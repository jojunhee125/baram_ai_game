import { ATTACK_COOLDOWN_MS } from "@zep-test/shared";
import { isTextEntry } from "./textEntry";

/**
 * Answers a press. `false` means the world was in no state to swing — a panel, a room hop — and
 * the cooldown is then not started, so closing that panel does not also cost the next swing.
 */
export type SwingAttempt = () => boolean;

/**
 * The Space swing.
 *
 * Space is the loudest key on the board — it scrolls the page, it re-activates whatever button
 * still holds focus, and it is the single most common keystroke while composing Hangul — so this
 * listener is mostly guards. Two of them exist because this project has already shipped the bug
 * twice: `homeButton.ts:63` ("typing ㅗ sends KeyH") and `inventoryPanel.ts:126` ("typing ㅑ sends
 * KeyI"). A physical `event.code` is still the right binding (it survives the layout and the IME);
 * what it costs is that the guards have to be written out every time.
 *
 * Holds no reference to the room: it reports a swing and the scene decides whether the world is
 * in a state to take one, the same division `HomeButton` uses.
 */
export class AttackKey {
  private lastSwingAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly onSwing: SwingAttempt) {
    window.addEventListener("keydown", this.handleKey);
  }

  /** Mandatory before constructing a successor, which a room hop does: the listener is global. */
  destroy(): void {
    window.removeEventListener("keydown", this.handleKey);
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    // `repeat` so that holding Space is one swing rather than the keyboard's auto-repeat rate
    // turned into a stream of attacks.
    if (event.code !== "Space" || event.repeat) {
      return;
    }
    // Ctrl/Cmd/Alt + Space belongs to the browser or the OS input switcher, never to us.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // Typing a space in chat must not swing, and a focused button must still answer Space itself:
    // taking it away would leave every HUD control keyboard-activatable by Enter only.
    if (isTextEntry(document.activeElement) || answersSpace(document.activeElement)) {
      return;
    }
    // Space scrolls the page and re-clicks the focused control. Called before the cooldown gate,
    // because the key is ours for the whole window whether or not this press produces a swing.
    event.preventDefault();

    const now = performance.now();
    if (now - this.lastSwingAt < ATTACK_COOLDOWN_MS) {
      return;
    }
    if (this.onSwing()) {
      this.lastSwingAt = now;
    }
  };
}

/**
 * Whether the focused element already treats Space as its own activation. Buttons and links are
 * the whole set on this page; text fields are {@link isTextEntry}'s half of the same question.
 */
function answersSpace(node: Element | null): boolean {
  return node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement;
}
