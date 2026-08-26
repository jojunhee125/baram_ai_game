import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  VIEW_RADIUS_TILES,
  type Player,
  type TilePosition,
} from "@zep-test/shared";
import type { CollisionMap, ProximityIndex, RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";

/**
 * These drive a room object directly rather than over a socket: the incremental view path has
 * to be exercised for hundreds of steps, and the move rate limiter alone would stretch that
 * into half a minute of wall clock over a real connection.
 */
type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null };
  userData?: { lastMoveAt: number };
}

function fakeClient(sessionId: string): FakeClient {
  return { sessionId, auth: { ssoNickname: null }, send: () => {} } as FakeClient;
}

function asRoomClient(client: FakeClient): RoomClient {
  return client as unknown as RoomClient;
}

/** mulberry32, so a failing run can be replayed exactly from the seed in the test. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spawn sampling reads Math.random directly, so the seed has to cover it too. */
function stubMathRandom(next: () => number): () => void {
  const original = Math.random;
  Math.random = next;
  return () => {
    Math.random = original;
  };
}

function chebyshev(a: TilePosition, b: TilePosition): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

async function createRoom<T extends MetaverseRoom>(room: T, options: RoomCreateOptions): Promise<T> {
  await room.onCreate(options);
  return room;
}

/** Stops the patch interval the room started in `onCreate`, which would otherwise hold the process open. */
function disposeRoom(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

function join(room: MetaverseRoom, sessionId: string): FakeClient {
  const client = fakeClient(sessionId);
  room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0 });
  return client;
}

/** Bypasses the per-client move throttle; this suite is testing view propagation, not rate limits. */
function step(room: MetaverseRoom, client: FakeClient, dir: Direction): void {
  if (client.userData) {
    client.userData.lastMoveAt = 0;
  }
  room["handleMove"](asRoomClient(client), { dir });
}

function playerOf(room: MetaverseRoom, sessionId: string): Player {
  const player = room.state.players.get(sessionId);
  assert.ok(player, `no player for session ${sessionId}`);
  return player;
}

/**
 * The oracle for the incremental path: what every client's view would be if it were rebuilt
 * from `state.players` alone. It deliberately does not consult the proximity index, so an
 * index that has gone stale shows up here too.
 */
function assertViewsMatchFullRecompute(room: MetaverseRoom, label: string): void {
  const players = room.state.players;
  const viewedBySession = room["viewedBySession"];
  const clientsBySession = room["clientsBySession"];

  for (const [sessionId, viewed] of viewedBySession) {
    const viewer = room.state.players.get(sessionId);
    assert.ok(viewer, `${label}: ${sessionId} still has view bookkeeping but no player`);

    const expected: string[] = [];
    for (const [otherId, other] of players.entries()) {
      if (chebyshev(viewer, other) <= VIEW_RADIUS_TILES) {
        expected.push(otherId);
      }
    }

    assert.deepEqual(
      [...viewed].sort(),
      expected.sort(),
      `${label}: ${sessionId}'s tracked view drifted from a full recompute`,
    );

    const view = clientsBySession.get(sessionId)?.view;
    assert.ok(view, `${label}: ${sessionId} has no StateView`);
    for (const [otherId, other] of players.entries()) {
      assert.equal(
        view.has(other),
        expected.includes(otherId),
        `${label}: ${sessionId}'s StateView disagrees with its bookkeeping about ${otherId}`,
      );
    }
  }
}

/**
 * Centre of grand-plaza's open central plaza, spread just wider than the view radius: clients
 * land both inside and outside each other's views and a single step flips visibility, which is
 * the transition the incremental path can get wrong.
 */
const AUDIT_ROOM: RoomCreateOptions = {
  roomType: "audit",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: 80, tileY: 72, spreadRadiusInTiles: VIEW_RADIUS_TILES + 2 },
};

const DIRECTIONS = [Direction.Up, Direction.Down, Direction.Left, Direction.Right] as const;

