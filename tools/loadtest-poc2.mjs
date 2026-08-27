// Go/No-go PoC #2 capacity measurement (docs/poc2-design.md §6.3-6.4).
//
//   npx tsx tools/loadtest-poc2.mjs                 # move cost + patch cost (deterministic)
//   npx tsx tools/loadtest-poc2.mjs --socket        # also the websocket tier (real bots)
//   npx tsx tools/loadtest-poc2.mjs --cluster-halves 6,8,10   # override the scenario B sweep
//                                                     (cwd = code/)
//
// Deliberately not a *.test.ts: it takes minutes and its output is a measurement, not an
// assertion, so CI must not run it (design §6.4).
//
// Three tiers, because one harness cannot measure all three things without one polluting another:
//
//   1. per-move server CPU  - the acceptance bar (<= 0.10 ms/move at n=500). Driven through
//      `handleMove` with in-process clients so the sample is the move path and nothing else,
//      which is also how the T2 baseline of 5.95 ms/move was taken (docs/decisions.md 2026-08-25).
//   2. per-patch encode CPU - design §6.5's declared unknown. Clients are pushed into
//      `room.clients` with a byte-counting `raw()`, so `broadcastPatch()` runs the real
//      per-view encoder with no socket or client-side decode in the sample.
//   3. websocket tier       - achieved rate, move->patch latency as a bot observes it, RSS.
//      Server and 500 bots share one process, so its latency is an upper bound, not the server's.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CODE_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));

const {
  ClientMessage,
  Direction,
  PATCH_RATE_MS,
  ServerMessage,
  VIEW_RADIUS_TILES,
  MAX_MOVES_PER_SECOND,
  VIEWPORT_HEIGHT_TILES,
  VIEWPORT_WIDTH_TILES,
  cameraBorderTiles,
} = await import(pathToFileURL(join(CODE_DIR, "shared/src/index.ts")).href);
const { MetaverseRoom } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/rooms/metaverseRoom.ts")).href
);
const { NaiveProximityIndex } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/game/proximity.ts")).href
);
const { TiledMapLoader } = await import(
  pathToFileURL(join(CODE_DIR, "server/src/game/tiledMap.ts")).href
);
const { ClientState } = await import(pathToFileURL(join(CODE_DIR, "node_modules/@colyseus/core/build/index.mjs")).href);
const { SchemaSerializer } = await import(
  pathToFileURL(join(CODE_DIR, "node_modules/@colyseus/core/build/serializer/SchemaSerializer.mjs")).href
);
// Bare specifier on purpose: `@colyseus/core` imports the encoder the same way, and the static
// `Encoder.BUFFER_SIZE` below only reaches the serializer if both land on the same module instance.
const { Encoder } = await import("@colyseus/schema");

/** Encoder default. At 500 views one patch needs ~6.5 MB, and it grows in steps of this size. */
const DEFAULT_ENCODER_BUFFER_BYTES = Encoder.BUFFER_SIZE;

/** Bar from design §6.3: one core has to absorb 500 clients x MAX_MOVES_PER_SECOND. */
const ACCEPTANCE_BAR_MS_PER_MOVE = 0.1;
const DIRECTIONS = [Direction.Up, Direction.Down, Direction.Left, Direction.Right];

/* ------------------------------------------------------------------ util ---- */

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedMs, fraction) {
  if (sortedMs.length === 0) return Number.NaN;
  const index = Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * fraction));
  return sortedMs[index];
}

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    meanMs: total / sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
  };
}

const ms = (value) => (Number.isFinite(value) ? value.toFixed(4) : "n/a");
const rssMb = () => (process.memoryUsage().rss / 1024 / 1024).toFixed(0);

/* ------------------------------------------------------------------ maps ---- */

/**
 * Density-controlled sweep maps (design §6.3): raising n on a fixed map makes both the old and
 * the new design curve upward, so it cannot tell them apart. Map area has to scale with n so
 * that k stays put and only n varies. Sizes chosen so walkable area halves with n:
 * 80*ab+240 walkable cells for an interior of 10a x 10b super-tiles.
 *
 * Stated as *interior* size on purpose. The outer size the generator wants is the interior plus
 * the camera border, and that border moves whenever the viewport does (2026-08-27: 20x15 -> 32x18
 * grew it from {10,10,7,8} to {16,16,8,9}). Pinning the interior is what keeps every number this
 * harness has already published comparable across that change - the walkable count, and therefore
 * the density k each row was built to hold, is unchanged.
 */
const SWEEP = [
  { bots: 125, interiorWidth: 110, interiorHeight: 40 },
  { bots: 250, interiorWidth: 100, interiorHeight: 90 },
  { bots: 500, interiorWidth: 140, interiorHeight: 130 },
];

