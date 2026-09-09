import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool } from "pg";
import { MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import {
  InMemoryInventoryStore,
  PostgresInventoryStore,
  type InventoryRow,
  type InventoryStore,
} from "./inventoryStore";
import { runMigrations } from "./migrate";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

const OWNER = "1f0d1a9c-6b7e-4f2a-9c31-0c4c2a5b8e10";
const OTHER_OWNER = "7c2b4d55-1e3f-4a88-b0d2-9f6e5c4a3b21";

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

/**
 * The narrow slice of `pg.Pool` the store touches, exactly as in profileStore.test.ts: casting a
 * stub rather than reaching for a real Postgres keeps these in the suite that runs without one.
 * The end-to-end proof that this SQL is valid is a container run, not this file.
 */
function stubPool(
  respond: (sql: string, values: readonly unknown[]) => { rows: Record<string, unknown>[] },
): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query(sql: string, values: readonly unknown[]) {
      queries.push({ sql, values });
      try {
        return Promise.resolve(respond(sql, values));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as Pool;
  return { pool, queries };
}

/** Store order is undefined by contract, so every comparison sorts first. */
function sorted(rows: readonly InventoryRow[]): InventoryRow[] {
  return [...rows].sort((left, right) => (left.itemKey < right.itemKey ? -1 : 1));
}

/**
 * Both implementations answer the same questions, because one of them is what local development
 * and the whole server suite actually run on (design §2.4) — a contract that drifts between them
 * would only be found in production.
 */
function assertInventoryStoreContract(label: string, create: () => InventoryStore): void {
  describe(`InventoryStore contract — ${label}`, () => {
    it("answers an empty bag for an owner it has never seen", async () => {
      assert.deepEqual(await create().list(OWNER), []);
    });

    it("returns what was granted, with the total", async () => {
      const store = create();
      assert.equal(await store.add(OWNER, "acorn", 3), 3);
      assert.deepEqual(await store.list(OWNER), [{ itemKey: "acorn", quantity: 3, equipped: false }]);
    });

    it("adds to an existing stack rather than replacing it", async () => {
      const store = create();
      await store.add(OWNER, "acorn", 3);
      assert.equal(await store.add(OWNER, "acorn", 4), 7, "the total is after the grant");
      assert.deepEqual(await store.list(OWNER), [{ itemKey: "acorn", quantity: 7, equipped: false }]);
    });

    it("keeps two item kinds apart in one bag", async () => {
      const store = create();
      await store.add(OWNER, "acorn", 2);
      await store.add(OWNER, "carrot", 5);
      assert.deepEqual(sorted(await store.list(OWNER)), [
        { itemKey: "acorn", quantity: 2, equipped: false },
        { itemKey: "carrot", quantity: 5, equipped: false },
      ]);
    });

    it("keeps two owners apart", async () => {
      const store = create();
      await store.add(OWNER, "acorn", 2);
      await store.add(OTHER_OWNER, "acorn", 9);
      assert.deepEqual(await store.list(OWNER), [{ itemKey: "acorn", quantity: 2, equipped: false }]);
      assert.deepEqual(await store.list(OTHER_OWNER), [{ itemKey: "acorn", quantity: 9, equipped: false }]);
    });

    it("survives a hundred grants of the same key without losing one", async () => {
      // The read-modify-write this store exists to avoid would drop most of these once the
      // awaits interleave; sequential or not, the total is the only honest answer.
      const store = create();
      let last: number | null = null;
      for (let index = 0; index < 100; index += 1) {
        last = await store.add(OWNER, "copper-coin", 1);
      }
      assert.equal(last, 100);
    });

    it("does not lose grants issued concurrently for one key", async () => {
      const store = create();
      const totals = await Promise.all(
        Array.from({ length: 25 }, () => store.add(OWNER, "herb", 2)),
      );
      assert.equal(totals.includes(null), false, "none of these can be a full bag");
      assert.deepEqual(await store.list(OWNER), [{ itemKey: "herb", quantity: 50, equipped: false }]);
      // Every intermediate total is distinct, which is what "atomic" means from outside: no two
      // grants can have read the same prior amount.
      assert.equal(new Set(totals).size, 25);
    });

    it("answers null instead of throwing once the bag holds MAX_DISTINCT_ITEMS kinds", async () => {
      const store = create();
      for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
        assert.equal(await store.add(OWNER, `filler-${index}`, 1), 1, `kind ${index}`);
      }
      assert.equal(await store.add(OWNER, "one-too-many", 1), null);
      assert.equal(
        (await store.list(OWNER)).some((row) => row.itemKey === "one-too-many"),
        false,
        "a refused grant must not leave a row behind",
      );
    });

    it("still tops up a kind already held when the bag is full", async () => {
      // The case the capacity check is most likely to get wrong: a full bag that stops accepting
      // more of what it already holds turns every later drop into a lost reward.
      const store = create();
      for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
        await store.add(OWNER, `filler-${index}`, 1);
      }
      assert.equal(await store.add(OWNER, "filler-0", 5), 6);
      assert.equal(await store.add(OWNER, "another-new-one", 1), null, "still full");
    });

    it("does not let one owner's full bag refuse another owner's first item", async () => {
      const store = create();
      for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
        await store.add(OWNER, `filler-${index}`, 1);
      }
      assert.equal(await store.add(OTHER_OWNER, "acorn", 1), 1);
    });

    it("rejects a quantity the quantity > 0 CHECK would reject, in both implementations", async () => {
      const store = create();
      for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await assert.rejects(
          () => store.add(OWNER, "acorn", quantity),
          /positive integer/,
          `quantity ${quantity}`,
        );
      }
      assert.deepEqual(await store.list(OWNER), [], "nothing may have been written");
    });

    it("grantOnce credits a cap-one item the first time and answers true", async () => {
      const store = create();
      assert.equal(await store.grantOnce(OWNER, "entry-pass"), true);
      assert.deepEqual(await store.list(OWNER), [{ itemKey: "entry-pass", quantity: 1, equipped: false }]);
    });

    it("grantOnce answers false, and stores nothing new, on every later call", async () => {
      const store = create();
      assert.equal(await store.grantOnce(OWNER, "entry-pass"), true);
      assert.equal(await store.grantOnce(OWNER, "entry-pass"), false);
      assert.equal(await store.grantOnce(OWNER, "entry-pass"), false);
      assert.deepEqual(await store.list(OWNER), [{ itemKey: "entry-pass", quantity: 1, equipped: false }]);
    });

    it("grantOnce answers false instead of throwing once the bag is at MAX_DISTINCT_ITEMS", async () => {
      const store = create();
      for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
        await store.add(OWNER, `filler-${index}`, 1);
      }
      assert.equal(await store.grantOnce(OWNER, "entry-pass"), false);
      assert.deepEqual(
        (await store.list(OWNER)).some((row) => row.itemKey === "entry-pass"),
        false,
        "a refused grant must not leave a row behind",
      );
    });

    it("grantOnce keeps two owners apart", async () => {
      const store = create();
      assert.equal(await store.grantOnce(OWNER, "entry-pass"), true);
      assert.equal(await store.grantOnce(OTHER_OWNER, "entry-pass"), true);
      assert.deepEqual(await store.list(OTHER_OWNER), [{ itemKey: "entry-pass", quantity: 1, equipped: false }]);
    });

    it("grantOnce is atomic under concurrency: exactly one caller wins, quantity never exceeds 1", async () => {
      // The cap-of-1 invariant Phase G's entry pass depends on. A check-then-set race across an
      // await boundary would let two concurrent kills both see "not held yet" and both grant.
      const store = create();
      const results = await Promise.all(
        Array.from({ length: 25 }, () => store.grantOnce(OWNER, "entry-pass")),
      );
      assert.equal(results.filter((won) => won).length, 1, "exactly one of 25 concurrent callers must win");
      assert.equal(results.filter((won) => !won).length, 24);
      assert.deepEqual(await store.list(OWNER), [{ itemKey: "entry-pass", quantity: 1, equipped: false }]);
    });
  });
}

