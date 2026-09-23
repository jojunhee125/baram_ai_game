import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import {
  AVATAR_SKIN_COUNT,
  CHAT_RADIUS_TILES,
  ClientMessage,
  Direction,
  HOME_COOLDOWN_MS,
  MAX_CHAT_LENGTH,
  MAX_CHATS_PER_SECOND,
  MAX_MOVES_PER_SECOND,
  MAX_NICKNAME_LENGTH,
  PATCH_RATE_MS,
  ServerMessage,
  VIEW_RADIUS_TILES,
  type ChatBroadcast,
  type MoveRejected,
  type Player,
  type PortalEntered,
  type RoomState,
  type Teleported,
} from "@zep-test/shared";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "./definitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";

/**
 * `boot()` from @colyseus/testing ignores its `port` argument when handed a `Server`
 * instance and always binds 2568 — which metaverseRoom.test.ts already owns. node:test
 * runs test files in parallel processes, so a second `boot()` would race for that port.
 * Listening explicitly on a private port is what keeps the two files independent.
 */
const INTEGRATION_PORT = 2571;

const [definition] = ROOM_DEFINITIONS;
if (definition === undefined) {
  throw new Error("ROOM_DEFINITIONS is empty; the integration suite has no room to join");
}
const plaza = definition;

/** The round trip through plaza: the door out of it, and the door back into it. */
const outbound = PORTAL_DEFINITIONS.find((portal) => portal.id === "plaza-south-door");
const inbound = PORTAL_DEFINITIONS.find((portal) => portal.id === "buyeo-novice-south-door");
const [firstDoorTile] = outbound?.from.tiles ?? [];
if (outbound === undefined || inbound === undefined || firstDoorTile === undefined) {
  throw new Error(`PORTAL_DEFINITIONS has no round trip through "${plaza.name}"`);
}
// Re-bound, like `plaza` above: a narrowed `const` does not stay narrowed inside the hoisted
// helper functions below, but a fresh declaration's own type does.
const outboundPortal = outbound;
const inboundPortal = inbound;
const doorTile = firstDoorTile;

const MOVE_INTERVAL_MS = 1000 / MAX_MOVES_PER_SECOND;
const CHAT_INTERVAL_MS = 1000 / MAX_CHATS_PER_SECOND;
/** Spacing that keeps consecutive requests clear of the server-side rate limiters. */
const MOVE_COOLDOWN_MS = MOVE_INTERVAL_MS + 15;
const CHAT_COOLDOWN_MS = CHAT_INTERVAL_MS + 30;
/** Long enough that a patch which was going to arrive has arrived. */
const SETTLE_MS = PATCH_RATE_MS * 4;
/**
 * The cadence the Phaser client actually sends at — `STEP_TWEEN_MS` in
 * client/src/world/playerSprites.ts. Mirrored here so the server's throttle is checked
 * against real input, not just against synthetic bursts.
 */
const CLIENT_STEP_INTERVAL_MS = PATCH_RATE_MS + 20;

/**
 * Row 20 of plaza.json is open across the whole interior, so all distance work happens along
 * it. It is also the spawn row, which is what lets `walkX` start from the spawn tile.
 */
const CORRIDOR_ROW = 20;
const CORRIDOR_MIN_X = 16;
const CORRIDOR_MAX_X = 47;

/**
 * 17 UTF-16 code units, so truncating at MAX_NICKNAME_LENGTH (16) cuts the last emoji in
 * half and leaves a lone high surrogate as the final code unit.
 */
const SURROGATE_SPLITTING_NICKNAME = `a${"\u{1F600}".repeat(8)}`;

/**
 * A high surrogate with no low surrogate after it, or a low surrogate with no high surrogate
 * before it. Matching the whole surrogate range instead would also flag well-formed pairs.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type PlazaRoom = Awaited<ReturnType<ColyseusTestServer["createRoom"]>> & { state: RoomState };

interface DecodedPlayers {
  get(sessionId: string): Player | undefined;
  readonly size: number;
  keys(): IterableIterator<string>;
}

/**
 * Only the surface these tests drive. The SDK's `Room` is generic over the whole room
 * type, and naming it here would drag that inference into every helper signature.
 */
interface ClientRoom {
  readonly sessionId: string;
  readonly state: { players?: DecodedPlayers } | undefined;
  send(type: string, payload?: unknown): void;
  onMessage(type: string, callback: (payload: unknown) => void): unknown;
  leave(consented?: boolean): Promise<number>;
}

interface Inbox {
  chats: ChatBroadcast[];
  rejects: MoveRejected[];
  portals: PortalEntered[];
  teleports: Teleported[];
}

let testServer: ColyseusTestServer;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
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

/** The client's own decoded copy of `state.players` — the only view that proves filtering works. */
function decoded(client: ClientRoom): DecodedPlayers | undefined {
  return client.state?.players;
}

function assertEmpty(received: readonly unknown[], label: string): void {
  assert.equal(received.length, 0, `${label}; received ${JSON.stringify(received)}`);
}

function seen(client: ClientRoom, sessionId: string): Player | undefined {
  return decoded(client)?.get(sessionId);
}

function seenIds(client: ClientRoom): string[] {
  const players = decoded(client);
  return players === undefined ? [] : [...players.keys()].sort();
}

function collect(client: ClientRoom): Inbox {
  const inbox: Inbox = { chats: [], rejects: [], portals: [], teleports: [] };
  client.onMessage(ServerMessage.Chat, (message: unknown) => {
    inbox.chats.push(message as ChatBroadcast);
  });
  client.onMessage(ServerMessage.MoveRejected, (message: unknown) => {
    inbox.rejects.push(message as MoveRejected);
  });
  client.onMessage(ServerMessage.PortalEntered, (message: unknown) => {
    inbox.portals.push(message as PortalEntered);
  });
  client.onMessage(ServerMessage.Teleported, (message: unknown) => {
    inbox.teleports.push(message as Teleported);
  });
  return inbox;
}

function serverPlayer(room: PlazaRoom, sessionId: string): Player {
  const player = room.state.players.get(sessionId);
  assert.ok(player, `server state has no player for session ${sessionId}`);
  return player;
}

