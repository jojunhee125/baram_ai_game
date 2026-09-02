import { loadLootTable, type LootTableMonster } from "../net/lootTable";
import { isTextEntry } from "../input/textEntry";
import { applyItemIcon } from "./inventoryPanel";

/** Which of the four mutually exclusive contents the window is currently drawing. */
type PanelView = "loading" | "items" | "empty" | "error";

/**
 * Open state lives on the module, not the instance, for the same reason the bag's does: a portal
 * hop restarts the scene and builds a new panel, and this window is its own toggle — independent
 * of `InventoryPanel`'s `panelOpen`, because they are different panels with different keys.
 */
let panelOpen = false;

/**
 * The drop-table window and its L shortcut.
 *
 * Room-scoped rather than account-scoped: one instance per room (`WorldScene` builds a fresh one
 * on every portal hop, passing the new `roomName`), which is the whole mechanism behind "the table
 * shown always matches the room you are standing in" — there is no room-switch logic here at all.
 *
 * Like the bag, this window does not stop the player moving — only `WorldScene.swing()`'s gate
 * reads `isOpen`, exactly as it already does for `InventoryPanel`.
 *
 * Unlike the bag, a successful read is cached for the lifetime of this instance: the table is
 * static per-room content (no consumption, no trade), so reopening never re-queries. A failed
 * read leaves the cache empty, so the retry button still has something to retry.
 */
export class LootTablePanel {
  private readonly panel = document.querySelector<HTMLElement>("#loot-table")!;
  private readonly button = document.querySelector<HTMLButtonElement>("#loot-table-button")!;
  private readonly closeButton = document.querySelector<HTMLButtonElement>("#loot-table-close")!;
  private readonly retryButton = document.querySelector<HTMLButtonElement>("#loot-table-retry")!;
  private readonly list = document.querySelector<HTMLElement>("#loot-table-list")!;
  private readonly status = document.querySelector<HTMLElement>("#loot-table-status")!;
  private readonly statusIcon = document.querySelector<HTMLElement>("#loot-table-status-icon")!;
  private readonly statusText = document.querySelector<HTMLElement>("#loot-table-status-text")!;
  private readonly statusHint = document.querySelector<HTMLElement>("#loot-table-status-hint")!;
  /**
   * Which read the DOM is allowed to belong to. Every reply checks it before drawing, so a slow
   * response cannot land in a panel that has since been closed, reopened, or handed to the
   * successor a room hop built — all three share these nodes.
   */
  private request = 0;
  /** Which block is on screen. */
  private view: PanelView = "loading";
  /** Set on the first successful read only; a failed read leaves this null so retry has something
   * to retry. */
  private cache: readonly LootTableMonster[] | null = null;

  constructor(private readonly roomName: string) {
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
   * `WorldScene.swing()` reads this to swallow the Attack input while the table is up, the same
   * way it already does for `InventoryPanel.isOpen` — movement stays live.
   */
  get isOpen(): boolean {
    return panelOpen;
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would toggle `panelOpen` back
   * on every press and an in-flight read would repaint the live panel with the departed room's
   * request.
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
    // Physical code + native-repeat guard, same reasoning as InventoryPanel's KeyI binding: typing
    // "ㅣ" in chat can send the same code walking does, which is how a stray keystroke opens a
    // panel behind the composer.
    if (event.code !== "KeyL" || event.repeat) {
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
    // only `event.target` still names the field the keystroke came from (ObjectPanel/InventoryPanel
    // carry the same ordering trap).
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
      this.list.replaceChildren();
      this.request += 1;
      return;
    }
    this.panel.hidden = false;
    this.refresh();
  }

  private refresh(): void {
    if (this.cache) {
      this.showMonsters(this.cache);
      return;
    }
    this.request += 1;
    const request = this.request;
    this.showLoading();
    void loadLootTable(this.roomName).then(
      (monsters) => {
        if (request !== this.request) {
          return;
        }
        this.cache = monsters;
        this.showMonsters(monsters);
      },
      (error: unknown) => {
        if (request !== this.request) {
          return;
        }
        console.warn("could not read the loot table", error);
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
    this.statusText.textContent = "확률표를 불러오는 중…";
    this.statusHint.textContent = "";
    this.retryButton.hidden = true;
    this.status.hidden = false;
  }

  private showMonsters(monsters: readonly LootTableMonster[]): void {
    this.list.setAttribute("aria-busy", "false");
    if (monsters.length === 0) {
      this.view = "empty";
      this.list.replaceChildren();
      this.list.hidden = true;
      this.statusIcon.hidden = false;
      this.statusText.textContent = "이 지역에는 몬스터가 없습니다.";
      this.statusHint.textContent = "";
      this.status.hidden = false;
      return;
    }
    this.view = "items";
    this.list.replaceChildren(...monsters.map((monster) => this.buildMonsterSection(monster)));
    this.list.hidden = false;
    this.status.hidden = true;
  }

  private showError(): void {
    this.view = "error";
    this.list.replaceChildren();
    this.list.hidden = true;
    this.list.setAttribute("aria-busy", "false");
    this.statusIcon.hidden = true;
    this.statusText.textContent = "확률표를 읽지 못했습니다.";
    this.statusHint.textContent = "잠시 후 다시 시도해 주세요.";
    this.retryButton.textContent = "다시 시도";
    this.retryButton.hidden = false;
    this.status.hidden = false;
  }

  private buildMonsterSection(monster: LootTableMonster): HTMLLIElement {
    const section = document.createElement("li");
    section.className = "loot-table__monster";

    const name = document.createElement("h3");
    name.className = "loot-table__monster-name";
    name.textContent = monster.name;

    const drops = document.createElement("ul");
    drops.className = "loot-table__drops";
    drops.append(...monster.drops.map((drop) => {
      const row = document.createElement("li");
      row.className = "loot-table__drop";

      const icon = document.createElement("span");
      applyItemIcon(icon, drop.icon);

      const dropName = document.createElement("span");
      dropName.className = "loot-table__drop-name";
      dropName.textContent = drop.name;

      const chance = document.createElement("span");
      chance.className = "loot-table__drop-chance";
      chance.textContent = `${drop.chancePercent}%`;

      row.append(icon, dropName, chance);
      return row;
    }));

    section.append(name, drops);
    return section;
  }

  /**
   * The chat composer yields Enter to any focused button, so focus left on 닫기 or 다시 시도 would
   * silently stop Enter from opening the composer.
   */
  private releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.panel.contains(focused)) {
      focused.blur();
    }
  }
}
