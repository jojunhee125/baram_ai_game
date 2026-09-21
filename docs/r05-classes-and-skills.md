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
- ~~**사망 시 MP는 리셋되지 않는다.**~~ → **R05-b에서 해소**(§7, `decisions.md` 2026-09-18 R05-b 미결 2): 사망 시 MP도 HP처럼 가득 찬다. R05-a 시점에는 MP를 소비하는 경로가 없어 관찰 가능한 차이가 없었고, 스킬이 붙는 R05-b에서 재검토하기로 남겨 둔 항목이었다.
- **스킬(R05-b)은 이번 범위에 없다.** `skillCooldowns` 맵, `skill:use` 경로, 4개 핵심 스킬은 전혀 구현하지 않았다 — 설계 문서 §3의 "R05-a 종료 시점에 스킬을 쓰는 호출자가 없는 것이 정상" 그대로.
- 수치(배율·MP·회복 비율)는 전부 §5 질문 2에 따라 구현자가 판단해 채운 provisional 값이다 — R06 성장 CLI 이전에는 근거 자료가 없다는 사실 자체가 설계 의도다.

## 7. R05-b 구현 (2026-09-18)

`decisions.md` 2026-09-18 착수 승인 범위(D5·D6·D7·D8, 미결 4건 확정) 그대로 구현했다. 서버·shared뿐이고 클라이언트 호출부는 없다 — R05-a가 "호출자 없는 상태가 정상"으로 끝난 것과 같은 구조(§3).

### 변경 파일

- `shared/src/skills.ts`(신규) — `SkillKey`, `SkillEffect`(판별 유니온: `self-damage-reduction`/`monster-damage`/`ally-heal`), `SkillDefinition`, `SKILL_DEFINITIONS`(직업당 스킬 1개, 수치는 구현자 판단), `isSkillKey`.
- `shared/src/classes.ts` — `ClassDefinition.skillKeys: readonly SkillKey[]` 추가, 4개 직업 각각 자기 스킬 1개씩 연결.
- `shared/src/index.ts` — `skills.ts` re-export.
- `shared/src/protocol.ts` — `ClientMessage.UseSkill`/`UseSkillRequest`, `ServerMessage.SkillUsed`/`SkillDenied`/`PlayerHealed`와 그 페이로드 타입, `SkillDenialReason`.
- `server/src/rooms/contracts.ts` — `PlayerSession.skillCooldowns`(`Map<SkillKey, number>`), `PlayerSession.stanceDamageReductionUntil`/`stanceDamageReduction`.
- `server/src/rooms/metaverseRoom.ts`:
  - `onCreate`에 `class:choose` 옆으로 `skill:use` 등록.
  - `onJoin`에서 `skillCooldowns: new Map()`, `stanceDamageReductionUntil: 0`, `stanceDamageReduction: 0` 초기화 — `lastAttackAt: 0`/`mp: 0`과 같은 자리, 같은 이유.
  - `pickAttackTarget`을 반경 인자로 일반화(D6) — 얼굴 방향→최단거리→id 순서의 tie-break은 그대로, 호출부(`handleAttack`은 `ATTACK_RANGE_TILES`, `handleUseSkill`은 `SkillDefinition.rangeInTiles`)만 갈라졌다.
  - `handleAttack`의 "몬스터가 피해를 입는" 꼬리(런타임 조회·`MonsterHit` 팬아웃·킬 분기의 loot/EXP/퀘스트)를 `applyMonsterDamage`로 추출 — `handleAttack`과 `handleUseSkill`의 몬스터-대상 스킬(급습·화염구)이 공유한다. 스킬 피해는 별도 메시지 없이 그대로 `MonsterHit`을 탄다(D8).
  - `equippedDamageReduction`이 `now` 인자를 받아 전사 방어 태세를 장비 감소와 같은 곱셈 결합에 한 항 더 넣는다(D7) — `damagePlayer`가 유일한 호출자.
  - `damagePlayer`의 사망 분기에 MP 전량 회복 + 활성 방어 태세 해제(`stanceDamageReductionUntil = 0`) 추가 — 아래 "사망 시 MP" 절 참고.
  - 신규 `handleUseSkill`(검증 순서는 미결 3 그대로: 세션/플레이어 존재 → `no-class` → `unknown-skill` → `on-cooldown` → `insufficient-mp` → **쿨다운 선차감** → 대상 해석(`no-target`/`out-of-range`/`target-dead`) → **MP 청구** → 적용 → 전송)과 `broadcastSkillUsed`(D3 — 시전자 본인 사본에만 `mpRemaining`/`mpMax`를 아예 다른 속성 집합으로 실어 보낸다, `undefined`로 지우는 방식이 아니라).
