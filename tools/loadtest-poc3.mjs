// Go/No-go PoC #3 measurement — "does a hunting ground fit in the same process as grand-plaza?"
// (docs/design-hunting-inventory.md §9).
//
//   npx tsx tools/loadtest-poc3.mjs                      # every tier, the full 4x3 sweep
//   npx tsx tools/loadtest-poc3.mjs --monsters 24        # pin the monster axis
//   npx tsx tools/loadtest-poc3.mjs --hunters 0,40       # pin the hunter axis
//   npx tsx tools/loadtest-poc3.mjs --skip-socket        # in-process tiers only (no 500 bots)
//   npx tsx tools/loadtest-poc3.mjs --socket-only        # tier D only
//                                                       (cwd = code/)
//
// Deliberately not a *.test.ts, for the reason `loadtest-poc2.mjs` gives: it takes minutes and
// its output is a measurement rather than an assertion, so CI must not run it (§9.2).
//
// Reuses poc2 rather than copying it. Grand-plaza's map, bot count, pacing and seeds all come
// from `loadtest-poc2.mjs`'s own exports and are never restated here, because the whole design of
// this harness is a single-variable comparison: the same scenario A, with and without a hunting
// ground in the process. Anything re-typed here could drift from what poc2 measures and would
// quietly turn the comparison into two different experiments.
//
// Four tiers, matching §9.2's four measurement layers:
//
//   A. grand-plaza per-move CPU   - poc2 scenario A, run twice: alone, and with a hunting ground
//      simulating in the same process. Criterion 1 (<= 0.10 ms/move).
//   B. grand-plaza per-patch CPU  - poc2's encode tier under the same two conditions.
//   C. hunting-ground tick cost   - `tick()` wall time, driven with an explicit clock so the
//      distribution is the tick's and nothing else's. Criterion 3.
//   D. websocket tier             - the server runs in a *child process* and the bots in this one.
//      That split is the point of the tier: `monitorEventLoopDelay` inside the child measures the
//      server's loop and not 500 bot decoders sharing it, which is the only way criterion 4
//      ("event loop delay p99 <= 50 ms") means what it says. Criteria 2 and 4.
//
// How the co-tenant interleaves in tiers A and B: Node has one thread, so a monster tick can land
// between two moves and never inside one. poc2's `between` hook is called once per iteration
// outside its `hrtime` pair, and this file drives the hunting ground from there on a *simulated*
// clock advanced by the production ratio — 500 clients x MAX_MOVES_PER_SECOND is 10,000 moves a
// second, against 5 ticks and 10 patches a second, so one move is 0.1 ms of simulated time. Pacing
// the co-tenant off wall time instead would understate it by the factor the harness runs faster
// than real time; pacing it off move count at a fixed ratio is what reproduces the real budget.
import { fork } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ACCEPTANCE_BAR_MS_PER_MOVE,
  CODE_DIR,
  DEFAULT_ENCODER_BUFFER_BYTES,
  DIRECTIONS,
  collectBotLatency,
  fakeClient,
  generateMaps,
  joinBots,
  loadClientSdk,
  measureInterleaved,
  ms,
  paceMoves,
  populate,
  rectLabel,
  rssMb,
  runMoveScenario,
  runPatchScenario,
  seededRandom,
  summarize,
  uniformWalkable,
} from "./loadtest-poc2.mjs";

const {
  MAX_MOVES_PER_SECOND,
  MONSTER_TICK_MS,
  PATCH_RATE_MS,
  VIEW_RADIUS_TILES,
} = await import(pathToFileURL(join(CODE_DIR, "shared/src/index.ts")).href);
const { MetaverseRoom } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/rooms/metaverseRoom.ts")).href
);
const { TiledMapLoader } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/game/tiledMap.ts")).href
);
const { ROOM_DEFINITIONS } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/rooms/definitions.ts")).href
);
const { MONSTER_TYPES, MonsterKind, validateMonsterSpawnDefinitions } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/rooms/monsterDefinitions.ts")).href
);
const { ITEM_DEFINITIONS } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/rooms/itemDefinitions.ts")).href
);
const { PORTAL_DEFINITIONS } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/rooms/portalDefinitions.ts")).href
);
const { INTERACTABLE_DEFINITIONS } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/rooms/interactableDefinitions.ts")).href
);
const { SchemaSerializer } = await import(
  pathToFileURL(join(CODE_DIR, "node_modules/@colyseus/core/build/serializer/SchemaSerializer.mjs")).href
);
const { Encoder } = await import("@colyseus/schema");

const HUNTING_ROOM = ROOM_DEFINITIONS.find((definition) => definition.name === "hunting-ground");

/* ------------------------------------------------------------- the bars ---- */

/** §9.3 criterion 3: 2.5% and 10% of the 200 ms tick period. */
const TICK_MEAN_BAR_MS = 5;
const TICK_P99_BAR_MS = 20;
/** §9.3 criterion 4: half of PATCH_RATE_MS is where patches start being pushed late. */
const EVENT_LOOP_P99_BAR_MS = 50;
/** §9.3 criterion 2. */
const LATENCY_REGRESSION_FACTOR = 1.25;

/**
 * PoC #2's published move->patch latency (docs/archive/decisions-2026-08.md, 2026-08-26 table).
 * Carried here only so the printout can name the number criterion 2 refers to.
 *
 * It is *not* the comparator this harness judges against, and the difference matters: those rows
 * were taken with the server and all 500 bots in one process and with VIEW_RADIUS_TILES at 13,
 * while tier D below splits server and bots across two processes and the radius is now 19. The
 * 2026-08-27 re-measurement moved the 10,000/s median from 45.1 ms to 187.8 ms on the radius
 * change alone and did not record a new p95, so the recorded p95 is stale in a known direction.
 * The valid single-variable comparator is the baseline row this harness measures in the same
 * session with the hunting ground absent, which is what the criterion table below uses.
 */
const POC2_RECORDED_LATENCY = [
  { movesPerSecondPerBot: 8.33, medianMs: 72.4, p95Ms: 132.8 },
  { movesPerSecondPerBot: 20, medianMs: 45.1, p95Ms: 114.5 },
];

/* --------------------------------------------------------------- sweeps ---- */

/** §9.2's sweep. Both axes are overridable, in the shape poc2's `--cluster-halves` established. */
const MONSTER_COUNTS = [10, 24, 60, 120];
const HUNTER_COUNTS = [0, 20, 40];

/**
 * Client send pacing, in moves per second per bot. poc2's socket tier uses exactly these two —
 * 8.33 is the 120 ms client step tween, 20 is the server's own rate limit — and criterion 2 is a
 * comparison against poc2, so they are read from there rather than chosen again.
 */
