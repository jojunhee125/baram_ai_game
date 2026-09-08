/**
 * One admin-designated fast-travel destination (roadmap Phase M) — the id, its display name and
 * which room it warps into. Where in that room is a server-only detail
 * (`server/src/rooms/landmarkDefinitions.ts`) the client never needs: the same "client never
 * asserts coordinates" rule as everywhere else, pushed one step further — here the client does
 * not even receive them.
 *
 * Lives in `shared`, unlike PORTAL_DEFINITIONS/INTERACTABLE_DEFINITIONS which are server-only:
 * those two are room-scoped content the client only ever learns about one tile at a time, but the
 * landmark panel shows all four, in every room, before the player has stood on anything — so the
 * names have to already be in the bundle.
 *
 * Fixed at exactly these four rows for Phase M (`docs/design-phase-m-landmark-teleport.md` §1).
 * Boot validation (`validateLandmarkDefinitions`) checks the server-side table agrees on id/room.
 */
export interface LandmarkDescriptor {
  id: string;
  /** Shown in the landmark panel, exactly as written. */
  name: string;
  /** Matchmaking room name this landmark warps into — a RoomDefinition name. */
  room: string;
}

export const LANDMARK_DEFINITIONS: readonly LandmarkDescriptor[] = [
  { id: "landmark-plaza", name: "마을 광장", room: "plaza" },
  { id: "landmark-grand-plaza", name: "분수 광장", room: "grand-plaza" },
  { id: "landmark-hunting-ground", name: "사냥터 입구", room: "hunting-ground" },
  { id: "landmark-hunting-den", name: "사냥굴 입구", room: "hunting-den" },
];
