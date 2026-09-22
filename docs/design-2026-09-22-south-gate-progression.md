# 남문·초기 성장·사냥터 묶음 구현 계약

> **과거 작업 기록:** 당시 남문 구현은 `5eb0f33`으로 저장한 뒤 main에 통합했다. 후속 숲·실DB·성장 검증 `ac70d3f`, 가방 비교 `e7b01d5`, 상점 비교 `a8fbcb0`도 origin/main에 push 완료했다. 아래 미구현·미검증·branch 표기는 당시 범위이며 현재 정본은 [메모리](../PROJECT_MEMORY.md)와 [로드맵](roadmap.md)이다. 운영 배포는 미수행이다.

> **2026-09-22 상태 갱신:** 사용자가 여러 작업의 묶음 진행을 승인한 뒤 이 계약의 남문 홈, 초기 장비 구매·전리품 판매, 들판·굴 차별화를 구현하고 검증했다. 아래 설계·승인 대기 표현은 구현 전 계약 수립 당시의 기록이다. 실제 구현 범위, 검증 결과 및 남은 제한은 [구현 기록](implementation-2026-09-22-south-gate-progression.md)을 따른다. 커밋·푸시·배포는 수행하지 않았다.

상태: 2026-09-22 사용자의 여러 항목 묶음 진행 승인에 따른 구현 설계. 구현·검증 결과는 [구현 기록](implementation-2026-09-22-south-gate-progression.md)에 별도로 남긴다. 기준 HEAD는 `297e7ba`, 작업 branch는 `feat/south-gate-progression`이다.

## Task Plan: 남문과 Lv1–10 성장 연결

- Phase 0 Design → architect: 현재 room/아이템/전투/지도 생성 구조 확인, 아래 계약 확정.
- Phase 1 Implementation → ui-engineer: 남문·들판·굴 지도와 client 표시. coder: 지역별 몬스터·보상·상점·AI. **parallel: yes; file_overlap: 없음**. 소유 파일 추가가 필요하면 main이 먼저 조정한다.
- Phase 2 Verification → tester: 지도 연결·안전 거리, 지역별 실제 보상과 API 일치, 장비 구매·장착·재접속·중복 정산, browser 화면과 실제 이동 확인.
- Phase 3 Review → reviewer: 계약·기존 자료 보존 확인. guardian: 판매 가능한 장비 추가에 따른 정산/장착 동시성 검토.

### 파일 소유권과 입출력

기존에 존재하는 아래 파일들을 수정 대상으로 확인했다. `client/src/**`는 UI 담당 범위이며 필요 파일만 수정한다. 모든 상대 경로는 Git 저장소 `code/` 기준이다.

| 단위 | Agent / 입력 | 출력 파일·모듈 | 의존 |
|---|---|---|---|
| 남문 및 사냥터 지형 | ui-engineer / 아래 좌표 계약 | `tools/generate-plaza.mjs`, `tools/generate-hunting-ground.mjs`, `tools/generate-hunting-den.mjs`, `assets/maps/plaza.json`, `assets/maps/hunting-ground.json`, `assets/maps/hunting-den.json`, `client/src/world/heritageArt.ts` | 설계 |
| 이동·NPC·지역 이름 | ui-engineer / 기존 ID 보존 | `server/src/rooms/definitions.ts`, `portalDefinitions.ts`, `interactableDefinitions.ts`, `landmarkDefinitions.ts`, `shared/src/landmarks.ts`, `client/src/ui/regionGuide.ts` | 좌표 계약 |
| 가방·드랍·무기 표시 | ui-engineer / 아이템 키 및 API 계약 | `client/src/net/lootTable.ts`, `client/src/ui/lootTablePanel.ts`, `inventoryPanel.ts`, `client/src/world/weaponVisual.ts`; 필요 시 동일 client 범위의 연관 화면 | 계약 확정; server 완료 전 병렬 가능 |
| 지역 몬스터와 경제 | coder / 아래 수치·불변식 | `server/src/rooms/monsterDefinitions.ts`, `itemDefinitions.ts`, `shopDefinitions.ts`, `questDefinitions.ts`, `lootTableView.ts`, `metaverseRoom.ts`, `server/src/game/monsterAi.ts`, `items.ts`, `server/src/server.ts` | 설계 |
| 회귀 및 증거 | tester / 구현 완료 코드 | 위 모듈의 기존 `*.test.ts`, `client/e2e/tests/`의 관련 기존 spec 및 필요한 신규 regression spec | 양 구현 완료 |
| 기록 | main | `docs/implementation-2026-09-22-south-gate-progression.md`, `docs/roadmap.md`, `docs/decisions.md` | 실제 변경·검증 결과 |

