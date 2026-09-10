import Phaser from "phaser";
import { Direction, TILE_SIZE_PX } from "@zep-test/shared";
import { ITEM_TEXTURE } from "./weaponVisual";

/** Long enough to register at 60fps, short enough not to hide the sprite it is describing. */
const HIT_FLASH_MS = 90;
/**
 * The flash and the death puff are the warm off-white the chat bubble uses, so a hit reads as
 * light rather than as a second palette arriving in the world.
 */
const FLASH_COLOR = 0xfdf7ea;

/** Radius of the swing arc, in pixels: just outside the avatar's own tile. */
const SWING_RADIUS_PX = 28;
/** Half-width of the arc, radians. ~40 degrees each way, so it reads as a cone, not a ring. */
const SWING_SPREAD = 0.7;
const SWING_MS = 240;
/**
 * The swing arc's own colour — never FLASH_COLOR. Stone floor (`#c9c2b4`) and grass (`#7fae5a`)
 * are both close in value to the off-white FLASH_COLOR, which is why the arc read as invisible;
 * this is a saturated gold, the same family as the existing `petalWarm` decal
 * (`tools/generate-assets.mjs`), and far enough from both terrain hues and from the red HP/damage
 * accent to not be mistaken for either.
 */
const SWING_COLOR = 0xffcc33;

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
 * How many sparks radiate per landed hit. Cheap primitives (a Phaser Arc, not a Text object like
 * the damage labels), so unlike MAX_DAMAGE_LABELS this needs no cap — even a crowded fight
 * landing several hits in one tick destroys every particle within IMPACT_PARTICLE_MS regardless.
 */
const IMPACT_PARTICLE_COUNT = 10;
const IMPACT_PARTICLE_RADIUS_PX = 18;
const IMPACT_PARTICLE_MS = 120;
const IMPACT_SHAKE_MS = 80;
/**
 * Phaser Camera.shake()'s own unit (fraction of the viewport). Small on purpose: legible once is
 * fine, legible on every ATTACK_COOLDOWN_MS (600ms) through a real fight is nauseating.
 */
const IMPACT_SHAKE_INTENSITY = 0.006;

