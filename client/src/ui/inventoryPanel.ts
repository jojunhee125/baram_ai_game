import {
  CLASS_DEFINITIONS,
  EQUIPMENT_SLOTS,
  EquipmentSlot,
  type CurrencyChanged,
  type EquipmentChanged,
  type ItemGranted,
  type ItemRemoved,
  type ShopDenied,
  type PlayerClassKey,
} from "@zep-test/shared";
import { loadInventory, readEquipmentMetadata, type InventoryItem } from "../net/inventory";
import { isTextEntry } from "../input/textEntry";
import { describeEquipmentComparison } from "./equipmentComparison";

/**
 * Column order of `assets/sprites/items.png`, and therefore the set of `ItemDefinition.icon`
 * values this bundle can draw. Reordering it repaints every bag with the wrong pictures, so
 * tools/generate-monster-art.mjs reads this array and refuses to bake the sheet if its own table
 * disagrees — the same guard MONSTER_SPRITE_ORDER carries.
 */
export const ITEM_ICON_ORDER = [
  "acorn",
  "carrot",
  "copper-coin",
  "herb",
  "old-dagger",
  "entry-pass",
  "leather-armor",
  "golden-helmet",
] as const;

/** One frame of items.png at 1x. The HUD column is CSS-sized, so this is CSS pixels. */
const ICON_SIZE_PX = 32;

/**
 * The concrete slot each equippable item occupies — a client mirror of `ItemDefinition.equipment.slot`
 * (design-phase-v-equipment-system.md §6.2), for the three items the catalogue actually equips today.
 * `GET /api/inventory` sends only `equipped: boolean`, not which slot, so this table is what resolves
 * a bag row to the slot its own 장착 button targets. A ring item would need to resolve to ring1 or
 * ring2 rather than one fixed slot (§1.3) — moot today, since this table has no "ring" entry to
 * resolve from.
 *
 * A row missing here is not a drawing bug but a dead item: {@link InventoryPanel.buildRow} hands out
 * no 장착 button without a slot, so the item can be carried and never worn. `items.test.ts` reads this
 * table out of this file and fails if any `ITEM_DEFINITIONS` row with `equipment` is absent from it.
 */
const EQUIPMENT_ITEM_SLOTS: Partial<Record<string, EquipmentSlot>> = {
  "leather-armor": EquipmentSlot.Armor,
  "old-dagger": EquipmentSlot.Weapon,
  "hunting-blade": EquipmentSlot.Weapon,
  "iron-blade": EquipmentSlot.Weapon,
  "padded-armor": EquipmentSlot.Armor,
  "reinforced-armor": EquipmentSlot.Armor,
  "golden-helmet": EquipmentSlot.Helmet,
  "forest-cloak": EquipmentSlot.Cloak,
  "veteran-blade": EquipmentSlot.Weapon,
  "mystic-cloak": EquipmentSlot.Cloak,
};

function itemSlot(item: InventoryItem): EquipmentSlot | undefined {
  return item.equipment?.slot === "ring" ? undefined : item.equipment?.slot ?? EQUIPMENT_ITEM_SLOTS[item.itemKey];
}

type InventoryChange =
  | { kind: "grant"; event: ItemGranted }
  | { kind: "remove"; event: ItemRemoved }
  | { kind: "equipment"; event: EquipmentChanged };

const MAX_PENDING_CHANGES = 128;

/**
 * Paints one column of `items.png` onto `node`, or leaves a visibly empty slot for an icon key
 * this bundle has no column for — the server can hold a catalogue newer than the browser (the
 * reason `icon` travels with the row at all), and an empty slot beside a real name beats a blank
 * line or, worse, some other item's picture.
 *
 * Exported so the drop toast draws its icon by the same table and the same fallback. A second
 * key-to-column mapping is exactly how the two windows would come to disagree.
 */
export function applyItemIcon(node: HTMLElement, icon: string): void {
  const frame = (ITEM_ICON_ORDER as readonly string[]).indexOf(icon);
  if (frame === -1) {
    node.className = "bag__icon bag__icon--unknown";
    return;
  }
  node.className = "bag__icon";
  // Sized here rather than in `.bag__icon`, where it was a literal `224px` that a Phase adding an
  // eighth column had no reason to look at — the whole sheet then scaled to 224/256 and every icon
  // drew a sliver of its neighbour. Derived from the array, it cannot fall behind the sheet again.
  node.style.backgroundSize = `${ITEM_ICON_ORDER.length * ICON_SIZE_PX}px ${ICON_SIZE_PX}px`;
  node.style.backgroundPosition = `-${frame * ICON_SIZE_PX}px 0`;
}

