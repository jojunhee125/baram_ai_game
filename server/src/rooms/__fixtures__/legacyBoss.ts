import { InteractableKind } from "@zep-test/shared";
import type { CollisionMap, RoomDefinition, PortalDefinition, InteractableDefinition, SpawnArea, PortalIndex, InteractableIndex, LandmarkIndex } from "../contracts";
import type { LandmarkDefinition } from "../landmarkDefinitions";
import { MonsterKind, MONSTER_TYPES as ACTIVE_MONSTER_TYPES, type MonsterType, type MonsterSpawnDefinition } from "../monsterDefinitions";
import { MetaverseRoom } from "../metaverseRoom";
import { TablePortalIndex } from "../../game/portals";
import { TableInteractableIndex } from "../../game/interactables";
import { TableLandmarkIndex } from "../../game/landmarks";
import { createGameServer } from "../../server";

// Archived content is injected only by historical mechanics tests; production registration stays canonical.
export const MONSTER_TYPES: ReadonlyMap<MonsterKind, MonsterType> = new Map([
  [
    MonsterKind.Squirrel,
    {
      kind: MonsterKind.Squirrel,
      maxHp: 12,
      damage: 5,
      attackCooldownMs: 1200,
      wanderStepIntervalMs: 1600,
      chaseStepIntervalMs: 600,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 8,
      respawnDelayMs: 8000,
      expReward: 1,
      loot: [
        { itemKey: "acorn", chance: 0.6, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.25, quantity: 1 },
        { itemKey: "herb", chance: 0.08, quantity: 1 },
        { itemKey: "entry-pass", chance: 0.15, quantity: 1 },
      ],
    },
  ],
  [
    MonsterKind.Rabbit,
    {
      kind: MonsterKind.Rabbit,
      maxHp: 19,
      damage: 7,
      attackCooldownMs: 800,
      wanderStepIntervalMs: 1200,
      chaseStepIntervalMs: 400,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 10,
      respawnDelayMs: 12000,
      expReward: 2,
      loot: [
        { itemKey: "carrot", chance: 0.55, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.35, quantity: 1 },
        { itemKey: "herb", chance: 0.12, quantity: 1 },
        { itemKey: "old-dagger", chance: 0.03, quantity: 1 },
      ],
    },
  ],
  [
    MonsterKind.Deer,
    {
      kind: MonsterKind.Deer,
      maxHp: 28,
      damage: 7,
      attackCooldownMs: 1200,
      wanderStepIntervalMs: 2000,
      chaseStepIntervalMs: 600,
      aggroRadiusTiles: 2,
      leashRadiusTiles: 10,
      respawnDelayMs: 16000,
      expReward: 3,
      loot: [
        { itemKey: "herb", chance: 0.5, quantity: 1 },
        { itemKey: "copper-coin", chance: 0.3, quantity: 1 },
        { itemKey: "carrot", chance: 0.15, quantity: 1 },
        { itemKey: "old-dagger", chance: 0.05, quantity: 1 },
        { itemKey: "leather-armor", chance: 0.03, quantity: 1 },
      ],
    },
  ],
  [MonsterKind.Boss, ACTIVE_MONSTER_TYPES.get(MonsterKind.Boss)!],
]);

