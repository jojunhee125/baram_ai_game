# R05 직업·MP·스킬 — 설계

승인 범위: **이 설계 문서 작성까지**(`decisions.md` 2026-09-18 "R05 설계 문서 작성 승인"). 구현은 R05-a/-b/-c 단계별로 별도 승인을 받는다.
기준 소스 `0216ff7`. 로드맵 항목은 [R05](roadmap.md) — "네 역할의 판단이 다르고 서버 판정 일치".

## 1. 무엇을 풀어야 하나

현재 전투는 **직업도 자원도 선택도 없는 단일 경로**다. 모든 플레이어가 같은 공격 하나를 600ms마다 인접 1타일에 넣는다(`ATTACK_COOLDOWN_MS`·`ATTACK_RANGE_TILES`·`PLAYER_ATTACK_DAMAGE`, `shared/src/constants.ts:86,97,103`). 레벨업도 HP +10 / 공격 +1로 전원 동일하다(`shared/src/leveling.ts`의 `HP_PER_LEVEL`·`ATTACK_PER_LEVEL`).

R05가 만들어야 하는 차이는 **판단의 차이**다. "전사가 HP가 더 많다"는 수치 차이만으로는 로드맵의 완료 조건을 만족하지 못한다 — 네 역할이 같은 상황에서 **다른 버튼을 눌러야** 한다.

확인한 전제(코드 근거):

| 이미 있는 것 | 위치 | R05가 쓰는 방식 |
|---|---|---|
| 세션 런타임 HP(영속 안 함, 입장 시 full) | `contracts.ts:487` `PlayerSession.hp` | MP를 **같은 규칙**으로 붙인다 (D2) |
| 공격 쿨다운 1종 | `contracts.ts:481` `lastAttackAt` | 스킬별 쿨다운 맵을 **별도**로 둔다 (D5) |
| 합산 공격력/최대HP 단일 지점 | `metaverseRoom.ts:1868` `totalAttack`, `totalMaxHp` | 직업 계수를 **이 두 함수 안에서만** 곱한다 (D4) |
| 근접 대상 선정 | `metaverseRoom.ts:1994` `pickAttackTarget` | 원거리·아군 대상 선정은 **같은 근접 인덱스**를 반경만 바꿔 쓴다 (D6) |
| 계정 영속 저장 패턴 | `migrations/0006_player_progress.sql` | 직업도 **독립 테이블**로 (D1) |
| 능력치 없는 공개 상태 | `shared/src/state.ts` `Player` | 직업은 **공개**, MP는 **비공개** (D3) |

## 2. 설계 결정

### D1 — 직업은 독립 테이블에 영속하고, 한 번 고르면 바뀌지 않는다

`player_class(owner_key uuid PK, class_key text NOT NULL CHECK (...), chosen_at timestamptz)`. 새 마이그레이션 `0011_player_class.sql`.

`player_profile`에 컬럼을 붙이지 않는 이유는 `0006_player_progress.sql`이 이미 적어둔 것과 같다 — `player_profile.avatar_skin`은 NOT NULL·기본값 없음이고 "행이 없다 = 스킨을 고른 적 없다"가 스킨 선택기의 계약이다. 직업 컬럼을 거기 붙이면 직업만 고른 계정에 `avatar_skin` 기본값을 발명하거나 NOT NULL을 풀어야 한다. 둘 다 이 기능이 건드릴 이유가 없는 계약을 깬다.

- **읽기는 입장 시 1회**, `hydrateProgressCache`와 같은 자리에서 세션에 캐시한다. 전투 경로에서 DB를 읽지 않는다(로드맵 §6: 서버 tick에서 DB 조회 금지).
- **전직·재선택은 V1에 없다.** 로드맵 R06이 "전직·승급은 전용 퀘스트·보스 조건·새 스킬 해금을 묶어 한 단계씩"이라고 이미 정했으므로, R05가 변경 경로를 먼저 열면 그 설계를 선점한다. 쓰기는 `chooseOnce(ownerKey, classKey)` 하나뿐이고, 이미 행이 있으면 **기존 값을 돌려준다**(멱등, `InventoryStore.grantOnce` 관례 그대로 — 두 탭이 동시에 다른 직업을 눌러도 먼저 커밋된 쪽이 이긴다).
- SSO 없는 로컬 개발에서는 `ownerKey`가 null이므로 `PlayerSession.ownerKey`의 기존 규칙대로 인메모리 스토어에 세션 id로 저장한다.

