import type { Pool } from "pg";
import { markDatabaseDegraded, markDatabaseOk } from "./status";

/**
 * One boss's last defeat time — a spawn row's state, not an account's (design-phase-i-boss-
 * monster.md §2.1, §2.3). Two implementations for `ProfileStore`/`InventoryStore`'s own reason:
 * the in-process one is not a test double but the normal local-development path.
 *
 * Keyed by `MonsterSpawnDefinition.id` rather than `ownerKey` — the only store in this directory
 * that takes no account key, because this state belongs to a spawn row, not to whoever last hit it.
 */
export interface BossStateStore {
  /** Never recorded yet is `null` — the caller tells "never killed" apart from "6 hours have passed". */
  getLastDefeatedAt(spawnId: string): Promise<number | null>;

  /**
   * epoch ms. A single UPSERT, so two room instances that defeat the same boss within seconds of
   * each other (design §1.1) still converge on one regen deadline — the later write wins.
   */
  recordDefeat(spawnId: string, defeatedAtMs: number): Promise<void>;
}

/**
 * The store a server booted without `DATABASE_URL` runs on. Not a test double: it is the normal
 * local-development path, which is what keeps the server test suite and the load-test harnesses
 * running without a Postgres to point them at. Its contents live and die with the process, so a
 * restart is indistinguishable from a first visit.
 */
export class InMemoryBossStateStore implements BossStateStore {
  private readonly defeatedAtBySpawnId = new Map<string, number>();

  getLastDefeatedAt(spawnId: string): Promise<number | null> {
    return Promise.resolve(this.defeatedAtBySpawnId.get(spawnId) ?? null);
  }

  recordDefeat(spawnId: string, defeatedAtMs: number): Promise<void> {
    this.defeatedAtBySpawnId.set(spawnId, defeatedAtMs);
    return Promise.resolve();
  }
}

export class PostgresBossStateStore implements BossStateStore {
  constructor(private readonly pool: Pool) {}

  async getLastDefeatedAt(spawnId: string): Promise<number | null> {
    const result = await this.query<{ defeated_at: Date }>(
      "SELECT defeated_at FROM monster_defeat WHERE spawn_id = $1",
      [spawnId],
    );
    const row = result.rows[0];
    return row === undefined ? null : row.defeated_at.getTime();
  }

  async recordDefeat(spawnId: string, defeatedAtMs: number): Promise<void> {
    await this.query(
      `INSERT INTO monster_defeat (spawn_id, defeated_at)
       VALUES ($1, $2)
       ON CONFLICT (spawn_id)
       DO UPDATE SET defeated_at = EXCLUDED.defeated_at`,
      [spawnId, new Date(defeatedAtMs)],
    );
  }

  /**
   * Every query reports what it learned about the connection: `/api/health` has no other way to
   * notice that a database which answered at boot has stopped answering. Failures are re-thrown —
   * the caller decides what a failed call means, and here it means the room's own fallback
   * (never persisted, or a fire-and-forget record that never landed) applies instead.
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
