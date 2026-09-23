import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  HOME_COOLDOWN_MS,
  MONSTER_TICK_MS,
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
import {
  MonsterKind,
  type MonsterSpawnDefinition,
  type MonsterType,
} from "./monsterDefinitions";

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
  userData?: { lastMoveAt: number; lastWarpAt: number };
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
    client.userData.lastWarpAt = 0;
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
      assert.equal(
        warper.sent.filter(({ type }) => type !== ServerMessage.PartyChanged && type !== ServerMessage.CraftingRecipes).length,
        1,
        "and must send nothing at all — not even a rejection",
      );

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
      requiredItemKeys: () => new Set(),
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

// ---------------------------------------------------------------------------
// Monster views — design §5.5.
//
// Everything below is the monster half of the harness above, and deliberately the same
// discipline: a ledger is only ever compared against a full scan of `state.monsters`, never
// against the index that produced it. A monster that stays visible forever, or never becomes
// visible at all, is a silent defect — nothing throws, nothing logs, and the only witness is a
// player who cannot see what is hitting them.
// ---------------------------------------------------------------------------

/**
 * Fixture rules rather than the shipped `MONSTER_TYPES`. Every interval is exactly one tick, so
 * `tick()` can be driven one step at a time and a walk of forty tiles costs forty calls instead
 * of the twenty-four seconds of simulated time the tuned-for-play table would need.
 */
const FIXTURE_MONSTER_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: 12,
      damage: 2,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 6,
      leashRadiusTiles: 10,
      respawnDelayMs: MONSTER_TICK_MS * 5,
      expReward: 1,
      loot: [],
    },
  ],
]);

const FIXTURE_RESPAWN_DELAY_MS = MONSTER_TICK_MS * 5;

/**
 * A room whose monster table is injected and whose monster index and simulation loop are both
 * counted.
 *
 * The simulation interval is counted and then *not* started. A live 200ms timer would mutate the
 * state in the middle of an assertion and would hold the process open, and the thing worth
 * asserting about it is whether the room asked for one at all (§5.4) — which the counter answers
 * exactly. Every test below drives {@link MetaverseRoom.tick} itself, with the clock as an
 * argument, which is the reason that method takes `now` rather than reading it.
 */
class MonsterCountingRoom extends MetaverseRoom {
  /** Assigned before `onCreate`; `monsterSpawns()` is not consulted before that. */
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];
  monsterIndexBuilds = 0;
  simulationIntervals = 0;
  simulationIntervalDelays: Array<number | undefined> = [];
  private countingMonsterIndex: CountingProximityIndex | null = null;

  get monsterIndexQueries(): number {
    return this.countingMonsterIndex?.withinCalls ?? 0;
  }

  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return this.fixtureSpawns;
  }

  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return FIXTURE_MONSTER_TYPES;
  }

  protected override createMonsterIndex(map: CollisionMap): ProximityIndex {
    this.monsterIndexBuilds++;
    this.countingMonsterIndex = new CountingProximityIndex(super.createMonsterIndex(map));
    return this.countingMonsterIndex;
  }

  override setSimulationInterval(
    callback?: Parameters<MetaverseRoom["setSimulationInterval"]>[0],
    delay?: number,
  ): void {
    this.simulationIntervals++;
    this.simulationIntervalDelays.push(delay);
    void callback;
  }
}

/**
 * The centre of grand-plaza's open plaza and the half-extent of the largest fully walkable
 * square around it. Monsters and players walk inside this box, so a step is only ever refused
 * by the map when a test means it to be. {@link assertOpenBoxIsWalkable} is what keeps this
 * pair honest if the map is ever regenerated.
 */
const OPEN_CENTRE: TilePosition = { tileX: 78, tileY: 70 };
const OPEN_HALF_EXTENT = 17;

/** Far outside the open box and outside a view radius of it — the warp test's origin. */
const OUTSIDE_THE_BOX: TilePosition = { tileX: 78, tileY: 13 };