### D2 — MP는 HP와 완전히 같은 규칙: 세션 런타임, 영속 안 함

`PlayerSession.mp`. 입장 시 full, 방 이동 시 full, DB에 없음.

R04-c에서 같은 질문에 이미 답이 나와 있다(`decisions.md` 2026-09-18: "HP는 룸 세션 런타임 값이라 DB와 원자적으로 묶을 수 없다"). MP를 영속화하면 소모품·정산과 같은 원자성 문제를 **한 축 더** 만들고, HP는 런타임인데 MP만 영속인 비대칭이 남는다. 마이그레이션이 하나 줄어드는 것은 덤이다.

- 회복: 기존 전투 이탈 회복(`COMBAT_EXIT_MS`·`COMBAT_RECOVERY_*`)이 도는 같은 tick에서 MP도 회복한다. **별도 타이머를 만들지 않는다.**
- 전투 중 MP 회복 여부는 D7의 수치 표에서 정한다(전투 중에도 소량 회복 — 안 그러면 주술사·도사가 전투 중 자원이 마르면 할 일이 없어진다).

### D3 — 직업은 공개 상태, MP는 비공개

`Player.level`이 공개인 이유(`state.ts:14-21`: 세션당 수십 번 바뀌므로 패치 비용이 무시할 만함)가 직업에는 **더 강하게** 적용된다 — 직업은 세션당 0번 바뀐다. `Player` 스키마에 `playerClass: "uint8"`을 추가한다(문자열이 아니라 코드: `Monster.kind`가 문자열인 이유는 "서버 타입 테이블·와이어·클라이언트 스프라이트 선택자의 판별자가 같은 값"이어서인데, 직업은 4개 고정이고 같은 판별자 공유 요구가 없다).

MP는 `hp`와 같은 이유로 스키마에 넣지 않는다 — 매 스킬마다 시야 내 전원에게 패치가 나간다. 본인에게만 메시지로 간다(D8).

### D4 — 직업 차이는 `totalAttack`/`totalMaxHp` 안에서만 발생한다

두 함수는 이미 "기본값 + 레벨 보너스 + 장비 합"의 **유일한 합산 지점**이다(`metaverseRoom.ts:1868`, `1884`). 직업 계수를 여기 곱하고 다른 곳은 건드리지 않는다. 호출자(공격·피격·회복·UI)가 전부 이 두 함수를 통과하므로 새 분기를 만들 이유가 없다.

계수는 **레벨 성장률이 아니라 배율**로 둔다. `HP_PER_LEVEL`/`ATTACK_PER_LEVEL`을 직업별로 나누면 레벨 곡선이 직업마다 갈라져 R06 성장 CLI가 4배 복잡해진다.

### D5 — 스킬 쿨다운은 공격 쿨다운과 별도 예산

`lastAttackAt`이 `lastWarpAt`·`lastMoveAt`과 별도인 이유(`contracts.ts:477-481`: "걷기가 스윙을 사면 안 된다")가 그대로 적용된다. 스킬이 평타 쿨다운을 소비하면 평타를 쉬어 스킬 연발이 가능해지고, 반대면 스킬이 평타를 막는다. **세션당 `skillCooldowns: Map<skillKey, number>`** 하나를 두고 스킬마다 독립 deadline을 찍는다(스킬은 직업당 1개이므로 맵 크기는 1이다 — 보조 스킬이 붙을 자리를 미리 만들어 두는 것).

평타 쿨다운과의 상호작용: **스킬은 평타 쿨다운을 소비하지도 검사하지도 않는다.** 대신 스킬 자체 쿨다운이 평타보다 길다(D7).

### D6 — 대상 선정은 서버가 하고, 클라이언트는 "무엇을 쓸지"만 말한다

`ClientMessage.Attack`이 무페이로드인 이유(`protocol.ts:44-50`: "서버가 공격자의 위치와 방향에서 대상을 고르므로 없는 몬스터를 지명할 방법이 없다")를 스킬에도 유지한다. 단, 회복 스킬은 대상이 필요하므로 **아군 대상 스킬만 `targetSessionId`를 받는다**.

