import type { Pool } from "pg";
import { MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { markDatabaseDegraded, markDatabaseOk } from "./status";

/**
 * One account's belongings. Two implementations for the reason `ProfileStore` has two
 * (design §2.4): the in-process one is not a test double but the normal local-development path,
 * and keeping it is what lets the server suite and `tools/loadtest-poc2.mjs` run with no Postgres
 * to point them at.
 *
 * Every method takes an `ownerKey` — the store knows about neither sessions nor rooms, because a
 * grant arriving after the killer has left the room is the normal path, not an edge case
 * (design §6.4).
 */
export interface InventoryStore {
  /**
   * Everything held. The order is whatever the backing gives, deliberately: display order is
   * `ITEM_DEFINITIONS` order and the caller applies it, so nothing here can quietly become the
   * thing the bag window depends on.
   */
  list(ownerKey: string): Promise<readonly InventoryRow[]>;

  /**
   * Adds to a stack and answers the total afterwards. A single statement, so the same account
   * hunting in two tabs cannot lose a drop between a read and a write.
   *
   * A full bag — more than {@link MAX_DISTINCT_ITEMS} *different* keys — answers null rather than
   * throwing: a full bag is a result, not a fault, and the caller turns it into a different
   * notice. Adding to a key already held never grows the number of kinds, so it always succeeds.
   *
   * `quantity` must be a positive integer; anything else is a caller bug and rejects.
   */
  add(ownerKey: string, itemKey: string, quantity: number): Promise<number | null>;

  /**
   * Grants a cap-one possession item (`ItemDefinition.possession === true`) the first time only.
   *
   * Answers `true` the first time an account is granted this key, `false` on every later call —
   * indistinguishable from "denied, bag full" (both mean "no new row"), which is all callers act
   * on: neither case has anything else to tell the player.
   */
  grantOnce(ownerKey: string, itemKey: string): Promise<boolean>;

  /** The account's equipped item, or null when nothing is equipped or the key is unheld. */
  getEquipped(ownerKey: string): Promise<string | null>;

  /**
   * Equips `itemKey`, unequipping whatever else this account had equipped first — at most one
   * item is ever equipped, and the caller does not have to unequip before equipping.
   *
   * Answers `false`, and changes nothing, when the account does not hold `itemKey` — and also
   * when a concurrent `equip` call for a *different* item on the same account committed first:
   * `inventory_item_owner_equipped_uidx` (design §7.2) lets only one of the two ever win, and the
   * loser reports it the same way a not-held item does, rather than throwing.
   */
  equip(ownerKey: string, itemKey: string): Promise<boolean>;

  /**
   * Unequips whatever this account has equipped. A no-op, not an error, if nothing is — and
   * `true`/`false` says which of those two happened, so a caller whose own cache of "what was
   * equipped before this call" might already be stale has the store's real answer to act on
   * instead.
   */
  unequip(ownerKey: string): Promise<boolean>;
}

export interface InventoryRow {
  itemKey: string;
  quantity: number;
  equipped: boolean;
}

/**
 * Rejects what the `quantity > 0` CHECK would reject, in both implementations, before either one
 * acts on it. Without this the two disagree — the in-memory store would happily record a zero or
 * subtract, while Postgres raises a `23514` that {@link PostgresInventoryStore} cannot tell apart
 * from a dropped connection and would therefore leave `/api/health` reporting `db: "degraded"`
 * for the rest of the process. `deriveSsoUserId` guards the `sub` shape for that same reason.
 *
 * The loot table's boot check (design §8.3) is the real guarantee that this never fires; this is
 * the part of it that survives a caller nobody has written yet.
 */
function assertGrantableQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new TypeError(`inventory grant quantity must be a positive integer, not ${quantity}`);
  }
}

/**
 * The same shape `deriveSsoUserId` already enforces on the way in, checked again here because
 * that guard has exactly one caller (`GET /api/inventory`) and `awardLoot`'s combat-drop path is
 * not it: with no SSO identity for the killer, it credits `lastHit.sessionId` instead — deliberately,
 * so drops still work in local development against {@link InMemoryInventoryStore}, which owns no
 * column and needs no such check.
 *
 * Against Postgres, a session id is never the uuid `owner_key` is declared as, so without this
 * guard every such kill throws a driver-level `22P02` that {@link PostgresInventoryStore.query}
 * cannot tell apart from a dropped connection — the exact confusion `deriveSsoUserId`'s own
 * comment warns about, except reached from a path that never validated the shape first. Left
 * unguarded, a production room with no SSO for a session (the WS auth PoC this project ships with
 * is unverified) marks `/api/health` degraded on every kill that session lands, masking a real
 * outage behind a fake one.
 */
