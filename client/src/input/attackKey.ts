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
 * Holding Space is a hold, not one keydown: repeated swings come from a timer paced to the
 * server's own cooldown (`ATTACK_COOLDOWN_MS`), not from the browser's key-repeat rate, which
 * differs per OS and would drift out of step with what the server actually accepts.
 *
 * Holds no reference to the room: it reports a swing and the scene decides whether the world is
 * in a state to take one, the same division `HomeButton` uses.
 */
export class AttackKey {
  /** True from a qualifying keydown to the keyup (or blur, or a guard failing mid-hold) that ends it. */
  private holding = false;
  /** The repeat timer for the current hold; undefined whenever `holding` is false. */
  private timer: number | undefined;

  constructor(private readonly onSwing: SwingAttempt) {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    // Alt-tabbing away never fires keyup for the key that was down when focus left, which would
    // otherwise leave the interval swinging into a tab nobody is playing.
    window.addEventListener("blur", this.stop);
  }

  /** Mandatory before constructing a successor, which a room hop does: the listener is global. */
  destroy(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.stop);
    this.stop();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "Space") {
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
    // Every one of the browser's own repeat keydowns needs its own preventDefault, or the page
    // scrolls the moment key-repeat kicks in — the repeat rate itself is no longer ours to use
    // (below), but suppressing its default action still is.
    event.preventDefault();

    if (this.holding) {
      return;
    }
    this.holding = true;
    this.attempt();
    // The server's cooldown, not the keyboard's repeat rate: that rate is the OS's, differs
    // per machine, and would drift out of step with what the server actually accepts.
    this.timer = window.setInterval(this.attempt, ATTACK_COOLDOWN_MS);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") {
      this.stop();
    }
  };

  /** One tick of a hold: re-checked against the same guards a fresh press would face. */
  private readonly attempt = (): void => {
    if (isTextEntry(document.activeElement) || answersSpace(document.activeElement)) {
      this.stop();
      return;
    }
    this.onSwing();
  };

  private readonly stop = (): void => {
    this.holding = false;
    window.clearInterval(this.timer);
    this.timer = undefined;
  };
}

/**
 * Whether the focused element already treats Space as its own activation. Buttons and links are
 * the whole set on this page; text fields are {@link isTextEntry}'s half of the same question.
 */
function answersSpace(node: Element | null): boolean {
  return node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement;
}