interface PlayerSnapshot {
  tileX: number;
  tileY: number;
  facing: number;
}

/**
 * `state.players.get()` returns the live schema instance, so a value captured before an
 * action would silently compare equal to itself afterwards. Any before/after check copies.
 */
function snapshot(room: PlazaRoom, sessionId: string): PlayerSnapshot {
  const player = serverPlayer(room, sessionId);
  return { tileX: player.tileX, tileY: player.tileY, facing: player.facing };
}

function chebyshev(a: Player, b: Player): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

async function createPlaza(): Promise<PlazaRoom> {
  return (await testServer.createRoom<RoomState>(plaza.name, {})) as PlazaRoom;
}

async function join(
  room: PlazaRoom,
  nickname: string,
  avatarSkin = 0,
  viaPortal?: string,
): Promise<ClientRoom> {
  const client = (await testServer.connectTo(room, {
    nickname,
    avatarSkin,
    viaPortal,
  })) as unknown as ClientRoom;
  await waitUntil(
    () => seen(client, client.sessionId) !== undefined,
    `${nickname} to decode its own player entry`,
  );
  return client;
}

async function stepMany(client: ClientRoom, dir: Direction, steps: number): Promise<void> {
  for (let index = 0; index < steps; index++) {
    client.send(ClientMessage.Move, { dir });
    await sleep(MOVE_COOLDOWN_MS);
  }
}

async function expectServerAt(
  room: PlazaRoom,
  client: ClientRoom,
  tileX: number,
  tileY: number,
  label: string,
): Promise<void> {
  try {
    await waitUntil(
      () => {
        const player = room.state.players.get(client.sessionId);
        return player !== undefined && player.tileX === tileX && player.tileY === tileY;
      },
      label,
      3000,
    );
  } catch {
    const player = room.state.players.get(client.sessionId);
    const actual = player === undefined ? "no player" : `(${player.tileX},${player.tileY})`;
    assert.fail(`${label}: expected (${tileX},${tileY}), server has ${actual}`);
  }
}

/** Walks along CORRIDOR_ROW and confirms the server accepted every step. */
async function walkX(room: PlazaRoom, client: ClientRoom, targetX: number): Promise<void> {
  assert.ok(
    targetX >= CORRIDOR_MIN_X && targetX <= CORRIDOR_MAX_X,
    `x=${targetX} is outside the walkable corridor`,
  );
  const start = serverPlayer(room, client.sessionId);
  assert.equal(start.tileY, CORRIDOR_ROW, "walkX only works along the open corridor row");
  const dir = targetX > start.tileX ? Direction.Right : Direction.Left;
  await stepMany(client, dir, Math.abs(targetX - start.tileX));
  await expectServerAt(room, client, targetX, CORRIDOR_ROW, `walk to x=${targetX}`);
}

before(async () => {
  const gameServer = createGameServer();
  await gameServer.listen(INTEGRATION_PORT);
  testServer = new ColyseusTestServer(gameServer);
});

after(async () => {
  await testServer.shutdown();
});

afterEach(async () => {
  await testServer.cleanup();
});

