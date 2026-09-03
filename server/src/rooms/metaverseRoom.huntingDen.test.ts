import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import {
  ClientMessage,
  Direction,
  MAX_MOVES_PER_SECOND,
  MONSTER_TICK_MS,
  PATCH_RATE_MS,
  ServerMessage,
  type MoveRejected,
  type PortalEntered,
  type RoomState,
} from "@zep-test/shared";
import { TiledMapLoader } from "../game/tiledMap";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";
import { MONSTER_SPAWN_DEFINITIONS, MonsterKind } from "./monsterDefinitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";

/**
 * node:test runs each file in its own process and every suite that listens needs a port no
 * other file binds. 2567 / 2571 / 2573 / 2575 / 2577 / 2579 / 2581 / 2583 are taken, so this
 * file takes 2585.
 */
const HUNTING_PORT = 2585;

const MOVE_COOLDOWN_MS = 1000 / MAX_MOVES_PER_SECOND + 15;
const SETTLE_MS = PATCH_RATE_MS * 4;

const HUNTING_GROUND = "hunting-ground";
const HUNTING_DEN = "hunting-den";

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

const huntingGround = roomDefinition(HUNTING_GROUND);
const huntingDen = roomDefinition(HUNTING_DEN);
const outbound = portalDefinition("hunting-ground-north-door");
const inbound = portalDefinition("hunting-den-south-door");

type AnyRoom = Awaited<ReturnType<ColyseusTestServer["createRoom"]>> & { state: RoomState };

