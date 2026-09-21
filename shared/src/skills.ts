/**
 * The skill execution contract (roadmap R05-b, `docs/r05-classes-and-skills.md` §2 D5/D7/D8, §3
 * R05-b scope) and the one core skill each class ships with today.
 *
 * Keyed by {@link SkillKey} rather than inlined on `ClassDefinition` (`classes.ts`): D5 already
 * sizes `PlayerSession.skillCooldowns` as a map from skill key to deadline in anticipation of a
 * second skill per class later, and this file is where that second row would land —
 * `ClassDefinition.skillKeys: readonly SkillKey[]` links a class to one-or-more rows here. This is
 * a deliberate refinement of D7's "수치는 `classDefinitions.ts` 한 파일의 명시 필드로 둔다" wording
 * (see `docs/r05-classes-and-skills.md` §7 for why splitting the skill table into its own file does
 * not drift from that instruction), not a departure from it — every tunable is still an explicit
 * field in exactly one place, just a skill-shaped place instead of a class-shaped one.
 *
 * Every number below is **provisional**, `CLASS_DEFINITIONS`' own disclaimer: there is no
 * kills-per-minute or gear-curve data before R06's growth CLI to weigh a multiplier against. They
 * were sanity-checked against what already exists (`PLAYER_ATTACK_DAMAGE`, `ATTACK_COOLDOWN_MS`,
 * each class's `maxMpBase`/`mpPerLevel`, `MP_COMBAT_RECOVERY_FRACTION_PER_TICK`) rather than picked
 * blind — see each definition's own comment for the specific comparison — but they are still a
 * guess, recorded honestly instead of hidden in scattered constants.
 */
export const SkillKey = {
  GuardStance: "guard-stance",
  Ambush: "ambush",
  Fireball: "fireball",
  Heal: "heal",
} as const;

export type SkillKey = (typeof SkillKey)[keyof typeof SkillKey];

/**
 * The three effect shapes D7's table describes, discriminated on `kind` so `handleUseSkill` applies
 * whichever one a skill carries without a switch keyed on {@link SkillKey} of its own.
 */
export type SkillEffect =
  | {
      kind: "self-damage-reduction";
      /**
       * Folded into `MetaverseRoom.equippedDamageReduction`'s existing multiplicative combination
       * (design §2 D7 — "새 감소 체계를 만들지 않고 시한부 항을 그 결합에 하나 더 넣는다"), never a
       * second damage-reduction axis of its own.
       */
      damageReduction: number;
      durationMs: number;
    }
  | {
      kind: "monster-damage";
      /** Multiplies `MetaverseRoom.totalAttack`'s result — never a parallel damage formula (design §2 D4). */
      attackMultiplier: number;
    }
  | {
      kind: "ally-heal";
      /**
       * Of the *target's* `totalMaxHp`, clamped to it — `ItemDefinition.consumable.healAmount`'s own
       * "never an overheal" rule, applied here to a target that may not be the caster.
       */
      healFractionOfTargetMaxHp: number;
    };

/** One skill's tunables — the single place every axis of D5/D7/D8 is read from. */
export interface SkillDefinition {
  key: SkillKey;
  /**
   * Display label, {@link ClassDefinition.label}'s own role and its own reason for living in
   * `shared` rather than the client (roadmap R05-c): the skill bar and any later readout name the
   * same skill, and a client-side copy of this table would be the one place the two could drift.
   * Not part of any wire message — the protocol carries {@link SkillKey}, never this.
   */
  label: string;
  /** Who a `skill:use` for this key can land on — the same three rows D6's table describes. */
  target: "self" | "monster" | "ally";
  /**
   * Chebyshev tiles, `ATTACK_RANGE_TILES`'s own unit. `0` for a `target: "self"` skill: no spatial
   * query is ever run for one, the caster is the only possible target.
   */
  rangeInTiles: number;
  mpCost: number;
  cooldownMs: number;
  effect: SkillEffect;
}

/** Narrows an unknown wire value to a real skill key — `UseSkillRequest.skillKey` is never trusted. */
export function isSkillKey(value: unknown): value is SkillKey {
  return typeof value === "string" && Object.hasOwn(SKILL_DEFINITIONS, value);
}

