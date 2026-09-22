import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";
import { getUnhealthyReason, resetReadiness } from "./http/readiness";
import type { PortalDefinition } from "./rooms/contracts";
import { PORTAL_DEFINITIONS } from "./rooms/portalDefinitions";
import { createGameServer } from "./server";

/**
 * Boot-time wiring of the portal checks: `validatePortalDefinitions` is unit-tested as a pure
 * function in `game/portals.test.ts`, but nothing proved that `server.ts` actually hands it the
 * real table, refuses to listen on its errors and only warns on its warnings. A miswired hook
 * would ship a server that boots happily with a broken door.
 *
 * 2568 / 2571 / 2573 are owned by the other suites; node:test runs files in parallel processes.
 */
const PORT = 2575;

/**
 * The table is mutated in place because `server.ts` imports the binding directly. node:test
 * gives this file its own process, so the mutation cannot reach another suite, and every test
 * restores the real rows before returning.
 */
const table = PORTAL_DEFINITIONS as PortalDefinition[];
const REAL_ROWS: readonly PortalDefinition[] = [...PORTAL_DEFINITIONS];

function restoreTable(): void {
  table.length = 0;
  table.push(...REAL_ROWS);
}

/** Walkable in plaza.json / grand-plaza.json; (28,24) is the south wall. */
const PLAZA_WALKABLE = { tileX: 20, tileY: 13 };
const PLAZA_BLOCKED = { tileX: 28, tileY: 24 };
const GRAND_WALKABLE = { tileX: 24, tileY: 9 };
const VALID_TARGET = {
  room: "grand-plaza",
  arrival: { tileX: 86, tileY: 73, spreadRadiusInTiles: 0 },
};

/** One row per reject case of the design's §3.6 list, appended to the real table at once. */
const BAD_ROWS: readonly PortalDefinition[] = [
  { id: "", from: { room: "plaza", tiles: [PLAZA_WALKABLE] }, to: VALID_TARGET },
  // Same id as the real first row.
  { id: "plaza-south-door", from: { room: "plaza", tiles: [PLAZA_WALKABLE] }, to: VALID_TARGET },
  { id: "bad-doorless", from: { room: "plaza", tiles: [] }, to: VALID_TARGET },
  { id: "bad-from-room", from: { room: "nowhere", tiles: [PLAZA_WALKABLE] }, to: VALID_TARGET },
  {
    id: "bad-to-room",
    from: { room: "plaza", tiles: [PLAZA_WALKABLE] },
    to: { room: "elsewhere", arrival: { tileX: 1, tileY: 1, spreadRadiusInTiles: 0 } },
  },
  { id: "bad-trigger", from: { room: "plaza", tiles: [PLAZA_BLOCKED] }, to: VALID_TARGET },
  {
    id: "bad-arrival",
    from: { room: "plaza", tiles: [PLAZA_WALKABLE] },
    to: { room: "plaza", arrival: { ...PLAZA_BLOCKED, spreadRadiusInTiles: 0 } },
  },
  {
    id: "bad-spread",
    from: { room: "plaza", tiles: [PLAZA_WALKABLE] },
    to: { room: "grand-plaza", arrival: { tileX: 86, tileY: 73, spreadRadiusInTiles: -1 } },
  },
];

/**
 * Only issue is a sticky arrival: `plaza-south-door` already triggers at (31,25), so landing a
 * client there is the authoring smell §3.6 warns about without refusing boot.
 */
const STICKY_ROW: PortalDefinition = {
  id: "sticky-arrival-door",
  from: { room: "grand-plaza", tiles: [GRAND_WALKABLE] },
  to: { room: "plaza", arrival: { tileX: 31, tileY: 25, spreadRadiusInTiles: 0 } },
};

async function isPortFree(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
}

let booted: ReturnType<typeof createGameServer> | null = null;

after(async () => {
  restoreTable();
  if (booted) {
    await booted.gracefullyShutdown(false);
    booted = null;
  }
  resetReadiness();
});

describe("boot-time portal validation is wired into listen()", () => {
  it("refuses to listen and names every bad row in one refusal message", async () => {
    table.push(...BAD_ROWS);
    let message = "";
    try {
      const gameServer = createGameServer();
      await gameServer.listen(PORT);
      assert.fail("listen() resolved with an invalid portal table");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      restoreTable();
    }

    // One restart per typo is a bad way to fix a table, so the checks must not stop at the first.
    for (const expected of [
      /portal at row \d+ has an empty id/,
      /"plaza-south-door" is declared more than once/,
      /"bad-doorless" has no trigger tiles/,
      /"bad-from-room" leaves from "nowhere", which is not a registered room/,
      /"bad-to-room" points at "elsewhere", which is not a registered room/,
      /"bad-trigger" triggers at \(28,24\), which is not a walkable tile of room "plaza"/,
      /"bad-arrival" arrives at \(28,24\), which is not a walkable tile of room "plaza"/,
      /"bad-spread" has a negative arrival spreadRadiusInTiles \(-1\)/,
    ]) {
      assert.match(message, expected);
    }
  });

  it("marks itself unhealthy with the refusal reason and binds no port", async () => {
    resetReadiness();
    table.push(...BAD_ROWS);
    try {
      const gameServer = createGameServer();
      await gameServer.listen(PORT).then(
        () => assert.fail("listen() resolved with an invalid portal table"),
        () => undefined,
      );
    } finally {
      restoreTable();
    }

    const reason = getUnhealthyReason();
    assert.ok(reason, "/api/health must report the refusal, not stay silently ready");
    assert.match(reason, /invalid portal definitions/);
    // A server that refused to boot but still holds the socket would look alive to the gateway.
    assert.equal(await isPortFree(PORT), true, `nothing may be listening on ${PORT}`);
  });

  it("warns without refusing for a sticky arrival, and marks itself ready", async () => {
    resetReadiness();
    table.push(STICKY_ROW);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      booted = createGameServer();
      await booted.listen(PORT);
    } finally {
      console.warn = originalWarn;
      restoreTable();
    }

    assert.equal(
      getUnhealthyReason(),
      null,
      "a warning-only table must still reach markReady()",
    );
    assert.equal(
      warnings.filter((line) => line.includes("sticky-arrival-door")).length,
      1,
      `expected exactly one sticky-arrival warning, got ${JSON.stringify(warnings)}`,
    );
    assert.match(
      warnings.join("\n"),
      /"sticky-arrival-door" arrives at \(31,25\), which is itself a portal trigger tile in room "plaza"/,
    );
  });
});
