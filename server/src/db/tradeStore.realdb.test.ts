import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { AtomicTradeRequest } from "../rooms/contracts";
import { MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { PostgresCurrencyStore } from "./currencyStore";
import { PostgresInventoryStore } from "./inventoryStore";
import { runMigrations } from "./migrate";
import { PostgresSettlementStore } from "./settlementStore";
import { resetDatabaseStatus } from "./status";
import { PostgresTradeStore } from "./tradeStore";

const databaseUrl = process.env["ZEP_TEST_DATABASE_URL"]?.trim();
const firstOwner = "00000000-0000-0000-0000-000000000001";
const secondOwner = "00000000-0000-0000-0000-000000000002";

describe("PostgresTradeStore real atomic transactions", {
  skip: !databaseUrl ? "ZEP_TEST_DATABASE_URL is not set" : false,
  concurrency: false,
}, () => {
  const schema = `trade_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let currency: PostgresCurrencyStore;
  let inventory: PostgresInventoryStore;
  let store: PostgresTradeStore;

  before(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl, max: 6, connectionTimeoutMillis: 5000,
      statement_timeout: 15_000, options: `-c search_path=${schema}`,
    });
    await runMigrations(pool);
    currency = new PostgresCurrencyStore(pool);
    inventory = new PostgresInventoryStore(pool);
    store = new PostgresTradeStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE trade_settlement, reward_grant, inventory_item, player_currency");
    await currency.credit(firstOwner, 100);
    await currency.credit(secondOwner, 50);
    await inventory.add(firstOwner, "acorn", 3);
    await inventory.add(secondOwner, "herb", 4);
    resetDatabaseStatus();
  });

  after(async () => {
    await pool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    resetDatabaseStatus();
  });

  function request(): AtomicTradeRequest {
    return {
      tradeId: randomUUID(),
      first: { ownerKey: firstOwner, offer: { currency: 20, items: [{ itemKey: "acorn", quantity: 3 }] } },
      second: { ownerKey: secondOwner, offer: { currency: 5, items: [{ itemKey: "herb", quantity: 2 }] } },
    };
  }

  async function snapshot() {
    return {
      currency: (await pool.query("SELECT owner_key, balance FROM player_currency ORDER BY owner_key")).rows,
      inventory: (await pool.query("SELECT owner_key, item_key, quantity, equipped_slot FROM inventory_item ORDER BY owner_key, item_key")).rows,
    };
  }

  it("concurrent duplicate/reversed requests commit once and changed payloads conflict", async () => {
    const input = request();
    const reverse = { ...input, first: input.second, second: input.first };
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, index) => store.exchange(index % 2 ? input : reverse)));
    for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
    assert.equal(outcomes[0]!.ok, true);
    assert.equal(await currency.getBalance(firstOwner), 85);
    assert.equal(await currency.getBalance(secondOwner), 65);
    assert.deepEqual(await inventory.list(firstOwner), [{ itemKey: "herb", quantity: 2, equipped: false }]);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM trade_settlement")).rows[0].count, 1);
    assert.deepEqual(await store.exchange({ ...input, first: { ...input.first, offer: { currency: 25, items: [] } } }),
      { ok: false, reason: "conflict" });
  });

  it("persists declines without any partial asset transfer and binds their replay", async () => {
    const initial = await snapshot();
    const input = request();
    input.second.offer.items = [{ itemKey: "herb", quantity: 5 }];
    const expected = { ok: false, reason: "insufficient-item", ownerKey: secondOwner, itemKey: "herb" };
    assert.deepEqual(await store.exchange(input), expected);
    assert.deepEqual(await snapshot(), initial);
    await inventory.add(secondOwner, "herb", 2);
    assert.deepEqual(await store.exchange(input), expected);
    assert.equal((await store.exchange({ ...input, tradeId: randomUUID() })).ok, true);
  });

  it("rolls back both owners and ledger when the final write fails", async () => {
    const initial = await snapshot();
    await pool.query("ALTER TABLE trade_settlement ADD CONSTRAINT reject_test_result CHECK (result IS NULL)");
    try {
      await assert.rejects(store.exchange(request()), (cause: unknown) =>
        typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23514");
      assert.deepEqual(await snapshot(), initial);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM trade_settlement")).rows[0].count, 0);
    } finally {
      await pool.query("ALTER TABLE trade_settlement DROP CONSTRAINT reject_test_result");
      resetDatabaseStatus();
    }
  });

  it("serializes conflicting trades and concurrent shop debit without creating assets", async () => {
    const input = request();
    const settlement = new PostgresSettlementStore(pool);
    const outcomes = await Promise.all([
      store.exchange(input),
      store.exchange({ ...input, tradeId: randomUUID() }),
      settlement.settle(`sale:${randomUUID()}`, firstOwner, { currencyDelta: 12, itemDebits: [{ itemKey: "acorn", quantity: 3 }] }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    const total = await pool.query("SELECT coalesce(sum(quantity), 0)::int AS total FROM inventory_item WHERE item_key = 'acorn'");
    assert.ok([0, 3].includes(total.rows[0].total));
    assert.equal(await currency.getBalance(firstOwner) + await currency.getBalance(secondOwner), total.rows[0].total === 0 ? 162 : 150);
  });

  it("allows an at-capacity swap but refuses an overflowing final bag and stack", async () => {
    for (const owner of [firstOwner, secondOwner]) {
      for (let index = 1; index < MAX_DISTINCT_ITEMS; index += 1) await inventory.add(owner, `filler-${index}`, 1);
    }
    const input = request();
    input.second.offer.items = [{ itemKey: "herb", quantity: 4 }];
    assert.equal((await store.exchange(input)).ok, true);
    assert.equal((await inventory.list(firstOwner)).length, MAX_DISTINCT_ITEMS);
    const initial = await snapshot();
    const overflow = request();
    overflow.first.offer.items = [];
    overflow.second.offer.items = [{ itemKey: "acorn", quantity: 1 }];
    assert.deepEqual(await store.exchange(overflow), { ok: false, reason: "bag-full", ownerKey: firstOwner });
    assert.deepEqual(await snapshot(), initial);
    await pool.query("UPDATE inventory_item SET quantity = 2147483647 WHERE owner_key = $1 AND item_key = 'herb'", [firstOwner]);
    const stackOverflow = request();
    stackOverflow.first.offer.items = [];
    stackOverflow.second.offer.items = [{ itemKey: "herb", quantity: 1 }];
    await inventory.add(secondOwner, "herb", 1);
    // Free one slot because the earlier swap filled the second owner's bag.
    await pool.query("DELETE FROM inventory_item WHERE owner_key = $1 AND item_key = 'filler-1'", [secondOwner]);
    await inventory.add(secondOwner, "herb", 1);
    assert.deepEqual(await store.exchange(stackOverflow), { ok: false, reason: "invalid-offer", ownerKey: firstOwner, itemKey: "herb" });
  });

  it("observes an in-flight equip before exchanging its stack", async () => {
    await inventory.add(firstOwner, "old-dagger", 1);
    const blocker = await pool.connect();
    const input = request();
    input.first.offer.items = [{ itemKey: "old-dagger", quantity: 1 }];
    let exchange: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("UPDATE inventory_item SET equipped_slot = 'weapon' WHERE owner_key = $1 AND item_key = 'old-dagger'", [firstOwner]);
      exchange = store.exchange(input);
      const deadline = Date.now() + 5000;
      let blocked = false;
      do {
        const result = await pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation = 'inventory_item'::regclass AND mode = 'ShareRowExclusiveLock' AND NOT granted) AS blocked",
        );
        blocked = result.rows[0]!.blocked;
        if (!blocked) await delay(10);
      } while (!blocked && Date.now() < deadline);
      assert.equal(blocked, true);
      await blocker.query("COMMIT");
      assert.deepEqual(await exchange, { ok: false, reason: "equipped-item", ownerKey: firstOwner, itemKey: "old-dagger" });
      assert.equal(await currency.getBalance(firstOwner), 100);
      assert.equal((await inventory.list(firstOwner)).find((item) => item.itemKey === "old-dagger")?.equipped, true);
    } finally {
      await blocker.query("ROLLBACK");
      if (exchange !== undefined) await Promise.allSettled([exchange]);
      blocker.release();
    }
  });

  for (const omitEarlyLock of [false, true]) {
    it(omitEarlyLock
      ? "detects the original consume/trade deadlock when the early table lock is omitted"
      : "serializes an item-only consumption already holding its row against a trade", async () => {
      await pool.query("TRUNCATE trade_settlement, reward_grant, inventory_item, player_currency");
      await currency.credit(firstOwner, 10);
      await currency.credit(secondOwner, 10);
      await inventory.add(firstOwner, "herb", 2);
      let releaseRead!: () => void;
      let readReached!: () => void;
      const paused = new Promise<void>((resolve) => { readReached = resolve; });
      const released = new Promise<void>((resolve) => { releaseRead = resolve; });
      const consumerClient = await pool.connect();
      const query = consumerClient.query.bind(consumerClient);
      const deadlocks: unknown[] = [];
      const recordFailure = (cause: unknown): never => {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "40P01") {
          deadlocks.push(cause);
        }
        throw cause;
      };
      const instrumentedClient = new Proxy(consumerClient, {
        get(target, property) {
          if (property === "release") return () => {};
          if (property !== "query") return Reflect.get(target, property);
          return async (sql: string, values?: unknown[]) => {
            if (omitEarlyLock && sql === "LOCK TABLE inventory_item IN ROW EXCLUSIVE MODE") {
              return { rows: [], rowCount: 0 };
            }
            const result = await query(sql, values).catch(recordFailure);
            if (sql.startsWith("SELECT equipped_slot") && sql.endsWith("FOR UPDATE")) {
              readReached();
              await released;
            }
            return result;
          };
        },
      }) as PoolClient;
      const consumerPool = new Proxy(pool, {
        get(target, property) {
          return property === "connect" ? async () => instrumentedClient : Reflect.get(target, property);
        },
      });
      const settlement = new PostgresSettlementStore(consumerPool);
      const observedTradePool = new Proxy(pool, {
        get(target, property) {
          if (property !== "connect") return Reflect.get(target, property);
          return async () => {
            const tradeClient = await pool.connect();
            return new Proxy(tradeClient, {
              get(client, key) {
                if (key === "query") {
                  return (sql: string, values?: unknown[]) => client.query(sql, values).catch(recordFailure);
                }
                const value = Reflect.get(client, key);
                return typeof value === "function" ? value.bind(client) : value;
              },
            });
          };
        },
      });
      const observedTrade = new PostgresTradeStore(observedTradePool);
      const consume = settlement.settle(`consume:${randomUUID()}`, firstOwner, {
        itemDebits: [{ itemKey: "herb", quantity: 1 }],
      });
      const tasks: Promise<unknown>[] = [consume];
      void consume.catch(() => {});
      try {
        await Promise.race([paused, delay(5000).then(() => { throw new Error("consume never locked its item row"); })]);
        const trade = observedTrade.exchange({
          tradeId: randomUUID(),
          first: { ownerKey: firstOwner, offer: { currency: 0, items: [{ itemKey: "herb", quantity: 1 }] } },
          second: { ownerKey: secondOwner, offer: { currency: 1, items: [] } },
        });
        tasks.push(trade);
        void trade.catch(() => {});
        const deadline = Date.now() + 5000;
        let blocked = false;
        do {
          const result = await pool.query<{ blocked: boolean }>(omitEarlyLock
            ? "SELECT EXISTS(SELECT 1 FROM pg_locks t JOIN pg_locks w ON w.pid = t.pid WHERE t.relation = 'inventory_item'::regclass AND t.mode = 'ShareRowExclusiveLock' AND t.granted AND w.locktype = 'transactionid' AND NOT w.granted) AS blocked"
            : "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE relation = 'inventory_item'::regclass AND mode = 'ShareRowExclusiveLock' AND NOT granted) AS blocked",
          );
          blocked = result.rows[0]!.blocked;
          if (!blocked) await delay(10);
        } while (!blocked && Date.now() < deadline);
        assert.equal(blocked, true, "trade must be waiting before the consumer resumes");
        releaseRead();
        const results = await Promise.allSettled(tasks);
        if (omitEarlyLock) {
          assert.ok(deadlocks.length > 0,
            "the negative control must observe PostgreSQL's 40P01 on either victim, even when the trade retry recovers");
        } else {
          assert.equal(deadlocks.length, 0, "the early lock prevents the deadlock rather than relying on retries");
          for (const result of results) {
            assert.equal(result.status, "fulfilled", JSON.stringify(result));
            if (result.status === "fulfilled") assert.equal((result.value as { ok: boolean }).ok, true);
          }
          assert.equal(await currency.getBalance(firstOwner), 11);
          assert.equal(await currency.getBalance(secondOwner), 9);
          assert.deepEqual(await inventory.list(firstOwner), []);
          assert.deepEqual(await inventory.list(secondOwner), [{ itemKey: "herb", quantity: 1, equipped: false }]);
        }
      } finally {
        releaseRead();
        await Promise.allSettled(tasks);
        consumerClient.release();
        resetDatabaseStatus();
      }
    });
  }
});
