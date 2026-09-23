import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import { matchMaker } from "colyseus";
import type { RoomState } from "@zep-test/shared";
import { createLegacyGameServer as createGameServer } from "./__fixtures__/legacyBoss";
import { ROOM_DEFINITIONS } from "./__fixtures__/legacyBoss";
import { MonsterKind } from "./monsterDefinitions";

/**
 * Phase I Pass T5 (`docs/design-phase-i-boss-monster.md` §1.2, §8 T5) through the real
 * matchmaker, which is the only place the claim being made can be checked: "one boss per zone"
 * rests on `joinOrCreate` never opening a second instance of a hunting room, and that is a fact
 * about `maxClients` and the matchmaker rather than about `onJoin`. The unit-level cap tests live
 * in `passI-boss-verification.test.ts`; this file pays for a listening server to prove the two
 * halves — a refused 21st join *and* still exactly one room — actually meet.
 *
 * node:test runs each file in its own process and every listening suite needs a port no other
 * file binds. 2567 / 2571 / 2573 / 2575 / 2577 / 2579 / 2581 / 2583 / 2585 / 2587 / 2589 / 2591 /
 * 2593 are taken, so this file takes 2595.
 */
const PORT = 2595;

const HUNTING_DEN = "hunting-den";
const HUNTING_GROUND = "hunting-ground";

function roomDefinition(name: string) {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  return definition;
}

interface ClientRoom {
  readonly sessionId: string;
  leave(consented?: boolean): Promise<number>;
}

let testServer: ColyseusTestServer;

/** The server-side room instance behind a matchmaker query result. */
function serverRoom(roomId: string): { maxClients: number; state: RoomState } {
  return testServer.getRoomById(roomId) as unknown as { maxClients: number; state: RoomState };
}

async function joinDen(nickname: string): Promise<ClientRoom> {
  return (await testServer.sdk.joinOrCreate(HUNTING_DEN, {
    nickname,
    avatarSkin: 0,
  })) as unknown as ClientRoom;
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

describe("Phase I §1.2 — the hunting rooms' real cap, through the matchmaker", () => {
  it("admits exactly realCapacity clients and opens no second instance for the one it refuses", async () => {
    const den = roomDefinition(HUNTING_DEN);
    const cap = den.realCapacity;
    assert.ok(cap !== undefined, "precondition: the den's real cap is what is being enforced");
    assert.ok(cap < den.maxClients, "precondition: maxClients is deliberately out of reach");

    const clients: ClientRoom[] = [];
    for (let index = 0; index < cap; index++) {
      clients.push(await joinDen(`hunter-${index}`));
    }
    assert.equal(clients.length, cap);

    const before = await matchMaker.query({ name: HUNTING_DEN });
    assert.equal(before.length, 1, "every one of them landed in the same instance");

    await assert.rejects(
      () => joinDen("one-too-many"),
      (error: unknown) => {
        assert.match(String((error as { message?: string }).message ?? error), /is full/);
        return true;
      },
      "the join past the cap is refused, not routed elsewhere",
    );

    const after = await matchMaker.query({ name: HUNTING_DEN });
    assert.equal(
      after.length,
      1,
      "a second instance would mean a second boss on its own 6-hour timer (design §1.1)",
    );
    const room = serverRoom(after[0]?.roomId ?? "");
    assert.equal(room.maxClients, den.maxClients, "matchmaking still sees a room with room to spare");
    assert.equal(room.state.players.size, cap, "and the refused client left no seat behind");
  });

  it("frees a seat on leave, so the cap is a live count and not a high-water mark", async () => {
    const cap = roomDefinition(HUNTING_DEN).realCapacity;
    assert.ok(cap !== undefined);
    const clients: ClientRoom[] = [];
    for (let index = 0; index < cap; index++) {
      clients.push(await joinDen(`hunter-${index}`));
    }
    const leaving = clients[0];
    assert.ok(leaving);
    await leaving.leave();

    const rooms = await matchMaker.query({ name: HUNTING_DEN });
    const room = serverRoom(rooms[0]?.roomId ?? "");
    const deadline = Date.now() + 5000;
    while (room.state.players.size === cap && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(room.state.players.size, cap - 1, "the leave was seen");

    const replacement = await joinDen("replacement");
    assert.ok(replacement.sessionId);
    assert.equal((await matchMaker.query({ name: HUNTING_DEN })).length, 1);
  });

  it("puts the real boss row on the map of a room the matchmaker built", async () => {
    // End to end with the real table, the real map file and no store wired: every boss starts
    // alive, which is `RoomCreateOptions.bossStateStore`'s documented no-store behaviour.
    const room = (await testServer.createRoom<RoomState>(HUNTING_GROUND, {})) as unknown as {
      state: RoomState;
    };
    const boss = room.state.monsters.get("hg-boss-01");
    assert.ok(boss, "hg-boss-01 is missing from a freshly matched hunting-ground");
    assert.equal(boss.kind, MonsterKind.Boss);
    const spawn = roomDefinition(HUNTING_GROUND).spawn;
    assert.ok(
      Math.max(Math.abs(boss.tileX - spawn.tileX), Math.abs(boss.tileY - spawn.tileY)) >= 6,
      "a boss within 6 tiles of the arrival would greet every visitor at the door",
    );
  });
});