/**
 * One row per skill, D7's table verbatim plus the numbers D7 left for implementation time
 * (`docs/decisions.md` 2026-09-18 R05-b 미결 1). Keyed by {@link SkillKey} for the same reason
 * `CLASS_DEFINITIONS` is keyed by class: every lookup in `metaverseRoom.ts` already has the key in
 * hand (`UseSkillRequest.skillKey`, validated) and never needs to scan.
 */
export const SKILL_DEFINITIONS: Readonly<Record<SkillKey, SkillDefinition>> = {
  /**
   * 전사 — 방어 태세. Self-target, no query, long cooldown, low MP cost (`maxMpBase` 30 at level 1,
   * so 8 MP is a little over a quarter of the pool — "낮음" without being free). 50% damage
   * reduction for 4s is a strong defensive cooldown, which is the point of a "버티기" role skill;
   * the 12s cooldown (`ATTACK_COOLDOWN_MS` × 20) keeps it a burst-mitigation tool, not a permanent
   * damage-reduction stack layered on top of gear.
   */
  [SkillKey.GuardStance]: {
    key: SkillKey.GuardStance,
    label: "방어 태세",
    target: "self",
    rangeInTiles: 0,
    mpCost: 8,
    cooldownMs: 12_000,
    effect: { kind: "self-damage-reduction", damageReduction: 0.5, durationMs: 4_000 },
  },
  /**
   * 도적 — 급습. Monster-target, `ATTACK_RANGE_TILES`'s own reach (1 tile), medium cooldown, low MP
   * cost relative to `maxMpBase` 40 (4 casts before dry). `attackMultiplier: 4` is the "고배율 1회
   * 타격" D7 asks for — at level 1 that is `totalAttack(≈5) × 4 ≈ 20` in one hit against an
   * auto-attack DPS of `≈5 / ATTACK_COOLDOWN_MS(600ms) ≈ 8.3/s`; over the 4s cooldown that is
   * `20 / 4 ≈ 5/s`, below the auto-attack's own rate — a burst opener, not a DPS replacement.
   */
  [SkillKey.Ambush]: {
    key: SkillKey.Ambush,
    label: "급습",
    target: "monster",
    rangeInTiles: 1,
    mpCost: 10,
    cooldownMs: 4_000,
    effect: { kind: "monster-damage", attackMultiplier: 4 },
  },
  /**
   * 주술사 — 화염구. Monster-target, range 4 (D7's "4~5"), short cooldown, high MP cost against the
   * class's own `maxMpBase` 100 — `100 / 18 ≈ 5.5` casts before dry, comfortably more than twice
   * (the constraint `docs/decisions.md` 2026-09-18 R05-b 미결 1 calls out by name). `attackMultiplier:
   * 2.5` puts its own DPS (`totalAttack(≈5) × 2.5 / cooldownMs(1.5s) ≈ 8.3/s`) in the same range as
   * the class's auto-attack DPS (`≈8.3/s`) rather than an absurd multiple of it — the payoff for
   * spending MP is range and burst shape, not a free damage multiplier on top of auto-attacking.
   */
  [SkillKey.Fireball]: {
    key: SkillKey.Fireball,
    label: "화염구",
    target: "monster",
    rangeInTiles: 4,
    mpCost: 18,
    cooldownMs: 1_500,
    effect: { kind: "monster-damage", attackMultiplier: 2.5 },
  },
  /**
   * 도사 — 치유. Ally-or-self target, range 3 (D7's "3~4"), medium MP cost against `maxMpBase` 80
   * (4 casts before dry) and medium cooldown. `healFractionOfTargetMaxHp: 0.3` restores roughly a
   * third of a level-1 HP pool (100 × 0.3 = 30) per cast — enough to matter mid-fight without
   * trivializing `COMBAT_RECOVERY_FRACTION_PER_TICK`'s existing out-of-combat regen.
   */
  [SkillKey.Heal]: {
    key: SkillKey.Heal,
    label: "치유",
    target: "ally",
    rangeInTiles: 3,
    mpCost: 20,
    cooldownMs: 5_000,
    effect: { kind: "ally-heal", healFractionOfTargetMaxHp: 0.3 },
  },
};
