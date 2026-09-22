import type Phaser from "phaser";
import {
  createLegacyAvatarManifests, Direction, resolveAvatarClip, validateAvatarManifest,
  type AvatarAction, type AvatarClip, type AvatarFrame, type AvatarManifest,
} from "@zep-test/shared";
import { MASTER_AVATAR_MANIFEST } from "./masterAvatar";

export type AvatarCatalog = ReadonlyMap<number, { primary: AvatarManifest; legacy: AvatarManifest }>;
export const AVATAR_REPLACEMENTS: readonly AvatarManifest[] = [MASTER_AVATAR_MANIFEST];

export function createAvatarCatalog(replacements: readonly AvatarManifest[] = AVATAR_REPLACEMENTS): AvatarCatalog {
  const catalog = new Map(createLegacyAvatarManifests().map((legacy) => [legacy.skinId, { primary: legacy, legacy }]));
  for (const primary of replacements) {
    const entry = catalog.get(primary.skinId);
    if (entry) catalog.set(primary.skinId, { primary, legacy: entry.legacy });
  }
  return catalog;
}

export const AVATAR_CATALOG = createAvatarCatalog();

export interface RuntimeAvatarClip {
  manifest: AvatarManifest;
  action: AvatarAction;
  clip: AvatarClip;
  durationMs: number;
  animationKey: string;
}

export interface AvatarAttachmentFrame {
  manifest: AvatarManifest;
  frame: AvatarFrame;
  action: AvatarAction;
  frameIndex: number;
}

export function resolveAvatarPreview(
  skinId: number, catalog: AvatarCatalog = AVATAR_CATALOG,
  textureAvailable: (path: string) => boolean = () => true,
): { manifest: AvatarManifest; frame: AvatarFrame; path: string } | null {
  const entry = catalog.get(skinId);
  if (!entry) return null;
  const visual = resolveAvatarClip(entry.primary, entry.legacy, "idle", Direction.Down, textureAvailable);
  if (!visual) return null;
  const frame = visual.manifest.frames[visual.clip.frames[0]!.frame]!;
  return { manifest: visual.manifest, frame, path: visual.manifest.textures[frame.texture]!.path };
}

const ACTIONS: readonly AvatarAction[] = ["idle", "walk", "attack", "cast", "hit", "death"];
const DIRECTIONS = [Direction.Down, Direction.Left, Direction.Right, Direction.Up] as const;
const textureKey = (path: string): string => `avatar:${path}`;
const clipKey = (skin: number, action: AvatarAction, direction: Direction): string => `${skin}:${action}:${direction}`;

