# 병렬 성장 검증과 위험한 숲 구현 계약

상태: 2026-09-22 구현 승인에 따른 설계 계약. 사용자는 직전 제안의 **성장 루프 E2E, 세 번째 위험한 숲, 실제 PostgreSQL 거래 경합 검증**을 대상으로 “병렬 코드작업 시작해라”라고 명시적으로 승인했다. 이후 모든 작업·commit·push는 `main`에서 수행하고 branch를 만들지 않도록 지시했다. main 담당자가 기존 작업을 fast-forward하여 `main == origin/main == d14ab02`로 동기화했다. 추가 기능 승인 절차는 필요하지 않다.

이 문서는 구현·검증·배포 완료 기록이 아니다. 실제 변경·실행 결과는 main 담당자가 별도 implementation 기록과 roadmap/decisions에 남긴다. 기존 EXP 곡선, 들판 EXP 1/2/3, 굴 EXP 20/32, 기존 boss EXP 600과 영속 respawn을 보존한다. DB migration, 신규 boss, 직업·스킬, SSO gateway/500 CCU PoC, 배포는 범위 밖이다.

## Task Plan: 독립된 세 작업과 숲의 두 구현 단위

- Phase 0 Design → architect: 기존 room/portal/AI/loot/store/client 경로를 조사하고 이 계약 확정.
- Phase 1 Implementation → tester(E2E) | tester(DB) | coder(숲 server) → ui-engineer(숲 map/client). **parallel: yes; file_overlap: 아래 소유권을 지키면 없음**. 가용 agent slot에 따라 coder와 UI는 순차로 시작할 수 있다.
- Phase 2 Verification → tester: 실제 browser 루프, PostgreSQL 연결 간 경합, 숲 왕복·행동·보상·map 안전거리. main: 전체 typecheck/test/build 통합.
- Phase 3 Review → reviewer, 거래·권한 수정이 발생하면 guardian. 구현 기록 저장 후 main에서 commit/push; 서버 배포 여부는 별도로 기록.

모든 경로는 Git root `code/` 기준이다. 기존 경로는 확인했고 신규 산출물은 아래에서 신규로 표시한다. 각 담당자는 다른 작업자의 변경을 되돌리지 않는다.

| 단위 / Agent | 입력·의존성 | 독점 소유 경로 / 출력 |
|---|---|---|
| 성장 루프 / tester | 기존 field·quest·shop API; 숲과 독립 | 신규 `client/e2e/tests/first-growth-loop.spec.ts`, 필요한 신규 `client/e2e/helpers/` helper. 기존 config/helper 수정은 main과 먼저 경계 조정. browser 증거·실행 결과 |
| DB 경합 / tester | 기존 PostgreSQL store; main이 실제 DB 실행 환경 확보 | 신규 `server/src/db/settlementStore.realdb.test.ts`, 필요한 신규 test helper. 경합 증거·SQL 최종 상태·실행 결과 |
| 숲 server / coder | 아래 좌표·수치 계약 | 기존 `server/src/rooms/{definitions,portalDefinitions,landmarkDefinitions,monsterDefinitions,itemDefinitions}.ts`, `server/src/game/monsterAi.ts`, `shared/src/landmarks.ts`. 기존 관련 server test 및 신규 숲 test. API 변경은 없음 |
| 숲 map/client / ui-engineer | 아래 계약; JSON 생성 후 server 통합 검증 | 신규 `tools/generate-hunting-forest.mjs`, `assets/maps/hunting-forest.json`; 기존 `tools/generate-hunting-den.mjs`, `assets/maps/hunting-den.json`; 기존 `client/src/world/{heritageArt,heritageMonsterArt}.ts`, `client/src/ui/{regionGuide,minimapTerrain,inventoryPanel}.ts`. 필요한 신규 forest browser spec |
| 통합 / main | 각 담당자 handoff | implementation record, `docs/roadmap.md`, `docs/decisions.md`, Git 동기화·commit·push, DB 실행 환경 |

