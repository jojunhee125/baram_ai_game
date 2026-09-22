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
 * The largest `quantity` one shop message may name (roadmap R04-c). **Not** a stack cap — the
 * comment above still holds and nothing limits what a bag accumulates from drops. This bounds what
 * a *client request* may ask for, which is a different thing.
 *
 * It exists because `inventory_item.quantity` is a Postgres `integer`
 * (`0002_inventory_item.sql`), so a request for 3e9 passes `Number.isInteger` and then fails deep
 * inside the settlement transaction as a raw driver error (`22003`). That rolls everything back —
 * no asset is ever corrupted — but it takes the `markDatabaseDegraded` path for a database that is
 * perfectly healthy, and the settle caller's `catch` swallows it, so the player's purchase
 * disappears without even a `ShopDenied`. Rejected up front instead, and deliberately far below the
 * column's own bound so repeated purchases stay nowhere near it.
 */
export const MAX_REQUEST_QUANTITY = 9_999;

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
  { key: "acorn", name: "도토리", icon: "acorn", sellValue: 4 },
  { key: "carrot", name: "당근", icon: "carrot", sellValue: 6 },
  { key: "copper-coin", name: "구리 동전", icon: "copper-coin", sellValue: 8 },
  // Promoted to the shop's recovery consumable (roadmap R04-c, design `docs/r04-settlement.md` §9
  // D11, `docs/decisions.md` 2026-09-18) — no new key or icon: a healing herb is exactly what this
  // drop-only row already was, so `plaza-shop-npc` sells the same item a squirrel/rabbit/deer can
  // already drop rather than introducing a second, unrelated "recovery item". `sellValue` is a
  // separate, explicit figure from the shop's buy price (`shopDefinitions.ts`) — decisions.md's own
  // rule for a price with no balancing data behind it yet.
  { key: "herb", name: "약초", icon: "herb", sellValue: 3, consumable: { healAmount: 30 } },
  // Promoted to a weapon-slot equipment item (design-phase-v-equipment-system.md §5.5): the `key`/
  // `icon`/`name` are unchanged, so the Pass G swing visual keyed on `old-dagger` still applies —
  // only the `equipment` field is new. Left without `possession: true`, unlike the design doc's
  // §6.4 assumption ("old-dagger는 기존부터 이미 possession: true"): that premise does not match
  // this table as shipped (Pass G never set it), and switching the loot-grant path from `add` to
  // `grantOnce` here would be a real behaviour change to drop repeatability, not the field-shape
  // migration `leather-armor` below is. Equip does not care about stack size either way.
  {
    key: "old-dagger",
    name: "낡은 단검",
    icon: "old-dagger",
    sellValue: 10,
    equipment: { slot: "weapon", stats: { attackDamage: 2 } },
  },
  { key: "entry-pass", name: "입장권", icon: "entry-pass", possession: true },
  {
    key: "leather-armor",
    name: "가죽 갑옷",
    icon: "leather-armor",
    possession: true,
    equipment: { slot: "armor", stats: { damageReduction: 0.2 } },
  },
  // Phase I (design-phase-i-boss-monster.md §7, §11.3): the boss's only drop, one per account.
  // damageReduction sits below leather-armor's 0.2 on purpose — this stacks with it multiplicatively
  // (equippedDamageReduction, metaverseRoom.ts), so armor stays the primary defensive slot and this
  // is the bonus layered on top (0.2 armor + 0.15 helmet = 32% combined).
  {
    key: "golden-helmet",
    name: "황금투구",
    icon: "golden-helmet",
    possession: true,
    equipment: { slot: "helmet", stats: { damageReduction: 0.15 } },
  },
  { key: "den-fur", name: "굴짐승 털", icon: "acorn", sellValue: 10 },
  { key: "antler", name: "단단한 뿔", icon: "carrot", sellValue: 18 },
  {
    key: "hunting-blade",
    name: "사냥꾼 검",
    icon: "old-dagger",
    sellValue: 45,
    equipment: { slot: "weapon", stats: { attackDamage: 6 } },
  },
  {
    key: "iron-blade",
    name: "철검",
    icon: "old-dagger",
    sellValue: 120,
    equipment: { slot: "weapon", stats: { attackDamage: 10 } },
  },
  {
    key: "padded-armor",
    name: "누비옷",
    icon: "leather-armor",
    sellValue: 25,
    equipment: { slot: "armor", stats: { damageReduction: 0.15 } },
  },
  {
    key: "reinforced-armor",
    name: "강화 가죽갑옷",
    icon: "leather-armor",
    sellValue: 75,
    equipment: { slot: "armor", stats: { damageReduction: 0.3 } },
  },
];
