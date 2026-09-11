import type Phaser from "phaser";

export const HERITAGE_MONSTER_FRAME_SIZE = 384;
export const HERITAGE_MONSTER_FOOT_Y = 374;

type SourceRect = readonly [x: number, y: number, width: number, height: number];

export interface MonsterAppearance {
  readonly textureKey: string;
  readonly firstFrame: number;
  readonly logicalCellPx: 32 | 384;
  readonly feetY: 32 | 374;
  readonly displayCellPx: 32 | 40 | 52 | 64;
}

export type HeritageMonsterArt = ReadonlyMap<string, MonsterAppearance>;

interface MonsterArt {
  readonly texture: string;
  readonly width: number;
  readonly height: number;
  readonly displaySize: number;
  readonly frames: readonly SourceRect[];
}

export const HERITAGE_MONSTER_ART = {
  squirrel: {
    texture: "heritage-squirrel", width: 1086, height: 1448, displaySize: 40,
    frames: [
      [112, 47, 190, 305], [468, 53, 182, 288], [816, 53, 191, 295],
      [41, 419, 303, 254], [392, 419, 306, 254], [745, 419, 305, 254],
      [48, 750, 295, 251], [397, 747, 296, 255], [748, 747, 296, 259],
      [88, 1079, 185, 298], [456, 1079, 172, 288], [801, 1079, 184, 302],
    ],
  },
  rabbit: {
    texture: "heritage-rabbit", width: 1078, height: 1459, displaySize: 40,
    frames: [
      [127, 86, 153, 260], [465, 86, 147, 247], [798, 86, 152, 260],
      [64, 406, 266, 270], [405, 409, 263, 267], [749, 403, 263, 273],
      [73, 744, 262, 266], [407, 745, 261, 265], [753, 744, 263, 268],
      [131, 1077, 142, 290], [465, 1077, 147, 271], [803, 1078, 140, 289],
    ],
  },
  deer: {
    texture: "heritage-deer", width: 1086, height: 1449, displaySize: 52,
    frames: [
      [133, 40, 142, 290], [471, 40, 143, 287], [809, 40, 143, 290],
      [39, 385, 292, 289], [396, 387, 283, 287], [743, 388, 290, 287],
      [53, 739, 288, 285], [406, 740, 286, 287], [749, 741, 291, 286],
      [143, 1067, 128, 319], [476, 1067, 132, 317], [813, 1067, 129, 319],
    ],
  },
  boss: {
    texture: "heritage-boss", width: 1086, height: 1448, displaySize: 64,
    frames: [
      [120, 12, 212, 335], [436, 12, 211, 335], [753, 12, 208, 335],
      [67, 369, 294, 308], [408, 369, 285, 309], [735, 369, 294, 308],
      [51, 701, 288, 308], [398, 701, 281, 309], [728, 702, 292, 308],
      [114, 1031, 212, 365], [439, 1032, 206, 364], [761, 1034, 211, 362],
    ],
  },
} as const satisfies Record<string, MonsterArt>;

