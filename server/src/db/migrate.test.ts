import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planMigrations } from "./migrate";

/** The real directory listing, so the production files are exercised by name at least once. */
const REAL_FILES = ["0001_player_profile.sql"];

describe("planMigrations — ordering", () => {
  it("returns every file, sorted by name, when nothing has been applied", () => {
    assert.deepEqual(planMigrations(["0002_inventory_item.sql", "0001_player_profile.sql"], []), [
      { version: "0001_player_profile", fileName: "0001_player_profile.sql" },
      { version: "0002_inventory_item", fileName: "0002_inventory_item.sql" },
    ]);
  });

  it("skips what is already applied and keeps the rest in order", () => {
    assert.deepEqual(
      planMigrations(
        ["0001_player_profile.sql", "0002_inventory_item.sql", "0003_item_icon.sql"],
        ["0001_player_profile"],
      ),
      [
        { version: "0002_inventory_item", fileName: "0002_inventory_item.sql" },
        { version: "0003_item_icon", fileName: "0003_item_icon.sql" },
      ],
    );
  });

  it("plans nothing when every file is applied, whatever order they were recorded in", () => {
    assert.deepEqual(
      planMigrations(
        ["0001_player_profile.sql", "0002_inventory_item.sql"],
        ["0002_inventory_item", "0001_player_profile"],
      ),
      [],
    );
  });

  it("is idempotent: re-planning after applying its own output yields nothing", () => {
    const files = ["0001_player_profile.sql", "0002_inventory_item.sql"];
    const applied = planMigrations(files, []).map((migration) => migration.version);
    assert.deepEqual(planMigrations(files, applied), []);
  });

  it("plans the real migrations directory listing from an empty database", () => {
    assert.deepEqual(
      planMigrations(REAL_FILES, []).map((migration) => migration.version),
      ["0001_player_profile"],
    );
  });

  it("accepts an empty directory and an empty applied set", () => {
    assert.deepEqual(planMigrations([], []), []);
  });
});

describe("planMigrations — what it ignores", () => {
  it("ignores non-.sql entries rather than rejecting the directory", () => {
    // A README beside the migrations is documentation, not a forgotten migration.
    assert.deepEqual(
      planMigrations(["README.md", "0001_player_profile.sql", ".gitkeep"], []),
      [{ version: "0001_player_profile", fileName: "0001_player_profile.sql" }],
    );
  });

  it("ignores an applied version with no file left on disk", () => {
    // What an older container sees after a rollback: the database is ahead of this image.
    // Rejecting would crash-loop the very deployment that is meant to be the safe one.
    assert.deepEqual(planMigrations(["0001_player_profile.sql"], ["0001_player_profile", "0002_inventory_item"]), []);
  });

  it("ignores a phantom applied version even when a lower-numbered file is still pending", () => {
    // The gap check must compare against applied *files*, not against the applied set, or a
    // version whose file is gone would make a legitimate pending migration look out of order.
    assert.deepEqual(
      planMigrations(["0001_player_profile.sql"], ["0009_from_the_future"]),
      [{ version: "0001_player_profile", fileName: "0001_player_profile.sql" }],
    );
  });
});

describe("planMigrations — what it refuses", () => {
  it("throws on a .sql file that breaks the naming convention", () => {
    // Skipping it would leave a migration silently unapplied, which is the exact failure the
    // runner exists to prevent — so an unreadable name is louder than a missing one.
    for (const bad of [
      "1_player_profile.sql",
      "00010_player_profile.sql",
      "0001-player-profile.sql",
      "0001_Player_Profile.sql",
      "0001_player__profile.sql",
      "0001_player_profile_.sql",
      "player_profile.sql",
      "0001_.sql",
      "0001.sql",
    ]) {
      assert.throws(
        () => planMigrations([bad], []),
        /naming convention/,
        `"${bad}" must be refused`,
      );
    }
  });

  it("throws when two files share a sequence number", () => {
    assert.throws(
      () => planMigrations(["0002_inventory_item.sql", "0002_item_icon.sql"], []),
      /share the sequence number 0002/,
    );
  });

  it("throws on a duplicate sequence whichever order the directory lists them in", () => {
    assert.throws(
      () => planMigrations(["0002_item_icon.sql", "0002_inventory_item.sql"], []),
      /share the sequence number 0002/,
    );
  });

  it("throws when a pending file sorts before one already applied", () => {
    // A file numbered under something in the database would run against a schema its author
    // never saw — two branches merged with colliding numbers is how this happens in practice.
    assert.throws(
      () =>
        planMigrations(
          ["0001_player_profile.sql", "0002_inventory_item.sql", "0003_item_icon.sql"],
          ["0001_player_profile", "0003_item_icon"],
        ),
      /"0002_inventory_item\.sql" is pending but sorts before the applied "0003_item_icon\.sql"/,
    );
  });

  it("does not mistake a pending file that sorts after everything applied for a reversal", () => {
    assert.deepEqual(
      planMigrations(
        ["0001_player_profile.sql", "0002_inventory_item.sql"],
        ["0001_player_profile"],
      ),
      [{ version: "0002_inventory_item", fileName: "0002_inventory_item.sql" }],
    );
  });
});
