import Phaser from "phaser";

/** Clears the avatar's head: the sprite is 32px tall above its origin at the feet. */
const NAME_TAG_OFFSET_Y = 34;
/** Above every avatar (whose depth is its y pixel), just under chat bubbles. */
const NAME_TAG_DEPTH = 9_999;

interface TrackedNameTag {
  text: Phaser.GameObjects.Text;
  sprite: Phaser.GameObjects.Sprite;
}

/**
 * One persistent text label per tracked id, drawn above its sprite's head. Originally player
 * nicknames only; `WorldScene` runs a second, independent instance for monster kind names since
 * Phase B (2026-09-03) — both sit on the same 32px tile origin, so one offset serves either.
 */
export class NameTags {
  private readonly active = new Map<string, TrackedNameTag>();

  constructor(private readonly scene: Phaser.Scene) {}

  add(id: string, sprite: Phaser.GameObjects.Sprite, label: string): void {
    this.remove(id);

    const text = this.scene.add.text(sprite.x, sprite.y - NAME_TAG_OFFSET_Y, label, {
      fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif',
      // Sized against the 32x18 canvas: 11px shrank to ~17px on screen once the viewport
      // widened, below what the old 20x15 layout rendered at. Kept at 12px rather than 13px so
      // a tag stays inside its own tile column next to an adjacent avatar.
      fontSize: "12px",
      color: "#ffffff",
      stroke: "#23212a",
      strokeThickness: 3,
    });
    text.setOrigin(0.5, 1);
    text.setDepth(NAME_TAG_DEPTH);

    this.active.set(id, { text, sprite });
  }

  /** Tracks the sprite every frame: it moves via tween, not by re-triggering `add`. */
  update(): void {
    for (const { text, sprite } of this.active.values()) {
      text.setPosition(sprite.x, sprite.y - NAME_TAG_OFFSET_Y);
    }
  }

  remove(id: string): void {
    this.active.get(id)?.text.destroy();
    this.active.delete(id);
  }
}