const CLIENT_PACING_PER_SECOND = 8.33;
const SOCKET_RATES = [CLIENT_PACING_PER_SECOND, MAX_MOVES_PER_SECOND];

/** 120 ms per step is the client's tween, which is what 8.33 moves/s/bot says in the other unit. */
const CLIENT_STEP_MS = 1000 / CLIENT_PACING_PER_SECOND;

/** poc2's worst-case declared traffic: 500 clients at the server's rate limit. */
const GRAND_PLAZA_MOVES_PER_SECOND = 500 * MAX_MOVES_PER_SECOND;

/* ---------------------------------------------------- hunting ground ------ */

/**
 * Monster kinds in the ratio the authored table uses (14 squirrels to 6 rabbits), with each
 * kind's authored wander radius. The mix is not cosmetic: a rabbit wanders every 1200 ms against
 * a squirrel's 1600 ms and over a radius-3 box rather than radius-2, and step frequency is what a
 * tick costs.
 */
const SPAWN_MIX = [
  { kind: MonsterKind.Squirrel, share: 0.7, wanderRadiusTiles: 2 },
  { kind: MonsterKind.Rabbit, share: 0.3, wanderRadiusTiles: 3 },
];

/**
 * The band monsters are allowed into. The authored table puts nothing at y >= 25 so that a player
 * arriving through the south door does not land in a fight already in progress
 * (`monsterDefinitions.ts`), and a generated table that ignored that would be measuring a map the
 * product does not have.
 */
const MONSTER_BAND = { minY: 8, maxY: 24 };

function walkableTiles(map, minY, maxY) {
  const tiles = [];
  for (let tileY = minY; tileY <= maxY; tileY++) {
    for (let tileX = 0; tileX < map.widthInTiles; tileX++) {
      if (map.isWalkable(tileX, tileY)) tiles.push({ tileX, tileY });
    }
  }
  return tiles;
}

/**
 * `count` spawn rows spread over the monster band by an even stride through the row-major walkable
 * list, so a bigger table is denser rather than differently placed — the sweep's only variable is
 * population. Deterministic for the same map and count.
 */
function generateHuntingSpawns(count, map) {
  const tiles = walkableTiles(map, MONSTER_BAND.minY, MONSTER_BAND.maxY);
  if (count > tiles.length) {
    throw new Error(`cannot place ${count} monsters: the band holds ${tiles.length} walkable tiles`);
  }
  const stride = tiles.length / count;
  const spawns = [];
  for (let index = 0; index < count; index++) {
    const tile = tiles[Math.floor(index * stride)];
    // Interleaved rather than blocked, so any prefix of the table holds the same kind ratio.
    const mix = index % 10 < SPAWN_MIX[0].share * 10 ? SPAWN_MIX[0] : SPAWN_MIX[1];
    spawns.push({
      id: `poc3-${mix.kind}-${String(index).padStart(3, "0")}`,
      room: "hunting-ground",
      kind: mix.kind,
      at: tile,
      wanderRadiusTiles: mix.wanderRadiusTiles,
    });
  }
  return spawns;
}

/**
 * The same boot check the server runs. A generated table skips `createGameServer`'s validation
 * (that one reads the authored table), and a spawn point inside a wall is a monster that never
 * appears — which would show up as a suspiciously cheap tick rather than as an error.
 */
function assertSpawnsValid(spawns, map) {
  const { errors } = validateMonsterSpawnDefinitions(
    spawns,
    MONSTER_TYPES,
    ITEM_DEFINITIONS,
    new Map([["hunting-ground", map]]),
    PORTAL_DEFINITIONS,
    INTERACTABLE_DEFINITIONS,
  );
  if (errors.length > 0) {
    throw new Error(`generated monster table is invalid: ${errors.join("; ")}`);
  }
}

/**
 * A hunting ground whose monster table is injected and whose simulation timer is suppressed.
 *
 * The timer has to go: a live 200 ms interval cannot fire inside poc2's synchronous move loop, so
 * leaving it on would produce a room that is nominally co-resident and actually idle — the exact
 * result this PoC exists to avoid believing. `tick()` already takes `now` as an argument for the
 * tests' sake, so the harness drives it on the simulated clock instead. Tier D uses the real timer
 * in the real server, which is where that path gets exercised.
 */
class HuntingLoadRoom extends MetaverseRoom {
  fixtureSpawns = [];

  monsterSpawns() {
    return this.fixtureSpawns;
  }

  setSimulationInterval() {}
}

async function buildHuntingRoom({ monsters, map }) {
  const spawns = generateHuntingSpawns(monsters, map);
  assertSpawnsValid(spawns, map);
  const room = new HuntingLoadRoom();
  room.fixtureSpawns = spawns;
  // Set before onCreate so the portal and object indexes resolve the real hunting-ground rows;
  // `monsterSpawns()` is overridden, so this does not reach the authored monster table.
  room.roomName = "hunting-ground";
  await room.onCreate({
    roomType: HUNTING_ROOM.roomType,
    mapKey: HUNTING_ROOM.mapKey,
    // Above the product's 40 only so a sweep point can never be refused by the cap rather than by
    // the measurement; every point this file runs is at or under 40.
    maxClients: 1000,
    spawn: HUNTING_ROOM.spawn,
  });
  // The interval is off (above); this stops Colyseus' own patch timer from firing mid-measurement.
  room.setPatchRate(null);
  if (room.state.monsters.size !== monsters) {
    throw new Error(`asked for ${monsters} monsters, room holds ${room.state.monsters.size}`);
  }
  return room;
}

/**
 * Joins `count` hunters, scatters them over the field and installs the encoder, so the co-tenant
 * pays its whole production bill and not just the monster half: player steps, monster ticks and
 * per-view patch encoding all land on the one core that grand-plaza is being measured on.
 */
function populateHunters(room, count, seed) {
  const random = seededRandom(seed);
  const clients = populate(room, count, uniformWalkable(room, random));
  for (const client of clients) {
    // `populate` relocates the bots after `onJoin` and refreshes their *player* views; the monster
    // ledger it does not know about would otherwise still describe their spawn tile.
    room.refreshMonsterViewFor(client.sessionId);
    client.raw = () => {};
    room.clients.push(client);
  }
  return clients;
}

function installSerializer(room) {
  // A bare room keeps the NoneSerializer (poc2 says why). 1 MB is the production growth step from
  // `server.ts`; the library default of 8 KB would measure buffer growth instead of encoding.
  const previous = Encoder.BUFFER_SIZE;
  Encoder.BUFFER_SIZE = 1024 * 1024;
  try {
    const serializer = new SchemaSerializer();
    serializer.reset(room.state);
    room.setSerializer(serializer);
  } finally {
    Encoder.BUFFER_SIZE = previous;
  }
}

