import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { InMemoryCurrencyStore, PostgresCurrencyStore } from "./currencyStore";
import { InMemoryInventoryStore, PostgresInventoryStore } from "./inventoryStore";
import { runMigrations } from "./migrate";
import { InMemorySettlementStore, PostgresSettlementStore } from "./settlementStore";
import { getDatabaseStatus, resetDatabaseStatus } from "./status";

/**
 * Independent adversarial verification of R04-a settlement core, run against a real Postgres.
 * Attacks angles nobody has tried yet — not a repeat of settlementStore.test.ts.
 */
const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

describe(
  "SettlementStore — independent verification against a real server",
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

    it("FIXED: refuses a grantKey reused by a different owner instead of replaying owner A's result", async () => {
      const store = new PostgresSettlementStore(pool);
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      const grantKey = `cross-owner:${randomUUID()}`;

      const firstOutcome = await store.settle(grantKey, ownerA, { currencyDelta: 500 });
      assert.deepEqual(firstOutcome, { ok: true, balance: 500, items: [] });

      // ownerB re-uses the same grantKey (e.g. a client-side bug, or a malicious replay of an
      // observed request with a swapped owner). The gate keys on grant_key alone, so this must be
      // caught by an explicit owner check rather than silently replaying owner A's stored result.
      await assert.rejects(
        () => store.settle(grantKey, ownerB, { currencyDelta: 500 }),
        /already settled for owner/,
        "a grantKey settled for a different owner must reject, not replay",
      );

      const currencyStore = new PostgresCurrencyStore(pool);
      const ownerBBalance = await currencyStore.getBalance(ownerB);
      assert.equal(ownerBBalance, 0, "owner B's real balance must never have been touched");
      const ownerABalance = await currencyStore.getBalance(ownerA);
      assert.equal(ownerABalance, 500, "owner A's balance is unaffected by owner B's rejected call");

      const row = await pool.query<{ owner_key: string }>(
        "SELECT owner_key FROM reward_grant WHERE grant_key = $1",
        [grantKey],
      );
      assert.equal(row.rows[0]?.owner_key, ownerA);
    });

    it("FIXED (same shape): InMemorySettlementStore also refuses ownerKey mismatch on replay", async () => {
      const store = new InMemorySettlementStore();
      const ownerA = randomUUID();
      const ownerB = randomUUID();
      const grantKey = `cross-owner-mem:${randomUUID()}`;

      await store.settle(grantKey, ownerA, { currencyDelta: 42 });
      await assert.rejects(
        () => store.settle(grantKey, ownerB, { currencyDelta: 42 }),
        /already settled for owner/,
      );
    });

    it("reward_grant with a NULL result (simulating a crash mid-settlement) throws the invariant error on replay", async () => {
      const grantKey = `null-result:${randomUUID()}`;
      const ownerKey = randomUUID();
      // Bypass the store entirely to reach a state the code claims can never commit: a gate row
      // whose result was never filled in. This is the state the "broken settlement invariant"
      // throw exists to guard against.
      await pool.query("INSERT INTO reward_grant (grant_key, owner_key, result) VALUES ($1, $2, NULL)", [
        grantKey,
        ownerKey,
      ]);
      const store = new PostgresSettlementStore(pool);
      await assert.rejects(
        () => store.settle(grantKey, ownerKey, { currencyDelta: 1 }),
        /broken settlement invariant/,
      );
      // Confirm this genuine fault (not an expected decline) does mark the database degraded.
      assert.equal(getDatabaseStatus(), "degraded");
      resetDatabaseStatus();
    });

    it("rolls back the currency credit for real when a later item in the same batch overflows the bag", async () => {
      const store = new PostgresSettlementStore(pool);
      const inventoryStore = new PostgresInventoryStore(pool);
      const currencyStore = new PostgresCurrencyStore(pool);
      const ownerKey = randomUUID();

      // Fill the bag to capacity first.
      for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
        const total = await inventoryStore.add(ownerKey, `filler-${index}`, 1);
        assert.notEqual(total, null);
      }
      const balanceBefore = await currencyStore.getBalance(ownerKey);

      const declined = await store.settle(`overflow:${randomUUID()}`, ownerKey, {
        currencyDelta: 777,
        items: [{ itemKey: "brand-new-item", quantity: 1 }],
      });
      assert.equal(declined.ok, false);
      if (!declined.ok) {
        assert.equal(declined.reason, "bag-full");
      }

      // Direct psql-equivalent read via the real store — not the in-process outcome — to prove
      // the rollback actually reached the table, not just the returned value.
      const balanceAfter = await currencyStore.getBalance(ownerKey);
      assert.equal(balanceAfter, balanceBefore, "the credit must not have landed in player_currency");

      const row = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM inventory_item WHERE owner_key = $1 AND item_key = 'brand-new-item'",
        [ownerKey],
      );
      assert.equal(row.rows[0]?.count, "0", "the new item must not have been inserted either");
    });

    it("FIXED: a balance near Number.MAX_SAFE_INTEGER is refused rather than silently rounded", async () => {
      const store = new PostgresSettlementStore(pool);
      const ownerKey = randomUUID();

      // MAX_SAFE_INTEGER itself is odd (2^53 - 1). Above 2^53 float64's granularity is 2, so an
      // *odd* sum in that range cannot be represented exactly — crediting an even amount onto an
      // odd base lands on an odd target, which `Number()` would round instead of report exactly.
      const target = Number.MAX_SAFE_INTEGER; // 9007199254740991, odd
      await pool.query(
        "INSERT INTO player_currency (owner_key, balance) VALUES ($1, $2)",
        [ownerKey, target.toString()],
      );

      // The fix refuses to report a rounded number at all: `currencyStore.ts`'s `toSafeInteger`
      // throws rather than letting `Number(row.balance)` silently answer the wrong value.
      await assert.rejects(
        () => store.settle(`msi:${randomUUID()}`, ownerKey, { currencyDelta: 2 }),
        /safe integer range/,
      );

      // And the transaction rolled back: a refused settle() must not have applied the credit.
      const raw = await pool.query<{ balance: string }>(
        "SELECT balance::text AS balance FROM player_currency WHERE owner_key = $1",
        [ownerKey],
      );
      assert.equal(raw.rows[0]?.balance, target.toString(), "the credit must not have landed");
    });

    it("a debit landing exactly on zero succeeds and leaves the row at 0, not deleted", async () => {
      const store = new PostgresSettlementStore(pool);
      const currencyStore = new PostgresCurrencyStore(pool);
      const ownerKey = randomUUID();
      await currencyStore.credit(ownerKey, 25);
      const outcome = await store.settle(`exact-zero:${randomUUID()}`, ownerKey, { currencyDelta: -25 });
      assert.deepEqual(outcome, { ok: true, balance: 0, items: [] });
      const balance = await currencyStore.getBalance(ownerKey);
      assert.equal(balance, 0);
    });

    it("InMemory and Postgres agree at the MAX_DISTINCT_ITEMS boundary for a brand-new key vs topping up an existing one", async () => {
      const ownerKeyPg = randomUUID();
      const memCurrency = new InMemoryCurrencyStore();
      const memInventory = new InMemoryInventoryStore();
      const memStore = new InMemorySettlementStore(memCurrency, memInventory);
      const pgStore = new PostgresSettlementStore(pool);
      const ownerKeyMem = randomUUID();

      // Fill both to exactly the cap.
      for (let index = 0; index < MAX_DISTINCT_ITEMS; index += 1) {
        const memOutcome = await memStore.settle(`fill-mem-${index}`, ownerKeyMem, {
          items: [{ itemKey: `item-${index}`, quantity: 1 }],
        });
        const pgOutcome = await pgStore.settle(`fill-pg-${index}-${ownerKeyPg}`, ownerKeyPg, {
          items: [{ itemKey: `item-${index}`, quantity: 1 }],
        });
        assert.equal(memOutcome.ok, true);
        assert.equal(pgOutcome.ok, true);
      }

      // Topping up an already-held key must succeed in both even though the bag is "full".
      const memTopUp = await memStore.settle(`topup-mem-${ownerKeyMem}`, ownerKeyMem, {
        items: [{ itemKey: "item-0", quantity: 5 }],
      });
      const pgTopUp = await pgStore.settle(`topup-pg-${ownerKeyPg}`, ownerKeyPg, {
        items: [{ itemKey: "item-0", quantity: 5 }],
      });
      assert.equal(memTopUp.ok, true);
      assert.equal(pgTopUp.ok, true);

      // A genuinely new key must be declined as bag-full in both.
      const memOverflow = await memStore.settle(`overflow-mem-${ownerKeyMem}`, ownerKeyMem, {
        items: [{ itemKey: "brand-new", quantity: 1 }],
      });
      const pgOverflow = await pgStore.settle(`overflow-pg-${ownerKeyPg}`, ownerKeyPg, {
        items: [{ itemKey: "brand-new", quantity: 1 }],
      });
      assert.deepEqual(memOverflow, { ok: false, reason: "bag-full", itemKey: "brand-new" });
      assert.deepEqual(pgOverflow, { ok: false, reason: "bag-full", itemKey: "brand-new" });
    });

    it("a currencyDelta: 0 settlement with a non-empty items array still applies the items (0 is not a full no-op)", async () => {
      const store = new PostgresSettlementStore(pool);
      const ownerKey = randomUUID();
      const outcome = await store.settle(`zero-delta-items:${randomUUID()}`, ownerKey, {
        currencyDelta: 0,
        items: [{ itemKey: "acorn", quantity: 2 }],
      });
      assert.deepEqual(outcome, { ok: true, balance: undefined, items: [{ itemKey: "acorn", quantity: 2 }] });
    });
  },
);
