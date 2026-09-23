# R04 정산 — 설계·구현·검증

[로드맵](roadmap.md) R04 "믿을 수 있는 보상"의 단일 문서. 승인 이력은 [decisions.md](decisions.md).
**R04-a(저장소 계층)·R04-b(퀘스트 보상 배선) 구현 완료(2026-09-17). R04-c(상점·소모품) 서버 구현
완료(2026-09-18, §10) — 클라이언트(상점 패널 UI)도 완료. 후속 장비 구매/판매 및 가방·상점 비교까지 origin/main에 반영했다. 최신 검증은 [상점 비교 기록](r04-settlement.md)을 따른다.**

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

## 가방의 같은 슬롯 장비 비교 계약

> 원본: `r04-settlement.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

상태: 2026-09-22 구현 승인에 따른 설계. 앞선 세 작업은 `ac70d3f`로 main에 반영되었으며, 사용자의 다음 코드 작업 한 건 지시에 따라 roadmap의 장비 교체 전 비교 공백을 구현한다. main 담당자가 fetch 후 `main == origin/main == ac70d3f`, clean 상태를 확인했다. 추가 branch·승인 절차 없이 진행한다. 이 문서는 구현/검증/배포 완료 기록이 아니다.

### Task Plan: 장비 metadata와 가방 비교

- Phase 0 Design → architect: 현재 inventory API, 구매/전리품 ItemGranted, 장비 변경 알림과 catalogue 확인; 이 계약 확정.
- Phase 1 Implementation → coder(server/shared metadata) | ui-engineer(client 가방 비교). **parallel: yes; file_overlap: 없음**. 새 shared type 반영 전 UI typecheck만 기다릴 수 있다.
- Phase 2 Verification → tester: API/실시간 획득 metadata 일치, 비교값·장착/해제·판매·재접속·구형 응답·늦은 응답 regression. main: 전체 typecheck/test/build.
- Phase 3 Review → read-only reviewer 또는 별도 context 검토; main이 implementation 기록과 roadmap/decisions를 정리하고 main에서 commit/push.

Git root `code/` 기준으로 기존 파일의 존재를 확인했다. 신규 파일은 아래에서 따로 표시한다. 다른 작업자의 변경을 되돌리지 않는다.

| 담당 | 독점 소유 경로 | 출력·의존성 |
|---|---|---|
| coder | `shared/src/protocol.ts`, `server/src/rooms/itemDefinitions.ts`, `server/src/http/routes.ts`, `server/src/rooms/metaverseRoom.ts`; 관련 `server/src/http/routes.inventory.test.ts`, `server/src/rooms/shopSystem.test.ts` 및 필요한 신규 server metadata test | 아래 optional metadata 정의 및 세 전송 지점의 일치. 기존 mutation/정산 의미 보존 |
| ui-engineer | `client/src/net/inventory.ts`, `client/src/ui/inventoryPanel.ts`, 필요한 신규 비교 helper, `client/src/style.css`/`heritage.css` | 가방 내부 같은 슬롯 비교와 live 갱신. shared contract 의존 |
| tester | main이 배정하는 신규 client E2E spec 및 별도 신규 test 파일 | 구현 파일을 직접 수정하지 않고 수치/동시 갱신/호환성 검증 |
| architect | 신규 `docs/r04-settlement.md` | 이 계약만 작성 |
| main | implementation record, `docs/roadmap.md`, `docs/decisions.md`, Git | 실제 구현·검증·배포 상태 구분 |

### Design Decision: 서버 metadata

Options: 1) client에 itemKey별 능력치를 복사 — 변경 파일은 적지만 배포 시 catalogue와 수치가 달라지고 새 장비가 누락된다. 2) 기존 API와 ItemGranted에 optional 장비 metadata를 추가 — server catalogue를 그대로 쓰며 현재 응답/요청 형식을 보존한다.

Decision: **2**. 실제 catalogue가 사용하는 공격력 보너스와 피해 감소만 전달한다. `maxHp` 장비, 새 장비/슬롯 기능, 최종 전투력 계산, shop 구매 전 비교는 이번 범위가 아니다.

Interface: `shared/src/protocol.ts`에 아래 타입을 export하고 `ItemGranted`에 optional `equipment`를 추가한다. 기존 `shared/src/index.ts`는 protocol을 이미 wildcard export하므로 수정 불필요다.

```ts
export interface EquipmentMetadata {
  slot: Exclude<EquipmentSlot, "ring1" | "ring2"> | "ring";
  attackDamage: number;
  damageReduction: number;
}

