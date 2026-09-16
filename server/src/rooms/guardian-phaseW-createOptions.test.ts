import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import { matchMaker } from "colyseus";
import { InMemoryProgressStore } from "../db/progressStore";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";
import type { MetaverseRoom } from "./metaverseRoom";

/**
 * Guardian audit of Phase W's new `RoomCreateOptions.progressStore`/`adminOwnerKeys`
 * (docs/design-phase-w-level-system.md §5, §11.0), following exactly `guardian-phaseI-
 * createOptions.test.ts`'s own reasoning for `realCapacity`: `onCreate` receives
 * `merge({}, clientOptions, handler.options)` (`MatchMaker.createRoom`), and `merge` copies only
 * the keys the handler object actually *has*. `server.ts`'s `gameServer.define()` call always
 * gives `handler.options` its own `progressStore`/`adminOwnerKeys` keys (even when the value
 * itself is `undefined` or the default empty `Set`), so a room-creating client's own join options
 * for those two keys are always discarded — but unlike `realCapacity`, nothing pinned this down as
 * a regression test before now: `guardian-phaseI-createOptions.test.ts` only ever asserts
 * `realCapacity`, so a future `define()` edit that drops or conditions the `progressStore`/
 * `adminOwnerKeys` shorthand properties would not fail any existing test.
 *
 * node:test runs each file in its own process and every listening suite needs its own port;
 * 2567-2597 odd are taken (see the sibling files' own port comments), so this file takes 2599.
 */
const PORT = 2599;
const GRAND_PLAZA = "grand-plaza";

interface ClientRoom {
  readonly sessionId: string;
  leave(consented?: boolean): Promise<number>;
}

let testServer: ColyseusTestServer;

/** The server's own, real config — never the values a join-time client supplies. */
const realProgressStore = new InMemoryProgressStore();
const realAdminOwnerKeys = new Set(["real-admin-only"]);

function definitionOf(name: string) {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  return definition;
}

async function join(roomName: string, options: Record<string, unknown>): Promise<ClientRoom> {
  return (await testServer.sdk.joinOrCreate(roomName, options)) as unknown as ClientRoom;
}

/** Lets a fire-and-forget store call (applyDeathExpPenalty) settle before assertions read it. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

before(async () => {
  const gameServer = createGameServer(
    undefined,
    undefined,
    undefined,
    realProgressStore,
    undefined,
    realAdminOwnerKeys,
  );
  await gameServer.listen(PORT);
  testServer = new ColyseusTestServer(gameServer);
});

after(async () => {
  await testServer.shutdown();
});

afterEach(async () => {
  await testServer.cleanup();
});

describe("GUARDIAN — progressStore/adminOwnerKeys are the server's own config, never the room-creating client's", () => {
  it("discards a forged '*' admin allowlist and a forged no-op store smuggled at room-creation time, and the death EXP penalty still lands for real", async () => {
    assert.equal(
      definitionOf(GRAND_PLAZA).realCapacity,
      undefined,
      "precondition: same row guardian-phaseI's own realCapacity exploit attempt used",
    );

    // The room instance is created by *this* join, so these are exactly the `clientOptions`
    // `merge({}, clientOptions, handler.options)` sees first — the strongest forgery a client can
    // attempt: an allowlist that claims to exempt everyone, and a store that would never actually
    // apply a cut even if it were consulted.
    const forgedAdminOwnerKeys = new Set(["*"]);
    let forgedStoreWasEverCalled = false;
    const forgedStore = {
      getExp: async () => {
        forgedStoreWasEverCalled = true;
        return 999_999;
      },
      grantExp: async (_owner: string, amount: number) => {
        forgedStoreWasEverCalled = true;
        return amount;
      },
      applyDeathPenalty: async () => {
        forgedStoreWasEverCalled = true;
        return 999_999; // never actually cuts anything
      },
    };

    const attacker = await join(GRAND_PLAZA, {
      nickname: "attacker",
      avatarSkin: 0,
      adminOwnerKeys: forgedAdminOwnerKeys,
      progressStore: forgedStore,
    });
    assert.ok(attacker.sessionId);

    const rooms = await matchMaker.query({ name: GRAND_PLAZA });
    assert.equal(rooms.length, 1, "precondition: one instance, and the attacker is holding it");
    const room = testServer.getRoomById(rooms[0]?.roomId ?? "") as unknown as MetaverseRoom;

    // Structural: the fields actually installed are the server's own objects, not the client's.
    assert.equal(room["progressStore"], realProgressStore, "the server's own store, not the client's forged one");
    assert.equal(room["adminOwnerKeys"], realAdminOwnerKeys, "the server's own allowlist, not the client's forged one");
    assert.equal(
      room["adminOwnerKeys"].has(attacker.sessionId),
      false,
      "the forged '*' allowlist never took effect — this session is not exempt",
    );

    // Behavioral: seed real EXP for this session under the *real* store (owner key falls back to
    // sessionId with no SSO wired in this test, metaverseRoom.ts's own convention) and force a
    // death directly — if either forgery had won, this account would keep all 1000 EXP (the forged
    // store never cuts, and the forged allowlist claims to exempt everyone).
    await realProgressStore.grantExp(attacker.sessionId, 1000);
    (room as unknown as { damagePlayer(sessionId: string, monsterId: string, damage: number, now: number): void })[
      "damagePlayer"
    ](attacker.sessionId, "guardian-test", 999_999, Date.now());
    await flush();

    assert.equal(forgedStoreWasEverCalled, false, "the forged store was never even consulted");
    const remaining = await realProgressStore.getExp(attacker.sessionId);
    assert.equal(remaining, 990, "the real store's own 1% cut landed — the forged store/allowlist had zero effect");
  });
});