coder는 map/client 경로를 수정하지 않고 UI는 server/shared 정의를 수정하지 않는다. `metaverseRoom.ts`, `server.ts`, wire protocol 및 DB production 변경은 현재 불필요하며, 실제 결함이 확인되면 main이 별도 담당자를 정한다. E2E tester가 기존 2567/5173 browser 실행을 먼저 독점하고 종료를 알려준 뒤 UI/숲 tester가 사용한다.

## Design Decision: 새 지역 연결과 재사용

Options: 1) 새 monster kind·wire schema·별도 전투 시스템을 도입 — 독자적 표현이 가능하지만 client sprite/quest/protocol/DB까지 변경 면적이 커진다. 2) 새 room·map을 기존 room별 monster resolver, item catalogue, portal/landmark에 추가 — 현재 API와 저장 데이터를 보존하고 지역별 전투·보상 차이를 구현할 수 있다.

Decision: **2**. 기존 rabbit/deer sprite를 사용하며 숲 전용 수치·행동·보상을 제공한다. 같은 스킨을 쓴다는 한계는 implementation 기록에 명시한다. room 표시 이름은 **위험한 숲**, 권장 Lv 8–15이며 level 입장 제한은 만들지 않는다.

### 좌표·room 계약

| 정의 | 고정 값 |
|---|---|
| room name / roomType / mapKey | `hunting-forest` |
| 수용 인원 | `maxClients: 500`, `realCapacity: 20` — 기존 굴 구조 재사용, 500 CCU 검증 주장이 아님 |
| map | 64×37 tiles, 기존 camera border 유지, interior x16..47 / y8..27 |
| join/home spawn | `(31,24)`, `spreadRadiusInTiles: 1` |
| `hunting-den-forest-door` | 굴 trigger `(47,25)`, `(47,26)` → 숲 `(31,26,r0)` |
| `hunting-forest-south-door` | 숲 trigger `(31,27)`, `(32,27)` → 굴 `(46,25,r0)` |
| `landmark-hunting-forest` | name `위험한 숲 · Lv 8–15`, room `hunting-forest`, tile `(31,26,r0)` |
| 입장권 | 숲 진입 portal/landmark에 기존 `entry-pass`, 기존 안내 `입장권은 다람쥐를 잡아서 획득하세요`. 숲 탈출에는 gate 없음 |

실제 굴 JSON의 x30..47/y23..27은 모두 walkable이다. 남동쪽을 연결하면 기존 몬스터 좌표를 바꾸지 않고 새 도착지·문과 몬스터 사이 안전거리를 유지할 수 있다. 기존 굴 남쪽 출구/도착지와 모든 boss 위치는 보존한다. 굴 generator는 새 문 그림·self-check만 추가하고 기존 collision을 보존한다.

숲은 짙은 나무 군집 사이 넓은 순환 길과 사냥 공터로 구성한다. 중앙 x30..33 남쪽 동선은 열어두고 모든 walkable tile은 연결한다. 각 통로는 최소 2 tiles 폭, 나무 지면 footprint와 collision 일치, camera border 안 walkable tile 0을 검사한다. 단순 전체 tint 변경만으로 숲 지형을 완료 처리하지 않는다.

## Design Decision: 매복 행동

Options: 1) 돌진/원거리/새 상태 기계를 추가 — 표현은 크지만 action·wire·연출·cooldown 계약이 넓어진다. 2) 현재 Hold/Attack/Respawn만 사용하는 제자리 매복형을 추가 — 접근 시 공격하지만 추격하지 않아 들판의 도주형 및 굴의 추격형과 구별된다.

Decision: **2**. `ambush`는 보이는 제자리 공격형이며 은신 기능이 아니다. 일반 몬스터 분기와 기존 cooldown/respawn 처리 순서를 보존한다.

