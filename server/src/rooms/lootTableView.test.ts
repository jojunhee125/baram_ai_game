import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ITEM_DEFINITIONS } from "./itemDefinitions";
import { buildLootTableView, MONSTER_DISPLAY_NAMES } from "./lootTableView";
import { MONSTER_SPAWN_DEFINITIONS, MONSTER_TYPES, monsterTypesForRoom, type MonsterKind } from "./monsterDefinitions";

const HUNTING_GROUND = "buyeo-novice";

describe("buildLootTableView", () => {
  it("returns every monster kind with a spawn in the room, in MONSTER_TYPES order", async () => {
    const kindsInRoom = new Set(
      MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === HUNTING_GROUND).map(
        (spawn) => spawn.kind,
      ),
    );
    const expectedKindOrder = [...MONSTER_TYPES.keys()].filter((kind) => kindsInRoom.has(kind));
    assert.ok(expectedKindOrder.length >= 2, "novice hunting must seed this test with 2+ kinds");

    const views = buildLootTableView(HUNTING_GROUND);
    assert.deepEqual(
      views.map((view) => view.kind),
      expectedKindOrder,
    );
  });

  it("carries the display name and the full, unfiltered drop table for each kind", async () => {
    const itemsByKey = new Map(ITEM_DEFINITIONS.map((item) => [item.key, item]));
    const views = buildLootTableView(HUNTING_GROUND);

    for (const view of views) {
      const type = monsterTypesForRoom(HUNTING_GROUND).get(view.kind as MonsterKind)!;
      assert.equal(view.name, MONSTER_DISPLAY_NAMES[view.kind as MonsterKind]);
      assert.equal(view.expReward, type.expReward);
      assert.equal(view.drops.length, type.loot.length);
      // Drop order follows the monster type's own loot array, not ITEM_DEFINITIONS' order —
      // those two orderings differ today (acorn, carrot, copper-coin, herb, old-dagger).
      assert.deepEqual(
        view.drops.map((drop) => drop.itemKey),
        type.loot.map((entry) => entry.itemKey),
      );
      for (const [index, drop] of view.drops.entries()) {
        const entry = type.loot[index]!;
        const item = itemsByKey.get(entry.itemKey)!;
        assert.equal(drop.name, item.name);
        assert.equal(drop.icon, item.icon);
        assert.equal(drop.quantity, entry.quantity);
        assert.equal(drop.sellValue, item.sellValue);
      }
    }
  });

  it("rounds chancePercent to one decimal place", async () => {
    const views = buildLootTableView(HUNTING_GROUND);
    for (const view of views) {
      const type = monsterTypesForRoom(HUNTING_GROUND).get(view.kind as MonsterKind)!;
      for (const [index, drop] of view.drops.entries()) {
        const entry = type.loot[index]!;
        // Computed by an independent path (toFixed rather than the implementation's
        // multiply-by-1000-then-divide-by-10) so a broken formula on either side would surface.
        const expected = Number.parseFloat((entry.chance * 100).toFixed(1));
        assert.equal(drop.chancePercent, expected);
      }
    }
  });

  it("returns an empty array for a room with no monster spawns", async () => {
    assert.deepEqual(buildLootTableView("grand-plaza"), []);
    assert.deepEqual(buildLootTableView("plaza"), []);
  });

  it("uses each room's effective loot and EXP without merging unrelated regional drops", () => {
    const denViews = buildLootTableView("buyeo-rat-cave");
    for (const view of denViews) {
      const type = monsterTypesForRoom("buyeo-rat-cave").get(view.kind as MonsterKind)!;
      assert.equal(view.expReward, type.expReward);
      assert.deepEqual(view.drops.map((drop) => drop.itemKey), type.loot.map((entry) => entry.itemKey));
    }
    const rat = denViews.find((view) => view.kind === "rat")!;
    assert.deepEqual(rat.drops.map((drop) => drop.itemKey), ["rat-meat"]);
    const fieldRabbit = buildLootTableView(HUNTING_GROUND).find((view) => view.kind === "rabbit")!;
    assert.equal(fieldRabbit.expReward, 2);
    assert.deepEqual(fieldRabbit.drops.map((drop) => drop.itemKey), ["rabbit-meat"]);
    assert.deepEqual(buildLootTableView("hunting-den"), []);
  });

  it("returns an empty array for a room name that does not exist at all", async () => {
    assert.deepEqual(buildLootTableView("no-such-room"), []);
  });
});
