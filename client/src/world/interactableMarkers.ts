import Phaser from "phaser";
import { Direction, InteractableKind, TILE_SIZE_PX } from "@zep-test/shared";
import type { InteractableMarkerPosition } from "../net/roomConnection";
import type { AvatarArt } from "./avatarArt";

/** The layer portal pads use: above the tile layers, below every avatar. See portalMarkers.ts. */
const MARKER_DEPTH = 1;

const PLATE_SIZE_PX = 24;
const PLATE_CORNER_PX = 6;
/** Off-black plate, so the glyph reads against the pale stone floor as well as the dark tiles. */
const PLATE_FILL = 0x14131a;
const PLATE_EDGE = 0xf0ece2;
const GLYPH_COLOR = "#f0ece2";

/**
 * The glyph is the only thing separating the three kinds; the plate is identical for all of them
 * so they read as one family, and a square plate is nothing like the round pulsing portal pad —
 * a door takes you somewhere, an object has something to read.
 *
 * `kind` is the wire string, not the union, so this switch has a reachable default: a browser can
 * hold a bundle older than the server's object table (the reason PortalEntered names its
 * destination room). A dot for an unrecognised kind beats drawing nothing, which would hide a
 * tile the player can still step on.
 */
function glyphFor(kind: string): string {
  switch (kind) {
    case InteractableKind.Link:
      return "↗";
    case InteractableKind.Notice:
      return "≡";
    case InteractableKind.Quiz:
      return "?";
    default:
      return "•";
  }
}

/**
 * Draws a plate on every fixed object tile, so an object is something you can see rather than
 * something you find by walking every tile of the room. The maps are machine-generated and carry
 * no object art, so this marker is the only thing on the floor saying anything is there.
 *
 * Still, where the portal pad pulses: an object is not somewhere to head towards, and one plate
 * per notice board is quieter than a room of competing animations.
 *
 * Fire and forget, like the portal pads — the tiles are static for the room's lifetime and
 * Phaser's scene shutdown destroys these with the rest of the display list on a room hop.
 */
export function drawInteractableMarkers(
  scene: Phaser.Scene,
  markers: readonly InteractableMarkerPosition[],
  art: AvatarArt,
): void {
  for (const { tileX, tileY, kind, avatarSkin } of markers) {
    if (kind === InteractableKind.Npc) {
      addNpcStandee(scene, tileX, tileY, avatarSkin ?? 0, art);
      continue;
    }

    // Tile-centred: this lies flat on the tile rather than standing on it like an avatar.
    const x = tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2;
    const y = tileY * TILE_SIZE_PX + TILE_SIZE_PX / 2;

    // Plate first, glyph second: they share a depth, so insertion order is what stacks them.
    addPlate(scene, x, y);
    addGlyph(scene, x, y, glyphFor(kind));
  }
}

/**
 * Draws the NPC as a standing avatar frame instead of the flat plate+glyph the other kinds get.
 * Positioned and depth-sorted like {@link PlayerSprites} — bottom-anchored on the tile, not
 * tile-centred like the plate — because this is meant to read as a person standing there, not a
 * signboard lying on the ground. Always idle, facing Down: this NPC never turns or walks, so one
 * fixed frame is the whole of it (no animation object, unlike a real player).
 */
function addNpcStandee(scene: Phaser.Scene, tileX: number, tileY: number, avatarSkin: number, art: AvatarArt): void {
  const x = tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2;
  const y = (tileY + 1) * TILE_SIZE_PX;
  const visual = art.resolve(avatarSkin, "idle", Direction.Down);
  if (!visual) throw new Error(`NPC avatar ${avatarSkin} is unavailable`);
  const sprite = scene.add.sprite(x, y, "__DEFAULT");
  art.apply(sprite, visual, false);
  sprite.setDepth(y);
}

function addPlate(scene: Phaser.Scene, x: number, y: number): void {
  const half = PLATE_SIZE_PX / 2;
  const plate = scene.add.graphics();
  plate.setPosition(x, y);
  plate.setDepth(MARKER_DEPTH);
  plate.fillStyle(PLATE_FILL, 0.66);
  plate.fillRoundedRect(-half, -half, PLATE_SIZE_PX, PLATE_SIZE_PX, PLATE_CORNER_PX);
  plate.lineStyle(2, PLATE_EDGE, 0.85);
  plate.strokeRoundedRect(-half, -half, PLATE_SIZE_PX, PLATE_SIZE_PX, PLATE_CORNER_PX);
}

function addGlyph(scene: Phaser.Scene, x: number, y: number, glyph: string): void {
  const label = scene.add.text(x, y, glyph, {
    // The name tag stack, so the marker glyphs and the tags miss the same fonts on the same box.
    fontFamily: '"Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif',
    fontSize: "15px",
    color: GLYPH_COLOR,
  });
  label.setOrigin(0.5, 0.5);
  label.setDepth(MARKER_DEPTH);
}
