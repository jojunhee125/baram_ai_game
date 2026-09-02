import Phaser from "phaser";

/** Canvas pixels, not tiles: a bar has to stay readable whatever the sprite underneath is. */
const BAR_WIDTH_PX = 26;
const BAR_HEIGHT_PX = 4;
/** Clears the monster's head. Two pixels above where a name tag would sit, which monsters lack. */
const BAR_OFFSET_Y = 36;

const BAR_BACKDROP = 0x14131a;
const BAR_TRACK = 0x3a3950;
/** A state colour, deliberately outside the interface's single accent hue. */
const BAR_FILL = 0xd4674f;

/** Above every sprite (whose depth is its y pixel), below the damage numbers and the name tags. */
const BAR_DEPTH = 9_990;

interface TrackedBar {
  graphics: Phaser.GameObjects.Graphics;
  sprite: Phaser.GameObjects.Sprite;
  /** Last drawn fill fraction, so a bar is only redrawn when its length actually changes. */
  ratio: number;
}

/**
 * One health bar per monster that has been hit at least once.
 *
 * "At least once" is the whole rule, and it is not an optimisation. `Monster` carries no HP, so a
 * `MonsterHit` is the only way health ever reaches this client (design §5.2) — a monster nobody
 * has swung at has no number to draw, and inventing one from a client-side stat table is exactly
 * what that design keeps out. The bar appearing on the first hit is therefore the honest
 * rendering of what the client knows, and it happens to match how the genre reads.
 */
export class MonsterHealthBars {
  private readonly bars = new Map<string, TrackedBar>();

  constructor(private readonly scene: Phaser.Scene) {}

  /**
   * Records a hit against `monsterId` and draws (or grows) its bar. `hpMax` rides in on every hit
   * for that reason: the scale is the server's to state, never this bundle's to remember.
   */
  applyHit(
    monsterId: string,
    sprite: Phaser.GameObjects.Sprite,
    hpRemaining: number,
    hpMax: number,
  ): void {
    const ratio = hpMax > 0 ? Math.max(0, Math.min(1, hpRemaining / hpMax)) : 0;
    const existing = this.bars.get(monsterId);
    if (existing) {
      existing.sprite = sprite;
      if (existing.ratio !== ratio) {
        existing.ratio = ratio;
        draw(existing.graphics, ratio);
      }
      return;
    }

    const graphics = this.scene.add.graphics();
    graphics.setDepth(BAR_DEPTH);
    graphics.setPosition(sprite.x, sprite.y - BAR_OFFSET_Y);
    draw(graphics, ratio);
    this.bars.set(monsterId, { graphics, sprite, ratio });
  }

  /** Called every frame: the sprite moves by tween, so the bar has to ride along with it. */
  update(): void {
    for (const [monsterId, bar] of this.bars) {
      if (!bar.sprite.active) {
        // The sprite went while its removal was still in flight; a bar hanging in empty space
        // reads as a monster that is there and invisible.
        bar.graphics.destroy();
        this.bars.delete(monsterId);
        continue;
      }
      bar.graphics.setPosition(bar.sprite.x, bar.sprite.y - BAR_OFFSET_Y);
    }
  }

  /**
   * Drops the bar. Called for death, for leaving the view radius, and for a respawn reusing the
   * id — all three mean the next thing under that id has not been hit yet.
   */
  remove(monsterId: string): void {
    this.bars.get(monsterId)?.graphics.destroy();
    this.bars.delete(monsterId);
  }
}

/** Local coordinates: the graphics object itself is positioned over the sprite each frame. */
function draw(graphics: Phaser.GameObjects.Graphics, ratio: number): void {
  const left = -BAR_WIDTH_PX / 2;
  graphics.clear();
  graphics.fillStyle(BAR_BACKDROP, 0.85);
  graphics.fillRect(left - 1, -1, BAR_WIDTH_PX + 2, BAR_HEIGHT_PX + 2);
  graphics.fillStyle(BAR_TRACK, 1);
  graphics.fillRect(left, 0, BAR_WIDTH_PX, BAR_HEIGHT_PX);
  if (ratio <= 0) {
    return;
  }
  graphics.fillStyle(BAR_FILL, 1);
  // At least a pixel: a monster on its last point of health must not look already dead.
  graphics.fillRect(left, 0, Math.max(1, BAR_WIDTH_PX * ratio), BAR_HEIGHT_PX);
}