/**
 * A stand-in Postgres: one row per (owner, item), driven by the store's own SQL. The responder
 * reproduces the parts of the statement that matter — the capacity predicate, the ON CONFLICT
 * accumulation, and returning no row when the predicate is false.
 */
function inMemoryBackedPostgresStore(): InventoryStore {
  const rows = new Map<string, Map<string, number>>();
  const { pool } = stubPool((sql, values) => {
    const ownerKey = String(values[0]);
    let bag = rows.get(ownerKey);
    if (bag === undefined) {
      bag = new Map<string, number>();
      rows.set(ownerKey, bag);
    }
    if (sql.includes("SELECT item_key, quantity")) {
      // Never equipped by anything this stub drives: no existing test in this file calls
      // `equip`, and `equip`/`unequip`/`getEquipped` route to the branches below unexercised.
      return { rows: [...bag].map(([item_key, quantity]) => ({ item_key, quantity, equipped: false })) };
    }
    const itemKey = String(values[1]);
    const held = bag.get(itemKey);
    // grantOnce's statement carries no quantity parameter — cap is $3, not $4 — and DO NOTHING
    // instead of DO UPDATE, so a held key answers false rather than topping up.
    if (sql.includes("DO NOTHING")) {
      if (held !== undefined || bag.size >= Number(values[2])) {
        return { rows: [] };
      }
      bag.set(itemKey, 1);
      return { rows: [{ quantity: 1 }] };
    }
    if (held === undefined && bag.size >= Number(values[3])) {
      return { rows: [] };
    }
    const total = (held ?? 0) + Number(values[2]);
    bag.set(itemKey, total);
    return { rows: [{ quantity: total }] };
  });
  return new PostgresInventoryStore(pool);
}

