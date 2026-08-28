import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  HOME_COOLDOWN_MS,
  ServerMessage,
  VIEW_RADIUS_TILES,
  type JoinOptions,
  type Player,
  type Teleported,
  type TilePosition,
} from "@zep-test/shared";
import type {
  CollisionMap,
  PortalIndex,
  ProximityIndex,
  RoomCreateOptions,
  SpawnArea,
} from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";

/**
 * These drive a room object directly rather than over a socket: the incremental view path has
 * to be exercised for hundreds of steps, and the move rate limiter alone would stretch that
 * into half a minute of wall clock over a real connection.
 */
type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null };
  userData?: { lastMoveAt: number; lastHomeAt: number };
  /** Every `client.send()` the room made, in order — a unicast reaches the test no other way. */
  sent: SentMessage[];
}

function fakeClient(sessionId: string): FakeClient {
  const sent: SentMessage[] = [];
  return {
    sessionId,
    auth: { ssoNickname: null },
    sent,
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload });
    },
  } as FakeClient;
}

function sentOfType<T>(client: FakeClient, type: string): T[] {
  return client.sent.filter((message) => message.type === type).map((message) => message.payload as T);
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

/** Lets the cooldown tests sit exactly on the HOME_COOLDOWN_MS boundary instead of racing it. */
function stubDateNow(now: () => number): () => void {
  const original = Date.now;
  Date.now = now;
  return () => {
    Date.now = original;
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

function join(
  room: MetaverseRoom,
  sessionId: string,
  options?: Partial<JoinOptions>,
): FakeClient {
  const client = fakeClient(sessionId);
  room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
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

/** The room's home tile: the spawn centre with the spread dropped, per `MetaverseRoom.home`. */
const HOME_TILE: TilePosition = {
  tileX: AUDIT_ROOM.spawn.tileX,
  tileY: AUDIT_ROOM.spawn.tileY,
};

/** Far enough from {@link HOME_TILE} that a warp back is a jump right out of the view radius. */
const FAR_FROM_HOME: TilePosition = { tileX: 80, tileY: 130 };

function warpHome(room: MetaverseRoom, client: FakeClient): void {
  if (client.userData) {
    client.userData.lastHomeAt = 0;
  }
  room["handleReturnHome"](asRoomClient(client));
}

/**
 * Teleports clients and then rebuilds *every* view from scratch. `place` moves one player behind
 * the room's back, so without the second pass the warp under test would start from bookkeeping
 * that is already wrong and the assertion could not tell which of the two broke it.
 */
function placeAll(room: MetaverseRoom, placements: Record<string, TilePosition>): void {
  for (const [sessionId, tile] of Object.entries(placements)) {
    place(room, sessionId, tile);
  }
  for (const sessionId of room.state.players.keys()) {
    room["refreshViewFor"](sessionId);
  }
}

function viewedBy(room: MetaverseRoom, sessionId: string): string[] {
  return [...(room["viewedBySession"].get(sessionId) ?? [])].sort();
}

function tileOf(room: MetaverseRoom, sessionId: string): TilePosition {
  const player = playerOf(room, sessionId);
  return { tileX: player.tileX, tileY: player.tileY };
}

describe("MetaverseRoom — home warp view maintenance", () => {
  it("keeps every view identical to a full recompute across a warp from outside the view radius", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x0badf00d));
    try {
      const warper = join(room, "warper");
      join(room, "atHome");
      join(room, "atOrigin");
      join(room, "faraway");
      placeAll(room, {
        warper: FAR_FROM_HOME,
        atHome: { tileX: HOME_TILE.tileX, tileY: HOME_TILE.tileY + 3 },
        atOrigin: { tileX: FAR_FROM_HOME.tileX + 2, tileY: FAR_FROM_HOME.tileY },
        faraway: { tileX: 20, tileY: 20 },
      });
      assertViewsMatchFullRecompute(room, "before the warp");
      assert.deepEqual(
        viewedBy(room, "warper"),
        ["atOrigin", "warper"],
        "precondition: the warper starts out of sight of home",
      );

      warpHome(room, warper);

      assert.deepEqual(tileOf(room, "warper"), HOME_TILE);
      assertViewsMatchFullRecompute(room, "after the warp out of view");
      assert.deepEqual(viewedBy(room, "warper"), ["atHome", "warper"]);
      assert.deepEqual(viewedBy(room, "atHome"), ["atHome", "warper"], "the landing tile gained one");
      assert.deepEqual(viewedBy(room, "atOrigin"), ["atOrigin"], "the vacated tile lost one");
      assert.deepEqual(viewedBy(room, "faraway"), ["faraway"], "and nobody else was touched");

      const teleported = sentOfType<Teleported>(warper, ServerMessage.Teleported);
      assert.equal(teleported.length, 1);
      assert.deepEqual(teleported[0], { ...HOME_TILE, facing: Direction.Down });
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("full-refreshes a one-tile warp too, flipping visibility on both edges of the view", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x0f0f0f0f));
    try {
      const origin: TilePosition = { tileX: HOME_TILE.tileX + 1, tileY: HOME_TILE.tileY };
      // 19 tiles from the origin but 20 from home, and the mirror case on the other side: a
      // one-tile warp is still a position change big enough to flip two clients in opposite
      // directions, which a "close enough, skip the refresh" shortcut would get wrong.
      const droppedTile: TilePosition = {
        tileX: origin.tileX + VIEW_RADIUS_TILES,
        tileY: origin.tileY,
      };
      const gainedTile: TilePosition = {
        tileX: HOME_TILE.tileX - VIEW_RADIUS_TILES,
        tileY: HOME_TILE.tileY,
      };

      const warper = join(room, "warper");
      join(room, "dropped");
      join(room, "gained");
      placeAll(room, { warper: origin, dropped: droppedTile, gained: gainedTile });
      assertViewsMatchFullRecompute(room, "before the short warp");
      assert.deepEqual(
        viewedBy(room, "warper"),
        ["dropped", "warper"],
        "precondition: exactly one of the two is in sight from the origin",
      );

      warpHome(room, warper);

      assert.deepEqual(tileOf(room, "warper"), HOME_TILE);
      assertViewsMatchFullRecompute(room, "after the short warp");
      assert.deepEqual(viewedBy(room, "warper"), ["gained", "warper"]);
      assert.deepEqual(viewedBy(room, "dropped"), ["dropped"]);
      assert.deepEqual(viewedBy(room, "gained"), ["gained", "warper"]);
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("handles a warp onto the tile the player is already standing on", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x11111111));
    try {
      const warper = join(room, "warper");
      join(room, "neighbour");
      placeAll(room, {
        warper: HOME_TILE,
        neighbour: { tileX: HOME_TILE.tileX + 2, tileY: HOME_TILE.tileY },
      });
      const before = viewedBy(room, "warper");

      warpHome(room, warper);

      assert.deepEqual(tileOf(room, "warper"), HOME_TILE);
      assert.equal(playerOf(room, "warper").facing, Direction.Down);
      assertViewsMatchFullRecompute(room, "after the in-place warp");
      assert.deepEqual(before, ["neighbour", "warper"], "precondition: the two can see each other");
      assert.deepEqual(viewedBy(room, "warper"), before, "an in-place warp changes nobody's view");
      assert.deepEqual(viewedBy(room, "neighbour"), ["neighbour", "warper"]);
      assert.equal(
        sentOfType<Teleported>(warper, ServerMessage.Teleported).length,
        1,
        "and is still acknowledged — the client cannot tell it was a no-op",
      );
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("silently ignores a second return-home inside the cooldown window", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x2222dddd));
    let clock = 1_000_000;
    const restoreClock = stubDateNow(() => clock);
    try {
      const warper = join(room, "warper");
      placeAll(room, { warper: FAR_FROM_HOME });

      room["handleReturnHome"](asRoomClient(warper));
      assert.deepEqual(tileOf(room, "warper"), HOME_TILE, "the first request is accepted");
      assert.equal(sentOfType<Teleported>(warper, ServerMessage.Teleported).length, 1);

      // Displaced again, so a second *accepted* warp would show up as a position change. Without
      // this the assertion below would hold either way and the test would prove nothing.
      placeAll(room, { warper: FAR_FROM_HOME });
      clock += HOME_COOLDOWN_MS - 1;
      room["handleReturnHome"](asRoomClient(warper));

      assert.deepEqual(
        tileOf(room, "warper"),
        FAR_FROM_HOME,
        "a request one millisecond inside the window must not move the player",
      );
      assert.equal(warper.sent.length, 1, "and must send nothing at all — not even a rejection");

      clock += 1;
      room["handleReturnHome"](asRoomClient(warper));
      assert.deepEqual(
        tileOf(room, "warper"),
        HOME_TILE,
        "exactly HOME_COOLDOWN_MS later it is accepted again: a cooldown, not a one-shot latch",
      );
      assert.equal(sentOfType<Teleported>(warper, ServerMessage.Teleported).length, 2);
      assertViewsMatchFullRecompute(room, "after the cooldown expired");
    } finally {
      restoreClock();
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("leaves the warper inside its own view — the proximity index is updated before the refresh", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x33334444));
    try {
      const warper = join(room, "warper");
      join(room, "atHome");
      placeAll(room, {
        warper: FAR_FROM_HOME,
        atHome: { tileX: HOME_TILE.tileX, tileY: HOME_TILE.tileY + 3 },
      });
      assert.ok(
        room["viewedBySession"].get("warper")?.has("warper"),
        "precondition: a player is always inside its own view",
      );

      warpHome(room, warper);

      // `refreshViewFor` rebuilds the warper's view from a proximity query around the *new* tile.
      // Refresh the views before moving the index and that query answers from the pre-warp tile,
      // which no longer holds the warper — so the warper drops itself and the player's own avatar
      // vanishes from their screen. A one-tile step hides this; only a warp exposes it.
      assert.ok(
        room["viewedBySession"].get("warper")?.has("warper"),
        "the warper must still see itself after warping",
      );
      const view = room["clientsBySession"].get("warper")?.view;
      assert.ok(view, "the warper still has a StateView");
      assert.equal(
        view.has(playerOf(room, "warper")),
        true,
        "and that StateView must still carry the warper's own Player",
      );
      assert.deepEqual(viewedBy(room, "warper"), ["atHome", "warper"]);
      assertViewsMatchFullRecompute(room, "after the warp");
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("keeps every view identical to a full recompute through random joins, leaves, walks and warps", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const random = seededRandom(0x5ca1ab1e);
    const restoreRandom = stubMathRandom(random);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      assert.ok(item !== undefined);
      return item;
    };

    try {
      const clients: FakeClient[] = [];
      let joins = 0;
      let warps = 0;

      for (let index = 0; index < 600; index++) {
        const roll = random();
        if (clients.length < 4 || roll < 0.1) {
          clients.push(join(room, `s${joins++}`));
        } else if (roll < 0.16) {
          const leaver = pick(clients);
          clients.splice(clients.indexOf(leaver), 1);
          room.onLeave(asRoomClient(leaver));
        } else if (roll < 0.28) {
          warpHome(room, pick(clients));
          warps++;
        } else {
          step(room, pick(clients), pick(DIRECTIONS));
        }
        assertViewsMatchFullRecompute(room, `step ${index}`);
      }

      assert.ok(warps > 40, `expected a meaningful number of warps, got ${warps}`);
      assert.equal(room.state.players.size, clients.length);
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });
});

const PORTAL_ARRIVAL: SpawnArea = { tileX: 40, tileY: 40, spreadRadiusInTiles: 0 };

/** A room that owns exactly one portal, so the `viaPortal` / `arriveAtHome` precedence is testable. */
class PortalRoom extends MetaverseRoom {
  protected override createPortalIndex(): PortalIndex {
    return {
      triggerAt: () => null,
      arrivalFor: (portalId) => (portalId === "known-door" ? PORTAL_ARRIVAL : null),
      triggerTiles: () => [],
    };
  }
}

describe("MetaverseRoom — arriveAtHome placement", () => {
  it("lands on the home tile itself, ignoring the room's spawn spread", async () => {
    const room = await createRoom(new MetaverseRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x44445555));
    try {
      assert.ok(
        AUDIT_ROOM.spawn.spreadRadiusInTiles > 0,
        "precondition: this room spreads its plain spawns, or the contrast below proves nothing",
      );

      const plainTiles = new Set<string>();
      for (let index = 0; index < 20; index++) {
        join(room, `plain${index}`);
        const tile = tileOf(room, `plain${index}`);
        plainTiles.add(`${tile.tileX},${tile.tileY}`);
      }
      assert.ok(
        plainTiles.size > 1,
        `precondition: plain joins actually scatter, got ${plainTiles.size} distinct tiles`,
      );

      for (let index = 0; index < 20; index++) {
        join(room, `home${index}`, { arriveAtHome: true });
        assert.deepEqual(
          tileOf(room, `home${index}`),
          HOME_TILE,
          `home${index} was placed off the home tile`,
        );
        assert.equal(playerOf(room, `home${index}`).facing, Direction.Down);
      }

      assertViewsMatchFullRecompute(room, "after 20 home arrivals stacked on one tile");
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("falls back to home, not to the spawn, for a viaPortal this room does not own", async () => {
    const room = await createRoom(new PortalRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x66667777));
    try {
      join(room, "stray", { arriveAtHome: true, viaPortal: "no-such-portal" });
      assert.deepEqual(
        tileOf(room, "stray"),
        HOME_TILE,
        "only one of the client's two requests was rejected",
      );
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("lets viaPortal win over arriveAtHome when the room owns the portal", async () => {
    const room = await createRoom(new PortalRoom(), AUDIT_ROOM);
    const restoreRandom = stubMathRandom(seededRandom(0x8888aaaa));
    try {
      const arrivalTile: TilePosition = {
        tileX: PORTAL_ARRIVAL.tileX,
        tileY: PORTAL_ARRIVAL.tileY,
      };
      assert.notDeepEqual(arrivalTile, HOME_TILE, "precondition: the two placements differ");

      join(room, "arrival", { arriveAtHome: true, viaPortal: "known-door" });

      assert.deepEqual(tileOf(room, "arrival"), arrivalTile);
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });
});
