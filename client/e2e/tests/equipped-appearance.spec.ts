/// <reference types="vite/client" />
import { expect, test as base, type Page } from "@playwright/test";
import type Phaser from "phaser";

// Renderer fixtures exercise real shipped art and Phaser, not inventory authorization.
async function createHarness(page: Page, fallback: boolean) {
  await page.route("**/__equipment-appearance-test", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body style="margin:0;background:#17251f"><div id="equipment-test"></div><style>canvas{width:960px!important;height:840px!important;image-rendering:pixelated}</style></body></html>',
  }));
  if (fallback) await page.route("**/sprites/baram-adventurer.png", route => route.fulfill({ status: 404, body: "fixture missing primary atlas" }));
  await page.goto("/__equipment-appearance-test");
  return page.evaluateHandle(async () => {
    const source = await (await fetch("/src/world/monsterSprites.ts")).text();
    const phaserUrl = source.match(/from\s*["']([^"']*phaser[^"']*)["']/)?.[1];
    if (!phaserUrl) throw new Error("Vite did not resolve Phaser");
    const Phaser = (await import(phaserUrl)).default as typeof import("phaser");
    const { createAvatarArt } = await import("/src/world/avatarArt.ts");
    const { PlayerSprites } = await import("/src/world/playerSprites.ts");
    const { LocalPlayer } = await import("/src/world/localPlayer.ts");
    const { NameTags } = await import("/src/world/nameTags.ts");
    let art!: ReturnType<typeof createAvatarArt>;
    let resolve!: (scene: Phaser.Scene) => void;
    const ready = new Promise<Phaser.Scene>(done => { resolve = done; });
    class AppearanceScene extends Phaser.Scene {
      preload() { art = createAvatarArt(this); art.preload(); }
      create() { art.prepare(); resolve(this); }
    }
    const game = new Phaser.Game({ type: Phaser.CANVAS, parent: "equipment-test", width: 480, height: 420,
      pixelArt: true, backgroundColor: "#17251f", banner: false, audio: { noAudio: true }, scene: [AppearanceScene] });
    const scene = await ready;
    const originalListeners = scene.events.listenerCount(Phaser.Scenes.Events.POST_UPDATE);
    const players = new PlayerSprites(scene, art);
    const snapshot = (skin = 0, facing: 0 | 1 | 2 | 3 = 0, weapon = "old-dagger", armor = "padded-armor") => ({
      avatarSkin: skin, facing, tileX: 3, tileY: 3, nickname: "appearance-fixture", level: 1,
      weaponItemKey: weapon, armorItemKey: armor,
    });
    const layer = (id: string, kind: "weapon" | "armor") => scene.children.getByName(`equipment:${kind}:${id}`) as Phaser.GameObjects.Sprite;
    const render = () => new Promise<void>(done => game.events.once(Phaser.Core.Events.POST_RENDER, done));
    const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
    const read = (sprite: Phaser.GameObjects.Sprite) => ({ x: sprite.x, y: sprite.y, width: sprite.displayWidth,
      height: sprite.displayHeight, visible: sprite.visible, active: sprite.active, angle: sprite.angle,
      alpha: sprite.alpha, depth: sprite.depth, texture: sprite.texture.key, originY: sprite.originY });
    const equipmentCount = () => scene.children.list.filter(child => child.name.startsWith("equipment:")).length;
    return { game, scene, art, players, LocalPlayer, NameTags, snapshot, layer, render, delay, read, equipmentCount, originalListeners };
  });
}

type Harness = Awaited<ReturnType<typeof createHarness>>;
const test = base.extend<{ harness: Harness; fallback: boolean }>({
  fallback: [false, { option: true }],
  harness: async ({ page, fallback }, use) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const harness = await createHarness(page, fallback);
    try { await use(harness); } finally {
      await harness.evaluate(async h => {
        const destroyed = new Promise<void>(done => h.game.events.once("destroy", done));
        h.game.destroy(true); await destroyed;
      });
      await harness.dispose();
    }
    expect(errors).toEqual([]);
  },
});