| 대상 종류 | 지명 방식 | 검증 |
|---|---|---|
| 몬스터 | 지명 안 함 — 서버가 사거리·방향으로 선택 | `pickAttackTarget`을 반경 인자로 일반화 |
| 아군 플레이어 | `targetSessionId` | 같은 방 + 사거리 내 + 살아있음. 실패는 `SkillDenied` |
| 자기 자신 | 지명 안 함 (전사 방어 태세) | 없음 |

**PvP는 없다.** 아군 대상 스킬은 피해를 줄 수 없고 대상 플레이어에게 피해를 넣는 경로 자체를 만들지 않는다. PvP는 로드맵 R10이다.

### D7 — 직업 4종과 핵심 스킬 1개 (수치는 착수 시 확정, 형태는 여기서 확정)

로드맵 R05 본문의 역할 정의를 그대로 형태화한다.

| 직업 | 역할 | HP·공격 배율 | 핵심 스킬 | 대상 | 사거리 | MP | 쿨다운 |
|---|---|---|---|---|---|---|---|
| 전사 | 근접·버티기 | HP↑ 공격– | 방어 태세 — 일정 시간 받는 피해 감소 | 자기 | — | 낮음 | 김 |
| 도적 | 위치 선정·순간 공격 | HP– 공격↑ | 급습 — 1회 고배율 타격 | 몬스터 | 1 | 낮음 | 중간 |
| 주술사 | MP 기반 원거리 | HP↓ 공격↑ | 화염구 — 원거리 단일 피해 | 몬스터 | 4~5 | 높음 | 짧음 |
| 도사 | 회복·지원 | HP· 공격↓ | 치유 — 아군 HP 회복 | 아군/자기 | 3~4 | 중간 | 중간 |

수치를 지금 못 박지 않는 이유: R04-c의 가격 결정과 같다 — 균형을 잡을 자료(R06 성장 CLI의 처치 시간·획득 속도)가 아직 없다. 임의값이라는 사실을 **데이터로 드러내는** 것이 R04-c `sellValue`의 선례다. 따라서 모든 수치는 `classDefinitions.ts` 한 파일의 명시 필드로 두고 코드에 상수를 흩지 않는다.

**전사의 방어 태세는 기존 `damageReduction` 축을 재사용한다** — 장비 스탯이 이미 곱셈 결합으로 합쳐지고 있다(`metaverseRoom.ts:2799`). 새 감소 체계를 만들지 않고 시한부 항을 그 결합에 하나 더 넣는다.

### D8 — 프로토콜 추가 4종

```
client → server
  skill:use           { skillKey, targetSessionId?, nonce }

server → client
  skill:used          { skillKey, casterSessionId, targetSessionId?, mpRemaining, mpMax, cooldownUntil }
  skill:denied        { skillKey, reason }   ← 기존 ShopDenied 관례
  player:healed       { targetSessionId, healAmount, hpRemaining, hpMax }
```

- `skill:used`는 **시전자 본인에게만** `mpRemaining`을 포함해 보내고, 시야 내 타인에게는 MP를 뺀 형태로 보낸다(D3). 시전 모션은 이 브로드캐스트로 재생한다.
- 피해는 **기존 `MonsterHit`을 그대로 쓴다.** 스킬 피해라고 별도 메시지를 만들면 클라이언트 피해 표시 경로가 둘이 된다.
- `nonce`는 R04-c의 per-attempt 멱등 키와 같은 역할이되, **스킬은 정산이 아니므로 원장에 남기지 않는다** — 재전송 방어는 쿨다운이 이미 한다. `nonce`는 `SkillDenied`를 어느 시도에 대한 거절인지 붙이기 위한 상관 키다.
- `reason`: `no-class` / `unknown-skill` / `on-cooldown` / `insufficient-mp` / `no-target` / `out-of-range` / `target-dead`.

**서버 판정이 권한이다** — 로드맵 R05의 "시전 애니메이션이나 생성 영상이 타격 권한을 결정하지 않는다"를 구현 규칙으로 옮기면: 서버는 `skill:use` 수신 시점에 MP 차감·쿨다운·판정을 **동기적으로 전부 끝내고** 결과를 보낸다. 시전 시간(캐스팅 바)은 R05에 없다.

