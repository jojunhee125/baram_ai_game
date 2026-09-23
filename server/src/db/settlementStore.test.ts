import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { InMemoryCurrencyStore } from "./currencyStore";
import { InMemoryInventoryStore } from "./inventoryStore";
import { runMigrations } from "./migrate";
import {
  InMemorySettlementStore,
  PostgresSettlementStore,
  type SettlementEffects,
  type SettlementOutcome,
  type SettlementStore,
} from "./settlementStore";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

/**
 * R04-a D2/D3 (`docs/r04-settlement.md` §4, §5): the two `SettlementStore`
 * implementations answer the same questions, `currencyStore.test.ts`'s own reason for its pair —
 * the in-memory one is the path local development and this whole suite actually run on.
 */
const OWNER = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const OTHER_OWNER = "f1e2d3c4-b5a6-4789-9876-543210fedcba";

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

interface FakeDatabase {
  currencyByOwner: Map<string, bigint>;
  bagsByOwner: Map<string, Map<string, number>>;
  grants: Map<string, { ownerKey: string; result: unknown | null }>;
}

function cloneDatabase(db: FakeDatabase): FakeDatabase {
  return {
    currencyByOwner: new Map(db.currencyByOwner),
    bagsByOwner: new Map([...db.bagsByOwner].map(([owner, bag]) => [owner, new Map(bag)])),
    grants: new Map([...db.grants].map(([key, row]) => [key, { ...row }])),
  };
}

/**
 * A stand-in for one checked-out `PoolClient`, driven by the exact SQL `PostgresCurrencyStore`,
 * `PostgresInventoryStore` and `PostgresSettlementStore` itself send — the same "implements what
 * each statement *says*" discipline `questStore.test.ts`'s own stub keeps. `BEGIN`/`COMMIT`/
 * `ROLLBACK` snapshot and restore the whole fake database, which is what proves the settlement is
 * really all-or-nothing at the statement level this suite can reach without a real transaction.
 */
