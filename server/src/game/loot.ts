import type { LootEntry } from "../rooms/monsterDefinitions";

/** One item a kill actually yielded. The rolled form of a {@link LootEntry}. */
export interface LootGrant {
  itemKey: string;
  quantity: number;
}

/**
 * Rolls one kill's drops. Knows nothing about rooms, sockets or the database, so it lives beside
 * `movement.ts`, `portals.ts` and `proximity.ts` — the place this codebase keeps rules it wants to
 * be able to check.
 *
 * Every line is an independent trial rather than one weighted draw: a kill has to be able to
 * yield nothing or several things, and independence is also what lets somebody read the table one
 * row at a time instead of holding the whole distribution in their head.
 *
 * `random` is passed in rather than reached for, which is the whole point of the signature — the
 * room hands over its own `random()` seam, and a test hands over a seeded generator and asserts
 * both the observed frequencies over ten thousand rolls and that one seed always replays the same
 * sequence. No room, no map, no socket.
 */
export function rollLoot(
  entries: readonly LootEntry[],
  random: () => number,
): readonly LootGrant[] {
  const grants: LootGrant[] = [];
  for (const entry of entries) {
    // Input order is output order, and one draw is taken per row whether or not it hits: both are
    // what let a seeded test replay an exact sequence rather than an exact multiset.
    if (random() < entry.chance) {
      grants.push({ itemKey: entry.itemKey, quantity: entry.quantity });
    }
  }
  return grants;
}