/** Which of the four mutually exclusive contents the window is currently drawing. */
type PanelView = "loading" | "items" | "empty" | "error";

/**
 * Open state lives on the module, not the instance, for the same reason the minimap's does: a
 * portal hop restarts the scene and builds a new panel, and a bag you opened should not close
 * itself because you walked through a door.
 */
let panelOpen = false;

/**
 * The bag window and its I shortcut.
 *
 * **This window does not stop the player moving.** The fixed-object panel does, deliberately
 * (`docs/design-fixed-objects.md` §9.5: reading holds you still), but a hunting ground is exactly
 * where checking your bag must not pin you in place while something is chewing on you — the
 * decision and its reasoning are in `docs/design-hunting-inventory.md` §3.4. So it lives in the
 * HUD column beside the minimap rather than behind a scrim, and `WorldScene.update()` never
 * consults it.
 *
 * The contents are read over HTTP on every open, because a bag is account data rather than room
 * state: putting it on the room would mean a database query inside the message path that has to
 * carry 500 CCU.
 */
export class InventoryPanel {
  private readonly panel = document.querySelector<HTMLElement>("#inventory")!;
  private readonly button = document.querySelector<HTMLButtonElement>("#inventory-button")!;
  private readonly closeButton = document.querySelector<HTMLButtonElement>("#inventory-close")!;
  private readonly retryButton = document.querySelector<HTMLButtonElement>("#inventory-retry")!;
  private readonly currencyBalance = document.querySelector<HTMLElement>("#inventory-currency")!;
  private readonly list = document.querySelector<HTMLElement>("#inventory-list")!;
  private readonly status = document.querySelector<HTMLElement>("#inventory-status")!;
  private readonly statusIcon = document.querySelector<HTMLElement>("#inventory-status-icon")!;
  private readonly statusText = document.querySelector<HTMLElement>("#inventory-status-text")!;
  private readonly statusHint = document.querySelector<HTMLElement>("#inventory-status-hint")!;
  private readonly slots = document.querySelector<HTMLElement>("#inventory-slots")!;
  /** Every slot row, keyed by its `data-slot`. Populated once in the constructor — the markup is
   * static HTML, never rebuilt, unlike the bag rows below it. */
  private readonly slotNodes = new Map<EquipmentSlot, HTMLElement>();
  /**
   * The slot rows' own 해제 buttons are as persistent as {@link button}/{@link closeButton} — a
   * room hop's successor instance must remove its own listeners in {@link destroy}, or the shared
   * static button fires every past instance's stale callback on one click.
   */
  private readonly slotUnequipHandlers = new Map<HTMLButtonElement, (event: MouseEvent) => void>();
  /**
   * Which read the DOM is allowed to belong to. Every reply checks it before drawing, so a slow
   * response cannot land in a bag that has since been closed, reopened, or handed to the successor
   * a room hop built — all three share these nodes.
   */
  private request = 0;
  /** Which block is on screen, so a live grant knows whether there is a list to patch. */
  private view: PanelView = "loading";
  private readonly items = new Map<string, InventoryItem>();
  private readonly observedSlots = new Map<string, EquipmentSlot>();
  private readonly unknownSlots = new Set<EquipmentSlot>();
  private readonly pendingChanges: InventoryChange[] = [];
  private pendingChangesOverflowed = false;
  private replayingChanges = false;
  private resolvingUnknownEquipment = false;
  private destroyed = false;
  /**
   * In-flight sale/use nonces by item key (design §9 D8) — `objectPanel.ts`'s own `pendingBuys`
   * shape, split into two maps rather than one keyed by `"sell:key"`/`"use:key"` because an item can
   * be sellable and consumable at once and each action gets its own independent attempt. Kept on the
   * instance rather than cleared by a refresh, for the same reason `pendingBuys` survives a reopen:
   * a rebuilt row must redraw already mid-attempt rather than losing track of it (see {@link
   * buildRow}).
   */
  private readonly pendingSell = new Map<string, string>();
  private readonly pendingUse = new Map<string, string>();
  private level = 1;
  private classKey: PlayerClassKey | null = null;

