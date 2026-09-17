import type { TilePosition } from "@zep-test/shared";
import type {
  CollisionMap,
  InteractableDefinition,
  ItemDefinition,
  PortalDefinition,
} from "./contracts";

/**
 * Monster kinds. A string discriminant for {@link InteractableKind}'s reason: the same value is
 * the key of the type table below, the `kind` on the wire (`Monster.kind`) and the client's
 * sprite selector, and one readable value in three places beats a numeric code plus the mapping
 * table that drifts away from it.
 */
export const MonsterKind = {
  Squirrel: "squirrel",
  Rabbit: "rabbit",
  Deer: "deer",
  Boss: "boss",
} as const;

export type MonsterKind = (typeof MonsterKind)[keyof typeof MonsterKind];

/**
 * 6 hours, ms (design-phase-i-boss-monster.md §7). The gap from the other kinds'
 * `respawnDelayMs` (at most 16000) is deliberate: the size difference is what says "this one
 * needs its state remembered across room instances" (§1), which {@link MonsterType.isBoss} and
 * {@link MonsterSpawnDefinition.persistentRespawn} carry into the code that actually persists it.
 */
export const BOSS_RESPAWN_MS = 6 * 60 * 60 * 1000;

/**
 * One line of a kind's drop table. Rolled independently of the other lines, so a kill can yield
 * nothing or several things and each row can be read on its own.
 *
 * Declared here rather than beside `rollLoot` because {@link MonsterType} is what owns it and
 * this file has to compile before there is any combat: Pass E's `game/loot.ts` imports it from
 * here (`docs/design-hunting-inventory.md` §6.5).
 */
export interface LootEntry {
  /** An {@link ItemDefinition.key}. Boot validation refuses a key that is not in the catalogue. */
  itemKey: string;
  /** Greater than 0 and at most 1. A 0 is a line that can never drop, which is a typo. */
  chance: number;
  /** Integer, at least 1. */
  quantity: number;
}

/**
 * The rules of one monster kind. None of this reaches the client — the only number it needs
 * (`hpMax`) rides along on every `MonsterHit`, so the client never holds a stat table that can
 * fall behind the server's.
 */
export interface MonsterType {
  kind: MonsterKind;
  maxHp: number;
  damage: number;
  attackCooldownMs: number;
  /**
   * Interval between wander steps. A monster's step costs the same as a player's step (every
   * viewer within the radius has their bookkeeping updated), so this and its chase twin are the
   * real performance levers of the whole feature — not the tick rate.
   */
  wanderStepIntervalMs: number;
  chaseStepIntervalMs: number;
  aggroRadiusTiles: number;
  /** Past this distance from the spawn point the monster drops its target and walks home. */
  leashRadiusTiles: number;
  respawnDelayMs: number;
  loot: readonly LootEntry[];
  /**
   * EXP credited to whoever last hit this monster (design-phase-w-level-system.md §4.1, §11 —
   * last-hit, `awardLoot`'s own rule reused). A positive integer, boot-validated the way loot's
   * `chance`/`quantity` already are (`validateMonsterSpawnDefinitions`). Hand-tuned per kind rather
   * than derived from `maxHp`/`damage`: this table's stats have always been set by feel and
   * live-play feedback (the comment above this map documents two such retunings), and `expReward`
   * is the same kind of number.
   */
  expReward: number;
  /**
   * True only for the boss kind. Boot validation requires every spawn row with
   * {@link MonsterSpawnDefinition.persistentRespawn} to name a kind with this set, and vice versa
   * (design §7) — the pairing is what stops a typo from silently giving a squirrel row DB-backed
   * persistence, or leaving a boss row without it.
   */
  isBoss?: boolean;
}

