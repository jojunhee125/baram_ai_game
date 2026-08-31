import type { Pool } from "pg";
import { markDatabaseDegraded, markDatabaseOk } from "./status";

/**
 * One account's profile. Today that is a single field, and that is exactly why skin
 * persistence is the first consumer of the database (design §2.1): it is the only feature
 * whose read and write paths never meet the room message path.
 *
 * Keyed by the SSO `sub` rather than a session or a room — the store knows about neither.
 */
export interface ProfileStore {
  /** Never stored yet is `null`; the store does not invent a default, the picker owns that. */
  getAvatarSkin(ownerKey: string): Promise<number | null>;
  setAvatarSkin(ownerKey: string, avatarSkin: number): Promise<void>;
}

/**
 * The store a server booted without `DATABASE_URL` runs on. Not a test double: it is the
 * normal local-development path (design §2.4), which is what keeps the server test suite and
 * `tools/loadtest-poc2.mjs` running without a Postgres to point them at. Its contents live
 * and die with the process, so a restart is indistinguishable from a first visit.
 */
export class InMemoryProfileStore implements ProfileStore {
  private readonly skinsByOwner = new Map<string, number>();

  getAvatarSkin(ownerKey: string): Promise<number | null> {
    return Promise.resolve(this.skinsByOwner.get(ownerKey) ?? null);
  }

  setAvatarSkin(ownerKey: string, avatarSkin: number): Promise<void> {
    this.skinsByOwner.set(ownerKey, avatarSkin);
    return Promise.resolve();
  }
}

export class PostgresProfileStore implements ProfileStore {
  constructor(private readonly pool: Pool) {}

  async getAvatarSkin(ownerKey: string): Promise<number | null> {
    const result = await this.query<{ avatar_skin: number }>(
      "SELECT avatar_skin FROM player_profile WHERE owner_key = $1",
      [ownerKey],
    );
    return result.rows[0]?.avatar_skin ?? null;
  }

  async setAvatarSkin(ownerKey: string, avatarSkin: number): Promise<void> {
    // One statement, so two tabs of the same account cannot interleave a read and a write.
    await this.query(
      `INSERT INTO player_profile (owner_key, avatar_skin)
       VALUES ($1, $2)
       ON CONFLICT (owner_key)
       DO UPDATE SET avatar_skin = EXCLUDED.avatar_skin, updated_at = now()`,
      [ownerKey, avatarSkin],
    );
  }

  /**
   * Every query reports what it learned about the connection: `/api/health` has no other way
   * to notice that a database which answered at boot has stopped answering. Failures are
   * re-thrown — the caller decides what a failed read means, and here it means the picker
   * shows its default rather than the route inventing a stored value.
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
