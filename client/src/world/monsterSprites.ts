import Phaser from "phaser";
import { Direction, TILE_SIZE_PX } from "@zep-test/shared";
import type { MonsterSnapshot } from "../net/roomConnection";

export const MONSTER_TEXTURE = "monster";

const FRAMES_PER_DIRECTION = 3;
const DIRECTIONS_PER_KIND = 4;

/**
 * The sheet's row blocks, in order; the index *is* the kindIndex baked into monster.png, so
 * **never reorder this** — a slime would draw bat frames. tools/generate-monster-art.mjs reads
 * this array, compares it against its own KINDS table and refuses to bake the sheet if they have
 * drifted, the same guard import-avatar.mjs puts on AVATAR_SKIN_COUNT.
 */
export const MONSTER_SPRITE_ORDER = ["slime", "bat"] as const;

/**
 * One tile of monster movement. Sized like STEP_TWEEN_MS — the shortest step interval any kind
 * uses, plus a margin — so consecutive chase steps blend instead of dropping back to idle between
 * tiles, while a wander step (over a second apart) finishes and rests.
 *
 * A per-kind value would be more precise and is deliberately not taken: the client holds no
 * monster stat table (design §8.3), so it uses the one bound that holds for every kind.
 */
export const MONSTER_STEP_TWEEN_MS = 420;

/** The avatar's 16fps is tuned to a 120ms step. This is the same two-frames-per-tile feel at 420. */
const MONSTER_WALK_FRAME_RATE = 5;

const ALL_DIRECTIONS: readonly Direction[] = [
  Direction.Down,
  Direction.Left,
  Direction.Right,
  Direction.Up,
];

interface TrackedMonster {
  sprite: Phaser.GameObjects.Sprite;
  tween: Phaser.Tweens.Tween | null;
  kindIndex: number;
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

function directionBase(kindIndex: number, facing: Direction): number {
  return (kindIndex * DIRECTIONS_PER_KIND + facing) * FRAMES_PER_DIRECTION;
}

function idleFrame(kindIndex: number, facing: Direction): number {
  return directionBase(kindIndex, facing) + 1;
}

function walkKey(kindIndex: number, facing: Direction): string {
  return `monster-walk-${kindIndex}-${facing}`;
}

function pixelX(tileX: number): number {
  return tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2;
}

/** Origin is (0.5, 1) like the avatar's, so monsters and players sort into one depth order. */
function pixelY(tileY: number): number {
  return (tileY + 1) * TILE_SIZE_PX;
}

export function registerMonsterAnimations(scene: Phaser.Scene): void {
  for (let kindIndex = 0; kindIndex < MONSTER_SPRITE_ORDER.length; kindIndex += 1) {
    for (const facing of ALL_DIRECTIONS) {
      const key = walkKey(kindIndex, facing);
      if (scene.anims.exists(key)) {
        continue;
      }
      const base = directionBase(kindIndex, facing);
      scene.anims.create({
        key,
        frames: [base, base + 1, base + 2, base + 1].map((frame) => ({
          key: MONSTER_TEXTURE,
          frame,
        })),
        frameRate: MONSTER_WALK_FRAME_RATE,
        repeat: -1,
      });
    }
  }
}

/**
 * Owns one sprite per visible monster, and nothing else. Deliberately a near-copy of
 * `PlayerSprites`: the two sheets share a layout, so the frame arithmetic is the same formula
 * with `skin` renamed, and folding them into one class would mean a renderer parameterised over
 * two textures, two animation namespaces and two tween lengths to save thirty lines.
 *
 * No name tags and no HP bars here — a monster carries nothing above its head, which is the
 * second thing (after the silhouette) telling a player which sprites are people.
 */
export class MonsterSprites {
  private readonly tracked = new Map<string, TrackedMonster>();

  constructor(private readonly scene: Phaser.Scene) {}

  add(monsterId: string, snapshot: MonsterSnapshot): Phaser.GameObjects.Sprite {
    this.remove(monsterId);

    const kindIndex = kindIndexOf(snapshot.kind);
    const sprite = this.scene.add.sprite(
      pixelX(snapshot.tileX),
      pixelY(snapshot.tileY),
      MONSTER_TEXTURE,
      idleFrame(kindIndex, snapshot.facing),
    );
    sprite.setOrigin(0.5, 1);
    sprite.setDepth(sprite.y);

    this.tracked.set(monsterId, {
      sprite,
      tween: null,
      kindIndex,
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
        monster.sprite.play(walkKey(monster.kindIndex, monster.facing), true);
      } else {
        monster.sprite.setFrame(idleFrame(monster.kindIndex, monster.facing));
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
      monster.sprite.setFrame(idleFrame(monster.kindIndex, monster.facing));
      return;
    }

    monster.sprite.play(walkKey(monster.kindIndex, monster.facing), true);

    monster.tween = this.scene.tweens.add({
      targets: monster.sprite,
      x: pixelX(monster.tileX),
      y: targetY,
      duration: MONSTER_STEP_TWEEN_MS,
      ease: "Linear",
      onComplete: () => {
        monster.tween = null;
        monster.sprite.stop();
        monster.sprite.setFrame(idleFrame(monster.kindIndex, monster.facing));
      },
    });
  }
}
