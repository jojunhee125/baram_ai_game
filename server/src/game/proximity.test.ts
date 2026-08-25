import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_RADIUS_TILES, Player, RoomState, type TilePosition } from "@zep-test/shared";
import { NaiveProximityIndex, type PlayerPositions } from "./proximity";

function sorted(sessionIds: Iterable<string>): string[] {
  return [...sessionIds].sort();
}

describe("NaiveProximityIndex.within", () => {
  it("returns nothing when the room is empty", () => {
    const index = new NaiveProximityIndex(new Map<string, TilePosition>());
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, CHAT_RADIUS_TILES)), []);
  });

  it("includes the origin's own session", () => {
    const players = new Map<string, TilePosition>([["self", { tileX: 5, tileY: 5 }]]);
    const index = new NaiveProximityIndex(players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 3)), ["self"]);
  });

  it("includes a player at exactly the radius and excludes the next tile out", () => {
    const players = new Map<string, TilePosition>([
      ["onEdge", { tileX: 8, tileY: 5 }],
      ["justOutside", { tileX: 9, tileY: 5 }],
    ]);
    const index = new NaiveProximityIndex(players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 3)), ["onEdge"]);
  });

  it("measures Chebyshev distance, so a full diagonal is still in range", () => {
    const players = new Map<string, TilePosition>([
      ["corner", { tileX: 8, tileY: 8 }],
      ["beyondCorner", { tileX: 9, tileY: 8 }],
    ]);
    const index = new NaiveProximityIndex(players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 3)), ["corner"]);
  });

  it("matches only the exact tile at radius 0", () => {
    const players = new Map<string, TilePosition>([
      ["same", { tileX: 5, tileY: 5 }],
      ["adjacent", { tileX: 5, tileY: 6 }],
    ]);
    const index = new NaiveProximityIndex(players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 0)), ["same"]);
  });

  it("returns nothing for a negative radius", () => {
    const players = new Map<string, TilePosition>([["same", { tileX: 5, tileY: 5 }]]);
    const index = new NaiveProximityIndex(players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, -1)), []);
  });

  it("is symmetric across all four quadrants", () => {
    const players = new Map<string, TilePosition>([
      ["upLeft", { tileX: 2, tileY: 2 }],
      ["upRight", { tileX: 8, tileY: 2 }],
      ["downLeft", { tileX: 2, tileY: 8 }],
      ["downRight", { tileX: 8, tileY: 8 }],
      ["farAway", { tileX: 20, tileY: 20 }],
    ]);
    const index = new NaiveProximityIndex(players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 3)), [
      "downLeft",
      "downRight",
      "upLeft",
      "upRight",
    ]);
  });

  it("reads positions live instead of snapshotting at construction", () => {
    const players = new Map<string, TilePosition>([["walker", { tileX: 20, tileY: 20 }]]);
    const index = new NaiveProximityIndex(players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 3)), []);

    players.set("walker", { tileX: 6, tileY: 5 });
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 3)), ["walker"]);

    players.delete("walker");
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, 3)), []);
  });

  it("accepts the MapSchema held in RoomState", () => {
    const state = new RoomState();
    state.players.set("near", new Player({ nickname: "near", tileX: 6, tileY: 6 }));
    state.players.set("far", new Player({ nickname: "far", tileX: 30, tileY: 30 }));

    const index = new NaiveProximityIndex(state.players);
    assert.deepEqual(sorted(index.within({ tileX: 5, tileY: 5 }, CHAT_RADIUS_TILES)), ["near"]);
  });
});

/** Compile-time guard: `state.players` must stay assignable to the index's input. */
type RoomPlayers = RoomState["players"];
const _roomStateIsAcceptableSource = (players: RoomPlayers): PlayerPositions => players;
void _roomStateIsAcceptableSource;
