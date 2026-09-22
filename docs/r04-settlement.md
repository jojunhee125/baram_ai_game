# R04 정산 — 설계·구현·검증

[로드맵](roadmap.md) R04 "믿을 수 있는 보상"의 단일 문서. 승인 이력은 [decisions.md](decisions.md).
**R04-a(저장소 계층)·R04-b(퀘스트 보상 배선) 구현 완료(2026-09-17). R04-c(상점·소모품) 서버 구현
완료(2026-09-18, §10) — 클라이언트(상점 패널 UI)도 완료. 후속 장비 구매/판매 및 가방·상점 비교까지 origin/main에 반영했다. 최신 검증은 [상점 비교 기록](implementation-2026-09-22-shop-equipment-comparison.md)을 따른다.**

## 1. 무엇을 풀어야 했나

| 로드맵 요구 | 해결 |
|---|---|
| 보상 원인 ID 저장, 중복 요청은 기존 결과 반환 | D2 원장 + D3 멱등 게이트 |
| 화폐·아이템 차감/추가를 하나의 원자적 변경으로 | D1 화폐 테이블 + D3 단일 트랜잭션 |
| 퀘스트 완료 시 화폐 보상, 미정산 계정은 재접속 시 재시도 | D6 완료 전이 호출 + 재시도 · D7 `CurrencyChanged` — **R04-b 완료** |
| 상점 구매·소모품 사용 | D4/D5 — **R04-c 완료(§10 이후)** |

착수 시점 실측: 화폐 개념이 코드에 없었고(`copper-coin`은 일반 드롭 아이템), 소모품 개념도 없었으며, 다중 statement 트랜잭션 전례는 마이그레이션 러너뿐이었다. HP는 영속되지 않는다(룸 세션 런타임 값).

## 2. 정산 경로

```
  [원인]                  [정산 코어 · 1 트랜잭션]              [통지]
 퀘스트 완료 ─┐        ┌──────────────────────────┐
 상점 구매  ─┼→ grantKey →│ ① reward_grant INSERT    │
 소모품 사용 ─┘           │    ON CONFLICT DO NOTHING│
                         │ ② 0행 → 저장된 결과 반환 ─┼→ 재요청: 변화 0
                         │ ③ 1행 → 화폐 UPDATE       │
                         │        인벤토리 UPSERT    │
                         │ ④ 결과를 원장에 기록      │
                         └──────────┬───────────────┘
                              COMMIT │ 실패 시 전부 롤백
                                     └→ 퀘스트는 R04-b가 배선(§8) · 상점/소모품은 R04-c에서 배선 완료
```

원장 INSERT가 멱등 게이트다. 자산 변경은 그 INSERT가 행을 만든 트랜잭션 안에서만 일어난다.

## 3. 설계 결정

| | 결정 | 기각한 대안과 이유 |
|---|---|---|
| **D1** 화폐 | 신규 `player_currency` 테이블 | `inventory_item`의 `copper-coin` 재사용 → 기존 드롭 스택이 소급 잔액이 되고 `MAX_DISTINCT_ITEMS` 캡을 소비. `player_progress` 컬럼 추가 → EXP 지급과 행 락을 공유해 사냥 경로에서 경합 |
| **D2** 원인 ID | 호출자가 만드는 결정론적 문자열 PK. `quest:<questId>:<owner>`, `shop:<owner>:<nonce>`, `use:<owner>:<nonce>` | 서버 생성 난수 → 재시도 때 달라져 멱등이 깨진다 |
| **D3** 원자성 | `settle()` 단일 트랜잭션. 락 순서 **화폐 → 인벤토리(`item_key` 오름차순)** 고정 | 순서를 고정하지 않으면 같은 계정 두 탭이 반대로 잠가 데드락 |
| **D4** 구매 | WS `shop:buy` (R04-c 구현) | HTTP → 룸 캐시 동기화 경로를 새로 만들어야 함 |
| **D5** 소모품 | 선차감 후 HP 회복, 세션 소멸 시 롤백 없음 (R04-c 구현) | 선회복은 무한 회복 악용. HP가 영속되지 않아 DB와 원자적으로 못 묶는다 |
| **D6** 퀘스트 보상 | 완료 전이 시 정산 + "완료됐는데 미정산" 재접속 재시도 (R04-b 구현, §8) | 전이가 await되지 않는 경로라 유실 가능. 원장이 멱등하므로 재시도가 안전 |
| **D7** 통지 | `CurrencyChanged` 1종 추가, 아이템은 기존 `ItemGranted` 재사용 (R04-b 구현, §8) | 상위 "정산 완료" 래퍼는 두 메시지를 하나로 묶을 이유가 없다 |

**실패한 정산은 원장 행을 남기지 않는다.** 잔액 부족·가방 가득참이면 원장 INSERT까지 전부 롤백되므로, 같은 `grantKey`로 나중에 재시도해 성공할 수 있다. 성공한 정산만 남고 그 결과가 재요청 시 그대로 반환된다.

## 4. 구현된 것 (R04-a)

| 파일 | 내용 |
|---|---|
| `server/migrations/0008_player_currency.sql` | `owner_key uuid PK` / `balance bigint DEFAULT 0 CHECK (balance >= 0)` / `updated_at` |
| `server/migrations/0009_reward_grant.sql` | `grant_key text PK` / `owner_key uuid` / `result jsonb` / `created_at` + owner 인덱스 |
| `server/src/db/currencyStore.ts` | `getBalance`/`credit`/`debit`. 단일 statement, 잔액 부족은 예외가 아니라 `null` |
| `server/src/db/withTransaction.ts` | `pool.connect()` 기반 BEGIN/COMMIT/ROLLBACK. 이전 전례는 `migrate.ts` 하나뿐이었다 |
| `server/src/db/settlementStore.ts` | `settle(grantKey, ownerKey, effects)`. Postgres·InMemory 두 구현 |
| `server/src/db/inventoryStore.ts` | 생성자를 `Pick<Pool,"query">`로 좁혀 `PoolClient`에서도 실행 가능(트랜잭션 재사용) |