`server/src/rooms/contracts.ts`와 `shared/src/protocol.ts`는 현재 설계상 변경 불필요하다. 필요해지면 coder 소유로 추가하며 UI 담당에게 알려야 한다. tester 외 담당자의 test 수정은 main이 경계를 배분한다. 사용자의 기존 미커밋 변경은 유지한다.

## Design Decision: 기존 두 사냥 지역으로 연결

Options: 1) 신규 숲 room까지 추가 — 세 테마를 갖추지만 room 등록·지도·portal·landmark·boss 지속성·검증 면적이 늘어난다. 2) 기존 들판/굴을 먼저 완결 — 기존 ID·두 hunting room의 인원 제한·계정 데이터를 유지하면서 남문→사냥→판매→장비 교체 흐름을 완성할 수 있다.

Decision: **2**. 이번 묶음은 남문 홈, 두 사냥 지역의 지형·행동·보상 차이, Lv1–10의 장비 목표를 구현한다. 세 번째 위험한 숲은 후속이며 이번 결과를 세 테마 완성으로 표현하지 않는다. 기존 SSO gateway/500 CCU PoC를 검증했다고 주장하지 않는다.

## 남문 좌표 계약

plaza 전체 64×35와 내부 x16..47/y8..25 유지. 최초 spawn 및 H 귀환의 plaza 내부 지점은 `(31,20,radius0)`. room ID 및 landmark ID는 유지한다. H의 기존 시작 room 의미도 유지하여 `?room=` 검증 진입을 깨뜨리지 않는다.

| 항목 | 최종 좌표/대상 |
|---|---|
| `plaza-south-door` trigger | `(31,25)`, `(32,25)` → hunting-ground `(35,30,r0)` |
| `plaza-north-door` trigger | `(31,8)`, `(32,8)` → grand-plaza `(22,9,r0)` |
| `hunting-ground-south-door` 복귀 | 기존 trigger 유지 → plaza `(31,23,r0)` |
| `grand-plaza-north-door` 복귀 | 기존 trigger 유지 → plaza `(31,10,r0)` |
| `plaza-hunting-ground-npc` | `(29,22)`, nonblocking, 남문·첫 사냥 안내 |
| `plaza-shop-npc` | `(35,20)`, nonblocking, 약초·장비·전리품 판매 안내 |
| 기존 안내물 | link `(17,23)`, notice `(44/45,23)`, quiz `(47,8)` 유지 |

남쪽 성벽의 지면 footprint는 y24, x17..28 및 x35..46. 열린 문은 x29..34이고 중앙 거리와 남쪽 출구를 연결한다. x16 측면 길은 유지하고 남쪽 문이 주동선으로 보이도록 표현한다. 기존 분수 중심 대칭 구도를 제거하고 건물·장사 공간·성벽을 구성한다. 모든 큰 장식의 지면 footprint와 실제 충돌은 일치해야 한다. 통과 가능한 문 위쪽 지붕은 보행자와 높이 기준을 맞춘다.

들판은 넓은 초지와 길, 굴은 암반 띠와 연결된 두 공간으로 구조를 구별한다. 단순 색상/장애물 tile ID 교체만으로 지형 완성 판정을 하지 않는다. 기존 두 hunting room의 portal, join spawn, landmark 좌표는 유지한다. 모든 통로는 2타일 이상이며 greedy AI를 가두는 오목한 막다른 길을 만들지 않는다. 생성 script와 JSON, client 장식, server 좌표를 함께 검증한다.

## Design Decision: 지역별 몬스터 정의

Options: 1) monster kind를 지역마다 추가 — 기존 sprite·quest kind·wire mapping 전체를 확장해야 한다. 2) 현재 kind를 유지하고 room별 유효 type map을 해석 — 표시·quest 연속성을 보존하면서 전투/보상을 지역별로 바꿀 수 있다.

