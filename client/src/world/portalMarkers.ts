import Phaser from "phaser";
import { TILE_SIZE_PX, type TilePosition } from "@zep-test/shared";

/** `--accent` from style.css. The canvas keeps the dark-scheme hue in both schemes, like the chat. */
const ACCENT = 0x6ea8dc;
/** The same hue lightened, for the inner ring that keeps the pad from reading as a flat blob. */
const ACCENT_LIGHT = 0xc6dcf0;
/** Under the accent, so the pad holds its edge against the pale floor art as well as dark. */
const OUTLINE = 0x14131a;

/**
 * Above the tile layers, which `createLayer` leaves at depth 0, and below every avatar, whose
 * depth is its y pixel and so is never under TILE_SIZE_PX (a sprite's origin sits on its tile's
 * bottom edge). A negative depth would bury the marker under the opaque ground layer instead of
 * drawing it on top.
 */
const MARKER_DEPTH = 1;

const PAD_RADIUS_PX = 13;
const PAD_INNER_RADIUS_PX = 7;
/** Overruns the 16px half-tile late in the fade, faint enough not to read as the next tile's pad. */
const PULSE_MAX_SCALE = 1.45;
const PULSE_MS = 1400;

/**
 * Draws a pad on every portal trigger tile, so a door is something you can see rather than
 * something you find by walking every tile of the room.
 *
 * The pulse carries that: a still pad reads as floor decoration, while a ring expanding out of
 * the tile reads as "you can go through here". Reduced motion drops it and keeps the pad, which
 * is visible on its own.
 *
 * Fire and forget — the tiles are static for the room's lifetime, and Phaser's scene shutdown
 * destroys these along with the rest of the display list on a portal hop.
 */
export function drawPortalMarkers(scene: Phaser.Scene, markers: readonly TilePosition[]): void {
  const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  for (const { tileX, tileY } of markers) {
    // Tile-centred, unlike an avatar: this lies flat on the tile rather than standing on it.
    const x = tileX * TILE_SIZE_PX + TILE_SIZE_PX / 2;
    const y = tileY * TILE_SIZE_PX + TILE_SIZE_PX / 2;

    addPad(scene, x, y);
    if (animate) {
      addPulse(scene, x, y);
    }
  }
}

function addPad(scene: Phaser.Scene, x: number, y: number): void {
  const pad = scene.add.graphics();
  pad.setPosition(x, y);
  pad.setDepth(MARKER_DEPTH);
  pad.lineStyle(4, OUTLINE, 0.4);
  pad.strokeCircle(0, 0, PAD_RADIUS_PX);
  pad.fillStyle(ACCENT, 0.34);
  pad.fillCircle(0, 0, PAD_RADIUS_PX);
  pad.lineStyle(2, ACCENT, 1);
  pad.strokeCircle(0, 0, PAD_RADIUS_PX);
  pad.lineStyle(1, ACCENT_LIGHT, 0.55);
  pad.strokeCircle(0, 0, PAD_INNER_RADIUS_PX);
}

function addPulse(scene: Phaser.Scene, x: number, y: number): void {
  const pulse = scene.add.graphics();
  pulse.setPosition(x, y);
  pulse.setDepth(MARKER_DEPTH);
  pulse.lineStyle(2.5, ACCENT, 1);
  pulse.strokeCircle(0, 0, PAD_RADIUS_PX);

  scene.tweens.add({
    targets: pulse,
    scale: { from: 0.85, to: PULSE_MAX_SCALE },
    alpha: { from: 0.9, to: 0 },
    duration: PULSE_MS,
    ease: "Sine.easeOut",
    repeat: -1,
  });
}