function fakePool(db: FakeDatabase): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  let snapshot: FakeDatabase | null = null;

  function query(sql: string, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    queries.push({ sql, values });
    const text = sql.trim();
    try {
      if (text === "BEGIN") {
        snapshot = cloneDatabase(db);
        return Promise.resolve({ rows: [] });
      }
      if (text === "COMMIT") {
        snapshot = null;
        return Promise.resolve({ rows: [] });
      }
      if (text === "LOCK TABLE inventory_item IN ROW EXCLUSIVE MODE") {
        return Promise.resolve({ rows: [] });
      }
      if (text === "ROLLBACK") {
        if (snapshot !== null) {
          db.currencyByOwner = snapshot.currencyByOwner;
          db.bagsByOwner = snapshot.bagsByOwner;
          db.grants = snapshot.grants;
        }
        snapshot = null;
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO reward_grant")) {
        const [grantKey, ownerKey] = values as [string, string];
        if (db.grants.has(grantKey)) {
          return Promise.resolve({ rows: [] });
        }
        db.grants.set(grantKey, { ownerKey, result: null });
        return Promise.resolve({ rows: [{ grant_key: grantKey }] });
      }
      if (sql.includes("SELECT result, owner_key FROM reward_grant")) {
        const [grantKey] = values as [string];
        const row = db.grants.get(grantKey);
        return Promise.resolve({
          rows: row === undefined ? [] : [{ result: row.result, owner_key: row.ownerKey }],
        });
      }
      if (sql.includes("UPDATE reward_grant SET result")) {
        const [grantKey, result] = values as [string, unknown];
        const row = db.grants.get(grantKey);
        if (row !== undefined) {
          row.result = result;
        }
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT balance FROM player_currency")) {
        const [ownerKey] = values as [string];
        const balance = db.currencyByOwner.get(ownerKey);
        return Promise.resolve({ rows: balance === undefined ? [] : [{ balance: balance.toString() }] });
      }
      if (sql.includes("INSERT INTO player_currency")) {
        const [ownerKey, amount] = values as [string, number];
        const total = (db.currencyByOwner.get(ownerKey) ?? 0n) + BigInt(amount);
        db.currencyByOwner.set(ownerKey, total);
        return Promise.resolve({ rows: [{ balance: total.toString() }] });
      }
      if (sql.includes("UPDATE player_currency")) {
        const [ownerKey, amount] = values as [string, number];
        const current = db.currencyByOwner.get(ownerKey) ?? 0n;
        const debit = BigInt(amount);
        if (current < debit) {
          return Promise.resolve({ rows: [] });
        }
        const next = current - debit;
        db.currencyByOwner.set(ownerKey, next);
        return Promise.resolve({ rows: [{ balance: next.toString() }] });
      }
      if (sql.includes("INSERT INTO inventory_item")) {
        const [ownerKey, itemKey, quantity, maxDistinct] = values as [string, string, number, number];
        let bag = db.bagsByOwner.get(ownerKey);
        if (bag === undefined) {
          bag = new Map<string, number>();
          db.bagsByOwner.set(ownerKey, bag);
        }
        const held = bag.get(itemKey);
        if (held === undefined && bag.size >= maxDistinct) {
          return Promise.resolve({ rows: [] });
        }
        const total = (held ?? 0) + quantity;
        bag.set(itemKey, total);
        return Promise.resolve({ rows: [{ quantity: total }] });
      }
      if (sql.includes("SELECT equipped_slot FROM inventory_item")) {
        assert.match(sql, /FOR UPDATE/, "equipment check must retain the item lock until settlement commits");
        const [ownerKey, itemKey] = values as [string, string];
        return Promise.resolve({ rows: db.bagsByOwner.get(ownerKey)?.has(itemKey) ? [{ equipped_slot: null }] : [] });
      }
      if (sql.includes("DELETE FROM inventory_item")) {
        // `InventoryStore.remove`'s single-statement DELETE-or-UPDATE (design §9 D10).
        const [ownerKey, itemKey, quantity] = values as [string, string, number];
        const bag = db.bagsByOwner.get(ownerKey);
        const held = bag?.get(itemKey);
        if (bag === undefined || held === undefined || held < quantity) {
          return Promise.resolve({ rows: [] });
        }
        const total = held - quantity;
        if (total === 0) {
          bag.delete(itemKey);
        } else {
          bag.set(itemKey, total);
        }
        return Promise.resolve({ rows: [{ quantity: total }] });
      }
      throw new Error(`fake client received unhandled SQL: ${sql}`);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const client = { query, release: () => undefined } as unknown as PoolClient;
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { pool, queries };
}

function newFakeDatabase(): FakeDatabase {
  return { currencyByOwner: new Map(), bagsByOwner: new Map(), grants: new Map() };
}

const IMPLEMENTATIONS: readonly [string, () => SettlementStore][] = [
  ["InMemorySettlementStore", () => new InMemorySettlementStore()],
  ["PostgresSettlementStore", () => new PostgresSettlementStore(fakePool(newFakeDatabase()).pool)],
];

for (const [name, create] of IMPLEMENTATIONS) {
  describe(`SettlementStore contract — ${name}`, () => {
    it("applies a currency credit and an item grant together, once", async () => {
      const store = create();
      const outcome = await store.settle("quest:first-hunt:" + OWNER, OWNER, {
        currencyDelta: 10,
        items: [{ itemKey: "acorn", quantity: 3 }],
      });
      assert.deepEqual(outcome, {
        ok: true,
        balance: 10,
        items: [{ itemKey: "acorn", quantity: 3 }],
      });
    });

    it("replays the exact original outcome on a repeated grantKey, changing nothing further", async () => {
      const store = create();
      const grantKey = "quest:first-hunt:" + OWNER;
      const first = await store.settle(grantKey, OWNER, { currencyDelta: 10 });
      const second = await store.settle(grantKey, OWNER, { currencyDelta: 10 });
      assert.deepEqual(second, first, "a replay must answer the same object the first call did");
      const third = await store.settle(grantKey, OWNER, { currencyDelta: 999 });
      assert.deepEqual(third, first, "even a differently-shaped retry replays the stored result");
    });

    it("declines a currency delta the account cannot afford, and leaves no ledger row", async () => {
      const store = create();
      const declined = await store.settle("shop:" + OWNER + ":n1", OWNER, { currencyDelta: -5 });
      assert.deepEqual(declined, { ok: false, reason: "insufficient-balance" });
      // No trace: the same grantKey can be retried once the account can afford it.
      await store.settle("credit-first", OWNER, { currencyDelta: 5 });
      const retried = await store.settle("shop:" + OWNER + ":n1", OWNER, { currencyDelta: -5 });
      assert.deepEqual(retried, { ok: true, balance: 0, items: [] });
    });

    it("declines all effects when one item would overflow the bag, refunding no partial currency change", async () => {
      const store = create();
      // Fill the bag with MAX_DISTINCT_ITEMS distinct keys first via ordinary grants.
      for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
        const outcome = await store.settle(`filler:${index}`, OWNER, {
          items: [{ itemKey: `filler-${index}`, quantity: 1 }],
        });
        assert.equal(outcome.ok, true, `filler ${index} must fit under the cap`);
      }
      const declined = await store.settle("overflow-attempt", OWNER, {
        currencyDelta: 50,
        items: [{ itemKey: "brand-new-item", quantity: 1 }],
      });
      assert.equal(declined.ok, false);
      if (!declined.ok) {
        assert.equal(declined.reason, "bag-full");
      }
      // The currency delta from the declined batch must not have landed either.
      const retryWithOnlyCurrency = await store.settle("overflow-attempt-currency-only", OWNER, {
        currencyDelta: 50,
      });
      assert.deepEqual(retryWithOnlyCurrency, { ok: true, balance: 50, items: [] });
    });

    it("debits an item and credits currency together, once (a sale, roadmap R04-c)", async () => {
      const store = create();
      await store.settle("grant-herb", OWNER, { items: [{ itemKey: "herb", quantity: 5 }] });
      const outcome = await store.settle("sell:" + OWNER + ":herb:2:n1", OWNER, {
        currencyDelta: 6,
        itemDebits: [{ itemKey: "herb", quantity: 2 }],
      });
      assert.deepEqual(outcome, { ok: true, balance: 6, items: [{ itemKey: "herb", quantity: 3 }] });
    });

    it("declines a debit for more than the account holds, refunding no partial currency change", async () => {
      const store = create();
      await store.settle("grant-herb-2", OWNER, { items: [{ itemKey: "herb", quantity: 1 }] });
      const declined = await store.settle("sell:" + OWNER + ":herb:5:n1", OWNER, {
        currencyDelta: 15,
        itemDebits: [{ itemKey: "herb", quantity: 5 }],
      });
      assert.deepEqual(declined, { ok: false, reason: "insufficient-item", itemKey: "herb" });
      // No ledger row on a decline (design §4 D3): the same grantKey can be retried once the
      // account holds enough, and no currency landed from the declined attempt either.
      const retryCurrencyOnly = await store.settle("sell-retry-currency-only", OWNER, { currencyDelta: 15 });
      assert.deepEqual(retryCurrencyOnly, { ok: true, balance: 15, items: [] });
    });

    it("declines a debit against an item the account never held at all", async () => {
      const store = create();
      const declined = await store.settle("use:" + OWNER + ":herb:n1", OWNER, {
        itemDebits: [{ itemKey: "herb", quantity: 1 }],
      });
      assert.deepEqual(declined, { ok: false, reason: "insufficient-item", itemKey: "herb" });
    });

    it("empties the stack to a gone row (quantity 0) when a debit removes every unit", async () => {
      const store = create();
      await store.settle("grant-herb-3", OWNER, { items: [{ itemKey: "herb", quantity: 1 }] });
      const outcome = await store.settle("use:" + OWNER + ":herb:n1", OWNER, {
        itemDebits: [{ itemKey: "herb", quantity: 1 }],
      });
      assert.deepEqual(outcome, { ok: true, balance: undefined, items: [{ itemKey: "herb", quantity: 0 }] });
    });

    it("keeps two accounts and two grant keys apart", async () => {
      const store = create();
      await store.settle("quest:a:" + OWNER, OWNER, { currencyDelta: 7 });
      await store.settle("quest:a:" + OTHER_OWNER, OTHER_OWNER, { currencyDelta: 20 });
      const ownerOutcome = await store.settle("quest:a:" + OWNER, OWNER, { currencyDelta: 999 });
      const otherOutcome = await store.settle("quest:a:" + OTHER_OWNER, OTHER_OWNER, { currencyDelta: 999 });
      assert.equal((ownerOutcome as { balance?: number }).balance, 7);
      assert.equal((otherOutcome as { balance?: number }).balance, 20);
    });

    it("accepts a zero currency delta as touching no balance at all", async () => {
      const store = create();
      const outcome = await store.settle("zero-delta", OWNER, { currencyDelta: 0, items: [] });
      assert.deepEqual(outcome, { ok: true, balance: undefined, items: [] });
      // Confirmed by a real credit afterwards: the zero-delta call above left nothing behind to add to.
      const credited = await store.settle("zero-delta-then-credit", OWNER, { currencyDelta: 3 });
      assert.deepEqual(credited, { ok: true, balance: 3, items: [] });
    });

    it("rejects a non-integer currency delta, and a non-positive item quantity", async () => {
      const store = create();
      for (const currencyDelta of [1.5, Number.NaN]) {
        await assert.rejects(() => store.settle("bad-currency", OWNER, { currencyDelta }), TypeError);
      }
      for (const quantity of [0, -1, 1.5]) {
        await assert.rejects(
          () => store.settle("bad-item", OWNER, { items: [{ itemKey: "acorn", quantity }] }),
          TypeError,
        );
      }
    });

    it("rejects an empty grantKey and a non-uuid owner key", async () => {
      const store = create();
      await assert.rejects(() => store.settle("", OWNER, {}), TypeError);
      await assert.rejects(() => store.settle("k", "session-abc", {}), TypeError);
    });
  });
}

