import Phaser from "phaser";

/** Clears the avatar's head: the sprite is 32px tall above its origin at the feet. */
const NAME_TAG_OFFSET_Y = 34;
/** Above every avatar (whose depth is its y pixel), just under chat bubbles. */
const NAME_TAG_DEPTH = 9_999;
/** Extra vertical gap per stacked label, on top of the 2nd+ tag sharing an exact spot. */
const STACK_OFFSET_PX = 13;

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

    const text = this.scene.add.text(sprite.x, sprite.y - Math.max(NAME_TAG_OFFSET_Y, sprite.displayHeight * sprite.originY + 2), label, {
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
    this.layout();
  }

  /** Tracks the sprite every frame: it moves via tween, not by re-triggering `add`. */
  update(): void {
    this.layout();
  }

  remove(id: string): void {
    this.active.get(id)?.text.destroy();
    this.active.delete(id);
  }

  /**
   * Two tags land on the same pixel whenever their sprites share a spawn tile (spread 0 rooms
   * like `plaza`'s and `grand-plaza`'s home tile). Grouped by exact rounded position and stacked
   * upward from the 2nd label on, sorted by id so the stacking order never flickers between
   * frames — this has to re-run every frame, not just on `add()`, since a player can walk onto an
   * already-occupied tile well after both tags exist.
   *
   * Resets every label to its sprite baseline first so repeated calls (e.g. a synchronous burst
   * of `add()`s replaying already-in-view players) never compound a prior call's stack offset.
   */
  private layout(): void {
    for (const { text, sprite } of this.active.values()) {
      text.setPosition(sprite.x, sprite.y - Math.max(NAME_TAG_OFFSET_Y, sprite.displayHeight * sprite.originY + 2));
    }
    const groups = new Map<string, string[]>();
    for (const [id, { sprite }] of this.active) {
      const key = `${Math.round(sprite.x)},${Math.round(sprite.y)}`;
      const ids = groups.get(key);
      if (ids) {
        ids.push(id);
      } else {
        groups.set(key, [id]);
      }
    }
    for (const ids of groups.values()) {
      if (ids.length < 2) {
        continue;
      }
      ids.sort();
      // Different skins can have different heights. Stack the entire group above its tallest
      // member, or a short avatar's second label may overlap a tall avatar's first label.
      const top = Math.min(...ids.map(id => this.active.get(id)!.text.y));
      ids.forEach((id, index) => {
        const tracked = this.active.get(id);
        if (tracked) {
          tracked.text.y = top - index * STACK_OFFSET_PX;
        }
      });
    }
  }
}