// Additive member of existing ItemGranted and client InventoryItem / HTTP item view.
equipment?: EquipmentMetadata;
```

`slot`은 기존 server `EquipmentSlotFamily`와 같은 구조이며 실제 착용 위치가 아닌 장비 family다. 현재 catalogue의 weapon/armor/helmet/cloak만 비교한다. ring family 정의를 전달할 수 있다는 것만으로 ring1/ring2 비교·장착 기능을 추가하지 않는다.

두 수치는 metadata 객체 안에서 필수다. `definition.equipment.stats.attackDamage ?? 0`, `damageReduction ?? 0`으로 정규화하며 `0`은 해당 장비의 그 보너스가 실제로 없다는 뜻이다. `equipment` 부재는 장비 정보가 제공되지 않은 상태이므로 0으로 간주하지 않는다. 일반 전리품에는 metadata를 생략한다. 기존 `damageReductionRatio`, `sellValue`, `consumable`, `equipped` 및 모든 필수 필드는 유지한다.

같은 변환을 세 번 복사하지 않도록 기존 `server/src/rooms/itemDefinitions.ts`에 다음 순수 helper를 두고 아래 경로에서 함께 사용한다. 별도 catalogue, DB column, API endpoint, generic serializer framework는 만들지 않는다.

```ts
export function equipmentMetadata(
  definition: ItemDefinition,
): EquipmentMetadata | undefined;
```

| 전송 지점 | 현재 동작·필수 변경 |
|---|---|
| `server/src/http/routes.ts`의 `presentInventory` | DB 수량/장착 여부를 catalogue와 결합하는 기존 응답에 metadata 추가 |
| `MetaverseRoom` 구매 성공의 `ItemGranted` | 실제 settlement 성공 뒤 보내는 기존 event에 같은 metadata 추가 |
| `MetaverseRoom.awardLoot`의 `ItemGranted` | 실제 drop grant 성공 뒤 보내는 기존 event에 같은 metadata 추가. 새 가방 row와 기존 stack 양쪽 처리 |

`EquipmentChanged {slot,itemKey,applied}`는 변경하지 않는다. 이 알림은 현재 착용 itemKey만 바꾸며 장비 수치 자체는 변하지 않는다. DB store/장비 cache/정산 lock/성공 판정/알림 순서도 변경하지 않는다.

### Design Decision: 비교 의미와 갱신

Options: 1) 매번 server에서 최종 공격력/종합 방어율 preview를 계산 — 직업 배율, 반올림, 다른 슬롯, 임시 skill까지 포함하는 새 API가 필요하다. 2) 가방에서 같은 슬롯 장비의 catalogue 보너스만 비교 — 교체 판단에 필요한 차이를 현재 metadata만으로 정확하게 표시한다.

Decision: **2**. 가방 안의 장비 row에 현재 장비 이름과 후보 장비 보너스/차이를 표시한다. 추가 modal·자동장착·새 필터는 만들지 않는다. 모바일/좁은 화면에서 기존 장착·판매 버튼을 가리지 않는다.

- 공격력은 `장비 공격력 +N`, 차이는 후보 attackDamage − 현재 attackDamage. 단검2 → 사냥꾼 검6은 `+4`다. 직업 배율을 적용한 최종 피해 증가라고 표현하지 않는다.
- 피해 감소는 해당 장비 자체의 비율이다. 누비옷15% → 강화 가죽갑옷30%는 `+15%p`다. helmet/cloak 등 다른 슬롯과의 곱연산 최종 피해 감소율 차이라고 표현하지 않는다.
- 같은 슬롯의 장비가 비어 있음이 확인되면 `미장착`을 기준으로 0과 비교한다. 다른 슬롯 장비를 비교 대상으로 선택하지 않는다. 같은 장비가 장착 중이면 그 상태를 표시한다.
- 확인된 metadata가 없거나 유효하지 않으면 수치 비교를 생략하고 정보 부족 상태를 표현한다. 구형 응답을 받아도 row·수량·기존 장착/판매 동작은 유지한다. 기존 itemKey→slot fallback은 호환성을 위해 유지할 수 있지만 stat을 hardcode하지 않는다.
- 새 parser는 optional metadata의 object shape, 허용 slot, finite한 비음수 attackDamage, `0 <= damageReduction <= 1`을 검사한다. 손상된 optional metadata 때문에 정상 inventory row 전체를 버리지는 않는다.

#### Live 갱신·응답 경합 계약

서버 metadata가 이미 있는 row는 비교 표시만 다시 계산하며 매 클릭마다 HTTP를 호출하지 않는다. 현재 `ItemGranted`는 장착 상태를 포함하지 않으므로 기존 stack을 갱신할 때 이미 확인된 equipped 상태를 유지한다.

| 사건 | 필수 결과 |
|---|---|
| 가방 snapshot 로드/재접속 | 전체 row metadata와 장착 상태로 비교 재계산 |
| 구매/전리품 `ItemGranted` | 새 row·기존 stack 모두 metadata 보관, 열린 가방 비교 즉시 갱신 |
| 성공한 `EquipmentChanged` | 해당 슬롯의 기존 착용 표시를 지우고 새 itemKey를 반영, 모든 같은 슬롯 후보 비교 갱신 |
| 성공한 해제 | 해당 슬롯 기준을 미장착으로 바꿔 후보 비교 갱신 |
| 판매/소비 `ItemRemoved` | total 반영/row 삭제 후 비교 재계산. 같은 key의 metadata를 다른 item에 남기지 않음 |
| 알려지지 않은 착용 key 알림 | 기준을 정보 부족으로 표시하고 필요한 inventory refresh를 합친다. 기준값0으로 거짓 비교하지 않음 |

HTTP snapshot이 진행 중일 때 grant/equipment/removal이 먼저 도착하면, 늦은 snapshot이 새 상태를 덮어쓰지 못하도록 generation/version을 검사하고 필요 시 한 번 더 읽는다. 닫힌 가방·destroy된 panel에서는 새 DOM 갱신을 하지 않고 다음 open 시 snapshot으로 복구한다. 연속 알림마다 무제한 HTTP를 발생시키지 않는다. `applied:false`는 기존 거절/정리 처리를 유지하며 요청 click만으로 비교 기준을 낙관 변경하지 않는다.

### 검증과 자체 검토

- API: weapon 공격력2/6/10, armor 감소15/20/30%, helmet15%, cloak10%가 catalogue와 일치; 비장비 metadata 부재; 구형 필드 보존. 구매와 실제 drop event metadata가 같은 API row와 일치.
- UI: 빈 슬롯, 같은 슬롯 교체의 양수/음수/0 차이, 서로 다른 슬롯, 기존 장비/신규 stack, 장착/해제/판매/재접속, malformed/구형 metadata, HTTP 중간 live event 후 늦은 응답을 검증한다. 피해 감소 차이는 %p로 확인한다.
- 테스트에서는 component fixture와 실제 server 통합 증거를 구분한다. 기존 무주입 성장 E2E와 일반 shop/inventory regression을 유지한다. 장비 비교 검증을 위해 RNG/production catalogue/계정 기본 자산을 변경하지 않는다.
- `npm run typecheck`, 관련 server tests, 관련 browser E2E, `npm test`, `npm run build`, `git diff --check` 결과를 implementation record에 남긴다. 실행하지 않은 검사는 이유를 명시한다.
- 실패 모드 검토: client 수치 복사, unknown을0으로 처리, 다른 슬롯끼리 비교, 피해 감소 합산 오해, 기존 stack 장착 상태 손실, 장착 변경 뒤 비교 stale, live event를 HTTP가 덮어씀, 구형 client/server 호환성 손상은 위 계약으로 제한한다. 새 권한·정산·전투 동작은 도입하지 않는다.

## 2026-09-22 장비 교체 전 능력치 비교 구현

> 원본: `r04-settlement.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

