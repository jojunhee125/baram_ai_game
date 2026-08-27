import Phaser from "phaser";

/** Clears the avatar's head: the sprite is 32px tall above its origin at the feet. */
const NAME_TAG_OFFSET_Y = 34;
/** Above every avatar (whose depth is its y pixel), just under chat bubbles. */
const NAME_TAG_DEPTH = 9_999;

interface TrackedNameTag {
  label: Phaser.GameObjects.Text;
  sprite: Phaser.GameObjects.Sprite;
}

/** One persistent nickname label per player, drawn above the avatar's head. */
export class NameTags {
  private readonly active = new Map<string, TrackedNameTag>();

  constructor(private readonly scene: Phaser.Scene) {}

  add(sessionId: string, sprite: Phaser.GameObjects.Sprite, nickname: string): void {
    this.remove(sessionId);

    const label = this.scene.add.text(sprite.x, sprite.y - NAME_TAG_OFFSET_Y, nickname, {
      fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif',
      // Sized against the 32x18 canvas: 11px shrank to ~17px on screen once the viewport
      // widened, below what the old 20x15 layout rendered at. Kept at 12px rather than 13px so
      // a tag stays inside its own tile column next to an adjacent avatar.
      fontSize: "12px",
      color: "#ffffff",
      stroke: "#23212a",
      strokeThickness: 3,
    });
    label.setOrigin(0.5, 1);
    label.setDepth(NAME_TAG_DEPTH);

    this.active.set(sessionId, { label, sprite });
  }

  /** Tracks the sprite every frame: it moves via tween, not by re-triggering `add`. */
  update(): void {
    for (const { label, sprite } of this.active.values()) {
      label.setPosition(sprite.x, sprite.y - NAME_TAG_OFFSET_Y);
    }
  }

  remove(sessionId: string): void {
    this.active.get(sessionId)?.label.destroy();
    this.active.delete(sessionId);
  }
}