이 시점 계약상 **호출자는 아직 없었다** — 첫 호출자(퀘스트 완료)는 R04-b(§8)에서 붙었다. 상점·소모품 호출자도 이후 R04-c에서 연결했다.

`InMemorySettlementStore`는 공유 `InMemoryCurrencyStore`/`InMemoryInventoryStore` 인스턴스를 동기 경로로 조작한다. 사유 상태를 들면 로컬 개발에서 정산 지급이 실제 가방에 안 보이는 발산이 생기고, 공개 Promise API를 `await`하면 멱등 판정과 기록 사이에 경합이 재도입되기 때문이다.

## 5. 독립 검증에서 잡은 결함 2건 (수정 완료)

fresh context tester가 구현자 자기검증과 다른 각도로 공격해 확정한 것들이다.

**Critical — 멱등 게이트가 `owner_key`를 검증하지 않았다.** `ownerA`로 성공한 `grantKey`를 `ownerB`가 재사용하면 ownerA의 결과(`{ok:true, balance:500}`)를 그대로 돌려줬다. ownerB의 실제 잔액은 0. `grantKey`에 `ownerKey`를 넣는 것은 호출자 규약일 뿐 저장소가 강제하지 않았던 것이 원인이다. → 재생 경로가 `owner_key`를 함께 읽어 비교하고, 불일치는 `SettlementOwnerMismatch`로 **재throw**한다. 잔액 부족 같은 정상 결과가 아니라 호출자의 키 구성 버그이므로 결과값으로 삼키지 않는다(`markDatabaseOk` 후 throw — DB는 멀쩡하다).

**High — `Number(row.balance)`의 정밀도 손실.** 참값 `9007199254740993`이 `9007199254740992`로 반올림됐다(DB 컬럼 직접 조회로 대조). → `toSafeInteger` 가드가 safe-integer 범위를 벗어나면 `RangeError`. 타입을 `bigint`로 바꾸지 않은 이유는 `SettlementOutcome`이 `reward_grant.result` jsonb로 직렬화되는데 `JSON.stringify(bigint)`가 예외이기 때문이다.

재현 실패(설계대로 동작 확인, 재보고 대상 아님): 부분 적용 롤백 실측, `result` NULL 불변식 가드, `currencyDelta: 0` + 아이템 병행, 정확히 0으로 떨어지는 debit, `MAX_DISTINCT_ITEMS` 경계에서 두 구현 일치, `markDatabaseDegraded` 오분류.

## 6. 검증 증거

실제 PostgreSQL 16.15(WSL Ubuntu 컨테이너, `ZEP_TEST_DATABASE_URL` opt-in). 컨테이너 기동 절차는 [R03 문서](r03-quest-and-village.md) §4와 동일하다.

```
npm test --workspace @zep-test/server   → 1117 tests / 1116 pass / 1 fail
npm run typecheck (shared·server·client) → 에러 0
```

실DB에서 실증한 것: 같은 `grantKey` 16건 동시 호출 → 정확히 1건만 적용 / 같은 두 아이템을 반대 순서로 건드리는 두 정산 → 데드락 없음 / 거절된 정산 후 `reward_grant` 무흔적 → 재시도 성공 / DDL 유효성과 jsonb 왕복.

## 7. 한계와 다음

- 남은 실패 1건은 `progressStore.test.ts`의 **기존** 실DB 격리 결함이다(논리 계정 전부를 같은 uuid 한 행으로 매핑). 오늘 코드가 아니며 별도 과제다.
- `withTransaction` 도중 커넥션 강제 종료 시 거동은 실측하지 않았다(코드 경로는 읽었고 논리적으로는 안전).
- safe-integer 초과 `RangeError`는 `markDatabaseDegraded`를 탄다. DB는 멀쩡하므로 의미상 부정확하지만 도달 불가능한 경로라 그대로 뒀다.
- R04-b 착수 전 확정 필요: 화폐 명칭·단위, 소모품 유실 허용 여부, 되팔기 포함 여부, first-hunt 보상 구성. → 2026-09-17 `decisions.md`에서 확정, §8 참고.

## 8. R04-b 구현·검증 (2026-09-17)

퀘스트 완료 보상 배선 — 정산 코어(R04-a)의 첫 호출자. `first-hunt` 완료 시 50전, 아이템 없음(`decisions.md` 2026-09-17).

### 8.1 변경된 파일

