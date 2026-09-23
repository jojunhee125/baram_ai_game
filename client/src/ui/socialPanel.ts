import {
  CLASS_DEFINITIONS,
  type PartyChanged, type PartyInvited, type PartyDenied, type PartyView,
  type TradeChanged, type TradeDenied, type TradeOffer,
  type CraftingRecipes, type CraftResult, type CraftingRecipeView,
} from "@zep-test/shared";
import { loadInventory, type InventoryItem } from "../net/inventory";
import type { RoomConnection } from "../net/roomConnection";
import { applyItemIcon } from "./inventoryPanel";
import "./socialPanel.css";

const MAX_TRADE_ITEMS = 6;
const MAX_QUANTITY = 9999;
const MAX_CURRENCY = 1_000_000_000;
const RETRY_DELAY_MS = 8000;
const CRAFT_STORAGE_KEY = "zep:pending-craft";
const REASONS: Record<string, string> = {
  "invalid-request": "요청을 확인한 뒤 다시 시도해 주세요.",
  "already-in-party": "이미 파티에 참여 중입니다.", "not-in-party": "먼저 파티를 만들어 주세요.",
  "not-leader": "파티장만 초대할 수 있습니다.", "party-full": "파티는 최대 4명입니다.",
  "unavailable": "지금은 이용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
  "same-owner": "같은 계정의 캐릭터와는 이용할 수 없습니다.",
  "expired": "요청 시간이 지났습니다. 다시 요청해 주세요.",
  "rate-limited": "잠시 기다린 뒤 다시 시도해 주세요.",
  "auth-required": "로그인 후 이용할 수 있습니다.", "busy": "이미 진행 중인 교환이 있습니다.",
  "out-of-range": "상대에게 더 가까이 이동해 주세요.",
  "stale-revision": "교환 내용이 바뀌었습니다. 내용을 다시 확인해 주세요.",
  "settling": "교환을 처리 중입니다. 잠시 기다려 주세요.",
  "insufficient-balance": "전이 부족합니다.", "insufficient-item": "재료나 아이템 수량이 부족합니다.",
  "equipped-item": "착용 중인 장비는 사용할 수 없습니다.", "bag-full": "가방에 빈자리가 필요합니다.",
  "restricted-item": "교환할 수 없는 아이템입니다.", "invalid-offer": "아이템과 수량을 확인해 주세요.",
  "conflict": "보유 내역이 바뀌었습니다. 가방을 새로 확인해 주세요.",
  "storage-error": "처리를 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
  "unknown-recipe": "현재 사용할 수 없는 제작법입니다.",
  "declined": "상대가 교환을 거절했습니다.", "cancelled": "교환이 취소되었습니다.",
  "disconnected": "상대가 떠나 교환이 취소되었습니다.",
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text: string, run: () => void, disabled = false): HTMLButtonElement {
  const element = node("button", text);
  element.type = "button";
  element.disabled = disabled;
  element.addEventListener("click", run);
  return element;
}

function message(reason?: string): string { return REASONS[reason ?? ""] ?? "요청을 완료하지 못했습니다. 다시 시도해 주세요."; }

export class SocialPanel {
  private readonly panel = node("section", "", "social");
  private readonly toggle = button("파티·교환·제작", () => this.setOpen(this.panel.hidden));
  private readonly status = node("p", "", "social__status");
  private readonly partyBody = node("div");
  private readonly nearbyBody = node("div");
  private readonly tradeBody = node("div");
  private readonly craftingBody = node("div");
  private party: PartyView | null = null;
  private invitation: PartyInvited | null = null;
  private trade: TradeChanged | null = null;
  private recipes: readonly CraftingRecipeView[] | null = null;
  private items: readonly InventoryItem[] = [];
  private inventoryState: "loading" | "ready" | "error" = "loading";
  private inventoryRequest = 0;
  private selectedAlly: string | undefined;
  private balance = 0;
  private destroyed = false;
  private actionPending = false;
  private pendingKind: "party" | "trade" = "trade";
  private nearbySignature = "";
  private partySignature = "";
  private actionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly craftAttempts = new Map<string, { nonce: string; sentAt: number }>();
  private readonly clock: ReturnType<typeof setInterval>;