/** Same source the generator derives its border from; never restate the numbers here. */
const BORDER = cameraBorderTiles(VIEWPORT_WIDTH_TILES, VIEWPORT_HEIGHT_TILES);

function sweepMapSize({ interiorWidth, interiorHeight }) {
  return {
    width: interiorWidth + BORDER.left + BORDER.right,
    height: interiorHeight + BORDER.top + BORDER.bottom,
  };
}

function generateMaps() {
  const directory = mkdtempSync(join(tmpdir(), "poc2-maps-"));
  const maps = [];
  for (const entry of SWEEP) {
    const { bots } = entry;
    const { width, height } = sweepMapSize(entry);
    const mapKey = `sweep-${bots}`;
    const stdout = execFileSync(
      process.execPath,
      ["tools/generate-load-map.mjs", "--width", String(width), "--height", String(height), "--out", join(directory, `${mapKey}.json`)],
      { cwd: CODE_DIR, encoding: "utf8" },
    );
    const walkable = Number(/(\d+) walkable/.exec(stdout)?.[1]);
    maps.push({ bots, mapKey, width, height, walkable, directory });
  }
  return { directory, maps };
}

/** The generator's own geometry rules (tools/generate-load-map.mjs), needed to find the plaza. */
function plazaRect(width, height) {
  const superCountX = (width - BORDER.left - BORDER.right) / 10;
  const superCountY = (height - BORDER.top - BORDER.bottom) / 10;
  const i0 = Math.floor((superCountX - 4) / 2);
  const j0 = Math.floor((superCountY - 3) / 2);
  return {
    minX: BORDER.left + i0 * 10,
    maxX: BORDER.left + (i0 + 4) * 10 - 1,
    minY: BORDER.top + j0 * 10,
    maxY: BORDER.top + (j0 + 3) * 10 - 1,
  };
}

/**
 * Where a scenario's bots are placed. `undefined` spreads them over the whole walkable map
 * (design §6.1); `"plaza"` confines them to the open central plaza; a number confines them to a
 * Chebyshev square of that half-extent at the plaza centre, which is how k is pushed past what
 * the plaza alone reaches — bots near the plaza edge have a view square that hangs off the crowd,
 * so spreading over all of it leaves k well short of the crowd size.
 *
 * The square is clamped to the plaza, so a half-extent larger than the plaza allows silently
 * degenerates into the `"plaza"` case. Callers that sweep half-extents must report that clamp
 * (see `clusterPlan`) instead of presenting the result as a tighter cluster than it is.
 */
function placementRect(map, cluster) {
  if (cluster === undefined) return undefined;
  const plaza = plazaRect(map.width, map.height);
  if (cluster === "plaza") return plaza;
  const centreX = Math.floor((plaza.minX + plaza.maxX) / 2);
  const centreY = Math.floor((plaza.minY + plaza.maxY) / 2);
  return {
    minX: Math.max(plaza.minX, centreX - cluster),
    maxX: Math.min(plaza.maxX, centreX + cluster),
    minY: Math.max(plaza.minY, centreY - cluster),
    maxY: Math.min(plaza.maxY, centreY + cluster),
  };
}

function rectSpan(rect) {
  if (rect === undefined) return null;
  return { width: rect.maxX - rect.minX + 1, height: rect.maxY - rect.minY + 1 };
}

/** Table cell for a placement: its tile span, or `whole` for the unconfined map-wide case. */
function rectLabel(rect) {
  const span = rectSpan(rect);
  return span === null ? "whole" : `${span.width}x${span.height}`;
}

/**
 * Half-extents swept to find the clustered worst case, tightest first.
 *
 * Deliberately *not* derived from VIEW_RADIUS_TILES, which is what this list replaced
 * (2026-08-27). Tying it to the camera radius meant the 13 -> 19 widening asked for a 39x39
 * square, `placementRect` clamped that to the 40x30 plaza, and scenario B silently stopped being
 * a cluster: it re-measured the whole plaza and published that easier number as the worst case.
 *
 * Swept rather than pinned to one corrected constant because the peak moves with the radius —
 * it sat at 27x27 when the radius was 13 and at 21x21 once it became 19 — so any single pinned
 * extent goes stale the next time the viewport moves, and finding the new one by hand is exactly
 * the work this list exists to avoid. 13 stays in it so the 27x27 row already on record
 * (docs/decisions.md 2026-08-26) remains a like-for-like comparison.
 *
 * Why a tighter square can be *cheaper* than a looser one, i.e. why there is a peak to find at
 * all: once the crowd fits inside one view radius every bot already sees every other, so a step
 * adds and removes nothing and only the mover's own view is rebuilt. The cost peaks just before
 * that, where views are nearly full *and* still churn at the boundary on every step.
 */
const CLUSTER_HALF_EXTENTS = [6, 8, 10, 13, 16, 19];