> 후속 상태: 이 가방 작업에서 제외했던 상점 구매 전 비교는 `a8fbcb0`으로 구현·push 완료했다. 문서 최종 정리도 `3b7f5b5`로 origin/main에 반영했다. [상점 구현 기록](r04-settlement.md).

### 승인·범위

사용자가 “다음 코드작업 하나 더 진행”으로 추가 코드 작업을 지시했다. 로드맵의 미구현 장비 비교를 선택하여 가방에서 현재 같은 슬롯 장비와 후보 장비의 능력치 차이를 보여준다. 기존 장비/전투/판매 수치와 정산 로직은 변경하지 않는다. [설계 계약](r04-settlement.md)을 따른다.

### 시작 상태

`git fetch origin`과 `git status -sb` 확인. main·origin/main·merge-base는 모두 `ac70d3f`이며 작업 트리는 깨끗했다. 사용자 지시에 따라 branch 생성 없이 main에서 작업·커밋·push한다.

### 상태

구현·독립 검토 완료. 전체 테스트1185개와 browser15개, 추가 layout2개, typecheck/build를 통과했다. 구현 커밋 `e7b01d5`를 `origin/main`에 push 완료했다. 운영 배포는 수행하지 않았다.

### 구현 중간 기록

- `EquipmentMetadata {slot, attackDamage, damageReduction}`를 optional `equipment`로 전달한다. 현재 서버 catalogue에서 보너스가 없는 수치는 0으로 정규화하고 장비가 아닌 품목은 metadata를 제공하지 않는다. 기존 응답 필드는 유지한다.
- `server/src/rooms/itemDefinitions.ts`의 단일 helper를 inventory HTTP 응답, 구매 성공 `ItemGranted`, 실제 전리품 `ItemGranted`에서 공유한다. 서버 typecheck 통과. DB·전투 계산·장착/정산 성공 판정은 변경하지 않았다.
- UI는 같은 슬롯의 장비 보너스만 비교한다. 전체 캐릭터 공격력·다른 방어구를 합친 최종 감소율 예측은 범위 밖이다. 피해 감소 차이는 %p로 표기한다.
- 설계/UI/서버 테스트/browser 테스트를 분담했다. 추가 backend coder 생성은 thread limit로 거절되어 main이 설계 계약에 따라 서버 metadata를 구현하고 독립 tester가 검증한다.

### 중간 검증