describe("MetaverseRoom — interest management (StateView filtering)", () => {
  it("hides a player past VIEW_RADIUS_TILES, reveals it at exactly the radius, hides it again", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice", 1);
    const bob = await join(room, "bob", 2);

    await waitUntil(
      () => seen(alice, bob.sessionId) !== undefined && seen(bob, alice.sessionId) !== undefined,
      "both clients to see each other at the shared spawn tile",
    );

    await walkX(room, alice, CORRIDOR_MIN_X);
    await walkX(room, bob, CORRIDOR_MIN_X + VIEW_RADIUS_TILES + 1);
    assert.equal(
      chebyshev(serverPlayer(room, alice.sessionId), serverPlayer(room, bob.sessionId)),
      VIEW_RADIUS_TILES + 1,
      "precondition: the two players are one tile beyond the view radius",
    );

    await waitUntil(
      () => seen(alice, bob.sessionId) === undefined,
      `alice to drop bob at ${VIEW_RADIUS_TILES + 1} tiles`,
    );
    assert.equal(
      seen(bob, alice.sessionId),
      undefined,
      "filtering is symmetric: bob must not see alice either",
    );
    assert.deepEqual(seenIds(alice), [alice.sessionId], "alice sees only herself");

    await walkX(room, bob, CORRIDOR_MIN_X + VIEW_RADIUS_TILES);
    await waitUntil(
      () => seen(alice, bob.sessionId) !== undefined,
      `alice to see bob at exactly ${VIEW_RADIUS_TILES} tiles`,
    );

    // Re-entering the view must resend every field, not just what changed while hidden.
    const bobSeen = seen(alice, bob.sessionId);
    assert.ok(bobSeen);
    assert.equal(bobSeen.nickname, "bob");
    assert.equal(bobSeen.avatarSkin, 2);
    assert.equal(bobSeen.tileX, CORRIDOR_MIN_X + VIEW_RADIUS_TILES);
    assert.equal(bobSeen.tileY, CORRIDOR_ROW);

    await walkX(room, bob, CORRIDOR_MIN_X + VIEW_RADIUS_TILES + 1);
    await waitUntil(
      () => seen(alice, bob.sessionId) === undefined,
      "alice to drop bob again after he steps back out",
    );
  });

  it("survives repeated view exit/entry without leaking a stale entry", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice", 1);
    // Highest valid skin: non-default (0) and != alice's, so a stale/reset entry is visible.
    // Derived from the constant so shrinking AVATAR_SKIN_COUNT cannot silently clamp it to 0.
    const bobSkin = AVATAR_SKIN_COUNT - 1;
    const bob = await join(room, "bob", bobSkin);
    await walkX(room, alice, CORRIDOR_MIN_X);

    const insideX = CORRIDOR_MIN_X + VIEW_RADIUS_TILES;
    const outsideX = insideX + 1;
    for (let round = 0; round < 3; round++) {
      await walkX(room, bob, outsideX);
      await waitUntil(
        () => seen(alice, bob.sessionId) === undefined,
        `round ${round}: alice to drop bob`,
      );
      await walkX(room, bob, insideX);
      await waitUntil(
        () => seen(alice, bob.sessionId) !== undefined,
        `round ${round}: alice to re-acquire bob`,
      );
      const bobSeen = seen(alice, bob.sessionId);
      assert.ok(bobSeen);
      assert.equal(bobSeen.nickname, "bob", `round ${round}: nickname survived re-entry`);
      assert.equal(bobSeen.avatarSkin, bobSkin, `round ${round}: avatarSkin survived re-entry`);
      assert.equal(bobSeen.tileX, insideX, `round ${round}: position survived re-entry`);
      assert.equal(
        seenIds(alice).length,
        2,
        `round ${round}: exactly alice + bob, no duplicate or ghost entry`,
      );
    }
  });

  it("keeps a diagonal neighbour visible that a Euclidean radius would have dropped", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");

    // Routes are straight runs along open rows and columns of plaza.json; expectServerAt fails
    // loudly if the map changes. The step counts have to land the pair exactly VIEW_RADIUS_TILES
    // apart, so they follow the radius constant and are re-derived whenever it changes.
    await stepMany(alice, Direction.Left, 15);
    await stepMany(alice, Direction.Up, 12);
    await expectServerAt(room, alice, 16, 8, "alice walks to the north-west corner");
    await stepMany(bob, Direction.Right, 4);
    await stepMany(bob, Direction.Up, 1);
    await expectServerAt(room, bob, 35, 19, "bob walks south-east of alice");

    const apart = chebyshev(
      serverPlayer(room, alice.sessionId),
      serverPlayer(room, bob.sessionId),
    );
    assert.equal(apart, VIEW_RADIUS_TILES, "precondition: exactly the view radius, diagonally");
    await waitUntil(
      () => seen(alice, bob.sessionId) !== undefined && seen(bob, alice.sessionId) !== undefined,
      "a diagonal pair at exactly the view radius to stay visible to each other",
    );

    // One more tile of horizontal separation crosses the radius even though dy shrinks.
    await stepMany(bob, Direction.Up, 1);
    await stepMany(bob, Direction.Right, 1);
    await expectServerAt(room, bob, 36, 18, "bob steps past the diagonal boundary");
    assert.equal(
      chebyshev(serverPlayer(room, alice.sessionId), serverPlayer(room, bob.sessionId)),
      VIEW_RADIUS_TILES + 1,
    );
    await waitUntil(
      () => seen(alice, bob.sessionId) === undefined,
      "alice to drop bob once he passes the diagonal boundary",
    );
  });

  it("filters per client: a middle player sees both ends, the ends do not see each other", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    const carol = await join(room, "carol");

    await walkX(room, alice, CORRIDOR_MIN_X);
    await walkX(room, carol, CORRIDOR_MIN_X + VIEW_RADIUS_TILES + 1);
    // bob stays on the spawn tile: 15 tiles from alice and 5 from carol, so inside both radii
    // while the two ends are VIEW_RADIUS_TILES + 1 apart.

    await waitUntil(
      () =>
        seenIds(alice).length === 2 && seenIds(bob).length === 3 && seenIds(carol).length === 2,
      "each client's view to settle",
    );
    assert.deepEqual(seenIds(alice), [alice.sessionId, bob.sessionId].sort());
    assert.deepEqual(
      seenIds(bob),
      [alice.sessionId, bob.sessionId, carol.sessionId].sort(),
      "the middle player sees everyone",
    );
    assert.deepEqual(seenIds(carol), [bob.sessionId, carol.sessionId].sort());
  });

  it("removes a leaving player from the other clients' decoded state", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    await waitUntil(
      () => seen(alice, bob.sessionId) !== undefined,
      "alice to see bob before he leaves",
    );

    await bob.leave();

    await waitUntil(() => room.state.players.size === 1, "server state to drop the leaver");
    await waitUntil(
      () => seen(alice, bob.sessionId) === undefined,
      "alice's decoded state to drop the leaver (onLeave view cleanup)",
    );
    assert.deepEqual(seenIds(alice), [alice.sessionId], "no ghost entry left behind");
  });

  it("removes a leaving player from every remaining client, including one that sees it from far away", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    const carol = await join(room, "carol");

    await walkX(room, alice, CORRIDOR_MIN_X);
    await walkX(room, carol, CORRIDOR_MIN_X + VIEW_RADIUS_TILES);
    await waitUntil(
      () => seenIds(alice).length === 3 && seenIds(carol).length === 3,
      "all three clients to see each other",
    );

    await bob.leave();

    await waitUntil(() => room.state.players.size === 2, "server state to drop the leaver");
    await waitUntil(
      () => seen(alice, bob.sessionId) === undefined && seen(carol, bob.sessionId) === undefined,
      "both remaining clients to drop the leaver",
    );
  });

  it("drops a forcibly disconnected client from the remaining client's view", async () => {
    const room = await createPlaza();
    const anchor = await join(room, "anchor");
    const flooder = await join(room, "flooder");
    await waitUntil(
      () => seen(anchor, flooder.sessionId) !== undefined,
      "the anchor to see the flooder before the kick",
    );

    // Blowing past the room's message cap kicks the client without a graceful leave(),
    // which is the onLeave path every other test here reaches voluntarily.
    for (let index = 0; index < 150; index++) {
      flooder.send(ClientMessage.Move, { dir: Direction.Right });
    }

    await waitUntil(
      () => room.state.players.get(flooder.sessionId) === undefined,
      "the flooding client to be dropped by the room's message ceiling",
    );
    await waitUntil(
      () => seen(anchor, flooder.sessionId) === undefined,
      "the anchor's decoded state to drop the kicked client",
    );
    assert.deepEqual(seenIds(anchor), [anchor.sessionId], "no ghost left by the involuntary leave");

    // The survivor must still be a working client, not just a surviving state entry.
    anchor.send(ClientMessage.Move, { dir: Direction.Left });
    await expectServerAt(
      room,
      anchor,
      plaza.spawn.tileX - 1,
      plaza.spawn.tileY,
      "the room still serves the other client after the kick",
    );
  });

  it("keeps views consistent through a join/leave churn cycle", async () => {
    const room = await createPlaza();
    const first = await Promise.all([
      join(room, "p0"),
      join(room, "p1"),
      join(room, "p2"),
      join(room, "p3"),
    ]);
    await waitUntil(
      () => first.every((client) => seenIds(client).length === 4),
      "all four clients to see the full spawn cluster",
    );

    const leavers = first.slice(0, 2);
    const stayers = first.slice(2);
    await Promise.all(leavers.map((client) => client.leave()));
    await waitUntil(() => room.state.players.size === 2, "server to drop both leavers");
    await waitUntil(
      () => stayers.every((client) => seenIds(client).length === 2),
      "remaining clients to drop both leavers",
    );
    for (const client of stayers) {
      for (const leaver of leavers) {
        assert.equal(seen(client, leaver.sessionId), undefined, "no ghost after churn");
      }
    }

    const rejoined = await Promise.all([join(room, "p4"), join(room, "p5")]);
    await waitUntil(
      () => [...stayers, ...rejoined].every((client) => seenIds(client).length === 4),
      "views to converge again after the rejoin",
    );
  });

  it("leaves no residue when clients connect and disconnect rapidly", async () => {
    const room = await createPlaza();
    const observer = await join(room, "observer");

    for (let round = 0; round < 8; round++) {
      const transient = await join(room, `t${round}`);
      await transient.leave();
    }

    await waitUntil(() => room.state.players.size === 1, "server state to settle back to one player");
    await sleep(SETTLE_MS);
    assert.deepEqual(
      seenIds(observer),
      [observer.sessionId],
      "the observer's view must contain only itself after the churn",
    );
  });
});

