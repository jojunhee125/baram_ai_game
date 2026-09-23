import {
  CLASS_DEFINITIONS,
  InteractableKind,
  QuestStatus,
  type InteractableEntered,
  type EquipmentChanged,
  type ItemGranted,
  type ItemRemoved,
  type LinkInteraction,
  type NpcInteraction,
  type QuestState,
  type QuizInteraction,
  type QuizResult,
  type ShopDenied,
  type ShopListingView,
  type ShopOffer,
} from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";
import { applyItemIcon } from "./inventoryPanel";
import { loadInventory, readEquipmentMetadata, type InventoryItem } from "../net/inventory";
import { describeEquipmentComparison } from "./equipmentComparison";

const KIND_LABELS: Record<InteractableKind, string> = {
  [InteractableKind.Link]: "링크",
  [InteractableKind.Notice]: "공지",
  [InteractableKind.Quiz]: "퀴즈",
  [InteractableKind.Npc]: "안내",
};

/** What a quiz currently on screen needs to match an asynchronous verdict against. */
interface OpenQuiz {
  objectId: string;
  /** The choice awaiting a verdict; null until the player has picked one. */
  answered: number | null;
  choices: readonly HTMLButtonElement[];
  result: HTMLElement;
}

/**
 * The nodes of one quest block on screen, kept so `quest:updated` patches the block in place
 * instead of the panel reopening. The giver's own line never changes and is not held here.
 */
interface OpenQuest {
  root: HTMLElement;
  /** The objective while it is unmet, the giver's closing line once it is. */
  objective: HTMLElement;
  /** 수락 대기 · 진행 중 n / m · 완료 — the reading the accept button turns into. */
  status: HTMLElement;
  accept: HTMLButtonElement;
}

interface ShopComparison {
  listing: ShopListingView;
  baseline: HTMLElement;
  difference: HTMLElement;
}

/**
 * The panel for every fixed object — link, notice and quiz. One panel rather than three: they
 * differ only in the body and the footer, they never open at once (the object that opens this is
 * the tile you are standing on), and three would mean three sets of markup, CSS and teardown.
 *
 * Draws only what the server sent. No object table reaches the client, so a browser holding a
 * bundle older than that table still renders whatever arrives.
 */
export class ObjectPanel {
  private readonly root = document.querySelector<HTMLElement>("#object-panel")!;
  private readonly dialog = document.querySelector<HTMLElement>("#object-panel-dialog")!;
  private readonly kind = document.querySelector<HTMLElement>("#object-panel-kind")!;
  private readonly heading = document.querySelector<HTMLElement>("#object-panel-title")!;
  private readonly body = document.querySelector<HTMLElement>("#object-panel-body")!;
  private readonly link = document.querySelector<HTMLAnchorElement>("#object-panel-link")!;
  private readonly closeButton = document.querySelector<HTMLButtonElement>("#object-panel-close")!;
  private quiz: OpenQuiz | null = null;
  /** The quest blocks currently drawn, by quest id. Empty for every kind but an NPC with offers. */
  private readonly quests = new Map<string, OpenQuest>();
  /**
   * The shop rows' buy buttons currently drawn, by item key — rebuilt on every `open()`, unlike
   * {@link pendingBuys} below.
   */
  private readonly shopRows = new Map<string, HTMLButtonElement>();
  /**
   * In-flight purchase nonces by item key (design §9 D8), kept on the instance rather than cleared
   * by `open()`/`close()` — `inventoryPanel.ts`'s own `pendingSell`/`pendingUse` shape, for the
   * same reason: stepping off the NPC tile and back on rebuilds {@link shopRows} from a fresh
   * `NpcInteraction` payload, but a purchase already in flight when that happens is a *dropped
   * reply*, not a new attempt, and resending it must reuse this same nonce. {@link buildShopRow}
   * reads this to redraw a reopened row already disabled and "구매하는 중…" when it applies.
   *
   * Not scoped by NPC: two different shop NPCs selling the same item key would share one pending
   * slot here. Unreached today — `docs/r04-settlement.md` §9 D11 authors exactly one shop NPC — and
   * left rather than keying by `${npcObjectId}:${itemKey}` for a case that cannot happen yet.
   */
  private readonly pendingBuys = new Map<string, string>();
  /** Which NPC the open shop block belongs to — {@link buyItem} names it back in every request. */
  private currentShopNpcId: string | null = null;
  private currentBlocksMovement = true;
  private readonly shopComparisons = new Map<string, ShopComparison>();
  private comparisonStatus: HTMLElement | null = null;
  private comparisonRetry: HTMLButtonElement | null = null;
  private comparisonGeneration = 0;
  private comparisonLoading = false;
  private comparisonDirty = false;
  private destroyed = false;