/** One sweep point, resolved against a map so the clamp is known before the run starts. */
function clusterPlan(map, half) {
  const rect = placementRect(map, half);
  const span = rectSpan(rect);
  const requested = half * 2 + 1;
  return {
    half,
    rect,
    span,
    requested,
    clamped: span.width < requested || span.height < requested,
    key: `${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`,
  };
}

/* ------------------------------------------------------------------ room ---- */

/** The pre-PoC production path, rebuilt without touching production code, for the head-to-head. */
class LegacyRoom extends MetaverseRoom {
  createProximityIndex() {
    return new NaiveProximityIndex();
  }
}

/**
 * `refreshViews()` as it stood before this PoC: one full recompute per client in the room on
 * every single move (design §5.1). `refreshViewFor` is that loop's body verbatim (design §5.4),
 * so walking every client through it reproduces the old cost — if anything slightly under it,
 * since the old version also paid a `clients.getById()` scan the rebuild does not (design §5.6).
 */
function installLegacyRefresh(room) {
  room.refreshViewsAround = function legacyRefreshViews() {
    for (const sessionId of this.clientsBySession.keys()) {
      this.refreshViewFor(sessionId);
    }
  };
}

function fakeClient(sessionId) {
  return {
    sessionId,
    auth: { ssoNickname: null },
    state: ClientState.JOINED,
    send: () => {},
    raw: () => {},
  };
}

async function buildRoom({ legacy, mapKey, mapsDirectory, spawn }) {
  const room = legacy ? new LegacyRoom() : new MetaverseRoom();
  if (mapsDirectory !== undefined) {
    room.mapLoader = new TiledMapLoader(mapsDirectory);
  }
  await room.onCreate({ roomType: "loadtest", mapKey, maxClients: 1000, spawn });
  // The patch interval would fire mid-measurement and charge encode time to a move sample.
  room.setPatchRate(null);
  if (legacy) {
    installLegacyRefresh(room);
  }
  return room;
}

/**
 * Joins `count` bots, then relocates them onto `layout`'s tiles and rebuilds every view, so both
 * implementations start from a byte-identical configuration for the same seed. Join cost is not
 * part of the measurement, which is why the spawn spread is left at 0.
 */
function populate(room, count, layout) {
  const clients = [];
  for (let index = 0; index < count; index++) {
    const client = fakeClient(`bot${index}`);
    room.onJoin(client, { nickname: `bot${index}`, avatarSkin: 0 });
    clients.push(client);
  }
  for (const client of clients) {
    const tile = layout();
    const player = room.state.players.get(client.sessionId);
    player.tileX = tile.tileX;
    player.tileY = tile.tileY;
    room.proximityIndex.move(client.sessionId, tile);
  }
  for (const client of clients) {
    room.refreshViewFor(client.sessionId);
  }
  return clients;
}

/** Uniform over the walkable tiles of a rectangle; unbounded rejection, so it is map-size agnostic. */
function uniformWalkable(room, random, rect) {
  const map = room.collisionMap;
  const bounds = rect ?? { minX: 0, maxX: map.widthInTiles - 1, minY: 0, maxY: map.heightInTiles - 1 };
  const spanX = bounds.maxX - bounds.minX + 1;
  const spanY = bounds.maxY - bounds.minY + 1;
  return () => {
    for (;;) {
      const tileX = bounds.minX + Math.floor(random() * spanX);
      const tileY = bounds.minY + Math.floor(random() * spanY);
      if (map.isWalkable(tileX, tileY)) return { tileX, tileY };
    }
  };
}

function meanViewSize(room) {
  let total = 0;
  for (const viewed of room.viewedBySession.values()) total += viewed.size;
  return total / room.viewedBySession.size;
}

/* ------------------------------------------------------- tier 1: per move ---- */

function measureMoveCost(room, clients, random, { samples, warmup }) {
  const timings = [];
  let accepted = 0;
  let rejected = 0;
  // Read *before* the loop, and reported alongside the after value rather than instead of it:
  // the loop walks each bot ~50 random steps, which diffuses a cluster by ~7 tiles RMS, so a k
  // read only at the end understates the density the scenario was built to hold (2026-08-27: the
  // whole-plaza row placed at k=324 and was published as 294.5).
  const meanViewSizePlaced = meanViewSize(room);

  for (let index = 0; index < samples + warmup; index++) {
    const client = clients[Math.floor(random() * clients.length)];
    const dir = DIRECTIONS[Math.floor(random() * DIRECTIONS.length)];
    const player = room.state.players.get(client.sessionId);
    const beforeX = player.tileX;
    const beforeY = player.tileY;
    // The throttle is a rate limit, not part of the per-move cost being measured.
    client.userData.lastMoveAt = 0;

    const start = process.hrtime.bigint();
    room.handleMove(client, { dir });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    if (player.tileX === beforeX && player.tileY === beforeY) {
      rejected++;
      continue;
    }
    accepted++;
    // Warmup samples are dropped: the first few hundred calls measure V8 warming up, and the
    // legacy path would look artificially close to the new one if they were kept.
    if (index >= warmup) timings.push(elapsedMs);
  }

  return { ...summarize(timings), accepted, rejected, meanViewSizePlaced, meanViewSizeEnd: meanViewSize(room) };
}