- `server/src/rooms/levelSystem.test.ts` — 기존 anchor-invariant 테스트 파일에 R05-b 전용 `describe` 블록 추가(아래 검증 절 참고). 새 테스트 파일을 만들지 않았다(작업 지시).
- `docs/r05-classes-and-skills.md` — 이 절.

### D7 수치와 그 근거

`SKILL_DEFINITIONS`(전부 provisional, R06 성장 CLI 이전 근거 자료 없음 — `CLASS_DEFINITIONS`의 선례 그대로):

| 스킬 | 직업 | 대상 | 사거리 | MP | 쿨다운 | 효과 |
|---|---|---|---|---|---|---|
| `guard-stance` | 전사 | 자기 | — | 8 | 12,000ms | 50% 피해감소, 4,000ms |
| `ambush` | 도적 | 몬스터 | 1 | 10 | 4,000ms | `totalAttack` × 4 |
| `fireball` | 주술사 | 몬스터 | 4 | 18 | 1,500ms | `totalAttack` × 2.5 |
| `heal` | 도사 | 아군/자기 | 3 | 20 | 5,000ms | 대상 `totalMaxHp`의 30%, 오버힐 없음 |

제약이 실제로 수치를 좁힌 지점(브리핑이 요구한 것 그대로):

- **주술사가 두 번보다 많이 화염구를 쓸 수 있어야 한다** — `maxMpBase` 100 / `mpCost` 18 = 마르기 전 5.5회. 통과.
- **화염구 자체 DPS가 평타 DPS를 터무니없이 넘으면 안 된다** — 레벨1 `totalAttack(주술사) = round(4×1.3) = 5`. 평타 DPS ≈ 5 / 0.6s ≈ 8.3/s. 화염구 DPS ≈ round(5×2.5)=13 / 1.5s ≈ 8.7/s — 같은 자릿수, 절대 배수가 아니다. 원거리라는 이점이 대가이지 순수 딜 배수가 아니게 맞췄다.
- 급습(도적)은 반대로 "1회 고배율, DPS는 평타보다 낮음"으로 뒀다 — `round(5×4)=20` / 4s = 5/s < 평타 8.3/s. 오프너지 DPS 대체가 아니다.
- 방어 태세 8 MP는 `maxMpBase` 30의 4분의 1강 — "낮음"을 지키면서도 공짜는 아니게. 12s 쿨다운(`ATTACK_COOLDOWN_MS`의 20배)은 상시 방어 스택이 아니라 순간 완화 도구로 남긴다.
- 치유 30%는 레벨1 HP(100)의 30 — `COMBAT_RECOVERY_FRACTION_PER_TICK`(틱당 3%)의 자연 회복을 무의미하게 만들지 않으면서 전투 중 의미 있는 한 방이 되게.

### 미결 3(빗나간 스킬의 쿨다운/MP 비대칭) 구현

`handleUseSkill`은 쿨다운을 대상 해석 **이전에** 찍고, MP는 대상 해석이 **성공한 뒤에만** 차감한다 — `no-target`/`out-of-range`/`target-dead`로 거절된 시도는 쿨다운을 잃지만 MP는 그대로다. 테스트 "denies no-target for a monster skill in a room with no monsters, but still stamps the cooldown and spares the MP"·"denies out-of-range…"·"denies target-dead…"가 이 비대칭을 양쪽 다 확인한다. `no-class`/`unknown-skill`/`on-cooldown`/`insufficient-mp`는 쿨다운 선차감보다 앞이므로 아무 비용도 없다 — 대응 테스트가 `skillCooldowns.size === 0`을 확인한다.

### 미결 4(몬스터 없는 방) 구현

`handleUseSkill`의 `monster-damage` 분기가 `this.hasMonsters === false`를 `pickAttackTarget` 호출 전에 걸러 `no-target`으로 거절한다 — 몬스터 인덱스 자체가 없는 방에서 그 인덱스를 조회하는 크래시를 만들지 않는다. `self`/`ally` 대상 스킬은 이 가드를 타지 않으므로 광장에서도 그대로 동작한다.