interface ClientRoom {
  readonly sessionId: string;
  readonly state:
    | {
        players?: { get(id: string): unknown; readonly size: number };
        monsters?: {
          get(id: string): { kind: string; tileX: number; tileY: number } | undefined;
          keys(): IterableIterator<string>;
          readonly size: number;
        };
      }
    | undefined;
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

/**
 * Actual spawn -> the near trigger tile of hunting-ground's north door: align onto the trail
 * column first, then climb it. hunting-ground's spawn spreads by 2 tiles inside the widened
 * trailhead (`assets/README.md` "남문 안쪽... 길목으로 넓어진다"), so a walker cannot assume it
 * starts on column 35 the way plaza's zero-spread spawn lets the other suite assume its column —
 * the horizontal leg is what makes this safe regardless of where inside the spread it landed.
 */
async function walkToNorthDoor(room: AnyRoom, client: ClientRoom): Promise<void> {
  const start = serverPlayer(room, client.sessionId);
  const startTile = { tileX: start.tileX, tileY: start.tileY };
  const nearestTrigger = outbound.from.tiles.reduce((left, right) =>
    Math.abs(right.tileX - startTile.tileX) < Math.abs(left.tileX - startTile.tileX) ? right : left,
  );

  const dx = nearestTrigger.tileX - startTile.tileX;
  if (dx !== 0) {
    await stepMany(client, dx > 0 ? Direction.Right : Direction.Left, Math.abs(dx));
    await expectServerAt(room, client, nearestTrigger.tileX, startTile.tileY, "aligned onto the trail column");
  }

  await stepMany(client, Direction.Up, startTile.tileY - nearestTrigger.tileY);
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

describe("hunting-den — the room itself", () => {
  it("is registered and creatable, and reports its own map", async () => {
    const room = await createRoom(HUNTING_DEN);
    assert.equal(room.state.mapKey, huntingDen.mapKey);
    assert.equal(room.state.roomType, huntingDen.roomType);
  });

  it("spawns a client without viaPortal on the declared spawn tile", async () => {
    const room = await createRoom(HUNTING_DEN);
    const client = await join(room, "hunter");
    const player = serverPlayer(room, client.sessionId);
    const map = await new TiledMapLoader().load(huntingDen.mapKey);
    assert.ok(
      Math.max(
        Math.abs(player.tileX - huntingDen.spawn.tileX),
        Math.abs(player.tileY - huntingDen.spawn.tileY),
      ) <= huntingDen.spawn.spreadRadiusInTiles,
      `spawned at (${player.tileX},${player.tileY}), outside the declared spread`,
    );
    assert.ok(map.isWalkable(player.tileX, player.tileY), "a spawn inside a wall strands the client");
  });

  it("publishes only its own door's trigger tiles as portal markers, and no others", async () => {
    // hunting-den has exactly one door (its south door back to hunting-ground) - unlike
    // hunting-ground, which now has two. A regression that leaked another room's triggers in
    // would show up here as an extra marker.
    const room = await createRoom(HUNTING_DEN);
    const declared = inbound.from.tiles.map((tile) => `${tile.tileX},${tile.tileY}`).sort();
    const published = [...room.state.portalMarkers].map((marker) => `${marker.tileX},${marker.tileY}`).sort();
    assert.deepEqual(published, declared);
  });

  it("shows two hunters standing together to each other", async () => {
    const room = await createRoom(HUNTING_DEN);
    const first = await join(room, "first");
    const second = await join(room, "second");
    await waitUntil(
      () => (first.state?.players?.size ?? 0) === 2 && (second.state?.players?.size ?? 0) === 2,
      "both hunters to decode each other",
    );
  });
});

describe("hunting-den — the round trip through hunting-ground's north door", () => {
  it("fires hunting-ground-north-door when a walker reaches the top row", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const walker = await join(room, "walker");
    const inbox = collect(walker);

    await walkToNorthDoor(room, walker);

    await waitUntil(() => inbox.portals.length === 1, "PortalEntered for the north door");
    assert.deepEqual(inbox.portals[0], { portalId: outbound.id, toRoom: HUNTING_DEN });
    assert.equal(inbox.rejects.length, 0, "every step of the route is an accepted move");
  });

  it("does not fire the south door on the way to the north one", async () => {
    // hunting-ground's two doors sit at opposite ends of the same trail column; a route that
    // somehow doubled back south would report a hop to plaza and nothing else would notice.
    const room = await createRoom(HUNTING_GROUND);
    const walker = await join(room, "walker");
    const inbox = collect(walker);

    await walkToNorthDoor(room, walker);
    await sleep(SETTLE_MS);

    assert.deepEqual(
      inbox.portals.map((event) => event.portalId),
      [outbound.id],
    );
  });

  it("lands the arriving client on the hunting-den arrival tile, not on its spawn", async () => {
    const room = await createRoom(HUNTING_DEN);
    const { arrival } = outbound.to;
    assert.notDeepEqual(
      { tileX: arrival.tileX, tileY: arrival.tileY },
      { tileX: huntingDen.spawn.tileX, tileY: huntingDen.spawn.tileY },
      "precondition: the arrival is not the generic spawn, or this proves nothing",
    );

    const arriving = await join(room, "arriving", outbound.id);
    const player = serverPlayer(room, arriving.sessionId);
    assert.equal(player.tileX, arrival.tileX);
    assert.equal(player.tileY, arrival.tileY);
  });

  it("completes the whole hop: walk out of hunting-ground, arrive, walk back, arrive again", async () => {
    // The single test that proves the two new PORTAL_DEFINITIONS rows describe a door a player
    // can actually use in both directions. Everything else here checks one half of it.
    const groundRoom = await createRoom(HUNTING_GROUND);
    const den = await createRoom(HUNTING_DEN);
    // Colyseus disposes an empty room, and this test leaves both of them empty mid-hop. One
    // resident each holds them open so the rejoins below reach the same instances.
    await join(groundRoom, "ground-anchor");
    await join(den, "den-anchor");

    const walker = await join(groundRoom, "walker");
    const outboundInbox = collect(walker);
    await walkToNorthDoor(groundRoom, walker);
    await waitUntil(() => outboundInbox.portals.length === 1, "the outbound PortalEntered");
    assert.equal(outboundInbox.portals[0]?.toRoom, HUNTING_DEN);

    // What the client does on PortalEntered: leave the old room and rejoin the named one.
    await walker.leave();
    await waitUntil(() => groundRoom.state.players.size === 1, "the walker to leave hunting-ground");

    const hunter = await join(den, "walker", outbound.id);
    const returnInbox = collect(hunter);
    const arrival = outbound.to.arrival;
    await expectServerAt(den, hunter, arrival.tileX, arrival.tileY, "arrived in the hunting den");

    // The return door is the row below the arrival tile, which is what makes the door usable
    // without hunting for it — one step back the way you came.
    const [returnTile] = inbound.from.tiles;
    assert.ok(returnTile);
    assert.equal(returnTile.tileX, arrival.tileX, "the return door is directly under the arrival");
    assert.equal(returnTile.tileY, arrival.tileY + 1);

    await stepMany(hunter, Direction.Down, 1);
    await expectServerAt(den, hunter, returnTile.tileX, returnTile.tileY, "onto the return door");
    await waitUntil(() => returnInbox.portals.length === 1, "the return PortalEntered");
    assert.deepEqual(returnInbox.portals[0], { portalId: inbound.id, toRoom: HUNTING_GROUND });

    await hunter.leave();
    await waitUntil(() => den.state.players.size === 1, "the hunter to leave the hunting den");

    const returned = await join(groundRoom, "walker", inbound.id);
    const back = serverPlayer(groundRoom, returned.sessionId);
    assert.equal(back.tileX, inbound.to.arrival.tileX);
    assert.equal(back.tileY, inbound.to.arrival.tileY);
  });

  it("does not re-fire the north door on the tile a returning player arrives on", async () => {
    // The arrival is one tile south of the trigger. If they were the same tile, a player coming
    // back from the den would be bounced straight out again — a loop nothing else in the suite
    // would catch, because both rows validate fine on their own.
    const room = await createRoom(HUNTING_GROUND);
    const returned = await join(room, "returned", inbound.id);
    const inboxOnArrival = collect(returned);
    await sleep(SETTLE_MS);
    assert.deepEqual(inboxOnArrival.portals, [], "arriving must not immediately fire a door");

    const arrival = inbound.to.arrival;
    assert.notDeepEqual(
      outbound.from.tiles.map((tile) => `${tile.tileX},${tile.tileY}`).includes(`${arrival.tileX},${arrival.tileY}`),
      true,
      "the hunting-ground arrival sits on the north door's own trigger",
    );
  });

  it("puts no monsters in the arriving player's view of a fresh hunting-den join", async () => {
    // hunting-den's own arrival is inside the y >= 24 clear band (design's entrance buffer), so
    // this also proves the buffer holds — not just that the door doesn't immediately fire again.
    const room = await createRoom(HUNTING_DEN);
    const arriving = await join(room, "arriving", outbound.id);
    const inbox = collect(arriving);
    await sleep(SETTLE_MS);
    assert.deepEqual(inbox.portals, [], "arriving in the hunting den must not fire its south door");
  });
});

describe("hunting-den — monster population", () => {
  const DEN_SPAWNS = MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === HUNTING_DEN);
  const GROUND_SPAWNS = MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === HUNTING_GROUND);

