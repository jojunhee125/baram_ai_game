/// <reference types="vite/client" />
import { expect, test as base, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import type Phaser from "phaser";
import type { AvatarAction, AvatarClip, AvatarFrame, AvatarManifest } from "../../../shared/src/avatarManifest";
import { waitForCanvasReady } from "../helpers/canvas";

const NATIVE_PATH = "/sprites/test-native-avatar.png";
const COUNTS = { idle: 1, walk: 4, attack: 3, cast: 3, hit: 1, death: 3 } as const;

function syntheticAvatar(): AvatarManifest {
  const frames: Record<string, AvatarFrame> = {};
  const actions = {} as Record<AvatarAction, { directions: Record<0 | 1 | 2 | 3, AvatarClip> }>;
  let index = 0;
  for (const action of Object.keys(COUNTS) as AvatarAction[]) {
    const directions = {} as Record<0 | 1 | 2 | 3, AvatarClip>;
    for (const direction of [0, 1, 2, 3] as const) {
      const poses: { frame: string; durationMs: number }[] = [];
      for (let pose = 0; pose < COUNTS[action]; pose++) {
        const name = `${action}-${direction}-${pose}`;
        frames[name] = {
          texture: "native",
          rect: { x: index % 10 * 48, y: Math.floor(index / 10) * 48, width: 48, height: 48 },
          foot: { x: 20 + pose * 2, y: 44 + pose },
        };
        poses.push({ frame: name, durationMs: action === "walk" ? 62.5 : 80 + pose * 40 });
        index++;
      }
      directions[direction] = { frames: poses, loop: action === "walk" };
    }
    actions[action] = { directions };
  }
  return {
    version: 1, skinId: 2, format: "native60",
    nativeSize: { width: 48, height: 48 }, displaySize: { width: 48, height: 48 },
    textures: { native: { path: NATIVE_PATH, width: 480, height: 288 } },
    frames, actions, layerOrder: ["composite"],
  };
}

function syntheticPng(): Buffer {
  const png = new PNG({ width: 480, height: 288 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const index = Math.floor(y / 48) * 10 + Math.floor(x / 48);
      const offset = (y * png.width + x) * 4;
      png.data[offset] = 40 + index * 3;
      png.data[offset + 1] = 180 - index * 2;
      png.data[offset + 2] = 60 + index;
      png.data[offset + 3] = x % 48 > 3 && x % 48 < 44 && y % 48 > 3 && y % 48 < 44 ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

async function createHarness(page: Page, replacements: AvatarManifest[]) {
  await page.route("**/__avatar-manifest-test", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body style="margin:0"><div id="avatar-test"></div></body></html>',
  }));
  await page.goto("/__avatar-manifest-test");
  return page.evaluateHandle(async replacements => {
    const source = await (await fetch("/src/world/monsterSprites.ts")).text();
    const phaserUrl = source.match(/from\s*["']([^"']*phaser[^"']*)["']/)?.[1];
    if (!phaserUrl) throw new Error("Vite did not resolve Phaser for avatar harness");
    const Phaser = (await import(phaserUrl)).default as typeof import("phaser");
    const api = await import("/src/world/avatarArt.ts");
    const { PlayerSprites } = await import("/src/world/playerSprites.ts");
    const { drawInteractableMarkers } = await import("/src/world/interactableMarkers.ts");
    const catalog = api.createAvatarCatalog(replacements);
    let art!: ReturnType<typeof api.createAvatarArt>;
    let readyResolve!: (scene: Phaser.Scene) => void;
    let readyReject!: (reason: unknown) => void;
    const ready = new Promise<Phaser.Scene>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const loadErrors: string[] = [];
    class AvatarTestScene extends Phaser.Scene {
      constructor() { super("avatar-manifest-test"); }
      preload() {
        art = api.createAvatarArt(this, catalog);
        this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => loadErrors.push(file.key));
        art.preload();
        this.load.spritesheet("reference-avatar", "/sprites/avatar.png", { frameWidth: 32, frameHeight: 32 });
        this.load.spritesheet("reference-heritage", "/sprites/heritage-adventurer.png", { frameWidth: 362, frameHeight: 362 });
      }
      create() {
        try { art.prepare(); readyResolve(this); } catch (error) { readyReject(error); }
      }
    }
    const game = new Phaser.Game({
      type: Phaser.CANVAS, parent: "avatar-test", width: 320, height: 192,
      pixelArt: true, backgroundColor: "#17251f", banner: false, audio: { noAudio: true },
      scene: [AvatarTestScene],
    });
    const timeout = setTimeout(() => readyReject(new Error("Avatar harness did not boot")), 15_000);
    let scene: Phaser.Scene;
    try { scene = await ready; } catch (error) { game.destroy(true); throw error; } finally { clearTimeout(timeout); }
    const players = new PlayerSprites(scene, art);
    const render = () => new Promise<void>(resolve => game.events.once(Phaser.Core.Events.POST_RENDER, resolve));
    const waitFor = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
      const deadline = performance.now() + 5_000;
      const check = () => {
        if (predicate()) return resolve();
        if (performance.now() > deadline) return reject(new Error("Avatar state did not settle"));
        requestAnimationFrame(check);
      };
      check();
    });
    const snapshot = (avatarSkin: number, facing: 0 | 1 | 2 | 3 = 0, tileX = 2, tileY = 2) => ({
      avatarSkin, facing, tileX, tileY, nickname: "avatar-test", level: 1,
    });
    const read = (sprite: Phaser.GameObjects.Sprite) => ({
      texture: sprite.texture.key,
      source: (sprite.texture.getSourceImage() as HTMLImageElement).src,
      rect: [sprite.frame.cutX, sprite.frame.cutY, sprite.frame.cutWidth, sprite.frame.cutHeight],
      width: sprite.displayWidth, height: sprite.displayHeight,
      originX: sprite.originX, originY: sprite.originY,
      x: sprite.x, y: sprite.y, depth: sprite.depth, active: sprite.active,
      playing: sprite.anims.isPlaying,
    });
    return { game, scene, art, api, catalog, players, drawInteractableMarkers, loadErrors, render, waitFor, snapshot, read };
  }, replacements);
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

const test = base.extend<{ harness: Harness; native: boolean; missingNative: boolean }>({
  native: [false, { option: true }],
  missingNative: [false, { option: true }],
  harness: async ({ page, native, missingNative }, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(`**${NATIVE_PATH}`, route => route.fulfill(missingNative
      ? { status: 404, body: "missing test asset" }
      : { contentType: "image/png", body: syntheticPng() }));
    const harness = await createHarness(page, native ? [syntheticAvatar()] : []);
    try { await use(harness); } finally {
      await harness.evaluate(async h => {
        const destroyed = new Promise<void>(resolve => h.game.events.once("destroy", resolve));
        h.game.destroy(true);
        await destroyed;
      });
      await harness.dispose();
    }
    expect(errors).toEqual([]);
  },
});

test("legacy: every skin and direction matches the old atlas pixels and feet", async ({ harness }) => {
  const results = await harness.evaluate(async h => {
    const results = [];
    for (let skin = 0; skin < 24; skin++) {
      for (const facing of [0, 1, 2, 3] as const) {
        const sprite = h.players.add("legacy", h.snapshot(skin, facing));
        sprite.setPosition(64, 112);
        const reference = h.scene.add.sprite(192, 112,
          skin === 0 ? "reference-heritage" : "reference-avatar", (skin === 0 ? 0 : skin * 12) + facing * 3 + 1);
        reference.setDisplaySize(skin === 0 ? 48 : 32, skin === 0 ? 48 : 32).setOrigin(0.5, skin === 0 ? 0.96 : 1);
        await h.render();
        const context = h.game.canvas.getContext("2d")!;
        const actual = context.getImageData(32, 56, 64, 64).data;
        const expected = context.getImageData(160, 56, 64, 64).data;
        let mismatched = 0;
        for (let pixel = 0; pixel < actual.length; pixel++) if (actual[pixel] !== expected[pixel]) mismatched++;
        results.push({ skin, facing, mismatched, ...h.read(sprite) });
        h.players.remove("legacy");
        reference.destroy();
      }
    }
    return { errors: h.loadErrors, results };
  });
  expect(results.errors).toEqual([]);
  expect(results.results).toHaveLength(96);
  for (const state of results.results) {
    expect(state.mismatched, `skin ${state.skin}, direction ${state.facing}`).toBe(0);
    expect(state.width).toBe(state.skin === 0 ? 48 : 32);
    expect(state.height).toBe(state.skin === 0 ? 48 : 32);
    expect(state.originX).toBe(0.5);
    expect(state.originY).toBeCloseTo(state.skin === 0 ? 0.96 : 1);
  }
});

test("legacy: heritage walk and attack preserve corrected side poses and timing", async ({ harness }) => {
  const result = await harness.evaluate(h => {
    const animations = [];
    for (const direction of [0, 1, 2, 3] as const) {
      for (const action of ["walk", "attack"] as const) {
        const visual = h.art.resolve(0, action, direction);
        if (!visual) throw new Error("Legacy clip is missing");
        const sprite = h.scene.add.sprite(64, 112, "reference-heritage", 1);
        h.art.apply(sprite, visual, true);
        const animation = sprite.anims.currentAnim!;
        animations.push({ action, direction,
          frames: animation.frames.map(entry => entry.frame.cutY / 362 * 3 + entry.frame.cutX / 362),
          durations: animation.frames.map(entry => entry.duration || animation.msPerFrame),
          repeat: animation.repeat,
        });
        sprite.destroy();
      }
    }
    return animations;
  });
  const poses = [[0, 1, 2], [3, 4, 8], [6, 7, 5], [9, 10, 11]];
  for (const animation of result) {
    const expected = poses[animation.direction]!;
    expect(animation.frames).toEqual(animation.action === "walk" ? [...expected, animation.direction * 3 + 1] : expected);
    expect(animation.durations).toEqual(animation.frames.map(() => animation.action === "walk" ? 62.5 : 100));
    expect(animation.repeat).toBe(animation.action === "walk" ? -1 : 0);
  }
});

test("legacy: attack, skin swap and removal leave no stale animation or timer", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const original = h.snapshot(0, 1);
    const sprite = h.players.add("player", original);
    const started = h.players.attack("player", 1);
    h.players.update("player", { ...original, avatarSkin: 23, tileX: 3 });
    await h.waitFor(() => h.scene.tweens.getTweens().length === 0);
    await new Promise(resolve => h.scene.time.delayedCall(350, resolve));
    const swapped = h.read(sprite);
    h.players.update("player", original);
    const restarted = h.players.attack("player", 2);
    h.players.remove("player");
    await new Promise(resolve => h.scene.time.delayedCall(350, resolve));
    return { started, restarted, swapped, active: sprite.active, tracked: Boolean(h.players.get("player")),
      tweens: h.scene.tweens.getTweens().length,
      remaining: h.scene.children.list.filter(child => child.type === "Sprite").length };
  });
  expect(result.started).toBe(true);
  expect(result.restarted).toBe(true);
  expect(result.swapped).toMatchObject({ width: 32, height: 32, originX: 0.5, originY: 1, playing: false, x: 112, y: 96 });
  expect(result.swapped.texture).toContain("/sprites/avatar.png");
  expect(result).toMatchObject({ active: false, tracked: false, tweens: 0, remaining: 0 });
});

