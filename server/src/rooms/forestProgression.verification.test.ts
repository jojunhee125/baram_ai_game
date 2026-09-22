import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Direction, ServerMessage, type ItemGranted, type JoinOptions } from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { InMemoryProgressStore } from "../db/progressStore";
import { InMemorySettlementStore } from "../db/settlementStore";
import { decideMonsterAction, MonsterAiState, type MonsterSnapshot } from "../game/monsterAi";
import { TiledMapLoader } from "../game/tiledMap";
import { ROOM_DEFINITIONS } from "./definitions";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import { LANDMARK_DEFINITIONS } from "./landmarkDefinitions";
import { buildLootTableView } from "./lootTableView";
import { MetaverseRoom } from "./metaverseRoom";
import { MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES, MonsterKind, monsterTypesForRoom,
  validateMonsterSpawnDefinitions } from "./monsterDefinitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";

const FOREST = "hunting-forest";
type Client = Parameters<MetaverseRoom["onJoin"]>[0];

class ForestAuditRoom extends MetaverseRoom {
  override setSimulationInterval(): void {}
  protected override random(): number { return 0; }
}

function stores() {
  const inventoryStore = new InMemoryInventoryStore();
  const currencyStore = new InMemoryCurrencyStore();
  return {
    inventoryStore, currencyStore,
    progressStore: new InMemoryProgressStore(),
    settlementStore: new InMemorySettlementStore(currencyStore, inventoryStore),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 16; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fixture(name = FOREST, data = stores(), owner = randomUUID()) {
  const room = new ForestAuditRoom();
  Object.defineProperty(room, "roomName", { value: name });
  const definition = ROOM_DEFINITIONS.find((row) => row.name === name);
  assert.ok(definition);
  await room.onCreate({ ...definition, ...data });
  function client() {
    const messages: { type: string; payload: unknown }[] = [];
    const value = { sessionId: randomUUID(), auth: { ssoNickname: null, ssoUserId: owner },
      send: (type: string, payload: unknown) => messages.push({ type, payload }) } as unknown as Client;
    return { client: value, messages };
  }
  async function join(options: Partial<JoinOptions> = {}) {
    const result = client();
    await room.onJoin(result.client, { nickname: "forest-audit", avatarSkin: 0, ...options });
    await flush();
    return result;
  }
  return { room, data, owner, join, client };
}

it("forest resolution leaves existing regional tables and monster populations unchanged", () => {
  const names = [undefined, "hunting-ground", "hunting-den", "unknown"];
  const before = names.map((name) => JSON.stringify([...monsterTypesForRoom(name)]));
  for (let i = 0; i < 100; i++) {
    const forest = monsterTypesForRoom(FOREST);
    assert.deepEqual([...forest.keys()], [MonsterKind.Rabbit, MonsterKind.Deer]);
    assert.equal(forest.get(MonsterKind.Rabbit)!.expReward, 45);
    assert.equal(forest.get(MonsterKind.Deer)!.expReward, 70);
  }
  assert.deepEqual(names.map((name) => JSON.stringify([...monsterTypesForRoom(name)])), before);
  assert.equal(MONSTER_SPAWN_DEFINITIONS.filter((row) => row.room === "hunting-ground").length, 21);
  assert.equal(MONSTER_SPAWN_DEFINITIONS.filter((row) => row.room === "hunting-den").length, 11);
  const spawns = MONSTER_SPAWN_DEFINITIONS.filter((row) => row.room === FOREST);
  assert.equal(spawns.length, 8);
  assert.equal(spawns.filter((row) => row.kind === MonsterKind.Rabbit).length, 4);
  assert.equal(spawns.filter((row) => row.kind === MonsterKind.Deer).length, 4);
  assert.ok(spawns.every((row) => !row.persistentRespawn));
});

it("ambush never steps across positions, target distances, cooldowns, and all AI states", () => {
  const type = monsterTypesForRoom(FOREST).get(MonsterKind.Rabbit)!;
  const base: MonsterSnapshot = { id: "forest-audit", state: MonsterAiState.Idle,
    tileX: 22, tileY: 12, spawn: { tileX: 22, tileY: 12 }, wanderRadiusTiles: 0,
    nextStepAt: 0, nextAttackAt: 1000, respawnAt: 1000 };
  for (const state of Object.values(MonsterAiState)) {
    for (const offset of [0, 10, 11]) {
      for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) {
        for (const now of [999, 1000, 1001]) {
          const snapshot = { ...base, state, tileX: base.tileX + offset };
          const action = decideMonsterAction(snapshot, [{ sessionId: "hunter",
            tileX: snapshot.tileX + dx, tileY: snapshot.tileY + dy }], now, type);
          assert.notEqual(action.kind, "step");
          if (state === MonsterAiState.Dead) {
            assert.equal(action.kind, now < 1000 ? "hold" : "respawn");
          } else if (Math.max(Math.abs(dx), Math.abs(dy)) <= 1 && offset <= type.leashRadiusTiles) {
            assert.equal(action.kind, now < 1000 ? "hold" : "attack");
            assert.equal(action.targetSessionId, "hunter");
            if (action.kind === "attack") assert.equal(action.nextAttackAt, now + 1600);
          } else {
            assert.deepEqual(action, { kind: "hold", state: "idle", targetSessionId: null });
          }
        }
      }
    }
  }
  assert.deepEqual(decideMonsterAction(base, [], 1000, type), {
    kind: "hold", state: "idle", targetSessionId: null,
  });
  const tied = decideMonsterAction(base, [
    { sessionId: "z", tileX: 21, tileY: 12 }, { sessionId: "a", tileX: 23, tileY: 12 },
  ], 1000, type);
  assert.equal(tied.targetSessionId, "a");
});

it("forest and den maps keep every walkable tile connected and all arrivals outside monster aggro", async () => {
  const loader = new TiledMapLoader();
  for (const name of [FOREST, "hunting-den"]) {
    const definition = ROOM_DEFINITIONS.find((row) => row.name === name)!;
    const map = await loader.load(definition.mapKey);
    const key = (x: number, y: number) => `${x},${y}`;
    const seen = new Set([key(definition.spawn.tileX, definition.spawn.tileY)]);
    const queue = [[definition.spawn.tileX, definition.spawn.tileY]];
    for (let i = 0; i < queue.length; i++) {
      const [x, y] = queue[i]!;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nx = x! + dx!, ny = y! + dy!;
        if (map.isWalkable(nx, ny) && !seen.has(key(nx, ny))) {
          seen.add(key(nx, ny)); queue.push([nx, ny]);
        }
      }
    }
    for (let y = 0; y < map.heightInTiles; y++) for (let x = 0; x < map.widthInTiles; x++) {
      if (map.isWalkable(x, y)) assert.ok(seen.has(key(x, y)), `${name}: disconnected ${x},${y}`);
    }
    const areas = [definition.spawn,
      ...PORTAL_DEFINITIONS.filter((row) => row.to.room === name).map((row) => row.to.arrival),
      ...LANDMARK_DEFINITIONS.filter((row) => row.room === name && row.tile).map((row) => row.tile!),
    ];
    const points = PORTAL_DEFINITIONS.filter((row) => row.from.room === name).flatMap((row) => row.from.tiles);
    const triggers = new Set(points.map((point) => key(point.tileX, point.tileY)));
    const safe = [...points];
    for (const area of areas) for (let dx = -area.spreadRadiusInTiles; dx <= area.spreadRadiusInTiles; dx++) {
      for (let dy = -area.spreadRadiusInTiles; dy <= area.spreadRadiusInTiles; dy++) {
        const point = { tileX: area.tileX + dx, tileY: area.tileY + dy };
        assert.ok(!triggers.has(key(point.tileX, point.tileY)), `${name}: arrival triggers a portal`);
        safe.push(point);
      }
    }
    for (const point of safe) {
      assert.ok(seen.has(key(point.tileX, point.tileY)), `${name}: unreachable arrival`);
      for (const spawn of MONSTER_SPAWN_DEFINITIONS.filter((row) => row.room === name)) {
        const type = monsterTypesForRoom(name).get(spawn.kind)!;
        assert.ok(Math.max(Math.abs(point.tileX - spawn.at.tileX), Math.abs(point.tileY - spawn.at.tileY))
          > spawn.wanderRadiusTiles + type.aggroRadiusTiles, `${spawn.id}: unsafe arrival ${JSON.stringify(point)}`);
      }
    }
  }
});

