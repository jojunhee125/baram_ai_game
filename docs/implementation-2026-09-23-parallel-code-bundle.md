# 2026-09-23 병렬 코드 묶음 구현 기록

## 목적과 승인

사용자는 2026-09-23 [범위 결정](design-2026-09-23-parallel-code-bundle.md)의 A(캐릭터 동작), B(장비 조건), C(지역 퀘스트), D(첫 단계 보스), I(성장 밸런스 CLI)를 함께 구현하도록 승인했다. 기존 시스템을 확장하고 공통 room·protocol 파일은 단일 작업자가 통합했다.

## 실제 변경

- **A:** `client/src/world/playerSprites.ts`, `client/src/scenes/WorldScene.ts`, `client/src/net/roomConnection.ts`에서 원격 공격·시전·피격·사망 이벤트와 기존 동작 texture의 fallback을 연결했다. `shared/src/protocol.ts`와 `server/src/rooms/metaverseRoom.ts`가 주변 플레이어에게 동작 이벤트를 보낸다. 현재 장비 레이어의 방향·깊이 동기화 경로를 유지한다.
- **B:** `server/src/rooms/{contracts,itemDefinitions,metaverseRoom}.ts`, `server/src/game/items.ts`, `shared/src/protocol.ts`에 레벨·직업 장비 조건과 서버 판정을 추가했다. 기존 장비는 조건을 두지 않았다. 숲 드롭의 신규 `veteran-blade`(Lv6 전사/도적)와 `mystic-cloak`(Lv7 주술사/도사)은 기존 icon을 재사용한다. `client/src/net/inventory.ts`, `client/src/ui/{inventoryPanel,objectPanel}.ts`, `client/src/style.css`에 가방·상점 조건 안내와 장착 버튼 제한을 연결했다.
- **C:** `server/src/rooms/questDefinitions.ts`, `server/src/db/questStore.ts`, `server/src/rooms/metaverseRoom.ts`에 `first-hunt` 후 굴 조사, 이어 숲 사냥 목표를 추가했다. 지정 지역 처치만 집계하며, PostgreSQL 선행 완료 검사는 원자적 `INSERT … SELECT … WHERE EXISTS`로 시행한다.
- **D:** `server/src/rooms/metaverseRoom.ts`의 `hg-boss-01`에 목표 타일 예고→공격→빈틈, HP 50% 이후 2단계 공격을 붙였다. 타일을 벗어나 회피할 수 있고 취소는 예고를 받은 주변 세션으로 보낸다. `client/src/world/bossTelegraphs.ts`가 예고 영역을 표시한다. 기존 respawn·전리품은 유지한다.
- **I:** `tools/balance-growth.mjs`와 `.test.mjs`를 추가했다. 현재 게임 데이터에 기반해 직업·장비·지역별 자동 공격 처치 시간, 예상 EXP와 약초 비용·순수입을 계산한다. 출력에 탐색 시간·반격·회복 등 가정과 미포함 요소를 명시한다.
- 관련 서버 테스트와 `client/e2e/tests/{equipment-comparison,equipped-appearance,shop-equipment-comparison}.spec.ts`를 갱신했다.
- 후속 퀘스트 카드와 알림이 생겨 단일 카드·마지막 알림을 가정하던 `client/e2e/tests/first-growth-loop.spec.ts`의 검증 대상을 `first-hunt`로 명시했다.
- 독립 리뷰에서 찾은 세 문제를 후속 수정했다. 잠긴 퀘스트 버튼·안내를 `QuestState.blocked`로 갱신한다. 보스 예고는 서버가 보낸 `windupMs`로 로컬 타이머를 시작하고 실제 공격 판정에서 취소한다. 퀘스트 저장값 로딩 전에 NPC를 연 경우 로딩 완료 후 offer 잠금 상태를 다시 보낸다. 관련 경로는 `client/e2e/tests/quest-prerequisite.spec.ts`와 서버 회귀 테스트로 확인했다.

## 검증

| 명령/검증 | 결과 |
|---|---|
| server 전체 테스트 | 1,175/1,175 통과 |
| `npm run typecheck` | server·shared·client 통과 |
| `npm run build` | client build 통과(기존 번들 크기 경고) |
| `git diff --check` | 통과 |
| 관련 Playwright | 36/36 통과 |
| 리뷰 수정 관련 Playwright | 11/11 통과 |
| client/e2e TypeScript 검사 | 통과 |
| `npx tsx --test tools/balance-growth.test.mjs` | 6/6 통과 |
| CLI 직접 실행 | 성공, 결정론적 추정치 출력 |
| 독립 서버 핵심 테스트 | 109/109 통과 |
| 수정 후 첫 성장 루프 Playwright | 1/1 통과: 퀘스트·판매·장착·계정 재접속 |
| 전체 Playwright | 116/148 진행 후 장시간 지연으로 중단, 전체 통과 미확인 |

전체 브라우저 실행에서 NPC 패널이 예상 위치에서 숨겨지는 실패와 보스 HP바가 HUD 조작 표시와 겹치는 실패를 각각 단독 재현했다. 이번 변경과의 인과관계는 확인되지 않았고 원인은 미확정이다. 그 밖에 옛 지역명을 기대하는 `heritage-first-play` 같은 기존 테스트 가정도 관찰했다. 신규 구현에 귀속되는 Critical/High 결함은 독립 검증에서 확인되지 않았다. 최종 read-only 재리뷰는 Critical 0 / Warning 0 / Info 0이다.

새 `acceptAfter` SQL의 실제 PostgreSQL 실행은 **미실행**이다. 이번 환경에는 `DATABASE_URL`과 `psql`이 없으며 서버 전체 테스트는 저장소 stub 계약을 검증했다. 실제 DB에서 동시 수락·재접속을 확인하는 작업은 후속 환경 검증으로 남는다.

실제 20~30분 플레이·목표 시대 원화와 24종 통일·사용자 시각 승인·운영 배포는 수행하지 않았다. CLI 추정치를 실제 플레이 결과로 해석하지 않는다.

## 문서·메모리 최신화 및 Git 반영 — 2026-09-23

- 사용자가 모든 프로젝트 메모리·로드맵 최신화 후 commit·push하도록 승인했다. `code/PROJECT_MEMORY.md`, `code/CLAUDE.md`, `code/docs/{roadmap,decisions}.md`의 현재 상태·마일스톤·다음 작업을 갱신했다.
- 저장소 바깥 `PROJECT_MEMORY.md`, `HANDOFF.md`, `CLAUDE.md`, `docs/{roadmap,decisions}.md`도 최신 정본을 가리키도록 갱신했다. 이 파일들은 `code/.git`의 추적 범위 밖이며 로컬 안내로 남는다. 과거 archive와 날짜별 검증 기록은 이력으로 보존했다.
- 해당 Claude 프로젝트의 외부 `memory/` 디렉터리는 비어 있었다. 프로젝트와 무관한 메모리와 앱 내부 DB는 수정하지 않았다.
- 이번 변경은 문서만 갱신하므로 통과한 코드 테스트를 반복하지 않는다. Git diff 검사·현재 링크 대상·로드맵 상태 일치 여부를 확인하고 동일 main 코드·문서 묶음으로 commit·push한다. 실 배포는 수행하지 않는다.
- Git 반영 결과는 main 이력과 원격 SHA 비교를 따른다.
