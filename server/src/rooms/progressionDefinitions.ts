import { InteractableKind, PROGRESSION_MONSTER_NAMES, PROGRESSION_REGIONS, type CraftingRecipeView } from "@zep-test/shared";
import type { InteractableDefinition, ItemDefinition, RoomDefinition } from "./contracts";
import type { MonsterKind, MonsterSpawnDefinition, MonsterType } from "./monsterDefinitions";
import type { QuestDefinition } from "./questDefinitions";
import type { ShopDefinition } from "./shopDefinitions";

export const LEGACY_PROGRESSION_ITEMS: readonly ItemDefinition[] = [
  {"key": "wetland-sword", "icon": "wetland-sword", "name": "물안개 습지 검", "sellValue": 60, "equipment": {"slot": "weapon", "stats": {"attackDamage": 16}, "requirement": {"minLevel": 10, "classes": ["warrior"]}}},
  {"key": "wetland-dagger", "icon": "wetland-dagger", "name": "물안개 습지 단도", "sellValue": 60, "equipment": {"slot": "weapon", "stats": {"attackDamage": 14}, "requirement": {"minLevel": 10, "classes": ["rogue"]}}},
  {"key": "wetland-staff", "icon": "wetland-staff", "name": "물안개 습지 지팡이", "sellValue": 60, "equipment": {"slot": "weapon", "stats": {"attackDamage": 13}, "requirement": {"minLevel": 10, "classes": ["shaman"]}}},
  {"key": "wetland-charm", "icon": "wetland-charm", "name": "물안개 습지 부적", "sellValue": 60, "equipment": {"slot": "weapon", "stats": {"attackDamage": 18}, "requirement": {"minLevel": 10, "classes": ["cleric"]}}},
  {"key": "wetland-armor", "icon": "wetland-armor", "name": "물안개 습지 갑옷", "sellValue": 45, "equipment": {"slot": "armor", "stats": {"damageReduction": 0.32}, "requirement": {"minLevel": 10}}},
  {"key": "wetland-helmet", "icon": "wetland-helmet", "name": "물안개 습지 투구", "sellValue": 30, "equipment": {"slot": "helmet", "stats": {"damageReduction": 0.16}, "requirement": {"minLevel": 10}}},
  {"key": "wetland-boots", "icon": "wetland-boots", "name": "물안개 습지 장화", "sellValue": 25, "equipment": {"slot": "shoes", "stats": {"damageReduction": 0.04}, "requirement": {"minLevel": 10}}},
  {"key": "wetland-cloak", "icon": "wetland-cloak", "name": "물안개 습지 망토", "sellValue": 25, "equipment": {"slot": "cloak", "stats": {"damageReduction": 0.14}, "requirement": {"minLevel": 10}}},
  {"key": "marsh-fiber", "icon": "marsh-fiber", "name": "늪풀 섬유", "sellValue": 18},
  {"key": "serpent-scale", "icon": "serpent-scale", "name": "갈대뱀 비늘", "sellValue": 24},
  {"key": "swamp-pearl", "icon": "swamp-pearl", "name": "늪의 진주", "sellValue": 60},
  {"key": "marsh-tonic", "icon": "marsh-tonic", "name": "물안개 습지 회복약", "sellValue": 6, "consumable": {"healAmount": 75}},
  {"key": "quarry-sword", "icon": "quarry-sword", "name": "붉은 채석장 검", "sellValue": 120, "equipment": {"slot": "weapon", "stats": {"attackDamage": 24}, "requirement": {"minLevel": 15, "classes": ["warrior"]}}},
  {"key": "quarry-dagger", "icon": "quarry-dagger", "name": "붉은 채석장 단도", "sellValue": 120, "equipment": {"slot": "weapon", "stats": {"attackDamage": 22}, "requirement": {"minLevel": 15, "classes": ["rogue"]}}},
  {"key": "quarry-staff", "icon": "quarry-staff", "name": "붉은 채석장 지팡이", "sellValue": 120, "equipment": {"slot": "weapon", "stats": {"attackDamage": 20}, "requirement": {"minLevel": 15, "classes": ["shaman"]}}},
  {"key": "quarry-charm", "icon": "quarry-charm", "name": "붉은 채석장 부적", "sellValue": 120, "equipment": {"slot": "weapon", "stats": {"attackDamage": 28}, "requirement": {"minLevel": 15, "classes": ["cleric"]}}},
  {"key": "quarry-armor", "icon": "quarry-armor", "name": "붉은 채석장 갑옷", "sellValue": 90, "equipment": {"slot": "armor", "stats": {"damageReduction": 0.36}, "requirement": {"minLevel": 15}}},
  {"key": "quarry-helmet", "icon": "quarry-helmet", "name": "붉은 채석장 투구", "sellValue": 60, "equipment": {"slot": "helmet", "stats": {"damageReduction": 0.18}, "requirement": {"minLevel": 15}}},
  {"key": "quarry-ring", "icon": "quarry-ring", "name": "붉은 채석장 반지", "sellValue": 50, "equipment": {"slot": "ring", "stats": {"attackDamage": 1, "damageReduction": 0.02}, "requirement": {"minLevel": 15}}},
  {"key": "quarry-necklace", "icon": "quarry-necklace", "name": "붉은 채석장 목걸이", "sellValue": 50, "equipment": {"slot": "necklace", "stats": {"damageReduction": 0.06}, "requirement": {"minLevel": 15}}},
  {"key": "iron-ore", "icon": "iron-ore", "name": "철광석", "sellValue": 28},
  {"key": "bat-wing", "icon": "bat-wing", "name": "박쥐 날개", "sellValue": 36},
  {"key": "rough-crystal", "icon": "rough-crystal", "name": "거친 수정", "sellValue": 90},
  {"key": "quarry-tonic", "icon": "quarry-tonic", "name": "붉은 채석장 회복약", "sellValue": 10, "consumable": {"healAmount": 120}},
  {"key": "frost-sword", "icon": "frost-sword", "name": "서리 설원 검", "sellValue": 210, "equipment": {"slot": "weapon", "stats": {"attackDamage": 34}, "requirement": {"minLevel": 20, "classes": ["warrior"]}}},
  {"key": "frost-dagger", "icon": "frost-dagger", "name": "서리 설원 단도", "sellValue": 210, "equipment": {"slot": "weapon", "stats": {"attackDamage": 31}, "requirement": {"minLevel": 20, "classes": ["rogue"]}}},
  {"key": "frost-staff", "icon": "frost-staff", "name": "서리 설원 지팡이", "sellValue": 210, "equipment": {"slot": "weapon", "stats": {"attackDamage": 28}, "requirement": {"minLevel": 20, "classes": ["shaman"]}}},
  {"key": "frost-charm", "icon": "frost-charm", "name": "서리 설원 부적", "sellValue": 210, "equipment": {"slot": "weapon", "stats": {"attackDamage": 39}, "requirement": {"minLevel": 20, "classes": ["cleric"]}}},
  {"key": "frost-armor", "icon": "frost-armor", "name": "서리 설원 갑옷", "sellValue": 160, "equipment": {"slot": "armor", "stats": {"damageReduction": 0.4}, "requirement": {"minLevel": 20}}},
  {"key": "frost-helmet", "icon": "frost-helmet", "name": "서리 설원 투구", "sellValue": 110, "equipment": {"slot": "helmet", "stats": {"damageReduction": 0.2}, "requirement": {"minLevel": 20}}},
  {"key": "frost-boots", "icon": "frost-boots", "name": "서리 설원 장화", "sellValue": 90, "equipment": {"slot": "shoes", "stats": {"damageReduction": 0.06}, "requirement": {"minLevel": 20}}},
  {"key": "frost-cloak", "icon": "frost-cloak", "name": "서리 설원 망토", "sellValue": 90, "equipment": {"slot": "cloak", "stats": {"damageReduction": 0.18}, "requirement": {"minLevel": 20}}},
  {"key": "white-fur", "icon": "white-fur", "name": "흰 털", "sellValue": 42},
  {"key": "frost-shard", "icon": "frost-shard", "name": "서리 파편", "sellValue": 54},
  {"key": "ice-heart", "icon": "ice-heart", "name": "얼음 심장", "sellValue": 140},
  {"key": "frost-tonic", "icon": "frost-tonic", "name": "서리 설원 회복약", "sellValue": 15, "consumable": {"healAmount": 180}},
  {"key": "ruin-sword", "icon": "ruin-sword", "name": "고대 유적 검", "sellValue": 350, "equipment": {"slot": "weapon", "stats": {"attackDamage": 46}, "requirement": {"minLevel": 25, "classes": ["warrior"]}}},
  {"key": "ruin-dagger", "icon": "ruin-dagger", "name": "고대 유적 단도", "sellValue": 350, "equipment": {"slot": "weapon", "stats": {"attackDamage": 42}, "requirement": {"minLevel": 25, "classes": ["rogue"]}}},
  {"key": "ruin-staff", "icon": "ruin-staff", "name": "고대 유적 지팡이", "sellValue": 350, "equipment": {"slot": "weapon", "stats": {"attackDamage": 38}, "requirement": {"minLevel": 25, "classes": ["shaman"]}}},
  {"key": "ruin-charm", "icon": "ruin-charm", "name": "고대 유적 부적", "sellValue": 350, "equipment": {"slot": "weapon", "stats": {"attackDamage": 52}, "requirement": {"minLevel": 25, "classes": ["cleric"]}}},
  {"key": "ruin-armor", "icon": "ruin-armor", "name": "고대 유적 갑옷", "sellValue": 275, "equipment": {"slot": "armor", "stats": {"damageReduction": 0.44}, "requirement": {"minLevel": 25}}},
  {"key": "ruin-helmet", "icon": "ruin-helmet", "name": "고대 유적 투구", "sellValue": 190, "equipment": {"slot": "helmet", "stats": {"damageReduction": 0.22}, "requirement": {"minLevel": 25}}},
  {"key": "ruin-ring", "icon": "ruin-ring", "name": "고대 유적 반지", "sellValue": 150, "equipment": {"slot": "ring", "stats": {"attackDamage": 2, "damageReduction": 0.03}, "requirement": {"minLevel": 25}}},
  {"key": "ruin-necklace", "icon": "ruin-necklace", "name": "고대 유적 목걸이", "sellValue": 150, "equipment": {"slot": "necklace", "stats": {"damageReduction": 0.08}, "requirement": {"minLevel": 25}}},
  {"key": "ancient-shard", "icon": "ancient-shard", "name": "고대 파편", "sellValue": 60},
  {"key": "spirit-dust", "icon": "spirit-dust", "name": "영혼 가루", "sellValue": 78},
  {"key": "guardian-core", "icon": "guardian-core", "name": "수호자의 핵", "sellValue": 210},
  {"key": "ruin-tonic", "icon": "ruin-tonic", "name": "고대 유적 회복약", "sellValue": 22, "consumable": {"healAmount": 260}},];

