import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollisionMap, PortalDefinition } from "../rooms/contracts";
import { ROOM_DEFINITIONS } from "../rooms/definitions";
import { PORTAL_DEFINITIONS } from "../rooms/portalDefinitions";
import { TablePortalIndex, validatePortalDefinitions } from "./portals";
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

const A_TO_B: PortalDefinition = {
  id: "a-to-b",
  from: {
    room: "a",
    tiles: [
      { tileX: 1, tileY: 2 },
      { tileX: 2, tileY: 2 },
    ],
  },
  to: { room: "b", arrival: { tileX: 4, tileY: 1, spreadRadiusInTiles: 0 } },
};

const B_TO_A: PortalDefinition = {
  id: "b-to-a",
  from: { room: "b", tiles: [{ tileX: 5, tileY: 3 }] },
  to: { room: "a", arrival: { tileX: 0, tileY: 0, spreadRadiusInTiles: 2 } },
};

/** Leaves from a third room, so room "a" has an arrival it does not own the trigger for. */
const C_TO_A: PortalDefinition = {
  id: "c-to-a",
  from: { room: "c", tiles: [{ tileX: 3, tileY: 0 }] },
  to: { room: "a", arrival: { tileX: 3, tileY: 3, spreadRadiusInTiles: 0 } },
};

const TABLE: readonly PortalDefinition[] = [A_TO_B, B_TO_A, C_TO_A];

function mapsFor(...rooms: string[]): ReadonlyMap<string, CollisionMap> {
  return new Map(rooms.map((room) => [room, MAP]));
}

describe("TablePortalIndex", () => {
  it("fires only the trigger tiles of its own room, on every tile of a wide doorway", () => {
    const index = new TablePortalIndex("a", TABLE, MAP);

    assert.equal(index.triggerAt(1, 2)?.id, "a-to-b");
    assert.equal(index.triggerAt(2, 2)?.id, "a-to-b");
    assert.equal(index.triggerAt(5, 3), null, "b's trigger must not fire in room a");
    assert.equal(index.triggerAt(3, 0), null, "c's trigger must not fire in room a");
    assert.equal(index.triggerAt(0, 0), null);
  });

  it("carries the destination room on the fired portal", () => {
    const portal = new TablePortalIndex("a", TABLE, MAP).triggerAt(1, 2);
    assert.ok(portal);
    assert.equal(portal.to.room, "b");
  });

  it("does not fold an out-of-range tileX into the neighbouring row", () => {
    // (5,3) is b's trigger; the linear index of (-1,4) and (6,3) is the same number, so an
    // unguarded `tileY * width + tileX` would answer this query with that portal.
    const index = new TablePortalIndex("b", TABLE, MAP);
    assert.equal(index.triggerAt(5, 3)?.id, "b-to-a", "precondition: the trigger is indexed");
    assert.equal(index.triggerAt(-1, 4), null);
    assert.equal(index.triggerAt(6, 3), null);
    assert.equal(index.triggerAt(0, -1), null);
  });

  it("cannot alias a tileY past the last row into an indexed cell", () => {
    // triggerAt guards tileX and `tileY < 0` but deliberately not `tileY >= heightInTiles`, and
    // does not need to: every indexed key is `tileY * width + tileX` with tileY < height and
    // 0 <= tileX < width, so it is below width*height, while every query the tileX guard lets
    // through with tileY >= height is at or above it. This sweep is that argument, executed.
    const index = new TablePortalIndex("b", TABLE, MAP);
    assert.equal(index.triggerAt(5, 3)?.id, "b-to-a", "precondition: the trigger is indexed");
    for (let tileY = MAP.heightInTiles; tileY < MAP.heightInTiles + 8; tileY++) {
      for (let tileX = 0; tileX < MAP.widthInTiles; tileX++) {
        assert.equal(index.triggerAt(tileX, tileY), null, `(${tileX},${tileY}) must not fire`);
      }
    }
  });

  it("resolves every portal pointing at its own room, whatever the room it leaves from", () => {
    const index = new TablePortalIndex("a", TABLE, MAP);
    assert.deepEqual(index.arrivalFor("b-to-a"), { tileX: 0, tileY: 0, spreadRadiusInTiles: 2 });
    assert.deepEqual(index.arrivalFor("c-to-a"), { tileX: 3, tileY: 3, spreadRadiusInTiles: 0 });
  });

  it("answers null for an unknown id and for a door out of its own room", () => {
    const index = new TablePortalIndex("a", TABLE, MAP);
    assert.equal(index.arrivalFor("a-to-b"), null, "a portal leaving this room arrives elsewhere");
    assert.equal(index.arrivalFor("no-such-portal"), null);
    assert.equal(index.arrivalFor(""), null);
  });

  it("answers null to everything for a room in no row", () => {
    const index = new TablePortalIndex("unlisted", TABLE, MAP);
    assert.equal(index.triggerAt(1, 2), null);
    assert.equal(index.arrivalFor("b-to-a"), null);
  });

  it("answers null to everything for a room whose name is undefined at runtime", () => {
    // A room built without the matchmaker, which is how metaverseRoom.views.test.ts builds one:
    // Colyseus types `roomName` as string but only assigns it in `__init`.
    const index = new TablePortalIndex(undefined, TABLE, MAP);
    assert.equal(index.triggerAt(1, 2), null);
    assert.equal(index.arrivalFor("b-to-a"), null);
  });
});

