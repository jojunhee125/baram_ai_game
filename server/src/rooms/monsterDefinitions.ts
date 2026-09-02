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
  Slime: "slime",
  Bat: "bat",
} as const;

export type MonsterKind = (typeof MonsterKind)[keyof typeof MonsterKind];

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
}

/**
 * Per-kind rules. Every duration is an integer multiple of MONSTER_TICK_MS (200) — otherwise a
 * deadline rounds up to the next tick and this table quietly stops describing what happens.
 *
 * Derived from constants that are already fixed, not picked:
 *  - player damage 4 every 600ms -> 6.67 DPS, player HP 30
 *  - a walking player covers a tile per STEP_TWEEN_MS (120ms) = 8.3 tiles/s
 *  - the viewport shows 8 tiles above the player, so aggro must stay <= 8 or monsters charge in
 *    from off screen
 *
 * The result: one monster can never kill a player (18s and 8s to do 30 damage, against a 5s
 * out-of-combat recovery), three at once can. That is the difficulty a starter field wants.
 */
export const MONSTER_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Slime,
    {
      kind: MonsterKind.Slime,
      /** Exactly three hits (4x3). The beginner monster has to be countable. */
      maxHp: 12,
      damage: 2,
      attackCooldownMs: 1200,
      wanderStepIntervalMs: 1600,
      /** 1.67 tiles/s, a fifth of a walking player: you can always stroll away from a slime. */
      chaseStepIntervalMs: 600,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 8,
      respawnDelayMs: 8000,
      loot: [
        { itemKey: "slime-jelly", chance: 0.6, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.25, quantity: 1 },
        { itemKey: "herb", chance: 0.08, quantity: 1 },
      ],
    },
  ],
  [
    MonsterKind.Bat,
    {
      kind: MonsterKind.Bat,
      /** Five hits — unmistakably a different fight from the slime's three. */
      maxHp: 20,
      damage: 3,
      attackCooldownMs: 800,
      wanderStepIntervalMs: 1200,
      /** 2.5 tiles/s. Still a third of a player's pace, so fleeing always works. */
      chaseStepIntervalMs: 400,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 10,
      respawnDelayMs: 12000,
      loot: [
        { itemKey: "bat-wing", chance: 0.55, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.35, quantity: 1 },
        { itemKey: "herb", chance: 0.12, quantity: 1 },
        { itemKey: "old-dagger", chance: 0.03, quantity: 1 },
      ],
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
}

/**
 * hunting-ground's monster placement. 20 rows = 20 monsters, and that is the whole population.
 *
 * Nothing spawns at y >= 25. Someone coming through the south door must not arrive into a fight
 * already in progress, and with the wander radii added no monster's resting range reaches y = 26.
 * That is a property of this table rather than of a boot check, so keep it when adding rows.
 * A monster dragged down to the door by a player is inside its leash and is working as intended.
 *
 * Difficulty runs south to north: slimes at the y23-24 entrance band, bats at the y10 far edge.
 * Coordinates were checked against `assets/maps/hunting-ground.json` (walkable, inside the
 * interior, clear of the portal tiles, and at least 6 tiles from the arrival and player spawn).
 */
export const MONSTER_SPAWN_DEFINITIONS: readonly MonsterSpawnDefinition[] = [
  // -- Southern band, nearest the entrance; all slimes --
  { id: "hg-slime-01", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 19, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-02", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 24, tileY: 23 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-03", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 29, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-04", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 41, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-05", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 46, tileY: 23 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-06", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 51, tileY: 24 }, wanderRadiusTiles: 2 },
  // -- Middle band --
  { id: "hg-slime-07", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 18, tileY: 19 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-08", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 23, tileY: 20 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-09", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 28, tileY: 18 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-10", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 33, tileY: 20 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-11", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 44, tileY: 19 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-12", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 49, tileY: 20 }, wanderRadiusTiles: 2 },
  // -- Northern band, the bat ground; the two slimes at either end are the transition --
  { id: "hg-slime-13", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 21, tileY: 14 }, wanderRadiusTiles: 2 },
  { id: "hg-slime-14", room: "hunting-ground", kind: MonsterKind.Slime, at: { tileX: 52, tileY: 14 }, wanderRadiusTiles: 2 },
  { id: "hg-bat-01", room: "hunting-ground", kind: MonsterKind.Bat, at: { tileX: 26, tileY: 14 }, wanderRadiusTiles: 3 },
  { id: "hg-bat-02", room: "hunting-ground", kind: MonsterKind.Bat, at: { tileX: 38, tileY: 13 }, wanderRadiusTiles: 3 },
  { id: "hg-bat-03", room: "hunting-ground", kind: MonsterKind.Bat, at: { tileX: 45, tileY: 15 }, wanderRadiusTiles: 3 },
  // y = 10 rather than y = 9: a radius-3 wander box has 36 of 49 tiles walkable there against 29
  // one row up, so these three scrape the boundary band far less.
  { id: "hg-bat-04", room: "hunting-ground", kind: MonsterKind.Bat, at: { tileX: 22, tileY: 10 }, wanderRadiusTiles: 3 },
  { id: "hg-bat-05", room: "hunting-ground", kind: MonsterKind.Bat, at: { tileX: 35, tileY: 10 }, wanderRadiusTiles: 3 },
  { id: "hg-bat-06", room: "hunting-ground", kind: MonsterKind.Bat, at: { tileX: 49, tileY: 10 }, wanderRadiusTiles: 3 },
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

  const itemKeys = new Set(items.map((item) => item.key));
  for (const [kind, type] of types) {
    const label = `monster type "${kind}"`;
    if (type.kind !== kind) {
      // The map key is what a spawn row names and `type.kind` is what the wire carries, so a
      // mismatch renders one monster as another without anything else noticing.
      errors.push(`${label} is filed under a key that does not match its own kind "${type.kind}"`);
    }
    for (const [index, entry] of type.loot.entries()) {
      const line = `${label} loot row ${index}`;
      if (!itemKeys.has(entry.itemKey)) {
        errors.push(`${line} drops "${entry.itemKey}", which is not in the item catalogue`);
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

    if (!types.has(spawn.kind)) {
      errors.push(`${label} is of kind "${spawn.kind}", which has no entry in MONSTER_TYPES`);
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