- `npx tsx --test --test-timeout=90000 server/src/rooms/equipmentMetadata.verification.test.ts server/src/http/routes.inventory.test.ts server/src/rooms/shopSystem.test.ts` → **31/31**,1.18초. 신규3개는 전체 catalogue의 HTTP 표시, 구매·전리품·HTTP metadata 일치, 기존 필드·착용상태·수량·가격 보존을 검증했다. 일반 품목 metadata가 JSON wire에서 생략되는 것도 확인했다.
- 서버 typecheck 통과. UI 초기 typecheck/build 통과(93modules, 기존500KB chunk 경고 유지). 최종 UI 수정 이후 통합 검증은 아래에 별도 기록한다.
- 로딩 중 같은 itemKey의 이벤트를 마지막 하나로 압축하면 `획득→장착→추가 획득` 순서의 인과관계가 사라질 수 있어 순서 보존 queue로 수정한다. 최대128건 이후는 추가 조회로 수렴시키며 단순 중복 키 압축으로 상태를 잃지 않는다.

### 최종 변경 사항

- 서버가 제공한 장비 공격력·피해 감소와 같은 슬롯의 현재 장비 이름·차이를 표시한다. 빈 슬롯만 0으로 비교하며 누락·잘못된 metadata는 비교 불가로 표시한다. 기존 아이템 행과 사용/판매 동작은 유지한다.
- HTTP 로딩 중 이벤트는 최대128건을 순서대로 replay한다. 초과 시 snapshot을 다시 조회하고, unknown 장착 슬롯도 snapshot으로 해소한다. 나중에 장비 정보가 도착한 행에는 장착 버튼을 추가하고 기존 focus를 유지한다.
- destroy 이후 live event를 무시하며 standard의 낮은 화면에서 가방 내용이 잘리지 않도록 panel scroll과 최소 list 높이를 적용했다. heritage도 비교 문구를 표시한다.
- 최초 전체 테스트에서 비장비 event의 `equipment: undefined` 추가가 기존 객체 형태 검증1건을 깨뜨렸다. 비장비에는 key 자체를 생략하도록 세 응답 경로를 수정했고 기존 테스트는 약화하지 않았다.

### 영향 경로

- `shared/src/protocol.ts`: optional 장비 metadata 계약.
- `server/src/rooms/itemDefinitions.ts`, `server/src/http/routes.ts`, `server/src/rooms/metaverseRoom.ts`: 정규화 helper와 inventory/구매/전리품 전달.
- `client/src/net/inventory.ts`, `client/src/ui/equipmentComparison.ts`, `client/src/ui/inventoryPanel.ts`: 검증·비교·실시간 상태 처리.
- `client/src/style.css`, `client/src/heritage.css`: 비교 표시와 작은 화면 layout.
- `server/src/rooms/equipmentMetadata.verification.test.ts`, `client/e2e/tests/equipment-comparison.spec.ts`: 독립 회귀 검증.
- `docs/r04-settlement.md`, 이 기록, `docs/roadmap.md`, `docs/decisions.md`: 계약·승인·구현 상태.

### 최종 검증

- `npm test`: **1185/1185 PASS**(shared26 + server1159), 실패·skip0. 서버39.9초. 로그 `%TEMP%/ksc-equipment-all-tests-final.log`.
- `npx tsx --test --test-timeout=90000 server/src/rooms/equipmentMetadata.verification.test.ts server/src/rooms/passE-combat-verification.test.ts`: **21/21 PASS**, 비장비 event 호환성 수정 확인.
- `npm run typecheck`: shared/server/client 모두 PASS.
- 최종 UI 수정 후 `npm run typecheck --workspace=@zep-test/client`, `npm run build` PASS(93 modules,4.86초). 기존500KB chunk 경고는 유지된다.
- 독립 read-only 검토에서 metadata 계약·unknown 비교·서버 장착 권한 관련 blocker 없음.
- `client/e2e`에서 `npx playwright test tests/equipment-comparison.spec.ts tests/shop-ui.spec.ts tests/first-growth-loop.spec.ts --output=test-results/equipment-comparison-final`: **15/15 PASS**,1.1분. 신규12개·기존 상점2개·실제 성장1개를 검증했다. 초기 실패에서 찾은 destroy 이후 event와 standard720×480 잘림을 수정 후 재검증했다. unknown metadata 이름 기대값은 fixture와 맞추되 숫자 억제 assertion을 유지했다.
- Browser 검증은 공격력 차이·피해 감소 %p·빈 슬롯·legacy/malformed metadata·focus·로딩 이벤트 순서·장착/해제·부분 판매·거절 event·queue overflow·destroy·두 스킨 좁은 화면을 포함한다. 실제 성장 검증은 보상 주입 없이14전 획득→단검 구매/장착→재접속 유지를 통과했다.
- Screenshot scroll 위치 정리 후 layout2개 재실행 **2/2 PASS**,5.6초. 독립 tester가 standard/heritage screenshot을 직접 확인했다. 산출물은 `client/e2e/test-results/equipment-comparison-layout/` 아래이며 Git에 포함하지 않는다.
- E2E `npx tsc --noEmit` PASS. `git diff --check` PASS. 최종 lifecycle/layout delta도 독립 reviewer 승인.

### 제한·미실행

