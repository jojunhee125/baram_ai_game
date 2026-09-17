import type { Pool } from "pg";
import { markDatabaseDegraded, markDatabaseOk } from "./status";

/**
 * One account's state on one quest, as every method here answers it. `requiredCount` is absent on
 * purpose: it lives in `QUEST_DEFINITIONS` and is passed *into* the write that uses it, so a row
 * read back can never claim a requirement the current table disagrees with.
 */
export interface QuestRow {
  questId: string;
  /** Kills credited so far, never above the requirement in force at the time of the last write. */
  killCount: number;
  /** `quest_progress.completed_at IS NOT NULL` — the stored fact, derived here, never a stored enum. */
  completed: boolean;
}

/**
 * Where an account's quest state is filed (roadmap R03, `server/migrations/0007_quest_progress.sql`).
 * Keyed by the SSO `sub`, `ProgressStore`'s own convention, and holding no reward of any kind:
 * completing a quest here changes a counter and nothing else. The payout that counter can trigger
 * (roadmap R04-b) is a separate call this store never makes and never needs to know happened —
 * `MetaverseRoom.recordQuestKill` settles it through `SettlementStore` once this store's own
 * `recordKill` answers a row with `completed: true`.
 */
export interface QuestStore {
  /** Every quest this account has accepted, in no guaranteed order. Never-accepted quests are absent, not zero rows. */
  list(ownerKey: string): Promise<readonly QuestRow[]>;

  /**
   * Accepts `questId`, answering the state afterwards. Idempotent: accepting one already accepted
   * — a second tab, a re-opened panel, a replayed message — returns the existing row untouched
   * rather than resetting its counter, which is why this is an upsert and not an insert the caller
   * guards with a read. `accepted_at` therefore always means the *first* acceptance.
   */
  accept(ownerKey: string, questId: string): Promise<QuestRow>;

  /**
   * Credits one kill against `questId` and answers the state afterwards, or `null` when there was
   * nothing to credit — the account has not accepted it, or has already completed it.
   *
   * `requiredCount` travels in rather than being read here, `ProgressStore.applyDeathPenalty`'s
   * `floor` and for its reason: the requirement belongs to the code table, and this stays one
   * round trip that reads and writes the live counter in a single statement. Two kills for the
   * same account landing at once (two tabs, or two fire-and-forget grants racing) therefore cannot
   * lose one to a read-modify-write, and cannot complete the quest twice.
   */
  recordKill(ownerKey: string, questId: string, requiredCount: number): Promise<QuestRow | null>;
}

/**
 * The store a server booted without `DATABASE_URL` runs on — `InMemoryProgressStore`'s own role
 * and reason: it is the normal local-development path, and it is what keeps the server test suite
 * running without a Postgres to point it at.
 */
export class InMemoryQuestStore implements QuestStore {
  private readonly byOwner = new Map<string, Map<string, { killCount: number; completed: boolean }>>();

  list(ownerKey: string): Promise<readonly QuestRow[]> {
    const rows = this.byOwner.get(ownerKey);
    return Promise.resolve(
      rows === undefined
        ? []
        : [...rows].map(([questId, row]) => ({ questId, killCount: row.killCount, completed: row.completed })),
    );
  }

  accept(ownerKey: string, questId: string): Promise<QuestRow> {
    const rows = this.rowsOf(ownerKey);
    const existing = rows.get(questId);
    if (existing !== undefined) {
      return Promise.resolve({ questId, ...existing });
    }
    const created = { killCount: 0, completed: false };
    rows.set(questId, created);
    return Promise.resolve({ questId, ...created });
  }

  recordKill(ownerKey: string, questId: string, requiredCount: number): Promise<QuestRow | null> {
    // The same guard `PostgresQuestStore` applies, so the two implementations of this interface
    // agree on a nonsense requirement instead of only one of them catching it, live, in production
    // — `ProgressStore`'s own `assertGrantableAmount` reasoning.
    try {
      assertRequiredCount(requiredCount);
    } catch (cause) {
      return Promise.reject(cause as Error);
    }
    const row = this.byOwner.get(ownerKey)?.get(questId);
    if (row === undefined || row.completed) {
      return Promise.resolve(null);
    }
    row.killCount = Math.min(requiredCount, row.killCount + 1);
    row.completed = row.killCount >= requiredCount;
    return Promise.resolve({ questId, killCount: row.killCount, completed: row.completed });
  }