/**
 * The co-tenant: everything the hunting ground does per unit of production time, on a clock the
 * caller advances.
 *
 * The clock lives here and only ever moves forward, which is load-bearing rather than tidy. Every
 * deadline inside the room — the next wander step, a respawn — is an absolute time on this clock,
 * so a second pump that restarted at zero would leave every monster with its next step scheduled
 * in what it now thinks is the far future and the room would go silently still. That is exactly
 * the shape of bug a cohabitation measurement cannot survive: it reads as "monsters are free".
 *
 * `advance(simulatedMs)` is what ties the two workloads together — the caller declares how much
 * production time one of its iterations stands for, and this drains whatever fell due.
 */
function createCoTenant({ room, hunterClients, seed }) {
  const random = seededRandom(seed);
  const tickSamples = [];
  let clock = 0;
  let nextTickAt = MONSTER_TICK_MS;
  let nextPatchAt = PATCH_RATE_MS;
  let patches = 0;
  let hunterMoves = 0;
  // Staggered, not all due at once: 40 hunters stepping on the same call would make one iteration
  // in every 12 carry the whole hunting-side move cost.
  const nextMoveAt = hunterClients.map((_, index) => (index / Math.max(1, hunterClients.length)) * CLIENT_STEP_MS);

  return {
    tickSamples,
    /**
     * Work counters, reported after every tier that uses this. Without them the cohabitation
     * tiers are unfalsifiable: a co-tenant that never ran and a co-tenant that costs nothing
     * produce the same table, and the first would be a harness bug reported as a result.
     */
    get work() {
      return { ticks: tickSamples.length, patches, hunterMoves, clockMs: clock };
    },
    advance(simulatedMs) {
      clock += simulatedMs;
      for (let index = 0; index < hunterClients.length; index++) {
        while (nextMoveAt[index] <= clock) {
          nextMoveAt[index] += CLIENT_STEP_MS;
          const client = hunterClients[index];
          // Same reason poc2 does it: the rate limit is not part of the cost being reproduced.
          client.userData.lastMoveAt = 0;
          room.handleMove(client, { dir: DIRECTIONS[Math.floor(random() * DIRECTIONS.length)] });
          hunterMoves++;
        }
      }
      while (nextTickAt <= clock) {
        nextTickAt += MONSTER_TICK_MS;
        const start = process.hrtime.bigint();
        room.tick(clock);
        tickSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      while (nextPatchAt <= clock) {
        nextPatchAt += PATCH_RATE_MS;
        room.broadcastPatch();
        patches++;
      }
    },
  };
}

/* ------------------------------------------------ tiers A and B: cohabitation ---- */

/**
 * One (monsters, hunters) point, built once and reused by every round so the monsters keep
 * wandering across the whole interleaved sweep instead of restarting from their spawn tiles.
 */
async function createWorld({ monsters, hunters, map, seed }) {
  if (monsters === 0 && hunters === 0) {
    // The control. `betweenFor` answering undefined is what makes poc2's hook a no-op, so the
    // baseline runs poc2's loop with nothing added to it at all — not even a call per iteration.
    return { label: "solo", monsters: 0, hunters: 0, tenant: null, betweenFor: () => undefined };
  }
  const room = await buildHuntingRoom({ monsters, map });
  installSerializer(room);
  const hunterClients = populateHunters(room, hunters, seed);
  const tenant = createCoTenant({ room, hunterClients, seed: seed ^ 0x5eed });
  return {
    label: `M${monsters}/H${hunters}`,
    monsters,
    hunters,
    room,
    hunterClients,
    tenant,
    /**
     * One closure per tier, because a tier's iteration stands for a different slice of production
     * time — a move is 0.1 ms of it, a patch is 100 ms — but all of them advance the one clock.
     */
    betweenFor(simulatedMsPerCall) {
      return () => tenant.advance(simulatedMsPerCall);
    },
  };
}

/* ------------------------------------------------------ tier C: tick cost ---- */

/**
 * The tick's own distribution, measured with nothing else in the process competing for the sample.
 *
 * One call of the co-tenant pump is one tick period here, so the hunters step at their real rate
 * relative to the monsters (1.67 steps per hunter per tick) and every tick is timed. Separated
 * from tier A because a distribution needs thousands of samples and tier A only produces a dozen
 * per run — and because criterion 3 is about the tick alone, not about the tick under contention.
 */
async function runTickScenario({ monsters, hunters, map, ticks, warmup, seed }) {
  const room = await buildHuntingRoom({ monsters, map });
  installSerializer(room);
  const hunterClients = populateHunters(room, hunters, seed);
  const tenant = createCoTenant({ room, hunterClients, seed: seed ^ 0x5eed });
  for (let index = 0; index < ticks + warmup; index++) {
    tenant.advance(MONSTER_TICK_MS);
  }
  const samples = tenant.tickSamples.slice(warmup);
  const living = room.state.monsters.size;
  room.setPatchRate(null);
  room.clients.length = 0;
  return { monsters, hunters, living, ...summarize(samples), samples };
}

/** Median of per-round statistics, poc2's aggregation, extended with the p99 criterion 3 needs. */
function aggregateTickRuns(runs) {
  const middleOf = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const pooled = summarize(runs.flatMap((run) => run.samples));
  return {
    ...runs[0],
    samples: undefined,
    meanMs: middleOf(runs.map((run) => run.meanMs)),
    p95Ms: middleOf(runs.map((run) => run.p95Ms)),
    p99Ms: middleOf(runs.map((run) => run.p99Ms)),
    maxMs: Math.max(...runs.map((run) => run.maxMs)),
    slowestMeanMs: Math.max(...runs.map((run) => run.meanMs)),
    pooled,
    runs: runs.length,
  };
}

/* ------------------------------------------------------ tier D: sockets ---- */

const CHILD_FLAG = "--server-child";

/** The child half of tier D: a real server, instrumented, driven over IPC. */
async function runServerChild(port) {
  const { createGameServer } = await import(pathToFileURL(join(CODE_DIR, "server/src/server.ts")).href);
  const { matchMaker } = await import("colyseus");
  const map = await new TiledMapLoader().load(HUNTING_ROOM.mapKey);

  let sweepSpawns = [];
  let tickSamples = [];
  const authoredSpawns = MetaverseRoom.prototype.monsterSpawns;
  MetaverseRoom.prototype.monsterSpawns = function poc3MonsterSpawns() {
    return this.roomName === "hunting-ground" ? sweepSpawns : authoredSpawns.call(this);
  };
  const authoredTick = MetaverseRoom.prototype.tick;
  MetaverseRoom.prototype.tick = function poc3Tick(now) {
    if (this.roomName !== "hunting-ground") {
      authoredTick.call(this, now);
      return;
    }
    const start = process.hrtime.bigint();
    authoredTick.call(this, now);
    tickSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
  };

  // resolution 5 ms: an order of magnitude under the 50 ms bar, and coarse enough that the
  // monitor's own timer is not a load of its own.
  const loopDelay = monitorEventLoopDelay({ resolution: 5 });
  const gameServer = createGameServer();
  await gameServer.listen(port);

  let huntingRoomId = null;
  const handlers = {
    async configure({ monsters }) {
      sweepSpawns = monsters === 0 ? [] : generateHuntingSpawns(monsters, map);
      return { spawns: sweepSpawns.length };
    },
    async createHunting() {
      const listing = await matchMaker.createRoom("hunting-ground", {});
      huntingRoomId = listing.roomId;
      const room = matchMaker.getLocalRoomById(huntingRoomId);
      // Otherwise a point with 0 hunters would dispose the room the moment it was made, and a
      // point with hunters would dispose it between the sweep's rounds.
      room.autoDispose = false;
      return { roomId: huntingRoomId, monsters: room.state.monsters.size };
    },
    async disposeHunting() {
      if (huntingRoomId === null) return { disposed: false };
      const room = matchMaker.getLocalRoomById(huntingRoomId);
      huntingRoomId = null;
      if (room === undefined) return { disposed: false };
      await room.disconnect();
      return { disposed: true };
    },
    async start() {
      tickSamples = [];
      loopDelay.reset();
      loopDelay.enable();
      return {};
    },
    async stop() {
      loopDelay.disable();
      const room = huntingRoomId === null ? undefined : matchMaker.getLocalRoomById(huntingRoomId);
      return {
        // The samples themselves, not just their summary: the parent pools them across rounds,
        // and ~40 numbers per 8 s run is nothing to send over IPC.
        tickSamples,
        loop: {
          // The histogram is in nanoseconds.
          meanMs: loopDelay.mean / 1e6,
          p50Ms: loopDelay.percentile(50) / 1e6,
          p95Ms: loopDelay.percentile(95) / 1e6,
          p99Ms: loopDelay.percentile(99) / 1e6,
          maxMs: loopDelay.max / 1e6,
        },
        serverRssMb: rssMb(),
        livingMonsters: room?.state.monsters.size ?? 0,
        huntersInRoom: room?.clients.length ?? 0,
      };
    },
    async shutdown() {
      await gameServer.gracefullyShutdown(false);
      return {};
    },
  };

  process.on("message", (message) => {
    const handler = handlers[message.type];
    Promise.resolve(handler === undefined ? Promise.reject(new Error(`unknown ${message.type}`)) : handler(message))
      .then((payload) => process.send({ id: message.id, payload }))
      .catch((error) => process.send({ id: message.id, error: error.stack ?? String(error) }));
  });
  process.send({ type: "ready" });
}

/** The parent's handle on that child: a request/response wrapper over IPC. */
function spawnServerChild(port) {
  const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG, "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message.type === "ready") {
        resolve();
        return;
      }
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.payload);
    });
    child.on("exit", (code) => {
      const error = new Error(`server child exited with code ${code}`);
      reject(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    });
  });
  return {
    ready,
    child,
    call(type, payload = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, type, ...payload });
      });
    },
  };
}