function assertUuidOwnerKey(ownerKey: string): void {
  if (!UUID_PATTERN.test(ownerKey)) {
    throw new TypeError(`inventory owner key must be a uuid, not "${ownerKey}"`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `23505` is Postgres's own code for a unique-constraint violation — unlike the `23514`/`22P02`
 * this file already refuses to guess at (design intent: those two are caller bugs that should
 * never reach a query), a `unique_violation` off `inventory_item_owner_equipped_uidx` is a normal,
 * expected outcome of two sessions of one account equipping different items at once, so `equip`
 * needs to tell it apart from every other failure rather than let it read as a dropped connection.
 */
function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";
}

/**
 * The store a server booted without `DATABASE_URL` runs on. Its contents live and die with the
 * process, so a restart is indistinguishable from a first visit.
 */
export class InMemoryInventoryStore implements InventoryStore {
  private readonly bagsByOwner = new Map<string, Map<string, number>>();
  private readonly equippedByOwner = new Map<string, string>();

  list(ownerKey: string): Promise<readonly InventoryRow[]> {
    const bag = this.bagsByOwner.get(ownerKey);
    if (bag === undefined) {
      return Promise.resolve([]);
    }
    const equipped = this.equippedByOwner.get(ownerKey);
    return Promise.resolve(
      [...bag].map(([itemKey, quantity]) => ({ itemKey, quantity, equipped: itemKey === equipped })),
    );
  }

  add(ownerKey: string, itemKey: string, quantity: number): Promise<number | null> {
    try {
      assertGrantableQuantity(quantity);
    } catch (cause) {
      return Promise.reject(cause);
    }
    let bag = this.bagsByOwner.get(ownerKey);
    if (bag === undefined) {
      bag = new Map<string, number>();
      this.bagsByOwner.set(ownerKey, bag);
    }
    const held = bag.get(itemKey);
    if (held === undefined && bag.size >= MAX_DISTINCT_ITEMS) {
      return Promise.resolve(null);
    }
    const total = (held ?? 0) + quantity;
    bag.set(itemKey, total);
    return Promise.resolve(total);
  }

  grantOnce(ownerKey: string, itemKey: string): Promise<boolean> {
    let bag = this.bagsByOwner.get(ownerKey);
    if (bag === undefined) {
      bag = new Map<string, number>();
      this.bagsByOwner.set(ownerKey, bag);
    }
    if (bag.has(itemKey)) {
      return Promise.resolve(false);
    }
    if (bag.size >= MAX_DISTINCT_ITEMS) {
      return Promise.resolve(false);
    }
    bag.set(itemKey, 1);
    return Promise.resolve(true);
  }

  getEquipped(ownerKey: string): Promise<string | null> {
    return Promise.resolve(this.equippedByOwner.get(ownerKey) ?? null);
  }

  equip(ownerKey: string, itemKey: string): Promise<boolean> {
    const bag = this.bagsByOwner.get(ownerKey);
    if (bag === undefined || !bag.has(itemKey)) {
      return Promise.resolve(false);
    }
    this.equippedByOwner.set(ownerKey, itemKey);
    return Promise.resolve(true);
  }

  unequip(ownerKey: string): Promise<boolean> {
    return Promise.resolve(this.equippedByOwner.delete(ownerKey));
  }
}

export class PostgresInventoryStore implements InventoryStore {
  constructor(private readonly pool: Pool) {}

  async list(ownerKey: string): Promise<readonly InventoryRow[]> {
    assertUuidOwnerKey(ownerKey);
    // No ORDER BY: the caller orders against ITEM_DEFINITIONS, and an ordering here would be a
    // second answer to that question that nobody is keeping in step with the first.
    const result = await this.query<{ item_key: string; quantity: number; equipped: boolean }>(
      "SELECT item_key, quantity, equipped FROM inventory_item WHERE owner_key = $1",
      [ownerKey],
    );
    return result.rows.map((row) => ({
      itemKey: row.item_key,
      quantity: row.quantity,
      equipped: row.equipped,
    }));
  }

  async add(ownerKey: string, itemKey: string, quantity: number): Promise<number | null> {
    assertGrantableQuantity(quantity);
    assertUuidOwnerKey(ownerKey);
    // `INSERT ... SELECT ... WHERE` rather than the plain `VALUES` of design §3.2: the capacity
    // test rides along in the same statement, so a grant is still one round trip and still
    // atomic. A false WHERE inserts no row, returns no row, and that empty result *is* the full
    // bag — the only other way for this statement to return nothing does not exist, because the
    // ON CONFLICT branch always returns its updated row.
    //
    // The EXISTS clause comes first and is what makes topping up an already-held stack
    // unconditional: at capacity the count test is false for every key, and without EXISTS a full
    // bag would stop accepting more of what it already holds.
    //
    // Under READ COMMITTED two grants of two *different* new keys can both see the same count and
    // both insert, so a bag can end up one or two kinds over the cap. Accepted: the alternative
    // is serializing every grant behind a lock to defend a number that exists only to bound the
    // size of one screen, and the failure it prevents — a lost drop — is the worse one.
    //
    // Uncast parameters, like the rest of this project's SQL. Checked against a real Postgres 17
    // rather than assumed: swapping `VALUES` for a `SELECT` source list does not cost the
    // parameters their types, and `pg_prepared_statements` still reports `{uuid,text,integer}`
    // from the target columns. `$4` comes out `bigint` from the `count(*)` comparison, which is
    // the same value by the time the driver has sent it as text.
    const result = await this.query<{ quantity: number }>(
      `INSERT INTO inventory_item (owner_key, item_key, quantity)
       SELECT $1, $2, $3
       WHERE EXISTS (SELECT 1 FROM inventory_item WHERE owner_key = $1 AND item_key = $2)
          OR (SELECT count(*) FROM inventory_item WHERE owner_key = $1) < $4
       ON CONFLICT (owner_key, item_key)
       DO UPDATE SET quantity = inventory_item.quantity + EXCLUDED.quantity
       RETURNING quantity`,
      [ownerKey, itemKey, quantity, MAX_DISTINCT_ITEMS],
    );
    return result.rows[0]?.quantity ?? null;
  }

  async grantOnce(ownerKey: string, itemKey: string): Promise<boolean> {
    assertUuidOwnerKey(ownerKey);
    // Same shape as `add`'s UPSERT, except a literal quantity of 1 and DO NOTHING instead of DO
    // UPDATE: a possession item has no stack to top up, so a second grant must leave the existing
    // row untouched rather than overwrite it back to 1.
    const result = await this.query<{ quantity: number }>(
      `INSERT INTO inventory_item (owner_key, item_key, quantity)
       SELECT $1, $2, 1
       WHERE EXISTS (SELECT 1 FROM inventory_item WHERE owner_key = $1 AND item_key = $2)
          OR (SELECT count(*) FROM inventory_item WHERE owner_key = $1) < $3
       ON CONFLICT (owner_key, item_key) DO NOTHING
       RETURNING quantity`,
      [ownerKey, itemKey, MAX_DISTINCT_ITEMS],
    );
    return result.rows.length > 0;
  }

  async equip(ownerKey: string, itemKey: string): Promise<boolean> {
    assertUuidOwnerKey(ownerKey);
    // The `item_key <> $2` guard on `cleared` is required, not cosmetic: without it, equipping an
    // already-equipped item would have `cleared` and the final UPDATE both target the same row in
    // the same statement, which Postgres defines as an error (or, worse, an unspecified result).
    //
    // Bypasses the shared `query` helper deliberately: two sessions of the same account equipping
    // two different items at once both pass the `target` CTE (each holds its own item), and only
    // the final UPDATE discovers the conflict, as a `23505` off `inventory_item_owner_equipped_uidx`
    // — the loser's connection is fine, so routing that through `query`'s catch would call
    // `markDatabaseDegraded` (and log a scary "database degraded" line) for a race that is normal,
    // expected concurrent usage, not a fault.
    try {
      const result = await this.pool.query<{ item_key: string }>(
        `WITH target AS (
           SELECT 1 FROM inventory_item WHERE owner_key = $1 AND item_key = $2
         ),
         cleared AS (
           UPDATE inventory_item SET equipped = false
           WHERE owner_key = $1 AND equipped = true AND item_key <> $2 AND EXISTS (SELECT 1 FROM target)
         )
         UPDATE inventory_item SET equipped = true
         WHERE owner_key = $1 AND item_key = $2 AND EXISTS (SELECT 1 FROM target)
         RETURNING item_key`,
        [ownerKey, itemKey],
      );
      markDatabaseOk();
      return result.rows.length > 0;
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        markDatabaseOk();
        return false;
      }
      markDatabaseDegraded(cause);
      throw cause;
    }
  }

  async unequip(ownerKey: string): Promise<boolean> {
    assertUuidOwnerKey(ownerKey);
    const result = await this.query<{ item_key: string }>(
      `UPDATE inventory_item SET equipped = false WHERE owner_key = $1 AND equipped = true RETURNING item_key`,
      [ownerKey],
    );
    return result.rows.length > 0;
  }

  async getEquipped(ownerKey: string): Promise<string | null> {
    assertUuidOwnerKey(ownerKey);
    const result = await this.query<{ item_key: string }>(
      `SELECT item_key FROM inventory_item WHERE owner_key = $1 AND equipped = true`,
      [ownerKey],
    );
    return result.rows[0]?.item_key ?? null;
  }

  /**
   * Every query reports what it learned about the connection: `/api/health` has no other way to
   * notice that a database which answered at boot has stopped answering. Failures are re-thrown —
   * the caller decides what a failed read means, and here it means the bag window says so rather
   * than the route inventing an empty bag.
   */
  private async query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    try {
      const result = await this.pool.query<T>(sql, [...values]);
      markDatabaseOk();
      return result;
    } catch (cause) {
      markDatabaseDegraded(cause);
      throw cause;
    }
  }
}
