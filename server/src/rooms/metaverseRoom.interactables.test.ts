import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import {
  ClientMessage,
  Direction,
  InteractableKind,
  MAX_MOVES_PER_SECOND,
  QuestStatus,
  ServerMessage,
  type InteractableEntered,
  type QuizResult,
  type RoomState,
  type TilePosition,
} from "@zep-test/shared";
import { TiledMapLoader } from "../game/tiledMap";
import { createGameServer } from "../server";
import type {
  CollisionMap,
  LinkInteractable,
  NoticeInteractable,
  NpcInteractable,
  QuizInteractable,
} from "./contracts";
import { ROOM_DEFINITIONS } from "./definitions";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";
import { QUESTS_BY_GIVER } from "./questDefinitions";

/**
 * Its own port, for the reason `metaverseRoom.integration.test.ts` records: node:test runs test
 * files in parallel processes and `boot()` always binds 2568, so every file that listens has to
 * pick a private port. Exactly one file may own a given port: this file and
 * routes.integration.test.ts both claimed 2573, which killed one suite with EADDRINUSE and left
 * the other's listener open so the run never exited. Grep the other *.test.ts files for the
 * ports they bind before changing this.
 */
const INTERACTABLE_PORT = 2581;

const MOVE_COOLDOWN_MS = 1000 / MAX_MOVES_PER_SECOND + 15;

const [plazaDefinition] = ROOM_DEFINITIONS;
if (plazaDefinition === undefined) {
  throw new Error("ROOM_DEFINITIONS is empty");
}
const plaza = plazaDefinition;

const huntingGroundDefinition = ROOM_DEFINITIONS.find((definition) => definition.name === "hunting-ground");
if (huntingGroundDefinition === undefined) {
  throw new Error("ROOM_DEFINITIONS has no hunting-ground row");
}
const huntingGround = huntingGroundDefinition;

const LINK = definitionFor("plaza-link-board", InteractableKind.Link) as LinkInteractable;
const NOTICE = definitionFor("plaza-notice-board", InteractableKind.Notice) as NoticeInteractable;
const QUIZ = definitionFor("plaza-quiz-stand", InteractableKind.Quiz) as QuizInteractable;
const NPC = definitionFor("plaza-hunting-ground-npc", InteractableKind.Npc) as NpcInteractable;
const SHOP_NPC = definitionFor("plaza-shop-npc", InteractableKind.Npc) as NpcInteractable;
const RETURN_NPC = definitionFor("hunting-ground-return-npc", InteractableKind.Npc) as NpcInteractable;
/** Read from the quest table rather than repeated here — the panel quotes it verbatim. */
const FIRST_QUEST = (() => {
  const [quest] = QUESTS_BY_GIVER.get(NPC.id) ?? [];
  assert.ok(quest, `the quest table no longer has a row given by "${NPC.id}"`);
  return quest;
})();

/** Fails loudly if the placeholder table is swapped for one that renames or re-kinds a row. */
function definitionFor(id: string, kind: InteractableKind) {
  const found = INTERACTABLE_DEFINITIONS.find((object) => object.id === id);
  assert.ok(found, `INTERACTABLE_DEFINITIONS no longer holds "${id}"`);
  assert.equal(found.kind, kind, `"${id}" is no longer a ${kind} object`);
  return found;
}

function tileOf(object: { at: { tiles: readonly TilePosition[] } }, index = 0): TilePosition {
  const tile = object.at.tiles[index];
  assert.ok(tile, "object row has no tile at that index");
  return tile;
}

/** Only the client surface these tests drive; see the note in metaverseRoom.integration.test.ts. */
interface ClientRoom {
  readonly sessionId: string;
  readonly state: { players?: { get(id: string): unknown; size: number } } | undefined;
  send(type: string, payload?: unknown): void;
  onMessage(type: string, callback: (payload: unknown) => void): unknown;
}

interface Inbox {
  objects: InteractableEntered[];
  quiz: QuizResult[];
}

type Room = Awaited<ReturnType<ColyseusTestServer["createRoom"]>> & { state: RoomState };

let testServer: ColyseusTestServer;
let plazaMap: CollisionMap;
let huntingGroundMap: CollisionMap;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function collect(client: ClientRoom): Inbox {
  const inbox: Inbox = { objects: [], quiz: [] };
  client.onMessage(ServerMessage.InteractableEntered, (message: unknown) => {
    inbox.objects.push(message as InteractableEntered);
  });
  client.onMessage(ServerMessage.QuizResult, (message: unknown) => {
    inbox.quiz.push(message as QuizResult);
  });
  return inbox;
}

