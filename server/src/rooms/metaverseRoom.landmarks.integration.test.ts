import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import type { RoomState } from "@zep-test/shared";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";
import { LANDMARK_DEFINITIONS } from "./landmarkDefinitions";

/**
 * Pass T deep verification for Phase M, item 4's `onJoin` matrix — but through the real matchmaker
 * (`createGameServer` + `ColyseusTestServer`), not the private-method-access harness the rest of
 * this phase's suites use. Two things only a real join can prove:
 *
 * 1. `landmark-plaza`/`landmark-grand-plaza` land exactly on that room's own `this.home`, with no
 *    coordinate drift, even though `grand-plaza`'s *plain* join spreads over a radius-70 area —
 *    proving the "tile: undefined falls back to home" design actually reaches production wiring,
 *    not just the synthetic tables other suites author by hand.
 * 2. What Colyseus does with a room whose `onJoin` throws (the `landmark-hunting-den` gate, no
 *    entry-pass): the private harness can only prove no player object was added to
 *    `state.players`, because it calls `room.onJoin` directly and never goes through Colyseus's own
 *    client-connection lifecycle. This file drives an actual rejected `connectTo` and inspects
 *    `room.clients` (Colyseus's own connected-client list) to prove the room is left with no
 *    leaked connection, and that the room keeps working for the next, legitimate join.
 *
 * 2585 / 2587 / 2589 / 2591 belong to other suites; node:test runs files in parallel processes.
 */
const PORT = 2593;

function roomDefinition(name: string) {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  return definition;
}

function landmarkRow(id: string) {
  const row = LANDMARK_DEFINITIONS.find((candidate) => candidate.id === id);
  assert.ok(row, `LANDMARK_DEFINITIONS has no "${id}" row`);
  return row;
}

const plaza = roomDefinition("plaza");
const grandPlaza = roomDefinition("grand-plaza");
const huntingGround = roomDefinition("hunting-ground");
const huntingDen = roomDefinition("hunting-den");

const plazaLandmark = landmarkRow("landmark-plaza");
const grandPlazaLandmark = landmarkRow("landmark-grand-plaza");
const huntingGroundLandmark = landmarkRow("landmark-hunting-ground");
const huntingDenLandmark = landmarkRow("landmark-hunting-den");

assert.equal(plazaLandmark.tile, undefined, "precondition: landmark-plaza resolves via this room's home, not an authored tile");
assert.equal(grandPlazaLandmark.tile, undefined, "precondition: landmark-grand-plaza resolves via this room's home too");
assert.ok(huntingGroundLandmark.tile, "precondition: landmark-hunting-ground authors a fixed tile");
assert.ok(huntingDenLandmark.tile, "precondition: landmark-hunting-den authors a fixed tile");
assert.equal(huntingDenLandmark.requiresItemKey, "entry-pass", "precondition: this is the gated row under test");

type AnyRoom = Awaited<ReturnType<ColyseusTestServer["createRoom"]>> & { state: RoomState };

let testServer: ColyseusTestServer;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
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

before(async () => {
  // Local-dev default: no inventory store configured at all, so the gated landmark below also
  // exercises `holdsItem`'s fail-closed branch (design §2.4/Pass T item 5) with the real wiring.
  const gameServer = createGameServer();
  await gameServer.listen(PORT);
  testServer = new ColyseusTestServer(gameServer);
});

after(async () => {
  await testServer.shutdown();
});

