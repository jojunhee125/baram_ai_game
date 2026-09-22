# 2026-09-22 성장 루프·위험한 숲·실DB 병렬 구현 기록

## 승인·목적

사용자가 제안된 세 작업에 “병렬 코드작업 시작해라”로 착수를 승인했다. 실제 성장 흐름의 자동 검증, 세 번째 사냥 지역 구현, 실제 PostgreSQL 거래 경합 검증을 수행한다. [설계 계약](design-2026-09-22-parallel-progression.md)을 따른다.

## Git 및 시작 상태

- 저장소는 `code/`이며 `git fetch origin`과 `git status -sb`를 확인했다. 시작 작업 트리는 깨끗했고 기존 branch의 base는 최신 origin/main `297e7ba`였다.
- 사용자 추가 지시로 신규 branch 생성 없이 main으로 전환, 기존 두 커밋을 fast-forward한 뒤 origin/main에 push했다. 병렬 구현 기준은 main `d14ab02`다.
- 이후 변경·커밋·push는 main에서만 수행한다. 운영 배포는 별도다.

## 진행 상태

세 작업의 구현·독립 검증·통합 회귀를 완료했다. main에서 commit/push하며 운영 배포는 수행하지 않는다. 사용자 시각 승인과 장시간 실플레이는 아래 한계대로 별도다.

## 실제 변경

- `hunting-forest`를 신규 room으로 등록했다. 굴 남동쪽 `(47,25)/(47,26)`에서 기존 입장권으로 진입하고 숲 남쪽에서 굴 `(46,25)`로 돌아온다. 지역 이동 목록에도 같은 입장권 조건을 적용한다.
- `tools/generate-hunting-forest.mjs`와 생성 JSON을 추가했다. 나무 군집 사이 순환길·공터를 구성하고 미니맵, 지역 안내, 굴 샛길 표식, 숲 지형 표현을 연결했다. 기존 굴 collision은 유지하고 출입구 두 ground tile만 바꿨다.
- 숲 토끼는 HP96/EXP45·제자리 매복, 사슴은 HP140/EXP70·추격형이다. 기존 두 지역·boss600EXP는 보존한다. 매복 AI는 인접 공격·cooldown·죽음/respawn을 재사용하고 Step을 반환하지 않는다.
- 숲의 수지(판매16전), 오래된 나무껍질(28전), 숲지기 망토(판매90전·cloak slot·피해 감소10%)를 추가했다. 실제 처치와 드롭 정보가 같은 room resolver를 사용한다. 기존 몬스터 sprite와 item icon을 재사용했다.
- 검토 중 최초 망토 후보 HP+20이 기존 장착 변경의 HP cap 동기화 공백을 활성화함을 발견했다. 새 자원 동기화 기능으로 범위를 넓히지 않고 기존 API 표시와 서버 계산이 지원하는 피해 감소10%로 확정했다. maxHp 장비 지원을 수정했다고 주장하지 않는다.
- E2E와 실DB 테스트는 독립 agent가 병렬 작성했다. 설계 agent 이후 추가 coder/UI thread 생성은 도구의 thread limit로 거절되어 main이 확정 계약에 따라 숲 production을 구현했다. 별도 context의 설계 agent가 읽기 전용 검토를 수행하고 tester가 독립 검증한다.
- 성장 E2E 최종 실행은 실제 다람쥐3마리→50전 보상→구리 동전1개 판매(+8전)→단검 구매(-40전)·장착→새 session 재접속을 완주했다. 판매 직후 실제 inventory의 수량1 감소, 재접속 후18전·전체 inventory(단검1개 장착·입장권1개 포함)·퀘스트 완료 유지, 퀘스트 보상 중복 지급 없음을 확인했다. 이전 실행의 도토리 판매14전도 통과했으며 무작위 전리품을 그대로 사용하므로 품목/잔액은 실제 획득값으로 계산한다.
- 테스트 작성 중 로컬 두 port의 CORS preflight, 포털 후 직업 선택창, 사냥 위치에 따른 충돌 경로, 저장된 외형으로 선택창을 생략하는 재접속 대기 조건을 보완했다. 공개 map의 collision을 읽는 BFS는 키입력 경로만 정하며 서버/Phaser 상태를 바꾸지 않는다. 이 과정에서 production 사냥·보상·인증 코드는 변경하지 않았다.

## 중간 검증

