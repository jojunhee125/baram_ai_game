import { InteractableKind } from "@zep-test/shared";
import type { InteractableDefinition, ItemDefinition } from "./contracts";

/**
 * One item one shop NPC sells, and what it costs there (roadmap R04-c, design
 * `docs/r04-settlement.md` §9 D11). Price lives here, not on {@link ItemDefinition}: a sell price
 * (`ItemDefinition.sellValue`) is intrinsic to the item, but a buy price is what *this shop*
 * charges for it, the same distinction `PortalDefinition.requiresItemKey` draws between an item's
 * own identity and what one particular gate does with it.
 */
export interface ShopListing {
  /** Must name a row in `ITEM_DEFINITIONS`. Boot validation refuses anything else. */
  itemKey: string;
  /** 전(錢), per unit. Positive integer; boot validation refuses anything else. */
  price: number;
}

/**
 * One NPC's shop, authored in code beside `QUEST_DEFINITIONS` and for the same reason: the deploy
 * is the edit permission (roadmap item 3's own rule, applied here to prices instead of quest
 * text).
 */
export interface ShopDefinition {
  /**
   * The {@link InteractableBase.id} of the NPC that runs this shop. Boot validation refuses an id
   * that is not an `Npc` row — `QuestDefinition.giverObjectId`'s own check, and for the same
   * reason: the NPC table stays exactly as it is, knowing nothing about shops, and the room
   * resolves the offer when the panel opens.
   */
  npcObjectId: string;
  /**
   * What this NPC sells, in the shop panel's display order. Non-empty, and no `itemKey` may repeat
   * within one shop — boot validation refuses both, `QuestDefinition`'s own "authored content, not
   * a database" trust model.
   */
  listings: readonly ShopListing[];
}

/**
 * The authored table. `plaza-shop-npc` is the placeholder NPC roadmap R03 already placed
 * (`interactableDefinitions.ts`), promoted here rather than replaced — no new NPC, no map change.
 * One listing: `herb` (`itemDefinitions.ts`), the recovery consumable §9 D11 asked for, at 12전
 * against first-hunt's 50전 reward (`docs/decisions.md` 2026-09-18's 10~15전 band — a first-hunt
 * payout buys 4 of these).
 */
export const SHOP_DEFINITIONS: readonly ShopDefinition[] = [
  {
    npcObjectId: "plaza-shop-npc",
    listings: [{ itemKey: "herb", price: 12 }],
  },
];

/** `SHOP_DEFINITIONS` by npc, the `QUESTS_BY_GIVER` lookup shape — at most one shop per NPC today. */
export const SHOPS_BY_NPC: ReadonlyMap<string, ShopDefinition> = new Map(
  SHOP_DEFINITIONS.map((shop) => [shop.npcObjectId, shop]),
);

/**
 * Boot validation, wired into `server.ts` beside the quest/portal/interactable/item checks and
 * refusing the boot on any error — `validateQuestDefinitions`'s own contract, checking:
 *
 * - `npcObjectId` names an object in `objects`, and that object's `kind` is `InteractableKind.Npc`.
 * - No two shops share one `npcObjectId`.
 * - `listings` is non-empty and has no repeated `itemKey` within one shop.
 * - Every `itemKey` names a row in `items`.
 * - Every `price` is a positive integer.
 *
 */
export function validateShopDefinitions(
  shops: readonly ShopDefinition[],
  objects: readonly InteractableDefinition[],
  items: readonly ItemDefinition[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const objectsById = new Map(objects.map((object) => [object.id, object]));
  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  const seenNpcObjectIds = new Set<string>();

  for (const shop of shops) {
    const label = `shop "${shop.npcObjectId}"`;
    if (seenNpcObjectIds.has(shop.npcObjectId)) {
      errors.push(`${label} is defined twice`);
    }
    seenNpcObjectIds.add(shop.npcObjectId);

    const npc = objectsById.get(shop.npcObjectId);
    if (npc === undefined) {
      errors.push(`${label} names an object that is not in the interactable table`);
    } else if (npc.kind !== InteractableKind.Npc) {
      errors.push(`${label} names an object of kind ${npc.kind} rather than npc`);
    }

    if (shop.listings.length === 0) {
      errors.push(`${label} has no listings`);
    }
    const seenItemKeys = new Set<string>();
    for (const listing of shop.listings) {
      if (seenItemKeys.has(listing.itemKey)) {
        errors.push(`${label} lists "${listing.itemKey}" twice`);
      }
      seenItemKeys.add(listing.itemKey);

      if (!itemsByKey.has(listing.itemKey)) {
        errors.push(`${label} lists "${listing.itemKey}", which is not in the item table`);
      }
      if (!Number.isInteger(listing.price) || listing.price < 1) {
        errors.push(`${label}'s listing for "${listing.itemKey}" prices it at ${listing.price}, not a positive integer`);
      }
    }
  }
  return { errors, warnings };
}
