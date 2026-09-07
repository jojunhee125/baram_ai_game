/** Matches ItemToasts' TOAST_LIFETIME_MS: long enough to read, short enough not to linger. */
const BANNER_LIFETIME_MS = 3200;

/**
 * Single-slot "you can't go through this door" notice. Unlike {@link ItemToasts} there is no
 * per-item key and no repeat count to fold into — a denial is just the server's message, shown
 * and then hidden, so one host node and one timer is all this owns.
 */
export class PortalDenialBanner {
  private readonly host = document.querySelector<HTMLElement>("#portal-denial-banner")!;
  private timer: number | null = null;

  show(message: string): void {
    this.host.textContent = message;
    this.host.hidden = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.host.hidden = true;
    }, BANNER_LIFETIME_MS);
  }

  destroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.host.hidden = true;
  }
}