### D9 — 직업 없는 계정의 처리

기존 계정에는 직업이 없다. 두 가지만 가능하고, **선택 강제**를 택한다.

- 채택: 직업 미선택 계정은 입장 후 **직업 선택 패널이 뜨고, 고르기 전에는 스킬만 못 쓴다.** 이동·평타·퀘스트·상점은 그대로 된다. 게임에 못 들어가게 막지 않는다.
- 기각: 전사 기본값 부여. 되돌릴 수 없는 선택(D1)을 사용자가 고르지 않았는데 대신 정해 버리는 것이고, "직업을 고른 적 없다"와 "전사를 골랐다"를 영원히 구분할 수 없게 된다 — `avatar_skin`의 NOT NULL이 만든 것과 같은 함정이다.

선택 UI는 기존 `avatarPicker.ts`/`characterMenu.ts` 옆에 붙인다. 신규 화면 체계를 만들지 않는다.

## 3. 단계 분할

각 단계는 **별도 승인**을 받는다(R04 선례).

| 단계 | 범위 | 산출물 | 완료 판단 |
|---|---|---|---|
| **R05-a** | D1·D2·D3·D4·D9 — 직업 저장·선택·MP 자원·능력치 차이 | `0011_player_class.sql`, `classStore.ts`, `classDefinitions.ts`, `Player.playerClass`, `PlayerSession.mp`, 선택 패널 | 직업을 고르고 재접속해도 유지, 직업별 HP/공격이 다름, MP가 차오름. **스킬은 아직 없음** |
| **R05-b** | D5·D6·D7·D8 — 스킬 실행 계약과 직업당 스킬 1개 | `skill:use` 경로, 쿨다운·MP 차감·대상 선정·판정, 4스킬 | 네 직업이 각자 스킬을 쓰고 서버가 거절 사유를 정확히 돌려줌 |
| **R05-c** | 클라이언트 — MP 게이지·단축키·시전 표현 | `playerVitals.ts` 확장, 스킬 바, fallback 시전 효과 | 키 하나로 스킬이 나가고 쿨다운·MP가 화면에 보임 |

R05-a 종료 시점에 **스킬을 쓰는 호출자가 없는 것이 정상이다** — R04-a의 "호출자 없는 상태가 정상"과 같은 구조다.
직업 전용 외형과 전용 시전 애니메이션은 **R02(아트)에 묶여 R05-c 범위 밖**이다. R05-c는 기존 공격 효과를 fallback으로 쓴다(R01이 미제작 동작에 idle fallback을 쓰는 선례).

## 4. 검증 계획

- R05-a: DB·영속 변경이므로 **fresh context tester 필수**(프로젝트 규칙: 정산·동시성 변경). 특히 D1의 "두 탭이 동시에 다른 직업 선택" 경합.
- R05-b: 전투 판정 변경이므로 **풀 파이프라인 대상**(프로젝트 CLAUDE.md: 프로토콜 변경). 회귀 시험은 되돌려서 실패까지 확인한다.
- R05-c: UI이므로 구현자 + 호출자 확인. 전체 e2e는 커밋 직전 호출자가 1회.
- 기존 알려진 실패 2건(`progressStore.test.ts` 실DB 팔, `phase-x2-death-notice.spec.ts` teardown)은 이 작업의 결함이 아니다 — `decisions.md` 2026-09-17 기록 참조, 재보고하지 않는다.

## 5. 열린 질문 (R05-a 착수 시 확정 필요)

1. **직업 이름 표기** — "전사/도적/주술사/도사" 그대로 쓸지. 로드맵 본문 표기를 그대로 채택할 생각이다.
2. **수치 확정 주체** — D7의 배율·MP·쿨다운을 사용자가 정할지, 구현자 판단에 위임할지(R04-c 가격처럼 위임 선례 있음).
3. **MP 전투 중 회복량** — 0으로 두면 주술사가 전투 중 자원이 마르고, 크면 쿨다운이 무의미해진다. 소량 회복을 제안한다.
4. **레벨 1 직업 선택 시점** — 최초 입장 즉시인지, 특정 레벨(예: 5) 이후인지. 즉시를 제안한다 — R05의 완료 조건이 "네 역할의 판단이 다르다"인데 선택이 늦으면 그 차이를 확인하는 데 오래 걸린다.