async function runMoveScenario({ label, legacy, map, bots, cluster, samples, warmup, seed }) {
  const spawnRect = placementRect(map, cluster);
  const spawn = {
    tileX: Math.floor(map.width / 2),
    tileY: Math.floor(map.height / 2),
    spreadRadiusInTiles: 0,
  };
  const room = await buildRoom({ legacy, mapKey: map.mapKey, mapsDirectory: map.directory, spawn });
  // Two PRNGs: the layout must be identical across implementations even when the move loop
  // draws a different number of times because a different number of steps got refused.
  const layoutRandom = seededRandom(seed);
  const moveRandom = seededRandom(seed ^ 0x9e37_79b9);
  try {
    const clients = populate(room, bots, uniformWalkable(room, layoutRandom, spawnRect));
    const result = measureMoveCost(room, clients, moveRandom, { samples, warmup });
    return { label, legacy, bots, map, cluster, rect: spawnRect, ...result };
  } finally {
    room.setPatchRate(null);
  }
}

/** Median of per-run medians: one run's median moves by up to 2x on a machine with turbo. */
function aggregateTimings(runs) {
  const medians = runs.map((run) => run.medianMs).sort((a, b) => a - b);
  const p95s = runs.map((run) => run.p95Ms).sort((a, b) => a - b);
  const middle = Math.floor(runs.length / 2);
  return {
    // Everything the run reports that is a function of the seed rather than of the clock — k,
    // byte counts, accept/reject split — is identical in every round, so round 0 carries it.
    ...runs[0],
    medianMs: medians[middle],
    p95Ms: p95s[middle],
    slowestMedianMs: medians[medians.length - 1],
    fastestMedianMs: medians[0],
    runs: runs.length,
  };
}

/**
 * Runs every configuration once per round, round after round, instead of finishing one
 * configuration before starting the next.
 *
 * Ordering is not a detail here, it decides the answer. On a throttling laptop part (the machine
 * of record is a 15 W i7-1255U) a multi-minute run gets monotonically slower, so configurations
 * measured late look worse than ones measured early by more than the effect being searched for:
 * measured back to back, the 39x30 and 40x30 placements — one column apart, k 330 vs 324 — came
 * out 47% apart, and the reported "worst" cluster simply followed whichever square the sweep
 * happened to visit around the throttle knee. Interleaving spreads that drift over every
 * configuration alike, which is what makes the per-configuration median comparable at all.
 *
 * This is also why the spread columns are printed rather than the median alone: if a peak is not
 * separated by more than the fastest-to-slowest band, it has not been resolved.
 */
async function measureInterleaved(runOnce, configs, rounds, progressLabel) {
  const runs = configs.map(() => []);
  for (let round = 0; round < rounds; round++) {
    for (const [index, config] of configs.entries()) {
      runs[index].push(await runOnce(config));
      // Only on a terminal: these runs are captured to a file for the record, and a carriage
      // return leaves every progress tick in it as one unreadable line.
      if (process.stdout.isTTY) {
        process.stdout.write(`\r  ${progressLabel}: round ${round + 1}/${rounds}, configuration ${index + 1}/${configs.length}   `);
      }
    }
  }
  if (process.stdout.isTTY) process.stdout.write(`\r${"".padEnd(72)}\r`);
  return runs.map(aggregateTimings);
}

/* ------------------------------------------------------ tier 2: per patch ---- */

/**
 * Per-patch encode cost (design §6.5). Colyseus re-encodes the changed state once per distinct
 * StateView, so this is the one cost the two PoC tickets do not touch at all; if the bottleneck
 * has moved here, that is the finding, not something to fix in this pass.
 */
