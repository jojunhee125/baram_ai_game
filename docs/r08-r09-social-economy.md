# R08·R09 파티·거래·제작 — 설계·구현·검증

[로드맵](roadmap.md) R08(파티·공동 보상)과 R09(개인 거래·제작)는 한 번의 승인·구현(E+F+G+H)으로 진행돼 설계·검증이 분리되지 않으므로 한 문서로 둔다.

## 소셜·경제 기능 구현 승인

> 원본: `design-2026-09-23-social-economy.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

2026-09-23 사용자가 “전체 코드 구현 시작”을 명시해 아래 E+F+G+H 범위의 구현을 승인했다. 승인된 동작과 기본값은 아래와 같다.

- E+F: 파티 생성·초대·탈퇴·공유 보상과 대상 지정 UI 지원
- G: 직접 거래 제안·양측 확인·취소·연결 종료 시 원자적인 두 소유자 간 교환
- H: 재료와 결과를 원자적으로 처리하는 제작 레시피 1종

세부 기본값은 파티 방 단위 최대 4명, 초대 TTL 30초, 리더 이탈·연결 종료 시 승계다. 전투는 HP/MP·직업·지원 회복을 사용하고, 자격이 있는 파티원에게 총량 보존형 공유 경험치와 퀘스트 기여를 준다. 전리품은 처치자만 획득한다. 거래는 서로 다른 소유자 간 거리 4 이내에서 revision 기반 양측 확인 후 원자적으로 처리하며, 제안은 최대 6개 슬롯·슬롯당 수량 9999·화폐 1e9 이하이고 장착품 및 보유 제한을 위반하는 항목은 금지한다. 제작은 강화 갑옷 1종으로, 패딩 갑옷 1개와 덴 퍼 3개, 30전을 재료로 사용한다.

이 문서는 2026-09-23 구현 착수 승인 이력이다. 이후 사용자가 구현 변경과 함께 commit·push하도록 승인했다. 배포는 승인되거나 수행되지 않았다. 승인된 E+F+G+H 범위는 구현·검증 완료 상태이며, 상세 근거는 [구현 기록](r08-r09-social-economy.md)에 기록한다. 방 단위 파티, 처치자 단독 전리품, 프로세스 중단 후 보상 복구의 비영속성, 거래 테이블 잠금의 500 CCU 미검증, 서버 재시작 후 대기 거래 복구 미지원은 알려진 제한이다. 아트·장시간 플레이·운영 배포는 별도다.

## 소셜·경제 기능 구현 기록

> 원본: `implementation-2026-09-23-social-economy.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

- **상태:** 구현 및 검증 완료(승인된 E+F+G+H 범위)
- **목적:** 승인된 파티(E+F), 플레이어 거래(G), 제작(H) 구현을 기록한다.
- **승인:** 2026-09-23 사용자가 “전체 코드 구현 시작”을 명시했다. 승인 범위는 [결정 기록](r08-r09-social-economy.md)을 따른다.
- **변경:** 파티 룸별 최대 4명 및 TTL 30초 초대, 리더 승계, HP/MP·직업·지원 회복, 자격자 대상 총량 보존 공유 경험치와 퀘스트 기여, 처치자 단독 전리품을 구현했다. 플레이어 거래는 거리·revision·양측 확인을 적용하고, 원자적 정산과 멱등 replay ledger를 메모리 및 PostgreSQL 저장소에 구현했다. 강화 갑옷 단일 제작 레시피는 재료·화폐·결과를 원자적으로 처리하며 정산 nonce를 재사용할 수 있다. 파티·거래·제작 UI와 인벤토리 무효화도 반영했다.
- **영향 경로:** `shared/src/protocol.ts`; `server/src/rooms/{metaverseRoom,partySystem,partyRewards,tradeSystem,craftingSystem,socialRuntime,ssoIdentity}.ts`; `server/src/db/{tradeStore,settlementStore}.ts`; `server/migrations/0012_trade_settlement.sql`; `server/src/{index,server}.ts`; `server/src/http/routes.ts`; `client/src/{net,ui,scenes,input}` 및 `heritage.css`. Browser 검증 파일은 `client/e2e/social.playwright.config.ts`, `client/e2e/helpers/social-server.ts`, `client/e2e/tests/social-live.spec.ts`, `client/e2e/tests/social-ui.spec.ts`이다.
- **검증:** 현재 작업 트리에서 `npm run typecheck` 및 `npm run build` 통과(97 modules, 기존 500 KB 초과 bundle 경고); 서버 TypeScript 검사도 통과했다. 실 PostgreSQL 선택 파일 49/49, 공유 회귀 26/26, social WebSocket 5/5, dedicated Playwright social suite 8/8(실제 두 브라우저 포함), quest 3/3, boss 6/6, 거래 실 PostgreSQL 8/8 통과. Social systems unit module suite 14/14 통과(같은 소유자 대기 거래 재접속 포함). 기본 in-memory 전체 서버 suite 1203/1203 통과하며, 이는 모든 실 PostgreSQL fixture를 포함하지 않는다. 전용 실 PostgreSQL DB에서 직렬 전체 suite 1322/1322 통과(suites 243, fail/cancel/skip/todo 0, 161696 ms, exit 0). 명령은 `ZEP_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/ksc_social_final_20260923_01 npx tsx --test --test-concurrency=1 --test-timeout=90000 'server/src/**/*.test.ts'`; 로그는 `%TEMP%/ksc-social-server-realdb-serial-final.log`에 있다. Shared 검증은 `npm test --workspace=@zep-test/shared`; browser 검증은 `cd client/e2e; npx playwright test -c social.playwright.config.ts`로 실행했다. APISIX SSO header/cookie 전달 PoC 및 500 CCU 성능 검증은 수행하지 않았다. Final read-only review Critical 0 / Warning 0 / Info 0, Guardian blocker 0. 테스트 수치는 suites가 겹쳐 합산하지 않는다.
- **남은 제한·후속:** 승인된 E+F+G+H 범위의 구현·검증은 완료됐다. 파티는 방 단위이며 재초대가 필요할 수 있고 전리품은 공유되지 않는다. 프로세스 중단 후 보상 복구는 영속적이지 않다. 거래 정산 테이블 잠금의 성능은 500 CCU에서 검증하지 않았으며, 서버 프로세스 재시작 후 대기 거래 복구도 영속화되지 않았다. Playwright 검증은 실제 두 브라우저를 쓴 한 live fixture 검증이며 APISIX SSO 경유 운영 인증 검증은 아니다. 아트·장시간 플레이·운영 배포는 별도다. 이 기록은 구현 변경과 함께 커밋·푸시할 대상이며, 실제 Git 반영 결과는 커밋 이력을 따른다. 배포는 수행하지 않았다.
- **계획(미실행):** 500 CCU 부하 검증은 격리된 production-like 환경과 테스트 계정으로 계획한다. 단일 방에서 실제 WebSocket 행동 50/100/250/500 CCU를, 분산 접속과 한곳 집중, 지속 부하·재접속·soak 조건으로 비교한다. p95/p99 지연, 연결 해제·오류, CPU·메모리·event loop·네트워크, DB pool·lock·deadlock을 관찰하고 인벤토리·화폐 보존도 확인한다. 실행 전에 허용 임계값을 합의한다. 거래의 global inventory lock은 병목 후보로 기록하되, 측정 전에는 결론을 내리지 않는다. 계획은 실행되지 않았고 임계값도 아직 정해지지 않았다.