Decision: **2**. 기본 `MONSTER_TYPES`의 기존 HP·EXP·loot 값은 유지한다. 최초 들판의 EXP1/2/3이라는 기존 초반 성장 결정도 유지한다. 변경은 명시적 room override에만 둔다.

Interface: `server/src/rooms/monsterDefinitions.ts`의 기존 type을 아래 형태로 확장하고, coder가 구현한다.

```ts
export type MonsterBehavior = "aggressive" | "timid";

// Existing MonsterType fields remain unchanged.
export interface MonsterType {
  behavior?: MonsterBehavior; // omitted = existing aggressive behavior
}

export function monsterTypesForRoom(
  roomName: string | undefined,
): ReadonlyMap<MonsterKind, MonsterType>;
```

이 블록은 기존 interface에 추가할 계약이며 기존 필드를 지우는 재선언 지시가 아니다. 알려지지 않은 room/undefined는 기본 map을 반환한다. resolver는 기본 type이나 기본 loot 배열을 mutate하지 않는다. 같은 room의 동일 kind에는 하나의 유효 type만 존재한다. `MetaverseRoom.monsterTypes()`가 resolver를 사용하되 현재 test subclass override seam을 유지한다. runtime의 `type` 하나가 HP·행동·EXP·loot를 모두 제공하고 `buildLootTableView(roomName)`도 같은 resolver를 사용한다. 부팅 시 각 등록 room의 유효 map과 spawn을 검증하여 override의 잘못된 item key/확률/EXP가 누락되지 않게 한다.

| 지역/kind | HP / EXP | 행동·수치 변경 |
|---|---|---|
| 들판 squirrel | 기존 12 / 1 | timid, 플레이어를 피함. flee step 1000ms로 player 600ms보다 느림 |
| 들판 rabbit | 기존 19 / 2 | 기존 공격·추격 유지 |
| 기본 deer | 기존 28 / 3 | 원래 값 유지 |
| 굴 rabbit | 48 / 20 | aggressive, aggro3, damage9, chase400ms, attack800ms |
| 굴 deer | 80 / 32 | aggressive, aggro3, damage13, chase600ms, attack1200ms |
| boss | 기존 5000 / 600 | 공격·respawn6시간·지속성·ID·위치 모두 유지 |

timid도 기존 Hold/Step action을 사용하고 새 wire enum은 추가하지 않는다. 감지 거리2 이내에서 플레이어 반대 방향으로 움직이되 모든 후보는 leash 안쪽으로 제한한다. 공격 action을 반환하지 않는다. step 대기 중·갈 곳이 없는 벽 모서리에서는 Hold하며, 무한 왕복이나 map 외부 이동을 허용하지 않는다. 안전한 상대축 후보가 있으면 그쪽으로 피할 수 있다. 플레이어가 따라잡을 수 있어야 하므로 더 빠른 flee나 무적 상태를 도입하지 않는다.

### 굴 도착 안전 보정

aggro 확대만 적용하면 기존 ordinary wander radius3의 일부가 도착 spread에 접근한다. 굴 일반 몬스터의 wander radius는 모두1로 바꾸고 `hd-rabbit-04`는 `(26,20)`에서 `(25,19)`로 옮긴다. boss wander3는 그대로다. UI 지도는 `(25,19)`를 비워둔다. 전체 join spread `(30..32,23..25)`, portal arrival `(31,26)`, death home `(31,24)`에 대해 `Chebyshev(spawn,arrival) > wanderRadius + aggroRadius`를 확인한다. portal trigger 안전성도 별도로 검사한다.

## Design Decision: 성장·상점·드랍

Options: 1) 누적 EXP 곡선 자체를 완화 — 기존 계정의 표시 레벨을 재해석하고 초반 성장 결정도 바꾼다. 2) 기존 곡선과 초반 보상을 보존하고 강화된 지역 보상과 장비 판매 경로를 추가 — 기존 데이터 migration 없이 다음 지역에 갈 이유를 만든다.