  setEligibility(level: number, classKey: PlayerClassKey | null): void {
    this.level = level;
    this.classKey = classKey;
    this.renderComparisons();
    for (const item of this.items.values()) {
      const row = this.findRow(item.itemKey);
      if (row) this.applyEquipEligibility(row, item);
    }
  }

  private requirementOf(item: InventoryItem): { label: string; eligible: boolean } | null {
    const requirement = item.equipment?.requirement;
    if (!requirement) return null;
    const parts: string[] = [];
    if (requirement.minLevel !== undefined) parts.push(`Lv.${requirement.minLevel} 이상`);
    if (requirement.classes?.length) {
      parts.push(requirement.classes.map((key) => CLASS_DEFINITIONS[key].label).join(" / "));
    }
    if (!parts.length) return null;
    return { label: `착용 조건: ${parts.join(" · ")}`,
      eligible: (requirement.minLevel === undefined || this.level >= requirement.minLevel) &&
        (!requirement.classes?.length || this.classKey !== null && requirement.classes.includes(this.classKey)) };
  }

  private applyEquipEligibility(row: HTMLElement, item: InventoryItem): void {
    const button = row.querySelector<HTMLButtonElement>(".bag__equip");
    if (!button) return;
    const requirement = this.requirementOf(item);
    button.disabled = !item.equipped && requirement !== null && !requirement.eligible;
    button.title = button.disabled ? requirement!.label : "";
  }

  constructor(
    private readonly onEquipItem: (itemKey: string, slot: EquipmentSlot) => void,
    private readonly onUnequipItem: (slot: EquipmentSlot) => void,
    /** design §9 D8 — nonce is minted by {@link attemptSell}, never here. */
    private readonly onSellItem: (itemKey: string, quantity: number, nonce: string) => void,
    /** design §9 D8 — nonce is minted by {@link attemptUse}, never here. */
    private readonly onUseItem: (itemKey: string, nonce: string) => void,
  ) {
    this.button.addEventListener("click", this.handleToggleClick);
    this.closeButton.addEventListener("click", this.handleCloseClick);
    this.retryButton.addEventListener("click", this.handleRetryClick);
    window.addEventListener("keydown", this.handleKey);
    this.bindSlots();
    this.button.hidden = false;
    this.applyOpenState();
  }

  /**
   * Read off the module flag, which is the part shared between instances.
   *
   * Used to gate `WorldScene.swing()`'s Attack input while the bag was up; that gate is gone
   * (2026-09-03, §3.4) — attack is always available regardless of what is open. Nothing currently
   * reads this, but it stays as the panel's open/closed accessor.
   */
  get isOpen(): boolean {
    return panelOpen;
  }

  invalidate(): void {
    if (panelOpen && !this.destroyed) this.refresh();
  }

  /**
   * Folds one drop into an open bag, so a pickup shows up without a second `GET /api/inventory`.
   * `ItemGranted.total` is the amount held afterwards, which is exactly what a row displays.
   *
   * Events arriving during a read are replayed in arrival order after the snapshot. The bounded
   * queue requests a fresh snapshot on overflow instead of showing a partially replayed bag.
   */
  applyGrant(event: ItemGranted): void {
    if (this.deferChange({ kind: "grant", event })) {
      return;
    }
    const previous = this.items.get(event.itemKey);
    const item: InventoryItem = {
      itemKey: event.itemKey,
      name: event.name,
      icon: event.icon,
      quantity: event.total,
      equipped: previous?.equipped ?? false,
      damageReductionRatio: event.damageReductionRatio,
      equipment: readEquipmentMetadata(event.equipment) ?? previous?.equipment,
      sellValue: event.sellValue,
      consumable: event.consumable,
    };
    this.items.set(event.itemKey, item);
    const count = this.findCount(event.itemKey);
    if (count) {
      count.textContent = String(event.total);
      this.ensureEquipAction(this.findRow(item.itemKey)!, item);
      this.renderComparisons();
      return;
    }
    this.list.append(this.buildRow(item));
    this.list.hidden = false;
    this.status.hidden = true;
    this.view = "items";
    this.renderComparisons();
  }