const MONSTER_ROOM: RoomCreateOptions = {
  roomType: "monster-audit",
  mapKey: "grand-plaza",
  maxClients: 500,
  // No spread: every test below places its clients explicitly, and a scattered join would make
  // the exact ledger contents a matter of the seed.
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

function monsterSpawn(
  id: string,
  at: TilePosition,
  wanderRadiusTiles = 0,
): MonsterSpawnDefinition {
  // `room` is ignored: MonsterCountingRoom returns the fixture table without filtering it.
  return { id, room: MONSTER_ROOM.roomType, kind: MonsterKind.Squirrel, at, wanderRadiusTiles };
}

async function createMonsterRoom(
  spawns: readonly MonsterSpawnDefinition[],
  options: RoomCreateOptions = MONSTER_ROOM,
): Promise<MonsterCountingRoom> {
  const room = new MonsterCountingRoom();
  room.fixtureSpawns = spawns;
  await room.onCreate(options);
  return room;
}

function assertOpenBoxIsWalkable(room: MetaverseRoom): void {
  const map = room["collisionMap"];
  for (let tileY = OPEN_CENTRE.tileY - OPEN_HALF_EXTENT; tileY <= OPEN_CENTRE.tileY + OPEN_HALF_EXTENT; tileY++) {
    for (let tileX = OPEN_CENTRE.tileX - OPEN_HALF_EXTENT; tileX <= OPEN_CENTRE.tileX + OPEN_HALF_EXTENT; tileX++) {
      assert.ok(
        map.isWalkable(tileX, tileY),
        `the walking box these tests assume is no longer open at (${tileX},${tileY})`,
      );
    }
  }
  assert.ok(map.isWalkable(OUTSIDE_THE_BOX.tileX, OUTSIDE_THE_BOX.tileY));
  assert.ok(
    chebyshev(OUTSIDE_THE_BOX, OPEN_CENTRE) > VIEW_RADIUS_TILES,
    "the warp origin has to be out of sight of home, or the warp test proves nothing",
  );
}

function monstersViewedBy(room: MetaverseRoom, sessionId: string): string[] {
  return [...(room["monstersViewedBySession"].get(sessionId) ?? [])].sort();
}

function monsterTileOf(room: MetaverseRoom, monsterId: string): TilePosition {
  const monster = room.state.monsters.get(monsterId);
  assert.ok(monster, `no monster ${monsterId}`);
  return { tileX: monster.tileX, tileY: monster.tileY };
}

/** Drives the room's own step applier, which is what `tick` calls for an accepted chase step. */
function stepMonster(room: MetaverseRoom, monsterId: string, dir: Direction): void {
  const monster = room.state.monsters.get(monsterId);
  assert.ok(monster, `no monster ${monsterId} to step`);
  room["stepMonster"](monsterId, monster, [dir]);
}

/**
 * `placeAll` for a room with monsters. `place` moves a player behind the room's back, so the
 * monster ledger has to be rebuilt alongside the player one — otherwise the case under test
 * starts from bookkeeping that is already wrong and the assertion cannot say which broke it.
 */
function placeAllWithMonsters(room: MetaverseRoom, placements: Record<string, TilePosition>): void {
  placeAll(room, placements);
  for (const sessionId of room.state.players.keys()) {
    room["refreshMonsterViewFor"](sessionId);
  }
}

/**
 * The monster oracle: what every client's monster view would be if it were rebuilt from
 * `state.monsters` alone. Like its player twin it never consults the monster index, so an index
 * that has gone stale is caught here rather than agreeing with itself.
 */
function assertMonsterViewsMatchFullRecompute(room: MetaverseRoom, label: string): void {
  const monsters = room.state.monsters;
  const viewedBySession = room["monstersViewedBySession"];
  const clientsBySession = room["clientsBySession"];

  for (const [sessionId, viewed] of viewedBySession) {
    const viewer = room.state.players.get(sessionId);
    assert.ok(viewer, `${label}: ${sessionId} still has monster bookkeeping but no player`);

    const expected: string[] = [];
    for (const [monsterId, monster] of monsters.entries()) {
      if (chebyshev(viewer, monster) <= VIEW_RADIUS_TILES) {
        expected.push(monsterId);
      }
    }

    assert.deepEqual(
      [...viewed].sort(),
      expected.sort(),
      `${label}: ${sessionId}'s monster ledger drifted from a full recompute`,
    );

    const view = clientsBySession.get(sessionId)?.view;
    assert.ok(view, `${label}: ${sessionId} has no StateView`);
    for (const [monsterId, monster] of monsters.entries()) {
      assert.equal(
        view.has(monster),
        expected.includes(monsterId),
        `${label}: ${sessionId}'s StateView disagrees with its ledger about ${monsterId}`,
      );
    }
  }

  // The other direction, which the loop above cannot see: a player with no ledger at all. That
  // is what a forgotten line in `onJoin` looks like, and every one of its monsters would then be
  // invisible to that one client for as long as they stayed in the room.
  if (room["hasMonsters"]) {
    for (const sessionId of room.state.players.keys()) {
      assert.ok(
        viewedBySession.has(sessionId),
        `${label}: ${sessionId} is in the room but has no monster ledger`,
      );
    }
  }
}

/** Every (viewer, monster) pair currently on a ledger, so a fuzz can count real transitions. */
function monsterLedgerPairs(room: MetaverseRoom): Set<string> {
  const pairs = new Set<string>();
  for (const [sessionId, viewed] of room["monstersViewedBySession"]) {
    for (const monsterId of viewed) {
      pairs.add(`${sessionId}/${monsterId}`);
    }
  }
  return pairs;
}

describe("MetaverseRoom — monster views follow a walking player (§5.5-1)", () => {
  it("keeps the monster ledger identical to a full recompute across a 34-tile walk", async () => {
    // Three monsters on the walk's own row: one the walker starts on top of and leaves behind,
    // one it never loses, and one it only ever approaches. A single walk therefore exercises
    // both edges of the radius in one direction each.
    const left = { tileX: OPEN_CENTRE.tileX - OPEN_HALF_EXTENT, tileY: OPEN_CENTRE.tileY };
    const right = { tileX: OPEN_CENTRE.tileX + OPEN_HALF_EXTENT, tileY: OPEN_CENTRE.tileY };
    const room = await createMonsterRoom([
      monsterSpawn("m-left", left),
      monsterSpawn("m-centre", OPEN_CENTRE),
      monsterSpawn("m-right", right),
    ]);
    try {
      assertOpenBoxIsWalkable(room);
      const walker = join(room, "walker");
      join(room, "sitter");
      placeAllWithMonsters(room, { walker: left, sitter: OPEN_CENTRE });

      assert.deepEqual(
        monstersViewedBy(room, "walker"),
        ["m-centre", "m-left"],
        "precondition: exactly one of the three starts out of sight",
      );
      const sitterBefore = monstersViewedBy(room, "sitter");
      assert.deepEqual(sitterBefore, ["m-centre", "m-left", "m-right"]);

      let gained = 0;
      let lost = 0;
      let previous = new Set(monstersViewedBy(room, "walker"));
      for (let index = 0; index < OPEN_HALF_EXTENT * 2; index++) {
        step(room, walker, Direction.Right);
        assertMonsterViewsMatchFullRecompute(room, `walk step ${index}`);
        const current = new Set(monstersViewedBy(room, "walker"));
        for (const id of current) {
          if (!previous.has(id)) {
            gained++;
          }
        }
        for (const id of previous) {
          if (!current.has(id)) {
            lost++;
          }
        }
        previous = current;
      }

      assert.deepEqual(tileOf(room, "walker"), right, "precondition: every step was accepted");
      assert.deepEqual(monstersViewedBy(room, "walker"), ["m-centre", "m-right"]);
      assert.equal(gained, 1, "m-right came into view exactly once");
      assert.equal(lost, 1, "m-left went out of view exactly once");
      assert.deepEqual(
        monstersViewedBy(room, "sitter"),
        sitterBefore,
        "one player walking must not touch another player's monster ledger",
      );
    } finally {
      disposeRoom(room);
    }
  });

  it("flips a monster in and out on the exact tile the radius changes", async () => {
    const monsterTile = { tileX: OPEN_CENTRE.tileX + OPEN_HALF_EXTENT, tileY: OPEN_CENTRE.tileY };
    const room = await createMonsterRoom([monsterSpawn("m", monsterTile)]);
    try {
      assertOpenBoxIsWalkable(room);
      const walker = join(room, "walker");
      // One tile too far to see it: the very next step must be the one that reveals it.
      const start = { tileX: monsterTile.tileX - (VIEW_RADIUS_TILES + 1), tileY: monsterTile.tileY };
      placeAllWithMonsters(room, { walker: start });
      assert.deepEqual(monstersViewedBy(room, "walker"), [], "precondition: one tile out of range");

      step(room, walker, Direction.Right);
      assert.equal(chebyshev(tileOf(room, "walker"), monsterTile), VIEW_RADIUS_TILES);
      assert.deepEqual(monstersViewedBy(room, "walker"), ["m"], "radius 19 is inside the view");
      assertMonsterViewsMatchFullRecompute(room, "on the boundary");

      step(room, walker, Direction.Left);
      assert.equal(chebyshev(tileOf(room, "walker"), monsterTile), VIEW_RADIUS_TILES + 1);
      assert.deepEqual(monstersViewedBy(room, "walker"), [], "radius 20 is outside it again");
      assertMonsterViewsMatchFullRecompute(room, "back off the boundary");
    } finally {
      disposeRoom(room);
    }
  });
});

describe("MetaverseRoom — monster views follow a walking monster (§5.5-2)", () => {
  it("keeps the ledger correct while the monster walks in, through and back out", async () => {
    // The mirror of the test above and a genuinely separate code path: a player's step ends in
    // `refreshMonsterViewFor` (rebuild the mover's own view), a monster's step in
    // `refreshMonsterViewAround` (touch the views the monster can have changed).
    const start = { tileX: OPEN_CENTRE.tileX + OPEN_HALF_EXTENT, tileY: OPEN_CENTRE.tileY };
    const watchTile = { tileX: OPEN_CENTRE.tileX - OPEN_HALF_EXTENT, tileY: OPEN_CENTRE.tileY };
    const room = await createMonsterRoom([monsterSpawn("m", start)]);
    try {
      assertOpenBoxIsWalkable(room);
      join(room, "watcher");
      join(room, "faraway");
      placeAllWithMonsters(room, { watcher: watchTile, faraway: OUTSIDE_THE_BOX });

      assert.equal(chebyshev(watchTile, start), OPEN_HALF_EXTENT * 2);
      assert.deepEqual(monstersViewedBy(room, "watcher"), [], "precondition: too far to be seen");

      let gained = 0;
      let lost = 0;
      let visible = false;
      const observe = (label: string): void => {
        assertMonsterViewsMatchFullRecompute(room, label);
        const now = monstersViewedBy(room, "watcher").includes("m");
        if (now !== visible) {
          if (now) {
            gained++;
          } else {
            lost++;
          }
          visible = now;
        }
      };

      for (let index = 0; index < OPEN_HALF_EXTENT * 2; index++) {
        stepMonster(room, "m", Direction.Left);
        observe(`monster approach ${index}`);
      }
      assert.deepEqual(monsterTileOf(room, "m"), watchTile, "precondition: every step was walkable");
      assert.deepEqual(monstersViewedBy(room, "watcher"), ["m"]);

      for (let index = 0; index < OPEN_HALF_EXTENT * 2; index++) {
        stepMonster(room, "m", Direction.Right);
        observe(`monster retreat ${index}`);
      }
      assert.deepEqual(monsterTileOf(room, "m"), start);
      assert.deepEqual(monstersViewedBy(room, "watcher"), []);

      assert.equal(gained, 1, "the monster entered the watcher's view exactly once");
      assert.equal(lost, 1, "and left it exactly once");
      assert.deepEqual(
        monstersViewedBy(room, "faraway"),
        [],
        "a monster stepping must not reach a player who was never within radius of either tile",
      );
    } finally {
      disposeRoom(room);
    }
  });

  it("adds a monster that walks in to every viewer in range, not just the nearest", async () => {
    // `refreshMonsterViewAround` visits a queried neighbourhood. A query anchored or bounded
    // wrongly would still serve the closest viewer and quietly skip the ones at the far edge.
    const start = { tileX: OPEN_CENTRE.tileX + OPEN_HALF_EXTENT, tileY: OPEN_CENTRE.tileY };
    const room = await createMonsterRoom([monsterSpawn("m", start)]);
    try {
      assertOpenBoxIsWalkable(room);
      const watchers = ["w0", "w1", "w2", "w3"];
      for (const id of watchers) {
        join(room, id);
      }
      // Spread down the column one tile short of the boundary, so one step of the monster puts
      // it inside the radius of all four at the same time.
      placeAllWithMonsters(room, {
        w0: { tileX: start.tileX - (VIEW_RADIUS_TILES + 1), tileY: start.tileY },
        w1: { tileX: start.tileX - (VIEW_RADIUS_TILES + 1), tileY: start.tileY + 4 },
        w2: { tileX: start.tileX - (VIEW_RADIUS_TILES + 1), tileY: start.tileY - 4 },
        w3: { tileX: start.tileX - (VIEW_RADIUS_TILES + 1), tileY: start.tileY + 8 },
      });
      for (const id of watchers) {
        assert.deepEqual(monstersViewedBy(room, id), [], `precondition: ${id} cannot see it yet`);
      }

      stepMonster(room, "m", Direction.Left);

      for (const id of watchers) {
        assert.deepEqual(monstersViewedBy(room, id), ["m"], `${id} was skipped`);
      }
      assertMonsterViewsMatchFullRecompute(room, "after the one step that reveals it to four");
    } finally {
      disposeRoom(room);
    }
  });
});

describe("MetaverseRoom — monster death and respawn (§5.5-3)", () => {
  it("drops a dead monster from every viewer's ledger and brings it back only to those in range", async () => {
    const room = await createMonsterRoom([
      monsterSpawn("m", OPEN_CENTRE),
      monsterSpawn("m-other", { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY }),
    ]);
    try {
      assertOpenBoxIsWalkable(room);
      const near = ["near0", "near1"];
      for (const id of [...near, "far"]) {
        join(room, id);
      }
      placeAllWithMonsters(room, {
        near0: OPEN_CENTRE,
        near1: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY + VIEW_RADIUS_TILES },
        far: OUTSIDE_THE_BOX,
      });
      for (const id of near) {
        assert.deepEqual(monstersViewedBy(room, id), ["m", "m-other"], `precondition: ${id} sees both`);
      }
      assert.deepEqual(monstersViewedBy(room, "far"), [], "precondition: far sees neither");

      const killedAt = 10_000;
      room["killMonster"]("m", killedAt);

      assert.equal(room.state.monsters.has("m"), false, "a death is a deletion, not a flag");
      for (const id of near) {
        assert.deepEqual(monstersViewedBy(room, id), ["m-other"], `${id} still carries the corpse`);
      }
      assertMonsterViewsMatchFullRecompute(room, "after the death");

      // Too early: the respawn is a deadline, not a one-shot the next tick satisfies.
      room["tick"](killedAt + FIXTURE_RESPAWN_DELAY_MS - 1);
      assert.equal(room.state.monsters.has("m"), false, "it came back before its delay elapsed");
      assertMonsterViewsMatchFullRecompute(room, "one millisecond before the respawn");

      room["tick"](killedAt + FIXTURE_RESPAWN_DELAY_MS);

      assert.equal(room.state.monsters.has("m"), true, "and it never came back at all");
      assert.deepEqual(monsterTileOf(room, "m"), OPEN_CENTRE, "a respawn returns to the spawn tile");
      for (const id of near) {
        assert.deepEqual(monstersViewedBy(room, id), ["m", "m-other"], `${id} did not get it back`);
      }
      assert.deepEqual(
        monstersViewedBy(room, "far"),
        [],
        "a respawn must reach only the viewers within radius of the spawn tile",
      );
      assertMonsterViewsMatchFullRecompute(room, "after the respawn");
    } finally {
      disposeRoom(room);
    }
  });

  it("respawns into the ledger of a viewer who arrived while it was dead", async () => {
    // The ordering trap: the respawn's `refreshMonsterViewAround` reaches whoever is standing
    // there *now*, which is not the set of viewers the death touched.
    const room = await createMonsterRoom([monsterSpawn("m", OPEN_CENTRE)]);
    try {
      const witness = join(room, "witness");
      placeAllWithMonsters(room, { witness: OPEN_CENTRE });
      room["killMonster"]("m", 1000);
      room.onLeave(asRoomClient(witness));

      const latecomer = join(room, "latecomer");
      void latecomer;
      assert.deepEqual(monstersViewedBy(room, "latecomer"), [], "nothing alive to see yet");

      room["tick"](1000 + FIXTURE_RESPAWN_DELAY_MS);

      assert.deepEqual(monstersViewedBy(room, "latecomer"), ["m"]);
      assertMonsterViewsMatchFullRecompute(room, "after a respawn under a new audience");
    } finally {
      disposeRoom(room);
    }
  });

  it("leaves no ledger entry behind when a monster dies out of everyone's sight", async () => {
    const room = await createMonsterRoom([monsterSpawn("m", OPEN_CENTRE)]);
    try {
      join(room, "far");
      placeAllWithMonsters(room, { far: OUTSIDE_THE_BOX });
      assert.deepEqual(monstersViewedBy(room, "far"), []);

      room["killMonster"]("m", 500);
      assertMonsterViewsMatchFullRecompute(room, "after an unwitnessed death");
      room["tick"](500 + FIXTURE_RESPAWN_DELAY_MS);
      assert.equal(room.state.monsters.has("m"), true);
      assert.deepEqual(
        monstersViewedBy(room, "far"),
        [],
        "an unwitnessed respawn must not add itself to a distant ledger",
      );
      assertMonsterViewsMatchFullRecompute(room, "after an unwitnessed respawn");
    } finally {
      disposeRoom(room);
    }
  });
});