/**
 * Per-kind rules. Every duration is an integer multiple of MONSTER_TICK_MS (200) — otherwise a
 * deadline rounds up to the next tick and this table quietly stops describing what happens.
 *
 * Derived from constants that are already fixed, not picked:
 *  - player damage 4 every 600ms -> 6.67 DPS, player HP 100
 *  - a walking player covers a tile per STEP_TWEEN_MS (120ms) = 8.3 tiles/s
 *  - the viewport shows 8 tiles above the player, so aggro must stay <= 8 or monsters charge in
 *    from off screen
 *
 * `damage` was retuned twice. Phase A (2026-09-03, from 2/3 to 7/10) paired the bump with
 * PLAYER_MAX_HP's 30->100 and COMBAT_EXIT_MS's 5000->2000, fixing "recovery is structurally 0"
 * without leaning on a cheaper monster. Later the same day, live play at hunting-ground (the
 * "왕초보 사냥터") reported that result as too punishing regardless — rabbit's 800ms cooldown sits
 * close enough to the player's own 600ms that every exchange read as a race the player was
 * already losing — so damage was nerfed again, 7/10 -> 5/7 (squirrel/rabbit), roughly -30% DPS
 * on both kinds. Cooldowns and HP are unchanged; only the per-hit number moved.
 *
 * The result: solo TTK against a player is now ~24s (squirrel) / ~11.4s (rabbit) — softer than
 * Phase A's 18s/8s — against a 2s out-of-combat recovery. One monster still can never kill a
 * player alone; several at once can. That is the difficulty a starter field wants.
 */