assertInventoryStoreContract("InMemoryInventoryStore", () => new InMemoryInventoryStore());
assertInventoryStoreContract("PostgresInventoryStore", inMemoryBackedPostgresStore);

describe("InMemoryInventoryStore", () => {
  it("keeps nothing across instances, which is what makes a restart look like a first visit", async () => {
    const first = new InMemoryInventoryStore();
    await first.add(OWNER, "acorn", 4);
    assert.deepEqual(await new InMemoryInventoryStore().list(OWNER), []);
  });

  it("never touches the database status field", async () => {
    resetDatabaseStatus();
    const store = new InMemoryInventoryStore();
    await store.add(OWNER, "acorn", 1);
    await store.list(OWNER);
    assert.equal(getDatabaseStatus(), "disabled", "the no-database mode must stay 'disabled'");
  });

  it("hands out a snapshot the caller cannot write back through", async () => {
    const store = new InMemoryInventoryStore();
    await store.add(OWNER, "acorn", 1);
    const rows = await store.list(OWNER);
    (rows[0] as InventoryRow).quantity = 999;
    assert.deepEqual(await store.list(OWNER), [{ itemKey: "acorn", quantity: 1, equipped: false }]);
  });
});

describe("PostgresInventoryStore — the statements it sends", () => {
  beforeEach(resetDatabaseStatus);

  it("reads one owner's rows and nothing else", async () => {
    const { pool, queries } = stubPool(() => ({
      rows: [
        { item_key: "acorn", quantity: 3, equipped: false },
        { item_key: "carrot", quantity: 1, equipped: true },
      ],
    }));
    const rows = await new PostgresInventoryStore(pool).list(OWNER);
    assert.deepEqual(rows, [
      { itemKey: "acorn", quantity: 3, equipped: false },
      { itemKey: "carrot", quantity: 1, equipped: true },
    ]);
    assert.equal(queries.length, 1);
    assert.match(
      queries[0]?.sql ?? "",
      /SELECT item_key, quantity, equipped_slot IS NOT NULL AS equipped FROM inventory_item WHERE owner_key = \$1/,
    );
    assert.deepEqual(queries[0]?.values, [OWNER]);
  });

  it("does not order the read, because display order belongs to ITEM_DEFINITIONS", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    await new PostgresInventoryStore(pool).list(OWNER);
    assert.doesNotMatch(
      queries[0]?.sql ?? "",
      /ORDER BY/i,
      "an ordering here is a second answer nobody keeps in step with the first",
    );
  });

  it("grants with a single statement, so a drop cannot be lost between a read and a write", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ quantity: 7 }] }));
    assert.equal(await new PostgresInventoryStore(pool).add(OWNER, "acorn", 3), 7);
    assert.equal(queries.length, 1, "read-modify-write would be two statements");
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO inventory_item/);
    assert.match(sql, /ON CONFLICT \(owner_key, item_key\)/);
    assert.match(sql, /DO UPDATE SET quantity = inventory_item\.quantity \+ EXCLUDED\.quantity/);
    assert.match(sql, /RETURNING quantity/, "ItemGranted.total comes from here");
    assert.deepEqual(queries[0]?.values, [OWNER, "acorn", 3, MAX_DISTINCT_ITEMS]);
  });

  it("carries the capacity test inside that same statement", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ quantity: 1 }] }));
    await new PostgresInventoryStore(pool).add(OWNER, "acorn", 1);
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /count\(\*\)/, "a separate COUNT round trip is what this avoids");
    assert.match(sql, /EXISTS/, "a held key must top up regardless of the count");
    assert.equal(queries.length, 1);
  });

  it("grantOnce sends a single DO NOTHING statement with a literal quantity of 1", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ quantity: 1 }] }));
    assert.equal(await new PostgresInventoryStore(pool).grantOnce(OWNER, "entry-pass"), true);
    assert.equal(queries.length, 1);
    const sql = queries[0]?.sql ?? "";
    assert.match(sql, /INSERT INTO inventory_item/);
    assert.match(sql, /SELECT \$1, \$2, 1\b/, "quantity is a literal, not a parameter");
    assert.match(sql, /ON CONFLICT \(owner_key, item_key\) DO NOTHING/);
    assert.match(sql, /RETURNING quantity/);
    assert.deepEqual(queries[0]?.values, [OWNER, "entry-pass", MAX_DISTINCT_ITEMS]);
  });

  it("grantOnce answers false, without throwing, when the conflict branch returns no row", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    assert.equal(await new PostgresInventoryStore(pool).grantOnce(OWNER, "entry-pass"), false);
  });

  it("passes the cap as a parameter rather than interpolating it into the statement", async () => {
    // Not a security point — the value is a module constant — but a per-call literal would give
    // the planner a new statement text for every distinct cap and lose the prepared plan.
    const { pool, queries } = stubPool(() => ({ rows: [{ quantity: 1 }] }));
    await new PostgresInventoryStore(pool).add(OWNER, "acorn", 1);
    assert.doesNotMatch(queries[0]?.sql ?? "", new RegExp(`< ${MAX_DISTINCT_ITEMS}\\b`));
    assert.match(queries[0]?.sql ?? "", /< \$4/);
  });

  it("reads an empty result as a full bag rather than as an error", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    assert.equal(await new PostgresInventoryStore(pool).add(OWNER, "acorn", 1), null);
  });

  it("sends nothing at all for a quantity the CHECK would refuse", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [{ quantity: 1 }] }));
    await assert.rejects(() => new PostgresInventoryStore(pool).add(OWNER, "acorn", 0));
    assert.deepEqual(queries, [], "a 23514 would be indistinguishable from a dropped connection");
    assert.equal(getDatabaseStatus(), "disabled", "and would wrongly mark the database degraded");
  });

  it("sends nothing at all for an owner key that is not a uuid, on a grant", async () => {
    // The shape a killer with no SSO identity produces: `awardLoot` falls back to the session id,
    // which is never a uuid. A `22P02` here would be exactly as indistinguishable from a dropped
    // connection as the quantity CHECK's `23514` above.
    const { pool, queries } = stubPool(() => ({ rows: [{ quantity: 1 }] }));
    await assert.rejects(() => new PostgresInventoryStore(pool).add("attacker-session-id", "acorn", 1));
    assert.deepEqual(queries, []);
    assert.equal(getDatabaseStatus(), "disabled", "and would wrongly mark the database degraded");
  });

  it("sends nothing at all for an owner key that is not a uuid, on a read", async () => {
    const { pool, queries } = stubPool(() => ({ rows: [] }));
    await assert.rejects(() => new PostgresInventoryStore(pool).list("attacker-session-id"));
    assert.deepEqual(queries, []);
    assert.equal(getDatabaseStatus(), "disabled", "and would wrongly mark the database degraded");
  });
});