describe("MetaverseRoom — chat delivery", () => {
  it("delivers chat inside CHAT_RADIUS_TILES and withholds it from a still-visible player outside it", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    const aliceInbox = collect(alice);
    const bobInbox = collect(bob);

    await walkX(room, alice, CORRIDOR_MIN_X);
    await walkX(room, bob, CORRIDOR_MIN_X + CHAT_RADIUS_TILES + 1);
    const gap = chebyshev(serverPlayer(room, alice.sessionId), serverPlayer(room, bob.sessionId));
    assert.equal(gap, CHAT_RADIUS_TILES + 1, "precondition: one tile beyond the chat radius");
    assert.ok(gap <= VIEW_RADIUS_TILES, "precondition: still inside the view radius");
    await waitUntil(
      () => seen(bob, alice.sessionId) !== undefined,
      "bob to still see alice's avatar while out of chat range",
    );

    alice.send(ClientMessage.Chat, { text: "too far" });
    // The sender is inside its own audience, so its echo is the delivery clock for the batch.
    await waitUntil(() => aliceInbox.chats.length === 1, "alice's own echo of the far message");
    await sleep(SETTLE_MS);
    assertEmpty(bobInbox.chats, "bob is beyond CHAT_RADIUS_TILES and must receive nothing");

    await sleep(CHAT_COOLDOWN_MS);
    await walkX(room, bob, CORRIDOR_MIN_X + CHAT_RADIUS_TILES);
    alice.send(ClientMessage.Chat, { text: "close enough" });
    await waitUntil(() => bobInbox.chats.length === 1, "bob to receive the in-range message");

    const received = bobInbox.chats[0];
    assert.ok(received);
    assert.equal(received.sessionId, alice.sessionId);
    assert.equal(received.nickname, "alice");
    assert.equal(received.text, "close enough");
    assert.ok(Math.abs(received.at - Date.now()) < 10_000, "timestamp is a server wall clock");
    assert.equal(aliceInbox.chats.length, 2, "the sender receives both of its own messages");
  });

  it("does not deliver chat to a player outside the view radius", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    const aliceInbox = collect(alice);
    const bobInbox = collect(bob);

    await walkX(room, alice, CORRIDOR_MIN_X);
    await walkX(room, bob, CORRIDOR_MIN_X + VIEW_RADIUS_TILES + 1);

    alice.send(ClientMessage.Chat, { text: "anyone out there" });
    await waitUntil(() => aliceInbox.chats.length === 1, "alice's own echo");
    await sleep(SETTLE_MS);
    assertEmpty(bobInbox.chats, "bob is outside the view radius and must receive nothing");
  });

  it("drops blank, whitespace-only and oversized messages without answering the sender", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const inbox = collect(alice);

    for (const text of ["", "   ", "\n\t ", "x".repeat(MAX_CHAT_LENGTH + 1)]) {
      alice.send(ClientMessage.Chat, { text });
      await sleep(20);
    }
    alice.send(ClientMessage.Chat, { text: 42 as unknown as string });
    await sleep(SETTLE_MS);
    assertEmpty(inbox.chats, "no invalid message may reach any client");

    // An invalid message must not have consumed the rate-limit budget either.
    alice.send(ClientMessage.Chat, { text: "valid" });
    await waitUntil(() => inbox.chats.length === 1, "the first valid message after invalid ones");
  });

  it("accepts a message of exactly MAX_CHAT_LENGTH and trims surrounding whitespace", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const inbox = collect(alice);

    const exact = "y".repeat(MAX_CHAT_LENGTH);
    alice.send(ClientMessage.Chat, { text: `   ${exact}   ` });
    await waitUntil(() => inbox.chats.length === 1, "the boundary-length message");
    assert.equal(inbox.chats[0]?.text, exact, "trimmed to exactly MAX_CHAT_LENGTH characters");
  });

  it("silently drops chat sent faster than MAX_CHATS_PER_SECOND", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const inbox = collect(alice);

    const burstStart = Date.now();
    for (const text of ["one", "two", "three"]) {
      alice.send(ClientMessage.Chat, { text });
    }
    const burstElapsed = Date.now() - burstStart;
    assert.ok(
      burstElapsed < CHAT_INTERVAL_MS,
      `precondition: the burst (${burstElapsed}ms) must fit inside one rate-limit window`,
    );

    await waitUntil(() => inbox.chats.length >= 1, "the first message of the burst");
    await sleep(SETTLE_MS);
    assert.equal(inbox.chats.length, 1, "only the first message of the burst is accepted");
    assert.equal(inbox.chats[0]?.text, "one");
    assertEmpty(inbox.rejects, "a rate-limited chat produces no error message");

    await sleep(CHAT_COOLDOWN_MS);
    alice.send(ClientMessage.Chat, { text: "after cooldown" });
    await waitUntil(() => inbox.chats.length === 2, "the limiter to reopen after the interval");
  });

  it("round-trips non-ASCII nicknames and message text", async () => {
    const room = await createPlaza();
    const alice = await join(room, "김철수");
    const bob = await join(room, "bob");
    const bobInbox = collect(bob);

    alice.send(ClientMessage.Chat, { text: "안녕하세요 🙂 café" });
    await waitUntil(() => bobInbox.chats.length === 1, "bob to receive the unicode message");
    assert.equal(bobInbox.chats[0]?.nickname, "김철수");
    assert.equal(bobInbox.chats[0]?.text, "안녕하세요 🙂 café");
    assert.equal(seen(bob, alice.sessionId)?.nickname, "김철수", "nickname survives schema encoding");
  });
});

