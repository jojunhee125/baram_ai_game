import Phaser from "phaser";
import { AVATAR_SKIN_COUNT, Direction, PATCH_RATE_MS, TILE_SIZE_PX } from "@zep-test/shared";
import type { PlayerSnapshot } from "../net/roomConnection";

export const AVATAR_TEXTURE = "avatar";

const FRAMES_PER_DIRECTION = 3;
const DIRECTIONS_PER_SKIN = 4;

/**
 * Slightly longer than the server patch interval so a step is still tweening when the
 * next position arrives — consecutive steps blend instead of flickering back to idle.
 */
export const STEP_TWEEN_MS = PATCH_RATE_MS + 20;

/** ~2 of the 4 cycle frames per tile step, which reads as one stride per tile. */
const WALK_FRAME_RATE = 16;

const ALL_DIRECTIONS: readonly Direction[] = [
  Direction.Down,
  Direction.Left,
  Direction.Right,
  Direction.Up,
];

interface TrackedPlayer {
  sprite: Phaser.GameObjects.Sprite;
  tween: Phaser.Tweens.Tween | null;
  skin: number;
  tileX: number;
  tileY: number;
  facing: Direction;
}

function directionBase(skin: number, facing: Direction): number {
  return (skin * DIRECTIONS_PER_SKIN + facing) * FRAMES_PER_DIRECTION;
}

function idleFrame(skin: number, facing: Direction): number {
  return directionBase(skin, facing) + 1;
}

function walkKey(skin: number, facing: Direction): string {
  return `walk-${skin}-${facing}`;
}

function pixelX(tileX: number): number {
  return tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2;
}

/** Origin is (0.5, 1), so y is the tile's bottom edge and the feet land on the grid line. */
function pixelY(tileY: number): number {
  return (tileY + 1) * TILE_SIZE_PX;
}

export function registerAvatarAnimations(scene: Phaser.Scene): void {
  for (let skin = 0; skin < AVATAR_SKIN_COUNT; skin += 1) {
    for (const facing of ALL_DIRECTIONS) {
      const key = walkKey(skin, facing);
      if (scene.anims.exists(key)) {
        continue;
      }
      const base = directionBase(skin, facing);
      scene.anims.create({
        key,
        frames: [base, base + 1, base + 2, base + 1].map((frame) => ({
          key: AVATAR_TEXTURE,
          frame,
        })),
        frameRate: WALK_FRAME_RATE,
        repeat: -1,
      });
    }
  }
}

/** Owns one sprite per visible player. Renders positions it is given; decides nothing. */
export class PlayerSprites {
  private readonly tracked = new Map<string, TrackedPlayer>();

  constructor(private readonly scene: Phaser.Scene) {}

  add(sessionId: string, snapshot: PlayerSnapshot): Phaser.GameObjects.Sprite {
    this.remove(sessionId);

    const sprite = this.scene.add.sprite(
      pixelX(snapshot.tileX),
      pixelY(snapshot.tileY),
      AVATAR_TEXTURE,
      idleFrame(snapshot.avatarSkin, snapshot.facing),
    );
    sprite.setOrigin(0.5, 1);
    // Depth by row so a player standing lower on the map overlaps one standing higher.
    sprite.setDepth(sprite.y);

    this.tracked.set(sessionId, {
      sprite,
      tween: null,
      skin: snapshot.avatarSkin,
      tileX: snapshot.tileX,
      tileY: snapshot.tileY,
      facing: snapshot.facing,
    });
    return sprite;
  }

  update(sessionId: string, snapshot: PlayerSnapshot): void {
    const player = this.tracked.get(sessionId);
    if (!player) {
      return;
    }

    // The server applies exactly one tile per accepted step, so anything further is not a walk:
    // it is a warp, or a correction after a throttled burst. Measured here rather than in the
    // teleport handler because `Teleported` only reaches the player who warped — everyone else
    // sees the same jump as a plain position change, and distance is what catches both.
    const distance = Math.max(
      Math.abs(snapshot.tileX - player.tileX),
      Math.abs(snapshot.tileY - player.tileY),
    );
    const turned = snapshot.facing !== player.facing;
    player.tileX = snapshot.tileX;
    player.tileY = snapshot.tileY;
    player.facing = snapshot.facing;

    if (distance > 0) {
      this.stepTo(player, distance > 1);
      return;
    }
    if (turned) {
      // A refused move still turns the player; nothing to tween, just face the new way.
      if (player.tween) {
        player.sprite.play(walkKey(player.skin, player.facing), true);
      } else {
        player.sprite.setFrame(idleFrame(player.skin, player.facing));
      }
    }
  }

  remove(sessionId: string): void {
    const player = this.tracked.get(sessionId);
    if (!player) {
      return;
    }
    player.tween?.stop();
    player.sprite.destroy();
    this.tracked.delete(sessionId);
  }

  get(sessionId: string): Phaser.GameObjects.Sprite | undefined {
    return this.tracked.get(sessionId)?.sprite;
  }

  private stepTo(player: TrackedPlayer, snap: boolean): void {
    player.tween?.stop();

    const targetY = pixelY(player.tileY);
    player.sprite.setDepth(targetY);

    if (snap) {
      player.tween = null;
      player.sprite.setPosition(pixelX(player.tileX), targetY);
      player.sprite.stop();
      player.sprite.setFrame(idleFrame(player.skin, player.facing));
      return;
    }

    // `true` keeps an already-running cycle going, so walking straight alternates feet
    // instead of restarting on the same frame every tile.
    player.sprite.play(walkKey(player.skin, player.facing), true);

    player.tween = this.scene.tweens.add({
      targets: player.sprite,
      x: pixelX(player.tileX),
      y: targetY,
      duration: STEP_TWEEN_MS,
      ease: "Linear",
      onComplete: () => {
        player.tween = null;
        player.sprite.stop();
        player.sprite.setFrame(idleFrame(player.skin, player.facing));
      },
    });
  }
}
