import { pathToFileURL } from "node:url";

import {
  ATTACK_COOLDOWN_MS,
  ATTACK_PER_LEVEL,
  CLASS_DEFINITIONS,
  HP_PER_LEVEL,
  LEVEL_CAP,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_MAX_HP,
  cumulativeExpForLevel,
  levelForExp,
} from "../shared/src/index.ts";
import { ITEM_DEFINITIONS } from "../server/src/rooms/itemDefinitions.ts";
import {
  MONSTER_SPAWN_DEFINITIONS,
  monsterTypesForRoom,
} from "../server/src/rooms/monsterDefinitions.ts";
import { SHOP_DEFINITIONS } from "../server/src/rooms/shopDefinitions.ts";

const ROOM_NAMES = ["hunting-ground", "hunting-den", "hunting-forest"];
const ITEM_BY_KEY = new Map(ITEM_DEFINITIONS.map((item) => [item.key, item]));
const HERB = ITEM_BY_KEY.get("herb");
const HERB_BUY_PRICE = SHOP_DEFINITIONS.flatMap((shop) => shop.listings)
  .find((listing) => listing.itemKey === "herb")?.price;

if (HERB?.consumable?.healAmount === undefined || HERB_BUY_PRICE === undefined) {
  throw new Error("The balance model requires the shop's healing herb definition and price.");
}

