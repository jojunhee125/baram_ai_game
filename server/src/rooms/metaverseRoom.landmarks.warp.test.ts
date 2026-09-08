import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  HOME_COOLDOWN_MS,
  ServerMessage,
  VIEW_RADIUS_TILES,
  type JoinOptions,
  type Teleported,
  type TilePosition,
} from "@zep-test/shared";
import { TableLandmarkIndex } from "../game/landmarks";
import type { LandmarkIndex, RoomCreateOptions, SpawnArea } from "./contracts";
import type { LandmarkDefinition } from "./landmarkDefinitions";
import { MetaverseRoom } from "./metaverseRoom";

/**
 * Pass T deep verification for Phase M (`docs/design-phase-m-landmark-teleport.md` §7):
 *
 * 1. `handleWarpToLandmark` case not covered by Pass S's own smoke suite
 *    (`metaverseRoom.landmarks.test.ts`) — an id that exists in the table but belongs to a
 *    landmark in a *different* room.
 * 2. The load-bearing correctness property of renaming `lastHomeAt` -> `lastWarpAt` (design §2.3):
 *    a home warp and a landmark warp draw from the same cooldown budget, proven in *both*
 *    directions rather than trusted because the rename compiled.
 * 3. View-ledger correctness for a landmark warp, reusing the exact oracle
 *    (`assertViewsMatchFullRecompute`) the home-button feature's own suite
 *    (`metaverseRoom.views.test.ts`, "MetaverseRoom — home warp view maintenance") already applies
 *    to `warpTo` — the design doc says the same "quietly breaks" risk applies here since both
 *    paths share `warpTo`/`refreshViewsAround`.
 *
 * Built on the same private-method-access harness as `metaverseRoom.landmarks.test.ts` and
 * `metaverseRoom.views.test.ts`: a `createLandmarkIndex` override forces a room name regardless of
 * `this.roomName`, since this harness never goes through the matchmaker.
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

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "landmark-warp-verify",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: 80, tileY: 72, spreadRadiusInTiles: VIEW_RADIUS_TILES + 2 },
};

/** Fixed landmark destination, deliberately distinct from `ROOM_OPTIONS.spawn`/`this.home`. */
const DEST_TILE: TilePosition = { tileX: 80, tileY: 130 };

const TEST_LANDMARKS: readonly LandmarkDefinition[] = [
  { id: "landmark-dest", room: ROOM_OPTIONS.roomType, tile: { ...DEST_TILE, spreadRadiusInTiles: 0 } },
  // Same table, but owned by a different room — proves TableLandmarkIndex's room filter, not just
  // an unknown-id lookup miss.
  { id: "landmark-elsewhere", room: "some-other-room", tile: { tileX: 1, tileY: 1, spreadRadiusInTiles: 0 } },
];

class LandmarkWarpRoom extends MetaverseRoom {
  protected override createLandmarkIndex(home: SpawnArea): LandmarkIndex {
    return new TableLandmarkIndex(ROOM_OPTIONS.roomType, TEST_LANDMARKS, home);
  }
}

async function createRoom(): Promise<LandmarkWarpRoom> {
  const room = new LandmarkWarpRoom();
  await room.onCreate(ROOM_OPTIONS);
  return room;
}