describe("validatePortalDefinitions", () => {
  it("accepts a table whose rooms, triggers and arrivals all check out", () => {
    assert.deepEqual(validatePortalDefinitions(TABLE, mapsFor("a", "b", "c")), {
      errors: [],
      warnings: [],
    });
  });

  it("accepts an empty table", () => {
    assert.deepEqual(validatePortalDefinitions([], mapsFor("a")), { errors: [], warnings: [] });
  });

  it("rejects an empty id", () => {
    const { errors } = validatePortalDefinitions(
      [{ id: "", from: { room: "a", tiles: [{ tileX: 1, tileY: 1 }] }, to: A_TO_B.to }],
      mapsFor("a", "b"),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /row 0.*empty id/);
  });

  it("rejects a duplicate id", () => {
    const { errors } = validatePortalDefinitions([A_TO_B, A_TO_B], mapsFor("a", "b"));
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /"a-to-b" is declared more than once/);
  });

  it("rejects a portal with no trigger tiles", () => {
    const { errors } = validatePortalDefinitions(
      [{ id: "doorless", from: { room: "a", tiles: [] }, to: A_TO_B.to }],
      mapsFor("a", "b"),
    );
    assert.deepEqual(errors, ['portal "doorless" has no trigger tiles']);
  });

  it("rejects an unregistered source or destination room", () => {
    const { errors } = validatePortalDefinitions(TABLE, mapsFor("a", "b"));
    assert.deepEqual(errors, [
      'portal "c-to-a" leaves from "c", which is not a registered room',
    ]);

    const reversed = validatePortalDefinitions(
      [{ id: "nowhere", from: { room: "a", tiles: [{ tileX: 1, tileY: 1 }] }, to: A_TO_B.to }],
      mapsFor("a"),
    );
    assert.deepEqual(reversed.errors, [
      'portal "nowhere" points at "b", which is not a registered room',
    ]);
  });

  it("rejects a trigger tile that can never be stepped onto", () => {
    const walled = new Map<string, CollisionMap>([
      ["a", gridMap(["..#...", "......"])],
      ["b", MAP],
    ]);
    const { errors } = validatePortalDefinitions(
      [
        {
          id: "dead-door",
          from: {
            room: "a",
            tiles: [
              { tileX: 1, tileY: 0 },
              { tileX: 2, tileY: 0 },
              { tileX: 99, tileY: 0 },
            ],
          },
          to: A_TO_B.to,
        },
      ],
      walled,
    );
    assert.deepEqual(errors, [
      'portal "dead-door" triggers at (2,0), which is not a walkable tile of room "a"',
      'portal "dead-door" triggers at (99,0), which is not a walkable tile of room "a"',
    ]);
  });

  it("rejects an arrival centre inside a wall", () => {
    const walled = new Map<string, CollisionMap>([
      ["a", MAP],
      ["b", gridMap(["......", "....#."])],
    ]);
    const { errors } = validatePortalDefinitions([A_TO_B], walled);
    assert.deepEqual(errors, [
      'portal "a-to-b" arrives at (4,1), which is not a walkable tile of room "b"',
    ]);
  });

  it("rejects a negative arrival spread radius", () => {
    const { errors } = validatePortalDefinitions(
      [
        {
          id: "inverted",
          from: { room: "a", tiles: [{ tileX: 1, tileY: 1 }] },
          to: { room: "b", arrival: { tileX: 2, tileY: 2, spreadRadiusInTiles: -1 } },
        },
      ],
      mapsFor("a", "b"),
    );
    assert.deepEqual(errors, [
      'portal "inverted" has a negative arrival spreadRadiusInTiles (-1)',
    ]);
  });

  it("collects every issue instead of stopping at the first", () => {
    const { errors } = validatePortalDefinitions(
      [
        {
          id: "",
          from: { room: "ghost", tiles: [] },
          to: { room: "b", arrival: { tileX: 1, tileY: 1, spreadRadiusInTiles: -3 } },
        },
      ],
      mapsFor("b"),
    );
    assert.equal(errors.length, 4, `expected all four issues, got ${JSON.stringify(errors)}`);
  });

  it("warns without rejecting when an arrival lands on the return door itself", () => {
    const sticky: readonly PortalDefinition[] = [
      {
        id: "a-to-b",
        from: { room: "a", tiles: [{ tileX: 1, tileY: 1 }] },
        // b's own trigger tile, so the arriving client stands on the way back.
        to: { room: "b", arrival: { tileX: 5, tileY: 3, spreadRadiusInTiles: 0 } },
      },
      {
        id: "b-to-a",
        from: { room: "b", tiles: [{ tileX: 5, tileY: 3 }] },
        to: { room: "a", arrival: { tileX: 2, tileY: 1, spreadRadiusInTiles: 0 } },
      },
    ];
    const { errors, warnings } = validatePortalDefinitions(sticky, mapsFor("a", "b"));
    assert.deepEqual(errors, [], "a sticky arrival must not refuse boot");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /"a-to-b" arrives at \(5,3\), which is itself a portal trigger/);
  });
});