describe("MetaverseRoom — movement authority", () => {
  it("rejects a step into the map border, turns the player, and shows no move to other clients", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    const aliceInbox = collect(alice);
    const bobInbox = collect(bob);

    await walkX(room, alice, CORRIDOR_MIN_X);
    await stepMany(alice, Direction.Down, 1);
    await expectServerAt(room, alice, CORRIDOR_MIN_X, CORRIDOR_ROW + 1, "alice steps off the corridor");
    await waitUntil(
      () => seen(bob, alice.sessionId)?.facing === Direction.Down,
      "bob to see alice facing Down before the refusal",
    );

    alice.send(ClientMessage.Move, { dir: Direction.Left });
    await waitUntil(() => aliceInbox.rejects.length === 1, "alice's MoveRejected");

    const rejection = aliceInbox.rejects[0];
    assert.ok(rejection);
    assert.deepEqual(rejection, {
      tileX: CORRIDOR_MIN_X,
      tileY: CORRIDOR_ROW + 1,
      facing: Direction.Left,
    });

    const authoritative = serverPlayer(room, alice.sessionId);
    assert.equal(authoritative.tileX, CORRIDOR_MIN_X, "a refused step never moves the player");
    assert.equal(authoritative.tileY, CORRIDOR_ROW + 1);
    assert.equal(authoritative.facing, Direction.Left, "a refused step still turns the player");

    await waitUntil(
      () => seen(bob, alice.sessionId)?.facing === Direction.Left,
      "bob to receive the turn even though the position did not change",
    );
    const aliceAsSeenByBob = seen(bob, alice.sessionId);
    assert.ok(aliceAsSeenByBob);
    assert.equal(aliceAsSeenByBob.tileX, CORRIDOR_MIN_X, "no observer sees a position change");
    assert.equal(aliceAsSeenByBob.tileY, CORRIDOR_ROW + 1);
    assertEmpty(bobInbox.rejects, "MoveRejected goes only to the refused mover");
  });

  it("rejects a step into the building beside the open south gate", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const inbox = collect(alice);
    await stepMany(alice, Direction.Down, 3);
    await stepMany(alice, Direction.Left, 2);
    await expectServerAt(room, alice, 29, 23, "beside the south gate building");
    alice.send(ClientMessage.Move, { dir: Direction.Left });
    await waitUntil(() => inbox.rejects.length === 1, "the wall refusal");
    assert.deepEqual(inbox.rejects[0], { tileX: 29, tileY: 23, facing: Direction.Left });
    assert.equal(serverPlayer(room, alice.sessionId).tileY, 23);
  });

  it("ignores malformed move payloads without moving, turning or answering", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const inbox = collect(alice);

    const before = snapshot(room, alice.sessionId);
    const malformed: unknown[] = [
      { dir: "up" },
      { dir: 4 },
      { dir: -1 },
      { dir: 0.5 },
      { dir: null },
      { dir: true },
      {},
      null,
      42,
      "move",
      [Direction.Up],
    ];
    for (const payload of malformed) {
      alice.send(ClientMessage.Move, payload);
      await sleep(MOVE_COOLDOWN_MS);
    }
    await sleep(SETTLE_MS);

    const after = snapshot(room, alice.sessionId);
    assert.equal(after.tileX, before.tileX, "no malformed payload may move the player");
    assert.equal(after.tileY, before.tileY);
    assert.equal(after.facing, before.facing, "an unparsable direction must not turn the player");
    assertEmpty(inbox.rejects, "a malformed payload is ignored, not refused");

    alice.send(ClientMessage.Move, { dir: Direction.Left });
    await expectServerAt(
      room,
      alice,
      before.tileX - 1,
      before.tileY,
      "the room still accepts a valid move afterwards",
    );
  });

  // Burst coalescing, re-arming between bursts and the hard message cap are covered
  // single-client in metaverseRoom.test.ts; only the multi-client gaps live here.

  it("never corrects a client stepping at the client's own input cadence", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const inbox = collect(alice);
    const start = snapshot(room, alice.sessionId);

    for (let index = 0; index < 8; index++) {
      alice.send(ClientMessage.Move, { dir: Direction.Right });
      await sleep(CLIENT_STEP_INTERVAL_MS);
    }

    await expectServerAt(
      room,
      alice,
      start.tileX + 8,
      start.tileY,
      "every step at the client's cadence is accepted",
    );
    assertEmpty(inbox.rejects, "normal play must never produce a throttle correction");
  });

  it("rate-limits each client independently", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    const start = snapshot(room, alice.sessionId);

    for (let index = 0; index < 4; index++) {
      alice.send(ClientMessage.Move, { dir: Direction.Left });
      bob.send(ClientMessage.Move, { dir: Direction.Right });
      await sleep(MOVE_COOLDOWN_MS);
    }

    await expectServerAt(room, alice, start.tileX - 4, start.tileY, "alice's four steps");
    await expectServerAt(room, bob, start.tileX + 4, start.tileY, "bob's four steps");
  });

  it("keeps the mover's own view in sync with the authoritative position", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");

    await walkX(room, alice, CORRIDOR_MAX_X);
    await waitUntil(() => {
      const self = seen(alice, alice.sessionId);
      return self?.tileX === CORRIDOR_MAX_X && self.facing === Direction.Right;
    }, "the mover's own decoded state to match the server");

    alice.send(ClientMessage.Move, { dir: Direction.Right });
    await sleep(SETTLE_MS);
    assert.equal(
      seen(alice, alice.sessionId)?.tileX,
      CORRIDOR_MAX_X,
      "the wall at the corridor edge holds",
    );
  });
});

