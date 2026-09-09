import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import { matchMaker } from "colyseus";
import type { RoomState } from "@zep-test/shared";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";

/**
 * Guardian audit of Phase I's new `RoomCreateOptions.realCapacity` (design-phase-i-boss-monster.md
 * §1.2), which `onJoin` enforces the join cap from.
 *
 * `onCreate` does not receive the handler's options — it receives
 * `merge({}, clientOptions, handler.options)` (`MatchMaker.createRoom`), and `merge` copies only
 * the keys the handler object actually *has*. Every other field of `RoomCreateOptions` is present
 * in every `ROOM_DEFINITIONS` row (or named explicitly at the `define()` call, which is why the
 * store fields are safe), so this is the first optional one — and a row that omits it leaves the
 * room-creating client's own `realCapacity` standing. That client is any authenticated user.
 *
 * node:test runs each file in its own process and every listening suite needs its own port;
 * 2567-2595 odd are taken, so this file takes 2597.
 */
const PORT = 2597;

const GRAND_PLAZA = "grand-plaza";
const HUNTING_DEN = "hunting-den";

interface ClientRoom {
  readonly sessionId: string;
  leave(consented?: boolean): Promise<number>;
}

let testServer: ColyseusTestServer;

function definitionOf(name: string) {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  return definition;
}

async function join(roomName: string, options: Record<string, unknown>): Promise<ClientRoom> {
  return (await testServer.sdk.joinOrCreate(roomName, options)) as unknown as ClientRoom;
}

before(async () => {
  const gameServer = createGameServer();
  await gameServer.listen(PORT);
  testServer = new ColyseusTestServer(gameServer);
});

after(async () => {
  await testServer.shutdown();
});

afterEach(async () => {
  await testServer.cleanup();
});

describe("GUARDIAN — the join cap is the server's number, never the creating client's", () => {
  it("ignores a realCapacity smuggled in the join options of the client that creates the room", async () => {
    assert.equal(
      definitionOf(GRAND_PLAZA).realCapacity,
      undefined,
      "precondition: this is a row that omits realCapacity, which is what exposes the merge",
    );

    // The room instance is created by *this* join, so these options are what `onCreate` merges.
    const attacker = await join(GRAND_PLAZA, {
      nickname: "attacker",
      avatarSkin: 0,
      realCapacity: 1,
    });
    assert.ok(attacker.sessionId);

    const rooms = await matchMaker.query({ name: GRAND_PLAZA });
    assert.equal(rooms.length, 1, "precondition: one instance, and the attacker is holding it");

    // maxClients (500) is nowhere near reached, so the matchmaker sees a room with room to spare
    // and will not open a second instance for this client: a refusal here locks every other user
    // out of the main room for as long as the attacker stays connected.
    const victim = await join(GRAND_PLAZA, { nickname: "victim", avatarSkin: 0 });
    assert.ok(victim.sessionId, "a second user must still be able to enter grand-plaza");

    const room = testServer.getRoomById(rooms[0]?.roomId ?? "") as unknown as {
      state: RoomState;
    };
    assert.equal(room.state.players.size, 2, "both are in the same instance");
  });

  it("keeps a hunting room's own cap authoritative against the same smuggled option", async () => {
    const den = definitionOf(HUNTING_DEN);
    assert.ok(den.realCapacity !== undefined && den.realCapacity > 1);

    const attacker = await join(HUNTING_DEN, {
      nickname: "attacker",
      avatarSkin: 0,
      realCapacity: 1,
    });
    assert.ok(attacker.sessionId);
    const second = await join(HUNTING_DEN, { nickname: "hunter", avatarSkin: 0 });
    assert.ok(second.sessionId, "hunting-den's authored cap is 20, not the 1 the client asked for");
  });

  it("does not let a run of refused joins lock the room into a second instance", async () => {
    // The other half of design §1.2: `onJoin` now refuses the joins `maxClients` used to, so a
    // refused join must not leave a seat (or a client entry) behind — 500 of those accumulating
    // would lock the room and hand the next arrival a second instance, which is a second boss on
    // its own 6-hour timer. Colyseus deletes both on the way out (`Room#_onLeave`); this is the
    // assertion that says so from the outside.
    const cap = definitionOf(HUNTING_DEN).realCapacity;
    assert.ok(cap !== undefined);
    const seated: ClientRoom[] = [];
    for (let index = 0; index < cap; index++) {
      seated.push(await join(HUNTING_DEN, { nickname: `hunter-${index}`, avatarSkin: 0 }));
    }

    for (let attempt = 0; attempt < 25; attempt++) {
      await assert.rejects(() => join(HUNTING_DEN, { nickname: `flood-${attempt}`, avatarSkin: 0 }));
    }

    const rooms = await matchMaker.query({ name: HUNTING_DEN });
    assert.equal(rooms.length, 1, "25 refusals must not have opened a second hunting-den");
    assert.equal(rooms[0]?.locked ?? true, false, "nor left the one instance locked");
    const room = testServer.getRoomById(rooms[0]?.roomId ?? "") as unknown as {
      clients: { length: number };
      state: RoomState;
    };
    assert.equal(room.state.players.size, cap, "the refused joins took no seats");
    assert.equal(room.clients.length, cap, "and left no client entries behind either");
  });

  it("cannot widen a hunting room's cap either", async () => {
    const den = definitionOf(HUNTING_DEN);
    assert.ok(den.realCapacity !== undefined);

    await join(HUNTING_DEN, {
      nickname: "attacker",
      avatarSkin: 0,
      realCapacity: den.maxClients,
    });
    const rooms = await matchMaker.query({ name: HUNTING_DEN });
    const room = testServer.getRoomById(rooms[0]?.roomId ?? "") as unknown as {
      realCapacity: number;
    };
    assert.equal(
      room.realCapacity,
      den.realCapacity,
      "a widened cap would put more players than PoC #3 measured on one monster simulation",
    );
  });
});
