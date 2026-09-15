import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLegacyAvatarManifests,
  resolveAvatarClip,
  validateAvatarManifest,
} from "./avatarManifest";
import type { AvatarAction, AvatarClip, AvatarFrame, AvatarManifest } from "./avatarManifest";
import { Direction } from "./geometry";

const directions = [Direction.Down, Direction.Left, Direction.Right, Direction.Up] as const;
const actionCounts = { idle: 1, walk: 4, attack: 3, cast: 3, hit: 1, death: 3 } as const;
const actions = Object.keys(actionCounts) as AvatarAction[];

function nativeManifest(skinId = 0): AvatarManifest {
  const frames: Record<string, AvatarFrame> = {};
  const definitions = {} as Record<AvatarAction, { directions: Record<Direction, AvatarClip> }>;
  let index = 0;
  for (const action of actions) {
    const clips = {} as Record<Direction, AvatarClip>;
    for (const direction of directions) {
      const clipFrames = [];
      for (let pose = 0; pose < actionCounts[action]; pose++) {
        const name = `${action}-${direction}-${pose}`;
        frames[name] = {
          texture: "native",
          rect: { x: (index % 10) * 48, y: Math.floor(index / 10) * 48, width: 48, height: 48 },
          foot: { x: 24, y: 46 },
          hands: { left: { x: 12, y: 24 }, right: { x: 36, y: 24 } },
        };
        index++;
        clipFrames.push({ frame: name, durationMs: action === "walk" ? 62.5 : 100 });
      }
      clips[direction] = { frames: clipFrames, loop: action === "walk" };
    }
    definitions[action] = { directions: clips };
  }
  return {
    version: 1,
    skinId,
    format: "native60",
    nativeSize: { width: 48, height: 48 },
    displaySize: { width: 48, height: 48 },
    textures: { native: { path: "/sprites/synthetic-native60.png", width: 480, height: 288 } },
    frames,
    actions: definitions,
    layerOrder: ["composite"],
  };
}

function legacy(skinId = 0): AvatarManifest {
  const manifest = createLegacyAvatarManifests().find((entry) => entry.skinId === skinId);
  assert.ok(manifest);
  return manifest;
}

function clip(manifest: AvatarManifest, action: AvatarAction, direction: Direction): AvatarClip {
  const result = resolveAvatarClip(manifest, manifest, action, direction);
  assert.ok(result);
  return result.clip;
}

function atlasIndices(manifest: AvatarManifest, value: AvatarClip): number[] {
  return value.frames.map(({ frame: name }) => {
    const frame = manifest.frames[name];
    assert.ok(frame);
    const texture = manifest.textures[frame.texture];
    assert.ok(texture);
    return frame.rect.y / frame.rect.height * (texture.width / frame.rect.width)
      + frame.rect.x / frame.rect.width;
  });
}

describe("legacy avatar compatibility", () => {
  it("preserves all 24 stable skin IDs and validates every generated manifest", () => {
    const manifests = createLegacyAvatarManifests();
    assert.deepEqual(manifests.map((entry) => entry.skinId), Array.from({ length: 24 }, (_, id) => id));
    for (const manifest of manifests) {
      assert.deepEqual(validateAvatarManifest(manifest), [], `skin ${manifest.skinId}`);
      assert.equal(manifest.format, "legacy12");
      assert.deepEqual(manifest.layerOrder, ["composite"]);
      assert.deepEqual(manifest.nativeSize, manifest.skinId === 0
        ? { width: 362, height: 362 } : { width: 16, height: 16 });
      assert.deepEqual(manifest.displaySize, manifest.skinId === 0
        ? { width: 48, height: 48 } : { width: 32, height: 32 });
      for (const frame of Object.values(manifest.frames)) {
        assert.equal(frame.foot.x, manifest.skinId === 0 ? 181 : 16);
        assert.ok(Math.abs(frame.foot.y - (manifest.skinId === 0 ? 347.52 : 32)) < 1e-9);
        assert.equal(frame.hands, undefined);
      }
    }
  });

  it("preserves every ordinary atlas row, idle pose and 16 fps walk", () => {
    for (let skinId = 1; skinId < 24; skinId++) {
      const manifest = legacy(skinId);
      for (const direction of directions) {
        const base = skinId * 12 + direction * 3;
        assert.deepEqual(atlasIndices(manifest, clip(manifest, "idle", direction)), [base + 1]);
        const walk = clip(manifest, "walk", direction);
        assert.deepEqual(atlasIndices(manifest, walk), [base, base + 1, base + 2, base + 1]);
        assert.equal(walk.loop, true);
        assert.deepEqual(walk.frames.map((frame) => frame.durationMs), [62.5, 62.5, 62.5, 62.5]);
      }
    }
  });

  it("preserves heritage side-pose correction and separate 300 ms attack atlas", () => {
    const manifest = legacy();
    const walks = [[0, 1, 2, 1], [3, 4, 8, 4], [6, 7, 5, 7], [9, 10, 11, 10]];
    for (const direction of directions) {
      const walk = clip(manifest, "walk", direction);
      assert.deepEqual(atlasIndices(manifest, walk), walks[direction]);
      assert.ok(walk.frames.every((frame) => frame.durationMs === 62.5));
      const attack = clip(manifest, "attack", direction);
      assert.deepEqual(atlasIndices(manifest, attack), walks[direction]?.slice(0, 3));
      assert.equal(attack.loop, false);
      assert.deepEqual(attack.frames.map((frame) => frame.durationMs), [100, 100, 100]);
      for (const { frame: name } of attack.frames) {
        const frame = manifest.frames[name]!;
        assert.equal(manifest.textures[frame.texture]?.path, "/sprites/classic-adventurer-attack.png");
      }
    }
  });
});