describe("MetaverseRoom — portals", () => {
  /**
   * Right along the spawn row, then south to the door. A hand-checked route across plaza.json
   * rather than a search: `expectServerAt` fails loudly if the map or the portal row moves.
   */
  async function walkToDoor(room: PlazaRoom, client: ClientRoom): Promise<void> {
    await stepMany(client, Direction.Right, doorTile.tileX - plaza.spawn.tileX);
    await expectServerAt(
      room,
      client,
      doorTile.tileX,
      plaza.spawn.tileY,
      "the walker reaches the door's column",
    );
    await stepMany(client, Direction.Down, doorTile.tileY - plaza.spawn.tileY);
    await expectServerAt(room, client, doorTile.tileX, doorTile.tileY, "the walker steps onto the door");
  }

  it("sends PortalEntered to the mover alone when an accepted step lands on a trigger tile", async () => {
    const room = await createPlaza();
    const walker = await join(room, "walker");
    const bystander = await join(room, "bystander");
    const walkerInbox = collect(walker);
    const bystanderInbox = collect(bystander);

    await walkToDoor(room, walker);

    await waitUntil(() => walkerInbox.portals.length === 1, "the walker's PortalEntered");
    assert.deepEqual(walkerInbox.portals[0], {
      portalId: outboundPortal.id,
      toRoom: outboundPortal.to.room,
    });
    await sleep(SETTLE_MS);
    assertEmpty(bystanderInbox.portals, "PortalEntered goes only to the mover");
    assertEmpty(walkerInbox.rejects, "the walk onto the door is a normal accepted step");
    // The server keeps no transition state: the client is simply standing on the door.
    assert.equal(room.state.players.size, 2, "entering a portal does not remove the player");
    assert.equal(serverPlayer(room, walker.sessionId).tileX, doorTile.tileX);
    assert.equal(serverPlayer(room, walker.sessionId).tileY, doorTile.tileY);
  });

  it("fires again on a fresh entry, but not for a refused step off the door", async () => {
    const room = await createPlaza();
    const walker = await join(room, "walker");
    const inbox = collect(walker);
    await walkToDoor(room, walker);
    await waitUntil(() => inbox.portals.length === 1, "the first PortalEntered");

    // Row 26 of plaza.json is the south wall. A refused step enters no tile, so it must not
    // re-fire the door the player is already standing on.
    walker.send(ClientMessage.Move, { dir: Direction.Down });
    await waitUntil(() => inbox.rejects.length === 1, "the wall refusal");
    await sleep(SETTLE_MS);
    assert.equal(inbox.portals.length, 1, "a refused step must not fire a portal");

    await sleep(MOVE_COOLDOWN_MS);
    await stepMany(walker, Direction.Up, 1);
    await expectServerAt(
      room,
      walker,
      doorTile.tileX,
      doorTile.tileY - 1,
      "the walker steps off the door",
    );
    assert.equal(inbox.portals.length, 1, "stepping off a portal fires nothing");

    await stepMany(walker, Direction.Down, 1);
    await waitUntil(() => inbox.portals.length === 2, "PortalEntered again after stepping back on");
  });

  it("places a client joining with viaPortal on that portal's arrival tile", async () => {
    const room = await createPlaza();
    const { arrival } = inboundPortal.to;
    assert.notDeepEqual(
      { tileX: arrival.tileX, tileY: arrival.tileY },
      { tileX: plaza.spawn.tileX, tileY: plaza.spawn.tileY },
      "precondition: the arrival tile is not the generic spawn, or this proves nothing",
    );

    const arriving = await join(room, "arriving", 0, inboundPortal.id);

    const authoritative = serverPlayer(room, arriving.sessionId);
    assert.equal(authoritative.tileX, arrival.tileX);
    assert.equal(authoritative.tileY, arrival.tileY);
    const self = seen(arriving, arriving.sessionId);
    assert.ok(self);
    assert.equal(self.tileX, arrival.tileX, "the client decodes the arrival tile too");
    assert.equal(self.tileY, arrival.tileY);
  });

  it("falls back to the room spawn for a viaPortal this room does not own", async () => {
    const room = await createPlaza();
    // Holds the room open across the leaves below, which would otherwise dispose it.
    await join(room, "anchor");

    const notOurs: readonly string[] = [
      "no-such-portal",
      // A door *out of* plaza: its arrival belongs to the destination room, not to this one.
      outboundPortal.id,
      "",
      42 as unknown as string,
    ];
    for (const viaPortal of notOurs) {
      const client = await join(room, "fallback", 0, viaPortal);
      const authoritative = serverPlayer(room, client.sessionId);
      const label = `viaPortal=${JSON.stringify(viaPortal)}`;
      assert.equal(authoritative.tileX, plaza.spawn.tileX, label);
      assert.equal(authoritative.tileY, plaza.spawn.tileY, label);
      await client.leave();
      await waitUntil(() => room.state.players.size === 1, `${label} to leave no player behind`);
    }
  });

  it("treats a join whose viaPortal key is absent and one whose value is undefined alike", async () => {
    // `join()` above always puts the key in the options object, undefined when unused, so every
    // pre-portal test in this file now sends a shape it never sent before. This is the check
    // that the added key is genuinely inert rather than quietly meaning something.
    const room = await createPlaza();
    const explicit = (await testServer.connectTo(room, {
      nickname: "explicit",
      avatarSkin: 0,
      viaPortal: undefined,
    })) as unknown as ClientRoom;
    const absent = (await testServer.connectTo(room, {
      nickname: "absent",
      avatarSkin: 0,
    })) as unknown as ClientRoom;

    for (const client of [explicit, absent]) {
      const authoritative = serverPlayer(room, client.sessionId);
      assert.equal(authoritative.tileX, plaza.spawn.tileX, `${authoritative.nickname} tileX`);
      assert.equal(authoritative.tileY, plaza.spawn.tileY, `${authoritative.nickname} tileY`);
    }
  });
});

