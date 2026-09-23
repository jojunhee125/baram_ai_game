import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { PROGRESSION_ITEM_ICON_ORDER, PROGRESSION_REGIONS, LEVEL_CAP, levelForExp, ServerMessage, cumulativeExpForLevel, Direction, type JoinOptions } from "@zep-test/shared";
import { InMemoryClassStore } from "../db/classStore";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { InMemoryProgressStore } from "../db/progressStore";
import { InMemoryQuestStore } from "../db/questStore";
import { InMemorySettlementStore } from "../db/settlementStore";
import { validateItemDefinitions } from "../game/items";
import { TiledMapLoader } from "../game/tiledMap";
import { CRAFTING_RECIPES, validateCraftingRecipes } from "./craftingSystem";
import { ROOM_DEFINITIONS } from "./definitions";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import { ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS } from "./itemDefinitions";
import { LANDMARK_DEFINITIONS } from "./landmarkDefinitions";
import { buildLootTableView } from "./lootTableView";
import { MetaverseRoom } from "./metaverseRoom";
import { MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES, type MonsterKind, monsterTypesForRoom, validateMonsterSpawnDefinitions } from "./monsterDefinitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";
import { QUEST_DEFINITIONS, validateQuestDefinitions } from "./questDefinitions";
import { SHOP_DEFINITIONS, validateShopDefinitions } from "./shopDefinitions";