export const MONSTER_SPAWN_DEFINITIONS: readonly MonsterSpawnDefinition[] = [
  { id: "hf-rabbit-01", room: "hunting-forest", kind: MonsterKind.Rabbit, at: { tileX: 22, tileY: 12 }, wanderRadiusTiles: 0 },
  { id: "hf-rabbit-02", room: "hunting-forest", kind: MonsterKind.Rabbit, at: { tileX: 41, tileY: 12 }, wanderRadiusTiles: 0 },
  { id: "hf-rabbit-03", room: "hunting-forest", kind: MonsterKind.Rabbit, at: { tileX: 22, tileY: 19 }, wanderRadiusTiles: 0 },
  { id: "hf-rabbit-04", room: "hunting-forest", kind: MonsterKind.Rabbit, at: { tileX: 41, tileY: 19 }, wanderRadiusTiles: 0 },
  { id: "hf-deer-01", room: "hunting-forest", kind: MonsterKind.Deer, at: { tileX: 27, tileY: 12 }, wanderRadiusTiles: 1 },
  { id: "hf-deer-02", room: "hunting-forest", kind: MonsterKind.Deer, at: { tileX: 36, tileY: 12 }, wanderRadiusTiles: 1 },
  { id: "hf-deer-03", room: "hunting-forest", kind: MonsterKind.Deer, at: { tileX: 25, tileY: 18 }, wanderRadiusTiles: 1 },
  { id: "hf-deer-04", room: "hunting-forest", kind: MonsterKind.Deer, at: { tileX: 38, tileY: 18 }, wanderRadiusTiles: 1 },
  { id: "hg-squirrel-01", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 19, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-02", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 24, tileY: 23 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-03", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 29, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-04", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 41, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-05", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 46, tileY: 23 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-06", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 51, tileY: 24 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-07", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 18, tileY: 19 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-08", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 23, tileY: 20 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-09", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 28, tileY: 18 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-10", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 33, tileY: 20 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-11", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 44, tileY: 19 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-12", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 49, tileY: 20 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-13", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 21, tileY: 14 }, wanderRadiusTiles: 2 },
  { id: "hg-squirrel-14", room: "hunting-ground", kind: MonsterKind.Squirrel, at: { tileX: 52, tileY: 14 }, wanderRadiusTiles: 2 },
  { id: "hg-rabbit-01", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 26, tileY: 14 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-02", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 38, tileY: 13 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-03", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 45, tileY: 15 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-04", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 22, tileY: 10 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-05", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 35, tileY: 10 }, wanderRadiusTiles: 3 },
  { id: "hg-rabbit-06", room: "hunting-ground", kind: MonsterKind.Rabbit, at: { tileX: 49, tileY: 10 }, wanderRadiusTiles: 3 },
  { id: "hd-rabbit-01", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 21, tileY: 12 }, wanderRadiusTiles: 1 },
  { id: "hd-deer-01", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 27, tileY: 11 }, wanderRadiusTiles: 1 },
  { id: "hd-rabbit-02", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 33, tileY: 13 }, wanderRadiusTiles: 1 },
  { id: "hd-deer-02", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 39, tileY: 11 }, wanderRadiusTiles: 1 },
  { id: "hd-rabbit-03", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 44, tileY: 13 }, wanderRadiusTiles: 1 },
  { id: "hd-deer-03", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 20, tileY: 19 }, wanderRadiusTiles: 1 },
  { id: "hd-rabbit-04", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 25, tileY: 19 }, wanderRadiusTiles: 1 },
  { id: "hd-deer-04", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 35, tileY: 18 }, wanderRadiusTiles: 1 },
  { id: "hd-rabbit-05", room: "hunting-den", kind: MonsterKind.Rabbit, at: { tileX: 38, tileY: 20 }, wanderRadiusTiles: 1 },
  { id: "hd-deer-05", room: "hunting-den", kind: MonsterKind.Deer, at: { tileX: 43, tileY: 19 }, wanderRadiusTiles: 1 },
  { id: "hg-boss-01", room: "hunting-ground", kind: MonsterKind.Boss, at: { tileX: 34, tileY: 16 }, wanderRadiusTiles: 3, persistentRespawn: true },
  { id: "hd-boss-01", room: "hunting-den", kind: MonsterKind.Boss, at: { tileX: 31, tileY: 17 }, wanderRadiusTiles: 3, persistentRespawn: true },
];

export const ROOM_DEFINITIONS: readonly RoomDefinition[] = [
  {
    name: "plaza",
    roomType: "plaza",
    mapKey: "plaza",
    maxClients: 50,
    spawn: { tileX: 31, tileY: 20, spreadRadiusInTiles: 0 },
  },
  {
    name: "grand-plaza",
    roomType: "grand-plaza",
    mapKey: "grand-plaza",
    maxClients: 500,
    spawn: { tileX: 86, tileY: 73, spreadRadiusInTiles: 70 },
  },
  {
    name: "hunting-ground",
    roomType: "hunting-ground",
    mapKey: "hunting-ground",
    maxClients: 500,
    realCapacity: 40,
    spawn: { tileX: 35, tileY: 27, spreadRadiusInTiles: 2 },
  },
  {
    name: "hunting-den",
    roomType: "hunting-den",
    mapKey: "hunting-den",
    maxClients: 500,
    realCapacity: 20,
    spawn: { tileX: 31, tileY: 24, spreadRadiusInTiles: 1 },
  },
  {
    name: "hunting-forest",
    roomType: "hunting-forest",
    mapKey: "hunting-forest",
    maxClients: 500,
    realCapacity: 20,
    spawn: { tileX: 31, tileY: 24, spreadRadiusInTiles: 1 },
  },
];