### D8 명세와의 사소한 불일치 1건 — `SkillDenied`에 `nonce` 포함

설계 문서 §2 D8의 와이어 블록은 `skill:denied { skillKey, reason }`만 적었지만, 바로 아래 산문이 "`nonce`는 `SkillDenied`를 어느 시도에 대한 거절인지 붙이기 위한 상관 키"라고 명시한다 — 상관 키가 되려면 거절 응답 자체에 실려야 하므로, 산문의 명시적 목적을 따라 `SkillDenied.nonce`를 추가했다. 코드 블록의 누락을 그대로 옮기지 않은 것이지 설계 의도를 벗어난 게 아니다.

### `skills.ts`를 별도 파일로 둔 것 — D7 "한 파일" 문구의 정제

D7은 "수치는 `classDefinitions.ts` 한 파일의 명시 필드로 둔다"고 적었다. `shared/src/skills.ts`를 새로 만든 이유는 D5가 이미 `skillCooldowns`를 스킬 키로 사이징해 두 번째 스킬의 자리를 만들어 뒀기 때문이다 — 그 두 번째 스킬이 실제로 생기는 자리가 바로 이 파일이고, `ClassDefinition.skillKeys: readonly SkillKey[]`가 직업↔스킬을 연결한다. 모든 수치는 여전히 정확히 한 곳(스킬마다 하나뿐인 `SkillDefinition`)에만 있다 — "한 파일" 문구가 지키려던 것(수치를 코드 전역에 흩지 않는다)은 그대로이고, 자리만 클래스 모양에서 스킬 모양으로 옮겼다.

### 검증 (실제 출력)

```
$ npm --prefix shared run typecheck
> tsc --noEmit
(에러 0)

$ npm --prefix server run typecheck
> tsc --noEmit
(에러 0)

$ npm --prefix server test
ℹ tests 1130
ℹ suites 228
ℹ pass 1130
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 42173.4885
```

`server/src/rooms/levelSystem.test.ts`에 추가한 R05-b 전용 19케이스(4스킬 각각 종단 검증, 방어 태세의 장비 감소와의 곱셈 결합과 만료, 치유의 오버힐 클램프, 7개 거절 사유 전부, D5 양방향 독립성 2건, 미선택 계정 anchor 불변, 사망 시 MP 전량 회복 + 태세 해제, 방관자 사본에 MP 부재)은 위 1,130개 안에 포함되어 있다 — 단독 실행(`npx tsx --test src/rooms/levelSystem.test.ts`)은 이 파일 전체 53 pass / 0 fail(R05-a 9케이스 포함).

**회귀 확인(되돌려서 실패까지 확인, 2건 모두 수행):**

1. D5 독립성 — `handleUseSkill`의 쿨다운 검사에 `now - session.lastAttackAt < ATTACK_COOLDOWN_MS`를 임시로 덧붙이자 "a skill never consumes or checks lastAttackAt, in either direction"이 정확히 그 1건만 실패했다(`AssertionError: a fresh auto-attack must never gate a skill, 1 !== 0`). 되돌리자 53/53 통과로 복귀.
2. 방관자 MP 비노출 — `broadcastSkillUsed`의 분기 조건을 임시로 `if (true)`로 바꿔 모두에게 MP를 실어 보내자 "omits mpRemaining/mpMax entirely from the onlooker's copy of SkillUsed"가 정확히 그 1건만 실패했다(`AssertionError: an onlooker must never receive the number, true !== false`). 되돌리자 53/53 통과로 복귀.

### 실행하지 않은 검증과 이유