describe("InMemorySettlementStore", () => {
  it("never touches the database status field", async () => {
    resetDatabaseStatus();
    const store = new InMemorySettlementStore();
    await store.settle("k", OWNER, { currencyDelta: 4 });
    assert.equal(getDatabaseStatus(), "disabled");
  });

  it("settles every one of 25 concurrent calls sharing one grantKey exactly once", async () => {
    const store = new InMemorySettlementStore();
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, () => store.settle("shared", OWNER, { currencyDelta: 10 })),
    );
    for (const outcome of outcomes) {
      assert.deepEqual(outcome, outcomes[0], "every caller must see the one outcome that was applied");
    }
    assert.deepEqual(outcomes[0], { ok: true, balance: 10, items: [] });
  });

  it("credits and grants land in the shared CurrencyStore/InventoryStore a room's other reads use", async () => {
    // The bug this guards: a settlement that kept its own private balance/bag would apply in
    // local development yet never show up in `GET /api/inventory` or any other reader of the
    // same account's shared stores.
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const store = new InMemorySettlementStore(currencyStore, inventoryStore);
    await store.settle("shared-stores", OWNER, {
      currencyDelta: 15,
      items: [{ itemKey: "acorn", quantity: 2 }],
    });
    assert.equal(await currencyStore.getBalance(OWNER), 15);
    assert.deepEqual(await inventoryStore.list(OWNER), [{ itemKey: "acorn", quantity: 2, equipped: false }]);
  });

  it("does not touch the shared stores at all when the settlement declines", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const store = new InMemorySettlementStore(currencyStore, inventoryStore);
    const declined = await store.settle("declined", OWNER, { currencyDelta: -1 });
    assert.deepEqual(declined, { ok: false, reason: "insufficient-balance" });
    assert.equal(await currencyStore.getBalance(OWNER), 0);
    assert.deepEqual(await inventoryStore.list(OWNER), []);
  });
});