describe("MetaverseRoom — onJoin arriveAtLandmark through the real matchmaker (Pass T)", () => {
  it("lands a fresh join on plaza's own home tile via landmark-plaza, with no coordinate drift", async () => {
    const room = (await testServer.createRoom<RoomState>("plaza", {})) as AnyRoom;
    const client = await testServer.connectTo(room, {
      nickname: "visitor",
      avatarSkin: 0,
      arriveAtLandmark: "landmark-plaza",
    });
    const player = room.state.players.get(client.sessionId);
    assert.ok(player);
    assert.equal(player.tileX, plaza.spawn.tileX);
    assert.equal(player.tileY, plaza.spawn.tileY);
  });

  it("lands a fresh join exactly on grand-plaza's home tile via landmark-grand-plaza, despite the room's own huge spawn spread", async () => {
    assert.ok(
      grandPlaza.spawn.spreadRadiusInTiles > 0,
      "precondition: a plain join to this room would scatter, or the contrast below proves nothing",
    );
    const room = (await testServer.createRoom<RoomState>("grand-plaza", {})) as AnyRoom;
    const client = await testServer.connectTo(room, {
      nickname: "visitor",
      avatarSkin: 0,
      arriveAtLandmark: "landmark-grand-plaza",
    });
    const player = room.state.players.get(client.sessionId);
    assert.ok(player);
    assert.equal(player.tileX, grandPlaza.spawn.tileX);
    assert.equal(player.tileY, grandPlaza.spawn.tileY);
  });

  it("lands a fresh join on the fixed, ungated landmark-hunting-ground tile", async () => {
    const room = (await testServer.createRoom<RoomState>("hunting-ground", {})) as AnyRoom;
    const client = await testServer.connectTo(room, {
      nickname: "visitor",
      avatarSkin: 0,
      arriveAtLandmark: "landmark-hunting-ground",
    });
    const player = room.state.players.get(client.sessionId);
    assert.ok(player);
    assert.equal(player.tileX, huntingGroundLandmark.tile!.tileX);
    assert.equal(player.tileY, huntingGroundLandmark.tile!.tileY);
    void huntingGround;
  });

  it("refuses the join for the room's very first client and leaves no unreachable room behind", async () => {
    // Colyseus auto-disposes a room that has never seated a single successful client — discovered
    // by this suite: a first attempt straight into `createRoom` reproducibly throws inside
    // `_onJoin`, then the very next `connectTo` against the same room handle fails with
    // `MatchMakeError: room "<id>" not found`, because the room tore itself down as "empty" the
    // moment the only pending join failed. Not a Phase M leak — the opposite, a clean teardown —
    // but it means "no leak" for a first-client refusal has to be phrased as "the room disposes
    // itself cleanly", which this test asserts directly instead of asserting on a room handle that
    // may no longer resolve.
    const room = (await testServer.createRoom<RoomState>("hunting-den", {})) as AnyRoom;

    await assert.rejects(
      testServer.connectTo(room, {
        nickname: "no-pass",
        avatarSkin: 0,
        arriveAtLandmark: "landmark-hunting-den",
      }),
    );

    await assert.rejects(
      testServer.connectTo(room, { nickname: "probe", avatarSkin: 0 }),
      /room .* not found/,
      "the room must have disposed itself cleanly rather than lingering half-initialized",
    );
  });

  it("refuses one client's gated join without disturbing an already-seated client or the room's ability to accept more", async () => {
    const room = (await testServer.createRoom<RoomState>("hunting-den", {})) as AnyRoom;
    // Keeps the room alive through the rejection below, so this test can inspect the room's live
    // state afterwards instead of racing Colyseus's auto-dispose of an empty room.
    const anchor = await testServer.connectTo(room, { nickname: "anchor", avatarSkin: 0 });
    await waitUntil(() => room.state.players.size === 1, "the anchor to seat first");

    await assert.rejects(
      testServer.connectTo(room, {
        nickname: "no-pass",
        avatarSkin: 0,
        arriveAtLandmark: "landmark-hunting-den",
      }),
    );

    // Colyseus's own connected-client bookkeeping, not just this room's application state — a
    // half-torn-down client here would be invisible to a check that only reads `state.players`.
    await waitUntil(() => room.clients.length === 1, "the refused connection to leave no client behind");
    assert.equal(room.state.players.size, 1, "the refused join must add no player either");
    assert.ok(room.state.players.get(anchor.sessionId), "the already-seated client must be untouched");

    // The room itself must not be left corrupted by the throw: a normal join right after it
    // succeeds exactly as if the failed attempt never happened.
    const survivor = await testServer.connectTo(room, { nickname: "survivor", avatarSkin: 0 });
    await waitUntil(() => room.state.players.size === 2, "the next, legitimate join to succeed");
    assert.ok(room.state.players.get(survivor.sessionId));
    void huntingDen;
  });
});
