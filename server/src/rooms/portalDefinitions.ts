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
 * walks the whole of row 11 between x=1 and x=18, and a door on that row would fire mid-test.
 */
export const PORTAL_DEFINITIONS: readonly PortalDefinition[] = [
  {
    id: "plaza-south-door",
    from: {
      room: "plaza",
      tiles: [
        { tileX: 15, tileY: 13 },
        { tileX: 16, tileY: 13 },
      ],
    },
    to: { room: "grand-plaza", arrival: { tileX: 16, tileY: 8, spreadRadiusInTiles: 0 } },
  },
  {
    id: "grand-plaza-north-door",
    from: {
      room: "grand-plaza",
      tiles: [
        { tileX: 16, tileY: 7 },
        { tileX: 17, tileY: 7 },
      ],
    },
    to: { room: "plaza", arrival: { tileX: 15, tileY: 12, spreadRadiusInTiles: 0 } },
  },
];