test("real primary and legacy art: all three gear profiles, four directions, visible pixel differences", async ({ harness, page }, testInfo) => {
  const result = await harness.evaluate(async h => {
    const profiles = [["old-dagger", "padded-armor"], ["hunting-blade", "leather-armor"], ["iron-blade", "reinforced-armor"]] as const;
    const states = [];
    for (const [skinIndex, skin] of [0, 2].entries()) {
      for (const [profile, [weapon, armor]] of profiles.entries()) {
        const y = 65 + (skinIndex * 3 + profile) * 65;
        for (const facing of [0, 1, 2, 3] as const) {
          const id = `${skin}-${profile}-${facing}`;
          const sprite = h.players.add(id, h.snapshot(skin, facing, weapon, armor));
          sprite.setPosition(60 + facing * 120, y);
          h.scene.add.text(5 + facing * 120, y + 3, `${skin === 0 ? "baram" : "legacy32"} ${weapon}`, { fontSize: "7px", color: "#ffffff" });
          await h.render();
          states.push({ skin, facing, weapon: h.read(h.layer(id, "weapon")), armor: h.read(h.layer(id, "armor")), body: h.read(sprite) });
        }
      }
    }
    await h.render();
    const context = h.game.canvas.getContext("2d")!;
    const hashes = [0, 2].map((_, skinIndex) => [0, 1, 2].map(profile => {
      const data = context.getImageData(32, 65 + (skinIndex * 3 + profile) * 65 - 48, 56, 48).data;
      let hash = 2166136261;
      for (const value of data) hash = Math.imul(hash ^ value, 16777619);
      return hash >>> 0;
    }));
    return { states, hashes };
  });
  expect(result.states).toHaveLength(24);
  for (const state of result.states) {
    expect(state.weapon.visible).toBe(true); expect(state.armor.visible).toBe(true);
    expect(state.body.height).toBe(state.skin === 0 ? 48 : 32);
    expect(state.armor.texture).toContain(`:${state.facing}`);
  }
  for (const hashes of result.hashes) expect(new Set(hashes).size).toBe(3);
  await page.locator("canvas").screenshot({ path: testInfo.outputPath("equipment-primary-legacy-directions.png") });
});

test("armor preserves primary and legacy head and feet pixels", async ({ harness }) => {
  const results = await harness.evaluate(async h => {
    const results = [];
    const context = h.game.canvas.getContext("2d")!;
    for (const skin of [0, 2]) for (const facing of [0, 1, 2, 3] as const) {
      const state = h.snapshot(skin, facing, "", "");
      const sprite = h.players.add("protected", state);
      await h.render();
      const x = Math.floor(sprite.x - sprite.displayWidth / 2);
      const y = Math.floor(sprite.y - sprite.displayHeight * sprite.originY);
      const width = sprite.displayWidth;
      // Back-facing primary art starts its torso at 45% of the frame; protect the head above it.
      const regions = [{ y, height: Math.floor(sprite.displayHeight * 0.4) }, { y: y + Math.ceil(sprite.displayHeight * 0.9), height: Math.floor(sprite.displayHeight * 0.1) }];
      const before = regions.map(region => Array.from(context.getImageData(x, region.y, width, region.height).data));
      for (const armor of ["padded-armor", "leather-armor", "reinforced-armor"]) {
        h.players.update("protected", { ...state, armorItemKey: armor }); await h.render();
        results.push({ skin, facing, armor, protected: regions.every((region, index) => {
          const after = context.getImageData(x, region.y, width, region.height).data;
          return after.every((value, pixel) => value === before[index]![pixel]);
        }) });
      }
      h.players.remove("protected");
    }
    return results;
  });
  for (const result of results) expect(result.protected, JSON.stringify(result)).toBe(true);
});

