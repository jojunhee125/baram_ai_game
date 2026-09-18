import { ATTACK_PER_LEVEL, HP_PER_LEVEL } from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";

/**
 * Open state lives on the module, not the instance, for the same reason the bag's and the
 * drop-table window's does: a portal hop restarts the scene and builds a new panel, and a menu
 * you opened should not close itself because you walked through a door.
 */
let panelOpen = false;

/**
 * The character menu and its C shortcut.
 *
 * Non-modal like the bag and the drop-table window — a popover in the HUD column, world still
 * visible, movement not blocked while this itself is open. Phase H seeds it with one row
 * ("스킨 변경"); Phase Q appends more without this class or its callback shape changing. What
 * "스킨 변경" actually opens is not this class's business — `WorldScene` wires the callback to the
 * avatar picker (`docs/design-phase-h-skin-skip-menu.md` §2.2-2.3), which *is* modal and blocks
 * movement on its own, via `WorldScene`'s `skinPickerOpen` gate rather than anything here.
 */
export class CharacterMenu {
  private readonly panel = document.querySelector<HTMLElement>("#character-menu")!;
  private readonly button = document.querySelector<HTMLButtonElement>("#character-menu-button")!;
  private readonly closeButton = document.querySelector<HTMLButtonElement>("#character-menu-close")!;
  private readonly changeSkinButton = document.querySelector<HTMLButtonElement>(
    "#character-menu-change-skin",
  )!;
  private readonly levelValue = document.querySelector<HTMLElement>("#character-menu-level")!;
  private readonly atkBonusValue = document.querySelector<HTMLElement>(
    "#character-menu-atk-bonus",
  )!;
  private readonly hpBonusValue = document.querySelector<HTMLElement>("#character-menu-hp-bonus")!;
  private readonly classValue = document.querySelector<HTMLElement>("#character-menu-class-value")!;
  private readonly chooseClassButton = document.querySelector<HTMLButtonElement>(
    "#character-menu-choose-class",
  )!;

  constructor(
    private readonly onChangeSkin: () => void,
    /** roadmap R05-a (design D9) — reopens `ClassPicker` for an account that dismissed it unchosen. */
    private readonly onChooseClass: () => void,
  ) {
    this.button.addEventListener("click", this.handleToggleClick);
    this.closeButton.addEventListener("click", this.handleCloseClick);
    this.changeSkinButton.addEventListener("click", this.handleChangeSkinClick);
    this.chooseClassButton.addEventListener("click", this.handleChooseClassClick);
    window.addEventListener("keydown", this.handleKey);
    this.button.hidden = false;
    this.applyOpenState();
  }

  get isOpen(): boolean {
    return panelOpen;
  }

  /**
   * The stat row's only data (design-phase-w2-level-client.md §2.3) — level-only bonuses, never a
   * total: this bundle never learns an equipped item's own attackDamage/maxHp, so a bare "공격력
   * +X" would read as the sum and be wrong the instant a weapon is worn. Pure arithmetic off the
   * same per-level constants the server anchors totalAttack/totalMaxHp to (design §4.2) — no
   * message of its own, called whenever `WorldScene` already knows the local player's level.
   */
  applyLevel(level: number): void {
    this.levelValue.textContent = String(level);
    this.atkBonusValue.textContent = String((level - 1) * ATTACK_PER_LEVEL);
    this.hpBonusValue.textContent = String((level - 1) * HP_PER_LEVEL);
  }

  /**
   * The account's class, or the lack of one (roadmap R05-a, design D9) — `null` shows "미선택" and
   * the 직업 선택 row that reopens `ClassPicker`; a real label hides that row, since D1 leaves no
   * way to change a class once chosen and there is nothing left to reopen.
   */
  applyClass(label: string | null): void {
    this.classValue.textContent = label ?? "미선택";
    this.chooseClassButton.hidden = label !== null;
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would toggle `panelOpen`
   * back on every press and answer clicks meant for the room it left.
   */
  destroy(): void {
    this.button.removeEventListener("click", this.handleToggleClick);
    this.closeButton.removeEventListener("click", this.handleCloseClick);
    this.changeSkinButton.removeEventListener("click", this.handleChangeSkinClick);
    this.chooseClassButton.removeEventListener("click", this.handleChooseClassClick);
    window.removeEventListener("keydown", this.handleKey);
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

  /**
   * Closes the popover before handing off, so the modal picker it opens is never sitting behind
   * a popover that is still, technically, open.
   */
  private readonly handleChangeSkinClick = (event: MouseEvent): void => {
    this.setOpen(false);
    if (event.detail > 0) {
      this.changeSkinButton.blur();
    }
    this.onChangeSkin();
  };

  /** {@link handleChangeSkinClick}'s own "close this popover before handing off" order. */
  private readonly handleChooseClassClick = (event: MouseEvent): void => {
    this.setOpen(false);
    if (event.detail > 0) {
      this.chooseClassButton.blur();
    }
    this.onChooseClass();
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.handleEscape(event);
      return;
    }
    // Physical code + native-repeat guard, same reasoning as every other HUD shortcut: typing a
    // Hangul syllable in chat can send the same code walking does, which is how a stray keystroke
    // opens a panel behind the composer.
    if (event.code !== "KeyC" || event.repeat) {
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
    // ObjectPanel/InventoryPanel/LootTablePanel).
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

  /**
   * The chat composer yields Enter to any focused button, so focus left on 닫기 or 스킨 변경 would
   * silently stop Enter from opening the composer.
   */
  private releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.panel.contains(focused)) {
      focused.blur();
    }
  }
}
