import {
  Direction, type AvatarActionDefinition, type AvatarClip, type AvatarFrame, type AvatarManifest,
} from "@zep-test/shared";

const CELL_SIZE = 48;
const COLUMN_COUNT = 4;
const FRAME_DURATION_MS = 1000 / 16;
const DIRECTIONS = [Direction.Down, Direction.Left, Direction.Right, Direction.Up] as const;
const TEXTURE = "master-adventurer";

const frames: Record<string, AvatarFrame> = {};
for (const [row, direction] of DIRECTIONS.entries()) {
  for (let column = 0; column < COLUMN_COUNT; column += 1) {
    frames[`${direction}:${column}`] = {
      texture: TEXTURE,
      rect: { x: column * CELL_SIZE, y: row * CELL_SIZE, width: CELL_SIZE, height: CELL_SIZE },
      foot: { x: 24, y: 46 },
    };
  }
}

function action(columns: readonly number[], loop: boolean): AvatarActionDefinition {
  const clip = (direction: Direction): AvatarClip => ({
    frames: columns.map((column) => ({ frame: `${direction}:${column}`, durationMs: FRAME_DURATION_MS })),
    loop,
  });
  return {
    directions: {
      [Direction.Down]: clip(Direction.Down),
      [Direction.Left]: clip(Direction.Left),
      [Direction.Right]: clip(Direction.Right),
      [Direction.Up]: clip(Direction.Up),
    },
  };
}

export const MASTER_AVATAR_MANIFEST: AvatarManifest = {
  version: 1,
  skinId: 0,
  format: "native60",
  nativeSize: { width: CELL_SIZE, height: CELL_SIZE },
  displaySize: { width: CELL_SIZE, height: CELL_SIZE },
  textures: {
    [TEXTURE]: {
      path: `/sprites/${TEXTURE}.png`,
      width: CELL_SIZE * COLUMN_COUNT,
      height: CELL_SIZE * DIRECTIONS.length,
    },
  },
  frames,
  actions: {
    idle: action([0], false),
    walk: action([1, 2, 3, 2], true),
    attack: { fallback: "idle" },
    cast: { fallback: "idle" },
    hit: { fallback: "idle" },
    death: { fallback: "idle" },
  },
  layerOrder: ["composite"],
};
