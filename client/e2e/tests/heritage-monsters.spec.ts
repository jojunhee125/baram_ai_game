/// <reference types="vite/client" />
import { expect, test as base, type Page } from "@playwright/test";
import type Phaser from "phaser";
import { joinRoom } from "../helpers/flows";

const KINDS = ["squirrel", "rabbit", "deer", "boss"] as const;
const TEXTURES = KINDS.map(kind => `heritage-${kind}`);
const DISPLAY = [40, 40, 52, 64];
const DIRECTIONS = ["DOWN", "LEFT", "RIGHT", "UP"];

interface MonsterAppearance {
  textureKey: string;
  firstFrame: number;
  logicalCellPx: 32 | 384;
  feetY: 32 | 374;
  displayCellPx: 32 | 40 | 52 | 64;
}

interface HeritageApi {
  preloadHeritageMonsterArt(scene: Phaser.Scene): void;
  prepareHeritageMonsterArt(scene: Phaser.Scene): ReadonlyMap<string, MonsterAppearance>;
  isHeritageMonsterTexture(key: string): boolean;
}

async function createHarness(page: Page) {
  await page.route("**/__heritage-monster-test", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body style="margin:0;background:#17251f"><div id="monster-test"></div></body></html>',
  }));
  await page.goto("/__heritage-monster-test");
  return page.evaluateHandle(async () => {
    // Resolve Phaser through Vite's transformed import: evaluate() has no browser import map.
    const sourceResponse = await fetch("/src/world/monsterSprites.ts");
    if (!sourceResponse.ok) throw new Error(`monsterSprites import: ${sourceResponse.status}`);
    const source = await sourceResponse.text();
    const phaserUrl = source.match(/from\s*["']([^"']*phaser[^"']*)["']/)?.[1];
    if (!phaserUrl) throw new Error("Vite did not resolve Phaser in monsterSprites.ts");
    const Phaser = (await import(phaserUrl)).default as typeof import("phaser");
    const artPath = "/src/world/heritageMonsterArt.ts";
    const art = await import(artPath) as HeritageApi;
    const monsters = await import("/src/world/monsterSprites.ts");
    const { NameTags } = await import("/src/world/nameTags.ts");
    const { MonsterHealthBars } = await import("/src/world/monsterHealthBars.ts");
    const loadErrors: string[] = [];
    const loadedUrls = new Set<string>();
    let resolveReady!: (scene: Phaser.Scene) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<Phaser.Scene>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let appearances: ReadonlyMap<string, MonsterAppearance>;
    class MonsterTestScene extends Phaser.Scene {
      constructor() { super("heritage-monster-test"); }
      preload(): void {
        this.load.on(Phaser.Loader.Events.FILE_COMPLETE, (_key: string, _type: string, _data: unknown) => {
          for (const entry of performance.getEntriesByType("resource")) {
            const path = new URL(entry.name).pathname;
            if (path.startsWith("/sprites/")) loadedUrls.add(path);
          }
        });
        this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
          loadErrors.push(file.key);
        });
        this.load.spritesheet("monster", "/sprites/monster.png", { frameWidth: 32, frameHeight: 32 });
        art.preloadHeritageMonsterArt(this);
      }
      create(): void {
        try {
          appearances = art.prepareHeritageMonsterArt(this);
          monsters.registerMonsterAnimations(this, appearances);
          resolveReady(this);
        } catch (error) {
          rejectReady(error);
        }
      }
    }
    const game = new Phaser.Game({
      type: Phaser.CANVAS,
      parent: "monster-test",
      width: 1200,
      height: 560,
      pixelArt: true,
      backgroundColor: "#17251f",
      banner: false,
      audio: { noAudio: true },
      scene: [MonsterTestScene],
    });
    const timeout = setTimeout(() => rejectReady(new Error("Phaser monster scene did not boot in 15s")), 15_000);
    let scene: Phaser.Scene;
    try {
      scene = await ready;
    } catch (error) {
      game.destroy(true);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let sprites = new monsters.MonsterSprites(scene, appearances!);
    let names = new NameTags(scene);
    let bars = new MonsterHealthBars(scene);
    const waitFor = (predicate: () => boolean): Promise<void> => new Promise((resolve, reject) => {
      const deadline = performance.now() + 5_000;
      const check = (): void => {
        if (predicate()) return resolve();
        if (performance.now() > deadline) return reject(new Error("Phaser state did not settle in 5s"));
        requestAnimationFrame(check);
      };
      check();
    });
    const render = (): Promise<void> => new Promise(resolve => {
      game.events.once(Phaser.Core.Events.POST_RENDER, () => resolve());
    });
    const snapshot = (kind: string, facing = 0, tileX = 5, tileY = 8) => ({
      kind, facing: facing as import("@zep-test/shared").Direction, tileX, tileY,
    });
    const readSprite = (sprite: Phaser.GameObjects.Sprite) => ({
      texture: sprite.texture.key,
      frame: Number(sprite.frame.name),
      width: sprite.displayWidth,
      height: sprite.displayHeight,
      originX: sprite.originX,
      originY: sprite.originY,
      x: sprite.x,
      y: sprite.y,
      depth: sprite.depth,
      playing: sprite.anims.isPlaying,
      animation: sprite.anims.currentAnim?.key ?? null,
      active: sprite.active,
    });
    const state = {
      game, scene, art, monsters, appearances: appearances!, sprites, names, bars,
      loadErrors, loadedUrls, snapshot, readSprite, waitFor, render,
      async restart() {
        const nextScene = new Promise<void>((resolve, reject) => {
          resolveReady = () => resolve();
          rejectReady = reject;
        });
        scene.scene.restart();
        await nextScene;
        sprites = new monsters.MonsterSprites(scene, appearances!);
        names = new NameTags(scene);
        bars = new MonsterHealthBars(scene);
        state.appearances = appearances!;
        state.sprites = sprites;
        state.names = names;
        state.bars = bars;
      },
    };
    return state;
  });
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

