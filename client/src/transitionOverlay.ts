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
/** Short: a death notice only has to be read once, not lingered on like a portal denial. */
const DEATH_NOTICE_MS = 1600;

const overlay = document.querySelector<HTMLElement>("#transition")!;
const notice = document.querySelector<HTMLElement>("#transition-notice")!;
const deathNotice = document.querySelector<HTMLElement>("#death-notice")!;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let noticeTimer: number | undefined;
let deathNoticeTimer: number | undefined;

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

/**
 * The death notice, deliberately its own element and timer rather than a call to
 * `showTransitionNotice()`. Sharing `#transition-notice`/`noticeTimer` with the portal-denial
 * banner would let the two clobber each other's timer if a death and a denied portal ever land in
 * the same window (design-phase-x-lowcost-ux.md §2.3 option B).
 */
export function showDeathNotice(message: string): void {
  // Both banners sit in the same slot (style.css `.notice` and `#portal-denial-banner` share
  // `top: var(--space-3)`; the row below is reserved for `.boss-vitals`, style.css:446-450). Moving
  // this one down would land on the boss bar, so instead death takes the row: it is the more
  // assertive of the two, and a stale "이동하지 못했습니다" under it is not worth the overlap.
  notice.hidden = true;
  window.clearTimeout(noticeTimer);
  deathNotice.textContent = message;
  deathNotice.hidden = false;
  window.clearTimeout(deathNoticeTimer);
  deathNoticeTimer = window.setTimeout(() => {
    deathNotice.hidden = true;
  }, DEATH_NOTICE_MS);
}