/**
 * One sweep point. The 500 grand-plaza bots are joined once by the caller and reused: rejoining
 * them per point would cost minutes and would also re-scatter them, and their placement is one of
 * the grand-plaza conditions that has to stay fixed across the comparison.
 */
async function runSocketPoint({ server, Client, endpoint, plazaBots, monsters, hunters, rates, durationMs }) {
  let huntBots = [];
  let huntingRoomId = null;
  if (monsters > 0 || hunters > 0) {
    await server.call("configure", { monsters });
    const created = await server.call("createHunting");
    huntingRoomId = created.roomId;
    // The sweep's whole variable is this number, and the room is rebuilt between points. A stale
    // room surviving a `disposeHunting` would publish the previous point's population under this
    // point's label, which is the one failure this tier could not be talked out of afterwards.
    if (created.monsters !== monsters) {
      throw new Error(`hunting room came up with ${created.monsters} monsters, expected ${monsters}`);
    }
    if (hunters > 0) {
      ({ bots: huntBots } = await joinBots({
        Client,
        endpoint,
        roomName: "hunting-ground",
        roomId: huntingRoomId,
        count: hunters,
        startIndex: 100_000,
        batchSize: 10,
        label: "hunters",
      }));
    }
  }

  const rows = [];
  for (const movesPerSecondPerBot of rates) {
    await server.call("start");
    // Seeded random directions rather than poc2's round robin, for both groups alike. See
    // `paceMoves`: the round robin gives each bot one fixed direction for the whole run, and this
    // harness reuses one set of 500 bots across every sweep point, so by the second point they
    // would all be standing against a wall and the "load" would be a stream of refusals. Applied
    // identically to the baseline and to every point, which is what keeps the comparison single
    // -variable; it is also what poc2's own in-process tiers do.
    const plazaDirections = seededRandom(0xa11ce);
    const huntDirections = seededRandom(0xb0b);
    // Concurrently on purpose: the two rooms are two independent traffic sources sharing one
    // server, which is the whole condition under test.
    const [plaza, hunt] = await Promise.all([
      paceMoves(plazaBots, movesPerSecondPerBot, durationMs, () => DIRECTIONS[Math.floor(plazaDirections() * DIRECTIONS.length)]),
      paceMoves(huntBots, movesPerSecondPerBot, durationMs, () => DIRECTIONS[Math.floor(huntDirections() * DIRECTIONS.length)]),
    ]);
    // One patch interval of settling, exactly as poc2 does, so in-flight moves land first.
    await new Promise((done) => setTimeout(done, PATCH_RATE_MS * 3));
    const metrics = await server.call("stop");
    rows.push({
      monsters,
      hunters,
      movesPerSecondPerBot,
      plaza: collectBotLatency(plazaBots, plaza.sent, plaza.elapsedMs, movesPerSecondPerBot),
      hunt: collectBotLatency(huntBots, hunt.sent, hunt.elapsedMs, movesPerSecondPerBot),
      ...metrics,
      botRssMb: rssMb(),
    });
  }

  await Promise.all(huntBots.map((state) => state.room.leave().catch(() => {})));
  if (huntingRoomId !== null) await server.call("disposeHunting");
  return rows;
}