- **클라이언트 e2e 전체 스위트는 이 머신에서 완주하지 못했다 — 메모리 부족이지 회귀가 아니다.** 세 번 시도했다: ① 하니스가 "critically low memory"로 중단 ② 23 실패 / 72 통과 · 49.9분(기준선 95 통과 / 0 실패 · 5.6분) ③ 실패 spec 3개만 재실행 → 15 실패 / 10 통과 · 24.5분. 실패 원문은 전부 `Test timeout of 60000ms exceeded` + `locator.click: Target page, context or browser has been closed`이고 **단정 불일치는 0건** — 브라우저가 죽고 뒤가 연쇄로 무너진 형태다. 실패 목록에 `client/src`와만 관계있는 순수 DOM 테스트(채팅 포커스 키바인딩, 아바타 피커 방향키 clamp)가 섞여 있는데 이번 변경은 `client/src` 0줄이고, 이 변경이 실제로 건드린 사망 분기의 전용 spec(`phase-x2-death-notice.spec.ts`)은 통과했다. 실행 전 2567/5173에 남아 있던 묵은 dev 서버는 정리했다(`reuseExistingServer` 때문에 안 치우면 구버전 서버로 초록불이 뜬다). **메모리 여유가 있을 때 1회 재실행해 이 항목을 닫을 것** — `decisions.md` 2026-09-18 R05-b 결과 항목 참조.
- **fresh context tester 재검증**은 이 세션의 범위 밖이다(`docs/decisions.md` 2026-09-18 검증 절 — "구현자 단위 테스트 + fresh context tester 재검증 2단"). 구현자 단위 테스트만 이 보고에 포함된다.
- 알려진 기존 실패 2건(`progressStore.test.ts` 실DB 팔, `phase-x2-death-notice.spec.ts` e2e teardown)은 재현·재보고하지 않았다 — 이번 범위와 무관.

### 남은 한계

- **PvP 경로 부재는 코드 구조로 보장했지만 grep 재확인은 검증자 몫이다** — 아군 대상 스킬(`heal`)이 대상의 `hp`를 깎는 코드 경로가 `handleUseSkill`에 전혀 없음을 구현 중 직접 확인했으나(§ 브리핑의 "리뷰어가 grep할 것"), 독립적인 재확인은 하지 않았다.
- **밸런스 수치는 전부 provisional**이다(위 표) — R06 성장 CLI 이전에는 근거 자료가 없다는 사실 자체가 설계 의도(D7).
- **`nonce`는 원장에 남지 않는다**(설계 §2 D8) — 재전송 방어는 쿨다운이 담당하고, `nonce`는 오직 `SkillDenied` 상관용이다. 멱등 키가 아니므로 같은 `nonce`로 두 번 보내도 두 번째 요청은 쿨다운에 걸려 거절될 뿐, 별도의 멱등 처리는 없다(의도된 것).
- **R05-c(클라이언트 — MP 게이지·단축키·시전 표현)는 이번 범위가 아니다.** 스킬을 실제로 쓰는 호출자가 아직 없다 — R05-a 종료 시점과 같은 구조.

## 8. R05-c 구현 기록 (2026-09-21)

승인: `docs/decisions.md` 2026-09-21. 기준 소스 `d081b25`. **클라이언트 전용** — 서버 코드 0줄, 프로토콜 변경 0건.
R05-b가 만든 계약에 처음으로 화면 호출자가 붙었다.

### 실제 변경

| 파일 | 변경 |
|---|---|
| `shared/src/skills.ts` | `SkillDefinition.label` 추가(방어 태세·급습·화염구·치유). **표시 문자열일 뿐 어떤 wire 메시지에도 실리지 않는다** — `ClassDefinition.label`과 같은 이유로 shared에 둔다(클라이언트 사본을 두면 두 곳이 어긋날 수 있다) |
| `client/index.html` | `#vitals` 안에 마력 head·track, 스킬 슬롯 `<ul>`·거절 문구 |
| `client/src/ui/playerVitals.ts` | `setMp`/`currentMp`, MP 로컬 회복 미러, 사망 시 MP 리필, `renderMp` |
| `client/src/ui/skillBar.ts` (신규) | 슬롯 생성·쿨다운 미러·마력 부족 표시·거절 문구, `skill:use` 발신 지점 |
| `client/src/input/skillKeys.ts` (신규) | `Digit1`~`Digit4`, **keydown 전용** |
| `client/src/net/roomConnection.ts` | `sendUseSkill`, `onSkillUsed`/`onSkillDenied`/`onPlayerHealed` |
| `client/src/scenes/WorldScene.ts` | 배선, `applyClassChanged`가 MP·슬롯까지 반영, 시전/치유 처리 |
| `client/src/world/combatEffects.ts` | fallback 시전 링 `cast()`, `healed` 숫자 톤 |
| `client/src/style.css` · `heritage.css` | 두 스킨 모두. 클래식 스킨을 빠뜨리면 사이드바 배치가 깨진다(2026-09-17 실사고) |

### 구현이 틀리기 쉬웠던 네 지점 (착수 전 실측으로 확정)