const test = base.extend<{
  harness: Harness;
  missingTextures: string[];
  browserErrors: string[];
}>({
  missingTextures: [[], { option: true }],
  browserErrors: [async ({ page, missingTextures }, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const pathname = new URL(message.location().url || "http://test.invalid").pathname;
      const expected404 = missingTextures.some(key => pathname === `/sprites/${key}.png`) &&
        /404/.test(message.text());
      if (!expected404) errors.push(`console: ${message.text()}`);
    });
    for (const key of missingTextures) {
      await page.route(`**/sprites/${key}.png`, route => route.fulfill({ status: 404, body: "missing test asset" }));
    }
    await use(errors);
    expect(errors, "No browser errors other than explicitly injected PNG 404s").toEqual([]);
  }, { auto: true }],
  harness: async ({ page, browserErrors: _errors }, use) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const harness = await createHarness(page);
    try {
      await use(harness);
    } finally {
      await harness.evaluate(async h => {
        const destroyed = new Promise<void>(resolve => h.game.events.once("destroy", () => resolve()));
        h.game.destroy(true);
        await destroyed;
      });
      await harness.dispose();
    }
  },
});

test("1 code paths: four actual PNGs register exactly 12 trimmed frames each", async ({ harness }) => {
  const result = await harness.evaluate(h => {
    return {
      legacyOrder: h.monsters.MONSTER_SPRITE_ORDER,
      loadErrors: h.loadErrors,
      sheets: ["squirrel", "rabbit", "deer", "boss"].map(kind => {
        const texture = h.scene.textures.get(`heritage-${kind}`);
        const image = texture.getSourceImage() as HTMLImageElement;
        return {
          key: texture.key,
          loaded: h.loadedUrls.has(`/sprites/heritage-${kind}.png`),
          imageSize: [image.naturalWidth, image.naturalHeight],
          frameNames: Object.keys(texture.frames),
          appearance: h.appearances.get(kind),
          frames: Array.from({ length: 12 }, (_, i) => {
            const frame = texture.get(i);
            const canvas = document.createElement("canvas");
            canvas.width = frame.cutWidth;
            canvas.height = frame.cutHeight;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight,
              0, 0, frame.cutWidth, frame.cutHeight);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let opaque = 0;
            let transparent = 0;
            let bottom = -1;
            for (let p = 3; p < pixels.length; p += 4) {
              if (pixels[p]! > 32) {
                opaque++;
                bottom = Math.floor((p / 4) / canvas.width);
              } else if (pixels[p] === 0) transparent++;
            }
            return {
              name: String(frame.name),
              rect: [frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight],
              logical: [frame.realWidth, frame.realHeight],
              trim: frame.trimmed,
              destination: [frame.x, frame.y, frame.width, frame.height],
              opaque, transparent,
              feet: frame.y + bottom + 1,
            };
          }),
        };
      }),
    };
  });
  expect(result.legacyOrder).toEqual(KINDS);
  expect(result.loadErrors).toEqual([]);
  for (const [index, sheet] of result.sheets.entries()) {
    expect(sheet.key).toBe(TEXTURES[index]);
    expect(sheet.loaded).toBe(true);
    expect(sheet.imageSize.every(size => size > 0)).toBe(true);
    expect(sheet.frameNames.sort()).toEqual(["__BASE", ...Array.from({ length: 12 }, (_, i) => String(i))].sort());
    expect(sheet.appearance).toEqual({
      textureKey: TEXTURES[index], firstFrame: 0, logicalCellPx: 384, feetY: 374, displayCellPx: DISPLAY[index],
    });
    expect(new Set(sheet.frames.map(frame => frame.rect.join(","))).size).toBe(12);
    for (const [i, frame] of sheet.frames.entries()) {
      expect(frame.name, `${sheet.key} frame ${i}`).toBe(String(i));
      expect(frame.logical).toEqual([384, 384]);
      expect(frame.trim).toBe(true);
      const [x, y, w, height] = frame.rect as [number, number, number, number];
      const [dx, dy, dw, dh] = frame.destination as [number, number, number, number];
      expect([x, y, w, height, dx, dy, dw, dh].every(Number.isFinite)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(w).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(x + w).toBeLessThanOrEqual(sheet.imageSize[0]!);
      expect(y + height).toBeLessThanOrEqual(sheet.imageSize[1]!);
      expect(dx).toBeGreaterThanOrEqual(0);
      expect(dy).toBeGreaterThanOrEqual(0);
      expect(dx + dw).toBeLessThanOrEqual(384);
      expect(dy + dh).toBeLessThanOrEqual(384);
      expect(frame.opaque).toBeGreaterThan(0);
      expect(frame.transparent).toBeGreaterThan(0);
      expect(Math.abs(frame.feet - 374), `${sheet.key}/${i} visible feet baseline`).toBeLessThanOrEqual(3);
    }
  }
});

