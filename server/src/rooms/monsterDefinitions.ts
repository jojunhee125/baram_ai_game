import { PROGRESSION_REGIONS, type TilePosition } from "@zep-test/shared";
import { PROGRESSION_MONSTERS, PROGRESSION_SPAWNS } from "./progressionDefinitions";
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
  FemaleDeer: "female-deer", Rat: "rat", Bat: "bat", Snake: "snake", Python: "python", KingPython: "king-python",
  Bear: "bear", Pyeongung: "pyeongung", Tiger: "tiger", BlueDeer: "blue-deer", RedDeer: "red-deer",
  WildBoar: "wild-boar", ForestBoar: "forest-boar", BlackFox: "black-fox", WhiteFox: "white-fox", Gumiho: "gumiho",
  MarshSlime: "marsh-slime",
  ReedSerpent: "reed-serpent",
  CaveBat: "cave-bat",
  RockBoar: "rock-boar",
  SnowWolf: "snow-wolf",
  FrostGolem: "frost-golem",
  RuinSentinel: "ruin-sentinel",
  CursedFlame: "cursed-flame",
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
export type MonsterBehavior = "aggressive" | "timid" | "ambush";

export interface MonsterType {
  kind: MonsterKind;
  /** Absent keeps the original aggressive behavior for fixtures and unconfigured rooms. */
  behavior?: MonsterBehavior;
  fleeStepIntervalMs?: number;
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

export const MONSTER_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map<MonsterKind, MonsterType>([
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
  ...PROGRESSION_MONSTERS,
]);

const REGION_MONSTER_TYPES = new Map(PROGRESSION_REGIONS.map((region) => [
  region.roomId as string,
  new Map(region.monsterKinds.map((kind) => [kind as MonsterKind, PROGRESSION_MONSTERS.get(kind as MonsterKind)!])),
]));

export function monsterTypesForRoom(roomName: string | undefined): ReadonlyMap<MonsterKind, MonsterType> {
  return roomName === undefined ? MONSTER_TYPES : REGION_MONSTER_TYPES.get(roomName) ?? MONSTER_TYPES;
}

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

export const MONSTER_SPAWN_DEFINITIONS: readonly MonsterSpawnDefinition[] = PROGRESSION_SPAWNS;

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
  typesForRoom: (roomName: string) => ReadonlyMap<MonsterKind, MonsterType> = () => types,
): MonsterValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  const regionalTypes = new Set([types, ...[...mapsByRoom.keys()].map(typesForRoom)]);
  for (const [kind, type] of [...regionalTypes].flatMap((table) => [...table])) {
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
    if (type.behavior !== undefined && type.behavior !== "aggressive" && type.behavior !== "timid" && type.behavior !== "ambush") {
      errors.push(`${label} has an unknown behavior "${type.behavior}"`);
    }
    if (type.behavior === "timid" && (!Number.isInteger(type.fleeStepIntervalMs) || (type.fleeStepIntervalMs ?? 0) <= 0)) {
      errors.push(`${label} needs a positive integer fleeStepIntervalMs for timid behavior`);
    }
    const seenLootKeys = new Set<string>();
    if (type.behavior === "ambush" && type.aggroRadiusTiles !== 1) {
      errors.push(`${label} needs aggroRadiusTiles 1 for ambush behavior`);
    }
    for (const [index, entry] of type.loot.entries()) {
      const line = `${label} loot row ${index}`;
      if (seenLootKeys.has(entry.itemKey)) {
        errors.push(`${line} duplicates item "${entry.itemKey}"`);
      }
      seenLootKeys.add(entry.itemKey);
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

    const type = typesForRoom(spawn.room).get(spawn.kind);
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

    if (type?.behavior === "ambush" && spawn.wanderRadiusTiles !== 0) {
      errors.push(`${label} needs wanderRadiusTiles 0 for ambush behavior`);
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
