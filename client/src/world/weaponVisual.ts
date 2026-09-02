import type { ItemGranted } from "@zep-test/shared";
import { loadInventory } from "../net/inventory";
import { ITEM_ICON_ORDER } from "../ui/inventoryPanel";

/**
 * The one item this pass draws on a swing. A literal, not a table: decision 2 of Pass G scopes
 * this to exactly one item — no equip system, no second weapon (docs/decisions.md 2026-09-02). A
 * second weapon graduates this into an ITEM_DEFINITIONS-driven system, which stays deferred.
 */
export const OLD_DAGGER_ITEM_KEY = "old-dagger";

/** Phaser texture key for the canvas copy of items.png (WorldScene.preload()). The bag window
 * loads the same file as a CSS background instead — the two never share a loader. */
export const ITEM_TEXTURE = "items";

/** `items.png` is one row of `ITEM_ICON_ORDER.length` TILE_SIZE_PX columns (assets/README.md); an
 * icon this bundle has no column for answers -1, same as `applyItemIcon`'s unknown-slot case. */
export function itemFrame(icon: string): number {
  return (ITEM_ICON_ORDER as readonly string[]).indexOf(icon);
}

/**
 * Whether the local account has ever held `old-dagger`. Read once at boot (`loadInventory()`, the
 * same call the bag window makes) and kept current by `applyGrant()` afterwards — no polling
 * timer, because `ItemGranted` already reaches this room on every drop (design §8.2) and this
 * scope has no way to lose an item once granted (design §0: no consumption, no trade).
 *
 * Holds no listener and no DOM, so — like `CombatEffects` — it has no `destroy()`: a stray resolve
 * from an abandoned boot read just writes into an instance nothing reads anymore.
 */
export class WeaponVisualState {
  private owned = false;

  constructor() {
    void loadInventory().then(
      (items) => {
        if (items.some((item) => item.itemKey === OLD_DAGGER_ITEM_KEY)) {
          this.owned = true;
        }
      },
      () => {
        // Left false. Cosmetic only — a future drop's ItemGranted still sets it, and a room hop
        // builds a fresh instance with a fresh read regardless.
      },
    );
  }

  applyGrant(event: ItemGranted): void {
    if (event.itemKey === OLD_DAGGER_ITEM_KEY) {
      this.owned = true;
    }
  }

  get hasOldDagger(): boolean {
    return this.owned;
  }
}