export const PROGRESSION_ITEMS: readonly ItemDefinition[] = [
  {"key": "rabbit-meat", "name": "토끼고기", "icon": "rabbit-meat", "sellValue": 6, "consumable": {"healAmount": 30}},
  {"key": "rat-meat", "name": "쥐고기", "icon": "rat-meat", "sellValue": 12, "consumable": {"healAmount": 40}},
  {"key": "bat-meat", "name": "박쥐고기", "icon": "bat-meat", "sellValue": 16, "consumable": {"healAmount": 45}},
  {"key": "snake-meat", "name": "뱀고기", "icon": "snake-meat", "sellValue": 24, "consumable": {"healAmount": 65}},
  {"key": "good-snake-meat", "name": "좋은뱀고기", "icon": "good-snake-meat", "sellValue": 36, "consumable": {"healAmount": 90}},
  {"key": "strength-helmet-1", "name": "힘의투구1", "icon": "strength-helmet-1", "sellValue": 150, "equipment": {"slot": "helmet", "stats": {"attackDamage": 2, "damageReduction": 0.16}, "requirement": {"minLevel": 10}}},
  {"key": "bear-hide", "name": "곰가죽", "icon": "bear-hide", "sellValue": 32},
  {"key": "bear-gall", "name": "웅담", "icon": "bear-gall", "sellValue": 45, "consumable": {"healAmount": 120}},
  {"key": "tiger-hide", "name": "호랑이가죽", "icon": "tiger-hide", "sellValue": 48},
  {"key": "deer-meat", "name": "사슴고기", "icon": "deer-meat", "sellValue": 54, "consumable": {"healAmount": 100}},
  {"key": "wild-pork", "name": "산돼지고기", "icon": "wild-pork", "sellValue": 68, "consumable": {"healAmount": 150}},
  {"key": "forest-pork", "name": "숲돼지고기", "icon": "forest-pork", "sellValue": 82, "consumable": {"healAmount": 180}},
  {"key": "fox-fur", "name": "여우모피", "icon": "fox-fur", "sellValue": 100},
  {"key": "square-shield", "name": "사각방패", "icon": "square-shield", "sellValue": 250},];