type Client = Parameters<MetaverseRoom["onJoin"]>[0];
class AuditRoom extends MetaverseRoom {
  override setSimulationInterval(): void {}
  protected override random(): number { return 0; }
}
const flush = async () => { for (let i = 0; i < 16; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

function stores() {
  const inventoryStore = new InMemoryInventoryStore(), currencyStore = new InMemoryCurrencyStore();
  return { inventoryStore, currencyStore, settlementStore: new InMemorySettlementStore(currencyStore, inventoryStore),
    progressStore: new InMemoryProgressStore(), classStore: new InMemoryClassStore(), questStore: new InMemoryQuestStore() };
}

async function fixture(name: string, data = stores(), owner = randomUUID()) {
  const room = new AuditRoom();
  Object.defineProperty(room, "roomName", { value: name });
  await room.onCreate({ ...ROOM_DEFINITIONS.find((row) => row.name === name)!, ...data });
  async function join(options: Partial<JoinOptions> = {}) {
    const messages: { type: string; payload: unknown }[] = [];
    const client = { sessionId: randomUUID(), auth: { ssoNickname: null, ssoUserId: owner }, send: (type: string, payload: unknown) => messages.push({ type, payload }) } as unknown as Client;
    await room.onJoin(client, { nickname: "progression-audit", avatarSkin: 0, ...options });
    await flush();
    return { client, messages };
  }
  return { room, data, owner, join };
}


const legacy = JSON.parse(readFileSync(new URL("./__fixtures__/legacy-hunting-catalog.json", import.meta.url), "utf8")) as {
  items: typeof ITEM_DEFINITIONS; quests: { id: string; reward: { currencyDelta: number }; count: number }[];
};
const regionIds = ["buyeo-novice", "buyeo-rat-cave", "buyeo-snake-cave", "buyeo-bear-cave", "buyeo-deer-cave", "buyeo-pig-cave", "buyeo-fox-cave"];

it("preserves all 67 saved item definitions and 11 quest reward contracts without activating retired acquisitions", async () => {
  assert.equal(legacy.items.length, 67);
  for (const previous of legacy.items) assert.deepEqual(ITEM_DEFINITIONS.find(item => item.key === previous.key), previous, previous.key);
  assert.equal(new Set(ITEM_DEFINITIONS.map(item => item.key)).size, ITEM_DEFINITIONS.length);
  assert.ok(MAX_DISTINCT_ITEMS >= ITEM_DEFINITIONS.length);
  assert.deepEqual(QUEST_DEFINITIONS.map(({ id, reward, objective }) => ({ id, reward, count: objective.count })), legacy.quests);
  assert.deepEqual(PROGRESSION_REGIONS.map(region => region.roomId), regionIds);
  assert.ok(ROOM_DEFINITIONS.every(room => !room.name.startsWith("hunting-")));
  assert.ok(PORTAL_DEFINITIONS.every(portal => !portal.from.room.startsWith("hunting-") && !portal.to.room.startsWith("hunting-")));
  assert.ok(LANDMARK_DEFINITIONS.every(row => !row.room.startsWith("hunting-")));
  assert.ok(MONSTER_SPAWN_DEFINITIONS.every(row => !row.room.startsWith("hunting-") && row.kind !== "boss"));
  const activeKeys = new Set([
    ...MONSTER_SPAWN_DEFINITIONS.flatMap(spawn => monsterTypesForRoom(spawn.room).get(spawn.kind)!.loot.map(row => row.itemKey)),
    ...SHOP_DEFINITIONS.flatMap(shop => shop.listings.map(row => row.itemKey)),
    ...CRAFTING_RECIPES.map(recipe => recipe.output.itemKey),
  ]);
  for (const item of legacy.items.slice(19)) assert.equal(activeKeys.has(item.key), false, `retired acquisition: ${item.key}`);
  assert.deepEqual(validateItemDefinitions(ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS).errors, []);
  assert.deepEqual(validateCraftingRecipes(CRAFTING_RECIPES, ITEM_DEFINITIONS), []);
  assert.deepEqual(validateQuestDefinitions(QUEST_DEFINITIONS, INTERACTABLE_DEFINITIONS, MONSTER_SPAWN_DEFINITIONS).errors, []);
  assert.deepEqual(validateShopDefinitions(SHOP_DEFINITIONS, INTERACTABLE_DEFINITIONS, ITEM_DEFINITIONS).errors, []);
  const loader = new TiledMapLoader();
  const maps = new Map(await Promise.all(ROOM_DEFINITIONS.map(async row => [row.name, await loader.load(row.mapKey)] as const)));
  assert.deepEqual(validateMonsterSpawnDefinitions(MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES, ITEM_DEFINITIONS, maps, PORTAL_DEFINITIONS, INTERACTABLE_DEFINITIONS, monsterTypesForRoom).errors, []);
  assert.equal(LEVEL_CAP, 30);
  assert.equal(levelForExp(cumulativeExpForLevel(30) + 10_000_000), 30);
  assert.equal(MONSTER_TYPES.get("boss")?.expReward, 600);
});

it("seven live maps have connected playable space, reachable portals/NPCs and safe arrival margins", async () => {
  const loader = new TiledMapLoader();
  const layouts = new Set<string>();
  for (const region of PROGRESSION_REGIONS) {
    const definition = ROOM_DEFINITIONS.find(row => row.name === region.roomId)!;
    const map = await loader.load(definition.mapKey);
    assert.deepEqual([map.widthInTiles, map.heightInTiles], [64, 37]);
    const key = (x: number, y: number) => y * map.widthInTiles + x;
    const queue = [[definition.spawn.tileX, definition.spawn.tileY]], seen = new Set([key(...queue[0]! as [number, number])]);
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i]!;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x! + dx!, ny = y! + dy!;
        if (map.isWalkable(nx, ny) && !seen.has(key(nx, ny))) { seen.add(key(nx, ny)); queue.push([nx, ny]); }
      }
    }
    let total = 0;
    for (let y = 0; y < map.heightInTiles; y++) for (let x = 0; x < map.widthInTiles; x++) if (map.isWalkable(x, y)) {
      total++;
      assert.ok(x >= 16 && x <= 47 && y >= 8 && y <= 27, `${region.roomId}: playable bounds ${x},${y}`);
    }
    assert.equal(seen.size, total, `${region.roomId}: disconnected walkable tiles`);
    layouts.add([...seen].sort((a, b) => a - b).join(","));
    const triggers = PORTAL_DEFINITIONS.filter(p => p.from.room === region.roomId).flatMap(p => p.from.tiles);
    const arrivals = [definition.spawn, ...PORTAL_DEFINITIONS.filter(p => p.to.room === region.roomId).map(p => p.to.arrival),
      ...LANDMARK_DEFINITIONS.filter(l => l.room === region.roomId && l.tile).map(l => l.tile!)];
    const safe = [...triggers, ...INTERACTABLE_DEFINITIONS.filter(npc => npc.at.room === region.roomId).flatMap(npc => npc.at.tiles)];
    for (const area of arrivals) for (let dx = -area.spreadRadiusInTiles; dx <= area.spreadRadiusInTiles; dx++) for (let dy = -area.spreadRadiusInTiles; dy <= area.spreadRadiusInTiles; dy++) {
      const point = { tileX: area.tileX + dx, tileY: area.tileY + dy };
      if (!map.isWalkable(point.tileX, point.tileY)) continue;
      assert.ok(!triggers.some(t => t.tileX === point.tileX && t.tileY === point.tileY), `${region.roomId}: arrival retriggers portal`);
      safe.push(point);
    }
    const spawns = MONSTER_SPAWN_DEFINITIONS.filter(spawn => spawn.room === region.roomId);
    assert.deepEqual(new Set(spawns.map(spawn => spawn.kind)), new Set(region.monsterKinds));
    for (const point of safe) {
      assert.ok(seen.has(key(point.tileX, point.tileY)), `${region.roomId}: unreachable safe point`);
      for (const spawn of spawns) assert.ok(Math.max(Math.abs(spawn.at.tileX - point.tileX), Math.abs(spawn.at.tileY - point.tileY)) > spawn.wanderRadiusTiles + monsterTypesForRoom(region.roomId).get(spawn.kind)!.aggroRadiusTiles, `${spawn.id}: unsafe point ${JSON.stringify(point)}`);
    }
  }
  assert.equal(layouts.size, 7, "all representative rooms need distinct collision layouts");
  const actual = new Set(PORTAL_DEFINITIONS.filter(p => regionIds.includes(p.from.room) || regionIds.includes(p.to.room)).map(p => `${p.from.room}>${p.to.room}`));
  const pairs = [["plaza", "buyeo-novice"], ...["rat", "bear", "deer", "pig", "fox"].map(name => ["buyeo-novice", `buyeo-${name}-cave`]), ["buyeo-rat-cave", "buyeo-snake-cave"]];
  assert.deepEqual(actual, new Set(pairs.flatMap(([a,b]) => [`${a}>${b}`, `${b}>${a}`])));
});

