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
 * Room state. `players` is view-tagged: each client receives only the entries
 * added to its own StateView, which is how proximity filtering is enforced.
 * The map key is the Colyseus sessionId.
 */
export const RoomState = schema({
  roomType: "string",
  mapKey: "string",
  players: { map: Player, view: true },
});

export type RoomState = SchemaType<typeof RoomState>;
