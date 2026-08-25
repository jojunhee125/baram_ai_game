export const Direction = {
  Down: 0,
  Left: 1,
  Right: 2,
  Up: 3,
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/** A position in tile units. Pixel coordinates never cross the wire. */
export interface TilePosition {
  tileX: number;
  tileY: number;
}
