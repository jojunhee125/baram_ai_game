import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresCurrencyStore } from "./currencyStore";
import { PostgresInventoryStore } from "./inventoryStore";
import { runMigrations } from "./migrate";
import { PostgresSettlementStore } from "./settlementStore";
import { resetDatabaseStatus } from "./status";

const databaseUrl = process.env["ZEP_TEST_DATABASE_URL"]?.trim();
const saleEffects = { currencyDelta: 25, itemDebits: [{ itemKey: "old-dagger", quantity: 1 }] };

describe("PostgresSettlementStore real transaction races", {
  skip: !databaseUrl ? "ZEP_TEST_DATABASE_URL is not set" : false,
  concurrency: false,
}, () => {
  let observer: Pool;
  let first: Pool;
  let second: Pool;
  let blocker: Pool;
  let firstPid: number;
  let secondPid: number;
  let blockerPid: number;
  const owners: string[] = [];
  const pending: Promise<unknown>[] = [];

  before(async () => {
    const options = {
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      idleTimeoutMillis: 0,
    };
    observer = new Pool(options);
    first = new Pool(options);
    second = new Pool(options);
    blocker = new Pool(options);
    await runMigrations(observer);
    const pids = await Promise.all([observer, first, second, blocker].map(async (pool) => {
      const result = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      return result.rows[0]!.pid;
    }));
    assert.equal(new Set(pids).size, 4, "the stores and lock observer need independent physical connections");
    [, firstPid, secondPid, blockerPid] = pids as [number, number, number, number];
    resetDatabaseStatus();
  });

  afterEach(async () => {
    await blocker.query("ROLLBACK");
    await Promise.allSettled(pending.splice(0));
    for (const owner of owners.splice(0)) {
      await observer.query("DELETE FROM reward_grant WHERE owner_key = $1", [owner]);
      await observer.query("DELETE FROM inventory_item WHERE owner_key = $1", [owner]);
      await observer.query("DELETE FROM player_currency WHERE owner_key = $1", [owner]);
    }
    resetDatabaseStatus();
  });

  after(async () => {
    await Promise.all([observer, first, second, blocker].filter(Boolean).map((pool) => pool.end()));
    resetDatabaseStatus();
  });

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise);
    void promise.catch(() => undefined);
    return promise;
  }

  async function seed(quantity = 1): Promise<string> {
    const owner = randomUUID();
    owners.push(owner);
    await new PostgresCurrencyStore(observer).credit(owner, 100);
    await new PostgresInventoryStore(observer).add(owner, "old-dagger", quantity);
    return owner;
  }

  async function waitBlocked(waiterPid: number, holderPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    let blockers: number[] = [];
    do {
      const result = await observer.query<{ blockers: number[] }>(
        "SELECT pg_blocking_pids($1) AS blockers", [waiterPid],
      );
      blockers = result.rows[0]!.blockers;
      if (blockers.includes(holderPid)) return;
      await delay(10);
    } while (Date.now() < deadline);
    assert.fail(`backend ${waiterPid} did not wait on ${holderPid}; observed blockers: ${blockers}`);
  }

  async function lockItem(owner: string): Promise<void> {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT item_key FROM inventory_item WHERE owner_key = $1 AND item_key = 'old-dagger' FOR UPDATE",
      [owner],
    );
  }

  async function snapshot(owner: string) {
    const bag = await observer.query<{ item_key: string; quantity: number; equipped_slot: string | null }>(
      "SELECT item_key, quantity, equipped_slot FROM inventory_item WHERE owner_key = $1 ORDER BY item_key", [owner],
    );
    const ledger = await observer.query<{ grant_key: string; result: unknown }>(
      "SELECT grant_key, result FROM reward_grant WHERE owner_key = $1 ORDER BY grant_key", [owner],
    );
    return {
      balance: await new PostgresCurrencyStore(observer).getBalance(owner),
      bag: bag.rows,
      equipped: await new PostgresInventoryStore(observer).getEquippedSlots(owner),
      ledger: ledger.rows,
    };
  }

  it("equip wins the row lock: sale rolls back currency and ledger without removing equipped gear", async () => {
    const owner = await seed();
    const key = `sale:${randomUUID()}`;
    await blocker.query("BEGIN");
    assert.equal(await new PostgresInventoryStore(blocker).equip(owner, "old-dagger", "weapon"), true);
    const sale = track(new PostgresSettlementStore(first).settle(key, owner, saleEffects));
    await waitBlocked(firstPid, blockerPid);
    await blocker.query("COMMIT");
    assert.deepEqual(await sale, { ok: false, reason: "equipped-item", itemKey: "old-dagger" });
    assert.deepEqual(await snapshot(owner), {
      balance: 100,
      bag: [{ item_key: "old-dagger", quantity: 1, equipped_slot: "weapon" }],
      equipped: { weapon: "old-dagger" },
      ledger: [],
    });
    assert.equal(await new PostgresInventoryStore(second).unequip(owner, "weapon"), true);
    const retry = await new PostgresSettlementStore(second).settle(key, owner, saleEffects);
    assert.deepEqual(retry, { ok: true, balance: 125, items: [{ itemKey: "old-dagger", quantity: 0 }] });
    assert.deepEqual(await snapshot(owner), {
      balance: 125, bag: [], equipped: {}, ledger: [{ grant_key: key, result: retry }],
    });
  });

  it("sale wins the row lock: waiting equip cannot resurrect the sold item or clear another weapon", async () => {
    const owner = await seed();
    const inventory = new PostgresInventoryStore(observer);
    await inventory.add(owner, "hunting-blade", 1);
    assert.equal(await inventory.equip(owner, "hunting-blade", "weapon"), true);
    const key = `sale:${randomUUID()}`;
    await lockItem(owner);
    const sale = track(new PostgresSettlementStore(first).settle(key, owner, saleEffects));
    await waitBlocked(firstPid, blockerPid);
    const equip = track(new PostgresInventoryStore(second).equip(owner, "old-dagger", "weapon"));
    // PostgreSQL's tuple-lock queue proves sale is ahead of equip before the gate opens.
    await waitBlocked(secondPid, firstPid);
    await blocker.query("COMMIT");
    const result = await sale;
    assert.deepEqual(result, { ok: true, balance: 125, items: [{ itemKey: "old-dagger", quantity: 0 }] });
    assert.equal(await equip, false);
    assert.deepEqual(await snapshot(owner), {
      balance: 125,
      bag: [{ item_key: "hunting-blade", quantity: 1, equipped_slot: "weapon" }],
      equipped: { weapon: "hunting-blade" },
      ledger: [{ grant_key: key, result }],
    });
  });

  it("concurrent and sequential replay of one grantKey changes assets exactly once", async () => {
    const owner = await seed(2);
    const key = `sale:${randomUUID()}`;
    await lockItem(owner);
    const original = track(new PostgresSettlementStore(first).settle(key, owner, saleEffects));
    await waitBlocked(firstPid, blockerPid);
    const duplicate = track(new PostgresSettlementStore(second).settle(key, owner, saleEffects));
    await waitBlocked(secondPid, firstPid);
    await blocker.query("COMMIT");
    const expected = { ok: true, balance: 125, items: [{ itemKey: "old-dagger", quantity: 1 }] };
    assert.deepEqual(await original, expected);
    assert.deepEqual(await duplicate, expected);
    await new PostgresCurrencyStore(observer).credit(owner, 7);
    assert.deepEqual(await new PostgresSettlementStore(second).settle(key, owner, saleEffects), expected);
    assert.deepEqual(await snapshot(owner), {
      balance: 132,
      bag: [{ item_key: "old-dagger", quantity: 1, equipped_slot: null }],
      equipped: {},
      ledger: [{ grant_key: key, result: expected }],
    });
  });

  it("a late debit decline rolls back earlier currency and item changes, then the same key can retry", async () => {
    const owner = await seed();
    const key = `batch:${randomUUID()}`;
    const effects = {
      currencyDelta: 25,
      itemDebits: [{ itemKey: "old-dagger", quantity: 1 }, { itemKey: "z-missing", quantity: 1 }],
    };
    const beforeState = await snapshot(owner);
    assert.deepEqual(await new PostgresSettlementStore(first).settle(key, owner, effects), {
      ok: false, reason: "insufficient-item", itemKey: "z-missing",
    });
    assert.deepEqual(await snapshot(owner), beforeState);
    await new PostgresInventoryStore(observer).add(owner, "z-missing", 1);
    const result = await new PostgresSettlementStore(second).settle(key, owner, effects);
    assert.deepEqual(result, {
      ok: true, balance: 125,
      items: [{ itemKey: "old-dagger", quantity: 0 }, { itemKey: "z-missing", quantity: 0 }],
    });
    assert.deepEqual(await snapshot(owner), {
      balance: 125, bag: [], equipped: {}, ledger: [{ grant_key: key, result }],
    });
  });

  it("a real integer overflow aborts the transaction and releases the grantKey for a valid retry", async () => {
    const owner = await seed();
    const key = `overflow:${randomUUID()}`;
    const beforeState = await snapshot(owner);
    await assert.rejects(new PostgresSettlementStore(first).settle(key, owner, {
      currencyDelta: 25,
      items: [{ itemKey: "acorn", quantity: 1 }, { itemKey: "old-dagger", quantity: 2_147_483_647 }],
    }), { code: "22003" });
    assert.deepEqual(await snapshot(owner), beforeState);
    const result = await new PostgresSettlementStore(second).settle(key, owner, saleEffects);
    assert.deepEqual(result, { ok: true, balance: 125, items: [{ itemKey: "old-dagger", quantity: 0 }] });
    assert.deepEqual(await snapshot(owner), {
      balance: 125, bag: [], equipped: {}, ledger: [{ grant_key: key, result }],
    });
  });

  it("a waiting retry can acquire the grantKey after the first transaction rolls back", async () => {
    const owner = await seed();
    const key = `retry:${randomUUID()}`;
    await lockItem(owner);
    const failed = track(new PostgresSettlementStore(first).settle(key, owner, {
      currencyDelta: 25,
      itemDebits: [{ itemKey: "old-dagger", quantity: 2 }],
    }));
    await waitBlocked(firstPid, blockerPid);
    const retry = track(new PostgresSettlementStore(second).settle(key, owner, saleEffects));
    await waitBlocked(secondPid, firstPid);
    await blocker.query("COMMIT");
    assert.deepEqual(await failed, { ok: false, reason: "insufficient-item", itemKey: "old-dagger" });
    const result = await retry;
    assert.deepEqual(result, { ok: true, balance: 125, items: [{ itemKey: "old-dagger", quantity: 0 }] });
    assert.deepEqual(await snapshot(owner), {
      balance: 125, bag: [], equipped: {}, ledger: [{ grant_key: key, result }],
    });
  });

  it("twenty competing sale requests with different keys cannot sell the final item twice", async () => {
    const owner = await seed();
    const keys = Array.from({ length: 20 }, () => `sale:${randomUUID()}`);
    const results = await Promise.all(keys.map((key, index) => track(
      new PostgresSettlementStore(index % 2 === 0 ? first : second).settle(key, owner, saleEffects),
    )));
    const winner = results.findIndex((result) => result.ok);
    assert.notEqual(winner, -1);
    assert.equal(results.filter((result) => result.ok).length, 1);
    for (const result of results.filter((result) => !result.ok)) {
      assert.deepEqual(result, { ok: false, reason: "insufficient-item", itemKey: "old-dagger" });
    }
    assert.deepEqual(await snapshot(owner), {
      balance: 125, bag: [], equipped: {},
      ledger: [{ grant_key: keys[winner], result: results[winner] }],
    });
  });
});
