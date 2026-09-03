import type { ItemGranted } from "@zep-test/shared";
import { applyItemIcon } from "./inventoryPanel";

/** Long enough to read a name and an amount, short enough not to stack up during a kill streak. */
const TOAST_LIFETIME_MS = 3200;
/** Matches the leave transition in style.css; the node is removed once it has finished fading. */
const TOAST_LEAVE_MS = 180;
/**
 * How many notices are on screen at once. Past this the corner is a wall of text rather than a
 * signal, and a hunting ground drops something on most kills.
 */
const MAX_TOASTS = 4;

interface LiveToast {
  node: HTMLElement;
  gain: HTMLElement;
  total: HTMLElement;
  /** Summed across repeats, so five squirrels in a row read "+5" rather than five separate "+1"s. */
  gained: number;
  timer: number;
}

/**
 * Short-lived "you picked something up" notices.
 *
 * Repeats fold into the live notice for that item instead of stacking: a hunting ground grants the
 * same jelly over and over, and one row whose amount climbs is both quieter and more informative
 * than five rows saying the same thing. `ItemGranted.total` is drawn beside it, which is the
 * number the bag would show — so a player who never opens the bag still knows what they have.
 *
 * Owns shared DOM and a timer per notice, so `destroy()` is mandatory before a successor is built.
 */
export class ItemToasts {
  private readonly host = document.querySelector<HTMLElement>("#item-toasts")!;
  /** Keyed by `itemKey`, in insertion order, so the oldest is the first entry. */
  private readonly live = new Map<string, LiveToast>();
  private readonly timers = new Set<number>();

  show(event: ItemGranted): void {
    const existing = this.live.get(event.itemKey);
    if (existing) {
      existing.gained += event.quantity;
      existing.gain.textContent = `+${existing.gained}`;
      existing.total.textContent = `가방에 ${event.total}개`;
      this.reschedule(event.itemKey, existing);
      return;
    }

    if (this.live.size >= MAX_TOASTS) {
      // Map iteration is insertion order, so this is the notice that has been up longest.
      for (const oldest of this.live.keys()) {
        this.dismiss(oldest);
        break;
      }
    }

    const toast = this.build(event);
    this.host.append(toast.node);
    this.live.set(event.itemKey, toast);
    this.reschedule(event.itemKey, toast);
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. Every timer here outlives
   * the scene restart and the host node is shared, so an abandoned instance would tear notices
   * out from under the room the player is now standing in.
   */
  destroy(): void {
    for (const timer of this.timers) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
    this.live.clear();
    this.host.replaceChildren();
  }

  private build(event: ItemGranted): LiveToast {
    const node = document.createElement("li");
    node.className = "toast";

    const icon = document.createElement("span");
    applyItemIcon(icon, event.icon);

    const body = document.createElement("span");
    body.className = "toast__body";

    const name = document.createElement("span");
    name.className = "toast__name";
    name.textContent = event.name;

    const total = document.createElement("span");
    total.className = "toast__total";
    total.textContent = `가방에 ${event.total}개`;

    const gain = document.createElement("span");
    gain.className = "toast__gain";
    gain.textContent = `+${event.quantity}`;

    body.append(name, total);
    node.append(icon, body, gain);
    return { node, gain, total, gained: event.quantity, timer: 0 };
  }

  private reschedule(itemKey: string, toast: LiveToast): void {
    this.clearTimer(toast.timer);
    toast.timer = this.later(() => this.dismiss(itemKey), TOAST_LIFETIME_MS);
  }

  private dismiss(itemKey: string): void {
    const toast = this.live.get(itemKey);
    if (!toast) {
      return;
    }
    this.clearTimer(toast.timer);
    this.live.delete(itemKey);
    toast.node.dataset.state = "leaving";
    this.later(() => toast.node.remove(), TOAST_LEAVE_MS);
  }

  private later(run: () => void, delayMs: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, delayMs);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: number): void {
    window.clearTimeout(timer);
    this.timers.delete(timer);
  }
}