## 6. R05-a 구현 (2026-09-18)

`decisions.md` 2026-09-18 착수 승인 범위(D1·D2·D3·D4·D9) 그대로 구현했다. 공유+서버를 먼저 하고, 계약이 굳은 뒤 클라이언트 선택 패널을 붙였다(§6.5).

### 변경 파일

- `shared/src/classes.ts`(신규) — `PlayerClassKey`/`PlayerClassCode`, `CLASS_DEFINITIONS`(D7 표 그대로, 수치는 §5 질문 2 위임에 따라 구현자 판단·전부 provisional), `classCodeFor`/`classKeyFor`/`isPlayerClassKey`.
- `shared/src/constants.ts` — `MP_RECOVERY_FRACTION_PER_TICK`(0.02)·`MP_COMBAT_RECOVERY_FRACTION_PER_TICK`(0.005), `COMBAT_RECOVERY_FRACTION_PER_TICK` 옆.
- `shared/src/state.ts` — `Player.playerClass: "uint8"` 추가(공개, D3).
- `shared/src/protocol.ts` — `ClientMessage.ChooseClass`/`ChooseClassRequest`, `ServerMessage.ClassChanged`/`ClassDenied`와 그 페이로드 타입.
- `shared/src/index.ts` — `classes.ts` re-export.
- `server/migrations/0011_player_class.sql`(신규) — `player_class(owner_key PK, class_key CHECK, chosen_at)`.
- `server/src/db/classStore.ts`(신규) + `classStore.test.ts`(신규) — `ClassStore`/`InMemoryClassStore`/`PostgresClassStore`, `chooseOnce`는 단일 upsert(D1의 "먼저 커밋된 쪽이 이긴다").
- `server/src/rooms/contracts.ts` — `RoomCreateOptions.classStore`, `PlayerSession.mp`/`PlayerSession.playerClass`.
- `server/src/rooms/metaverseRoom.ts` — `classStore` 필드·`onCreate` 배선·`class:choose` 메시지 등록, `onJoin`에서 `playerClass`/`mp` 초기화 + `hydrateClassCache`(join-time `ClassChanged` sync 포함), `applyChosenClass`/`sendClassChanged`/`handleChooseClass`/`settleChooseClass`, `totalAttack`/`totalMaxHp`에 직업 배율 적용(미선택은 정확히 1.0), 신규 `totalMaxMp`, `recoverOutOfCombat`에 MP 회복(전투 중/이탈 시 분기) 추가.
- `server/src/server.ts`/`server/src/index.ts` — `classStore`를 `currencyStore`/`progressStore`와 같은 방식으로 배선(부팅 시 Postgres/InMemory 선택, `createGameServer` 마지막 위치 인자로 추가).
- `server/src/rooms/levelSystem.test.ts` — 기존 anchor-invariant 테스트 파일에 R05-a 전용 `describe` 블록 추가(아래 참고).
- `docs/roadmap.md` — R05 상태·§7 표·§5 상세 갱신.

### 검증 (실제 출력)

```
$ npm --prefix shared run typecheck
> tsc --noEmit
(에러 0)

$ npm --prefix server run typecheck
> tsc --noEmit
(에러 0)

$ npm --prefix server test
ℹ tests 1110
ℹ suites 227
ℹ pass 1110
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 38852.3102

$ npm --prefix client run build
✓ 88 modules transformed.
✓ built in 4.70s
```

`server/src/rooms/levelSystem.test.ts`에 추가한 R05-a 전용 8케이스(미선택 anchor 불변, 직업별 배율 4종, 전투 중/이탈 MP 회복, 재접속 유지, join-time sync, 성공/재요청 멱등, `already-chosen`, `unknown-class`)는 위 1,110개 안에 포함되어 있다 — `npx tsx --test src/rooms/levelSystem.test.ts` 단독 실행은 33 pass / 0 fail(이 파일 전체, R05-a분 포함).

### 실행하지 않은 검증과 이유

- 알려진 기존 실패 2건(`progressStore.test.ts` 실DB 팔, `phase-x2-death-notice.spec.ts` e2e teardown)은 재현·재보고하지 않았다(`decisions.md` 2026-09-17 기록).