  constructor(
    private readonly sendAnswer: (objectId: string, choiceIndex: number) => void,
    private readonly sendAcceptQuest: (questId: string) => void,
    /**
     * design §9 D8 — `nonce` is minted by {@link buyItem}, never here: this callback's only job is
     * to put a message on the wire.
     */
    private readonly sendBuyItem: (
      npcObjectId: string,
      itemKey: string,
      quantity: number,
      nonce: string,
    ) => void,
  ) {
    this.closeButton.addEventListener("click", this.handleClose);
    window.addEventListener("keydown", this.handleKey);
    // The DOM outlives the scene, so a successor built by a room hop inherits whatever the
    // previous instance left on screen.
    this.close();
  }

  /** Read off the DOM rather than a field, since the DOM is the part shared between instances. */
  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /**
   * Whether the currently-open panel (if any) should hold movement/the home-and-landmark warp.
   * False both when nothing is open and when what is open was authored non-modal
   * (`InteractableEntered.blocksMovement === false`) — one getter, so `WorldScene` never has to
   * combine `isOpen` with a second field itself at three separate call sites.
   */
  get blocksMovement(): boolean {
    return this.isOpen && this.currentBlocksMovement;
  }

  open(payload: InteractableEntered): void {
    if (this.destroyed) return;
    this.resetComparisons();
    this.currentBlocksMovement = payload.blocksMovement;
    this.quiz = null;
    this.quests.clear();
    this.shopRows.clear();
    this.currentShopNpcId = null;
    this.body.replaceChildren();
    this.link.hidden = true;
    this.link.removeAttribute("href");
    this.kind.textContent = KIND_LABELS[payload.kind];
    this.heading.textContent = payload.title;

    switch (payload.kind) {
      case InteractableKind.Link:
        this.renderLink(payload);
        break;
      case InteractableKind.Notice:
        this.renderNotice(payload);
        break;
      case InteractableKind.Quiz:
        this.renderQuiz(payload);
        break;
      case InteractableKind.Npc:
        this.renderNpc(payload);
        break;
      default:
        // A kind this bundle has no case for: the server serves the bundle but a browser can be
        // holding an older one, the same reason PortalEntered carries its destination room. The
        // heading and 닫기 are already drawn, so the player gets a panel they can read and
        // dismiss rather than a tile that swallows them.
        this.kind.textContent = "오브젝트";
    }

    this.root.hidden = false;
    this.invalidateComparisons();
    // The dialog, not a control inside it: Tab then starts here instead of back at the chat
    // composer, while Enter keeps opening the composer the way it does everywhere else.
    this.dialog.focus();
  }

  /**
   * Shows the verdict for an answer this panel is still waiting on, and ignores every other one.
   * The round trip is asynchronous, so a verdict can arrive for a panel that has since closed, for
   * a different object, or for a choice the player replaced with another before the reply landed.
   */
  showQuizResult(result: QuizResult): void {
    const quiz = this.quiz;
    if (!quiz) {
      return;
    }
    if (result.objectId !== quiz.objectId || result.choiceIndex !== quiz.answered) {
      return;
    }

    for (const [index, choice] of quiz.choices.entries()) {
      choice.disabled = true;
      if (index === result.choiceIndex) {
        choice.classList.add(result.correct ? "object__choice--correct" : "object__choice--wrong");
      }
    }

    quiz.result.className = result.correct
      ? "object__result object__result--correct"
      : "object__result object__result--wrong";
    quiz.result.textContent = result.correct ? "정답입니다." : "오답입니다.";
    if (result.explanation) {
      const note = document.createElement("span");
      note.className = "object__explanation";
      note.textContent = result.explanation;
      quiz.result.append(note);
    }
    // No "다시 풀기": stepping off the tile and back on opens a fresh panel, which is the retry.
  }

  /**
   * Redraws one quest block if this panel is showing that quest, and ignores every other update.
   * Updates arrive whether or not a panel is open — a kill in the hunting ground sends one with no
   * NPC in sight — and the tracker, not this, is what always shows them.
   */
  applyQuestUpdate(state: QuestState): void {
    const quest = this.quests.get(state.questId);
    if (!quest) {
      return;
    }
    this.drawQuestState(quest, state);
  }

