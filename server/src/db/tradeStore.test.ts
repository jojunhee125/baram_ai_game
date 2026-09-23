import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { AtomicTradeRequest } from "../rooms/contracts";
import { MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { InMemoryCurrencyStore } from "./currencyStore";
import { InMemoryInventoryStore } from "./inventoryStore";
import { InMemoryTradeStore } from "./tradeStore";

const firstOwner = "00000000-0000-0000-0000-000000000001";
const secondOwner = "00000000-0000-0000-0000-000000000002";

function request(): AtomicTradeRequest {
  return {
    tradeId: randomUUID(),
    first: { ownerKey: firstOwner, offer: { currency: 20, items: [{ itemKey: "acorn", quantity: 3 }] } },
    second: { ownerKey: secondOwner, offer: { currency: 5, items: [{ itemKey: "herb", quantity: 2 }] } },
  };
}

describe("InMemoryTradeStore", () => {
  let currency: InMemoryCurrencyStore;
  let inventory: InMemoryInventoryStore;
  let store: InMemoryTradeStore;

  beforeEach(async () => {
    currency = new InMemoryCurrencyStore();
    inventory = new InMemoryInventoryStore();
    store = new InMemoryTradeStore(currency, inventory);
    await currency.credit(firstOwner, 100);
    await currency.credit(secondOwner, 50);
    await inventory.add(firstOwner, "acorn", 3);
    await inventory.add(secondOwner, "herb", 4);
  });

  it("moves both offers atomically through the shared backing stores", async () => {
    assert.deepEqual(await store.exchange(request()), {
      ok: true,
      participants: [
        { ownerKey: firstOwner, balance: 85, items: [{ itemKey: "acorn", quantity: 0 }, { itemKey: "herb", quantity: 2 }] },
        { ownerKey: secondOwner, balance: 65, items: [{ itemKey: "acorn", quantity: 3 }, { itemKey: "herb", quantity: 2 }] },
      ],
    });
    assert.equal(await currency.getBalance(firstOwner), 85);
    assert.deepEqual(await inventory.list(firstOwner), [{ itemKey: "herb", quantity: 2, equipped: false }]);
  });

  it("replays the original result once and rejects changed offers or owners", async () => {
    const input = request();
    const original = await store.exchange(input);
    const reversed = { ...input, first: input.second, second: input.first };
    assert.deepEqual(await store.exchange(reversed), original);
    assert.deepEqual(await store.exchange({ ...input, first: { ...input.first, offer: { currency: 21, items: [] } } }),
      { ok: false, reason: "conflict" });
    assert.deepEqual(await store.exchange({ ...input, first: { ...input.first, ownerKey: randomUUID() } }),
      { ok: false, reason: "conflict" });
    if (original.ok) original.participants[0]!.balance = 123456;
    const replay = await store.exchange(input);
    assert.ok(replay.ok);
    assert.equal(replay.participants[0]!.balance, 85);
    assert.equal(await currency.getBalance(firstOwner), 85);
  });

  it("binds rejected transactions without partially transferring another asset", async () => {
    const input = request();
    input.second.offer = { currency: 100, items: [] };
    const expected = { ok: false, reason: "insufficient-balance", ownerKey: secondOwner };
    assert.deepEqual(await store.exchange(input), expected);
    assert.equal(await currency.getBalance(firstOwner), 100);
    assert.equal(inventory.peekBag(firstOwner).get("acorn"), 3);
    await currency.credit(secondOwner, 100);
    assert.deepEqual(await store.exchange(input), expected);
    assert.equal((await store.exchange({ ...input, tradeId: randomUUID() })).ok, true);
  });

  it("does not fund an offer using assets the same exchange would receive", async () => {
    const input = request();
    input.first.offer = { currency: 120, items: [{ itemKey: "herb", quantity: 1 }] };
    assert.deepEqual(await store.exchange(input), { ok: false, reason: "insufficient-balance", ownerKey: firstOwner });
    input.first.offer.currency = 0;
    assert.deepEqual(await store.exchange({ ...input, tradeId: randomUUID() }),
      { ok: false, reason: "insufficient-item", ownerKey: firstOwner, itemKey: "herb" });
    assert.equal(await currency.getBalance(secondOwner), 50);
  });

  it("rejects equipped equipment and every possession item", async () => {
    await inventory.add(firstOwner, "old-dagger", 2);
    await inventory.equip(firstOwner, "old-dagger", "weapon");
    const input = request();
    input.first.offer = { currency: 20, items: [{ itemKey: "old-dagger", quantity: 1 }] };
    assert.deepEqual(await store.exchange(input),
      { ok: false, reason: "equipped-item", ownerKey: firstOwner, itemKey: "old-dagger" });
    for (const itemKey of ["entry-pass", "leather-armor", "golden-helmet"]) {
      assert.deepEqual(await store.exchange({ ...request(), first: { ownerKey: firstOwner, offer: { currency: 0, items: [{ itemKey, quantity: 1 }] } } }),
        { ok: false, reason: "restricted-item", ownerKey: firstOwner, itemKey });
    }
    assert.equal(await currency.getBalance(firstOwner), 100);
  });

  it("validates unknown, duplicate, excessive and malformed offers before writes", async () => {
    const input = request();
    const invalid = [
      { ...input, tradeId: "" },
      { ...input, tradeId: "a".repeat(129) },
      { ...input, first: { ...input.first, ownerKey: "guest" } },
      { ...input, second: { ...input.second, ownerKey: firstOwner.toUpperCase() } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: -1, items: [] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: 1e9 + 1, items: [] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: 0.5, items: [] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: NaN, items: [] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: 0, items: [{ itemKey: "unknown", quantity: 1 }] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: 0, items: [{ itemKey: "acorn", quantity: 10_000 }] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: 0, items: [{ itemKey: "acorn", quantity: 0 }] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: 0, items: [...input.first.offer.items, ...input.first.offer.items] } } },
      { ...input, first: { ownerKey: firstOwner, offer: { currency: 0, items: ["acorn", "carrot", "copper-coin", "herb", "den-fur", "antler", "old-dagger"].map((itemKey) => ({ itemKey, quantity: 1 })) } } },
      null,
      { ...input, second: null },
    ];
    for (const candidate of invalid) {
      const result = await store.exchange(candidate as AtomicTradeRequest);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, "invalid-offer");
    }
    assert.equal(await currency.getBalance(firstOwner), 100);
  });

  it("checks capacity after both outgoing stacks have been removed", async () => {
    for (const owner of [firstOwner, secondOwner]) {
      for (let index = 1; index < MAX_DISTINCT_ITEMS; index += 1) {
        await inventory.add(owner, `filler-${index}`, 1);
      }
    }
    const input = request();
    input.second.offer.items = [{ itemKey: "herb", quantity: 4 }];
    assert.equal((await store.exchange(input)).ok, true);
    assert.equal(inventory.peekBag(firstOwner).size, MAX_DISTINCT_ITEMS);
    assert.equal(inventory.peekBag(secondOwner).size, MAX_DISTINCT_ITEMS);
  });

  it("refuses a final full bag or overflowing stack without moving currency", async () => {
    for (let index = 1; index < MAX_DISTINCT_ITEMS; index += 1) {
      await inventory.add(firstOwner, `filler-${index}`, 1);
    }
    const input = request();
    input.first.offer.items = [];
    assert.deepEqual(await store.exchange(input), { ok: false, reason: "bag-full", ownerKey: firstOwner });
    assert.equal(await currency.getBalance(firstOwner), 100);
    inventory.pokeBag(firstOwner, new Map([["herb", 2_147_483_647]]));
    assert.deepEqual(await store.exchange({ ...input, tradeId: randomUUID() }),
      { ok: false, reason: "invalid-offer", ownerKey: firstOwner, itemKey: "herb" });
  });

  it("serializes duplicate and conflicting calls without duplicating assets", async () => {
    const input = request();
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => store.exchange(input)));
    assert.ok(outcomes.every((outcome) => outcome.ok));
    assert.equal(await currency.getBalance(firstOwner), 85);
    const conflict = await store.exchange({ ...input, tradeId: randomUUID() });
    assert.deepEqual(conflict, { ok: false, reason: "insufficient-item", ownerKey: firstOwner, itemKey: "acorn" });
    assert.equal(await currency.getBalance(firstOwner) + await currency.getBalance(secondOwner), 150);
  });
});