test("2 boundaries: unknown kinds remain visible on the original 32px atlas", async ({ harness }) => {
  const result = await harness.evaluate(h => ["", "future-monster", "보스-v2", "__proto__"].flatMap(kind =>
    [0, 1, 2, 3].map(facing => {
      const id = `${kind}/${facing}`;
      const sprite = h.sprites.add(id, h.snapshot(kind, facing, 0, 0));
      const state = h.readSprite(sprite);
      const recognized = h.art.isHeritageMonsterTexture(kind);
      h.sprites.remove(id);
      return { facing, recognized, ...state };
    })));
  for (const state of result) {
    expect(state).toMatchObject({
      recognized: false, texture: "monster", frame: state.facing * 3 + 1,
      width: 32, height: 32, originX: 0.5, originY: 1, x: 16, y: 32, depth: 32,
    });
  }
});

test("monster movement reaches its server tile before the next 200ms attack tick", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const positions = [];
    for (const kind of ["squirrel", "rabbit", "deer", "boss"]) {
      const sprite = h.sprites.add(kind, h.snapshot(kind, 2, 5, 8));
      h.sprites.update(kind, h.snapshot(kind, 2, 6, 8));
      const tween = h.scene.tweens.getTweensOf(sprite)[0]!;
      await new Promise(resolve => h.scene.time.delayedCall(200, resolve));
      positions.push({ kind, x: sprite.x, y: sprite.y, duration: tween.duration });
      h.sprites.remove(kind);
    }
    return positions;
  });
  for (const position of result) {
    expect(position.x, position.kind).toBeCloseTo(208);
    expect(position.y).toBe(288);
    expect(position.duration).toBeLessThanOrEqual(100);
  }
});

test("3 states: all species turn, walk, settle on centre idle, and snap respawns", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const states = [];
    for (const kind of ["squirrel", "rabbit", "deer", "boss"]) {
      const sprite = h.sprites.add(kind, h.snapshot(kind));
      for (const facing of [0, 1, 2, 3]) {
        h.sprites.update(kind, h.snapshot(kind, facing));
        const idle = h.readSprite(sprite);
        h.sprites.update(kind, h.snapshot(kind, facing, 6));
        const walking = h.readSprite(sprite);
        await h.waitFor(() => !sprite.anims.isPlaying);
        const settled = h.readSprite(sprite);
        h.sprites.update(kind, h.snapshot(kind, facing, 12, 0));
        const snapped = h.readSprite(sprite);
        h.sprites.update(kind, h.snapshot(kind, facing));
        states.push({ kind, facing, idle, walking, settled, snapped });
      }
      h.sprites.remove(kind);
    }
    return states;
  });
  for (const state of result) {
    const size = DISPLAY[KINDS.indexOf(state.kind as typeof KINDS[number])];
    for (const sprite of [state.idle, state.walking, state.settled, state.snapped]) {
      expect(sprite.texture).toBe(`heritage-${state.kind}`);
      expect(sprite.width).toBeCloseTo(size!);
      expect(sprite.height).toBeCloseTo(size!);
      expect(sprite.originX).toBe(0.5);
      expect(sprite.originY).toBeCloseTo(374 / 384);
    }
    expect(state.idle).toMatchObject({ frame: state.facing * 3 + 1, playing: false });
    expect(state.walking.playing).toBe(true);
    expect(state.walking.animation).toContain(`heritage-${state.kind}`);
    expect(state.settled).toMatchObject({ frame: state.facing * 3 + 1, playing: false, x: 208, y: 288, depth: 288 });
    expect(state.snapped).toMatchObject({ frame: state.facing * 3 + 1, playing: false, x: 400, y: 32, depth: 32 });
  }
});

