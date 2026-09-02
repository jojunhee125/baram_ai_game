import Phaser from "phaser";
import { Direction, TILE_SIZE_PX } from "@zep-test/shared";

/** Long enough to register at 60fps, short enough not to hide the sprite it is describing. */
const HIT_FLASH_MS = 90;
/**
 * The flash and the death puff are the warm off-white the chat bubble uses, so a hit reads as
 * light rather than as a second palette arriving in the world.
 */
const FLASH_COLOR = 0xfdf7ea;

/** Radius of the swing arc, in pixels: just outside the avatar's own tile. */
const SWING_RADIUS_PX = 20;
/** Half-width of the arc, radians. ~40 degrees each way, so it reads as a cone, not a ring. */
const SWING_SPREAD = 0.7;
const SWING_MS = 200;

const DEATH_MS = 320;

const DAMAGE_RISE_PX = 22;
const DAMAGE_MS = 620;
/**
 * A ceiling on live damage labels. Every label is a Text object, i.e. its own canvas texture, and
 * a crowded spawn point can deliver hits from several attackers at once — past a dozen they are
 * unreadable anyway, so the oldest goes rather than the frame rate.
 */
const MAX_DAMAGE_LABELS = 12;

/** Above the health bars and every sprite, below the name tags. */
const DAMAGE_DEPTH = 9_995;

/** Screen-space angle the player is facing; y grows downwards, so Up is negative. */
const SWING_ANGLES: Readonly<Record<Direction, number>> = {
  [Direction.Down]: Math.PI / 2,
  [Direction.Left]: Math.PI,
  [Direction.Right]: 0,
  [Direction.Up]: -Math.PI / 2,
};

/**
 * Who a damage number belongs to. The colours are the only place `MonsterHit.bySessionId` shows
 * up on screen: your own hits read bright, someone else's stay muted, and damage you took is the
 * danger hue — so a busy spawn point still tells you which numbers are yours.
 */
export type DamageTone = "dealt" | "dealt-by-other" | "taken";

const DAMAGE_COLORS: Readonly<Record<DamageTone, string>> = {
  dealt: "#fdf7ea",
  "dealt-by-other": "#b9b5c6",
  taken: "#e0806f",
};

/**
 * Transient combat visuals: the swing, the flash on a hit, the number that floats off it, and the
 * puff a monster leaves behind.
 *
 * Every one of these is a detached object rather than something done *to* the sprite's position,
 * for two reasons. The sprite's x/y already belong to the step tween, so a second tween on them
 * would fight it and could strand an avatar off its tile. And a monster's death arrives in the
 * same tick as the state deletion that destroys its sprite, so an animation played on the sprite
 * would be cut off a frame later — the puff has to outlive the thing that died.
 *
 * Holds no listeners and no DOM, so it has no `destroy()`: Phaser clears the display list, the
 * tweens and the timers of a scene it restarts, which is the only way this object goes away.
 */
export class CombatEffects {
  private readonly damageLabels = new Set<Phaser.GameObjects.Text>();

  constructor(private readonly scene: Phaser.Scene) {}

  /**
   * The local player's own swing, drawn whether or not anything was in range: an empty swing gets
   * no reply from the server (design §6.1), so this is the only feedback that the key registered.
   */
  swing(sprite: Phaser.GameObjects.Sprite, facing: Direction): void {
    const centre = SWING_ANGLES[facing];
    const arc = this.scene.add.graphics();
    arc.lineStyle(3, FLASH_COLOR, 0.9);
    arc.beginPath();
    arc.arc(0, 0, SWING_RADIUS_PX, centre - SWING_SPREAD, centre + SWING_SPREAD);
    arc.strokePath();
    arc.setPosition(sprite.x, sprite.y - TILE_SIZE_PX / 2);
    arc.setDepth(sprite.depth + 1);
    arc.setScale(0.72);

    this.scene.tweens.add({
      targets: arc,
      alpha: 0,
      scaleX: 1.1,
      scaleY: 1.1,
      duration: SWING_MS,
      ease: "Quad.easeOut",
      onComplete: () => arc.destroy(),
    });
  }

  /** Whitens a sprite for a moment. Which sprite took the hit is the whole message. */
  flash(sprite: Phaser.GameObjects.Sprite): void {
    sprite.setTint(FLASH_COLOR).setTintMode(Phaser.TintModes.FILL);
    this.scene.time.delayedCall(HIT_FLASH_MS, () => {
      if (sprite.active) {
        // The mode has to go back with the colour: `clearTint` alone leaves a white FILL, which
        // is the flash made permanent.
        sprite.clearTint().setTintMode(Phaser.TintModes.MULTIPLY);
      }
    });
  }

  /** One number, rising off the sprite it belongs to and fading out. */
  damage(sprite: Phaser.GameObjects.Sprite, amount: number, tone: DamageTone): void {
    // A Set iterates in insertion order, so the first entry is the oldest label on screen.
    for (const oldest of this.damageLabels) {
      if (this.damageLabels.size < MAX_DAMAGE_LABELS) {
        break;
      }
      this.damageLabels.delete(oldest);
      oldest.destroy();
    }

    const label = this.scene.add.text(sprite.x, sprite.y - TILE_SIZE_PX, String(amount), {
      fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif',
      fontSize: "13px",
      fontStyle: "bold",
      color: DAMAGE_COLORS[tone],
      stroke: "#23212a",
      strokeThickness: 3,
    });
    label.setOrigin(0.5, 1);
    label.setDepth(DAMAGE_DEPTH);
    this.damageLabels.add(label);

    this.scene.tweens.add({
      targets: label,
      y: label.y - DAMAGE_RISE_PX,
      alpha: 0,
      duration: DAMAGE_MS,
      ease: "Quad.easeOut",
      onComplete: () => {
        this.damageLabels.delete(label);
        label.destroy();
      },
    });
  }

  /**
   * The puff left where something died: a detached copy of the sprite's current frame, whitened,
   * squashing towards its feet as it fades. Detached because the sprite itself is about to be
   * destroyed by the state deletion that follows the same hit (design §5.2).
   */
  death(sprite: Phaser.GameObjects.Sprite): void {
    const ghost = this.scene.add.sprite(sprite.x, sprite.y, sprite.texture.key, sprite.frame.name);
    ghost.setOrigin(0.5, 1);
    ghost.setDepth(sprite.depth);
    ghost.setTint(FLASH_COLOR).setTintMode(Phaser.TintModes.FILL);

    this.scene.tweens.add({
      targets: ghost,
      alpha: 0,
      scaleX: 1.3,
      scaleY: 0.6,
      duration: DEATH_MS,
      ease: "Quad.easeOut",
      onComplete: () => ghost.destroy(),
    });
  }
}
