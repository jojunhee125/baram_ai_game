import {
  CLASS_DEFINITIONS,
  isSkillKey,
  SKILL_DEFINITIONS,
  type PlayerClassKey,
  type SkillDenied,
  type SkillDenialReason,
  type SkillKey,
} from "@zep-test/shared";

/** Sends one cast. Returns whether it left — a scene mid-transition refuses, {@link SwingAttempt}'s own shape. */
export type CastAttempt = (skillKey: SkillKey, nonce: string) => boolean;

/** How long a denial stays on screen. Long enough to read one short line, short enough not to stack up. */
const DENIAL_MS = 1800;

/**
 * Why a cast was refused, in the player's words. Keyed by the server's own
 * {@link SkillDenialReason} so a reason added server-side fails to compile here rather than
 * silently showing nothing.
 *
 * `no-class` is phrased as an instruction rather than an error because it is the one reason the
 * player can act on immediately — the picker is two clicks away in the character menu.
 */
const DENIAL_TEXT: Readonly<Record<SkillDenialReason, string>> = {
  "no-class": "직업을 먼저 선택하세요",
  "unknown-skill": "사용할 수 없는 기술입니다",
  "on-cooldown": "아직 준비되지 않았습니다",
  "insufficient-mp": "마력이 부족합니다",
  "no-target": "대상이 없습니다",
  "out-of-range": "거리가 너무 멉니다",
  "target-dead": "대상이 쓰러져 있습니다",
};

/** One slot's live DOM and the timer that clears its cooldown. */
interface Slot {
  skillKey: SkillKey;
  root: HTMLLIElement;
  cooldownFill: HTMLElement;
  timer: number | undefined;
}

/**
 * The skill slots, and the only place a `skill:use` is sent from (roadmap R05-c).
 *
 * Built from `CLASS_DEFINITIONS[classKey].skillKeys` rather than from static markup: that list is
 * one entry per class today and gains a second later (`shared/src/skills.ts` doc comment), and a
 * copy in `index.html` would be the second place it lives.
 *
 * **Every gate here is feedback, never authority.** The server re-checks class, cooldown, MP,
 * target and range on its own clock (`handleUseSkill`), exactly as `AttackKey`'s cooldown mirror
 * is feedback for `ATTACK_COOLDOWN_MS`. What this class refuses locally, it refuses only to avoid
 * sending a message whose denial is already certain.
 *
 * The cooldown mirror runs on `SkillDefinition.cooldownMs` as a *duration* and deliberately
 * ignores `SkillUsed.cooldownUntil`, which is a server `Date.now()` (`metaverseRoom.ts:1132`):
 * subtracting it from a client clock would fold clock skew straight into the bar, and a client
 * running a few seconds behind would show a slot ready that the server still refuses.
 *
 * Owns shared DOM and one timer per slot, so `destroy()` is mandatory before a successor is built.
 */
export class SkillBar {
  private readonly list = document.querySelector<HTMLUListElement>("#skills")!;
  private readonly denial = document.querySelector<HTMLElement>("#skills-denial")!;
  private readonly animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  private slots: Slot[] = [];
  private denialTimer: number | undefined;
  /** Last MP the gauge reported, so an unaffordable slot can be dimmed before it is pressed. */
  private mp = 0;

  constructor(private readonly onCast: CastAttempt) {
    // A room hop hands these shared nodes to a successor: start from "no class known yet" rather
    // than from whatever the previous room's class sync left drawn.
    this.applyClass(null);
  }

  /**
   * The account's class, or the lack of one. Rebuilds the slots outright instead of diffing them:
   * a class is chosen once per account (design D1), so this runs at most twice in a session — once
   * on the join sync and once on the pick.
   */
  applyClass(classKey: PlayerClassKey | null): void {
    this.clearSlots();
    if (classKey === null) {
      this.list.hidden = true;
      return;
    }
    for (const [index, skillKey] of CLASS_DEFINITIONS[classKey].skillKeys.entries()) {
      this.slots.push(this.buildSlot(skillKey, index));
    }
    this.list.hidden = this.slots.length === 0;
    // Slots are built in whatever MP state the session is already in — the class sync and the MP
    // reading arrive in the same `ClassChanged` — so the first affordability pass happens here
    // rather than waiting for `applyMp` to see a *change*, which a player who joined empty would
    // never produce.
    this.renderAffordability();
  }

  /**
   * One hotkey press, by slot position — `Digit1` is slot 0. Returns whether a cast was actually
   * sent, which is what the input uses to decide it consumed the key.
   */
  castSlot(index: number): boolean {
    const slot = this.slots[index];
    if (slot === undefined) {
      return false;
    }
    // Refused locally only where the denial is already certain. Range and target are not checked
    // here at all — the server picks the target (design D6) and the client does not know what is
    // in range, so those two always make the round trip and come back as a readable reason.
    if (slot.timer !== undefined) {
      this.showDenialText(DENIAL_TEXT["on-cooldown"]);
      return false;
    }
    if (this.mp < SKILL_DEFINITIONS[slot.skillKey].mpCost) {
      this.showDenialText(DENIAL_TEXT["insufficient-mp"]);
      return false;
    }
    return this.onCast(slot.skillKey, crypto.randomUUID());
  }

