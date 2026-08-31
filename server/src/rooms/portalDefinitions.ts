import type { PortalDefinition } from "./contracts";

/**
 * The portal graph. Each row is one-way, so a door you can walk back through is two rows —
 * which is what lets the two sides arrive on different tiles. Design and the rejected
 * map-embedded alternative: `docs/design-portal-object.md`.
 *
 * Coordinates are authored here rather than read from the map, so they are also recorded in
 * `assets/README.md` beside each map's spawn tile. Boot refuses to start if a trigger or an
 * arrival is not walkable (`validateRoomMaps`), but nothing can check that a trigger sits on
 * the tile the map art draws a door on — that stays an eyeball check.
 *
 * Trigger tiles deliberately avoid plaza's spawn row: `metaverseRoom.integration.test.ts`
 * walks the whole of row 20 between x=16 and x=47, and a door on that row would fire mid-test.
 */
export const PORTAL_DEFINITIONS: readonly PortalDefinition[] = [
  {
    id: "plaza-south-door",
    from: {
      room: "plaza",
      tiles: [
        { tileX: 31, tileY: 25 },
        { tileX: 32, tileY: 25 },
      ],
    },
    to: { room: "grand-plaza", arrival: { tileX: 22, tileY: 9, spreadRadiusInTiles: 0 } },
  },
  {
    id: "grand-plaza-north-door",
    from: {
      room: "grand-plaza",
      tiles: [
        { tileX: 22, tileY: 8 },
        { tileX: 23, tileY: 8 },
      ],
    },
    to: { room: "plaza", arrival: { tileX: 31, tileY: 24, spreadRadiusInTiles: 0 } },
  },
  {
    id: "plaza-north-door",
    from: {
      room: "plaza",
      tiles: [
        { tileX: 31, tileY: 8 },
        { tileX: 32, tileY: 8 },
      ],
    },
    to: { room: "hunting-ground", arrival: { tileX: 35, tileY: 30, spreadRadiusInTiles: 0 } },
  },
  {
    id: "hunting-ground-south-door",
    from: {
      room: "hunting-ground",
      tiles: [
        { tileX: 35, tileY: 31 },
        { tileX: 36, tileY: 31 },
      ],
    },
    to: { room: "plaza", arrival: { tileX: 31, tileY: 9, spreadRadiusInTiles: 0 } },
  },
];