for (const kind of [MonsterKind.Rabbit, MonsterKind.Deer]) {
  it(`forest ${kind}: actual death awards the displayed EXP, loot, and live sale metadata`, async () => {
    const f = await fixture();
    try {
      const player = await f.join();
      const [id, runtime] = [...f.room["monsterRuntimes"]].find(([, row]) => row.type.kind === kind)!;
      const type = monsterTypesForRoom(FOREST).get(kind)!;
      assert.equal(runtime.hp, kind === MonsterKind.Rabbit ? 96 : 140);
      f.room["applyMonsterDamage"](player.client, player.client.userData!, id, type.maxHp, Date.now());
      await flush();
      assert.equal(f.room.state.monsters.has(id), false);
      assert.equal(await f.data.progressStore.getExp(f.owner), kind === MonsterKind.Rabbit ? 45 : 70);
      const actual = (await f.data.inventoryStore.list(f.owner)).map(({ itemKey, quantity }) => ({ itemKey, quantity }));
      assert.deepEqual(actual.sort((a, b) => a.itemKey.localeCompare(b.itemKey)),
        type.loot.map(({ itemKey, quantity }) => ({ itemKey, quantity })).sort((a, b) => a.itemKey.localeCompare(b.itemKey)));
      const view = buildLootTableView(FOREST).find((row) => row.kind === kind)!;
      assert.equal(view.expReward, type.expReward);
      assert.deepEqual(view.drops.map((row) => [row.itemKey, row.chancePercent, row.quantity]),
        type.loot.map((row) => [row.itemKey, row.chance * 100, row.quantity]));
      const messages = player.messages.filter((row) => row.type === ServerMessage.ItemGranted)
        .map((row) => row.payload as ItemGranted);
      for (const drop of view.drops) {
        const item = ITEM_DEFINITIONS.find((row) => row.key === drop.itemKey)!;
        assert.equal(drop.sellValue, item.sellValue);
        assert.equal(messages.find((row) => row.itemKey === drop.itemKey)?.sellValue, item.sellValue);
      }
    } finally { f.room.onDispose(); }
  });
}

