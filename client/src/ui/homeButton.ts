import { HOME_COOLDOWN_MS } from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";

/** Physical codes: laptops fold `Home` into an Fn combination, so `KeyH` has to work too. */
const SHORTCUT_CODES: ReadonlySet<string> = new Set(["KeyH", "Home"]);

/**
 * Module-scope, not instance: a cross-room hop destroys and reconstructs `HomeButton`, and the
 * cooldown this mirrors is a per-account rule (the server's `HOME_COOLDOWN_MS`/`lastWarpAt`), not
 * a per-instance one — surviving the hop is the point, otherwise a fresh instance starts enabled
 * mid-cooldown.
 */
let cooldownUntil = 0;

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
    this.button.hidden = false;
    this.applyCooldown();
  }

  /** Locks the control for HOME_COOLDOWN_MS, mirroring the server's rate limit. */
  beginCooldown(): void {
    cooldownUntil = Date.now() + HOME_COOLDOWN_MS;
    this.applyCooldown();
  }

  /** Disables the button for whatever is left of the module's cooldown window, if any. */
  private applyCooldown(): void {
    const remainingMs = cooldownUntil - Date.now();
    window.clearTimeout(this.cooldownTimer);
    if (remainingMs <= 0) {
      this.button.disabled = false;
      return;
    }
    this.button.disabled = true;
    this.cooldownTimer = window.setTimeout(() => {
      this.button.disabled = false;
    }, remainingMs);
  }

  /**
   * Mandatory before constructing a successor, which a cross-room hop does. All three things
   * this holds outlive the scene restart: a `window` listener, a shared DOM node, and a pending
   * timer that would otherwise re-enable the live instance's button on the old room's schedule.
   *
   * Leaves the button hidden and disabled rather than restoring it enabled: the normal path is a
   * successor's constructor immediately overwriting both, so this only shows up if that
   * construction fails, where it keeps a stale button from looking live over the wrong room.
   */
  destroy(): void {
    this.button.removeEventListener("click", this.handleClick);
    window.removeEventListener("keydown", this.handleKey);
    window.clearTimeout(this.cooldownTimer);
    this.button.disabled = true;
    this.button.hidden = true;
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