- Browser 검증은 실제 HTML/CSS/parser/panel을 사용하는 component fixture이며 실제 계정의 장시간 플레이 검증과 구분한다.
- 실제 PostgreSQL 재검증은 미실행: DB schema/query/정산 로직을 변경하지 않았고 이전 작업의 실DB 검증을 유지한다.
- 상점 구매 전 비교, 최종 직업 공격력/합산 방어율 예측, 신규 장비/HP bonus는 구현 범위 밖이다. 운영 배포·사용자 시각 승인은 수행하지 않았다.

### 문서 최종 정리

2026-09-22 사용자 요청으로 이 기록과 `roadmap.md`·`decisions.md`의 구현 및 Git 반영 상태를 확정했다. `git fetch origin` 후 main과 origin/main이 `e7b01d5`로 일치하고 선행 `ac70d3f`가 포함됨을 확인했다. 코드 변경이 없어 테스트/build는 재실행하지 않으며 위 결과를 유지한다. 문서 diff와 링크를 확인한 뒤 main에 커밋·push한다.

## 상점 구매 전 같은 슬롯 장비 비교

> 원본: `r04-settlement.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

상태: 2026-09-22 설계 확정. 사용자의 “다음 코드작업도 개시한다” 지시에 따라 다음 작은 구현을 선택한다. main 담당자가 fetch 후 `main == origin/main == 3b7f5b5`, clean 상태를 확인했다. branch/worktree를 만들지 않으며 모든 Git 반영은 main 담당자가 main에서 수행한다. 이 문서는 구현·검증·배포 완료 기록이 아니다. 구현 착수 범위와 결과는 별도 implementation record 및 roadmap/decisions에 기록한다.

### 선택 근거와 범위

`docs/roadmap.md:5,71`은 가방 장비 비교 완료와 상점 구매 전 비교 제외를 명시한다. 실제 `client/src/ui/objectPanel.ts`의 `renderShop`/`buildShopRow`는 아이콘·이름·가격·절대 장비 수치·구매 버튼만 보여 준다. `server/src/rooms/metaverseRoom.ts`의 `shopOffered`는 authored shop listing을 표시용 `ShopListingView`로 변환한다. 직전 가방 비교에서 만든 서버 metadata·HTTP inventory·비교 formatter를 재사용할 수 있어 다음 작업으로 적합하다.

포함: 현재 상점의 장비 후보와 현재 착용한 같은 슬롯 장비의 공격력 보너스/피해 감소 차이를 구매 전에 표시한다. 미장착·같은 장비·정보 부족·조회 실패·실시간 변경·닫기/재열기/scene 종료를 처리한다. 제외: 새 상품/가격/보상/전투 수치, 구매 후 자동 장착, 최종 캐릭터 전투력 계산, ring 선택, 새 API/DB/cache, boss/party/전직, 가방 상태 관리의 전면 통합. R04의 장시간 실제 플레이나 R06/R07 전체 완료로 표시하지 않는다.

### Task Plan: 구매 판단에 현재 장비 연결

- Phase 0 Design → architect: 실제 roadmap·shop 표시·inventory 계약을 확인하고 이 문서를 작성한다.
- Phase 1 Implementation → coder(server/shared) | ui-engineer(shop/client). **parallel: yes; file_overlap: 없음.** UI는 아래 additive shared 계약을 기준으로 작업하며 typecheck는 shared 변경 이후 수행한다.
- Phase 2 Verification → tester: listing metadata, 비교/실시간 race/호환성/browser layout과 기존 구매 회귀를 검증한다. main은 전체 test/typecheck/build를 실행한다.
- Phase 3 Review → read-only reviewer/guardian 또는 독립 context 검토. main은 구현 기록·roadmap·decisions를 갱신하고 main에 반영한다.

| 담당 | 독점 소유 경로 | 입력·출력 및 의존성 |
|---|---|---|
| coder 또는 main | `shared/src/protocol.ts`, `server/src/rooms/metaverseRoom.ts` | 기존 `EquipmentMetadata`/`equipmentMetadata`를 shop listing에 additive 연결. 새 helper/정산 변경 없음 |
| ui-engineer | `client/src/ui/objectPanel.ts`, `client/src/ui/equipmentComparison.ts`, `client/src/scenes/WorldScene.ts`, 필요한 `client/src/net/inventory.ts` 및 `client/src/style.css`/`client/src/heritage.css` | 기존 inventory parser/API/formatter 재사용. Shop 표시와 아래 live invalidation 배선. net inventory는 아래 선택적 strict 조회만 허용; InventoryPanel 수정 없음 |
| tester | 신규 `server/src/rooms/shopComparison.verification.test.ts`, 신규 `client/e2e/tests/shop-equipment-comparison.spec.ts` | production과 파일 중복 없음. 기존 `shopSystem.test.ts`, `shop-ui.spec.ts`, `equipment-comparison.spec.ts`를 회귀 실행하며 수정 필요 시 main과 소유권 합의 |
| architect | 신규 `docs/r04-settlement.md` | 이 설계만 작성 |
| main | implementation record, `docs/roadmap.md`, `docs/decisions.md`, Git | 구체적 착수 결정과 실제 구현·검증·push/배포 상태를 구분하여 기록 |

모든 작업자는 공동 작업 중이며 다른 담당자의 변경을 되돌리지 않는다. server 변경과 UI 변경 사이에 파일 중복은 없고 테스트는 신규 파일로 분리한다. Browser port 소유권은 main이 tester 한 명에게 배정한다.

### Design Decision: 상품 수치 계약

Options: 1) 기존 `attackBonus`/`damageReductionRatio`와 client itemKey 표로 슬롯을 추정한다 — 서버 수정은 작지만 구형/신규 상품과 0 수치의 의미가 모호하다. 2) 기존 정규화된 `EquipmentMetadata`를 listing에도 optional 전달한다 — 서버 정의를 그대로 재사용하며 가방과 상점 수치가 일치한다.

Decision: **2**. 이미 있는 helper를 `shopOffered` 한 곳에 연결한다. 기존 필수 필드와 `attackBonus`, `damageReductionRatio`는 그대로 유지하고 비장비는 새 key 자체를 생략한다.

```ts
// Additive member on existing ShopListingView in shared/src/protocol.ts.
equipment?: EquipmentMetadata;