async function joinRoom(name: string): Promise<{ room: Room; client: ClientRoom; inbox: Inbox }> {
  const room = (await testServer.createRoom<RoomState>(name, {})) as Room;
  const client = (await testServer.connectTo(room, {
    nickname: "walker",
    avatarSkin: 0,
  })) as unknown as ClientRoom;
  await waitUntil(
    () => room.state.players.get(client.sessionId) !== undefined,
    "the walker to appear in server state",
  );
  return { room, client, inbox: collect(client) };
}

const STEPS: readonly { dir: Direction; dx: number; dy: number }[] = [
  { dir: Direction.Up, dx: 0, dy: -1 },
  { dir: Direction.Down, dx: 0, dy: 1 },
  { dir: Direction.Left, dx: -1, dy: 0 },
  { dir: Direction.Right, dx: 1, dy: 0 },
];

/**
 * Tiles the walker must not cross on its way anywhere: another object would open a panel the
 * test never asked for, and a portal trigger would move it to a different room mid-walk.
 */
function detours(exceptTile: TilePosition, roomName: string = plaza.name): Set<string> {
  const blocked = new Set<string>();
  for (const object of INTERACTABLE_DEFINITIONS) {
    if (object.at.room !== roomName) {
      continue;
    }
    for (const tile of object.at.tiles) {
      blocked.add(`${tile.tileX},${tile.tileY}`);
    }
  }
  for (const portal of PORTAL_DEFINITIONS) {
    if (portal.from.room !== roomName) {
      continue;
    }
    for (const tile of portal.from.tiles) {
      blocked.add(`${tile.tileX},${tile.tileY}`);
    }
  }
  blocked.delete(`${exceptTile.tileX},${exceptTile.tileY}`);
  return blocked;
}

/** Shortest tile path, so the walk tracks the real map rather than hard-coded coordinates. */
function pathTo(
  from: TilePosition,
  to: TilePosition,
  blocked: Set<string>,
  map: CollisionMap,
): Direction[] {
  const key = (x: number, y: number): string => `${x},${y}`;
  const goal = key(to.tileX, to.tileY);
  if (key(from.tileX, from.tileY) === goal) {
    return [];
  }
  const cameFrom = new Map<string, Direction[]>([[key(from.tileX, from.tileY), []]]);
  let frontier = [{ x: from.tileX, y: from.tileY }];
  while (frontier.length > 0) {
    const next: { x: number; y: number }[] = [];
    for (const node of frontier) {
      const route = cameFrom.get(key(node.x, node.y)) ?? [];
      for (const step of STEPS) {
        const x = node.x + step.dx;
        const y = node.y + step.dy;
        const at = key(x, y);
        if (cameFrom.has(at) || !map.isWalkable(x, y)) {
          continue;
        }
        if (at !== goal && blocked.has(at)) {
          continue;
        }
        const taken = [...route, step.dir];
        if (at === goal) {
          return taken;
        }
        cameFrom.set(at, taken);
        next.push({ x, y });
      }
    }
    frontier = next;
  }
  throw new Error(`no path from (${from.tileX},${from.tileY}) to (${to.tileX},${to.tileY})`);
}

async function walkTo(
  room: Room,
  client: ClientRoom,
  target: TilePosition,
  map: CollisionMap = plazaMap,
  roomName: string = plaza.name,
): Promise<void> {
  const player = room.state.players.get(client.sessionId);
  assert.ok(player);
  for (const dir of pathTo(
    { tileX: player.tileX, tileY: player.tileY },
    target,
    detours(target, roomName),
    map,
  )) {
    client.send(ClientMessage.Move, { dir });
    await sleep(MOVE_COOLDOWN_MS);
  }
  await waitUntil(() => {
    const at = room.state.players.get(client.sessionId);
    return at !== undefined && at.tileX === target.tileX && at.tileY === target.tileY;
  }, `the walker to reach (${target.tileX},${target.tileY})`);
}

before(async () => {
  const gameServer = createGameServer();
  await gameServer.listen(INTERACTABLE_PORT);
  testServer = new ColyseusTestServer(gameServer);
  plazaMap = await new TiledMapLoader().load(plaza.mapKey);
  huntingGroundMap = await new TiledMapLoader().load(huntingGround.mapKey);
});

after(async () => {
  await testServer.shutdown();
});

afterEach(async () => {
  await testServer.cleanup();
});

