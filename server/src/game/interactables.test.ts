import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AVATAR_SKIN_COUNT, InteractableKind } from "@zep-test/shared";
import type {
  CollisionMap,
  InteractableDefinition,
  PortalDefinition,
  RoomDefinition,
} from "../rooms/contracts";
import { ROOM_DEFINITIONS } from "../rooms/definitions";
import { INTERACTABLE_DEFINITIONS } from "../rooms/interactableDefinitions";
import { PORTAL_DEFINITIONS } from "../rooms/portalDefinitions";
import { TableInteractableIndex, validateInteractableDefinitions } from "./interactables";
import { TiledMapLoader } from "./tiledMap";

/** '.' = walkable, '#' = blocked. Row index is tileY, column index is tileX. */
function gridMap(rows: string[]): CollisionMap {
  return {
    widthInTiles: rows[0]?.length ?? 0,
    heightInTiles: rows.length,
    isWalkable(tileX, tileY) {
      return rows[tileY]?.[tileX] === ".";
    },
  };
}

const MAP = gridMap([
  "......",
  "......",
  "......",
  "......",
]);

const A_LINK: InteractableDefinition = {
  id: "a-link",
  kind: InteractableKind.Link,
  at: { room: "a", tiles: [{ tileX: 1, tileY: 1 }] },
  title: "링크",
  url: "https://example.com/a",
};

/** Two tiles wide, so "every tile of one object fires" has something to assert on. */
const A_NOTICE: InteractableDefinition = {
  id: "a-notice",
  kind: InteractableKind.Notice,
  at: {
    room: "a",
    tiles: [
      { tileX: 2, tileY: 2 },
      { tileX: 3, tileY: 2 },
    ],
  },
  title: "공지",
  body: "첫 줄\n둘째 줄",
};

const B_QUIZ: InteractableDefinition = {
  id: "b-quiz",
  kind: InteractableKind.Quiz,
  at: { room: "b", tiles: [{ tileX: 5, tileY: 3 }] },
  title: "퀴즈",
  question: "정답은?",
  choices: ["하나", "둘"],
  answerIndex: 1,
  explanation: "해설",
};

const A_NPC: InteractableDefinition = {
  id: "a-npc",
  kind: InteractableKind.Npc,
  at: { room: "a", tiles: [{ tileX: 4, tileY: 1 }] },
  title: "안내",
  body: "여기는 사냥터입니다.",
  avatarSkin: 21,
};

const TABLE: readonly InteractableDefinition[] = [A_LINK, A_NOTICE, B_QUIZ, A_NPC];

/** A door out of "a" and one back, so tile-collision rules have a portal table to collide with. */
const A_TO_B: PortalDefinition = {
  id: "a-to-b",
  from: { room: "a", tiles: [{ tileX: 5, tileY: 0 }] },
  to: { room: "b", arrival: { tileX: 0, tileY: 3, spreadRadiusInTiles: 0 } },
};

const B_TO_A: PortalDefinition = {
  id: "b-to-a",
  from: { room: "b", tiles: [{ tileX: 0, tileY: 0 }] },
  to: { room: "a", arrival: { tileX: 4, tileY: 3, spreadRadiusInTiles: 0 } },
};

const PORTALS: readonly PortalDefinition[] = [A_TO_B, B_TO_A];

function mapsFor(...rooms: string[]): ReadonlyMap<string, CollisionMap> {
  return new Map(rooms.map((room) => [room, MAP]));
}

/** The new spawn-overlap check is Info-level and off by default; only the tests that exercise it opt in. */
const NO_ROOMS: readonly RoomDefinition[] = [];

/** A well-formed row of each kind, so a rule test can break exactly one field. */
function link(patch: Partial<Extract<InteractableDefinition, { kind: "link" }>> = {}) {
  return { ...A_LINK, ...patch } as InteractableDefinition;
}

