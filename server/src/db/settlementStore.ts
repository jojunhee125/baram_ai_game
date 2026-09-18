import type { Pool, PoolClient } from "pg";
import { MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { InMemoryCurrencyStore, PostgresCurrencyStore } from "./currencyStore";
import { InMemoryInventoryStore, PostgresInventoryStore } from "./inventoryStore";
import { markDatabaseDegraded, markDatabaseOk } from "./status";
import { withTransaction } from "./withTransaction";

/** One item grant inside a settlement — a quantity to add to the account's bag, never a debit. */
export interface SettlementItemGrant {
  readonly itemKey: string;
  readonly quantity: number;
}

/**
 * One item debit inside a settlement — a quantity to remove from the account's bag, never a grant
 * (roadmap R04-c, design `docs/r04-settlement.md` §9 D10). Split from {@link SettlementItemGrant}
 * as its own type rather than a signed `quantity` on one shape, `CurrencyStore`'s own `credit`/
 * `debit` split (`currencyStore.ts`) for the same reason: a caller building a batch should not be
 * able to typo a sign and turn a sale into a free grant.
 *
 * Honoured by both {@link SettlementStore} implementations: a shop sale or a consumable use lists
 * the item here, and `settle` removes it in the same all-or-nothing transaction as any
 * {@link SettlementEffects.currencyDelta} in the same call, declining with
 * {@link SettlementInsufficientItem} rather than touching anything if the account does not hold
 * enough.
 */
export interface SettlementItemDebit {
  readonly itemKey: string;
  readonly quantity: number;
}

/**
 * What one call to `settle` changes, all together or not at all (design
 * `docs/r04-settlement.md` §3, §4 D3). `currencyDelta` may be positive (a
 * reward) or negative (a purchase); omitted or `0` means the settlement touches no balance at all.
 *
 * `items` and `itemDebits` may both be present in one call (a sale credits currency and debits the
 * sold item in the same transaction). Lock order for *both* together is the existing
 * currency-then-inventory rule (design §4 D3), inventory rows taken in `item_key` ascending order
 * across grants and debits merged as one sequence — not grants-then-debits — so two settlements
 * touching the same two items in opposite roles can never lock them in opposite orders.
 */
export interface SettlementEffects {
  readonly currencyDelta?: number;
  readonly items?: readonly SettlementItemGrant[];
  readonly itemDebits?: readonly SettlementItemDebit[];
}

/**
 * The stack total after one item's grant or debit — `InventoryStore.add`/`remove`'s own "answers
 * the total" shape. `quantity` is 0 for a debit that emptied the stack, the row-gone case those
 * stores' own `remove` documents.
 */
export interface SettlementResultItem {
  readonly itemKey: string;
  readonly quantity: number;
}

/** Every effect in `effects` applied. `balance` is present only when `currencyDelta` was given. */
export interface SettlementSuccess {
  readonly ok: true;
  readonly balance?: number;
  readonly items: readonly SettlementResultItem[];
}

/** The account cannot afford `currencyDelta`. Nothing in `effects` was applied. */
export interface SettlementInsufficientBalance {
  readonly ok: false;
  readonly reason: "insufficient-balance";
}

/** `itemKey` would push the bag over `MAX_DISTINCT_ITEMS`. Nothing in `effects` was applied. */
export interface SettlementBagFull {
  readonly ok: false;
  readonly reason: "bag-full";
  readonly itemKey: string;
}

/**
 * `itemKey` was debited (design §9 D10) for more than the account holds. Nothing in `effects` was
 * applied — {@link SettlementBagFull}'s own all-or-nothing rule, extended to the debit side.
 */
export interface SettlementInsufficientItem {
  readonly ok: false;
  readonly reason: "insufficient-item";
  readonly itemKey: string;
}

export type SettlementOutcome =
  | SettlementSuccess
  | SettlementInsufficientBalance
  | SettlementBagFull
  | SettlementInsufficientItem;

/**
 * The reward ledger and its all-or-nothing transaction (design §4 D2/D3). Keyed by a caller-built
 * `grantKey` — quest completion, a shop purchase and a consumable use each construct a
 * deterministic string from their own cause, `reward_grant`'s own reason (`0009_reward_grant.sql`)
 * for not generating one here: a random key would differ on every retry and defeat the whole
 * point of asking for one.
 *
 * D4/D5 (shop, consumables) are later milestones, still uncalled. D6/D7 (quest wiring, client
 * notice) are wired: `MetaverseRoom.recordQuestKill`/`hydrateQuestCache` are the two callers
 * (roadmap R04-b) — the first on the completion transition itself, the second retrying it on join
 * for an account whose completion never got to call this at all.
 */
export interface SettlementStore {
  /**
   * Applies `effects` for `grantKey`/`ownerKey` exactly once, ever — a second call for a
   * `grantKey` that already committed touches no balance and no bag, and instead replays the
   * exact `SettlementOutcome` the first call produced (design §4 D2: duplicate requests get back
   * the original result, not a bare "already processed" flag).
   *
   * All-or-nothing: if the currency delta cannot be afforded, or any item grant would overflow
   * the bag, *nothing* in `effects` is applied — not even the parts that would have succeeded on
   * their own — and no ledger row is written for the attempt, so the same `grantKey` can be
   * retried later and succeed once the account can afford it (design §4 D3).
   */
  settle(grantKey: string, ownerKey: string, effects: SettlementEffects): Promise<SettlementOutcome>;
}

/**
 * The store a server booted without `DATABASE_URL` runs on. Not a test double: it is the normal
 * local-development path (`CurrencyStore`'s own reason), which is what keeps the server test
 * suite running without a Postgres to point it at.
 *
 * Takes the process's actual `InMemoryCurrencyStore`/`InMemoryInventoryStore` (constructing its
 * own private pair by default, for a store used on its own in a test) rather than keeping a
 * second, separate balance/bag of its own: those two stores are what a room's inventory panel and
 * currency reads already go through, so a settlement that kept a divergent copy would apply in
 * local development yet never show up anywhere a caller could see it. Sharing them is safe for the
 * exact reason composing their *public* `credit`/`debit`/`add` methods would not be — this uses
 * only their synchronous `peekBalance`/`pokeBalance`/`peekBag`/`pokeBag` pair, which never
 * `await`s, so nothing here can suspend between this method's idempotency check and the write
 * that follows it. Two concurrent `settle` calls sharing a `grantKey` therefore cannot both pass
 * "not yet settled" before either one records the outcome.
 */
export class InMemorySettlementStore implements SettlementStore {
  private readonly grantsByKey = new Map<string, { ownerKey: string; outcome: SettlementOutcome }>();

  constructor(
    private readonly currencyStore: InMemoryCurrencyStore = new InMemoryCurrencyStore(),
    private readonly inventoryStore: InMemoryInventoryStore = new InMemoryInventoryStore(),
  ) {}

  settle(grantKey: string, ownerKey: string, effects: SettlementEffects): Promise<SettlementOutcome> {
    try {
      assertGrantKey(grantKey);
      assertUuidOwnerKey(ownerKey);
      assertSettlementEffects(effects);
    } catch (cause) {
      return Promise.reject(cause as Error);
    }
    // The idempotency gate itself — `reward_grant`'s own `ON CONFLICT DO NOTHING` role, done here
    // with a Map lookup instead of a unique index. This method never awaits anything below this
    // point, so two concurrent `settle` calls for the same key can never interleave between this
    // check and the write that follows it (see this class's own doc comment).
    const existing = this.grantsByKey.get(grantKey);
    if (existing !== undefined) {
      if (existing.ownerKey !== ownerKey) {
        // A grantKey is a caller-built deterministic string keyed to one owner (design §4 D2) —
        // seeing it again with a *different* owner is not a replay, it is the calling code's
        // grantKey construction failing to embed the owner it claims (`PostgresSettlementStore`'s
        // own reason). Silently answering owner A's stored outcome would report a credit to owner
        // B that never touched owner B's balance at all.
        return Promise.reject(new SettlementOwnerMismatch(grantKey, existing.ownerKey, ownerKey));
      }
      return Promise.resolve(existing.outcome);
    }

    const outcome = this.applyEffects(ownerKey, effects);
    if (outcome.ok) {
      // Only a successful settlement is remembered — a decline leaves no trace, the same "no
      // ledger row on failure" rule `PostgresSettlementStore` enforces by rolling back before its
      // `reward_grant` INSERT ever commits (design §4 D3).
      this.grantsByKey.set(grantKey, { ownerKey, outcome });
    }
    return Promise.resolve(outcome);
  }

  private applyEffects(ownerKey: string, effects: SettlementEffects): SettlementOutcome {
    // Currency first, then items by item_key ascending — not because a single-threaded Map needs
    // a lock order, but so this implementation fails on the same effect `PostgresSettlementStore`
    // would fail on, for callers that assert on *which* reason a mixed batch was declined for.
    const previousBalance = this.currencyStore.peekBalance(ownerKey);
    let nextBalance: number | undefined;
    if (effects.currencyDelta !== undefined && effects.currencyDelta !== 0) {
      const candidate = previousBalance + effects.currencyDelta;
      if (candidate < 0) {
        return { ok: false, reason: "insufficient-balance" };
      }
      nextBalance = candidate;
    }

    const nextBag = new Map(this.inventoryStore.peekBag(ownerKey));
    // Grants and debits merged into one item_key-ascending sequence, never grants-then-debits —
    // `SettlementEffects`'s own doc comment on why (design §4 D3, extended by §9 D10).
    const sortedOps = [
      ...(effects.items ?? []).map((grant) => ({ ...grant, kind: "grant" as const })),
      ...(effects.itemDebits ?? []).map((debit) => ({ ...debit, kind: "debit" as const })),
    ].sort((left, right) => compareItemKeyAscending(left.itemKey, right.itemKey));
    const resultItems: SettlementResultItem[] = [];
    for (const { itemKey, quantity, kind } of sortedOps) {
      const held = nextBag.get(itemKey);
      if (kind === "grant") {
        if (held === undefined && nextBag.size >= MAX_DISTINCT_ITEMS) {
          return { ok: false, reason: "bag-full", itemKey };
        }
        const total = held === undefined ? quantity : held + quantity;
        nextBag.set(itemKey, total);
        resultItems.push({ itemKey, quantity: total });
      } else {
        if (held === undefined || held < quantity) {
          return { ok: false, reason: "insufficient-item", itemKey };
        }
        const total = held - quantity;
        if (total === 0) {
          nextBag.delete(itemKey);
        } else {
          nextBag.set(itemKey, total);
        }
        resultItems.push({ itemKey, quantity: total });
      }
    }

    // Nothing is written until every effect in the batch is known to succeed — a currency change
    // computed above is discarded, not committed, if a later item in the same batch cannot fit.
    if (nextBalance !== undefined) {
      this.currencyStore.pokeBalance(ownerKey, nextBalance);
    }
    if (sortedOps.length > 0) {
      this.inventoryStore.pokeBag(ownerKey, nextBag);
    }
    return { ok: true, balance: nextBalance, items: resultItems };
  }
}

/**
 * Total order over item keys, `Array.prototype.sort`'s own stability requirement made explicit:
 * a bare `left < right ? -1 : 1` answers `1` for equal keys too, which is not a stable comparator
 * and leaves a batch that names the same `itemKey` twice with an unspecified order between the
 * two entries. Returning `0` for equal keys relies on `sort`'s guaranteed stability (ES2019) to
 * keep them in the order `effects.items` gave them instead.
 */
function compareItemKeyAscending(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/**
 * Signals an *expected* decline (insufficient balance, a full bag) up through
 * {@link withTransaction}'s rollback path without it being read as a database fault — the same
 * shape `PostgresInventoryStore.equip`'s own `23505` catch exists for, one level up: the
 * transaction it interrupts is exactly the one that must roll back, so throwing here is what
 * makes `withTransaction` roll it back, and {@link PostgresSettlementStore.settle} is what turns
 * the throw back into an ordinary `SettlementOutcome` instead of letting it reach the caller as
 * an exception.
 */
class SettlementDeclined extends Error {
  constructor(
    readonly outcome: SettlementInsufficientBalance | SettlementBagFull | SettlementInsufficientItem,
  ) {
    super(`settlement declined: ${outcome.reason}`);
  }
}

/**
 * A `grantKey` already settled for a *different* owner than the one asking now. This is not a
 * database fault (nothing about the connection or the row is broken) and it is not a normal
 * settlement decline either (`InventoryStore.add`'s "a full bag is a result, not a fault"
 * convention does not extend to this): a grantKey is supposed to be built from its owner (design
 * §4 D2, `0009_reward_grant.sql`'s own comment), so seeing it again under a different owner means
 * the *caller* broke that contract — replaying owner A's stored result to owner B would report a
 * credit to an account whose balance was never touched. {@link PostgresSettlementStore.settle} and
 * {@link InMemorySettlementStore.settle} both mark the database `ok` (it is) and let this reach
 * the caller as an exception rather than an ordinary `SettlementOutcome`, exactly so this class of
 * bug cannot go unnoticed behind a plausible-looking `{ ok: true }`.
 */
class SettlementOwnerMismatch extends Error {
  constructor(grantKey: string, actualOwnerKey: string, requestedOwnerKey: string) {
    super(
      `settlement grantKey "${grantKey}" was already settled for owner "${actualOwnerKey}", not "${requestedOwnerKey}" — a grantKey must be built from its owner (design §4 D2)`,
    );
  }
}

export class PostgresSettlementStore implements SettlementStore {
  constructor(private readonly pool: Pool) {}

  async settle(
    grantKey: string,
    ownerKey: string,
    effects: SettlementEffects,
  ): Promise<SettlementOutcome> {
    assertGrantKey(grantKey);
    assertUuidOwnerKey(ownerKey);
    assertSettlementEffects(effects);
    try {
      const outcome = await withTransaction(this.pool, (client) =>
        this.settleWithinTransaction(client, grantKey, ownerKey, effects),
      );
      markDatabaseOk();
      return outcome;
    } catch (cause) {
      if (cause instanceof SettlementDeclined) {
        // Insufficient balance and a full bag are normal, expected settlement outcomes —
        // `PostgresInventoryStore.equip`'s own reason for not routing its `23505` through
        // `markDatabaseDegraded`. The transaction that carried this already rolled back, so
        // nothing here is actually broken.
        markDatabaseOk();
        return cause.outcome;
      }
      if (cause instanceof SettlementOwnerMismatch) {
        // A caller bug, not a database fault — see that class's own doc comment. The database is
        // fine, so this marks `ok` rather than `degraded`, but the caller still needs to know its
        // grantKey/ownerKey pairing is wrong, so this re-throws instead of returning a value.
        markDatabaseOk();
        throw cause;
      }
      markDatabaseDegraded(cause);
      throw cause;
    }
  }

  private async settleWithinTransaction(
    client: PoolClient,
    grantKey: string,
    ownerKey: string,
    effects: SettlementEffects,
  ): Promise<SettlementOutcome> {
    // The idempotency gate (design §3, §4 D2/D3): only the transaction that actually inserts this
    // row goes on to touch a balance or a bag. A concurrent settle() for the same grantKey either
    // loses this race and falls into the replay branch below, or blocks on Postgres's own row lock
    // until the winner commits or rolls back — never both winning at once.
    const gate = await client.query<{ grant_key: string }>(
      `INSERT INTO reward_grant (grant_key, owner_key)
       VALUES ($1, $2)
       ON CONFLICT (grant_key) DO NOTHING
       RETURNING grant_key`,
      [grantKey, ownerKey],
    );
    if (gate.rows.length === 0) {
      const stored = await client.query<{ result: SettlementOutcome | null; owner_key: string }>(
        "SELECT result, owner_key FROM reward_grant WHERE grant_key = $1",
        [grantKey],
      );
      const row = stored.rows[0];
      if (row === undefined) {
        // The conflict this branch exists for means a row is there — Postgres would not have
        // reported zero inserted rows otherwise. Reaching this is the same broken-invariant class
        // as the NULL-result case below, just with the row itself missing instead of incomplete.
        throw new Error(`reward_grant "${grantKey}" reported a conflict but no row was found`);
      }
      if (row.owner_key !== ownerKey) {
        throw new SettlementOwnerMismatch(grantKey, row.owner_key, ownerKey);
      }
      if (row.result == null) {
        // `0009_reward_grant.sql`'s own invariant: no committed row is ever left with a NULL
        // result, because a settlement that fails rolls its INSERT back with it. Reaching this
        // means that invariant broke, not that this call has anything sensible to fall back to.
        throw new Error(`reward_grant "${grantKey}" exists with no result — a broken settlement invariant`);
      }
      return row.result;
    }

    // Lock order fixed at currency, then items by item_key ascending (design §4 D3) — the only
    // defence against two tabs of one account settling different grants that touch an overlapping
    // set of rows in opposite orders and deadlocking each other.
    let balance: number | undefined;
    if (effects.currencyDelta !== undefined && effects.currencyDelta !== 0) {
      const currencyStore = new PostgresCurrencyStore(client);
      if (effects.currencyDelta > 0) {
        balance = await currencyStore.credit(ownerKey, effects.currencyDelta);
      } else {
        const result = await currencyStore.debit(ownerKey, -effects.currencyDelta);
        if (result === null) {
          throw new SettlementDeclined({ ok: false, reason: "insufficient-balance" });
        }
        balance = result;
      }
    }

    const items: SettlementResultItem[] = [];
    // Merged into one item_key-ascending sequence, never grants-then-debits — `SettlementEffects`'s
    // own doc comment on why (design §4 D3, extended by §9 D10).
    const sortedOps = [
      ...(effects.items ?? []).map((grant) => ({ ...grant, kind: "grant" as const })),
      ...(effects.itemDebits ?? []).map((debit) => ({ ...debit, kind: "debit" as const })),
    ].sort((left, right) => compareItemKeyAscending(left.itemKey, right.itemKey));
    if (sortedOps.length > 0) {
      const inventoryStore = new PostgresInventoryStore(client);
      for (const { itemKey, quantity, kind } of sortedOps) {
        if (kind === "grant") {
          const total = await inventoryStore.add(ownerKey, itemKey, quantity);
          if (total === null) {
            throw new SettlementDeclined({ ok: false, reason: "bag-full", itemKey });
          }
          items.push({ itemKey, quantity: total });
        } else {
          const total = await inventoryStore.remove(ownerKey, itemKey, quantity);
          if (total === null) {
            throw new SettlementDeclined({ ok: false, reason: "insufficient-item", itemKey });
          }
          items.push({ itemKey, quantity: total });
        }
      }
    }

    const outcome: SettlementOutcome = { ok: true, balance, items };
    // Uncast parameter, like the rest of this project's SQL — Postgres infers jsonb from the
    // target column, and the driver already serialises a plain object to JSON text on the wire.
    await client.query("UPDATE reward_grant SET result = $2 WHERE grant_key = $1", [grantKey, outcome]);
    return outcome;
  }
}

/**
 * Rejects what `credit`/`debit`/`add` would each reject anyway, before either implementation of
 * `settle` touches a row — `progressStore.ts`'s own `assertGrantableAmount`, for the same reason:
 * a caller bug should fail identically and immediately in both implementations, not read as a
 * schema-level `23514`/`22P02` `PostgresSettlementStore` would otherwise mark the database
 * degraded over.
 */
function assertSettlementEffects(effects: SettlementEffects): void {
  // `0` is accepted, matching `SettlementEffects.currencyDelta`'s own doc comment: a caller that
  // computes a delta and happens to land on zero must not have to special-case that into
  // `undefined` before calling `settle` — both `InMemorySettlementStore.applyEffects` and
  // `PostgresSettlementStore.settleWithinTransaction` already test `!== 0` and treat it as "touch
  // no balance", so refusing it here would only be the guard disagreeing with the rest of this
  // file about what a zero delta means.
  if (effects.currencyDelta !== undefined && !Number.isInteger(effects.currencyDelta)) {
    throw new TypeError(`settlement currency delta must be an integer, not ${effects.currencyDelta}`);
  }
  for (const item of effects.items ?? []) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new TypeError(`settlement item quantity must be a positive integer, not ${item.quantity}`);
    }
  }
  for (const debit of effects.itemDebits ?? []) {
    if (!Number.isInteger(debit.quantity) || debit.quantity < 1) {
      throw new TypeError(`settlement item debit quantity must be a positive integer, not ${debit.quantity}`);
    }
  }
}

/** A `grantKey` is a caller-built deterministic string (design §4 D2) — never empty, never absent. */
function assertGrantKey(grantKey: string): void {
  if (typeof grantKey !== "string" || grantKey.length === 0) {
    throw new TypeError(`settlement grant key must be a non-empty string, not ${JSON.stringify(grantKey)}`);
  }
}

/**
 * The same shape `inventoryStore.ts`'s own `assertUuidOwnerKey` enforces, and for the same
 * reason: a caller falls back to the session id when there is no SSO identity (local
 * development), and a session id is never the uuid `owner_key` is declared as. Left unguarded, a
 * production room with no SSO for a session would throw a driver-level `22P02` inside the
 * transaction that {@link PostgresSettlementStore.settle} cannot tell apart from a dropped
 * connection, marking `/api/health` degraded on every such call.
 */
function assertUuidOwnerKey(ownerKey: string): void {
  if (!UUID_PATTERN.test(ownerKey)) {
    throw new TypeError(`settlement owner key must be a uuid, not "${ownerKey}"`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
