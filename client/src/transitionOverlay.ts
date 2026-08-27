/**
 * The screen wipe for a portal hop, plus the notice shown when one fails.
 *
 * A DOM overlay rather than a Phaser camera fade: the camera only covers the canvas, leaving the
 * chat panel visible mid-transition, and it would be destroyed along with the scene it belongs
 * to — the fade has to outlive the scene restart it hides. Same shape as `bootStatus.ts`, which
 * is the same thing at a different moment: a short loading screen over the stage.
 */
const FADE_MS = 200;
const NOTICE_MS = 6000;

const overlay = document.querySelector<HTMLElement>("#transition")!;
const notice = document.querySelector<HTMLElement>("#transition-notice")!;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let noticeTimer: number | undefined;

/**
 * Timed rather than awaiting `transitionend`: reduced motion drops the transition entirely, and
 * an event that never fires would hang the transition on a black screen forever.
 */
function settle(): Promise<void> {
  if (reducedMotion.matches) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.setTimeout(resolve, FADE_MS);
  });
}

export function fadeToBlack(): Promise<void> {
  window.clearTimeout(noticeTimer);
  notice.hidden = true;
  overlay.dataset["state"] = "opaque";
  return settle();
}

export function fadeFromBlack(): Promise<void> {
  overlay.dataset["state"] = "clear";
  return settle();
}

/** Transient, because the player keeps playing in the room they never left. */
export function showTransitionNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice.hidden = true;
  }, NOTICE_MS);
}
