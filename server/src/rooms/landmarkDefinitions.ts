import { LANDMARK_DEFINITIONS as LANDMARK_DESCRIPTORS } from "@zep-test/shared";
import type { SpawnArea } from "./contracts";

export interface LandmarkDefinition {
  id: string;
  room: string;
  /**
   * Undefined means "this room's own home tile" — resolved at runtime from the destination
   * room's `this.home` rather than copied here (docs/design-phase-m-landmark-teleport.md §1.1),
   * so a landmark that is a room's home can never drift from what ReturnHome/arriveAtHome already
   * send you to. Present for a landmark that is not a room's home, authored the same way a portal
   * arrival is.
   */
  tile?: SpawnArea;
  /** Same shape as {@link PortalDefinition.requiresItemKey}/{@link PortalDefinition.deniedMessage} — see design §2.4. */
  requiresItemKey?: string;
  deniedMessage?: string;
}

/**
 * Server-only half of each row (`tile`/`requiresItemKey`) — the shared half (`id`/`name`/`room`)
 * lives in `@zep-test/shared`'s `landmarks.ts` since the client needs it too. Boot validation
 * (`validateLandmarkDefinitions`) checks the two stay in step: same id set, same room per id.
 */
export const LANDMARK_DEFINITIONS: readonly LandmarkDefinition[] = [
  {
    id: "landmark-hunting-forest", room: "hunting-forest",
    tile: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 },
    requiresItemKey: "entry-pass",
    deniedMessage: "입장권은 다람쥐를 잡아서 획득하세요",
  },
  { id: "landmark-plaza", room: "plaza" },
  { id: "landmark-grand-plaza", room: "grand-plaza" },
  { id: "landmark-hunting-ground", room: "hunting-ground", tile: { tileX: 35, tileY: 30, spreadRadiusInTiles: 0 } },
  {
    id: "landmark-hunting-den",
    room: "hunting-den",
    tile: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 },
    requiresItemKey: "entry-pass",
    deniedMessage: "입장권은 다람쥐를 잡아서 획득하세요",
  },
];

// Sanity check against LANDMARK_DESCRIPTORS is delegated to validateLandmarkDefinitions rather
// than done here, so a mismatch is a boot-time diagnostic (with every offending row named) rather
// than a thrown error at module load with no room name in it.
export { LANDMARK_DESCRIPTORS };