export const MONSTER_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      /** Exactly three hits (4x3). The beginner monster has to be countable. */
      maxHp: 12,
      /** Nerfed from 7 (live-play feedback, 2026-09-03) — see the table's own comment above. */
      damage: 5,
      attackCooldownMs: 1200,
      wanderStepIntervalMs: 1600,
      /** 1.67 tiles/s, a fifth of a walking player: you can always stroll away from a squirrel. */
      chaseStepIntervalMs: 600,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 8,
      respawnDelayMs: 8000,
      /**
       * 1 is the floor — `validateMonsterSpawnDefinitions` requires a positive integer, so the
       * lowest monster in the game cannot be made cheaper than this. Was 4 until 2026-09-17
       * (decisions.md "왕초보 사냥터 EXP·레벨 곡선 8배 하향"): 4 against the old 10 EXP first level
       * meant three squirrels to reach level 2, and the starter field is the one place that must
       * not pay well. The other half of the 8x lives in `expToNextLevel` (shared/src/leveling.ts),
       * because this number had nowhere lower to go.
       */
      expReward: 1,
      loot: [
        { itemKey: "acorn", chance: 0.6, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.25, quantity: 1 },
        { itemKey: "herb", chance: 0.08, quantity: 1 },
        { itemKey: "entry-pass", chance: 0.15, quantity: 1 },
      ],
    },
  ],
  [
    MonsterKind.Rabbit,
    {
      kind: MonsterKind.Rabbit,
      /**
       * Still five hits: 19/4 rounds up to 5, same as the clean 4x5 this was before the 2026-09-03
       * -1 tweak — unmistakably a different fight from the squirrel's three either way.
       */
      maxHp: 19,
      /** Nerfed from 10 (live-play feedback, 2026-09-03) — see the table's own comment above. */
      damage: 7,
      attackCooldownMs: 800,
      wanderStepIntervalMs: 1200,
      /** 2.5 tiles/s. Still a third of a player's pace, so fleeing always works. */
      chaseStepIntervalMs: 400,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 10,
      respawnDelayMs: 12000,
      /** squirrel(1) < rabbit(2) < deer(3) « boss(600), the hits-to-kill ordering §4.1 asks for. Was 7 (2026-09-17 retune). */
      expReward: 2,
      loot: [
        { itemKey: "carrot", chance: 0.55, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.35, quantity: 1 },
        { itemKey: "herb", chance: 0.12, quantity: 1 },
        { itemKey: "old-dagger", chance: 0.03, quantity: 1 },
      ],
    },
  ],
  [
    MonsterKind.Deer,
    {
      kind: MonsterKind.Deer,
      /** Seven hits (4x7) — 3 (squirrel) / 5 (rabbit) / 7 (deer) keeps the odd-hit-count sequence. */
      maxHp: 28,
      /**
       * Rabbit's value, reused rather than invented: the den's threat ceiling stays unchanged.
       * Tracks Rabbit's own 10->7 live-play nerf (2026-09-03) for the same reason.
       */
      damage: 7,
      /**
       * Squirrel's cadence (DPS 5.83 post-nerf), not rabbit's (8.75) — a body this much tankier
       * hitting as often as the rabbit would be a net increase in the den's danger, so the
       * cadence stays low.
       */
      attackCooldownMs: 1200,
      /** Slower than either existing kind: the big-bodied grazer among two smaller, quicker ones. */
      wanderStepIntervalMs: 2000,
      /** Squirrel's value, reused: 1.67 tiles/s, a fifth of a walking player, so fleeing always works. */
      chaseStepIntervalMs: 600,
      aggroRadiusTiles: 2,
      /** Rabbit's value, reused. */
      leashRadiusTiles: 10,
      /** Continues the den's respawn arithmetic (8000, 12000, +4000). */
      respawnDelayMs: 16000,
      /** squirrel(1) < rabbit(2) < deer(3) « boss(600). Was 11 (2026-09-17 retune). */
      expReward: 3,
      loot: [
        { itemKey: "herb", chance: 0.5, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.3, quantity: 1 },
        { itemKey: "carrot", chance: 0.15, quantity: 1 },
        { itemKey: "old-dagger", chance: 0.05, quantity: 1 },
        { itemKey: "leather-armor", chance: 0.03, quantity: 1 },
      ],
    },
  ],
  [
    MonsterKind.Boss,
    {
      kind: MonsterKind.Boss,
      isBoss: true,
      /**
       * ~180x the existing top HP (deer, 28) — the same "the delay is a bigger number in the same
       * field" move `respawnDelayMs` makes, applied to HP (design §11.1). Solo TTK is ~8.3 minutes
       * with `old-dagger` and the boss never missing a swing back; a 6-10 person group clears in
       * 1-2 minutes. Group play is a side effect of the number, not a separate rule.
       */
      maxHp: 5000,
      /** Above the existing top (rabbit/deer, 7) — DPS 18/1.4 = 12.86, above rabbit's 8.75. */
      damage: 18,
      attackCooldownMs: 1400,
      /** Slower than deer's 2000 — the biggest body wanders the slowest. */
      wanderStepIntervalMs: 2400,
      /** Slower than every existing kind (400-600) — about 1/6.6 of a walking player; fleeing always wins. */
      chaseStepIntervalMs: 800,
      /** Unchanged from every other kind — a room-wide aggro radius would be a new mechanic, not a stat (design §4). */
      aggroRadiusTiles: 2,
      /** Rabbit/deer's own value, reused rather than inventing a new one. */
      leashRadiusTiles: 10,
      respawnDelayMs: BOSS_RESPAWN_MS,
      /**
       * Far above deer, matching the same "the delay is a bigger number" move maxHp/respawnDelayMs
       * already made. **Deliberately left at 600 by the 2026-09-17 retune** (user's explicit call)
       * while the three field kinds dropped 4x: a 6-hour respawn means this cannot be farmed, so
       * the one number in the table that is rate-limited by the clock rather than by the player is
       * also the one that does not need to be cut. The gap is now 600 squirrels rather than 150 —
       * the boss is the starter field's fastest levelling route by a wide margin, on purpose.
       */
      expReward: 600,
      loot: [{ itemKey: "golden-helmet", chance: 0.25, quantity: 1 }],
    },
  ],
]);

