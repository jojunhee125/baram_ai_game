export const TILE_SIZE_PX = 32;

/** Server -> client state patch interval. 100ms = 10Hz, the tick-rate cap from roadmap item 6. */
export const PATCH_RATE_MS = 100;

/**
 * Players outside this radius are not synced to the client at all (Colyseus StateView filtering).
 *
 * Derived from the camera, not picked: on a map whose walkable area is inset far enough that
 * the camera never clamps, the local player sits dead centre, so the furthest tile that can
 * put a pixel on screen is 10 away (Chebyshev). The extra 3 tiles are approach margin — two
 * players walking at each other close ~1.7 tiles per patch, so 3 buys ~180ms to spawn the
 * sprite before it would pop in on screen.
 */
export const VIEW_RADIUS_TILES = 13;

/**
 * Chat delivery radius. Must stay <= VIEW_RADIUS_TILES: a client that receives a chat
 * message but not the sender's state would render a message from an unknown player.
 * 7 is the viewport's vertical half-extent, so anyone audible is at least partly on screen.
 */
export const CHAT_RADIUS_TILES = 7;

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
