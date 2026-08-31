import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import {
  ClientMessage,
  Direction,
  MAX_MOVES_PER_SECOND,
  PATCH_RATE_MS,
  ServerMessage,
  type MoveRejected,
  type PortalEntered,
  type RoomState,
} from "@zep-test/shared";
import { TiledMapLoader } from "../game/tiledMap";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";

/**
 * node:test runs each file in its own process and every suite that listens needs a port no
 * other file binds. 2568 / 2571 / 2573 / 2575 / 2577 / 2581 are taken, so this file takes 2579.
 */
const HUNTING_PORT = 2579;

const MOVE_COOLDOWN_MS = 1000 / MAX_MOVES_PER_SECOND + 15;
const SETTLE_MS = PATCH_RATE_MS * 4;

const HUNTING_GROUND = "hunting-ground";
const PLAZA = "plaza";

function roomDefinition(name: string) {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  return definition;
}

function portalDefinition(id: string) {
  const portal = PORTAL_DEFINITIONS.find((candidate) => candidate.id === id);
  assert.ok(portal, `PORTAL_DEFINITIONS has no "${id}" row`);
  return portal;
}

const plaza = roomDefinition(PLAZA);
const huntingGround = roomDefinition(HUNTING_GROUND);
const outbound = portalDefinition("plaza-north-door");
const inbound = portalDefinition("hunting-ground-south-door");

/**
 * Hand-checked against plaza.json rather than searched: right along the open spawn row to a
 * column the fountain (x30-33, y15-18) does not block, straight up to the top open row, then
 * left into the door. `expectServerAt` between the legs fails loudly if the map moves.
 */
const NORTH_ROUTE_COLUMN = 35;
const NORTH_ROUTE_ROW = 8;

type AnyRoom = Awaited<ReturnType<ColyseusTestServer["createRoom"]>> & { state: RoomState };

interface ClientRoom {
  readonly sessionId: string;
  readonly state: { players?: { get(id: string): unknown; readonly size: number } } | undefined;
  send(type: string, payload?: unknown): void;
  onMessage(type: string, callback: (payload: unknown) => void): unknown;
  leave(consented?: boolean): Promise<number>;
}

interface Inbox {
  portals: PortalEntered[];
  rejects: MoveRejected[];
}

let testServer: ColyseusTestServer;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await sleep(20);
  }
}

function collect(client: ClientRoom): Inbox {
  const inbox: Inbox = { portals: [], rejects: [] };
  client.onMessage(ServerMessage.PortalEntered, (message: unknown) => {
    inbox.portals.push(message as PortalEntered);
  });
  client.onMessage(ServerMessage.MoveRejected, (message: unknown) => {
    inbox.rejects.push(message as MoveRejected);
  });
  return inbox;
}

function serverPlayer(room: AnyRoom, sessionId: string) {
  const player = room.state.players.get(sessionId);
  assert.ok(player, `server state has no player for session ${sessionId}`);
  return player;
}

async function createRoom(name: string): Promise<AnyRoom> {
  return (await testServer.createRoom<RoomState>(name, {})) as AnyRoom;
}

async function join(room: AnyRoom, nickname: string, viaPortal?: string): Promise<ClientRoom> {
  const client = (await testServer.connectTo(room, {
    nickname,
    avatarSkin: 0,
    viaPortal,
  })) as unknown as ClientRoom;
  await waitUntil(
    () => room.state.players.get(client.sessionId) !== undefined,
    `${nickname} to appear in ${room.roomName ?? "the room"}`,
  );
  return client;
}

async function stepMany(client: ClientRoom, dir: Direction, steps: number): Promise<void> {
  for (let index = 0; index < steps; index++) {
    client.send(ClientMessage.Move, { dir });
    await sleep(MOVE_COOLDOWN_MS);
  }
}

async function expectServerAt(
  room: AnyRoom,
  client: ClientRoom,
  tileX: number,
  tileY: number,
  label: string,
): Promise<void> {
  try {
    await waitUntil(
      () => {
        const player = room.state.players.get(client.sessionId);
        return player !== undefined && player.tileX === tileX && player.tileY === tileY;
      },
      label,
      3000,
    );
  } catch {
    const player = room.state.players.get(client.sessionId);
    const actual = player === undefined ? "no player" : `(${player.tileX},${player.tileY})`;
    assert.fail(`${label}: expected (${tileX},${tileY}), server has ${actual}`);
  }
}

