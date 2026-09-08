import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ServerMessage, type JoinOptions, type Teleported } from "@zep-test/shared";
import { InMemoryInventoryStore, type InventoryStore } from "../db/inventoryStore";
import { TableLandmarkIndex } from "../game/landmarks";
import type { LandmarkIndex, RoomCreateOptions, SpawnArea } from "./contracts";
import type { LandmarkDefinition } from "./landmarkDefinitions";
import { MetaverseRoom } from "./metaverseRoom";

/**
 * Pass S smoke coverage for Phase M (`docs/design-phase-m-landmark-teleport.md`): the same-room
 * warp (`handleWarpToLandmark`) and the cross-room join branch (`onJoin`'s `arriveAtLandmark`),
 * with the entry-pass gate (§2.4) as the highest-risk new path. Exhaustive verification (cooldown
 * sharing with return-home, boot validation, view-ledger correctness) is Pass T's job; this file
 * only proves the happy path and the denial path both work.
 *
 * Built on the same private-method-access harness as `entryPass-verification.test.ts`'s
 * `GatedRoom`: a `createLandmarkIndex` override forces a room name regardless of `this.roomName`,
 * since this harness never goes through the matchmaker.
 */

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: { lastWarpAt: number };
  sent: SentMessage[];
}

function fakeClient(sessionId: string, ssoUserId: string | null = null): FakeClient {
  const sent: SentMessage[] = [];
  return {
    sessionId,
    auth: { ssoNickname: null, ssoUserId },
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

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "landmark-verify",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: 80, tileY: 72, spreadRadiusInTiles: 0 },
};

const OPEN_TILE = { tileX: 90, tileY: 72 };
const GATED_TILE = { tileX: 60, tileY: 60 };

const TEST_LANDMARKS: readonly LandmarkDefinition[] = [
  { id: "landmark-open", room: ROOM_OPTIONS.roomType, tile: { ...OPEN_TILE, spreadRadiusInTiles: 0 } },
  {
    id: "landmark-gated",
    room: ROOM_OPTIONS.roomType,
    tile: { ...GATED_TILE, spreadRadiusInTiles: 0 },
    requiresItemKey: "entry-pass",
    deniedMessage: "verify-landmark-denied",
  },
];

class LandmarkTestRoom extends MetaverseRoom {
  protected override createLandmarkIndex(home: SpawnArea): LandmarkIndex {
    return new TableLandmarkIndex(ROOM_OPTIONS.roomType, TEST_LANDMARKS, home);
  }
}

async function createLandmarkRoom(store?: InventoryStore): Promise<LandmarkTestRoom> {
  const room = new LandmarkTestRoom();
  await room.onCreate({ ...ROOM_OPTIONS, inventoryStore: store });
  return room;
}

/** Mirrors the production `onJoin` call: not awaited, since a plain or ungated-landmark join never
 * reaches an `await` and completes synchronously before this returns. */
function join(
  room: MetaverseRoom,
  sessionId: string,
  options?: Partial<JoinOptions>,
  ssoUserId: string | null = null,
): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  void room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
  return client;
}

/** For a join expected to await a store round trip (a gated landmark) or to throw. */
async function tryJoin(
  room: MetaverseRoom,
  sessionId: string,
  options: Partial<JoinOptions>,
  ssoUserId: string | null = null,
): Promise<{ client: FakeClient; error: Error | null }> {
  const client = fakeClient(sessionId, ssoUserId);
  try {
    await room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
    return { client, error: null };
  } catch (error) {
    return { client, error: error as Error };
  }
}