test("walk frames, blocked turns, warps and skin changes keep both layers attached", async ({ harness }) => {
  const states = await harness.evaluate(async h => {
    const states = [];
    const body = h.players.add("walker", h.snapshot());
    for (const skin of [0, 2]) for (const facing of [0, 1, 2, 3] as const) {
      const state = { ...h.snapshot(skin, facing), tileX: 3, tileY: 3 };
      h.players.update("walker", state); await h.delay(100);
      const destination = { ...state, tileX: state.tileX + (facing === 1 ? -1 : facing === 2 ? 1 : 0), tileY: state.tileY + (facing === 0 ? 1 : facing === 3 ? -1 : 0) };
      h.players.update("walker", destination);
      for (let frame = 0; frame < 3; frame++) {
        await h.render();
        states.push({ body: h.read(body), weapon: h.read(h.layer("walker", "weapon")), armor: h.read(h.layer("walker", "armor")), facing });
      }
      await h.delay(100);
      h.players.update("walker", { ...destination, tileX: 10, tileY: 9 }); await h.render();
      states.push({ body: h.read(body), weapon: h.read(h.layer("walker", "weapon")), armor: h.read(h.layer("walker", "armor")), facing });
    }
    return states;
  });
  for (const state of states) {
    expect(state.armor.texture.endsWith(`:${state.facing}`)).toBe(true);
    expect(Math.abs(state.armor.x - state.body.x)).toBeLessThan(1);
    expect(Math.abs(state.weapon.x - state.body.x)).toBeLessThan(15);
    expect(state.armor.y).toBeGreaterThan(state.body.y - state.body.height);
    expect(state.armor.y + state.armor.height).toBeLessThan(state.body.y);
    expect(Math.abs(state.weapon.depth - state.body.depth)).toBeLessThan(0.5);
    expect(state.weapon.depth < state.body.depth).toBe(state.facing === 3);
  }
});

test("local pending movement accepts gear-only authoritative patches without rollback; blocked turn and teleport preserve gear", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const spawn = h.snapshot();
    const body = h.players.add("local", spawn);
    const sent: number[] = [];
    let walkable = true;
    const local = new h.LocalPlayer("local", spawn, h.players, new h.NameTags(h.scene), dir => sent.push(dir), () => walkable);
    local.step(2);
    local.applyServerState({ ...spawn, weaponItemKey: "iron-blade", armorItemKey: "reinforced-armor" });
    await h.delay(130); await h.render();
    const pending = { body: h.read(body), weapon: h.read(h.layer("local", "weapon")), armor: h.read(h.layer("local", "armor")) };
    local.applyServerState({ ...spawn, tileX: 4, facing: 2, weaponItemKey: "iron-blade", armorItemKey: "reinforced-armor" });
    walkable = false; local.step(1); await h.render();
    const blocked = { x: body.x, armor: h.layer("local", "armor").texture.key };
    local.applyTeleport({ tileX: 9, tileY: 8, facing: 3 }); await h.render();
    const warped = { x: body.x, y: body.y, weapon: h.read(h.layer("local", "weapon")), armor: h.read(h.layer("local", "armor")) };
    local.applyServerState({ ...spawn, tileX: 9, tileY: 8, facing: 3, weaponItemKey: "", armorItemKey: "" }); await h.render();
    return { pending, blocked, warped, sent, hidden: !h.layer("local", "weapon").visible && !h.layer("local", "armor").visible };
  });
  expect(result.sent).toEqual([2]); expect(result.pending.body.x).toBe(144);
  expect(result.pending.weapon.texture).toBe("equipment:weapon:iron-blade");
  expect(result.pending.armor.texture).toBe("equipment:armor:reinforced-armor:2");
  expect(result.blocked).toEqual({ x: 144, armor: "equipment:armor:reinforced-armor:1" });
  expect(result.warped.x).toBe(304); expect(result.warped.y).toBe(288);
  expect(result.warped.armor.texture).toBe("equipment:armor:reinforced-armor:3"); expect(result.hidden).toBe(true);
});