1. **MP 곡선은 HP 곡선과 게이트를 공유할 수 없다.** `recoverOutOfCombat`에서 HP는 `COMBAT_EXIT_MS` 경과 후에만, MP는 **전투 중에도** `MP_COMBAT_RECOVERY_FRACTION_PER_TICK`(0.005) vs 평시 0.02로 계속 찬다. 공유했으면 전투 내내 게이지가 멈춰 — 캐스터가 실제로 보는 유일한 구간에서 — 서버와 어긋났을 것이다. `nextMpRecoveryAt`·`lastDamagedAt`을 따로 둔 이유다.
2. **`SkillUsed.cooldownUntil`은 서버의 `Date.now()`다**(`metaverseRoom.ts:1132`). 클라이언트에서 빼면 시계 오차가 그대로 게이지에 들어온다. `beginAttackCooldown`이 서버 시각이 아니라 `ATTACK_COOLDOWN_MS` **기간**을 쓰는 것과 같은 이유로 `SKILL_DEFINITIONS[key].cooldownMs`만 쓴다 — `SkillBar.beginCooldown`의 인자가 `skillKey` 하나뿐인 것이 그 계약이다.
3. **방관자 사본에는 `mpRemaining`/`mpMax` 키가 아예 없다**(설계 §3 D3). 핸들러는 시야 내 모든 시전에 불리므로 `casterSessionId` 비교 후에만 게이지를 만진다. `?? 0`으로 받았으면 옆 사람이 스킬 쏠 때마다 내 마력이 0이 됐다.
4. **자기 치유는 `player:healed`가 1통뿐이다**(`metaverseRoom.ts:1203`의 `targetClient !== client` 가드). 2통 전제로 누적했으면 HP가 두 배로 들어왔다.

### 설계에서 좁힌 것 · 넓힌 것

- **좁힘 — 아군 대상 스킬은 자기 자신만 지정한다.** 남을 가리키려면 파티 프레임이 필요하고 그건 R08이다. 서버는 사거리 내 아군 누구든 받으므로 **계약은 그대로이고 UI의 사정거리만 좁다**. 도사의 치유는 오늘 자힐로만 쓰인다.
- **넓히지 않았다 — `#vitals` 패널은 이미 무조건 열려 있었다.** `setMp`가 `reveal()`을 부르지만 `WorldScene`은 Pass F(2026-09-02) 이후 이 패널을 조건 없이 열고 있다. `PlayerVitals.reveal()`의 doc comment가 아직 "첫 몬스터"라고 말하는 것은 그때 갱신되지 않은 것이고, 이번에 그 규칙을 바꾼 것이 아니다. 호출은 남겨 뒀다 — 마력은 광장에서도 차고 쓰이므로(`decisions.md` 2026-09-18 R05-b 미결 4), 저 무조건 reveal이 나중에 다시 좁혀져도 게이지가 함께 사라지지 않게 하기 위해서다.
- **단축키는 hold가 아니다.** `AttackKey`는 600ms 간격 연타를 전제한 hold 입력이지만 스킬 쿨다운은 1.5~12초다. `event.repeat`도 거절한다. IME·레이아웃·포커스 가드는 `attackKey.ts`에서 그대로 가져왔다 — 같은 계열 버그를 이 프로젝트가 두 번 냈다(`homeButton.ts:63`, `inventoryPanel.ts:126`).

### 착수 뒤 발견해 고친 결함 1건 (attach() 순서)

`RoomConnection`은 join 직후 서버가 스스로 보내는 `ClassChanged`를 `attach()` 전까지 `pendingClassChanges`에 모아 두고 `attach()`에서 흘려보낸다. 그런데 `WorldScene`에서 `attach()`는 310행, 클래스/스킬 UI 생성은 432행이었다 — **버퍼가 비워지는 시점에 `skillBar`가 아직 `null`이라 join 동기화가 통째로 버려진다.** `ClassChanged`는 그 뒤로 *직업을 고를 때만* 다시 오므로, 이미 직업이 있는 계정은 그 세션 내내 마력 게이지도 스킬 슬롯도 못 본다.

`questTracker`가 바로 같은 이유로 이미 `attach()` 앞에 있었다(`pendingQuestUpdates`). 같은 자리로 옮겼다. **`classPicker`도 R05-a 때부터 같은 구멍이 있었고** 함께 옮겼다 — R05-a가 남긴 "선택 패널 육안 확인"이 아직 안 된 항목이라 아무도 눈치채지 못한 상태였다.