describe("MetaverseRoom — object markers in RoomState", () => {
  it("publishes every tile of every object in the room, with its kind and nothing else", async () => {
    const { room } = await joinRoom(plaza.name);

    const published = [...room.state.interactableMarkers]
      .map((marker) => `${marker.tileX},${marker.tileY},${marker.kind}`)
      .sort();
    const expected = INTERACTABLE_DEFINITIONS.filter((object) => object.at.room === plaza.name)
      .flatMap((object) => object.at.tiles.map((tile) => `${tile.tileX},${tile.tileY},${object.kind}`))
      .sort();

    assert.deepEqual(published, expected);
    assert.ok(published.length > 0, "precondition: plaza owns at least one object tile");
  });

  it("never puts an object's content into the synced state", async () => {
    const { room } = await joinRoom(plaza.name);
    // The quiz answer, the notice body and the link URL would all be readable by every client
    // for the room's whole lifetime if a marker ever carried them.
    const serialised = JSON.stringify([...room.state.interactableMarkers]);
    assert.equal(serialised.includes(QUIZ.question), false);
    assert.equal(serialised.includes(NOTICE.body), false);
    assert.equal(serialised.includes(LINK.url), false);
    assert.equal(serialised.includes(NPC.body), false);
    assert.equal(serialised.includes("answerIndex"), false);
  });

  it("carries the npc's authored avatarSkin on its marker; every other kind's stays undefined", async () => {
    // The one bug the design doc flags as invisible to the compiler: an optional field a missed
    // spread leaves unset. This also confirms the documented behaviour of
    // `InteractableMarker.avatarSkin` (state.ts) and `InteractableMarkerTile.avatarSkin`
    // (contracts.ts): a schema `uint8` that is never assigned decodes as `undefined`, not `0` —
    // verified directly against @colyseus/schema's Encoder/Decoder round trip.
    const { room } = await joinRoom(plaza.name);
    const markers = [...room.state.interactableMarkers];

    const npcMarker = markers.find(
      (marker) => marker.tileX === NPC.at.tiles[0]?.tileX && marker.tileY === NPC.at.tiles[0]?.tileY,
    );
    assert.ok(npcMarker, "precondition: the npc's marker is published");
    assert.equal(npcMarker.kind, InteractableKind.Npc);
    assert.equal(npcMarker.avatarSkin, NPC.avatarSkin, "marker avatarSkin must match the authored row");
    assert.equal(NPC.avatarSkin, 21, "precondition: the authored table still uses skin 21");

    for (const marker of markers) {
      if (marker.kind === InteractableKind.Npc) {
        continue;
      }
      assert.equal(
        marker.avatarSkin,
        undefined,
        `non-npc marker at (${marker.tileX},${marker.tileY}) unexpectedly carries an avatarSkin`,
      );
    }
  });

  it("publishes no markers in the load-test room", async () => {
    // grand-plaza is the 500-CCU map; an object there would put PoC #2 messages on the wire.
    const grand = ROOM_DEFINITIONS.find((definition) => definition.name === "grand-plaza");
    assert.ok(grand);
    const { room } = await joinRoom(grand.name);
    assert.deepEqual([...room.state.interactableMarkers], []);
  });

  it("publishes hunting-ground's own object tile, including the R03 return npc", async () => {
    const { room } = await joinRoom(huntingGround.name);

    const published = [...room.state.interactableMarkers]
      .map((marker) => `${marker.tileX},${marker.tileY},${marker.kind}`)
      .sort();
    const expected = INTERACTABLE_DEFINITIONS.filter((object) => object.at.room === huntingGround.name)
      .flatMap((object) => object.at.tiles.map((tile) => `${tile.tileX},${tile.tileY},${object.kind}`))
      .sort();

    assert.deepEqual(published, expected);
    assert.deepEqual(expected, [`${RETURN_NPC.at.tiles[0]?.tileX},${RETURN_NPC.at.tiles[0]?.tileY},npc`]);
  });
});