  /**
   * Folds one equip/unequip verdict into an open bag. Dropped under the same conditions as
   * {@link applyGrant} — a reopen re-reads and picks up the true state either way — and also
   * when `applied` is false, since a denied request changed nothing for this row to reflect.
   *
   * Only the bag row(s) targeting `event.slot` are touched — each of the eight slots settles
   * independently now (design §4.2), so an armor equip must not flip a weapon row's label.
   */
  applyEquipmentChange(event: EquipmentChanged): void {
    if (!event.applied || this.deferChange({ kind: "equipment", event })) {
      return;
    }
    if (event.itemKey !== null) this.observedSlots.set(event.itemKey, event.slot);
    for (const item of this.items.values()) {
      if (this.resolveSlot(item) === event.slot) item.equipped = item.itemKey === event.itemKey;
    }
    if (event.itemKey !== null && !this.items.has(event.itemKey)) {
      this.unknownSlots.add(event.slot);
    } else {
      this.unknownSlots.delete(event.slot);
    }
    for (const row of this.list.children) {
      if (!(row instanceof HTMLElement) || row.dataset.slot !== event.slot) {
        continue;
      }
      const equip = row.querySelector<HTMLButtonElement>(".bag__equip");
      if (!equip) {
        continue;
      }
      const equipped = row.dataset.itemKey === event.itemKey;
      row.dataset.equipped = String(equipped);
      equip.textContent = equipped ? "해제" : "장착";
    }
    this.applySlot(event.slot, this.unknownSlots.has(event.slot)
      ? { name: "장비 정보 확인 필요", icon: "" }
      : this.resolveEquippedItem(event.itemKey));
    this.renderComparisons();
    if (this.unknownSlots.has(event.slot) && !this.replayingChanges && !this.resolvingUnknownEquipment) {
      this.resolvingUnknownEquipment = true;
      this.refresh();
    }
  }

  /**
   * Patches the balance shown in the bag header (roadmap R04-b) — every `CurrencyChanged`, the
   * join-time sync and a settled quest reward alike, and whether or not the bag is currently open:
   * unlike {@link applyGrant} this is a persistent label, not a row in a list that only exists
   * while the panel shows its "items" view, and it needs no reopen to read correctly. Carried as-is
   * across a room hop rather than reset — the balance is the account's, not the room's, so the
   * number from the room just left is still the right number until this fires again.
   */
  applyCurrencyChange(event: CurrencyChanged): void {
    if (this.destroyed) return;
    this.currencyBalance.textContent = `${event.balance.toLocaleString("ko-KR")}전`;
  }

  /**
   * Folds a sale or a consumable use into an open bag (roadmap R04-c, design §9 D12) — {@link
   * applyGrant}'s own shape run in reverse: `total === 0` drops the row instead of leaving a "0"
   * count on screen, since a stack that hit zero is gone from the bag entirely. Also resolves
   * whichever of {@link pendingSell}/{@link pendingUse} this reply answers, by `event.reason`,
   * which is exact here — unlike a buy, a sale or a use always carries its own cause.
   *
   * Dropped under {@link applyGrant}'s own conditions when the window has nothing to patch; the
   * pending map is still cleared regardless; so is a reopen the other way to resync it.
   */
  applyItemRemoved(event: ItemRemoved): void {
    if (this.destroyed) return;
    this.resolvePending(event.reason === "consume" ? this.pendingUse : this.pendingSell, event.itemKey);
    if (this.deferChange({ kind: "remove", event })) {
      return;
    }
    const row = this.findRow(event.itemKey);
    if (!row) {
      return;
    }
    if (event.total <= 0) {
      this.items.delete(event.itemKey);
      row.remove();
      this.renderSlots([...this.items.values()]);
      this.renderComparisons();
      if (this.list.children.length === 0) {
        this.showItems([]);
      }
      return;
    }
    const item = this.items.get(event.itemKey);
    if (item) item.quantity = event.total;
    const count = row.querySelector<HTMLElement>(".bag__count");
    if (count) {
      count.textContent = String(event.total);
    }
  }

  private deferChange(change: InventoryChange): boolean {
    if (this.destroyed || !panelOpen || this.view === "error") return true;
    if (this.view !== "loading") return false;
    if (this.pendingChanges.length < MAX_PENDING_CHANGES) this.pendingChanges.push(change);
    else this.pendingChangesOverflowed = true;
    return true;
  }

