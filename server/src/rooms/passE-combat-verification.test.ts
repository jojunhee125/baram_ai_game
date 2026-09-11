import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATTACK_COOLDOWN_MS,
  COMBAT_EXIT_MS,
  COMBAT_RECOVERY_HP_PER_TICK,
  Direction,
  MONSTER_TICK_MS,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HP,
  ServerMessage,
  VIEW_RADIUS_TILES,
  type EquipmentSlot,
  type ItemGranted,
  type JoinOptions,
  type MonsterHit,
  type PlayerHit,
  type Teleported,
  type TilePosition,
} from "@zep-test/shared";
import { InMemoryInventoryStore, type InventoryStore } from "../db/inventoryStore";
import { rollLoot } from "../game/loot";
import type { CollisionMap, ProximityIndex, RoomCreateOptions } from "./contracts";
import { MetaverseRoom } from "./metaverseRoom";
import { MonsterKind, type MonsterSpawnDefinition, type MonsterType } from "./monsterDefinitions";

type RoomClient = Parameters<MetaverseRoom["onJoin"]>[0];

interface SentMessage {
  type: string;
  payload: unknown;
}

interface FakeClient {
  sessionId: string;
  auth: { ssoNickname: string | null; ssoUserId: string | null };
  userData?: { lastMoveAt: number; lastAttackAt: number; hp: number; lastDamagedAt: number };
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
  return client.sent
    .filter((message) => message.type === type)
    .map((message) => message.payload as T);
}

function asRoomClient(client: FakeClient): RoomClient {
  return client as unknown as RoomClient;
}

const OPEN_CENTRE: TilePosition = { tileX: 78, tileY: 70 };

const FIXTURE_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: 8,
      damage: 3,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 6,
      leashRadiusTiles: 10,
      respawnDelayMs: MONSTER_TICK_MS * 5,
      expReward: 4,
      loot: [
        { itemKey: "acorn", chance: 1, quantity: 2 },
        { itemKey: "herb", chance: 0.0001, quantity: 1 },
      ],
    },
  ],
  [
    // A second kind, distinct from Squirrel, whose loot rows are *both* certain hits — needed to
    // exercise "one grant throws, the other still lands" (a single-loot-row fixture cannot).
    MonsterKind.Rabbit,
    {
      kind: MonsterKind.Rabbit,
      maxHp: 8,
      damage: 3,
      attackCooldownMs: MONSTER_TICK_MS,
      wanderStepIntervalMs: MONSTER_TICK_MS,
      chaseStepIntervalMs: MONSTER_TICK_MS,
      aggroRadiusTiles: 6,
      leashRadiusTiles: 10,
      respawnDelayMs: MONSTER_TICK_MS * 5,
      expReward: 7,
      loot: [
        { itemKey: "acorn", chance: 1, quantity: 1 },
        { itemKey: "herb", chance: 1, quantity: 1 },
      ],
    },
  ],
]);

class VerifyRoom extends MetaverseRoom {
  fixtureSpawns: readonly MonsterSpawnDefinition[] = [];
  /** Fixed draw: every loot line with chance 1 hits, everything below 0.5 misses. */
  randomValue = 0.5;

  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return this.fixtureSpawns;
  }

  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> {
    return FIXTURE_TYPES;
  }

  protected override random(): number {
    return this.randomValue;
  }

  protected override createMonsterIndex(map: CollisionMap): ProximityIndex {
    return super.createMonsterIndex(map);
  }

  override setSimulationInterval(): void {
    // A live timer would mutate state mid-assertion; every test drives `tick` itself.
  }
}

const ROOM_OPTIONS: RoomCreateOptions = {
  roomType: "verify-combat",
  mapKey: "grand-plaza",
  maxClients: 500,
  spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 0 },
};

function spawnAt(id: string, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind: MonsterKind.Squirrel, at, wanderRadiusTiles: 0 };
}

function spawnRabbitAt(id: string, at: TilePosition): MonsterSpawnDefinition {
  return { id, room: ROOM_OPTIONS.roomType, kind: MonsterKind.Rabbit, at, wanderRadiusTiles: 0 };
}