test("4 data flow: HP bars clear actual name labels including the 64px boss", async ({ harness }) => {
  const result = await harness.evaluate(h => ["squirrel", "rabbit", "deer", "boss"].map(kind => {
    const sprite = h.sprites.add(kind, h.snapshot(kind));
    h.names.add(kind, sprite, h.monsters.monsterDisplayName(kind));
    const label = h.scene.children.list.find(child => child.type === "Text") as Phaser.GameObjects.Text;
    const read = () => {
      const graphics = h.scene.children.list.find(child => child.type === "Graphics") as Phaser.GameObjects.Graphics;
      return { barX: graphics.x, barBottom: graphics.y + 5, labelTop: label.getBounds().top, spriteX: sprite.x };
    };
    h.bars.applyHit(kind, sprite, 1, 5000);
    const initial = read();
    sprite.setPosition(sprite.x + 32, sprite.y - 32);
    h.names.update();
    h.bars.update();
    const moved = read();
    const ratios = [];
    for (const [remaining, maximum] of [[0, 0], [-1, 10], [1, 1], [20, 10], [1, Number.MAX_SAFE_INTEGER]]) {
      h.bars.applyHit(kind, sprite, remaining!, maximum!);
      const entries = (h.bars as unknown as { bars: Map<string, { ratio: number }> }).bars;
      ratios.push(entries.get(kind)!.ratio);
    }
    h.sprites.remove(kind);
    h.bars.update();
    h.names.remove(kind);
    return { kind, initial, moved, ratios, graphicsLeft: h.scene.children.list.filter(child => child.type === "Graphics").length };
  }));
  for (const state of result) {
    for (const placement of [state.initial, state.moved]) {
      expect(placement.barX).toBe(placement.spriteX);
      expect(placement.barBottom, `${state.kind} HP bar overlaps its label`).toBeLessThan(placement.labelTop);
    }
    expect(state.moved.barBottom - state.initial.barBottom).toBe(-32);
    expect(state.ratios).toEqual([0, 0, 1, 1, 1 / Number.MAX_SAFE_INTEGER]);
    expect(state.graphicsLeft).toBe(0);
  }
});

test("5 dependencies: prepare/register are idempotent across actual scene restart", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const keys = ["heritage-squirrel", "heritage-rabbit", "heritage-deer", "heritage-boss"];
    const textures = keys.map(key => h.scene.textures.get(key));
    const frames = textures.map(texture => Array.from({ length: 12 }, (_, i) => texture.get(i)));
    const animationKeys = ["monster", ...keys].flatMap(key => h.scene.anims.getAnimsFromTexture(key)).sort();
    const animations = animationKeys.map(key => h.scene.anims.get(key));
    for (let i = 0; i < 10; i++) {
      const appearances = h.art.prepareHeritageMonsterArt(h.scene);
      h.monsters.registerMonsterAnimations(h.scene, appearances);
    }
    const before = h.sprites.add("reentry", h.snapshot("boss"));
    await h.restart();
    const after = h.sprites.add("reentry", h.snapshot("boss"));
    return {
      animationKeys,
      keysAfter: ["monster", ...keys].flatMap(key => h.scene.anims.getAnimsFromTexture(key)).sort(),
      sameTextures: textures.every((texture, i) => h.scene.textures.get(keys[i]!) === texture),
      sameFrames: frames.every((row, i) => row.every((frame, j) => textures[i]!.get(j) === frame)),
      sameAnimations: animations.every((animation, i) => h.scene.anims.get(animationKeys[i]!) === animation),
      oldActive: before.active,
      reentered: h.readSprite(after),
      loadErrors: h.loadErrors,
    };
  });
  expect(result.animationKeys.length).toBe(32);
  expect(result.keysAfter).toEqual(result.animationKeys);
  expect(result.sameTextures).toBe(true);
  expect(result.sameFrames).toBe(true);
  expect(result.sameAnimations).toBe(true);
  expect(result.oldActive).toBe(false);
  expect(result.reentered).toMatchObject({ texture: "heritage-boss", frame: 1, active: true });
  expect(result.loadErrors).toEqual([]);
});

