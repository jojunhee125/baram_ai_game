import Phaser from "phaser";
import { TILE_SIZE_PX, type BossTelegraph } from "@zep-test/shared";

const WARNING_FILL = 0xc95142;
const WARNING_BORDER = 0xffd9a5;

interface Warning {
  graphic: Phaser.GameObjects.Graphics;
  expiry: Phaser.Time.TimerEvent;
}

/** One warning per boss. Cancellation follows the server verdict; windup is a bounded fallback. */
export class BossTelegraphs {
  private readonly active = new Map<string, Warning>();

  constructor(private readonly scene: Phaser.Scene) {
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  show(event: BossTelegraph): void {
    this.remove(event.monsterId);
    if (!Number.isFinite(event.targetTileX) || !Number.isFinite(event.targetTileY) ||
      !Number.isInteger(event.radiusTiles) || event.radiusTiles < 0 || event.radiusTiles > 5 ||
      !Number.isInteger(event.windupMs) || event.windupMs <= 0) return;

    const graphic = this.scene.add.graphics().setName(`boss-telegraph:${event.monsterId}`).setDepth(1);
    const radius = event.radiusTiles;
    graphic.fillStyle(WARNING_FILL, event.phase === 2 ? 0.44 : 0.35);
    graphic.lineStyle(2, WARNING_BORDER, 0.9);
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (x * x + y * y > radius * radius) continue;
        const left = (event.targetTileX + x) * TILE_SIZE_PX;
        const top = (event.targetTileY + y) * TILE_SIZE_PX;
        graphic.fillRect(left, top, TILE_SIZE_PX, TILE_SIZE_PX);
        graphic.strokeRect(left + 1, top + 1, TILE_SIZE_PX - 2, TILE_SIZE_PX - 2);
      }
    }
    const expiry = this.scene.time.delayedCall(event.windupMs, () => this.remove(event.monsterId));
    this.active.set(event.monsterId, { graphic, expiry });
  }

  remove(monsterId: string): void {
    const warning = this.active.get(monsterId);
    if (!warning) return;
    warning.expiry.remove(false);
    warning.graphic.destroy();
    this.active.delete(monsterId);
  }

  destroy(): void {
    for (const monsterId of this.active.keys()) this.remove(monsterId);
  }
}