// Existing helper; reuse without changing its implementation or stats.
export function equipmentMetadata(definition: ItemDefinition): EquipmentMetadata | undefined;
```

metadata 내부 `attackDamage`/`damageReduction`는 필수이며 해당 보너스가 없으면 실제 0이다. metadata 객체 부재는 unknown이다. 서버가 제공한 객체는 기존 `readEquipmentMetadata`로 검증하고 잘못된 optional metadata 때문에 상품/가격/구매 버튼을 버리지 않는다. 구형 listing의 절대 수치 표시는 유지하되 슬롯/기준을 추측해 차이를 계산하지 않는다. non-gear 약초에는 불필요한 비교 경고를 붙이지 않는다.

### Design Decision: 현재 장비의 조회와 실시간 갱신

Options: 1) 가방과 상점을 위한 전역 inventory model을 새로 추출한다 — HTTP를 공유하지만 이미 검증한 가방 lifecycle과 모든 호출부를 변경한다. 2) 열린 장비 상점에 한해 기존 `loadInventory()`로 현재 장비를 읽고, 관련 live 이벤트에서 비교만 무효화한 뒤 조회를 합친다 — 작은 독립 수명주기로 기존 가방을 유지한다.

Decision: **2**. 같은 상점을 열 때 baseline 조회 한 번, 이후 변경 알림에 대한 coalesced refresh만 둔다. polling·구매 click 시 추정 장착·전역 store·가방의 128-event replay queue 복제는 하지 않는다.

```ts
// Existing ObjectPanel: typed live notifications; only invalidate comparison.
applyGrant(event: ItemGranted): void;
applyItemRemoved(event: ItemRemoved): void;
applyEquipmentChange(event: EquipmentChanged): void;