export const PROGRESSION_RECIPES: readonly CraftingRecipeView[] = [];

export const PROGRESSION_MONSTERS: ReadonlyMap<MonsterKind, MonsterType> = new Map<MonsterKind, MonsterType>([
  ["squirrel", {"kind": "squirrel", "maxHp": 12, "damage": 5, "attackCooldownMs": 1200, "expReward": 1, "behavior": "timid", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 8000, "loot": [{"itemKey": "acorn", "chance": 0.6, "quantity": 1}], "fleeStepIntervalMs": 1000}],
  ["rabbit", {"kind": "rabbit", "maxHp": 19, "damage": 7, "attackCooldownMs": 1200, "expReward": 2, "behavior": "timid", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "rabbit-meat", "chance": 0.55, "quantity": 1}], "fleeStepIntervalMs": 1000}],
  ["female-deer", {"kind": "female-deer", "maxHp": 28, "damage": 7, "attackCooldownMs": 1600, "expReward": 3, "behavior": "timid", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [], "fleeStepIntervalMs": 1000}],
  ["rat", {"kind": "rat", "maxHp": 48, "damage": 9, "attackCooldownMs": 1600, "expReward": 20, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "rat-meat", "chance": 0.75, "quantity": 1}]}],
  ["bat", {"kind": "bat", "maxHp": 64, "damage": 10, "attackCooldownMs": 1400, "expReward": 26, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "bat-meat", "chance": 0.7, "quantity": 1}]}],
  ["snake", {"kind": "snake", "maxHp": 100, "damage": 14, "attackCooldownMs": 1600, "expReward": 45, "behavior": "ambush", "aggroRadiusTiles": 1, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "snake-meat", "chance": 0.8, "quantity": 1}]}],
  ["python", {"kind": "python", "maxHp": 140, "damage": 16, "attackCooldownMs": 1600, "expReward": 65, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "good-snake-meat", "chance": 0.75, "quantity": 1}]}],
  ["king-python", {"kind": "king-python", "maxHp": 220, "damage": 20, "attackCooldownMs": 1600, "expReward": 100, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "strength-helmet-1", "chance": 0.025, "quantity": 1}]}],
  ["bear", {"kind": "bear", "maxHp": 180, "damage": 20, "attackCooldownMs": 1800, "expReward": 90, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "bear-hide", "chance": 0.8, "quantity": 1}]}],
  ["pyeongung", {"kind": "pyeongung", "maxHp": 210, "damage": 23, "attackCooldownMs": 1800, "expReward": 110, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "bear-gall", "chance": 0.75, "quantity": 1}]}],
  ["tiger", {"kind": "tiger", "maxHp": 240, "damage": 26, "attackCooldownMs": 1400, "expReward": 125, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "tiger-hide", "chance": 0.75, "quantity": 1}]}],
  ["blue-deer", {"kind": "blue-deer", "maxHp": 300, "damage": 28, "attackCooldownMs": 1600, "expReward": 160, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "deer-meat", "chance": 0.8, "quantity": 1}]}],
  ["red-deer", {"kind": "red-deer", "maxHp": 380, "damage": 32, "attackCooldownMs": 1600, "expReward": 220, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "deer-meat", "chance": 0.9, "quantity": 1}]}],
  ["wild-boar", {"kind": "wild-boar", "maxHp": 460, "damage": 38, "attackCooldownMs": 1600, "expReward": 280, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "wild-pork", "chance": 0.8, "quantity": 1}]}],
  ["forest-boar", {"kind": "forest-boar", "maxHp": 560, "damage": 44, "attackCooldownMs": 1600, "expReward": 360, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "forest-pork", "chance": 0.8, "quantity": 1}]}],
  ["black-fox", {"kind": "black-fox", "maxHp": 660, "damage": 48, "attackCooldownMs": 1400, "expReward": 420, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "fox-fur", "chance": 0.8, "quantity": 1}]}],
  ["white-fox", {"kind": "white-fox", "maxHp": 760, "damage": 54, "attackCooldownMs": 1400, "expReward": 500, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "fox-fur", "chance": 0.9, "quantity": 1}]}],
  ["gumiho", {"kind": "gumiho", "maxHp": 980, "damage": 68, "attackCooldownMs": 1600, "expReward": 620, "behavior": "aggressive", "aggroRadiusTiles": 2, "wanderStepIntervalMs": 1600, "chaseStepIntervalMs": 600, "leashRadiusTiles": 8, "respawnDelayMs": 12000, "loot": [{"itemKey": "square-shield", "chance": 0.025, "quantity": 1}]}],
 ]);

