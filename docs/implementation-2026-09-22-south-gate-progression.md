# 2026-09-22 남문 홈·성장·사냥터 통합 구현 기록

> **과거 작업 기록:** 당시 남문 구현은 `5eb0f33`으로 저장한 뒤 main에 통합했다. 후속 숲·실DB·성장 검증 `ac70d3f`, 가방 비교 `e7b01d5`, 상점 비교 `a8fbcb0`도 origin/main에 push 완료했다. 아래 미구현·미검증·branch 표기는 당시 범위이며 현재 정본은 [메모리](../PROJECT_MEMORY.md)와 [로드맵](roadmap.md)이다. 운영 배포는 미수행이다.

## 승인과 목적

사용자는 다음 코드 작업을 요청한 뒤 남문 홈 단일 범위 확인에 대해 “하나씩 작업하지 말고 여러개 묶어서 진행 시작해라”라고 지시했다. 이에 최신 로드맵의 남문 홈, Lv1~10 성장·장비 획득 연결, 지역별 지형·행동·보상 차별화를 하나의 구현 묶음으로 착수한다. 단계별 추가 승인 없이 설계·구현·관련 검증까지 진행한다.

기존 EXP 곡선과 저장된 계정 데이터, 왕초보 몬스터 EXP 하향 및 보스 600 EXP 결정을 보존한다. 기존 정산·상점·장비 시스템을 활용하고, 지역 전용 아이템은 판매 또는 장착 등 실제 용도를 가진다. 정확한 2009~2010 원작 배치 재현이나 최종 미술 승인을 자동 테스트로 대체하지 않는다.

## 시작 상태

- 실제 Git 저장소: `code/`.
- `git fetch origin` 성공. HEAD와 origin/main, merge-base는 모두 `297e7bafacef989478cb938e6add65b918b544b6`.
- 작업 branch: `feat/south-gate-progression`.
- 기존 r05 E2E·로드맵·결정·아트 문서 및 미추적 조사/메모리 변경을 보존한다.

## 상태

통합 구현, 독립 코드·보안 검토, 최종 회귀 검증을 완료했다. commit·push·배포는 수행하지 않았다. 설계는 [구현 계약](design-2026-09-22-south-gate-progression.md)을 참고한다.

## 변경 전 성장·경제 점검

독립 tester가 실제 `MetaverseRoom.totalAttack/totalMaxHp`와 기존 콘텐츠를 읽고 산출했다. 일반 공격 간격은 600ms이며 아래는 Lv1/Lv5/Lv10의 무장비 공격력이다: 전사 4/7/12, 도적 5/10/16, 주술사 5/10/17, 도사 3/6/10. 공격 횟수는 `ceil(몬스터 HP / 공격력)`, 첫 명중부터 처치까지 시간은 `(횟수-1)*0.6초`다. 이동·리젠·스킬·네트워크를 제외한 산식이므로 실제 성장 시간이나 직업 종합 밸런스로 해석하지 않는다.

Lv5 누적 EXP 425, Lv10 3,226은 유지한다. 기존 약초는 구매 12전/판매 3전/회복 30 HP다. 일반 전리품의 판매가 없어 약초만 판매할 경우 처치당 환금 기대값이 다람쥐 0.24전, 토끼 0.36전, 사슴 1.5전이었다. 첫 퀘스트 50전 이후 장비 구매 목표가 없던 공백을 이번 묶음에서 연결한다.

변경 전 검사: `npm run typecheck` 3 workspace 통과. `server/`에서 `npx tsx --test --test-timeout=90000 src/rooms/shopSystem.test.ts src/rooms/monsterDefinitions.test.ts src/rooms/levelSystem.test.ts src/rooms/lootTableView.test.ts` → 89 pass / 0 fail. 이것은 변경 전 기준이며 구현 후 검증을 대신하지 않는다.

## 실제 구현 범위

- 남문 홈: plaza ID·시작점(31,20)을 유지하고 성벽·문루·거리·가옥 및 실제 충돌을 구성했다. 남문은 초보 들판, 북쪽 길은 기존 대광장으로 연결한다. 안내 NPC와 상점, 지역명·미니맵도 함께 맞췄다.
- 지형: 초보 들판의 열린 교차로와 바위굴의 암벽 띠를 구분했다. 생성기와 map JSON을 함께 수정했다. 세 번째 위험한 숲은 이번 구현에 포함하지 않았다.
- 성장·경제: 첫 사냥 보상 50전과 기존 성장식을 유지한다. 단검 40전, 누비옷 100전, 사냥꾼 검 180전, 강화 가죽갑옷 300전, 철검 480전의 구매 경로를 추가하고 일반 전리품을 판매 가능하게 했다. 기존 아이콘/무기 렌더링을 재사용하며 새 아이템의 장착·능력치·판매가를 화면에 연결했다.
- 지역 보상: 들판 EXP1/2/3 및 보스600을 유지한다. 굴 토끼48HP/20EXP, 사슴80HP/32EXP와 지역 전용 털·뿔·장비 테이블을 적용했다. 지역 테이블은 기본 드롭과 합산하지 않고 전체 대체하며 runtime/API/boot 검증이 동일 resolver를 사용한다.
- 행동: 들판 다람쥐는 플레이어보다 느린 도주형, 굴 몬스터는 강화된 추격형이다. 굴 도착 구역의 안전거리를 맞춰 배회 범위/배치를 조정했다.