/**
 * Median of per-round statistics, and the round-to-round spread beside it.
 *
 * Tier D has to be repeated and interleaved for the reason poc2 recorded on 2026-08-27: on a
 * throttling laptop part a multi-minute sweep gets monotonically slower, and a configuration
 * measured late looks worse than one measured early by more than the effect being searched for.
 * A first pass of this tier ran each point once, in order, and produced an event loop delay that
 * was worse at 24 monsters than at 120 — which is not a monster effect, it is the drift. The
 * spread column is printed for the same reason poc2 prints its own: an effect that is not larger
 * than the band has not been resolved, whatever the point estimate says.
 */
function aggregateSocketRuns(runs) {
  const middleOf = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const latencyOf = (side) => ({
    ...runs[0][side].latency,
    medianMs: middleOf(runs.map((run) => run[side].latency.medianMs)),
    p95Ms: middleOf(runs.map((run) => run[side].latency.p95Ms)),
    count: runs.reduce((total, run) => total + run[side].latency.count, 0),
  });
  const loopP99s = runs.map((run) => run.loop.p99Ms);
  return {
    ...runs[0],
    rounds: runs.length,
    plaza: { ...runs[0].plaza, achievedRate: middleOf(runs.map((run) => run.plaza.achievedRate)), refused: runs.reduce((t, r) => t + r.plaza.refused, 0), sent: runs.reduce((t, r) => t + r.plaza.sent, 0), latency: latencyOf("plaza") },
    hunt: { ...runs[0].hunt, latency: latencyOf("hunt") },
    loop: {
      p99Ms: middleOf(loopP99s),
      lowestP99Ms: Math.min(...loopP99s),
      highestP99Ms: Math.max(...loopP99s),
      maxMs: Math.max(...runs.map((run) => run.loop.maxMs)),
    },
    tick: summarize(runs.flatMap((run) => run.tickSamples)),
    serverRssMb: Math.max(...runs.map((run) => Number(run.serverRssMb))),
  };
}

/* ------------------------------------------------------------------ main ---- */

function parseList(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const values = (process.argv[index + 1] ?? "").split(",").map((value) => Number.parseInt(value, 10));
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 0)) {
    console.error(`${flag}: expected a comma-separated list of non-negative integers, got ${JSON.stringify(process.argv[index + 1])}`);
    process.exit(1);
  }
  return values;
}

function parseNumber(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  return Number.isInteger(value) ? value : fallback;
}

const port = parseNumber("--port", 2598);

if (process.argv.includes(CHILD_FLAG)) {
  await runServerChild(port);
} else {
  await runParent();
}

