import { CLASS_DEFINITIONS, EQUIPMENT_SLOTS, type EquipmentMetadata, type PlayerClassKey } from "@zep-test/shared";

/**
 * Same-origin like `profile.ts`, and for the same reason: in production the game server serves
 * this bundle, so the request carries the SSO cookies the KAD gateway checks.
 */
const INVENTORY_PATH = "/api/inventory";

/**
 * Shorter than the profile's, because this one is behind a control the player just pressed: an
 * open window that sits on a spinner is worse feedback than one that says it could not read the
 * bag and offers to try again.
 */
const LOAD_TIMEOUT_MS = 2500;

/** One row of the bag, exactly as the server sent it. */
export interface InventoryItem {
  itemKey: string;
  /** Display name, sent with the row so a bundle older than the server still labels it. */
  name: string;
  /** An `ITEM_ICON_ORDER` value; an unknown one draws the fallback slot rather than nothing. */
  icon: string;
  quantity: number;
  equipped: boolean;
  tradeable?: boolean;
  equipment?: EquipmentMetadata;
  /** Present only on equipment rows; its absence is what tells a row apart from a possession. */
  damageReductionRatio?: number;
  /**
   * 전(錢) this item sells back for (roadmap R04-c, design `docs/r04-settlement.md` §9 D11); its
   * absence is what tells `InventoryPanel` not to draw a 판매 button for this row — the same
   * "field present, not a boolean" treatment `damageReductionRatio` already gets.
   *
   * **Not yet sent by `/api/inventory`** — the HTTP route (`server/routes.ts`, out of this task's
   * scope) still presents only the fields R04-b needed. Until it grows this field, every row parses
   * with `sellValue: undefined` and no 판매 button ever renders; this type and its parser are ready
   * for the day it does.
   */
  sellValue?: number;
  /**
   * Whether this item is usable via `item:use` (design §9 D11) — a bare boolean rather than the
   * server's `{ healAmount }` shape, since the row only needs to decide whether to draw a 사용
   * button; the heal amount itself is never shown ahead of use. Same unsent-field caveat as
   * {@link sellValue} above.
   */
  consumable?: boolean;
}

/**
 * Reads the account's bag.
 *
 * An empty array is a success, never an error: no SSO identity (local dev, or a request that
 * missed the gateway) answers `200 {"items": []}` by design, so "you are not signed in" and "you
 * are carrying nothing" reach this function as the same thing — and they are the same thing to
 * the player, who in both cases has an empty bag.
 *
 * Throws on anything else. The caller draws an error state from it, because unlike the stored
 * avatar skin there is no sensible substitute to fall back to: an empty bag drawn after a failed
 * read is a lie about the player's belongings.
 */
export async function loadInventory(options: { strict?: boolean } = {}): Promise<readonly InventoryItem[]> {
  const response = await fetch(INVENTORY_PATH, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return readItems(await response.json(), options.strict ?? false);
}

/**
 * Rows that do not parse are dropped, not thrown on. The catalogue lives on the server and can
 * grow a field or a type this bundle was not built against; losing one row from the list beats
 * replacing the whole bag with an error the player cannot act on.
 */
function readItems(body: unknown, strict: boolean): readonly InventoryItem[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    throw new Error("response had no items array");
  }
  if (strict && items.some((item) => !isInventoryItem(item) || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    throw new Error("response had an invalid inventory row");
  }
  return items.filter(isInventoryItem).map((item) => ({
    ...item,
    equipment: readEquipmentMetadata(item.equipment),
  }));
}

export function readEquipmentMetadata(value: unknown): EquipmentMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const equipment = value as Partial<EquipmentMetadata>;
  if (
    (equipment.slot !== "ring" &&
      !EQUIPMENT_SLOTS.some((slot) => slot !== "ring1" && slot !== "ring2" && slot === equipment.slot)) ||
    typeof equipment.attackDamage !== "number" ||
    !Number.isFinite(equipment.attackDamage) || equipment.attackDamage < 0 ||
    typeof equipment.damageReduction !== "number" ||
    !Number.isFinite(equipment.damageReduction) ||
    equipment.damageReduction < 0 || equipment.damageReduction > 1
  ) return undefined;
  const source = equipment.requirement;
  const requirement = source && typeof source === "object" &&
    (source.minLevel === undefined || Number.isInteger(source.minLevel) && source.minLevel > 0) &&
    (source.classes === undefined || Array.isArray(source.classes) && source.classes.length > 0 &&
      source.classes.every((key) => typeof key === "string" && Object.hasOwn(CLASS_DEFINITIONS, key)))
    ? { minLevel: source.minLevel, classes: source.classes as readonly PlayerClassKey[] | undefined }
    : undefined;
  return { slot: equipment.slot!, attackDamage: equipment.attackDamage, damageReduction: equipment.damageReduction, requirement };
}

function isInventoryItem(row: unknown): row is InventoryItem {
  const item = row as Partial<InventoryItem> | null;
  return (
    typeof item?.itemKey === "string" &&
    typeof item.name === "string" &&
    typeof item.icon === "string" &&
    typeof item.quantity === "number" &&
    Number.isFinite(item.quantity) &&
    typeof item.equipped === "boolean" &&
    (typeof item.tradeable === "boolean" || item.tradeable === undefined) &&
    (typeof item.damageReductionRatio === "number" || item.damageReductionRatio === undefined) &&
    (typeof item.sellValue === "number" || item.sellValue === undefined) &&
    (typeof item.consumable === "boolean" || item.consumable === undefined)
  );
}
