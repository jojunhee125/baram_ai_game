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
 * EXP needed to go from `level` to `level + 1`, for `level` in `[1, LEVEL_CAP)`. Sums to 68,881 by
 * `LEVEL_CAP`.
 *
 * The coefficient was 10 (total 34,438) until 2026-09-17 (decisions.md "왕초보 사냥터 EXP·레벨 곡선
 * 8배 하향"). Live play reported levelling as far too fast, and the diagnosis was that the starter
 * field's `expReward` values sat too high against this curve — 4 EXP a squirrel against a 10 EXP
 * first level meant three kills to reach level 2. The retune is deliberately split across both
 * numbers: `monsterDefinitions.ts` dropped squirrel/rabbit/deer to 1/2/3, which is as low as a
 * positive-integer reward can go, and the remaining factor of two had to come from here. The two
 * together are 8x, and only that part which lives here also slows down every future field.
 *
 * `LEVEL_CAP` is therefore no longer reachable in the starter field in any sensible time (68,881
 * squirrels) — intended, and the reason R07's themed zones have to carry rewards of their own
 * rather than only tougher monsters.
 */
export function expToNextLevel(level: number): number {
  return Math.round(20 * level ** 1.7);
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