/**
 * Transient combat visuals: the swing, the flash on a hit, the number that floats off it, and the
 * puff a monster leaves behind.
 *
 * Effects are detached objects; the attack pose only rotates the sprite, never its position,
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
   *
   * `weaponFrame` is optional: undefined draws the arc. Passed
   * when the local player has equipped `old-dagger` (`WeaponVisualState.hasOldDagger`), it also
   * overlays that item's `items.png` frame at the hand position — a cosmetic-only signal, no
   * damage or equip semantics attached.
   */
  swing(sprite: Phaser.GameObjects.Sprite, facing: Direction, weaponFrame?: number, attackPose = false): void {
    const centre = SWING_ANGLES[facing];
    const turn = facing === Direction.Left || facing === Direction.Up ? -1 : 1;
    if (!attackPose) this.scene.tweens.add({
      targets: sprite,
      angle: turn * 12,
      duration: 90,
      yoyo: true,
      ease: "Quad.easeOut",
    });
    const arc = this.scene.add.graphics();
    for (const [width, color] of [[7, 0x392817], [4, SWING_COLOR], [2, FLASH_COLOR]] as const) {
      arc.lineStyle(width, color, 1);
      arc.beginPath();
      arc.arc(0, 0, SWING_RADIUS_PX, centre - SWING_SPREAD, centre + SWING_SPREAD);
      arc.strokePath();
    }
    const centreY = sprite.y - sprite.displayHeight * 0.4;
    arc.setPosition(sprite.x, centreY);
    arc.setDepth(sprite.depth + 1);
    arc.setScale(0.8);
    arc.setRotation(-turn * 0.6);

    this.scene.tweens.add({
      targets: arc,
      alpha: 0,
      scaleX: 1.1,
      scaleY: 1.1,
      rotation: turn * 0.6,
      duration: SWING_MS,
      // easeIn, not easeOut: applied to an alpha fading 1->0, easeOut front-loads the drop (arc
      // reads as gone by ~40% of SWING_MS regardless of how long SWING_MS is) — easeIn holds it
      // near-opaque through most of the duration instead, so lengthening SWING_MS actually reads
      // as more visible (Pass F reviewer finding, 2026-09-02).
      ease: "Quad.easeIn",
      onUpdate: (tween: Phaser.Tweens.Tween) => {
        if (!sprite.active) {
          tween.stop();
          arc.destroy();
          return;
        }
        arc.setPosition(sprite.x, sprite.y - sprite.displayHeight * 0.4);
        arc.setDepth(sprite.depth + 1);
      },
      onComplete: () => arc.destroy(),
    });

    if (weaponFrame === undefined) {
      return;
    }
    const centreX = sprite.x;
    const angle = SWING_ANGLES[facing];
    const handRadius = SWING_RADIUS_PX * 0.5;
    const weapon = this.scene.add.sprite(
      centreX + Math.cos(angle) * handRadius,
      centreY + Math.sin(angle) * handRadius,
      ITEM_TEXTURE,
      weaponFrame,
    );
    weapon.setDepth(sprite.depth + 1);
    weapon.setScale(0.6);
    weapon.setRotation(centre - turn * 0.7);
    this.scene.tweens.add({
      targets: weapon,
      scale: 0.85,
      alpha: 0,
      rotation: centre + turn * 0.7,
      duration: SWING_MS,
      ease: "Quad.easeIn",
      onUpdate: (tween: Phaser.Tweens.Tween) => {
        if (!sprite.active) {
          tween.stop();
          weapon.destroy();
          return;
        }
        weapon.setPosition(sprite.x + Math.cos(angle) * handRadius,
          sprite.y - sprite.displayHeight * 0.4 + Math.sin(angle) * handRadius);
        weapon.setDepth(sprite.depth + 1);
      },
      onComplete: () => weapon.destroy(),
    });
  }

  /**
   * A landed hit: sparks off the target, plus a screen shake for a hit the local player is party to.
   * Called from the same site `flash()`/`damage()` already are — the swing arc (`swing()`, above) is
   * a different signal (registered the keypress) and is untouched by this.
   *
   * Colour reuses `DAMAGE_COLORS[tone]` rather than a parallel table: three hues already carry the
   * "whose hit" meaning, so a fourth constant per tone would be the same three values written twice.
   *
   * Shake is skipped for `"dealt-by-other"`: the camera follows the local player, and a fight with
   * several attackers on one monster would otherwise shake the screen for hits that are neither
   * yours nor aimed at you — the same muting `DAMAGE_COLORS["dealt-by-other"]` already applies to
   * the number.
   */
  impact(sprite: Phaser.GameObjects.Sprite, tone: DamageTone): void {
    const centreX = sprite.x;
    const centreY = sprite.y - TILE_SIZE_PX / 2;
    const color = Number.parseInt(DAMAGE_COLORS[tone].slice(1), 16);

    for (let i = 0; i < IMPACT_PARTICLE_COUNT; i += 1) {
      const angle = (i / IMPACT_PARTICLE_COUNT) * Math.PI * 2;
      const particle = this.scene.add.circle(centreX, centreY, 2, color);
      particle.setDepth(sprite.depth + 1);
      this.scene.tweens.add({
        targets: particle,
        x: centreX + Math.cos(angle) * IMPACT_PARTICLE_RADIUS_PX,
        y: centreY + Math.sin(angle) * IMPACT_PARTICLE_RADIUS_PX,
        alpha: 0,
        duration: IMPACT_PARTICLE_MS,
        ease: "Quad.easeOut",
        onComplete: () => particle.destroy(),
      });
    }

    if (tone !== "dealt-by-other") {
      this.scene.cameras.main.shake(IMPACT_SHAKE_MS, IMPACT_SHAKE_INTENSITY);
    }
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
    ghost.setOrigin(sprite.originX, sprite.originY);
    ghost.setScale(sprite.scaleX, sprite.scaleY);
    ghost.setFlip(sprite.flipX, sprite.flipY);
    ghost.setDepth(sprite.depth);
    ghost.setTint(FLASH_COLOR).setTintMode(Phaser.TintModes.FILL);

    this.scene.tweens.add({
      targets: ghost,
      alpha: 0,
      scaleX: sprite.scaleX * 1.3,
      scaleY: sprite.scaleY * 0.6,
      duration: DEATH_MS,
      ease: "Quad.easeOut",
      onComplete: () => ghost.destroy(),
    });
  }
}
