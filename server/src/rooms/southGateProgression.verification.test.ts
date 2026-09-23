import assert from "node:assert/strict";
import { it } from "node:test";
import { ServerMessage, type ItemGranted, type EquipmentSlot } from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { InMemoryProgressStore } from "../db/progressStore";
import { InMemorySettlementStore } from "../db/settlementStore";
import { TableInteractableIndex } from "../game/interactables";
import { TiledMapLoader } from "../game/tiledMap";
import { decideMonsterAction, MonsterAiState, type MonsterSnapshot } from "../game/monsterAi";
import { STEP_BY_DIRECTION } from "../game/movement";
import type { CollisionMap, RoomCreateOptions } from "./contracts";
import { ROOM_DEFINITIONS } from "./definitions";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import { ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS } from "./itemDefinitions";
import { buildLootTableView } from "./lootTableView";
import { MetaverseRoom } from "./metaverseRoom";
import { MONSTER_TYPES, MONSTER_SPAWN_DEFINITIONS, MonsterKind, monsterTypesForRoom,
  validateMonsterSpawnDefinitions } from "./monsterDefinitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";

const OWNER = "781dc379-0af2-4785-bf6c-e1db84b659f5";
type Client = Parameters<MetaverseRoom["onJoin"]>[0];
class AuditRoom extends MetaverseRoom {
  auditRoomName = "plaza";
  protected override createInteractableIndex(map: CollisionMap) {
    return new TableInteractableIndex(this.auditRoomName, INTERACTABLE_DEFINITIONS, map);
  }
  override setSimulationInterval(): void {}
  protected override random(): number { return 0; }
}
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await new Promise<void>(resolve => setImmediate(resolve));
}
async function fixture(name = "plaza", overrides: Partial<RoomCreateOptions> = {}) {
  const inventoryStore = new InMemoryInventoryStore();
  const currencyStore = new InMemoryCurrencyStore();
  const progressStore = new InMemoryProgressStore();
  const settlementStore = new InMemorySettlementStore(currencyStore, inventoryStore);
  const room = new AuditRoom();
  room.auditRoomName = name;
  Object.defineProperty(room, "roomName", { value: name });
  const definition = ROOM_DEFINITIONS.find(row => row.name === name)!;
  await room.onCreate({ ...definition, inventoryStore, currencyStore, progressStore, settlementStore, ...overrides });
  function join(id: string) {
    const messages: { type: string; payload: unknown }[] = [];
    const client = { sessionId: id, auth: { ssoNickname: null, ssoUserId: OWNER },
      send: (type: string, payload: unknown) => messages.push({ type, payload }) } as unknown as Client;
    room.onJoin(client, { nickname: id, avatarSkin: 0 });
    return { client, messages };
  }
  const player = join("audit-player");
  await flush();
  return { room, ...player, join, inventoryStore, currencyStore, progressStore, settlementStore };
}
function buy(room: AuditRoom, client: Client, itemKey = "old-dagger", nonce = "buy-1") {
  room["handleBuyItem"](client, { npcObjectId: "plaza-shop-npc", itemKey, quantity: 1, nonce });
}
function sell(room: AuditRoom, client: Client, itemKey = "old-dagger", nonce = "sell-1") {
  room["handleSellItem"](client, { itemKey, quantity: 1, nonce });
}
function equip(room: AuditRoom, client: Client, itemKey = "old-dagger", slot: EquipmentSlot = "weapon") {
  room["handleEquipItem"](client, { itemKey, slot });
}

it("regional resolution does not change base tables or another region after repeated lookups", () => {
  const before = JSON.stringify([...MONSTER_TYPES]);
  for (let i = 0; i < 100; i++) {
    const field = monsterTypesForRoom("buyeo-novice");
    const den = monsterTypesForRoom("buyeo-rat-cave");
    assert.equal(field.get(MonsterKind.Rabbit)!.maxHp, 19);
    assert.equal(field.get(MonsterKind.Squirrel)!.expReward, 1);
    assert.equal(den.get(MonsterKind.Rat)!.maxHp, 48);
    assert.equal(den.get(MonsterKind.Bat)!.expReward, 26);
    assert.equal(den.has(MonsterKind.Boss), false);
    assert.deepEqual([...monsterTypesForRoom(undefined)], [...MONSTER_TYPES]);
    assert.deepEqual([...monsterTypesForRoom("unknown")], [...MONSTER_TYPES]);
  }
  assert.equal(JSON.stringify([...MONSTER_TYPES]), before);
});