export const PORTAL_DEFINITIONS: readonly PortalDefinition[] = [
  {
    id: "hunting-den-forest-door",
    from: { room: "hunting-den", tiles: [{ tileX: 47, tileY: 25 }, { tileX: 47, tileY: 26 }] },
    to: { room: "hunting-forest", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } },
    requiresItemKey: "entry-pass",
    deniedMessage: "입장권은 다람쥐를 잡아서 획득하세요",
  },
  {
    id: "hunting-forest-south-door",
    from: { room: "hunting-forest", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] },
    to: { room: "hunting-den", arrival: { tileX: 46, tileY: 25, spreadRadiusInTiles: 0 } },
  },
  {
    id: "plaza-south-door",
    from: {
      room: "plaza",
      tiles: [
        { tileX: 31, tileY: 25 },
        { tileX: 32, tileY: 25 },
      ],
    },
    to: { room: "hunting-ground", arrival: { tileX: 35, tileY: 30, spreadRadiusInTiles: 0 } },
  },
  {
    id: "grand-plaza-north-door",
    from: {
      room: "grand-plaza",
      tiles: [
        { tileX: 22, tileY: 8 },
        { tileX: 23, tileY: 8 },
      ],
    },
    to: { room: "plaza", arrival: { tileX: 31, tileY: 10, spreadRadiusInTiles: 0 } },
  },
  {
    id: "plaza-north-door",
    from: {
      room: "plaza",
      tiles: [
        { tileX: 31, tileY: 8 },
        { tileX: 32, tileY: 8 },
      ],
    },
    to: { room: "grand-plaza", arrival: { tileX: 22, tileY: 9, spreadRadiusInTiles: 0 } },
  },
  {
    id: "hunting-ground-south-door",
    from: {
      room: "hunting-ground",
      tiles: [
        { tileX: 35, tileY: 31 },
        { tileX: 36, tileY: 31 },
      ],
    },
    to: { room: "plaza", arrival: { tileX: 31, tileY: 23, spreadRadiusInTiles: 0 } },
  },
  {
    id: "hunting-ground-north-door",
    from: {
      room: "hunting-ground",
      tiles: [
        { tileX: 35, tileY: 8 },
        { tileX: 36, tileY: 8 },
      ],
    },
    to: { room: "hunting-den", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } },
    requiresItemKey: "entry-pass",
    deniedMessage: "입장권은 다람쥐를 잡아서 획득하세요",
  },
  {
    id: "hunting-den-south-door",
    from: {
      room: "hunting-den",
      tiles: [
        { tileX: 31, tileY: 27 },
        { tileX: 32, tileY: 27 },
      ],
    },
    to: { room: "hunting-ground", arrival: { tileX: 35, tileY: 9, spreadRadiusInTiles: 0 } },
  },
];

export const LANDMARK_DEFINITIONS: readonly LandmarkDefinition[] = [
  {
    id: "landmark-hunting-forest", room: "hunting-forest",
    tile: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 },
    requiresItemKey: "entry-pass",
    deniedMessage: "입장권은 다람쥐를 잡아서 획득하세요",
  },
  { id: "landmark-plaza", room: "plaza" },
  { id: "landmark-grand-plaza", room: "grand-plaza" },
  { id: "landmark-hunting-ground", room: "hunting-ground", tile: { tileX: 35, tileY: 30, spreadRadiusInTiles: 0 } },
  {
    id: "landmark-hunting-den",
    room: "hunting-den",
    tile: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 },
    requiresItemKey: "entry-pass",
    deniedMessage: "입장권은 다람쥐를 잡아서 획득하세요",
  },
];