| 파일 | 내용 |
|---|---|
| `server/src/rooms/questDefinitions.ts` | `QuestReward`(`currencyDelta`)와 `QuestDefinition.reward?` 추가, 부팅 검증에 양의 정수 확인 추가. `first-hunt`에 `{ currencyDelta: 50 }` 부여. 보상 없는 퀘스트는 `reward`를 아예 생략 — `{ currencyDelta: 0 }`이 아니라 정산 호출 자체가 없어야 하므로 |
| `server/src/rooms/metaverseRoom.ts` | `recordQuestKill`이 완료 전이 순간 `settleQuestReward(..., notify: true)` 호출(D6). `hydrateQuestCache`가 재접속 시 완료돼 있으나 미확인인 행을 `notify: false`로 재시도. `hydrateCurrencyCache` 신설 — 매 룸 입장마다 잔액을 읽어 세션 캐시를 채우고 `CurrencyChanged(reason:"sync")` 전송 |
| `server/src/rooms/contracts.ts` | `RoomCreateOptions.currencyStore`/`settlementStore`, `PlayerSession.currencyBalance` 추가 |
| `server/src/server.ts` / `server/src/index.ts` | 두 스토어를 부팅 시 구성해 각 룸 정의에 주입. 인메모리 경로는 `InMemorySettlementStore`가 룸이 이미 쓰는 `InMemoryCurrencyStore`/`InMemoryInventoryStore`를 공유(하나뿐인 잔액/가방) |
| `shared/src/protocol.ts` | `CurrencyChanged`(`balance`/`delta`/`reason: "quest" \| "sync"`) 추가 |
| `client/src/net/roomConnection.ts` | `CurrencyChanged` 수신 + `attach()` 이전 도착분 버퍼링(`QuestUpdated`와 같은 패턴 — 둘 다 입장 시 서버가 먼저 보낸다) |
| `client/src/ui/inventoryPanel.ts` | 가방 헤더에 잔액 표시(`applyCurrencyChange`) |
| `client/src/ui/itemToasts.ts` | 보상 획득 토스트(`showCurrency`) — 기존 드롭 토스트 목록을 재사용, `copper-coin` 아이콘은 그림만 차용(화폐와 그 아이템은 별개 테이블) |
| `client/index.html`, `client/src/style.css` | `#inventory-currency` 라벨과 스타일 |

### 8.2 정산 호출 흐름

```
 처치 → recordQuestKill
        ├ row.completed && reward 있음
        │   → settleQuestReward(notify:true) → settle() → CurrencyChanged("quest")
        └ 미완료 또는 reward 없음 → 호출 자체가 없음

 입장 → hydrateQuestCache ─ 완료된 행 && reward 있음
        │                   → settleQuestReward(notify:false) → settle() 재시도(침묵)
        └ (await) ──→ hydrateCurrencyCache → getBalance() → CurrencyChanged("sync")
                      ※ 병렬 아님. 재시도가 끝난 뒤 실제 잔액을 읽어 알린다(8.5 참조)
```

### 8.3 D6/D7 세부 동작

- **`ownerKey === null`(SSO 없음)은 정산을 아예 건너뛴다.** 전리품·EXP·퀘스트 진행은 세션 id로 대체하지만 `SettlementStore.settle`은 `assertUuidOwnerKey`로 uuid가 아니면 예외를 던진다(D2 계약, 변경하지 않음). 로컬 개발은 퀘스트가 완료는 되지만 지급은 없다 — 정직한 저하.
- **재시도는 알리지 않는다.** `notify:false`는 원장만 바로잡고 `CurrencyChanged`를 보내지 않는다 — 매 재접속마다 이미 지급된 보상을 다시 알리는 것을 막기 위해서다. 재시도로 확인된 잔액은 같은 입장의 `hydrateCurrencyCache`가 보내는 `"sync"` 메시지로 보인다. **그 sync는 재시도 뒤에 체인으로 실행된다** — 병렬로 두면 항상 정산 전 잔액을 알린다(8.5 High 결함).
- **보상 없는 퀘스트는 `settle` 호출 자체가 없다** — `questSystem.test.ts`로 확인.

### 8.4 검증 증거

```
npm run typecheck (shared·server·client)        → 에러 0
npm run build --workspace=@zep-test/client      → 성공 (vite build)
npm test --workspace @zep-test/server           → 1036 tests / 1036 pass / 0 fail
npx playwright test (client/e2e, 전체 12 spec)  → 93 passed / 0 failed (6.9분)
  (인메모리 경로, DATABASE_URL 미설정 — R04-a §6의 1117건 기준은 실DB opt-in 스위트 포함,
  이번 실행에는 없다. 아래 8.5의 이유로 실DB 재검증은 이번 범위에서 수행하지 않았다.)
```

새로 작성한 좁은 테스트(`server/src/rooms/questSystem.test.ts`, "quest completion rewards" 5건):
- 완료 시 1회 지급, `CurrencyChanged("quest")` 정확히 1건
- 재접속 재시도는 잔액을 두 번 올리지 않고 `"quest"` 사유 메시지도 보내지 않음
- **입장 시 재시도가 지급한 잔액이 그 입장의 `"sync"` 메시지에 담긴다**(아래 High 결함의 회귀 테스트)
- 보상 없는 퀘스트는 완료되어도 `settle` 호출 0건
- SSO 없는 계정은 예외 없이 조용히 건너뜀

### 8.5 독립 검증에서 잡은 결함 1건 (수정 완료)

fresh context tester가 구현자 자기검증과 다른 각도로 공격해 확정했다. R04-a §5와 같은 2단 검증 절차다.

**High — 재접속 정산 재시도가 지급한 잔액이 클라이언트에 반영되지 않았다.** 입장 시 `hydrateCurrencyCache`(await 1홉: `getBalance`)와 `hydrateQuestCache`(await 2홉 이상: `list` → `settle` 트랜잭션)를 **병렬로** 발사했는데, 전자가 구조적으로 항상 먼저 끝나 정산 **이전** 잔액을 `"sync"`로 보냈다. `settleQuestReward`는 `notify:false`일 때 `session.currencyBalance` 갱신조차 하지 않으므로(`!notify` 즉시 return), DB는 50전인데 화면과 서버 세션 캐시는 0으로 **다음 재입장까지 고정**됐다. 타이밍 우연이 아니라 홉 수 차이이며 실DB에서는 격차가 더 벌어진다.

수정: 입장 경로에서 `hydrateCurrencyCache`를 `hydrateQuestCache` **뒤에 체인**하고, `hydrateQuestCache`는 자신이 띄운 재시도들을 `await`한 뒤 resolve하게 했다. 재시도의 `SettlementOutcome.balance`를 그대로 통지하는 더 짧은 수정은 **기각** — 이미 정산된 계정에 대해 `settle`은 *정산 시점*에 기록된 잔액을 재생하므로, D4/D5가 화폐를 움직이는 두 번째 경로를 만드는 순간 낡은 값이 된다. 체인은 매번 실제 잔액을 읽는다.

