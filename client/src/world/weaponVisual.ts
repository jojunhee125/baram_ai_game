import { type EquipmentChanged } from "@zep-test/shared";
import { loadInventory } from "../net/inventory";
import { WEAPON_APPEARANCE_KEYS } from "./equipmentAppearance";
import { ITEM_ICON_ORDER } from "../ui/inventoryPanel";

export const OLD_DAGGER_ITEM_KEY = "old-dagger";
const BLADE_ITEM_KEYS: ReadonlySet<string> = new Set([OLD_DAGGER_ITEM_KEY, "hunting-blade", "iron-blade",
  ...WEAPON_APPEARANCE_KEYS]);

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
        this.owned = items.some((item) => BLADE_ITEM_KEYS.has(item.itemKey) && item.equipped);
      },
      () => {
        // Keep the conservative unarmed default; later equipment verdicts remain authoritative.
      },
    );
  }

  applyEquipmentChange(event: EquipmentChanged): void {
    if (event.slot !== "weapon") return;
    this.receivedEquipment = true;
    this.owned = event.itemKey !== null && BLADE_ITEM_KEYS.has(event.itemKey);
  }

  get hasOldDagger(): boolean {
    return this.owned;
  }
}