describe("MetaverseRoom — incremental view maintenance", () => {
  it("keeps every view identical to a full recompute through random joins, leaves and walks", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const random = seededRandom(0x00c0ffee);
    const restoreRandom = stubMathRandom(random);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      assert.ok(item !== undefined);
      return item;
    };

    try {
      const clients: FakeClient[] = [];
      let joins = 0;
      let leaves = 0;
      let moves = 0;

      for (let index = 0; index < 600; index++) {
        const roll = random();
        if (clients.length < 4 || roll < 0.1) {
          clients.push(join(room, `s${joins++}`));
        } else if (roll < 0.16) {
          const leaver = pick(clients);
          clients.splice(clients.indexOf(leaver), 1);
          room.onLeave(asRoomClient(leaver));
          leaves++;
        } else {
          step(room, pick(clients), pick(DIRECTIONS));
          moves++;
        }
        assertViewsMatchFullRecompute(room, `step ${index}`);
      }

      // Without this the test could pass by never exercising anything.
      assert.ok(joins > 20, `expected a meaningful number of joins, got ${joins}`);
      assert.ok(leaves > 10, `expected a meaningful number of leaves, got ${leaves}`);
      assert.ok(moves > 300, `expected a meaningful number of moves, got ${moves}`);
      assert.equal(room.state.players.size, clients.length);
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("drops a leaver from its neighbours' bookkeeping without touching distant clients", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x1234abcd));
    try {
      const alice = join(room, "alice");
      const bob = join(room, "bob");
      place(room, "alice", { tileX: 70, tileY: 70 });
      place(room, "bob", { tileX: 74, tileY: 70 });
      room["refreshViewFor"]("alice");
      room["refreshViewFor"]("bob");
      assert.deepEqual([...room["viewedBySession"].get("alice") ?? []].sort(), ["alice", "bob"]);

      room.onLeave(asRoomClient(bob));

      assert.deepEqual([...room["viewedBySession"].get("alice") ?? []], ["alice"]);
      assert.equal(room["viewedBySession"].has("bob"), false, "the leaver's bookkeeping is gone");
      assert.equal(room["clientsBySession"].has("bob"), false, "the leaver's client entry is gone");
      assertViewsMatchFullRecompute(room, "after the leave");
      void alice;
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });
});

/** Counts radius queries so a test can prove the per-move cost does not scale with room population. */
class CountingProximityIndex implements ProximityIndex {
  withinCalls = 0;

  constructor(private readonly inner: ProximityIndex) {}

  within(origin: TilePosition, radiusInTiles: number, out: string[]): string[] {
    this.withinCalls++;
    return this.inner.within(origin, radiusInTiles, out);
  }

  insert(sessionId: string, position: TilePosition): void {
    this.inner.insert(sessionId, position);
  }

  move(sessionId: string, position: TilePosition): void {
    this.inner.move(sessionId, position);
  }

  remove(sessionId: string): void {
    this.inner.remove(sessionId);
  }
}

class CountingRoom extends MetaverseRoom {
  countingIndex!: CountingProximityIndex;

  protected override createProximityIndex(map: CollisionMap): ProximityIndex {
    this.countingIndex = new CountingProximityIndex(super.createProximityIndex(map));
    return this.countingIndex;
  }
}

const ISOLATED_ROOM: RoomCreateOptions = {
  roomType: "isolated",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: 80, tileY: 72, spreadRadiusInTiles: 0 },
};

function place(room: MetaverseRoom, sessionId: string, tile: TilePosition): void {
  const player = playerOf(room, sessionId);
  player.tileX = tile.tileX;
  player.tileY = tile.tileY;
  room["proximityIndex"].move(sessionId, tile);
}

/**
 * Walkable tiles spaced further apart than the view radius, so no two clients placed on them
 * can see each other — and still cannot after one of them takes a step.
 */
function isolatedWalkableTiles(map: CollisionMap, count: number): TilePosition[] {
  const stride = VIEW_RADIUS_TILES + 2;
  const tiles: TilePosition[] = [];
  for (let tileY = 0; tileY < map.heightInTiles; tileY += stride) {
    for (let tileX = 0; tileX < map.widthInTiles; tileX += stride) {
      if (tiles.length < count && map.isWalkable(tileX, tileY)) {
        tiles.push({ tileX, tileY });
      }
    }
  }
  assert.equal(tiles.length, count, `only found ${tiles.length} isolated walkable tiles`);
  return tiles;
}