  /**
   * The server accepted a cast of ours. Starts the slot's cooldown mirror from the definition's
   * own duration — see this class's doc comment for why not from `SkillUsed.cooldownUntil`.
   */
  beginCooldown(skillKey: string): void {
    if (!isSkillKey(skillKey)) {
      return;
    }
    const slot = this.slots.find((candidate) => candidate.skillKey === skillKey);
    if (slot === undefined) {
      return;
    }
    const { cooldownMs } = SKILL_DEFINITIONS[skillKey];
    window.clearTimeout(slot.timer);
    slot.root.dataset.state = "cooling";
    slot.cooldownFill.style.transitionDuration = "0ms";
    slot.cooldownFill.style.transform = "scaleX(0)";
    if (this.animate) {
      // Commits the reset as its own style change so the growth below has something to start
      // from — `playerVitals.beginAttackCooldown`'s own reflow trick.
      void slot.cooldownFill.offsetWidth;
      slot.cooldownFill.style.transitionDuration = `${cooldownMs}ms`;
      slot.cooldownFill.style.transform = "scaleX(1)";
    }
    slot.timer = window.setTimeout(() => {
      slot.timer = undefined;
      delete slot.root.dataset.state;
      slot.cooldownFill.style.transitionDuration = "0ms";
      slot.cooldownFill.style.transform = "scaleX(1)";
      this.renderAffordability();
    }, cooldownMs);
    this.renderAffordability();
  }

  /**
   * The MP gauge's current reading, so a slot the player cannot pay for reads as unavailable.
   * Called every frame by the scene (MP recovers on its own, with no message to hang this on), so
   * an unchanged value returns before touching the DOM.
   */
  applyMp(mp: number): void {
    if (mp === this.mp) {
      return;
    }
    this.mp = mp;
    this.renderAffordability();
  }

  /** A cast this client sent was refused. `nonce` is not read: only the latest denial is shown. */
  applyDenied(event: SkillDenied): void {
    this.showDenialText(DENIAL_TEXT[event.reason] ?? "기술을 사용할 수 없습니다");
  }

  /** Mandatory before constructing a successor, which a room hop does: every node here is shared. */
  destroy(): void {
    this.clearSlots();
    window.clearTimeout(this.denialTimer);
    this.denialTimer = undefined;
    this.list.hidden = true;
    this.denial.hidden = true;
  }

  private buildSlot(skillKey: SkillKey, index: number): Slot {
    const definition = SKILL_DEFINITIONS[skillKey];
    const root = document.createElement("li");
    root.className = "skills__slot";

    const key = document.createElement("kbd");
    key.className = "skills__key";
    key.textContent = String(index + 1);

    const name = document.createElement("span");
    name.className = "skills__name";
    name.textContent = definition.label;

    const cost = document.createElement("span");
    cost.className = "skills__cost";
    cost.textContent = `${definition.mpCost} MP`;

    const cooldown = document.createElement("span");
    cooldown.className = "skills__cooldown";
    cooldown.setAttribute("aria-hidden", "true");
    const cooldownFill = document.createElement("span");
    cooldownFill.className = "skills__cooldown-fill";
    cooldownFill.style.transitionDuration = "0ms";
    cooldownFill.style.transform = "scaleX(1)";
    cooldown.append(cooldownFill);

    root.append(key, name, cost, cooldown);
    this.list.append(root);
    return { skillKey, root, cooldownFill, timer: undefined };
  }

  /**
   * Dims what cannot be paid for. Skipped for a slot already reading `cooling`: one unavailable
   * state at a time, and the cooldown is the more specific of the two.
   */
  private renderAffordability(): void {
    for (const slot of this.slots) {
      if (slot.timer !== undefined) {
        continue;
      }
      if (this.mp < SKILL_DEFINITIONS[slot.skillKey].mpCost) {
        slot.root.dataset.state = "unaffordable";
      } else {
        delete slot.root.dataset.state;
      }
    }
  }

  private showDenialText(text: string): void {
    this.denial.textContent = text;
    this.denial.hidden = false;
    window.clearTimeout(this.denialTimer);
    this.denialTimer = window.setTimeout(() => {
      this.denialTimer = undefined;
      this.denial.hidden = true;
    }, DENIAL_MS);
  }

  private clearSlots(): void {
    for (const slot of this.slots) {
      window.clearTimeout(slot.timer);
      slot.root.remove();
    }
    this.slots = [];
  }
}
