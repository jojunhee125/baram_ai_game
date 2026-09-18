import type { Pool } from "pg";
import { isPlayerClassKey, type PlayerClassKey } from "@zep-test/shared";
import { markDatabaseDegraded, markDatabaseOk } from "./status";

/**
 * One account's chosen class (roadmap R05-a, `docs/r05-classes-and-skills.md` D1, `0011_player_
 * class.sql`'s own header comment for why this is a dedicated table rather than a column on
 * `player_profile`).
 *
 * Keyed by the SSO `sub`, `ProgressStore`'s own convention. Write-once by design: there is no
 * `setClass` that overwrites, only {@link chooseOnce} — R05 has no respec/reclass path (design §2
 * D1; R06 owns that when it exists), so a second write path would let this store race ahead of a
 * feature that has not been designed yet.
 */
export interface ClassStore {
  /** Never chosen yet is `null` — the store invents no default. */
  getClass(ownerKey: string): Promise<PlayerClassKey | null>;

  /**
   * Registers `classKey` if the account has never chosen, and answers the class the account
   * actually holds afterwards — which may not be `classKey` (design §2 D1): two tabs racing to
   * choose different classes both land on whichever commit wins, never an error and never two
   * rows. A single upsert, `CurrencyStore.credit`'s own reason: a read-then-write here would let
   * two concurrent first choices each believe it was the one that won.
   *
   * `classKey` is untyped `string` here, not `PlayerClassKey`, on purpose — {@link
   * ChooseClassRequest.classKey}'s own "the server validates it" contract means an invalid value
   * can genuinely reach this call, and both implementations must refuse it identically rather
   * than only whichever one happens to run first in production.
   */
  chooseOnce(ownerKey: string, classKey: string): Promise<PlayerClassKey>;
}

/**
 * The store a server booted without `DATABASE_URL` runs on. Not a test double: it is the normal
 * local-development path (`ProgressStore`'s own reason), which is what keeps the server test
 * suite running without a Postgres to point it at. Also the honest home for a session with no SSO
 * identity (design §2 D1's last bullet): `MetaverseRoom` falls back to the session id as the owner
 * key the same way `awardExp` already does, so class choice still works end to end in local dev.
 */
export class InMemoryClassStore implements ClassStore {
  private readonly classByOwner = new Map<string, PlayerClassKey>();

  getClass(ownerKey: string): Promise<PlayerClassKey | null> {
    return Promise.resolve(this.classByOwner.get(ownerKey) ?? null);
  }

  chooseOnce(ownerKey: string, classKey: string): Promise<PlayerClassKey> {
    // Same guard `PostgresClassStore.chooseOnce` applies — see `assertPlayerClassKey`'s own doc
    // comment — so the two implementations of this interface agree on an invalid key instead of
    // only one of them catching it, live, in production.
    try {
      assertPlayerClassKey(classKey);
    } catch (cause) {
      return Promise.reject(cause as Error);
    }
    const existing = this.classByOwner.get(ownerKey);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    this.classByOwner.set(ownerKey, classKey);
    return Promise.resolve(classKey);
  }
}

export class PostgresClassStore implements ClassStore {
  /**
   * `Pick<Pool, "query">` rather than `Pool` itself, `PostgresCurrencyStore`'s own reason: a
   * caller building this over a checked-out `PoolClient` (inside a larger transaction) can hand
   * it in without this store caring which one it got.
   */
  constructor(private readonly executor: Pick<Pool, "query">) {}

  async getClass(ownerKey: string): Promise<PlayerClassKey | null> {
    assertUuidOwnerKey(ownerKey);
    const result = await this.query<{ class_key: string }>(
      "SELECT class_key FROM player_class WHERE owner_key = $1",
      [ownerKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : (row.class_key as PlayerClassKey);
  }

  async chooseOnce(ownerKey: string, classKey: string): Promise<PlayerClassKey> {
    assertPlayerClassKey(classKey);
    assertUuidOwnerKey(ownerKey);
    // One statement, `PostgresCurrencyStore.credit`'s own upsert shape: two tabs racing a first
    // choice cannot interleave a read and a write and each believe it won. The `DO UPDATE` is a
    // no-op write (`class_key = player_class.class_key`) purely so `RETURNING` always answers a
    // row — Postgres does not run `RETURNING` on a `DO NOTHING` conflict — which is what keeps
    // this one round trip instead of an `INSERT ... DO NOTHING` followed by a fallback `SELECT`
    // that would leave a window between the two for another writer to land in.
    const result = await this.query<{ class_key: string }>(
      `INSERT INTO player_class (owner_key, class_key)
       VALUES ($1, $2)
       ON CONFLICT (owner_key)
       DO UPDATE SET class_key = player_class.class_key
       RETURNING class_key`,
      [ownerKey, classKey],
    );
    const stored = result.rows[0]?.class_key;
    return (stored ?? classKey) as PlayerClassKey;
  }

  /**
   * Every query reports what it learned about the connection: `/api/health` has no other way to
   * notice that a database which answered at boot has stopped answering. Failures are re-thrown —
   * the caller decides what a failed call means, and here it means the choice is dropped rather
   * than the room inventing an answer.
   */
  private async query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    try {
      const result = await this.executor.query<T>(sql, [...values]);
      markDatabaseOk();
      return result;
    } catch (cause) {
      markDatabaseDegraded(cause);
      throw cause;
    }
  }
}

/**
 * Rejects what the schema's own `CHECK` constraint would reject, before either implementation
 * touches the database — `currencyStore.ts`'s own `assertPositiveAmount` reasoning: a client
 * message is never trusted shape, `ChooseClassRequest.classKey` most of all, since it is a plain
 * string precisely so the server can be the one to validate it (protocol.ts's own doc comment).
 */
function assertPlayerClassKey(classKey: string): asserts classKey is PlayerClassKey {
  if (!isPlayerClassKey(classKey)) {
    throw new TypeError(`class key must be one of warrior/rogue/shaman/cleric, not "${classKey}"`);
  }
}

/**
 * The same shape `currencyStore.ts`'s own `assertUuidOwnerKey` enforces, and for the same reason:
 * `MetaverseRoom` falls back to the session id when there is no SSO identity, and a session id is
 * never the uuid `owner_key` is declared as. Left unguarded, a production room with no SSO for a
 * session would throw a driver-level `22P02` that {@link PostgresClassStore.query} cannot tell
 * apart from a dropped connection, marking `/api/health` degraded on every such call.
 */
function assertUuidOwnerKey(ownerKey: string): void {
  if (!UUID_PATTERN.test(ownerKey)) {
    throw new TypeError(`class owner key must be a uuid, not "${ownerKey}"`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