위 두 항목(실 Postgres 팔, fresh context tester)은 **이후 호출자가 모두 실행했다** — 아래 두 절 참고.

### 실 Postgres 검증 (호출자 실행)

구현 세션이 "Docker 접근 불가"로 남긴 항목을 실제로 돌렸다. **도커 부재가 아니라 호출마다 WSL VM이 내려가는 문제**였고, [R03 문서](r03-quest-and-village.md) §5에 이미 적혀 있는 `sleep infinity` 레시피로 VM을 붙잡아 두면 된다. 앞으로 "Docker 없음"으로 건너뛰기 전에 그 레시피를 먼저 쓸 것.

```
$ wsl -d Ubuntu -- bash -c "docker run -d --name zep-pg-r05 -e POSTGRES_PASSWORD=zep -p 55433:5432 postgres:16 && sleep infinity"   # 백그라운드
$ cd server && ZEP_TEST_DATABASE_URL="postgres://postgres:zep@127.0.0.1:55433/postgres" npx tsx --test src/db/classStore.test.ts
[zep-test] applied migration 0011_player_class
▶ PostgresClassStore — against a real server
    ✔ chooseOnce twice with different keys returns the first key both times and leaves one row
    ✔ re-choosing the same class is a no-op that still answers it
    ✔ rejects an invalid class key … before storing anything
  ✔ collapses 16 concurrent first-choosers onto one row and one winning class (115.616ms)
ℹ tests 27
ℹ pass 27
ℹ fail 0
```

`0011_player_class.sql`의 DDL이 실제 Postgres 16에서 유효하고, 진짜 행 잠금 하에서 D1의 write-once 계약이 성립함을 확인했다 — 스텁으로는 증명할 수 없던 부분이다.

### 독립 검증에서 잡은 결함 1건 (Critical · 수정 완료)

설계 문서 §4가 요구한 fresh context tester 패스가 **Critical 1건**을 잡았다. R04-a/-b/-c에 이어 네 단계 연속으로 구현자 자체검증을 통과한 결함이 이 패스에서 나왔다.

- **증상**: 입장 직후 직업을 고르면 그 선택이 소리 없이 취소된다. `{playerClass:"warrior", mp:30, hp:125}` → `{playerClass:null, mp:0, hp:100}`. 거절 메시지도 예외도 없다.
- **원인**: `hydrateClassCache`(입장 시 조회)와 `settleChooseClass`(실시간 선택)는 서로 순서 보장이 없는 **독립적인 두 왕복**이다. 하이드레이션의 가드가 `session.playerClass !== classKey`, 즉 "내 답이 현재값과 다른가"만 보기 때문에, 늦게 도착한 **오래된** 조회 결과가 이미 착지한 **새로운** 선택을 틀린 값으로 간주하고 되돌렸다.
- **왜 실사용 경로인가**: D9가 승인한 흐름이 정확히 "입장하고 바로 고른다"이다. 억지 시나리오가 아니라 기본 동선이다.
- **수정**(`metaverseRoom.ts` `hydrateClassCache`): 하이드레이션은 `session.playerClass === null`일 때만 적용한다. `chooseOnce`가 write-once이므로 착지한 선택은 언제나 권위 있고, 스토어가 이 세션이 합의하지 않은 직업을 들고 있을 수 없다.
- **회귀 테스트**: `levelSystem.test.ts`의 "does not let a stale join-time read undo a class chosen while hydration was still pending". 수정 후 34/34 통과, **수정을 되돌리면 정확히 그 1건만 실패**(`actual: null, expected: 'warrior'`) — 양방향 확인했다.

검증에서 **건전함이 확인된 것**: anchor invariant(미선택 배율 정확히 1, `Math.round`/`Math.max`가 기존 정수합을 움직이지 못함), Postgres 단일 문 write-once, 직업 변경 시 HP 이월 공식(축소 배율에서도 1 미만으로 내려가지 않음), `recoverOutOfCombat` 재구성의 HP 절반이 기존과 논리적 등가, 세션이 `await` 중 떠난 경우의 무예외 처리.

### 6.5 클라이언트 선택 패널