async function createRoom(
  spawns: readonly MonsterSpawnDefinition[],
  store?: InventoryStore,
): Promise<VerifyRoom> {
  const room = new VerifyRoom();
  room.fixtureSpawns = spawns;
  await room.onCreate({ ...ROOM_OPTIONS, inventoryStore: store });
  return room;
}

function join(
  room: MetaverseRoom,
  sessionId: string,
  options?: Partial<JoinOptions>,
  ssoUserId: string | null = null,
): FakeClient {
  const client = fakeClient(sessionId, ssoUserId);
  room.onJoin(asRoomClient(client), { nickname: sessionId, avatarSkin: 0, ...options });
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

function face(room: MetaverseRoom, sessionId: string, dir: Direction): void {
  const player = room.state.players.get(sessionId);
  assert.ok(player);
  player.facing = dir;
}

function attack(room: MetaverseRoom, client: FakeClient, at?: number): void {
  if (at !== undefined && client.userData) {
    client.userData.lastAttackAt = at;
  }
  room["handleAttack"](asRoomClient(client));
}

/** Lets a fire-and-forget `awardLoot` settle before the assertion reads what it sent. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dispose(room: MetaverseRoom): void {
  room.setPatchRate(null);
}

describe("VERIFY rollLoot", () => {
  it("rolls each row independently, in input order", () => {
    const draws = [0.9, 0.1, 0.4];
    let index = 0;
    const grants = rollLoot(
      [
        { itemKey: "a", chance: 0.5, quantity: 1 },
        { itemKey: "b", chance: 0.5, quantity: 3 },
        { itemKey: "c", chance: 0.5, quantity: 1 },
      ],
      () => draws[index++] ?? 1,
    );
    assert.deepEqual(grants, [
      { itemKey: "b", quantity: 3 },
      { itemKey: "c", quantity: 1 },
    ]);
    assert.equal(index, 3, "one draw per row, hit or miss");
  });

  it("can yield nothing and can yield everything", () => {
    const entries = [
      { itemKey: "a", chance: 0.6, quantity: 1 },
      { itemKey: "b", chance: 0.6, quantity: 1 },
    ];
    assert.deepEqual(rollLoot(entries, () => 0.99), []);
    assert.equal(rollLoot(entries, () => 0).length, 2);
    assert.deepEqual(rollLoot([], () => 0), []);
  });

  it("matches the declared frequency over 10000 rolls and replays a seed exactly", () => {
    const seeded = (seed: number): (() => number) => {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const entries = [
      { itemKey: "common", chance: 0.6, quantity: 1 },
      { itemKey: "rare", chance: 0.03, quantity: 1 },
    ];
    const counts = new Map<string, number>();
    const random = seeded(0x0badf00d);
    for (let index = 0; index < 10_000; index++) {
      for (const grant of rollLoot(entries, random)) {
        counts.set(grant.itemKey, (counts.get(grant.itemKey) ?? 0) + 1);
      }
    }
    const common = (counts.get("common") ?? 0) / 10_000;
    const rare = (counts.get("rare") ?? 0) / 10_000;
    assert.ok(Math.abs(common - 0.6) < 0.02, `common frequency ${common}`);
    assert.ok(Math.abs(rare - 0.03) < 0.01, `rare frequency ${rare}`);

    const first = rollLoot(entries, seeded(42));
    const second = rollLoot(entries, seeded(42));
    assert.deepEqual(first, second, "the same seed replays the same sequence");
  });
});

describe("VERIFY handleAttack", () => {
  it("damages the faced monster, fans MonsterHit out to viewers, and records last-hit", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const behind = { tileX: OPEN_CENTRE.tileX - 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([spawnAt("m-faced", faced), spawnAt("m-behind", behind)]);
    try {
      const attacker = join(room, "attacker");
      const watcher = join(room, "watcher");
      const distant = join(room, "distant");
      place(room, "attacker", OPEN_CENTRE);
      place(room, "watcher", { tileX: OPEN_CENTRE.tileX + 5, tileY: OPEN_CENTRE.tileY });
      place(room, "distant", { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY - 40 });
      face(room, "attacker", Direction.Right);

      attack(room, attacker, 0);

      const runtime = room["monsterRuntimes"].get("m-faced");
      assert.ok(runtime);
      assert.equal(runtime.hp, 8 - PLAYER_ATTACK_DAMAGE, "the faced monster took the hit");
      assert.equal(room["monsterRuntimes"].get("m-behind")?.hp, 8, "the one behind was not touched");
      assert.deepEqual(runtime.lastHitBy, { sessionId: "attacker", ownerKey: null });

      const hits = sentOfType<MonsterHit>(attacker, ServerMessage.MonsterHit);
      assert.equal(hits.length, 1);
      assert.deepEqual(hits[0], {
        monsterId: "m-faced",
        bySessionId: "attacker",
        damage: PLAYER_ATTACK_DAMAGE,
        hpRemaining: 4,
        hpMax: 8,
      });
      assert.equal(
        sentOfType<MonsterHit>(watcher, ServerMessage.MonsterHit).length,
        1,
        "a bystander inside the monster's view radius is told",
      );
      assert.equal(
        sentOfType<MonsterHit>(distant, ServerMessage.MonsterHit).length,
        0,
        "a player 40 tiles away is not",
      );
      assert.ok(
        chebyshevOf({ tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY - 40 }, faced) >
          VIEW_RADIUS_TILES,
        "precondition: the distant player really is out of range",
      );
    } finally {
      dispose(room);
    }
  });

  it("prefers the faced tile over a nearer candidate and breaks ties by monster id", async () => {
    const sameTile = OPEN_CENTRE;
    const facedTile = { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY - 1 };
    const room = await createRoom([spawnAt("m-zz-same", sameTile), spawnAt("m-aa-faced", facedTile)]);
    try {
      const attacker = join(room, "attacker");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Up);

      attack(room, attacker, 0);
      assert.equal(
        room["monsterRuntimes"].get("m-aa-faced")?.hp,
        4,
        "the faced tile wins even though the other shares the attacker's own tile (distance 0)",
      );

      // Now face away from both: two candidates at distance 0 and 1, nearest wins.
      face(room, "attacker", Direction.Down);
      attack(room, attacker, 0);
      assert.equal(room["monsterRuntimes"].get("m-zz-same")?.hp, 4, "distance 0 beats distance 1");

      // Two on the same tile, neither faced: the lower id wins, every time.
      const tie = await createRoom([spawnAt("m-b", sameTile), spawnAt("m-a", sameTile)]);
      try {
        const swinger = join(tie, "swinger");
        place(tie, "swinger", OPEN_CENTRE);
        face(tie, "swinger", Direction.Down);
        attack(tie, swinger, 0);
        assert.equal(tie["monsterRuntimes"].get("m-a")?.hp, 4, "m-a is chosen");
        assert.equal(tie["monsterRuntimes"].get("m-b")?.hp, 8, "m-b is not");
      } finally {
        dispose(tie);
      }
    } finally {
      dispose(room);
    }
  });

  it("drops a swing inside the cooldown in silence, and accepts one exactly on the boundary", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([spawnAt("m", faced)]);
    try {
      const attacker = join(room, "attacker");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);
      const now = Date.now();

      attack(room, attacker, now - ATTACK_COOLDOWN_MS);
      assert.equal(room["monsterRuntimes"].get("m")?.hp, 4, "the boundary swing is accepted");
      const after = attacker.sent.length;

      attack(room, attacker);
      assert.equal(room["monsterRuntimes"].get("m")?.hp, 4, "the immediate follow-up does nothing");
      assert.equal(attacker.sent.length, after, "and says nothing at all — not even a rejection");
    } finally {
      dispose(room);
    }
  });

  it("answers a swing that reaches nothing with silence, and never touches a monsterless room", async () => {
    const far = { tileX: OPEN_CENTRE.tileX + 6, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([spawnAt("m", far)]);
    try {
      const attacker = join(room, "attacker");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);
      attack(room, attacker, 0);
      assert.equal(attacker.sent.length, 0, "an empty swing is answered with nothing");
      assert.equal(room["monsterRuntimes"].get("m")?.hp, 8);
    } finally {
      dispose(room);
    }

    const bare = await createRoom([]);
    try {
      const attacker = join(bare, "attacker");
      assert.equal(bare["hasMonsters"], false, "precondition: no monsters were built");
      attack(bare, attacker, 0);
      assert.equal(attacker.sent.length, 0, "and no monster index was reached for");
    } finally {
      dispose(bare);
    }
  });

  it("kills, drops, credits the account and tells the killer", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", faced)], store);
    try {
      const attacker = join(room, "attacker", undefined, "sso-user-1");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);
      assert.equal(attacker.userData?.hp, PLAYER_MAX_HP, "full health on arrival");

      attack(room, attacker, 0);
      attack(room, attacker, 0);
      await flush();

      const hits = sentOfType<MonsterHit>(attacker, ServerMessage.MonsterHit);
      assert.equal(hits.length, 2);
      assert.equal(hits[1]?.hpRemaining, 0, "the killing blow reports 0 — the death notice");
      assert.equal(room.state.monsters.has("m"), false, "the monster left the map");
      assert.equal(room["monsterRuntimes"].get("m")?.state, "dead");

      const granted = sentOfType<ItemGranted>(attacker, ServerMessage.ItemGranted);
      assert.equal(granted.length, 1, "the 1.0 row dropped, the 0.0001 row did not");
      assert.deepEqual(granted[0], {
        itemKey: "acorn",
        name: "도토리",
        icon: "acorn",
        quantity: 2,
        total: 2,
        damageReductionRatio: undefined,
      });
      assert.deepEqual(await store.list("sso-user-1"), [{ itemKey: "acorn", quantity: 2, equipped: false }]);
      assert.deepEqual(await store.list("attacker"), [], "credited to the account, not the session");
    } finally {
      dispose(room);
    }
  });

  it("still credits a killer who left the room, and sends them nothing", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", faced)], store);
    try {
      const attacker = join(room, "attacker", undefined, "sso-user-2");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);

      attack(room, attacker, 0);
      attack(room, attacker, 0);
      room.onLeave(asRoomClient(attacker));
      await flush();

      assert.deepEqual(await store.list("sso-user-2"), [{ itemKey: "acorn", quantity: 2, equipped: false }]);
      assert.equal(
        sentOfType<ItemGranted>(attacker, ServerMessage.ItemGranted).length,
        0,
        "nothing is sent to a session that is gone",
      );
    } finally {
      dispose(room);
    }
  });

  it("files a drop under the session id when there is no SSO, and skips it with no store", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", faced)], store);
    try {
      const attacker = join(room, "attacker");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);
      attack(room, attacker, 0);
      attack(room, attacker, 0);
      await flush();
      assert.deepEqual(await store.list("attacker"), [{ itemKey: "acorn", quantity: 2, equipped: false }]);
    } finally {
      dispose(room);
    }

    const storeless = await createRoom([spawnAt("m", faced)]);
    try {
      const attacker = join(storeless, "attacker");
      place(storeless, "attacker", OPEN_CENTRE);
      face(storeless, "attacker", Direction.Right);
      attack(storeless, attacker, 0);
      attack(storeless, attacker, 0);
      await flush();
      assert.equal(storeless.state.monsters.has("m"), false, "the kill still resolves");
      assert.equal(
        sentOfType<ItemGranted>(attacker, ServerMessage.ItemGranted).length,
        0,
        "and credits nothing",
      );
    } finally {
      dispose(storeless);
    }
  });
});

describe("VERIFY monster damage, death and recovery", () => {
  it("unicasts PlayerHit to the victim only", async () => {
    const room = await createRoom([spawnAt("m", OPEN_CENTRE)]);
    try {
      const victim = join(room, "victim");
      const bystander = join(room, "bystander");
      place(room, "victim", OPEN_CENTRE);
      place(room, "bystander", { tileX: OPEN_CENTRE.tileX + 2, tileY: OPEN_CENTRE.tileY });

      room["tick"](1000);

      const hits = sentOfType<PlayerHit>(victim, ServerMessage.PlayerHit);
      assert.equal(hits.length, 1);
      assert.deepEqual(hits[0], {
        monsterId: "m",
        damage: 3,
        hpRemaining: PLAYER_MAX_HP - 3,
        hpMax: PLAYER_MAX_HP,
      });
      assert.equal(victim.userData?.hp, PLAYER_MAX_HP - 3);
      assert.equal(victim.userData?.lastDamagedAt, 1000);
      assert.equal(
        sentOfType<PlayerHit>(bystander, ServerMessage.PlayerHit).length,
        0,
        "nobody sees anybody else's number",
      );
    } finally {
      dispose(room);
    }
  });

  it("sends the player home at 0 HP with full health and no loss", async () => {
    const room = await createRoom([spawnAt("m", OPEN_CENTRE)]);
    try {
      const victim = join(room, "victim");
      place(room, "victim", OPEN_CENTRE);
      assert.ok(victim.userData);
      victim.userData.hp = 3;

      room["tick"](1000);

      const hits = sentOfType<PlayerHit>(victim, ServerMessage.PlayerHit);
      assert.equal(hits.at(-1)?.hpRemaining, 0, "0 is the death notice");
      assert.equal(victim.userData.hp, PLAYER_MAX_HP, "and revival is immediate and total");

      const teleported = sentOfType<Teleported>(victim, ServerMessage.Teleported);
      assert.equal(teleported.length, 1, "the move reuses the existing Teleported message");
      assert.deepEqual(teleported[0], {
        tileX: ROOM_OPTIONS.spawn.tileX,
        tileY: ROOM_OPTIONS.spawn.tileY,
        facing: Direction.Down,
      });
      const player = room.state.players.get("victim");
      assert.equal(player?.tileX, ROOM_OPTIONS.spawn.tileX);
      assert.equal(player?.tileY, ROOM_OPTIONS.spawn.tileY);
      assert.ok(
        room["viewedBySession"].get("victim")?.has("victim"),
        "the index was moved before the view was rebuilt — the player still sees themselves",
      );
    } finally {
      dispose(room);
    }
  });

  it("recovers only after COMBAT_EXIT_MS and never past full health", async () => {
    const room = await createRoom([spawnAt("m", { tileX: OPEN_CENTRE.tileX + 30, tileY: OPEN_CENTRE.tileY })]);
    try {
      const hurt = join(room, "hurt");
      const whole = join(room, "whole");
      place(room, "hurt", OPEN_CENTRE);
      place(room, "whole", { tileX: OPEN_CENTRE.tileX + 2, tileY: OPEN_CENTRE.tileY });
      assert.ok(hurt.userData && whole.userData);
      hurt.userData.hp = PLAYER_MAX_HP - COMBAT_RECOVERY_HP_PER_TICK * 2;
      hurt.userData.lastDamagedAt = 1000;

      room["tick"](1000 + COMBAT_EXIT_MS - 1);
      assert.equal(
        hurt.userData.hp,
        PLAYER_MAX_HP - COMBAT_RECOVERY_HP_PER_TICK * 2,
        "one millisecond early is still in combat",
      );

      room["tick"](1000 + COMBAT_EXIT_MS);
      assert.equal(
        hurt.userData.hp,
        PLAYER_MAX_HP - COMBAT_RECOVERY_HP_PER_TICK,
        "exactly on the boundary it starts coming back",
      );
      room["tick"](1000 + COMBAT_EXIT_MS + MONSTER_TICK_MS);
      assert.equal(hurt.userData.hp, PLAYER_MAX_HP);
      room["tick"](1000 + COMBAT_EXIT_MS + MONSTER_TICK_MS * 2);
      assert.equal(hurt.userData.hp, PLAYER_MAX_HP, "and never goes past it");

      assert.equal(hurt.sent.length, 0, "recovery is silent — the client draws the same curve");
      assert.equal(whole.userData.hp, PLAYER_MAX_HP, "a never-hit player is left alone");
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY the random seam now owns spawn sampling", () => {
  it("places a spread spawn from the subclass's generator, with the global untouched", async () => {
    const room = new VerifyRoom();
    // 0.5 * 9 = 4.5 -> floor 4; centre - 4 + 4 = the centre tile itself, deterministically.
    room.randomValue = 0.5;
    await room.onCreate({
      ...ROOM_OPTIONS,
      spawn: { tileX: OPEN_CENTRE.tileX, tileY: OPEN_CENTRE.tileY, spreadRadiusInTiles: 4 },
    });
    try {
      join(room, "a");
      assert.deepEqual(
        { tileX: room.state.players.get("a")?.tileX, tileY: room.state.players.get("a")?.tileY },
        OPEN_CENTRE,
        "the override decided the tile, so Math.random no longer has to be swapped out",
      );

      room.randomValue = 0;
      join(room, "b");
      assert.deepEqual(
        { tileX: room.state.players.get("b")?.tileX, tileY: room.state.players.get("b")?.tileY },
        { tileX: OPEN_CENTRE.tileX - 4, tileY: OPEN_CENTRE.tileY - 4 },
        "and a different draw moves it",
      );
    } finally {
      dispose(room);
    }
  });
});

// -- The rows below are tester-authored (E4), added on top of coder's self-check harness above
// after independent review against docs/design-hunting-inventory.md §6. They target gaps the
// handoff flagged (a real store.add() throw, not just "no store") plus two paths the original
// harness did not reach at all: last-hit changing hands between two different attackers, and the
// MonsterHit fan-out's own radius boundary.

describe("VERIFY last-hit changes hands between two different attackers", () => {
  it("credits only the killer, even though an earlier attacker did most of the damage", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new InMemoryInventoryStore();
    const room = await createRoom([spawnAt("m", faced)], store);
    try {
      const first = join(room, "first", undefined, "sso-user-first");
      const second = join(room, "second", undefined, "sso-user-second");
      place(room, "first", OPEN_CENTRE);
      face(room, "first", Direction.Right);
      // Approaches the same monster from the far side — distance 1, so it is a valid target too.
      place(room, "second", { tileX: OPEN_CENTRE.tileX + 2, tileY: OPEN_CENTRE.tileY });
      face(room, "second", Direction.Left);

      attack(room, first, 0);
      assert.equal(room["monsterRuntimes"].get("m")?.hp, 4, "first attacker's hit landed");
      assert.deepEqual(room["monsterRuntimes"].get("m")?.lastHitBy, {
        sessionId: "first",
        ownerKey: "sso-user-first",
      });

      attack(room, second, 0);
      await flush();

      assert.equal(room.state.monsters.has("m"), false, "the second attacker's hit finished it");
      assert.equal(
        sentOfType<ItemGranted>(first, ServerMessage.ItemGranted).length,
        0,
        "the attacker who did not land the killing blow gets nothing",
      );
      const granted = sentOfType<ItemGranted>(second, ServerMessage.ItemGranted);
      assert.equal(granted.length, 1, "the killer is told");
      assert.deepEqual(await store.list("sso-user-second"), [{ itemKey: "acorn", quantity: 2, equipped: false }]);
      assert.deepEqual(
        await store.list("sso-user-first"),
        [],
        "last-hit is winner-take-all, not split by damage contributed",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY MonsterHit fan-out radius is exactly VIEW_RADIUS_TILES", () => {
  it("reaches a viewer on the boundary and not one tile past it", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([spawnAt("m", faced)]);
    try {
      const attacker = join(room, "attacker");
      const onBoundary = join(room, "onBoundary");
      const pastBoundary = join(room, "pastBoundary");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);
      place(room, "onBoundary", { tileX: faced.tileX + VIEW_RADIUS_TILES, tileY: faced.tileY });
      place(room, "pastBoundary", { tileX: faced.tileX + VIEW_RADIUS_TILES + 1, tileY: faced.tileY });
      assert.equal(chebyshevOf(faced, { tileX: faced.tileX + VIEW_RADIUS_TILES, tileY: faced.tileY }), VIEW_RADIUS_TILES);

      attack(room, attacker, 0);

      assert.equal(
        sentOfType<MonsterHit>(onBoundary, ServerMessage.MonsterHit).length,
        1,
        "exactly VIEW_RADIUS_TILES away is still in range (<=, not <)",
      );
      assert.equal(
        sentOfType<MonsterHit>(pastBoundary, ServerMessage.MonsterHit).length,
        0,
        "one tile further is out",
      );
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY target selection when two candidates share the faced tile", () => {
  it("still breaks the tie by monster id, not by which one was faced first", async () => {
    const facedTile = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const room = await createRoom([spawnAt("m-zz", facedTile), spawnAt("m-aa", facedTile)]);
    try {
      const attacker = join(room, "attacker");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);

      attack(room, attacker, 0);

      assert.equal(room["monsterRuntimes"].get("m-aa")?.hp, 4, "both are faced and both are distance 1 — id decides");
      assert.equal(room["monsterRuntimes"].get("m-zz")?.hp, 8, "the other one is left alone");
    } finally {
      dispose(room);
    }
  });
});

describe("VERIFY a store that actually throws (not just a full bag)", () => {
  /** Rejects the first item key it is asked to add, resolves every other one normally. */
  class FailingFirstGrantStore implements InventoryStore {
    readonly addCalls: string[] = [];
    private readonly bag = new Map<string, number>();

    list(ownerKey: string): Promise<readonly { itemKey: string; quantity: number; equipped: boolean }[]> {
      void ownerKey;
      return Promise.resolve(
        [...this.bag].map(([itemKey, quantity]) => ({ itemKey, quantity, equipped: false })),
      );
    }

    add(_ownerKey: string, itemKey: string, quantity: number): Promise<number | null> {
      this.addCalls.push(itemKey);
      if (itemKey === "acorn") {
        return Promise.reject(new Error("connection reset"));
      }
      const total = (this.bag.get(itemKey) ?? 0) + quantity;
      this.bag.set(itemKey, total);
      return Promise.resolve(total);
    }

    grantOnce(_ownerKey: string, itemKey: string): Promise<boolean> {
      if (this.bag.has(itemKey)) {
        return Promise.resolve(false);
      }
      this.bag.set(itemKey, 1);
      return Promise.resolve(true);
    }

    getEquippedSlots(): Promise<Partial<Record<EquipmentSlot, string>>> {
      return Promise.resolve({});
    }

    equip(): Promise<boolean> {
      return Promise.resolve(false);
    }

    unequip(): Promise<boolean> {
      return Promise.resolve(false);
    }
  }

  it("drops the failed grant in silence, still credits and announces the other, and never throws unhandled", async () => {
    const faced = { tileX: OPEN_CENTRE.tileX + 1, tileY: OPEN_CENTRE.tileY };
    const store = new FailingFirstGrantStore();
    const room = await createRoom([spawnRabbitAt("m", faced)], store);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const attacker = join(room, "attacker", undefined, "sso-user-throw");
      place(room, "attacker", OPEN_CENTRE);
      face(room, "attacker", Direction.Right);

      attack(room, attacker, 0);
      attack(room, attacker, 0);
      await flush();

      assert.equal(room.state.monsters.has("m"), false, "the kill resolves regardless of the store's health");
      assert.deepEqual(
        store.addCalls,
        ["acorn", "herb"],
        "both independent rows were attempted, in declared order",
      );
      const granted = sentOfType<ItemGranted>(attacker, ServerMessage.ItemGranted);
      assert.equal(granted.length, 1, "only the row that actually committed is announced");
      assert.equal(granted[0]?.itemKey, "herb");
      assert.deepEqual(
        await store.list("sso-user-throw"),
        [{ itemKey: "herb", quantity: 1, equipped: false }],
        "the failed row was never stored either — the announcement matches reality",
      );
      assert.ok(warnings.length >= 1, "the failure is logged, not swallowed silently");
      assert.equal(unhandled.length, 0, "the rejection is caught inside awardLoot, never reaches the process");
    } finally {
      console.warn = originalWarn;
      process.off("unhandledRejection", onUnhandledRejection);
      dispose(room);
    }
  });
});

function chebyshevOf(a: TilePosition, b: TilePosition): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}