// In existing equipmentComparison.ts, narrow the required input fields so both
// inventory rows and shop candidates can use the same formatter without fake quantity.
export type EquipmentComparisonItem = Pick<InventoryItem, "name" | "equipped" | "equipment">;
export function describeEquipmentComparison(
  item: EquipmentComparisonItem,
  current: EquipmentComparisonItem | null | undefined,
): EquipmentComparisonDescription;
```

`WorldScene`의 기존 `onItemGranted`, `onItemRemoved`, `onEquipmentChanged`에서 대응하는 typed 알림을 호출한다. `EquipmentChanged`는 `applied:true`일 때만 비교를 무효화한다. 기존 toast, pending buy 해결, inventory/weapon 갱신은 유지한다. `ShopDenied`나 구매 요청 자체는 inventory가 바뀐 것으로 간주하지 않는다. 최초 단일 invalidation 메서드 제안은 UI 착수 시 위 typed 경계로 확정했다.

`loadInventory`가 구조적으로 잘못된 row를 필터링하면 착용 row가 사라져 false empty baseline이 될 수 있다. 이를 막기 위한 **선택적 strict 조회 인자** 추가는 허용한다. strict 모드는 잘못된 top-level/필수 row shape를 실패로 처리하고 shop은 unknown을 표시한다. 기본 호출의 기존 가방 동작은 유지한다. optional equipment metadata만 잘못된 row는 기존 parser처럼 row를 보존하고 metadata unknown으로 남긴다. 인자 이름/형태는 UI 담당자가 기존 함수와 일관되게 정하고 tester에 전달한다.

| 상태/사건 | 필수 동작 |
|---|---|
| 장비 listing이 있는 shop open | 현재 장비를 한 번 조회. candidate 절대 수치와 구매 버튼은 바로 표시, baseline은 조회 중 표시 |
| 장비 없는 NPC/shop | 새 inventory 조회 불필요. 기존 퀘스트/대화/약초 구매 유지 |
| 성공한 grant/removal/equipment 변화 | 열린 shop의 기존 baseline을 즉시 unknown으로 만들고 refresh. 닫힌 shop에서는 조회/DOM 변경 없음 |
| 조회 중 변화 | dirty/version을 증가. 오래된 응답은 표시하지 않고, 현재 요청 종료 후 후속 조회 한 번으로 합침. 활성 shop session당 동시 조회 최대 1개 |
| close/다른 NPC open/destroy | generation을 무효화. 늦은 success/error와 파기된 인스턴스 이벤트가 새 panel을 변경하거나 후속 조회를 시작하지 않음 |
| HTTP 실패 | 비교 정보 미확인 표시. 가격/구매/pending nonce 상태 유지. 무한 자동 재시도 없음; 다음 실제 변경 또는 reopen에서 다시 조회 |

동일 session에서 dirty refresh가 다시 변경을 만나면 같은 규칙을 반복한다. snapshot 이후의 live 이벤트를 오래된 HTTP 응답이 덮을 수 없게 한다. UI를 갱신할 때 shop row/구매 button을 다시 만들지 않고 비교 text만 교체해 keyboard focus와 pending 구매 상태를 보존한다.

#### 비교 의미

- 현재 catalogue의 weapon/armor/helmet/cloak 보너스만 표시한다. 같은 슬롯의 `equipped:true` inventory row 한 개가 baseline이다. 다른 슬롯의 장비는 더하거나 빼지 않는다.
- 비교 candidate와 baseline의 itemKey가 같고 현재 착용이 확인되면 기존 formatter의 `현재 장착 중` 표현을 쓴다. 보유만 하고 미착용인 같은 상품을 착용 중이라고 표시하지 않는다.
- 조회가 성공했고 해당 슬롯이 확실히 비어 있으면 baseline `null`로 0과 비교한다. 조회 중/실패는 `undefined`; equipped row의 metadata가 없거나 잘못되어 슬롯을 알 수 없거나 같은 슬롯에 둘 이상이면 숫자 비교를 억제한다. Client itemKey→stat/slot 표를 새로 복제하지 않는다.
- 공격력 차이는 장비 보너스의 뺄셈이다. 단검2→사냥꾼 검6은 +4. 피해 감소는 비율 차이에 100을 곱한 **%p**이다. 누비옷15%→강화 갑옷30%는 +15%p. 다른 슬롯과 곱해지는 최종 방어율이나 직업 배율을 적용한 최종 피해량이라고 표현하지 않는다.
- 장비 정보가 있는 후보는 현재 장비 조회 실패와 무관하게 절대 수치를 읽을 수 있다. 구형/잘못된 metadata는 숫자를 추정하지 않는다. ring family는 현재 작업에서 concrete slot으로 선택하지 않는다.
- 좁은 화면과 두 theme에서 이름·가격·구매 버튼·비교 수치를 읽고 조작할 수 있도록 wrapping/scroll을 유지한다. 색만으로 양수/음수를 구분하지 않는다.

### 검증과 gate

- Server: 실제 `shopOffered`/NPC interaction listing이 catalogue helper 및 inventory metadata와 일치하는지 확인한다. 무기2/6/10, 방어구15/20/30%의 값과 0 축, 가격/순서/기존 stat 필드, 약초의 새 equipment key 부재를 검증한다. 새 구매 권한/정산 semantics가 없음을 기존 shop 회귀로 확인한다.
- Browser: 빈 슬롯·현재 단검 대비 검+4·반대 음수·동일 장비·갑옷 %p·다른 슬롯 무시·legacy/malformed metadata·HTTP 실패에서도 구매 유지. 장비 상점 open 조회1회, non-gear NPC 조회0회, live 3종 배선, 조회 중 다중 변경 합치기/옛 snapshot 폐기, close/reopen/다른 NPC/destroy 늦은 응답, focus/pending 구매 유지, 두 theme/작은 viewport를 확인한다.
- Component HTTP/event fixture와 실제 서버 통합 증거는 구분한다. 기존 `shop-ui.spec.ts`, `equipment-comparison.spec.ts` 및 적절한 기존 성장 회귀를 실행한다. 새 비교를 위해 production catalogue/기본 자산/RNG를 바꾸지 않는다.
- Main: 관련 server/browser tests, `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`. 실제 명령·결과·실행하지 못한 항목·남은 제한을 implementation record에 기록한다.

자체 검토: metadata 부재의 false zero, 잘못된 슬롯/중복 착용, 오래된 응답, 이벤트 폭주, close/destroy 후 DOM 오염, 구매 focus/nonce 손실을 계약으로 다룬다. 기존 formatter/HTTP/helper 재사용이 가장 작은 범위이며 DB/권한/자산 mutation 변경은 필요 없다. 사용자 결정이 필요한 열린 항목은 없다.

## 2026-09-22 상점 구매 전 장비 비교

> 원본: `r04-settlement.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

### 승인과 범위

사용자 “다음 코드작업도 개시한다” 지시에 따라 앞선 가방 비교에서 제외했던 상점 구매 전 비교를 다음 단일 구현으로 선택하고 착수 범위를 안내했다. 서버 장비 metadata와 기존 비교 helper를 사용해 같은 슬롯의 현재 장비 대비 공격력·피해 감소 차이를 표시한다. 가격·구매 정산·전투 계산·DB는 변경하지 않는다.