describe("PostgresInventoryStore — health reporting", () => {
  beforeEach(resetDatabaseStatus);

  it("marks the database ok on a successful read", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    await new PostgresInventoryStore(pool).list(OWNER);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database ok on a successful grant", async () => {
    const { pool } = stubPool(() => ({ rows: [{ quantity: 1 }] }));
    await new PostgresInventoryStore(pool).add(OWNER, "acorn", 1);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database ok on a full bag, which is an answer and not a fault", async () => {
    const { pool } = stubPool(() => ({ rows: [] }));
    assert.equal(await new PostgresInventoryStore(pool).add(OWNER, "acorn", 1), null);
    assert.equal(getDatabaseStatus(), "ok");
  });

  it("marks the database degraded and rethrows when a read fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresInventoryStore(pool).list(OWNER),
      /connection terminated/,
      "the route decides what a failed read means; the store must not swallow it",
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("marks the database degraded and rethrows when a grant fails", async () => {
    const { pool } = stubPool(() => {
      throw new Error("connection terminated unexpectedly");
    });
    await assert.rejects(
      () => new PostgresInventoryStore(pool).add(OWNER, "acorn", 1),
      /connection terminated/,
      "a failed grant must not read as a full bag — the caller would tell the player the wrong thing",
    );
    assert.equal(getDatabaseStatus(), "degraded");
  });

  it("recovers to ok on the next query that succeeds", async () => {
    let fail = true;
    const { pool } = stubPool(() => {
      if (fail) {
        throw new Error("terminating connection due to administrator command");
      }
      return { rows: [{ item_key: "acorn", quantity: 2, equipped: false }] };
    });
    const store = new PostgresInventoryStore(pool);
    await assert.rejects(() => store.list(OWNER));
    assert.equal(getDatabaseStatus(), "degraded");
    fail = false;
    assert.deepEqual(await store.list(OWNER), [{ itemKey: "acorn", quantity: 2, equipped: false }]);
    assert.equal(getDatabaseStatus(), "ok", "a database that answers again must stop reading as degraded");
  });

  it("reports a rejected value the pg driver never wrapped in an Error", async () => {
    const { pool } = stubPool(() => {
      throw "socket hang up";
    });
    await assert.rejects(() => new PostgresInventoryStore(pool).list(OWNER));
    assert.equal(getDatabaseStatus(), "degraded");
  });
});

