export const TILE_SIZE_PX = 32;

/** Server -> client state patch interval. 100ms = 10Hz, the tick-rate cap from roadmap item 6. */
export const PATCH_RATE_MS = 100;

/** Players outside this radius are not synced to the client at all (Colyseus StateView filtering). */
export const VIEW_RADIUS_TILES = 15;

/**
 * Chat delivery radius. Must stay <= VIEW_RADIUS_TILES: a client that receives a chat
 * message but not the sender's state would render a message from an unknown player.
 */
export const CHAT_RADIUS_TILES = 8;

/** Message is rejected if longer. Counted in UTF-16 code units. */
export const MAX_CHAT_LENGTH = 200;

/** Nickname is truncated if longer. Counted in code points — not code units, not graphemes. */
export const MAX_NICKNAME_LENGTH = 16;

/** Server-side per-client rate limits, enforced in the room handler. */
export const MAX_MOVES_PER_SECOND = 20;
export const MAX_CHATS_PER_SECOND = 2;

/**
 * Number of selectable avatar variants. Must equal the skin block count baked into
 * `assets/sprites/avatar.png` — the sheet is `row = skin * 4 + direction`, so its height
 * is `AVATAR_SKIN_COUNT * 4 * TILE_SIZE_PX`. Raising this without regenerating the sheet
 * makes the server hand out skins whose rows do not exist and Phaser renders blank frames.
 */
export const AVATAR_SKIN_COUNT = 4;
