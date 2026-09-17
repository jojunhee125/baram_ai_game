import { InteractableKind } from "@zep-test/shared";
import type { InteractableDefinition } from "./contracts";
// Imported as a value, not just as a type — `contracts.ts`'s own note on `InteractableKind`: the
// objective below names a kind, and the kind table is where that name has to come from.
import { MonsterKind, type MonsterSpawnDefinition } from "./monsterDefinitions";

/**
 * One quest: an NPC offers it, the account accepts it, and kills of one monster kind advance it
 * (roadmap R03, `docs/roadmap.md` §5 "R03 — 목표를 가진 마을"). Authored in code beside
 * `INTERACTABLE_DEFINITIONS` and `MONSTER_SPAWN_DEFINITIONS`, for their reason: the deploy is the
 * edit permission, and a map regeneration must not be able to delete content.
 *
 * Exactly one objective, and that objective is always a kill count — the roadmap's own limit for
 * this step ("초기에는 처치 목표 하나로 제한한다"). A shape with an objective *array* or a
 * discriminated objective union would be inventing the branch that R03 explicitly defers; the day
 * a second objective kind exists is the day this becomes a union, and nothing stored depends on
 * the shape (`quest_progress` holds one counter, keyed by quest).
 *
 * Completing a quest pays out {@link reward} at most once per account, settled through R04-b's
 * ledger (`MetaverseRoom.recordQuestKill`/`hydrateQuestCache`, `docs/r04-settlement.md` §4 D2/D6)
 * rather than written here directly — this table only ever says *what* to pay, never *whether* an
 * account has already been paid for it.
 */
export interface QuestDefinition {
  /**
   * Stable key, unique across the table. It is written into `quest_progress.quest_id` and crosses
   * the wire both ways (`QuestUpdated.questId`, `AcceptQuestRequest.questId`), so — like an item
   * key or a portal id — it must never be a table index: reordering the rows would reattach every
   * stored row to a different quest.
   */
  id: string;
  /**
   * The {@link InteractableBase.id} of the NPC that offers it. The link points this way, from the
   * quest to the giver, so the object table stays exactly as it is: an NPC row knows nothing about
   * quests, and `MetaverseRoom` resolves the offer when the panel opens. Boot validation refuses an
   * id that is not an `Npc` row.
   */
  giverObjectId: string;
  /** Panel heading, shown as written — `InteractableBase.title`'s own terms. */
  title: string;
  /** What the giver says when offering it. Newlines are significant; rendered as text, never markup. */
  summary: string;
  /**
   * The objective in the player's words, e.g. "다람쥐 3마리 처치". Authored rather than composed
   * from {@link QuestObjective} at runtime: the two numbers below drive a progress bar, and a
   * sentence built by string-joining a monster kind's enum value is how a UI ends up reading
   * "squirrel 3마리". The count appears in both places on purpose — boot validation checks they
   * agree so the copy cannot drift from the requirement.
   */
  objectiveText: string;
  objective: QuestObjective;
  /** Shown once the objective is met. */
  completionText: string;
  /**
   * What completing this quest pays out, or absent for a quest that pays nothing — see
   * {@link QuestReward}. Absent rather than `{ currencyDelta: 0 }`: the latter would still be a
   * settlement worth calling `settle()` and writing a ledger row for (`SettlementEffects
   * .currencyDelta`'s own "0 means touch no balance" reading is about a *mixed* batch, not an
   * excuse to open one for nothing), where a quest with no reward at all must make no settlement
   * call whatsoever.
   */
  reward?: QuestReward;
}

/** The only objective kind R03 defines: kill `count` monsters of `kind`. */
export interface QuestObjective {
  kind: MonsterKind;
  /** Positive integer. Boot validation refuses anything else, `LootEntry.quantity`'s own treatment. */
  count: number;
}

/**
 * What a completed quest pays out (roadmap R04-b, `docs/decisions.md` 2026-09-17). Currency only:
 * R04-c's shop does not exist yet, so an item reward would sit in a bag with nothing to spend it
 * on — that decision's own reasoning, and the reason {@link SettlementEffects.items} stays unused
 * by every call this file's quest wiring makes.
 */
export interface QuestReward {
  /** 전(錢), credited once via `SettlementStore.settle`. Boot validation refuses anything but a positive integer. */
  currencyDelta: number;
}

/**
 * The authored table. One row, which is the whole of R03's "퀘스트 1개": the guide NPC already
 * standing at the plaza's north gate (`plaza-hunting-ground-npc`, the one that tells you the
 * hunting ground is through there) now also has something to ask for, so the first quest needs no
 * new NPC, no new art and no map change.
 *
 * Squirrel rather than rabbit or deer: it is the kind the hunting ground is full of
 * (`MONSTER_SPAWN_DEFINITIONS` places 14 of them), it dies in exactly three hits by design, and it
 * is the only kind reachable without the hunting-den entry pass.
 */
