import Phaser from "phaser";

const BUBBLE_LIFETIME_MS = 4000;
/** Clears the avatar's head: the sprite is 26px tall above its origin at the feet. */
const BUBBLE_OFFSET_Y = 30;
/** Above every avatar, whose depth is its y pixel (max 480 on the plaza map). */
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
    const label = this.scene.add.text(sprite.x, sprite.y - BUBBLE_OFFSET_Y, body, {
      fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif',
      fontSize: "11px",
      color: "#23212a",
      backgroundColor: "#fdf7ea",
      padding: { x: 5, y: 3 },
      align: "center",
      wordWrap: { width: 150 },
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
      bubble.label.setPosition(bubble.sprite.x, bubble.sprite.y - BUBBLE_OFFSET_Y);
    }
  }

  remove(sessionId: string): void {
    this.active.get(sessionId)?.label.destroy();
    this.active.delete(sessionId);
  }
}