async function runPatchScenario({ label, map, bots, cluster, patches, movesPerPatch, seed, encoderBufferBytes }) {
  const spawnRect = placementRect(map, cluster);
  Encoder.BUFFER_SIZE = encoderBufferBytes;
  // Each grow-and-re-encode logs one line; at the 8 KB default that is hundreds of lines per
  // patch, so the count is the measurement here, not noise to be discarded.
  let overflowWarnings = 0;
  const realWarn = console.warn;
  console.warn = (message) => {
    if (typeof message === "string" && message.includes("buffer overflow")) overflowWarnings++;
    else realWarn(message);
  };
  const room = await buildRoom({
    legacy: false,
    mapKey: map.mapKey,
    mapsDirectory: map.directory,
    spawn: { tileX: Math.floor(map.width / 2), tileY: Math.floor(map.height / 2), spreadRadiusInTiles: 0 },
  });
  // A bare room keeps the NoneSerializer: `SchemaSerializer` is installed by the `state` setter
  // that `Room.__init()` defines, and only the matchmaker calls that. Installed here instead of
  // in buildRoom so the move tier stays free of any encoder bookkeeping.
  const serializer = new SchemaSerializer();
  serializer.reset(room.state);
  room.setSerializer(serializer);
  const layoutRandom = seededRandom(seed);
  const moveRandom = seededRandom(seed ^ 0x1234_5678);
  try {
    const clients = populate(room, bots, uniformWalkable(room, layoutRandom, spawnRect));
    // Same reason as the move tier: `patches * movesPerPatch` steps diffuse the cluster, so the
    // density this scenario was built to hold is only readable before the first patch.
    const meanViewSizePlaced = meanViewSize(room);
    // The serializer only encodes for clients in `room.clients`; `raw` is where the socket would be.
    let bytes = 0;
    for (const client of clients) {
      client.raw = (encoded) => {
        bytes += encoded.length;
      };
      room.clients.push(client);
    }

    const timings = [];
    const byteCounts = [];
    for (let patch = 0; patch < patches; patch++) {
      for (let move = 0; move < movesPerPatch; move++) {
        const client = clients[Math.floor(moveRandom() * clients.length)];
        client.userData.lastMoveAt = 0;
        room.handleMove(client, { dir: DIRECTIONS[Math.floor(moveRandom() * DIRECTIONS.length)] });
      }
      bytes = 0;
      const start = process.hrtime.bigint();
      room.broadcastPatch();
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      if (patch >= 3) {
        timings.push(elapsedMs);
        byteCounts.push(bytes);
      }
    }

    return {
      label,
      bots,
      movesPerPatch,
      encoderBufferBytes,
      overflowWarnings,
      rect: spawnRect,
      finalBufferBytes: serializer.encoder.sharedBuffer.byteLength,
      ...summarize(timings),
      meanBytesPerPatch: byteCounts.reduce((sum, value) => sum + value, 0) / byteCounts.length,
      meanViewSizePlaced,
      meanViewSizeEnd: meanViewSize(room),
    };
  } finally {
    console.warn = realWarn;
    Encoder.BUFFER_SIZE = DEFAULT_ENCODER_BUFFER_BYTES;
    room.clients.length = 0;
    room.setPatchRate(null);
  }
}

/* -------------------------------------------------------- tier 3: sockets ---- */

async function runSocketScenario({ bots, movesPerSecondPerBot, durationMs }) {
  const { createGameServer } = await import(pathToFileURL(join(CODE_DIR, "server/src/server.ts")).href);
  const { Client } = await import(pathToFileURL(join(CODE_DIR, "node_modules/@colyseus/sdk/build/index.mjs")).href);

  const port = 2599;
  const gameServer = createGameServer();
  await gameServer.listen(port);

  const endpoint = `ws://127.0.0.1:${port}`;
  const bot = async (index, roomId) => {
    const client = new Client(endpoint);
    const options = { nickname: `bot${index}`, avatarSkin: 0 };
    const room =
      roomId === null
        ? await client.create("grand-plaza", options)
        : await client.joinById(roomId, options);
    const state = { room, sentAt: 0, tile: null, latencies: [], sent: 0, refused: 0 };
    // A step into a wall never moves the player, so leaving `sentAt` set would charge its wait
    // to whatever move lands next and invent latency that never happened.
    room.onMessage(ServerMessage.MoveRejected, () => {
      state.refused++;
      state.sentAt = 0;
    });
    room.onStateChange(() => {
      const player = room.state.players.get(room.sessionId);
      if (!player) return;
      const tile = `${player.tileX},${player.tileY}`;
      if (state.tile !== null && tile !== state.tile && state.sentAt !== 0) {
        state.latencies.push(performance.now() - state.sentAt);
        state.sentAt = 0;
      }
      state.tile = tile;
    });
    return state;
  };

  const first = await bot(0, null);
  const roomId = first.room.roomId;
  const bots_ = [first];
  // Batched rather than all at once: 500 concurrent seat reservations spill into a second room,
  // and `joinById` on a room that has just locked itself rejects.
  const batchSize = 25;
  for (let index = 1; index < bots; index += batchSize) {
    const batch = [];
    for (let offset = 0; offset < batchSize && index + offset < bots; offset++) {
      batch.push(bot(index + offset, roomId));
    }
    bots_.push(...(await Promise.all(batch)));
    process.stdout.write(`\r  joined ${bots_.length}/${bots}   `);
  }
  process.stdout.write("\n");

  let cursor = 0;
  let sent = 0;
  const startedAt = performance.now();
  // Paced off the deficit rather than a fixed count per tick: Windows timers fire at ~15 ms
  // whatever the interval asks for, so a per-tick quota silently caps the achieved rate.
  await new Promise((done) => {
    const timer = setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const due = Math.floor((elapsed / 1000) * bots_.length * movesPerSecondPerBot);
      while (sent < due) {
        const state = bots_[cursor++ % bots_.length];
        if (state.sentAt === 0) state.sentAt = performance.now();
        state.room.send(ClientMessage.Move, { dir: DIRECTIONS[cursor % DIRECTIONS.length] });
        state.sent++;
        sent++;
      }
      if (elapsed >= durationMs) {
        clearInterval(timer);
        done();
      }
    }, 4);
  });
  const elapsedMs = performance.now() - startedAt;
  // One patch interval of settling, so in-flight moves land before the latency sample is read.
  await new Promise((done) => setTimeout(done, PATCH_RATE_MS * 3));

  const latencies = bots_.flatMap((state) => state.latencies);
  const report = {
    bots: bots_.length,
    targetRate: bots_.length * movesPerSecondPerBot,
    achievedRate: (sent / elapsedMs) * 1000,
    sent,
    refused: bots_.reduce((total, state) => total + state.refused, 0),
    latency: summarize(latencies),
    rssMb: rssMb(),
  };
  await Promise.all(bots_.map((state) => state.room.leave().catch(() => {})));
  await gameServer.gracefullyShutdown(false);
  return report;
}