describe("MetaverseRoom — entering an object", () => {
  it("delivers the link's content, and only to the player who stepped on it", async () => {
    const { room, client, inbox } = await joinRoom(plaza.name);
    const bystander = (await testServer.connectTo(room, {
      nickname: "bystander",
      avatarSkin: 0,
    })) as unknown as ClientRoom;
    const bystanderInbox = collect(bystander);

    await walkTo(room, client, tileOf(LINK));
    await waitUntil(() => inbox.objects.length > 0, "the link payload");

    assert.deepEqual(inbox.objects, [
      {
        kind: InteractableKind.Link,
        objectId: LINK.id,
        title: LINK.title,
        url: LINK.url,
        blocksMovement: true,
      },
    ]);
    assert.deepEqual(bystanderInbox.objects, [], "an object is not broadcast to the room");
  });

  it("delivers the notice body verbatim, newlines included, from either tile of the board", async () => {
    const { room, client, inbox } = await joinRoom(plaza.name);
    const first = tileOf(NOTICE, 0);
    const second = tileOf(NOTICE, 1);

    await walkTo(room, client, first);
    await waitUntil(() => inbox.objects.length === 1, "the first tile's payload");
    await walkTo(room, client, second);
    await waitUntil(() => inbox.objects.length === 2, "the second tile's payload");

    const body = NOTICE.body;
    assert.ok(body.includes("\n"), "precondition: the placeholder notice is multi-line");
    for (const payload of inbox.objects) {
      assert.deepEqual(payload, {
        kind: InteractableKind.Notice,
        objectId: NOTICE.id,
        title: NOTICE.title,
        body,
        blocksMovement: true,
      });
    }
  });

  it("delivers the quiz question and choices but never the answer", async () => {
    const { room, client, inbox } = await joinRoom(plaza.name);
    await walkTo(room, client, tileOf(QUIZ));
    await waitUntil(() => inbox.objects.length > 0, "the quiz payload");

    const [payload] = inbox.objects;
    assert.ok(payload);
    assert.deepEqual(payload, {
      kind: InteractableKind.Quiz,
      objectId: QUIZ.id,
      title: QUIZ.title,
      question: QUIZ.question,
      choices: QUIZ.choices,
      blocksMovement: true,
    });
    // The one thing a quiz has. Asserted on the serialised payload too, because a field added
    // later would pass the shape check above only if someone also updated it.
    assert.equal(JSON.stringify(payload).includes("answerIndex"), false);
    assert.equal(JSON.stringify(payload).includes(String(QUIZ.explanation)), false);
  });

  it("does not fire again while the player stands on the tile", async () => {
    const { room, client, inbox } = await joinRoom(plaza.name);
    await walkTo(room, client, tileOf(QUIZ));
    await waitUntil(() => inbox.objects.length === 1, "the quiz payload");

    // A move the map refuses still reaches handleMove and still turns the player; what it must
    // not do is re-deliver the object under their feet. Only the walls are pushed against, so
    // the walker provably never leaves the tile and the assertion below cannot be vacuous.
    const tile = tileOf(QUIZ);
    const walls = STEPS.filter((step) => !plazaMap.isWalkable(tile.tileX + step.dx, tile.tileY + step.dy));
    assert.ok(walls.length > 0, "precondition: the quiz stand has a wall to face");
    for (let round = 0; round < 3; round++) {
      for (const { dir } of walls) {
        client.send(ClientMessage.Move, { dir });
        await sleep(MOVE_COOLDOWN_MS);
      }
    }
    await sleep(200);

    const at = room.state.players.get(client.sessionId);
    assert.ok(at);
    assert.deepEqual({ tileX: at.tileX, tileY: at.tileY }, tile, "the walker left the object tile");
    assert.equal(inbox.objects.length, 1, "standing still re-opened the panel");
  });

  it("delivers the npc's title and body like a notice, and only to the player who stepped on it", async () => {
    const { room, client, inbox } = await joinRoom(plaza.name);
    const bystander = (await testServer.connectTo(room, {
      nickname: "bystander",
      avatarSkin: 0,
    })) as unknown as ClientRoom;
    const bystanderInbox = collect(bystander);

    await walkTo(room, client, tileOf(NPC));
    await waitUntil(() => inbox.objects.length > 0, "the npc payload");

    assert.deepEqual(inbox.objects, [
      {
        kind: InteractableKind.Npc,
        objectId: NPC.id,
        title: NPC.title,
        body: NPC.body,
        blocksMovement: false,
        // This guide also gives R03's first quest, and the panel carries the reader's own state on
        // it (`questSystem.test.ts` covers that state; here it is the payload's shape that matters).
        // `Offered` with no progress, since this server is built without a quest store.
        quests: [
          {
            questId: FIRST_QUEST.id,
            title: FIRST_QUEST.title,
            summary: FIRST_QUEST.summary,
            objectiveText: FIRST_QUEST.objectiveText,
            completionText: FIRST_QUEST.completionText,
            status: QuestStatus.Offered,
            killCount: 0,
            requiredCount: FIRST_QUEST.objective.count,
          },
        ],
      },
    ]);
    assert.deepEqual(bystanderInbox.objects, [], "an object is not broadcast to the room");
  });

  it("delivers the shop npc's placeholder content and no quest (R03 content, no purchase path)", async () => {
    const { room, client, inbox } = await joinRoom(plaza.name);

    await walkTo(room, client, tileOf(SHOP_NPC));
    await waitUntil(() => inbox.objects.length > 0, "the shop npc payload");

    assert.deepEqual(inbox.objects, [
      {
        kind: InteractableKind.Npc,
        objectId: SHOP_NPC.id,
        title: SHOP_NPC.title,
        body: SHOP_NPC.body,
        blocksMovement: true,
        quests: undefined,
      },
    ]);
    assert.equal(QUESTS_BY_GIVER.get(SHOP_NPC.id), undefined, "the shop npc gives no quest");
    // The one rule this row must never break: no currency/price field anywhere on the wire.
    assert.equal(JSON.stringify(inbox.objects).match(/price|cost|currency/i), null);
  });

  it("delivers the hunting-ground return npc's content from its own room", async () => {
    const { room, client, inbox } = await joinRoom(huntingGround.name);

    await walkTo(room, client, tileOf(RETURN_NPC), huntingGroundMap, huntingGround.name);
    await waitUntil(() => inbox.objects.length > 0, "the return npc payload");

    assert.deepEqual(inbox.objects, [
      {
        kind: InteractableKind.Npc,
        objectId: RETURN_NPC.id,
        title: RETURN_NPC.title,
        body: RETURN_NPC.body,
        // False, unlike every plaza object: this room has monsters, and a panel that froze the
        // player would hold them still while one is hitting them (see the row's own comment).
        blocksMovement: false,
        quests: undefined,
      },
    ]);
  });

  it("stays quiet on every tile that is not an object", async () => {
    const { room, client, inbox } = await joinRoom(plaza.name);
    // Ten steps along the open spawn row, which owns no object by construction.
    for (let step = 0; step < 10; step++) {
      client.send(ClientMessage.Move, { dir: Direction.Left });
      await sleep(MOVE_COOLDOWN_MS);
    }
    await sleep(200);
    const at = room.state.players.get(client.sessionId);
    assert.ok(at && at.tileX < plaza.spawn.tileX, "precondition: the walker actually moved");
    assert.deepEqual(inbox.objects, []);
  });
});

