import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusTestServer } from "@colyseus/testing";
import { ClientMessage, Direction, MAX_MOVES_PER_SECOND, type RoomState } from "@zep-test/shared";
import { TiledMapLoader } from "../game/tiledMap";
import { createGameServer } from "../server";
import { STEP_BY_DIRECTION } from "../game/movement";
import { MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES, MonsterKind } from "./monsterDefinitions";

/**
 * Pass F, F-4: `MONSTER_TYPES.aggroRadiusTiles` went from 4/6 (rat/bat) to 2/2
 * (`docs/design-hunting-inventory.md` 부록 F). `monsterAi.test.ts` proves the FSM gate itself
 * against a literal fixture that is deliberately decoupled from this table (its own header
 * comment says so), so a typo in `monsterDefinitions.ts` would not fail anything there. This
 * file drives the real table through the real room simulation instead: an actual client,
 * actually walked to an actual tile distance from an actual monster, over an actual connection.
 *
 * node:test runs each file in its own process; 2579/2581 etc. are taken by sibling suites, so
 * this one takes 2583.
 */
const PORT = 2583;

const HUNTING_GROUND = "buyeo-rat-cave";
const MOVE_COOLDOWN_MS = 1000 / MAX_MOVES_PER_SECOND + 15;

type AnyRoom = Awaited<ReturnType<ColyseusTestServer["createRoom"]>> & { state: RoomState };

interface ClientRoom {
  readonly sessionId: string;
  send(type: string, payload?: unknown): void;
  leave(consented?: boolean): Promise<number>;
}

let testServer: ColyseusTestServer;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(20);
  }
}

async function createRoom(): Promise<AnyRoom> {
  return (await testServer.createRoom<RoomState>(HUNTING_GROUND, {})) as AnyRoom;
}

async function join(room: AnyRoom, nickname: string): Promise<ClientRoom> {
  const client = (await testServer.connectTo(room, {
    nickname,
    avatarSkin: 0,
  })) as unknown as ClientRoom;
  await waitUntil(
    () => room.state.players.get(client.sessionId) !== undefined,
    `${nickname} to appear in ${HUNTING_GROUND}`,
  );
  return client;
}

function tileOf(room: AnyRoom, client: ClientRoom): { tileX: number; tileY: number } {
  const player = room.state.players.get(client.sessionId);
  assert.ok(player, "player has left the state");
  return { tileX: player.tileX, tileY: player.tileY };
}

function monsterTile(room: AnyRoom, monsterId: string): { tileX: number; tileY: number } {
  const monster = room.state.monsters.get(monsterId);
  assert.ok(monster, `monster "${monsterId}" is not on the wire (dead, or a bad id)`);
  return { tileX: monster.tileX, tileY: monster.tileY };
}

/**
 * Breadth-first shortest path over the real collision map. `monsterAi`'s own `greedyDirections`
 * is deliberately not this (design §7: no A*) and would strand on the very obstacle this test
 * has to route a *player* around (`metaverseRoom.huntingGround.test.ts` notes a pillar at
 * x41,y27) -- a real client is expected to path however its input allows, which here is BFS.
 */
function shortestPath(
  isWalkable: (x: number, y: number) => boolean,
  from: { tileX: number; tileY: number },
  to: { tileX: number; tileY: number },
): Direction[] {
  const key = (x: number, y: number): string => `${x},${y}`;
  const cameFrom = new Map<string, { x: number; y: number; dir: Direction }>();
  const visited = new Set<string>([key(from.tileX, from.tileY)]);
  const queue: Array<{ x: number; y: number }> = [{ x: from.tileX, y: from.tileY }];
  const directions = [Direction.Up, Direction.Down, Direction.Left, Direction.Right];

  while (queue.length > 0) {
    const current = queue.shift();
    assert.ok(current);
    if (current.x === to.tileX && current.y === to.tileY) {
      const path: Direction[] = [];
      let cursor = key(current.x, current.y);
      for (;;) {
        const step = cameFrom.get(cursor);
        if (!step) break;
        path.unshift(step.dir);
        cursor = key(step.x, step.y);
      }
      return path;
    }
    for (const dir of directions) {
      const delta = STEP_BY_DIRECTION[dir];
      const next = { x: current.x + delta.dx, y: current.y + delta.dy };
      const nextKey = key(next.x, next.y);
      if (visited.has(nextKey) || !isWalkable(next.x, next.y)) continue;
      visited.add(nextKey);
      cameFrom.set(nextKey, { x: current.x, y: current.y, dir });
      queue.push(next);
    }
  }
  throw new Error(`no walkable path from (${from.tileX},${from.tileY}) to (${to.tileX},${to.tileY})`);
}

