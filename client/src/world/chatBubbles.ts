import Phaser from "phaser";

const BUBBLE_LIFETIME_MS = 4000;
/** Clears the avatar's head and the persistent name tag drawn just above it. */
const BUBBLE_OFFSET_Y = 50;
/** Above every avatar, whose depth is its y pixel (max 4,704 on grand-plaza). */
const BUBBLE_DEPTH = 10_000;
const MAX_BUBBLE_CHARS = 80;

interface ActiveBubble {
  label: Phaser.GameObjects.Text;
  sprite: Phaser.GameObjects.Sprite;
  expiresAt: number;
}

/** One transient speech bubble per player, drawn in-canvas so it tracks the camera. */
export class ChatBubbles {
  private readonly active = new Map<string, ActiveBubble>();

  constructor(private readonly scene: Phaser.Scene) {}

  show(sessionId: string, sprite: Phaser.GameObjects.Sprite, text: string): void {
    this.active.get(sessionId)?.label.destroy();

    const body = text.length > MAX_BUBBLE_CHARS ? `${text.slice(0, MAX_BUBBLE_CHARS)}…` : text;
    const label = this.scene.add.text(sprite.x, sprite.y - Math.max(BUBBLE_OFFSET_Y, sprite.displayHeight * sprite.originY + 18), body, {
      fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif',
      // Matches the name tag: see nameTags.ts for why 12px and not 13px.
      fontSize: "12px",
      color: "#23212a",
      backgroundColor: "#fdf7ea",
      padding: { x: 5, y: 3 },
      align: "center",
      wordWrap: { width: 150, useAdvancedWrap: true },
    });
    label.setOrigin(0.5, 1);
    label.setDepth(BUBBLE_DEPTH);

    this.active.set(sessionId, {
      label,
      sprite,
      expiresAt: this.scene.time.now + BUBBLE_LIFETIME_MS,
    });
  }

  update(now: number): void {
    for (const [sessionId, bubble] of this.active) {
      if (now >= bubble.expiresAt || !bubble.sprite.active) {
        bubble.label.destroy();
        this.active.delete(sessionId);
        continue;
      }
      bubble.label.setPosition(bubble.sprite.x, bubble.sprite.y - Math.max(BUBBLE_OFFSET_Y, bubble.sprite.displayHeight * bubble.sprite.originY + 18));
    }
  }

  remove(sessionId: string): void {
    this.active.get(sessionId)?.label.destroy();
    this.active.delete(sessionId);
  }
}