test.describe("native manifest runtime", () => {
  test.use({ native: true });

  test("all sixty authored frames reach Phaser with independent durations and anchors", async ({ harness }) => {
    const result = await harness.evaluate(h => {
      const results = [];
      for (const action of ["idle", "walk", "attack", "cast", "hit", "death"] as const) {
        for (const direction of [0, 1, 2, 3] as const) {
          const visual = h.art.resolve(2, action, direction);
          if (!visual) throw new Error(`Missing ${action}/${direction}`);
          const sprite = h.scene.add.sprite(64, 112, "reference-avatar", 1);
          h.art.apply(sprite, visual, true);
          const animation = sprite.anims.currentAnim;
          results.push({ action, direction, ...h.read(sprite),
            frames: animation?.frames.map(entry => ({
              rect: [entry.frame.cutX, entry.frame.cutY, entry.frame.cutWidth, entry.frame.cutHeight],
              duration: entry.duration || animation.msPerFrame,
            })) ?? [{ rect: [sprite.frame.cutX, sprite.frame.cutY, sprite.frame.cutWidth, sprite.frame.cutHeight], duration: 80 }],
          });
          sprite.destroy();
        }
      }
      return { errors: h.loadErrors, results };
    });
    expect(result.errors).toEqual([]);
    expect(result.results).toHaveLength(24);
    const manifest = syntheticAvatar();
    for (const animation of result.results) {
      const definition = manifest.actions[animation.action];
      expect("directions" in definition).toBe(true);
      if (!("directions" in definition)) throw new Error("Invalid test fixture");
      const expected = definition.directions[animation.direction];
      expect(animation.texture).toContain(NATIVE_PATH);
      expect(animation.width).toBe(48);
      expect(animation.height).toBe(48);
      expect(animation.originX).toBeCloseTo(20 / 48);
      expect(animation.originY).toBeCloseTo(44 / 48);
      expect(animation.frames).toEqual(expected.frames.map(entry => {
        const { rect } = manifest.frames[entry.frame]!;
        return { rect: [rect.x, rect.y, rect.width, rect.height], duration: entry.durationMs };
      }));
    }
  });

  test("a native attack updates feet on each pose and restores idle on completion", async ({ harness }) => {
    const result = await harness.evaluate(async h => {
      const sprite = h.players.add("native", h.snapshot(2, 2));
      const seen: { rect: number[]; originX: number; originY: number; at: number }[] = [];
      const capture = () => {
        const state = h.read(sprite);
        if (!state.texture.includes("test-native-avatar")) return;
        if (seen.at(-1)?.rect.join() === state.rect.join()) return;
        seen.push({ rect: state.rect, originX: state.originX, originY: state.originY, at: h.scene.time.now });
      };
      const startedAt = h.scene.time.now;
      const started = h.players.attack("native", 2);
      capture();
      await h.waitFor(() => { capture(); return !sprite.anims.isPlaying; });
      await h.render();
      const final = h.read(sprite);
      h.players.remove("native");
      return { started, seen, final, elapsed: h.scene.time.now - startedAt };
    });
    expect(result.started).toBe(true);
    expect(result.elapsed, "Authored 80 + 120 + 160 ms attack must not retain the old 300 ms timeout").toBeGreaterThanOrEqual(340);
    const manifest = syntheticAvatar();
    const attack = manifest.actions.attack;
    if (!("directions" in attack)) throw new Error("Invalid test fixture");
    const expected = attack.directions[2].frames.map(entry => manifest.frames[entry.frame]!);
    for (const frame of expected) {
      const sample = result.seen.find(state => state.rect.join() === [frame.rect.x, frame.rect.y, 48, 48].join());
      expect(sample, `native attack pose ${frame.rect.x},${frame.rect.y} rendered`).toBeDefined();
      expect(sample!.originX).toBeCloseTo(frame.foot.x / 48);
      expect(sample!.originY).toBeCloseTo(frame.foot.y / 48);
    }
    expect(result.final.rect).toEqual([96, 0, 48, 48]);
    expect(result.final.originX).toBeCloseTo(20 / 48);
    expect(result.final.originY).toBeCloseTo(44 / 48);
    expect(result.final.playing).toBe(false);
  });

  test("NPCs share the player's resolved idle appearance for legacy and native skins", async ({ harness }) => {
    const result = await harness.evaluate(h => {
      const states = [];
      for (const skin of [0, 2, 23]) {
        const player = h.players.add("compare", h.snapshot(skin));
        const children = new Set(h.scene.children.list);
        h.drawInteractableMarkers(h.scene, [{ kind: "npc", tileX: 2, tileY: 2, avatarSkin: skin }], h.art);
        const npc = h.scene.children.list.find(child => !children.has(child) && child.type === "Sprite") as Phaser.GameObjects.Sprite;
        if (!npc) throw new Error(`NPC skin ${skin} was not rendered`);
        states.push({ skin, player: h.read(player), npc: h.read(npc) });
        npc.destroy();
        h.players.remove("compare");
      }
      return states;
    });
    for (const { skin, player, npc } of result) expect(npc, `NPC skin ${skin}`).toEqual(player);
  });

  test("preview uses native idle and falls back to the same legacy skin when its image fails", async ({ harness }) => {
    const result = await harness.evaluate(h => {
      const native = h.api.resolveAvatarPreview(2, h.catalog);
      const legacy = h.api.resolveAvatarPreview(2, h.catalog, path => !path.includes("test-native-avatar"));
      const unavailable = h.api.resolveAvatarPreview(2, h.catalog, () => false);
      return {
        native: native && { skin: native.manifest.skinId, format: native.manifest.format, path: native.path, rect: native.frame.rect },
        legacy: legacy && { skin: legacy.manifest.skinId, format: legacy.manifest.format, path: legacy.path, rect: legacy.frame.rect },
        unavailable,
      };
    });
    expect(result.native).toEqual({ skin: 2, format: "native60", path: NATIVE_PATH,
      rect: { x: 0, y: 0, width: 48, height: 48 } });
    expect(result.legacy).toEqual({ skin: 2, format: "legacy12", path: "/sprites/avatar.png",
      rect: { x: 32, y: 256, width: 32, height: 32 } });
    expect(result.unavailable).toBeNull();
  });

  test("an unproduced native attack resolves idle and preserves the generic attack effect path", async ({ harness }) => {
    const primary = syntheticAvatar();
    const partial: AvatarManifest = { ...primary, actions: { ...primary.actions, attack: { fallback: "idle" } } };
    const result = await harness.evaluate(async (h, partial) => {
      const { PlayerSprites } = await import("/src/world/playerSprites.ts");
      const art = h.api.createAvatarArt(h.scene, h.api.createAvatarCatalog([partial]));
      art.prepare();
      const players = new PlayerSprites(h.scene, art);
      const sprite = players.add("partial", h.snapshot(2, 1));
      const attacked = players.attack("partial", 1);
      const state = h.read(sprite);
      const resolved = art.resolve(2, "attack", 1)?.action;
      players.remove("partial");
      return { attacked, resolved, state };
    }, partial);
    expect(result.attacked).toBe(false);
    expect(result.resolved).toBe("idle");
    expect(result.state.texture).toContain(NATIVE_PATH);
    expect(result.state.rect).toEqual([48, 0, 48, 48]);
  });

  test("repeated prepare and rapid replacement do not retain destroyed sprite state", async ({ harness }) => {
    const result = await harness.evaluate(async h => {
      h.art.prepare();
      h.art.prepare();
      const destroyed: Phaser.GameObjects.Sprite[] = [];
      for (let i = 0; i < 40; i++) {
        const sprite = h.players.add("rapid", h.snapshot(2, 0));
        h.players.attack("rapid", 1);
        h.players.update("rapid", h.snapshot(23, 2, 3));
        h.players.remove("rapid");
        destroyed.push(sprite);
      }
      await new Promise(resolve => h.scene.time.delayedCall(500, resolve));
      return { active: destroyed.filter(sprite => sprite.active).length,
        tracked: Boolean(h.players.get("rapid")), tweens: h.scene.tweens.getTweens().length,
        sprites: h.scene.children.list.filter(child => child.type === "Sprite").length };
    });
    expect(result).toEqual({ active: 0, tracked: false, tweens: 0, sprites: 0 });
  });
});

