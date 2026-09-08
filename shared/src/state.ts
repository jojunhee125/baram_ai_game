import { schema, type SchemaType } from "@colyseus/schema";

/**
 * Per-player synced state. Position is in tile units and is written only by the
 * server; the client tweens between successive tiles for rendering.
 */
export const Player = schema({
  nickname: "string",
  tileX: "uint16",
  tileY: "uint16",
  /** Direction enum value. */
  facing: "uint8",
  avatarSkin: "uint8",
});

export type Player = SchemaType<typeof Player>;

/**
 * A portal trigger tile's position, for rendering an in-world marker only — the client never
 * learns a portal's id or destination room this way (see `PortalEntered`/`JoinOptions.viaPortal`
 * for that). Static for the room's lifetime, so it needs no view tagging: every client sees
 * every marker in the room it is in.
 */
export const PortalMarker = schema({
  tileX: "uint16",
  tileY: "uint16",
});

export type PortalMarker = SchemaType<typeof PortalMarker>;

/**
 * A fixed object's tile, for drawing an in-world marker. Unlike {@link PortalMarker} it carries
 * `kind`, so the marker can say which of the three object types it is before you step on it —
 * the maps are machine-generated and have no object art to read that from.
 *
 * The object's content never arrives this way, only its position: content comes with
 * `InteractableEntered`, on the step that enters the tile. Static for the room's lifetime, so
 * like the portal markers it needs no view tagging.
 */
export const InteractableMarker = schema({
  tileX: "uint16",
  tileY: "uint16",
  /** An `InteractableKind` value. A string rather than a code — see that enum for why. */
  kind: "string",
  /**
   * Meaningful only when `kind === "npc"`; every other kind leaves this unset (`undefined` —
   * `@colyseus/schema` does not zero-initialise unassigned primitives) and the marker renderer
   * never reads it for them, {@link Monster.kind}'s reasoning for a field that costs nothing
   * worth optimising per entry.
   */
  avatarSkin: "uint8",
});

export type InteractableMarker = SchemaType<typeof InteractableMarker>;

/**
 * One living monster. It goes into the same view-tagged map machinery as {@link Player} but
 * carries **no HP**.
 *
 * HP in the state would patch every view within the view radius on every single hit. This
 * project has already made the same call twice — quiz content and chat are messages, not state
 * — so damage travels as a `MonsterHit` message and the client renders the bar locally.
 *
 * `kind` is a string for {@link InteractableMarker.kind}'s reason: the same value is the
 * discriminant of the server's type table, of the wire, and of the client's sprite selector.
 * There are tens of monsters and the field is written once at spawn, so the per-entry string
 * costs nothing worth optimising — revisit that the day monsters appear in grand-plaza.
 */
export const Monster = schema({
  kind: "string",
  tileX: "uint16",
  tileY: "uint16",
  /** Direction enum value, same convention as {@link Player.facing}. */
  facing: "uint8",
});

export type Monster = SchemaType<typeof Monster>;

/**
 * Room state. `players` is view-tagged: each client receives only the entries
 * added to its own StateView, which is how proximity filtering is enforced.
 * The map key is the Colyseus sessionId.
 */
export const RoomState = schema({
  roomType: "string",
  mapKey: "string",
  players: { map: Player, view: true },
  /**
   * Living monsters only, keyed by spawn point id. A death deletes the entry and a respawn puts
   * it back under the same key, so monsters travel the *same* view bookkeeping path as a player
   * join/leave rather than inventing a second set of rules. The death animation is driven by the
   * `MonsterHit` that reports `hpRemaining: 0`, not by this deletion.
   */
  monsters: { map: Monster, view: true },
  portalMarkers: { array: PortalMarker },
  interactableMarkers: { array: InteractableMarker },
});

export type RoomState = SchemaType<typeof RoomState>;