export const INTERACTABLE_DEFINITIONS: readonly InteractableDefinition[] = [
  {
    id: "plaza-link-board",
    kind: InteractableKind.Link,
    at: { room: "plaza", tiles: [{ tileX: 17, tileY: 23 }] },
    title: "안내 링크 (자리표시)",
    url: "https://example.com/zep-test-placeholder",
  },
  {
    id: "plaza-notice-board",
    kind: InteractableKind.Notice,
    at: {
      room: "plaza",
      tiles: [
        { tileX: 44, tileY: 23 },
        { tileX: 45, tileY: 23 },
      ],
    },
    title: "남문 길 안내",
    body: "남쪽: 초보 들판\n북쪽: 대광장\n\n성문 앞 길잡이에게 임무를 받고 동쪽 상점에서 준비하세요. T 키로 지역 이동 목록을 확인할 수 있습니다.",
  },
  {
    id: "plaza-quiz-stand",
    kind: InteractableKind.Quiz,
    at: { room: "plaza", tiles: [{ tileX: 47, tileY: 8 }] },
    title: "퀴즈 (자리표시)",
    question: "이 서비스의 실시간 서버는 어떤 프레임워크로 만들어졌을까요?",
    choices: ["Colyseus", "Socket.IO", "Firebase"],
    answerIndex: 0,
    explanation: "이 서비스의 실시간 서버는 Colyseus로 구현되어 있습니다.",
  },
  {
    id: "plaza-hunting-ground-npc",
    kind: InteractableKind.Npc,
    at: { room: "plaza", tiles: [{ tileX: 29, tileY: 22 }] },
    title: "남문 길잡이",
    body: "남쪽 성문을 지나면 초보 들판입니다. 들판에서 입장권을 얻으면 북쪽 바위 사냥굴로 들어갈 수 있습니다.\n\n동쪽 상점에서 약초와 장비를 준비하세요. 공격은 Space, 가방은 I입니다.",
    avatarSkin: 21, // 백발 / 파랑 고글 / 주황 코트 (assets/README.md 스킨표) — 안내인 인상, 교체 쉬움
    blocksMovement: false,
  },
  {
    id: "plaza-shop-npc",
    kind: InteractableKind.Npc,
    blocksMovement: false,
    at: { room: "plaza", tiles: [{ tileX: 35, tileY: 20 }] },
    title: "남문 상점",
    body: "약초와 사냥 장비를 팝니다. 첫 임무 보상으로 낡은 단검을 마련하고 더 강한 검과 갑옷을 준비하세요.\n\n전리품은 가방의 판매 버튼으로 바꿀 수 있습니다.",
    avatarSkin: 16, // 갈색 머리 / 빨강 상의 (assets/README.md 스킨표) — 안내 NPC(21)와 겹치지 않는 인상
  },
  {
    id: "hunting-ground-return-npc",
    kind: InteractableKind.Npc,
    blocksMovement: false,
    at: { room: "hunting-ground", tiles: [{ tileX: 39, tileY: 29 }] },
    title: "마을로 돌아가는 길",
    body: "남쪽 문을 나가면 남문 마을입니다.\n\n길잡이에게 임무를 보고하고 상점에서 장비를 준비하세요.",
    avatarSkin: 22, // 어두운 피부 / 갈색 머리 / 파랑 셔츠 (assets/README.md 스킨표) — 안내 NPC(21)·상점 NPC(16)와 겹치지 않는 인상
  },
];

export class LegacyBossRoom extends MetaverseRoom {
  protected override monsterSpawns(): readonly MonsterSpawnDefinition[] {
    return MONSTER_SPAWN_DEFINITIONS.filter((spawn) => spawn.room === this.roomName);
  }
  protected override monsterTypes(): ReadonlyMap<MonsterKind, MonsterType> { return MONSTER_TYPES; }
  protected override createPortalIndex(map: CollisionMap): PortalIndex {
    return new TablePortalIndex(this.roomName, PORTAL_DEFINITIONS, map);
  }
  protected override createInteractableIndex(map: CollisionMap): InteractableIndex {
    return new TableInteractableIndex(this.roomName, INTERACTABLE_DEFINITIONS, map);
  }
  protected override createLandmarkIndex(home: SpawnArea): LandmarkIndex {
    return new TableLandmarkIndex(this.roomName ?? this.state.roomType, LANDMARK_DEFINITIONS, home);
  }
}

export function createLegacyGameServer(...args: Parameters<typeof createGameServer>): ReturnType<typeof createGameServer> {
  const server = createGameServer(...args);
  const [profileStore, inventoryStore, bossStateStore, progressStore, questStore, adminOwnerKeys = new Set<string>(), currencyStore, settlementStore, classStore, tradeStore] = args;
  void profileStore;
  for (const definition of ROOM_DEFINITIONS) {
    server.define(definition.name, LegacyBossRoom, {
      ...definition, realCapacity: definition.realCapacity ?? definition.maxClients,
      inventoryStore, bossStateStore, progressStore, questStore, currencyStore, settlementStore, classStore, tradeStore, adminOwnerKeys,
    });
  }
  return server;
}
