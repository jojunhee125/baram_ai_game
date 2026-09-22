import { LANDMARK_DEFINITIONS, type TilePosition } from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";
import type { MinimapTerrain } from "./minimapTerrain";

/** Tile units, but fractional: mid-step values, unlike the integer `TilePosition` on the wire. */
export interface TilePoint {
  x: number;
  y: number;
}

/** Tile units. `cameras.main.worldView` divided by TILE_SIZE_PX. */
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the scene observes each frame. The minimap draws this and looks nothing up itself. */
export interface MinimapView {
  /** Tile centre of the local avatar, or null while its sprite does not exist yet. */
  self: TilePoint | null;
  /** What the main camera actually covers, i.e. after Phaser has applied its bounds clamp. */
  camera: TileRect;
}

/**
 * Box the whole map is fitted into, in backing-canvas pixels. One rule for every room: plaza is
 * 64x35 and lands width-bound, grand-plaza is 172x147 and lands height-bound, so fixing either
 * axis alone would blow the other one out.
 */
const MAX_WIDTH_PX = 240;
const MAX_HEIGHT_PX = 180;
/** Keeps a future small room from becoming a handful of giant blocks; it just draws smaller. */
const MAX_PX_PER_TILE = 6;

/*
 * Marker sizes are canvas pixels, never tiles, so they look the same at either room's scale.
 * Colours are fixed across schemes, matching the terrain buffer and the in-world portal pad.
 */
const SELF_RADIUS_PX = 3.5;
const SELF_OUTLINE_PX = 1.5;
const SELF_FILL = "#ffffff";
const SELF_OUTLINE = "#23212a";
const VIEWPORT_STROKE = "rgba(236, 234, 244, 0.75)";
/** `--accent`, matching the in-world portal pad so the two read as the same thing. */
const PORTAL_FILL = "#6ea8dc";
const PORTAL_SIZE_PX = 4;

/**
 * Open state lives on the module, not the instance: a portal hop restarts the scene and builds a
 * new Minimap, and a map you opened should not close itself because you walked through a door.
 */
let panelOpen = false;

/**
 * The minimap panel and its toggle, a DOM overlay beside the chat panel rather than a second
 * Phaser camera — a zoomed-out camera would redraw all 50k tiles of grand-plaza every frame and
 * would need every renderer in the project to remember to `ignore()` it.
 *
 * Owns its own 'm' shortcut, the way ChatPanel owns Enter.
 */
export class Minimap {
  private readonly panel = document.querySelector<HTMLElement>("#minimap")!;
  private readonly canvas = document.querySelector<HTMLCanvasElement>("#minimap-canvas")!;
  private readonly button = document.querySelector<HTMLButtonElement>("#minimap-button")!;
  private readonly context: CanvasRenderingContext2D;
  private readonly pxPerTile: number;
  /** Last drawn marker geometry, quantised to canvas pixels; null forces the next frame to draw. */
  private lastDrawn: string | null = null;

  constructor(
    private readonly terrain: MinimapTerrain,
    private readonly portals: readonly TilePosition[],
    mapLabel: string,
  ) {
    const context = this.canvas.getContext("2d");
    if (!context) {
      throw new Error("could not get a 2d context for the minimap");
    }
    this.context = context;

    this.pxPerTile = Math.min(
      MAX_WIDTH_PX / terrain.cols,
      MAX_HEIGHT_PX / terrain.rows,
      MAX_PX_PER_TILE,
    );
    this.canvas.width = Math.round(terrain.cols * this.pxPerTile);
    this.canvas.height = Math.round(terrain.rows * this.pxPerTile);
    const region = LANDMARK_DEFINITIONS.find((landmark) => landmark.room === mapLabel)?.name ?? mapLabel;
    this.canvas.setAttribute("aria-label", `${region} 미니맵`);
    // A percentage of the HUD column, which is itself a percentage of the stage, so the panel
    // tracks Phaser's Scale.FIT exactly. Never measured: the panel reports zero while hidden.
    this.panel.style.width = `${(this.canvas.width / MAX_WIDTH_PX) * 100}%`;

    this.button.addEventListener("click", this.handleClick);
    window.addEventListener("keydown", this.handleKey);
    this.button.hidden = false;
    this.applyOpenState();
  }