function validSource(texture: Phaser.Textures.Texture, art: MonsterArt): boolean {
  const source = texture.source[0];
  return source?.width === art.width && source.height === art.height &&
    art.frames.length === 12 && art.frames.every(([x, y, w, h]) =>
      [x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0 &&
      x + w <= source.width && y + h <= source.height &&
      w <= HERITAGE_MONSTER_FRAME_SIZE && h <= HERITAGE_MONSTER_FOOT_Y);
}

function validFrame(texture: Phaser.Textures.Texture, index: number, rect: SourceRect): boolean {
  if (!texture.has(String(index))) return false;
  const frame = texture.get(index);
  const [x, y, w, h] = rect;
  return frame.sourceIndex === 0 && frame.cutX === x && frame.cutY === y &&
    frame.cutWidth === w && frame.cutHeight === h && frame.trimmed &&
    frame.realWidth === HERITAGE_MONSTER_FRAME_SIZE &&
    frame.realHeight === HERITAGE_MONSTER_FRAME_SIZE &&
    frame.x === Math.round((HERITAGE_MONSTER_FRAME_SIZE - w) / 2) &&
    frame.y === HERITAGE_MONSTER_FOOT_Y - h && frame.width === w && frame.height === h;
}

export function isHeritageMonsterTexture(key: string): boolean {
  return Object.values(HERITAGE_MONSTER_ART).some(art => art.texture === key);
}

/**
 * 몬스터가 실제로 사는 room인가. `usesClassicTerrain`과 같은 부류의 클라이언트 렌더 게이트다.
 *
 * 레거시 `monster.png`는 모든 room에서 무조건 로드한다 — 몇 킬로바이트라서 "어느 room에 몬스터가
 * 있는가"라는 서버 소유 사실을 클라이언트가 한 벌 더 갖는 비용이 더 컸기 때문이다(`WorldScene.preload`
 * 주석). 이 4종 heritage 시트는 합계 4.32MiB라 그 전제가 뒤집힌다: 몬스터가 0마리인 `grand-plaza`는
 * 500 CCU 성능 기준선 room이고 `plaza`는 전원이 거쳐가는 로비인데, 둘 다 절대 쓰지 않을 4.32MiB를
 * 받고 있었다(2026-09-11 독립 리뷰).
 *
 * 이 목록이 미래에 틀리면(새 room에 몬스터가 생기면) 그 room의 몬스터는 레거시 외형으로 그려진다 —
 * `prepareHeritageMonsterArt`가 텍스처 없는 종류를 건너뛰고 `monsterSprites`가 기존 atlas로 되돌아가므로
 * 빈 스프라이트가 되지는 않는다.
 */
export function roomHasHeritageMonsters(mapKey: string): boolean {
  return mapKey === "hunting-ground" || mapKey === "hunting-den";
}

export function preloadHeritageMonsterArt(scene: Phaser.Scene): void {
  for (const art of Object.values(HERITAGE_MONSTER_ART)) {
    scene.load.image(art.texture, `/sprites/${art.texture}.png`);
  }
}

export function prepareHeritageMonsterArt(scene: Phaser.Scene): HeritageMonsterArt {
  const appearances = new Map<string, MonsterAppearance>();
  for (const [kind, art] of Object.entries(HERITAGE_MONSTER_ART)) {
    if (!scene.textures.exists(art.texture)) continue;
    const texture = scene.textures.get(art.texture);
    if (!validSource(texture, art)) {
      console.warn(`Invalid monster image dimensions: ${art.texture}; using legacy art.`);
      continue;
    }
    try {
      art.frames.forEach((rect, index) => {
        if (validFrame(texture, index, rect)) return;
        if (texture.has(String(index))) texture.remove(String(index));
        const [x, y, w, h] = rect;
        const frame = texture.add(index, 0, x, y, w, h);
        if (!frame) throw new Error(`Cannot register ${art.texture} frame ${index}`);
        frame.setTrim(HERITAGE_MONSTER_FRAME_SIZE, HERITAGE_MONSTER_FRAME_SIZE,
          Math.round((HERITAGE_MONSTER_FRAME_SIZE - w) / 2), HERITAGE_MONSTER_FOOT_Y - h, w, h);
      });
      if (art.frames.every((rect, index) => validFrame(texture, index, rect))) {
        appearances.set(kind, {
          textureKey: art.texture,
          firstFrame: 0,
          logicalCellPx: HERITAGE_MONSTER_FRAME_SIZE,
          feetY: HERITAGE_MONSTER_FOOT_Y,
          displayCellPx: art.displaySize,
        });
      }
    } catch (error) {
      console.warn(`Cannot register monster art: ${art.texture}; using legacy art.`, error);
    }
  }
  return appearances;
}