it("a dropped cloak reduces damage by 10%, persists on rejoin, refuses worn sale, and loses its bonus after sale", async () => {
  const f = await fixture();
  let later: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const player = await f.join();
    const [id, runtime] = [...f.room["monsterRuntimes"]].find(([, row]) => row.type.kind === MonsterKind.Rabbit)!;
    f.room["applyMonsterDamage"](player.client, player.client.userData!, id, runtime.hp, Date.now());
    await flush();
    f.room["handleEquipItem"](player.client, { itemKey: "forest-cloak", slot: "cloak" });
    await flush();
    assert.ok(Math.abs(f.room["equippedDamageReduction"](player.client.userData!, Date.now()) - 0.1) < 1e-9);
    const beforeHp = player.client.userData!.hp;
    f.room["damagePlayer"](player.client.sessionId, id, 20, Date.now());
    assert.equal(beforeHp - player.client.userData!.hp, 18);
    assert.deepEqual(await f.data.inventoryStore.getEquippedSlots(f.owner), { cloak: "forest-cloak" });
    later = await fixture(FOREST, f.data, f.owner);
    const rejoined = await later.join();
    assert.ok(Math.abs(later.room["equippedDamageReduction"](rejoined.client.userData!, Date.now()) - 0.1) < 1e-9);
    const sale = { itemKey: "forest-cloak", quantity: 1, nonce: "forest-cloak-sale" };
    later.room["handleSellItem"](rejoined.client, sale);
    await flush();
    assert.equal(await f.data.currencyStore.getBalance(f.owner), 0);
    assert.equal((await f.data.inventoryStore.list(f.owner)).find((row) => row.itemKey === "forest-cloak")?.quantity, 1);
    later.room["handleUnequipItem"](rejoined.client, { slot: "cloak" });
    await flush();
    for (let i = 0; i < 20; i++) later.room["handleSellItem"](rejoined.client, sale);
    await flush();
    assert.equal(await f.data.currencyStore.getBalance(f.owner), 90);
    assert.equal((await f.data.inventoryStore.list(f.owner)).some((row) => row.itemKey === "forest-cloak"), false);
    assert.deepEqual(await f.data.inventoryStore.getEquippedSlots(f.owner), {});
    assert.equal(f.room["equippedDamageReduction"](player.client.userData!, Date.now()), 0);
    assert.equal(later.room["equippedDamageReduction"](rejoined.client.userData!, Date.now()), 0);
  } finally { later?.room.onDispose(); f.room.onDispose(); }
});

