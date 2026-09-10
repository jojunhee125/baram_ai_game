import type { EquipmentChanged } from "@zep-test/shared";
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

/** Mirrors equipped state; a late inventory read must not overwrite a newer server verdict. */
export class WeaponVisualState {
  private owned = false;
  private receivedEquipment = false;

  constructor() {
    void loadInventory().then(
      (items) => {
        if (this.receivedEquipment) return;
        this.owned = items.some((item) => item.itemKey === OLD_DAGGER_ITEM_KEY && item.equipped);
      },
      () => {
        // Keep the conservative unarmed default; later equipment verdicts remain authoritative.
      },
    );
  }

  applyEquipmentChange(event: EquipmentChanged): void {
    if (event.slot !== "weapon") return;
    this.receivedEquipment = true;
    this.owned = event.itemKey === OLD_DAGGER_ITEM_KEY;
  }

  get hasOldDagger(): boolean {
    return this.owned;
  }
}
