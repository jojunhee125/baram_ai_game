import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ItemDefinition } from "../rooms/contracts";
import { ITEM_DEFINITIONS, MAX_DISTINCT_ITEMS } from "../rooms/itemDefinitions";
import { validateItemDefinitions } from "./items";

const CAP = 8;

function item(overrides: Partial<ItemDefinition> = {}): ItemDefinition {
  return { key: "slime-jelly", name: "슬라임 젤리", icon: "slime-jelly", ...overrides };
}

const TABLE: readonly ItemDefinition[] = [
  item(),
  item({ key: "bat-wing", name: "박쥐 날개", icon: "bat-wing" }),
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
    const { errors } = validateItemDefinitions([item({ key: " slime-jelly" })], CAP);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /leading or trailing whitespace/);
  });

  it("rejects a duplicate key, which is one row the bag can never show", () => {
    const { errors } = validateItemDefinitions([item(), item({ name: "다른 이름" })], CAP);
    assert.deepEqual(errors, ['item "slime-jelly" is declared more than once']);
  });

  it("rejects a third copy too, rather than reporting the first duplicate only", () => {
    const { errors } = validateItemDefinitions([item(), item(), item()], CAP);
    assert.equal(errors.length, 2);
  });

  it("rejects an empty name and an empty icon", () => {
    const { errors } = validateItemDefinitions([item({ name: "  ", icon: "" })], CAP);
    assert.deepEqual(errors, [
      'item "slime-jelly" has an empty name',
      'item "slime-jelly" has an empty icon key',
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

  it("holds exactly the keys of design appendix D-4, in that order", () => {
    // Pinned rather than merely spot-checked, because two other things are indexed by it: Pass D
    // refuses to boot on a `MONSTER_TYPES.loot` key that is not here, and the client picks an
    // `items.png` frame by position in `ITEM_ICON_ORDER`. A key edited here without those is a
    // boot refusal; a row reordered here without those is every icon drawn as the wrong item.
    assert.deepEqual(
      ITEM_DEFINITIONS.map((definition) => definition.key),
      ["slime-jelly", "bat-wing", "copper-coin", "herb", "old-dagger"],
    );
  });

  it("names every item, and gives each icon the same string as its key", () => {
    // The equality is today's arrangement rather than a rule — the fields stay separate so art
    // can be shared later (design D-3) — but while it holds, a mismatch is a typo.
    for (const definition of ITEM_DEFINITIONS) {
      assert.equal(definition.icon, definition.key, definition.key);
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