for (const [name, kind] of [["buyeo-novice", MonsterKind.Rabbit], ["buyeo-rat-cave", MonsterKind.Rat]] as const) {
  it(`${name}: actual rabbit death awards the region's EXP and full loot displayed by API`, async () => {
    const f = await fixture(name);
    try {
      const [id, runtime] = [...f.room["monsterRuntimes"]].find(([, row]) => row.type.kind === kind)!;
      const expected = monsterTypesForRoom(name).get(kind)!;
      assert.equal(runtime.hp, expected.maxHp);
      f.room["applyMonsterDamage"](f.client, f.client.userData!, id, expected.maxHp, Date.now());
      await flush();
      assert.equal(f.room.state.monsters.has(id), false);
      assert.equal(await f.progressStore.getExp(OWNER), expected.expReward);
      const actual = (await f.inventoryStore.list(OWNER)).map(row => ({ itemKey: row.itemKey, quantity: row.quantity }));
      assert.deepEqual(actual.sort((a,b) => a.itemKey.localeCompare(b.itemKey)),
        expected.loot.map(row => ({ itemKey: row.itemKey, quantity: row.quantity })).sort((a,b) => a.itemKey.localeCompare(b.itemKey)));
      const view = buildLootTableView(name).find(row => row.kind === kind)!;
      assert.equal(view.expReward, expected.expReward);
      assert.deepEqual(view.drops.map(row => row.itemKey), expected.loot.map(row => row.itemKey));
      for (const drop of view.drops) {
        assert.equal(drop.quantity, expected.loot.find(row => row.itemKey === drop.itemKey)!.quantity);
        assert.equal(drop.sellValue, ITEM_DEFINITIONS.find(row => row.key === drop.itemKey)!.sellValue);
      }
    } finally { f.room.onDispose(); }
  });
}

it("50 quest coins buy a dagger; equip changes damage, selling worn gear fails, and a replacement persists", async () => {
  const f = await fixture();
  try {
    await f.currencyStore.credit(OWNER, 50);
    buy(f.room, f.client);
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER), 10);
    equip(f.room, f.client);
    await flush();
    assert.equal(f.room["totalAttack"](f.client.userData!), 6);
    sell(f.room, f.client);
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER), 10);
    assert.equal((await f.inventoryStore.list(OWNER)).find(row => row.itemKey === "old-dagger")?.quantity, 1);
    f.room["handleUnequipItem"](f.client, { slot: "weapon" });
    await flush();
    sell(f.room, f.client, "old-dagger", "after-unequip");
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER), 20);
    assert.equal(f.room["totalAttack"](f.client.userData!), 4);
    await f.currencyStore.credit(OWNER, 160);
    buy(f.room, f.client, "hunting-blade", "upgrade");
    await flush();
    equip(f.room, f.client, "hunting-blade");
    await flush();
    assert.equal(f.room["totalAttack"](f.client.userData!), 10);
    assert.deepEqual(await f.inventoryStore.getEquippedSlots(OWNER), { weapon: "hunting-blade" });
    assert.equal(await f.currencyStore.getBalance(OWNER), 0);
    const later = await fixture("buyeo-novice", { inventoryStore: f.inventoryStore, currencyStore: f.currencyStore });
    try { assert.equal(later.room["totalAttack"](later.client.userData!), 10); }
    finally { later.room.onDispose(); }
  } finally { f.room.onDispose(); }
});

it("purchase boundaries: insufficient funds, simultaneous nonce replay, and full bag keep balances atomic", async () => {
  const f = await fixture();
  try {
    await f.currencyStore.credit(OWNER, 39);
    buy(f.room, f.client);
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER), 39);
    assert.deepEqual(await f.inventoryStore.list(OWNER), []);
    await f.currencyStore.credit(OWNER, 1);
    for (let i = 0; i < 25; i++) buy(f.room, f.client);
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER), 0);
    assert.equal((await f.inventoryStore.list(OWNER))[0]!.quantity, 1);
    for (let i = 1; i < MAX_DISTINCT_ITEMS; i++) await f.inventoryStore.add(OWNER, `filler-${i}`, 1);
    await f.currencyStore.credit(OWNER, 180);
    buy(f.room, f.client, "hunting-blade", "bag-full");
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER), 180);
    assert.equal((await f.inventoryStore.list(OWNER)).some(row => row.itemKey === "hunting-blade"), false);
  } finally { f.room.onDispose(); }
});

it("equip then sell in the same turn cannot retain a stat bonus for an item no longer owned", async () => {
  const f = await fixture();
  try {
    await f.inventoryStore.add(OWNER, "old-dagger", 1);
    equip(f.room, f.client);
    sell(f.room, f.client);
    await flush();
    const owned = (await f.inventoryStore.list(OWNER)).some(row => row.itemKey === "old-dagger");
    assert.ok(owned || f.room["totalAttack"](f.client.userData!) === 4, "sold item must not keep +2 attack in the room cache");
    assert.ok(owned || (await f.inventoryStore.getEquippedSlots(OWNER)).weapon === undefined, "sold item must not keep a persisted equipped slot");
  } finally { f.room.onDispose(); }
});

