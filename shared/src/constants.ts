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
 * Monster decision interval — the first server-side simulation loop in this codebase. Every room
 * before this one was purely message-driven, and a room with no monster rows still is: it never
 * starts the loop at all (`docs/design-hunting-inventory.md` §5.4). That one condition is what
 * keeps grand-plaza's measured PoC #2 cost unchanged.
 *
 * An integer multiple of PATCH_RATE_MS. If the decision and send cadences were coprime, the wait
 * between deciding and sending would drift between 0 and one tick and the movement would not read
 * evenly. 100ms buys nothing (the patch rate is the smallest unit anything is visible in) and
 * 500ms makes chases visibly sluggish and rounds the attack cooldown up to the tick.
 *
 * The tick is a scan, not the cost: each monster holds its own deadlines and only the ones whose
 * deadline has passed do any work. The lever on the real cost is the per-kind step interval.
 */
export const MONSTER_TICK_MS = 200;

/**
 * Minimum interval between two accepted attacks from one client, mirrored by the client as its
 * own input gate. HOME_COOLDOWN_MS's arrangement and its reason: the mirror is UX, this is the
 * guard.
 *
 * It needs a budget of its own for chat's reason rather than movement's — one swing fans a
 * `MonsterHit` unicast out to every viewer within VIEW_RADIUS_TILES of the target, so
 * `maxMessagesPerSecond` (60) bounds the messages coming in but not the ones going out.
 */
export const ATTACK_COOLDOWN_MS = 600;

/**
 * How far a swing reaches, Chebyshev: the eight tiles around the attacker and the one they stand
 * on, since monsters do not block movement and sharing a tile is reachable.
 *
 * Nothing on the client mirrors this — a swing carries no payload and the server picks what it
 * lands on. It is shared anyway so that the numbers defining a fight are read in one place.
 * `MONSTER_ATTACK_RANGE_TILES` is the monster's own reach and stays separate: changing the length
 * of the player's arm is not a change to every monster's.
 */
export const ATTACK_RANGE_TILES = 1;

/**
 * Damage one hit does. Stats, levels and equipment are all out of scope, so the damage formula
 * has exactly one input — and a formula with one input is a constant.
 */
export const PLAYER_ATTACK_DAMAGE = 4;

/**
 * Starting and maximum health. Mirrored by the client, and that mirror is the only way it knows
 * the number before its first `PlayerHit`: health is never in `RoomState`, and joining or
 * changing rooms always restores it in full, so "full on arrival" needs no message.
 */
export const PLAYER_MAX_HP = 100;

/**
 * Quiet time after the last hit before health starts coming back. Without a recovery of some
 * kind, the optimal play from the second fight onwards is to die on purpose or to leave and
 * rejoin — both restore full health for free, and nothing else does.
 *
 * Shared because the client mirrors the whole recovery curve. Recovery sends no message (a
 * per-tick unicast to every hurt player is exactly the traffic this design keeps off the wire),
 * so the client redraws its own bar from this, COMBAT_RECOVERY_HP_PER_TICK, MONSTER_TICK_MS and
 * the time of its last `PlayerHit`. The two can only drift apart while nothing is happening, and
 * the next `PlayerHit` carries the server's number.
 */
export const COMBAT_EXIT_MS = 2000;

/**
 * Health restored per MONSTER_TICK_MS once out of combat — 15 HP/s, so a player left on 1 HP is
 * whole again about 6.6 seconds after the recovery starts. Deliberately fast: what it has to beat
 * is walking out of the door and rejoining, which is free, restores everything at once and takes
 * about as long.
 *
 * Scaled with PLAYER_MAX_HP (Phase A, 2026-09-03) rather than left at 1: an unscaled per-tick
 * amount would still recover in absolute HP terms but would take 3.3x longer in wall-clock time
 * to refill the now-3.3x-bigger bar, which is exactly the "recovery might as well not exist"
 * complaint this phase exists to fix, just moved from COMBAT_EXIT_MS to here.
 *
 * Recovery rides the monster tick, so it runs only in a room that has monsters. That is the only
 * room where health can be lost, and any room change restores it anyway.
 *
 * Superseded server-side by COMBAT_RECOVERY_FRACTION_PER_TICK (Phase W-1, 2026-09-11): a level's
 * `totalMaxHp` (design-phase-w-level-system.md §4.2) varies per session, so `recoverOutOfCombat`
 * now recomputes this fraction against each session's own max instead of adding one shared
 * absolute number. Kept exported and unchanged for the client (`playerVitals.ts`), which still
 * mirrors the old absolute curve until Phase W-2 teaches it about levels — the two constants agree
 * exactly at level 1 (`round(100 * 0.03) === 3`), which is the anchor invariant that makes today's
 * client harmless to leave alone.
 */
export const COMBAT_RECOVERY_HP_PER_TICK = 3;

/**
 * Fraction of `totalMaxHp` restored per MONSTER_TICK_MS once out of combat — the server-side
 * successor to COMBAT_RECOVERY_HP_PER_TICK (Phase W-1, design §4.4). 3/100 = 0.03 is not a new
 * number: it is the ratio COMBAT_RECOVERY_HP_PER_TICK already had against PLAYER_MAX_HP, made
 * explicit so it scales with a leveled-up session's larger `totalMaxHp` instead of leaving
 * absolute recovery time worse the higher a player's level climbs.
 */
export const COMBAT_RECOVERY_FRACTION_PER_TICK = 0.03;

/**
 * Fraction of a class's `totalMaxMp` restored per MONSTER_TICK_MS once out of combat (roadmap
 * R05-a, design `docs/r05-classes-and-skills.md` D2, `docs/decisions.md` 2026-09-18 열린 질문 3).
 * MP has no absolute-per-tick predecessor to match the way COMBAT_RECOVERY_FRACTION_PER_TICK
 * matches PLAYER_MAX_HP's old constant — resources start life as a fraction, since there is no
 * legacy client curve to stay anchored to. Rides the same `recoverOutOfCombat` tick as HP; no
 * separate timer.
 */
export const MP_RECOVERY_FRACTION_PER_TICK = 0.02;

/**
 * Fraction of `totalMaxMp` restored per MONSTER_TICK_MS **while in combat** — deliberately
 * smaller than {@link MP_RECOVERY_FRACTION_PER_TICK} rather than zero (decisions.md 2026-09-18):
 * a MP-based class (주술사) that hits zero mid-fight would otherwise have nothing left to do
 * until it disengages, and disengaging is not always the attacker's choice. A small trickle keeps
 * a cooldown-gated skill meaningful without making the cooldown itself pointless.
 */
export const MP_COMBAT_RECOVERY_FRACTION_PER_TICK = 0.005;

/**
 * Number of selectable avatar variants. Must equal the skin block count baked into
 * `assets/sprites/avatar.png` — the sheet is `row = skin * 4 + direction`, so its height
 * is `AVATAR_SKIN_COUNT * 4 * TILE_SIZE_PX`. Raising this without regenerating the sheet
 * makes the server hand out skins whose rows do not exist and Phaser renders blank frames.
 */
export const AVATAR_SKIN_COUNT = 24;
