import { AVATAR_SKIN_COUNT } from "./constants";
import { Direction } from "./geometry";

export type AvatarAction = "idle" | "walk" | "attack" | "cast" | "hit" | "death";

export interface AvatarSize {
  width: number;
  height: number;
}

export interface AvatarPoint {
  x: number;
  y: number;
}

export interface AvatarFrame {
  texture: string;
  /** Rectangle in texture pixels; anchors below are relative to this rectangle. */
  rect: AvatarPoint & AvatarSize;
  foot: AvatarPoint;
  hands?: { left?: AvatarPoint; right?: AvatarPoint };
}

export interface AvatarClip {
  frames: readonly { frame: string; durationMs: number }[];
  loop: boolean;
}

export type AvatarActionDefinition =
  | { directions: Readonly<Record<Direction, AvatarClip>> }
  | { fallback: AvatarAction };

export interface AvatarManifest {
  version: 1;
  skinId: number;
  format: "legacy12" | "native60";
  /** Authored dimensions when known; legacy high-resolution art uses its source cell size. */
  nativeSize: AvatarSize;
  displaySize: AvatarSize;
  textures: Readonly<Record<string, { path: string; width: number; height: number }>>;
  frames: Readonly<Record<string, AvatarFrame>>;
  actions: Readonly<Record<AvatarAction, AvatarActionDefinition>>;
  layerOrder: readonly string[];
}

const ACTIONS: readonly AvatarAction[] = ["idle", "walk", "attack", "cast", "hit", "death"];
const DIRECTIONS: readonly Direction[] = [Direction.Down, Direction.Left, Direction.Right, Direction.Up];
const WALK_DURATION_MS = 1000 / 16;
const ATTACK_DURATION_MS = 1000 / 10;