describe("MetaverseRoom — a leaver's monster ledger (§5.5-4)", () => {
  it("drops the leaver's monster bookkeeping and touches nobody else's", async () => {
    const room = await createMonsterRoom([
      monsterSpawn("m0", OPEN_CENTRE),
      monsterSpawn("m1", { tileX: OPEN_CENTRE.tileX + 2, tileY: OPEN_CENTRE.tileY }),
    ]);
    try {
      const leaver = join(room, "leaver");
      join(room, "stayer");
      placeAllWithMonsters(room, { leaver: OPEN_CENTRE, stayer: OPEN_CENTRE });
      assert.deepEqual(monstersViewedBy(room, "leaver"), ["m0", "m1"], "precondition: it sees both");

      room.onLeave(asRoomClient(leaver));

      assert.equal(
        room["monstersViewedBySession"].has("leaver"),
        false,
        "a Set per departed session, held for the room's whole life, is the leak this guards",
      );
      assert.deepEqual(monstersViewedBy(room, "stayer"), ["m0", "m1"]);
      assertMonsterViewsMatchFullRecompute(room, "after the leave");
    } finally {
      disposeRoom(room);
    }
  });

  it("empties the ledger map entirely once the last player has gone", async () => {
    const room = await createMonsterRoom([monsterSpawn("m", OPEN_CENTRE)]);
    try {
      const clients = ["a", "b", "c"].map((id) => join(room, id));
      assert.equal(room["monstersViewedBySession"].size, 3);
      for (const client of clients) {
        room.onLeave(asRoomClient(client));
      }
      assert.equal(room["monstersViewedBySession"].size, 0);
    } finally {
      disposeRoom(room);
    }
  });

  it("keeps a leaver out of the ledgers a later monster step walks over", async () => {
    // A ledger left behind would not fail on the leave itself: it fails later, when the next
    // monster step queries that tile and finds a viewer with no player.
    const room = await createMonsterRoom([
      monsterSpawn("m", { tileX: OPEN_CENTRE.tileX + OPEN_HALF_EXTENT, tileY: OPEN_CENTRE.tileY }),
    ]);
    try {
      assertOpenBoxIsWalkable(room);
      const leaver = join(room, "leaver");
      placeAllWithMonsters(room, { leaver: OPEN_CENTRE });
      room.onLeave(asRoomClient(leaver));

      for (let index = 0; index < 5; index++) {
        stepMonster(room, "m", Direction.Left);
        assertMonsterViewsMatchFullRecompute(room, `step ${index} after the leave`);
      }
      assert.equal(room["monstersViewedBySession"].size, 0);
    } finally {
      disposeRoom(room);
    }
  });
});