Interface: 기존 `server/src/rooms/monsterDefinitions.ts`의 type alias에 한 값만 추가한다. 아래 나머지 서명은 **현존 API 유지 계약**이며 신규 파일/추상화가 아니다.

```ts
export type MonsterBehavior = "aggressive" | "timid" | "ambush";

export function monsterTypesForRoom(
  roomName: string | undefined,
): ReadonlyMap<MonsterKind, MonsterType>;

export function decideMonsterAction(
  snapshot: MonsterSnapshot,
  nearbyPlayers: readonly MonsterTarget[],
  now: number,
  type: MonsterType,
): MonsterAction;
```

- dead이면 기존 respawn deadline 처리; alive인 ambush는 1 tile 이내 가장 가까운 상대에게만 기존 Attack을 사용한다. tie-break와 attack cooldown도 기존 규칙을 사용한다.
- 상대가 없거나 1 tile 밖이면 Idle/Hold, target null. cooldown 중 인접 상대가 있으면 Attack 상태/Hold. **Step을 반환하지 않는다.** 공격 타깃이 같은 tile인 경우도 허용한다.
- `ambush` spawn은 wander radius 0, aggro radius 1. boot validator에 enum 값을 추가하고 이 두 불변 조건을 검사한다. AI tests는 target 부재/거리2/인접/동일tile/cooldown/dead/respawn을 포함한다.
- 일반 aggressive/timid 및 기존 unknown-room fallback을 변경하지 않는다. forest resolver는 base map과 기존 field/den map/loot 배열을 mutate하지 않는다.

### 전투·spawn 수치

아래는 초기 콘텐츠 수치이며 장시간 실플레이 균형이 검증되었다는 뜻이 아니다. 표에 없는 MonsterType 값은 기존 kind에서 상속한다.

| 숲 kind | HP / EXP | behavior | damage / attack ms | aggro / leash | chase / wander / respawn ms |
|---|---|---|---|---|---|
| rabbit | 96 / 45 | ambush | 20 / 1600 | 1 / 기존10 | 기존400 / 기존1600 / 기존12000 |
| deer | 140 / 70 | aggressive | 17 / 1200 | 3 / 기존10 | 400 / 기존2000 / 기존16000 |

상속 값은 구현 시 기존 type을 spread하며 표의 `기존` 값 때문에 base를 수정하지 않는다. rabbit/deer의 기존 원본 interval이 표와 다르면 원본을 보존하고 기록을 정정한다.

| spawn IDs | 좌표 | wander radius |
|---|---|---|
| `hf-rabbit-01` .. `04` | `(22,12)`, `(41,12)`, `(22,19)`, `(41,19)` | 0 |
| `hf-deer-01` .. `04` | `(27,12)`, `(36,12)`, `(25,18)`, `(38,18)` | 1 |

모든 spawn과 wander 범위를 map에서 열어둔다. 전체 join spread x30..32/y23..25, portal arrival/trigger, landmark/home에서 `Chebyshev(monsterSpawn, arrival) > wanderRadius + aggroRadius`를 검사한다. 새 굴 arrival/trigger도 기존 전체 spawn/boss에 대해 같은 검사를 한다. 새 boss나 영속 monster row는 추가하지 않는다.

## Design Decision: 용도 있는 보상

Options: 1) 미래 제작용 소재만 추가 — 현재 사용할 수 없어 보상 연결 요구를 만족하지 못한다. 2) 즉시 판매 가능한 전리품과 기존 cloak slot 장비 추가 — 현재 상점/가방/장착/재접속 경로를 그대로 사용한다.

Decision: **2**. 기존 catalogue 뒤에 아래 stackable item을 추가한다. `possession`은 설정하지 않는다. cloak은 기존 아이콘을 재사용하고 장착 표시는 cloak slot으로 처리한다. 신규 sprite나 제작 시스템은 만들지 않는다.