describe("MetaverseRoom — join options", () => {
  it("truncates an over-long nickname to MAX_NICKNAME_LENGTH", async () => {
    const room = await createPlaza();
    const long = "n".repeat(MAX_NICKNAME_LENGTH + 20);
    const client = await join(room, long);
    assert.equal(seen(client, client.sessionId)?.nickname, "n".repeat(MAX_NICKNAME_LENGTH));
  });

  it("truncates an all-astral nickname on a code-point boundary", async () => {
    const room = await createPlaza();
    // 20 code points / 40 UTF-16 code units, so truncation actually has to cut — and the
    // cut has to land between surrogate pairs rather than inside one.
    const client = await join(room, "\u{1F600}".repeat(MAX_NICKNAME_LENGTH + 4));
    const observer = await join(room, "observer");
    await waitUntil(
      () => seen(observer, client.sessionId) !== undefined,
      "the observer to see the emoji player",
    );

    const authoritative = serverPlayer(room, client.sessionId).nickname;
    assert.equal(
      [...authoritative].length,
      MAX_NICKNAME_LENGTH,
      "MAX_NICKNAME_LENGTH counts code points, not UTF-16 code units",
    );
    assert.ok(
      !LONE_SURROGATE.test(authoritative),
      `truncation split a surrogate pair: ${JSON.stringify(authoritative)}`,
    );

    const decodedPlayer = seen(observer, client.sessionId);
    assert.ok(decodedPlayer);
    assert.equal(decodedPlayer.nickname, authoritative, "the observer decodes the same nickname");
    // The fields encoded after the string are the ones a length-prefix desync destroys.
    assert.equal(decodedPlayer.tileX, plaza.spawn.tileX);
    assert.equal(decodedPlayer.tileY, plaza.spawn.tileY);
  });

  it("keeps a nickname of exactly MAX_NICKNAME_LENGTH intact", async () => {
    const room = await createPlaza();
    const exact = "e".repeat(MAX_NICKNAME_LENGTH);
    const client = await join(room, exact);
    assert.equal(seen(client, client.sessionId)?.nickname, exact);
  });

  it("keeps the room running for everyone else when a nickname truncation splits a surrogate pair", async () => {
    const room = await createPlaza();
    const observer = await join(room, "observer");
    // Both join inside one patch window, so a corrupt entry and a healthy one are
    // encoded into the same payload.
    const [client, other] = await Promise.all([
      join(room, SURROGATE_SPLITTING_NICKNAME),
      join(room, "other"),
    ]);
    await waitUntil(() => seenIds(observer).length === 3, "the observer to see all three players");

    // The damage must at least stay inside the offending player's own entry.
    assert.equal(seen(observer, other.sessionId)?.nickname, "other");
    assert.equal(seen(observer, other.sessionId)?.tileY, plaza.spawn.tileY);
    observer.send(ClientMessage.Move, { dir: Direction.Left });
    await expectServerAt(
      room,
      observer,
      plaza.spawn.tileX - 1,
      plaza.spawn.tileY,
      "the room keeps running after the truncated nickname is encoded",
    );
    assert.ok(seen(observer, client.sessionId) !== undefined, "the player still exists in the view");
  });

  it("delivers a surrogate-splitting nickname to other clients without corrupting the player", async () => {
    const room = await createPlaza();
    const client = await join(room, SURROGATE_SPLITTING_NICKNAME);
    const observer = await join(room, "observer");
    await sleep(SETTLE_MS);

    const decodedPlayer = seen(observer, client.sessionId);
    assert.ok(decodedPlayer, "the player reaches the observer");
    assert.equal(
      decodedPlayer.tileX,
      plaza.spawn.tileX,
      "the position must survive the nickname encoding",
    );
    assert.equal(decodedPlayer.tileY, plaza.spawn.tileY);
    assert.equal(
      decodedPlayer.nickname,
      serverPlayer(room, client.sessionId).nickname,
      "what the observer decodes must match the authoritative nickname",
    );
    assert.ok(
      !LONE_SURROGATE.test(decodedPlayer.nickname),
      `no lone surrogate may survive truncation: ${JSON.stringify(decodedPlayer.nickname)}`,
    );
  });

  it("survives a chat message containing a lone surrogate", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");
    const bobInbox = collect(bob);

    alice.send(ClientMessage.Chat, { text: "hi \uD83D there" });
    await sleep(SETTLE_MS);

    // Whatever the payload decodes to, the room must still serve both clients afterwards.
    await sleep(CHAT_COOLDOWN_MS);
    alice.send(ClientMessage.Chat, { text: "still alive" });
    await waitUntil(
      () => bobInbox.chats.some((message) => message.text === "still alive"),
      "the room to keep delivering chat after a lone-surrogate payload",
    );
    assert.equal(seen(bob, alice.sessionId)?.nickname, "alice", "state stays intact");
  });

  it("clamps every out-of-range avatar skin to 0 and preserves the last valid one", async () => {
    const room = await createPlaza();
    // The room auto-disposes once the last client leaves, so one client holds it open.
    await join(room, "anchor");
    for (const skin of [-1, AVATAR_SKIN_COUNT, 1.5, Number.NaN, 99]) {
      const client = await join(room, `skin${skin}`, skin);
      assert.equal(
        seen(client, client.sessionId)?.avatarSkin,
        0,
        `avatarSkin ${skin} must fall back to 0`,
      );
      await client.leave();
    }
    const client = await join(room, "boundary", AVATAR_SKIN_COUNT - 1);
    assert.equal(seen(client, client.sessionId)?.avatarSkin, AVATAR_SKIN_COUNT - 1);
  });

  it("refuses a join without any options and still serves the other clients", async () => {
    const room = await createPlaza();
    const alice = await join(room, "alice");
    const bob = await join(room, "bob");

    await assert.rejects(testServer.connectTo(room, {}));
    await waitUntil(() => room.state.players.size === 2, "the refused join to leave no player behind");

    // A refused client never got a StateView, so the next refreshViews must skip it cleanly.
    alice.send(ClientMessage.Move, { dir: Direction.Left });
    await expectServerAt(
      room,
      alice,
      plaza.spawn.tileX - 1,
      plaza.spawn.tileY,
      "the room still moves players after a refused join",
    );
    await waitUntil(
      () => seen(bob, alice.sessionId)?.tileX === plaza.spawn.tileX - 1,
      "the surviving clients still sync after a refused join",
    );
  });
});

