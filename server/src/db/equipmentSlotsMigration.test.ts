import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";

/**
 * Phase V Pass T1 (`docs/design-phase-v-equipment-system.md` §2.2, §9 T1): proves the *data
 * transformation* half of `0004_equipment_slots.sql` — not just that the file is syntactically
 * valid SQL (the store-level tests already run it via `runMigrations` on a fresh database), but
 * that a database *already carrying real `equipped = true` rows* (the 0003 shape, exactly what is
 * running in production per the design doc's own warning) converts them to `equipped_slot =
 * 'armor'` and drops the old column without losing anything.
 *
 * Opt-in against a real Postgres, same convention as `inventoryStore.test.ts`'s own header:
 *
 *   docker run -d --rm --name zep-inv-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=zeptest \
 *     -p 55440:5432 postgres:17-alpine
 *   ZEP_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55440/zeptest npm test -w @zep-test/server
 *
 * Runs in its own Postgres *schema*, created and dropped by this file, rather than on `public`
 * where the rest of the suite's opt-in tests already run the *full* migration set (0001..0004) —
 * this file needs to freeze the database at the 0003 shape first and insert pre-existing rows
 * before applying 0004, which `runMigrations` (idempotent, tracks `schema_migration`) has no way
 * to be asked to do on a database that has already moved past that point.
 */

const REAL_DATABASE_URL = process.env["ZEP_TEST_DATABASE_URL"]?.trim();

const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

async function readMigration(fileName: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIRECTORY, fileName), "utf8");
}