  constructor(private readonly connection: RoomConnection) {
    this.panel.id = "social-panel";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "파티, 교환, 제작");
    this.toggle.id = "social-button";
    this.toggle.className = "hud__button";
    this.toggle.setAttribute("aria-controls", this.panel.id);
    this.toggle.setAttribute("aria-expanded", "false");
    const heading = node("header", "", "social__heading");
    heading.append(node("h2", "동료와 제작"), button("닫기", () => this.setOpen(false)));
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.panel.append(heading, this.status);
    for (const [title, body] of [["파티", this.partyBody], ["주변 사람", this.nearbyBody],
      ["개인 교환", this.tradeBody], ["제작", this.craftingBody]] as const) {
      const section = node("section", "", "social__section");
      section.append(node("h3", title), body);
      this.panel.append(section);
    }
    document.querySelector(".hud__controls")!.append(this.toggle);
    document.querySelector(".stage")!.append(this.panel);
    this.panel.addEventListener("keydown", this.onKey);
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(CRAFT_STORAGE_KEY) ?? "{}");
      if (stored && typeof stored === "object") for (const [recipeId, nonce] of Object.entries(stored)) {
        if (typeof nonce === "string") this.craftAttempts.set(recipeId, { nonce, sentAt: 0 });
      }
    } catch { /* Unavailable session storage does not prevent crafting in this room. */ }
    this.renderParty(); this.renderNearby(); this.renderTrade(); this.renderCrafting();
    this.clock = setInterval(() => {
      if (this.invitation && Date.now() >= this.invitation.expiresAt) {
        this.invitation = null; this.renderParty();
      }
      if ([...this.craftAttempts.values()].some((attempt) => attempt.sentAt > 0 && Date.now() - attempt.sentAt >= RETRY_DELAY_MS)) {
        for (const attempt of this.craftAttempts.values()) if (Date.now() - attempt.sentAt >= RETRY_DELAY_MS) attempt.sentAt = 0;
        this.renderCrafting();
      }
    }, 1000);
  }

  get healingTarget(): string { return this.selectedAlly ?? this.connection.sessionId; }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { event.stopPropagation(); this.setOpen(false); }
  };

  private setOpen(open: boolean): void {
    this.panel.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      this.renderNearby();
      void this.refreshInventory();
      this.panel.querySelector<HTMLButtonElement>("button")?.focus();
    } else this.toggle.focus();
  }

  private announce(text: string): void { this.status.textContent = text; }

  private pending(run: () => void, kind: "party" | "trade" = "trade"): void {
    if (this.actionPending || this.connection.hasLeft) return;
    this.actionPending = true;
    this.pendingKind = kind;
    this.announce("요청 중입니다…");
    run();
    this.renderParty(); this.renderNearby(); this.renderTrade();
    clearTimeout(this.actionTimer);
    this.actionTimer = setTimeout(() => {
      this.finishAction();
      this.renderTrade();
      this.announce("응답을 기다리고 있습니다. 상태를 확인한 뒤 다시 시도해 주세요.");
    }, RETRY_DELAY_MS);
  }

  private finishAction(): void {
    clearTimeout(this.actionTimer); this.actionPending = false;
    this.renderParty(); this.renderNearby();
  }

  applyParty(event: PartyChanged): void {
    this.party = event.party;
    if (this.party) this.invitation = null;
    if (!this.party?.members.some((member) => member.sessionId === this.selectedAlly)) this.selectedAlly = undefined;
    if (this.actionPending && this.pendingKind === "party") { this.finishAction(); this.announce("파티 상태를 갱신했습니다."); }
    this.renderParty(); this.renderNearby();
  }

  applyInvitation(event: PartyInvited): void {
    this.invitation = event; this.renderParty(); this.setOpen(true);
    this.announce(`${event.inviterNickname} 님이 파티에 초대했습니다.`);
  }

  applyPartyDenied(event: PartyDenied): void {
    this.finishAction(); this.renderTrade(); this.announce(message(event.reason));
  }

  applyTrade(event: TradeChanged): void {
    this.trade = event; this.finishAction(); this.renderTrade();
    if (event.phase === "invited" && event.initiatorSessionId !== this.connection.sessionId) this.setOpen(true);
    if (event.phase === "completed") { this.announce("교환을 완료했습니다."); void this.refreshInventory(); }
    else if (event.phase === "cancelled") this.announce(message(event.reason));
    else this.announce(event.phase === "settling" ? "교환을 처리 중입니다…" : "교환 내용을 확인해 주세요.");
  }

  applyTradeDenied(event: TradeDenied): void {
    this.finishAction(); this.renderTrade(); this.announce(message(event.reason));
  }

  applyRecipes(event: CraftingRecipes): void { this.recipes = event.recipes; this.renderCrafting(); }
  applyBalance(balance: number): void { this.balance = balance; this.renderCrafting(); }
  inventoryChanged(): void { if (!this.panel.hidden) void this.refreshInventory(); }

  applyCraftResult(event: CraftResult): void {
    const attempt = this.craftAttempts.get(event.recipeId);
    if (!attempt || attempt.nonce !== event.nonce) return;
    if (event.ok || (event.reason !== "storage-error" && event.reason !== "unavailable" && event.reason !== "rate-limited")) {
      this.craftAttempts.delete(event.recipeId);
    } else attempt.sentAt = 0;
    this.persistCraft(); this.renderCrafting();
    this.announce(event.ok ? "제작을 완료했습니다. 가방에서 확인해 주세요." : message(event.reason));
    if (event.ok) void this.refreshInventory();
  }

  playersChanged(): void { if (!this.panel.hidden) this.renderNearby(); }

  private renderParty(): void {
    const signature = JSON.stringify([this.party, this.invitation, this.selectedAlly, this.actionPending]);
    if (signature === this.partySignature) return;
    this.partySignature = signature;
    const focusedLabel = this.partyBody.contains(document.activeElement)
      ? document.activeElement?.getAttribute("aria-label") : null;
    this.partyBody.replaceChildren();
    if (this.invitation) {
      const invite = this.invitation;
      this.partyBody.append(node("p", `${invite.inviterNickname} 님의 초대`),
        button("파티 수락", () => this.pending(() => this.connection.respondParty(invite.inviteId, true), "party"), this.actionPending),
        button("파티 거절", () => {
          this.connection.respondParty(invite.inviteId, false); this.invitation = null; this.renderParty();
        }, this.actionPending));
    }
    if (!this.party) {
      const empty = node("div", "", "social__empty");
      const icon = node("span"); applyItemIcon(icon, "entry-pass"); icon.setAttribute("aria-hidden", "true");
      empty.append(icon, node("p", "함께할 파티가 없습니다. 같은 방에서 최대 4명까지 함께할 수 있습니다."));
      this.partyBody.append(empty, button("파티 만들기", () => this.pending(() => this.connection.createParty(), "party"), this.actionPending));
      return;
    }
    this.partyBody.append(node("p", `${this.party.members.length} / 4명 · 방을 떠나면 파티에서 나갑니다.`, "social__muted"));
    for (const member of this.party.members) {
      const self = member.sessionId === this.connection.sessionId;
      const selected = this.healingTarget === member.sessionId;
      const row = button("", () => { this.selectedAlly = member.sessionId; this.renderParty(); });
      row.className = "social__member";
      row.setAttribute("aria-pressed", String(selected));
      row.setAttribute("aria-label", `${member.nickname}${self ? " 나" : ""} 치유 대상 선택`);
      row.append(node("strong", `${member.nickname}${self ? " (나)" : ""}${member.sessionId === this.party.leaderSessionId ? " · 파티장" : ""}`),
        node("span", `Lv.${member.level} ${member.playerClass ? CLASS_DEFINITIONS[member.playerClass]?.label ?? "" : "직업 미선택"}`),
        node("span", `HP ${member.hp}/${member.maxHp} · MP ${member.mp}/${member.maxMp}`),
        node("small", selected ? "치유 대상" : "선택하여 치유 대상으로 지정"));
      this.partyBody.append(row);
    }
    this.partyBody.append(button("파티 나가기", () => this.pending(() => this.connection.leaveParty(), "party"), this.actionPending));
    if (focusedLabel) {
      for (const control of this.partyBody.querySelectorAll<HTMLButtonElement>("button[aria-label]")) {
        if (control.getAttribute("aria-label") === focusedLabel) control.focus({ preventScroll: true });
      }
    }
  }

  private renderNearby(): void {
    const players = [...this.connection.players].filter(([id]) => id !== this.connection.sessionId);
    const signature = JSON.stringify([players.map(([id, player]) => [id, player.nickname, player.level]), this.party?.partyId,
      this.party?.leaderSessionId, this.party?.members.map((member) => member.sessionId), this.actionPending, this.trade?.phase]);
    if (signature === this.nearbySignature) return;
    this.nearbySignature = signature;
    this.nearbyBody.replaceChildren();
    if (!players.length) {
      this.nearbyBody.append(node("p", "주변에 다른 사람이 없습니다. 가까이 이동해 보세요.", "social__muted"),
        button("주변 확인", () => this.renderNearby()));
      return;
    }
    const busy = this.trade !== null && !["completed", "cancelled"].includes(this.trade.phase);
    for (const [id, player] of players) {
      const row = node("div", "", "social__nearby");
      row.append(node("span", `Lv.${player.level} ${player.nickname}`),
        button("초대", () => this.pending(() => this.connection.inviteParty(id), "party"), this.actionPending || !this.party ||
          this.party.leaderSessionId !== this.connection.sessionId || this.party.members.length >= 4 || this.party.members.some((member) => member.sessionId === id)),
        button("교환", () => this.pending(() => this.connection.requestTrade(id)), this.actionPending || busy));
      this.nearbyBody.append(row);
    }
  }

  private renderTrade(): void {
    this.tradeBody.replaceChildren();
    const trade = this.trade;
    if (!trade) { this.tradeBody.append(node("p", "주변 사람에게 교환을 요청해 보세요.", "social__muted")); return; }
    if (trade.phase === "completed" || trade.phase === "cancelled") {
      this.tradeBody.append(node("p", trade.phase === "completed" ? "교환 완료" : message(trade.reason)),
        button("교환 내역 닫기", () => { this.trade = null; this.renderTrade(); this.renderNearby(); }));
      return;
    }
    if (trade.phase === "invited") {
      const incoming = trade.initiatorSessionId !== this.connection.sessionId;
      this.tradeBody.append(node("p", incoming ? "교환 요청이 도착했습니다." : "상대의 수락을 기다리고 있습니다…"));
      if (incoming) this.tradeBody.append(button("교환 수락", () => this.pending(() => this.connection.respondTrade(trade.tradeId, true)), this.actionPending),
        button("교환 거절", () => this.pending(() => this.connection.respondTrade(trade.tradeId, false)), this.actionPending));
      else this.tradeBody.append(button("교환 취소", () => this.pending(() => this.connection.cancelTrade(trade.tradeId)), this.actionPending));
      return;
    }
    const self = trade.participants.find((participant) => participant.sessionId === this.connection.sessionId);
    for (const participant of trade.participants) {
      const block = node("div", "", "social__offer");
      block.append(node("strong", `${participant.nickname}${participant.sessionId === this.connection.sessionId ? " (나)" : ""} · ${participant.confirmed ? "확인 완료" : "확인 전"}`),
        node("p", `${participant.offer.currency.toLocaleString()}전`));
      for (const item of participant.offer.items) block.append(node("p", `${item.name ?? this.items.find((row) => row.itemKey === item.itemKey)?.name ?? "알 수 없는 아이템"} × ${item.quantity}`));
      if (!participant.offer.items.length) block.append(node("p", "제시한 아이템 없음", "social__muted"));
      this.tradeBody.append(block);
    }
    if (trade.phase === "settling") {
      if (trade.reason === "storage-error") {
        this.tradeBody.append(node("p", "교환 결과를 아직 확인하지 못했습니다. 같은 교환의 결과를 다시 확인해 주세요."),
          button("같은 교환 다시 확인", () => this.pending(() => this.connection.confirmTrade(trade.tradeId, trade.revision)), this.actionPending));
      } else this.tradeBody.append(node("p", "교환을 처리 중입니다. 완료될 때까지 기다려 주세요."));
      return;
    }
    if (!self) return;
    this.tradeBody.append(node("p", "아이템 6종까지 교환할 수 있습니다. 내용이 바뀌면 두 사람 모두 다시 확인해야 합니다.", "social__muted"));
    const form = node("form", "", "social__trade-form");
    const currency = node("input"); currency.type = "number"; currency.min = "0"; currency.max = String(Math.min(this.balance, MAX_CURRENCY)); currency.step = "1";
    currency.value = String(self.offer.currency); currency.required = true;
    const moneyLabel = node("label", `제시할 전 (보유 ${this.balance.toLocaleString()}전)`); moneyLabel.append(currency); form.append(moneyLabel);
    const amounts: { select: HTMLSelectElement; quantity: HTMLInputElement }[] = [];
    const eligible = this.items.filter((item) => item.tradeable === true && !item.equipped && item.quantity > 0);
    for (let index = 0; index < MAX_TRADE_ITEMS; index++) {
      const row = node("div", "", "social__trade-item");
      const select = node("select"); select.setAttribute("aria-label", `교환 아이템 ${index + 1}`);
      select.append(new Option("선택 안 함", ""));
      for (const item of eligible) select.append(new Option(`${item.name} (보유 ${item.quantity})`, item.itemKey));
      const quantity = node("input"); quantity.type = "number"; quantity.min = "1"; quantity.max = String(MAX_QUANTITY); quantity.step = "1";
      quantity.setAttribute("aria-label", `교환 수량 ${index + 1}`);
      select.value = self.offer.items[index]?.itemKey ?? ""; quantity.value = String(self.offer.items[index]?.quantity ?? 1);
      quantity.disabled = !select.value;
      select.addEventListener("change", () => { quantity.disabled = !select.value; quantity.max = String(Math.min(MAX_QUANTITY, eligible.find((item) => item.itemKey === select.value)?.quantity ?? MAX_QUANTITY)); });
      amounts.push({ select, quantity }); row.append(select, quantity); form.append(row);
    }
    if (this.inventoryState === "loading") form.append(node("p", "가방을 확인 중입니다…"));
    if (this.inventoryState === "error") form.append(node("p", "가방을 불러오지 못했습니다."), button("가방 다시 읽기", () => void this.refreshInventory()));
    if (this.inventoryState === "ready" && !eligible.length) form.append(node("p", "교환 가능한 아이템이 없습니다. 전만 제시할 수 있습니다.", "social__muted"));
    const save = button("제안 적용", () => {}); save.type = "submit";
    save.disabled = this.actionPending || this.inventoryState !== "ready";
    form.append(save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.actionPending || !form.reportValidity()) return;
      const items = amounts.filter((row) => row.select.value).map((row) => ({ itemKey: row.select.value, quantity: Number(row.quantity.value) }));
      if (new Set(items.map((item) => item.itemKey)).size !== items.length || items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY || item.quantity > (eligible.find((row) => row.itemKey === item.itemKey)?.quantity ?? 0))) {
        this.announce("같은 아이템은 한 줄에 모으고 보유 수량 안에서 입력해 주세요."); return;
      }
      const offer: TradeOffer = { currency: Number(currency.value), items };
      this.pending(() => this.connection.updateTrade(trade.tradeId, trade.revision, offer));
    });
    this.tradeBody.append(form,
      button(self.confirmed ? "확인 완료 · 상대 대기" : "표시된 제안으로 교환 확정", () => this.pending(() => this.connection.confirmTrade(trade.tradeId, trade.revision)), this.actionPending || self.confirmed),
      button("교환 취소", () => this.pending(() => this.connection.cancelTrade(trade.tradeId)), this.actionPending));
    form.addEventListener("input", () => {
      const confirm = this.tradeBody.querySelector<HTMLButtonElement>(".social__trade-form + button");
      if (confirm) { confirm.disabled = true; confirm.textContent = "제안 적용 후 확정하세요"; }
    });
  }

  private renderCrafting(): void {
    this.craftingBody.replaceChildren();
    if (this.recipes === null) { this.craftingBody.append(node("p", "제작법을 불러오는 중입니다…")); return; }
    if (!this.recipes.length) { this.craftingBody.append(node("p", "현재 제작할 수 있는 물품이 없습니다."), button("가방 확인", () => void this.refreshInventory())); return; }
    if (this.inventoryState === "loading") this.craftingBody.append(node("p", "가방을 확인 중입니다…"));
    if (this.inventoryState === "error") this.craftingBody.append(node("p", "재료를 확인하지 못했습니다."), button("재료 다시 읽기", () => void this.refreshInventory()));
    for (const recipe of this.recipes) {
      const card = node("div", "", "social__recipe");
      card.append(node("strong", recipe.name), node("p", `완성: ${recipe.output.name} × ${recipe.output.quantity}`));
      for (const ingredient of recipe.ingredients) card.append(node("p", `${ingredient.name} ${ingredient.quantity}개 / 보유 ${this.inventoryState === "ready" ? this.items.find((item) => item.itemKey === ingredient.itemKey)?.quantity ?? 0 : "확인 중"}`));
      card.append(node("p", `비용 ${recipe.currencyCost.toLocaleString()}전 / 보유 ${this.balance.toLocaleString()}전`));
      const attempt = this.craftAttempts.get(recipe.recipeId);
      const enough = this.inventoryState === "ready" && this.balance >= recipe.currencyCost && recipe.ingredients.every((ingredient) => {
        const item = this.items.find((row) => row.itemKey === ingredient.itemKey);
        return item && !item.equipped && item.quantity >= ingredient.quantity;
      });
      if (!attempt && this.inventoryState === "ready" && !enough) card.append(node("p", "착용하지 않은 재료와 충분한 전이 필요합니다.", "social__muted"));
      card.append(button(attempt ? attempt.sentAt === 0 ? "같은 제작 다시 확인" : "제작 중…" : "제작하기", () => this.craft(recipe.recipeId), attempt ? attempt.sentAt !== 0 : !enough));
      this.craftingBody.append(card);
    }
  }

  private craft(recipeId: string): void {
    if (this.connection.hasLeft) return;
    const previous = this.craftAttempts.get(recipeId);
    if (previous && previous.sentAt !== 0) return;
    const attempt = { nonce: previous?.nonce ?? crypto.randomUUID(), sentAt: Date.now() };
    this.craftAttempts.set(recipeId, attempt); this.persistCraft(); this.renderCrafting();
    this.announce("제작 결과를 기다리고 있습니다…");
    this.connection.craftItem(recipeId, attempt.nonce);
  }

  private persistCraft(): void {
    try { sessionStorage.setItem(CRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries([...this.craftAttempts].map(([id, attempt]) => [id, attempt.nonce])))); } catch { /* Keep the in-memory attempt for retries. */ }
  }

  private async refreshInventory(): Promise<void> {
    const request = ++this.inventoryRequest;
    this.inventoryState = "loading"; this.renderTrade(); this.renderCrafting();
    try {
      const items = await loadInventory({ strict: true });
      if (this.destroyed || request !== this.inventoryRequest) return;
      this.items = items; this.inventoryState = "ready";
    } catch {
      if (this.destroyed || request !== this.inventoryRequest) return;
      this.inventoryState = "error";
      this.announce("가방을 불러오지 못했습니다. 다시 읽기를 눌러 주세요.");
    }
    this.renderTrade(); this.renderCrafting();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; ++this.inventoryRequest;
    clearInterval(this.clock); clearTimeout(this.actionTimer);
    this.panel.removeEventListener("keydown", this.onKey);
    this.panel.remove(); this.toggle.remove();
  }
}