  private rowsOf(ownerKey: string): Map<string, { killCount: number; completed: boolean }> {
    const existing = this.byOwner.get(ownerKey);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Map<string, { killCount: number; completed: boolean }>();
    this.byOwner.set(ownerKey, created);
    return created;
  }
}

export class PostgresQuestStore implements QuestStore {
  constructor(private readonly pool: Pool) {}

  async list(ownerKey: string): Promise<readonly QuestRow[]> {
    assertUuidOwnerKey(ownerKey);
    const result = await this.query<StoredRow>(
      "SELECT quest_id, kill_count, completed_at FROM quest_progress WHERE owner_key = $1",
      [ownerKey],
    );
    return result.rows.map(toQuestRow);
  }

  async accept(ownerKey: string, questId: string): Promise<QuestRow> {
    assertUuidOwnerKey(ownerKey);
    // The self-assignment in DO UPDATE is what makes this one round trip instead of two: DO
    // NOTHING returns no row on conflict, which would force a follow-up SELECT on exactly the
    // common path (a panel re-opened on a quest already accepted). It changes no column — in
    // particular not `updated_at`, so re-opening the panel cannot make an untouched quest look
    // like it just progressed.
    const result = await this.query<StoredRow>(
      `INSERT INTO quest_progress (owner_key, quest_id)
       VALUES ($1, $2)
       ON CONFLICT (owner_key, quest_id)
       DO UPDATE SET quest_id = quest_progress.quest_id
       RETURNING quest_id, kill_count, completed_at`,
      [ownerKey, questId],
    );
    const row = result.rows[0];
    // RETURNING always answers here: the insert either wrote the row or the DO UPDATE touched it.
    return row === undefined ? { questId, killCount: 0, completed: false } : toQuestRow(row);
  }

  async recordKill(
    ownerKey: string,
    questId: string,
    requiredCount: number,
  ): Promise<QuestRow | null> {
    assertRequiredCount(requiredCount);
    assertUuidOwnerKey(ownerKey);
    // One statement against the live column, `ProgressStore.applyDeathPenalty`'s shape: the clamp,
    // the completion test and the write all read the same `kill_count` the database holds at that
    // instant, so two concurrent kills increment twice and complete once. `completed_at IS NULL` in
    // the WHERE is what makes the whole thing a no-op — zero rows, `null` out — for a quest that is
    // not accepted or is already finished, rather than something the caller has to check first and
    // then race against.
    const result = await this.query<StoredRow>(
      `UPDATE quest_progress
       SET kill_count = LEAST($3::int, kill_count + 1),
           completed_at = CASE WHEN kill_count + 1 >= $3::int THEN now() ELSE NULL END,
           updated_at = now()
       WHERE owner_key = $1 AND quest_id = $2 AND completed_at IS NULL
       RETURNING quest_id, kill_count, completed_at`,
      [ownerKey, questId, requiredCount],
    );
    const row = result.rows[0];
    return row === undefined ? null : toQuestRow(row);
  }

  /** Every query reports what it learned about the connection — `PostgresProgressStore.query`'s own contract. */
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

interface StoredRow extends Record<string, unknown> {
  quest_id: string;
  kill_count: number;
  completed_at: Date | null;
}

function toQuestRow(row: StoredRow): QuestRow {
  return {
    questId: row.quest_id,
    // `integer` comes back as a JS number; `bigint` would not, which is why the column is not one.
    killCount: Number(row.kill_count),
    completed: row.completed_at !== null,
  };
}

/**
 * Rejects a requirement the UPDATE's own arithmetic could not mean anything sensible with — a
 * zero would complete the quest on a kill that was never needed, a fraction would make `LEAST`
 * clamp to a fractional count the `integer` column then refuses at write time.
 */
function assertRequiredCount(requiredCount: number): void {
  if (!Number.isInteger(requiredCount) || requiredCount < 1) {
    throw new TypeError(`quest required count must be a positive integer, not ${requiredCount}`);
  }
}

/**
 * The shape `owner_key` is declared as, checked before the driver sees it — `PostgresProgressStore`'s
 * own `assertUuidOwnerKey` and for its exact reason: `MetaverseRoom` falls back to the session id
 * when there is no SSO identity, and a `22P02` from that would be indistinguishable, to
 * {@link PostgresQuestStore.query}, from a dropped connection — marking `/api/health` degraded on
 * every kill in local development.
 */
function assertUuidOwnerKey(ownerKey: string): void {
  if (!UUID_PATTERN.test(ownerKey)) {
    throw new TypeError(`quest owner key must be a uuid, not "${ownerKey}"`);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
