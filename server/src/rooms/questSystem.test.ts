import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Direction,
  InteractableKind,
  MONSTER_TICK_MS,
  PLAYER_ATTACK_DAMAGE,
  QuestStatus,
  ServerMessage,
  type CurrencyChanged,
  type InteractableEntered,
  type JoinOptions,
  type NpcInteraction,
  type QuestState,
  type TilePosition,
} from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryQuestStore, type QuestRow, type QuestStore } from "../db/questStore";
import { InMemorySettlementStore, type SettlementStore } from "../db/settlementStore";
import { TableInteractableIndex } from "../game/interactables";
import { TiledMapLoader } from "../game/tiledMap";
import type { CollisionMap, InteractableIndex, RoomCreateOptions } from "./contracts";
import { INTERACTABLE_DEFINITIONS } from "./interactableDefinitions";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";
import { QUEST_DEFINITIONS, validateQuestDefinitions, type QuestDefinition } from "./questDefinitions";

/**
 * Roadmap R03 step 3 (`docs/roadmap.md` §7, `docs/decisions.md` 2026-09-16): quest state is stored,
 * advanced by the kills it names, and still there after a rejoin — the step's own completion test
 * ("재접속 후 진행 유지, 해당 처치 이벤트만 갱신"). The store's contract is
 * `db/questStore.test.ts`; this file is about the room that drives it.
 *
 * Harness modeled on `levelSystem.test.ts` — a hand-driven room with no live timer and no
 * `@colyseus/testing` socket, because every case here needs an exact call count or an exact
 * sequence of kills.
 */

const OWNER = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
const OTHER_OWNER = "f1e2d3c4-b5a6-4789-9876-543210fedcba";
/** The authored row under test. Deliberately read from the real table: R03 ships exactly this one. */
const QUEST = QUEST_DEFINITIONS[0]!;
const GIVER_ROOM = "plaza";

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: {
    lastAttackAt: number;
    lastMoveAt: number;
    questRows: Map<string, QuestRow>;
    questRowsHydrated: boolean;
    ownerKey: string | null;
  };
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

/** One hit kills — this file is about the counter, not about how long a squirrel lives. */
const FIXTURE_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: PLAYER_ATTACK_DAMAGE,
      damage: 0,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 0,
      leashRadiusTiles: 0,
      respawnDelayMs: 1_000_000,
      expReward: 4,
      loot: [],
    },
  ],
  [
    MonsterKind.Rabbit,
    {
      kind: MonsterKind.Rabbit,
      maxHp: PLAYER_ATTACK_DAMAGE,
      damage: 0,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 0,
      leashRadiusTiles: 0,
      respawnDelayMs: 1_000_000,
      expReward: 4,
      loot: [],
    },
  ],
]);

const PLAZA_MAP = await new TiledMapLoader().load("plaza");

/** The giver's tile, read from the authored table rather than repeated here. */
const GIVER_TILE = ((): TilePosition => {
  const giver = INTERACTABLE_DEFINITIONS.find((object) => object.id === QUEST.giverObjectId);
  assert.ok(giver, `the object table has no "${QUEST.giverObjectId}"`);
  const tile = giver.at.tiles[0];
  assert.ok(tile);
  return tile;
})();

/** A walkable tile beside `at`, and the direction that steps from it onto `at`. */
function approach(at: TilePosition): { from: TilePosition; dir: Direction } {
  const candidates = [
    { from: { tileX: at.tileX - 1, tileY: at.tileY }, dir: Direction.Right },
    { from: { tileX: at.tileX + 1, tileY: at.tileY }, dir: Direction.Left },
    { from: { tileX: at.tileX, tileY: at.tileY - 1 }, dir: Direction.Down },
    { from: { tileX: at.tileX, tileY: at.tileY + 1 }, dir: Direction.Up },
  ];
  const found = candidates.find((candidate) => PLAZA_MAP.isWalkable(candidate.from.tileX, candidate.from.tileY));
  assert.ok(found, `(${at.tileX},${at.tileY}) has no walkable neighbour to step in from`);
  return found;
}