describe("MetaverseRoom — monster views across a home warp (§5.5-5)", () => {
  it("rebuilds the warper's monster view from the landing tile, not the one it left", async () => {
    const originMonster = { tileX: OUTSIDE_THE_BOX.tileX, tileY: OUTSIDE_THE_BOX.tileY + 2 };
    const homeMonster = { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY + 2 };
    const room = await createMonsterRoom([
      monsterSpawn("m-origin", originMonster),
      monsterSpawn("m-home", homeMonster),
      monsterSpawn("m-nowhere", { tileX: 160, tileY: 140 }),
    ]);
    try {
      assertOpenBoxIsWalkable(room);
      const warper = join(room, "warper");
      join(room, "resident");
      placeAllWithMonsters(room, {
        warper: OUTSIDE_THE_BOX,
        resident: { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY },
      });
      assert.deepEqual(
        monstersViewedBy(room, "warper"),
        ["m-origin"],
        "precondition: the warper starts out of sight of home's monster",
      );
      const residentBefore = monstersViewedBy(room, "resident");
      assert.deepEqual(residentBefore, ["m-home"]);

      warpHome(room, warper);

      assert.deepEqual(tileOf(room, "warper"), {
        tileX: MONSTER_ROOM.spawn.tileX,
        tileY: MONSTER_ROOM.spawn.tileY,
      });
      assert.deepEqual(
        monstersViewedBy(room, "warper"),
        ["m-home"],
        "a warp is the path a one-tile step masks: the origin's monster must be dropped and the destination's added in one go",
      );
      assert.deepEqual(
        monstersViewedBy(room, "resident"),
        residentBefore,
        "nobody else's monster ledger moves when a player warps",
      );
      assertMonsterViewsMatchFullRecompute(room, "after the warp");
    } finally {
      disposeRoom(room);
    }
  });

  it("keeps the ledger exact when a warp lands on the tile the player already stood on", async () => {
    const room = await createMonsterRoom([monsterSpawn("m", OPEN_CENTRE)]);
    try {
      const warper = join(room, "warper");
      const before = monstersViewedBy(room, "warper");
      assert.deepEqual(before, ["m"], "precondition: it starts on top of the monster");

      warpHome(room, warper);

      assert.deepEqual(monstersViewedBy(room, "warper"), before, "an in-place warp changes nothing");
      assertMonsterViewsMatchFullRecompute(room, "after the in-place warp");
    } finally {
      disposeRoom(room);
    }
  });

  it("keeps every monster ledger identical to a full recompute through joins, leaves, walks, warps, ticks and deaths", async () => {
    // The whole feature in one loop. Any of the six paths can be right in isolation and wrong in
    // combination — a respawn arriving between a warp and its refresh, a death whose viewer set
    // was computed before the killer moved — and only a mixed sequence reaches those.
    const spawns = [
      monsterSpawn("f0", { tileX: OPEN_CENTRE.tileX - 6, tileY: OPEN_CENTRE.tileY - 4 }, 2),
      monsterSpawn("f1", { tileX: OPEN_CENTRE.tileX + 5, tileY: OPEN_CENTRE.tileY + 3 }, 2),
      monsterSpawn("f2", { tileX: OPEN_CENTRE.tileX - 2, tileY: OPEN_CENTRE.tileY + 6 }, 2),
      monsterSpawn("f3", { tileX: OPEN_CENTRE.tileX + 7, tileY: OPEN_CENTRE.tileY - 7 }, 2),
      monsterSpawn("f4", { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY }, 2),
    ];
    const room = await createMonsterRoom(spawns);
    const random = seededRandom(0x51117e5);
    const restoreRandom = stubMathRandom(random);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      assert.ok(item !== undefined);
      return item;
    };

    try {
      assertOpenBoxIsWalkable(room);
      const clients: FakeClient[] = [];
      let joins = 0;
      let ticks = 0;
      let kills = 0;
      let warps = 0;
      let gained = 0;
      let lost = 0;
      let now = 1_000;
      let previous = monsterLedgerPairs(room);

      for (let index = 0; index < 900; index++) {
        const roll = random();
        if (clients.length < 3 || roll < 0.08) {
          clients.push(join(room, `s${joins++}`));
        } else if (roll < 0.13) {
          const leaver = pick(clients);
          clients.splice(clients.indexOf(leaver), 1);
          room.onLeave(asRoomClient(leaver));
        } else if (roll < 0.2) {
          warpHome(room, pick(clients));
          warps++;
        } else if (roll < 0.24) {
          room["killMonster"](pick(spawns).id, now);
          kills++;
        } else if (roll < 0.55) {
          now += MONSTER_TICK_MS;
          room["tick"](now);
          ticks++;
        } else {
          step(room, pick(clients), pick(DIRECTIONS));
        }

        assertViewsMatchFullRecompute(room, `monster fuzz step ${index}`);
        assertMonsterViewsMatchFullRecompute(room, `monster fuzz step ${index}`);

        const current = monsterLedgerPairs(room);
        for (const pair of current) {
          if (!previous.has(pair)) {
            gained++;
          }
        }
        for (const pair of previous) {
          if (!current.has(pair)) {
            lost++;
          }
        }
        previous = current;
      }

      // Without these the loop could pass by never putting a monster in anybody's view.
      assert.ok(ticks > 100, `expected a meaningful number of ticks, got ${ticks}`);
      assert.ok(kills > 20, `expected a meaningful number of kills, got ${kills}`);
      assert.ok(warps > 30, `expected a meaningful number of warps, got ${warps}`);
      assert.ok(gained > 50, `expected monsters to enter views, got ${gained}`);
      assert.ok(lost > 50, `expected monsters to leave views, got ${lost}`);
      assert.equal(room["monstersViewedBySession"].size, clients.length);
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });
});

