import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { EquipmentMetadata } from "@zep-test/shared";
import { ROOM_DEFINITIONS } from "./definitions";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import { MetaverseRoom } from "./metaverseRoom";
import { SHOP_DEFINITIONS, type ShopListing } from "./shopDefinitions";

const EXPECTED: Readonly<Record<string, EquipmentMetadata>> = {
  "old-dagger": { slot: "weapon", attackDamage: 2, damageReduction: 0 },
  "padded-armor": { slot: "armor", attackDamage: 0, damageReduction: 0.15 },
  "hunting-blade": { slot: "weapon", attackDamage: 6, damageReduction: 0 },
  "reinforced-armor": { slot: "armor", attackDamage: 0, damageReduction: 0.3 },
  "iron-blade": { slot: "weapon", attackDamage: 10, damageReduction: 0 },
};

class ShopMetadataRoom extends MetaverseRoom {
  override setSimulationInterval(): void {}
}

async function fixture(t: TestContext): Promise<ShopMetadataRoom> {
  const room = new ShopMetadataRoom();
  t.after(() => {
    room.onDispose();
    room.setPatchRate(null);
  });
  const plaza = ROOM_DEFINITIONS.find((definition) => definition.name === "plaza");
  assert.ok(plaza);
  Object.defineProperty(room, "roomName", { value: plaza.name });
  await room.onCreate(plaza);
  return room;
}

it("shop offers include normalized catalogue metadata for every weapon and armor listing", async (t) => {
  const room = await fixture(t);
  const shop = SHOP_DEFINITIONS.find((definition) => definition.npcObjectId === "plaza-shop-npc");
  assert.ok(shop);
  const offer = room["shopOffered"](shop.npcObjectId);
  assert.ok(offer);
  assert.deepEqual(offer.listings.map((listing) => listing.itemKey), shop.listings.map((listing) => listing.itemKey));
  const gear = offer.listings.filter((listing) => listing.equipment !== undefined);
  assert.deepEqual(gear.map((listing) => listing.itemKey).sort(), Object.keys(EXPECTED).sort());
  for (const listing of gear) {
    assert.deepEqual(listing.equipment, EXPECTED[listing.itemKey], listing.itemKey);
  }
});

it("shop metadata preserves complete legacy listing shapes and omits equipment entirely for consumables", async (t) => {
  const room = await fixture(t);
  const shop = SHOP_DEFINITIONS.find((definition) => definition.npcObjectId === "plaza-shop-npc");
  assert.ok(shop);
  const offer = room["shopOffered"](shop.npcObjectId);
  assert.ok(offer);
  for (const listing of offer.listings) {
    const definition = ITEM_DEFINITIONS.find((item) => item.key === listing.itemKey);
    const authored: ShopListing | undefined = shop.listings.find((item) => item.itemKey === listing.itemKey);
    assert.ok(definition);
    assert.ok(authored);
    const { equipment: _equipment, ...legacy } = listing;
    assert.deepEqual(legacy, {
      itemKey: authored.itemKey,
      name: definition.name,
      icon: definition.icon,
      price: authored.price,
      ...(definition.equipment?.stats.attackDamage === undefined ? {} : { attackBonus: definition.equipment.stats.attackDamage }),
      ...(definition.equipment?.stats.damageReduction === undefined ? {} : { damageReductionRatio: definition.equipment.stats.damageReduction }),
    });
    if (definition.equipment === undefined) {
      assert.equal(Object.hasOwn(listing, "equipment"), false);
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(listing)), "equipment"), false);
    }
  }
  const herb = offer.listings.find((listing) => listing.itemKey === "herb");
  assert.ok(herb, "the offer must include a consumable to exercise metadata omission");
  assert.equal(herb.price, 12);
});