class QuestRoom extends MetaverseRoom {
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];

  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return this.fixtureSpawns;
  }

  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return FIXTURE_TYPES;
  }

  /**
   * A hand-constructed room has no Colyseus `roomName`, so the real narrowing would resolve to an
   * empty object table and the giver would stand nowhere. Naming the room here is what the
   * `createInteractableIndex` seam is for — the same thing `fixtureSpawns` does for monsters.
   */
  protected override createInteractableIndex(map: CollisionMap): InteractableIndex {
    return new TableInteractableIndex(GIVER_ROOM, INTERACTABLE_DEFINITIONS, map);
  }

  override setSimulationInterval(): void {
    // A live timer would mutate state mid-assertion; every case here drives the room itself.
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: GIVER_ROOM,
  mapKey: GIVER_ROOM,
  maxClients: 50,
  spawn: { tileX: 31, tileY: 20, spreadRadiusInTiles: 0 },
};

async function createRoom(
  overrides: Partial<RoomCreateOptions> = {},
  spawns: readonly MonsterSpawnDefinition[] = [],
): Promise<QuestRoom> {
  const room = new QuestRoom();
  room.fixtureSpawns = spawns;
  await room.onCreate({ ...ROOM_OPTIONS, ...overrides });
  return room;
}

function join(room: MetaverseRoom, sessionId: string, ssoUserId: string | null = OWNER): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  void room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0 } satisfies JoinOptions);
  return client;
}

function place(room: MetaverseRoom, sessionId: string, tile: TilePosition): void {
  const player = room.state.players.get(sessionId);
  assert.ok(player);
  player.tileX = tile.tileX;
  player.tileY = tile.tileY;
  room["proximityIndex"].move(sessionId, tile);
  room["refreshViewFor"](sessionId);
  room["refreshMonsterViewFor"](sessionId);
}

function attack(room: MetaverseRoom, client: FakeClient, at = 0): void {
  if (client.userData) {
    client.userData.lastAttackAt = at;
  }
  room["handleAttack"](asRoomClient(client));
}

function accept(room: MetaverseRoom, client: FakeClient, questId = QUEST.id): void {
  room["handleAcceptQuest"](asRoomClient(client), { questId });
}

/** Lets the fire-and-forget store calls settle before an assertion reads what they sent. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function questUpdates(client: FakeClient): QuestState[] {
  return sentOfType<QuestState>(client, ServerMessage.QuestUpdated);
}

function currencyChanges(client: FakeClient): CurrencyChanged[] {
  return sentOfType<CurrencyChanged>(client, ServerMessage.CurrencyChanged);
}

function dispose(room: MetaverseRoom): void {
  room.onDispose();
  room.setPatchRate(null);
}

/** Squirrels on walkable tiles beside the player, one per kill the case needs. */
function squirrelsBeside(at: TilePosition, count: number): readonly MonsterSpawnDefinition[] {
  const spawns: MonsterSpawnDefinition[] = [];
  for (let index = 0; index < count; index++) {
    spawns.push({
      id: `q-squirrel-${index}`,
      room: GIVER_ROOM,
      kind: MonsterKind.Squirrel,
      at: { tileX: at.tileX + 1, tileY: at.tileY },
      wanderRadiusTiles: 0,
    });
  }
  return spawns;
}