- `client/src/ui/classPicker.ts`(신규), `characterMenu.ts`(직업 표시행 + 미선택 시에만 보이는 "직업 선택" 버튼), `net/roomConnection.ts`(`sendChooseClass`, `onClassChanged`/`onClassDenied` — `ClassChanged`는 join-time sync이므로 `CurrencyChanged`와 같은 pre-attach 대기열 처리), `scenes/WorldScene.ts`(배선·방 이동 시 파기), `index.html`, `style.css`.
- **카드 4종은 `CLASS_DEFINITIONS`에서 런타임 생성한다.** 이름도 배율도 클라이언트에 하드코딩하지 않고, HP·공격 성향(높음/보통/낮음)은 렌더 시점에 배율을 1.0 기준과 비교해 파생한다 — 재조정이 와도 화면이 어긋날 수 없다.
- **되돌릴 수 없는 선택이므로 2단 확정**: 카드 선택(전송 없음) → "선택하기"가 인라인 확인을 띄우고(기본 포커스는 되돌릴 수 있는 "다시 고르기") → "확정"에서만 `class:choose`를 보낸다. 한 번의 오클릭으로 영구 결정이 나지 않는다.
- **플레이를 막지 않는다**(D9): 이동·채팅·평타·퀘스트·상점이 패널 뒤에서 그대로 동작한다. `objectPanel.blocksMovement`/`skinPickerOpen`과 달리 `WorldScene`이 이 패널로 입력을 잠그지 않는다. 그래도 Tab 트랩·Esc 해제는 정상 다이얼로그대로다.
- **`already-chosen` 경합은 서버 값으로 수렴한다** — 패널은 사용자가 누른 것이 아니라 도착한 `ClassChanged`의 `classKey`로 닫힌다. `ClassDenied`는 상태 문구만 바꾸고 패널을 여닫지 않는다.
- MP는 받아만 두고 **그리지 않는다** — MP 게이지·단축키는 R05-c이고 아직 미승인이다. HP는 기존 `vitals.applyHit` 경로를 한 줄 재사용해 직업 선택으로 바뀐 최대치를 반영한다.
- **클래식 스킨(`heritage.css`) 대응**: 전면 오버레이라 heritage 재정의가 필요 없다. 근거는 추측이 아니라 대조다 — `heritage.css`에 `.object`/`.picker` 규칙이 **하나도 없고**(둘 다 공유 `:root` 변수만으로 재스킨된다), 새로 넣은 두 행이 재사용하는 `.character-menu__stat-row`/`.character-menu__item`은 `heritage.css:102,111`이 이미 재스킨한다. 다만 **실제 렌더 육안 확인은 하지 않았다**(아래 한계).

```
$ npm --prefix client run typecheck   → 에러 0
$ npm --prefix client run build       → ✓ 89 modules transformed, built in 4.26s
```

(>500kB 청크 경고는 이 변경 이전부터 있던 것이다.)

### 남은 한계

- **선택 패널의 육안 확인을 하지 않았다.** 스타일 근거는 `heritage.css` 대조로 확인했지만 두 스킨 중 어느 쪽도 실제로 띄워 보지 않았다. `zep_client_verification_harness`가 기록한 headless 오탐 6종을 고려하면 이 항목은 **사용자 화면 확인**으로만 닫힌다.
- **사망 시 MP는 리셋되지 않는다.** HP는 사망 시 `totalMaxHp`로 즉시 회복되지만(기존 동작) MP는 그 지점을 건드리지 않았다 — 이번 범위에 MP를 소비하는 경로(스킬)가 전혀 없어 관찰 가능한 차이가 없다. R05-b가 스킬을 붙이기 전에 재검토할 것.
- **스킬(R05-b)은 이번 범위에 없다.** `skillCooldowns` 맵, `skill:use` 경로, 4개 핵심 스킬은 전혀 구현하지 않았다 — 설계 문서 §3의 "R05-a 종료 시점에 스킬을 쓰는 호출자가 없는 것이 정상" 그대로.
- 수치(배율·MP·회복 비율)는 전부 §5 질문 2에 따라 구현자가 판단해 채운 provisional 값이다 — R06 성장 CLI 이전에는 근거 자료가 없다는 사실 자체가 설계 의도다.