  close(): void {
    this.resetComparisons();
    this.releaseFocus();
    this.root.hidden = true;
    this.body.replaceChildren();
    this.link.hidden = true;
    this.link.removeAttribute("href");
    this.kind.textContent = "";
    this.heading.textContent = "";
    this.quiz = null;
    this.quests.clear();
    this.shopRows.clear();
    this.currentShopNpcId = null;
    this.currentBlocksMovement = true; // back to the safe default for whatever opens next
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would keep answering Escape
   * and keep sending answers to the room it left.
   */
  destroy(): void {
    this.destroyed = true;
    this.closeButton.removeEventListener("click", this.handleClose);
    window.removeEventListener("keydown", this.handleKey);
    this.close();
  }

  private renderLink(payload: LinkInteraction): void {
    const url = document.createElement("p");
    url.className = "object__url";
    url.textContent = payload.url;
    this.body.append(url);

    // Straight from the payload, unchecked: the URL comes from a table authored in the repo whose
    // scheme boot validation already enforced, so the table is the allowlist and a second check
    // here would only defend against our own server. That stops being true the day content becomes
    // runtime-editable — docs/design-fixed-objects.md §2.3.
    this.link.href = payload.url;
    this.link.hidden = false;
  }

  private renderNotice(payload: { body: string }): void {
    const text = document.createElement("p");
    text.className = "object__text";
    // textContent with `white-space: pre-wrap`, never innerHTML. The source is our own table, but
    // a markup-rendering path is not worth having at all when line breaks are all a notice needs.
    text.textContent = payload.body;
    this.body.append(text);
  }

  /**
   * The guide's line, and under it whatever that guide is offering (roadmap R03). `quests` is
   * absent for every NPC but the plaza guide today, and an NPC that offers nothing renders exactly
   * what it did before this panel learned about quests.
   */
  private renderNpc(payload: NpcInteraction): void {
    this.renderNotice(payload);
    for (const quest of payload.quests ?? []) {
      this.renderQuest(quest);
    }
    if (payload.shop) {
      this.renderShop(payload.objectId, payload.shop);
    }
  }

  /**
   * The giver's quest treatment, applied to a shop listing (roadmap R04-c, design §9 D11/D12):
   * ruled off from whatever is above it, one row per listing, drawn once from the payload the NPC
   * panel carried — a listing's price never changes underneath an open panel, unlike a quest's
   * status, so there is no `applyX` counterpart here to patch a row in place.
   */
  private renderShop(npcObjectId: string, offer: ShopOffer): void {
    this.currentShopNpcId = npcObjectId;

    const section = document.createElement("section");
    section.className = "object__shop";

    const title = document.createElement("h3");
    title.className = "object__shop-title";
    title.textContent = "상점";
    section.append(title);

    const list = document.createElement("ul");
    list.className = "object__shop-list";
    for (const listing of offer.listings) {
      list.append(this.buildShopRow(listing));
    }
    section.append(list);

    this.body.append(section);
    if (this.shopComparisons.size > 0) {
      const status = document.createElement("p");
      status.className = "object__shop-comparison-status";
      status.setAttribute("role", "status");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "object__shop-comparison-retry";
      retry.textContent = "장비 비교 다시 확인";
      retry.hidden = true;
      retry.addEventListener("click", () => this.invalidateComparisons());
      section.insertBefore(status, list);
      section.insertBefore(retry, list);
      this.comparisonStatus = status;
      this.comparisonRetry = retry;
    }
  }

  private buildShopRow(listing: ShopListingView): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "object__shop-row";
    row.dataset.itemKey = listing.itemKey;

    const icon = document.createElement("span");
    applyItemIcon(icon, listing.icon);

    const name = document.createElement("span");
    name.className = "object__shop-name";
    name.textContent = listing.name;
    const benefits: string[] = [];
    if (listing.attackBonus !== undefined) benefits.push(`공격력 +${listing.attackBonus}`);
    if (listing.damageReductionRatio !== undefined) benefits.push(`받는 피해 ${Math.round(listing.damageReductionRatio * 100)}% 감소`);
    if (benefits.length > 0) {
      const stats = document.createElement("small");
      stats.className = "object__shop-stats";
      stats.textContent = benefits.join(" · ");
      name.append(stats);
    }
    const requirement = readEquipmentMetadata(listing.equipment)?.requirement;
    if (requirement) {
      const conditions: string[] = [];
      if (requirement.minLevel !== undefined) conditions.push(`Lv.${requirement.minLevel} 이상`);
      if (requirement.classes?.length) {
        conditions.push(requirement.classes.map((key) => CLASS_DEFINITIONS[key].label).join(" / "));
      }
      if (conditions.length) {
        const hint = document.createElement("small");
        hint.className = "object__shop-requirement";
        hint.textContent = `착용 조건: ${conditions.join(" · ")}`;
        name.append(hint);
      }
    }

    const price = document.createElement("span");
    price.className = "object__shop-price";
    price.textContent = `${listing.price.toLocaleString("ko-KR")}전`;

    // A reopen (stepping off the tile and back on) rebuilds this row from scratch, but a purchase
    // already in flight when that happens is a dropped reply, not a new attempt — `pendingBuys`
    // outlives the rebuild, so the fresh button starts exactly where the old one left off.
    const pending = this.pendingBuys.has(listing.itemKey);
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "object__shop-buy";
    buy.disabled = pending;
    buy.textContent = pending ? "구매하는 중…" : "구매";
    buy.addEventListener("click", () => this.buyItem(listing.itemKey));

    row.append(icon, name, price, buy);
    if (listing.equipment !== undefined || listing.attackBonus !== undefined || listing.damageReductionRatio !== undefined) {
      const comparison = document.createElement("div");
      comparison.className = "object__shop-comparison";
      const baseline = document.createElement("span");
      baseline.className = "object__shop-comparison-baseline";
      const difference = document.createElement("span");
      difference.className = "object__shop-comparison-difference";
      comparison.append(baseline, difference);
      row.append(comparison);
      this.shopComparisons.set(listing.itemKey, { listing, baseline, difference });
    }
    this.shopRows.set(listing.itemKey, buy);
    return row;
  }