describe("the authored quest table", () => {
  it("passes its own boot validation against the real object and spawn tables", async () => {
    const { MONSTER_SPAWN_DEFINITIONS } = await import("./monsterDefinitions");
    const { errors, warnings } = validateQuestDefinitions(
      QUEST_DEFINITIONS,
      INTERACTABLE_DEFINITIONS,
      MONSTER_SPAWN_DEFINITIONS,
    );
    assert.deepEqual(errors, [], "boot would refuse to start");
    assert.deepEqual(warnings, []);
  });

  it("refuses a giver that is not there, is not an NPC, or a kind nothing spawns", () => {
    const giver = INTERACTABLE_DEFINITIONS.find((object) => object.kind === InteractableKind.Quiz);
    assert.ok(giver, "the fixture needs a non-npc object to point at");
    const { errors } = validateQuestDefinitions(
      [
        { ...QUEST, id: "ghost-giver", giverObjectId: "no-such-object" },
        { ...QUEST, id: "quiz-giver", giverObjectId: giver.id },
        { ...QUEST, id: "no-such-prey", objective: { kind: "phoenix" as MonsterKind, count: 1 } },
        { ...QUEST, id: "zero-kills", objective: { kind: MonsterKind.Squirrel, count: 0 } },
      ],
      INTERACTABLE_DEFINITIONS,
      // A squirrel spawn exists, so only the intended fault fires on each row.
      [{ id: "s", room: GIVER_ROOM, kind: MonsterKind.Squirrel, at: { tileX: 0, tileY: 0 }, wanderRadiusTiles: 0 }],
    );
    assert.equal(errors.length, 4, `expected exactly one error per row: ${errors}`);
    assert.ok(errors.some((error) => error.includes("no-such-object")));
    assert.ok(errors.some((error) => error.includes("rather than an npc")));
    assert.ok(errors.some((error) => error.includes("phoenix")));
    assert.ok(errors.some((error) => error.includes("not a positive integer")));
  });

  it("refuses two rows sharing an id", () => {
    const { errors } = validateQuestDefinitions(
      [QUEST, { ...QUEST }],
      INTERACTABLE_DEFINITIONS,
      [{ id: "s", room: GIVER_ROOM, kind: QUEST.objective.kind, at: { tileX: 0, tileY: 0 }, wanderRadiusTiles: 0 }],
    );
    assert.ok(errors.some((error) => error.includes("defined twice")), errors.join("; "));
  });
});

describe("the NPC panel", () => {
  it("offers the quest to an account that has never accepted it", async () => {
    const room = await createRoom({ questStore: new InMemoryQuestStore() });
    const client = join(room, "hunter");
    await flush();
    const { from, dir } = approach(GIVER_TILE);
    place(room, "hunter", from);
    room["handleMove"](asRoomClient(client), { dir });

    const panels = sentOfType<InteractableEntered>(client, ServerMessage.InteractableEntered);
    const npc = panels.find((panel) => panel.objectId === QUEST.giverObjectId);
    assert.ok(npc, `the step onto (${GIVER_TILE.tileX},${GIVER_TILE.tileY}) opened no panel`);
    assert.equal(npc.kind, InteractableKind.Npc);
    assert.deepEqual((npc as NpcInteraction).quests, [
      {
        questId: QUEST.id,
        title: QUEST.title,
        summary: QUEST.summary,
        objectiveText: QUEST.objectiveText,
        completionText: QUEST.completionText,
        status: QuestStatus.Offered,
        killCount: 0,
        requiredCount: QUEST.objective.count,
      } satisfies QuestState,
    ]);
    dispose(room);
  });

  it("carries no quests field for an NPC that gives none", async () => {
    const room = await createRoom({ questStore: new InMemoryQuestStore() });
    const other = INTERACTABLE_DEFINITIONS.find(
      (object) => object.at.room === GIVER_ROOM && object.id !== QUEST.giverObjectId,
    );
    assert.ok(other, "the plaza has another object to check against");
    const tile = other.at.tiles[0]!;
    const client = join(room, "hunter");
    await flush();
    const { from, dir } = approach(tile);
    place(room, "hunter", from);
    room["handleMove"](asRoomClient(client), { dir });

    const panel = sentOfType<InteractableEntered>(client, ServerMessage.InteractableEntered).find(
      (sent) => sent.objectId === other.id,
    );
    assert.ok(panel);
    assert.equal((panel as NpcInteraction).quests, undefined);
    dispose(room);
  });
});

