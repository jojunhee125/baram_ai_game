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
export async function loadInventory(): Promise<readonly InventoryItem[]> {
  const response = await fetch(INVENTORY_PATH, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return readItems(await response.json());
}

/**
 * Rows that do not parse are dropped, not thrown on. The catalogue lives on the server and can
 * grow a field or a type this bundle was not built against; losing one row from the list beats
 * replacing the whole bag with an error the player cannot act on.
 */
function readItems(body: unknown): readonly InventoryItem[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    throw new Error("response had no items array");
  }
  return items.filter(isInventoryItem);
}

function isInventoryItem(row: unknown): row is InventoryItem {
  const item = row as Partial<InventoryItem> | null;
  return (
    typeof item?.itemKey === "string" &&
    typeof item.name === "string" &&
    typeof item.icon === "string" &&
    typeof item.quantity === "number" &&
    Number.isFinite(item.quantity)
  );
}