function disposeRoom(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

function join(room: MetaverseRoom, sessionId: string, options?: Partial<JoinOptions>): FakeClient {
  const client = fakeClient(sessionId);
  void room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
  return client;
}

function place(room: MetaverseRoom, sessionId: string, tile: TilePosition): void {
  const player = room.state.players.get(sessionId);
  assert.ok(player, `no player for session ${sessionId}`);
  player.tileX = tile.tileX;
  player.tileY = tile.tileY;
  room["proximityIndex"].move(sessionId, tile);
}

function placeAll(room: MetaverseRoom, placements: Record<string, TilePosition>): void {
  for (const [sessionId, tile] of Object.entries(placements)) {
    place(room, sessionId, tile);
  }
  for (const sessionId of room.state.players.keys()) {
    room["refreshViewFor"](sessionId);
  }
}

function tileOf(room: MetaverseRoom, sessionId: string): TilePosition {
  const player = room.state.players.get(sessionId);
  assert.ok(player, `no player for session ${sessionId}`);
  return { tileX: player.tileX, tileY: player.tileY };
}

function viewedBy(room: MetaverseRoom, sessionId: string): string[] {
  return [...(room["viewedBySession"].get(sessionId) ?? [])].sort();
}

function chebyshev(a: TilePosition, b: TilePosition): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/** The oracle for the incremental path, copied verbatim from `metaverseRoom.views.test.ts`. */
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

function resetWarpCooldown(client: FakeClient): void {
  if (client.userData) {
    client.userData.lastWarpAt = 0;
  }
}

function landmarkWarp(room: MetaverseRoom, client: FakeClient, landmarkId: string): void {
  room["handleWarpToLandmark"](asRoomClient(client), { landmarkId });
}

function homeWarp(room: MetaverseRoom, client: FakeClient): void {
  room["handleReturnHome"](asRoomClient(client));
}

describe("MetaverseRoom — handleWarpToLandmark (Pass T)", () => {
  it("ignores a landmark id that belongs to a different room, without moving the player or consuming the cooldown", async () => {
    const room = await createRoom();
    try {
      const walker = join(room, "walker");
      const before = tileOf(room, "walker");

      landmarkWarp(room, walker, "landmark-elsewhere");

      assert.deepEqual(tileOf(room, "walker"), before, "the player must not move");
      assert.equal(sentOfType<Teleported>(walker, ServerMessage.Teleported).length, 0);

      // The cooldown was not spent on the ignored request, so a real warp right behind it still works.
      landmarkWarp(room, walker, "landmark-dest");
      assert.deepEqual(tileOf(room, "walker"), DEST_TILE);
      assert.equal(sentOfType<Teleported>(walker, ServerMessage.Teleported).length, 1);
    } finally {
      disposeRoom(room);
    }
  });
});

describe("MetaverseRoom — home warp and landmark warp share one cooldown budget (Pass T)", () => {
  it("drops a landmark warp attempted immediately after a home warp", async () => {
    const room = await createRoom();
    try {
      const walker = join(room, "walker");
      place(room, "walker", DEST_TILE);
      resetWarpCooldown(walker);

      homeWarp(room, walker);
      assert.deepEqual(tileOf(room, "walker"), { tileX: room["home"].tileX, tileY: room["home"].tileY });
      assert.equal(sentOfType<Teleported>(walker, ServerMessage.Teleported).length, 1, "the home warp itself lands");

      // No time has meaningfully passed; well inside HOME_COOLDOWN_MS.
      landmarkWarp(room, walker, "landmark-dest");
      assert.equal(
        sentOfType<Teleported>(walker, ServerMessage.Teleported).length,
        1,
        "the landmark warp right behind the home warp must be dropped, not queued or applied",
      );
      assert.deepEqual(
        tileOf(room, "walker"),
        { tileX: room["home"].tileX, tileY: room["home"].tileY },
        "the player must still be standing at home, not the landmark",
      );
    } finally {
      disposeRoom(room);
    }
  });

  it("drops a home warp attempted immediately after a landmark warp", async () => {
    const room = await createRoom();
    try {
      const walker = join(room, "walker");
      const home = { tileX: room["home"].tileX, tileY: room["home"].tileY };
      place(room, "walker", home);
      resetWarpCooldown(walker);

      landmarkWarp(room, walker, "landmark-dest");
      assert.deepEqual(tileOf(room, "walker"), DEST_TILE);
      assert.equal(
        sentOfType<Teleported>(walker, ServerMessage.Teleported).length,
        1,
        "the landmark warp itself lands",
      );

      homeWarp(room, walker);
      assert.equal(
        sentOfType<Teleported>(walker, ServerMessage.Teleported).length,
        1,
        "the home warp right behind the landmark warp must be dropped, not queued or applied",
      );
      assert.deepEqual(
        tileOf(room, "walker"),
        DEST_TILE,
        "the player must still be standing at the landmark, not home",
      );
    } finally {
      disposeRoom(room);
    }
  });

  it("accepts the second warp, whichever kind, once HOME_COOLDOWN_MS has actually elapsed", async () => {
    const room = await createRoom();
    let clock = 5_000_000;
    const restoreClock = stubDateNow(() => clock);
    try {
      const walker = join(room, "walker");
      place(room, "walker", DEST_TILE);
      resetWarpCooldown(walker);

      homeWarp(room, walker);
      assert.equal(sentOfType<Teleported>(walker, ServerMessage.Teleported).length, 1);

      clock += HOME_COOLDOWN_MS - 1;
      landmarkWarp(room, walker, "landmark-dest");
      assert.equal(
        sentOfType<Teleported>(walker, ServerMessage.Teleported).length,
        1,
        "one millisecond short of the cooldown must still be dropped",
      );

      clock += 1;
      landmarkWarp(room, walker, "landmark-dest");
      assert.equal(
        sentOfType<Teleported>(walker, ServerMessage.Teleported).length,
        2,
        "exactly HOME_COOLDOWN_MS later, the cross-kind warp is accepted — a shared cooldown, not a one-shot latch",
      );
    } finally {
      restoreClock();
      disposeRoom(room);
    }
  });
});

describe("MetaverseRoom — landmark warp view-ledger correctness (Pass T)", () => {
  it("keeps every view identical to a full recompute across a landmark warp from outside the view radius", async () => {
    const room = await createRoom();
    const restoreRandom = stubMathRandom(seededRandom(0xa11ce001));
    try {
      const warper = join(room, "warper");
      join(room, "atDest");
      join(room, "atOrigin");
      join(room, "faraway");
      const origin = { tileX: 80, tileY: 72 };
      placeAll(room, {
        warper: origin,
        atDest: { tileX: DEST_TILE.tileX, tileY: DEST_TILE.tileY + 3 },
        atOrigin: { tileX: origin.tileX + 2, tileY: origin.tileY },
        faraway: { tileX: 20, tileY: 20 },
      });
      assertViewsMatchFullRecompute(room, "before the landmark warp");
      assert.deepEqual(
        viewedBy(room, "warper"),
        ["atOrigin", "warper"],
        "precondition: the warper starts out of sight of the landmark",
      );

      resetWarpCooldown(warper);
      landmarkWarp(room, warper, "landmark-dest");

      assert.deepEqual(tileOf(room, "warper"), DEST_TILE);
      assertViewsMatchFullRecompute(room, "after the landmark warp out of view");
      assert.deepEqual(viewedBy(room, "warper"), ["atDest", "warper"]);
      assert.deepEqual(viewedBy(room, "atDest"), ["atDest", "warper"], "the landing tile gained one");
      assert.deepEqual(viewedBy(room, "atOrigin"), ["atOrigin"], "the vacated tile lost one");
      assert.deepEqual(viewedBy(room, "faraway"), ["faraway"], "and nobody else was touched");

      const teleported = sentOfType<Teleported>(warper, ServerMessage.Teleported);
      assert.equal(teleported.length, 1);
      assert.deepEqual(teleported[0], { ...DEST_TILE, facing: Direction.Down });
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("full-refreshes a one-tile landmark warp too, flipping visibility on both edges of the view", async () => {
    const room = await createRoom();
    const restoreRandom = stubMathRandom(seededRandom(0xf0f0f0f1));
    try {
      const origin: TilePosition = { tileX: DEST_TILE.tileX + 1, tileY: DEST_TILE.tileY };
      const droppedTile: TilePosition = {
        tileX: origin.tileX + VIEW_RADIUS_TILES,
        tileY: origin.tileY,
      };
      const gainedTile: TilePosition = {
        tileX: DEST_TILE.tileX - VIEW_RADIUS_TILES,
        tileY: DEST_TILE.tileY,
      };

      const warper = join(room, "warper");
      join(room, "dropped");
      join(room, "gained");
      placeAll(room, { warper: origin, dropped: droppedTile, gained: gainedTile });
      assertViewsMatchFullRecompute(room, "before the short landmark warp");
      assert.deepEqual(
        viewedBy(room, "warper"),
        ["dropped", "warper"],
        "precondition: exactly one of the two is in sight from the origin",
      );

      resetWarpCooldown(warper);
      landmarkWarp(room, warper, "landmark-dest");

      assert.deepEqual(tileOf(room, "warper"), DEST_TILE);
      assertViewsMatchFullRecompute(room, "after the short landmark warp");
      assert.deepEqual(viewedBy(room, "warper"), ["gained", "warper"]);
      assert.deepEqual(viewedBy(room, "dropped"), ["dropped"]);
      assert.deepEqual(viewedBy(room, "gained"), ["gained", "warper"]);
    } finally {
      restoreRandom();
      disposeRoom(room);
    }
  });

  it("handles a landmark warp onto the tile the player is already standing on", async () => {
    const room = await createRoom();
    const restoreRandom = stubMathRandom(seededRandom(0x1a1a1a1a));
    try {
      const warper = join(room, "warper");
      join(room, "neighbour");
      placeAll(room, {
        warper: DEST_TILE,
        neighbour: { tileX: DEST_TILE.tileX + 2, tileY: DEST_TILE.tileY },
      });
      const before = viewedBy(room, "warper");

      resetWarpCooldown(warper);
      landmarkWarp(room, warper, "landmark-dest");

      assert.deepEqual(tileOf(room, "warper"), DEST_TILE);
      assert.equal(room.state.players.get(warper.sessionId)?.facing, Direction.Down);
      assertViewsMatchFullRecompute(room, "after the in-place landmark warp");
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
});