async function walk(client: ClientRoom, room: AnyRoom, path: Direction[]): Promise<void> {
  for (const dir of path) {
    const at = tileOf(room, client), delta = STEP_BY_DIRECTION[dir];
    const expected = { tileX: at.tileX + delta.dx, tileY: at.tileY + delta.dy };
    client.send(ClientMessage.Move, { dir });
    await waitUntil(() => {
      const current = tileOf(room, client);
      return current.tileX === expected.tileX && current.tileY === expected.tileY;
    }, `acknowledged step to ${expected.tileX},${expected.tileY}`);
    await sleep(MOVE_COOLDOWN_MS);
  }
}

function chebyshev(a: { tileX: number; tileY: number }, b: { tileX: number; tileY: number }): number {
  return Math.max(Math.abs(a.tileX - b.tileX), Math.abs(a.tileY - b.tileY));
}

/**
 * Walks the hunter to a fixed point `marginTiles` from a monster's *spawn* tile and confirms it
 * is never chased there, sampled across two full wander cycles.
 *
 * Deliberately not "walk to 3 tiles from wherever the monster happens to be standing right now":
 * a live monster keeps taking its own wander steps (radius `wanderRadiusTiles`, unrelated to
 * aggro) while the hunter is still en route, so a target framed off the *live* tile goes stale by
 * the time it is reached -- this measured as a real, reproducible failure (see the two flaky
 * first drafts of this file this replaced). Framing the target off the immobile *spawn* tile
 * instead, with `marginTiles` chosen so `marginTiles - wanderRadiusTiles` still exceeds the real
 * `aggroRadiusTiles` (2), makes the live distance bounded and safe for the whole test regardless
 * of where in its box the monster happens to be: `[marginTiles - W, marginTiles + W]` never dips
 * to 2 or below by wandering alone. The floor of that range, `marginTiles - W`, is also chosen to
 * still sit at or under the *old*, pre-Pass-F radius (4 for rat, 6 for bat) -- so a regression
 * that silently restored the old value would show up here as a monster that starts closing the
 * distance instead of pacing it, which the assertion below would catch.
 */
async function assertNoAggroAtMargin(
  room: AnyRoom,
  hunter: ClientRoom,
  map: { isWalkable(x: number, y: number): boolean },
  spawnAt: { tileX: number; tileY: number },
  monsterId: string,
  marginTiles: number,
  wanderStepIntervalMs: number,
): Promise<void> {
  const target = { tileX: spawnAt.tileX + marginTiles, tileY: spawnAt.tileY };
  const path = shortestPath((x, y) => map.isWalkable(x, y), tileOf(room, hunter), target);
  await walk(hunter, room, path);
  assert.deepEqual(tileOf(room, hunter), target, "hunter did not reach the margin mark");

  const observeMs = wanderStepIntervalMs * 2 + 400;
  const deadline = Date.now() + observeMs;
  let samples = 0;
  while (Date.now() < deadline) {
    const distance = chebyshev(monsterTile(room, monsterId), target);
    assert.ok(
      distance >= 3,
      `${monsterId} closed to Chebyshev ${distance} of a hunter parked ${marginTiles} tiles from ` +
        `its spawn -- with aggroRadiusTiles=2 this should never happen from wandering alone`,
    );
    samples++;
    await sleep(250);
  }
  assert.ok(samples >= 4, `only took ${samples} samples over ${observeMs}ms -- window too short to trust`);
}

/**
 * Adaptively walks the hunter to exactly Chebyshev 2 of wherever the monster is *actually*
 * standing right now (re-read every attempt, since it keeps wandering independently), then
 * confirms a real chase step follows -- proof the real `aggroRadiusTiles: 2` does engage the FSM
 * over the wire, not just in `monsterAi.test.ts`'s decoupled fixture.
 *
 * All four Chebyshev-2 tiles are tried, not just `+x`: the monster wanders freely inside its
 * radius, so on any attempt where it has stepped beside one of the map's rock clusters the single
 * `+x` candidate is a wall -- `shortestPath` then throws, which the retry loop cannot absorb
 * unless the failure is caught here (measured: 1 run in 12 solo, 3 in 5 when batched).
 */