for (const region of PROGRESSION_REGIONS) {
  it(`${region.roomId}: live resolver kills award exactly the displayed loot and EXP`, async () => {
    const f = await fixture(region.roomId);
    try {
      const { client } = await f.join();
      const expected = new Map<string, number>();
      let exp = 0;
      assert.deepEqual(new Set(buildLootTableView(region.roomId).map(row => row.kind)), new Set(region.monsterKinds));
      for (const kind of region.monsterKinds) {
        const [id, runtime] = [...f.room["monsterRuntimes"]].find(([, value]) => value.type.kind === kind)!;
        const shown = buildLootTableView(region.roomId).find(row => row.kind === kind)!;
        assert.equal(shown.expReward, runtime.type.expReward);
        assert.deepEqual(shown.drops.map(row => [row.itemKey, row.quantity, row.chancePercent]), runtime.type.loot.map(row => [row.itemKey, row.quantity, Math.round(row.chance * 1000) / 10]));
        for (const row of runtime.type.loot) if (row.chance > 0) expected.set(row.itemKey, (expected.get(row.itemKey) ?? 0) + row.quantity);
        exp += runtime.type.expReward;
        f.room["applyMonsterDamage"](client, client.userData!, id, runtime.hp, Date.now());
        await flush();
      }
      assert.equal(await f.data.progressStore.getExp(f.owner), exp);
      assert.deepEqual(new Map((await f.data.inventoryStore.list(f.owner)).map(row => [row.itemKey, row.quantity])), expected);
      for (const key of region.itemKeys) assert.ok(ITEM_DEFINITIONS.some(item => item.key === key));
    } finally { f.room.onDispose(); }
  });
}

