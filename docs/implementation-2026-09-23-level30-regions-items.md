# Lv1~30 후속 지역·아이템 — 구현 및 검증 기록

**상태:** 승인 범위 구현·기록된 검증 완료 · 전체 제품 미완료 · 미 push · 미배포

4개 후속 지역과 아이템 성장 경로를 [승인된 설계](design-2026-09-23-level30-regions-items.md)에 따라 추가했다. 변경은 지역 콘텐츠·맵·몬스터·퀘스트·제작·상점, 아이템 카탈로그와 저장/장착 처리, UI·표현 및 관련 회귀 검증을 포함한다. 레벨 상한 30, 네 직업, 기존 스킬 구성과 기존 19개 item key/행 및 아이콘 순서는 유지했다. 이 기록은 승인된 범위의 완료이며 전체 로드맵, 장시간 실제 플레이, 시각 승인 또는 배포 완료를 뜻하지 않는다.

## 구현 결과

- 습지·채석장·설원·유적 4곳, 신규 아이템 48개(총 67), 몬스터 kind 8개, 퀘스트 8개(총 11), 제작 레시피 36개(총 37), 지역 NPC 4명을 연결했다. 최대 고유 아이템 한도를 24에서 80으로 확장했다.
- 지역 이동·포털과 안전 여백, 직업 장비 및 외형, 인벤토리 장착 슬롯 snapshot, 두 반지 슬롯의 동일 아이템 중복 방지, 지역 제작 안내를 연결했다.
- 검증 중 확인한 오류도 수정했다: 기존 퀘스트 등록 순서/접두 콘텐츠 보존, 반지 두 슬롯 장착 검증 및 DB 슬롯 교체 순서, 단일 snapshot의 equipped slot metadata, legacy unknown-slot UI 회귀. HP tonic 및 투구 제작 재료·산출량은 상점 구매보다 제작이 불리하지 않도록 조정했다.

## 검증 증거

- 서버 관련 25개 파일의 첫 최종 실행은 399건 중 397 pass, 2개의 기존 fixture 기대값 불일치, skip 0이었다. 해당 변경 후 실제 PostgreSQL 16.15 (전용 port 55433, `ksc_level30_test`)에서 아래 두 파일을 실행해 112/112 통과, fail/skip 0을 확인했다. 새 동시성 사례를 포함해 중복을 제거한 관련 서버 사례 400개가 최종 통과했다. 이는 단일 400-case 실행 결과가 아니다.

  ```powershell
  $env:ZEP_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55433/ksc_level30_test'
  npx tsx --test --test-concurrency=1 --test-timeout=90000 server/src/db/inventoryStore.test.ts server/src/rooms/equipmentSlots-verification.test.ts
  ```

  독립 실행 로그: `C:/Temp/ksc-level30-independent-server-final.log`, `C:/Temp/ksc-level30-independent-pg-final.log`.
- 브라우저: `cd client/e2e; npx playwright test -c level30.playwright.config.ts` — 24/24 통과(40.9초). `cd client/e2e; npx playwright test -c social.playwright.config.ts tests/social-live.spec.ts` — 실제 browser 2개를 사용하는 party/trade/craft 1/1 통과(14.7초).
- 신규 지역 서버 회귀(`server/src/rooms/level30Progression.verification.test.ts`)를 포함해 공유 타입·데이터 사례 15개가 통과했다. Shared 26/26, 성장 모델 8/8 (`npx tsx --test tools/balance-growth.test.mjs`), root `npm run typecheck`, `npm run build`(99 modules; 기존 500KB 초과 bundle warning), E2E TypeScript 검사 및 `git diff --check` 통과.
- 독립 검사: 67개 전 아이템 획득 경로 도달, 48개 신규 아이템 사용 경로 및 37개 recipe 연결 확인; 4개 맵 BFS·카메라·포털 안전 확인; 기존 아이템 icon 8개와 monster sprite 4개 블록의 픽셀 보존 확인. 64개 전투 산술 사례에서 각 단계×직업의 기본 공격 생존성과 tonic 비용을 포함한 기대 순익 양수를 확인했다. 산술 모델은 실제 플레이 밸런스 측정이 아니다.
- 독립 보안/리뷰 단계에서 blocking finding은 보고되지 않았다.

## 남은 제한

전체 서버·브라우저 테스트 모음, 실제 20~30분 성장 플레이, 사용자 시각 승인, APISIX SSO 및 500 CCU PoC는 이 작업에서 수행하지 않았다. 생성 sprite/icon은 승인된 원작 pixel art나 시각 승인을 뜻하지 않는다. 새 레시피 경제와 전투는 automated/model evidence만 있으며 장기 실플레이 균형은 미확인이다. 코드 변경은 push·배포하지 않았다.
