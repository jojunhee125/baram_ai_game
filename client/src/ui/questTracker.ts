import { QuestStatus, type QuestState } from "@zep-test/shared";

/** One tracked quest's nodes, kept so an update patches the row instead of rebuilding the list. */
interface TrackedRow {
  root: HTMLLIElement;
  count: HTMLElement;
  fill: HTMLElement;
  track: HTMLElement;
  objective: HTMLElement;
}

/**
 * What the account is carrying, top-left under the vitals panel (roadmap R03).
 *
 * Fed only by `quest:updated`, which the server sends once per accepted quest right after join and
 * again on every change — so this holds no quest table, no polling and no "loading" state: an empty
 * list means nothing is accepted. `Offered` never appears here; an offer lives in the NPC panel,
 * and a row in the tracker is by definition something already taken on.
 *
 * Rows survive completion rather than clearing themselves. There is no turn-in until R04 hands
 * quests a payout, so "완료" *is* the end state, and a row that vanished at the last kill would
 * take the only record of it with it.
 *
 * Owns shared DOM — the nodes outlive the scene, like every other panel — so `destroy()` is
 * mandatory before a room hop constructs a successor.
 */
export class QuestTracker {
  private readonly panel = document.querySelector<HTMLElement>("#quest-tracker")!;
  private readonly list = document.querySelector<HTMLElement>("#quest-tracker-list")!;
  private readonly rows = new Map<string, TrackedRow>();

  constructor() {
    // The predecessor's rows are still on these nodes after a room hop; the server re-sends every
    // accepted quest on the join that follows, so starting empty loses nothing and starting dirty
    // would show the previous room's reading until the first message landed.
    this.clear();
  }

  /**
   * Draws one quest's state, inserting the row on first sight and patching it after that.
   * Re-applying an identical state is a no-op in effect, which matters: the join replay and a
   * change that happens to arrive in the same frame both go through here.
   */
  apply(state: QuestState): void {
    if (state.status === QuestStatus.Offered) {
      return;
    }
    const row = this.rows.get(state.questId) ?? this.insert(state);
    row.root.dataset.status = state.status;
    row.objective.textContent =
      state.status === QuestStatus.Completed ? state.completionText : state.objectiveText;
    row.count.textContent = `${state.killCount} / ${state.requiredCount}`;
    // Clamped, never trusted to be in range: the bar is drawn from two numbers the server owns, and
    // a requirement lowered by a deploy leaves stored rows whose count is above the new one
    // (r03-quest-and-village.md, "남은 한계").
    const ratio =
      state.requiredCount > 0
        ? Math.max(0, Math.min(1, state.killCount / state.requiredCount))
        : 1;
    row.fill.style.transform = `scaleX(${ratio})`;
    row.track.setAttribute("aria-valuenow", String(state.killCount));
    row.track.setAttribute("aria-valuemax", String(state.requiredCount));
    this.panel.hidden = false;
  }

  /**
   * Mandatory before constructing a successor, which a room hop does. Every node here is shared, so
   * an abandoned instance would leave the next room's tracker holding rows nobody is updating.
   */
  destroy(): void {
    this.clear();
  }

  private insert(state: QuestState): TrackedRow {
    const root = document.createElement("li");
    root.className = "quests__row";

    const head = document.createElement("p");
    head.className = "quests__row-head";
    const title = document.createElement("span");
    title.className = "quests__title";
    title.textContent = state.title;
    const count = document.createElement("span");
    count.className = "quests__count";
    head.append(title, count);

    const track = document.createElement("div");
    track.className = "quests__track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `${state.title} 진행도`);
    track.setAttribute("aria-valuemin", "0");
    const fill = document.createElement("span");
    fill.className = "quests__fill";
    track.append(fill);

    // pre-wrap and the server's own string, like every other authored line the client draws
    // (ObjectPanel.renderNotice): the objective is copy, not a sentence composed here.
    const objective = document.createElement("p");
    objective.className = "quests__objective";

    root.append(head, track, objective);
    this.list.append(root);

    const row: TrackedRow = { root, count, fill, track, objective };
    this.rows.set(state.questId, row);
    return row;
  }

  private clear(): void {
    this.rows.clear();
    this.list.replaceChildren();
    this.panel.hidden = true;
  }
}
