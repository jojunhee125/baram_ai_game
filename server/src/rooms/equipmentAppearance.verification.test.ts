import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it, type TestContext } from "node:test";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import { ColyseusTestServer } from "@colyseus/testing";
import { ClientMessage, Direction, Player, RoomState, ServerMessage, type EquipmentChanged, type EquipmentSlot } from "@zep-test/shared";
import { InMemoryInventoryStore, type InventoryStore } from "../db/inventoryStore";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";
import { MetaverseRoom } from "./metaverseRoom";

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

class AppearanceRoom extends MetaverseRoom {
  override setSimulationInterval(): void {}
}

async function fixture(t: TestContext, inventoryStore?: InventoryStore, name = "plaza"): Promise<AppearanceRoom> {
  const room = new AppearanceRoom();
  t.after(() => {
    room.onDispose();
    room.setPatchRate(null);
  });
  const definition = ROOM_DEFINITIONS.find((row) => row.name === name);
  assert.ok(definition);
  Object.defineProperty(room, "roomName", { value: name });
  await room.onCreate({ ...definition, inventoryStore });
  return room;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function join(room: MetaverseRoom, owner: string) {
  const equipment: EquipmentChanged[] = [];
  const client = {
    sessionId: randomUUID(),
    auth: { ssoNickname: null, ssoUserId: owner },
    send(type: string, payload: unknown) {
      if (type === ServerMessage.EquipmentChanged) equipment.push(payload as EquipmentChanged);
    },
  } as unknown as RoomClient;
  await room.onJoin(client, { nickname: "appearance", avatarSkin: 0 });
  await flush();
  return { client, equipment };
}

function appearance(room: MetaverseRoom, client: RoomClient) {
  const player = room.state.players.get(client.sessionId);
  assert.ok(player);
  return { weapon: player.weaponItemKey, armor: player.armorItemKey };
}

it("hydrates persisted weapon and armor in every authored room and on a later session", async (t) => {
  const owner = randomUUID();
  const store = new InMemoryInventoryStore();
  await store.add(owner, "iron-blade", 1);
  await store.add(owner, "reinforced-armor", 1);
  await store.equip(owner, "iron-blade", "weapon");
  await store.equip(owner, "reinforced-armor", "armor");
  for (const definition of ROOM_DEFINITIONS) {
    const room = await fixture(t, store, definition.name);
    const { client } = await join(room, owner);
    assert.deepEqual(appearance(room, client), { weapon: "iron-blade", armor: "reinforced-armor" }, definition.name);
  }
  const later = await fixture(t, store);
  const { client } = await join(later, owner);
  assert.deepEqual(appearance(later, client), { weapon: "iron-blade", armor: "reinforced-armor" });
  const noStore = await fixture(t);
  const anonymous = await join(noStore, randomUUID());
  assert.deepEqual(appearance(noStore, anonymous.client), { weapon: "", armor: "" });
});

it("late hydration preserves newer subscribed weapon changes while hydrating an independent armor slot", async (t) => {
  let resolveHydration!: (value: Partial<Record<EquipmentSlot, string>>) => void;
  const hydration = new Promise<Partial<Record<EquipmentSlot, string>>>((resolve) => { resolveHydration = resolve; });
  class DeferredStore extends InMemoryInventoryStore {
    override getEquippedSlots(): Promise<Partial<Record<EquipmentSlot, string>>> { return hydration; }
  }
  const owner = randomUUID();
  const store = new DeferredStore();
  await store.add(owner, "hunting-blade", 1);
  const room = await fixture(t, store);
  const first = await join(room, owner);
  const sibling = await join(room, owner);
  room["handleEquipItem"](first.client, { itemKey: "hunting-blade", slot: "weapon" });
  await flush();
  for (const session of [first, sibling]) {
    assert.deepEqual(appearance(room, session.client), { weapon: "hunting-blade", armor: "" });
  }
  resolveHydration({ weapon: "old-dagger", armor: "padded-armor" });
  await flush();
  for (const session of [first, sibling]) {
    assert.deepEqual(appearance(room, session.client), { weapon: "hunting-blade", armor: "padded-armor" });
  }
  room["handleUnequipItem"](first.client, { slot: "weapon" });
  await flush();
  for (const session of [first, sibling]) {
    assert.deepEqual(appearance(room, session.client), { weapon: "", armor: "padded-armor" });
  }
});

it("stores without subscriptions project successful settlements and keep rejected equipment unchanged", async (t) => {
  const owner = randomUUID();
  const backing = new InMemoryInventoryStore();
  await backing.add(owner, "old-dagger", 1);
  await backing.add(owner, "hunting-blade", 1);
  await backing.add(owner, "leather-armor", 1);
  await backing.equip(owner, "old-dagger", "weapon");
  await backing.equip(owner, "leather-armor", "armor");
  const store: InventoryStore = {
    list: backing.list.bind(backing),
    add: backing.add.bind(backing),
    grantOnce: backing.grantOnce.bind(backing),
    getEquippedSlots: backing.getEquippedSlots.bind(backing),
    equip: backing.equip.bind(backing),
    unequip: backing.unequip.bind(backing),
    remove: backing.remove.bind(backing),
  };
  const room = await fixture(t, store);
  const { client, equipment } = await join(room, owner);
  room["handleEquipItem"](client, { itemKey: "hunting-blade", slot: "weapon" });
  await flush();
  assert.deepEqual(appearance(room, client), { weapon: "hunting-blade", armor: "leather-armor" });
  room["handleEquipItem"](client, { itemKey: "iron-blade", slot: "weapon" });
  await flush();
  assert.deepEqual(equipment.at(-1), { slot: "weapon", itemKey: "hunting-blade", applied: false });
  assert.deepEqual(appearance(room, client), { weapon: "hunting-blade", armor: "leather-armor" });
  room["handleUnequipItem"](client, { slot: "armor" });
  await flush();
  assert.deepEqual(appearance(room, client), { weapon: "hunting-blade", armor: "" });
  assert.equal((await backing.list(owner)).find((item) => item.itemKey === "leather-armor")?.quantity, 1);
});

it("filters unknown and wrong-slot appearance keys without rewriting the authoritative equipment cache", async (t) => {
  class InvalidAppearanceStore extends InMemoryInventoryStore {
    override getEquippedSlots(): Promise<Partial<Record<EquipmentSlot, string>>> {
      return Promise.resolve({ weapon: "future-weapon", armor: "old-dagger", helmet: "golden-helmet" });
    }
  }
  const room = await fixture(t, new InvalidAppearanceStore());
  const { client } = await join(room, randomUUID());
  assert.deepEqual(appearance(room, client), { weapon: "", armor: "" });
  assert.deepEqual(client.userData?.equippedItemKeys,
    { weapon: "future-weapon", armor: "old-dagger", helmet: "golden-helmet" });
});

it("serializes equipment through existing player views, including removal and fresh appearance on re-entry", () => {
  const state = new RoomState({ roomType: "plaza", mapKey: "plaza" });
  const encoder = new Encoder(state);
  const player = new Player({ nickname: "wearer", tileX: 10, tileY: 10, facing: Direction.Down,
    avatarSkin: 0, level: 1, playerClass: 0, weaponItemKey: "old-dagger", armorItemKey: "leather-armor" });
  state.players.set("wearer", player);
  const near = new StateView();
  near.add(player);
  const far = new StateView();
  const nearDecoder = new Decoder(new RoomState());
  const farDecoder = new Decoder(new RoomState());
  const decoders = [[near, nearDecoder], [far, farDecoder]] as const;
  function publish(full: boolean): void {
    const iterator = { offset: 0 };
    if (full) encoder.encodeAll(iterator);
    else encoder.encode(iterator);
    const sharedOffset = iterator.offset;
    for (const [view, decoder] of decoders) {
      decoder.decode(full ? encoder.encodeAllView(view, sharedOffset, iterator) : encoder.encodeView(view, sharedOffset, iterator));
    }
    encoder.discardChanges();
  }
  publish(true);
  assert.equal(nearDecoder.state.players.get("wearer")?.weaponItemKey, "old-dagger");
  assert.equal(nearDecoder.state.players.get("wearer")?.armorItemKey, "leather-armor");
  assert.equal(farDecoder.state.players.has("wearer"), false);
  player.weaponItemKey = "iron-blade";
  player.armorItemKey = "reinforced-armor";
  publish(false);
  assert.equal(nearDecoder.state.players.get("wearer")?.weaponItemKey, "iron-blade");
  assert.equal(farDecoder.state.players.has("wearer"), false);
  near.remove(player);
  publish(false);
  assert.equal(nearDecoder.state.players.has("wearer"), false);
  player.weaponItemKey = "";
  publish(false);
  near.add(player);
  publish(false);
  assert.equal(nearDecoder.state.players.get("wearer")?.weaponItemKey, "");
  assert.equal(nearDecoder.state.players.get("wearer")?.armorItemKey, "reinforced-armor");
});

it("replicates visible equipment to another socket without leaking inventory or owner verdicts", async (t) => {
  const store = new InMemoryInventoryStore();
  const server = createGameServer(undefined, store);
  // Other integration suites own 2567-2599; node:test executes files in separate processes.
  await server.listen(2601);
  const testServer = new ColyseusTestServer(server);
  t.after(() => testServer.shutdown());
  const room = await testServer.createRoom<RoomState>("plaza", {});
  const authoritative = room as unknown as MetaverseRoom;
  const wearer = await testServer.connectTo(room, { nickname: "wearer", avatarSkin: 0 });
  const observer = await testServer.connectTo(room, { nickname: "observer", avatarSkin: 0 });
  const observerVerdicts: unknown[] = [];
  observer.onMessage(ServerMessage.EquipmentChanged, (event) => observerVerdicts.push(event));
  async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "equipment appearance did not reach the observer");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  await until(() => observer.state.players?.has(wearer.sessionId) === true);
  assert.equal(observer.state.players.get(wearer.sessionId)?.weaponItemKey, "");
  await store.add(wearer.sessionId, "iron-blade", 1);
  await store.add(wearer.sessionId, "reinforced-armor", 1);
  wearer.send(ClientMessage.EquipItem, { itemKey: "iron-blade", slot: "weapon" });
  wearer.send(ClientMessage.EquipItem, { itemKey: "reinforced-armor", slot: "armor" });
  await until(() => observer.state.players.get(wearer.sessionId)?.weaponItemKey === "iron-blade"
    && observer.state.players.get(wearer.sessionId)?.armorItemKey === "reinforced-armor");
  assert.deepEqual(Object.keys(observer.state.players.get(wearer.sessionId)!.toJSON()).sort(),
    ["nickname", "tileX", "tileY", "facing", "avatarSkin", "level", "playerClass", "weaponItemKey", "armorItemKey"].sort());
  const observerPlayer = room.state.players.get(observer.sessionId)!;
  function moveObserver(tileX: number, tileY: number): void {
    observerPlayer.tileX = tileX;
    observerPlayer.tileY = tileY;
    authoritative["proximityIndex"].move(observer.sessionId, { tileX, tileY });
    authoritative["refreshViewFor"](observer.sessionId);
  }
  moveObserver(1, 1);
  await until(() => !observer.state.players.has(wearer.sessionId));
  wearer.send(ClientMessage.UnequipItem, { slot: "weapon" });
  await until(() => room.state.players.get(wearer.sessionId)?.weaponItemKey === "");
  assert.equal(observer.state.players.has(wearer.sessionId), false);
  const wearerPlayer = room.state.players.get(wearer.sessionId)!;
  moveObserver(wearerPlayer.tileX, wearerPlayer.tileY);
  await until(() => observer.state.players.has(wearer.sessionId));
  assert.equal(observer.state.players.get(wearer.sessionId)?.weaponItemKey, "");
  assert.equal(observer.state.players.get(wearer.sessionId)?.armorItemKey, "reinforced-armor");
  assert.deepEqual(observerVerdicts, []);
});
