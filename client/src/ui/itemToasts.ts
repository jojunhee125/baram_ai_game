import type { CurrencyChanged, ItemGranted, ItemRemoved, ShopDenied } from "@zep-test/shared";
import { applyItemIcon } from "./inventoryPanel";

/**
 * Sentinel key for a currency reward's row in {@link ItemToasts.live} — a balance is not a bag
 * row, so it shares no `itemKey` with anything {@link ItemToasts.show} draws, and this is what
 * lets repeated rewards fold into one growing notice the same way a repeated item drop does.
 */
const CURRENCY_TOAST_KEY = "__currency__";

/**
 * Prefixed rather than sharing {@link ItemToasts.show}'s bare `itemKey`: a sale/use and a drop of
 * the exact same item can be live at once (selling herb while a squirrel drops another), and
 * folding them into one row would report the wrong sign on whichever arrived second.
 */
function removedToastKey(itemKey: string): string {
  return `removed:${itemKey}`;
}

/** design §9 D13 — one Korean line per {@link ShopDenialReason}, worded to say what to do next. */
const DENIAL_MESSAGES: Record<ShopDenied["reason"], string> = {
  "insufficient-balance": "잔액이 부족합니다. 사냥으로 화폐를 모아 보세요.",
  "bag-full": "가방이 가득 찼습니다. 정리한 뒤 다시 시도해 주세요.",
  "insufficient-item": "가진 수량보다 많이 요청했습니다.",
  "unknown-item": "존재하지 않는 아이템입니다.",
  "not-sold-here": "이 상점에서는 팔지 않는 물건입니다.",
  "not-sellable": "판매할 수 없는 아이템입니다.",
  "not-consumable": "사용할 수 없는 아이템입니다.",
};

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
   * A settled quest reward's own notice (roadmap R04-b) — same list, same repeats-fold-into-one-
   * row behaviour as {@link show}, keyed by {@link CURRENCY_TOAST_KEY} since a balance is not a bag
   * row. Reuses the `copper-coin` frame purely for its picture: the reward itself is currency,
   * never that item, which is why nothing here touches the bag's own copper-coin stack.
   *
   * Called only for `event.reason === "quest"` — the join-time `"sync"` message is not a reward
   * and announces nothing, `inventoryPanel.ts`'s own `applyCurrencyChange` being the one thing that
   * reads it.
   */
  showCurrency(event: CurrencyChanged): void {
    const existing = this.live.get(CURRENCY_TOAST_KEY);
    if (existing) {
      existing.gained += event.delta;
      existing.gain.textContent = `+${existing.gained}전`;
      existing.total.textContent = `${event.balance.toLocaleString("ko-KR")}전 보유`;
      this.reschedule(CURRENCY_TOAST_KEY, existing);
      return;
    }

    if (this.live.size >= MAX_TOASTS) {
      for (const oldest of this.live.keys()) {
        this.dismiss(oldest);
        break;
      }
    }

    const toast = this.buildCurrency(event);
    this.host.append(toast.node);
    this.live.set(CURRENCY_TOAST_KEY, toast);
    this.reschedule(CURRENCY_TOAST_KEY, toast);
  }

  /**
   * A sale or a consumable use shrank a stack (roadmap R04-c, design §9 D12) — {@link show}'s own
   * fold-repeats-into-one-row behaviour, keyed by {@link removedToastKey} instead of the bare
   * `itemKey` for that function's own reason. The sign is negative on purpose: this is a "you gave
   * something up" notice, not a pickup, so `toast__gain--negative` reads it apart from {@link show}
   * at a glance.
   */
  showRemoved(event: ItemRemoved): void {
    const key = removedToastKey(event.itemKey);
    const existing = this.live.get(key);
    if (existing) {
      existing.gained += event.quantity;
      existing.gain.textContent = `-${existing.gained}`;
      existing.total.textContent = `가방에 ${event.total}개`;
      this.reschedule(key, existing);
      return;
    }

    if (this.live.size >= MAX_TOASTS) {
      for (const oldest of this.live.keys()) {
        this.dismiss(oldest);
        break;
      }
    }

    const toast = this.buildRemoved(event);
    this.host.append(toast.node);
    this.live.set(key, toast);
    this.reschedule(key, toast);
  }

  /**
   * A `shop:buy`/`shop:sell`/`item:use` was refused (design §9 D13) — deliberately not folded into
   * {@link live} the way a grant or a removal is: a denial carries no running total to grow, each
   * one is its own complete sentence, and two different reasons arriving back to back (bag full,
   * then insufficient balance on the next attempt) must read as two lines, not one overwriting the
   * other. `DENIAL_MESSAGES` carries a distinct wording per `event.reason` so "잔액 부족" never reads
   * as "가방이 가득 찼습니다" — the requirement `ShopDenialReason`'s own doc comment states.
   */
  showDenied(event: ShopDenied): void {
    if (this.live.size >= MAX_TOASTS) {
      for (const oldest of this.live.keys()) {
        this.dismiss(oldest);
        break;
      }
    }
    const node = document.createElement("li");
    node.className = "toast toast--denied";
    const body = document.createElement("span");
    body.className = "toast__body";
    const name = document.createElement("span");
    name.className = "toast__name";
    name.textContent = DENIAL_MESSAGES[event.reason];
    body.append(name);
    node.append(body);
    this.host.append(node);
    // Not tracked in `live`: nothing here ever grows, so there is nothing for a repeat to fold into.
    this.later(() => {
      node.dataset.state = "leaving";
      this.later(() => node.remove(), TOAST_LEAVE_MS);
    }, TOAST_LIFETIME_MS);
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

  /** {@link build}'s own shape, against a currency reward instead of a bag row. */
  private buildCurrency(event: CurrencyChanged): LiveToast {
    const node = document.createElement("li");
    node.className = "toast";

    const icon = document.createElement("span");
    applyItemIcon(icon, "copper-coin");

    const body = document.createElement("span");
    body.className = "toast__body";

    const name = document.createElement("span");
    name.className = "toast__name";
    name.textContent = "보상";

    const total = document.createElement("span");
    total.className = "toast__total";
    total.textContent = `${event.balance.toLocaleString("ko-KR")}전 보유`;

    const gain = document.createElement("span");
    gain.className = "toast__gain";
    gain.textContent = `+${event.delta}전`;

    body.append(name, total);
    node.append(icon, body, gain);
    return { node, gain, total, gained: event.delta, timer: 0 };
  }

  /** {@link build}'s own shape, against a shrinking stack instead of a growing one. */
  private buildRemoved(event: ItemRemoved): LiveToast {
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
    gain.className = "toast__gain toast__gain--negative";
    gain.textContent = `-${event.quantity}`;

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
