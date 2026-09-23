import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { EquipmentSlot } from "@zep-test/shared";
import type { ItemDefinition } from "../rooms/contracts";
import { ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { validateItemDefinitions } from "./items";

const CAP = 8;

function item(overrides: Partial<ItemDefinition> = {}): ItemDefinition {
  return { key: "acorn", name: "도토리", icon: "acorn", ...overrides };
}

const TABLE: readonly ItemDefinition[] = [
  item(),
  item({ key: "carrot", name: "당근", icon: "carrot" }),
];

describe("validateItemDefinitions", () => {
  it("passes a well-formed table", () => {
    assert.deepEqual(validateItemDefinitions(TABLE, CAP), { errors: [], warnings: [] });
  });

  it("passes an empty table — no items is a valid stage of this build", () => {
    assert.deepEqual(validateItemDefinitions([], CAP), { errors: [], warnings: [] });
  });

  it("rejects an empty key and names the row instead of the key", () => {
    const { errors } = validateItemDefinitions([item({ key: "" })], CAP);
    assert.deepEqual(errors, ['item at row 0 has an empty key']);
  });

  it("rejects a whitespace-only key", () => {
    const { errors } = validateItemDefinitions([item({ key: "   " })], CAP);
    assert.deepEqual(errors, ['item at row 0 has an empty key']);
  });

  it("rejects padding around a key, which the database would store verbatim", () => {
    const { errors } = validateItemDefinitions([item({ key: " acorn" })], CAP);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /leading or trailing whitespace/);
  });

  it("rejects a duplicate key, which is one row the bag can never show", () => {
    const { errors } = validateItemDefinitions([item(), item({ name: "다른 이름" })], CAP);
    assert.deepEqual(errors, ['item "acorn" is declared more than once']);
  });

  it("rejects a third copy too, rather than reporting the first duplicate only", () => {
    const { errors } = validateItemDefinitions([item(), item(), item()], CAP);
    assert.equal(errors.length, 2);
  });

  it("rejects an empty name and an empty icon", () => {
    const { errors } = validateItemDefinitions([item({ name: "  ", icon: "" })], CAP);
    assert.deepEqual(errors, [
      'item "acorn" has an empty name',
      'item "acorn" has an empty icon key',
    ]);
  });

  it("collects every fault in one pass rather than stopping at the first", () => {
    const { errors } = validateItemDefinitions(
      [item({ key: "" }), item({ name: "" }), item({ icon: "" })],
      CAP,
    );
    assert.equal(errors.length, 4, `one empty key, one duplicate, one name, one icon: ${errors}`);
  });

  it("refuses a capacity that is not a positive integer", () => {
    for (const cap of [0, -1, 2.5, Number.NaN]) {
      const { errors } = validateItemDefinitions(TABLE, cap);
      assert.equal(errors.length, 1, `cap ${cap}`);
      assert.match(errors[0] ?? "", /MAX_DISTINCT_ITEMS must be a positive integer/);
    }
  });

  it("warns without refusing when the catalogue outgrows the bag", () => {
    const wide = Array.from({ length: CAP + 1 }, (_, index) => item({ key: `item-${index}` }));
    const { errors, warnings } = validateItemDefinitions(wide, CAP);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /locks the rest out permanently/);
  });

  it("does not warn when the catalogue exactly fills the bag", () => {
    const exact = Array.from({ length: CAP }, (_, index) => item({ key: `item-${index}` }));
    assert.deepEqual(validateItemDefinitions(exact, CAP).warnings, []);
  });
});

