import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import {
  ClientMessage,
  Direction,
  MAX_MOVES_PER_SECOND,
  ServerMessage,
  type MoveRejected,
  type RoomState,
} from "@zep-test/shared";
import { ROOM_DEFINITIONS } from "./definitions";
import { createGameServer, resolvePort, DEFAULT_PORT } from "../server";

/**
 * The joined client decodes the initial state asynchronously, and a StateView-filtered
 * client receives no further patches while nothing in its view changes — so polling the
 * decoded state is the reliable wait here, not `waitForNextPatch()`.
 */
async function waitFor<T>(probe: () => T | undefined | null, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const definition = ROOM_DEFINITIONS[0];

/** Colyseus `CloseCode.WITH_ERROR`, which is not exported from the package root. */
const CLOSE_CODE_WITH_ERROR = 4002;

describe("MetaverseRoom — smoke test", () => {
  let testServer: ColyseusTestServer;

  before(async () => {
    testServer = await boot(createGameServer());
  });

  after(async () => {
    await testServer.shutdown();
  });

  it("boots the room registered in the definition table", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    assert.equal(room.state.roomType, definition.roomType);
    assert.equal(room.state.mapKey, definition.mapKey);
    assert.equal(room.maxClients, definition.maxClients);
    await testServer.cleanup();
  });

  it("spawns a joining client at the configured spawn tile", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    const client = await testServer.connectTo(room, { nickname: "tester", avatarSkin: 3 });

    const self = await waitFor(
      () => client.state.players?.get(client.sessionId),
      "the client's own player entry",
    );
    assert.equal(self.nickname, "tester");
    assert.equal(self.avatarSkin, 3);
    assert.equal(self.tileX, definition.spawn.tileX);
    assert.equal(self.tileY, definition.spawn.tileY);
    assert.equal(self.facing, Direction.Down);

    await testServer.cleanup();
  });

  it("trims the nickname and falls back to skin 0 for an out-of-range value", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    const client = await testServer.connectTo(room, { nickname: "  padded  ", avatarSkin: 99 });

    const self = await waitFor(
      () => client.state.players?.get(client.sessionId),
      "the client's own player entry",
    );
    assert.equal(self.nickname, "padded");
    assert.equal(self.avatarSkin, 0);

    await testServer.cleanup();
  });

  it("refuses a join with a blank nickname", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    await assert.rejects(testServer.connectTo(room, { nickname: "   ", avatarSkin: 0 }));
    await testServer.cleanup();
  });

  it("sends one MoveRejected for a throttled burst, not one per dropped move", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    const client = await testServer.connectTo(room, { nickname: "burst", avatarSkin: 0 });
    await waitFor(() => client.state.players?.get(client.sessionId), "the player entry");

    const rejections: MoveRejected[] = [];
    client.onMessage(ServerMessage.MoveRejected, (payload: MoveRejected) => {
      rejections.push(payload);
    });

    // Up from the spawn tile is walkable, so the first move is accepted on its merits
    // and every rejection below comes from the rate limit rather than a collision.
    const burst = 10;
    for (let i = 0; i < burst; i++) {
      client.send(ClientMessage.Move, { dir: Direction.Up });
    }

    const self = await waitFor(
      () => client.state.players?.get(client.sessionId),
      "the player entry",
    );
    await waitFor(() => (rejections.length > 0 ? true : undefined), "a throttle notice");
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(rejections.length, 1, `expected 1 notice for ${burst} moves`);
    assert.equal(self.tileY, definition.spawn.tileY - 1, "exactly one move should be accepted");
    const [rejection] = rejections;
    assert.ok(rejection);
    assert.equal(rejection.tileX, self.tileX);
    assert.equal(rejection.tileY, self.tileY);
    assert.equal(rejection.facing, Direction.Up);

    await testServer.cleanup();
  });

  it("notifies again once the client has moved between bursts", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    const client = await testServer.connectTo(room, { nickname: "twoBursts", avatarSkin: 0 });
    await waitFor(() => client.state.players?.get(client.sessionId), "the player entry");

    const rejections: MoveRejected[] = [];
    client.onMessage(ServerMessage.MoveRejected, (payload: MoveRejected) => {
      rejections.push(payload);
    });

    client.send(ClientMessage.Move, { dir: Direction.Up });
    client.send(ClientMessage.Move, { dir: Direction.Up });
    await waitFor(() => (rejections.length === 1 ? true : undefined), "the first throttle notice");

    // Past the throttle window: the next move is accepted, which re-arms the notice.
    await new Promise((resolve) => setTimeout(resolve, 1000 / MAX_MOVES_PER_SECOND + 40));
    client.send(ClientMessage.Move, { dir: Direction.Up });
    client.send(ClientMessage.Move, { dir: Direction.Up });
    await waitFor(() => (rejections.length === 2 ? true : undefined), "the second throttle notice");

    await testServer.cleanup();
  });

  it("disconnects a client that blows past the hard message cap", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    const client = await testServer.connectTo(room, { nickname: "spammer", avatarSkin: 0 });
    await waitFor(() => client.state.players?.get(client.sessionId), "the player entry");

    client.onMessage(ServerMessage.MoveRejected, () => {});
    const left = new Promise<number>((resolve) => {
      client.onLeave((code: number) => resolve(code));
    });

    for (let i = 0; i < 200; i++) {
      client.send(ClientMessage.Move, { dir: Direction.Up });
    }

    const code = await Promise.race([
      left,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("client was not disconnected")), 5000),
      ),
    ]);
    assert.equal(code, CLOSE_CODE_WITH_ERROR);
    await waitFor(
      () => (room.state.players.size === 0 ? true : undefined),
      "the spammer to be removed from state",
    );

    await testServer.cleanup();
  });

  it("keeps a client moving at the allowed rate connected", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    const client = await testServer.connectTo(room, { nickname: "wellBehaved", avatarSkin: 0 });
    await waitFor(() => client.state.players?.get(client.sessionId), "the player entry");

    client.onMessage(ServerMessage.MoveRejected, () => {});
    let closeCode: number | undefined;
    client.onLeave((code: number) => {
      closeCode = code;
    });

    // Spans more than a second, so it also proves the cap's per-second counter resets.
    const directions = [Direction.Up, Direction.Down];
    for (let i = 0; i < 30; i++) {
      client.send(ClientMessage.Move, { dir: directions[i % 2] ?? Direction.Up });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(closeCode, undefined, "a client within the limits must stay connected");
    assert.equal(room.state.players.size, 1);

    await testServer.cleanup();
  });

  it("drops a leaving player from the room state", async () => {
    assert.ok(definition);
    const room = await testServer.createRoom<RoomState>(definition.name, {});
    const client = await testServer.connectTo(room, { nickname: "leaver", avatarSkin: 0 });
    await waitFor(() => client.state.players?.get(client.sessionId), "the player entry");
    assert.equal(room.state.players.size, 1);

    await client.leave();
    await waitFor(() => (room.state.players.size === 0 ? true : undefined), "the player to be removed");

    await testServer.cleanup();
  });
});

describe("resolvePort", () => {
  it("falls back to the default for missing or unusable values", () => {
    for (const value of [undefined, "", "abc", "0", "-1", "70000"]) {
      assert.equal(resolvePort(value), DEFAULT_PORT, `PORT=${String(value)}`);
    }
  });

  it("accepts a valid port", () => {
    assert.equal(resolvePort("3000"), 3000);
  });
});