## 중간 검증 및 수정 중 발견

- UI 담당: client typecheck·build 통과. 기존 큰 bundle 경고 유지. 맵 생성 self-check 3개 통과: 연결된 walkable tile 498/860/584, 사냥맵 좁은 통로 0.
- UI 브라우저 smoke: 남문/들판/굴 pageerror0, 900px/1920px 화면 확인. main이 남문·굴 PNG를 직접 열어 화면을 확인했다. 이미지 위치 `client/e2e/test-results/world-screens/`는 테스트 산출물이며 Git 영속 기록은 아니다. 이 검사는 실제 포털 왕복이나 성장 루프 완주를 대신하지 않는다.
- backend 담당: 초기 관련 회귀149/149, workspace typecheck 통과. 이후 독립 tester가 새로 판매 가능해진 장비의 equip/sell 경합과 같은 계정 다른 접속의 stale 장비 cache에서 High 결함을 재현했다. 당시 저장 단계의 장착 장비 debit 거절과 접속 간 cache 정합성을 수정·검증했고 아래 최종 결과에서 통과를 확인했다. 초기149 통과만으로 이 문제의 해결을 주장하지 않는다.

## 독립 검증에서 발견하여 수정한 사항

- 장착과 판매가 같은 turn에 겹치거나 다른 접속의 장비 cache가 뒤처지면 판매 이후에도 능력치가 남는 High 결함을 재현했다. `settlementStore`는 장착 행을 debit하지 않으며 PostgreSQL에서는 행 잠금과 조건부 차감으로 보호한다. `inventoryStore`는 계정별 장비 변경을 같은 process/store의 세션에 알리고 `MetaverseRoom`은 cache와 요청 version을 갱신한다. 실제 장착 변경 기준의 응답 및 실패 rollback을 보존한다.
- 가방을 연 채 새 전리품·구매 장비를 받으면 판매 버튼이 즉시 나타나지 않는 live metadata 누락을 수정했다. `ItemGranted`의 `sellValue/consumable`을 구매·드롭 두 경로에서 전달하고 client의 새 행에 반영한다.
- guardian은 위 경합 수정의 저장소 잠금·이벤트 순서·요청 재전송·rollback을 독립 검토했다. reviewer는 지역 resolver·포털·장식 footprint·장비 표시·알림 수정 diff를 확인했고 잔여 지적 0건으로 반환했다. reviewer 직접 실행한 독립 회귀는 11 pass / 0 fail이다.

## 영향받은 주요 경로

- 지도와 렌더: `tools/generate-{plaza,hunting-ground,hunting-den}.mjs`, `assets/maps/{plaza,hunting-ground,hunting-den}.json`, `client/src/world/heritageArt.ts`, `client/src/ui/minimapTerrain.ts`, `minimap.ts`, `regionGuide.ts`, `client/src/scenes/WorldScene.ts`, `client/src/heritage.css`.
- 동선: `server/src/rooms/portalDefinitions.ts`, `interactableDefinitions.ts`, `questDefinitions.ts`, `shared/src/landmarks.ts`.
- 지역 콘텐츠·상품: `server/src/rooms/monsterDefinitions.ts`, `itemDefinitions.ts`, `shopDefinitions.ts`, `lootTableView.ts`, `server/src/game/monsterAi.ts`, `items.ts`, `server/src/server.ts`.
- 거래·동기화: `server/src/db/inventoryStore.ts`, `settlementStore.ts`, `server/src/rooms/metaverseRoom.ts`, `shared/src/protocol.ts`.
- 아이템 표시: `client/src/net/lootTable.ts`, `client/src/ui/{inventoryPanel,lootTablePanel,objectPanel}.ts`, `client/src/world/weaponVisual.ts`.
- 검증: 관련 server test fixture와 `server/src/rooms/southGateProgression.verification.test.ts`, 관련 client E2E. 기존 사용자 수정 `r05-skill-integration.spec.ts`는 이번 작업 소유 변경에 포함하지 않는다.

