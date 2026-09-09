import type { RoomDefinition } from "./contracts";

/**
 * Registration table for `gameServer.define()`. Adding a room type is a row here,
 * not a code change (Phase1 design decision #5).
 */
export const ROOM_DEFINITIONS: readonly RoomDefinition[] = [
  {
    name: "plaza",
    roomType: "plaza",
    mapKey: "plaza",
    /** Phase1 local-test default, not a capacity target. */
    maxClients: 50,
    /** Stays 0: the integration tests assert this exact tile, and 50 clients overlapping is cosmetic. */
    spawn: { tileX: 31, tileY: 20, spreadRadiusInTiles: 0 },
  },
  {
    name: "grand-plaza",
    roomType: "grand-plaza",
    mapKey: "grand-plaza",
    maxClients: 500,
    /** Centre of the central plaza; radius 70 covers the whole walkable interior. */
    spawn: { tileX: 86, tileY: 73, spreadRadiusInTiles: 70 },
  },
  {
    name: "hunting-ground",
    roomType: "hunting-ground",
    mapKey: "hunting-ground",
    /**
     * Raised from 40 to grand-plaza's own value (design-phase-i-boss-monster.md §1.2): a boss's
     * defeat time is scoped to a spawn row and read back per *room instance*, so two instances of
     * this room would let it be killed twice for two payouts. `maxClients` at 40 let Colyseus's
     * matchmaker open a second instance the moment this room filled up; raised here, it never
     * will. `realCapacity` below still enforces the real 40-person gameplay cap that PoC #3's load
     * budget (`docs/design-hunting-inventory.md` §4.2) was measured against — nothing about how
     * many people can be in this room at once has changed, only who enforces it.
     */
    maxClients: 500,
    /** The actual gameplay cap, enforced by `onJoin` now that `maxClients` no longer is. */
    realCapacity: 40,
    /**
     * Two tiles further north than the door itself: at tileY 29 with radius 2 this square's
     * southern edge (y 31) landed exactly on the south door's own trigger row (`hunting-ground-south-door`,
     * `portalDefinitions.ts`), so ~20% of joins spawned a player standing on the door's row and a
     * single sideways step could walk them straight onto the trigger tile and fire it unasked
     * (tester-reproduced, Phase E review). y 27 keeps a full clear row (y 30) between the spread's
     * max (29) and the trigger (31). Confirmed against `assets/maps/hunting-ground.json`: x 33-37 /
     * y 25-29 is open ground (no collides tiles) and clear of every monster's spawn-plus-wander box.
     */
    spawn: { tileX: 35, tileY: 27, spreadRadiusInTiles: 2 },
  },
  {
    name: "hunting-den",
    roomType: "hunting-den",
    mapKey: "hunting-den",
    /**
     * Raised from 20, for `hunting-ground`'s own reason (design-phase-i-boss-monster.md §1.2):
     * `maxClients` no longer bounds this room, `realCapacity` below does.
     */
    maxClients: 500,
    /**
     * The actual gameplay cap — sized narratively rather than off a load measurement, since this
     * room is one layer deeper than hunting-ground and reached only by walking through it, so
     * fewer hunters are expected here at once (`docs/design-phase-e-second-hunting-ground.md` §5).
     */
    realCapacity: 20,
    /**
     * Mirrored hunting-ground's own spawn placement closely enough to copy its bug: at tileY 25
     * with radius 2 this square's southern edge (y 27) landed exactly on `hunting-den-south-door`'s
     * trigger row (`portalDefinitions.ts`), the same ~20%-of-joins/one-step-fires-the-door failure
     * mode (tester-reproduced, Phase E review). tileY 24 keeps a clear row (y 26) between the
     * spread's max (25) and the trigger (27); the radius also drops from 2 to 1 because a radius-2
     * square here (x 29-33) clips hd-rabbit-04's wander box (`monsterDefinitions.ts`, spawn (26,20)
     * radius 3 -> x 23-29/y 17-23) at its x=29 edge, and hd-deer-04's at its x=32/y=21 corner.
     * Confirmed against `assets/maps/hunting-den.json`: x 30-32 / y 23-25 is open ground and clear
     * of every monster's spawn-plus-wander box.
     */
    spawn: { tileX: 31, tileY: 24, spreadRadiusInTiles: 1 },
  },
];