async function assertAggroEngagesAtTwo(
  room: AnyRoom,
  hunter: ClientRoom,
  map: { isWalkable(x: number, y: number): boolean },
  monsterId: string,
  chaseStepIntervalMs: number,
): Promise<void> {
  let distance = -1;
  for (let attempt = 0; attempt < 6; attempt++) {
    const live = monsterTile(room, monsterId);
    const candidates = [
      { tileX: live.tileX + 2, tileY: live.tileY },
      { tileX: live.tileX - 2, tileY: live.tileY },
      { tileX: live.tileX, tileY: live.tileY + 2 },
      { tileX: live.tileX, tileY: live.tileY - 2 },
    ];
    let walked = false;
    for (const target of candidates) {
      if (!map.isWalkable(target.tileX, target.tileY)) continue;
      let path: Direction[];
      try {
        path = shortestPath((x, y) => map.isWalkable(x, y), tileOf(room, hunter), target);
      } catch {
        // Walkable but unreachable (walled off from the hunter's side) -- try the next tile.
        continue;
      }
      await walk(hunter, room, path);
      walked = true;
      break;
    }
    if (!walked) {
      // Every candidate was a wall this attempt. Give the monster a wander step and re-read.
      await sleep(MOVE_COOLDOWN_MS);
      continue;
    }
    distance = chebyshev(monsterTile(room, monsterId), tileOf(room, hunter));
    if (distance === 2) break;
  }
  assert.equal(distance, 2, `could not converge the hunter onto Chebyshev 2 of ${monsterId} after 6 attempts`);

  const atHold = monsterTile(room, monsterId);
  await waitUntil(
    () => {
      const now = monsterTile(room, monsterId);
      return now.tileX !== atHold.tileX || now.tileY !== atHold.tileY;
    },
    `${monsterId} to take a chase step once the hunter held at exactly 2 tiles`,
    chaseStepIntervalMs + 1000,
  );
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

describe("buyeo-rat-cave — F-4 aggro radius, against the real MONSTER_TYPES table", () => {
  it(`the real rat aggroRadiusTiles is 2, not the pre-Pass-F 4`, () => {
    const rat = MONSTER_TYPES.get(MonsterKind.Rat);
    assert.ok(rat);
    assert.equal(rat.aggroRadiusTiles, 2);
  });

  it(`the real bat aggroRadiusTiles is 2, not the pre-Pass-F 6`, () => {
    const bat = MONSTER_TYPES.get(MonsterKind.Bat);
    assert.ok(bat);
    assert.equal(bat.aggroRadiusTiles, 2);
  });

  it(
    "a hunter 5 tiles from a live rat's spawn is never chased across two wander cycles, " +
      "but holding at exactly 2 tiles from its live position starts a real chase",
    async () => {
      const room = await createRoom();
      const hunter = await join(room, "hunter");
      const map = await new TiledMapLoader().load("buyeo-rat-cave");
      const ratType = MONSTER_TYPES.get(MonsterKind.Rat);
      assert.ok(ratType);

      const spawnRow = MONSTER_SPAWN_DEFINITIONS.find(
        (spawn) => spawn.room === HUNTING_GROUND && spawn.kind === MonsterKind.Rat,
      );
      assert.ok(spawnRow, "no rat spawn row in the real table");
      assert.equal(spawnRow.wanderRadiusTiles, 1, "margin math below assumes this row's real wander radius");

      // margin(5) - wanderRadiusTiles(2) = 3 > aggroRadiusTiles(2): wandering alone can never
      // pull the live distance to this fixed point below 3.
      await assertNoAggroAtMargin(
        room,
        hunter,
        map,
        spawnRow.at,
        spawnRow.id,
        5,
        ratType.wanderStepIntervalMs,
      );

      await assertAggroEngagesAtTwo(room, hunter, map, spawnRow.id, ratType.chaseStepIntervalMs);
    },
  );

  it(
    "a hunter 6 tiles from a live bat's spawn is never chased across two wander cycles, " +
      "but holding at exactly 2 tiles from its live position starts a real chase",
    async () => {
      const room = await createRoom();
      const hunter = await join(room, "hunter");
      const map = await new TiledMapLoader().load("buyeo-rat-cave");
      const batType = MONSTER_TYPES.get(MonsterKind.Bat);
      assert.ok(batType);

      const spawnRow = MONSTER_SPAWN_DEFINITIONS.find(
        (spawn) => spawn.room === HUNTING_GROUND && spawn.kind === MonsterKind.Bat,
      );
      assert.ok(spawnRow, "no bat spawn row in the real table");
      assert.equal(spawnRow.wanderRadiusTiles, 1, "margin math below assumes this row's real wander radius");

      // margin(6) - wanderRadiusTiles(3) = 3 > aggroRadiusTiles(2): same reasoning as the rat
      // case, sized for the bat's wider wander box.
      await assertNoAggroAtMargin(
        room,
        hunter,
        map,
        spawnRow.at,
        spawnRow.id,
        6,
        batType.wanderStepIntervalMs,
      );

      await assertAggroEngagesAtTwo(room, hunter, map, spawnRow.id, batType.chaseStepIntervalMs);
    },
  );

  it("both current rat-cave kinds have an eight-tile leash", () => {
    const rat = MONSTER_TYPES.get(MonsterKind.Rat);
    const bat = MONSTER_TYPES.get(MonsterKind.Bat);
    assert.ok(rat && bat);
    assert.equal(rat.leashRadiusTiles, 8);
    assert.equal(bat.leashRadiusTiles, 8);
  });
});