function notice(patch: Partial<Extract<InteractableDefinition, { kind: "notice" }>> = {}) {
  return { ...A_NOTICE, ...patch } as InteractableDefinition;
}

function quiz(patch: Partial<Extract<InteractableDefinition, { kind: "quiz" }>> = {}) {
  return { ...B_QUIZ, at: { room: "a", tiles: [{ tileX: 1, tileY: 3 }] }, ...patch } as InteractableDefinition;
}

function npc(patch: Partial<Extract<InteractableDefinition, { kind: "npc" }>> = {}) {
  return { ...A_NPC, at: { room: "a", tiles: [{ tileX: 5, tileY: 1 }] }, ...patch } as InteractableDefinition;
}

describe("TableInteractableIndex", () => {
  it("fires only the tiles of its own room, on every tile of a wide object", () => {
    const index = new TableInteractableIndex("a", TABLE, MAP);

    assert.equal(index.at(1, 1)?.id, "a-link");
    assert.equal(index.at(2, 2)?.id, "a-notice");
    assert.equal(index.at(3, 2)?.id, "a-notice", "both tiles of one board must open it");
    assert.equal(index.at(5, 3), null, "b's object must not fire in room a");
    assert.equal(index.at(0, 0), null);
  });

  it("carries the whole row, content and kind included, on the fired object", () => {
    const object = new TableInteractableIndex("a", TABLE, MAP).at(2, 2);
    assert.ok(object);
    assert.equal(object.kind, InteractableKind.Notice);
    assert.equal(object.kind === InteractableKind.Notice && object.body, "첫 줄\n둘째 줄");
  });

  it("does not fold an out-of-range tileX into the neighbouring row", () => {
    // (5,3) is b's object; (-1,4) and (6,3) share its linear index, so an unguarded
    // `tileY * width + tileX` would answer those queries with that object.
    const index = new TableInteractableIndex("b", TABLE, MAP);
    assert.equal(index.at(5, 3)?.id, "b-quiz", "precondition: the object is indexed");
    assert.equal(index.at(-1, 4), null);
    assert.equal(index.at(6, 3), null);
    assert.equal(index.at(0, -1), null);
  });

  it("cannot alias a tileY past the last row into an indexed cell", () => {
    // Same argument portals.test.ts spells out: every indexed key is below width*height, and the
    // tileX guard puts every query with tileY >= height at or above it. Executed rather than
    // asserted, because `at` deliberately does not guard `tileY >= heightInTiles`.
    const index = new TableInteractableIndex("b", TABLE, MAP);
    assert.equal(index.at(5, 3)?.id, "b-quiz", "precondition: the object is indexed");
    for (let tileY = MAP.heightInTiles; tileY < MAP.heightInTiles + 8; tileY++) {
      for (let tileX = 0; tileX < MAP.widthInTiles; tileX++) {
        assert.equal(index.at(tileX, tileY), null, `(${tileX},${tileY}) must not fire`);
      }
    }
  });

  it("resolves its own ids by id and answers null for another room's", () => {
    const index = new TableInteractableIndex("a", TABLE, MAP);
    assert.equal(index.byId("a-link")?.id, "a-link");
    assert.equal(index.byId("a-notice")?.id, "a-notice");
    assert.equal(index.byId("b-quiz"), null, "a quiz in room b is not this room's to grade");
    assert.equal(index.byId("no-such-object"), null);
    assert.equal(index.byId(""), null);
  });

  it("lists every tile of its own room with the owning object's kind", () => {
    const markers = new TableInteractableIndex("a", TABLE, MAP).markerTiles();
    assert.deepEqual(
      [...markers].sort((left, right) => left.tileX - right.tileX),
      [
        { tileX: 1, tileY: 1, kind: InteractableKind.Link },
        { tileX: 2, tileY: 2, kind: InteractableKind.Notice },
        { tileX: 3, tileY: 2, kind: InteractableKind.Notice },
        { tileX: 4, tileY: 1, kind: InteractableKind.Npc, avatarSkin: 21 },
      ],
    );
  });

  it("fills avatarSkin on an Npc marker from the definition table, and on no other kind", () => {
    // The one spot the design doc flags as compiler-invisible: an optional field that a missed
    // spread leaves silently absent, rendering every Npc marker as skin 0.
    const markers = new TableInteractableIndex("a", TABLE, MAP).markerTiles();
    const npcMarker = markers.find((marker) => marker.kind === InteractableKind.Npc);
    assert.ok(npcMarker, "precondition: the room's Npc row produced a marker");
    assert.equal(npcMarker.avatarSkin, 21);

    for (const marker of markers) {
      if (marker.kind === InteractableKind.Npc) {
        continue;
      }
      assert.equal("avatarSkin" in marker, false, `non-Npc marker at (${marker.tileX},${marker.tileY}) must not carry avatarSkin`);
    }
  });

  it("answers null to everything for a room in no row", () => {
    const index = new TableInteractableIndex("unlisted", TABLE, MAP);
    assert.equal(index.at(1, 1), null);
    assert.equal(index.byId("a-link"), null);
    assert.deepEqual(index.markerTiles(), []);
  });

  it("answers null to everything for a room whose name is undefined at runtime", () => {
    // A room built without the matchmaker, which is how metaverseRoom.views.test.ts builds one:
    // Colyseus types `roomName` as string but only assigns it in `__init`.
    const index = new TableInteractableIndex(undefined, TABLE, MAP);
    assert.equal(index.at(1, 1), null);
    assert.equal(index.byId("a-link"), null);
    assert.deepEqual(index.markerTiles(), []);
  });
});

