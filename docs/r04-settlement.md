# R04 정산 — 설계·구현·검증

[로드맵](roadmap.md) R04 "믿을 수 있는 보상"의 단일 문서. 승인 이력은 [decisions.md](decisions.md).
**R04-a(저장소 계층)·R04-b(퀘스트 보상 배선) 구현 완료(2026-09-17). R04-c(상점·소모품)는 미착수.**

## 1. 무엇을 풀어야 했나

| 로드맵 요구 | 해결 |
|---|---|
| 보상 원인 ID 저장, 중복 요청은 기존 결과 반환 | D2 원장 + D3 멱등 게이트 |
| 화폐·아이템 차감/추가를 하나의 원자적 변경으로 | D1 화폐 테이블 + D3 단일 트랜잭션 |
| 퀘스트 완료 시 화폐 보상, 미정산 계정은 재접속 시 재시도 | D6 완료 전이 호출 + 재시도 · D7 `CurrencyChanged` — **R04-b 완료** |
| 상점 구매·소모품 사용 | D4/D5 — **R04-c로 남음** |

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
                                     └→ 퀘스트는 R04-b가 배선(§8) · 상점/소모품은 R04-c로 남음
```

원장 INSERT가 멱등 게이트다. 자산 변경은 그 INSERT가 행을 만든 트랜잭션 안에서만 일어난다.

## 3. 설계 결정

| | 결정 | 기각한 대안과 이유 |
|---|---|---|
| **D1** 화폐 | 신규 `player_currency` 테이블 | `inventory_item`의 `copper-coin` 재사용 → 기존 드롭 스택이 소급 잔액이 되고 `MAX_DISTINCT_ITEMS` 캡을 소비. `player_progress` 컬럼 추가 → EXP 지급과 행 락을 공유해 사냥 경로에서 경합 |
| **D2** 원인 ID | 호출자가 만드는 결정론적 문자열 PK. `quest:<questId>:<owner>`, `shop:<owner>:<nonce>`, `use:<owner>:<nonce>` | 서버 생성 난수 → 재시도 때 달라져 멱등이 깨진다 |
| **D3** 원자성 | `settle()` 단일 트랜잭션. 락 순서 **화폐 → 인벤토리(`item_key` 오름차순)** 고정 | 순서를 고정하지 않으면 같은 계정 두 탭이 반대로 잠가 데드락 |
| **D4** 구매 | WS `shop:buy` (미구현) | HTTP → 룸 캐시 동기화 경로를 새로 만들어야 함 |
| **D5** 소모품 | 선차감 후 HP 회복, 세션 소멸 시 롤백 없음 (미구현) | 선회복은 무한 회복 악용. HP가 영속되지 않아 DB와 원자적으로 못 묶는다 |
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

이 시점 계약상 **호출자는 아직 없었다** — 첫 호출자(퀘스트 완료)는 R04-b(§8)에서 붙었다. 상점·소모품 호출자는 여전히 R04-c로 남아 있다.

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

### 8.7 남은 한계

- **정산이 끝난 계정도 매 입장마다 재시도 트랜잭션을 한 번 낸다.** `hydrateQuestCache`는 "완료 + 보상 있음" 행이면 이미 지급됐는지와 무관하게 `settleQuestReward`를 부른다. 멱등 재생이라 정확성 문제는 없지만 Postgres 경로에서는 BEGIN/INSERT ON CONFLICT/SELECT/COMMIT 한 벌을 영구히 반복한다. 튜토리얼 퀘스트를 끝낸 대다수 재접속 플레이어가 해당되므로 500 CCU 목표(PoC #2)에서는 비용이다. 값싸게 없애려면 `quest_progress`에 정산 완료 플래그를 두거나 `SettlementStore`에 읽기 전용 존재 확인을 추가해야 하는데, 둘 다 R04-b 승인 범위 밖이라 **의도적으로 남겼다**. 벤치마크는 하지 않았다(코드 판독 근거).
- 상점 구매·소모품 사용(D4/D5)은 여전히 미구현 — R04-c, 별도 승인 필요.
- 클라이언트 잔액 표시는 가방 헤더 한 곳뿐이다. 다른 패널에 중복 표시하지 않았다 — 기존 HUD 배치 규약을 넘어서는 새 UI를 만들지 않기 위해서다.