function manifestKey(manifest: AvatarManifest): string {
  let hash = 2166136261;
  for (const character of JSON.stringify(manifest)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `avatar:${manifest.skinId}:${manifest.format}:${hash >>> 0}`;
}

export type AvatarArt = ReturnType<typeof createAvatarArt>;

export function createAvatarArt(scene: Phaser.Scene, catalog: AvatarCatalog = AVATAR_CATALOG) {
  const manifests = [...new Set([...catalog.values()].flatMap(({ primary, legacy }) => [primary, legacy]))]
    .filter((manifest) => validateAvatarManifest(manifest).length === 0);
  const keys = new Map(manifests.map((manifest) => [manifest, manifestKey(manifest)]));
  const paths = new Set(manifests.flatMap((manifest) => Object.values(manifest.textures).map((texture) => texture.path)));
  const clips = new Map<string, RuntimeAvatarClip | null>();
  const spriteVisuals = new WeakMap<Phaser.GameObjects.Sprite, RuntimeAvatarClip>();
  const frameKey = (manifest: AvatarManifest, name: string): string => `${keys.get(manifest)}:${name}`;

  function styleFrame(sprite: Phaser.GameObjects.Sprite, visual: RuntimeAvatarClip): void {
    const entry = visual.clip.frames.find((entry) => frameKey(visual.manifest, entry.frame) === sprite.frame.name);
    if (!entry) return;
    const frame = visual.manifest.frames[entry.frame]!;
    sprite.setDisplaySize(visual.manifest.displaySize.width, visual.manifest.displaySize.height);
    sprite.setOrigin(frame.foot.x / frame.rect.width, frame.foot.y / frame.rect.height);
  }

  return {
    preload(): void {
      for (const path of paths) {
        if (!scene.textures.exists(textureKey(path))) scene.load.image(textureKey(path), path);
      }
    },
    isTextureKey(key: string): boolean {
      return key.startsWith("avatar:") && paths.has(key.slice("avatar:".length));
    },
    prepare(): void {
      clips.clear();
      const unavailable = new Map<AvatarManifest, Set<string>>();
      for (const manifest of manifests) {
        const missing = new Set<string>();
        unavailable.set(manifest, missing);
        for (const texture of Object.values(manifest.textures)) {
          const key = textureKey(texture.path);
          if (!scene.textures.exists(key)) {
            missing.add(texture.path);
            continue;
          }
          const source = scene.textures.get(key).getSourceImage() as HTMLImageElement;
          if (source.width !== texture.width || source.height !== texture.height) missing.add(texture.path);
        }
        for (const [name, frame] of Object.entries(manifest.frames)) {
          const path = manifest.textures[frame.texture]!.path;
          if (missing.has(path)) continue;
          const texture = scene.textures.get(textureKey(path));
          const { x, y, width, height } = frame.rect;
          const nameInTexture = frameKey(manifest, name);
          if (!texture.has(nameInTexture)) texture.add(nameInTexture, 0, x, y, width, height);
        }
      }
      for (const [skin, entry] of catalog) {
        for (const action of ACTIONS) {
          for (const direction of DIRECTIONS) {
            // Resolve each candidate separately because a shared path can declare different dimensions.
            const resolveCandidate = (manifest: AvatarManifest) => resolveAvatarClip(
              manifest, null, action, direction, (path) => unavailable.has(manifest) && !unavailable.get(manifest)!.has(path),
            );
            const resolved = resolveCandidate(entry.primary) ?? resolveCandidate(entry.legacy);
            if (!resolved) {
              clips.set(clipKey(skin, action, direction), null);
              if (action === "idle" || action === "walk") throw new Error(`Avatar ${skin} has no available ${action} clip`);
              continue;
            }
            const { manifest, clip } = resolved;
            const animationKey = `${keys.get(manifest)}:${resolved.action}:${direction}`;
            const visual = { ...resolved, animationKey, durationMs: clip.frames.reduce((sum, entry) => sum + entry.durationMs, 0) };
            clips.set(clipKey(skin, action, direction), visual);
            if (!scene.anims.exists(animationKey)) {
              scene.anims.create({
                key: animationKey,
                frames: clip.frames.map((entry) => {
                  const frame = manifest.frames[entry.frame]!;
                  return { key: textureKey(manifest.textures[frame.texture]!.path), frame: frameKey(manifest, entry.frame), duration: entry.durationMs };
                }),
                duration: visual.durationMs,
                repeat: clip.loop ? -1 : 0,
              });
            }
          }
        }
      }
    },
    resolve(skinId: number, action: AvatarAction, direction: Direction): RuntimeAvatarClip | null {
      return clips.get(clipKey(skinId, action, direction)) ?? null;
    },
    currentFrame(sprite: Phaser.GameObjects.Sprite): AvatarAttachmentFrame | null {
      const visual = spriteVisuals.get(sprite);
      if (!visual) return null;
      const frameIndex = visual.clip.frames.findIndex((entry) => frameKey(visual.manifest, entry.frame) === sprite.frame.name);
      if (frameIndex < 0) return null;
      return { manifest: visual.manifest, frame: visual.manifest.frames[visual.clip.frames[frameIndex]!.frame]!, action: visual.action, frameIndex };
    },
    apply(sprite: Phaser.GameObjects.Sprite, visual: RuntimeAvatarClip, animate: boolean): void {
      if (!spriteVisuals.has(sprite)) {
        sprite.on("animationupdate", () => {
          const current = spriteVisuals.get(sprite);
          if (current) styleFrame(sprite, current);
        });
      }
      spriteVisuals.set(sprite, visual);
      if (animate && sprite.anims.isPlaying && sprite.anims.currentAnim?.key === visual.animationKey) {
        styleFrame(sprite, visual);
        return;
      }
      sprite.stop();
      const first = visual.clip.frames[0]!;
      const frame = visual.manifest.frames[first.frame]!;
      sprite.setTexture(textureKey(visual.manifest.textures[frame.texture]!.path), frameKey(visual.manifest, first.frame));
      if (animate) sprite.play(visual.animationKey);
      styleFrame(sprite, visual);
    },
  };
}
