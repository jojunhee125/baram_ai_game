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