Decision: **2**. `shared/src/leveling.ts`는 변경하지 않는다. Lv cap30, EXP threshold, 클래스 배율/스킬, 50전 첫 사냥 quest 보상도 유지한다. 첫 사냥 문구의 북쪽을 남쪽으로 수정한다. 새 장비는 전 직업 공용이며 level/class 착용 제한은 없다. Lv 안내는 추천 구간이고 입장 조건은 기존 entry-pass이다.

| 아이템 key | 용도 / icon | 구매 | 판매 |
|---|---|---:|---:|
| acorn | 기존 전리품 | — | 4 |
| carrot | 기존 전리품 | — | 6 |
| copper-coin | 기존 전리품, 자동 재화 전환 아님 | — | 8 |
| herb | 기존 HP30 회복 | 12 | 기존3 |
| old-dagger | 기존 weapon 공격+2 | 40 | 10 |
| hunting-blade | 사냥꾼 검, weapon 공격+6 / old-dagger | 180 | 45 |
| iron-blade | 철검, weapon 공격+10 / old-dagger | 480 | 120 |
| padded-armor | 누비옷, armor 피해감소15% / leather-armor | 100 | 25 |
| reinforced-armor | 강화 가죽갑옷, armor 피해감소30% / leather-armor | 300 | 75 |
| den-fur | 굴짐승 털, 판매용 / acorn | — | 10 |
| antler | 단단한 뿔, 판매용 / carrot | — | 18 |

새 장비/전리품은 일반 stack item으로 두고 `possession:true`를 붙이지 않는다. 기존 leather-armor20%, golden-helmet15%, entry-pass의 possession 성격 및 이전 소유권은 유지하고 판매 대상으로 만들지 않는다. 장착 중인 장비 판매 거절을 유지하고 판매/장착이 겹치는 실제 경로를 검토한다. 모든 판매 가격은 구매 가격 미만이며 새로운 가격·stat 값도 부팅 validation 범위에 포함한다. 재료라는 이름만 있고 쓰임이 없는 새 아이템은 만들지 않는다.

지역 loot는 **기본 table과 합산하지 않는 전체 대체**이다. 각 entry는 독립 Bernoulli이고 한 table 안에 중복 itemKey를 허용하지 않는다. 다음 수량은 모두1이다.

| 대상 | 실제 loot |
|---|---|
| 들판 전체 | 기본 `MONSTER_TYPES` table 그대로 |
| 굴 rabbit | den-fur75%, copper-coin25%, herb10%, hunting-blade3% |
| 굴 deer | antler70%, copper-coin35%, herb15%, reinforced-armor3%, iron-blade2% |
| 굴 boss | golden-helmet25%, iron-blade50%; EXP600 유지 |

두 지역에서 같은 rabbit을 잡아도 드랍 목표가 다르다. 기존 boss 장비는 유지하면서 굴 boss에는 최종 초기 무기 획득 경로를 더한다. 상점 구매가 확정 경로이며 boss나 희귀 드랍을 얻어야만 성장할 수 있는 구조가 아니다.

### 수치 근거와 한계

기존 계산식은 `round((4 + level - 1 + equipmentAttack) * classMultiplier)`, 기본 공격 간격600ms다. 아래는 이동·스킬·miss·회복을 제외한 단일 대상 정지 계산이며 실플레이 시간 측정이 아니다.

| Lv3 직업 | 단검+2 → 사냥꾼 검+6 → 철검+10 공격력 | 굴 rabbit48HP 타격 수 | 굴 deer80HP 타격 수 |
|---|---|---|---|
| 전사 | 7 → 11 → 14 | 7 → 5 → 4 | 12 → 8 → 6 |
| 도적 | 10 → 14 → 19 | 5 → 4 → 3 | 8 → 6 → 5 |
| 주술사 | 10 → 16 → 21 | 5 → 3 → 3 | 8 → 5 → 4 |
| 도사 | 6 → 10 → 13 | 8 → 5 → 4 | 14 → 8 → 7 |

첫 quest의50전은 단검40전을 확정 구매할 수 있다. 전리품을 전부 판매할 때 kill당 기대 수입은 들판 squirrel4.64전, rabbit6.76전, 굴 rabbit11.15전, deer20.50전이다. 예: 굴 deer는 `0.7*18 + 0.35*8 + 0.15*3 + 0.03*75 + 0.02*120 = 20.50`. 첫 획득 장비를 착용하거나 약초를 쓰면 실제 현금 수입은 이보다 적다. 확률은 구매 보장이 아니며 각 개인의 편차가 있다.

