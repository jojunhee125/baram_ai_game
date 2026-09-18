import {
  CLASS_DEFINITIONS,
  PlayerClassKey,
  type ClassChanged,
  type ClassDenied,
} from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";

/** Design doc §2 D7's own role column — display copy only, no tunable value lives in this table. */
const ROLE_TAGLINE: Readonly<Record<PlayerClassKey, string>> = {
  [PlayerClassKey.Warrior]: "근접·버티기",
  [PlayerClassKey.Rogue]: "위치 선정·순간 공격",
  [PlayerClassKey.Shaman]: "MP 기반 원거리",
  [PlayerClassKey.Cleric]: "회복·지원",
};

/**
 * A qualitative reading of a `CLASS_DEFINITIONS` multiplier against the 1.0 baseline — never a
 * hardcoded number of its own, so a rebalance of the underlying multiplier (design §5 열린 질문 2
 * calls every number provisional) never needs a matching edit here.
 */
function tendencyLabel(multiplier: number): string {
  if (multiplier > 1.05) {
    return "높음";
  }
  if (multiplier < 0.95) {
    return "낮음";
  }
  return "보통";
}

/**
 * "을" after a syllable with a batchim (final consonant), "를" after one without — the standard
 * Hangul-syllable-block arithmetic: a modern Hangul syllable is `0xAC00 + (initial*21+medial)*28
 * + final`, so `% 28 === 0` means `final === 0`, i.e. no batchim.
 */
function objectParticle(label: string): "을" | "를" {
  const code = label.charCodeAt(label.length - 1) - 0xac00;
  if (code < 0 || code > 11171) {
    return "를";
  }
  return code % 28 === 0 ? "를" : "을";
}

/**
 * The class picker (roadmap R05-a, `docs/r05-classes-and-skills.md` D9). Opens itself on the
 * join-time `class:changed` sync for an account that has never chosen (`classKey: null`) and is
 * reopenable from the character menu for as long as that stays true — there is no reopen path
 * once a real class lands, since D1 leaves no way to change it in V1.
 *
 * Unlike `avatarPicker.ts`'s `.picker`, this never blocks play (design D9): movement, chat, the
 * basic attack, quests and the shop all keep working while it is up — `WorldScene` never gates on
 * it the way it gates on `objectPanel.blocksMovement`/`skinPickerOpen`. It still behaves like a
 * real dialog for a keyboard/screen-reader user (Tab stays inside it, Escape closes it); a scrim
 * over the canvas only stops mouse clicks reaching the world, and this game has no click-to-move
 * for it to block.
 */
export class ClassPicker {
  private readonly root = document.querySelector<HTMLElement>("#class-picker")!;
  private readonly dialog = document.querySelector<HTMLElement>("#class-picker-dialog")!;
  private readonly closeButton = document.querySelector<HTMLButtonElement>("#class-picker-close")!;
  private readonly selectView = document.querySelector<HTMLElement>("#class-picker-select")!;
  private readonly grid = document.querySelector<HTMLElement>("#class-picker-grid")!;
  private readonly chooseButton = document.querySelector<HTMLButtonElement>("#class-picker-choose")!;
  private readonly confirmView = document.querySelector<HTMLElement>("#class-picker-confirm")!;
  private readonly confirmText = document.querySelector<HTMLElement>("#class-picker-confirm-text")!;
  private readonly confirmBack = document.querySelector<HTMLButtonElement>(
    "#class-picker-confirm-back",
  )!;
  private readonly confirmYes = document.querySelector<HTMLButtonElement>(
    "#class-picker-confirm-yes",
  )!;
  private readonly status = document.querySelector<HTMLElement>("#class-picker-status")!;
  private cards: HTMLButtonElement[] = [];
  private selected: PlayerClassKey | null = null;