/**
 * One spawn point, which owns at most one living monster. Population is therefore the length of
 * the table below and not a runtime value: there is no spawner period and no per-area cap, so
 * there is no way for the count to run away. Same layer and same trust model as
 * `PORTAL_DEFINITIONS` and `INTERACTABLE_DEFINITIONS` — what is in code is authoritative, and
 * editing it means deploying.
 *
 * Deliberately not merged with those two tables even though this is the fourth of its kind. A
 * portal row and an object row are both "a tile that fires when stepped on" and are looked up by
 * position on the move path; a spawn point fires nothing and is never looked up by position — it
 * *owns an entity*. There is no shared query to factor out.
 */
export interface MonsterSpawnDefinition {
  /** Unique across the table. It is the `state.monsters` key and the `monsterId` on the wire. */
  id: string;
  /** A {@link RoomDefinition} `name`. A room named in no row never starts a simulation loop. */
  room: string;
  kind: MonsterKind;
  /** Boot validation refuses an unwalkable tile: a spawner in a wall is a monster that never comes. */
  at: TilePosition;
  /** Chebyshev half-extent the monster wanders inside. 0 pins it to its spawn tile. */
  wanderRadiusTiles: number;
  /**
   * True only for a boss row (design-phase-i-boss-monster.md §2, §7). Routes `populateMonsters()`
   * through a `BossStateStore` read at room creation and `killMonster()` through a fire-and-forget
   * write on death — every other row (squirrel/rabbit/deer) takes neither path, which is what
   * keeps "monster state lives only in room memory" true for everything but this one flag. Boot
   * validation requires this to agree with {@link MonsterType.isBoss} of the row's own kind, in
   * both directions.
   */
  persistentRespawn?: boolean;
}

/**
 * Every hunting room's monster placement, one contiguous table across both rooms. hunting-ground
 * holds 20 rows + a boss, hunting-den (Phase E) holds 10 more + a boss - 32 total, the PoC #3
 * population cap as of Phase I (design-phase-i-boss-monster.md §5; both bosses were added inside
 * the range PoC #3 already measured safe, so the cap moved from 30 to 32 without a new load test).
 *
 * Nothing spawns at y >= 25 in hunting-ground or y >= 24 in hunting-den. Someone coming through a
 * room's entrance door must not arrive into a fight already in progress, and with the wander
 * radii added no monster's resting range reaches the entrance either. That is a property of this
 * table rather than of a boot check, so keep it when adding rows. A monster dragged to a door by
 * a player is inside its leash and is working as intended.
 *
 * hunting-ground's difficulty runs south to north: squirrels at the y23-24 entrance band, rabbits
 * at the y10 far edge. hunting-den was rabbits only at launch (`docs/design-phase-e-second-hunting-ground.md`
 * §4); Phase S (`docs/roadmap.md` row S) added deer, interleaved 5:5 with the rabbits so no corner
 * of the room reads as "the strong part". Coordinates were checked against the actual map file of their own room (walkable, inside
 * the interior, clear of the portal tiles, and at least 6 tiles from the arrival and player spawn).
 */
