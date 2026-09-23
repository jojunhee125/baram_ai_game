import type { Pool, PoolClient } from "pg";
import type { AtomicTradeOutcome, AtomicTradeRequest, TradeStore } from "../rooms/contracts";
import { ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS, MAX_REQUEST_QUANTITY } from "../rooms/itemDefinitions";
import { InMemoryCurrencyStore } from "./currencyStore";
import { InMemoryInventoryStore } from "./inventoryStore";
import { markDatabaseDegraded, markDatabaseOk } from "./status";
import { withTransaction } from "./withTransaction";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STACK_QUANTITY = 2_147_483_647;
const MAX_TRADE_CURRENCY = 1_000_000_000;
const MAX_TRADE_ITEMS = 6;
const ITEM_BY_KEY = new Map(ITEM_DEFINITIONS.map((item) => [item.key, item]));
type TradeFailure = Extract<AtomicTradeOutcome, { ok: false }>;
type TradeSuccess = Extract<AtomicTradeOutcome, { ok: true }>;
type Participant = AtomicTradeRequest["first"];

interface AccountSnapshot {
  balance: number;
  bag: ReadonlyMap<string, number>;
  equipped: ReadonlySet<string>;
}

interface ExchangePlan {
  outcome: TradeSuccess;
  bags: readonly ReadonlyMap<string, number>[];
}