describe("accepting a quest", () => {
  it("stores it and answers with the accepted state", async () => {
    const store = new InMemoryQuestStore();
    const room = await createRoom({ questStore: store });
    const client = join(room, "hunter");
    await flush();

    accept(room, client);
    await flush();

    assert.deepEqual(questUpdates(client), [
      {
        questId: QUEST.id,
        title: QUEST.title,
        summary: QUEST.summary,
        objectiveText: QUEST.objectiveText,
        completionText: QUEST.completionText,
        status: QuestStatus.Accepted,
        killCount: 0,
        requiredCount: QUEST.objective.count,
      } satisfies QuestState,
    ]);
    assert.deepEqual(await store.list(OWNER), [{ questId: QUEST.id, killCount: 0, completed: false }]);
    dispose(room);
  });

  it("is idempotent — a replayed accept never resets progress", async () => {
    const store = new InMemoryQuestStore();
    const room = await createRoom({ questStore: store }, squirrelsBeside(ROOM_OPTIONS.spawn, 1));
    const client = join(room, "hunter");
    await flush();
    accept(room, client);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;
    attack(room, client);
    await flush();

    accept(room, client);
    await flush();

    assert.deepEqual(questUpdates(client).at(-1)?.killCount, 1, "the second accept re-stated the row");
    assert.deepEqual(await store.list(OWNER), [{ questId: QUEST.id, killCount: 1, completed: false }]);
    dispose(room);
  });

  it("ignores a quest whose giver is in another room", async () => {
    const store = new InMemoryQuestStore();
    // hunting-ground has no giver: the object index resolves nothing, so `roomQuests` is empty.
    const room = await createRoom({
      questStore: store,
      roomType: "hunting-ground",
      mapKey: "hunting-ground",
      spawn: { tileX: 35, tileY: 25, spreadRadiusInTiles: 0 },
    });
    room["roomQuests"] = new Map();
    const client = join(room, "hunter");
    await flush();

    accept(room, client);
    await flush();

    assert.deepEqual(questUpdates(client), []);
    assert.deepEqual(await store.list(OWNER), [], "nothing was written for an unofferable quest");
    dispose(room);
  });

  it("ignores an unknown id and a malformed payload", async () => {
    const store = new InMemoryQuestStore();
    const room = await createRoom({ questStore: store });
    const client = join(room, "hunter");
    await flush();

    accept(room, client, "no-such-quest");
    room["handleAcceptQuest"](asRoomClient(client), { questId: 42 as unknown as string });
    await flush();

    assert.deepEqual(questUpdates(client), []);
    assert.deepEqual(await store.list(OWNER), []);
    dispose(room);
  });

  it("says nothing at all in a room built without a store", async () => {
    const room = await createRoom();
    const client = join(room, "hunter");
    await flush();
    accept(room, client);
    await flush();
    assert.deepEqual(questUpdates(client), [], "a room that cannot remember must not claim it did");
    dispose(room);
  });
});

