# R04 정산 — 설계·구현·검증

[로드맵](roadmap.md) R04 "믿을 수 있는 보상"의 단일 문서. 승인 이력은 [decisions.md](decisions.md).
**R04-a(저장소 계층) 구현 완료(2026-09-17). R04-b/-c는 미착수.**

## 1. 무엇을 풀어야 했나

| 로드맵 요구 | 해결 |
|---|---|
| 보상 원인 ID 저장, 중복 요청은 기존 결과 반환 | D2 원장 + D3 멱등 게이트 |
| 화폐·아이템 차감/추가를 하나의 원자적 변경으로 | D1 화폐 테이블 + D3 단일 트랜잭션 |
| 소모품·상점·첫 장비 보상 | D4/D5/D6 — **R04-b/-c로 남음** |

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
                                     └→ (R04-b/-c에서 배선)
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
| **D6** 퀘스트 보상 | 완료 전이 시 정산 + "완료됐는데 미정산" 재접속 재시도 (미구현) | 전이가 await되지 않는 경로라 유실 가능. 원장이 멱등하므로 재시도가 안전 |
| **D7** 통지 | `CurrencyChanged` 1종 추가, 아이템은 기존 `ItemGranted` 재사용 (미구현) | 상위 "정산 완료" 래퍼는 두 메시지를 하나로 묶을 이유가 없다 |

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

계약상 **호출자는 아직 없다** — 룸·프로토콜·클라이언트 배선은 R04-b/-c다.

`InMemorySettlementStore`는 공유 `InMemoryCurrencyStore`/`InMemoryInventoryStore` 인스턴스를 동기 경로로 조작한다. 사유 상태를 들면 로컬 개발에서 정산 지급이 실제 가방에 안 보이는 발산이 생기고, 공개 Promise API를 `await`하면 멱등 판정과 기록 사이에 경합이 재도입되기 때문이다.

## 5. 독립 검증에서 잡은 결함 2건 (수정 완료)

fresh context tester가 구현자 자기검증과 다른 각도로 공격해 확정한 것들이다.

**Critical — 멱등 게이트가 `owner_key`를 검증하지 않았다.** `ownerA`로 성공한 `grantKey`를 `ownerB`가 재사용하면 ownerA의 결과(`{ok:true, balance:500}`)를 그대로 돌려줬다. ownerB의 실제 잔액은 0. `grantKey`에 `ownerKey`를 넣는 것은 호출자 규약일 뿐 저장소가 강제하지 않았던 것이 원인이다. → 재생 경로가 `owner_key`를 함께 읽어 비교하고, 불일치는 `SettlementOwnerMismatch`로 **재throw**한다. 잔액 부족 같은 정상 결과가 아니라 호출자의 키 구성 버그이므로 결과값으로 삼키지 않는다(`markDatabaseOk` 후 throw — DB는 멀쩡하다).

**High — `Number(row.balance)`의 정밀도 손실.** 참값 `9007199254740993`이 `9007199254740992`로 반올림됐다(DB 컬럼 직접 조회로 대조). → `toSafeInteger` 가드가 safe-integer 범위를 벗어나면 `RangeError`. 타입을 `bigint`로 바꾸지 않은 이유는 `SettlementOutcome`이 `reward_grant.result` jsonb로 직렬화되는데 `JSON.stringify(bigint)`가 예외이기 때문이다.

재현 실패(설계대로 동작 확인, 재보고 대상 아님): 부분 적용 롤백 실측, `result` NULL 불변식 가드, `currencyDelta: 0` + 아이템 병행, 정확히 0으로 떨어지는 debit, `MAX_DISTINCT_ITEMS` 경계에서 두 구현 일치, `markDatabaseDegraded` 오분류.

## 6. 검증 증거

실제 PostgreSQL 16.15(WSL Ubuntu 컨테이너, `ZEP_TEST_DATABASE_URL` opt-in). 컨테이너 기동 절차는 [postgres 검증 기록](verification-2026-09-17-postgres-quest.md) §기동 절차와 동일하다.

```
npm test --workspace @zep-test/server   → 1117 tests / 1116 pass / 1 fail
npm run typecheck (shared·server·client) → 에러 0
```

실DB에서 실증한 것: 같은 `grantKey` 16건 동시 호출 → 정확히 1건만 적용 / 같은 두 아이템을 반대 순서로 건드리는 두 정산 → 데드락 없음 / 거절된 정산 후 `reward_grant` 무흔적 → 재시도 성공 / DDL 유효성과 jsonb 왕복.

## 7. 한계와 다음

- 남은 실패 1건은 `progressStore.test.ts`의 **기존** 실DB 격리 결함이다(논리 계정 전부를 같은 uuid 한 행으로 매핑). 오늘 코드가 아니며 별도 과제다.
- `withTransaction` 도중 커넥션 강제 종료 시 거동은 실측하지 않았다(코드 경로는 읽었고 논리적으로는 안전).
- safe-integer 초과 `RangeError`는 `markDatabaseDegraded`를 탄다. DB는 멀쩡하므로 의미상 부정확하지만 도달 불가능한 경로라 그대로 뒀다.
- R04-b 착수 전 확정 필요: 화폐 명칭·단위, 소모품 유실 허용 여부, 되팔기 포함 여부, first-hunt 보상 구성.
