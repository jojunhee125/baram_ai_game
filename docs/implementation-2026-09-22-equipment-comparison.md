# 2026-09-22 장비 교체 전 능력치 비교 구현

> 후속 상태: 이 가방 작업에서 제외했던 상점 구매 전 비교는 `a8fbcb0`으로 구현·push 완료했다. 문서 최종 정리도 `3b7f5b5`로 origin/main에 반영했다. [상점 구현 기록](implementation-2026-09-22-shop-equipment-comparison.md).

## 승인·범위

사용자가 “다음 코드작업 하나 더 진행”으로 추가 코드 작업을 지시했다. 로드맵의 미구현 장비 비교를 선택하여 가방에서 현재 같은 슬롯 장비와 후보 장비의 능력치 차이를 보여준다. 기존 장비/전투/판매 수치와 정산 로직은 변경하지 않는다. [설계 계약](design-2026-09-22-equipment-comparison.md)을 따른다.

## 시작 상태

`git fetch origin`과 `git status -sb` 확인. main·origin/main·merge-base는 모두 `ac70d3f`이며 작업 트리는 깨끗했다. 사용자 지시에 따라 branch 생성 없이 main에서 작업·커밋·push한다.

## 상태

구현·독립 검토 완료. 전체 테스트1185개와 browser15개, 추가 layout2개, typecheck/build를 통과했다. 구현 커밋 `e7b01d5`를 `origin/main`에 push 완료했다. 운영 배포는 수행하지 않았다.

## 구현 중간 기록

- `EquipmentMetadata {slot, attackDamage, damageReduction}`를 optional `equipment`로 전달한다. 현재 서버 catalogue에서 보너스가 없는 수치는 0으로 정규화하고 장비가 아닌 품목은 metadata를 제공하지 않는다. 기존 응답 필드는 유지한다.
- `server/src/rooms/itemDefinitions.ts`의 단일 helper를 inventory HTTP 응답, 구매 성공 `ItemGranted`, 실제 전리품 `ItemGranted`에서 공유한다. 서버 typecheck 통과. DB·전투 계산·장착/정산 성공 판정은 변경하지 않았다.
- UI는 같은 슬롯의 장비 보너스만 비교한다. 전체 캐릭터 공격력·다른 방어구를 합친 최종 감소율 예측은 범위 밖이다. 피해 감소 차이는 %p로 표기한다.
- 설계/UI/서버 테스트/browser 테스트를 분담했다. 추가 backend coder 생성은 thread limit로 거절되어 main이 설계 계약에 따라 서버 metadata를 구현하고 독립 tester가 검증한다.

## 중간 검증

- `npx tsx --test --test-timeout=90000 server/src/rooms/equipmentMetadata.verification.test.ts server/src/http/routes.inventory.test.ts server/src/rooms/shopSystem.test.ts` → **31/31**,1.18초. 신규3개는 전체 catalogue의 HTTP 표시, 구매·전리품·HTTP metadata 일치, 기존 필드·착용상태·수량·가격 보존을 검증했다. 일반 품목 metadata가 JSON wire에서 생략되는 것도 확인했다.
- 서버 typecheck 통과. UI 초기 typecheck/build 통과(93modules, 기존500KB chunk 경고 유지). 최종 UI 수정 이후 통합 검증은 아래에 별도 기록한다.
- 로딩 중 같은 itemKey의 이벤트를 마지막 하나로 압축하면 `획득→장착→추가 획득` 순서의 인과관계가 사라질 수 있어 순서 보존 queue로 수정한다. 최대128건 이후는 추가 조회로 수렴시키며 단순 중복 키 압축으로 상태를 잃지 않는다.

## 최종 변경 사항

- 서버가 제공한 장비 공격력·피해 감소와 같은 슬롯의 현재 장비 이름·차이를 표시한다. 빈 슬롯만 0으로 비교하며 누락·잘못된 metadata는 비교 불가로 표시한다. 기존 아이템 행과 사용/판매 동작은 유지한다.
- HTTP 로딩 중 이벤트는 최대128건을 순서대로 replay한다. 초과 시 snapshot을 다시 조회하고, unknown 장착 슬롯도 snapshot으로 해소한다. 나중에 장비 정보가 도착한 행에는 장착 버튼을 추가하고 기존 focus를 유지한다.
- destroy 이후 live event를 무시하며 standard의 낮은 화면에서 가방 내용이 잘리지 않도록 panel scroll과 최소 list 높이를 적용했다. heritage도 비교 문구를 표시한다.
- 최초 전체 테스트에서 비장비 event의 `equipment: undefined` 추가가 기존 객체 형태 검증1건을 깨뜨렸다. 비장비에는 key 자체를 생략하도록 세 응답 경로를 수정했고 기존 테스트는 약화하지 않았다.

