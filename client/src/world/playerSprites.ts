import Phaser from "phaser";
import { Direction, PATCH_RATE_MS, TILE_SIZE_PX, type AvatarAction } from "@zep-test/shared";
import type { PlayerSnapshot } from "../net/roomConnection";
import type { AvatarArt } from "./avatarArt";

/**
 * Slightly longer than the server patch interval so a step is still tweening when the
 * next position arrives — consecutive steps blend instead of flickering back to idle.
 */
export const STEP_TWEEN_MS = PATCH_RATE_MS + 20;

interface TrackedPlayer {
  sprite: Phaser.GameObjects.Sprite;
  attackTimer: Phaser.Time.TimerEvent | null;
  tween: Phaser.Tweens.Tween | null;
  skin: number;
  tileX: number;
  tileY: number;
  facing: Direction;
  level: number;
}

/** What one `update()` call found changed — today just the one thing a caller needs to react to. */
export interface PlayerUpdateResult {
  /** True when this patch's `level` differs from the one already tracked — the nameTag's cue to redraw. */
  levelChanged: boolean;
}

function pixelX(tileX: number): number {
  return tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2;
}

/** Origin is (0.5, 1), so y is the tile's bottom edge and the feet land on the grid line. */
function pixelY(tileY: number): number {
  return (tileY + 1) * TILE_SIZE_PX;
}

/** Owns one sprite per visible player. Renders positions it is given; decides nothing. */
export class PlayerSprites {
  private readonly tracked = new Map<string, TrackedPlayer>();

  constructor(private readonly scene: Phaser.Scene, private readonly art: AvatarArt) {
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const sessionId of this.tracked.keys()) this.remove(sessionId);
    });
  }

  add(sessionId: string, snapshot: PlayerSnapshot): Phaser.GameObjects.Sprite {
    this.remove(sessionId);

    const visual = this.art.resolve(snapshot.avatarSkin, "idle", snapshot.facing);
    if (!visual) throw new Error(`Avatar ${snapshot.avatarSkin} is unavailable`);
    const sprite = this.scene.add.sprite(
      pixelX(snapshot.tileX),
      pixelY(snapshot.tileY),
      "__DEFAULT",
    );
    this.art.apply(sprite, visual, visual.clip.frames.length > 1);
    // Depth by row so a player standing lower on the map overlaps one standing higher.
    sprite.setDepth(sprite.y);

    this.tracked.set(sessionId, {
      sprite,
      attackTimer: null,
      tween: null,
      skin: snapshot.avatarSkin,
      tileX: snapshot.tileX,
      tileY: snapshot.tileY,
      facing: snapshot.facing,
      level: snapshot.level,
    });
    return sprite;
  }

  update(sessionId: string, snapshot: PlayerSnapshot): PlayerUpdateResult {
    const player = this.tracked.get(sessionId);
    if (!player) {
      return { levelChanged: false };
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
    // `avatarSkin` never changed after join until the character menu (Phase H), so nothing here
    // ever read it past `add()` — a live change would otherwise render as the old skin forever,
    // until this player left and re-entered view.
    const skinChanged = snapshot.avatarSkin !== player.skin;
    // Read before overwriting below, same reason as skinChanged: the caller (WorldScene) redraws
    // the name tag on a change, and nothing here holds a sprite-visible cue for level the way skin
    // does, so the caller needs this flag rather than a texture diff of its own.
    const levelChanged = snapshot.level !== player.level;
    if (distance > 0 || turned || skinChanged) this.finishAttack(player);
    player.tileX = snapshot.tileX;
    player.tileY = snapshot.tileY;
    player.facing = snapshot.facing;
    player.skin = snapshot.avatarSkin;
    player.level = snapshot.level;
    if (distance > 0) {
      this.stepTo(player, distance > 1);
      return { levelChanged };
    }
    if (turned || skinChanged) {
      // A refused move still turns the player; nothing to tween, just face the new way.
      this.show(player, player.tween ? "walk" : "idle");
    }
    return { levelChanged };
  }

  remove(sessionId: string): void {
    const player = this.tracked.get(sessionId);
    if (!player) {
      return;
    }
    player.attackTimer?.remove(false);
    player.tween?.stop();
    player.sprite.destroy();
    this.tracked.delete(sessionId);
  }

  get(sessionId: string): Phaser.GameObjects.Sprite | undefined {
    return this.tracked.get(sessionId)?.sprite;
  }

  attack(sessionId: string, facing: Direction): boolean {
    const player = this.tracked.get(sessionId);
    if (!player) return false;
    const visual = this.art.resolve(player.skin, "attack", facing);
    if (!visual || visual.action !== "attack") return false;
    this.finishAttack(player);
    this.art.apply(player.sprite, visual, true);
    player.attackTimer = this.scene.time.delayedCall(visual.durationMs, () => this.finishAttack(player));
    return true;
  }

  private finishAttack(player: TrackedPlayer): void {
    if (!player.attackTimer) return;
    player.attackTimer.remove(false);
    player.attackTimer = null;
    if (!player.sprite.active) return;
    this.show(player, player.tween ? "walk" : "idle");
  }

  private show(player: TrackedPlayer, action: AvatarAction): void {
    const visual = this.art.resolve(player.skin, action, player.facing);
    if (!visual) throw new Error(`Avatar ${player.skin} has no ${action} clip`);
    this.art.apply(player.sprite, visual, action !== "idle" || visual.clip.frames.length > 1);
  }

  private stepTo(player: TrackedPlayer, snap: boolean): void {
    player.tween?.stop();

    const targetY = pixelY(player.tileY);
    player.sprite.setDepth(targetY);

    if (snap) {
      player.tween = null;
      player.sprite.setPosition(pixelX(player.tileX), targetY);
      this.show(player, "idle");
      return;
    }

    // `true` keeps an already-running cycle going, so walking straight alternates feet
    // instead of restarting on the same frame every tile.
    this.show(player, "walk");

    player.tween = this.scene.tweens.add({
      targets: player.sprite,
      x: pixelX(player.tileX),
      y: targetY,
      duration: STEP_TWEEN_MS,
      ease: "Linear",
      onComplete: () => {
        player.tween = null;
        if (player.attackTimer) return;
        this.show(player, "idle");
      },
    });
  }
}