describe("MetaverseRoom — quiz grading", () => {
  async function quizClient(): Promise<{ room: Room; client: ClientRoom; inbox: Inbox }> {
    const joined = await joinRoom(plaza.name);
    return joined;
  }

  it("grades the declared answer correct and returns the explanation", async () => {
    const { client, inbox } = await quizClient();
    client.send(ClientMessage.QuizAnswer, { objectId: QUIZ.id, choiceIndex: QUIZ.answerIndex });
    await waitUntil(() => inbox.quiz.length > 0, "a verdict");

    assert.deepEqual(inbox.quiz, [
      {
        objectId: QUIZ.id,
        choiceIndex: QUIZ.answerIndex,
        correct: true,
        explanation: QUIZ.explanation,
      },
    ]);
  });

  it("grades every other in-range choice wrong", async () => {
    const { client, inbox } = await quizClient();
    const wrong = QUIZ.choices.map((_, index) => index).filter((index) => index !== QUIZ.answerIndex);
    assert.ok(wrong.length > 0, "precondition: the quiz has a wrong answer to give");

    for (const choiceIndex of wrong) {
      client.send(ClientMessage.QuizAnswer, { objectId: QUIZ.id, choiceIndex });
    }
    await waitUntil(() => inbox.quiz.length === wrong.length, "a verdict per wrong choice");
    assert.deepEqual(
      inbox.quiz.map((result) => [result.choiceIndex, result.correct]),
      wrong.map((choiceIndex) => [choiceIndex, false]),
    );
  });

  it("grades an out-of-range choice wrong rather than ignoring it", async () => {
    // The client is waiting on this reply; silence would leave its panel grading forever.
    const { client, inbox } = await quizClient();
    for (const choiceIndex of [QUIZ.choices.length, -1, 9999, -9999]) {
      client.send(ClientMessage.QuizAnswer, { objectId: QUIZ.id, choiceIndex });
    }
    await waitUntil(() => inbox.quiz.length === 4, "a verdict for each out-of-range choice");
    assert.deepEqual(
      inbox.quiz.map((result) => result.correct),
      [false, false, false, false],
    );
  });

  it("grades an answer from a player standing nowhere near the tile", async () => {
    // Deliberate: the design keeps no interaction state, so requiring the tile would only add a
    // failure mode where stepping off mid-answer swallows the reply.
    const { room, client, inbox } = await quizClient();
    const at = room.state.players.get(client.sessionId);
    assert.ok(at);
    assert.notDeepEqual(
      { tileX: at.tileX, tileY: at.tileY },
      tileOf(QUIZ),
      "precondition: the player is at spawn, not on the quiz tile",
    );

    client.send(ClientMessage.QuizAnswer, { objectId: QUIZ.id, choiceIndex: QUIZ.answerIndex });
    await waitUntil(() => inbox.quiz.length > 0, "a verdict from off the tile");
    assert.equal(inbox.quiz[0]?.correct, true);
  });

  it("ignores an answer naming something that is not a quiz in this room", async () => {
    const { client, inbox } = await quizClient();
    for (const objectId of [LINK.id, NOTICE.id, "no-such-object", "", "__proto__", "constructor"]) {
      client.send(ClientMessage.QuizAnswer, { objectId, choiceIndex: 0 });
    }
    // Followed by one that does resolve, so the silence above is measured rather than assumed:
    // if the server were going to answer any of them it would have by the time this lands.
    client.send(ClientMessage.QuizAnswer, { objectId: QUIZ.id, choiceIndex: 0 });
    await waitUntil(() => inbox.quiz.length > 0, "the control verdict");
    await sleep(200);
    assert.deepEqual(
      inbox.quiz.map((result) => result.objectId),
      [QUIZ.id],
    );
  });

  it("ignores a malformed payload without answering and without dropping the connection", async () => {
    const { client, inbox } = await quizClient();
    const malformed: unknown[] = [
      { objectId: QUIZ.id, choiceIndex: 1.5 },
      { objectId: QUIZ.id, choiceIndex: Number.NaN },
      { objectId: QUIZ.id, choiceIndex: Number.POSITIVE_INFINITY },
      { objectId: QUIZ.id, choiceIndex: "1" },
      { objectId: QUIZ.id, choiceIndex: null },
      { objectId: QUIZ.id },
      { objectId: 7, choiceIndex: 0 },
      { objectId: null, choiceIndex: 0 },
      {},
    ];
    for (const payload of malformed) {
      client.send(ClientMessage.QuizAnswer, payload);
    }
    client.send(ClientMessage.QuizAnswer, { objectId: QUIZ.id, choiceIndex: QUIZ.answerIndex });
    await waitUntil(() => inbox.quiz.length > 0, "the control verdict after the malformed burst");
    await sleep(200);

    assert.equal(inbox.quiz.length, 1, `malformed answers were graded: ${JSON.stringify(inbox.quiz)}`);
    assert.equal(inbox.quiz[0]?.correct, true, "the connection still works after the burst");
  });

  it("ignores an answer for an object that belongs to another room", async () => {
    const grand = ROOM_DEFINITIONS.find((definition) => definition.name === "grand-plaza");
    assert.ok(grand);
    const { client, inbox } = await joinRoom(grand.name);

    client.send(ClientMessage.QuizAnswer, { objectId: QUIZ.id, choiceIndex: QUIZ.answerIndex });
    await sleep(400);
    assert.deepEqual(inbox.quiz, [], "a room with no objects graded another room's quiz");
  });

  it("answers a rapid burst one verdict per answer, in order", async () => {
    // No dedicated rate limit by design; Colyseus' maxMessagesPerSecond is the only cap, and a
    // burst under it must neither drop verdicts nor reorder them.
    const { client, inbox } = await quizClient();
    const burst = 20;
    for (let index = 0; index < burst; index++) {
      client.send(ClientMessage.QuizAnswer, {
        objectId: QUIZ.id,
        choiceIndex: index % QUIZ.choices.length,
      });
    }
    await waitUntil(() => inbox.quiz.length === burst, `all ${burst} verdicts`, 8000);
    assert.deepEqual(
      inbox.quiz.map((result) => result.choiceIndex),
      Array.from({ length: burst }, (_, index) => index % QUIZ.choices.length),
    );
    assert.deepEqual(
      inbox.quiz.map((result) => result.correct),
      Array.from({ length: burst }, (_, index) => index % QUIZ.choices.length === QUIZ.answerIndex),
    );
  });
});