export const MONSTER_SPAWN_DEFINITIONS: readonly MonsterSpawnDefinition[] = [
  // -- Southern band, nearest the entrance; all squirrels --
  { id: "hg-squirrel-01", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 19, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-02", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 24, tileY: 23 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-03", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 29, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-04", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 41, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-05", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 46, tileY: 23 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-06", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 51, tileY: 24 }, wanderRadiusTiles: 2 },
  // -- Middle band --
  { id: "hg-squirrel-07", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 18, tileY: 19 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-08", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 23, tileY: 20 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-09", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 28, tileY: 18 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-10", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 33, tileY: 20 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-11", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 44, tileY: 19 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-12", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 49, tileY: 20 }, wanderRadiusTiles: 2 },
  // -- Northern band, the rabbit ground; the two squirrels at either end are the transition --
  { id: "hg-squirrel-13", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 21, tileY: 14 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-14", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 52, tileY: 14 }, wanderRadiusTiles: 2 },
  { id: "hg-rabbit-01", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 26, tileY: 14 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-02", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 38, tileY: 13 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-03", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 45, tileY: 15 }, wanderRadiusTiles: 3 },
  // y = 10 rather than y = 9: a radius-3 wander box has 36 of 49 tiles walkable there against 29
  // one row up, so these three scrape the boundary band far less.
  { id: "hg-rabbit-04", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 22, tileY: 10 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-05", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 35, tileY: 10 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-06", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 49, tileY: 10 }, wanderRadiusTiles: 3 },
  // -- hunting-den, Phase E's second room. Launched rabbits-only (`docs/design-phase-e-second-hunting-ground.md`
  // §4); Phase S (`docs/roadmap.md` row S) swapped in deer at every other spawn point — interleaved
  // 5:5, not clustered, so the room doesn't read as having a "harder" corner. 20 + 10 = 30, the
  // PoC #3 population cap, reached exactly. Positions and wanderRadiusTiles are unchanged from
  // launch; only kind and id were touched (ids renumbered so the rabbit sequence stays contiguous).
  //
  // Nothing spawns at y >= 24, for hunting-ground's own reason: a player arriving through the
  // south door must not land in a fight already in progress. Coordinates were checked against
  // the actual `assets/maps/hunting-den.json` (walkable, inside the interior, clear of the
  // portal tiles). hd-rabbit-08 (now hd-deer-04, same position) was moved from the design's
  // placeholder (32, 18) to (35, 18): the placeholder sat on the trail (map x 31-32, the
  // full-height dirt path connecting both doors), which the design flagged as a coder judgement
  // call rather than something the boot validator would catch.
  { id: "hd-rabbit-01", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 21, tileY: 12 }, wanderRadiusTiles: 3 },
  { id: "hd-deer-01", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 27, tileY: 11 }, wanderRadiusTiles: 3 },
  { id: "hd-rabbit-02", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 33, tileY: 13 }, wanderRadiusTiles: 3 },
  { id: "hd-deer-02", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 39, tileY: 11 }, wanderRadiusTiles: 3 },
  { id: "hd-rabbit-03", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 44, tileY: 13 }, wanderRadiusTiles: 3 },
  { id: "hd-deer-03", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 20, tileY: 19 }, wanderRadiusTiles: 3 },
  { id: "hd-rabbit-04", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 26, tileY: 20 }, wanderRadiusTiles: 3 },
  { id: "hd-deer-04", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 35, tileY: 18 }, wanderRadiusTiles: 3 },
  { id: "hd-rabbit-05", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 38, tileY: 20 }, wanderRadiusTiles: 3 },
  { id: "hd-deer-05", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 43, tileY: 19 }, wanderRadiusTiles: 3 },
  // -- Bosses (Phase I, design-phase-i-boss-monster.md §3, §11.2). One per room, `wanderRadiusTiles`
  // matched to rabbit/deer's own 3. Coordinates were checked against the actual map files
  // (`assets/maps/hunting-ground.json` / `assets/maps/hunting-den.json`): each sits at least 6
  // tiles (Chebyshev) from *every* tile a player can arrive on in its own room — portal trigger and
  // arrival tiles, the room's whole join-spawn spread square, its `home` (the death-warp target,
  // `metaverseRoom.ts`), and any landmark tile — and its wander box is fully open (hg-boss-01) or
  // open but for two tiles (hd-boss-01: 28,16 and 28,17).
  //
  // The arrival set has to be the full one, not just the portals: hd-boss-01 launched at (31,20),
  // which cleared every portal tile but stood 4 tiles from home (31,24) — inside wander(3) +
  // aggro(2) = 5. A solo player killed there warps home and is re-aggroed on arrival, which
  // cancels the §6.6 wipe reset the death just armed, so the boss keeps the group's damage
  // forever. 6 is exactly that reach plus one: at 6 a freely wandering boss can never aggro a
  // player standing on an arrival tile. `passI-boss-independent-reverification.test.ts` REVERIFY B
  // asserts all three properties for every `persistentRespawn` row.
  { id: "hg-boss-01", room: "hunting-ground", kind: MonsterKind.Boss, at: { tileX: 34, tileY: 16 }, wanderRadiusTiles: 3, persistentRespawn: true },
  { id: "hd-boss-01", room: "hunting-den", kind: MonsterKind.Boss, at: { tileX: 31, tileY: 17 }, wanderRadiusTiles: 3, persistentRespawn: true },
];