export const PROGRESSION_ROOMS: readonly RoomDefinition[] = PROGRESSION_REGIONS.map((region) => ({
  name: region.roomId, roomType: region.roomId, mapKey: region.roomId, maxClients: 500, realCapacity: 20,
  spawn: { tileX: 31, tileY: 24, spreadRadiusInTiles: 1 },
}));

const SPAWN_TILES = [[23, 14], [40, 14], [23, 19], [40, 19], [28, 14], [35, 14], [28, 19], [35, 19]] as const;

export const PROGRESSION_SPAWNS: readonly MonsterSpawnDefinition[] = PROGRESSION_REGIONS.flatMap((region) =>
  SPAWN_TILES.map(([tileX, tileY], index) => {
    const kind = region.monsterKinds[index % region.monsterKinds.length] as MonsterKind;
    return {
      id: `${region.roomId}-${kind}-${index + 1}`, room: region.roomId, kind, at: { tileX, tileY },
      wanderRadiusTiles: PROGRESSION_MONSTERS.get(kind)!.behavior === "ambush" ? 0 : 1,
    };
  }),
);

export const PROGRESSION_NPCS: readonly InteractableDefinition[] = PROGRESSION_REGIONS.map((region, index) => ({
  id: `${region.roomId}-camp-npc`, kind: InteractableKind.Npc, at: { room: region.roomId, tiles: [{ tileX: 28, tileY: 25 }] },
  title: `${region.name} 길잡이`, body: `이 프로젝트의 권장 레벨은 ${region.minLevel}–${region.maxLevel}입니다. 사냥 의뢰와 보급품을 확인하세요. 전리품은 가방에서 판매하거나 회복에 사용할 수 있습니다.`,
  avatarSkin: 8 + index, blocksMovement: false,
}));