describe("PORTAL_DEFINITIONS", () => {
  it("passes boot validation against the real room maps", async () => {
    const loader = new TiledMapLoader();
    const mapsByRoom = new Map<string, CollisionMap>();
    for (const definition of ROOM_DEFINITIONS) {
      mapsByRoom.set(definition.name, await loader.load(definition.mapKey));
    }

    assert.deepEqual(validatePortalDefinitions(PORTAL_DEFINITIONS, mapsByRoom), {
      errors: [],
      warnings: [],
    });
  });

  it("fires on exactly the declared tiles of the real plaza map, and nowhere off it", async () => {
    const map = await new TiledMapLoader().load("plaza");
    const index = new TablePortalIndex("plaza", PORTAL_DEFINITIONS, map);
    const declared = new Set<string>();
    for (const portal of PORTAL_DEFINITIONS) {
      if (portal.from.room !== "plaza") {
        continue;
      }
      for (const tile of portal.from.tiles) {
        declared.add(`${tile.tileX},${tile.tileY}`);
      }
    }
    assert.ok(declared.size > 0, "precondition: plaza owns at least one door");

    // Swept past the map edge on all four sides, so an out-of-range coordinate that folded into
    // a valid cell — the linear-index hazard — would show up as an unexpected fire.
    for (let tileY = -4; tileY < map.heightInTiles + 4; tileY++) {
      for (let tileX = -4; tileX < map.widthInTiles + 4; tileX++) {
        assert.equal(
          index.triggerAt(tileX, tileY) !== null,
          declared.has(`${tileX},${tileY}`),
          `triggerAt(${tileX},${tileY}) disagrees with PORTAL_DEFINITIONS`,
        );
      }
    }
  });

  it("keeps plaza's triggers clear of the tiles the integration suite walks", () => {
    // metaverseRoom.integration.test.ts asserts relative movement from plaza's spawn tile and
    // walks the whole of row 20 plus the column at x=16; a door on those tiles would fire
    // mid-test and rewrite an unrelated failure into a confusing one.
    const walked = new Set<string>();
    for (let tileX = 16; tileX <= 47; tileX++) {
      walked.add(`${tileX},20`);
    }
    // Up to y=8 for the diagonal-visibility route, down to y=21 for the border refusal.
    for (let tileY = 8; tileY <= 21; tileY++) {
      walked.add(`16,${tileY}`);
    }
    for (const tile of [
      // The fountain approach, one step up from the spawn tile.
      { tileX: 31, tileY: 19 },
      // The second walker's leg of the diagonal-visibility route.
      { tileX: 35, tileY: 19 },
      { tileX: 35, tileY: 18 },
      { tileX: 36, tileY: 18 },
    ]) {
      walked.add(`${tile.tileX},${tile.tileY}`);
    }

    for (const portal of PORTAL_DEFINITIONS) {
      if (portal.from.room !== "plaza") {
        continue;
      }
      for (const tile of portal.from.tiles) {
        assert.equal(
          walked.has(`${tile.tileX},${tile.tileY}`),
          false,
          `portal "${portal.id}" triggers at (${tile.tileX},${tile.tileY}), which the integration suite walks over`,
        );
      }
    }
  });

  it("keeps the approach to plaza's door clear of any other plaza door", () => {
    // The tiles above cannot include the door approach, because the last tile of it *is* a
    // trigger. Derived from the same values `walkToDoor` uses (spawn, then the first tile of the
    // outbound door) so it tracks the route instead of restating coordinates: a second plaza
    // door dropped onto the approach would fire before the walker ever reached the real one.
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
    // The destination itself is meant to fire; only what precedes it must be quiet.
    approach.delete(`${door.tileX},${door.tileY}`);

    for (const portal of PORTAL_DEFINITIONS) {
      if (portal.from.room !== plaza.name) {
        continue;
      }
      for (const tile of portal.from.tiles) {
        assert.equal(
          approach.has(`${tile.tileX},${tile.tileY}`),
          false,
          `portal "${portal.id}" triggers at (${tile.tileX},${tile.tileY}), on the route walkToDoor takes to "${outbound.id}"`,
        );
      }
    }
  });
});
