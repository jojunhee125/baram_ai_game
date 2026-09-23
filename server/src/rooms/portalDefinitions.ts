import type { PortalDefinition } from "./contracts";
import { PROGRESSION_CONNECTIONS } from "@zep-test/shared";

export const PORTAL_DEFINITIONS: readonly PortalDefinition[] = [
  {
    id: "grand-plaza-north-door",
    from: {
      room: "grand-plaza",
      tiles: [
        { tileX: 22, tileY: 8 },
        { tileX: 23, tileY: 8 },
      ],
    },
    to: { room: "plaza", arrival: { tileX: 31, tileY: 10, spreadRadiusInTiles: 0 } },
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
    to: { room: "grand-plaza", arrival: { tileX: 22, tileY: 9, spreadRadiusInTiles: 0 } },
  },
  ...PROGRESSION_CONNECTIONS,
];
