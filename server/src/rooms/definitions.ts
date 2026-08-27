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
];