async function runParent() {
  const monsterCounts = parseList("--monsters", MONSTER_COUNTS);
  const hunterCounts = parseList("--hunters", HUNTER_COUNTS);
  const repeat = parseNumber("--repeat", 3);
  const socketDurationMs = parseNumber("--socket-duration", 8000);
  const socketRepeat = parseNumber("--socket-repeat", 3);
  const socketBots = parseNumber("--socket-bots", 500);
  const ticks = parseNumber("--ticks", 500);
  const socketOnly = process.argv.includes("--socket-only");
  const skipSocket = process.argv.includes("--skip-socket");

  console.log("PoC #3 load test - docs/design-hunting-inventory.md §9");
  console.log(
    `  node ${process.version}, VIEW_RADIUS_TILES=${VIEW_RADIUS_TILES}, PATCH_RATE_MS=${PATCH_RATE_MS}, ` +
      `MONSTER_TICK_MS=${MONSTER_TICK_MS}`,
  );
  console.log(`  sweep: monsters ${monsterCounts.join("/")} x hunters ${hunterCounts.join("/")}`);
  console.log(
    `  bars: move <= ${ACCEPTANCE_BAR_MS_PER_MOVE} ms, tick mean <= ${TICK_MEAN_BAR_MS} ms / p99 <= ${TICK_P99_BAR_MS} ms, ` +
      `loop delay p99 <= ${EVENT_LOOP_P99_BAR_MS} ms, latency p95 <= ${LATENCY_REGRESSION_FACTOR}x baseline`,
  );

  const huntingMap = await new TiledMapLoader().load(HUNTING_ROOM.mapKey);
  const band = walkableTiles(huntingMap, MONSTER_BAND.minY, MONSTER_BAND.maxY).length;
  console.log(
    `\nhunting-ground: ${huntingMap.widthInTiles}x${huntingMap.heightInTiles}, ` +
      `${band} walkable tiles in the y${MONSTER_BAND.minY}-${MONSTER_BAND.maxY} monster band, ` +
      `product maxClients=${HUNTING_ROOM.maxClients}`,
  );

  const sweepPoints = [];
  for (const monsters of monsterCounts) {
    for (const hunters of hunterCounts) sweepPoints.push({ monsters, hunters });
  }

  const results = { tierA: [], tierB: [], tierC: [], tierD: [], socketBaseline: [] };

  if (!socketOnly) {
    const { maps } = generateMaps();
    console.log("\ngenerated poc2 sweep maps:");
    for (const map of maps) console.log(`  ${map.mapKey}: ${map.width}x${map.height}, ${map.walkable} walkable`);
    const grandPlaza = maps[maps.length - 1];

    const solo = await createWorld({ monsters: 0, hunters: 0, map: huntingMap, seed: 0xc0ffee });
    const worlds = [solo];
    for (const point of sweepPoints) {
      worlds.push(await createWorld({ ...point, map: huntingMap, seed: 0xc0ffee }));
    }
    const worst = worlds[worlds.length - 1];

    /* ---- tier A ---- */
    // One move stands for 1/10,000 s of production traffic (500 clients x the rate limit).
    const moveSimulatedMs = 1000 / GRAND_PLAZA_MOVES_PER_SECOND;
    const moveConfigs = [];
    for (const map of maps) {
      moveConfigs.push({ world: solo, label: "A dispersed", legacy: false, map, bots: map.bots, cluster: undefined, samples: 20000, warmup: 5000, seed: 0xa11ce });
    }
    for (const world of worlds.slice(1)) {
      moveConfigs.push({ world, label: "A dispersed", legacy: false, map: grandPlaza, bots: grandPlaza.bots, cluster: undefined, samples: 20000, warmup: 5000, seed: 0xa11ce });
    }
    for (const map of maps.slice(0, -1)) {
      moveConfigs.push({ world: worst, label: "A dispersed", legacy: false, map, bots: map.bots, cluster: undefined, samples: 20000, warmup: 5000, seed: 0xa11ce });
    }
    // Resolved once per configuration, never per round: the closure carries the world's clock and
    // rebuilding it each round would rewind that clock (see `createCoTenant`).
    for (const config of moveConfigs) config.between = config.world.betweenFor(moveSimulatedMs);
    console.log(`\ntier A - per-move CPU: ${repeat} interleaved rounds over ${moveConfigs.length} configurations`);
    results.tierA = await measureInterleaved(
      async (config) => ({ ...(await runMoveScenario(config)), world: config.world.label }),
      moveConfigs,
      repeat,
      "tier A",
    );
    printMoveRows(results.tierA);
    printCoTenantWork("after tier A", worlds);

    /* ---- tier B ---- */
    // Only the control and the heaviest point: the encode tier is the slowest one to run and the
    // sweep's variable (monster population) reaches grand-plaza's encoder through nothing but
    // shared CPU, so the two endpoints bound whatever the middle would have shown.
    const patchConfigs = [];
    for (const encoderBufferBytes of [DEFAULT_ENCODER_BUFFER_BYTES, 8 * 1024 * 1024]) {
      for (const world of [solo, worst]) {
        for (const scenario of [{ label: "A dispersed", cluster: undefined, seed: 0xa11ce }, { label: "B plaza", cluster: "plaza", seed: 0xb0b }]) {
          patchConfigs.push({ ...scenario, world, map: grandPlaza, bots: 500, patches: 25, movesPerPatch: 1000, encoderBufferBytes });
        }
      }
    }
    for (const config of patchConfigs) config.between = config.world.betweenFor(PATCH_RATE_MS);
    console.log(`\ntier B - per-patch encode CPU: ${repeat} interleaved rounds over ${patchConfigs.length} configurations`);
    results.tierB = await measureInterleaved(
      async (config) => ({ ...(await runPatchScenario(config)), world: config.world.label }),
      patchConfigs,
      repeat,
      "tier B",
    );
    printPatchRows(results.tierB);
    printCoTenantWork("after tier B (cumulative)", worlds);

    /* ---- tier C ---- */
    console.log(`\ntier C - hunting tick cost: ${repeat} interleaved rounds over ${sweepPoints.length} configurations, ${ticks} ticks each`);
    const tickRuns = [];
    for (let round = 0; round < repeat; round++) {
      for (const [index, point] of sweepPoints.entries()) {
        if (tickRuns[index] === undefined) tickRuns[index] = [];
        tickRuns[index].push(await runTickScenario({ ...point, map: huntingMap, ticks, warmup: 50, seed: 0xdecafbad }));
        if (process.stdout.isTTY) process.stdout.write(`\r  tier C: round ${round + 1}/${repeat}, configuration ${index + 1}/${sweepPoints.length}   `);
      }
    }
    if (process.stdout.isTTY) process.stdout.write(`\r${"".padEnd(72)}\r`);
    results.tierC = tickRuns.map(aggregateTickRuns);
    printTickRows(results.tierC);
    console.log(`\nRSS after the in-process tiers: ${rssMb()} MB`);
  }

  if (!skipSocket) {
    console.log(`\ntier D - websocket, server in a child process (port ${port})`);
    const server = spawnServerChild(port);
    await server.ready;
    const Client = await loadClientSdk();
    const endpoint = `ws://127.0.0.1:${port}`;
    try {
      const { bots: plazaBots } = await joinBots({ Client, endpoint, roomName: "grand-plaza", roomId: null, count: socketBots, label: "plaza bots" });
      console.log(`  ${plazaBots.length} grand-plaza bots joined`);

      // The baseline is one point of the rotation rather than a first pass of its own: running it
      // once, cold, before everything else is precisely how a drifting machine manufactures a
      // regression that is not there.
      const socketPoints = [{ monsters: 0, hunters: 0 }, ...sweepPoints];
      const runsByPoint = new Map();
      for (let round = 0; round < socketRepeat; round++) {
        for (const point of socketPoints) {
          console.log(`  round ${round + 1}/${socketRepeat}, monsters=${point.monsters} hunters=${point.hunters}`);
          const rows = await runSocketPoint({ server, Client, endpoint, plazaBots, ...point, rates: SOCKET_RATES, durationMs: socketDurationMs });
          for (const row of rows) {
            const key = `${row.monsters}/${row.hunters}/${row.movesPerSecondPerBot}`;
            if (!runsByPoint.has(key)) runsByPoint.set(key, []);
            runsByPoint.get(key).push(row);
          }
        }
      }
      for (const runs of runsByPoint.values()) {
        const row = aggregateSocketRuns(runs);
        (row.monsters === 0 && row.hunters === 0 ? results.socketBaseline : results.tierD).push(row);
      }
      printSocketRows("baseline - no hunting room in the process", results.socketBaseline);
      for (const point of sweepPoints) {
        printSocketRows(
          `monsters=${point.monsters} hunters=${point.hunters}`,
          results.tierD.filter((row) => row.monsters === point.monsters && row.hunters === point.hunters),
        );
      }

      await Promise.all(plazaBots.map((state) => state.room.leave().catch(() => {})));
    } finally {
      await server.call("shutdown").catch(() => {});
      server.child.kill();
    }
  }

  printCriteria(results, { monsterCounts, hunterCounts });
}

/* ---------------------------------------------------------------- output ---- */

function printMoveRows(rows) {
  console.log("\nPer-move CPU, poc2 scenario A dispersed (grand-plaza conditions unchanged; only the co-tenant varies)");
  console.log("  co-tenant   n     map        k placed  k end    median ms   p95 ms    med spread        % of bar");
  for (const row of rows) {
    console.log(
      `  ${row.world.padEnd(11)} ${String(row.bots).padEnd(5)} ${`${row.map.width}x${row.map.height}`.padEnd(10)} ` +
        `${row.meanViewSizePlaced.toFixed(1).padEnd(9)} ${row.meanViewSizeEnd.toFixed(1).padEnd(8)} ` +
        `${ms(row.medianMs).padEnd(11)} ${ms(row.p95Ms).padEnd(9)} ` +
        `${`${ms(row.fastestMedianMs)}-${ms(row.slowestMedianMs)}`.padEnd(17)} ` +
        `${((row.medianMs / ACCEPTANCE_BAR_MS_PER_MOVE) * 100).toFixed(1)}%`,
    );
  }
}

/**
 * Proof that each co-tenant simulated what it claims to have simulated. The interesting column is
 * `tick ms total`: read against the grand-plaza cost in the same table, it is the whole reason
 * criterion 1 comes out where it does, and it is also the check that would have caught a stalled
 * clock (a world with ticks > 0 but a monster population that never stepped).
 */
