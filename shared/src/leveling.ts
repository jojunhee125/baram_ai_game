/**
 * The level/EXP curve (docs/design-phase-w-level-system.md §11, decisions.md 2026-09-11 "Phase
 * W·X 구현 착수 승인"): level is always derived from accumulated EXP, never stored on its own —
 * `state.ts`'s `Player.level` and `player_progress.exp` both point back here, so a curve or cap
 * change reinterprets every existing value instead of needing a migration or a broadcast of its
 * own (design §5.1).
 *
 * Server-only consumer today (`MetaverseRoom.awardExp`/`applyDeathExpPenalty`) — kept in shared
 * anyway, `camera.ts`'s own reason: a formula with two homes is a formula that drifts, and the
 * client's own EXP bar (Phase W-2) will need `levelForExp`/`remainingExpToNextLevel` the moment it
 * exists.
 */

/** Levels run 1..30 (design §11, the user's explicit "slow growth" choice over the 20 recommended). */
export const LEVEL_CAP = 30;

/** Automatic per-level stat growth (design §3 — no point-allocation UI). */
export const HP_PER_LEVEL = 10;
export const ATTACK_PER_LEVEL = 1;

/**
 * EXP needed to go from `level` to `level + 1`, for `level` in `[1, LEVEL_CAP)`. Sums to roughly
 * 34,000 by `LEVEL_CAP` (design §11) — about 5,000 average-EXP kills, which is what the monster
 * `expReward` table (`monsterDefinitions.ts`) was reverse-tuned against.
 */
export function expToNextLevel(level: number): number {
  return Math.round(10 * level ** 1.7);
}

/**
 * Cumulative EXP required to *be* `level` — 0 for level 1. `level` is clamped to `[1, LEVEL_CAP]`
 * first, so a caller outside that range gets the nearest real threshold rather than `undefined`.
 *
 * Backed by a table built once at module load rather than summed per call: `LEVEL_CAP` is fixed,
 * so this is 29 additions total for the process's whole life, not per kill.
 */
export function cumulativeExpForLevel(level: number): number {
  const clamped = Math.min(Math.max(Math.trunc(level), 1), LEVEL_CAP);
  return LEVEL_THRESHOLDS[clamped] ?? 0;
}

/** The level `exp` cumulative EXP falls into — never below 1, never above `LEVEL_CAP`. */
export function levelForExp(exp: number): number {
  let level = 1;
  while (level < LEVEL_CAP && exp >= cumulativeExpForLevel(level + 1)) {
    level += 1;
  }
  return level;
}

/**
 * EXP still needed to reach the next level from `exp`, or `null` once `levelForExp(exp)` has
 * already reached `LEVEL_CAP` — the wire shape `ExpGranted.expToNextLevel` (protocol.ts) mirrors.
 */
export function remainingExpToNextLevel(exp: number): number | null {
  const level = levelForExp(exp);
  return level >= LEVEL_CAP ? null : cumulativeExpForLevel(level + 1) - exp;
}

const LEVEL_THRESHOLDS: readonly number[] = buildLevelThresholds();

/** index 0 unused, index 1 = 0 (level 1 needs no EXP), index `L` = sum of expToNextLevel(1..L-1). */
function buildLevelThresholds(): readonly number[] {
  const thresholds: number[] = [0, 0];
  let total = 0;
  for (let level = 1; level < LEVEL_CAP; level++) {
    total += expToNextLevel(level);
    thresholds.push(total);
  }
  return thresholds;
}
