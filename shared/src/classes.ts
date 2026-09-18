import { SkillKey } from "./skills";

/**
 * The four playable classes (roadmap R05-a, `docs/r05-classes-and-skills.md` D1/D3/D4/D7,
 * `docs/decisions.md` 2026-09-18). `PlayerClassKey` is the DB/wire string form —
 * `player_class.class_key`, `ChooseClassRequest.classKey`, `ClassChanged.classKey` — while
 * `PlayerClassCode` is the numeric form `Player.playerClass` (`state.ts`) carries on the schema.
 *
 * Every tunable in {@link CLASS_DEFINITIONS} is **provisional** — there is no balance data yet
 * (no kills-per-minute, no gear curve) to weigh a multiplier against, `ITEM_DEFINITIONS.sellValue`'s
 * own precedent (`docs/decisions.md` 2026-09-18 R04-c): the honest move is to put every number in
 * one explicit place, not to pick confidently and hide the guess in scattered constants. Revisit
 * once R06's growth CLI has real numbers to check these against.
 */
export const PlayerClassKey = {
  Warrior: "warrior",
  Rogue: "rogue",
  Shaman: "shaman",
  Cleric: "cleric",
} as const;

export type PlayerClassKey = (typeof PlayerClassKey)[keyof typeof PlayerClassKey];

/**
 * The wire/schema form of a class. `0` is not "no class" left implicit — it is `Unchosen`,
 * spelled out for {@link classKeyFor}'s reason: `@colyseus/schema` does not zero-initialise an
 * unassigned primitive to a meaningful value of its own, so `Player.playerClass` must always be
 * set at spawn (`MetaverseRoom.onJoin`, `state.ts`'s own rule for `Player.level`), and `0` is what
 * that assignment writes for an account that has not chosen yet.
 */
export const PlayerClassCode = {
  Unchosen: 0,
  Warrior: 1,
  Rogue: 2,
  Shaman: 3,
  Cleric: 4,
} as const;

export type PlayerClassCode = (typeof PlayerClassCode)[keyof typeof PlayerClassCode];

/** One class's tunables — the single place every axis of D4/D7 is read from. */
export interface ClassDefinition {
  key: PlayerClassKey;
  code: PlayerClassCode;
  /** Display label, the roadmap's own wording (`docs/decisions.md` 2026-09-18 열린 질문 1). */
  label: string;
  /** Multiplies `MetaverseRoom.totalMaxHp`'s base+level+equipment sum. */
  maxHpMultiplier: number;
  /** Multiplies `MetaverseRoom.totalAttack`'s base+level+equipment sum. */
  attackMultiplier: number;
  /** MP at level 1 — `MetaverseRoom.totalMaxMp`'s floor for this class. */
  maxMpBase: number;
  /** MP added per level above 1, added to `maxMpBase` by `totalMaxMp`. */
  mpPerLevel: number;
  /**
   * The skills this class can `skill:use` (roadmap R05-b, `docs/r05-classes-and-skills.md` §7) —
   * one entry each today. `handleUseSkill`'s `unknown-skill` check is exactly "not one of these".
   */
  skillKeys: readonly SkillKey[];
}

/**
 * One row per class, D7's table verbatim. Keyed by {@link PlayerClassKey} rather than held as an
 * array: every lookup in `metaverseRoom.ts` (`totalAttack`/`totalMaxHp`/`totalMaxMp`) already has
 * the key in hand from `PlayerSession.playerClass` and never needs to scan.
 */
export const CLASS_DEFINITIONS: Readonly<Record<PlayerClassKey, ClassDefinition>> = {
  [PlayerClassKey.Warrior]: {
    key: PlayerClassKey.Warrior,
    code: PlayerClassCode.Warrior,
    label: "전사",
    maxHpMultiplier: 1.25,
    attackMultiplier: 0.9,
    maxMpBase: 30,
    mpPerLevel: 2,
    skillKeys: [SkillKey.GuardStance],
  },
  [PlayerClassKey.Rogue]: {
    key: PlayerClassKey.Rogue,
    code: PlayerClassCode.Rogue,
    label: "도적",
    maxHpMultiplier: 0.9,
    attackMultiplier: 1.2,
    maxMpBase: 40,
    mpPerLevel: 2,
    skillKeys: [SkillKey.Ambush],
  },
  [PlayerClassKey.Shaman]: {
    key: PlayerClassKey.Shaman,
    code: PlayerClassCode.Shaman,
    label: "주술사",
    maxHpMultiplier: 0.75,
    attackMultiplier: 1.3,
    maxMpBase: 100,
    mpPerLevel: 6,
    skillKeys: [SkillKey.Fireball],
  },
  [PlayerClassKey.Cleric]: {
    key: PlayerClassKey.Cleric,
    code: PlayerClassCode.Cleric,
    label: "도사",
    maxHpMultiplier: 1.0,
    attackMultiplier: 0.8,
    maxMpBase: 80,
    mpPerLevel: 5,
    skillKeys: [SkillKey.Heal],
  },
};

/** Narrows an unknown wire value to a real class key — `ChooseClassRequest.classKey` is never trusted. */
export function isPlayerClassKey(value: unknown): value is PlayerClassKey {
  return typeof value === "string" && Object.hasOwn(CLASS_DEFINITIONS, value);
}

/** `null` (unchosen) maps to {@link PlayerClassCode.Unchosen}; every real key to its own code. */
export function classCodeFor(key: PlayerClassKey | null): PlayerClassCode {
  return key === null ? PlayerClassCode.Unchosen : CLASS_DEFINITIONS[key].code;
}

/**
 * The inverse of {@link classCodeFor}. `null` for `Unchosen` and for any code this table does not
 * recognise — a client holding a bundle older than a future fifth class must not crash reading one
 * off `Player.playerClass`, the same "unknown resolves to the safe default" rule {@link
 * PlayerClassKey.Warrior}'s own callers already give an unknown `viaPortal`/`arriveAtLandmark`.
 */
export function classKeyFor(code: number): PlayerClassKey | null {
  for (const definition of Object.values(CLASS_DEFINITIONS)) {
    if (definition.code === code) {
      return definition.key;
    }
  }
  return null;
}
