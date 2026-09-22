import type { ItemDefinition } from "../rooms/contracts";

/** Boot-validation outcome. Every error refuses boot; warnings are authoring smells only. */
export interface ItemValidation {
  errors: readonly string[];
  warnings: readonly string[];
}

/**
 * Checks the item catalogue, in the same spirit as `validatePortalDefinitions` and
 * `validateInteractableDefinitions`: none of these faults would surface until a drop landed, and
 * by then the wrong key is already written into somebody's bag — the one kind of authoring
 * mistake in this project that a redeploy does not undo.
 *
 * `maxDistinctItems` is a parameter rather than the imported constant so this stays a pure
 * function of its inputs, which is what lets the capacity rule be tested without a table.
 *
 * Every issue is collected rather than thrown at the first one: a boot failure that reveals one
 * typo per restart is a bad way to fix a table.
 */
export function validateItemDefinitions(
  items: readonly ItemDefinition[],
  maxDistinctItems: number,
): ItemValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenKeys = new Set<string>();

  for (const [index, item] of items.entries()) {
    const label = item.key.trim().length === 0 ? `item at row ${index}` : `item "${item.key}"`;
    if (item.key.trim().length === 0) {
      errors.push(`${label} has an empty key`);
    } else if (item.key !== item.key.trim()) {
      // The key goes into `inventory_item.item_key` verbatim, where the padding is invisible and
      // permanent: the trimmed spelling would then look like a different, missing item.
      errors.push(`${label} has leading or trailing whitespace in its key`);
    } else if (seenKeys.has(item.key)) {
      // The second row would be unreachable: both share one primary key in the database, so a
      // grant of either adds to the same stack and the bag shows whichever row is listed first.
      errors.push(`${label} is declared more than once`);
    } else {
      seenKeys.add(item.key);
    }

    if (item.name.trim().length === 0) {
      errors.push(`${label} has an empty name`);
    }
    if (item.icon.trim().length === 0) {
      errors.push(`${label} has an empty icon key`);
    }
    if (item.sellValue !== undefined && (!Number.isSafeInteger(item.sellValue) || item.sellValue < 1)) {
      errors.push(`${label} has a sellValue that is not a positive safe integer`);
    }
    if (item.equipment !== undefined) {
      for (const [stat, value] of Object.entries(item.equipment.stats)) {
        if (stat === "damageReduction") {
          if (!Number.isFinite(value) || value <= 0 || value >= 1) {
            errors.push(`${label} has a damageReduction outside (0, 1)`);
          }
        } else if ((stat !== "attackDamage" && stat !== "maxHp") || !Number.isSafeInteger(value) || value < 1) {
          errors.push(`${label} has an invalid equipment stat "${stat}"`);
        }
      }
    }
  }

  if (!Number.isInteger(maxDistinctItems) || maxDistinctItems < 1) {
    errors.push(`MAX_DISTINCT_ITEMS must be a positive integer, not ${maxDistinctItems}`);
  } else if (items.length > maxDistinctItems) {
    // Not an error — a bag smaller than the catalogue is a legitimate design — but worth saying
    // out loud while nothing can be dropped or sold: a player who fills the bag can never be
    // granted any of the remaining kinds again.
    warnings.push(
      `the item catalogue has ${items.length} kinds but a bag holds ${maxDistinctItems}; with no way to drop an item, a full bag locks the rest out permanently`,
    );
  }

  return { errors, warnings };
}
