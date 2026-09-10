import Phaser from "phaser";
import { Direction, PATCH_RATE_MS, TILE_SIZE_PX } from "@zep-test/shared";
import type { MonsterSnapshot } from "../net/roomConnection";
import {
  prepareHeritageMonsterArt,
  type HeritageMonsterArt,
  type MonsterAppearance,
} from "./heritageMonsterArt";

export const MONSTER_TEXTURE = "monster";

const FRAMES_PER_DIRECTION = 3;
const DIRECTIONS_PER_KIND = 4;

/**
 * The sheet's row blocks, in order; the index *is* the kindIndex baked into monster.png, so
 * **never reorder this** — a squirrel would draw rabbit frames. tools/generate-monster-art.mjs
 * reads this array, compares it against its own KINDS table and refuses to bake the sheet if they
 * have drifted, the same guard import-avatar.mjs puts on AVATAR_SKIN_COUNT.
 */
export const MONSTER_SPRITE_ORDER = ["squirrel", "rabbit", "deer", "boss"] as const;

/** Catch up within one state-patch interval, rather than trailing the authoritative attack tile. */
export const MONSTER_STEP_TWEEN_MS = PATCH_RATE_MS;

/** Two animation frames per rendered tile step; server movement cadence remains unchanged. */
const MONSTER_WALK_FRAME_RATE = 2000 / MONSTER_STEP_TWEEN_MS;

const ALL_DIRECTIONS: readonly Direction[] = [
  Direction.Down,
  Direction.Left,
  Direction.Right,
  Direction.Up,
];

interface TrackedMonster {
  sprite: Phaser.GameObjects.Sprite;
  tween: Phaser.Tweens.Tween | null;
  art: MonsterAppearance;
  tileX: number;
  tileY: number;
  facing: Direction;
}

/**
 * Wire string to sheet row block. Unrecognised kinds fall back to the first block rather than
 * rendering nothing: the server can be newer than the browser holding this bundle (the reason
 * `Monster.kind` is a string at all), and an invisible monster that can still hit you is far
 * worse than one drawn with the wrong body.
 */
function kindIndexOf(kind: string): number {
  const index = (MONSTER_SPRITE_ORDER as readonly string[]).indexOf(kind);
  return index === -1 ? 0 : index;
}

/**
 * The wire value of the server's `MonsterKind.Boss`. Matched as a string rather than imported,
 * for {@link MONSTER_DISPLAY_NAMES}' reason: only `kind` crosses the wire (design §5.2), and the
 * monster type table it belongs to is server-side.
 */
const BOSS_KIND = "boss";

/** Wire string to Korean display label, for the name tag drawn above a monster's head. */
const MONSTER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  squirrel: "다람쥐",
  rabbit: "토끼",
  deer: "사슴",
  [BOSS_KIND]: "보스",
};

/**
 * The boss's label, or null for every other kind — and for `undefined`, which is what reading the
 * kind of a monster no longer in view gives. The one place the boss is told apart from the rest,
 * because it is the only difference the client makes: its health is drawn by `BossVitals` at the
 * top of the screen instead of by a bar over its head (`docs/design-phase-i-boss-monster.md`
 * §10-3), and that call needs the label anyway.
 */
export function bossDisplayName(kind: string | undefined): string | null {
  return kind === BOSS_KIND ? monsterDisplayName(BOSS_KIND) : null;
}

/**
 * Unlike {@link kindIndexOf}'s index-0 fallback (which has to pick *some* body to draw), an
 * unrecognised kind falls back to its own wire string here — labelling an unknown monster as
 * "다람쥐" would be a worse lie than an untranslated kind showing through.
 */
export function monsterDisplayName(kind: string): string {
  return MONSTER_DISPLAY_NAMES[kind] ?? kind;
}

function resolveMonsterVisual(art: HeritageMonsterArt, kind: string): MonsterAppearance {
  return art.get(kind) ?? {
    textureKey: MONSTER_TEXTURE,
    firstFrame: kindIndexOf(kind) * DIRECTIONS_PER_KIND * FRAMES_PER_DIRECTION,
    logicalCellPx: TILE_SIZE_PX,
    displayCellPx: TILE_SIZE_PX,
    feetY: TILE_SIZE_PX,
  };
}

function directionBase(art: MonsterAppearance, facing: Direction): number {
  return art.firstFrame + facing * FRAMES_PER_DIRECTION;
}

function idleFrame(art: MonsterAppearance, facing: Direction): number {
  return directionBase(art, facing) + 1;
}

function walkKey(art: MonsterAppearance, facing: Direction): string {
  const kindIndex = art.firstFrame / (DIRECTIONS_PER_KIND * FRAMES_PER_DIRECTION);
  return `${art.textureKey}-walk-${kindIndex}-${facing}`;
}

function pixelX(tileX: number): number {
  return tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2;
}

/** Origin is (0.5, 1) like the avatar's, so monsters and players sort into one depth order. */
function pixelY(tileY: number): number {
  return (tileY + 1) * TILE_SIZE_PX;
}