  private replayChanges(): void {
    const changes = this.pendingChanges.splice(0);
    this.replayingChanges = true;
    for (const change of changes) {
      if (change.kind === "grant") this.applyGrant(change.event);
      else if (change.kind === "remove") this.applyItemRemoved(change.event);
      else this.applyEquipmentChange(change.event);
    }
    this.replayingChanges = false;
    if (this.unknownSlots.size > 0 && !this.resolvingUnknownEquipment) {
      this.resolvingUnknownEquipment = true;
      this.refresh();
    }
  }

  /**
   * A `shop:sell`/`item:use` this panel sent was refused (design §9 D12/D13) — `objectPanel.ts`'s
   * own `resolveShopAttempt` reset, against the two actions this panel owns instead of `"buy"`.
   * Unlike a buy's `ItemGranted` gap, this has nothing to guess at: `ShopDenied.action` says exactly
   * which pending map answers it.
   */
  applyShopDenied(event: ShopDenied): void {
    if (this.destroyed) return;
    if (event.action === "sell") {
      this.resolvePending(this.pendingSell, event.itemKey);
    } else if (event.action === "use") {
      this.resolvePending(this.pendingUse, event.itemKey);
    }
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would toggle `panelOpen` back
   * on every press — the key would look dead — and an in-flight read would repaint the live
   * panel with the departed room's request.
   */
  destroy(): void {
    this.destroyed = true;
    this.pendingChanges.length = 0;
    this.button.removeEventListener("click", this.handleToggleClick);
    this.closeButton.removeEventListener("click", this.handleCloseClick);
    this.retryButton.removeEventListener("click", this.handleRetryClick);
    window.removeEventListener("keydown", this.handleKey);
    for (const [button, handler] of this.slotUnequipHandlers) {
      button.removeEventListener("click", handler);
    }
    this.request += 1;
  }

  /** Wires each of the eight static slot rows once — see {@link slotNodes}'s own comment. */
  private bindSlots(): void {
    for (const slot of EQUIPMENT_SLOTS) {
      const node = this.slots.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      if (!node) {
        continue;
      }
      this.slotNodes.set(slot, node);
      const unequip = node.querySelector<HTMLButtonElement>(".bag__equip");
      if (!unequip) {
        continue;
      }
      const handleClick = (event: MouseEvent): void => {
        this.onUnequipItem(slot);
        if (event.detail > 0) {
          unequip.blur();
        }
      };
      unequip.addEventListener("click", handleClick);
      this.slotUnequipHandlers.set(unequip, handleClick);
    }
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
    // Keyboard activation hands focus back to the control that opened this; without it the ring
    // falls into <body> and the next Tab restarts from the top of the page.
    if (event.detail === 0) {
      this.button.focus();
    }
  };

  private readonly handleRetryClick = (event: MouseEvent): void => {
    this.refresh();
    if (event.detail > 0) {
      this.retryButton.blur();
    }
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.handleEscape(event);
      return;
    }
    // Physical code, so the binding survives the layout and the IME. That is also what makes the
    // next guard necessary: typing "ㅑ" in chat sends `KeyI` exactly as walking does, which is how
    // "I typed a message and the bag opened" happens (the same defect homeButton.ts:63 records).
    if (event.code !== "KeyI" || event.repeat) {
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
    // Escape in the chat composer clears the composer; that keystroke must not also close the bag
    // behind it. The composer blurs itself in the target phase, before this bubble-phase listener
    // runs, so only `event.target` still names the field the keystroke came from — the same
    // ordering trap ObjectPanel.handleKey documents.
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
      this.panel.hidden = true;
      // Dropped rather than left on screen: the next open re-reads anyway, and a stale bag
      // flashing before the new one arrives reads as an item vanishing.
      this.list.replaceChildren();
      this.items.clear();
      this.observedSlots.clear();
      this.pendingChanges.length = 0;
      this.pendingChangesOverflowed = false;
      this.unknownSlots.clear();
      this.resolvingUnknownEquipment = false;
      this.request += 1;
      return;
    }
    this.panel.hidden = false;
    this.refresh();
  }

