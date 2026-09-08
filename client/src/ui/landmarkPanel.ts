import { HOME_COOLDOWN_MS, LANDMARK_DEFINITIONS } from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";

/**
 * Open state lives on the module, not the instance, for the same reason the character menu's does:
 * a cross-room hop restarts the scene and builds a new panel, and a panel you opened should not
 * close itself because you walked through a door.
 */
let panelOpen = false;

/**
 * Cooldown mirror only, deliberately its own module-scope value rather than sharing HomeButton's —
 * the two controls share one server-side budget (`lastWarpAt`), but not this display
 * (`docs/design-phase-m-landmark-teleport.md` §2.3/§8-1). A warp made through either control leaves
 * the other's rows looking clickable for the rest of the shared cooldown; that mismatch is a known,
 * accepted limitation, not a bug to fix here.
 */
let cooldownUntil = 0;

/**
 * The landmark panel and its T shortcut.
 *
 * Non-modal like the bag/drop-table/character menu — a popover in the HUD column, world still
 * visible, movement not blocked while this is open. Unlike the character menu's one hand-written
 * row, every row here is built at construction time from `LANDMARK_DEFINITIONS` (shared data), so
 * `index.html` holds only an empty `<ul>` (docs/design-phase-m-landmark-teleport.md §3.2).
 */
export class LandmarkPanel {
  private readonly panel = document.querySelector<HTMLElement>("#landmark-panel")!;
  private readonly button = document.querySelector<HTMLButtonElement>("#landmark-button")!;
  private readonly closeButton = document.querySelector<HTMLButtonElement>("#landmark-panel-close")!;
  private readonly list = document.querySelector<HTMLElement>("#landmark-panel-list")!;
  private readonly rows: HTMLButtonElement[] = [];
  private cooldownTimer: number | undefined;

  constructor(private readonly onSelect: (landmarkId: string) => void) {
    this.button.addEventListener("click", this.handleToggleClick);
    this.closeButton.addEventListener("click", this.handleCloseClick);
    window.addEventListener("keydown", this.handleKey);
    this.buildRows();
    this.button.hidden = false;
    this.applyOpenState();
    this.applyCooldown();
  }

  get isOpen(): boolean {
    return panelOpen;
  }

  /** Locks every row for HOME_COOLDOWN_MS, mirroring the server's shared warp cooldown. */
  beginCooldown(): void {
    cooldownUntil = Date.now() + HOME_COOLDOWN_MS;
    this.applyCooldown();
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would toggle `panelOpen` back
   * on every press and answer clicks meant for the room it left.
   */
  destroy(): void {
    this.button.removeEventListener("click", this.handleToggleClick);
    this.closeButton.removeEventListener("click", this.handleCloseClick);
    window.removeEventListener("keydown", this.handleKey);
    window.clearTimeout(this.cooldownTimer);
    // Rows are rebuilt from LANDMARK_DEFINITIONS at construction, unlike CharacterMenu's one
    // hand-written row — clearing them here drops their listeners immediately instead of leaving a
    // click on a stale row reach this dead instance's onSelect in the moment before the scene
    // restart lands.
    this.list.replaceChildren();
    this.rows.length = 0;
  }

  private buildRows(): void {
    for (const landmark of LANDMARK_DEFINITIONS) {
      const item = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "landmark-panel__item";
      row.textContent = landmark.name;
      row.addEventListener("click", (event: MouseEvent) => {
        // Closes before acting, same order CharacterMenu.handleChangeSkinClick uses.
        this.setOpen(false);
        if (event.detail > 0) {
          row.blur();
        }
        this.onSelect(landmark.id);
      });
      item.append(row);
      this.list.append(item);
      this.rows.push(row);
    }
  }

  private readonly handleToggleClick = (event: MouseEvent): void => {
    this.setOpen(!panelOpen);
    // A pointer click leaves focus on the button, and the chat composer yields Enter to focused
    // buttons — keeping it would silently stop Enter from opening the composer. `detail === 0`
    // is a keyboard activation, where the focus ring is the user's place in the page.
    if (event.detail > 0) {
      this.button.blur();
    }
  };

  private readonly handleCloseClick = (event: MouseEvent): void => {
    this.setOpen(false);
    if (event.detail === 0) {
      this.button.focus();
    }
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.handleEscape(event);
      return;
    }
    // Physical code + native-repeat guard, same reasoning as every other HUD shortcut: typing a
    // Hangul syllable in chat can send the same code walking does, which is how a stray keystroke
    // opens a panel behind the composer.
    if (event.code !== "KeyT" || event.repeat) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (isTextEntry(document.activeElement)) {
      return;
    }
    event.preventDefault();
    this.setOpen(!panelOpen);
  };

  private handleEscape(event: KeyboardEvent): void {
    if (!panelOpen) {
      return;
    }
    // The composer blurs itself in the target phase before this bubble-phase listener runs, so
    // only `event.target` still names the field the keystroke came from (same ordering trap as
    // ObjectPanel/InventoryPanel/LootTablePanel/CharacterMenu).
    if (isTextEntry(event.target as Element | null)) {
      return;
    }
    event.preventDefault();
    this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    panelOpen = open;
    this.applyOpenState();
  }

  private applyOpenState(): void {
    this.button.setAttribute("aria-expanded", String(panelOpen));
    if (!panelOpen) {
      this.releaseFocus();
    }
    this.panel.hidden = !panelOpen;
  }

  /** Disables every row for whatever is left of the module's cooldown window, if any. */
  private applyCooldown(): void {
    const remainingMs = cooldownUntil - Date.now();
    window.clearTimeout(this.cooldownTimer);
    if (remainingMs <= 0) {
      this.setRowsDisabled(false);
      return;
    }
    this.setRowsDisabled(true);
    this.cooldownTimer = window.setTimeout(() => {
      this.setRowsDisabled(false);
    }, remainingMs);
  }

  private setRowsDisabled(disabled: boolean): void {
    for (const row of this.rows) {
      row.disabled = disabled;
    }
  }

  /**
   * The chat composer yields Enter to any focused button, so focus left on a row or 닫기 would
   * silently stop Enter from opening the composer.
   */
  private releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.panel.contains(focused)) {
      focused.blur();
    }
  }
}
