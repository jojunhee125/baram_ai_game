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
});

export type InteractableMarker = SchemaType<typeof InteractableMarker>;

/**
 * Room state. `players` is view-tagged: each client receives only the entries
 * added to its own StateView, which is how proximity filtering is enforced.
 * The map key is the Colyseus sessionId.
 */
export const RoomState = schema({
  roomType: "string",
  mapKey: "string",
  players: { map: Player, view: true },
  portalMarkers: { array: PortalMarker },
  interactableMarkers: { array: InteractableMarker },
});

export type RoomState = SchemaType<typeof RoomState>;