/**
 * The half of `PostgresInventoryStore` no stub can reach: whether the statement is *valid SQL
 * against the shipped DDL*, and whether the capacity predicate and the ON CONFLICT accumulation
 * mean there what they were written to mean.
 *
 * Opt-in, and it has to be: design §2.4 makes "the whole server suite runs with no Postgres to
 * point it at" a property of this project, so a suite that needed a container would break every
 * developer and CI run that has not got one. Set the variable and it runs; leave it and the two
 * cases below are reported as skipped rather than quietly absent.
 *
 *   docker run -d --rm --name zep-inv-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=zeptest \
 *     -p 55440:5432 postgres:17-alpine
 *   ZEP_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55440/zeptest npm test -w @zep-test/server
 *
 * Non-destructive by construction: it creates its own owner uuids and never deletes a row or
 * truncates a table, so pointing it at a database that holds something else costs that database
 * a handful of rows under uuids nothing else uses. It does run the migrations, which is
 * deliberate — the DDL is part of what is under test.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

/**
 * Wraps the real store so that the shared contract's two fixed owner constants become a fresh
 * pair of uuids per `create()`. Without this every case in the contract would inherit the rows
 * the previous one left in the one table they all share.
 */
function ownerScopedStore(pool: Pool): InventoryStore {
  const inner = new PostgresInventoryStore(pool);
  const owners = new Map<string, string>();
  const resolve = (ownerKey: string): string => {
    let mapped = owners.get(ownerKey);
    if (mapped === undefined) {
      mapped = randomUUID();
      owners.set(ownerKey, mapped);
    }
    return mapped;
  };
  return {
    list: (ownerKey) => inner.list(resolve(ownerKey)),
    add: (ownerKey, itemKey, quantity) => inner.add(resolve(ownerKey), itemKey, quantity),
    grantOnce: (ownerKey, itemKey) => inner.grantOnce(resolve(ownerKey), itemKey),
    getEquippedSlots: (ownerKey) => inner.getEquippedSlots(resolve(ownerKey)),
    equip: (ownerKey, itemKey, slot) => inner.equip(resolve(ownerKey), itemKey, slot),
    unequip: (ownerKey, slot) => inner.unequip(resolve(ownerKey), slot),
  };
}