function printCoTenantWork(title, worlds) {
  console.log(`\n  co-tenant work done, ${title}`);
  console.log("    co-tenant   sim seconds  ticks   patches  hunter moves  tick ms total  mean tick ms");
  for (const world of worlds) {
    if (world.tenant === null) {
      console.log(`    ${world.label.padEnd(11)} (control: poc2's loop with no hook attached)`);
      continue;
    }
    const { ticks, patches, hunterMoves, clockMs } = world.tenant.work;
    const total = world.tenant.tickSamples.reduce((sum, value) => sum + value, 0);
    console.log(
      `    ${world.label.padEnd(11)} ${(clockMs / 1000).toFixed(1).padEnd(12)} ${String(ticks).padEnd(7)} ` +
        `${String(patches).padEnd(8)} ${String(hunterMoves).padEnd(13)} ${total.toFixed(1).padEnd(14)} ` +
        `${ticks === 0 ? "n/a" : ms(total / ticks)}`,
    );
  }
}

function printPatchRows(rows) {
  console.log("\nPer-patch encode CPU - 500 views, 1000 moves per patch");
  console.log("  co-tenant   scenario      rect     buf     k placed  median ms   p95 ms    kB/patch   % of 100ms");
  for (const row of rows) {
    console.log(
      `  ${row.world.padEnd(11)} ${row.label.padEnd(13)} ${rectLabel(row.rect).padEnd(8)} ` +
        `${`${row.encoderBufferBytes / 1024}k`.padEnd(7)} ${row.meanViewSizePlaced.toFixed(1).padEnd(9)} ` +
        `${ms(row.medianMs).padEnd(11)} ${ms(row.p95Ms).padEnd(9)} ` +
        `${(row.meanBytesPerPatch / 1024).toFixed(1).padEnd(10)} ` +
        `${((row.medianMs / PATCH_RATE_MS) * 100).toFixed(1)}%`,
    );
  }
}

function printTickRows(rows) {
  console.log("\nHunting-ground tick() wall time (median of per-round statistics; pooled p99 over every round)");
  console.log("  monsters  hunters  alive  mean ms   p95 ms    p99 ms    max ms    pooled p99  n       % of 200ms tick");
  for (const row of rows) {
    console.log(
      `  ${String(row.monsters).padEnd(9)} ${String(row.hunters).padEnd(8)} ${String(row.living).padEnd(6)} ` +
        `${ms(row.meanMs).padEnd(9)} ${ms(row.p95Ms).padEnd(9)} ${ms(row.p99Ms).padEnd(9)} ${ms(row.maxMs).padEnd(9)} ` +
        `${ms(row.pooled.p99Ms).padEnd(11)} ${String(row.pooled.count).padEnd(7)} ` +
        `${((row.meanMs / MONSTER_TICK_MS) * 100).toFixed(2)}%`,
    );
  }
}

function printSocketRows(title, rows) {
  console.log(`\n  ${title}`);
  console.log("    rate/bot  plaza rate   refused  plaza move->patch          hunt move->patch           ticks  tick mean/p99      loop p99   loop p99 spread    RSS");
  for (const row of rows) {
    // `refused` is evidence, not decoration: a group whose moves are all refused by a wall is a
    // group that has stopped loading the server, and its latency column would look excellent.
    const latency = (report) =>
      report.latency.count === 0
        ? "no samples".padEnd(26)
        : `med ${ms(report.latency.medianMs)} p95 ${ms(report.latency.p95Ms)}`.padEnd(26);
    const refusedPercent = row.plaza.sent === 0 ? 0 : (row.plaza.refused / row.plaza.sent) * 100;
    console.log(
      `    ${String(row.movesPerSecondPerBot).padEnd(9)} ${`${row.plaza.achievedRate.toFixed(0)}/s`.padEnd(12)} ` +
        `${`${refusedPercent.toFixed(0)}%`.padEnd(8)} ${latency(row.plaza)} ${latency(row.hunt)} ` +
        `${String(row.tick.count).padEnd(6)} ${`${ms(row.tick.meanMs)}/${ms(row.tick.p99Ms)}`.padEnd(18)} ` +
        `${ms(row.loop.p99Ms).padEnd(10)} ${`${ms(row.loop.lowestP99Ms)}-${ms(row.loop.highestP99Ms)}`.padEnd(18)} ${row.serverRssMb} MB`,
    );
  }
}

/**
 * The five criteria of §9.3, each as a measured value against its bar.
 *
 * Prints per-criterion outcomes and the largest monster count that clears all of them. It does not
 * print an overall verdict and does not choose a mitigation: §10's gate row makes that the user's
 * call (G2), and a harness that announced a verdict would be answering a question it was not asked.
 */
