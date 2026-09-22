import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { it, type TestContext } from "node:test";
import express from "express";
import { ServerMessage, type EquipmentMetadata, type ItemGranted } from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { InMemorySettlementStore } from "../db/settlementStore";
import { configureHttpRoutes } from "../http/routes";
import { ROOM_DEFINITIONS } from "./definitions";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import { MetaverseRoom } from "./metaverseRoom";
import { SHOP_DEFINITIONS } from "./shopDefinitions";

const EXPECTED: Readonly<Record<string, EquipmentMetadata>> = {
  "old-dagger": { slot: "weapon", attackDamage: 2, damageReduction: 0 },
  "hunting-blade": { slot: "weapon", attackDamage: 6, damageReduction: 0 },
  "iron-blade": { slot: "weapon", attackDamage: 10, damageReduction: 0 },
  "leather-armor": { slot: "armor", attackDamage: 0, damageReduction: 0.2 },
  "padded-armor": { slot: "armor", attackDamage: 0, damageReduction: 0.15 },
  "reinforced-armor": { slot: "armor", attackDamage: 0, damageReduction: 0.3 },
  "golden-helmet": { slot: "helmet", attackDamage: 0, damageReduction: 0.15 },
  "forest-cloak": { slot: "cloak", attackDamage: 0, damageReduction: 0.1 },
};

interface InventoryView {
  itemKey: string;
  name: string;
  icon: string;
  quantity: number;
  equipped: boolean;
  damageReductionRatio?: number;
  sellValue?: number;
  consumable?: boolean;
  equipment?: EquipmentMetadata;
}

class MetadataRoom extends MetaverseRoom {
  override setSimulationInterval(): void {}
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fixture(t: TestContext) {
  const owner = randomUUID();
  const inventory = new InMemoryInventoryStore();
  const currency = new InMemoryCurrencyStore();
  const room = new MetadataRoom();
  t.after(() => room.onDispose());
  Object.defineProperty(room, "roomName", { value: "plaza" });
  await room.onCreate({ ...ROOM_DEFINITIONS.find((row) => row.name === "plaza")!,
    inventoryStore: inventory, currencyStore: currency,
    settlementStore: new InMemorySettlementStore(currency, inventory) });
  const grants: ItemGranted[] = [];
  const client = { sessionId: randomUUID(), auth: { ssoNickname: null, ssoUserId: owner },
    send(type: string, payload: unknown) {
      if (type === ServerMessage.ItemGranted) grants.push(payload as ItemGranted);
    },
  } as unknown as Parameters<MetaverseRoom["onJoin"]>[0];
  await room.onJoin(client, { nickname: "metadata-audit", avatarSkin: 0 });
  await flush();
  const app = express();
  configureHttpRoutes(app, undefined, inventory);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const token = `${Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")}.${
    Buffer.from(JSON.stringify({ sub: owner })).toString("base64url")}.test-signature`;
  async function readInventory(): Promise<InventoryView[]> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/api/inventory",
        headers: { "x-auth-request-access-token": token } }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, 200);
            resolve((JSON.parse(text) as { items: InventoryView[] }).items);
          } catch (cause) { reject(cause); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }
  return { owner, inventory, currency, room, client, grants, readInventory };
}

function assertMetadataAndLegacy(row: InventoryView | ItemGranted): void {
  const definition = ITEM_DEFINITIONS.find((item) => item.key === row.itemKey)!;
  assert.deepEqual(row.equipment, EXPECTED[row.itemKey], `${row.itemKey}: normalized equipment`);
  assert.equal(row.name, definition.name);
  assert.equal(row.icon, definition.icon);
  assert.equal(row.damageReductionRatio, definition.equipment?.stats.damageReduction,
    `${row.itemKey}: legacy ratio must retain its original presence and value`);
  assert.equal(row.sellValue, definition.sellValue);
  assert.equal(row.consumable, definition.consumable ? true : undefined);
  if (!definition.equipment) {
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(row)), "equipment"), false,
      `${row.itemKey}: non-equipment must have no equipment object on the JSON wire`);
  }
}