회귀 테스트는 수정을 되돌리면 `balance: 0`이 먼저 나가는 것으로 실패함을 확인했다(테스트가 결함을 실제로 잡는지 직접 대조).

### 8.6 실행하지 않은 검사와 이유

- **실 Postgres 재검증은 하지 않았다.** 정산 코어(`settlementStore.ts`/`currencyStore.ts`/`withTransaction.ts`)는 R04-a에서 이미 실DB로 검증됐고 이번 작업은 그 계약을 바꾸지 않았다. 이번에 새로 생긴 동시성 표면은 룸의 두 호출 지점(`recordQuestKill`/`hydrateQuestCache`)이 같은 `grantKey`로 경합하는 경우뿐인데, `InMemorySettlementStore`의 동기 가드(자신의 doc 주석대로 `await` 없이 검사·기록)로도 그대로 드러나는 경합이라 실DB가 아니어도 검증된다고 판단했다.
- e2e 전체 스위트는 호출자(메인)가 High 결함 수정 뒤 1회 돌렸다(위 8.4). R04-a 때 "기존 실패"로 기록됐던 `phase-x2-death-notice.spec.ts`의 teardown 타임아웃은 이번 실행에서는 재현되지 않았다 — 산발적 실패였다는 뜻이므로 `decisions.md`의 그 기록은 "상시 실패"가 아니라 "간헐 실패"로 읽어야 한다.
- `progressStore.test.ts`의 기존 실DB 격리 결함(R04-a §7에 기록된 별도 과제)은 인메모리 실행에는 애초에 나타나지 않는다.

### 8.7 R04-b 당시 한계 이력

후속 R04-c에서 정산 완료 플래그와 상점/소모품을 구현했다(§10.2). 아래 항목은 당시 판단을 보존한 것으로 현재 미구현 목록이 아니다.