describe("native and legacy clip resolution", () => {
  it("supports all 60 authored poses across six actions and four directions", () => {
    const primary = nativeManifest();
    assert.equal(Object.keys(primary.frames).length, 60);
    assert.deepEqual(validateAvatarManifest(primary), []);
    for (const action of actions) {
      for (const direction of directions) {
        const result = resolveAvatarClip(primary, legacy(), action, direction, () => true);
        assert.ok(result);
        assert.equal(result.manifest, primary);
        assert.equal(result.action, action);
        assert.deepEqual(result.clip.frames.map((frame) => frame.frame),
          Array.from({ length: actionCounts[action] }, (_, pose) => `${action}-${direction}-${pose}`));
      }
    }
  });

  it("allows partial native production with explicit idle fallback", () => {
    const complete = nativeManifest();
    const primary: AvatarManifest = {
      ...complete,
      frames: Object.fromEntries(Object.entries(complete.frames).filter(([name]) => /^(idle|walk)-/.test(name))),
      actions: { ...complete.actions, attack: { fallback: "idle" }, cast: { fallback: "idle" },
        hit: { fallback: "idle" }, death: { fallback: "idle" } },
    };
    assert.deepEqual(validateAvatarManifest(primary), []);
    for (const action of ["attack", "cast", "hit", "death"] as const) {
      const result = resolveAvatarClip(primary, legacy(), action, Direction.Up);
      assert.ok(result);
      assert.equal(result.manifest, primary);
      assert.equal(result.action, "idle");
      assert.equal(result.clip.frames[0]?.frame, "idle-3-0");
    }
  });

  it("retries the requested action on the same legacy skin when native texture is unavailable", () => {
    const original = nativeManifest();
    const primary: AvatarManifest = { ...original, actions: { ...original.actions, attack: { fallback: "idle" } } };
    const fallback = legacy();
    const result = resolveAvatarClip(primary, fallback, "attack", Direction.Left,
      (path) => !path.includes("synthetic-native60"));
    assert.ok(result);
    assert.equal(result.manifest, fallback);
    assert.equal(result.action, "attack");
    assert.deepEqual(atlasIndices(fallback, result.clip), [3, 4, 8]);
  });

  it("follows legacy action fallback when the same skin has no attack art", () => {
    const fallback = legacy(23);
    const result = resolveAvatarClip(nativeManifest(23), fallback, "attack", Direction.Right,
      (path) => !path.includes("synthetic-native60"));
    assert.ok(result);
    assert.equal(result.manifest, fallback);
    assert.equal(result.action, "idle");
    assert.deepEqual(atlasIndices(fallback, result.clip), [283]);
  });

  it("never changes skin identity to obtain a fallback texture", () => {
    assert.equal(resolveAvatarClip(nativeManifest(0), legacy(1), "walk", Direction.Down,
      (path) => !path.includes("synthetic-native60")), null);
    const primary = nativeManifest(0);
    assert.equal(resolveAvatarClip(primary, legacy(1), "walk", Direction.Down)?.manifest, primary);
  });

  it("returns null for wholly unavailable textures or absent manifests", () => {
    assert.equal(resolveAvatarClip(nativeManifest(), legacy(), "attack", Direction.Down, () => false), null);
    assert.equal(resolveAvatarClip(null, undefined, "idle", Direction.Down), null);
    const fallback = legacy();
    assert.equal(resolveAvatarClip(undefined, fallback, "walk", Direction.Left)?.manifest, fallback);
  });

  it("handles repeated interleaved resolutions without mutating inputs or sharing state", async () => {
    const primary = nativeManifest();
    const fallback = legacy();
    const before = JSON.stringify([primary, fallback]);
    const results = await Promise.all(Array.from({ length: 2000 }, async (_, index) => {
      const available = index % 2 === 0;
      const result = resolveAvatarClip(primary, fallback, "walk", Direction.Left,
        (path) => available || !path.includes("synthetic-native60"));
      assert.equal(result?.manifest, available ? primary : fallback);
    }));
    assert.equal(results.length, 2000);
    assert.equal(JSON.stringify([primary, fallback]), before);
    assert.deepEqual(createLegacyAvatarManifests(), createLegacyAvatarManifests());
  });
});