it("forest entry portal checks possession, both portal arrivals work, and the exit needs no pass", async () => {
  const den = await fixture("hunting-den");
  const forest = await fixture(FOREST, den.data, den.owner);
  try {
    const denied = await den.join({ viaPortal: "hunting-forest-south-door" });
    den.room["handleMove"](denied.client, { dir: Direction.Right });
    assert.ok(denied.messages.some((row) => row.type === ServerMessage.PortalDenied));
    assert.ok(!denied.messages.some((row) => row.type === ServerMessage.PortalEntered));
    await den.data.inventoryStore.grantOnce(den.owner, "entry-pass");
    const allowed = await den.join({ viaPortal: "hunting-forest-south-door" });
    den.room["handleMove"](allowed.client, { dir: Direction.Right });
    assert.deepEqual(allowed.messages.find((row) => row.type === ServerMessage.PortalEntered)?.payload,
      { portalId: "hunting-den-forest-door", toRoom: FOREST });
    const arrival = await forest.join({ viaPortal: "hunting-den-forest-door" });
    const player = forest.room.state.players.get(arrival.client.sessionId)!;
    assert.deepEqual([player.tileX, player.tileY], [31, 26]);
    await den.data.inventoryStore.remove(den.owner, "entry-pass", 1);
    forest.room["handleMove"](arrival.client, { dir: Direction.Down });
    assert.deepEqual(arrival.messages.find((row) => row.type === ServerMessage.PortalEntered)?.payload,
      { portalId: "hunting-forest-south-door", toRoom: "hunting-den" });
    const back = await den.join({ viaPortal: "hunting-forest-south-door" });
    const returned = den.room.state.players.get(back.client.sessionId)!;
    assert.deepEqual([returned.tileX, returned.tileY], [46, 25]);
  } finally { forest.room.onDispose(); den.room.onDispose(); }
});

it("forest landmark denies missing possession and concurrent admitted joins respect the capacity of 20", async () => {
  const f = await fixture();
  try {
    const denied = f.client();
    await assert.rejects(f.room.onJoin(denied.client, {
      nickname: "forest-audit", avatarSkin: 0, arriveAtLandmark: "landmark-hunting-forest",
    }), /requires item "entry-pass"/);
    assert.equal(f.room.state.players.size, 0);
    await f.data.inventoryStore.grantOnce(f.owner, "entry-pass");
    const outcomes = await Promise.allSettled(Array.from({ length: 25 }, () => f.join({
      arriveAtLandmark: "landmark-hunting-forest",
    })));
    assert.equal(outcomes.filter((row) => row.status === "fulfilled").length, 20);
    assert.equal(outcomes.filter((row) => row.status === "rejected").length, 5);
    assert.equal(f.room.state.players.size, 20);
    for (const player of f.room.state.players.values()) assert.deepEqual([player.tileX, player.tileY], [31, 26]);
  } finally { f.room.onDispose(); }
});

it("boot refuses ambush wander radius or aggro radius that disagrees with stationary behavior", async () => {
  const loader = new TiledMapLoader();
  const maps = new Map(await Promise.all(ROOM_DEFINITIONS.map(async (row) =>
    [row.name, await loader.load(row.mapKey)] as const)));
  const altered = MONSTER_SPAWN_DEFINITIONS.map((row) => row.id === "hf-rabbit-01"
    ? { ...row, wanderRadiusTiles: 1 } : row);
  const result = validateMonsterSpawnDefinitions(altered, MONSTER_TYPES, ITEM_DEFINITIONS,
    maps, PORTAL_DEFINITIONS, INTERACTABLE_DEFINITIONS, monsterTypesForRoom);
  assert.ok(result.errors.some((error) => /hf-rabbit-01.*wanderRadiusTiles 0/.test(error)));
  const resolve = (name: string | undefined) => {
    const types = new Map(monsterTypesForRoom(name));
    if (name === FOREST) types.set(MonsterKind.Rabbit, { ...types.get(MonsterKind.Rabbit)!, aggroRadiusTiles: 2 });
    return types;
  };
  const invalidType = validateMonsterSpawnDefinitions(MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES,
    ITEM_DEFINITIONS, maps, PORTAL_DEFINITIONS, INTERACTABLE_DEFINITIONS, resolve);
  assert.ok(invalidType.errors.some((error) => /aggroRadiusTiles 1 for ambush/.test(error)));
});