test("6 regression: legacy animation keys and heritage frame sequences retain four directions", async ({ harness }) => {
  const result = await harness.evaluate(h => ["squirrel", "rabbit", "deer", "boss"].flatMap((kind, index) =>
    [0, 1, 2, 3].map(facing => {
      const legacy = h.scene.anims.get(`monster-walk-${index}-${facing}`);
      if (!legacy) throw new Error(`Missing legacy animation ${index}/${facing}`);
      const id = `${kind}/${facing}`;
      const sprite = h.sprites.add(id, h.snapshot(kind, facing));
      h.sprites.update(id, h.snapshot(kind, facing, 6));
      const animation = sprite.anims.currentAnim!;
      const read = (value: Phaser.Animations.Animation) => ({
        key: value.key, repeat: value.repeat,
        frames: value.frames.map(frame => ({ key: frame.textureKey, frame: Number(frame.textureFrame) })),
      });
      const row = { kind, index, facing, legacy: read(legacy), heritage: read(animation) };
      h.sprites.remove(id);
      return row;
    })));
  for (const row of result) {
    const frame = row.facing * 3;
    expect(row.legacy.frames).toEqual([frame, frame + 1, frame + 2, frame + 1]
      .map(frame => ({ key: "monster", frame: row.index * 12 + frame })));
    expect(row.heritage.key).toContain(`heritage-${row.kind}`);
    expect(row.heritage.frames).toEqual([frame, frame + 1, frame + 2, frame + 1]
      .map(frame => ({ key: `heritage-${row.kind}`, frame })));
    expect(row.legacy.repeat).toBe(-1);
    expect(row.heritage.repeat).toBe(-1);
  }
});

test("7 stress: rapid add/move/replace/remove leaves no sprites or active tweens", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const removed: Phaser.GameObjects.Sprite[] = [];
    for (let i = 0; i < 256; i++) {
      const kind = ["squirrel", "rabbit", "deer", "boss"][i % 4]!;
      const id = `burst-${i % 16}`;
      removed.push(h.sprites.add(id, h.snapshot(kind, i % 4)));
      h.sprites.update(id, h.snapshot(kind, i % 4, 6));
      if (i % 3 === 0) h.sprites.remove(id);
    }
    for (let i = 0; i < 16; i++) {
      h.sprites.remove(`burst-${i}`);
      h.sprites.remove(`burst-${i}`);
      h.sprites.update(`burst-${i}`, h.snapshot("boss"));
    }
    await h.waitFor(() => h.scene.tweens.getTweens().length === 0);
    return {
      activeRemoved: removed.filter(sprite => sprite.active).length,
      sprites: h.scene.children.list.filter(child => child.type === "Sprite").length,
      tracked: Array.from({ length: 16 }, (_, i) => h.sprites.get(`burst-${i}`) !== undefined),
      tweens: h.scene.tweens.getTweens().length,
    };
  });
  expect(result).toEqual({ activeRemoved: 0, sprites: 0, tracked: Array(16).fill(false), tweens: 0 });
});

test("8 rendering: game-scale contact sheet contains all 48 species/direction/frame cells", async ({ harness, page }, testInfo) => {
  const result = await harness.evaluate(async h => {
    const rendered = [];
    for (const [row, kind] of ["squirrel", "rabbit", "deer", "boss"].entries()) {
      h.scene.add.text(12, 104 + row * 120, h.monsters.monsterDisplayName(kind), { fontSize: "16px", color: "#ffffff" });
      for (let facing = 0; facing < 4; facing++) {
        for (let step = 0; step < 3; step++) {
          const x = 160 + (facing * 3 + step) * 88;
          const y = 130 + row * 120;
          const sprite = h.sprites.add(`${kind}/${facing}/${step}`, h.snapshot(kind, facing));
          sprite.setFrame(facing * 3 + step).setPosition(x, y);
          h.scene.add.text(x, y + 12, String(facing * 3 + step), { fontSize: "12px", color: "#b8cbbb" }).setOrigin(0.5, 0);
          rendered.push({ kind, facing, step, ...h.readSprite(sprite) });
        }
      }
    }
    ["DOWN", "LEFT", "RIGHT", "UP"].forEach((direction, i) => {
      h.scene.add.text(248 + i * 264, 22, direction, { fontSize: "16px", color: "#ffffff" }).setOrigin(0.5, 0);
    });
    await h.render();
    const context = h.game.canvas.getContext("2d")!;
    return rendered.map(sprite => {
      const pixels = context.getImageData(Math.floor(sprite.x - sprite.width / 2),
        Math.floor(sprite.y - sprite.height * sprite.originY), Math.ceil(sprite.width), Math.ceil(sprite.height)).data;
      let painted = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        if (pixels[p] !== 23 || pixels[p + 1] !== 37 || pixels[p + 2] !== 31) painted++;
      }
      return { ...sprite, painted };
    });
  });
  expect(result).toHaveLength(48);
  for (const sprite of result) {
    expect(sprite.texture).toBe(`heritage-${sprite.kind}`);
    expect(sprite.frame).toBe(sprite.facing * 3 + sprite.step);
    expect(sprite.width).toBeCloseTo(DISPLAY[KINDS.indexOf(sprite.kind as typeof KINDS[number])]!);
    expect(sprite.painted, `${sprite.kind}/${DIRECTIONS[sprite.facing]}/${sprite.step} is blank`).toBeGreaterThan(20);
  }
  const canvas = page.locator("#monster-test canvas");
  const box = await canvas.boundingBox();
  expect(box).toMatchObject({ width: 1200, height: 560 });
  const path = testInfo.outputPath("heritage-monsters-contact-sheet.png");
  await canvas.screenshot({ path });
  await testInfo.attach("48 frames at game scale (visual review artifact)", { path, contentType: "image/png" });
});

