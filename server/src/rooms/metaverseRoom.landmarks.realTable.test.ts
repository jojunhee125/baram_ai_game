import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JoinOptions } from "@zep-test/shared";
import { InMemoryInventoryStore, type InventoryStore } from "../db/inventoryStore";
import { TableLandmarkIndex } from "../game/landmarks";
import type { LandmarkIndex, RoomCreateOptions, SpawnArea } from "./contracts";
import { ROOM_DEFINITIONS } from "./definitions";
import { LANDMARK_DEFINITIONS } from "./landmarkDefinitions";
import { MetaverseRoom } from "./metaverseRoom";

/**
 * Pass T deep verification for Phase M, item 4 (golden path (f)) and item 5 — but against the
 * *real* production `LANDMARK_DEFINITIONS` table (`server/src/rooms/landmarkDefinitions.ts`)
 * rather than the synthetic verify table Pass S's own `metaverseRoom.landmarks.test.ts` uses.
 *
 * Pass S's suite already proves the mechanism works against a table it wrote for the purpose;
 * this file proves the actual shipped `landmark-hunting-den` row (id, room, tile, requiresItemKey)
 * still behaves correctly, so a future edit to the real table that drops/renames the gate would
 * fail here even if the synthetic table were never touched.
 *
 * Same private-method-access harness as `entryPass-verification.test.ts`'s `GatedRoom`: a
 * `createLandmarkIndex` override forces a room name regardless of `this.roomName`, since this
 * harness never goes through the matchmaker.
 */

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: { lastWarpAt: number };
}

function fakeClient(sessionId: string, ssoUserId: string | null): FakeClient {
  return {
    sessionId,
    auth: { ssoNickname: null, ssoUserId },
    send: () => {},
  } as FakeClient;
}

function asRoomClient(client: FakeClient): RoomClient {
  return client as unknown as RoomClient;
}

const huntingDenDefinition = ROOM_DEFINITIONS.find((room) => room.name === "hunting-den");
assert.ok(huntingDenDefinition, "ROOM_DEFINITIONS has no \"hunting-den\" row");

const realHuntingDenRow = LANDMARK_DEFINITIONS.find((landmark) => landmark.id === "landmark-hunting-den");
assert.ok(realHuntingDenRow, "the real landmark table has no \"landmark-hunting-den\" row");
assert.ok(realHuntingDenRow.tile, "landmark-hunting-den must author a fixed tile, not fall back to home");
assert.equal(
  realHuntingDenRow.requiresItemKey,
  "entry-pass",
  "precondition: this suite exists specifically to verify the entry-pass gate on this row",
);

const ROOM_OPTIONS: RoomCreateOptions = {
  ...huntingDenDefinition,
  roomType: "landmark-real-table-verify",
};

/** Forces the landmark index's room name to "hunting-den" so it resolves rows from the real table. */
class RealLandmarkHuntingDenRoom extends MetaverseRoom {
  protected override createLandmarkIndex(home: SpawnArea): LandmarkIndex {
    return new TableLandmarkIndex("hunting-den", LANDMARK_DEFINITIONS, home);
  }
}

async function createRoom(store?: InventoryStore): Promise<RealLandmarkHuntingDenRoom> {
  const room = new RealLandmarkHuntingDenRoom();
  await room.onCreate({ ...ROOM_OPTIONS, inventoryStore: store });
  return room;
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

async function tryJoin(
  room: MetaverseRoom,
  sessionId: string,
  options: Partial<JoinOptions>,
  ssoUserId: string | null,
): Promise<{ client: FakeClient; error: Error | null }> {
  const client = fakeClient(sessionId, ssoUserId);
  try {
    await room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
    return { client, error: null };
  } catch (error) {
    return { client, error: error as Error };
  }
}

describe("MetaverseRoom — onJoin arriveAtLandmark against the real production landmark-hunting-den row (Pass T)", () => {
  it("refuses the join when the account holds no entry-pass", async () => {
    const store = new InMemoryInventoryStore();
    const room = await createRoom(store);
    try {
      const { client, error } = await tryJoin(
        room,
        "arriving",
        { arriveAtLandmark: "landmark-hunting-den" },
        "sso-real-table-1",
      );
      assert.ok(error, "join must be refused");
      assert.match(error!.message, /landmark "landmark-hunting-den" requires item "entry-pass"/);
      assert.equal(room.state.players.get(client.sessionId), undefined, "a refused join must add no player");
      assert.equal(room.clients.length, 0, "a refused join must leave no connected client behind either");
    } finally {
      dispose(room);
    }
  });

  it("fails closed when no inventory store is configured at all", async () => {
    const room = await createRoom(undefined);
    try {
      const { client, error } = await tryJoin(
        room,
        "arriving",
        { arriveAtLandmark: "landmark-hunting-den" },
        "sso-real-table-2",
      );
      assert.ok(error, "an unconfigured store can prove nothing is owned, so the join must be denied");
      assert.equal(room.state.players.get(client.sessionId), undefined);
    } finally {
      dispose(room);
    }
  });

  it("admits the join and lands exactly on the real landmark-hunting-den tile once the account holds an entry-pass", async () => {
    const store = new InMemoryInventoryStore();
    await store.grantOnce("sso-real-table-3", "entry-pass");
    const room = await createRoom(store);
    try {
      const { client, error } = await tryJoin(
        room,
        "arriving",
        { arriveAtLandmark: "landmark-hunting-den" },
        "sso-real-table-3",
      );
      assert.equal(error, null);
      const player = room.state.players.get(client.sessionId);
      assert.ok(player);
      assert.equal(player.tileX, realHuntingDenRow.tile!.tileX);
      assert.equal(player.tileY, realHuntingDenRow.tile!.tileY);
    } finally {
      dispose(room);
    }
  });

  it("the boot table's tile is a walkable tile of the real hunting-den map (precondition for the test above)", async () => {
    const room = await createRoom();
    try {
      const map = room["collisionMap"];
      assert.equal(
        map.isWalkable(realHuntingDenRow.tile!.tileX, realHuntingDenRow.tile!.tileY),
        true,
        "if this ever fails, the success test above would be landing players on a wall",
      );
    } finally {
      dispose(room);
    }
  });
});