describe("ITEM_DEFINITIONS", () => {
  it("is a table the server will boot on", () => {
    // The same guard `portals.test.ts` and `interactables.test.ts` put on the real tables: the
    // boot check is only worth having if a bad edit fails here rather than on a deploy.
    assert.deepEqual(validateItemDefinitions(ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS), {
      errors: [],
      warnings: [],
    });
  });

  it("has at least one item, or nothing can ever drop", () => {
    assert.ok(ITEM_DEFINITIONS.length > 0);
  });

  it("preserves original catalogue keys and appends progression equipment and saleable loot", () => {
    // Pinned rather than merely spot-checked, because two other things are indexed by it: Pass D
    // refuses to boot on a `MONSTER_TYPES.loot` key that is not here, and the client picks an
    // `items.png` frame by position in `ITEM_ICON_ORDER`. A key edited here without those is a
    // boot refusal; a row reordered here without those is every icon drawn as the wrong item.
    assert.deepEqual(
      ITEM_DEFINITIONS.map((definition) => definition.key),
      ["acorn", "carrot", "copper-coin", "herb", "old-dagger", "entry-pass", "leather-armor", "golden-helmet",
        "den-fur", "antler", "hunting-blade", "iron-blade", "padded-armor", "reinforced-armor",
        "forest-resin", "ancient-bark", "forest-cloak", "veteran-blade", "mystic-cloak"],
    );
  });

  it("names every item and keeps explicit icon aliases for progression items", () => {
    const aliases: Record<string, string> = { "hunting-blade": "old-dagger", "iron-blade": "old-dagger",
      "padded-armor": "leather-armor", "reinforced-armor": "leather-armor", "den-fur": "acorn", antler: "carrot",
      "forest-resin": "acorn", "ancient-bark": "carrot", "forest-cloak": "leather-armor",
      "veteran-blade": "old-dagger", "mystic-cloak": "leather-armor" };
    for (const definition of ITEM_DEFINITIONS) {
      assert.equal(definition.icon, aliases[definition.key] ?? definition.key, definition.key);
      assert.ok(definition.name.trim().length > 0, definition.key);
    }
  });

  it("uses keys the database column can hold and a URL never has to escape", () => {
    // These keys travel in JSON and end up in `inventory_item.item_key` forever. Keeping them to
    // lower-case ASCII and hyphens costs nothing now and avoids an encoding question later.
    for (const definition of ITEM_DEFINITIONS) {
      assert.match(definition.key, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, definition.key);
    }
  });

  it("leaves room in the bag for the whole catalogue", () => {
    assert.ok(
      ITEM_DEFINITIONS.length <= MAX_DISTINCT_ITEMS,
      `${ITEM_DEFINITIONS.length} kinds do not fit in a bag of ${MAX_DISTINCT_ITEMS}`,
    );
  });
});

/**
 * The client half of this table lives in two arrays the server cannot import: `client/` compiles
 * against DOM types this package's `lib` does not include, so `inventoryPanel.ts` is read as source
 * and its arrays parsed out — the same technique `tools/generate-monster-art.mjs` uses to check
 * ITEM_ICON_ORDER before baking, and for the same reason. Parsing beats a copy of the lists here,
 * which would agree with itself forever while the real file drifted.
 *
 * Phase I shipped `golden-helmet` in ITEM_DEFINITIONS and in neither client array. Nothing failed:
 * the bag, the equipment slots, the drop toast and the drop table all drew the dashed empty box, and
 * the item could not be equipped at all. These three checks are what that should have tripped.
 */
const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../client/src");
const INVENTORY_PANEL_TS = join(CLIENT_DIR, "ui/inventoryPanel.ts");
const ITEMS_PNG = join(dirname(fileURLToPath(import.meta.url)), "../../../assets/sprites/items.png");

/** Frame size of items.png, and the CSS pixel size of a bag icon (`ICON_SIZE_PX`, inventoryPanel.ts). */
const ICON_FRAME_PX = 32;

function clientSource(): string {
  return readFileSync(INVENTORY_PANEL_TS, "utf8");
}

/**
 * A miss throws rather than returning empty: renaming the const would otherwise turn every check
 * below into a vacuous pass, which is the one way a source-parsing test fails worse than no test.
 */
