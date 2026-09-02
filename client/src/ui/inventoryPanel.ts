import type { ItemGranted } from "@zep-test/shared";
import { loadInventory, type InventoryItem } from "../net/inventory";
import { isTextEntry } from "../input/textEntry";

/**
 * Column order of `assets/sprites/items.png`, and therefore the set of `ItemDefinition.icon`
 * values this bundle can draw. Reordering it repaints every bag with the wrong pictures, so
 * tools/generate-monster-art.mjs reads this array and refuses to bake the sheet if its own table
 * disagrees — the same guard MONSTER_SPRITE_ORDER carries.
 */
export const ITEM_ICON_ORDER = [
  "slime-jelly",
  "bat-wing",
  "copper-coin",
  "herb",
  "old-dagger",
] as const;

/** One frame of items.png at 1x. The HUD column is CSS-sized, so this is CSS pixels. */
const ICON_SIZE_PX = 32;

/**
 * Paints one column of `items.png` onto `node`, or leaves a visibly empty slot for an icon key
 * this bundle has no column for — the server can hold a catalogue newer than the browser (the
 * reason `icon` travels with the row at all), and an empty slot beside a real name beats a blank
 * line or, worse, some other item's picture.
 *
 * Exported so the drop toast draws its icon by the same table and the same fallback. A second
 * key-to-column mapping is exactly how the two windows would come to disagree.
 */
export function applyItemIcon(node: HTMLElement, icon: string): void {
  const frame = (ITEM_ICON_ORDER as readonly string[]).indexOf(icon);
  if (frame === -1) {
    node.className = "bag__icon bag__icon--unknown";
    return;
  }
  node.className = "bag__icon";
  node.style.backgroundPosition = `-${frame * ICON_SIZE_PX}px 0`;
}

/** Which of the four mutually exclusive contents the window is currently drawing. */
type PanelView = "loading" | "items" | "empty" | "error";

/**
 * Open state lives on the module, not the instance, for the same reason the minimap's does: a
 * portal hop restarts the scene and builds a new panel, and a bag you opened should not close
 * itself because you walked through a door.
 */
let panelOpen = false;

/**
 * The bag window and its I shortcut.
 *
 * **This window does not stop the player moving.** The fixed-object panel does, deliberately
 * (`docs/design-fixed-objects.md` §9.5: reading holds you still), but a hunting ground is exactly
 * where checking your bag must not pin you in place while something is chewing on you — the
 * decision and its reasoning are in `docs/design-hunting-inventory.md` §3.4. So it lives in the
 * HUD column beside the minimap rather than behind a scrim, and `WorldScene.update()` never
 * consults it.
 *
 * The contents are read over HTTP on every open, because a bag is account data rather than room
 * state: putting it on the room would mean a database query inside the message path that has to
 * carry 500 CCU.
 */
export class InventoryPanel {
  private readonly panel = document.querySelector<HTMLElement>("#inventory")!;
  private readonly button = document.querySelector<HTMLButtonElement>("#inventory-button")!;
  private readonly closeButton = document.querySelector<HTMLButtonElement>("#inventory-close")!;
  private readonly retryButton = document.querySelector<HTMLButtonElement>("#inventory-retry")!;
  private readonly list = document.querySelector<HTMLElement>("#inventory-list")!;
  private readonly status = document.querySelector<HTMLElement>("#inventory-status")!;
  private readonly statusIcon = document.querySelector<HTMLElement>("#inventory-status-icon")!;
  private readonly statusText = document.querySelector<HTMLElement>("#inventory-status-text")!;
  private readonly statusHint = document.querySelector<HTMLElement>("#inventory-status-hint")!;
  /**
   * Which read the DOM is allowed to belong to. Every reply checks it before drawing, so a slow
   * response cannot land in a bag that has since been closed, reopened, or handed to the successor
   * a room hop built — all three share these nodes.
   */
  private request = 0;
  /** Which block is on screen, so a live grant knows whether there is a list to patch. */
  private view: PanelView = "loading";

  constructor() {
    this.button.addEventListener("click", this.handleToggleClick);
    this.closeButton.addEventListener("click", this.handleCloseClick);
    this.retryButton.addEventListener("click", this.handleRetryClick);
    window.addEventListener("keydown", this.handleKey);
    this.button.hidden = false;
    this.applyOpenState();
  }

  /**
   * Read off the module flag, which is the part shared between instances.
   *
   * Pass E reads this to swallow the Attack input while the bag is up: a click or a keypress
   * aimed at a row must not also swing at whatever is standing next to you. That is the *only*
   * input this window is allowed to take — movement stays live (§3.4).
   */
  get isOpen(): boolean {
    return panelOpen;
  }