function walkableDirection(map: CollisionMap, from: TilePosition): Direction {
  const options: ReadonlyArray<readonly [Direction, TilePosition]> = [
    [Direction.Right, { tileX: from.tileX + 1, tileY: from.tileY }],
    [Direction.Left, { tileX: from.tileX - 1, tileY: from.tileY }],
    [Direction.Down, { tileX: from.tileX, tileY: from.tileY + 1 }],
    [Direction.Up, { tileX: from.tileX, tileY: from.tileY - 1 }],
  ];
  for (const [dir, destination] of options) {
    if (map.isWalkable(destination.tileX, destination.tileY)) {
      return dir;
    }
  }
  assert.fail(`no walkable neighbour of (${from.tileX},${from.tileY})`);
}

/**
 * A block of tiles in grand-plaza's open central plaza, small enough that every client on it is
 * inside every other one's view radius. The isolated-tile case below cannot tell an O(k) delta
 * from an O(k^2) per-neighbour recompute, because there k is 0.
 */
function crowdedPlazaTiles(count: number): TilePosition[] {
  const side = Math.ceil(Math.sqrt(count));
  assert.ok(side <= VIEW_RADIUS_TILES, `a ${side}-wide block does not fit inside one view radius`);
  return Array.from({ length: count }, (_, index) => ({
    tileX: 70 + (index % side),
    tileY: 70 + Math.floor(index / side),
  }));
}

describe("MetaverseRoom — per-move cost is independent of the neighbourhood size", () => {
  for (const population of [4, 25]) {
    it(`issues exactly two proximity queries for a move among ${population} mutually visible clients`, async () => {
      const room = await createRoom(new CountingRoom(), ISOLATED_ROOM);
      try {
        const tiles = crowdedPlazaTiles(population);
        const clients = tiles.map((_, index) => join(room, `s${index}`));
        tiles.forEach((tile, index) => {
          place(room, `s${index}`, tile);
        });
        for (const client of clients) {
          room["refreshViewFor"](client.sessionId);
        }

        const mover = clients[0];
        const origin = tiles[0];
        assert.ok(mover && origin);
        assert.equal(
          room["viewedBySession"].get(mover.sessionId)?.size,
          population,
          "precondition: every client sits inside every other client's view",
        );

        room.countingIndex.withinCalls = 0;
        step(room, mover, Direction.Right);

        assert.equal(
          room.countingIndex.withinCalls,
          2,
          "each neighbour is a one-bit delta, so no per-neighbour view recompute is allowed",
        );
        assert.notDeepEqual(
          { tileX: playerOf(room, mover.sessionId).tileX, tileY: playerOf(room, mover.sessionId).tileY },
          origin,
          "precondition: the move was actually accepted",
        );
        assertViewsMatchFullRecompute(room, "after the crowded move");
      } finally {
        disposeRoom(room);
      }
    });
  }
});

describe("MetaverseRoom — per-move cost is independent of room population", () => {
  for (const population of [3, 12]) {
    it(`issues exactly two proximity queries for a move among ${population} isolated clients`, async () => {
      const room = await createRoom(new CountingRoom(), ISOLATED_ROOM);
      try {
        const map = room["collisionMap"];
        const tiles = isolatedWalkableTiles(map, population);
        const clients = tiles.map((_, index) => join(room, `s${index}`));
        tiles.forEach((tile, index) => {
          place(room, `s${index}`, tile);
        });
        for (const client of clients) {
          room["refreshViewFor"](client.sessionId);
        }

        for (const client of clients) {
          assert.deepEqual(
            [...(room["viewedBySession"].get(client.sessionId) ?? [])],
            [client.sessionId],
            "precondition: every client is alone in its own view",
          );
        }

        const mover = clients[0];
        const origin = tiles[0];
        assert.ok(mover && origin);
        const dir = walkableDirection(map, origin);

        room.countingIndex.withinCalls = 0;
        step(room, mover, dir);

        assert.equal(
          room.countingIndex.withinCalls,
          2,
          "one neighbour scan plus one recompute for the mover, whatever the population",
        );
        assert.notDeepEqual(
          { tileX: playerOf(room, mover.sessionId).tileX, tileY: playerOf(room, mover.sessionId).tileY },
          origin,
          "precondition: the move was actually accepted",
        );
        assertViewsMatchFullRecompute(room, "after the isolated move");
      } finally {
        disposeRoom(room);
      }
    });
  }
});
