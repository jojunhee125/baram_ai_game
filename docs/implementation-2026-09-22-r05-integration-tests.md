# R05 실제 접속 통합 테스트 보강

> Git 후속 상태: 이 작업과 E2E 타입 정리는 `297e7ba`로 origin/main에 반영했다. 아래 실패·미커밋 표현은 당시 검증 단계 이력이다. 최신 E2E typecheck는 통과했으며 [현재 정본](../PROJECT_MEMORY.md)을 따른다.

## 목적과 변경

기존 R05-c 7개 테스트는 room 접속 없이 UI 모듈을 직접 생성하므로 WorldScene과 RoomConnection의 연결을 검증하지 못했다. 실제 로컬 서버와 브라우저를 연결하는 `client/e2e/tests/r05-skill-integration.spec.ts`를 추가했다. production 코드와 기존 테스트는 변경하지 않았다.

- 최초 입장의 직업 동기화로 선택 패널이 열리는지 확인한다. 확정 전에는 `class:choose`가 전송되지 않고, 돌아가기 후 확정하면 한 번 전송되는지 확인한다.
- 전사 선택 후 MP 30과 방어 태세 슬롯을 확인하고, 실제 Digit1 입력이 `skill:use` 요청·`skill:used` 응답·MP 감소·쿨다운 표시까지 연결되는지 확인한다. MP는 자동 회복하므로 22~29 범위로 확인한다.
- 쿨다운 중 재입력과 빈 슬롯 Digit2~4가 추가 요청을 보내지 않는지 확인한다.
- 광장의 주술사 화염구가 실제 서버에서 거절되어 '대상이 없습니다'를 표시하고 MP 100을 유지하는지 확인한다.

WebSocket 관측은 메시지 이름 존재와 요청 개수만 확인하며, payload 전체를 디코딩하거나 서버 응답을 주입하지 않는다. 브라우저 context는 매 테스트 후 닫는다.

## 검증

기준: `main`과 `origin/main`이 모두 `b2f55f5025c4b4183e318db47e0c320f88bad729`, 작업 시작 시 clean.

- `code/`: `npm run typecheck` 통과, `npm run build` 통과(4.26초, 기존 큰 chunk 경고).
- `code/server/`: `npx tsx --test --test-timeout=90000 src/rooms/levelSystem.test.ts` — 53 pass, 0 fail.
- `code/client/e2e/`: `npx playwright test tests/r05-skill-integration.spec.ts tests/r05c-skill-client.spec.ts` — 9 pass, 0 fail, 29.8초.
- MP 속성 누락이 감소로 오인되지 않도록 단정을 강화한 최종 파일에서 `npx playwright test tests/r05-skill-integration.spec.ts` 재실행 — 2 pass, 0 fail, 15.3초.
- `code/client/e2e/`: `npx tsc --noEmit` 실패. 수정하지 않은 `r05c-skill-client.spec.ts:266`의 `string`/`SkillDenialReason` 불일치 1건, `shop-ui.spec.ts:117,118,130,132,282,284`의 possibly undefined 6건. 신규 테스트 파일 진단은 없었다. workspace typecheck에는 별도 E2E 프로젝트가 포함되지 않는다.

## 한계와 후속 작업

- Astra 구현 agent와 별도 모델 검증 agent 모두 usage limit으로 중단됐다. 사용자 재개 요청 후 메인 agent가 구현·실행했으며, 다른 모델의 독립 검증은 완료하지 못했다.
- 인증 없는 로컬 세션을 사용한다. SSO 계정의 직업 영속·재접속 복원, 치유 HP 반영, 4직업 전체 플레이와 두 UI 스킨의 시각적 품질을 이번 테스트로 보장하지 않는다.
- R05 및 roadmap 완료 상태는 변경하지 않는다. 실제 플레이와 시각 확인은 여전히 남아 있다.
- 전체 서버/E2E suite는 반복하지 않았다. 관련 서버 53개와 R05 브라우저 9개에 검증을 한정했다. commit·push·배포는 수행하지 않았다.

## 후속 작업 — E2E TypeScript 오류 해소

사용자의 추가 코드 작업 요청에 따라 위에서 발견한 오류 7건을 수정했다.

- `client/e2e/tests/shop-ui.spec.ts`: 첫 번째/두 번째 구매·판매 요청을 지역 변수로 받고 `node:assert/strict`의 `ok`로 존재를 확인한 뒤 nonce에 접근한다. 기존 요청 개수·nonce 차이 단정은 유지하며, 요청이 없으면 런타임에도 실패한다. 배열 길이에 대한 Playwright 단정만으로 TypeScript가 인덱스 접근을 좁히지 못하던 6건을 해소했다.
- `client/e2e/tests/r05c-skill-client.spec.ts`: 거절 사유 배열에 `as const`를 적용해 문자열 리터럴 union을 유지한다. 실행 값과 기존 단정을 바꾸지 않고 `SkillDenialReason` 불일치 1건을 해소했다.
- `code/client/e2e/`의 `npx tsc --noEmit` 통과. 별도 E2E 프로젝트까지 TypeScript 오류 0건이다.
- `code/`의 `npm run typecheck` 및 `npm run build` 통과(9.28초, 기존 큰 chunk 경고).
- `code/client/e2e/`의 `npx playwright test tests/shop-ui.spec.ts tests/r05c-skill-client.spec.ts tests/r05-skill-integration.spec.ts` — 11 pass, 0 fail, 28.0초.
- `git diff --check` 통과. production 코드 변경이 없어 서버 테스트는 추가 반복하지 않았다.
- 별도 모델 `gpt-5.6-sol` reviewer가 이번 수정 두 파일을 독립 검토했다. 지적 사항 0건, 기존 assertion 강도와 browser runtime 동작 유지 확인. 이전 통합 테스트 전체를 검토한 것은 아니며, reviewer는 테스트를 재실행하지 않았다.

## 문서 반영과 Git 전달

사용자가 문서 업데이트 후 commit·push를 요청했다. `docs/roadmap.md`와 `docs/r05-classes-and-skills.md`에 이번 검증 범위와 이 기록의 링크를 추가했다. R05 완료 상태와 수동 확인 항목은 유지한다. 전달 대상은 테스트 3개 파일과 문서 3개 파일이며, 커밋 전 remote 동기화 상태와 변경 목록을 확인한다. 위 'commit·push 미수행' 기록은 전달 요청 전 단계의 상태다.