  applyGrant(_event: ItemGranted): void {
    this.invalidateComparisons();
  }

  applyItemRemoved(_event: ItemRemoved): void {
    this.invalidateComparisons();
  }

  applyEquipmentChange(event: EquipmentChanged): void {
    if (event.applied) this.invalidateComparisons();
  }

  private resetComparisons(): void {
    this.comparisonGeneration += 1;
    this.comparisonDirty = false;
    this.shopComparisons.clear();
    this.comparisonStatus = null;
    this.comparisonRetry = null;
  }

  private hasOpenComparison(): boolean {
    return !this.destroyed && this.isOpen && this.currentShopNpcId !== null && this.shopComparisons.size > 0;
  }

  private invalidateComparisons(): void {
    if (!this.hasOpenComparison()) return;
    this.comparisonDirty = true;
    this.setComparisonPending();
    this.refreshComparisons();
  }

  private setComparisonPending(): void {
    if (this.comparisonStatus) this.comparisonStatus.textContent = "장착 장비를 확인하는 중…";
    if (this.comparisonRetry) this.comparisonRetry.hidden = true;
    for (const { baseline, difference } of this.shopComparisons.values()) {
      baseline.textContent = "비교: 장비 확인 중";
      difference.textContent = "";
      difference.hidden = true;
    }
  }

  private refreshComparisons(): void {
    if (this.comparisonLoading || !this.comparisonDirty || !this.hasOpenComparison()) return;
    const generation = this.comparisonGeneration;
    this.comparisonLoading = true;
    this.comparisonDirty = false;
    void loadInventory({ strict: true }).then(
      (items) => {
        if (generation !== this.comparisonGeneration || !this.hasOpenComparison() || this.comparisonDirty) return;
        this.renderComparisons(items);
      },
      () => {
        if (generation !== this.comparisonGeneration || !this.hasOpenComparison() || this.comparisonDirty) return;
        if (this.comparisonStatus) this.comparisonStatus.textContent = "장착 장비를 읽지 못했습니다. 다시 확인해 주세요.";
        if (this.comparisonRetry) this.comparisonRetry.hidden = false;
        for (const { baseline, difference } of this.shopComparisons.values()) {
          baseline.textContent = "비교 장비 확인 필요";
          difference.textContent = "비교 수치 정보 없음";
          difference.hidden = false;
        }
      },
    ).finally(() => {
      this.comparisonLoading = false;
      this.refreshComparisons();
    });
  }