it("legacy weapons keep level/class gates and every legacy item survives room reconnect", async () => {
  for (const item of legacy.items.filter(item => item.equipment?.slot === "weapon" && item.equipment.requirement?.classes)) {
    const f = await fixture("buyeo-novice");
    try {
      await f.data.inventoryStore.add(f.owner, item.key, 1);
      const level = item.equipment!.requirement!.minLevel!;
      const classKey = item.equipment!.requirement!.classes![0]!;
      await f.data.classStore.chooseOnce(f.owner, classKey);
      await f.data.progressStore.grantExp(f.owner, cumulativeExpForLevel(level - 1));
      const low = await f.join();
      f.room["handleEquipItem"](low.client, { itemKey: item.key, slot: "weapon" }); await flush();
      assert.deepEqual(await f.data.inventoryStore.getEquippedSlots(f.owner), {});
      await f.data.progressStore.grantExp(f.owner, cumulativeExpForLevel(level) - cumulativeExpForLevel(level - 1));
      const eligible = await f.join();
      f.room["handleEquipItem"](eligible.client, { itemKey: item.key, slot: "weapon" }); await flush();
      assert.equal((await f.data.inventoryStore.getEquippedSlots(f.owner)).weapon, item.key);
    } finally { f.room.onDispose(); }
  }
  const data = stores(), owner = randomUUID();
  for (const item of legacy.items) await data.inventoryStore.add(owner, item.key, 1);
  for (const name of ["buyeo-novice", "buyeo-rat-cave"]) {
    const f = await fixture(name, data, owner);
    try { await f.join(); assert.equal((await data.inventoryStore.list(owner)).length, 67); }
    finally { f.room.onDispose(); }
  }
});

it("old completed/unsettled quests settle original rewards exactly once across concurrent relogin", async () => {
  const data = stores(), owner = randomUUID();
  for (const quest of legacy.quests) {
    await data.questStore.accept(owner, quest.id);
    for (let i = 0; i < quest.count; i++) await data.questStore.recordKill(owner, quest.id, quest.count);
  }
  const rooms = await Promise.all(Array.from({ length: 4 }, () => fixture("buyeo-novice", data, owner)));
  try {
    await Promise.all(rooms.map(f => f.join())); await flush();
    const total = legacy.quests.reduce((sum, quest) => sum + quest.reward.currencyDelta, 0);
    assert.equal(await data.currencyStore.getBalance(owner), total);
    assert.ok((await data.questStore.list(owner)).every(row => row.completed && row.settled));
    await Promise.all(rooms.map(f => f.join())); await flush();
    assert.equal(await data.currencyStore.getBalance(owner), total);
  } finally { for (const f of rooms) f.room.onDispose(); }
});

it("retargeted quest objectives ignore other rooms, preserve partial progress and cap original counts", async () => {
  for (const quest of QUEST_DEFINITIONS) {
    const data = stores(), owner = randomUUID();
    await data.questStore.accept(owner, quest.id);
    await data.questStore.recordKill(owner, quest.id, quest.objective.count);
    await data.inventoryStore.add(owner, "entry-pass", 1);
    const wrong = await fixture(quest.objective.room === "buyeo-fox-cave" ? "buyeo-novice" : "buyeo-fox-cave", data, owner);
    try {
      const { client } = await wrong.join();
      for (let i = 0; i < 20; i++) wrong.room["advanceQuests"]({ sessionId: client.sessionId, ownerKey: owner }, quest.objective.kind);
      await flush();
      assert.equal((await data.questStore.list(owner)).find(row => row.questId === quest.id)!.killCount, 1);
      assert.equal(await data.currencyStore.getBalance(owner), 0);
    } finally { wrong.room.onDispose(); }
    const f = await fixture(quest.objective.room ?? "buyeo-novice", data, owner);
    try {
      const { client } = await f.join();
      for (let i = 0; i < quest.objective.count + 5; i++) f.room["advanceQuests"]({ sessionId: client.sessionId, ownerKey: owner }, quest.objective.kind);
      await flush();
      const row = (await data.questStore.list(owner)).find(row => row.questId === quest.id)!;
      assert.deepEqual([row.killCount, row.completed, row.settled], [quest.objective.count, true, true]);
      assert.equal(await data.currencyStore.getBalance(owner), quest.reward!.currencyDelta);
    } finally { f.room.onDispose(); }
  }
});