/** Spawn -> the first trigger tile of plaza's north door, one accepted step at a time. */
async function walkToNorthDoor(room: AnyRoom, client: ClientRoom): Promise<void> {
  const [doorTile] = outbound.from.tiles;
  assert.ok(doorTile);
  assert.equal(doorTile.tileY, NORTH_ROUTE_ROW, "the route's top row is the door's row");

  await stepMany(client, Direction.Right, NORTH_ROUTE_COLUMN - plaza.spawn.tileX);
  await expectServerAt(room, client, NORTH_ROUTE_COLUMN, plaza.spawn.tileY, "clear of the fountain");

  await stepMany(client, Direction.Up, plaza.spawn.tileY - NORTH_ROUTE_ROW);
  await expectServerAt(room, client, NORTH_ROUTE_COLUMN, NORTH_ROUTE_ROW, "the top row");

  // Left onto the far trigger tile of the doorway, which is the one the walker meets first.
  const nearestTrigger = outbound.from.tiles.reduce((left, right) =>
    Math.abs(right.tileX - NORTH_ROUTE_COLUMN) < Math.abs(left.tileX - NORTH_ROUTE_COLUMN) ? right : left,
  );
  await stepMany(client, Direction.Left, NORTH_ROUTE_COLUMN - nearestTrigger.tileX);
  await expectServerAt(room, client, nearestTrigger.tileX, nearestTrigger.tileY, "onto the north door");
}

before(async () => {
  const gameServer = createGameServer();
  await gameServer.listen(HUNTING_PORT);
  testServer = new ColyseusTestServer(gameServer);
});

after(async () => {
  await testServer.shutdown();
});

afterEach(async () => {
  await testServer.cleanup();
});

describe("hunting-ground — the room itself", () => {
  it("is registered and creatable, and reports its own map", async () => {
    const room = await createRoom(HUNTING_GROUND);
    assert.equal(room.state.mapKey, huntingGround.mapKey);
    assert.equal(room.state.roomType, huntingGround.roomType);
  });

  it("spawns a client without viaPortal on the declared spawn tile", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const client = await join(room, "hunter");
    const player = serverPlayer(room, client.sessionId);
    // spreadRadiusInTiles is 2 here, so the exact tile is not fixed — but it must be inside
    // the declared radius and it must be walkable, which is what a spawn contract means.
    const map = await new TiledMapLoader().load(huntingGround.mapKey);
    assert.ok(
      Math.max(
        Math.abs(player.tileX - huntingGround.spawn.tileX),
        Math.abs(player.tileY - huntingGround.spawn.tileY),
      ) <= huntingGround.spawn.spreadRadiusInTiles,
      `spawned at (${player.tileX},${player.tileY}), outside the declared spread`,
    );
    assert.ok(map.isWalkable(player.tileX, player.tileY), "a spawn inside a wall strands the client");
  });

  it("publishes both of its own door's trigger tiles as portal markers and no others", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const declared = inbound.from.tiles.map((tile) => `${tile.tileX},${tile.tileY}`).sort();
    const published = [...room.state.portalMarkers].map((marker) => `${marker.tileX},${marker.tileY}`).sort();
    assert.deepEqual(published, declared);
  });

  it("shows two hunters standing together to each other", async () => {
    // The new room gets the same view machinery as the other two; a room whose interest
    // management silently did nothing would still pass every geometry test in the suite.
    const room = await createRoom(HUNTING_GROUND);
    const first = await join(room, "first");
    const second = await join(room, "second");
    await waitUntil(
      () => (first.state?.players?.size ?? 0) === 2 && (second.state?.players?.size ?? 0) === 2,
      "both hunters to decode each other",
    );
  });
});