/* ------------------------------------------------------------------ main ---- */

// `k placed` is the density the scenario was built to hold, `k end` what the random walk had
// diffused it to by the last sample; the move cost belongs to the range between them.
function printMoveTable(title, rows) {
  console.log(`\n${title}`);
  console.log("  impl     n     map        rect     k placed  k end    median ms   p95 ms    med spread        moves/s (1 core)");
  for (const row of rows) {
    const perSecond = row.medianMs > 0 ? Math.round(1000 / row.medianMs) : Number.NaN;
    console.log(
      `  ${(row.legacy ? "legacy" : "new").padEnd(8)} ${String(row.bots).padEnd(5)} ` +
        `${`${row.map.width}x${row.map.height}`.padEnd(10)} ${rectLabel(row.rect).padEnd(8)} ` +
        `${row.meanViewSizePlaced.toFixed(1).padEnd(9)} ${row.meanViewSizeEnd.toFixed(1).padEnd(8)} ` +
        `${ms(row.medianMs).padEnd(11)} ${ms(row.p95Ms).padEnd(9)} ` +
        `${`${ms(row.fastestMedianMs)}-${ms(row.slowestMedianMs)}`.padEnd(17)} ` +
        `${perSecond.toLocaleString("en-US")}`,
    );
  }
}

const socketsOnly = process.argv.includes("--socket-only");
const wantSockets = socketsOnly || process.argv.includes("--socket");
const repeatIndex = process.argv.indexOf("--repeat");
const repeat = repeatIndex === -1 ? 3 : Number.parseInt(process.argv[repeatIndex + 1] ?? "3", 10);
const botsIndex = process.argv.indexOf("--socket-bots");
const socketBots = botsIndex === -1 ? 500 : Number.parseInt(process.argv[botsIndex + 1] ?? "500", 10);
const halvesIndex = process.argv.indexOf("--cluster-halves");
const clusterHalfExtents =
  halvesIndex === -1
    ? CLUSTER_HALF_EXTENTS
    : (process.argv[halvesIndex + 1] ?? "").split(",").map((value) => Number.parseInt(value, 10));
if (clusterHalfExtents.length === 0 || clusterHalfExtents.some((half) => !Number.isInteger(half) || half < 1)) {
  console.error(
    `--cluster-halves: expected a comma-separated list of positive integers, got ${JSON.stringify(process.argv[halvesIndex + 1])}`,
  );
  process.exit(1);
}

async function runSocketTier() {
  for (const movesPerSecondPerBot of [8.33, MAX_MOVES_PER_SECOND]) {
    try {
      const report = await runSocketScenario({ bots: socketBots, movesPerSecondPerBot, durationMs: 8000 });
      console.log(
        `\nWebsocket tier - ${report.bots} bots, target ${Math.round(report.targetRate)} moves/s` +
          `\n  achieved      : ${report.achievedRate.toFixed(0)} moves/s (${report.sent} sent, ${report.refused} refused by a wall)` +
          `\n  move -> patch : median ${ms(report.latency.medianMs)} ms, p95 ${ms(report.latency.p95Ms)} ms, ` +
          `max ${ms(report.latency.maxMs)} ms (n=${report.latency.count})` +
          `\n  RSS           : ${report.rssMb} MB  [server + all bots in one process, so an upper bound]`,
      );
    } catch (error) {
      console.log(`\nWebsocket tier at ${movesPerSecondPerBot}/s/bot failed: ${error.stack}`);
    }
  }
}