- 공식 [EDB Windows 바이너리](https://www.enterprisedb.com/download-postgresql-binaries)의 PostgreSQL16.15를 `C:/Temp/ksc-pg-20260922/`에 준비했다. 전용 cluster/database `ksc_parallel_test`, loopback `127.0.0.1:55432`만 사용하며 운영 DB/서비스를 변경하지 않는다.
- `ZEP_TEST_DATABASE_URL` 설정 후 실제 migration0001–0011과 신규 경합7개를 포함한 관련 DB 회귀 **187 pass / 0 fail / 0 skip**. 독립 backend PID4개와 `pg_blocking_pids`로 실제 lock 대기를 확인했다. rollback 테스트의 의도한 integer overflow22003 로그는 예상 결과다. 로그 `%TEMP%/ksc-settlement-realdb-tests.log`.
- `node tools/generate-hunting-forest.mjs`: 첫 self-check가 북쪽 1tile 통로를 거절했다. 나무 군집을 경계로 붙여 수정 후 **576 walkable·전체 연결·좁은 통로0·도착/배회 안전성** 통과. 굴 generator는 기존584 walkable 유지.
- workspace typecheck와 build 통과(92 modules,19.03초; 기존500KB bundle 경고 유지).
- 첫 전체 테스트에서 기존 catalogue 기대값2건·굴 portal 기대값1건, 이동 타이밍1건이 실패했다. fixture 갱신 및 독립 재검증 후 최종 결과를 아래에 기록한다. 이 중간 실행을 통과로 보고하지 않는다.

## 검증 및 한계

- 자동 성장 E2E는 동일 서버의 InMemory store를 실제 UUID 계정으로 이용한다. 브라우저 인증 header fixture와 로컬 CORS preflight만 준비하고 보상/아이템/EXP/퀘스트·게임 응답을 주입하지 않는다. APISIX·SSO 배포 경로 및 DB 재시작 내구성의 증거는 아니다.
- 실DB 경합 검증은 저장 상태 원자성에 대한 것이다. 다중 process 장비 cache invalidation을 구현·검증하지 않았다.
- 숲 browser 검증은 직접 room 입장으로 화면을 보고, 실제 키입력으로 굴 출구와 입장권 없는 재진입 거절을 확인한다. 입장권 보유 왕복·landmark 수용인원은 서버 통합 테스트로 검증한다. 기존 직접 room join 경로는 입장권을 강제하지 않으므로 portal/landmark 조건을 room 전체 접근 통제로 표현하지 않는다.
- 숲은 기존 토끼/사슴 sprite·기존 item icon을 재사용한다. 망토의 캐릭터 외형 layer는 추가하지 않았다. 실제 20–30분 체감 밸런스, 네 직업 장시간 플레이, 시대 reference·사용자 시각 승인, 500CCU 및 운영 배포는 이번 검증에 포함하지 않는다.
- main이 browser screenshot의 숲 도착 화면·보상표·굴 샛길을 직접 열어 확인했다. 이는 최종 아트 승인과 구분한다.
- 테스트용 PostgreSQL은 검증 후 `pg_ctl -D C:/Temp/ksc-pg-20260922/data -m fast -w stop`으로 정상 종료했다. 전용 파일은 재현을 위해 남기며 Windows service는 설치하지 않았다.

## 최종 검증 결과

| 실행 위치 / 명령·검증 | 결과 |
|---|---|
| `code/`: `npm test` | shared26 + server1156 = **1182 pass / 0 fail**, server39.09초. 실DB opt-in은 이 명령과 별도로 실행했으며 skipped0을 실DB 실행 증거로 해석하지 않는다 |
| `code/`: `npm run typecheck` | shared/server/client 통과 |
| `code/`: `npm run build` | exit0,92modules,8.39초. 기존500KB bundle 경고 유지 |
| 실제 PostgreSQL settlement/inventory/currency 회귀 | **187/187**, 신규 경합7개 포함, skip0 |
| 숲 신규·monsterDefinitions·items 검증 | **47/47**, 신규 숲9개 포함 |
| 숲·기존 지역·AI 회귀 | **58/58** |
| `server/`: `npx tsx --test --test-timeout=90000 src/rooms/metaverseRoom.integration.test.ts` | **40/40**,33.60초. 최초 전체 실행의 이동 타이밍 실패는 독립 재실행과 최종 전체 실행에서 미재현 |
| 두 map generator 재실행 및 SHA256 전후 비교 | 동일 출력, self-check 통과 |
| `client/e2e/`: `npx playwright test tests/first-growth-loop.spec.ts --output=test-results/growth-run` | **1 passed**,1.2분(testcase1.1분). 실제 획득·판매 후 persisted 수량 차감·구매·장착·계정 재접속 |
| `client/e2e/`: `npx playwright test tests/hunting-forest.spec.ts tests/pass-m-landmark-teleport.spec.ts` | **9 passed**. 숲 화면·출구·입장권 거절 및 지역 이동 회귀 |
| `client/e2e/`: `npx tsc --noEmit` | 통과 |
| `git diff --check` | exit0, CRLF 변환 안내 외 오류 없음 |

전체 테스트 로그: `%TEMP%/ksc-parallel-all-tests-final.log`. 독립 숲 로그: `%TEMP%/ksc-forest-verification.log`, `%TEMP%/ksc-forest-regression.log`. Browser 관련 **10개 통과**이며 전체 E2E suite는 미실행(변경 범위의 성장·숲·지역 이동 검증에 한정). 테스트 browser/server port2567/5173은 종료했다. Screenshot과 trace는 Playwright 산출물이며 Git 영속 자료는 아니다.

## 영향받은 경로

- 지역 정의·AI·보상: `server/src/rooms/{definitions,portalDefinitions,landmarkDefinitions,monsterDefinitions,itemDefinitions}.ts`, `server/src/game/monsterAi.ts`, `shared/src/landmarks.ts`.
- map·표시: `tools/generate-hunting-{forest,den}.mjs`, `assets/maps/hunting-{forest,den}.json`, `client/src/world/{heritageArt,heritageMonsterArt}.ts`, `client/src/ui/{inventoryPanel,minimapTerrain,regionGuide}.ts`.
- 검증: `server/src/db/settlementStore.realdb.test.ts`, `server/src/rooms/forestProgression.verification.test.ts`, 관련 catalogue/굴/monster fixture, `client/e2e/tests/{first-growth-loop,hunting-forest,pass-m-landmark-teleport}.spec.ts`.
- 기록: 본 문서, 설계 계약, `docs/roadmap.md`, `docs/decisions.md`.
