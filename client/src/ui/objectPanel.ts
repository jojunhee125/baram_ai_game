import {
  InteractableKind,
  QuestStatus,
  type InteractableEntered,
  type LinkInteraction,
  type NpcInteraction,
  type QuestState,
  type QuizInteraction,
  type QuizResult,
} from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";

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
  private currentBlocksMovement = true;

  constructor(
    private readonly sendAnswer: (objectId: string, choiceIndex: number) => void,
    private readonly sendAcceptQuest: (questId: string) => void,
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
    this.currentBlocksMovement = payload.blocksMovement;
    this.quiz = null;
    this.quests.clear();
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
    this.releaseFocus();
    this.root.hidden = true;
    this.body.replaceChildren();
    this.link.hidden = true;
    this.link.removeAttribute("href");
    this.kind.textContent = "";
    this.heading.textContent = "";
    this.quiz = null;
    this.quests.clear();
    this.currentBlocksMovement = true; // back to the safe default for whatever opens next
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. The keydown listener is on
   * `window` and every node here is shared, so an abandoned instance would keep answering Escape
   * and keep sending answers to the room it left.
   */
  destroy(): void {
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
    quest.accept.hidden = !offered;
    quest.accept.disabled = false;

    if (state.status === QuestStatus.Completed) {
      quest.objective.textContent = state.completionText;
      quest.status.textContent = "완료";
      return;
    }
    quest.objective.textContent = state.objectiveText;
    quest.status.textContent = offered
      ? "아직 수락하지 않았습니다."
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
