import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseOptions, projectRows, renderReport } from "./balance-growth.mjs";

const scenario = (...args) => projectRows(parseOptions(args));


test("projects exactly seven active original regions and eighteen species for all four classes", () => {
  const expected = new Map([
    ["buyeo-novice", ["squirrel", "rabbit", "female-deer"]], ["buyeo-rat-cave", ["rat", "bat"]],
    ["buyeo-snake-cave", ["snake", "python", "king-python"]], ["buyeo-bear-cave", ["bear", "pyeongung", "tiger"]],
    ["buyeo-deer-cave", ["blue-deer", "red-deer"]], ["buyeo-pig-cave", ["wild-boar", "forest-boar"]],
    ["buyeo-fox-cave", ["black-fox", "white-fox", "gumiho"]],
  ]);
  const rows = scenario("--level", "30");
  assert.equal(rows.length, 72);
  for (const [room, kinds] of expected) for (const classKey of ["warrior", "rogue", "shaman", "cleric"]) {
    const region = scenario("--room", room, "--class", classKey, "--level", "30");
    assert.deepEqual(new Set(region.map(row => row.monster)), new Set(kinds));
    assert.ok(region.every(row => row.spawnCount > 0 && Number.isFinite(row.expPerKill)));
  }
  for (const room of ["hunting-ground", "hunting-den", "hunting-forest", "hunting-wetland", "hunting-quarry", "hunting-frost", "hunting-ruins"])
    assert.throws(() => parseOptions(["--room", room]), /Unknown room/);
  assert.throws(() => parseOptions(["--consumable", "marsh-tonic"]), /Unknown purchasable healing/);
});

test("saved legacy equipment still contributes stats while duplicate ring keys are rejected", () => {
  const args = ["--class", "warrior", "--room", "buyeo-fox-cave", "--level", "30"];
  const naked = scenario(...args)[0], rings = scenario(...args, "--equipment", "quarry-ring,ruin-ring")[0];
  assert.ok(rings.attack > naked.attack);
  assert.ok(rings.damageTaken <= naked.damageTaken);
  assert.throws(() => parseOptions([...args, "--equipment", "quarry-ring,quarry-ring"]), /same equipment item/);
  assert.throws(() => parseOptions([...args, "--equipment", "square-shield"]), /Unknown equipment/);
});

test("cap, numeric boundaries and deterministic zero-loot creatures are handled", () => {
  for (const value of ["0", "31", "-1", "NaN", "9007199254740992", ""]) assert.throws(() => parseOptions(["--level", value]));
  const rows = scenario("--room", "buyeo-novice", "--class", "warrior", "--level", "30", "--search-seconds", "0");
  assert.ok(rows.every(row => row.projectedLevel <= 30));
  assert.ok(rows.find(row => row.monster === "female-deer"));
  assert.deepEqual(rows, scenario("--room", "buyeo-novice", "--class", "warrior", "--level", "30", "--search-seconds", "0"));
});

test("rejects illegal equipment and invalid numeric CLI inputs", () => {
  assert.throws(() => parseOptions(["--class", "shaman", "--level", "6", "--equipment", "veteran-blade"]),
    /cannot be equipped by shaman/);
  assert.throws(() => parseOptions(["--class", "warrior", "--level", "2", "--equipment", "veteran-blade"]),
    /requires level 6/);
  assert.throws(() => parseOptions(["--equipment", "old-dagger,hunting-blade"]),
    /Only one item may occupy the weapon slot/);
  assert.throws(() => parseOptions(["--minutes", "1.5"]), /must be an integer/);
  assert.throws(() => parseOptions(["--room", "unknown"]), /Unknown room/);
});

test("JSON output is deterministic and identifies assumptions as estimates", () => {
  const options = parseOptions(["--class", "rogue", "--room", "buyeo-rat-cave", "--json"]);
  const first = renderReport(options);
  assert.equal(first, renderReport(options));
  const parsed = JSON.parse(first);
  assert.equal(parsed.rows.length, 2);
  assert.match(parsed.assumptions.source, /not observed play/);
  assert.match(parsed.assumptions.exclusions, /Skills/);
});

test("CLI process emits a report and fails cleanly for an invalid option", () => {
  const script = fileURLToPath(new URL("./balance-growth.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--import", "tsx", script, "--class", "cleric", "--room", "buyeo-fox-cave"], {
    encoding: "utf8",
  });
  assert.match(output, /Growth balance projection/);
  assert.match(output, /cleric\s+buyeo-fox-cave/);
  assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", script, "--class", "invalid"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }), /Command failed/);
});