  private renderComparisons(items: readonly InventoryItem[]): void {
    const equipped = items.filter((item) => item.equipped);
    const hasUnknownSlot = equipped.some((item) => !item.equipment || item.equipment.slot === "ring");
    if (this.comparisonStatus) this.comparisonStatus.textContent = "같은 슬롯의 장비 수치를 비교합니다.";
    for (const { listing, baseline, difference } of this.shopComparisons.values()) {
      const equipment = readEquipmentMetadata(listing.equipment);
      const sameSlot = equipment ? equipped.filter((item) => item.equipment?.slot === equipment.slot) : [];
      const current = !equipment || equipment.slot === "ring" || hasUnknownSlot || sameSlot.length > 1
        ? undefined : sameSlot[0] ?? null;
      const description = describeEquipmentComparison({
        name: listing.name,
        equipped: current?.itemKey === listing.itemKey,
        equipment,
      }, current);
      baseline.textContent = description.baseline;
      difference.textContent = description.difference;
      difference.hidden = description.difference.length === 0;
    }
  }

  /**
   * Sends one purchase of one unit — there is no quantity stepper, {@link
   * ClientMessage.UseItem}'s own "nothing more to say" minimalism applied to buying. Disables the
   * row's button until a terminal reply resolves it ({@link resolveShopAttempt}/{@link
   * applyShopDenied}), the same wait `acceptQuest` already holds its own button through.
   *
   * `pendingBuys` is checked before minting a nonce (design §9 D8): a click reaching here with one
   * already recorded — only possible via a reopened row that redrew itself disabled-and-pending,
   * since a live button is disabled for the whole in-flight window — is a resend of that same
   * attempt, not a new purchase, and must carry the identical nonce back out.
   */
  private buyItem(itemKey: string): void {
    const button = this.shopRows.get(itemKey);
    const npcObjectId = this.currentShopNpcId;
    if (!button || !npcObjectId || button.disabled) {
      return;
    }
    let nonce = this.pendingBuys.get(itemKey);
    if (nonce === undefined) {
      nonce = crypto.randomUUID();
      this.pendingBuys.set(itemKey, nonce);
    }
    button.disabled = true;
    button.textContent = "구매하는 중…";
    this.sendBuyItem(npcObjectId, itemKey, 1, nonce);
  }

  /**
   * Clears an in-flight purchase and restores the row to its pressable state — called on both a
   * successful buy and a refused one, {@link acceptQuest}'s "answer only ever comes from the
   * server" rule applied here too. Ignored for an item this panel is not currently selling, or one
   * with no purchase in flight, the same guard {@link applyQuestUpdate} gives a foreign quest id.
   *
   * **Known gap**: a successful buy has no message of its own to call this from — `ItemGranted`
   * carries no "this came from a shop" marker (design §9 D12 reuses it verbatim), so `WorldScene`
   * calls this on every `ItemGranted` for the item key regardless of cause. A monster dropping the
   * exact item being bought at the same moment would clear this early; harmless (the button simply
   * re-enables a beat sooner) but worth knowing rather than papering over.
   */
  resolveShopAttempt(itemKey: string): void {
    if (!this.pendingBuys.delete(itemKey)) {
      return;
    }
    const button = this.shopRows.get(itemKey);
    if (!button) {
      return;
    }
    button.disabled = false;
    button.textContent = "구매";
  }

  /** A `shop:buy` this panel's own NPC sent was refused — {@link resolveShopAttempt}'s own reset. */
  applyShopDenied(event: ShopDenied): void {
    if (event.action !== "buy") {
      return;
    }
    this.resolveShopAttempt(event.itemKey);
  }

  private renderQuest(state: QuestState): void {
    const section = document.createElement("section");
    section.className = "object__quest";

    const title = document.createElement("h3");
    title.className = "object__quest-title";
    title.textContent = state.title;

    // The giver's offer, drawn once: unlike the two lines below it, nothing the server later sends
    // rewrites it. Same textContent + pre-wrap treatment renderNotice gives a notice body.
    const summary = document.createElement("p");
    summary.className = "object__text";
    summary.textContent = state.summary;

    const objective = document.createElement("p");
    objective.className = "object__quest-objective";

    // A live region, because accepting redraws this line rather than moving focus, and the button
    // that did it is about to disappear — without this the panel would change with nothing said.
    const status = document.createElement("p");
    status.className = "object__quest-status";
    status.setAttribute("role", "status");

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "object__quest-accept";
    accept.textContent = "수락";
    accept.addEventListener("click", () => this.acceptQuest(state.questId));

    section.append(title, summary, objective, status, accept);
    this.body.append(section);

    const quest: OpenQuest = { root: section, objective, status, accept };
    this.quests.set(state.questId, quest);
    this.drawQuestState(quest, state);
  }