test("local fallback swing is bounded, independent from remote, and exchange or unequip cancels it", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const state = h.snapshot();
    const body = h.players.add("local", state);
    h.players.add("remote", { ...state, tileX: 6 });
    await h.render();
    const before = h.read(h.layer("local", "weapon"));
    const remoteBefore = h.read(h.layer("remote", "weapon"));
    const bodyClip = h.players.attack("local", 0);
    await h.delay(60); await h.render();
    const during = h.read(h.layer("local", "weapon"));
    const remoteDuring = h.read(h.layer("remote", "weapon"));
    await h.delay(160); await h.render();
    const after = h.read(h.layer("local", "weapon"));
    h.players.attack("local", 0); await h.render();
    h.players.update("local", { ...state, weaponItemKey: "hunting-blade" }); await h.render();
    const exchanged = h.read(h.layer("local", "weapon"));
    h.players.attack("local", 0);
    h.players.update("local", { ...state, weaponItemKey: "" }); await h.delay(220); await h.render();
    return { bodyClip, before, during, after, remoteBefore, remoteDuring, exchanged, hidden: !h.layer("local", "weapon").visible, body: h.read(body) };
  });
  expect(result.bodyClip).toBe(false);
  expect(result.during.angle).not.toBe(result.before.angle);
  expect(result.after.angle).toBeCloseTo(result.before.angle, 5);
  expect(result.remoteDuring).toEqual(result.remoteBefore);
  expect(result.exchanged.texture).toBe("equipment:weapon:hunting-blade");
  expect(result.exchanged.angle).toBeCloseTo(result.before.angle, 5);
  expect(result.hidden).toBe(true); expect(result.body.angle).toBe(0);
});

test("turn, warp and skin changes cancel an active fallback weapon pose immediately", async ({ harness }) => {
  const results = await harness.evaluate(async h => {
    const results = [];
    for (const change of ["turn", "warp", "skin"] as const) {
      const state = h.snapshot();
      h.players.add("interrupted", state);
      h.players.attack("interrupted", 0); await h.delay(45); await h.render();
      const during = h.read(h.layer("interrupted", "weapon"));
      h.players.update("interrupted", { ...state, facing: change === "turn" ? 1 : 0,
        tileX: change === "warp" ? 9 : 3, avatarSkin: change === "skin" ? 2 : 0 });
      await h.render();
      results.push({ change, during, after: h.read(h.layer("interrupted", "weapon")) });
      h.players.remove("interrupted");
    }
    return results;
  });
  for (const result of results) {
    expect(result.during.angle).not.toBe(12);
    expect(result.after.angle).toBe(result.change === "turn" ? -30 : 12);
  }
});

test("same-tile actors keep whole bodies and gear grouped across insertion and removal", async ({ harness, page }, testInfo) => {
  const groups = await harness.evaluate(async h => {
    const groups = [];
    h.players.add("front", h.snapshot(0, 0, "iron-blade", "reinforced-armor"));
    h.players.add("back", h.snapshot(2, 3, "old-dagger", "leather-armor"));
    const depths = (id: string) => [h.players.get(id)!.depth, h.layer(id, "weapon").depth, h.layer(id, "armor").depth];
    await h.render(); groups.push([depths("front"), depths("back")]);
    h.players.remove("front");
    h.players.add("front", h.snapshot(0, 0, "hunting-blade", "padded-armor"));
    await h.render(); groups.push([depths("front"), depths("back")]);
    h.players.update("back", { ...h.snapshot(2, 3), tileX: 4 });
    await h.delay(150); await h.render(); groups.push([depths("front"), depths("back")]);
    h.players.update("back", h.snapshot(2, 3)); await h.delay(150); await h.render();
    return groups;
  });
  for (const [first, second] of groups) {
    expect(Math.max(...first!) < Math.min(...second!) || Math.max(...second!) < Math.min(...first!)).toBe(true);
  }
  await page.locator("canvas").screenshot({ path: testInfo.outputPath("equipment-overlapping-actors.png") });
});

