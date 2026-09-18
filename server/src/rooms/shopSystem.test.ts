import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ServerMessage,
  type CurrencyChanged,
  type ItemGranted,
  type ItemRemoved,
  type ShopDenied,
} from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { InMemorySettlementStore } from "../db/settlementStore";
import { TableInteractableIndex } from "../game/interactables";
import { TiledMapLoader } from "../game/tiledMap";
import type { CollisionMap, InteractableIndex, RoomCreateOptions } from "./contracts";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import { MetaverseRoom } from "./metaverseRoom";
import { SHOPS_BY_NPC } from "./shopDefinitions";

/**
 * Roadmap R04-c (`docs/r04-settlement.md` §9): the shop/consumable message handlers
 * (`handleBuyItem`/`handleSellItem`/`handleUseItem`). Harness modeled on `questSystem.test.ts` — a
 * hand-driven room with no live timer, because every case here needs an exact store/message count.
 */

const OWNER = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const ROOM_TYPE = "plaza";

/** Read from the shop/item tables rather than repeated here — `questSystem.test.ts`'s own pattern. */
const LISTING = (() => {
  const shop = SHOPS_BY_NPC.get("plaza-shop-npc");
  assert.ok(shop, `the shop table has no row for "plaza-shop-npc"`);
  const [listing] = shop.listings;
  assert.ok(listing, "the shop table's fixture row needs at least one listing");
  return listing;
})();
const CONSUMABLE_ITEM = (() => {
  const item = ITEM_DEFINITIONS.find((candidate) => candidate.key === LISTING.itemKey);
  assert.ok(item?.consumable, `"${LISTING.itemKey}" must be the authored recovery consumable`);
  assert.ok(item.sellValue !== undefined, `"${LISTING.itemKey}" must have a sellValue to be resellable`);
  return item as typeof item & { consumable: { healAmount: number }; sellValue: number };
})();

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: { hp: number; ownerKey: string | null; currencyBalance: number };
  sent: SentMessage[];
}

function fakeClient(sessionId: string, ssoUserId: string | null = OWNER): FakeClient {
  const sent: SentMessage[] = [];
  return {
    sessionId,
    auth: { ssoNickname: null, ssoUserId },
    sent,
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload });
    },
  } as FakeClient;
}

function sentOfType<T>(client: FakeClient, type: string): T[] {
  return client.sent.filter((message) => message.type === type).map((message) => message.payload as T);
}

function asRoomClient(client: FakeClient): RoomClient {
  return client as unknown as RoomClient;
}

class ShopRoom extends MetaverseRoom {
  /** A hand-constructed room has no Colyseus `roomName` — `questSystem.test.ts`'s own seam. */
  protected override createInteractableIndex(map: CollisionMap): InteractableIndex {
    return new TableInteractableIndex(ROOM_TYPE, INTERACTABLE_DEFINITIONS, map);
  }

  override setSimulationInterval(): void {
    // A live timer would mutate state mid-assertion; every case here drives the room itself.
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: ROOM_TYPE,
  mapKey: "plaza",
  maxClients: 50,
  spawn: { tileX: 31, tileY: 20, spreadRadiusInTiles: 0 },
};

async function createRoom(overrides: Partial<RoomCreateOptions> = {}): Promise<ShopRoom> {
  const room = new ShopRoom();
  await room.onCreate({ ...ROOM_OPTIONS, ...overrides });
  return room;
}

function join(room: MetaverseRoom, sessionId: string, ssoUserId: string | null = OWNER): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  void room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0 });
  return client;
}