  /**
   * The three readings one quest block ever has. Called for the state the panel opened on and again
   * for every `quest:updated` that names it, so an accept, a kill and the kill that finishes it all
   * land here rather than in three separate paths that have to agree.
   */
  private drawQuestState(quest: OpenQuest, state: QuestState): void {
    quest.root.dataset.status = state.status;
    const offered = state.status === QuestStatus.Offered;
    const blocked = offered && state.blocked === true;
    quest.accept.hidden = !offered;
    quest.accept.disabled = blocked;
    quest.accept.title = blocked ? "선행 퀘스트를 먼저 완료하세요." : "";

    if (state.status === QuestStatus.Completed) {
      quest.objective.textContent = state.completionText;
      quest.status.textContent = "완료";
      return;
    }
    quest.objective.textContent = state.objectiveText;
    quest.status.textContent = blocked
      ? "선행 퀘스트를 먼저 완료하면 수락할 수 있습니다."
      : offered ? "아직 수락하지 않았습니다."
        : `진행 중 · ${state.killCount} / ${state.requiredCount}`;
  }

  /**
   * Sends the accept and waits for the server's own `quest:updated` to redraw the block — the
   * button never draws the accepted state itself. An accept the server ignores (an id this room
   * does not offer) therefore leaves the block visibly un-accepted instead of lying about it.
   *
   * The button is disabled rather than removed while that round trip is out: the accept is
   * idempotent server-side, but a second press before the reply is a wasted write, and leaving it
   * pressable would say nothing was sent. A reply that never arrives is not a dead end — stepping
   * off the tile and back on builds the block again, which is the same retry the quiz relies on.
   */
  private acceptQuest(questId: string): void {
    const quest = this.quests.get(questId);
    if (!quest || quest.accept.disabled) {
      return;
    }
    quest.accept.disabled = true;
    quest.status.textContent = "수락하는 중…";
    this.sendAcceptQuest(questId);
  }

  private renderQuiz(payload: QuizInteraction): void {
    const question = document.createElement("p");
    question.className = "object__text";
    question.textContent = payload.question;

    const list = document.createElement("div");
    list.className = "object__choices";
    const choices: HTMLButtonElement[] = [];
    for (const [index, label] of payload.choices.entries()) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "object__choice";
      choice.textContent = label;
      choice.setAttribute("aria-pressed", "false");
      choice.addEventListener("click", () => this.answer(index));
      choices.push(choice);
      list.append(choice);
    }

    // Carries the wait as well as the verdict: grading is a round trip, and a button that just
    // highlights itself gives no sign that anything was sent.
    const result = document.createElement("p");
    result.className = "object__result";
    result.setAttribute("role", "status");

    this.body.append(question, list, result);
    this.quiz = { objectId: payload.objectId, answered: null, choices, result };
  }

  /**
   * Choices stay enabled until a verdict lands. A dropped reply would otherwise leave the quiz
   * permanently unanswerable, and answering twice costs nothing — the second answer becomes the
   * one `showQuizResult` matches, so the first verdict is discarded on arrival.
   */
  private answer(index: number): void {
    const quiz = this.quiz;
    if (!quiz) {
      return;
    }
    quiz.answered = index;
    for (const [at, choice] of quiz.choices.entries()) {
      choice.setAttribute("aria-pressed", String(at === index));
      choice.classList.remove("object__choice--correct", "object__choice--wrong");
    }
    quiz.result.className = "object__result";
    quiz.result.textContent = "채점하는 중…";
    this.sendAnswer(quiz.objectId, index);
  }

  private readonly handleClose = (): void => {
    this.close();
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.isOpen) {
      return;
    }
    // Escape in the chat composer clears the composer; that keystroke must not also close the
    // panel behind it. The composer blurs itself in the target phase, before this bubble-phase
    // listener runs, so by then `document.activeElement` is already <body> — only `event.target`
    // still names the field the keystroke came from. Same ordering trap as MovementKeys.handleFocusIn.
    if (isTextEntry(event.target as Element | null)) {
      return;
    }
    event.preventDefault();
    this.close();
  };

  /**
   * The chat composer yields Enter to any focused button, so focus left on 닫기 or on a choice
   * would silently stop Enter from opening the composer. Same fix homeButton applies to itself
   * after a pointer click, except that here the element is going away regardless.
   */
  private releaseFocus(): void {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.root.contains(focused)) {
      focused.blur();
    }
  }
}