export function registerMonsterAnimations(
  scene: Phaser.Scene,
  appearances: HeritageMonsterArt = prepareHeritageMonsterArt(scene),
): void {
  for (const kind of MONSTER_SPRITE_ORDER) {
    const legacy = resolveMonsterVisual(new Map(), kind);
    const resolved = resolveMonsterVisual(appearances, kind);
    const variants = resolved.textureKey === MONSTER_TEXTURE ? [legacy] : [legacy, resolved];
    for (const art of variants) {
      for (const facing of ALL_DIRECTIONS) {
        const key = walkKey(art, facing);
        if (scene.anims.exists(key)) {
          continue;
        }
        const base = directionBase(art, facing);
        scene.anims.create({
          key,
          frames: [base, base + 1, base + 2, base + 1].map((frame) => ({
            key: art.textureKey,
            frame,
          })),
          frameRate: MONSTER_WALK_FRAME_RATE,
          repeat: -1,
        });
      }
    }
  }
}

/**
 * Owns one sprite per visible monster, and nothing else. Deliberately a near-copy of
 * `PlayerSprites`: the two sheets share a layout, so the frame arithmetic is the same formula
 * with `skin` renamed, and folding them into one class would mean a renderer parameterised over
 * two textures, two animation namespaces and two tween lengths to save thirty lines.
 *
 * No HP bars here — those only appear once a monster's been hit (`MonsterHealthBars`). Name tags
 * are drawn the same way, by `WorldScene`'s own `NameTags` instance using `monsterDisplayName()`
 * above: this class only owns the sprite, never what floats above it.
 *
 * Until Phase B (2026-09-03) a monster carried nothing above its head at all, which was the
 * second thing (after the silhouette) telling a player which sprites were people — traded away
 * deliberately for readability once players asked what they were fighting
 * (`docs/feasibility-review-2026-09-02-balance.md` §4-A).
 */
export class MonsterSprites {
  private readonly tracked = new Map<string, TrackedMonster>();

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly appearances: HeritageMonsterArt = prepareHeritageMonsterArt(scene),
  ) {}

  add(monsterId: string, snapshot: MonsterSnapshot): Phaser.GameObjects.Sprite {
    this.remove(monsterId);

    const art = resolveMonsterVisual(this.appearances, snapshot.kind);
    const sprite = this.scene.add.sprite(
      pixelX(snapshot.tileX),
      pixelY(snapshot.tileY),
      art.textureKey,
      idleFrame(art, snapshot.facing),
    );
    sprite.setDisplaySize(art.displayCellPx, art.displayCellPx);
    sprite.setOrigin(0.5, art.feetY / art.logicalCellPx);
    sprite.setDepth(sprite.y);

    this.tracked.set(monsterId, {
      sprite,
      tween: null,
      art,
      tileX: snapshot.tileX,
      tileY: snapshot.tileY,
      facing: snapshot.facing,
    });
    return sprite;
  }

  update(monsterId: string, snapshot: MonsterSnapshot): void {
    const monster = this.tracked.get(monsterId);
    if (!monster) {
      return;
    }

    // One accepted step is one tile, so anything further is a respawn reusing the same entry
    // rather than a walk — snap, the way the player renderer snaps a warp.
    const distance = Math.max(
      Math.abs(snapshot.tileX - monster.tileX),
      Math.abs(snapshot.tileY - monster.tileY),
    );
    const turned = snapshot.facing !== monster.facing;
    monster.tileX = snapshot.tileX;
    monster.tileY = snapshot.tileY;
    monster.facing = snapshot.facing;

    if (distance > 0) {
      this.stepTo(monster, distance > 1);
      return;
    }
    if (turned) {
      if (monster.tween) {
        monster.sprite.play(walkKey(monster.art, monster.facing), true);
      } else {
        monster.sprite.setFrame(idleFrame(monster.art, monster.facing));
      }
    }
  }

  /**
   * Death and leaving the view radius are the same removal here, because the state map makes them
   * the same event (design §5.2) — the death animation belongs to the `MonsterHit` that preceded
   * it, not to the entry disappearing.
   */
  remove(monsterId: string): void {
    const monster = this.tracked.get(monsterId);
    if (!monster) {
      return;
    }
    monster.tween?.stop();
    monster.sprite.destroy();
    this.tracked.delete(monsterId);
  }

  get(monsterId: string): Phaser.GameObjects.Sprite | undefined {
    return this.tracked.get(monsterId)?.sprite;
  }

  private stepTo(monster: TrackedMonster, snap: boolean): void {
    monster.tween?.stop();

    const targetY = pixelY(monster.tileY);
    monster.sprite.setDepth(targetY);

    if (snap) {
      monster.tween = null;
      monster.sprite.setPosition(pixelX(monster.tileX), targetY);
      monster.sprite.stop();
      monster.sprite.setFrame(idleFrame(monster.art, monster.facing));
      return;
    }

    monster.sprite.play(walkKey(monster.art, monster.facing), true);

    monster.tween = this.scene.tweens.add({
      targets: monster.sprite,
      x: pixelX(monster.tileX),
      y: targetY,
      duration: MONSTER_STEP_TWEEN_MS,
      ease: "Linear",
      onComplete: () => {
        monster.tween = null;
        monster.sprite.stop();
        monster.sprite.setFrame(idleFrame(monster.art, monster.facing));
      },
    });
  }
}