/** Lets the fire-and-forget store calls settle before an assertion reads what they sent. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function buy(room: MetaverseRoom, client: FakeClient, overrides: Partial<{
  npcObjectId: string;
  itemKey: string;
  quantity: number;
  nonce: string;
}> = {}): void {
  room["handleBuyItem"](asRoomClient(client), {
    npcObjectId: "plaza-shop-npc",
    itemKey: LISTING.itemKey,
    quantity: 1,
    nonce: "n1",
    ...overrides,
  });
}

function sell(room: MetaverseRoom, client: FakeClient, overrides: Partial<{
  itemKey: string;
  quantity: number;
  nonce: string;
}> = {}): void {
  room["handleSellItem"](asRoomClient(client), {
    itemKey: LISTING.itemKey,
    quantity: 1,
    nonce: "n1",
    ...overrides,
  });
}

function use(room: MetaverseRoom, client: FakeClient, overrides: Partial<{ itemKey: string; nonce: string }> = {}): void {
  room["handleUseItem"](asRoomClient(client), {
    itemKey: LISTING.itemKey,
    nonce: "n1",
    ...overrides,
  });
}

function dispose(room: MetaverseRoom): void {
  room.onDispose();
  room.setPatchRate(null);
}

describe("BuyItem", () => {
  it("debits currency and grants the item atomically on success", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    await currencyStore.credit(OWNER, 100);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "buyer");
    await flush();

    buy(room, client, { quantity: 2 });
    await flush();

    assert.equal(await currencyStore.getBalance(OWNER), 100 - LISTING.price * 2);
    assert.deepEqual(await inventoryStore.list(OWNER), [
      { itemKey: LISTING.itemKey, quantity: 2, equipped: false },
    ]);
    assert.deepEqual(
      sentOfType<CurrencyChanged>(client, ServerMessage.CurrencyChanged).filter((c) => c.reason === "shop-buy"),
      [{ balance: 100 - LISTING.price * 2, delta: -(LISTING.price * 2), reason: "shop-buy" }],
    );
    const granted = sentOfType<ItemGranted>(client, ServerMessage.ItemGranted);
    assert.equal(granted.length, 1);
    assert.equal(granted[0]?.itemKey, LISTING.itemKey);
    assert.equal(granted[0]?.total, 2);
    dispose(room);
  });

  it("ignores a quantity past MAX_REQUEST_QUANTITY instead of letting it reach the settlement", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    // Funded well past the asking price, so nothing but the quantity guard can stop this.
    await currencyStore.credit(OWNER, Number.MAX_SAFE_INTEGER - 1);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "buyer");
    await flush();

    // `Number.isInteger` says yes and `inventory_item.quantity` — a Postgres `integer` — says no.
    // Unguarded, this reaches `settle()` and fails there as a raw 22003 driver error: the whole
    // transaction rolls back (nothing is corrupted), but the database is flagged degraded and the
    // caller's catch swallows the error, so the buyer never hears anything back at all.
    buy(room, client, { quantity: 3_000_000_000 });
    await flush();

    assert.equal(await currencyStore.getBalance(OWNER), Number.MAX_SAFE_INTEGER - 1, "no debit");
    assert.deepEqual(await inventoryStore.list(OWNER), [], "no grant");
    assert.deepEqual(sentOfType<ItemGranted>(client, ServerMessage.ItemGranted), []);
    assert.deepEqual(
      sentOfType<ShopDenied>(client, ServerMessage.ShopDenied),
      [],
      "a malformed message is ignored in silence, exactly as quantity < 1 already is",
    );
    dispose(room);
  });

  it("changes nothing and denies insufficient-balance when the account cannot afford it", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "buyer");
    await flush();

    buy(room, client);
    await flush();

    assert.equal(await currencyStore.getBalance(OWNER), 0, "no debit");
    assert.deepEqual(await inventoryStore.list(OWNER), [], "no grant");
    assert.deepEqual(sentOfType<ItemGranted>(client, ServerMessage.ItemGranted), []);
    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "buy", itemKey: LISTING.itemKey, reason: "insufficient-balance" },
    ]);
    dispose(room);
  });

  it("a resent nonce for the same purchase never buys twice", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    await currencyStore.credit(OWNER, 100);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "buyer");
    await flush();

    buy(room, client, { nonce: "same-nonce" });
    await flush();
    buy(room, client, { nonce: "same-nonce" });
    await flush();

    assert.equal(await currencyStore.getBalance(OWNER), 100 - LISTING.price, "debited exactly once");
    assert.deepEqual(await inventoryStore.list(OWNER), [
      { itemKey: LISTING.itemKey, quantity: 1, equipped: false },
    ]);
    dispose(room);
  });

  it("denies unknown-item for an itemKey outside ITEM_DEFINITIONS", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    const room = await createRoom({ currencyStore, settlementStore });
    const client = join(room, "buyer");
    await flush();

    buy(room, client, { itemKey: "no-such-item" });
    await flush();

    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "buy", itemKey: "no-such-item", reason: "unknown-item" },
    ]);
    dispose(room);
  });

  it("denies not-sold-here for a real item this shop does not list", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    const room = await createRoom({ currencyStore, settlementStore });
    const client = join(room, "buyer");
    await flush();

    buy(room, client, { itemKey: "acorn" });
    await flush();

    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "buy", itemKey: "acorn", reason: "not-sold-here" },
    ]);
    dispose(room);
  });
});

describe("SellItem", () => {
  it("debits the item and credits its sellValue on success", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    await inventoryStore.add(OWNER, LISTING.itemKey, 3);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "seller");
    await flush();

    sell(room, client, { quantity: 2 });
    await flush();

    assert.equal(await currencyStore.getBalance(OWNER), CONSUMABLE_ITEM.sellValue! * 2);
    assert.deepEqual(await inventoryStore.list(OWNER), [
      { itemKey: LISTING.itemKey, quantity: 1, equipped: false },
    ]);
    assert.deepEqual(sentOfType<ItemRemoved>(client, ServerMessage.ItemRemoved), [
      { itemKey: LISTING.itemKey, name: CONSUMABLE_ITEM.name, icon: CONSUMABLE_ITEM.icon, quantity: 2, total: 1, reason: "shop-sell" },
    ]);
    dispose(room);
  });

  it("refuses to sell what the session has equipped, leaving the bag untouched", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    await inventoryStore.add(OWNER, LISTING.itemKey, 1);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "seller");
    await flush();
    // Written straight into the session cache because no *equipment* row has a `sellValue` yet —
    // the guard reads this cache, not the item table, and the day equipment becomes sellable is the
    // day a sold-while-worn row would leave its stat bonus applied to a player who no longer owns
    // it. The slot name is irrelevant; the guard looks at the values.
    (client.userData as unknown as { equippedItemKeys: Record<string, string> }).equippedItemKeys = {
      armor: LISTING.itemKey,
    };

    sell(room, client);
    await flush();

    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "sell", itemKey: LISTING.itemKey, reason: "not-sellable" },
    ]);
    assert.deepEqual(
      await inventoryStore.list(OWNER),
      [{ itemKey: LISTING.itemKey, quantity: 1, equipped: false }],
      "the row survives the refusal",
    );
    assert.equal(await currencyStore.getBalance(OWNER), 0, "and nothing was paid for it");
    dispose(room);
  });

  it("denies insufficient-item and changes nothing when the account does not hold enough", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    await inventoryStore.add(OWNER, LISTING.itemKey, 1);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "seller");
    await flush();

    sell(room, client, { quantity: 5 });
    await flush();

    assert.equal(await currencyStore.getBalance(OWNER), 0);
    assert.deepEqual(await inventoryStore.list(OWNER), [
      { itemKey: LISTING.itemKey, quantity: 1, equipped: false },
    ]);
    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "sell", itemKey: LISTING.itemKey, reason: "insufficient-item" },
    ]);
    dispose(room);
  });

  it("denies not-sellable for an item with no sellValue", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    const noSellItem = ITEM_DEFINITIONS.find((item) => item.sellValue === undefined);
    assert.ok(noSellItem, "the fixture needs an item with no sellValue");
    await inventoryStore.add(OWNER, noSellItem.key, 1);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "seller");
    await flush();

    sell(room, client, { itemKey: noSellItem.key });
    await flush();

    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "sell", itemKey: noSellItem.key, reason: "not-sellable" },
    ]);
    dispose(room);
  });

  it("denies unknown-item for an itemKey outside ITEM_DEFINITIONS", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    const room = await createRoom({ currencyStore, settlementStore });
    const client = join(room, "seller");
    await flush();

    sell(room, client, { itemKey: "no-such-item" });
    await flush();

    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "sell", itemKey: "no-such-item", reason: "unknown-item" },
    ]);
    dispose(room);
  });
});

describe("UseItem", () => {
  it("restores HP and debits one unit on success", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    await inventoryStore.add(OWNER, LISTING.itemKey, 2);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "user");
    await flush();
    const session = client.userData!;
    const maxHp = session.hp;
    session.hp = Math.max(1, maxHp - CONSUMABLE_ITEM.consumable!.healAmount - 5);
    const hpBefore = session.hp;

    use(room, client);
    await flush();

    assert.equal(
      session.hp,
      Math.min(maxHp, hpBefore + CONSUMABLE_ITEM.consumable!.healAmount),
      "heal is clamped to the account's current max HP",
    );
    assert.deepEqual(await inventoryStore.list(OWNER), [
      { itemKey: LISTING.itemKey, quantity: 1, equipped: false },
    ]);
    const removed = sentOfType<ItemRemoved>(client, ServerMessage.ItemRemoved);
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.reason, "consume");
    assert.equal(removed[0]?.total, 1);
    assert.equal(removed[0]?.hpRemaining, session.hp);
    assert.deepEqual(
      sentOfType<CurrencyChanged>(client, ServerMessage.CurrencyChanged).filter((c) => c.reason !== "sync"),
      [],
      "a use never moves currency",
    );
    dispose(room);
  });

  it("denies insufficient-item and heals nothing when the account holds none", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "user");
    await flush();
    const session = client.userData!;
    session.hp = 1;

    use(room, client);
    await flush();

    assert.equal(session.hp, 1, "no heal without a debit");
    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "use", itemKey: LISTING.itemKey, reason: "insufficient-item" },
    ]);
    dispose(room);
  });

  it("denies not-consumable for an item with no consumable effect", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const inventoryStore = new InMemoryInventoryStore();
    const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
    const nonConsumable = ITEM_DEFINITIONS.find((item) => item.consumable === undefined);
    assert.ok(nonConsumable, "the fixture needs a non-consumable item");
    await inventoryStore.add(OWNER, nonConsumable.key, 1);
    const room = await createRoom({ currencyStore, inventoryStore, settlementStore });
    const client = join(room, "user");
    await flush();

    use(room, client, { itemKey: nonConsumable.key });
    await flush();

    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "use", itemKey: nonConsumable.key, reason: "not-consumable" },
    ]);
    dispose(room);
  });

  it("denies unknown-item for an itemKey outside ITEM_DEFINITIONS", async () => {
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    const room = await createRoom({ currencyStore, settlementStore });
    const client = join(room, "user");
    await flush();

    use(room, client, { itemKey: "no-such-item" });
    await flush();

    assert.deepEqual(sentOfType<ShopDenied>(client, ServerMessage.ShopDenied), [
      { action: "use", itemKey: "no-such-item", reason: "unknown-item" },
    ]);
    dispose(room);
  });
});
