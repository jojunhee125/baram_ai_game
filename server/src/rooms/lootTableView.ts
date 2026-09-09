import { MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES, type MonsterKind } from "./monsterDefinitions";
import { ITEM_DEFINITIONS } from "./itemDefinitions";

/**
 * Korean display name per kind. Kept apart from `monsterDefinitions.ts` on purpose: that file is
 * this pass's frozen surface (read-only per the assignment) and carries no display string today —
 * only `kind` crosses the wire (design §5.2), and nothing needed a name until this panel.
 */
export const MONSTER_DISPLAY_NAMES: Readonly<Record<MonsterKind, string>> = {
  squirrel: "다람쥐",
  rabbit: "토끼",
  deer: "사슴",
  boss: "보스",
};

export interface LootTableDropView {
  itemKey: string;
  name: string;
  icon: string;
  /** entry.chance * 100, rounded to one decimal — every current value lands on a whole number. */
  chancePercent: number;
}

export interface LootTableMonsterView {
  kind: string;
  name: string;
  drops: readonly LootTableDropView[];
}

/**
 * Every monster kind with at least one spawn point in `roomName`, each carrying its full loot
 * table — the same rows for every spawn of that kind, because population is spawn *points*
 * (design §5.2), not per-monster instances with independent tables. Order follows `MONSTER_TYPES`'
 * own declaration order (squirrel before rabbit) — the same "table order is display order" rule
 * `ITEM_DEFINITIONS` already carries (design §3.2), which here also happens to be difficulty order.
 *
 * A room with no spawn rows (grand-plaza, plaza, an unrecognised name) returns `[]`. There is no
 * separate "room not found" outcome: this is static, non-sensitive data, so an empty result reads
 * identically to — and is exactly as safe as — a real room that has no monsters.
 *
 * Assumes `validateMonsterSpawnDefinitions` has already run at boot (every loot `itemKey` exists
 * in `ITEM_DEFINITIONS`, every spawn `kind` exists in `MONSTER_TYPES`) — this does not re-check
 * what boot has already refused to let run.
 */
export function buildLootTableView(roomName: string): readonly LootTableMonsterView[] {
  const kindsInRoom = new Set<MonsterKind>();
  for (const spawn of MONSTER_SPAWN_DEFINITIONS) {
    if (spawn.room === roomName) {
      kindsInRoom.add(spawn.kind);
    }
  }

  const itemsByKey = new Map(ITEM_DEFINITIONS.map((item) => [item.key, item]));
  const views: LootTableMonsterView[] = [];
  for (const [kind, type] of MONSTER_TYPES) {
    if (!kindsInRoom.has(kind)) {
      continue;
    }
    views.push({
      kind,
      name: MONSTER_DISPLAY_NAMES[kind],
      drops: type.loot.map((entry) => {
        const item = itemsByKey.get(entry.itemKey)!;
        return {
          itemKey: entry.itemKey,
          name: item.name,
          icon: item.icon,
          chancePercent: Math.round(entry.chance * 1000) / 10,
        };
      }),
    });
  }
  return views;
}