test("9 concurrency: a turn or replacement during movement cannot revive a removed sprite", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const first = h.sprites.add("same-id", h.snapshot("squirrel"));
    h.sprites.update("same-id", h.snapshot("squirrel", 2, 6));
    h.sprites.update("same-id", h.snapshot("squirrel", 3, 6));
    const turned = h.readSprite(first);
    h.sprites.update("same-id", h.snapshot("squirrel", 1, 5));
    const replacement = h.sprites.add("same-id", h.snapshot("boss", 1, 10));
    h.sprites.update("same-id", h.snapshot("boss", 2, 11));
    await h.waitFor(() => !replacement.anims.isPlaying && h.scene.tweens.getTweens().length === 0);
    const settled = h.readSprite(replacement);
    h.sprites.remove("same-id");
    await h.render();
    return {
      turned, settled, firstActive: first.active, replacementActive: replacement.active,
      tracked: h.sprites.get("same-id") !== undefined,
      spritesLeft: h.scene.children.list.filter(child => child.type === "Sprite").length,
      tweensLeft: h.scene.tweens.getTweens().length,
    };
  });
  expect(result.turned.playing).toBe(true);
  expect(result.turned.animation).toContain("heritage-squirrel");
  expect(result.settled).toMatchObject({ texture: "heritage-boss", frame: 7, x: 368, y: 288, playing: false });
  expect(result.firstActive).toBe(false);
  expect(result.replacementActive).toBe(false);
  expect(result.tracked).toBe(false);
  expect(result.spritesLeft).toBe(0);
  expect(result.tweensLeft).toBe(0);
});

test("classic normal attack plays directional frames and cancels safely", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const { PlayerSprites } = await import("/src/world/playerSprites.ts");
    const { createAvatarArt } = await import("/src/world/avatarArt.ts");
    const art = createAvatarArt(h.scene);
    await new Promise<void>(resolve => {
      art.preload();
      h.scene.load.once("complete", resolve);
      h.scene.load.start();
    });
    art.prepare();
    const players = new PlayerSprites(h.scene, art);
    const frames = [];
    const states = [];
    for (const facing of [0, 1, 2, 3] as const) {
      const state = { nickname: "test", tileX: 5, tileY: 5, facing, avatarSkin: 0, level: 1 };
      const sprite = players.add("self", state);
      players.attack("self", facing);
      const seen = new Set<number>();
      await h.waitFor(() => {
        if (sprite.texture.key !== "avatar:/sprites/classic-adventurer-attack.png") return true;
        seen.add(sprite.frame.cutY / 362 * 3 + sprite.frame.cutX / 362);
        return false;
      });
      frames.push([...seen]);
      states.push({ texture: sprite.texture.key, width: sprite.displayWidth, angle: sprite.angle });
      players.attack("self", facing);
      players.update("self", { ...state, tileX: 6, avatarSkin: 1 });
      await h.waitFor(() => h.scene.tweens.getTweens().length === 0);
      states.push({ texture: sprite.texture.key, width: sprite.displayWidth, angle: sprite.angle });
      players.remove("self");
    }
    const state = { nickname: "test", tileX: 5, tileY: 5, facing: 0 as const, avatarSkin: 0, level: 1 };
    const sprite = players.add("self", state);
    players.attack("self", 0);
    players.remove("self");
    await new Promise(resolve => h.scene.time.delayedCall(350, resolve));
    return { frames, states, removed: !sprite.active, tracked: !!players.get("self") };
  });
  expect(result.frames).toEqual([[0, 1, 2], [3, 4, 8], [6, 7, 5], [9, 10, 11]]);
  for (let i = 0; i < result.states.length; i += 2) {
    expect(result.states[i]).toEqual({ texture: "avatar:/sprites/heritage-adventurer.png", width: 48, angle: 0 });
    expect(result.states[i + 1]).toEqual({ texture: "avatar:/sprites/avatar.png", width: 32, angle: 0 });
  }
  expect(result).toMatchObject({ removed: true, tracked: false });
});