  /**
   * Folds one drop into an open bag, so a pickup shows up without a second `GET /api/inventory`.
   * `ItemGranted.total` is the amount held afterwards, which is exactly what a row displays.
   *
   * A grant that lands while the window is loading or showing a failure is dropped: the read in
   * flight will carry it, and the retry button covers the other case. That leaves the bag at most
   * one pickup behind for the length of one request, which reopening resolves.
   */
  applyGrant(event: ItemGranted): void {
    if (!panelOpen || this.view === "loading" || this.view === "error") {
      return;
    }
    const count = this.findCount(event.itemKey);
    if (count) {
      count.textContent = String(event.total);
      return;
    }
    this.list.append(
      this.buildRow({
        itemKey: event.itemKey,
        name: event.name,
        icon: event.icon,
        quantity: event.total,
      }),
    );
    this.list.hidden = false;
    this.status.hidden = true;
    this.view = "items";
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would toggle `panelOpen` back
   * on every press — the key would look dead — and an in-flight read would repaint the live
   * panel with the departed room's request.
   */
  destroy(): void {
    this.button.removeEventListener("click", this.handleToggleClick);
    this.closeButton.removeEventListener("click", this.handleCloseClick);
    this.retryButton.removeEventListener("click", this.handleRetryClick);
    window.removeEventListener("keydown", this.handleKey);
    this.request += 1;
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
    // Keyboard activation hands focus back to the control that opened this; without it the ring
    // falls into <body> and the next Tab restarts from the top of the page.
    if (event.detail === 0) {
      this.button.focus();
    }
  };

  private readonly handleRetryClick = (event: MouseEvent): void => {
    this.refresh();
    if (event.detail > 0) {
      this.retryButton.blur();
    }
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.handleEscape(event);
      return;
    }
    // Physical code, so the binding survives the layout and the IME. That is also what makes the
    // next guard necessary: typing "ㅑ" in chat sends `KeyI` exactly as walking does, which is how
    // "I typed a message and the bag opened" happens (the same defect homeButton.ts:63 records).
    if (event.code !== "KeyI" || event.repeat) {
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
    // Escape in the chat composer clears the composer; that keystroke must not also close the bag
    // behind it. The composer blurs itself in the target phase, before this bubble-phase listener
    // runs, so only `event.target` still names the field the keystroke came from — the same
    // ordering trap ObjectPanel.handleKey documents.
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
      this.panel.hidden = true;
      // Dropped rather than left on screen: the next open re-reads anyway, and a stale bag
      // flashing before the new one arrives reads as an item vanishing.
      this.list.replaceChildren();
      this.request += 1;
      return;
    }
    this.panel.hidden = false;
    this.refresh();
  }

  private refresh(): void {
    this.request += 1;
    const request = this.request;
    this.showLoading();
    void loadInventory().then(
      (items) => {
        if (request === this.request) {
          this.showItems(items);
        }
      },
      (error: unknown) => {
        if (request !== this.request) {
          return;
        }
        console.warn("could not read the bag", error);
        this.showError();
      },
    );
  }

  private showLoading(): void {
    this.view = "loading";
    this.list.replaceChildren();
    this.list.hidden = true;
    this.list.setAttribute("aria-busy", "true");
    this.statusIcon.hidden = true;
    this.statusText.textContent = "가방을 여는 중…";
    this.statusHint.textContent = "";
    this.retryButton.hidden = true;
    this.status.hidden = false;
  }

  private showItems(items: readonly InventoryItem[]): void {
    this.list.setAttribute("aria-busy", "false");
    if (items.length === 0) {
      this.view = "empty";
      this.list.replaceChildren();
      this.list.hidden = true;
      this.statusIcon.hidden = false;
      this.statusText.textContent = "가방이 비어 있습니다.";
      this.statusHint.textContent = "사냥터에서 얻은 물건이 여기에 쌓입니다.";
      this.retryButton.textContent = "새로 고침";
      this.retryButton.hidden = false;
      this.status.hidden = false;
      return;
    }
    this.view = "items";
    this.list.replaceChildren(...items.map((item) => this.buildRow(item)));
    this.list.hidden = false;
    this.status.hidden = true;
  }

  private showError(): void {
    this.view = "error";
    this.list.replaceChildren();
    this.list.hidden = true;
    this.list.setAttribute("aria-busy", "false");
    this.statusIcon.hidden = true;
    this.statusText.textContent = "가방을 읽지 못했습니다.";
    this.statusHint.textContent = "잠시 후 다시 시도해 주세요.";
    this.retryButton.textContent = "다시 시도";
    this.retryButton.hidden = false;
    this.status.hidden = false;
  }

  /** Looks the row up by walking the list rather than by selector: `itemKey` is server data. */
  private findCount(itemKey: string): HTMLElement | null {
    for (const row of this.list.children) {
      if (row instanceof HTMLElement && row.dataset.itemKey === itemKey) {
        return row.querySelector<HTMLElement>(".bag__count");
      }
    }
    return null;
  }

  private buildRow(item: InventoryItem): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "bag__row";
    // What `applyGrant` finds the row by, so a pickup lands on the item it belongs to.
    row.dataset.itemKey = item.itemKey;

    const icon = document.createElement("span");
    applyItemIcon(icon, item.icon);

    const name = document.createElement("span");
    name.className = "bag__name";
    name.textContent = item.name;

    const count = document.createElement("span");
    count.className = "bag__count";
    count.textContent = String(item.quantity);

    const unit = document.createElement("span");
    unit.className = "visually-hidden";
    unit.textContent = "개";

    row.append(icon, name, count, unit);
    return row;
  }

  /**
   * The chat composer yields Enter to any focused button, so focus left on 닫기 or 다시 시도 would
   * silently stop Enter from opening the composer. Same fix ObjectPanel applies on close, except
   * that here the nodes are only hidden rather than emptied.
   */
  private releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.panel.contains(focused)) {
      focused.blur();
    }
  }
}