## 영향 경로

- `shared/src/protocol.ts`: optional 장비 metadata 계약.
- `server/src/rooms/itemDefinitions.ts`, `server/src/http/routes.ts`, `server/src/rooms/metaverseRoom.ts`: 정규화 helper와 inventory/구매/전리품 전달.
- `client/src/net/inventory.ts`, `client/src/ui/equipmentComparison.ts`, `client/src/ui/inventoryPanel.ts`: 검증·비교·실시간 상태 처리.
- `client/src/style.css`, `client/src/heritage.css`: 비교 표시와 작은 화면 layout.
- `server/src/rooms/equipmentMetadata.verification.test.ts`, `client/e2e/tests/equipment-comparison.spec.ts`: 독립 회귀 검증.
- `docs/design-2026-09-22-equipment-comparison.md`, 이 기록, `docs/roadmap.md`, `docs/decisions.md`: 계약·승인·구현 상태.

## 최종 검증

- `npm test`: **1185/1185 PASS**(shared26 + server1159), 실패·skip0. 서버39.9초. 로그 `%TEMP%/ksc-equipment-all-tests-final.log`.
- `npx tsx --test --test-timeout=90000 server/src/rooms/equipmentMetadata.verification.test.ts server/src/rooms/passE-combat-verification.test.ts`: **21/21 PASS**, 비장비 event 호환성 수정 확인.
- `npm run typecheck`: shared/server/client 모두 PASS.
- 최종 UI 수정 후 `npm run typecheck --workspace=@zep-test/client`, `npm run build` PASS(93 modules,4.86초). 기존500KB chunk 경고는 유지된다.
- 독립 read-only 검토에서 metadata 계약·unknown 비교·서버 장착 권한 관련 blocker 없음.
- `client/e2e`에서 `npx playwright test tests/equipment-comparison.spec.ts tests/shop-ui.spec.ts tests/first-growth-loop.spec.ts --output=test-results/equipment-comparison-final`: **15/15 PASS**,1.1분. 신규12개·기존 상점2개·실제 성장1개를 검증했다. 초기 실패에서 찾은 destroy 이후 event와 standard720×480 잘림을 수정 후 재검증했다. unknown metadata 이름 기대값은 fixture와 맞추되 숫자 억제 assertion을 유지했다.
- Browser 검증은 공격력 차이·피해 감소 %p·빈 슬롯·legacy/malformed metadata·focus·로딩 이벤트 순서·장착/해제·부분 판매·거절 event·queue overflow·destroy·두 스킨 좁은 화면을 포함한다. 실제 성장 검증은 보상 주입 없이14전 획득→단검 구매/장착→재접속 유지를 통과했다.
- Screenshot scroll 위치 정리 후 layout2개 재실행 **2/2 PASS**,5.6초. 독립 tester가 standard/heritage screenshot을 직접 확인했다. 산출물은 `client/e2e/test-results/equipment-comparison-layout/` 아래이며 Git에 포함하지 않는다.
- E2E `npx tsc --noEmit` PASS. `git diff --check` PASS. 최종 lifecycle/layout delta도 독립 reviewer 승인.

## 제한·미실행

- Browser 검증은 실제 HTML/CSS/parser/panel을 사용하는 component fixture이며 실제 계정의 장시간 플레이 검증과 구분한다.
- 실제 PostgreSQL 재검증은 미실행: DB schema/query/정산 로직을 변경하지 않았고 이전 작업의 실DB 검증을 유지한다.
- 상점 구매 전 비교, 최종 직업 공격력/합산 방어율 예측, 신규 장비/HP bonus는 구현 범위 밖이다. 운영 배포·사용자 시각 승인은 수행하지 않았다.

## 문서 최종 정리

2026-09-22 사용자 요청으로 이 기록과 `roadmap.md`·`decisions.md`의 구현 및 Git 반영 상태를 확정했다. `git fetch origin` 후 main과 origin/main이 `e7b01d5`로 일치하고 선행 `ac70d3f`가 포함됨을 확인했다. 코드 변경이 없어 테스트/build는 재실행하지 않으며 위 결과를 유지한다. 문서 diff와 링크를 확인한 뒤 main에 커밋·push한다.
