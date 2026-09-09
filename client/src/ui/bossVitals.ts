/**
 * A boss's health, fixed to the top of the screen.
 *
 * The trigger is `MonsterHealthBars`' and not a new one: `Monster` carries no HP, so a
 * `MonsterHit` is the only way a monster's health ever reaches this client (design §5.2) — a boss
 * nobody has swung at, and that has not swung back, has no number to draw. Only the placement
 * differs (`docs/design-phase-i-boss-monster.md` §10-3). A bar over the head is sized for a fight
 * that lasts three hits; this one lasts minutes, runs across a wander box wider than the viewport
 * and is fought by a group, so the readout is pinned to the screen instead of to the sprite.
 *
 * One slot, because a room holds one boss row. If a second ever shared a view radius, the last one
 * hit would take the panel — the alternative is a stack of boss frames, which is a different
 * feature.
 *
 * Owns shared DOM, so `destroy()` is mandatory before a successor is built — a room hop does that.
 */
export class BossVitals {
  private readonly panel = document.querySelector<HTMLElement>("#boss-vitals")!;
  private readonly name = document.querySelector<HTMLElement>("#boss-vitals-name")!;
  private readonly count = document.querySelector<HTMLElement>("#boss-vitals-count")!;
  private readonly track = document.querySelector<HTMLElement>("#boss-vitals-track")!;
  private readonly fill = document.querySelector<HTMLElement>("#boss-vitals-fill")!;

  /** Which boss the panel is drawn for. Null while it is hidden, which is most of the time. */
  private shownFor: string | null = null;

  constructor() {
    // A room hop hands these nodes to a successor mid-fight, so the panel starts from the state a
    // fresh arrival is in: nothing has been hit, so there is nothing to draw.
    this.panel.hidden = true;
  }

  /**
   * Records a hit on a boss and reveals (or moves) the bar. `hpMax` rides in on every hit for
   * `MonsterHealthBars.applyHit`'s reason: the scale is the server's to state, never this
   * bundle's to remember. `name` likewise comes from the caller, which resolved it from the kind
   * on the wire.
   */
  applyHit(monsterId: string, name: string, hpRemaining: number, hpMax: number): void {
    const hp = Math.max(0, Math.min(hpMax, hpRemaining));
    const ratio = hpMax > 0 ? hp / hpMax : 0;
    if (this.shownFor !== monsterId) {
      this.shownFor = monsterId;
      this.name.textContent = name;
      // Last, so the entrance animation runs over a panel that already reads correctly.
      this.panel.hidden = false;
    }
    this.count.textContent = `${hp} / ${hpMax}`;
    this.fill.style.transform = `scaleX(${ratio})`;
    this.track.setAttribute("aria-valuenow", String(hp));
    this.track.setAttribute("aria-valuemax", String(hpMax));
  }

  /**
   * Drops the panel if it is this monster's. Called for death, for leaving the view radius, and
   * for a respawn reusing the id — all three mean the next thing under that id has not been hit
   * yet. Named ids rather than a bare `hide()` so a squirrel dying next to the boss cannot clear
   * the boss's bar.
   */
  release(monsterId: string): void {
    if (this.shownFor !== monsterId) {
      return;
    }
    this.shownFor = null;
    this.panel.hidden = true;
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. Every node here is shared,
   * so without this the boss bar of the room just left would hang over the new one — and the two
   * hunting zones each have a boss, so that is a reachable state rather than a theoretical one.
   */
  destroy(): void {
    this.shownFor = null;
    this.panel.hidden = true;
  }
}