it("concurrent joins respect authored 20-player capacity", async () => {
  const f = await fixture("buyeo-rat-cave");
  try {
    await f.data.inventoryStore.grantOnce(f.owner, "entry-pass");
    const result = await Promise.allSettled(Array.from({ length: 25 }, () => f.join()));
    assert.equal(result.filter(entry => entry.status === "fulfilled").length, 20);
    assert.equal(f.room.state.players.size, 20);
    for (const entry of result) if (entry.status === "rejected") assert.match(String(entry.reason), /full/);
  } finally { f.room.onDispose(); }
});

it("same ring cannot occupy both slots even with quantity two or simultaneous requests; distinct rings can", async () => {
  for (const quantity of [1, 2]) {
    const store = new InMemoryInventoryStore(), owner = randomUUID();
    await store.add(owner, "quarry-ring", quantity);
    const result = await Promise.all([store.equip(owner, "quarry-ring", "ring1"), store.equip(owner, "quarry-ring", "ring2")]);
    assert.equal(result.filter(Boolean).length, 1);
    assert.deepEqual(await store.list(owner), [{ itemKey: "quarry-ring", quantity, equipped: true, equippedSlot: "ring1" }]);
    await store.add(owner, "ruin-ring", 1);
    assert.equal(await store.equip(owner, "ruin-ring", "ring2"), true);
    assert.deepEqual(await store.getEquippedSlots(owner), { ring1: "quarry-ring", ring2: "ruin-ring" });
    assert.equal(await store.unequip(owner, "ring1"), true);
    assert.equal(await store.equip(owner, "quarry-ring", "ring2"), true);
    assert.deepEqual(await store.getEquippedSlots(owner), { ring2: "quarry-ring" });
  }
});


it("original species drop only their authored source items, including zero loot for female deer", () => {
  const expected: Record<string, readonly string[]> = {
    squirrel: ["acorn"], rabbit: ["rabbit-meat"], "female-deer": [], rat: ["rat-meat"], bat: ["bat-meat"],
    snake: ["snake-meat"], python: ["good-snake-meat"], "king-python": ["strength-helmet-1"],
    bear: ["bear-hide"], pyeongung: ["bear-gall"], tiger: ["tiger-hide"], "blue-deer": ["deer-meat"], "red-deer": ["deer-meat"],
    "wild-boar": ["wild-pork"], "forest-boar": ["forest-pork"], "black-fox": ["fox-fur"], "white-fox": ["fox-fur"], gumiho: ["square-shield"],
  };
  for (const region of PROGRESSION_REGIONS) for (const kind of region.monsterKinds)
    assert.deepEqual(monsterTypesForRoom(region.roomId).get(kind as MonsterKind)!.loot.map(row => row.itemKey), expected[kind], kind);
  assert.equal(ITEM_DEFINITIONS.find(item => item.key === "square-shield")!.equipment, undefined);
  assert.ok(ITEM_DEFINITIONS.find(item => item.key === "square-shield")!.sellValue! > 0);
  assert.deepEqual(PROGRESSION_ITEM_ICON_ORDER.slice(0, 48), legacy.items.slice(19).map(item => item.icon));
});