function ascending(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalRequest(value: unknown): AtomicTradeRequest | TradeFailure {
  if (!isRecord(value) || typeof value.tradeId !== "string" || value.tradeId.length === 0 ||
      value.tradeId.length > 128 || value.tradeId.includes("\0")) {
    return { ok: false, reason: "invalid-offer" };
  }
  const participants: Participant[] = [];
  for (const raw of [value.first, value.second]) {
    if (!isRecord(raw) || typeof raw.ownerKey !== "string" || !UUID_PATTERN.test(raw.ownerKey) ||
        !isRecord(raw.offer) || !Number.isSafeInteger(raw.offer.currency) ||
        typeof raw.offer.currency !== "number" || raw.offer.currency < 0 ||
        raw.offer.currency > MAX_TRADE_CURRENCY || !Array.isArray(raw.offer.items) ||
        raw.offer.items.length > MAX_TRADE_ITEMS) {
      return { ok: false, reason: "invalid-offer" };
    }
    const ownerKey = raw.ownerKey.toLowerCase();
    const keys = new Set<string>();
    const items: { itemKey: string; quantity: number }[] = [];
    for (const item of raw.offer.items) {
      if (!isRecord(item) || typeof item.itemKey !== "string" || !Number.isSafeInteger(item.quantity) ||
          typeof item.quantity !== "number" || item.quantity < 1 || item.quantity > MAX_REQUEST_QUANTITY ||
          keys.has(item.itemKey) || !ITEM_BY_KEY.has(item.itemKey)) {
        return { ok: false, reason: "invalid-offer", ownerKey };
      }
      if (ITEM_BY_KEY.get(item.itemKey)?.possession === true) {
        return { ok: false, reason: "restricted-item", ownerKey, itemKey: item.itemKey };
      }
      keys.add(item.itemKey);
      items.push({ itemKey: item.itemKey, quantity: item.quantity });
    }
    items.sort((left, right) => ascending(left.itemKey, right.itemKey));
    participants.push({ ownerKey, offer: { currency: raw.offer.currency, items } });
  }
  participants.sort((left, right) => ascending(left.ownerKey, right.ownerKey));
  const first = participants[0]!;
  const second = participants[1]!;
  if (first.ownerKey === second.ownerKey ||
      [first, second].every(({ offer }) => offer.currency === 0 && offer.items.length === 0)) {
    return { ok: false, reason: "invalid-offer" };
  }
  return { tradeId: value.tradeId, first, second };
}

function planExchange(request: AtomicTradeRequest, snapshots: readonly AccountSnapshot[]): ExchangePlan | TradeFailure {
  const participants = [request.first, request.second];
  const bags = snapshots.map((snapshot) => new Map(snapshot.bag));
  const results: TradeSuccess["participants"][number][] = [];
  for (const [index, participant] of participants.entries()) {
    const snapshot = snapshots[index]!;
    if (snapshot.balance < participant.offer.currency) {
      return { ok: false, reason: "insufficient-balance", ownerKey: participant.ownerKey };
    }
    if (!Number.isSafeInteger(snapshot.balance) || snapshot.balance < 0) {
      return { ok: false, reason: "conflict", ownerKey: participant.ownerKey };
    }
  }
  for (const [index, participant] of participants.entries()) {
    const snapshot = snapshots[index]!;
    for (const item of participant.offer.items) {
      if (snapshot.equipped.has(item.itemKey)) {
        return { ok: false, reason: "equipped-item", ownerKey: participant.ownerKey, itemKey: item.itemKey };
      }
      const held = snapshot.bag.get(item.itemKey) ?? 0;
      if (held < item.quantity) {
        return { ok: false, reason: "insufficient-item", ownerKey: participant.ownerKey, itemKey: item.itemKey };
      }
      const remaining = held - item.quantity;
      if (remaining === 0) bags[index]!.delete(item.itemKey);
      else bags[index]!.set(item.itemKey, remaining);
    }
  }
  for (const [index, participant] of participants.entries()) {
    const incoming = participants[1 - index]!.offer;
    const bag = bags[index]!;
    for (const item of incoming.items) {
      const total = (bag.get(item.itemKey) ?? 0) + item.quantity;
      if (!Number.isSafeInteger(total) || total > MAX_STACK_QUANTITY) {
        return { ok: false, reason: "invalid-offer", ownerKey: participant.ownerKey, itemKey: item.itemKey };
      }
      bag.set(item.itemKey, total);
    }
    if (bag.size > MAX_DISTINCT_ITEMS) {
      return { ok: false, reason: "bag-full", ownerKey: participant.ownerKey };
    }
    const balance = snapshots[index]!.balance - participant.offer.currency + incoming.currency;
    if (!Number.isSafeInteger(balance)) {
      return { ok: false, reason: "invalid-offer", ownerKey: participant.ownerKey };
    }
    const changedKeys = [...new Set([...participant.offer.items, ...incoming.items].map((item) => item.itemKey))]
      .sort(ascending);
    results.push({
      ownerKey: participant.ownerKey,
      balance,
      items: changedKeys.map((itemKey) => ({ itemKey, quantity: bag.get(itemKey) ?? 0 })),
    });
  }
  return { outcome: { ok: true, participants: results }, bags };
}

export class InMemoryTradeStore implements TradeStore {
  private readonly trades = new Map<string, { request: string; outcome: AtomicTradeOutcome }>();

  constructor(
    private readonly currencyStore: InMemoryCurrencyStore,
    private readonly inventoryStore: InMemoryInventoryStore,
  ) {}

  exchange(input: AtomicTradeRequest): Promise<AtomicTradeOutcome> {
    const request = canonicalRequest(input);
    if ("ok" in request) return Promise.resolve(request);
    const fingerprint = JSON.stringify(request);
    const stored = this.trades.get(request.tradeId);
    if (stored !== undefined) {
      return Promise.resolve(stored.request === fingerprint
        ? structuredClone(stored.outcome) : { ok: false, reason: "conflict" });
    }
    const participants = [request.first, request.second];
    const snapshots = participants.map(({ ownerKey }) => ({
      balance: this.currencyStore.peekBalance(ownerKey),
      bag: this.inventoryStore.peekBag(ownerKey),
      equipped: new Set([...this.inventoryStore.peekBag(ownerKey).keys()]
        .filter((itemKey) => this.inventoryStore.isEquipped(ownerKey, itemKey))),
    }));
    const plan = planExchange(request, snapshots);
    const outcome = "ok" in plan ? plan : plan.outcome;
    // No await may split validation, both account writes, and the replay ledger.
    if (!("ok" in plan)) {
      plan.outcome.participants.forEach((participant, index) => {
        this.currencyStore.pokeBalance(participant.ownerKey, participant.balance);
        this.inventoryStore.pokeBag(participant.ownerKey, plan.bags[index]!);
      });
    }
    this.trades.set(request.tradeId, { request: fingerprint, outcome: structuredClone(outcome) });
    return Promise.resolve(outcome);
  }
}

export class PostgresTradeStore implements TradeStore {
  constructor(private readonly pool: Pool) {}

  async exchange(input: AtomicTradeRequest): Promise<AtomicTradeOutcome> {
    const request = canonicalRequest(input);
    if ("ok" in request) return request;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const outcome = await withTransaction(this.pool, (client) => this.exchangeWithinTransaction(client, request));
        markDatabaseOk();
        return outcome;
      } catch (cause) {
        const code = isRecord(cause) ? cause.code : undefined;
        if (code === "40001" || code === "40P01") {
          if (attempt < 2) continue;
          markDatabaseOk();
          return { ok: false, reason: "conflict" };
        }
        markDatabaseDegraded(cause);
        throw cause;
      }
    }
  }

  private async exchangeWithinTransaction(client: PoolClient, request: AtomicTradeRequest): Promise<AtomicTradeOutcome> {
    const fingerprint = JSON.stringify(request);
    const inserted = await client.query<{ trade_id: string }>(
      `INSERT INTO trade_settlement (trade_id, first_owner_key, second_owner_key, request)
       VALUES ($1, $2, $3, $4) ON CONFLICT (trade_id) DO NOTHING RETURNING trade_id`,
      [request.tradeId, request.first.ownerKey, request.second.ownerKey, fingerprint],
    );
    if (inserted.rows.length === 0) {
      const stored = await client.query<{ request: AtomicTradeRequest; result: AtomicTradeOutcome | null }>(
        "SELECT request, result FROM trade_settlement WHERE trade_id = $1", [request.tradeId],
      );
      const row = stored.rows[0];
      if (row === undefined || row.result === null) throw new Error(`trade ${request.tradeId} has no committed result`);
      const canonical = canonicalRequest(row.request);
      return !("ok" in canonical) && JSON.stringify(canonical) === fingerprint
        ? row.result : { ok: false, reason: "conflict" };
    }

    const participants = [request.first, request.second];
    const balances: number[] = [];
    for (const { ownerKey } of participants) {
      await client.query("INSERT INTO player_currency (owner_key) VALUES ($1) ON CONFLICT DO NOTHING", [ownerKey]);
      const currency = await client.query<{ balance: string }>(
        "SELECT balance FROM player_currency WHERE owner_key = $1 FOR UPDATE", [ownerKey],
      );
      balances.push(Number(currency.rows[0]!.balance));
    }
    // Existing drops do not take an owner mutex. This also excludes newly inserted stacks,
    // which row locks alone cannot protect when checking the final bag capacity.
    await client.query("LOCK TABLE inventory_item IN SHARE ROW EXCLUSIVE MODE");
    const snapshots: AccountSnapshot[] = [];
    for (const [index, { ownerKey }] of participants.entries()) {
      const inventory = await client.query<{ item_key: string; quantity: number; equipped_slot: string | null }>(
        "SELECT item_key, quantity, equipped_slot FROM inventory_item WHERE owner_key = $1 ORDER BY item_key FOR UPDATE",
        [ownerKey],
      );
      snapshots.push({
        balance: balances[index]!,
        bag: new Map(inventory.rows.map((row) => [row.item_key, row.quantity])),
        equipped: new Set(inventory.rows.filter((row) => row.equipped_slot !== null).map((row) => row.item_key)),
      });
    }
    const plan = planExchange(request, snapshots);
    const outcome = "ok" in plan ? plan : plan.outcome;
    if (!("ok" in plan)) {
      for (const participant of plan.outcome.participants) {
        await client.query("UPDATE player_currency SET balance = $2, updated_at = now() WHERE owner_key = $1",
          [participant.ownerKey, participant.balance]);
        for (const item of participant.items) {
          if (item.quantity === 0) {
            await client.query("DELETE FROM inventory_item WHERE owner_key = $1 AND item_key = $2",
              [participant.ownerKey, item.itemKey]);
          } else {
            await client.query(
              `INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, $3)
               ON CONFLICT (owner_key, item_key) DO UPDATE SET quantity = EXCLUDED.quantity`,
              [participant.ownerKey, item.itemKey, item.quantity],
            );
          }
        }
      }
    }
    await client.query("UPDATE trade_settlement SET result = $2 WHERE trade_id = $1", [request.tradeId, outcome]);
    return outcome;
  }
}