## 검증·운영 한계

- 실제 PostgreSQL 실행 환경이 없다: `ZEP_TEST_DATABASE_URL` 미설정, Docker command 없음, WSL 미설치. DB 행 잠금은 코드 검토·SQL test double로 검증했으며 실제 DB 동시성 검증 완료로 표시하지 않는다.
- 장착 알림은 단일 process의 공유 InventoryStore 범위다. 다중 process 배포에는 별도의 invalidation/정합성 설계가 필요하다.
- 세 번째 숲, 새 전용 장비 원화, 원작 시대 화면과의 픽셀 대조·사용자 시각 승인, 네 직업의 실제 장시간 성장/밸런스 확정은 남아 있다. 기존 아이콘과 code-native 도형을 재사용했다.
- SSO gateway와 500 CCU PoC, 실배포는 검증하지 않았다. 기존 bundle size 경고는 유지한다.

## 최종 검증 결과

중간 실패는 변경된 map/판매가/동기화/알림 필드에 대한 기존 fixture를 갱신하고 재검증했다. 아래는 최종 코드 기준이다.

| 실행 위치 / 명령 | 결과 |
|---|---|
| `code/`: `npm test` | exit0. shared26/26 + server1146/1146 = **1172 pass / 0 fail**. server37.62초. 실DB opt-in suite는 환경 미설정으로 등록되지 않으므로 report의 skipped0을 실DB 실행으로 해석하지 않는다 |
| `code/`: `npm run typecheck` | shared/server/client 모두 통과 |
| `code/`: `npm run build` | exit0, 92 modules, 4.30초. 기존 500KB bundle 경고 유지 |
| `code/client/e2e/`: `npx playwright test tests/south-gate-progression.spec.ts` | **3 passed, 26.0초** |
| `code/client/e2e/`: `npx tsc --noEmit` | exit0 |
| `code/server/`: `npx tsx --test --test-reporter=spec src/rooms/passE-combat-verification.test.ts src/rooms/passI-boss-verification.test.ts src/rooms/southGateProgression.verification.test.ts` | 80 pass / 0 fail, 1.01초 |
| `git diff --check` | 통과; CRLF 안내 외 whitespace 오류 없음 |

전체 test 로그: `%TEMP%/ksc-southgate-tests-complete.log`. 최종 browser 이미지: `client/e2e/test-results/progression-screens/{plaza,hunting-ground,hunting-den}.png`. 앞의 `world-screens`는 Playwright 재실행으로 정리될 수 있는 중간 결과이며, 위 progression-screens가 현재 결과다.

신규 server regression15개는 실제 지역별 rabbit 처치 EXP/드롭과 API 일치, 기본 정의 불변, 구매/장착/업그레이드/재접속, nonce25회·잔액 경계·가방 full, 장비 경합3경로, map BFS·굴 도착 안전거리, boot 검증, timid1734개 위치/대상 조합과 cooldown/corner/respawn, 거절 후 판매 재시도 및 live grant metadata를 다룬다.

Browser는 실제 키입력으로 상점 접근, 남문↔들판, 남문→대광장→H, 굴→들판→남문을 검증했다. 들판에서 입장권을 획득해 굴로 들어가는 전체 browser 흐름은 새 test 범위가 아니며 기존 server integration으로 검증했다. 구매 test는 첫 quest 보상과 같은50전을 직접 주입하므로 quest 수령→구매를 단일 browser 흐름으로 검증했다고 표현하지 않는다. 열린 가방의 버튼은 실제 `InventoryPanel.applyGrant` browser component test와 서버 grant metadata regression으로 나눠 검증했다. 전체 E2E suite는 실행하지 않았으며 이번 변경의 이동·상점·드롭·live inventory에 한정했다.

독립 tester/reviewer/guardian 검증과 구현 기록 저장을 완료했다. 잔여 범위는 위 검증·운영 한계와 로드맵에 남겼다.

## 후속 문서 동기화 — 2026-09-22

사용자의 최신화 확인 요청에서 roadmap 상단, 상위 HANDOFF/PROJECT_MEMORY, 저장소 PROJECT_MEMORY, 상위 roadmap 안내에 구현 미승인/미착수 표현이 남은 것을 발견하여 수정했다. 구현 전 review/design은 역사·계약 문서임을 상태 배너로 구분하고 구현 기록에 연결했다. roadmap §7의 실제 후속 후보와 최근 완료 요약도 분리했다. 현재 상태·테스트 결과·미커밋/미배포·남은 제한을 일치시켰다. 문서만 변경했으므로 코드 테스트를 재실행하지 않았다. 링크 대상 존재와 문서 상태 검색 및 git diff --check로 확인했다.