describe("MetaverseRoom — a room with no monsters pays nothing for them (§5.4, §5.5-6)", () => {
  /** Joins, walks, warps and leaves — every path that could reach the monster code. */
  function exerciseEveryPath(room: MonsterCountingRoom): void {
    const clients = ["a", "b", "c"].map((id) => join(room, id));
    const [first, second] = clients;
    assert.ok(first && second);
    for (let index = 0; index < 12; index++) {
      step(room, first, Direction.Right);
      step(room, second, Direction.Down);
    }
    warpHome(room, first);
    room["tick"](1_000);
    room.onLeave(asRoomClient(second));
  }

  it("builds no monster index, starts no simulation loop and issues no monster query", async () => {
    const room = await createMonsterRoom([]);
    try {
      exerciseEveryPath(room);

      assert.equal(room.monsterIndexBuilds, 0, "createMonsterIndex must not even be called");
      assert.equal(room.monsterIndexQueries, 0, "and so there is nothing to query");
      assert.equal(room["monsterIndex"], undefined);
      assert.equal(room["hasMonsters"], false);
      assert.equal(room["monsterRuntimes"].size, 0);
      assert.equal(
        room["monstersViewedBySession"].size,
        0,
        "not even an empty Set per session: the room allocates nothing for a feature it has not got",
      );
      assert.equal(
        room.simulationIntervals,
        0,
        "a monsterless room stays purely message-driven, which is what PoC #2 measured",
      );
      assert.equal(room.state.monsters.size, 0);
    } finally {
      disposeRoom(room);
    }
  });

  it("does all of it in a room that has one spawn row, so the zero above is not vacuous", async () => {
    const room = await createMonsterRoom([monsterSpawn("m", OPEN_CENTRE)]);
    try {
      exerciseEveryPath(room);

      assert.equal(room.monsterIndexBuilds, 1);
      assert.ok(room.monsterIndexQueries > 0, "the monster index is queried on the paths above");
      assert.equal(room["hasMonsters"], true);
      assert.equal(room.simulationIntervals, 1, "and the simulation loop is requested exactly once");
      assert.deepEqual(room.simulationIntervalDelays, [MONSTER_TICK_MS]);
    } finally {
      disposeRoom(room);
    }
  });

  it("stops building the index when the table names monsters for other rooms only", async () => {
    // `monsterSpawns()` narrows by room name in production; the zero-row outcome is what the
    // real grand-plaza gets, and it has to be the no-monster path rather than an empty one.
    const room = await createMonsterRoom([]);
    try {
      assert.equal(room["monsterIndex"], undefined);
      const walker = join(room, "walker");
      step(room, walker, Direction.Right);
      assert.equal(room.monsterIndexQueries, 0);
      assertViewsMatchFullRecompute(room, "a monsterless room still keeps its player views");
    } finally {
      disposeRoom(room);
    }
  });
});
