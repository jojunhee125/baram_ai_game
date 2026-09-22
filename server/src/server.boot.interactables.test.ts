import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, it } from "node:test";
import { InteractableKind } from "@zep-test/shared";
import { getUnhealthyReason, resetReadiness } from "./http/readiness";
import type { InteractableDefinition } from "./rooms/contracts";
import { INTERACTABLE_DEFINITIONS } from "./rooms/interactableDefinitions";
import { createGameServer } from "./server";

/**
 * Boot-time wiring of the object checks, the counterpart of `server.boot.test.ts` for portals:
 * `validateInteractableDefinitions` is unit-tested as a pure function in
 * `game/interactables.test.ts`, but nothing proved `server.ts` hands it the real table, the real
 * portal table and the real maps, refuses to listen on its errors and only warns on its warnings.
 * A miswired hook ships a server that boots happily with an object nobody can ever open.
 *
 * 2568 / 2571 / 2573 / 2575 belong to the other suites; node:test runs files in parallel processes.
 */
const PORT = 2577;

/**
 * Mutated in place because `server.ts` imports the binding directly, exactly as the portal boot
 * suite does. This file gets its own process, so the mutation reaches no other suite, and every
 * test restores the real rows before returning.
 */
const table = INTERACTABLE_DEFINITIONS as InteractableDefinition[];
const REAL_ROWS: readonly InteractableDefinition[] = [...INTERACTABLE_DEFINITIONS];

function restoreTable(): void {
  table.length = 0;
  table.push(...REAL_ROWS);
}

/** Row 20 of plaza.json is open across x=16..47; (28,24) is the south wall. */
const free = (tileX: number) => [{ tileX, tileY: 20 }];
const PLAZA_BLOCKED = { tileX: 28, tileY: 24 };
/** plaza-south-door's trigger and its arrival, per assets/README.md. */
const PORTAL_TRIGGER = { tileX: 31, tileY: 25 };
const PORTAL_ARRIVAL = { tileX: 31, tileY: 23 };
/** The first tile of the real link board, for the overlap rule. */
const REAL_OBJECT_TILE = { tileX: 17, tileY: 23 };

function link(id: string, tiles: { tileX: number; tileY: number }[], patch = {}): InteractableDefinition {
  return {
    id,
    kind: InteractableKind.Link,
    at: { room: "plaza", tiles },
    title: "제목",
    url: "https://example.com/ok",
    ...patch,
  } as InteractableDefinition;
}

/** One row per reject rule of the design's §7 list, appended to the real table at once. */
const BAD_ROWS: readonly InteractableDefinition[] = [
  link("", free(17)),
  // Same id as the real first row.
  link("plaza-link-board", free(18)),
  link("bad-no-tiles", []),
  link("bad-room", free(19), { at: { room: "nowhere", tiles: free(19) } }),
  link("bad-tile", [PLAZA_BLOCKED]),
  link("bad-overlap", [REAL_OBJECT_TILE]),
  link("bad-portal-tile", [PORTAL_TRIGGER]),
  link("bad-title", free(21), { title: "   " }),
  link("bad-url", free(22), { url: "/relative/only" }),
  link("bad-scheme", free(23), { url: "ftp://files.example.com/notice.txt" }),
  {
    id: "bad-body",
    kind: InteractableKind.Notice,
    at: { room: "plaza", tiles: free(24) },
    title: "제목",
    body: "  \n ",
  },
  {
    id: "bad-question",
    kind: InteractableKind.Quiz,
    at: { room: "plaza", tiles: free(25) },
    title: "제목",
    question: " ",
    choices: ["하나", "둘"],
    answerIndex: 0,
  },
  {
    id: "bad-choices",
    kind: InteractableKind.Quiz,
    at: { room: "plaza", tiles: free(26) },
    title: "제목",
    question: "문제",
    choices: ["하나"],
    answerIndex: 0,
  },
  {
    id: "bad-answer",
    kind: InteractableKind.Quiz,
    at: { room: "plaza", tiles: free(27) },
    title: "제목",
    question: "문제",
    choices: ["하나", "둘"],
    answerIndex: 5,
  },
];

/**
 * Only issue is that it sits on plaza-south-door's arrival tile: arriving is not a step, so the
 * panel stays shut for anyone who comes in through that door. §7 warns without refusing.
 */
const STICKY_ROW: InteractableDefinition = link("sticky-arrival-object", [PORTAL_ARRIVAL]);

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

describe("boot-time interactable validation is wired into listen()", () => {
  it("refuses to listen and names every bad row in one refusal message", async () => {
    table.push(...BAD_ROWS);
    let message = "";
    try {
      const gameServer = createGameServer();
      await gameServer.listen(PORT);
      assert.fail("listen() resolved with an invalid object table");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      restoreTable();
    }

    assert.match(message, /invalid interactable definitions/);
    // One restart per typo is a bad way to fix a table, so the checks must not stop at the first.
    for (const expected of [
      /object at row \d+ has an empty id/,
      /"plaza-link-board" is declared more than once/,
      /"bad-no-tiles" has no tiles/,
      /"bad-room" sits in "nowhere", which is not a registered room/,
      /"bad-tile" occupies \(28,24\), which is not a walkable tile of room "plaza"/,
      /"bad-overlap" occupies \(17,23\) of room "plaza", which is already occupied by object "plaza-link-board"/,
      /"bad-portal-tile" occupies \(31,25\), which is a portal trigger tile in room "plaza"/,
      /"bad-title" has an empty title/,
      /"bad-url" has a url that is not absolute/,
      /"bad-scheme" has a "ftp:" url; only http and https are opened/,
      /"bad-body" has an empty body/,
      /"bad-question" has an empty question/,
      /"bad-choices" offers 1 choice\(s\); a quiz needs two or more/,
      /"bad-answer" has answerIndex 5, which is outside its 2 choices/,
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
        () => assert.fail("listen() resolved with an invalid object table"),
        () => undefined,
      );
    } finally {
      restoreTable();
    }

    const reason = getUnhealthyReason();
    assert.ok(reason, "/api/health must report the refusal, not stay silently ready");
    assert.match(reason, /invalid interactable definitions/);
    // A server that refused to boot but still holds the socket would look alive to the gateway.
    assert.equal(await isPortFree(PORT), true, `nothing may be listening on ${PORT}`);
  });

  it("warns without refusing for an object on a portal arrival tile, and marks itself ready", async () => {
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

    assert.equal(getUnhealthyReason(), null, "a warning-only table must still reach markReady()");
    assert.equal(
      warnings.filter((line) => line.includes("sticky-arrival-object")).length,
      1,
      `expected exactly one arrival warning, got ${JSON.stringify(warnings)}`,
    );
    assert.match(
      warnings.join("\n"),
      /"sticky-arrival-object" occupies \(31,23\), which is a portal arrival tile in room "plaza"/,
    );
  });
});