it("a sibling session with stale equipment cache cannot sell another session's worn item", async () => {
  const f = await fixture();
  try {
    await f.inventoryStore.add(OWNER, "old-dagger", 1);
    const sibling = f.join("sibling");
    await flush();
    equip(f.room, f.client);
    await flush();
    sell(f.room, sibling.client);
    await flush();
    assert.equal((await f.inventoryStore.list(OWNER)).some(row => row.itemKey === "old-dagger"), true);
    assert.equal(await f.currencyStore.getBalance(OWNER), 0);
  } finally { f.room.onDispose(); }
});

it("a sibling room unequip then sale removes the former wearer's attack bonus", async () => {
  const f = await fixture();
  const sibling = await fixture("buyeo-novice", { inventoryStore: f.inventoryStore,
    currencyStore: f.currencyStore, settlementStore: f.settlementStore });
  try {
    await f.inventoryStore.add(OWNER, "old-dagger", 1);
    equip(f.room, f.client);
    await flush();
    assert.equal(f.room["totalAttack"](f.client.userData!), 6);
    sibling.room["handleUnequipItem"](sibling.client, { slot: "weapon" });
    await flush();
    sell(sibling.room, sibling.client);
    await flush();
    assert.equal((await f.inventoryStore.list(OWNER)).some(row => row.itemKey === "old-dagger"), false);
    assert.equal(f.room["totalAttack"](f.client.userData!), 4);
    assert.equal(await f.currencyStore.getBalance(OWNER), 10);
  } finally { sibling.room.onDispose(); f.room.onDispose(); }
});

it("all portals, NPCs, and monster origins remain reachable from each authored room spawn", async () => {
  const loader = new TiledMapLoader();
  for (const definition of ROOM_DEFINITIONS.filter(row => row.name !== "grand-plaza")) {
    const map = await loader.load(definition.mapKey);
    const key = (x: number, y: number) => `${x},${y}`;
    const seen = new Set([key(definition.spawn.tileX, definition.spawn.tileY)]);
    const queue = [[definition.spawn.tileX, definition.spawn.tileY]];
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i]!;
      for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nx = x! + dx!, ny = y! + dy!, point = key(nx,ny);
        if (map.isWalkable(nx,ny) && !seen.has(point)) { seen.add(point); queue.push([nx,ny]); }
      }
    }
    const points = [
      ...PORTAL_DEFINITIONS.filter(row => row.from.room === definition.name).flatMap(row => row.from.tiles),
      ...PORTAL_DEFINITIONS.filter(row => row.to.room === definition.name).map(row => row.to.arrival),
      ...INTERACTABLE_DEFINITIONS.filter(row => row.at.room === definition.name).flatMap(row => row.at.tiles),
      ...MONSTER_SPAWN_DEFINITIONS.filter(row => row.room === definition.name).map(row => row.at),
    ];
    for (const point of points) assert.ok(seen.has(key(point.tileX,point.tileY)), `${definition.name}: unreachable ${key(point.tileX,point.tileY)}`);
  }
});

it("den's full arrival spread is outside each monster's wander plus aggro radius", () => {
  const safe = [{tileX:31,tileY:26}, ...Array.from({length:9},(_,i)=>({tileX:30+i%3,tileY:23+Math.floor(i/3)}))];
  for (const spawn of MONSTER_SPAWN_DEFINITIONS.filter(row => row.room === "buyeo-rat-cave")) {
    const type = monsterTypesForRoom("buyeo-rat-cave").get(spawn.kind)!;
    for (const point of safe) assert.ok(Math.max(Math.abs(point.tileX-spawn.at.tileX),Math.abs(point.tileY-spawn.at.tileY)) > spawn.wanderRadiusTiles+type.aggroRadiusTiles, `${spawn.id} threatens ${JSON.stringify(point)}`);
  }
});

it("boot validation rejects invalid regional EXP and drops even when the base map is valid", async () => {
  const loader = new TiledMapLoader();
  const maps = new Map(await Promise.all(ROOM_DEFINITIONS.map(async row => [row.name, await loader.load(row.mapKey)] as const)));
  for (const patch of [
    { expReward: 0 },
    { loot: [{ itemKey: "missing-item", chance: 0.5, quantity: 1 }] },
    { loot: [{ itemKey: "herb", chance: 1.1, quantity: 1 }] },
    { loot: [{ itemKey: "herb", chance: 0.5, quantity: 1 }, { itemKey: "herb", chance: 0.5, quantity: 1 }] },
  ]) {
    const resolve = (name: string | undefined) => {
      const map = new Map(monsterTypesForRoom(name));
      if (name === "buyeo-rat-cave") map.set(MonsterKind.Rat, { ...map.get(MonsterKind.Rat)!, ...patch });
      return map;
    };
    const result = validateMonsterSpawnDefinitions(MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES, ITEM_DEFINITIONS,
      maps, PORTAL_DEFINITIONS, INTERACTABLE_DEFINITIONS, resolve);
    assert.ok(result.errors.length > 0, `invalid regional override accepted: ${JSON.stringify(patch)}`);
  }
});