/**
 * The unit suite drives `handleReturnHome` directly, which cannot see the `onMessage` wiring or
 * the payload-free message contract. These go over a real socket, so a mistyped registration
 * — the one failure that would leave the button dead in production — fails here.
 */
describe("MetaverseRoom — return home", () => {
  it("warps a walked-away client back to the spawn tile and tells it so", async () => {
    const room = await createPlaza();
    const client = await join(room, "walker");
    const inbox = collect(client);
    const observer = await join(room, "observer");

    await walkX(room, client, plaza.spawn.tileX + 9);
    assert.notEqual(
      snapshot(room, client.sessionId).tileX,
      plaza.spawn.tileX,
      "precondition: the client actually walked off the home tile",
    );

    client.send(ClientMessage.ReturnHome);

    await expectServerAt(
      room,
      client,
      plaza.spawn.tileX,
      plaza.spawn.tileY,
      "the return-home message is wired up and warps the player",
    );
    await waitUntil(() => inbox.teleports.length === 1, "the Teleported acknowledgement");
    assert.deepEqual(inbox.teleports[0], {
      tileX: plaza.spawn.tileX,
      tileY: plaza.spawn.tileY,
      facing: Direction.Down,
    });
    assertEmpty(inbox.rejects, "a warp is not a move and must not be rejected");
    await waitUntil(
      () => seen(observer, client.sessionId)?.tileX === plaza.spawn.tileX,
      "the observer to see the warped position",
    );
  });

  it("drops a second return-home inside the cooldown without answering it", async () => {
    const room = await createPlaza();
    const client = await join(room, "impatient");
    const inbox = collect(client);
    assert.ok(
      SETTLE_MS < HOME_COOLDOWN_MS,
      "precondition: the wait below stays inside the cooldown window",
    );

    client.send(ClientMessage.ReturnHome);
    await waitUntil(() => inbox.teleports.length === 1, "the first acknowledgement");
    client.send(ClientMessage.ReturnHome);
    await sleep(SETTLE_MS);

    assert.equal(inbox.teleports.length, 1, "the second request is answered with silence");
    assertEmpty(inbox.rejects, "and with no rejection either — the client already mirrors the window");
  });

  it("ignores a return-home carrying an unexpected payload", async () => {
    const room = await createPlaza();
    const client = await join(room, "noisy");
    const inbox = collect(client);

    // The message is declared payload-free, so anything sent alongside it is a client the
    // server does not control. It must not become a way to name a destination tile.
    client.send(ClientMessage.ReturnHome, { tileX: 1, tileY: 1 });
    await waitUntil(() => inbox.teleports.length === 1, "the acknowledgement");

    assert.deepEqual(snapshot(room, client.sessionId), {
      tileX: plaza.spawn.tileX,
      tileY: plaza.spawn.tileY,
      facing: Direction.Down,
    });
  });
});

describe("MetaverseRoom — change skin", () => {
  it("applies an in-range skin change and syncs it to observers", async () => {
    const room = await createPlaza();
    const client = await join(room, "reskinner", 0);
    const observer = await join(room, "observer");
    await waitUntil(
      () => seen(observer, client.sessionId) !== undefined,
      "the observer to see the reskinner",
    );

    client.send(ClientMessage.ChangeSkin, { skin: 5 });

    await waitUntil(
      () => serverPlayer(room, client.sessionId).avatarSkin === 5,
      "the server to apply the new skin",
    );
    // The server mutating its own object is not the same moment the patch reaches either
    // client — that is a further round trip through the patch encoder and this socket, so
    // asserting the decoded copy right after the server-side waitUntil above (rather than
    // waiting on the decoded copy itself) is a race: it happened to pass only because earlier
    // tests in this file leave enough real time between send() and the assertion for the
    // patch to land.
    await waitUntil(
      () => seen(client, client.sessionId)?.avatarSkin === 5,
      "the reskinner to see their own new skin",
    );
    await waitUntil(
      () => seen(observer, client.sessionId)?.avatarSkin === 5,
      "the observer to see the new skin through the normal Player patch",
    );
  });

  it("ignores an out-of-range skin and leaves the current skin unchanged", async () => {
    const room = await createPlaza();
    const client = await join(room, "reskinner", 3);

    for (const skin of [-1, AVATAR_SKIN_COUNT, 1.5, Number.NaN]) {
      client.send(ClientMessage.ChangeSkin, { skin });
    }
    // No acknowledgement exists to wait on (§4: no ack), so settle on the clock instead.
    await sleep(SETTLE_MS);

    assert.equal(
      serverPlayer(room, client.sessionId).avatarSkin,
      3,
      "an out-of-range skin must not overwrite the current one",
    );
  });

  it("ignores a malformed change-skin payload without touching the current skin", async () => {
    const room = await createPlaza();
    const client = await join(room, "reskinner", 2);

    const malformed: unknown[] = [{ skin: "5" }, { skin: null }, {}, null, 42, "avatar:change-skin"];
    for (const payload of malformed) {
      client.send(ClientMessage.ChangeSkin, payload);
    }
    await sleep(SETTLE_MS);

    assert.equal(serverPlayer(room, client.sessionId).avatarSkin, 2);
  });
});