export const PROGRESSION_SHOPS: readonly ShopDefinition[] = PROGRESSION_REGIONS.map((region) => ({
  npcObjectId: `${region.roomId}-camp-npc`, listings: [{ itemKey: "herb", price: 12 }],
}));

export const PROGRESSION_QUESTS: readonly QuestDefinition[] = [
  { id: "wetland-survey", giverObjectId: "buyeo-deer-cave-camp-npc", prerequisiteQuestId: "first-hunt", title: "사슴굴 정찰", summary: `${PROGRESSION_MONSTER_NAMES["blue-deer"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["blue-deer"]} 6마리 처치`, objective: { kind: "blue-deer", room: "buyeo-deer-cave", count: 6 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 200 } },
  { id: "wetland-trial", giverObjectId: "buyeo-deer-cave-camp-npc", prerequisiteQuestId: "wetland-survey", title: "사슴굴 위협 제거", summary: `${PROGRESSION_MONSTER_NAMES["red-deer"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["red-deer"]} 8마리 처치`, objective: { kind: "red-deer", room: "buyeo-deer-cave", count: 8 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 300 } },
  { id: "quarry-survey", giverObjectId: "buyeo-pig-cave-camp-npc", prerequisiteQuestId: "first-hunt", title: "돼지굴 정찰", summary: `${PROGRESSION_MONSTER_NAMES["wild-boar"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["wild-boar"]} 6마리 처치`, objective: { kind: "wild-boar", room: "buyeo-pig-cave", count: 6 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 350 } },
  { id: "quarry-trial", giverObjectId: "buyeo-pig-cave-camp-npc", prerequisiteQuestId: "quarry-survey", title: "돼지굴 위협 제거", summary: `${PROGRESSION_MONSTER_NAMES["forest-boar"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["forest-boar"]} 8마리 처치`, objective: { kind: "forest-boar", room: "buyeo-pig-cave", count: 8 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 500 } },
  { id: "frost-survey", giverObjectId: "buyeo-fox-cave-camp-npc", prerequisiteQuestId: "first-hunt", title: "여우굴 정찰", summary: `${PROGRESSION_MONSTER_NAMES["black-fox"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["black-fox"]} 6마리 처치`, objective: { kind: "black-fox", room: "buyeo-fox-cave", count: 6 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 550 } },
  { id: "frost-trial", giverObjectId: "buyeo-fox-cave-camp-npc", prerequisiteQuestId: "frost-survey", title: "여우굴 위협 제거", summary: `${PROGRESSION_MONSTER_NAMES["white-fox"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["white-fox"]} 8마리 처치`, objective: { kind: "white-fox", room: "buyeo-fox-cave", count: 8 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 800 } },
  { id: "ruin-survey", giverObjectId: "buyeo-snake-cave-camp-npc", prerequisiteQuestId: "first-hunt", title: "뱀굴 정찰", summary: `${PROGRESSION_MONSTER_NAMES["snake"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["snake"]} 6마리 처치`, objective: { kind: "snake", room: "buyeo-snake-cave", count: 6 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 800 } },
  { id: "ruin-trial", giverObjectId: "buyeo-snake-cave-camp-npc", prerequisiteQuestId: "ruin-survey", title: "뱀굴 위협 제거", summary: `${PROGRESSION_MONSTER_NAMES["python"]} 처치로 주변의 안전을 확보하세요.`, objectiveText: `${PROGRESSION_MONSTER_NAMES["python"]} 8마리 처치`, objective: { kind: "python", room: "buyeo-snake-cave", count: 8 }, completionText: "의뢰를 완료했습니다. 보급품을 준비하고 다음 사냥에 도전하세요.", reward: { currencyDelta: 1200 } },
];