들판에서 squirrel:rabbit=7:3으로66회 사냥하면 평균85.8EXP·348.2전이며 Lv3 threshold85를 넘는다. 이후 굴 rabbit:deer=1:1로121회면 평균3146EXP가 추가되어 합계3231.8EXP로 Lv10 threshold3226을 넘는다. 이는 약187회라는 비교 모델이며, 이동·드랍 편차·몬스터 분포·사망·스킬·동시 이용을 반영한 시간 보장은 아니다. 단검→사냥꾼 검→철검의 두 교체와 방어구 구매가 그 과정에 들어갈 수 있다.

기존 약초 가격12전/HP30 및 out-of-combat 회복은 변경하지 않는다. 최종 balance 판정은 클래스별 짧은 실플레이로 보완하고 Lv30 완성이나 20–30분 내 Lv10을 보장하지 않는다.

## Client/API 계약

기존 `/api/loot-table/:roomName`의 `monsters` envelope와 unknown room의 빈 배열 동작 유지. 다음 additive fields를 server와 client에 함께 반영한다.

```ts
export interface LootTableDropView {
  itemKey: string;
  name: string;
  icon: string;
  chancePercent: number;
  quantity: number;
  sellValue?: number;
}
export interface LootTableMonsterView {
  kind: string;
  name: string;
  expReward: number;
  drops: readonly LootTableDropView[];
}
```

Client는 EXP·수량·판매가를 서버 결과에서 표시한다. 오래된 optional field가 없는 응답을 수용할지는 UI 담당이 결정하되 오표시는 없어야 한다. bag의 기존 `EQUIPMENT_ITEM_SLOTS`에 네 새 장비 key를 추가하고 weapon visual이 새 weapon도 인식하도록 한다. 기존 atlas를 재사용할 수 있지만 아이템 이름과 stats/장착 결과는 구별되어야 한다. 지역명은 남문 마을 / 초보 들판(Lv1–3) / 바위 사냥굴(Lv3–10), 안내는 실제 south gate와 entry-pass 경로를 설명한다.

## 검증 계약

- `npm run typecheck`, `npm test`, `npm run build` 결과를 기록한다. 각 지도 generator 실행 및 생성 결과 일치, spawn·portal·NPC reachability, 도착·boss 안전거리와 camera invariant를 검사한다.
- 유효 몬스터 table에 잘못된 loot key/확률/중복 key/EXP가 있으면 boot 실패. room A 해석 후 B/기본 map 불변. 실제 kill의 EXP/loot와 API의 동일 room 값 일치. 기본 EXP1/2/3과 boss600 고정 확인.
- timid의 도주 간격·벽/모서리·leash·죽음/respawn·추격 가능성을 pure AI regression으로 확인한다. 굴 도착 spread에서 일반 몬스터/보스 즉시 aggro가 없는지 전체 좌표로 검사한다.
- 첫 quest→단검 구매→장착→전리품 판매→다음 무기/방어구 구매. 부족 잔액, 가방 full, nonce replay, 동일 장비 구매, 장착 중 판매·장착/판매 경쟁, 재접속의 계정 결과를 확인한다. In-memory 검증과 실제 PostgreSQL 검증을 구분한다.
- browser에서 최초 남문 화면, shop 접근, 두 방향 portal 왕복, H 귀환, grand-plaza 접근, 지도별 지형 차이, 드랍 정보와 새 장비 장착을 확인한다. 사용자 기존 변경을 수정했다고 오해할 만한 test 전체 덮어쓰기를 금지한다.

## 설계 자체 검토

기존 계정 EXP/아이템 key·boss 지속성과 보상600을 보존한다. 신규 migration·세 번째 room·class/level 착용 gate 없이 기존 시스템 조합으로 한정한다. 지역 table이 runtime·API·boot 검증 중 일부에만 반영되는 실패, spawn aggro 확대, 장비 판매 경쟁, 잘못된 아이콘/장착 키, 장식과 충돌 불일치를 필수 검증 대상으로 분리했다. 배포는 이번 설계나 테스트 통과만으로 완료 처리하지 않는다.