export function parseOptions(args) {
  const options = {
    level: 3,
    classKey: "all",
    room: "all",
    equipmentKeys: [],
    minutes: 30,
    searchSeconds: 5,
    json: false,
  };
  const valued = new Set(["--level", "--class", "--room", "--equipment", "--minutes", "--search-seconds"]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--json") {
      options.json = true;
      continue;
    }
    if (!valued.has(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    switch (option) {
      case "--level":
        options.level = parseInteger(value, option, 1, LEVEL_CAP);
        break;
      case "--class":
        if (value !== "all" && !Object.hasOwn(CLASS_DEFINITIONS, value)) {
          throw new Error(`Unknown class: ${value}`);
        }
        options.classKey = value;
        break;
      case "--room":
        if (value !== "all" && !ROOM_NAMES.includes(value)) {
          throw new Error(`Unknown room: ${value}`);
        }
        options.room = value;
        break;
      case "--equipment":
        options.equipmentKeys = value === "none" ? [] : value.split(",");
        if (options.equipmentKeys.some((key) => key.length === 0 || key.trim() !== key)) {
          throw new Error("--equipment needs comma-separated item keys without blanks");
        }
        break;
      case "--minutes":
        options.minutes = parseInteger(value, option, 1, 1440);
        break;
      case "--search-seconds":
        options.searchSeconds = parseInteger(value, option, 0, 3600);
        break;
    }
  }
  validateEquipment(options.equipmentKeys, options.level, selectedClasses(options.classKey));
  return options;
}

function parseInteger(value, option, minimum, maximum) {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${option} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function selectedClasses(classKey) {
  return classKey === "all" ? Object.keys(CLASS_DEFINITIONS) : [classKey];
}

function validateEquipment(keys, level, classes) {
  const slots = new Set();
  for (const key of keys) {
    const item = ITEM_BY_KEY.get(key);
    if (item?.equipment === undefined) {
      throw new Error(`Unknown equipment item: ${key}`);
    }
    const { slot, requirement } = item.equipment;
    if (slots.has(slot)) {
      throw new Error(`Only one item may occupy the ${slot} slot`);
    }
    slots.add(slot);
    if (level < (requirement?.minLevel ?? 1)) {
      throw new Error(`${key} requires level ${requirement.minLevel}`);
    }
    for (const classKey of classes) {
      if (requirement?.classes !== undefined && !requirement.classes.includes(classKey)) {
        throw new Error(`${key} cannot be equipped by ${classKey}; select an eligible --class`);
      }
    }
  }
}

function equipmentStats(keys) {
  let attackBonus = 0;
  let hpBonus = 0;
  let damageFraction = 1;
  for (const key of keys) {
    const stats = ITEM_BY_KEY.get(key).equipment.stats;
    attackBonus += stats.attackDamage ?? 0;
    hpBonus += stats.maxHp ?? 0;
    damageFraction *= 1 - (stats.damageReduction ?? 0);
  }
  return { attackBonus, hpBonus, damageFraction };
}

export function projectRows(options) {
  validateEquipment(options.equipmentKeys, options.level, selectedClasses(options.classKey));
  const gear = equipmentStats(options.equipmentKeys);
  const durationMs = options.minutes * 60_000;
  const searchMs = options.searchSeconds * 1000;
  const rooms = options.room === "all" ? ROOM_NAMES : [options.room];
  const rows = [];
  for (const classKey of selectedClasses(options.classKey)) {
    const classDefinition = CLASS_DEFINITIONS[classKey];
    const attack = Math.max(1, Math.round((PLAYER_ATTACK_DAMAGE +
      (options.level - 1) * ATTACK_PER_LEVEL + gear.attackBonus) * classDefinition.attackMultiplier));
    const maxHp = Math.max(1, Math.round((PLAYER_MAX_HP +
      (options.level - 1) * HP_PER_LEVEL + gear.hpBonus) * classDefinition.maxHpMultiplier));
    for (const room of rooms) {
      const types = monsterTypesForRoom(room);
      const counts = new Map();
      for (const spawn of MONSTER_SPAWN_DEFINITIONS) {
        if (spawn.room === room) {
          counts.set(spawn.kind, (counts.get(spawn.kind) ?? 0) + 1);
        }
      }
      for (const [kind, spawnCount] of counts) {
        const monster = types.get(kind);
        if (monster === undefined) {
          throw new Error(`Spawned ${kind} has no monster type in ${room}`);
        }
        const hitsToKill = Math.ceil(monster.maxHp / attack);
        const fightMs = (hitsToKill - 1) * ATTACK_COOLDOWN_MS;
        // The first monster hit arrives after its cooldown; a lethal player hit wins a tie.
        const monsterHits = fightMs === 0 ? 0 : Math.ceil(fightMs / monster.attackCooldownMs);
        const damagePerHit = Math.max(1, Math.floor(monster.damage * gear.damageFraction));
        const damageTaken = monsterHits * damagePerHit;
        const soloSurvivable = damageTaken < maxHp;
        const cycleMs = hitsToKill * ATTACK_COOLDOWN_MS + searchMs;
        const timeCapacity = Math.floor(durationMs / cycleMs);
        const respawnCapacity = spawnCount * Math.ceil(durationMs / monster.respawnDelayMs);
        const projectedKills = soloSurvivable ? Math.min(timeCapacity, respawnCapacity) : null;
        let expectedLootCurrency = 0;
        let expectedHerbDrops = 0;
        for (const loot of monster.loot) {
          const expectedQuantity = loot.chance * loot.quantity;
          if (loot.itemKey === "herb") {
            expectedHerbDrops += expectedQuantity;
          } else {
            expectedLootCurrency += expectedQuantity * (ITEM_BY_KEY.get(loot.itemKey)?.sellValue ?? 0);
          }
        }
        const herbsNeeded = damageTaken / HERB.consumable.healAmount;
        const netCurrencyPerKill = expectedLootCurrency +
          Math.max(0, expectedHerbDrops - herbsNeeded) * (HERB.sellValue ?? 0) -
          Math.max(0, herbsNeeded - expectedHerbDrops) * HERB_BUY_PRICE;
        const projectedExp = projectedKills === null ? null : projectedKills * monster.expReward;
        rows.push({
          classKey, level: options.level, room, monster: kind, spawnCount,
          attack, maxHp, hitsToKill, fightSeconds: fightMs / 1000,
          monsterHits, damageTaken, soloSurvivable,
          expPerKill: monster.expReward, netCurrencyPerKill,
          projectedKills, projectedExp,
          projectedLevel: projectedExp === null ? null : levelForExp(cumulativeExpForLevel(options.level) + projectedExp),
          projectedNetCurrency: projectedKills === null ? null : netCurrencyPerKill * projectedKills,
        });
      }
    }
  }
  return rows;
}

function formatNumber(value) {
  return value === null ? "n/a" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function renderReport(options) {
  const rows = projectRows(options);
  const assumptions = {
    source: "Current server/shared definitions; deterministic estimate, not observed play",
    combat: "Auto attacks only, first player hit at time zero; monster first retaliates after its cooldown; lethal player hit wins a tie",
    cycle: `${options.searchSeconds}s search between kills plus one attack cooldown per player hit; single-kind focus in each independent row`,
    capacity: "Kills bounded by time and spawn count times respawn opportunities; no other players or downtime",
    economy: "Expected loot sale proceeds less herbs needed to replace all damage; fractional expectations, no passive recovery, quests or death penalty",
    exclusions: "Skills, movement AI, misses, in-fight healing, inventory limits and gear changes are excluded",
  };
  if (options.json) {
    return `${JSON.stringify({ options, assumptions, rows }, null, 2)}\n`;
  }
  const lines = [
    "Growth balance projection (not actual-play observations)",
    `Level ${options.level}; class ${options.classKey}; room ${options.room}; equipment ${options.equipmentKeys.join(",") || "none"}; ${options.minutes} min; search ${options.searchSeconds}s/kill`,
    "Each row is an independent solo single-monster-kind scenario. n/a means one fight is not survivable without in-fight healing.",
    "class    room            monster   atk  hp   hits  fight(s)  taken  kills  exp    level  net coins",
  ];
  for (const row of rows) {
    lines.push([
      row.classKey.padEnd(8), row.room.padEnd(15), row.monster.padEnd(9),
      String(row.attack).padStart(3), String(row.maxHp).padStart(4),
      String(row.hitsToKill).padStart(5), formatNumber(row.fightSeconds).padStart(9),
      String(row.damageTaken).padStart(6), formatNumber(row.projectedKills).padStart(6),
      formatNumber(row.projectedExp).padStart(6), formatNumber(row.projectedLevel).padStart(6),
      formatNumber(row.projectedNetCurrency).padStart(10),
    ].join(" "));
  }
  lines.push("Assumptions:");
  for (const value of Object.values(assumptions)) {
    lines.push(`- ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export const HELP = `Usage: npx tsx tools/balance-growth.mjs [options]
  --level 1..${LEVEL_CAP}             Starting level (default 3)
  --class all|warrior|rogue|shaman|cleric  (default all)
  --room all|hunting-ground|hunting-den|hunting-forest  (default all)
  --equipment key,key       Equipped item keys (default none)
  --minutes 1..1440         Projection duration (default 30)
  --search-seconds 0..3600  Time between fights (default 5)
  --json                    Machine-readable report
  --help                    Show this help
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).includes("--help")) {
      process.stdout.write(HELP);
    } else {
      process.stdout.write(renderReport(parseOptions(process.argv.slice(2))));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
