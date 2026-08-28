const DEFAULT_ROOM_NAME = "plaza";

/**
 * `?room=` is a verification hatch for grand-plaza (docs/decisions.md 2026-08-26), not the
 * Phase2 room routing UX. Unknown names are the matchmaker's to reject: an allow-list here
 * would duplicate ROOM_DEFINITIONS and could disagree with it.
 */
export function resolveRoomName(search: string = window.location.search): string {
  const value = new URLSearchParams(search).get("room")?.trim();
  return value === undefined || value === "" ? DEFAULT_ROOM_NAME : value;
}

/** The room this page booted into, read once at module load. */
const homeRoomName = resolveRoomName();

/**
 * Where the home control returns to: the room this session started in.
 *
 * Captured rather than re-read, and that capture is the point. A portal hop deliberately leaves
 * the URL alone today; if it ever started tracking the current room, re-reading would silently
 * turn "home" into "wherever I am" and the control would stop doing anything.
 */
export function resolveHomeRoomName(): string {
  return homeRoomName;
}
