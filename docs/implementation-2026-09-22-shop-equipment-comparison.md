# 2026-09-22 상점 구매 전 장비 비교

## 승인과 범위

사용자 “다음 코드작업도 개시한다” 지시에 따라 앞선 가방 비교에서 제외했던 상점 구매 전 비교를 다음 단일 구현으로 선택하고 착수 범위를 안내했다. 서버 장비 metadata와 기존 비교 helper를 사용해 같은 슬롯의 현재 장비 대비 공격력·피해 감소 차이를 표시한다. 가격·구매 정산·전투 계산·DB는 변경하지 않는다.

## 시작 상태

git fetch origin 후 main과 origin/main은 모두 `3b7f5b5`이며 작업 트리는 깨끗했다. 사용자 지시에 따라 branch/worktree 생성 없이 main에서 진행한다.

## 진행 상태

구현·독립 코드 검토 완료. 전체 테스트1187개, browser26개와 typecheck/build 통과. main에 커밋·push하며 운영 배포는 수행하지 않았다. [설계 계약](design-2026-09-22-next-shop-comparison.md).

## 실제 변경

- `shared/src/protocol.ts`, `server/src/rooms/metaverseRoom.ts`: ShopListingView에 optional equipment를 추가하고 기존 helper로 생성한다. 비장비는 key 자체를 생략하며 기존 가격·순서·절대 수치를 보존한다.
- `client/src/ui/objectPanel.ts`: 같은 슬롯 장비의 기여 수치와 차이(%p)를 표시한다. 같은 장비의 현재 착용 상태와 빈 슬롯을 구분하고 정보 부족·조회 실패 시 차이를 추측하지 않는다. 조회 실패 후 재시도를 제공한다.
- `client/src/net/inventory.ts`: 상점용 선택적 strict 조회를 추가했다. 필수 row/수량 손상을 실패 처리하며 기존 가방 호출의 동작은 유지한다.
- `client/src/ui/equipmentComparison.ts`: 기존 formatter의 입력을 필요한 필드로 좁혀 상점에서도 재사용한다.
- `client/src/scenes/WorldScene.ts`: 획득·제거·장착 event를 상점 비교 무효화에 연결한다. 조회 중 변경은 합쳐서 후속 조회하며 늦은 응답·닫힌 panel·destroy 이후 갱신을 차단한다. 비교 text만 변경해 구매 nonce·버튼·focus를 보존한다.
- `client/src/style.css`: 비교 표시와 loading/error/retry UI. heritage는 기존 object modal 스타일로 동작하여 별도 CSS 변경이 없었다.
- `server/src/rooms/shopEquipmentMetadata.verification.test.ts`: 실제 상품 목록의 metadata와 기존 필드를 검증하는 신규2개. `metaverseRoom.interactables.test.ts`는 additive 응답의 exact expectation을 갱신했다.

## 검증

- `npm test`: **1187/1187 PASS**(shared26 + server1161), 실패·skip0, 서버37.35초. 로그 `%TEMP%/ksc-shop-comparison-all-tests-final.log`.
- 최초 전체 실행은 별도 focused suite와 동일 테스트 port2581을 동시에 사용하여 EADDRINUSE로1파일 실패했다. 중복 실행 종료 후 위 전체 검증을 단독 재실행해 통과했다. 테스트/제품 로직을 변경해 회피하지 않았다.
- 서버 관련 focused tests **41/41 PASS**,18.55초. 로그 `%TEMP%/ksc-shop-equipment-server-tests.log`.
- `npm run typecheck`: shared/server/client PASS. UI 최종 `npm run build`: PASS,93modules,7.20초. 기존500KB chunk 경고 유지.
- 독립 read-only 검토: strict baseline·중복 슬롯·dirty refresh·close/destroy·재시도·기존 구매 nonce 보존 확인, material defect 없음.
- `client/e2e`에서 `npx playwright test tests/shop-equipment-comparison.spec.ts tests/shop-ui.spec.ts tests/equipment-comparison.spec.ts --output=test-results/shop-comparison-first`: **26/26 PASS**,22.6초. 신규 상점12개·기존 가방12개·기존 상점2개. 같은 슬롯/%p·strict unknown·40개 event의 조회 병합·구매 nonce/focus·close/reopen/nonshop/destroy·standard/heritage720×480 검증.
- E2E `npx tsc --noEmit` PASS. 독립 tester가 두 theme screenshot에서 비교·가격·구매 버튼을 직접 확인했다. 산출물은 `client/e2e/test-results/shop-comparison-first/`에 보존하며 Git에는 포함하지 않는다.
- `git diff --check` PASS. 검증 파일 `client/e2e/tests/shop-equipment-comparison.spec.ts`를 추가했다.

## 제한·미실행

- DB·정산·권한·전투 수치를 변경하지 않아 실PostgreSQL 검증은 재실행하지 않았다.
- Browser는 실제 ObjectPanel/parser/CSS와 typed event3종을 사용하는 component fixture다. WorldScene에서 실제 wire 이벤트 발생을 별도로 강제하지 않았으며 배선은 코드 검토·typecheck로 확인했다. 실제 성장 E2E는 앞선 작업의 통과 결과를 유지하고 이번에는 재실행하지 않았다.
- 전체 캐릭터 피해량/합산 방어율 예측, ring 선택, 신규 상품/지역은 포함하지 않는다.
- 장시간 실제 플레이·사용자 시각 승인·운영 배포는 수행하지 않았다.