  private refresh(): void {
    this.request += 1;
    const request = this.request;
    this.showLoading();
    void loadInventory().then(
      (items) => {
        if (request === this.request) {
          if (this.pendingChangesOverflowed) {
            this.pendingChangesOverflowed = false;
            this.pendingChanges.length = 0;
            this.refresh();
            return;
          }
          this.unknownSlots.clear();
          this.showItems(items);
          this.replayChanges();
          if (this.unknownSlots.size === 0) this.resolvingUnknownEquipment = false;
        }
      },
      (error: unknown) => {
        if (request !== this.request) {
          return;
        }
        console.warn("could not read the bag", error);
        this.showError();
      },
    );
  }

  private showLoading(): void {
    this.view = "loading";
    this.list.replaceChildren();
    this.list.hidden = true;
    this.list.setAttribute("aria-busy", "true");
    this.statusIcon.hidden = true;
    this.statusText.textContent = "가방을 여는 중…";
    this.statusHint.textContent = "";
    this.retryButton.hidden = true;
    this.status.hidden = false;
  }

  private showItems(items: readonly InventoryItem[]): void {
    this.items.clear();
    for (const item of items) this.items.set(item.itemKey, { ...item });
    this.list.setAttribute("aria-busy", "false");
    this.renderSlots(items);
    if (items.length === 0) {
      this.view = "empty";
      this.list.replaceChildren();
      this.list.hidden = true;
      this.statusIcon.hidden = false;
      this.statusText.textContent = "가방이 비어 있습니다.";
      this.statusHint.textContent = "사냥터에서 얻은 물건이 여기에 쌓입니다.";
      this.retryButton.textContent = "새로 고침";
      this.retryButton.hidden = false;
      this.status.hidden = false;
      return;
    }
    this.view = "items";
    this.list.replaceChildren(...items.map((item) => this.buildRow(item)));
    this.list.hidden = false;
    this.status.hidden = true;
    this.renderComparisons();
  }

  private showError(): void {
    this.view = "error";
    this.pendingChanges.length = 0;
    this.pendingChangesOverflowed = false;
    this.list.replaceChildren();
    this.list.hidden = true;
    this.list.setAttribute("aria-busy", "false");
    this.statusIcon.hidden = true;
    this.statusText.textContent = "가방을 읽지 못했습니다.";
    this.statusHint.textContent = "잠시 후 다시 시도해 주세요.";
    this.retryButton.textContent = "다시 시도";
    this.retryButton.hidden = false;
    this.status.hidden = false;
  }

  /**
   * One pass over `items`, sorting each equipped row into the slot its `itemKey` maps to
   * (`EQUIPMENT_ITEM_SLOTS`) and rendering all eight rows from that — including the five that
   * never get a hit this Phase, which render as the same empty state {@link applySlot} always
   * falls back to.
   */
  private renderSlots(items: readonly InventoryItem[]): void {
    const equippedBySlot = new Map<EquipmentSlot, InventoryItem>();
    for (const item of items) {
      const slot = item.equipped ? this.resolveSlot(item) : undefined;
      if (slot !== undefined) {
        equippedBySlot.set(slot, item);
        this.unknownSlots.delete(slot);
      }
    }
    for (const slot of EQUIPMENT_SLOTS) {
      this.applySlot(slot, this.unknownSlots.has(slot) ? { name: "장비 정보 확인 필요", icon: "" } : equippedBySlot.get(slot) ?? null);
    }
  }

  /** Paints one slot row. `null` renders as `applyItemIcon`'s own unknown-icon fallback — the same empty box an unrecognised icon key already draws. */
  private applySlot(slot: EquipmentSlot, item: { name: string; icon: string } | null): void {
    const node = this.slotNodes.get(slot);
    if (!node) {
      return;
    }
    const icon = node.querySelector<HTMLElement>(".bag__icon");
    const name = node.querySelector<HTMLElement>(".bag__slot-name");
    const unequip = node.querySelector<HTMLButtonElement>(".bag__equip");
    if (icon) {
      applyItemIcon(icon, item?.icon ?? "");
    }
    if (name) {
      name.textContent = item?.name ?? "비어 있음";
    }
    if (unequip) {
      unequip.hidden = item === null;
    }
  }

  /** What {@link applyEquipmentChange} paints a slot with — looked up from the row already in the open list, since `EquipmentChanged` carries only the bare `itemKey`. */
  private resolveEquippedItem(itemKey: string | null): { name: string; icon: string } | null {
    if (itemKey === null) {
      return null;
    }
    const row = this.findRow(itemKey);
    if (!row) {
      return null;
    }
    return {
      name: row.querySelector<HTMLElement>(".bag__name")?.textContent ?? "",
      icon: row.dataset.icon ?? "",
    };
  }

