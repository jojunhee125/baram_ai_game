export const TILE_SIZE_PX = 32;

/** Server -> client state patch interval. 100ms = 10Hz, the tick-rate cap from roadmap item 6. */
export const PATCH_RATE_MS = 100;

/**
 * Approach margin added on top of the furthest visible tile. Two players walking at each other
 * close ~1.7 tiles per patch (PATCH_RATE_MS at the client's send cadence), so 3 tiles buys
 * ~180ms to spawn the sprite before it would pop in on screen, and absorbs the name tag that
 * overhangs the sprite by a tile.
 */
export const VIEW_RADIUS_MARGIN_TILES = 3;

/**
 * Players outside this radius are not synced to the client at all (Colyseus StateView filtering).
 *
 * Derived from the camera, not picked:
 * `maxVisibleTileDistance(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES) + VIEW_RADIUS_MARGIN_TILES`
 * = 16 + 3. Kept a literal rather than computed so that widening the viewport fails a test
 * instead of silently changing every proximity query's cost - the value gates a load test
 * (`docs/poc2-design.md` §6, `tools/loadtest-poc2.mjs`), not just what you can see.
 */
export const VIEW_RADIUS_TILES = 19;

/**
 * Chat delivery radius. Must stay <= VIEW_RADIUS_TILES: a client that receives a chat
 * message but not the sender's state would render a message from an unknown player.
 *
 * Equals the viewport's *upward* visible extent (`cameraBorderTiles(...).top`), which is the
 * smallest of the four directions, so anyone audible is at least partly on screen whichever way
 * they stand. Not `floor(height / 2)`: on an even-height viewport that is one row past the top
 * edge of the screen.
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
 * Minimum interval between two accepted "return home" requests from one client.
 *
 * Load-bearing, not cosmetic. A home warp is the only non-adjacent position change the room
 * performs, and `refreshViewsAround` answers it with one proximity query of radius
 * `VIEW_RADIUS_TILES + step`; across grand-plaza that spans the whole grid, so a warp costs
 * O(room population) where a step costs O(neighbours). Without this the only limit is Colyseus'
 * 60 messages/second, i.e. 500 clients x 60 x 500 = 15M operations/second — several times the
 * entire movement load. At 2s the worst case is 250 warps/s x 500 = 125k, a third of it.
 *
 * Shared rather than server-only because the client mirrors it as the button's disabled window.
 * That mirror is UX; this is the guard. Raise it if the `encodeView` backlog gets worse.
 */
export const HOME_COOLDOWN_MS = 2000;

/**
 * Number of selectable avatar variants. Must equal the skin block count baked into
 * `assets/sprites/avatar.png` — the sheet is `row = skin * 4 + direction`, so its height
 * is `AVATAR_SKIN_COUNT * 4 * TILE_SIZE_PX`. Raising this without regenerating the sheet
 * makes the server hand out skins whose rows do not exist and Phaser renders blank frames.
 */
export const AVATAR_SKIN_COUNT = 24;