  /**
   * Called every frame. Returns without touching the canvas while closed, or while the markers
   * have not moved by a whole canvas pixel.
   */
  update(view: MinimapView): void {
    if (!panelOpen) {
      return;
    }
    const drawn = this.quantise(view);
    if (drawn === this.lastDrawn) {
      return;
    }
    this.lastDrawn = drawn;
    this.render(view);
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and the canvas is shared, so an abandoned instance would toggle `panelOpen` back on
   * every press — the key would look dead — and repaint the old room's terrain.
   *
   * Only hides the button, not the panel: `panelOpen` is module-scope on purpose (a map you
   * opened should not close itself because you walked through a door) and must survive this call
   * unchanged — this is cleanup for a failed successor construction, not a room-hop close.
   */
  destroy(): void {
    this.button.removeEventListener("click", this.handleClick);
    window.removeEventListener("keydown", this.handleKey);
    this.button.hidden = true;
  }

  private readonly handleClick = (event: MouseEvent): void => {
    this.toggle();
    // A pointer click leaves focus on the button, and the chat composer yields Enter to focused
    // buttons — keeping it would silently stop Enter from opening the composer. `detail === 0`
    // is a keyboard activation, where the focus ring is the user's place in the page.
    if (event.detail > 0) {
      this.button.blur();
    }
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    // Physical code, so the binding survives the layout and the IME, and modifier combinations
    // are left to the browser and the OS (Ctrl+M, Cmd+M, Alt+M all mean something already).
    if (event.code !== "KeyM" || event.repeat) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (isTextEntry(document.activeElement)) {
      return;
    }
    event.preventDefault();
    this.toggle();
  };

  private toggle(): void {
    panelOpen = !panelOpen;
    this.applyOpenState();
  }

  private applyOpenState(): void {
    this.panel.hidden = !panelOpen;
    this.button.setAttribute("aria-expanded", String(panelOpen));
    this.lastDrawn = null;
    if (panelOpen) {
      this.drawTerrain();
    }
  }

  private render(view: MinimapView): void {
    this.drawTerrain();

    const context = this.context;
    const scale = this.pxPerTile;

    // A fixed size, not a tile's worth, so an exit stays findable at either room's scale.
    // Rounded to whole pixels: the panel is upscaled with `image-rendering: pixelated`, which
    // magnifies an anti-aliased edge into a smear.
    context.fillStyle = PORTAL_FILL;
    for (const { tileX, tileY } of this.portals) {
      context.fillRect(
        Math.round((tileX + 0.5) * scale - PORTAL_SIZE_PX / 2),
        Math.round((tileY + 0.5) * scale - PORTAL_SIZE_PX / 2),
        PORTAL_SIZE_PX,
        PORTAL_SIZE_PX,
      );
    }

    // Half-pixel offset so a 1px stroke lands on the pixel rather than across two of them.
    context.lineWidth = 1;
    context.strokeStyle = VIEWPORT_STROKE;
    context.strokeRect(
      view.camera.x * scale + 0.5,
      view.camera.y * scale + 0.5,
      Math.max(view.camera.width * scale - 1, 1),
      Math.max(view.camera.height * scale - 1, 1),
    );

    if (!view.self) {
      return;
    }
    context.beginPath();
    context.arc(view.self.x * scale, view.self.y * scale, SELF_RADIUS_PX, 0, Math.PI * 2);
    context.fillStyle = SELF_FILL;
    context.fill();
    context.lineWidth = SELF_OUTLINE_PX;
    context.strokeStyle = SELF_OUTLINE;
    context.stroke();
  }

  private drawTerrain(): void {
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(
      this.terrain.buffer,
      0,
      0,
      this.terrain.cols,
      this.terrain.rows,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
  }

  private quantise(view: MinimapView): string {
    const scale = this.pxPerTile;
    const self = view.self
      ? `${Math.round(view.self.x * scale)},${Math.round(view.self.y * scale)}`
      : "none";
    return [
      self,
      Math.round(view.camera.x * scale),
      Math.round(view.camera.y * scale),
      Math.round(view.camera.width * scale),
      Math.round(view.camera.height * scale),
    ].join(" ");
  }
}