export function createLegacyAvatarManifests(): readonly AvatarManifest[] {
  return Array.from({ length: AVATAR_SKIN_COUNT }, (_, skinId): AvatarManifest => {
    const heritage = skinId === 0;
    const cellSize = heritage ? 362 : 32;
    const texture = heritage ? "heritage-adventurer" : "avatar";
    const attackTexture = "classic-adventurer-attack";
    const textures: Record<string, { path: string; width: number; height: number }> = {
      [texture]: {
        path: `/sprites/${texture}.png`,
        width: cellSize * 3,
        height: heritage ? cellSize * 4 : AVATAR_SKIN_COUNT * 4 * cellSize,
      },
    };
    if (heritage) {
      textures[attackTexture] = { path: `/sprites/${attackTexture}.png`, width: 1086, height: 1448 };
    }

    const frames: Record<string, AvatarFrame> = {};
    const firstFrame = heritage ? 0 : skinId * 12;
    for (const textureKey of Object.keys(textures)) {
      for (let offset = 0; offset < 12; offset += 1) {
        const index = firstFrame + offset;
        frames[`${textureKey}:${index}`] = {
          texture: textureKey,
          rect: {
            x: index % 3 * cellSize,
            y: Math.floor(index / 3) * cellSize,
            width: cellSize,
            height: cellSize,
          },
          foot: { x: cellSize / 2, y: heritage ? 347.52 : cellSize },
        };
      }
    }

    const clip = (indices: readonly number[], textureKey: string, durationMs: number, loop: boolean): AvatarClip => ({
      frames: indices.map((index) => ({ frame: `${textureKey}:${index}`, durationMs })),
      loop,
    });
    const directions = (makeClip: (direction: Direction) => AvatarClip): AvatarActionDefinition => ({
      directions: {
        [Direction.Down]: makeClip(Direction.Down),
        [Direction.Left]: makeClip(Direction.Left),
        [Direction.Right]: makeClip(Direction.Right),
        [Direction.Up]: makeClip(Direction.Up),
      },
    });
    const poseIndices = (direction: Direction): readonly number[] => {
      // Only the legacy heritage sheets swap the third poses of the side rows.
      if (heritage && direction === Direction.Left) return [3, 4, 8];
      if (heritage && direction === Direction.Right) return [6, 7, 5];
      const base = firstFrame + direction * 3;
      return [base, base + 1, base + 2];
    };

    return {
      version: 1,
      skinId,
      format: "legacy12",
      nativeSize: { width: heritage ? 362 : 16, height: heritage ? 362 : 16 },
      displaySize: { width: heritage ? 48 : 32, height: heritage ? 48 : 32 },
      textures,
      frames,
      actions: {
        idle: directions((direction) => clip([firstFrame + direction * 3 + 1], texture, WALK_DURATION_MS, false)),
        walk: directions((direction) => clip(
          [...poseIndices(direction), firstFrame + direction * 3 + 1], texture, WALK_DURATION_MS, true,
        )),
        attack: heritage
          ? directions((direction) => clip(poseIndices(direction), attackTexture, ATTACK_DURATION_MS, false))
          : { fallback: "idle" },
        cast: { fallback: "idle" },
        hit: { fallback: "idle" },
        death: { fallback: "idle" },
      },
      layerOrder: ["composite"],
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPixel(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSize(value: unknown): value is AvatarSize {
  return isRecord(value) && isPositive(value.width) && isPositive(value.height);
}

function isPoint(value: unknown, size: AvatarSize): boolean {
  return isRecord(value)
    && typeof value.x === "number" && Number.isFinite(value.x) && value.x >= 0 && value.x <= size.width
    && typeof value.y === "number" && Number.isFinite(value.y) && value.y >= 0 && value.y <= size.height;
}

function isAction(value: unknown): value is AvatarAction {
  return typeof value === "string" && ACTIONS.includes(value as AvatarAction);
}

function isSkinId(value: unknown): value is number {
  return isPixel(value) && value < AVATAR_SKIN_COUNT;
}

export function validateAvatarManifest(manifest: AvatarManifest): readonly string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) return ["manifest must be an object"];
  if (manifest.version !== 1) errors.push("version must be 1");
  if (!isSkinId(manifest.skinId)) errors.push(`skinId must be an integer from 0 to ${AVATAR_SKIN_COUNT - 1}`);
  if (manifest.format !== "legacy12" && manifest.format !== "native60") errors.push("format must be legacy12 or native60");
  if (!isSize(manifest.nativeSize)) errors.push("nativeSize must have positive finite dimensions");
  if (!isSize(manifest.displaySize)) errors.push("displaySize must have positive finite dimensions");
  if (!Array.isArray(manifest.layerOrder) || manifest.layerOrder.length === 0
    || manifest.layerOrder.some((layer) => typeof layer !== "string" || layer.trim().length === 0)
    || new Set(manifest.layerOrder).size !== manifest.layerOrder.length) {
    errors.push("layerOrder must contain unique nonempty layer names");
  }

  const textures = isRecord(manifest.textures) ? manifest.textures : {};
  if (Object.keys(textures).length === 0) errors.push("textures must contain at least one texture");
  for (const [key, texture] of Object.entries(textures)) {
    if (key.trim().length === 0 || !isRecord(texture)
      || typeof texture.path !== "string" || texture.path.trim().length === 0
      || !isPixel(texture.width) || texture.width === 0 || !isPixel(texture.height) || texture.height === 0) {
      errors.push(`texture ${key} must have a path and positive integer dimensions`);
    }
  }

  const frames = isRecord(manifest.frames) ? manifest.frames : {};
  if (Object.keys(frames).length === 0) errors.push("frames must contain at least one frame");
  for (const [key, frame] of Object.entries(frames)) {
    if (key.trim().length === 0 || !isRecord(frame)) {
      errors.push(`frame ${key} must be a named frame object`);
      continue;
    }
    const texture = typeof frame.texture === "string" && Object.hasOwn(textures, frame.texture)
      ? textures[frame.texture] : undefined;
    if (!isRecord(texture)) errors.push(`frame ${key} references an unknown texture`);
    const rect = frame.rect;
    if (!isRecord(rect) || !isPixel(rect.x) || !isPixel(rect.y)
      || !isPixel(rect.width) || rect.width === 0 || !isPixel(rect.height) || rect.height === 0) {
      errors.push(`frame ${key} rect must have nonnegative integer coordinates and positive integer dimensions`);
      continue;
    }
    if (isRecord(texture) && isSize(texture)
      && (rect.x + rect.width > texture.width || rect.y + rect.height > texture.height)) {
      errors.push(`frame ${key} rect exceeds texture bounds`);
    }
    const size = { width: rect.width, height: rect.height };
    if (!isPoint(frame.foot, size)) errors.push(`frame ${key} foot must be within its rect`);
    if (frame.hands !== undefined) {
      if (!isRecord(frame.hands)) errors.push(`frame ${key} hands must be an object`);
      else {
        for (const side of ["left", "right"] as const) {
          if (frame.hands[side] !== undefined && !isPoint(frame.hands[side], size)) {
            errors.push(`frame ${key} ${side} hand must be within its rect`);
          }
        }
      }
    }
  }

  const actions: Record<string, unknown> = isRecord(manifest.actions) ? manifest.actions : {};
  for (const action of ACTIONS) {
    const definition = Object.hasOwn(actions, action) ? actions[action] : undefined;
    if (!isRecord(definition)) {
      errors.push(`action ${action} must have directions or an explicit fallback`);
      continue;
    }
    if (Object.hasOwn(definition, "fallback")) {
      if (!isAction(definition.fallback) || Object.hasOwn(definition, "directions")) {
        errors.push(`action ${action} must have only a valid fallback`);
      }
      continue;
    }
    if (!isRecord(definition.directions)) {
      errors.push(`action ${action} must have all four directions`);
      continue;
    }
    for (const direction of DIRECTIONS) {
      const clip = definition.directions[direction];
      if (!isRecord(clip) || typeof clip.loop !== "boolean" || !Array.isArray(clip.frames) || clip.frames.length === 0) {
        errors.push(`action ${action} direction ${direction} must have a nonempty clip and boolean loop`);
        continue;
      }
      for (const [index, entry] of clip.frames.entries()) {
        if (!isRecord(entry) || typeof entry.frame !== "string" || !Object.hasOwn(frames, entry.frame)) {
          errors.push(`action ${action} direction ${direction} frame ${index} references an unknown frame`);
        }
        if (!isRecord(entry) || !isPositive(entry.durationMs)) {
          errors.push(`action ${action} direction ${direction} frame ${index} durationMs must be positive and finite`);
        }
      }
    }
  }
  for (const action of ACTIONS) {
    const visited = new Set<AvatarAction>();
    let current = action;
    while (true) {
      if (visited.has(current)) {
        errors.push(`action ${action} has a fallback cycle`);
        break;
      }
      visited.add(current);
      const definition = actions[current];
      if (!isRecord(definition) || !isAction(definition.fallback)) break;
      current = definition.fallback;
    }
  }
  return errors;
}

export function resolveAvatarClip(
  primary: AvatarManifest | null | undefined,
  legacy: AvatarManifest | null | undefined,
  action: AvatarAction,
  direction: Direction,
  textureAvailable: (path: string) => boolean = () => true,
): { manifest: AvatarManifest; action: AvatarAction; clip: AvatarClip } | null {
  if (!isAction(action) || !DIRECTIONS.includes(direction)) return null;
  if (primary != null && !isSkinId(primary.skinId)) return null;
  const candidates = [primary];
  if (legacy?.format === "legacy12" && (primary == null || primary.skinId === legacy.skinId)) {
    candidates.push(legacy);
  }
  for (const manifest of candidates) {
    if (manifest == null || validateAvatarManifest(manifest).length > 0) continue;
    const visited = new Set<AvatarAction>();
    let current = action;
    while (!visited.has(current)) {
      visited.add(current);
      const definition = manifest.actions[current];
      if ("fallback" in definition) {
        current = definition.fallback;
        continue;
      }
      const clip = definition.directions[direction];
      const available = clip.frames.every((entry) => {
        const frame = manifest.frames[entry.frame]!;
        return textureAvailable(manifest.textures[frame.texture]!.path);
      });
      if (available) return { manifest, action: current, clip };
      break;
    }
  }
  return null;
}