describe("hunting-ground — the round trip through plaza's north door", () => {
  it("fires plaza-north-door when a walker reaches the top row", async () => {
    const room = await createRoom(PLAZA);
    const walker = await join(room, "walker");
    const inbox = collect(walker);

    await walkToNorthDoor(room, walker);

    await waitUntil(() => inbox.portals.length === 1, "PortalEntered for the north door");
    assert.deepEqual(inbox.portals[0], { portalId: outbound.id, toRoom: HUNTING_GROUND });
    assert.equal(inbox.rejects.length, 0, "every step of the route is an accepted move");
  });

  it("does not fire the south door on the way to the north one", async () => {
    // The two plaza doors are mirror images across the spawn row; a route that brushed the
    // wrong one would report a hop to grand-plaza and nothing else would notice.
    const room = await createRoom(PLAZA);
    const walker = await join(room, "walker");
    const inbox = collect(walker);

    await walkToNorthDoor(room, walker);
    await sleep(SETTLE_MS);

    assert.deepEqual(
      inbox.portals.map((event) => event.portalId),
      [outbound.id],
    );
  });

  it("lands the arriving client on the hunting-ground arrival tile, not on its spawn", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const { arrival } = outbound.to;
    assert.notDeepEqual(
      { tileX: arrival.tileX, tileY: arrival.tileY },
      { tileX: huntingGround.spawn.tileX, tileY: huntingGround.spawn.tileY },
      "precondition: the arrival is not the generic spawn, or this proves nothing",
    );

    const arriving = await join(room, "arriving", outbound.id);
    const player = serverPlayer(room, arriving.sessionId);
    assert.equal(player.tileX, arrival.tileX);
    assert.equal(player.tileY, arrival.tileY);
  });

  it("completes the whole hop: walk out of plaza, arrive, walk back, arrive again", async () => {
    // The single test that proves the two new PORTAL_DEFINITIONS rows describe a door a player
    // can actually use in both directions. Everything else here checks one half of it.
    const plazaRoom = await createRoom(PLAZA);
    const hunting = await createRoom(HUNTING_GROUND);
    // Colyseus disposes an empty room, and this test leaves both of them empty mid-hop. One
    // resident each holds them open so the rejoins below reach the same instances.
    await join(plazaRoom, "plaza-anchor");
    await join(hunting, "hunting-anchor");

    const walker = await join(plazaRoom, "walker");
    const outboundInbox = collect(walker);
    await walkToNorthDoor(plazaRoom, walker);
    await waitUntil(() => outboundInbox.portals.length === 1, "the outbound PortalEntered");
    assert.equal(outboundInbox.portals[0]?.toRoom, HUNTING_GROUND);

    // What the client does on PortalEntered: leave the old room and rejoin the named one.
    await walker.leave();
    await waitUntil(() => plazaRoom.state.players.size === 1, "the walker to leave plaza");

    const hunter = await join(hunting, "walker", outbound.id);
    const returnInbox = collect(hunter);
    const arrival = outbound.to.arrival;
    await expectServerAt(hunting, hunter, arrival.tileX, arrival.tileY, "arrived in the hunting ground");

    // The return door is the row below the arrival tile, which is what makes the door usable
    // without hunting for it — one step back the way you came.
    const [returnTile] = inbound.from.tiles;
    assert.ok(returnTile);
    assert.equal(returnTile.tileX, arrival.tileX, "the return door is directly under the arrival");
    assert.equal(returnTile.tileY, arrival.tileY + 1);

    await stepMany(hunter, Direction.Down, 1);
    await expectServerAt(hunting, hunter, returnTile.tileX, returnTile.tileY, "onto the return door");
    await waitUntil(() => returnInbox.portals.length === 1, "the return PortalEntered");
    assert.deepEqual(returnInbox.portals[0], { portalId: inbound.id, toRoom: PLAZA });

    await hunter.leave();
    await waitUntil(() => hunting.state.players.size === 1, "the hunter to leave the hunting ground");

    const returned = await join(plazaRoom, "walker", inbound.id);
    const back = serverPlayer(plazaRoom, returned.sessionId);
    assert.equal(back.tileX, inbound.to.arrival.tileX);
    assert.equal(back.tileY, inbound.to.arrival.tileY);
  });

  it("does not re-fire the north door on the tile a returning player arrives on", async () => {
    // The arrival is one tile below the trigger. If they were the same tile, a player coming
    // back from the hunting ground would be bounced straight out again — a loop nothing else
    // in the suite would catch, because both rows validate fine on their own.
    const room = await createRoom(PLAZA);
    const returned = await join(room, "returned", inbound.id);
    const inboxOnArrival = collect(returned);
    await sleep(SETTLE_MS);
    assert.deepEqual(inboxOnArrival.portals, [], "arriving must not immediately fire a door");

    const arrival = inbound.to.arrival;
    assert.notDeepEqual(
      outbound.from.tiles.map((tile) => `${tile.tileX},${tile.tileY}`).includes(`${arrival.tileX},${arrival.tileY}`),
      true,
      "the plaza arrival sits on the north door's own trigger",
    );
  });

  it("puts the hunting ground's own arrival off its own trigger tiles as well", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const arriving = await join(room, "arriving", outbound.id);
    const inbox = collect(arriving);
    await sleep(SETTLE_MS);
    assert.deepEqual(inbox.portals, [], "arriving in the hunting ground must not fire its south door");
  });
});