function warp(room: MetaverseRoom, client: FakeClient, landmarkId: string): void {
  room["handleWarpToLandmark"](asRoomClient(client), { landmarkId });
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

describe("VERIFY handleWarpToLandmark — same-room warp", () => {
  it("lands the walker on the landmark's tile and sends Teleported", async () => {
    const room = await createLandmarkRoom();
    try {
      const walker = join(room, "walker");
      warp(room, walker, "landmark-open");

      const player = room.state.players.get(walker.sessionId);
      assert.ok(player);
      assert.equal(player.tileX, OPEN_TILE.tileX);
      assert.equal(player.tileY, OPEN_TILE.tileY);

      const teleports = sentOfType<Teleported>(walker, ServerMessage.Teleported);
      assert.equal(teleports.length, 1);
      assert.deepEqual(
        { tileX: teleports[0]?.tileX, tileY: teleports[0]?.tileY },
        { tileX: OPEN_TILE.tileX, tileY: OPEN_TILE.tileY },
      );
    } finally {
      dispose(room);
    }
  });

  it("ignores an id this room does not own, without moving the player or consuming the cooldown", async () => {
    const room = await createLandmarkRoom();
    try {
      const walker = join(room, "walker");
      const before = room.state.players.get(walker.sessionId);
      assert.ok(before);
      const startTile = { tileX: before.tileX, tileY: before.tileY };

      warp(room, walker, "landmark-does-not-exist");

      const after = room.state.players.get(walker.sessionId);
      assert.ok(after);
      assert.deepEqual({ tileX: after.tileX, tileY: after.tileY }, startTile);
      assert.equal(sentOfType<Teleported>(walker, ServerMessage.Teleported).length, 0);

      // The cooldown was not spent on the ignored request, so an immediate real warp still works.
      warp(room, walker, "landmark-open");
      assert.equal(sentOfType<Teleported>(walker, ServerMessage.Teleported).length, 1);
    } finally {
      dispose(room);
    }
  });

  it("shares its cooldown with return-home: a second warp right behind the first is dropped in silence", async () => {
    const room = await createLandmarkRoom();
    try {
      const walker = join(room, "walker");
      warp(room, walker, "landmark-open");
      assert.equal(sentOfType<Teleported>(walker, ServerMessage.Teleported).length, 1);

      // No time has meaningfully passed since the first warp — well inside HOME_COOLDOWN_MS.
      warp(room, walker, "landmark-gated");
      assert.equal(
        sentOfType<Teleported>(walker, ServerMessage.Teleported).length,
        1,
        "the second warp must be dropped, not queued or applied",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY onJoin arriveAtLandmark — cross-room join", () => {
  it("lands a fresh join on an ungated landmark's tile with no store configured", async () => {
    const room = await createLandmarkRoom();
    try {
      const { client, error } = await tryJoin(room, "arriving", { arriveAtLandmark: "landmark-open" });
      assert.equal(error, null);
      const player = room.state.players.get(client.sessionId);
      assert.ok(player);
      assert.equal(player.tileX, OPEN_TILE.tileX);
      assert.equal(player.tileY, OPEN_TILE.tileY);
    } finally {
      dispose(room);
    }
  });

  it("falls back to the plain spawn for a landmark id this room does not own, rather than refusing the join", async () => {
    const room = await createLandmarkRoom();
    try {
      const { client, error } = await tryJoin(room, "arriving", { arriveAtLandmark: "landmark-elsewhere" });
      assert.equal(error, null);
      const player = room.state.players.get(client.sessionId);
      assert.ok(player);
      assert.equal(player.tileX, ROOM_OPTIONS.spawn.tileX);
      assert.equal(player.tileY, ROOM_OPTIONS.spawn.tileY);
    } finally {
      dispose(room);
    }
  });

  it("refuses the whole join for a gated landmark when the account does not hold the item", async () => {
    const store = new InMemoryInventoryStore();
    const room = await createLandmarkRoom(store);
    try {
      const { client, error } = await tryJoin(
        room,
        "arriving",
        { arriveAtLandmark: "landmark-gated" },
        "sso-landmark-1",
      );
      assert.ok(error, "join must be refused");
      assert.match(error!.message, /landmark "landmark-gated" requires item "entry-pass"/);
      assert.equal(room.state.players.get(client.sessionId), undefined, "a refused join must add no player");
    } finally {
      dispose(room);
    }
  });

  it("fails closed (denies) for a gated landmark when no inventory store is configured at all", async () => {
    const room = await createLandmarkRoom(undefined);
    try {
      const { client, error } = await tryJoin(
        room,
        "arriving",
        { arriveAtLandmark: "landmark-gated" },
        "sso-landmark-2",
      );
      assert.ok(error, "an unconfigured store can prove nothing is owned, so the join must be denied");
      assert.equal(room.state.players.get(client.sessionId), undefined);
    } finally {
      dispose(room);
    }
  });

  it("admits a gated landmark join once the account holds the required item", async () => {
    const store = new InMemoryInventoryStore();
    await store.grantOnce("sso-landmark-3", "entry-pass");
    const room = await createLandmarkRoom(store);
    try {
      const { client, error } = await tryJoin(
        room,
        "arriving",
        { arriveAtLandmark: "landmark-gated" },
        "sso-landmark-3",
      );
      assert.equal(error, null);
      const player = room.state.players.get(client.sessionId);
      assert.ok(player);
      assert.equal(player.tileX, GATED_TILE.tileX);
      assert.equal(player.tileY, GATED_TILE.tileY);
    } finally {
      dispose(room);
    }
  });
});