test("attack pose restores rotation without changing movement or skin scale", async ({ harness }) => {
  const results = await harness.evaluate(async h => {
    const { CombatEffects } = await import("/src/world/combatEffects.ts");
    const effects = new CombatEffects(h.scene);
    const results = [];
    for (const facing of [0, 1, 2, 3] as const) {
      const sprite = h.scene.add.sprite(160, 160, "monster", 1).setDisplaySize(48, 48).setOrigin(0.5, 0.96);
      const count = h.scene.children.list.length;
      effects.swing(sprite, facing);
      const temporary = h.scene.children.list.length - count;
      let peak = 0;
      sprite.setPosition(180, 180).setDisplaySize(32, 32);
      await h.waitFor(() => {
        peak = Math.max(peak, Math.abs(sprite.angle));
        return h.scene.tweens.getTweens().length === 0;
      });
      results.push({ temporary, peak, angle: sprite.angle, x: sprite.x, y: sprite.y,
        width: sprite.displayWidth, remaining: h.scene.children.list.length - count });
      sprite.destroy();
    }
    return results;
  });
  for (const result of results) {
    expect(result.temporary).toBe(1);
    expect(result.peak).toBeGreaterThan(5);
    expect(result.angle).toBeCloseTo(0);
    expect(result).toMatchObject({ x: 180, y: 180, width: 32, remaining: 0 });
  }
});

test("moving attack effects follow the attacker and clean up on removal", async ({ harness }) => {
  const results = await harness.evaluate(async h => {
    const { CombatEffects } = await import("/src/world/combatEffects.ts");
    const { ITEM_TEXTURE } = await import("/src/world/weaponVisual.ts");
    await new Promise<void>(resolve => {
      h.scene.load.spritesheet(ITEM_TEXTURE, "/sprites/items.png", { frameWidth: 32, frameHeight: 32 });
      h.scene.load.once("complete", resolve);
      h.scene.load.start();
    });
    const results = [];
    for (const facing of [0, 1, 2, 3] as const) {
      const sprite = h.scene.add.sprite(160, 160, "monster", 1).setDisplaySize(48, 48);
      new CombatEffects(h.scene).swing(sprite, facing, 0, true);
      const arc = h.scene.children.list.find(child => child.type === "Graphics") as Phaser.GameObjects.Graphics;
      const weapon = h.scene.children.list.find(child => child.type === "Sprite" && child !== sprite) as Phaser.GameObjects.Sprite;
      const offset = { x: weapon.x - arc.x, y: weapon.y - arc.y };
      sprite.setPosition(192, 128).setDepth(128).setDisplaySize(32, 32);
      await h.render();
      await h.render();
      const moved = { x: arc.x, y: arc.y, depth: arc.depth,
        weaponX: weapon.x - arc.x, weaponY: weapon.y - arc.y, weaponDepth: weapon.depth };
      sprite.destroy();
      await h.waitFor(() => !arc.active && !weapon.active && h.scene.tweens.getTweens().length === 0);
      results.push({ offset, moved, remaining: h.scene.children.list.length });
    }
    return results;
  });
  for (const result of results) {
    expect(result.moved.x).toBe(192);
    expect(result.moved.y).toBeCloseTo(115.2);
    expect(result.moved.depth).toBe(129);
    expect(result.moved.weaponDepth).toBe(129);
    expect(result.moved.weaponX).toBeCloseTo(result.offset.x);
    expect(result.moved.weaponY).toBeCloseTo(result.offset.y);
    expect(result.remaining).toBe(0);
  }
});

test("death ghosts preserve game-scale size and feet throughout the fade", async ({ harness }) => {
  const results = await harness.evaluate(async h => {
    const { CombatEffects } = await import("/src/world/combatEffects.ts");
    const effects = new CombatEffects(h.scene);
    const results = [];
    for (const kind of ["squirrel", "rabbit", "deer", "boss", "future-monster"]) {
      const source = h.sprites.add(kind, h.snapshot(kind, 1));
      source.setFlip(true, false);
      const expected = h.readSprite(source);
      effects.death(source);
      const ghost = h.scene.children.list.find(child => child.type === "Sprite" && child !== source) as Phaser.GameObjects.Sprite;
      const initial = h.readSprite(ghost);
      const flip = [ghost.flipX, ghost.flipY];
      h.sprites.remove(kind);
      let maxWidth = ghost.displayWidth;
      let maxHeight = ghost.displayHeight;
      await h.waitFor(() => {
        if (!ghost.active) return true;
        maxWidth = Math.max(maxWidth, ghost.displayWidth);
        maxHeight = Math.max(maxHeight, ghost.displayHeight);
        return false;
      });
      results.push({ kind, expected, initial, flip, maxWidth, maxHeight, active: ghost.active });
    }
    return results;
  });
  for (const result of results) {
    expect(result.initial, `${result.kind} death ghost must start at the visible body size`).toMatchObject({
      texture: result.expected.texture, frame: result.expected.frame,
      width: result.expected.width, height: result.expected.height,
      originX: result.expected.originX, originY: result.expected.originY,
      x: result.expected.x, y: result.expected.y, depth: result.expected.depth,
    });
    expect(result.flip).toEqual([true, false]);
    expect(result.maxWidth).toBeLessThanOrEqual(result.expected.width * 1.3 + 0.01);
    expect(result.maxHeight).toBeLessThanOrEqual(result.expected.height + 0.01);
    expect(result.active).toBe(false);
  }
});

