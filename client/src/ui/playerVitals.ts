import {
  ATTACK_COOLDOWN_MS,
  COMBAT_EXIT_MS,
  COMBAT_RECOVERY_HP_PER_TICK,
  MONSTER_TICK_MS,
  PLAYER_MAX_HP,
  type PlayerHit,
} from "@zep-test/shared";

/** Below this fraction the bar turns amber, and below the next one it turns red. */
const LOW_RATIO = 0.5;
const CRITICAL_RATIO = 0.25;

/**
 * How long the empty bar stays on screen after a death before it refills. Long enough to read as
 * "you died", short enough that the player is walking again before it clears.
 */
const REVIVAL_HOLD_MS = 700;

/**
 * The local player's health, and the key that spends it.
 *
 * Health is never in `RoomState` and never arrives on join: joining or changing rooms always
 * restores it in full, so this starts at `PLAYER_MAX_HP` and waits for a `PlayerHit` to say
 * otherwise (design §6.3). Between hits it runs the server's own recovery curve locally —
 * `COMBAT_EXIT_MS` of quiet, then `COMBAT_RECOVERY_HP_PER_TICK` every `MONSTER_TICK_MS` — because
 * recovery deliberately sends no message. That local number is an estimate and is treated as one:
 * the next `PlayerHit` overwrites it outright rather than being reconciled with it.
 *
 * Owns shared DOM and two timers, so `destroy()` is mandatory before a successor is built.
 */
export class PlayerVitals {
  private readonly panel = document.querySelector<HTMLElement>("#vitals")!;
  private readonly count = document.querySelector<HTMLElement>("#vitals-count")!;
  private readonly track = document.querySelector<HTMLElement>("#vitals-track")!;
  private readonly fill = document.querySelector<HTMLElement>("#vitals-fill")!;
  private readonly cooldown = document.querySelector<HTMLElement>("#vitals-cooldown")!;
  private readonly attackStatus = document.createElement("span");
  /**
   * Read once rather than per swing: a change of preference mid-session is not worth a listener,
   * and the timer below is the source of truth for the cooldown either way.
   */
  private readonly animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  private hp = PLAYER_MAX_HP;
  /** The server's, taken from the last hit. Sent every time so this bundle holds no stat table. */
  private hpMax = PLAYER_MAX_HP;
  /** When the next local recovery tick is due; infinite while there is nothing to recover. */
  private nextRecoveryAt = Number.POSITIVE_INFINITY;
  private cooldownTimer: number | undefined;
  private revivalTimer: number | undefined;

  constructor() {
    this.attackStatus.className = "vitals__attack-status";
    this.attackStatus.textContent = "공격 준비";
    this.panel.querySelector(".vitals__hint")!.append(this.attackStatus);
    delete this.panel.dataset.attack;
    this.cooldown.style.transitionDuration = "0ms";
    this.cooldown.style.transform = "scaleX(1)";
    // A room hop hands these nodes to a successor mid-fight, so the panel starts from the state a
    // fresh arrival is in — full health — rather than from whatever the last room left drawn.
    this.panel.hidden = true;
    this.render();
  }

  /**
   * Puts the panel on screen. Called on the first monster this room shows, so a room without
   * monsters never draws a health bar for a fight it cannot have.
   */
  reveal(): void {
    this.panel.hidden = false;
  }

  /**
   * The server's number, which always wins over the locally estimated recovery.
   *
   * `hpRemaining === 0` is death. The walk back to the home tile is not this class's business —
   * it arrives as the existing `Teleported` — so all that happens here is that the empty bar is
   * held long enough to be seen and then refilled, which is what the server has already done.
   */
  applyHit(event: PlayerHit): void {
    this.reveal();
    window.clearTimeout(this.revivalTimer);
    this.revivalTimer = undefined;

    this.hpMax = event.hpMax > 0 ? event.hpMax : PLAYER_MAX_HP;
    this.hp = Math.max(0, Math.min(this.hpMax, event.hpRemaining));
    this.nextRecoveryAt = performance.now() + COMBAT_EXIT_MS;
    this.render();

    if (event.hpRemaining > 0) {
      return;
    }
    this.revivalTimer = window.setTimeout(() => {
      this.revivalTimer = undefined;
      this.hp = this.hpMax;
      this.nextRecoveryAt = Number.POSITIVE_INFINITY;
      this.render();
    }, REVIVAL_HOLD_MS);
  }

  /** Called every frame. Does nothing at full health, which is every room but a hunting ground. */
  update(): void {
    if (this.hp >= this.hpMax) {
      return;
    }
    const now = performance.now();
    if (now < this.nextRecoveryAt) {
      return;
    }
    // Counted rather than stepped one tick per frame: a backgrounded tab stops rendering, and the
    // bar has to come back correct rather than resume where it stopped.
    const ticks = Math.floor((now - this.nextRecoveryAt) / MONSTER_TICK_MS) + 1;
    this.nextRecoveryAt += ticks * MONSTER_TICK_MS;
    this.hp = Math.min(this.hpMax, this.hp + ticks * COMBAT_RECOVERY_HP_PER_TICK);
    this.render();
  }

  /**
   * Mirrors the server's ATTACK_COOLDOWN_MS as feedback, never as the guard — the guard is the
   * server's, and the input's own gate is in `AttackKey`. The timer, not the transition, is what
   * says when the window is over, so this reads the same with animation turned off.
   */
  beginAttackCooldown(): void {
    window.clearTimeout(this.cooldownTimer);
    this.panel.dataset.attack = "cooling";
    this.attackStatus.textContent = "재사용 대기";
    this.cooldown.style.transitionDuration = "0ms";
    this.cooldown.style.transform = "scaleX(0)";
    if (this.animate) {
      // Commits the reset as its own style change, so the growth below has something to start
      // from instead of being coalesced into a no-op.
      void this.cooldown.offsetWidth;
      this.cooldown.style.transitionDuration = `${ATTACK_COOLDOWN_MS}ms`;
      this.cooldown.style.transform = "scaleX(1)";
    }
    this.cooldownTimer = window.setTimeout(this.endAttackCooldown, ATTACK_COOLDOWN_MS);
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. Both timers outlive the
   * scene restart and every node here is shared, so an abandoned instance would refill the live
   * panel's cooldown bar and revive a player the new room never killed.
   */
  destroy(): void {
    window.clearTimeout(this.cooldownTimer);
    window.clearTimeout(this.revivalTimer);
    this.panel.hidden = true;
    delete this.panel.dataset.attack;
    this.attackStatus.remove();
  }

  private readonly endAttackCooldown = (): void => {
    this.cooldownTimer = undefined;
    delete this.panel.dataset.attack;
    this.attackStatus.textContent = "공격 준비";
    this.cooldown.style.transitionDuration = "0ms";
    this.cooldown.style.transform = "scaleX(1)";
  };

  private render(): void {
    const ratio = this.hpMax > 0 ? Math.max(0, Math.min(1, this.hp / this.hpMax)) : 0;
    this.count.textContent = `${this.hp} / ${this.hpMax}`;
    this.fill.style.transform = `scaleX(${ratio})`;
    this.track.setAttribute("aria-valuenow", String(this.hp));
    this.track.setAttribute("aria-valuemax", String(this.hpMax));
    this.panel.dataset.level = levelOf(ratio);
  }
}

function levelOf(ratio: number): string {
  if (ratio <= CRITICAL_RATIO) {
    return "critical";
  }
  return ratio <= LOW_RATIO ? "low" : "ok";
}
