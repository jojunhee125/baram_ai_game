/** Room-scoped, not account data: no SSO identity involved, unlike `inventory.ts`'s endpoint. */
const LOOT_TABLE_PATH_PREFIX = "/api/loot-table/";

/**
 * Shorter than the profile's, because this one is behind a control the player just pressed: an
 * open window that sits on a spinner is worse feedback than one that says it could not read the
 * table and offers to try again.
 */
const LOAD_TIMEOUT_MS = 2500;

/** One drop row, exactly as the server sent it. */
export interface LootTableDrop {
  itemKey: string;
  name: string;
  icon: string;
  chancePercent: number;
}

/** One monster kind and its full loot table. */
export interface LootTableMonster {
  kind: string;
  name: string;
  drops: readonly LootTableDrop[];
}

/**
 * Reads `roomName`'s drop table. Always 200: an unrecognised or monster-less room name is an empty
 * array, not an error (server side, `buildLootTableView`) — so an empty result here is a real
 * answer ("this room has no monsters"), not a failure.
 *
 * Throws on anything else. The caller draws an error state from it and offers a retry.
 */
export async function loadLootTable(roomName: string): Promise<readonly LootTableMonster[]> {
  const response = await fetch(`${LOOT_TABLE_PATH_PREFIX}${encodeURIComponent(roomName)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return readMonsters(await response.json());
}

/**
 * Monster rows that do not parse are dropped, not thrown on — same reasoning as
 * `inventory.ts`'s `readItems`: the server catalogue can grow a field this bundle was not built
 * against, and losing one row beats replacing the whole table with an error.
 */
function readMonsters(body: unknown): readonly LootTableMonster[] {
  const monsters = (body as { monsters?: unknown } | null)?.monsters;
  if (!Array.isArray(monsters)) {
    throw new Error("response had no monsters array");
  }
  return monsters.filter(isLootTableMonster);
}

function isLootTableMonster(row: unknown): row is LootTableMonster {
  const monster = row as Partial<LootTableMonster> | null;
  return (
    typeof monster?.kind === "string" &&
    typeof monster.name === "string" &&
    Array.isArray(monster.drops) &&
    monster.drops.every(isLootTableDrop)
  );
}

function isLootTableDrop(row: unknown): row is LootTableDrop {
  const drop = row as Partial<LootTableDrop> | null;
  return (
    typeof drop?.itemKey === "string" &&
    typeof drop.name === "string" &&
    typeof drop.icon === "string" &&
    typeof drop.chancePercent === "number" &&
    Number.isFinite(drop.chancePercent)
  );
}