  /** Looks the row up by walking the list rather than by selector: `itemKey` is server data. */
  private findRow(itemKey: string): HTMLElement | null {
    for (const row of this.list.children) {
      if (row instanceof HTMLElement && row.dataset.itemKey === itemKey) {
        return row;
      }
    }
    return null;
  }

  private findCount(itemKey: string): HTMLElement | null {
    return this.findRow(itemKey)?.querySelector<HTMLElement>(".bag__count") ?? null;
  }

  private renderComparisons(): void {
    const items = [...this.items.values()];
    const unknownEquipped = items.some((item) => item.equipped && this.resolveSlot(item) === undefined);
    for (const item of items) {
      const slot = this.resolveSlot(item);
      if (slot === undefined && !item.equipment) continue;
      const row = this.findRow(item.itemKey);
      if (!row) continue;
      let details = row.querySelector<HTMLElement>(".bag__comparison");
      if (!details) {
        details = document.createElement("div");
        details.className = "bag__comparison";
        for (const name of ["stats", "baseline", "difference"]) {
          const line = document.createElement("span");
          line.className = `bag__comparison-${name}`;
          details.append(line);
        }
        row.append(details);
      }
      const equipped = items.filter((entry) => entry.equipped && this.resolveSlot(entry) === slot);
      const current = slot === undefined || this.unknownSlots.has(slot) || unknownEquipped || equipped.length > 1
        ? undefined : equipped[0] ?? null;
      const description = describeEquipmentComparison(item, current);
      for (const [name, text] of Object.entries(description)) {
        const line = details.querySelector<HTMLElement>(`.bag__comparison-${name}`)!;
        line.textContent = text;
        line.hidden = text.length === 0;
      }
      const requirement = this.requirementOf(item);
      let condition = details.querySelector<HTMLElement>(".bag__comparison-requirement");
      if (requirement && !condition) {
        condition = document.createElement("span");
        condition.className = "bag__comparison-requirement";
        details.append(condition);
      }
      if (condition) {
        condition.textContent = requirement?.label ?? "";
        condition.hidden = requirement === null;
        condition.dataset.eligible = String(requirement?.eligible ?? true);
      }
    }
  }

  private resolveSlot(item: InventoryItem): EquipmentSlot | undefined {
    return this.observedSlots.get(item.itemKey) ?? itemSlot(item);
  }

  private ensureEquipAction(row: HTMLElement, item: InventoryItem): void {
    const slot = this.resolveSlot(item);
    if (slot === undefined) return;
    row.dataset.slot = slot;
    row.dataset.equipped = String(item.equipped);
    if (row.querySelector(".bag__equip")) {
      this.applyEquipEligibility(row, item);
      return;
    }
    let actions = row.querySelector<HTMLElement>(".bag__actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "bag__actions";
      row.append(actions);
    }
    const equip = document.createElement("button");
    equip.type = "button";
    equip.className = "bag__equip";
    equip.textContent = item.equipped ? "해제" : "장착";
    equip.addEventListener("click", (event) => {
      const currentSlot = row.dataset.slot as EquipmentSlot;
      if (row.dataset.equipped === "true") this.onUnequipItem(currentSlot);
      else this.onEquipItem(item.itemKey, currentSlot);
      if (event.detail > 0) equip.blur();
    });
    actions.prepend(equip);
    this.applyEquipEligibility(row, item);
  }

  private buildRow(item: InventoryItem): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "bag__row";
    // What `applyGrant` finds the row by, so a pickup lands on the item it belongs to.
    row.dataset.itemKey = item.itemKey;
    // What `resolveEquippedItem` reads back for the slot grid once this row is equipped.
    row.dataset.icon = item.icon;

    const icon = document.createElement("span");
    applyItemIcon(icon, item.icon);

    const name = document.createElement("span");
    name.className = "bag__name";
    name.textContent = item.name;

    const count = document.createElement("span");
    count.className = "bag__count";
    count.textContent = String(item.quantity);

    const unit = document.createElement("span");
    unit.className = "visually-hidden";
    unit.textContent = "개";