if (socketsOnly) {
  await runSocketTier();
  process.exit(0);
}

console.log("PoC #2 load test - docs/poc2-design.md §6.3-6.4");
console.log(`  node ${process.version}, VIEW_RADIUS_TILES=${VIEW_RADIUS_TILES}, PATCH_RATE_MS=${PATCH_RATE_MS}`);
console.log(`  acceptance bar: <= ${ACCEPTANCE_BAR_MS_PER_MOVE} ms/move at n=500 (${500 * MAX_MOVES_PER_SECOND} moves/s worst case)`);

const { directory, maps } = generateMaps();
console.log(`\ngenerated sweep maps in ${directory}`);
for (const map of maps) {
  console.log(`  ${map.mapKey}: ${map.width}x${map.height}, ${map.walkable} walkable`);
}
const grandPlaza = maps[maps.length - 1];

const plazaPlacement = rectLabel(placementRect(grandPlaza, "plaza"));

const dispersedConfigs = maps.map((map) => ({
  label: "A dispersed", legacy: false, map, bots: map.bots, cluster: undefined, samples: 20000, warmup: 5000, seed: 0xa11ce,
}));
for (const map of maps) {
  // Fewer samples: the legacy path is ~2 orders of magnitude slower and the spread is tiny.
  dispersedConfigs.push({ label: "A dispersed", legacy: true, map, bots: map.bots, cluster: undefined, samples: 1500, warmup: 300, seed: 0xa11ce });
}

const clusterConfigs = [
  { label: "B plaza", legacy: false, map: grandPlaza, bots: 500, cluster: "plaza", samples: 20000, warmup: 5000, seed: 0xb0b },
  { label: "B plaza", legacy: true, map: grandPlaza, bots: 500, cluster: "plaza", samples: 600, warmup: 100, seed: 0xb0b },
];
console.log(`\nclustered sweep: half-extents ${clusterHalfExtents.join(", ")} at the ${plazaPlacement} plaza centre`);
const measuredRects = new Set();
for (const half of clusterHalfExtents) {
  const plan = clusterPlan(grandPlaza, half);
  if (plan.clamped) {
    console.log(
      `  half-extent ${half}: asked for ${plan.requested}x${plan.requested}, the ${plazaPlacement} plaza allows only ` +
        `${plan.span.width}x${plan.span.height} - CLAMPED, so this row is looser than requested`,
    );
  }
  // Two half-extents that clamp to the same rect would be the same measurement run twice.
  if (measuredRects.has(plan.key)) {
    console.log(`  half-extent ${half}: skipped, clamps onto the ${rectLabel(plan.rect)} rect already measured`);
    continue;
  }
  measuredRects.add(plan.key);
  clusterConfigs.push({ label: "B tight", legacy: false, map: grandPlaza, bots: 500, cluster: half, samples: 20000, warmup: 5000, seed: 0xb0b });
}

// Both scenarios in one interleaved pass, so that A and B are comparable to each other and not
// just within themselves - the cross-table claim ("dispersed has N times the headroom of a
// crowd") is read off exactly that comparison.
console.log(`\nmove tier: ${repeat} interleaved rounds over ${dispersedConfigs.length + clusterConfigs.length} configurations, median of each`);
const moveRows = await measureInterleaved(runMoveScenario, [...dispersedConfigs, ...clusterConfigs], repeat, "move tier");
const dispersed = moveRows.slice(0, dispersedConfigs.length);
const clustered = moveRows.slice(dispersedConfigs.length);

printMoveTable("Scenario A - dispersed, density held constant (k fixed, n varies)", dispersed);

// The whole plaza is in the running, not just the swept squares: the peak is a churn effect, not
// a pure density one, so the loosest clustered placement can beat every tighter one and picking
// the worst from the sweep alone would under-report again, in a new way.
const worstCluster = clustered
  .filter((row) => !row.legacy)
  .reduce((worst, row) => (row.medianMs > worst.medianMs ? row : worst));
// The head-to-head only has to be paid on the row that decides the verdict: the legacy path costs
// ~200x per sample, so sweeping it too would dominate runtime. If the plaza won, it already has one.
if (typeof worstCluster.cluster === "number") {
  const [legacyWorst] = await measureInterleaved(
    runMoveScenario,
    [{ label: "B tight", legacy: true, map: grandPlaza, bots: 500, cluster: worstCluster.cluster, samples: 400, warmup: 100, seed: 0xb0b }],
    repeat,
    "legacy head-to-head",
  );
  clustered.push(legacyWorst);
}