describe("PostgresInventoryStore — against a real server", { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false }, () => {
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

  // The same assertions the in-memory store answers, so "two implementations, one contract" is
  // a fact about the shipped SQL rather than about a hand-written responder that agrees with it.
  assertInventoryStoreContract("PostgresInventoryStore on a real server", () =>
    ownerScopedStore(pool),
  );

  it("loses no grant when 25 of them for one key are genuinely in flight at once", async () => {
    // The stub responds synchronously, so its version of this test cannot interleave. Here the
    // pool holds several connections and Postgres really does run these concurrently: a
    // read-modify-write would return the same total twice and end far below 50.
    const store = new PostgresInventoryStore(pool);
    const owner = randomUUID();
    const totals = await Promise.all(
      Array.from({ length: 25 }, () => store.add(owner, "herb", 2)),
    );
    assert.equal(totals.includes(null), false, "none of these can be a full bag");
    assert.equal(new Set(totals).size, 25, "two grants returned the same total, so one was lost");
    assert.deepEqual(await store.list(owner), [{ itemKey: "herb", quantity: 50, equipped: false }]);
  });

  it("keeps topping up a held key while the bag is full, concurrently", async () => {
    // The documented READ COMMITTED looseness is about two *new* keys racing (see the SQL's own
    // comment). Topping up a held key must not be loose at all: the EXISTS branch is what turns
    // every later drop of something already carried into a kept one.
    const store = new PostgresInventoryStore(pool);
    const owner = randomUUID();
    for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
      assert.equal(await store.add(owner, `filler-${index}`, 1), 1, `kind ${index}`);
    }
    assert.equal(await store.add(owner, "one-too-many", 1), null, "precondition: the bag is full");

    const totals = await Promise.all(
      Array.from({ length: 10 }, () => store.add(owner, "filler-0", 1)),
    );
    assert.equal(totals.includes(null), false, "a full bag refused more of what it already holds");
    assert.equal(new Set(totals).size, 10);
    const rows = await store.list(owner);
    assert.equal(rows.length, MAX_DISTINCT_ITEMS, "and it grew no new kinds doing it");
    assert.equal(rows.find((row) => row.itemKey === "filler-0")?.quantity, 11);
  });

  it("prepares the grant statement, with the parameter types its own comment claims", async () => {
    // `INSERT INTO t (cols) SELECT $1, $2, $3 WHERE ...` is the shape that classically fails with
    // 42P18 "could not determine data type of parameter", because the parameters sit in a
    // sub-select rather than in a VALUES list. The store's comment says Postgres 17 resolves them
    // from the target column list anyway; until now nothing checked that, and the stub above only
    // compares the SQL to a regex — it never asks a server to parse it. If this is ever wrong,
    // *every* item grant throws, and Pass E is the first caller that would find out.
    //
    // The statement is captured from the store rather than copied here, so this cannot drift.
    const { pool: recorder, queries } = stubPool(() => ({ rows: [{ quantity: 1 }] }));
    await new PostgresInventoryStore(recorder).add(OWNER, "acorn", 1);
    const grantSql = queries[0]?.sql;
    assert.ok(grantSql, "the store sent no statement to capture");

    const client = await pool.connect();
    try {
      await client.query(`PREPARE zep_grant_contract AS ${grantSql}`);
      const prepared = await client.query<{ parameter_types: string }>(
        "SELECT parameter_types::text FROM pg_prepared_statements WHERE name = 'zep_grant_contract'",
      );
      assert.equal(
        prepared.rows[0]?.parameter_types,
        "{uuid,text,integer,bigint}",
        "the server inferred different parameter types than the statement's comment documents",
      );

      // Proves the check above can fail: without this, a harness that silently swallowed the
      // error would report the same PASS as a statement that really does prepare.
      await assert.rejects(
        () => client.query("PREPARE zep_grant_control AS INSERT INTO inventory_item (owner_key, nope) SELECT $1, $2"),
        /nope/,
        "a broken statement has to be reported, or the assertion above proves nothing",
      );
    } finally {
      client.release();
    }
  });

  it("prepares the read statement too", async () => {
    const { pool: recorder, queries } = stubPool(() => ({ rows: [] }));
    await new PostgresInventoryStore(recorder).list(OWNER);
    const listSql = queries[0]?.sql;
    assert.ok(listSql);

    const client = await pool.connect();
    try {
      await client.query(`PREPARE zep_list_contract AS ${listSql}`);
      const prepared = await client.query<{ parameter_types: string }>(
        "SELECT parameter_types::text FROM pg_prepared_statements WHERE name = 'zep_list_contract'",
      );
      assert.equal(prepared.rows[0]?.parameter_types, "{uuid}");
    } finally {
      client.release();
    }
  });

  it("refuses a non-positive quantity at the database as well as in the store", async () => {
    // `assertGrantableQuantity` is the guard that stops this ever being sent. The CHECK behind
    // it is the reason that guard has to agree with the DDL, so the DDL is asserted too.
    const owner = randomUUID();
    await assert.rejects(
      () =>
        pool.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, $3)", [
          owner,
          "acorn",
          0,
        ]),
      /quantity/,
      "the quantity > 0 CHECK is missing from the shipped schema",
    );
  });

  it("files one row per (owner, item) — the primary key is the stack model", async () => {
    const owner = randomUUID();
    await pool.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, $3)", [
      owner,
      "carrot",
      1,
    ]);
    await assert.rejects(
      () =>
        pool.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, $3)", [
          owner,
          "carrot",
          1,
        ]),
      /duplicate key/,
      "a second row for the same stack would make list() report the item twice",
    );
  });

  describe("PostgresInventoryStore.equip — concurrent equip of two different items into the same slot", () => {
    it("the partial unique index lets exactly one row end up equipped, and the loser's call resolves false rather than rejecting", async () => {
      // Phase F's own atomicity claim, forced rather than assumed: two genuinely concurrent
      // connections racing `equip()` for two *different* items **into the same slot** on one
      // owner — the only case `inventory_item_owner_equipped_slot_uidx` (design §2.1) can still
      // contend on now that the index is `(owner_key, equipped_slot)` rather than `(owner_key)`.
      // Both items are equipped into "armor" here regardless of their own catalogue slot, since
      // this drives `InventoryStore.equip` directly and it enforces no slot-family match itself
      // (that check lives in `MetaverseRoom.handleEquipItem`) — the point under test is the index,
      // not the catalogue. The CTE's own "cleared" step only clears rows it can see in its own
      // snapshot, so the real guarantee has to come from the index itself — this proves it does,
      // and that `equip()` now catches the loser's own `23505` off that index and resolves `false`
      // (Bug 1 fix) instead of letting it reject: an uncaught rejection there left
      // `settleEquipRequest`'s catch block sending nothing at all to the losing session, which
      // looked like a dropped click rather than a denied request.
      const store = new PostgresInventoryStore(pool);
      for (let trial = 0; trial < 10; trial++) {
        const owner = randomUUID();
        await store.add(owner, "leather-armor", 1);
        await store.add(owner, "old-dagger", 1);

        const results = await Promise.allSettled([
          store.equip(owner, "leather-armor", "armor"),
          store.equip(owner, "old-dagger", "armor"),
        ]);

        const rows = await store.list(owner);
        const equippedRows = rows.filter((row) => row.equipped);
        assert.equal(
          equippedRows.length,
          1,
          `trial ${trial}: exactly one row must be equipped, got ${JSON.stringify(rows)}`,
        );

        const rejected = results.filter((r) => r.status === "rejected");
        assert.equal(rejected.length, 0, `trial ${trial}: neither concurrent equip() call may reject`);

        const values = (results as PromiseFulfilledResult<boolean>[]).map((r) => r.value);
        assert.equal(
          values.filter((value) => value === true).length,
          1,
          `trial ${trial}: exactly one concurrent equip() must report success`,
        );
        assert.equal(
          values.filter((value) => value === false).length,
          1,
          `trial ${trial}: the loser must resolve false rather than throw`,
        );
        assert.equal(
          getDatabaseStatus(),
          "ok",
          `trial ${trial}: a losing 23505 is an expected race outcome, not a database fault`,
        );
      }
    });
  });
});
