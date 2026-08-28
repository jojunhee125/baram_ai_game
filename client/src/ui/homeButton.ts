import { HOME_COOLDOWN_MS } from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";

/** Physical codes: laptops fold `Home` into an Fn combination, so `KeyH` has to work too. */
const SHORTCUT_CODES: ReadonlySet<string> = new Set(["KeyH", "Home"]);

/**
 * The "return home" control and its H / Home shortcut.
 *
 * The disabled window after an activation is the only success feedback there is — arriving at
 * home is something the screen already shows. It mirrors the server's HOME_COOLDOWN_MS guard;
 * the guard is what protects the room, this is what stops the button feeling broken.
 */
export class HomeButton {
  private readonly button = document.querySelector<HTMLButtonElement>("#home-button")!;
  private cooldownTimer: number | undefined;

  constructor(private readonly onActivate: () => void) {
    this.button.addEventListener("click", this.handleClick);
    window.addEventListener("keydown", this.handleKey);
    this.button.disabled = false;
    this.button.hidden = false;
  }

  /** Locks the control for HOME_COOLDOWN_MS, mirroring the server's rate limit. */
  beginCooldown(): void {
    this.button.disabled = true;
    window.clearTimeout(this.cooldownTimer);
    this.cooldownTimer = window.setTimeout(() => {
      this.button.disabled = false;
    }, HOME_COOLDOWN_MS);
  }

  /**
   * Mandatory before constructing a successor, which a cross-room hop does. All three things
   * this holds outlive the scene restart: a `window` listener, a shared DOM node, and a pending
   * timer that would otherwise re-enable the live instance's button on the old room's schedule.
   */
  destroy(): void {
    this.button.removeEventListener("click", this.handleClick);
    window.removeEventListener("keydown", this.handleKey);
    window.clearTimeout(this.cooldownTimer);
  }

  private readonly handleClick = (event: MouseEvent): void => {
    // A pointer click leaves focus on the button, and the chat composer yields Enter to focused
    // buttons — keeping it would silently stop Enter from opening the composer, and Space would
    // warp again. `detail === 0` is a keyboard activation, where focus is the user's position.
    if (event.detail > 0) {
      this.button.blur();
    }
    this.onActivate();
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (!SHORTCUT_CODES.has(event.code) || event.repeat) {
      return;
    }
    // Ctrl+H is browser history and Cmd+H hides the app; a modified combination is never ours.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // Typing "ㅗ" in chat sends `KeyH`, which is how "I typed a message and teleported" happens.
    if (isTextEntry(document.activeElement) || this.button.disabled) {
      return;
    }
    event.preventDefault();
    this.onActivate();
  };
}