- **정산이 끝난 계정도 매 입장마다 재시도 트랜잭션을 한 번 낸다.** `hydrateQuestCache`는 "완료 + 보상 있음" 행이면 이미 지급됐는지와 무관하게 `settleQuestReward`를 부른다. 멱등 재생이라 정확성 문제는 없지만 Postgres 경로에서는 BEGIN/INSERT ON CONFLICT/SELECT/COMMIT 한 벌을 영구히 반복한다. 튜토리얼 퀘스트를 끝낸 대다수 재접속 플레이어가 해당되므로 500 CCU 목표(PoC #2)에서는 비용이다. 값싸게 없애려면 `quest_progress`에 정산 완료 플래그를 두거나 `SettlementStore`에 읽기 전용 존재 확인을 추가해야 하는데, 둘 다 R04-b 승인 범위 밖이라 **의도적으로 남겼다**. 벤치마크는 하지 않았다(코드 판독 근거).
- 상점 구매·소모품 사용(D4/D5)은 여전히 미구현 — R04-c, 별도 승인 필요.
- 클라이언트 잔액 표시는 가방 헤더 한 곳뿐이다. 다른 패널에 중복 표시하지 않았다 — 기존 HUD 배치 규약을 넘어서는 새 UI를 만들지 않기 위해서다.

## 9. R04-c 설계 (2026-09-18, 착수 승인 · `decisions.md` 참고)

D4(상점 구매)·D5(소모품 사용)를 실제로 배선하는 데 필요한 잔여 결정. §3의 D1~D7과 같은 표 형식.

| | 결정 | 기각한 대안과 이유 |
|---|---|---|
| **D8** grantKey nonce | **클라이언트가 생성**, 사용자 행동 1회당 1개(`crypto.randomUUID()` 등). 같은 시도의 재시도(끊긴 연결 재연결 등)는 **같은 nonce**를 그대로 재전송한다. 실제 `grantKey`는 `shop:<owner>:<itemKey>:<quantity>:<nonce>` / `sell:<owner>:<itemKey>:<quantity>:<nonce>` / `use:<owner>:<itemKey>:<nonce>` — D2가 적어둔 3세그먼트 형태를 이 프로젝트의 구체적 보간으로 확정한 것. `<owner>`는 **항상 서버가 세션의 인증된 `ownerKey`로 채운다**(클라이언트 페이로드의 어떤 필드도 신뢰하지 않음). item/quantity를 nonce와 나란히 키에 넣은 것은 "같은 nonce, 다른 요청" 재생 사고를 원천 차단하기 위해서다 — 키가 다르면 애초에 재생 분기를 타지 않는다. | 서버가 nonce 생성(D2가 이미 기각: 재시도마다 값이 달라져 멱등이 깨진다). 클라이언트 nonce를 그대로 키로 씀(item/quantity 없이) — nonce를 실수로 재사용한 완전히 다른 요청이 첫 요청의 결과를 그대로 돌려받아 클라이언트가 "성공"으로 오인할 여지가 있다(실질적 이중지급은 아니다 — `SettlementOutcome`을 재생할 뿐 두 번째 효과는 적용되지 않는다 — 그래도 혼란스러운 응답이라 배제). |
| **D9** §8.7 성능 부채 | **(a) `quest_progress.settled_at` 컬럼**(`0010_quest_progress_settled.sql`). `hydrateQuestCache`는 이미 `QuestStore.list()`로 매 입장마다 `quest_progress` 행을 읽는다 — 이 컬럼을 그 SELECT에 얹으면 **추가 왕복 0회**로 "이미 정산됨"을 알 수 있다. `settle()`이 `ok:true`를 반환한 뒤 별도 UPDATE로 플래그를 세우고(경합해도 멱등), 플래그가 없을 때만 재시도 `settle()`을 부른다. | (b) `SettlementStore`에 읽기 전용 존재 확인 추가 — 이미 정산된 계정도 매 입장 `reward_grant`에 SELECT 1회를 여전히 낸다(트랜잭션은 없앴지만 왕복은 남는다). (a)는 이미 읽는 데이터에 열 하나 얹는 것이라 그 왕복마저 없앤다. **D6 안전성**: 플래그 UPDATE가 크래시로 유실돼도 다음 입장이 다시 재시도하고, 그 재시도는 `reward_grant` 멱등 덕에 공짜 재생이다 — 오늘과 같은 실패 모드로 열화할 뿐 D6가 깨지지 않는다. 플래그는 **성능 단축 경로일 뿐, `settle()` 호출을 막는 게이트가 아니다** — 코더는 이 불변식을 지켜야 한다. |
| **D10** 아이템 차감 확장 | `SettlementEffects.itemDebits`(신규, `settlementStore.ts`)·`SettlementOutcome`에 `insufficient-item` 신설·`InventoryStore.remove(ownerKey, itemKey, quantity): Promise<number \| null>`(신규, 아래 인터페이스) 도입. 판매(아이템 차감+화폐 지급)·소모품 사용(아이템 차감만)은 모두 D2가 이미 예정한 `settle()` 경로를 타야 하는데, 현재 `SettlementEffects`는 **추가만** 표현하고 차감을 표현할 수 없다 — 이 간극을 메우지 않으면 D4/D5 중 판매·사용 절반이 구현 불가능하다. | `items`에 음수 `quantity` 허용 — `CurrencyStore`가 이미 `credit`/`debit`을 분리한 이유와 같다: 부호 하나 틀리면 판매가 무상 지급이 된다. 잠금 순서는 기존 "화폐→인벤토리 item_key 오름차순"을 grants/debits를 **하나로 합쳐** item_key 오름차순으로 확장 — grants 먼저 처리하고 debits를 나중에 처리하면 같은 두 아이템을 반대 역할로 건드리는 두 정산이 반대 순서로 잠글 수 있다. **주의(구현 게이트): 이 필드는 두 `SettlementStore` 구현이 모두 처리하기 전까지 어떤 호출자도 채우면 안 된다** — 지금은 인터페이스만 존재하고 조용히 무시된다(`ok:true`인데 아무것도 안 지워짐). |
| **D11** 아이템/상점 데이터 모델 | `ItemDefinition`(contracts.ts)에 `sellValue?: number`(구매가에서 파생 금지, `decisions.md` 2026-09-18 그대로)와 `consumable?: { healAmount: number }` 추가. 상점 재고는 `questDefinitions.ts` 관례를 그대로 따르는 신규 `server/src/rooms/shopDefinitions.ts` — `ShopDefinition { npcObjectId, listings: ShopListing[] }`, `ShopListing { itemKey, price }`. 가격은 아이템이 아니라 **상점(리스팅)에** 있다 — sellValue는 아이템 고유값이지만 buyPrice는 "이 상점이 얼마에 파는가"라서 다르다. R03이 배치한 placeholder 상점 NPC — `interactableDefinitions.ts`의 `plaza-shop-npc`(`title: "상점 (자리표시)"`) — 의 id를 그대로 `SHOP_DEFINITIONS`의 `npcObjectId`로 승격한다(신규 NPC·신규 맵 변경 없음). 그 NPC의 `body`(현재 "회복 소모품과 기본 장비를 준비 중입니다…")도 실제 판매 문구로 함께 갱신해야 자리표시 문구가 남지 않는다. | 가격을 `ItemDefinition`에 둠 — 상점이 하나뿐인 지금은 동작하지만, "가격은 아이템의 속성"이라는 잘못된 모델을 굳혀 두 번째 상점이 생기는 날 마이그레이션이 된다. 재고(품절) 모델 도입 — 사용자 승인 범위에 없고(§9 D13 "not-sold-here"는 재고 소진이 아니라 "이 상점이 안 판다"는 뜻), 무한 재고 행상 컨벤션이 이 장르에서 표준이다. |
| **D12** 프로토콜 | `ClientMessage.BuyItem`(`shop:buy`: `{npcObjectId,itemKey,quantity,nonce}`)·`SellItem`(`shop:sell`: `{itemKey,quantity,nonce}`)·`UseItem`(`item:use`: `{itemKey,nonce}`, 수량 없음 — 소모는 항상 1개). 성공은 기존 메시지 재사용: 구매/판매는 `CurrencyChanged`(`reason: "shop-buy"\|"shop-sell"` 추가)+`ItemGranted`/`ItemRemoved`(신규), 사용은 `ItemRemoved`(`reason:"consume"`, HP 필드 동봉)만 — 화폐가 안 움직이므로 `CurrencyChanged`는 안 보낸다. 실패는 `ShopDenied`(신규, `PortalEntered`/`PortalDenied` 쌍의 모양) 하나로 통일 — buy/sell/use 세 액션과 `ShopDenialReason` 7종을 얹은 한 메시지, 액션마다 별도 Denied 메시지를 만들지 않는다. NPC 패널은 `NpcInteraction.shop?: ShopOffer`(quests?와 대칭, 독립적으로 존재 가능)로 리스팅을 실어 보낸다. | 새 "정산 완료" 래퍼(예: `PurchaseCompleted`) — D7이 이미 기각. 성공에도 별도 ack 메시지(`ShopResult{ok:true}`) — `PortalEntered`처럼 "무언의 성공, 명시적 실패"가 이미 이 코드베이스의 관례라 대칭이 깨지지 않게 실패만 명시했다. |
| **D13** 실패 사유 표현 | `ShopDenialReason`(shared) 7종으로 클라이언트가 서로 다른 토스트를 낸다: `insufficient-balance`/`bag-full`/`insufficient-item`/`unknown-item`/`not-sold-here`(품절의 자리, 실제로는 "이 상점은 안 판다")/`not-sellable`/`not-consumable`. | 문자열 메시지 하나로 뭉뚱그림 — "잔액 부족"과 "가방 가득" UI가 다른 액션을 유도해야 한다(전자는 사냥 유도, 후자는 정리 유도)는 사용자 요구사항을 만족하지 못한다. |

### 9.1 구현 분해

```
[shared 타입]                [server: 상점/소모품]        [server: §8.7 성능부채]      [client]
protocol.ts (D8/D12) ───┬──▶ shopDefinitions.ts 실제    0010 마이그레이션 적용 ─┐
                        │    데이터 채우기(D11)          questStore.ts:         │
contracts.ts            │      ↓                        +settled?/+markSettled  │
  ItemDefinition (D11) ─┘    settlementStore.ts:         (§9 D9 시그니처, 아래)  │
  (이미 반영)                 InMemory/Postgres에         ↓                     │
                             itemDebits 적용(D10) ──┐    hydrateQuestCache      │
                             inventoryStore.ts:      │    수정(§9 D9)          │
                             +remove() 양쪽 구현 ────┤        ↓                 │
                             (D10, 아래 시그니처)     └──▶ metaverseRoom.ts:    │
                                    ↓                      handleBuy/Sell/Use   │
                             questDefinitions.ts는          핸들러 신설         │
                             변경 없음(리워드 스키마 그대로) (BuyItem/SellItem/  │
                                                            UseItem 핸들러)     │
                                                                  ↓             ▼
                                                         shopPanel UI(신규) +
                                                         inventoryPanel.ts 판매/사용 버튼
                                                         (npcPanel.ts류 기존 패턴 재사용)
```

의존 순서: `protocol.ts`/`contracts.ts`(완료) → `settlementStore.ts`+`inventoryStore.ts`(D10, 병행 가능·같은 PR) → `shopDefinitions.ts` 데이터+`questStore.ts`(D9)는 **서로 독립**이라 병렬 가능(파일 겹침 없음) → 둘 다 끝난 뒤 `metaverseRoom.ts` 핸들러(모든 스토어에 의존) → 클라이언트(서버 메시지 계약이 확정된 뒤 시작, 프로토콜 타입만으로 UI 골격은 병행 가능). `metaverseRoom.ts`는 한 파일에 세 핸들러가 다 들어가므로 그 안에서는 순차 작업.

### 9.2 D9/D10에 필요한 정확한 인터페이스 (미반영 — 코더가 그대로 적용)

두 인터페이스 모두 **필수 메서드 추가**라 기존 구현체(`InMemoryQuestStore`/`PostgresQuestStore`, `InMemoryInventoryStore`/`PostgresInventoryStore`) 양쪽을 같은 커밋에서 채우지 않으면 `tsc`가 실패한다 — 그래서 이번 설계 커밋에는 반영하지 않고 여기 원문으로 남긴다.

```ts
// server/src/db/questStore.ts — QuestRow / QuestStore
export interface QuestRow {
  questId: string;
  killCount: number;
  completed: boolean;
  /** `quest_progress.settled_at IS NOT NULL` (§9 D9). completed가 false면 항상 false. */
  settled: boolean;
}

export interface QuestStore {
  // list/accept/recordKill 시그니처는 그대로, 반환하는 QuestRow에 settled 포함.

  /**
   * 이 계정·퀘스트의 보상이 정산 완료됐다고 기록한다(§9 D9). 멱등 — 이미 세팅돼 있어도 안전.
   * settle()이 ok:true를 반환한 뒤 호출하며, 실패해도 삼켜도 된다(다음 입장이 다시 정산 재시도).
   */
  markSettled(ownerKey: string, questId: string): Promise<void>;
}

// server/src/db/inventoryStore.ts — InventoryStore
export interface InventoryStore {
  // list/add/grantOnce/equip/unequip/getEquippedSlots 시그니처는 그대로.

  /**
   * `quantity`를 차감하고 이후 총량을 반환한다, 부족하면 `null`(§9 D10) — CurrencyStore.debit의
   * "부족은 예외가 아니라 결과" 관례 그대로. 단일 statement(조건부 UPDATE)로, 두 탭이 동시에 같은
   * 소모품을 쓰는 경합에서 체크와 차감이 갈라지지 않게 한다. 0까지 줄면 행을 지울지, 0으로 둘지는
   * 구현 판단(design 상 어느 쪽도 이 파일이 강제하지 않음) — 다만 `list()`가 돌려주는 모양은
   * 바뀌면 안 된다(0개 항목은 표시하지 않는다).
   */
  remove(ownerKey: string, itemKey: string, quantity: number): Promise<number | null>;
}
```

## 10. R04-c 서버 구현·검증 (2026-09-18)

D4(상점 구매)·D5(소모품 사용)·§8.7 성능부채 제거를 실제로 배선했다. §9가 지정한 인터페이스 그대로,
§9.1 의존 순서 그대로 구현했다. **클라이언트(상점 패널 UI)는 이번 범위 밖 — 다른 에이전트가 별도
작업 중이며, `client/` 아래는 건드리지 않았다.**

### 10.1 구매·판매·사용 경로

```
BuyItem  ──▶ handleBuyItem  ─┐                     성공 ──▶ CurrencyChanged(shop-buy) + ItemGranted
SellItem ──▶ handleSellItem ─┼─▶ settle(grantKey, { currencyDelta, items?, itemDebits? })
UseItem  ──▶ handleUseItem  ─┘         │                    │
                                       │ 원장 재생(같은 nonce) ▶ 같은 outcome 재전송, 자산 재변경 없음
                                       ▼
                              ok:false ▶ ShopDenied(action, itemKey, reason)
```

- `grantKey`는 §9 D8 그대로 `<action>:<ownerKey>:<itemKey>:<quantity>:<nonce>` (`<ownerKey>`는 항상
  세션의 인증된 `PlayerSession.ownerKey`, 클라이언트 페이로드는 신뢰하지 않는다). `ownerKey === null`
  (SSO 없음)은 `settleQuestReward`와 같은 규칙으로 조용히 건너뛴다 — §9가 명시하지 않은 빈틈이라
  기존 관례를 그대로 확장했다(10.4 한계 참고).
- 판매는 `itemDebits`+양의 `currencyDelta`, 사용은 `itemDebits`만(화폐 불변). 소모품 HP 회복은
  **`settle()`이 `ok:true`를 준 뒤에만** 적용한다 — 선차감 후 회복, 세션 소멸 시 유실 허용
  (`decisions.md` 2026-09-18).
- 실패 사유는 `settle()`이 답한 3종(`insufficient-balance`/`bag-full`/`insufficient-item`) 그대로
  `ShopDenied.reason`으로 통과시키거나(sell/use), 핸들러가 사전 검증한 4종
  (`unknown-item`/`not-sold-here`/`not-sellable`/`not-consumable`)을 얹는다.

### 10.2 §9 D9 — settled 플래그

`quest_progress.settled_at`을 `QuestStore.list()`가 이미 읽는 SELECT에 얹었다(`QuestRow.settled`).
`hydrateQuestCache`는 `!row.settled`일 때만 재시도 `settle()`을 부른다. `settleQuestReward`는
`outcome.ok`가 참이면 (완료 경로·재시도 경로 양쪽에서, `notify` 값과 무관하게) `markSettled`를
호출한다 — 플래그는 성능 단축 경로일 뿐 `settle()` 호출을 막는 게이트가 아니라는 §9 D9의 불변식
그대로.

### 10.3 변경 파일

| 파일 | 내용 |
|---|---|
| `server/src/db/inventoryStore.ts` | `remove()` 신설, InMemory·Postgres 양쪽(Postgres는 DELETE·UPDATE 두 CTE를 하나로 합친 단일 statement — `quantity > 0` CHECK 때문에 0으로 떨어지는 UPDATE는 불가능해 DELETE 분기가 필요) |
| `server/src/db/settlementStore.ts` | `itemDebits` 실제 적용(InMemory·Postgres), grants+debits를 `item_key` 오름차순으로 합쳐 처리, `SettlementDeclined`에 `insufficient-item` 추가 |
| `server/src/db/questStore.ts` | `QuestRow.settled` + `markSettled()`, InMemory·Postgres 양쪽 |
| `server/src/rooms/metaverseRoom.ts` | `roomShops`(roomQuests와 같은 narrowing), `shopOffered()`, `BuyItem`/`SellItem`/`UseItem` 핸들러 3개 + `sendShopDenied` 공통 꼬리, `hydrateQuestCache`/`settleQuestReward`에 D9 배선, `toInteraction`에 `shop` 필드 |
| `server/src/rooms/shopDefinitions.ts` | 실제 데이터(`plaza-shop-npc` → `herb` 12전) + `validateShopDefinitions` 구현 |
| `server/src/rooms/itemDefinitions.ts` | `herb`에 `sellValue: 3`·`consumable: { healAmount: 30 }` 추가 — 새 아이템 키·새 아이콘 없이 기존 드롭 아이템을 상점 소모품으로 승격 |
| `server/src/rooms/interactableDefinitions.ts` | `plaza-shop-npc`의 자리표시 문구를 실제 판매 문구로 교체 |
| `server/src/server.ts` | `validateShopDefinitions`를 부팅 검증에 연결 |
| `server/src/http/routes.ts` | `GET /api/inventory` 응답(`presentInventory`)에 `sellValue`(그대로)·`consumable`(있으면 `true`, 없으면 필드 자체 생략 — `client/src/net/inventory.ts`가 이미 그 모양으로 파서를 대비해 둠) 추가 |
| 테스트 | `server/src/rooms/shopSystem.test.ts`(신설, 13건) + `questSystem.test.ts`(D9 settled 전용 describe 2건 추가) + `settlementStore.test.ts`/`inventoryStore.test.ts`/`questStore.test.ts`(계약 테스트 확장) + `routes.inventory.test.ts`(sellValue/consumable 와이어 테스트 1건 추가) + 기존 `InventoryStore`/`QuestStore` 가짜 구현 전부에 `remove`/`markSettled` 추가 + `metaverseRoom.interactables.test.ts`(상점 NPC가 이제 실제 `shop` 필드를 보내므로 갱신) |

### 10.4 검증 증거

```
npm run typecheck (shared·server·client)            → 에러 0
npm test --workspace @zep-test/server (인메모리)     → 1082 tests / 1082 pass / 0 fail
npm test --workspace @zep-test/server (실 Postgres)  → 1172 tests / 1171 pass / 1 fail
  실패 1건은 progressStore.test.ts의 기존 실DB 격리 결함(§7) — 이번 코드가 아니다.
npm run build --workspace=@zep-test/client          → 성공
npx playwright test (client/e2e 전체)               → 아래 10.7
```

새로 작성한 좁은 테스트: 구매 성공 시 화폐 차감+아이템 지급 원자적 / 잔액 부족 구매는 아무것도
바꾸지 않음 / 같은 nonce 재전송은 두 번 사지 않음 / 판매가 아이템 차감+화폐 지급 / 소모품 사용이
HP 회복+아이템 1개 차감(화폐는 안 움직임) / 없는 아이템·미판매·비소모품 사용·판매가 각각
`ShopDenied`로 거절 / **settled 플래그가 선 계정은 재입장 시 `settle()` 호출이 정확히 0건, 플래그가
없으면 여전히 1회 재시도**(D9의 핵심, `settle()` 호출 횟수를 직접 센 카운팅 스토어로 확인).

### 10.5 실행하지 않은 검사와 이유

- **구현 단계에서는 실 Postgres 검증을 하지 못했다**(그 세션에 `docker` CLI가 없었다). **독립 검증에서
  해소됐다** — WSL 안에는 docker가 있었고(`wsl -- docker version`), 기존 컨테이너를 되살려 실DB로
  전체 스위트를 재실행했다(위 10.4). 즉 `remove()`의 단일 statement 원자성·`itemDebits` 잠금 순서·
  마이그레이션 `0010`은 **스텁이 아니라 실제 SQL로** 검증됐다. WSL VM 유휴종료가 dockerd를 함께
  죽여 컨테이너가 18초 만에 내려가는 현상(`r03` 문서 §4의 경고)이 실제로 재현됐고, `sleep infinity`
  동반 프로세스로 세션을 유지해 우회했다.
- e2e 전체 스위트는 돌리지 않았다 — 호출자(메인)가 커밋 직전 1회 돌리는 프로젝트 규칙(§9 브리핑
  지시) 그대로.
- 클라이언트 빌드/타입체크는 구현 시점에 다른 에이전트가 `client/`를 동시에 작업 중이라 그 보고에
  포함되지 않았다 — 양쪽이 끝난 뒤 호출자가 3개 워크스페이스 전체로 재실행해 에러 0을 확인했다.

### 10.6 독립 검증에서 잡은 결함 1건 + 잠재 결함 1건 (둘 다 수정 완료)

fresh context tester가 실 Postgres로 공격했다. R04-a §5, R04-b §8.5에 이어 **세 번째 연속**으로
구현자 자기검증을 통과한 결함이 나왔다.

**Medium — `quantity` 상한이 없어 요청이 조용히 소멸했다.** `handleBuyItem`/`handleSellItem`은
`Number.isInteger(quantity) && quantity >= 1`만 봤고, `inventory_item.quantity`는 Postgres
`integer`(32비트)다. `quantity: 3_000_000_000`은 검증을 통과한 뒤 정산 트랜잭션 안에서 raw 드라이버
에러(`22003`)로 실패한다. 자산은 전부 롤백되어 **경제적 피해는 없지만**, (a) 멀쩡한 DB가
`markDatabaseDegraded`로 오분류되고 (b) `settleBuy`/`settleSell`의 `catch`가 에러를 삼켜
**플레이어는 `ShopDenied`조차 못 받고 시도가 사라진다.** → `MAX_REQUEST_QUANTITY = 9_999`
(`itemDefinitions.ts`)를 넘으면 두 핸들러가 앞에서 무시한다. 거절이 아니라 무시인 것은 기존
`quantity < 1` 처리와 같은 취급이다 — 이 서버가 내보내는 어떤 클라이언트도 만들 수 없는 값이므로
거절할 구매가 아니라 잘못된 메시지다. 컬럼 상한(21.4억)이 아니라 훨씬 낮은 값을 고른 것은 반복
구매로도 컬럼 근처에 못 가게 하기 위해서다.

**잠재 — 착용 중인 아이템을 팔면 스탯이 유령으로 남는다.** `settleSell`은 인벤토리 행만 지우고
`session.equippedItemKeys`(룸 세션 캐시)는 건드리지 않는다. 오늘은 `sellValue`를 가진 유일한 행이
소모품이라 **도달 불가**지만, 장비에 `sellValue`가 붙는 날 조용한 데미지 오류로 나타난다. →
착용 중이면 `not-sellable`로 거절한다. 정산 트랜잭션 안에서 장착 해제를 처리하는 대안은 이번
범위를 넘고, 거절이 잃는 것이 없다(벗고 팔면 된다).

두 수정 모두 **되돌리면 실패하는지 대조 확인**했다(테스트가 실제로 결함을 잡는지).

### 10.7 남은 한계

### 10.6 남은 한계

- `ownerKey === null`(로컬 개발, SSO 없음) 상태의 상점 액션은 아무 메시지도 보내지 않고 조용히
  무시한다 — §9가 이 경우를 명시하지 않아 `settleQuestReward`의 기존 관례(정산은 uuid 계정에만)를
  그대로 확장한 구현자 판단. `ShopDenialReason` 7종 중 이 경우에 맞는 것이 없다.
- 재고(품절) 모델은 여전히 없다(§9 D11이 기각한 그대로) — `not-sold-here`는 "이 상점이 안 판다"는
  뜻이지 품절이 아니다.
- 화폐 지급 위주였던 R04-b와 달리 이번 상점 구매는 `SettlementEffects.items`를 실제로 쓰는 첫
  호출자다 — `MAX_DISTINCT_ITEMS` 상한에 걸린 구매는 `bag-full`로 거절되지만, 벌크 구매(quantity가
  큰 한 번의 구매)가 상한을 우회하지 않는지는 `add()`의 기존 캡 로직에 의존할 뿐 이번에 새로
  검증하지 않았다(R04-a §6에서 이미 검증된 경계).
- `ItemGranted`에는 구매인지 몬스터 드롭인지 구분하는 필드가 없다(설계 그대로). 클라이언트는 모든
  `ItemGranted`로 미결 구매를 해소하므로, 같은 아이템이 우연히 동시에 드롭되면 구매 버튼이 조금
  일찍 풀린다 — 무해하며 `objectPanel.ts` 주석에 남겼다.
- 상점 구매 수량은 클릭당 1개 고정이다(수량 입력 UI 없음). `UseItem`이 수량을 아예 갖지 않는
  미니멀리즘을 그대로 따랐고, 스테퍼 UI를 발명하지 않았다.