test("picker retains 24 choices, manifest preview geometry and keyboard selection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  const radios = page.locator("#avatar-picker-grid [role=radio]");
  await expect(radios).toHaveCount(24);
  await expect(page.locator("#avatar-picker-grid [aria-busy=true]")).toHaveCount(0);
  const previews = await page.evaluate(async () => {
    const { resolveAvatarPreview } = await import("/src/world/avatarArt.ts");
    return [...document.querySelectorAll<HTMLElement>(".picker__preview")].map((element, skin) => {
      const preview = resolveAvatarPreview(skin)!;
      const texture = preview.manifest.textures[preview.frame.texture]!;
      const scaleX = 64 / preview.frame.rect.width;
      const scaleY = 64 / preview.frame.rect.height;
      return { skin, image: element.style.backgroundImage, size: element.style.backgroundSize.split(" ").map(parseFloat),
        position: element.style.backgroundPosition.split(" ").map(parseFloat),
        expectedImage: preview.path,
        expectedSize: [texture.width * scaleX, texture.height * scaleY],
        expectedPosition: [-preview.frame.rect.x * scaleX, -preview.frame.rect.y * scaleY] };
    });
  });
  expect(previews).toHaveLength(24);
  for (const preview of previews) {
    expect(preview.image, `skin ${preview.skin}`).toContain(preview.expectedImage);
    expect(preview.size).toHaveLength(2);
    expect(preview.position).toHaveLength(2);
    for (const axis of [0, 1]) {
      expect(preview.size[axis]).toBeCloseTo(preview.expectedSize[axis]!);
      expect(preview.position[axis]).toBeCloseTo(preview.expectedPosition[axis]!);
    }
  }
  await radios.nth(2).click();
  await page.keyboard.press("ArrowRight");
  await expect(radios.nth(3)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await waitForCanvasReady(page);
  await expect(page.locator("#avatar-picker")).toBeHidden();
  expect(errors).toEqual([]);
});

test.describe("missing native texture", () => {
  test.use({ native: true, missingNative: true });
  test("keeps the same legacy skin visible and never borrows another skin's attack", async ({ harness }) => {
    const result = await harness.evaluate(h => {
      const sprite = h.players.add("missing", h.snapshot(2, 3));
      const idle = h.read(sprite);
      const attack = h.players.attack("missing", 3);
      h.players.update("missing", h.snapshot(2, 1, 3));
      const walking = h.read(sprite);
      h.players.remove("missing");
      return { errors: h.loadErrors.length, idle, attack, walking };
    });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.idle.texture).toContain("/sprites/avatar.png");
    expect(result.idle.rect).toEqual([32, 352, 32, 32]);
    expect(result.idle).toMatchObject({ width: 32, height: 32, originX: 0.5, originY: 1 });
    expect(result.attack).toBe(false);
    expect(result.walking.texture).toContain("/sprites/avatar.png");
    expect(result.walking.playing).toBe(true);
  });
});
