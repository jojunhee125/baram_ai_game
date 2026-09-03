import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoomCreateOptions, SpawnArea } from "./contracts";
import { ROOM_DEFINITIONS } from "./definitions";
import { MetaverseRoom } from "./metaverseRoom";
import { PORTAL_DEFINITIONS } from "./portalDefinitions";

/**
 * Diagnostic for the Phase E tester finding (2026-09-03): hunting-ground's and hunting-den's
 * `spawn` squares each reached exactly onto their own south door's trigger row, so ~20% of plain
 * joins landed a player on that row and one sideways step could fire the door unasked. Fixed in
 * `definitions.ts`; this file drives {@link MetaverseRoom.pickSpawnTile} (bracket-accessed, same
 * as the private-method calls elsewhere in this suite) through every offset its rejection-sampling
 * square can draw — not just the extremes — rather than relying on real `Math.random()` draws to
 * eventually land on the corner that broke it.
 */
class DrivenRandomRoom extends MetaverseRoom {
  private readonly queue: number[] = [];

  queueRandom(...values: number[]): void {
    this.queue.push(...values);
  }

  protected override random(): number {
    const next = this.queue.shift();
    assert.ok(next !== undefined, "DrivenRandomRoom.random() called with no queued value left");
    return next;
  }

  override setSimulationInterval(): void {
    // No monster tick needed: this diagnostic only exercises spawn placement.
  }
}

function roomDefinition(name: string) {
  const definition = ROOM_DEFINITIONS.find((candidate) => candidate.name === name);
  assert.ok(definition, `ROOM_DEFINITIONS has no "${name}" row`);
  return definition;
}

/** Every tile that fires a portal when a player of this room steps onto it. */
function triggerTilesOf(roomName: string): ReadonlySet<string> {
  const tiles = new Set<string>();
  for (const portal of PORTAL_DEFINITIONS) {
    if (portal.from.room === roomName) {
      for (const tile of portal.from.tiles) {
        tiles.add(`${tile.tileX},${tile.tileY}`);
      }
    }
  }
  return tiles;
}

async function assertSpawnNeverLandsOnATrigger(roomName: string): Promise<void> {
  const definition = roomDefinition(roomName);
  const triggers = triggerTilesOf(roomName);
  assert.ok(triggers.size > 0, `precondition: "${roomName}" owns at least one portal trigger tile`);

  const room = new DrivenRandomRoom();
  await room.onCreate(definition as RoomCreateOptions);
  try {
    const area = room["spawn"] as SpawnArea;
    const span = area.spreadRadiusInTiles * 2 + 1;

    for (let xOffset = 0; xOffset < span; xOffset++) {
      for (let yOffset = 0; yOffset < span; yOffset++) {
        // pickSpawnTile draws tileX's offset first, then tileY's; (offset + 0.5) / span lands
        // Math.floor(random() * span) on exactly that offset.
        room.queueRandom((xOffset + 0.5) / span, (yOffset + 0.5) / span);
        const tile = room["pickSpawnTile"](area) as { tileX: number; tileY: number };
        const key = `${tile.tileX},${tile.tileY}`;
        assert.ok(
          !triggers.has(key),
          `"${roomName}" spawn offset (${xOffset},${yOffset}) drew (${tile.tileX},${tile.tileY}), one of its own portal trigger tiles`,
        );
      }
    }
  } finally {
    room.setPatchRate(null);
  }
}

describe("DIAGNOSTIC — a room's spawn square never draws its own portal trigger tile", () => {
  it("hunting-ground: every offset the spread square can draw clears both doors", async () => {
    await assertSpawnNeverLandsOnATrigger("hunting-ground");
  });

  it("hunting-den: every offset the spread square can draw clears its door", async () => {
    await assertSpawnNeverLandsOnATrigger("hunting-den");
  });
});