export const QUEST_DEFINITIONS: readonly QuestDefinition[] = [
  {
    id: "first-hunt",
    giverObjectId: "plaza-hunting-ground-npc",
    title: "첫 사냥",
    summary:
      "북쪽 문을 지나면 사냥터입니다. 다람쥐 세 마리만 잡고 돌아오면 사냥이 어떤 것인지 알게 될 겁니다.",
    objectiveText: "사냥터에서 다람쥐 3마리 처치",
    objective: { kind: MonsterKind.Squirrel, count: 3 },
    completionText: "벌써 세 마리를 잡았군요. 이제 사냥터를 혼자 돌아다녀도 되겠습니다.",
    // 화폐만, 소액(`docs/decisions.md` 2026-09-17) — R04-c 상점이 아직 없어 아이템은 쓸 데가 없다.
    reward: { currencyDelta: 50 },
  },
];

/** `QUEST_DEFINITIONS` by id — the lookup `handleAcceptQuest` does on every request. */
export const QUESTS_BY_ID: ReadonlyMap<string, QuestDefinition> = new Map(
  QUEST_DEFINITIONS.map((quest) => [quest.id, quest]),
);

/**
 * `QUEST_DEFINITIONS` by giver, for the NPC panel. A list per giver rather than a single quest:
 * the table does not forbid one NPC offering two, and a map that silently kept only the last row
 * would be a table whose meaning depends on its order.
 */
export const QUESTS_BY_GIVER: ReadonlyMap<string, readonly QuestDefinition[]> = groupBy(
  QUEST_DEFINITIONS,
  (quest) => quest.giverObjectId,
);

/**
 * Quests advanced by killing one monster kind, for the kill path. Built once at module load
 * because `MetaverseRoom.advanceQuests` runs on every kill and must not scan the table — the same
 * reason the portal and interactable indexes exist.
 */
export const QUESTS_BY_MONSTER_KIND: ReadonlyMap<MonsterKind, readonly QuestDefinition[]> = groupBy(
  QUEST_DEFINITIONS,
  (quest) => quest.objective.kind,
);

/**
 * Boot validation, wired into `server.ts` beside the portal/interactable/item checks and refusing
 * the boot on any error — the same contract those have. A quest table is authored content, and
 * every fault below is one that would otherwise surface as a quest that silently cannot be
 * accepted or cannot be finished, on a player's account, after the deploy.
 *
 * Takes the object and spawn tables because three of the checks are about this table *and* one of
 * those: a giver that does not exist, a giver that is not an NPC, and an objective naming a monster
 * kind that is placed nowhere — an uncompletable quest, which no single-table check could see.
 */
export function validateQuestDefinitions(
  quests: readonly QuestDefinition[],
  objects: readonly InteractableDefinition[],
  spawns: readonly MonsterSpawnDefinition[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  const objectsById = new Map(objects.map((object) => [object.id, object]));
  const spawnedKinds = new Set(spawns.map((spawn) => spawn.kind));

  for (const quest of quests) {
    const label = `quest "${quest.id}"`;
    if (quest.id.length === 0) {
      errors.push("a quest has an empty id");
    }
    if (seenIds.has(quest.id)) {
      errors.push(`${label} is defined twice`);
    }
    seenIds.add(quest.id);

    const giver = objectsById.get(quest.giverObjectId);
    if (giver === undefined) {
      errors.push(`${label} names giver "${quest.giverObjectId}", which is not an interactable object`);
    } else if (giver.kind !== InteractableKind.Npc) {
      errors.push(
        `${label} names giver "${quest.giverObjectId}", which is a ${giver.kind} object rather than an npc`,
      );
    }

    const { kind, count } = quest.objective;
    if (!Number.isInteger(count) || count < 1) {
      errors.push(`${label} requires ${count} kills, which is not a positive integer`);
    }
    if (!spawnedKinds.has(kind)) {
      // Not a warning: nothing of that kind exists to kill, so the quest can be accepted and then
      // never finished — the fault this whole function exists to catch before a player finds it.
      errors.push(`${label} targets monster kind "${kind}", which no spawn row places`);
    }
    if (Number.isInteger(count) && count > 0 && !quest.objectiveText.includes(String(count))) {
      // A warning rather than an error: the copy being out of step with the requirement misleads a
      // player but still leaves a finishable quest, and an author writing the number in words is a
      // deliberate choice this check cannot tell apart from a typo.
      warnings.push(
        `${label} requires ${count} kills but its objectiveText does not mention that number`,
      );
    }
    if (quest.title.length === 0 || quest.summary.length === 0 || quest.completionText.length === 0) {
      errors.push(`${label} has an empty title, summary or completionText`);
    }
    if (quest.reward !== undefined) {
      const { currencyDelta } = quest.reward;
      if (!Number.isInteger(currencyDelta) || currencyDelta < 1) {
        errors.push(`${label} rewards ${currencyDelta} currency, which is not a positive integer`);
      }
    }
  }
  return { errors, warnings };
}

function groupBy<K, T>(rows: readonly T[], keyOf: (row: T) => K): ReadonlyMap<K, readonly T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, [row]);
    } else {
      existing.push(row);
    }
  }
  return grouped;
}