    row.append(icon, name, count, unit);

    const actions = document.createElement("div");
    actions.className = "bag__actions";

    // 판매 — only a row whose item carries a sell price at all (design §9 D11); absent for a
    // quest-bound possession like entry-pass. Restores the "in flight" reading across a reopen
    // rather than always starting fresh, since `pendingSell` outlives this row being torn down and
    // rebuilt by a refresh — the resend such a reopen produces is the same attempt, not a new one.
    if (item.sellValue !== undefined) {
      const pendingNonce = this.pendingSell.get(item.itemKey);
      const sell = document.createElement("button");
      sell.type = "button";
      sell.className = "bag__sell";
      sell.disabled = pendingNonce !== undefined;
      sell.textContent = pendingNonce !== undefined ? "판매하는 중…" : "판매";
      sell.addEventListener("click", (event) => {
        this.attemptSell(item.itemKey, sell);
        if (event.detail > 0) {
          sell.blur();
        }
      });
      actions.append(sell);
    }

    // 사용 — only a consumable row (design §9 D11), {@link sellValue}'s own shape and reopen rule.
    if (item.consumable === true) {
      const pendingNonce = this.pendingUse.get(item.itemKey);
      const use = document.createElement("button");
      use.type = "button";
      use.className = "bag__use";
      use.disabled = pendingNonce !== undefined;
      use.textContent = pendingNonce !== undefined ? "사용하는 중…" : "사용";
      use.addEventListener("click", (event) => {
        this.attemptUse(item.itemKey, use);
        if (event.detail > 0) {
          use.blur();
        }
      });
      actions.append(use);
    }

    if (actions.childElementCount > 0) row.append(actions);
    this.ensureEquipAction(row, item);
    return row;
  }

  /**
   * Sends one sale of one unit — no quantity stepper, `objectPanel.ts`'s own `buyItem` minimalism.
   * `pendingSell` is checked first rather than always minting fresh (design §9 D8): a
   * reopened bag rebuilds this button in its pending reading (see {@link buildRow}), and a click on
   * it is a resend of the *same* attempt, not a new sale — this is the one path in this panel where
   * that resend can actually happen, since the row survives a reopen only through the map, not the
   * DOM.
   */
  private attemptSell(itemKey: string, button: HTMLButtonElement): void {
    if (button.disabled) {
      return;
    }
    let nonce = this.pendingSell.get(itemKey);
    if (nonce === undefined) {
      nonce = crypto.randomUUID();
      this.pendingSell.set(itemKey, nonce);
    }
    button.disabled = true;
    button.textContent = "판매하는 중…";
    this.onSellItem(itemKey, 1, nonce);
  }

  /** {@link attemptSell}'s own shape, against `item:use`. Always exactly one unit. */
  private attemptUse(itemKey: string, button: HTMLButtonElement): void {
    if (button.disabled) {
      return;
    }
    let nonce = this.pendingUse.get(itemKey);
    if (nonce === undefined) {
      nonce = crypto.randomUUID();
      this.pendingUse.set(itemKey, nonce);
    }
    button.disabled = true;
    button.textContent = "사용하는 중…";
    this.onUseItem(itemKey, nonce);
  }

  /**
   * Clears one pending attempt and restores whatever button is currently on screen for it, if the
   * bag happens to be open and showing that row — `objectPanel.ts`'s own `resolveShopAttempt`
   * reset, against a map instead of a per-row field, since this panel's rows do not survive a
   * refresh the way `ObjectPanel`'s shop block survives being merely reopened.
   */
  private resolvePending(pending: Map<string, string>, itemKey: string): void {
    if (!pending.delete(itemKey)) {
      return;
    }
    const row = this.findRow(itemKey);
    const button = row?.querySelector<HTMLButtonElement>(
      pending === this.pendingSell ? ".bag__sell" : ".bag__use",
    );
    if (!button) {
      return;
    }
    button.disabled = false;
    button.textContent = pending === this.pendingSell ? "판매" : "사용";
  }

  /**
   * The chat composer yields Enter to any focused button, so focus left on 닫기 or 다시 시도 would
   * silently stop Enter from opening the composer. Same fix ObjectPanel applies on close, except
   * that here the nodes are only hidden rather than emptied.
   */
  private releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.panel.contains(focused)) {
      focused.blur();
    }
  }
}
