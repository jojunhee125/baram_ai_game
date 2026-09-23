import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseOptions, projectRows, renderReport } from "./balance-growth.mjs";

const scenario = (...args) => projectRows(parseOptions(args));

test("uses class attack rounding, equipment damage reduction and current room monster stats", () => {
  const rows = scenario(
    "--class", "warrior", "--room", "hunting-ground", "--level", "3",
    "--equipment", "old-dagger,padded-armor",
  );
  const squirrel = rows.find((row) => row.monster === "squirrel");
  assert.deepEqual(
    [squirrel.attack, squirrel.maxHp, squirrel.hitsToKill, squirrel.monsterHits, squirrel.damageTaken],
    [7, 150, 2, 1, 4],
  );
  assert.equal(squirrel.projectedKills, 290);
  assert.equal(squirrel.projectedExp, 290);
  assert.equal(squirrel.projectedLevel, 4);
  assert.ok(Math.abs(squirrel.netCurrencyPerKill - 3.76) < 1e-10);
});

test("marks a long solo fight unviable while preserving its time and damage estimate", () => {
  const boss = scenario("--class", "warrior", "--room", "hunting-ground", "--level", "3")
    .find((row) => row.monster === "boss");
  assert.equal(boss.soloSurvivable, false);
  assert.ok(boss.fightSeconds > 400);
  assert.ok(boss.damageTaken > boss.maxHp);
  assert.equal(boss.projectedKills, null);
  assert.equal(boss.projectedExp, null);
  assert.equal(boss.projectedNetCurrency, null);
});

test("room variants and spawn counts come from the authored tables", () => {
  const den = scenario("--class", "rogue", "--room", "hunting-den", "--level", "6")
    .find((row) => row.monster === "rabbit");
  const forest = scenario("--class", "rogue", "--room", "hunting-forest", "--level", "6")
    .find((row) => row.monster === "rabbit");
  assert.equal(den.spawnCount, 5);
  assert.equal(forest.spawnCount, 4);
  assert.equal(den.expPerKill, 20);
  assert.equal(forest.expPerKill, 45);
  assert.ok(forest.hitsToKill > den.hitsToKill);
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
  const options = parseOptions(["--class", "rogue", "--room", "hunting-den", "--json"]);
  const first = renderReport(options);
  assert.equal(first, renderReport(options));
  const parsed = JSON.parse(first);
  assert.equal(parsed.rows.length, 3);
  assert.match(parsed.assumptions.source, /not observed play/);
  assert.match(parsed.assumptions.exclusions, /Skills/);
});

test("CLI process emits a report and fails cleanly for an invalid option", () => {
  const script = fileURLToPath(new URL("./balance-growth.mjs", import.meta.url));
  const output = execFileSync(process.execPath, ["--import", "tsx", script, "--class", "cleric", "--room", "hunting-forest"], {
    encoding: "utf8",
  });
  assert.match(output, /Growth balance projection/);
  assert.match(output, /cleric\s+hunting-forest/);
  assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", script, "--class", "invalid"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }), /Command failed/);
});