it("all fourteen graph edges work through real move and join handlers without a legacy entry pass", async () => {
  const loader = new TiledMapLoader();
  for (const portal of PORTAL_DEFINITIONS.filter(p => regionIds.includes(p.from.room) || regionIds.includes(p.to.room))) {
    const source = await fixture(portal.from.room);
    const target = await fixture(portal.to.room, source.data, source.owner);
    try {
      const { client, messages } = await source.join();
      const map = await loader.load(ROOM_DEFINITIONS.find(row => row.name === portal.from.room)!.mapKey);
      const trigger = portal.from.tiles[0]!;
      const steps = [[0, 1, Direction.Up], [0, -1, Direction.Down], [1, 0, Direction.Left], [-1, 0, Direction.Right]] as const;
      const [dx, dy, dir] = steps.find(([dx, dy]) => map.isWalkable(trigger.tileX + dx, trigger.tileY + dy))!;
      const player = source.room.state.players.get(client.sessionId)!;
      player.tileX = trigger.tileX + dx; player.tileY = trigger.tileY + dy;
      source.room["proximityIndex"].move(client.sessionId, player);
      source.room["handleMove"](client, { dir }); await flush();
      assert.deepEqual(messages.find(row => row.type === ServerMessage.PortalEntered)?.payload,
        { portalId: portal.id, toRoom: portal.to.room }, portal.id);
      const arrival = await target.join({ viaPortal: portal.id });
      const landed = target.room.state.players.get(arrival.client.sessionId)!;
      assert.deepEqual([landed.tileX, landed.tileY], [portal.to.arrival.tileX, portal.to.arrival.tileY], portal.id);
      assert.deepEqual(await source.data.inventoryStore.list(source.owner), []);
    } finally { source.room.onDispose(); target.room.onDispose(); }
  }
});

it("saved legacy tonic remains usable and sellable while new trophy rejects equip and sells once", async () => {
  const f = await fixture("buyeo-novice");
  try {
    await f.data.progressStore.grantExp(f.owner, cumulativeExpForLevel(30));
    await f.data.inventoryStore.add(f.owner, "marsh-tonic", 2);
    await f.data.inventoryStore.add(f.owner, "square-shield", 1);
    const { client } = await f.join();
    client.userData!.hp = 1;
    f.room["handleUseItem"](client, { itemKey: "marsh-tonic", nonce: randomUUID() }); await flush();
    assert.equal(client.userData!.hp, 76);
    f.room["handleEquipItem"](client, { itemKey: "square-shield", slot: "armor" }); await flush();
    assert.deepEqual(await f.data.inventoryStore.getEquippedSlots(f.owner), {});
    for (const key of ["marsh-tonic", "square-shield"]) {
      const request = { itemKey: key, quantity: 1, nonce: randomUUID() };
      for (let i = 0; i < 20; i++) f.room["handleSellItem"](client, request);
      await flush();
    }
    assert.equal(await f.data.currencyStore.getBalance(f.owner), 6 + ITEM_DEFINITIONS.find(item => item.key === "square-shield")!.sellValue!);
    assert.deepEqual(await f.data.inventoryStore.list(f.owner), []);
  } finally { f.room.onDispose(); }
});


it("every active recipe is reachable from live drop/shop sources without saved legacy materials", () => {
  const obtainable = new Set([
    ...MONSTER_SPAWN_DEFINITIONS.flatMap(spawn => monsterTypesForRoom(spawn.room).get(spawn.kind)!.loot.filter(row => row.chance > 0).map(row => row.itemKey)),
    ...SHOP_DEFINITIONS.flatMap(shop => shop.listings.map(row => row.itemKey)),
  ]);
  for (let pass = 0; pass < CRAFTING_RECIPES.length; pass++) for (const recipe of CRAFTING_RECIPES)
    if (recipe.ingredients.every(input => obtainable.has(input.itemKey))) obtainable.add(recipe.output.itemKey);
  for (const recipe of CRAFTING_RECIPES) {
    assert.ok(obtainable.has(recipe.output.itemKey), `${recipe.recipeId}: unreachable output`);
    for (const input of recipe.ingredients) assert.ok(obtainable.has(input.itemKey), `${recipe.recipeId}: inactive ingredient ${input.itemKey}`);
  }
  assert.equal(obtainable.has("den-fur"), false, "legacy ownership must not satisfy fresh-account recipe reachability");
});