/** Boot-validation outcome. Every error refuses boot; warnings are authoring smells only. */
export interface MonsterValidation {
  errors: readonly string[];
  warnings: readonly string[];
}

/**
 * Checks the monster tables at boot, alongside `validatePortalDefinitions`,
 * `validateInteractableDefinitions` and `validateItemDefinitions` and for the same reason: none
 * of these faults surfaces until somebody walks into that corner of that map, by which time the
 * server has been reporting itself healthy for hours.
 *
 * Both tables are checked, not just the spawns: a drop line naming an item that is not in the
 * catalogue is only reachable on a kill, and the kill is where finding out about it is worst.
 *
 * `portals` and `interactables` are taken beyond the signature the design sketched, because the
 * documented overlap *warning* cannot be computed without them —
 * `validateInteractableDefinitions` already takes the portal table for the same reason.
 *
 * Every issue is collected rather than thrown at the first one: a boot failure that reveals one
 * typo per restart is a bad way to fix a table.
 */
export function validateMonsterSpawnDefinitions(
  spawns: readonly MonsterSpawnDefinition[],
  types: ReadonlyMap<MonsterKind, MonsterType>,
  items: readonly ItemDefinition[],
  mapsByRoom: ReadonlyMap<string, CollisionMap>,
  portals: readonly PortalDefinition[],
  interactables: readonly InteractableDefinition[],
): MonsterValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  for (const [kind, type] of types) {
    const label = `monster type "${kind}"`;
    if (type.kind !== kind) {
      // The map key is what a spawn row names and `type.kind` is what the wire carries, so a
      // mismatch renders one monster as another without anything else noticing.
      errors.push(`${label} is filed under a key that does not match its own kind "${type.kind}"`);
    }
    if (!Number.isInteger(type.expReward) || type.expReward <= 0) {
      // Same spot, same pattern as the loot chance/quantity checks just below: a kill that grants
      // 0, a negative amount or a fraction is a typo that boot should catch, not `awardExp`.
      errors.push(`${label} has an expReward of ${type.expReward}, which is not a positive integer`);
    }
    for (const [index, entry] of type.loot.entries()) {
      const line = `${label} loot row ${index}`;
      const item = itemsByKey.get(entry.itemKey);
      if (item === undefined) {
        errors.push(`${line} drops "${entry.itemKey}", which is not in the item catalogue`);
      } else if (item.possession === true && entry.quantity !== 1) {
        // A possession item is granted through `grantOnce`, which always credits exactly one —
        // a row asking for more is a promise the grant path can never keep.
        errors.push(`${line} drops possession item "${entry.itemKey}" with quantity ${entry.quantity}, which must be 1`);
      }
      if (!(entry.chance > 0) || entry.chance > 1) {
        errors.push(`${line} has a chance of ${entry.chance}, which is outside (0, 1]`);
      }
      if (!Number.isInteger(entry.quantity) || entry.quantity < 1) {
        errors.push(`${line} grants ${entry.quantity}, which is not a positive integer`);
      }
    }
  }

  // String keys are fine here, unlike on the move path: this runs once, at boot.
  const portalTilesByRoom = new Map<string, Set<string>>();
  for (const portal of portals) {
    for (const tile of portal.from.tiles) {
      tilesOf(portalTilesByRoom, portal.from.room).add(tileKey(tile.tileX, tile.tileY));
    }
    const { arrival } = portal.to;
    tilesOf(portalTilesByRoom, portal.to.room).add(tileKey(arrival.tileX, arrival.tileY));
  }
  const objectTilesByRoom = new Map<string, Set<string>>();
  for (const object of interactables) {
    for (const tile of object.at.tiles) {
      tilesOf(objectTilesByRoom, object.at.room).add(tileKey(tile.tileX, tile.tileY));
    }
  }

  const seenIds = new Set<string>();
  for (const [index, spawn] of spawns.entries()) {
    const label = spawn.id.trim().length === 0 ? `monster spawn at row ${index}` : `monster spawn "${spawn.id}"`;
    if (spawn.id.trim().length === 0) {
      errors.push(`${label} has an empty id`);
    } else if (spawn.id !== spawn.id.trim()) {
      // The id is the `state.monsters` key and the `monsterId` on the wire, where the padding is
      // invisible; the trimmed spelling would then look like a different, missing monster.
      errors.push(`${label} has leading or trailing whitespace in its id`);
    } else if (seenIds.has(spawn.id)) {
      // The second row would be unreachable: both write the same `state.monsters` key.
      errors.push(`${label} is declared more than once`);
    } else {
      seenIds.add(spawn.id);
    }

    const type = types.get(spawn.kind);
    if (type === undefined) {
      errors.push(`${label} is of kind "${spawn.kind}", which has no entry in MONSTER_TYPES`);
    } else {
      // Both directions (design §7): a boss row missing the flag would never persist its state,
      // and a non-boss row carrying it would read a table this store was never meant to hold.
      const isBossKind = type.isBoss === true;
      const isPersistentSpawn = spawn.persistentRespawn === true;
      if (isPersistentSpawn && !isBossKind) {
        errors.push(`${label} sets persistentRespawn but its kind "${spawn.kind}" is not a boss type`);
      } else if (isBossKind && !isPersistentSpawn) {
        errors.push(`${label} is of boss kind "${spawn.kind}" but does not set persistentRespawn`);
      }
    }

    if (!Number.isInteger(spawn.wanderRadiusTiles) || spawn.wanderRadiusTiles < 0) {
      errors.push(
        `${label} has a wanderRadiusTiles of ${spawn.wanderRadiusTiles}, which is not a non-negative integer`,
      );
    }

    const map = mapsByRoom.get(spawn.room);
    if (map === undefined) {
      errors.push(`${label} sits in "${spawn.room}", which is not a registered room`);
      continue;
    }
    // isWalkable() reports out-of-bounds tiles as blocked, so this covers both checks.
    if (!map.isWalkable(spawn.at.tileX, spawn.at.tileY)) {
      errors.push(
        `${label} spawns at (${spawn.at.tileX},${spawn.at.tileY}), which is not a walkable tile of room "${spawn.room}"`,
      );
    }

    // Warnings, not errors: a monster standing on a door or a signboard works fine — it just
    // means someone will walk into a fight the instant they arrive, which is nearly always a typo.
    const key = tileKey(spawn.at.tileX, spawn.at.tileY);
    if (portalTilesByRoom.get(spawn.room)?.has(key)) {
      warnings.push(
        `${label} spawns at (${spawn.at.tileX},${spawn.at.tileY}), which is a portal trigger or arrival tile in room "${spawn.room}"`,
      );
    }
    if (objectTilesByRoom.get(spawn.room)?.has(key)) {
      warnings.push(
        `${label} spawns at (${spawn.at.tileX},${spawn.at.tileY}), which is an interactable object's tile in room "${spawn.room}"`,
      );
    }
  }

  return { errors, warnings };
}

function tilesOf(byRoom: Map<string, Set<string>>, room: string): Set<string> {
  let tiles = byRoom.get(room);
  if (tiles === undefined) {
    tiles = new Set<string>();
    byRoom.set(room, tiles);
  }
  return tiles;
}

function tileKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`;
}
