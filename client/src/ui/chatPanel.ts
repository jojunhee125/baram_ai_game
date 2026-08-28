import { MAX_CHAT_LENGTH, type ChatBroadcast } from "@zep-test/shared";
import { isTextEntry } from "../input/textEntry";

const MAX_LOG_ROWS = 50;

/** Composer and message log. Speech bubbles live in the canvas; see ChatBubbles. */
export class ChatPanel {
  private readonly root = document.querySelector<HTMLElement>("#chat")!;
  private readonly log = document.querySelector<HTMLElement>("#chat-log")!;
  private readonly empty = document.querySelector<HTMLElement>("#chat-empty")!;
  private readonly input = document.querySelector<HTMLInputElement>("#chat-input")!;

  constructor(private readonly onSend: (text: string) => void) {
    this.input.maxLength = MAX_CHAT_LENGTH;
    this.input.addEventListener("keydown", this.handleInputKey);
    window.addEventListener("keydown", this.handleGlobalKey);
    this.root.hidden = false;
  }

  /**
   * Mandatory before constructing a successor (a portal hop does): the DOM nodes are shared, so
   * an abandoned panel's keydown listener still runs first, sends to the room it left, and
   * empties the composer before the live panel ever sees the text.
   */
  destroy(): void {
    this.input.removeEventListener("keydown", this.handleInputKey);
    window.removeEventListener("keydown", this.handleGlobalKey);
  }

  append(message: ChatBroadcast, isSelf: boolean): void {
    this.empty.hidden = true;

    const row = document.createElement("p");
    row.className = isSelf ? "chat__row chat__row--self" : "chat__row";

    const who = document.createElement("span");
    who.className = "chat__nickname";
    who.textContent = message.nickname;

    const body = document.createElement("span");
    body.className = "chat__text";
    // textContent, never innerHTML: this is unsanitised text from another player.
    body.textContent = message.text;

    row.append(who, body);
    this.log.append(row);

    const rows = this.log.querySelectorAll(".chat__row");
    for (let i = 0; i < rows.length - MAX_LOG_ROWS; i += 1) {
      rows[i]?.remove();
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  private readonly handleGlobalKey = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.isComposing || this.root.hidden) {
      return;
    }
    // The send handler blurs the composer, and this same keydown then bubbles up here —
    // without this the avatar would stay locked out of movement after every message.
    if (event.target === this.input) {
      return;
    }
    // Leave Enter alone while typing, or while a focused button owns it (boot retry, and a HUD
    // control a keyboard user tabbed to). Clicking a HUD control does not strand the composer:
    // those buttons blur themselves on a pointer activation for exactly this reason.
    if (isTextEntry(document.activeElement) || document.activeElement instanceof HTMLButtonElement) {
      return;
    }
    event.preventDefault();
    this.input.focus();
  };

  private readonly handleInputKey = (event: KeyboardEvent): void => {
    // A Hangul composition is committed with Enter; that keypress must not also send.
    if (event.isComposing) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.send();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.input.value = "";
      this.input.blur();
    }
  };

  private send(): void {
    const text = this.input.value.trim();
    this.input.value = "";
    // Blur so movement keys work again straight after sending.
    this.input.blur();
    if (text.length > 0) {
      this.onSend(text.slice(0, MAX_CHAT_LENGTH));
    }
  }
}