```ts
const forestItems: readonly ItemDefinition[] = [
  { key: "forest-resin", name: "숲의 수지", icon: "acorn", sellValue: 16 },
  { key: "ancient-bark", name: "오래된 나무껍질", icon: "carrot", sellValue: 28 },
  {
    key: "forest-cloak", name: "숲지기 망토", icon: "leather-armor", sellValue: 90,
    equipment: { slot: "cloak", stats: { damageReduction: 0.1 } },
  },
];
```

이 블록은 catalogue에 삽입할 row 계약이며 별도 exported collection이나 파일을 만들라는 요구가 아니다. client `EQUIPMENT_ITEM_SLOTS`에 `forest-cloak: EquipmentSlot.Cloak`만 추가한다. 기존 가방/character stat 기능을 이용한다.

구현 검토에서 최초 제안의 HP+20은 장착 변경 시 HP cap 동기화가 추가로 필요함을 확인했다. 이번 범위를 새 자원 동기화 체계로 넓히지 않고 기존 서버 계산·API 표시가 지원하는 피해 감소 10%로 확정했다. 다른 방어구와는 기존 곱연산으로 결합하며 10%p 단순 합산하지 않는다.

| 숲 kind | 전체 교체 loot table — 각 quantity 1, 독립 확률 |
|---|---|
| rabbit | forest-resin 80%, copper-coin 30%, herb 15%, forest-cloak 2% |
| deer | ancient-bark 75%, copper-coin 40%, herb 20%, forest-cloak 4% |

runtime kill과 `/api/loot-table/hunting-forest`는 같은 room resolver를 사용한다. 기존 response envelope/fields를 보존하고 EXP·수량·판매가 표시는 server 값을 따른다. 지역 안내에서 제자리 공격형·추격형, 판매 전리품과 망토, 남쪽 굴 출구를 설명한다. 숲 전용 map palette/minimap/heritage monster enable을 추가하되 old-region rendering은 보존한다.

## 성장 루프 E2E 계약

Options: 1) 기존처럼 50전/quest/loot를 주입해 UI 경로만 검사 — 빠르지만 이번 실제 획득 루프 요구를 충족하지 못한다. 2) 인증 identity만 준비하고 실제 입력과 서버 이벤트로 완주 — 시간이 길어도 획득·정산·판매·장착의 연결을 검증한다. **2 선택.**

1. 새 UUID account의 local gateway header fixture를 준비한다. 기존 `x-auth-request-access-token`의 JWT payload `sub`를 사용하며 돈·아이템·EXP·quest row는 0에서 시작한다. 실제 gateway 통과를 검증한 것으로 표현하지 않는다.
2. 남문 마을 guide `(29,22)`에서 `first-hunt`를 실제 버튼으로 수락, 남문을 걸어 들판 진입, 실제 Space 공격으로 squirrel 3마리 처치. 도주형을 추격하고 필요 시 실제 추가 사냥으로 판매 가능한 전리품을 얻는다. RNG 결과는 서버에서 관찰하고 고정하지 않는다.
3. `quest:updated`와 reward/currency 이벤트, tracker/balance로 완료와 50전 지급을 관찰한다. 이 구현의 보상은 완료 즉시 자동 정산이므로 없는 수령 버튼을 만들지 않는다.
4. 마을로 걸어 귀환하고 실제 가방 판매 버튼으로 획득 전리품을 판매. shop `(35,20)`에서 40전 `old-dagger`를 구매하고 weapon slot 장착. 관측한 판매 수량×sellValue로 정확한 잔액을 계산한다.
5. 같은 identity/context에서 tab을 닫고 새 tab으로 재접속. quest 정산 재발 없음, 잔액·판매 감소량·단검 수량·장착·stat 유지 확인. 단순 페이지 reload로 초기화를 가장하지 않는다.