describe("PostgresSettlementStore — the statements it sends", () => {
  beforeEach(resetDatabaseStatus);

  it("gates on a single INSERT ... ON CONFLICT DO NOTHING before touching any other table", async () => {
    const { pool, queries } = fakePool(newFakeDatabase());
    await new PostgresSettlementStore(pool).settle("k", OWNER, {
      currencyDelta: 10,
      items: [{ itemKey: "acorn", quantity: 1 }],
    });
    const statements = queries.map((entry) => entry.sql);
    assert.match(statements[0] ?? "", /^BEGIN$/);
    assert.match(statements[1] ?? "", /INSERT INTO reward_grant/);
    assert.match(statements[1] ?? "", /ON CONFLICT \(grant_key\) DO NOTHING/);
  });

  it("touches currency before any item, and items in item_key ascending order", async () => {
    const { pool, queries } = fakePool(newFakeDatabase());
    await new PostgresSettlementStore(pool).settle("k", OWNER, {
      currencyDelta: 10,
      items: [
        { itemKey: "zebra-charm", quantity: 1 },
        { itemKey: "acorn", quantity: 1 },
      ],
    });
    const tables = queries
      .map((entry) => entry.sql)
      .filter((sql) => sql.includes("player_currency") || sql.includes("inventory_item"));
    assert.match(tables[0] ?? "", /player_currency/, "currency must be touched first");
    const itemInserts = queries.filter((entry) => entry.sql.includes("INSERT INTO inventory_item"));
    assert.equal(itemInserts[0]?.values[1], "acorn", "item_key ascending: acorn before zebra-charm");
    assert.equal(itemInserts[1]?.values[1], "zebra-charm");
  });

  it("keeps a batch's own order between two entries that name the same item_key", async () => {
    // The comparator answers 0 for equal keys and relies on Array.prototype.sort's guaranteed
    // stability (ES2019) — a comparator that answered 1 here would leave this order unspecified.
    const { pool, queries } = fakePool(newFakeDatabase());
    await new PostgresSettlementStore(pool).settle("k", OWNER, {
      items: [
        { itemKey: "acorn", quantity: 1 },
        { itemKey: "acorn", quantity: 4 },
      ],
    });
    const itemInserts = queries.filter((entry) => entry.sql.includes("INSERT INTO inventory_item"));
    assert.equal(itemInserts.length, 2);
    assert.equal(itemInserts[0]?.values[2], 1, "the first entry in the batch is applied first");
    assert.equal(itemInserts[1]?.values[2], 4);
  });

  it("does not replay when the gate finds no row (first-time settlement)", async () => {
    const { pool, queries } = fakePool(newFakeDatabase());
    await new PostgresSettlementStore(pool).settle("k", OWNER, { currencyDelta: 1 });
    assert.equal(
      queries.some((entry) => entry.sql.includes("SELECT result, owner_key FROM reward_grant")),
      false,
      "the replay SELECT only runs on the conflict path",
    );
  });

  it("marks the database ok on a decline, since it rolled back cleanly rather than failing", async () => {
    const { pool } = fakePool(newFakeDatabase());
    await new PostgresSettlementStore(pool).settle("k", OWNER, { currencyDelta: -1 });
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database degraded and rethrows when a query genuinely fails", async () => {
    const broken = {
      connect: () =>
        Promise.resolve({
          query: () => Promise.reject(new Error("connection terminated unexpectedly")),
          release: () => undefined,
        }),
    } as unknown as Pool;
    await assert.rejects(
      () => new PostgresSettlementStore(broken).settle("k", OWNER, { currencyDelta: 1 }),
      /connection terminated/,
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });
});

/**
 * Opt-in against a real Postgres, `currencyStore.test.ts`'s own convention — this is what a
 * synchronous stub cannot show at all: two settle() calls for the same grantKey genuinely
 * in flight at once, blocked against each other by Postgres's own row lock rather than by this
 * suite's single-threaded ordering, and a lock order that really does avoid a deadlock under two
 * opposite-order concurrent settlements.
 *
 * NOT executed in this implementation session — no Docker/Postgres was reachable here (see the
 * implementation record). The block is written and ready; it runs the moment
 * `ZEP_TEST_DATABASE_URL` is set.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "PostgresSettlementStore — against a real server",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 8 });
      await runMigrations(pool);
      resetDatabaseStatus();
    });

    after(async () => {
      await pool.end();
      resetDatabaseStatus();
    });

    it("applies exactly one of 16 concurrent settle() calls sharing a grantKey", async () => {
      const store = new PostgresSettlementStore(pool);
      const ownerKey = randomUUID();
      // Unique per run, not the literal "shared": this describe block runs against a persistent
      // database, and a fixed grantKey would collide with whatever owner a *previous* run of this
      // suite already settled it for — exactly the cross-owner mismatch `settleWithinTransaction`
      // is now supposed to catch, but for an innocent reason (test reuse) rather than a real bug.
      const grantKey = `shared:${randomUUID()}`;
      const outcomes = await Promise.all(
        Array.from({ length: 16 }, () => store.settle(grantKey, ownerKey, { currencyDelta: 10 })),
      );
      for (const outcome of outcomes) {
        assert.deepEqual(outcome, outcomes[0]);
      }
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM reward_grant WHERE grant_key = $1",
        [grantKey],
      );
      assert.equal(rows.rows[0]?.count, "1");
    });

    it("does not deadlock when two settlements touch the same two items in opposite order", async () => {
      const store = new PostgresSettlementStore(pool);
      const ownerKey = randomUUID();
      const suffix = randomUUID();
      const outcomes = await Promise.all([
        store.settle(`order-a:${suffix}`, ownerKey, {
          items: [
            { itemKey: "acorn", quantity: 1 },
            { itemKey: "zebra-charm", quantity: 1 },
          ],
        }),
        store.settle(`order-b:${suffix}`, ownerKey, {
          items: [
            { itemKey: "zebra-charm", quantity: 1 },
            { itemKey: "acorn", quantity: 1 },
          ],
        }),
      ]);
      assert.equal(outcomes.every((outcome) => outcome.ok), true, "the fixed lock order must prevent a deadlock");
    });

    it("leaves reward_grant untouched after a declined settlement, so a retry can still succeed", async () => {
      const store = new PostgresSettlementStore(pool);
      const ownerKey = randomUUID();
      const grantKey = `later-retry:${randomUUID()}`;
      const declined = await store.settle(grantKey, ownerKey, { currencyDelta: -1 });
      assert.deepEqual(declined, { ok: false, reason: "insufficient-balance" });
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM reward_grant WHERE grant_key = $1",
        [grantKey],
      );
      assert.equal(rows.rows[0]?.count, "0");
    });
  },
);
