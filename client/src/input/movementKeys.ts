import { Direction } from "@zep-test/shared";

/** Physical key codes, so the mapping survives keyboard layout and IME changes. */
const KEY_DIRECTIONS: Readonly<Record<string, Direction>> = {
  ArrowUp: Direction.Up,
  ArrowDown: Direction.Down,
  ArrowLeft: Direction.Left,
  ArrowRight: Direction.Right,
  KeyW: Direction.Up,
  KeyS: Direction.Down,
  KeyA: Direction.Left,
  KeyD: Direction.Right,
};

function isTextEntry(node: Element | null): boolean {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLElement && node.isContentEditable)
  );
}

/**
 * Tracks which movement key is currently held. Held directions form a stack so the
 * most recent press wins while several are down, which is what grid movement expects.
 */
export class MovementKeys {
  private readonly held: Direction[] = [];

  constructor() {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    // A key held while the window or canvas loses focus never delivers its keyup.
    window.addEventListener("blur", this.clear);
    document.addEventListener("focusin", this.handleFocusIn);
  }

  /** Null when nothing is held, or while the player is typing. */
  get active(): Direction | null {
    return this.held.at(-1) ?? null;
  }

  /** Mandatory before constructing a successor (a portal hop does): the listeners are global. */
  destroy(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.clear);
    document.removeEventListener("focusin", this.handleFocusIn);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const direction = KEY_DIRECTIONS[event.code];
    if (direction === undefined || isTextEntry(document.activeElement)) {
      return;
    }
    // Arrow keys scroll the page; the canvas owns them while walking.
    event.preventDefault();
    if (!this.held.includes(direction)) {
      this.held.push(direction);
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    const direction = KEY_DIRECTIONS[event.code];
    if (direction === undefined) {
      return;
    }
    const at = this.held.indexOf(direction);
    if (at !== -1) {
      this.held.splice(at, 1);
    }
  };

  private readonly handleFocusIn = (event: FocusEvent): void => {
    // Focusing the chat box mid-walk must not leave the avatar walking forever.
    if (isTextEntry(event.target as Element | null)) {
      this.clear();
    }
  };

  private readonly clear = (): void => {
    this.held.length = 0;
  };
}