읽기 전용 WS decode와 map collision을 이용한 경로 계획은 허용한다. Phaser 내부 상태 변경, synthetic server message, fake loot RNG, inventory/currency/quest API 응답 대체는 금지한다. 몬스터 위치 관찰이 필요하면 수신 state를 decode하거나 실제 화면을 사용한다. 제한시간/최대 사냥 수/실패 screenshot을 두고 무한 재시도하지 않는다. 새 spec은 기존 E2E와 분리하며 full suite 성공을 이 spec 성공으로 대체하지 않는다.

## 실제 PostgreSQL 거래 계약

현존 API는 다음과 같으며 production store 인터페이스 변경은 필요하지 않다.

```ts
interface SettlementEffects {
  readonly currencyDelta?: number;
  readonly items?: readonly SettlementItemGrant[];
  readonly itemDebits?: readonly SettlementItemDebit[];
}
interface SettlementStore {
  settle(grantKey: string, ownerKey: string, effects: SettlementEffects): Promise<SettlementOutcome>;
}
```

`PostgresSettlementStore(pool)`, `PostgresInventoryStore(executor).equip(ownerKey, itemKey, slot)`를 실제 독립 연결/store instance에서 실행한다. `ZEP_TEST_DATABASE_URL`이 없으면 명시적으로 skip하고 실제 DB 성공으로 보고하지 않는다. 기존 `runMigrations`를 사용하며 새 revision은 필요하지 않다. test 전용 schema/고유 owner·grantKey로 격리하고 자신의 데이터만 정리한다.

- 동일 판매 key 동시·순차 replay: item 1회 감소, balance 1회 증가, reward_grant 1행, replay outcome 동일.
- equip 선점 후 sale: 실제 row lock 대기를 관찰하고 sale이 equipped-item으로 거절되는지 확인. equip·item은 유지, currency/ledger는 불변.
- sale 선점 후 equip: sale commit 후 equip 실패, item 제거, equipped slot 비어 있음. `pg_backend_pid()`로 물리 연결 구분 및 `pg_stat_activity`/lock 등으로 실제 대기를 확인한다. 단순 `Promise.all`만으로 순서를 추측하지 않는다.
- 실패 원인: 부족한 item/balance 또는 뒤쪽 DB statement 실패. 앞쪽 currency/item write도 rollback, ledger 없음, 같은 key 정상 retry 성공. DB failpoint는 test schema/transaction에 제한하고 production fail hook은 추가하지 않는다.
- DB test는 저장 상태 원자성을 검증한다. runtime 장비 cache/다중 process invalidation까지 검증했다고 표현하지 않는다. 이번 코드에서 그 결함이 발견되면 별도 production 수정 소유권과 regression을 정한다.

## 검증·자체 검토

- 숲 generator self-check, 기존 굴 generator 결과 재현, room boot, portal/landmark gate, full spread 안전거리, monster resolver 불변성, 실제 kill EXP/loot/API 일치, cloak 장착·판매 거절·해제 후 판매를 검사한다.
- `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`; 새 E2E와 숲 browser 왕복; `ZEP_TEST_DATABASE_URL` 설정 실제 DB suite 실행. 실행하지 않은 검사는 이유와 함께 implementation 기록에 명시한다.
- 실패 모드 검토: map 등록 누락, client sprite enable 누락, loot 표시 불일치, gate 우회, portal 재진입 loop, spawn aggro, 제자리 AI chase 누출, old-region 값 변경, identity 분리, RNG 무한 대기, replay 중복 정산, DB lock 순서·rollback, equipped cache와 DB 검증 혼동을 각 담당자의 검사에 배정했다.
- 가장 작은 변경으로 기존 data table/AI action/store를 조합하고 신규 protocol/migration/상속 계층을 도입하지 않는다. 코드 구현 전 사용자 승인은 위에 기록했으며 모든 작업은 main에서 수행한다. 구현 후 reviewer 승인·실제 검증·implementation 기록이 남아 있으므로 이 설계만으로 완료를 선언하지 않는다.