it("timid behavior never attacks and every escape candidate increases distance within its leash", () => {
  const type = monsterTypesForRoom("buyeo-novice").get(MonsterKind.Squirrel)!;
  for (let x = -8; x <= 8; x++) for (let y = -8; y <= 8; y++) {
    for (const [dx,dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1],[2,2]]) {
      const snapshot: MonsterSnapshot = { id:"audit-timid", state:MonsterAiState.Idle, tileX:x, tileY:y,
        spawn:{tileX:0,tileY:0}, wanderRadiusTiles:2, nextStepAt:0, nextAttackAt:0, respawnAt:0 };
      const target = { sessionId:"hunter", tileX:x+dx!, tileY:y+dy! };
      const action = decideMonsterAction(snapshot, [target], 1000, type);
      assert.notEqual(action.kind, "attack");
      if (action.kind === "step") {
        assert.equal(action.nextStepAt, 2000);
        for (const direction of action.directions) {
          const d = STEP_BY_DIRECTION[direction], nx=x+d.dx, ny=y+d.dy;
          assert.ok(Math.max(Math.abs(nx),Math.abs(ny)) <= type.leashRadiusTiles);
          assert.ok(Math.abs(nx-target.tileX)+Math.abs(ny-target.tileY)>Math.abs(dx!)+Math.abs(dy!));
        }
      }
    }
  }
});

it("timid cooldown, trapped leash corner, death deadline and collision fallback preserve movement boundaries", () => {
  const type = monsterTypesForRoom("buyeo-novice").get(MonsterKind.Squirrel)!;
  const snapshot: MonsterSnapshot = { id:"audit-timid", state:MonsterAiState.Idle, tileX:0,tileY:0,
    spawn:{tileX:0,tileY:0}, wanderRadiusTiles:2,nextStepAt:1001,nextAttackAt:0,respawnAt:2000 };
  const target={sessionId:"hunter",tileX:-1,tileY:0};
  assert.equal(decideMonsterAction(snapshot,[target],1000,type).kind,"hold");
  const action=decideMonsterAction(snapshot,[target],1001,type);
  assert.equal(action.kind,"step");
  if(action.kind === "step") {
    assert.ok(action.directions.length>=2,"a blocked preferred axis still has a safe orthogonal fallback");
    assert.equal(action.nextStepAt,2001);
  }
  assert.equal(decideMonsterAction({...snapshot,tileX:8,tileY:8,nextStepAt:0},
    [{...target,tileX:7,tileY:7}],1000,type).kind,"hold");
  assert.equal(decideMonsterAction({...snapshot,state:MonsterAiState.Dead},[target],1999,type).kind,"hold");
  assert.equal(decideMonsterAction({...snapshot,state:MonsterAiState.Dead},[target],2000,type).kind,"respawn");
});

it("a declined worn-item sale can retry after unequip and repeated successful nonce credits only once", async () => {
  const f=await fixture();
  try {
    await f.inventoryStore.add(OWNER,"old-dagger",1);
    equip(f.room,f.client);
    await flush();
    sell(f.room,f.client,"old-dagger","retry-sale");
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER),0);
    f.room["handleUnequipItem"](f.client,{slot:"weapon"});
    await flush();
    for(let i=0;i<25;i++)sell(f.room,f.client,"old-dagger","retry-sale");
    await flush();
    assert.equal(await f.currencyStore.getBalance(OWNER),10);
    assert.deepEqual(await f.inventoryStore.list(OWNER),[]);
  } finally { f.room.onDispose(); }
});

it("live loot and shop grants carry sale/use metadata so new bag rows work before a reload", async () => {
  const f=await fixture();
  try {
    await f.room["awardLoot"]({sessionId:f.client.sessionId,ownerKey:OWNER},
      ["acorn","den-fur","antler","iron-blade","herb"].map(itemKey=>({itemKey,quantity:1})));
    await f.currencyStore.credit(OWNER,40);
    buy(f.room,f.client);
    await flush();
    const grants=f.messages.filter(row=>row.type===ServerMessage.ItemGranted).map(row=>row.payload as ItemGranted);
    for(const key of ["acorn","den-fur","antler","iron-blade","herb","old-dagger"]) {
      const grant=grants.find(row=>row.itemKey===key);
      assert.ok(grant,`missing grant for ${key}`);
      assert.equal(grant.sellValue,ITEM_DEFINITIONS.find(row=>row.key===key)!.sellValue);
    }
    assert.equal(grants.find(row=>row.itemKey==="herb")!.consumable,true);
  } finally { f.room.onDispose(); }
});