it("inventory HTTP reports all normalized gear values and preserves equipped flags and legacy fields", async (t) => {
  const f = await fixture(t);
  for (const definition of ITEM_DEFINITIONS) await f.inventory.add(f.owner, definition.key, 2);
  await f.inventory.equip(f.owner, "iron-blade", "weapon");
  await f.inventory.equip(f.owner, "forest-cloak", "cloak");
  const before = await f.inventory.list(f.owner);
  const items = await f.readInventory();
  assert.deepEqual(items.map((row) => row.itemKey), ITEM_DEFINITIONS.map((row) => row.key));
  for (const row of items) {
    assertMetadataAndLegacy(row);
    assert.equal(row.quantity, 2);
    assert.equal(row.equipped, row.itemKey === "iron-blade" || row.itemKey === "forest-cloak");
  }
  assert.deepEqual(await f.inventory.list(f.owner), before, "metadata reads cannot change equipment or assets");
});

it("loot grants and later HTTP reload agree for every item without putting gear metadata on herbs or materials", async (t) => {
  const f = await fixture(t);
  await f.room["awardLoot"]({ sessionId: f.client.sessionId, ownerKey: f.owner },
    ITEM_DEFINITIONS.map((row) => ({ itemKey: row.key, quantity: 1 })));
  await flush();
  assert.equal(f.grants.length, ITEM_DEFINITIONS.length);
  const items = await f.readInventory();
  for (const grant of f.grants) {
    assertMetadataAndLegacy(grant);
    const loaded = items.find((row) => row.itemKey === grant.itemKey)!;
    assertMetadataAndLegacy(loaded);
    assert.deepEqual(loaded.equipment, grant.equipment);
    assert.equal(grant.quantity, 1);
    assert.equal(grant.total, 1);
    assert.equal(loaded.quantity, 1);
  }
  assert.equal(await f.currency.getBalance(f.owner), 0);
});

it("purchase, loot, and reload expose identical metadata while retaining actual quantities and purchase cost", async (t) => {
  const f = await fixture(t);
  const shop = SHOP_DEFINITIONS.find((row) => row.npcObjectId === "plaza-shop-npc")!;
  await f.currency.credit(f.owner, 3_000);
  for (const listing of shop.listings) {
    f.room["handleBuyItem"](f.client, { npcObjectId: shop.npcObjectId,
      itemKey: listing.itemKey, quantity: 2, nonce: `metadata:${listing.itemKey}` });
    await flush();
  }
  const purchased = [...f.grants];
  assert.equal(purchased.length, shop.listings.length);
  assert.equal(await f.currency.getBalance(f.owner),
    3_000 - shop.listings.reduce((sum, listing) => sum + listing.price * 2, 0));
  await f.room["awardLoot"]({ sessionId: f.client.sessionId, ownerKey: f.owner },
    shop.listings.map((row) => ({ itemKey: row.itemKey, quantity: 1 })));
  const dropped = f.grants.slice(purchased.length);
  assert.equal(dropped.length, purchased.length);
  const items = await f.readInventory();
  for (const purchase of purchased) {
    const drop = dropped.find((row) => row.itemKey === purchase.itemKey)!;
    const loaded = items.find((row) => row.itemKey === purchase.itemKey)!;
    for (const row of [purchase, drop, loaded]) assertMetadataAndLegacy(row);
    assert.deepEqual(purchase.equipment, drop.equipment);
    assert.deepEqual(purchase.equipment, loaded.equipment);
    assert.equal(purchase.quantity, 2);
    assert.equal(purchase.total, 2);
    assert.equal(drop.quantity, 1);
    assert.equal(drop.total, 3);
    assert.equal(loaded.quantity, 3);
  }
});
