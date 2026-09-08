import {
  InteractableKind,
  type InteractableEntered,
  type LinkInteraction,
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

  constructor(private readonly sendAnswer: (objectId: string, choiceIndex: number) => void) {
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

  open(payload: InteractableEntered): void {
    this.quiz = null;
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
        this.renderNotice(payload);
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

  close(): void {
    this.releaseFocus();
    this.root.hidden = true;
    this.body.replaceChildren();
    this.link.hidden = true;
    this.link.removeAttribute("href");
    this.kind.textContent = "";
    this.heading.textContent = "";
    this.quiz = null;
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
