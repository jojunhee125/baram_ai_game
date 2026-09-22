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
  VIEW_RADIUS_TILES,
  type MoveRejected,
  type PortalEntered,
  type RoomState,
} from "@zep-test/shared";
import { TiledMapLoader } from "../game/tiledMap";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";
import { MetaverseRoom } from "./metaverseRoom";
import {
  MONSTER_SPAWN_DEFINITIONS,
  MONSTER_TYPES,
  MonsterKind,
} from "./monsterDefinitions";
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
const outbound = portalDefinition("plaza-south-door");
const inbound = portalDefinition("hunting-ground-south-door");
// Phase E gave hunting-ground a second door, at the opposite end of the same trail
// (`docs/design-phase-e-second-hunting-ground.md` §2.2). Not exercised by a round trip in this
// file — `metaverseRoom.huntingDen.test.ts` owns that — but its trigger tiles are still this
// room's own, so the portal-marker test below has to count them.
const northDoor = portalDefinition("hunting-ground-north-door");

type AnyRoom = Awaited<ReturnType<ColyseusTestServer["createRoom"]>> & { state: RoomState };

interface DecodedMonster {
  kind: string;
  tileX: number;
  tileY: number;
}

interface ClientRoom {
  readonly sessionId: string;
  readonly state:
    | {
        players?: { get(id: string): unknown; readonly size: number };
        monsters?: {
          get(id: string): DecodedMonster | undefined;
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

/** Walk the central street from spawn through the south gate. */
async function walkToSouthDoor(room: AnyRoom, client: ClientRoom): Promise<void> {
  const [doorTile] = outbound.from.tiles;
  assert.ok(doorTile);
  assert.equal(doorTile.tileX, plaza.spawn.tileX);
  await stepMany(client, Direction.Down, doorTile.tileY - plaza.spawn.tileY);
  await expectServerAt(room, client, doorTile.tileX, doorTile.tileY, "onto the south door");
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

  it("publishes both of its doors' trigger tiles as portal markers and no others", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const declared = [...inbound.from.tiles, ...northDoor.from.tiles]
      .map((tile) => `${tile.tileX},${tile.tileY}`)
      .sort();
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

describe("hunting-ground — the round trip through plaza's south door", () => {
  it("fires plaza-south-door when a walker reaches the south gate", async () => {
    const room = await createRoom(PLAZA);
    const walker = await join(room, "walker");
    const inbox = collect(walker);

    await walkToSouthDoor(room, walker);

    await waitUntil(() => inbox.portals.length === 1, "PortalEntered for the south door");
    assert.deepEqual(inbox.portals[0], { portalId: outbound.id, toRoom: HUNTING_GROUND });
    assert.equal(inbox.rejects.length, 0, "every step of the route is an accepted move");
  });

  it("does not fire the north door on the way to the south one", async () => {
    // The two plaza doors are mirror images across the spawn row; a route that brushed the
    // wrong one would report a hop to grand-plaza and nothing else would notice.
    const room = await createRoom(PLAZA);
    const walker = await join(room, "walker");
    const inbox = collect(walker);

    await walkToSouthDoor(room, walker);
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
    await walkToSouthDoor(plazaRoom, walker);
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

  it("does not re-fire the south door on the tile a returning player arrives on", async () => {
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
      "the plaza arrival sits on the south door's own trigger",
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

// ---------------------------------------------------------------------------
// Monsters over a real connection.
//
// `metaverseRoom.views.test.ts` audits the ledger by driving a room object directly, and
// `monsterAi.test.ts` audits the FSM with no room at all. Neither of them encodes anything: they
// would both still pass if `state.monsters` never reached a client, if the spawn table were
// narrowed to the wrong room name, or if a second view-tagged map on the same schema did not
// decode. That is what these cover, and it is the only place the real MONSTER_SPAWN_DEFINITIONS
// and the real simulation loop are exercised together.
// ---------------------------------------------------------------------------

const HUNTING_SPAWNS = MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === HUNTING_GROUND);

/**
 * The south-east end of the walkable interior. Only 8 of the 20 spawn rows are within a view
 * radius of it, against all 20 from the room's own spawn tile — which is what makes monster
 * interest management observable on a map this small.
 */
const FAR_CORNER = { tileX: 55, tileY: 31 };

function chebyshev(a: { tileX: number; tileY: number }, b: { tileX: number; tileY: number }): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/** Recomputed on every poll: both sides of the comparison move while the loop is running. */
function serverVisibleMonsters(room: AnyRoom, sessionId: string): string[] {
  const player = room.state.players.get(sessionId);
  if (player === undefined) {
    return [];
  }
  const ids: string[] = [];
  for (const [monsterId, monster] of room.state.monsters.entries()) {
    if (chebyshev(player, monster) <= VIEW_RADIUS_TILES) {
      ids.push(monsterId);
    }
  }
  return ids.sort();
}

function decodedMonsters(client: ClientRoom): string[] {
  return [...(client.state?.monsters?.keys() ?? [])].sort();
}

function decodedMonsterOf(client: ClientRoom, monsterId: string): DecodedMonster {
  const monster = client.state?.monsters?.get(monsterId);
  assert.ok(monster, `the client has no decoded monster "${monsterId}"`);
  return monster;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Waits for the decoded map to agree with the server's own radius calculation. A convergence
 * check rather than a snapshot comparison, because the monsters keep walking: a single sample
 * could catch the client one patch behind and fail for no reason.
 */
async function expectDecodedMonstersToMatch(
  room: AnyRoom,
  client: ClientRoom,
  label: string,
): Promise<string[]> {
  try {
    await waitUntil(() => sameIds(decodedMonsters(client), serverVisibleMonsters(room, client.sessionId)), label);
  } catch {
    assert.fail(
      `${label}: client decoded [${decodedMonsters(client).join(",")}], server says [${serverVisibleMonsters(room, client.sessionId).join(",")}]`,
    );
  }
  return decodedMonsters(client);
}

describe("hunting-ground — monsters over the wire", () => {
  it("decodes the monsters the server says are in range, and only those", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const hunter = await join(room, "hunter");

    assert.equal(
      room.state.monsters.size,
      HUNTING_SPAWNS.length,
      "the room did not build one monster per spawn row of the real table",
    );
    const decoded = await expectDecodedMonstersToMatch(room, hunter, "the arrival view");
    assert.ok(decoded.length > 0, "a hunter standing on the trailhead sees nothing at all");
    for (const monsterId of decoded) {
      assert.ok(
        HUNTING_SPAWNS.some((spawn) => spawn.id === monsterId),
        `decoded "${monsterId}", which is in no spawn row`,
      );
      const monster = decodedMonsterOf(hunter, monsterId);
      assert.ok(
        monster.kind === MonsterKind.Squirrel ||
          monster.kind === MonsterKind.Rabbit ||
          monster.kind === MonsterKind.Boss,
        `decoded kind "${monster.kind}", which the client has no sprite for`,
      );
    }
  });

  it("drops the monsters that fall out of range as the hunter walks to the far corner", async () => {
    const room = await createRoom(HUNTING_GROUND);
    const hunter = await join(room, "hunter");
    const atSpawn = await expectDecodedMonstersToMatch(room, hunter, "the arrival view");

    // Down to the bottom row before turning east, and a snapshot of the start rather than the
    // live Player. The spawn spreads by 2, so the walker can begin anywhere from row 25 to row
    // 29 in columns 33-37, all open ground, while row 31 is clear from x16 to x55 for every
    // column it can start in.
    const start = serverPlayer(room, hunter.sessionId);
    const from = { tileX: start.tileX, tileY: start.tileY };
    await stepMany(hunter, Direction.Down, FAR_CORNER.tileY - from.tileY);
    await expectServerAt(room, hunter, from.tileX, FAR_CORNER.tileY, "the bottom row");
    await stepMany(hunter, Direction.Right, FAR_CORNER.tileX - from.tileX);
    await expectServerAt(room, hunter, FAR_CORNER.tileX, FAR_CORNER.tileY, "the far corner");

    const atCorner = await expectDecodedMonstersToMatch(room, hunter, "the far-corner view");
    // Which ids were dropped, not how many are left: the counts on both sides move as the field
    // wanders, and "at least one western monster is no longer on the wire" is the property.
    const dropped = atSpawn.filter((monsterId) => !atCorner.includes(monsterId));
    assert.ok(
      dropped.length > 0,
      `interest management filtered nothing: [${atSpawn.join(",")}] at the spawn, [${atCorner.join(",")}] in the corner`,
    );
    assert.ok(atCorner.length > 0, "the corner is inside the field; it should still see some");
  });

  it("runs the simulation loop: the field is not frozen on its spawn tiles", async () => {
    const room = await createRoom(HUNTING_GROUND);
    await join(room, "hunter");
    const spawnTileOf = new Map(HUNTING_SPAWNS.map((spawn) => [spawn.id, spawn.at]));

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

  it("keeps a monster's whole life cycle intact on the wire: death, then respawn under the same key", async () => {
    // The one case the encoder can get wrong that the ledger audit cannot see. A respawn is a
    // *new* Monster instance filed under the key a delete just removed, and a client that
    // decoded the delete has to accept the re-add without the stale entry lingering.
    //
    // Combat is Pass E's, so the room's own kill path is called directly — there is no other
    // way to stage a death today, and staging it is the entire point.
    const room = await createRoom(HUNTING_GROUND);
    const hunter = await join(room, "hunter");
    const victim = "hg-squirrel-10";
    const squirrel = MONSTER_TYPES.get(MonsterKind.Squirrel);
    assert.ok(squirrel, "MONSTER_TYPES has no squirrel row");
    assert.ok(
      HUNTING_SPAWNS.some((spawn) => spawn.id === victim && spawn.kind === MonsterKind.Squirrel),
      `${victim} is no longer a squirrel spawn row; pick another victim`,
    );

    await waitUntil(
      () => decodedMonsters(hunter).includes(victim),
      `${victim} to reach the hunter's view`,
    );

    (room as unknown as MetaverseRoom)["killMonster"](victim, Date.now());

    await waitUntil(() => !decodedMonsters(hunter).includes(victim), `${victim} to leave the wire`);
    assert.equal(hunter.state?.monsters?.get(victim), undefined, "a stale entry survived the delete");

    await waitUntil(
      () => decodedMonsters(hunter).includes(victim),
      `${victim} to respawn on the wire`,
      squirrel.respawnDelayMs + 5000,
    );
    const revived = decodedMonsterOf(hunter, victim);
    const spawnRow = HUNTING_SPAWNS.find((spawn) => spawn.id === victim);
    assert.ok(spawnRow);
    assert.ok(
      chebyshev(revived, spawnRow.at) <= spawnRow.wanderRadiusTiles,
      `respawned at (${revived.tileX},${revived.tileY}), outside its own wander box`,
    );
    await expectDecodedMonstersToMatch(room, hunter, "the view after the respawn");
  });

  it("puts no monsters in plaza or grand-plaza, which is what keeps PoC #2's baseline valid", async () => {
    for (const name of [PLAZA, "grand-plaza"]) {
      const room = await createRoom(name);
      const visitor = await join(room, "visitor");
      await sleep(MONSTER_TICK_MS * 3);
      assert.equal(room.state.monsters.size, 0, `${name} built monsters`);
      assert.equal(visitor.state?.monsters?.size ?? 0, 0, `${name} sent monsters to a client`);
    }
  });
});