function printCriteria(results, { monsterCounts }) {
  const verdict = (ok) => (ok ? "PASS" : "FAIL");
  console.log("\n\n=== §9.3 criteria ===");

  const cohabMoves = results.tierA.filter((row) => row.world !== "solo" && row.bots === 500);
  if (cohabMoves.length > 0) {
    const worst = cohabMoves.reduce((a, b) => (a.medianMs > b.medianMs ? a : b));
    console.log(
      `\n1. grand-plaza per-move CPU with a hunting ground co-resident, n=500` +
        `\n   worst point ${worst.world}: median ${ms(worst.medianMs)} ms/move vs bar ${ACCEPTANCE_BAR_MS_PER_MOVE} ms ` +
        `-> ${verdict(worst.medianMs <= ACCEPTANCE_BAR_MS_PER_MOVE)} (${((worst.medianMs / ACCEPTANCE_BAR_MS_PER_MOVE) * 100).toFixed(1)}% of the bar)`,
    );
    const solo = results.tierA.find((row) => row.world === "solo" && row.bots === 500);
    if (solo !== undefined) {
      console.log(`   same-session solo baseline: ${ms(solo.medianMs)} ms/move (co-tenant costs ${((worst.medianMs / solo.medianMs - 1) * 100).toFixed(1)}%)`);
    }
  }

  if (results.tierD.length > 0 && results.socketBaseline.length > 0) {
    console.log("\n2. grand-plaza move->patch p95 against the same-session baseline");
    for (const rate of SOCKET_RATES) {
      const base = results.socketBaseline.find((row) => row.movesPerSecondPerBot === rate);
      const rows = results.tierD.filter((row) => row.movesPerSecondPerBot === rate);
      if (base === undefined || rows.length === 0) continue;
      const worst = rows.reduce((a, b) => (a.plaza.latency.p95Ms > b.plaza.latency.p95Ms ? a : b));
      const bar = base.plaza.latency.p95Ms * LATENCY_REGRESSION_FACTOR;
      console.log(
        `   ${rate}/s/bot: baseline p95 ${ms(base.plaza.latency.p95Ms)} ms, bar ${ms(bar)} ms, ` +
          `worst M${worst.monsters}/H${worst.hunters} p95 ${ms(worst.plaza.latency.p95Ms)} ms -> ${verdict(worst.plaza.latency.p95Ms <= bar)}`,
      );
      const recorded = POC2_RECORDED_LATENCY.find((entry) => entry.movesPerSecondPerBot === rate);
      if (recorded !== undefined) {
        console.log(
          `     [for reference only] PoC #2's published p95 was ${recorded.p95Ms} ms -> bar ${(recorded.p95Ms * LATENCY_REGRESSION_FACTOR).toFixed(1)} ms; ` +
            `taken single-process at VIEW_RADIUS_TILES=13, so not a like-for-like comparator`,
        );
      }
    }
  }

  console.log("\n3. hunting tick cost");
  if (results.tierC.length > 0) {
    const worstMean = results.tierC.reduce((a, b) => (a.meanMs > b.meanMs ? a : b));
    const worstP99 = results.tierC.reduce((a, b) => (a.pooled.p99Ms > b.pooled.p99Ms ? a : b));
    console.log(
      `   tier C (in-process, ${results.tierC[0].pooled.count} samples per point)` +
        `\n     worst mean: M${worstMean.monsters}/H${worstMean.hunters} ${ms(worstMean.meanMs)} ms vs ${TICK_MEAN_BAR_MS} ms -> ${verdict(worstMean.meanMs <= TICK_MEAN_BAR_MS)}` +
        `\n     worst p99 : M${worstP99.monsters}/H${worstP99.hunters} ${ms(worstP99.pooled.p99Ms)} ms vs ${TICK_P99_BAR_MS} ms -> ${verdict(worstP99.pooled.p99Ms <= TICK_P99_BAR_MS)}`,
    );
  }
  if (results.tierD.length > 0) {
    const worst = results.tierD.reduce((a, b) => (a.tick.p99Ms > b.tick.p99Ms ? a : b));
    const worstMean = results.tierD.reduce((a, b) => (a.tick.meanMs > b.tick.meanMs ? a : b));
    console.log(
      `   tier D (real timer, both rooms loaded)` +
        `\n     worst mean: M${worstMean.monsters}/H${worstMean.hunters} ${ms(worstMean.tick.meanMs)} ms -> ${verdict(worstMean.tick.meanMs <= TICK_MEAN_BAR_MS)}` +
        `\n     worst p99 : M${worst.monsters}/H${worst.hunters} ${ms(worst.tick.p99Ms)} ms -> ${verdict(worst.tick.p99Ms <= TICK_P99_BAR_MS)}`,
    );
  }

  if (results.tierD.length > 0) {
    const worst = results.tierD.reduce((a, b) => (a.loop.p99Ms > b.loop.p99Ms ? a : b));
    const baselineWorst = results.socketBaseline.reduce((a, b) => (a.loop.p99Ms > b.loop.p99Ms ? a : b));
    console.log(
      `\n4. server event loop delay p99, both rooms loaded (measured inside the server process)` +
        `\n   worst M${worst.monsters}/H${worst.hunters} at ${worst.movesPerSecondPerBot}/s/bot: ${ms(worst.loop.p99Ms)} ms vs ${EVENT_LOOP_P99_BAR_MS} ms -> ${verdict(worst.loop.p99Ms <= EVENT_LOOP_P99_BAR_MS)}`,
    );
    console.log(`   worst point's own round-to-round spread: ${ms(worst.loop.lowestP99Ms)}-${ms(worst.loop.highestP99Ms)} ms over ${worst.rounds} rounds`);
    for (const row of results.socketBaseline) {
      console.log(
        `   baseline (no hunting room) at ${row.movesPerSecondPerBot}/s/bot: ${ms(row.loop.p99Ms)} ms ` +
          `(spread ${ms(row.loop.lowestP99Ms)}-${ms(row.loop.highestP99Ms)})`,
      );
    }
    // Two confounds sit under this number and both push it up before a single monster exists:
    // Windows' ~15.6 ms timer granularity, and grand-plaza's own `broadcastPatch` at 500 views,
    // which tier B measures at 13-50 ms of synchronous encoding. The baseline row is where both
    // already live, so the monster contribution is the delta from it and not the absolute value.
    console.log(
      `   [confounded] the no-monster baseline is already ${ms(baselineWorst.loop.p99Ms)} ms - Windows' ~15.6 ms timer ` +
        `granularity plus grand-plaza's own 500-view patch encode (tier B: 13-50 ms). Monster contribution is the ` +
        `delta: ${ms(worst.loop.p99Ms - baselineWorst.loop.p99Ms)} ms, against a baseline spread of ` +
        `${ms(baselineWorst.loop.highestP99Ms - baselineWorst.loop.lowestP99Ms)} ms`,
    );
  }

  console.log("\n5. largest monster count clearing every criterion measured above");
  for (const monsters of monsterCounts) {
    const notes = [];
    const move = results.tierA.filter((row) => row.world.startsWith(`M${monsters}/`) && row.bots === 500);
    if (move.length > 0) notes.push(`move ${verdict(move.every((row) => row.medianMs <= ACCEPTANCE_BAR_MS_PER_MOVE))}`);
    const tick = results.tierC.filter((row) => row.monsters === monsters);
    if (tick.length > 0) {
      notes.push(`tick ${verdict(tick.every((row) => row.meanMs <= TICK_MEAN_BAR_MS && row.pooled.p99Ms <= TICK_P99_BAR_MS))}`);
    }
    const socket = results.tierD.filter((row) => row.monsters === monsters);
    if (socket.length > 0) {
      notes.push(`loop ${verdict(socket.every((row) => row.loop.p99Ms <= EVENT_LOOP_P99_BAR_MS))}`);
      for (const rate of SOCKET_RATES) {
        const base = results.socketBaseline.find((row) => row.movesPerSecondPerBot === rate);
        const rows = socket.filter((row) => row.movesPerSecondPerBot === rate);
        if (base === undefined || rows.length === 0) continue;
        const bar = base.plaza.latency.p95Ms * LATENCY_REGRESSION_FACTOR;
        notes.push(`p95@${rate} ${verdict(rows.every((row) => row.plaza.latency.p95Ms <= bar))}`);
      }
    }
    console.log(`   ${String(monsters).padStart(4)} monsters: ${notes.join(", ")}`);
  }
  console.log("\n(No overall verdict and no mitigation is chosen here - design §10 makes that the user's call.)");
}