describe("validateInteractableDefinitions", () => {
  it("accepts a table whose rooms, tiles and content all check out", () => {
    assert.deepEqual(validateInteractableDefinitions(TABLE, PORTALS, mapsFor("a", "b"), NO_ROOMS), {
      errors: [],
      warnings: [],
    });
  });

  it("accepts an empty table", () => {
    assert.deepEqual(validateInteractableDefinitions([], PORTALS, mapsFor("a", "b"), NO_ROOMS), {
      errors: [],
      warnings: [],
    });
  });

  it("rejects an empty id", () => {
    const { errors } = validateInteractableDefinitions(
      [link({ id: "" })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ["object at row 0 has an empty id"]);
  });

  it("rejects a duplicate id", () => {
    const { errors } = validateInteractableDefinitions(
      [A_LINK, link({ at: { room: "a", tiles: [{ tileX: 4, tileY: 1 }] } })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "a-link" is declared more than once']);
  });

  it("rejects an unregistered room", () => {
    const { errors } = validateInteractableDefinitions(
      [link({ at: { room: "ghost", tiles: [{ tileX: 1, tileY: 1 }] } })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, [
      'object "a-link" sits in "ghost", which is not a registered room',
    ]);
  });

  it("rejects an object with no tiles", () => {
    const { errors } = validateInteractableDefinitions(
      [link({ at: { room: "a", tiles: [] } })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "a-link" has no tiles']);
  });

  it("rejects a tile that can never be stepped onto, including one off the map", () => {
    const walled = new Map<string, CollisionMap>([["a", gridMap(["..#...", "......"])]]);
    const { errors } = validateInteractableDefinitions(
      [
        link({
          at: {
            room: "a",
            tiles: [
              { tileX: 1, tileY: 0 },
              { tileX: 2, tileY: 0 },
              { tileX: 99, tileY: 0 },
            ],
          },
        }),
      ],
      PORTALS,
      walled,
      NO_ROOMS,
    );
    assert.deepEqual(errors, [
      'object "a-link" occupies (2,0), which is not a walkable tile of room "a"',
      'object "a-link" occupies (99,0), which is not a walkable tile of room "a"',
    ]);
  });

  it("rejects two objects sharing a tile, because the index would keep only one", () => {
    const { errors } = validateInteractableDefinitions(
      [
        link({ id: "ok", at: { room: "a", tiles: [{ tileX: 0, tileY: 0 }] } }),
        link({ id: "x", at: { room: "a", tiles: [{ tileX: 0, tileY: 0 }] } }),
      ],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.equal(errors.length, 1);
    assert.match(
      errors[0] ?? "",
      /object "x" occupies \(0,0\) of room "a", which is already occupied by object "ok"/,
    );
  });

  it("rejects one object listing the same tile twice", () => {
    // Same rule, and the case a two-row check would miss: a wide board with a copy-pasted tile.
    const { errors } = validateInteractableDefinitions(
      [
        notice({
          id: "x",
          at: {
            room: "a",
            tiles: [
              { tileX: 0, tileY: 0 },
              { tileX: 0, tileY: 0 },
            ],
          },
        }),
      ],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /already occupied by object "x"/);
  });

  it("rejects a tile that is also a portal trigger", () => {
    const { errors } = validateInteractableDefinitions(
      [link({ id: "x", at: { room: "a", tiles: [{ tileX: 5, tileY: 0 }] } })],
      PORTALS,
      mapsFor("a", "b"),
      NO_ROOMS,
    );
    assert.equal(errors.length, 1);
    assert.match(
      errors[0] ?? "",
      /object "x" occupies \(5,0\), which is a portal trigger tile in room "a"/,
    );
  });

  it("does not treat another room's portal trigger as a collision", () => {
    // b's trigger is (0,0); an object on a's (0,0) is a different tile entirely.
    const { errors, warnings } = validateInteractableDefinitions(
      [link({ id: "x", at: { room: "a", tiles: [{ tileX: 0, tileY: 0 }] } })],
      PORTALS,
      mapsFor("a", "b"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });

  it("warns without rejecting when an object sits on a portal arrival tile", () => {
    // b-to-a arrives at a's (4,3). Arriving is not a step, so the panel stays shut until the
    // player walks off and back on — an authoring smell, not a broken object.
    const { errors, warnings } = validateInteractableDefinitions(
      [link({ id: "x", at: { room: "a", tiles: [{ tileX: 4, tileY: 3 }] } })],
      PORTALS,
      mapsFor("a", "b"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, [], "a sticky arrival must not refuse boot");
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0] ?? "",
      /object "x" occupies \(4,3\), which is a portal arrival tile in room "a"/,
    );
  });

  it("rejects an empty title, whitespace included, whatever the kind", () => {
    for (const row of [link({ title: "" }), notice({ title: "   " }), quiz({ title: "\n\t" }), npc({ title: "\n\t" })]) {
      const { errors } = validateInteractableDefinitions(
        [row],
        PORTALS,
        mapsFor("a"),
        NO_ROOMS,
      );
      assert.deepEqual(errors, [`object "${row.id}" has an empty title`]);
    }
  });

  it("rejects a link url that is not absolute", () => {
    const { errors } = validateInteractableDefinitions(
      [link({ id: "x", url: "/relative/path" })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, [
      'object "x" has a url that is not absolute: "/relative/path"',
    ]);
  });

  it("rejects a link url whose scheme is neither http nor https", () => {
    const { errors } = validateInteractableDefinitions(
      [link({ id: "x", url: "ftp://files.example.com/notice.txt" })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "x" has a "ftp:" url; only http and https are opened']);

    const script = validateInteractableDefinitions(
      [link({ id: "x", url: "javascript:alert(1)" })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(script.errors, [
      'object "x" has a "javascript:" url; only http and https are opened',
    ]);
  });

  it("accepts both http and https", () => {
    const { errors } = validateInteractableDefinitions(
      [
        link({ id: "plain", url: "http://intranet.example/notice" }),
        link({ id: "tls", at: { room: "a", tiles: [{ tileX: 3, tileY: 3 }] } }),
      ],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, []);
  });

  it("rejects an empty notice body", () => {
    const { errors } = validateInteractableDefinitions(
      [notice({ id: "x", body: "   \n  " })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "x" has an empty body']);
  });

  it("rejects an empty quiz question", () => {
    const { errors } = validateInteractableDefinitions(
      [quiz({ id: "x", question: " " })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "x" has an empty question']);
  });

  it("rejects a quiz with fewer than two choices", () => {
    const { errors } = validateInteractableDefinitions(
      [quiz({ id: "x", choices: ["하나"], answerIndex: 0 })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "x" offers 1 choice(s); a quiz needs two or more']);
  });

  it("rejects an answerIndex outside the choices, on either end", () => {
    for (const answerIndex of [2, -1]) {
      const { errors } = validateInteractableDefinitions(
        [quiz({ id: "x", choices: ["하나", "둘"], answerIndex })],
        PORTALS,
        mapsFor("a"),
        NO_ROOMS,
      );
      assert.deepEqual(errors, [
        `object "x" has answerIndex ${answerIndex}, which is outside its 2 choices`,
      ]);
    }
  });

  it("rejects a non-integer answerIndex", () => {
    // `choices[1.5]` is undefined, so a fractional index grades every answer wrong in silence.
    const { errors } = validateInteractableDefinitions(
      [quiz({ id: "x", choices: ["하나", "둘"], answerIndex: 1.5 })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, [
      'object "x" has answerIndex 1.5, which is outside its 2 choices',
    ]);
  });

  it("accepts a well-formed npc row", () => {
    const { errors } = validateInteractableDefinitions([npc({ id: "x" })], PORTALS, mapsFor("a"), NO_ROOMS);
    assert.deepEqual(errors, []);
  });

  it("rejects an empty npc body", () => {
    const { errors } = validateInteractableDefinitions(
      [npc({ id: "x", body: "  \n " })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "x" has an empty body']);
  });

  it("rejects an npc avatarSkin outside [0, AVATAR_SKIN_COUNT), on either end", () => {
    for (const avatarSkin of [-1, AVATAR_SKIN_COUNT]) {
      const { errors } = validateInteractableDefinitions(
        [npc({ id: "x", avatarSkin })],
        PORTALS,
        mapsFor("a"),
        NO_ROOMS,
      );
      assert.deepEqual(errors, [
        `object "x" has avatarSkin ${avatarSkin}, outside [0, ${AVATAR_SKIN_COUNT})`,
      ]);
    }
  });

  it("rejects a non-integer npc avatarSkin", () => {
    const { errors } = validateInteractableDefinitions(
      [npc({ id: "x", avatarSkin: 1.5 })],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    assert.deepEqual(errors, ['object "x" has avatarSkin 1.5, outside [0, 24)']);
  });

  it("accepts the boundary avatarSkin values 0 and AVATAR_SKIN_COUNT - 1", () => {
    for (const avatarSkin of [0, AVATAR_SKIN_COUNT - 1]) {
      const { errors } = validateInteractableDefinitions(
        [npc({ id: "x", avatarSkin })],
        PORTALS,
        mapsFor("a"),
        NO_ROOMS,
      );
      assert.deepEqual(errors, []);
    }
  });

  it("collects every issue instead of stopping at the first", () => {
    const { errors } = validateInteractableDefinitions(
      [
        {
          id: "",
          kind: InteractableKind.Quiz,
          at: { room: "ghost", tiles: [] },
          title: "",
          question: "",
          choices: [],
          answerIndex: 0,
        },
      ],
      PORTALS,
      mapsFor("a"),
      NO_ROOMS,
    );
    // empty id, unregistered room, no tiles, empty title, empty question, too few choices,
    // answerIndex outside an empty choice list.
    assert.equal(errors.length, 7, `expected all seven issues, got ${JSON.stringify(errors)}`);
  });

  function room(spawn: RoomDefinition["spawn"]): RoomDefinition {
    return { name: "a", roomType: "a", mapKey: "a", maxClients: 10, spawn };
  }

  it("warns, without refusing boot, when a room's spawn square reaches an interactable tile", () => {
    const { errors, warnings } = validateInteractableDefinitions(TABLE, PORTALS, mapsFor("a", "b"), [
      room({ tileX: 1, tileY: 1, spreadRadiusInTiles: 0 }),
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, [
      'room "a" spawn square reaches (1,1), occupied by object "a-link"; a joining player may open its panel immediately',
    ]);
  });

  it("warns, without refusing boot, when a room's spawn square reaches a portal trigger tile", () => {
    const { errors, warnings } = validateInteractableDefinitions(TABLE, PORTALS, mapsFor("a", "b"), [
      room({ tileX: 5, tileY: 0, spreadRadiusInTiles: 0 }),
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, [
      'room "a" spawn square reaches (5,0), a portal trigger tile; a joining player may fire it immediately',
    ]);
  });

  it("stays silent when a room's spawn square reaches neither an interactable nor a portal trigger tile", () => {
    const { errors, warnings } = validateInteractableDefinitions(TABLE, PORTALS, mapsFor("a", "b"), [
      room({ tileX: 0, tileY: 0, spreadRadiusInTiles: 0 }),
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  });
});

describe("INTERACTABLE_DEFINITIONS", () => {
  async function realMaps(): Promise<ReadonlyMap<string, CollisionMap>> {
    const loader = new TiledMapLoader();
    const mapsByRoom = new Map<string, CollisionMap>();
    for (const definition of ROOM_DEFINITIONS) {
      mapsByRoom.set(definition.name, await loader.load(definition.mapKey));
    }
    return mapsByRoom;
  }

  it("passes boot validation against the real room maps and the real portal table", async () => {
    // grand-plaza's spawn spread (radius 70) is wide enough to reach grand-plaza-north-door's
    // trigger tiles — a real, harmless authoring smell the new spawn-overlap check is meant to
    // surface (§1.9 of docs/design-phase-j-grand-plaza-cleanup.md), not a regression to silence.
    assert.deepEqual(
      validateInteractableDefinitions(
        INTERACTABLE_DEFINITIONS,
        PORTAL_DEFINITIONS,
        await realMaps(),
        ROOM_DEFINITIONS,
      ),
      {
        errors: [],
        warnings: [
          'room "grand-plaza" spawn square reaches (22,8), a portal trigger tile; a joining player may fire it immediately',
          'room "grand-plaza" spawn square reaches (23,8), a portal trigger tile; a joining player may fire it immediately',
        ],
      },
    );
  });

  it("fires on exactly the declared tiles of the real plaza map, and nowhere off it", async () => {
    const map = await new TiledMapLoader().load("plaza");
    const index = new TableInteractableIndex("plaza", INTERACTABLE_DEFINITIONS, map);
    const declared = new Set<string>();
    for (const object of INTERACTABLE_DEFINITIONS) {
      if (object.at.room !== "plaza") {
        continue;
      }
      for (const tile of object.at.tiles) {
        declared.add(`${tile.tileX},${tile.tileY}`);
      }
    }
    assert.ok(declared.size > 0, "precondition: plaza holds at least one object");

    // Swept past the map edge on all four sides, so an out-of-range coordinate folding into a
    // valid cell — the linear-index hazard — would show up as an unexpected fire.
    for (let tileY = -4; tileY < map.heightInTiles + 4; tileY++) {
      for (let tileX = -4; tileX < map.widthInTiles + 4; tileX++) {
        assert.equal(
          index.at(tileX, tileY) !== null,
          declared.has(`${tileX},${tileY}`),
          `at(${tileX},${tileY}) disagrees with INTERACTABLE_DEFINITIONS`,
        );
      }
    }
  });

  it("keeps every object clear of the tiles the integration suite walks", () => {
    // Entering an object gates the client's movement and puts an unexpected message on the wire;
    // metaverseRoom.integration.test.ts asserts relative movement from plaza's spawn tile and
    // walks the whole of row 20 plus the column at x=16, so an object there would rewrite an
    // unrelated failure into a confusing one. Same defence portals.test.ts applies to doors.
    const walked = new Set<string>();
    for (let tileX = 16; tileX <= 47; tileX++) {
      walked.add(`${tileX},20`);
    }
    for (let tileY = 8; tileY <= 21; tileY++) {
      walked.add(`16,${tileY}`);
    }
    for (const tile of [
      { tileX: 31, tileY: 19 },
      { tileX: 35, tileY: 19 },
      { tileX: 35, tileY: 18 },
      { tileX: 36, tileY: 18 },
    ]) {
      walked.add(`${tile.tileX},${tile.tileY}`);
    }

    for (const object of INTERACTABLE_DEFINITIONS) {
      if (object.at.room !== "plaza") {
        continue;
      }
      for (const tile of object.at.tiles) {
        assert.equal(
          walked.has(`${tile.tileX},${tile.tileY}`),
          false,
          `object "${object.id}" occupies (${tile.tileX},${tile.tileY}), which the integration suite walks over`,
        );
      }
    }
  });

  it("keeps every object off the route walkToDoor takes to plaza's door", () => {
    // The approach the portal suite already protects: an object on it opens a panel — and gates
    // movement — before the walker ever reaches the door.
    const [plaza] = ROOM_DEFINITIONS;
    assert.ok(plaza);
    const outbound = PORTAL_DEFINITIONS.find((portal) => portal.from.room === plaza.name);
    const [door] = outbound?.from.tiles ?? [];
    assert.ok(outbound && door, `no door leaves "${plaza?.name}"`);

    const approach = new Set<string>();
    const [xFrom, xTo] = [plaza.spawn.tileX, door.tileX].sort((a, b) => a - b);
    for (let tileX = xFrom ?? 0; tileX <= (xTo ?? 0); tileX++) {
      approach.add(`${tileX},${plaza.spawn.tileY}`);
    }
    const [yFrom, yTo] = [plaza.spawn.tileY, door.tileY].sort((a, b) => a - b);
    for (let tileY = yFrom ?? 0; tileY <= (yTo ?? 0); tileY++) {
      approach.add(`${door.tileX},${tileY}`);
    }

    for (const object of INTERACTABLE_DEFINITIONS) {
      if (object.at.room !== plaza.name) {
        continue;
      }
      for (const tile of object.at.tiles) {
        assert.equal(
          approach.has(`${tile.tileX},${tile.tileY}`),
          false,
          `object "${object.id}" occupies (${tile.tileX},${tile.tileY}), on the route walkToDoor takes to "${outbound.id}"`,
        );
      }
    }
  });

  it("puts nothing in grand-plaza, whose bots would answer quizzes during PoC #2", () => {
    // tools/loadtest-poc2.mjs walks bots at random; an object under one of them adds messages the
    // 500-CCU measurement is supposed not to have.
    const loadMap = ROOM_DEFINITIONS.find((room) => room.name === "grand-plaza");
    assert.ok(loadMap, "precondition: grand-plaza is still a registered room");
    assert.deepEqual(
      INTERACTABLE_DEFINITIONS.filter((object) => object.at.room === "grand-plaza"),
      [],
    );
  });

  it("names every object in a room that exists", () => {
    const rooms = new Set(ROOM_DEFINITIONS.map((room) => room.name));
    for (const object of INTERACTABLE_DEFINITIONS) {
      assert.equal(rooms.has(object.at.room), true, `object "${object.id}" names an unknown room`);
    }
  });
});