  it("has exactly ten rows, an interleaved 5:5 rabbit/deer mix — Phase S's second kind", () => {
    assert.equal(DEN_SPAWNS.length, 10);
    assert.ok(
      DEN_SPAWNS.every((spawn) => spawn.kind === MonsterKind.Rabbit || spawn.kind === MonsterKind.Deer),
      "every den spawn must be a rabbit or a deer, no other kind",
    );
    assert.equal(DEN_SPAWNS.filter((spawn) => spawn.kind === MonsterKind.Rabbit).length, 5);
    assert.equal(DEN_SPAWNS.filter((spawn) => spawn.kind === MonsterKind.Deer).length, 5);
  });

  it("keeps the two hunting rooms at 20 + 10 = 30, the PoC #3 cap, with no overlap", () => {
    assert.equal(GROUND_SPAWNS.length, 20);
    assert.equal(GROUND_SPAWNS.length + DEN_SPAWNS.length, 30);
    const groundIds = new Set(GROUND_SPAWNS.map((spawn) => spawn.id));
    assert.ok(DEN_SPAWNS.every((spawn) => !groundIds.has(spawn.id)), "spawn ids must be unique across rooms");
  });

  it("builds one monster per spawn row of the real table, only rabbits and deer, 5:5", async () => {
    const room = await createRoom(HUNTING_DEN);
    await join(room, "hunter");
    assert.equal(
      room.state.monsters.size,
      DEN_SPAWNS.length,
      "the room did not build one monster per spawn row of the real table",
    );
    const kinds = [...room.state.monsters.values()].map((monster) => monster.kind);
    assert.ok(
      kinds.every((kind) => kind === MonsterKind.Rabbit || kind === MonsterKind.Deer),
      "every built monster must be a rabbit or a deer, no other kind (e.g. no stray squirrel)",
    );
    assert.equal(kinds.filter((kind) => kind === MonsterKind.Rabbit).length, 5);
    assert.equal(kinds.filter((kind) => kind === MonsterKind.Deer).length, 5);
  });

  it("runs the simulation loop: the field is not frozen on its spawn tiles", async () => {
    const room = await createRoom(HUNTING_DEN);
    await join(room, "hunter");
    const spawnTileOf = new Map(DEN_SPAWNS.map((spawn) => [spawn.id, spawn.at]));

    await waitUntil(
      () =>
        [...room.state.monsters.entries()].some(([monsterId, monster]) => {
          const at = spawnTileOf.get(monsterId);
          return at !== undefined && (monster.tileX !== at.tileX || monster.tileY !== at.tileY);
        }),
      "at least one monster to take a wander step",
      MONSTER_TICK_MS * 20,
    );
  });

  it("does not mix hunting-den's monsters into a freshly created hunting-ground room", async () => {
    // Both rooms share one MONSTER_SPAWN_DEFINITIONS table; a filter bug in the room's own
    // construction is the one thing this table's shape cannot catch on its own.
    const room = await createRoom(HUNTING_GROUND);
    await join(room, "hunter");
    assert.equal(room.state.monsters.size, GROUND_SPAWNS.length);
    for (const monsterId of room.state.monsters.keys()) {
      assert.ok(!DEN_SPAWNS.some((spawn) => spawn.id === monsterId), `${monsterId} belongs to hunting-den`);
    }
  });
});
