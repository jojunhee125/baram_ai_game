import { isTextEntry } from "./textEntry";

/**
 * Answers a press for the slot at `index` (0-based). `false` means nothing was cast — no such
 * slot, a cooldown, or a world in no state to cast — {@link SwingAttempt}'s own contract.
 */
export type SlotAttempt = (index: number) => boolean;

/**
 * How many slots a hotkey can reach. Four is the number of digits reserved, not the number of
 * skills that exist (one per class today): a press past the end is simply refused by the bar.
 */
const SLOT_COUNT = 4;

/**
 * The number-row skill hotkeys.
 *
 * **Keydown only, never a hold** — the one place this deliberately parts from {@link AttackKey}.
 * That class repeats on a timer paced to `ATTACK_COOLDOWN_MS` (600ms) because holding Space is
 * how a player auto-attacks; skill cooldowns are 1.5–12s (`SKILL_DEFINITIONS`), so a held key
 * would buy nothing but a stream of `on-cooldown` denials and the message-rate pressure that goes
 * with them. `event.repeat` is refused for the same reason.
 *
 * Everything else is copied from `attackKey.ts` on purpose, because this project has already
 * shipped the same class of bug twice (`homeButton.ts:63` "typing ㅗ sends KeyH",
 * `inventoryPanel.ts:126` "typing ㅑ sends KeyI"): bind the physical `event.code` so the binding
 * survives the keyboard layout and the Hangul IME, leave modified presses to the browser and the
 * OS, and stand down entirely while a text field or an activatable control holds focus.
 *
 * Holds no reference to the room or the bar: it reports a slot press and the scene decides
 * whether the world is in a state to take one, the same division `AttackKey` uses.
 */
export class SkillKeys {
  constructor(private readonly onSlot: SlotAttempt) {
    window.addEventListener("keydown", this.handleKeyDown);
  }

  /** Mandatory before constructing a successor, which a room hop does: the listener is global. */
  destroy(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    // The browser's own key-repeat, which a cooldown measured in seconds has no use for.
    if (event.repeat) {
      return;
    }
    const index = slotIndexOf(event.code);
    if (index === null) {
      return;
    }
    // Ctrl/Cmd+digit switches browser tabs and Alt+digit belongs to the OS — never to us.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // Typing "1" in chat must not cast, and a focused control keeps its own keyboard handling.
    if (isTextEntry(document.activeElement)) {
      return;
    }
    // Only once the press is certainly ours: a digit has no default action worth suppressing on
    // the canvas, but preventing it unconditionally would eat the keystroke a panel wanted.
    event.preventDefault();
    this.onSlot(index);
  };
}

/** `Digit1`..`Digit4` → 0..3. Physical codes only: the numpad and the IME are both out. */
function slotIndexOf(code: string): number | null {
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    if (code === `Digit${index + 1}`) {
      return index;
    }
  }
  return null;
}