### 시작 상태

git fetch origin 후 main과 origin/main은 모두 `3b7f5b5`이며 작업 트리는 깨끗했다. 사용자 지시에 따라 branch/worktree 생성 없이 main에서 진행한다.

### 진행 상태

구현·독립 코드 검토 완료. 전체 테스트1187개, browser26개와 typecheck/build 통과. 구현 커밋 `a8fbcb0`를 origin/main에 push 완료했다. 운영 배포는 수행하지 않았다. [설계 계약](r04-settlement.md).

### 실제 변경

- `shared/src/protocol.ts`, `server/src/rooms/metaverseRoom.ts`: ShopListingView에 optional equipment를 추가하고 기존 helper로 생성한다. 비장비는 key 자체를 생략하며 기존 가격·순서·절대 수치를 보존한다.
- `client/src/ui/objectPanel.ts`: 같은 슬롯 장비의 기여 수치와 차이(%p)를 표시한다. 같은 장비의 현재 착용 상태와 빈 슬롯을 구분하고 정보 부족·조회 실패 시 차이를 추측하지 않는다. 조회 실패 후 재시도를 제공한다.
- `client/src/net/inventory.ts`: 상점용 선택적 strict 조회를 추가했다. 필수 row/수량 손상을 실패 처리하며 기존 가방 호출의 동작은 유지한다.
- `client/src/ui/equipmentComparison.ts`: 기존 formatter의 입력을 필요한 필드로 좁혀 상점에서도 재사용한다.
- `client/src/scenes/WorldScene.ts`: 획득·제거·장착 event를 상점 비교 무효화에 연결한다. 조회 중 변경은 합쳐서 후속 조회하며 늦은 응답·닫힌 panel·destroy 이후 갱신을 차단한다. 비교 text만 변경해 구매 nonce·버튼·focus를 보존한다.
- `client/src/style.css`: 비교 표시와 loading/error/retry UI. heritage는 기존 object modal 스타일로 동작하여 별도 CSS 변경이 없었다.
- `server/src/rooms/shopEquipmentMetadata.verification.test.ts`: 실제 상품 목록의 metadata와 기존 필드를 검증하는 신규2개. `metaverseRoom.interactables.test.ts`는 additive 응답의 exact expectation을 갱신했다.

### 검증

- `npm test`: **1187/1187 PASS**(shared26 + server1161), 실패·skip0, 서버37.35초. 로그 `%TEMP%/ksc-shop-comparison-all-tests-final.log`.
- 최초 전체 실행은 별도 focused suite와 동일 테스트 port2581을 동시에 사용하여 EADDRINUSE로1파일 실패했다. 중복 실행 종료 후 위 전체 검증을 단독 재실행해 통과했다. 테스트/제품 로직을 변경해 회피하지 않았다.
- 서버 관련 focused tests **41/41 PASS**,18.55초. 로그 `%TEMP%/ksc-shop-equipment-server-tests.log`.
- `npm run typecheck`: shared/server/client PASS. UI 최종 `npm run build`: PASS,93modules,7.20초. 기존500KB chunk 경고 유지.
- 독립 read-only 검토: strict baseline·중복 슬롯·dirty refresh·close/destroy·재시도·기존 구매 nonce 보존 확인, material defect 없음.
- `client/e2e`에서 `npx playwright test tests/shop-equipment-comparison.spec.ts tests/shop-ui.spec.ts tests/equipment-comparison.spec.ts --output=test-results/shop-comparison-first`: **26/26 PASS**,22.6초. 신규 상점12개·기존 가방12개·기존 상점2개. 같은 슬롯/%p·strict unknown·40개 event의 조회 병합·구매 nonce/focus·close/reopen/nonshop/destroy·standard/heritage720×480 검증.
- E2E `npx tsc --noEmit` PASS. 독립 tester가 두 theme screenshot에서 비교·가격·구매 버튼을 직접 확인했다. 산출물은 `client/e2e/test-results/shop-comparison-first/`에 보존하며 Git에는 포함하지 않는다.
- `git diff --check` PASS. 검증 파일 `client/e2e/tests/shop-equipment-comparison.spec.ts`를 추가했다.

### 제한·미실행

- DB·정산·권한·전투 수치를 변경하지 않아 실PostgreSQL 검증은 재실행하지 않았다.
- Browser는 실제 ObjectPanel/parser/CSS와 typed event3종을 사용하는 component fixture다. WorldScene에서 실제 wire 이벤트 발생을 별도로 강제하지 않았으며 배선은 코드 검토·typecheck로 확인했다. 실제 성장 E2E는 앞선 작업의 통과 결과를 유지하고 이번에는 재실행하지 않았다.
- 전체 캐릭터 피해량/합산 방어율 예측, ring 선택, 신규 상품/지역은 포함하지 않는다.
- 장시간 실제 플레이·사용자 시각 승인·운영 배포는 수행하지 않았다.