printMoveTable(
  `Scenario B - clustered, n=500 (plaza = the whole ${plazaPlacement} plaza; tight = a Chebyshev square at its centre)`,
  clustered,
);
const clusterName = (row) =>
  typeof row.cluster === "number" ? `half-extent ${row.cluster}` : "the whole plaza";
console.log(
  `  worst clustered placement: ${rectLabel(worstCluster.rect)} (${clusterName(worstCluster)}), ` +
    `median ${ms(worstCluster.medianMs)} ms/move = ${((worstCluster.medianMs / ACCEPTANCE_BAR_MS_PER_MOVE) * 100).toFixed(1)}% of the ` +
    `${ACCEPTANCE_BAR_MS_PER_MOVE} ms bar`,
);
const densestCluster = clustered
  .filter((row) => !row.legacy)
  .reduce((densest, row) => (row.meanViewSizePlaced > densest.meanViewSizePlaced ? row : densest));
console.log(
  `  densest clustered placement: ${rectLabel(densestCluster.rect)} (${clusterName(densestCluster)}), ` +
    `k ${densestCluster.meanViewSizePlaced.toFixed(1)} as placed`,
);

// Both buffer sizes on purpose: the 8 KB default grows 8 KB at a time and re-encodes the whole
// patch on every step, so measuring only the default would report the growth, not the encoder.
const PRESIZED_ENCODER_BUFFER_BYTES = 8 * 1024 * 1024;
// The move tier's worst placement and its densest one need not be the same square - move cost
// peaks on view *churn*, encode cost tracks k and therefore bytes - so both get an encode row,
// deduplicated when they coincide. Carrying the move tier's own worst placement over is what lets
// the two tiers' worst-case rows be added into one core budget.
const patchScenarios = [
  { label: "A dispersed", cluster: undefined, seed: 0xa11ce },
  { label: "B plaza", cluster: "plaza", seed: 0xb0b },
];
for (const row of [worstCluster, densestCluster]) {
  if (patchScenarios.some((scenario) => scenario.cluster === row.cluster)) continue;
  patchScenarios.push({ label: "B tight", cluster: row.cluster, seed: 0xb0b });
}
const patchConfigs = [];
for (const encoderBufferBytes of [DEFAULT_ENCODER_BUFFER_BYTES, PRESIZED_ENCODER_BUFFER_BYTES]) {
  for (const scenario of patchScenarios) {
    patchConfigs.push({ ...scenario, map: grandPlaza, bots: 500, patches: 25, movesPerPatch: 1000, encoderBufferBytes });
  }
}
// Interleaved for the same reason the move tier is, and it matters more here: these rows land
// near 100% of the patch budget, so an ordering artefact is the difference between "fits in a
// core" and "does not". The seed is fixed per scenario, so byte counts and k repeat exactly
// across rounds and only the timings move.
console.log(`\npatch tier: ${repeat} interleaved rounds over ${patchConfigs.length} configurations, median of each`);
const patchRows = await measureInterleaved(runPatchScenario, patchConfigs, repeat, "patch tier");
console.log("\nPer-patch encode cost (design §6.5) - 500 views, 1000 moves per patch");
console.log("  scenario      rect     buf     k placed  k end    median ms   p95 ms    med spread        kB/patch   %of 100ms   overflow warns");
for (const row of patchRows) {
  const budget = ((row.medianMs / PATCH_RATE_MS) * 100).toFixed(1);
  console.log(
    `  ${row.label.padEnd(13)} ${rectLabel(row.rect).padEnd(8)} ${`${row.encoderBufferBytes / 1024}k`.padEnd(7)} ` +
      `${row.meanViewSizePlaced.toFixed(1).padEnd(9)} ${row.meanViewSizeEnd.toFixed(1).padEnd(8)} ` +
      `${ms(row.medianMs).padEnd(11)} ${ms(row.p95Ms).padEnd(9)} ` +
      `${`${ms(row.fastestMedianMs)}-${ms(row.slowestMedianMs)}`.padEnd(17)} ` +
      `${(row.meanBytesPerPatch / 1024).toFixed(1).padEnd(10)} ` +
      `${`${budget}%`.padEnd(11)} ${row.overflowWarnings} (grew to ${(row.finalBufferBytes / 1024 / 1024).toFixed(1)} MB)`,
  );
}

console.log(`\nRSS after the in-process tiers: ${rssMb()} MB`);

if (wantSockets) {
  await runSocketTier();
}

const worst = Math.max(
  ...[...dispersed, ...clustered].filter((row) => !row.legacy && row.bots === 500).map((row) => row.medianMs),
);
console.log(
  `\nVerdict: worst-case median ${ms(worst)} ms/move at n=500 vs bar ${ACCEPTANCE_BAR_MS_PER_MOVE} ms -> ` +
    `${worst <= ACCEPTANCE_BAR_MS_PER_MOVE ? "PASS" : "FAIL"}`,
);