describe("kills advancing a quest", () => {
  it("counts only up to the requirement, completes once, and then stops", async () => {
    const store = new InMemoryQuestStore();
    const required = QUEST.objective.count;
    const room = await createRoom(
      { questStore: store },
      squirrelsBeside(ROOM_OPTIONS.spawn, required + 1),
    );
    const client = join(room, "hunter");
    await flush();
    accept(room, client);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;

    for (let kill = 0; kill < required + 1; kill++) {
      attack(room, client);
      await flush();
    }

    const updates = questUpdates(client);
    assert.deepEqual(
      updates.map((update) => `${update.killCount}/${update.requiredCount} ${update.status}`),
      [
        `0/${required} ${QuestStatus.Accepted}`,
        `1/${required} ${QuestStatus.Accepted}`,
        `2/${required} ${QuestStatus.Accepted}`,
        `3/${required} ${QuestStatus.Completed}`,
      ],
      "the kill past the requirement must produce no fifth message",
    );
    assert.deepEqual(await store.list(OWNER), [{ questId: QUEST.id, killCount: required, completed: true }]);
    dispose(room);
  });

  it("credits nothing to an account that never accepted it", async () => {
    const store = new InMemoryQuestStore();
    const room = await createRoom({ questStore: store }, squirrelsBeside(ROOM_OPTIONS.spawn, 1));
    const client = join(room, "hunter");
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;

    attack(room, client);
    await flush();

    assert.deepEqual(questUpdates(client), []);
    assert.deepEqual(await store.list(OWNER), [], "a kill must not accept a quest on the player's behalf");
    dispose(room);
  });

  it("ignores a kill of a kind the quest does not name", async () => {
    const store = new InMemoryQuestStore();
    const room = await createRoom({ questStore: store }, [
      {
        id: "q-rabbit",
        room: GIVER_ROOM,
        kind: MonsterKind.Rabbit,
        at: { tileX: ROOM_OPTIONS.spawn.tileX + 1, tileY: ROOM_OPTIONS.spawn.tileY },
        wanderRadiusTiles: 0,
      },
    ]);
    const client = join(room, "hunter");
    await flush();
    accept(room, client);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;

    attack(room, client);
    await flush();

    assert.equal(questUpdates(client).length, 1, "only the accept — a rabbit is not a squirrel");
    assert.deepEqual(await store.list(OWNER), [{ questId: QUEST.id, killCount: 0, completed: false }]);
    dispose(room);
  });

  it("credits the killer's account and nobody else's", async () => {
    const store = new InMemoryQuestStore();
    const room = await createRoom({ questStore: store }, squirrelsBeside(ROOM_OPTIONS.spawn, 1));
    const killer = join(room, "killer", OWNER);
    const bystander = join(room, "bystander", OTHER_OWNER);
    await flush();
    accept(room, killer);
    accept(room, bystander);
    await flush();
    place(room, "killer", ROOM_OPTIONS.spawn);
    room.state.players.get("killer")!.facing = Direction.Right;

    attack(room, killer);
    await flush();

    assert.equal(questUpdates(killer).at(-1)?.killCount, 1);
    assert.equal(questUpdates(bystander).at(-1)?.killCount, 0, "standing nearby is not hunting");
    assert.deepEqual(await store.list(OTHER_OWNER), [{ questId: QUEST.id, killCount: 0, completed: false }]);
    dispose(room);
  });

  it("credits the account even when the killer left before the store answered", async () => {
    const store = new InMemoryQuestStore();
    const room = await createRoom({ questStore: store }, squirrelsBeside(ROOM_OPTIONS.spawn, 1));
    const client = join(room, "hunter");
    await flush();
    accept(room, client);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;

    attack(room, client);
    room.onLeave(asRoomClient(client));
    await flush();

    assert.deepEqual(
      await store.list(OWNER),
      [{ questId: QUEST.id, killCount: 1, completed: false }],
      "the kill belongs to the account, not to the session that walked out",
    );
    dispose(room);
  });
});

describe("rejoining", () => {
  it("hands a returning account its stored progress", async () => {
    const store = new InMemoryQuestStore();
    const required = QUEST.objective.count;
    const room = await createRoom({ questStore: store }, squirrelsBeside(ROOM_OPTIONS.spawn, 1));
    const first = join(room, "hunter");
    await flush();
    accept(room, first);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;
    attack(room, first);
    await flush();
    room.onLeave(asRoomClient(first));

    const second = join(room, "hunter-again", OWNER);
    await flush();

    assert.deepEqual(questUpdates(second), [
      {
        questId: QUEST.id,
        title: QUEST.title,
        summary: QUEST.summary,
        objectiveText: QUEST.objectiveText,
        completionText: QUEST.completionText,
        status: QuestStatus.Accepted,
        killCount: 1,
        requiredCount: required,
      } satisfies QuestState,
    ]);
    dispose(room);
  });

  it("keeps asking the store for a quest the cache has not been told about yet", async () => {
    // The hydration read is held open while the session accepts and then kills. An accept landing
    // in that window fills the cache with *one* row, which says nothing about any other quest —
    // treating a non-empty cache as a complete one drops that kill permanently, since the store is
    // the only thing that ever credits it. R03 authors exactly one quest, so the second quest is
    // stood in for by removing the accepted row: same cache state, one authored row to build it.
    let releaseHydration: ((rows: readonly QuestRow[]) => void) | undefined;
    const held = new Promise<readonly QuestRow[]>((resolve) => {
      releaseHydration = resolve;
    });
    let killCalls = 0;
    const inner = new InMemoryQuestStore();
    const holding: QuestStore = {
      list: () => held,
      accept: (ownerKey, questId) => inner.accept(ownerKey, questId),
      recordKill: (ownerKey, questId, required) => {
        killCalls += 1;
        return inner.recordKill(ownerKey, questId, required);
      },
    };
    const room = await createRoom({ questStore: holding }, squirrelsBeside(ROOM_OPTIONS.spawn, 1));
    const client = join(room, "hunter");
    await flush();
    accept(room, client);
    await flush();
    assert.equal(client.userData?.questRowsHydrated, false, "the hydration read is still open");
    assert.equal(client.userData?.questRows.size, 1, "and the accept has already written to the cache");
    client.userData!.questRows.delete(QUEST.id);

    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;
    attack(room, client);
    await flush();

    assert.equal(killCalls, 1, "an unhydrated cache must never answer 'not accepted' on its own");
    releaseHydration?.([]);
    await flush();
    assert.equal(client.userData?.questRowsHydrated, true);
    dispose(room);
  });

  it("tells a fresh account nothing, and asks the store nothing more per kill", async () => {
    let listCalls = 0;
    let killCalls = 0;
    const inner = new InMemoryQuestStore();
    const counting: QuestStore = {
      list: (ownerKey) => {
        listCalls += 1;
        return inner.list(ownerKey);
      },
      accept: (ownerKey, questId) => inner.accept(ownerKey, questId),
      recordKill: (ownerKey, questId, required) => {
        killCalls += 1;
        return inner.recordKill(ownerKey, questId, required);
      },
    };
    const room = await createRoom({ questStore: counting }, squirrelsBeside(ROOM_OPTIONS.spawn, 1));
    const client = join(room, "hunter");
    await flush();
    assert.equal(listCalls, 1, "one hydration read per join");
    assert.deepEqual(questUpdates(client), [], "nothing accepted, nothing to say");

    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;
    attack(room, client);
    await flush();

    assert.equal(
      killCalls,
      0,
      "a hydrated session with no accepted quest must not touch the store on a kill",
    );
    dispose(room);
  });
});