describe("manifest validation rejects malformed authored data", () => {
  const cases: [string, (manifest: AvatarManifest) => AvatarManifest][] = [
    ["negative skin ID", (m) => ({ ...m, skinId: -1 })],
    ["fractional skin ID", (m) => ({ ...m, skinId: 0.5 })],
    ["nonfinite display size", (m) => ({ ...m, displaySize: { width: Infinity, height: 48 } })],
    ["empty texture path", (m) => ({ ...m, textures: { native: { ...m.textures.native!, path: "" } } })],
    ["missing texture reference", (m) => ({ ...m, frames: { ...m.frames,
      "idle-0-0": { ...m.frames["idle-0-0"]!, texture: "missing" } } })],
    ["negative rectangle origin", (m) => ({ ...m, frames: { ...m.frames,
      "idle-0-0": { ...m.frames["idle-0-0"]!, rect: { x: -1, y: 0, width: 48, height: 48 } } } })],
    ["rectangle beyond atlas edge", (m) => ({ ...m, frames: { ...m.frames,
      "idle-0-0": { ...m.frames["idle-0-0"]!, rect: { x: 433, y: 0, width: 48, height: 48 } } } })],
    ["zero-sized rectangle", (m) => ({ ...m, frames: { ...m.frames,
      "idle-0-0": { ...m.frames["idle-0-0"]!, rect: { x: 0, y: 0, width: 0, height: 48 } } } })],
    ["nonfinite foot", (m) => ({ ...m, frames: { ...m.frames,
      "idle-0-0": { ...m.frames["idle-0-0"]!, foot: { x: NaN, y: 48 } } } })],
    ["action fallback cycle", (m) => ({ ...m, actions: { ...m.actions,
      attack: { fallback: "cast" }, cast: { fallback: "attack" } } })],
  ];
  for (const [name, corrupt] of cases) {
    it(name, () => assert.ok(validateAvatarManifest(corrupt(nativeManifest())).length > 0));
  }

  for (const [name, frames] of [
    ["missing frame reference", [{ frame: "missing", durationMs: 100 }]],
    ["zero duration", [{ frame: "idle-0-0", durationMs: 0 }]],
    ["negative duration", [{ frame: "idle-0-0", durationMs: -1 }]],
    ["nonfinite duration", [{ frame: "idle-0-0", durationMs: Infinity }]],
    ["empty clip", []],
  ] as const) {
    it(name, () => {
      const primary = nativeManifest();
      const idle = primary.actions.idle;
      assert.ok("directions" in idle);
      const malformed: AvatarManifest = { ...primary, actions: { ...primary.actions,
        idle: { directions: { ...idle.directions, [Direction.Down]: { frames, loop: false } } } } };
      assert.ok(validateAvatarManifest(malformed).length > 0);
    });
  }

  it("terminates cyclic fallbacks and recovers using valid legacy", () => {
    const original = nativeManifest();
    const cyclic: AvatarManifest = { ...original, actions: { ...original.actions,
      attack: { fallback: "cast" }, cast: { fallback: "attack" } } };
    const fallback = legacy();
    assert.equal(resolveAvatarClip(cyclic, fallback, "attack", Direction.Left)?.manifest, fallback);
    assert.equal(resolveAvatarClip(cyclic, cyclic, "attack", Direction.Left), null);
  });
});