  constructor(private readonly onChoose: (classKey: PlayerClassKey) => void) {
    this.buildCards();
    this.closeButton.addEventListener("click", this.handleClose);
    this.chooseButton.addEventListener("click", this.handleChooseClick);
    this.confirmBack.addEventListener("click", this.handleConfirmBackClick);
    this.confirmYes.addEventListener("click", this.handleConfirmYesClick);
    this.grid.addEventListener("keydown", this.handleGridKey);
    window.addEventListener("keydown", this.handleKey);
    // The DOM outlives the scene, so a successor built by a room hop inherits whatever the
    // previous instance left on screen — including a card armed mid-confirm.
    this.resetSelection();
    this.close();
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /**
   * Shows the panel. Resets to a fresh grid only if it was not already open — a redundant open
   * (the character menu's row, pressed while the join-time sync already opened this) must not
   * throw away a selection already in progress.
   */
  open(): void {
    if (!this.isOpen) {
      this.resetSelection();
    }
    this.root.hidden = false;
    this.dialog.focus();
  }

  close(): void {
    this.releaseFocus();
    this.root.hidden = true;
  }

  /**
   * The account's class, or the lack of one. `classKey: null` is always the join-time sync — a
   * real class never reverts to it (D1) — so this is the one signal that opens the panel on its
   * own. A real `classKey` is the settle-and-close signal design D1 requires: whatever this panel
   * currently shows, the server's stored value wins, whether that is this attempt landing or
   * another tab's pick racing ahead of it (`chooseOnce`'s "first commit wins").
   */
  applyClassChanged(event: ClassChanged): void {
    if (event.classKey === null) {
      this.open();
      return;
    }
    if (this.isOpen) {
      this.close();
    }
  }

  /**
   * A `class:choose` this panel sent was refused. `already-chosen` needs no action here beyond
   * the notice — the `ClassChanged` carrying the account's real class is what settles and closes
   * the panel ({@link applyClassChanged}), never what the user clicked.
   */
  applyClassDenied(event: ClassDenied): void {
    if (!this.isOpen) {
      return;
    }
    if (event.reason === "unknown-class") {
      // Only reachable from a bundle skew, since every request this panel sends names a real key
      // — recoverable, so the confirm step reopens for another attempt rather than staying stuck.
      this.status.textContent = "선택하지 못했습니다. 다시 시도해 주세요.";
      this.confirmYes.disabled = false;
      this.confirmBack.disabled = false;
      this.confirmYes.textContent = "확정";
      return;
    }
    this.status.textContent = "이미 다른 직업을 선택했습니다.";
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would keep trapping Tab and
   * answering Escape for a panel the live instance owns.
   */
  destroy(): void {
    this.closeButton.removeEventListener("click", this.handleClose);
    this.chooseButton.removeEventListener("click", this.handleChooseClick);
    this.confirmBack.removeEventListener("click", this.handleConfirmBackClick);
    this.confirmYes.removeEventListener("click", this.handleConfirmYesClick);
    this.grid.removeEventListener("keydown", this.handleGridKey);
    window.removeEventListener("keydown", this.handleKey);
    this.close();
  }

  /** One radio card per `CLASS_DEFINITIONS` row, in the table's own order (전사/도적/주술사/도사). */
  private buildCards(): void {
    const cards = Object.values(CLASS_DEFINITIONS).map((definition) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "class-picker__card";
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", "false");
      card.tabIndex = -1;
      card.dataset.classKey = definition.key;

      const name = document.createElement("span");
      name.className = "class-picker__card-name";
      name.textContent = definition.label;

      const role = document.createElement("span");
      role.className = "class-picker__card-role";
      role.textContent = ROLE_TAGLINE[definition.key];

      const stats = document.createElement("span");
      stats.className = "class-picker__card-stats";
      stats.textContent = `체력 ${tendencyLabel(definition.maxHpMultiplier)} · 공격 ${tendencyLabel(definition.attackMultiplier)}`;

      card.append(name, role, stats);
      card.addEventListener("click", () => this.select(definition.key));
      return card;
    });
    this.grid.replaceChildren(...cards);
    this.cards = cards;
  }

  /** Marks one card checked (roving tabindex), and nothing more — sending is a separate, confirmed step. */
  private select(classKey: PlayerClassKey): void {
    this.selected = classKey;
    for (const card of this.cards) {
      const checked = card.dataset.classKey === classKey;
      card.setAttribute("aria-checked", String(checked));
      card.tabIndex = checked ? 0 : -1;
    }
    this.chooseButton.disabled = false;
  }

  private resetSelection(): void {
    this.selected = null;
    for (const [index, card] of this.cards.entries()) {
      card.setAttribute("aria-checked", "false");
      card.tabIndex = index === 0 ? 0 : -1;
    }
    this.chooseButton.disabled = true;
    this.confirmView.hidden = true;
    this.selectView.hidden = false;
    this.status.textContent = "";
    this.confirmYes.disabled = false;
    this.confirmBack.disabled = false;
    this.confirmYes.textContent = "확정";
  }

  /**
   * The confirm step design D1's "no undo" needs — a click on 선택하기 arms this instead of sending
   * anything. Default focus lands on 다시 고르기 rather than 확정: the reversible action, not the
   * permanent one, is what a stray Enter should land on.
   */
  private armConfirm(): void {
    if (!this.selected) {
      return;
    }
    const definition = CLASS_DEFINITIONS[this.selected];
    this.selectView.hidden = true;
    this.confirmView.hidden = false;
    this.status.textContent = "";
    this.confirmText.textContent = `정말 ${definition.label}${objectParticle(definition.label)} 선택하시겠어요? 되돌릴 수 없습니다.`;
    this.confirmBack.focus();
  }

  private disarmConfirm(): void {
    this.confirmView.hidden = true;
    this.selectView.hidden = false;
    this.status.textContent = "";
    const card = this.cards.find((candidate) => candidate.dataset.classKey === this.selected);
    card?.focus();
  }

  private commit(): void {
    if (!this.selected || this.confirmYes.disabled) {
      return;
    }
    this.confirmYes.disabled = true;
    this.confirmBack.disabled = true;
    this.confirmYes.textContent = "선택하는 중…";
    this.status.textContent = "";
    this.onChoose(this.selected);
  }

  private readonly handleClose = (): void => {
    this.close();
  };

  private readonly handleChooseClick = (): void => {
    this.armConfirm();
  };

  private readonly handleConfirmBackClick = (): void => {
    this.disarmConfirm();
  };

  private readonly handleConfirmYesClick = (): void => {
    this.commit();
  };

  /** Left/Right and Up/Down rove the same one axis — four cards is not enough to need a real grid. */
  private readonly handleGridKey = (event: KeyboardEvent): void => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : undefined;
    if (step === undefined || this.cards.length === 0) {
      return;
    }
    event.preventDefault();
    const currentKey = this.selected ?? (this.cards[0]!.dataset.classKey as PlayerClassKey);
    const currentIndex = Math.max(
      0,
      this.cards.findIndex((card) => card.dataset.classKey === currentKey),
    );
    const next = this.cards[(currentIndex + step + this.cards.length) % this.cards.length]!;
    this.select(next.dataset.classKey as PlayerClassKey);
    next.focus();
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (!this.isOpen) {
      return;
    }
    if (event.key === "Escape") {
      // Escape in the chat composer clears the composer; that keystroke must not also close this
      // panel behind it — the same ordering trap ObjectPanel.handleKey documents.
      if (isTextEntry(event.target as Element | null)) {
        return;
      }
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "Tab") {
      this.trapTab(event);
    }
  };

  /** Keeps Tab cycling inside the dialog rather than escaping into the HUD/chat behind it. */
  private trapTab(event: KeyboardEvent): void {
    const focusable = Array.from(
      this.dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * The chat composer yields Enter to any focused button, so focus left on 닫기 or a card would
   * silently stop Enter from opening the composer.
   */
  private releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.root.contains(focused)) {
      focused.blur();
    }
  }
}