이 결함은 신규 e2e 7케이스가 **구조적으로 못 잡는다**: 전부 room 접속 없이 모듈을 직접 만드는 화이트박스라 `WorldScene`의 배선을 지나지 않는다. 실제 플레이(§ 남은 한계의 육안 확인)가 이것을 확인하는 유일한 경로다.

**이 수정이 드러낸 두 번째 것 — 자동 오픈 빈도.** 고치고 나니 D9의 패널이 실제로 뜨기 시작했고, 서버가 방마다 join 동기화를 보내므로 문을 지날 때마다 모달이 떴다. 사용자 결정으로 **자동 오픈은 세션당 1회**가 됐다(`decisions.md` 2026-09-21). 기존 e2e 6개 spec이 이 모달에 가려 실패했고 — 원인은 메모리가 아니라 이 변경이다 — `joinRoom` 헬퍼의 `dismissClassPicker` 한 곳과 헬퍼를 쓰지 않는 spec 1개의 직접 호출로 닫았다. 직업을 고르지 않고 닫는 이유는 골라 버리면 기존 spec들이 직업 배율이 걸린 다른 전투를 재게 되기 때문이다.

### 검증

게이트: shared·client·server typecheck 에러 0, client build 성공(`✓ built in 14.59s`), 서버 **1,130 pass / 0 fail**(R05-b 종료 시점과 동일 — 서버는 건드리지 않았다).

신규 `client/e2e/tests/r05c-skill-client.spec.ts` **7케이스 전부 통과**(21.3s). room 접속 없이 실제 `index.html` 마크업에 모듈을 직접 물리는 화이트박스로, `phase-w2-level-client.spec.ts`·`pass-i-boss-hp-bar.spec.ts`의 선례다.

**회귀 확인(되돌려서 실패까지 확인, 2건):**

1. 직업 동기화 오탐 — `applyHit`의 `if (event.damage > 0)` 가드를 떼어 피해 0짜리 동기화도 피격으로 세게 하자 "마력은 전투 중에도 회복하되 더 느리고…"가 정확히 그 1건만 실패했다. 되돌리자 복귀.
2. 쿨다운 길이 — `beginCooldown`의 `SKILL_DEFINITIONS[skillKey].cooldownMs`를 `0`으로 바꾸자 "the cooldown must still be running halfway through it"이 실패했다. **첫 작성본은 이것을 못 잡았다** — 동기 검사만 있어서 `cooldownMs: 0`에도 통과했다. 절반 지점 검사를 추가해서야 판별력이 생겼다. 되돌리자 복귀.

### 실행하지 않은 검증과 남은 한계

- **전체 e2e는 4배치로 나눠 전부 돌렸다(RAM 부족으로 한 번에 못 돌린다 — 사용자 지시).** 16개 spec 전부 최종 트리에서 통과를 확인했다. 단 두 개는 **단독 실행에서만** 초록이었다: `heritage-first-play`(배치 안에서 teardown 타임아웃, 단독 24.4초 통과)와 `phase-x2-death-notice`(같은 트리에서 2실패·2통과 — `decisions.md`에 이미 기록된 기존 플래키). **후자가 직업 패널 때문에 더 불안정해졌는지는 확증하지 못했다** — 자동 오픈을 끄고 한 번 통과한 것이 전부고, 원래 플래키한 spec에 n=1은 근거가 못 된다. 남은 의심으로 기록한다.
- **fresh context tester 재검증은 하지 않았다.** 설계 §4가 R05-c에 대해 "구현자 + 호출자 확인"으로 정한 강도이고, R05-b 기록이 남긴 판별자(비동기 왕복 경합이 있는가)에도 해당하지 않는다 — 이 단계에 `await`가 있는 새 경로는 없다.
- **육안 확인은 남아 있다.** 마력 게이지·슬롯이 두 스킨에서 실제로 어떻게 보이는지, 특히 클래식 스킨 사이드바 안에서의 배치는 사용자가 봐야 닫힌다. headless 자동 확인으로 대체하지 않는다(알려진 오탐).
- **R05-a가 남긴 직업 선택 패널 육안 확인도 그대로 남아 있다.**
- 아군 대상 지정은 위 "좁힘" 항목대로 R08까지 자기 자신뿐이다.