test("unknown keys, transforms, rapid replacement and shutdown do not leak equipment", async ({ harness }) => {
  const result = await harness.evaluate(async h => {
    const body = h.players.add("unknown", h.snapshot(2, 0, "__proto__", "missing-armor"));
    await h.render();
    const unknown = { visible: body.visible, gear: h.layer("unknown", "weapon").visible || h.layer("unknown", "armor").visible };
    h.players.update("unknown", h.snapshot(2)); body.setAlpha(0.4).setAngle(17); await h.render();
    const transformed = { weapon: h.read(h.layer("unknown", "weapon")), armor: h.read(h.layer("unknown", "armor")) };
    body.setVisible(false); await h.render();
    const hidden = !h.layer("unknown", "weapon").visible && !h.layer("unknown", "armor").visible;
    h.players.remove("unknown");
    const texturesBefore = h.scene.textures.getTextureKeys().length;
    let maximum = 0;
    for (let index = 0; index < 100; index++) {
      h.players.add("rapid", h.snapshot(index % 2 === 0 ? 0 : 2));
      h.players.attack("rapid", 0);
      h.players.update("rapid", { ...h.snapshot(), tileX: 4 });
      maximum = Math.max(maximum, h.equipmentCount());
      h.players.remove("rapid");
    }
    h.players.add("replacement", h.snapshot()); h.players.attack("replacement", 0);
    h.players.add("replacement", h.snapshot(2, 1, "iron-blade", "leather-armor"));
    await h.delay(250); await h.render();
    const replaced = { count: h.equipmentCount(), weapon: h.layer("replacement", "weapon").texture.key };
    const textureGrowth = h.scene.textures.getTextureKeys().length - texturesBefore;
    h.scene.scene.stop(); await h.delay(50);
    return { unknown, transformed, hidden, maximum, replaced, textureGrowth, remaining: h.equipmentCount(),
      listeners: h.scene.events.listenerCount("postupdate"), originalListeners: h.originalListeners };
  });
  expect(result.unknown).toEqual({ visible: true, gear: false }); expect(result.hidden).toBe(true);
  expect(result.transformed.weapon.alpha).toBeCloseTo(0.4); expect(result.transformed.armor.angle).toBe(17);
  expect(result.maximum).toBe(2); expect(result.replaced).toEqual({ count: 2, weapon: "equipment:weapon:iron-blade" });
  expect(result.textureGrowth).toBe(0); expect(result.remaining).toBe(0); expect(result.listeners).toBeLessThanOrEqual(result.originalListeners);
});

test.describe("primary asset unavailable", () => {
  test.use({ fallback: true });
  test("heritage fallback keeps native attack attachment and gear after body clip finishes", async ({ harness, page }, testInfo) => {
    const result = await harness.evaluate(async h => {
      const state = h.snapshot(0, 2, "iron-blade", "reinforced-armor");
      const body = h.players.add("fallback", state);
      const source = body.texture.key;
      const attacked = h.players.attack("fallback", 2);
      await h.delay(90); await h.render();
      const during = { body: h.read(body), weapon: h.read(h.layer("fallback", "weapon")), armor: h.read(h.layer("fallback", "armor")) };
      await h.delay(600); await h.render();
      return { source, attacked, during, after: h.read(h.layer("fallback", "weapon")) };
    });
    expect(result.source).toContain("heritage-adventurer.png"); expect(result.attacked).toBe(true);
    expect(result.during.weapon.visible).toBe(true); expect(result.during.armor.visible).toBe(true);
    expect(Math.abs(result.during.armor.x - result.during.body.x)).toBeLessThan(1);
    expect(result.after.angle).toBe(30);
    await page.locator("canvas").screenshot({ path: testInfo.outputPath("equipment-heritage-fallback.png") });
  });
});