describe("quest completion rewards (roadmap R04-b)", () => {
  const REWARD = QUEST.reward;
  assert.ok(REWARD, "the fixture needs the authored table's own reward");

  it("settles the reward exactly once, the moment the kill completes it", async () => {
    const questStore = new InMemoryQuestStore();
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    const required = QUEST.objective.count;
    const room = await createRoom(
      { questStore, currencyStore, settlementStore },
      squirrelsBeside(ROOM_OPTIONS.spawn, required),
    );
    const client = join(room, "hunter");
    await flush();
    accept(room, client);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;

    for (let kill = 0; kill < required; kill++) {
      attack(room, client);
      await flush();
    }

    assert.equal(await currencyStore.getBalance(OWNER), REWARD.currencyDelta);
    assert.deepEqual(
      currencyChanges(client).filter((change) => change.reason === "quest"),
      [{ balance: REWARD.currencyDelta, delta: REWARD.currencyDelta, reason: "quest" }],
      "exactly one reward notice, for exactly the kill that completed it",
    );
    dispose(room);
  });

  it("never double-credits a rejoin retry of an already-settled quest", async () => {
    const questStore = new InMemoryQuestStore();
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    const required = QUEST.objective.count;
    const room = await createRoom(
      { questStore, currencyStore, settlementStore },
      squirrelsBeside(ROOM_OPTIONS.spawn, required),
    );
    const first = join(room, "hunter");
    await flush();
    accept(room, first);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;
    for (let kill = 0; kill < required; kill++) {
      attack(room, first);
      await flush();
    }
    assert.equal(await currencyStore.getBalance(OWNER), REWARD.currencyDelta);
    room.onLeave(asRoomClient(first));

    // Rejoining re-hydrates the already-completed row and retries the settlement (design §4 D6) —
    // this is what asserts the ledger's own idempotency actually holds here: the balance must not
    // move a second time, and the retry must not re-announce a reward the first session already got.
    const second = join(room, "hunter-again", OWNER);
    await flush();

    assert.equal(
      await currencyStore.getBalance(OWNER),
      REWARD.currencyDelta,
      "a retry is a no-op replay, never a second credit",
    );
    assert.deepEqual(
      currencyChanges(second).filter((change) => change.reason === "quest"),
      [],
      "the retry is silent — hydrateCurrencyCache's own join-time sync already carries the right number",
    );
    dispose(room);
  });

  it("announces the balance a join-time retry paid out, on that same join", async () => {
    const questStore = new InMemoryQuestStore();
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    // Exactly the state design §4 D6's retry exists for: the row is complete in the store, but the
    // completion never got as far as settling it. Built against the store directly, which is what
    // a process restart between `recordKill` committing and `settleQuestReward`'s own await
    // landing leaves behind.
    await questStore.accept(OWNER, QUEST.id);
    for (let kill = 0; kill < QUEST.objective.count; kill++) {
      await questStore.recordKill(OWNER, QUEST.id, QUEST.objective.count);
    }
    assert.equal(await currencyStore.getBalance(OWNER), 0, "precondition: nothing was settled");

    const room = await createRoom(
      { questStore, currencyStore, settlementStore },
      squirrelsBeside(ROOM_OPTIONS.spawn, 1),
    );
    const client = join(room, "hunter");
    await flush();

    assert.equal(
      await currencyStore.getBalance(OWNER),
      REWARD.currencyDelta,
      "precondition: the join-time retry did pay out",
    );
    // The regression this case exists for: the join-time balance read is one hop and the retry is
    // at least two, so fired in parallel the sync reliably announced the pre-settlement balance and
    // stayed wrong until the next join — the retry itself is deliberately silent.
    assert.deepEqual(
      currencyChanges(client).map((change) => ({ balance: change.balance, reason: change.reason })),
      [{ balance: REWARD.currencyDelta, reason: "sync" }],
      "the join's only balance notice carries what the retry settled, not the balance before it",
    );
    dispose(room);
  });

  it("makes no settlement call at all for a quest with no reward, even once it completes", async () => {
    const questStore = new InMemoryQuestStore();
    let settleCalls = 0;
    const countingSettlementStore: SettlementStore = {
      settle: () => {
        settleCalls += 1;
        return Promise.resolve({ ok: true, balance: 0, items: [] });
      },
    };
    const room = await createRoom({ questStore, settlementStore: countingSettlementStore });
    const noRewardQuest: QuestDefinition = { ...QUEST, id: "no-reward-quest", reward: undefined };

    await questStore.accept(OWNER, noRewardQuest.id);
    // Walked to one kill short of completion directly against the store, so the single call under
    // test below is the one that actually flips `completed` — the exact condition
    // `MetaverseRoom.recordQuestKill` gates its settlement call on.
    for (let kill = 0; kill < noRewardQuest.objective.count - 1; kill++) {
      await questStore.recordKill(OWNER, noRewardQuest.id, noRewardQuest.objective.count);
    }

    await room["recordQuestKill"]({ sessionId: "hunter", ownerKey: OWNER }, noRewardQuest, questStore);
    await flush();

    const rows = await questStore.list(OWNER);
    assert.equal(
      rows.find((row) => row.questId === noRewardQuest.id)?.completed,
      true,
      "precondition: the quest is actually complete now",
    );
    assert.equal(settleCalls, 0, "a rewardless quest must never call settle at all");
    dispose(room);
  });

  it("skips settlement outright for an account with no SSO identity, without throwing", async () => {
    const questStore = new InMemoryQuestStore();
    const currencyStore = new InMemoryCurrencyStore();
    const settlementStore = new InMemorySettlementStore(currencyStore);
    const required = QUEST.objective.count;
    const room = await createRoom(
      { questStore, currencyStore, settlementStore },
      squirrelsBeside(ROOM_OPTIONS.spawn, required),
    );
    const client = join(room, "hunter", null);
    await flush();
    accept(room, client);
    await flush();
    place(room, "hunter", ROOM_OPTIONS.spawn);
    room.state.players.get("hunter")!.facing = Direction.Right;

    for (let kill = 0; kill < required; kill++) {
      attack(room, client);
      await flush();
    }

    assert.deepEqual(
      currencyChanges(client).filter((change) => change.reason === "quest"),
      [],
      "no real account, no settlement, no reward notice",
    );
    // `settlementStore.settle` would have thrown on a non-uuid ownerKey (`assertUuidOwnerKey`) had
    // this codebase fallen back to the session id the way loot/EXP/quest-progress do; reaching
    // here at all is the assertion that it did not.
    dispose(room);
  });
});
