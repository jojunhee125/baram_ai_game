import type { ItemDefinition } from "./contracts";

/**
 * How many *different* items one bag holds. Quantity is not capped — a stack of a thousand hides
 * costs one row, while a thousand kinds costs a thousand (design §3.1, option c).
 *
 * Server-side rather than in `shared/src/constants.ts`, unlike HOME_COOLDOWN_MS and
 * MAX_CHAT_LENGTH: those are shared because the client mirrors them in its own input handling,
 * and nothing on the client mirrors this one. The bag window draws the rows the server sent it
 * and never has to know how many more would have fitted.
 *
 * Larger than ITEM_DEFINITIONS is deliberate for now: with the catalogue this small, a full bag
 * would be unreachable and the capacity path would never be exercised outside its tests.
 */
export const MAX_DISTINCT_ITEMS = 24;

/**
 * Everything a player can be carrying. A pure data table like `PORTAL_DEFINITIONS` and
 * `INTERACTABLE_DEFINITIONS`, on the same layer and with the same trust model: what is in code
 * is authoritative, and editing it means deploying.
 *
 * These five rows are design appendix D-4, matched to the `MONSTER_TYPES.loot` chances of Pass D.
 * Boot refuses to start on a loot entry naming a key that is not here, so this table and that one
 * cannot drift apart unnoticed.
 *
 * **A `key` cannot be changed after a deploy.** It is written verbatim into
 * `inventory_item.item_key`, so renaming one abandons every stack already filed under the old
 * spelling — a typo here survives every later fix. `name` and `icon` carry no such weight and can
 * be changed whenever.
 *
 * Row *order* is load-bearing twice over. It is the display order of the bag window, because the
 * store returns rows in whatever order its backing gives them and `GET /api/inventory` re-orders
 * them against this table (design §3.3). It is also the icon frame order: the client picks a
 * frame of `items.png` by `ITEM_ICON_ORDER.indexOf(definition.icon)` (design appendix D-3), so
 * reordering here repaints every icon. Keep this order.
 *
 * Each `icon` happens to equal its `key` today, and the fields stay separate anyway (design
 * D-3): the first two items to share one piece of art have to be able to diverge without anyone
 * being tempted to change a `key` the database is already holding.
 */
export const ITEM_DEFINITIONS: readonly ItemDefinition[] = [
  { key: "acorn", name: "도토리", icon: "acorn" },
  { key: "carrot", name: "당근", icon: "carrot" },
  { key: "copper-coin", name: "구리 동전", icon: "copper-coin" },
  { key: "herb", name: "약초", icon: "herb" },
  { key: "old-dagger", name: "낡은 단검", icon: "old-dagger" },
];