function readIconOrder(): readonly string[] {
  const block = /ITEM_ICON_ORDER\s*=\s*\[([\s\S]*?)\]/.exec(clientSource());
  assert.ok(block, `${INVENTORY_PANEL_TS}: ITEM_ICON_ORDER not found`);
  const icons = [...(block[1] ?? "").matchAll(/"([^"]+)"/g)].map((entry) => entry[1] as string);
  assert.ok(icons.length > 0, "ITEM_ICON_ORDER parsed as empty");
  return icons;
}

function readEquipmentItemSlots(): ReadonlyMap<string, string> {
  const block = /EQUIPMENT_ITEM_SLOTS[^=]*=\s*\{([\s\S]*?)\}/.exec(clientSource());
  assert.ok(block, `${INVENTORY_PANEL_TS}: EQUIPMENT_ITEM_SLOTS not found`);
  const pairs = [...(block[1] ?? "").matchAll(/"([^"]+)"\s*:\s*EquipmentSlot\.(\w+)/g)];
  assert.ok(pairs.length > 0, "EQUIPMENT_ITEM_SLOTS parsed as empty");
  return new Map(
    pairs.map(([, key, member]) => {
      const slot = (EquipmentSlot as Record<string, string>)[member as string];
      assert.ok(slot, `EQUIPMENT_ITEM_SLOTS names EquipmentSlot.${member}, which does not exist`);
      return [key as string, slot];
    }),
  );
}

describe("ITEM_DEFINITIONS against the client's mirror tables", () => {
  it("gives every item an icon the bag has a frame for", () => {
    const order = readIconOrder();
    const missing = ITEM_DEFINITIONS.filter((definition) => !order.includes(definition.icon));
    assert.deepEqual(
      missing.map((definition) => definition.icon),
      [],
      "these icons draw bag__icon--unknown: add them to ITEM_ICON_ORDER (append only) and re-run tools/generate-monster-art.mjs",
    );
  });

  it("has no frame left over that no item claims", () => {
    // Not cosmetic: a stale entry shifts every later column, so the leftover is found as every
    // icon after it drawing the wrong picture.
    const icons = new Set(ITEM_DEFINITIONS.map((definition) => definition.icon));
    assert.deepEqual(
      readIconOrder().filter((icon) => !icons.has(icon)),
      [],
    );
  });

  it("gives every equipment item the slot its 장착 button targets", () => {
    // Without an entry the row renders fine and gets no button, so this fails as an item that can
    // be carried and never worn — quieter than a missing icon, and it is how golden-helmet shipped.
    const slots = readEquipmentItemSlots();
    const equippable = ITEM_DEFINITIONS.filter((definition) => definition.equipment !== undefined);
    assert.deepEqual(
      equippable.map((definition) => [definition.key, slots.get(definition.key)]),
      equippable.map((definition) => [definition.key, definition.equipment?.slot]),
    );
    for (const key of slots.keys()) {
      assert.ok(
        ITEM_DEFINITIONS.some((definition) => definition.key === key),
        `EQUIPMENT_ITEM_SLOTS has "${key}", which is not an item`,
      );
    }
  });

  it("has an items.png as wide as the frames the client indexes", () => {
    // Closes the loop: both arrays can be edited correctly and the sheet left un-baked, which draws
    // the last item as blank. Width lives in the PNG's IHDR, bytes 16-19, big-endian.
    const png = readFileSync(ITEMS_PNG);
    assert.equal(
      png.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      `${ITEMS_PNG} is not a PNG`,
    );
    assert.equal(
      png.readUInt32BE(16),
      readIconOrder().length * ICON_FRAME_PX,
      "items.png does not have one frame per ITEM_ICON_ORDER entry: re-run tools/generate-monster-art.mjs",
    );
    assert.equal(png.readUInt32BE(20), ICON_FRAME_PX);
  });
});