describe(
  "0004_equipment_slots.sql — data transformation against a real server",
  { skip: REAL_DATABASE_URL === undefined ? "ZEP_TEST_DATABASE_URL is not set" : false },
  () => {
    let pool: Pool;
    let client: PoolClient;
    const schema = `phase_v_migration_t1_${randomUUID().replaceAll("-", "_")}`;

    before(async () => {
      pool = new Pool({ connectionString: REAL_DATABASE_URL, max: 2 });
      client = await pool.connect();
      // A dedicated schema, dropped in `after`, so this never touches whatever `public` (or any
      // other test file's own schema) already holds — non-destructive by construction, the same
      // property `inventoryStore.test.ts`'s real-server suite documents for itself.
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);

      // Freeze the database at exactly the 0003 shape: 0001/0002/0003 applied for real, 0004 not
      // yet — the state every already-deployed production database is in before this migration
      // runs (design §2.2's own premise).
      await client.query(await readMigration("0001_player_profile.sql"));
      await client.query(await readMigration("0002_inventory_item.sql"));
      await client.query(await readMigration("0003_inventory_item_equipped.sql"));
    });

    after(async () => {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      client.release();
      await pool.end();
    });

    const armorOwner = randomUUID();
    const unequippedOwner = randomUUID();
    const secondArmorOwner = randomUUID();

    it("fixture: seeds pre-0004 rows exactly like a real, already-deployed account", async () => {
      // The one case the design doc says is unambiguous: every `equipped = true` row today is an
      // armor-slot equip, because leather-armor is the only equipment item that has ever existed.
      await client.query(
        "INSERT INTO inventory_item (owner_key, item_key, quantity, equipped) VALUES ($1, $2, 1, true)",
        [armorOwner, "leather-armor"],
      );
      // A row that was never equipped must stay untouched — the UPDATE's WHERE clause is what is
      // under test, not just "does the column move".
      await client.query(
        "INSERT INTO inventory_item (owner_key, item_key, quantity, equipped) VALUES ($1, $2, 3, false)",
        [unequippedOwner, "acorn"],
      );
      // A second equipped account, to prove the UPDATE is not a LIMIT-1 fluke and the unique index
      // rebuilt afterwards still lets two different owners each hold their own armor-slot row.
      await client.query(
        "INSERT INTO inventory_item (owner_key, item_key, quantity, equipped) VALUES ($1, $2, 1, true)",
        [secondArmorOwner, "leather-armor"],
      );

      const before = await client.query<{ equipped: boolean }>(
        "SELECT equipped FROM inventory_item WHERE owner_key = $1",
        [armorOwner],
      );
      assert.equal(before.rows[0]?.equipped, true, "precondition: the legacy boolean column is set");
    });

    it("applies 0004: every pre-existing equipped=true row becomes equipped_slot='armor'", async () => {
      await client.query(await readMigration("0004_equipment_slots.sql"));

      const armorRow = await client.query<{ equipped_slot: string | null }>(
        "SELECT equipped_slot FROM inventory_item WHERE owner_key = $1 AND item_key = $2",
        [armorOwner, "leather-armor"],
      );
      assert.equal(
        armorRow.rows[0]?.equipped_slot,
        "armor",
        "the one historical equipment item's equipped row must land in the armor slot, not null or another slot",
      );

      const secondArmorRow = await client.query<{ equipped_slot: string | null }>(
        "SELECT equipped_slot FROM inventory_item WHERE owner_key = $1 AND item_key = $2",
        [secondArmorOwner, "leather-armor"],
      );
      assert.equal(secondArmorRow.rows[0]?.equipped_slot, "armor", "a second account's row must convert too");

      const untouchedRow = await client.query<{ equipped_slot: string | null; quantity: number }>(
        "SELECT equipped_slot, quantity FROM inventory_item WHERE owner_key = $1 AND item_key = $2",
        [unequippedOwner, "acorn"],
      );
      assert.equal(
        untouchedRow.rows[0]?.equipped_slot,
        null,
        "a row that was never equipped must not gain a slot out of nowhere",
      );
      assert.equal(untouchedRow.rows[0]?.quantity, 3, "the conversion must not disturb quantity");
    });

    it("drops the old `equipped` column entirely", async () => {
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'inventory_item'`,
        [schema],
      );
      const names = columns.rows.map((row) => row.column_name);
      assert.equal(names.includes("equipped"), false, "the boolean column must be gone, not just unused");
      assert.equal(names.includes("equipped_slot"), true);
    });

    it("rebuilds the unique index scoped to (owner_key, equipped_slot), replacing the old (owner_key)-only one", async () => {
      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'inventory_item'`,
        [schema],
      );
      const names = indexes.rows.map((row) => row.indexname);
      assert.equal(
        names.includes("inventory_item_owner_equipped_uidx"),
        false,
        "the old (owner_key)-only index must be dropped, or it would still cap one equip per account total",
      );
      assert.equal(names.includes("inventory_item_owner_equipped_slot_uidx"), true);
    });

    it("the CHECK constraint refuses a slot outside the documented eight", async () => {
      const owner = randomUUID();
      await client.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, 1)", [
        owner,
        "acorn",
      ]);
      await assert.rejects(
        () =>
          client.query("UPDATE inventory_item SET equipped_slot = $1 WHERE owner_key = $2", [
            "backpack",
            owner,
          ]),
        /inventory_item_equipped_slot_check/,
      );
    });

    it("the rebuilt unique index still lets exactly one row win a same-slot race post-migration", async () => {
      // Not a data-transformation question by itself, but the point of narrowing the index to
      // (owner_key, equipped_slot) is that the *new* index — the one this migration just built —
      // is what `PostgresInventoryStore.equip`'s 23505 handling depends on from this point on.
      // Proven directly against the migrated schema rather than assumed from the 0004 SQL text.
      const owner = randomUUID();
      await client.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, 1)", [
        owner,
        "leather-armor",
      ]);
      await client.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, 1)", [
        owner,
        "old-dagger",
      ]);
      await client.query("UPDATE inventory_item SET equipped_slot = 'armor' WHERE owner_key = $1 AND item_key = $2", [
        owner,
        "leather-armor",
      ]);
      await assert.rejects(
        () =>
          client.query(
            "UPDATE inventory_item SET equipped_slot = 'armor' WHERE owner_key = $1 AND item_key = $2",
            [owner, "old-dagger"],
          ),
        /duplicate key value violates unique constraint "inventory_item_owner_equipped_slot_uidx"/,
        "two rows for one owner in the same slot must still be impossible after the migration",
      );
    });

    it("a different slot for the same owner no longer contends on the index — the whole point of the migration", async () => {
      const owner = randomUUID();
      await client.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, 1)", [
        owner,
        "leather-armor",
      ]);
      await client.query("INSERT INTO inventory_item (owner_key, item_key, quantity) VALUES ($1, $2, 1)", [
        owner,
        "old-dagger",
      ]);
      await client.query("UPDATE inventory_item SET equipped_slot = 'armor' WHERE owner_key = $1 AND item_key = $2", [
        owner,
        "leather-armor",
      ]);
      // Under the pre-migration (owner_key)-only index this second UPDATE would also have hit the
      // unique violation above; under the new (owner_key, equipped_slot) index it must not.
      await assert.doesNotReject(() =>
        client.query("UPDATE inventory_item SET equipped_slot = 'weapon' WHERE owner_key = $1 AND item_key = $2", [
          owner,
          "old-dagger",
        ]),
      );
      const rows = await client.query<{ item_key: string; equipped_slot: string }>(
        "SELECT item_key, equipped_slot FROM inventory_item WHERE owner_key = $1 AND equipped_slot IS NOT NULL ORDER BY item_key",
        [owner],
      );
      assert.deepEqual(rows.rows, [
        { item_key: "leather-armor", equipped_slot: "armor" },
        { item_key: "old-dagger", equipped_slot: "weapon" },
      ]);
    });
  },
);
