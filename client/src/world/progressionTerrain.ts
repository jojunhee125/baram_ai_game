import { PROGRESSION_REGIONS, TILE_SIZE_PX } from "@zep-test/shared";

type Rgb = readonly [number, number, number];
interface TerrainPalette {
  floor: string; path: string; wall: string; light: string; dark: string; accent: string;
  minimap: { floor: Rgb; path: Rgb; wall: Rgb };
}

const PALETTES: Readonly<Record<string, TerrainPalette>> = {
  novice: { floor: "#617341", path: "#ae9467", wall: "#344d30", light: "#829852", dark: "#31402c", accent: "#c4b77b", minimap: { floor: [97,115,65], path: [174,148,103], wall: [52,77,48] } },
  rat: { floor: "#79684e", path: "#9b835b", wall: "#4a4034", light: "#9d8b65", dark: "#342e28", accent: "#a5a16c", minimap: { floor: [121,104,78], path: [155,131,91], wall: [74,64,52] } },
  snake: { floor: "#58604b", path: "#958369", wall: "#39453a", light: "#849077", dark: "#29332f", accent: "#afb480", minimap: { floor: [88,96,75], path: [149,131,105], wall: [57,69,58] } },
  bear: { floor: "#786457", path: "#aa906e", wall: "#51483f", light: "#a38e76", dark: "#352f2b", accent: "#c5aa82", minimap: { floor: [120,100,87], path: [170,144,110], wall: [81,72,63] } },
  deer: { floor: "#6b7749", path: "#a6996b", wall: "#465333", light: "#98a46a", dark: "#3b472f", accent: "#d0ba85", minimap: { floor: [107,119,73], path: [166,153,107], wall: [70,83,51] } },
  pig: { floor: "#80704d", path: "#aa956b", wall: "#554936", light: "#a69263", dark: "#3c352b", accent: "#c0ad78", minimap: { floor: [128,112,77], path: [170,149,107], wall: [85,73,54] } },
  fox: { floor: "#74645c", path: "#ac9077", wall: "#50433d", light: "#a08a7b", dark: "#352d2b", accent: "#c2a98a", minimap: { floor: [116,100,92], path: [172,144,119], wall: [80,67,61] } },
};

function themeOf(mapKey: string): string | undefined {
  return PROGRESSION_REGIONS.find(region => region.roomId === mapKey)?.theme;
}

export function hasProgressionTerrain(mapKey: string): boolean {
  return themeOf(mapKey) !== undefined;
}

export function progressionMinimapColor(mapKey: string, blocked: boolean, ground: number | undefined): Rgb | undefined {
  const palette = PALETTES[themeOf(mapKey) ?? ""];
  return palette?.minimap[blocked ? "wall" : ground === 4 || ground === 5 ? "path" : "floor"];
}

export function paintProgressionTile(context: CanvasRenderingContext2D, mapKey: string, tile: number): void {
  const theme = themeOf(mapKey);
  const palette = PALETTES[theme ?? ""];
  if (!palette) throw new Error(`Unknown progression terrain: ${mapKey}`);
  const x = (tile % 8) * TILE_SIZE_PX;
  const y = Math.floor(tile / 8) * TILE_SIZE_PX;
  const blocked = tile >= 8;
  const path = tile === 3 || tile === 4;
  const outdoor = theme === "novice" || theme === "deer";
  const rect = (color: string, dx: number, dy: number, width: number, height: number): void => {
    context.fillStyle = color;
    context.fillRect(x + dx, y + dy, width, height);
  };
  rect(blocked ? palette.wall : path ? palette.path : palette.floor, 0, 0, 32, 32);
  if (blocked && outdoor) {
    rect(palette.dark, 12, 14, 9, 18);
    rect(palette.path, 14, 17, 3, 13);
    for (const [dx, dy, w, h] of [[4, 5, 24, 15], [8, 1, 17, 22], [1, 10, 29, 10]]) rect(palette.wall, dx!, dy!, w!, h!);
    rect(palette.floor, 6, 5, 17, 8);
    rect(palette.light, 10, 2, 10, 4);
    if (theme === "deer") { rect(palette.accent, 5, 12, 3, 2); rect(palette.accent, 21, 7, 3, 2); }
  } else if (blocked) {
    rect(palette.dark, 0, 24, 32, 8);
    rect(palette.floor, 3, 7, 25, 18);
    rect(palette.light, 5, 3, 21, 5);
    rect(palette.wall, 20, 11, 10, 15);
    rect(palette.dark, 6, 17, 16, 2);
    if (theme === "rat") { rect(palette.dark, 10, 21, 12, 10); rect(palette.wall, 12, 19, 8, 3); }
    if (theme === "snake") { rect(palette.accent, 6, 6, 2, 12); rect(palette.accent, 8, 16, 5, 2); }
    if (theme === "bear") { rect(palette.light, 10, 7, 2, 7); rect(palette.light, 14, 9, 2, 6); rect(palette.light, 18, 8, 2, 6); }
    if (theme === "pig") { rect(palette.path, 3, 26, 25, 3); rect(palette.dark, 8, 23, 3, 4); }
    if (theme === "fox") { rect(palette.accent, 7, 10, 3, 2); rect(palette.accent, 11, 12, 2, 3); }
  } else {
    for (let i = 0; i < 10; i++) rect(i % 2 ? palette.light : palette.dark,
      (i * 13 + tile * 7) % 29 + 1, (i * 7 + tile * 3) % 29 + 1, 2, 1);
    if (outdoor && !path) { rect(palette.light, 6, 18, 1, 4); rect(palette.light, 8, 16, 1, 5); }
    if (theme === "snake" && !path) { rect(palette.wall, 8, 12, 14, 4); rect(palette.light, 10, 12, 8, 1); }
    if (theme === "pig" && !path) { rect(palette.dark, 5, 10, 3, 2); rect(palette.dark, 10, 12, 3, 2); }
    if (tile === 3) { rect(palette.dark, 0, 1, 32, 2); rect(palette.accent, 2, 4, 28, 2); }
  }
}