test("live hunting ground: all four PNGs load and the real 1440x900 world survives reentry", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const loaded = new Set<string>();
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (response.ok() && TEXTURES.some(key => path === `/sprites/${key}.png`)) loaded.add(path);
  });
  await joinRoom(page, "hunting-ground", { skinIndex: 0 });
  const guide = page.getByRole("region", { name: "현재 지역 안내" });
  await expect(guide).toContainText("초보 사냥터 · 1굴");
  await expect.poll(() => loaded.size).toBe(4);
  await expect(page.locator("#transition")).toHaveAttribute("data-state", "clear");
  const path = testInfo.outputPath("hunting-monsters.png");
  await page.screenshot({ path });
  await testInfo.attach("Real hunting ground (visual review artifact)", { path, contentType: "image/png" });
  for (const destination of ["마을 광장", "사냥터 입구"]) {
    await page.locator("#landmark-button").click();
    await page.locator("#landmark-panel-list").getByRole("button", { name: destination, exact: true }).click();
    await expect(guide).toContainText(destination === "마을 광장" ? "마을 광장" : "초보 사냥터 · 1굴");
    await expect(page.locator("#transition")).toHaveAttribute("data-state", "clear");
  }
});

test.describe("missing optional art", () => {
  test.use({ missingTextures: TEXTURES });

  test("all four missing sheets retain kind-specific legacy bodies and animation rows", async ({ harness }) => {
    const result = await harness.evaluate(h => ({
      errors: h.loadErrors.sort(),
      states: ["squirrel", "rabbit", "deer", "boss"].flatMap((kind, index) => [0, 1, 2, 3].map(facing => {
        const id = `${kind}/${facing}`;
        const sprite = h.sprites.add(id, h.snapshot(kind, facing));
        const idle = h.readSprite(sprite);
        h.sprites.update(id, h.snapshot(kind, facing, 6));
        const walk = h.readSprite(sprite);
        h.sprites.remove(id);
        return { kind, index, facing, idle, walk };
      })),
    }));
    expect(result.errors).toEqual([...TEXTURES].sort());
    for (const { index, facing, idle, walk } of result.states) {
      expect(idle).toMatchObject({ texture: "monster", frame: index * 12 + facing * 3 + 1,
        width: 32, height: 32, originX: 0.5, originY: 1 });
      expect(walk.animation).toBe(`monster-walk-${index}-${facing}`);
      expect(walk.playing).toBe(true);
    }
  });

  test("PNG 404s do not trigger the global WorldScene load error or prevent entry", async ({ page }) => {
    await joinRoom(page, "hunting-ground", { skinIndex: 0 });
    await expect(page.getByRole("region", { name: "현재 지역 안내" })).toContainText("초보 사냥터 · 1굴");
    await expect(page.locator("#game-root canvas")).toBeVisible();
    await expect(page.getByText("맵을 불러오지 못했습니다", { exact: true })).toBeHidden();
  });
});

/**
 * 2026-09-11 독립 리뷰 High: 4종 시트 합계 4.32MiB가 `mapKey`와 무관하게 모든 room의
 * `preload()`에서 무조건 로드되고 있었다. 몬스터는 `hunting-ground`/`hunting-den`에만 있고,
 * `grand-plaza`는 500 CCU 성능 기준선 room, `plaza`는 전원이 거쳐가는 로비다.
 */
test.describe("몬스터 아트는 몬스터가 사는 room에서만 내려받는다", () => {
  async function monsterArtRequests(page: Page, room: string): Promise<string[]> {
    const seen = new Set<string>();
    page.on("request", request => {
      const match = /\/sprites\/(heritage-(?:squirrel|rabbit|deer|boss))\.png/.exec(request.url());
      if (match?.[1]) seen.add(match[1]);
    });
    await joinRoom(page, room, { skinIndex: 0 });
    await expect(page.locator("#game-root canvas")).toBeVisible();
    return [...seen].sort();
  }

  for (const room of ["plaza", "grand-plaza"]) {
    test(`${room}에서는 몬스터 PNG를 한 장도 요청하지 않는다`, async ({ page }) => {
      expect(await monsterArtRequests(page, room)).toEqual([]);
    });
  }

  test("hunting-ground에서는 4종을 전부 요청한다", async ({ page }) => {
    expect(await monsterArtRequests(page, "hunting-ground")).toEqual([...TEXTURES].sort());
  });
});
