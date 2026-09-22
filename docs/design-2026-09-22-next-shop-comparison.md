# 상점 구매 전 같은 슬롯 장비 비교

상태: 2026-09-22 설계 확정. 사용자의 “다음 코드작업도 개시한다” 지시에 따라 다음 작은 구현을 선택한다. main 담당자가 fetch 후 `main == origin/main == 3b7f5b5`, clean 상태를 확인했다. branch/worktree를 만들지 않으며 모든 Git 반영은 main 담당자가 main에서 수행한다. 이 문서는 구현·검증·배포 완료 기록이 아니다. 구현 착수 범위와 결과는 별도 implementation record 및 roadmap/decisions에 기록한다.

## 선택 근거와 범위

`docs/roadmap.md:5,71`은 가방 장비 비교 완료와 상점 구매 전 비교 제외를 명시한다. 실제 `client/src/ui/objectPanel.ts`의 `renderShop`/`buildShopRow`는 아이콘·이름·가격·절대 장비 수치·구매 버튼만 보여 준다. `server/src/rooms/metaverseRoom.ts`의 `shopOffered`는 authored shop listing을 표시용 `ShopListingView`로 변환한다. 직전 가방 비교에서 만든 서버 metadata·HTTP inventory·비교 formatter를 재사용할 수 있어 다음 작업으로 적합하다.

포함: 현재 상점의 장비 후보와 현재 착용한 같은 슬롯 장비의 공격력 보너스/피해 감소 차이를 구매 전에 표시한다. 미장착·같은 장비·정보 부족·조회 실패·실시간 변경·닫기/재열기/scene 종료를 처리한다. 제외: 새 상품/가격/보상/전투 수치, 구매 후 자동 장착, 최종 캐릭터 전투력 계산, ring 선택, 새 API/DB/cache, boss/party/전직, 가방 상태 관리의 전면 통합. R04의 장시간 실제 플레이나 R06/R07 전체 완료로 표시하지 않는다.

## Task Plan: 구매 판단에 현재 장비 연결

- Phase 0 Design → architect: 실제 roadmap·shop 표시·inventory 계약을 확인하고 이 문서를 작성한다.
- Phase 1 Implementation → coder(server/shared) | ui-engineer(shop/client). **parallel: yes; file_overlap: 없음.** UI는 아래 additive shared 계약을 기준으로 작업하며 typecheck는 shared 변경 이후 수행한다.
- Phase 2 Verification → tester: listing metadata, 비교/실시간 race/호환성/browser layout과 기존 구매 회귀를 검증한다. main은 전체 test/typecheck/build를 실행한다.
- Phase 3 Review → read-only reviewer/guardian 또는 독립 context 검토. main은 구현 기록·roadmap·decisions를 갱신하고 main에 반영한다.

| 담당 | 독점 소유 경로 | 입력·출력 및 의존성 |
|---|---|---|
| coder 또는 main | `shared/src/protocol.ts`, `server/src/rooms/metaverseRoom.ts` | 기존 `EquipmentMetadata`/`equipmentMetadata`를 shop listing에 additive 연결. 새 helper/정산 변경 없음 |
| ui-engineer | `client/src/ui/objectPanel.ts`, `client/src/ui/equipmentComparison.ts`, `client/src/scenes/WorldScene.ts`, 필요한 `client/src/net/inventory.ts` 및 `client/src/style.css`/`client/src/heritage.css` | 기존 inventory parser/API/formatter 재사용. Shop 표시와 아래 live invalidation 배선. net inventory는 아래 선택적 strict 조회만 허용; InventoryPanel 수정 없음 |
| tester | 신규 `server/src/rooms/shopComparison.verification.test.ts`, 신규 `client/e2e/tests/shop-equipment-comparison.spec.ts` | production과 파일 중복 없음. 기존 `shopSystem.test.ts`, `shop-ui.spec.ts`, `equipment-comparison.spec.ts`를 회귀 실행하며 수정 필요 시 main과 소유권 합의 |
| architect | 신규 `docs/design-2026-09-22-next-shop-comparison.md` | 이 설계만 작성 |
| main | implementation record, `docs/roadmap.md`, `docs/decisions.md`, Git | 구체적 착수 결정과 실제 구현·검증·push/배포 상태를 구분하여 기록 |

모든 작업자는 공동 작업 중이며 다른 담당자의 변경을 되돌리지 않는다. server 변경과 UI 변경 사이에 파일 중복은 없고 테스트는 신규 파일로 분리한다. Browser port 소유권은 main이 tester 한 명에게 배정한다.

## Design Decision: 상품 수치 계약

Options: 1) 기존 `attackBonus`/`damageReductionRatio`와 client itemKey 표로 슬롯을 추정한다 — 서버 수정은 작지만 구형/신규 상품과 0 수치의 의미가 모호하다. 2) 기존 정규화된 `EquipmentMetadata`를 listing에도 optional 전달한다 — 서버 정의를 그대로 재사용하며 가방과 상점 수치가 일치한다.

Decision: **2**. 이미 있는 helper를 `shopOffered` 한 곳에 연결한다. 기존 필수 필드와 `attackBonus`, `damageReductionRatio`는 그대로 유지하고 비장비는 새 key 자체를 생략한다.

```ts
// Additive member on existing ShopListingView in shared/src/protocol.ts.
equipment?: EquipmentMetadata;

// Existing helper; reuse without changing its implementation or stats.
export function equipmentMetadata(definition: ItemDefinition): EquipmentMetadata | undefined;
```

metadata 내부 `attackDamage`/`damageReduction`는 필수이며 해당 보너스가 없으면 실제 0이다. metadata 객체 부재는 unknown이다. 서버가 제공한 객체는 기존 `readEquipmentMetadata`로 검증하고 잘못된 optional metadata 때문에 상품/가격/구매 버튼을 버리지 않는다. 구형 listing의 절대 수치 표시는 유지하되 슬롯/기준을 추측해 차이를 계산하지 않는다. non-gear 약초에는 불필요한 비교 경고를 붙이지 않는다.

## Design Decision: 현재 장비의 조회와 실시간 갱신

Options: 1) 가방과 상점을 위한 전역 inventory model을 새로 추출한다 — HTTP를 공유하지만 이미 검증한 가방 lifecycle과 모든 호출부를 변경한다. 2) 열린 장비 상점에 한해 기존 `loadInventory()`로 현재 장비를 읽고, 관련 live 이벤트에서 비교만 무효화한 뒤 조회를 합친다 — 작은 독립 수명주기로 기존 가방을 유지한다.

Decision: **2**. 같은 상점을 열 때 baseline 조회 한 번, 이후 변경 알림에 대한 coalesced refresh만 둔다. polling·구매 click 시 추정 장착·전역 store·가방의 128-event replay queue 복제는 하지 않는다.

```ts
// Existing ObjectPanel: typed live notifications; only invalidate comparison.
applyGrant(event: ItemGranted): void;
applyItemRemoved(event: ItemRemoved): void;
applyEquipmentChange(event: EquipmentChanged): void;

// In existing equipmentComparison.ts, narrow the required input fields so both
// inventory rows and shop candidates can use the same formatter without fake quantity.
export type EquipmentComparisonItem = Pick<InventoryItem, "name" | "equipped" | "equipment">;
export function describeEquipmentComparison(
  item: EquipmentComparisonItem,
  current: EquipmentComparisonItem | null | undefined,
): EquipmentComparisonDescription;
```

`WorldScene`의 기존 `onItemGranted`, `onItemRemoved`, `onEquipmentChanged`에서 대응하는 typed 알림을 호출한다. `EquipmentChanged`는 `applied:true`일 때만 비교를 무효화한다. 기존 toast, pending buy 해결, inventory/weapon 갱신은 유지한다. `ShopDenied`나 구매 요청 자체는 inventory가 바뀐 것으로 간주하지 않는다. 최초 단일 invalidation 메서드 제안은 UI 착수 시 위 typed 경계로 확정했다.

`loadInventory`가 구조적으로 잘못된 row를 필터링하면 착용 row가 사라져 false empty baseline이 될 수 있다. 이를 막기 위한 **선택적 strict 조회 인자** 추가는 허용한다. strict 모드는 잘못된 top-level/필수 row shape를 실패로 처리하고 shop은 unknown을 표시한다. 기본 호출의 기존 가방 동작은 유지한다. optional equipment metadata만 잘못된 row는 기존 parser처럼 row를 보존하고 metadata unknown으로 남긴다. 인자 이름/형태는 UI 담당자가 기존 함수와 일관되게 정하고 tester에 전달한다.

| 상태/사건 | 필수 동작 |
|---|---|
| 장비 listing이 있는 shop open | 현재 장비를 한 번 조회. candidate 절대 수치와 구매 버튼은 바로 표시, baseline은 조회 중 표시 |
| 장비 없는 NPC/shop | 새 inventory 조회 불필요. 기존 퀘스트/대화/약초 구매 유지 |
| 성공한 grant/removal/equipment 변화 | 열린 shop의 기존 baseline을 즉시 unknown으로 만들고 refresh. 닫힌 shop에서는 조회/DOM 변경 없음 |
| 조회 중 변화 | dirty/version을 증가. 오래된 응답은 표시하지 않고, 현재 요청 종료 후 후속 조회 한 번으로 합침. 활성 shop session당 동시 조회 최대 1개 |
| close/다른 NPC open/destroy | generation을 무효화. 늦은 success/error와 파기된 인스턴스 이벤트가 새 panel을 변경하거나 후속 조회를 시작하지 않음 |
| HTTP 실패 | 비교 정보 미확인 표시. 가격/구매/pending nonce 상태 유지. 무한 자동 재시도 없음; 다음 실제 변경 또는 reopen에서 다시 조회 |

동일 session에서 dirty refresh가 다시 변경을 만나면 같은 규칙을 반복한다. snapshot 이후의 live 이벤트를 오래된 HTTP 응답이 덮을 수 없게 한다. UI를 갱신할 때 shop row/구매 button을 다시 만들지 않고 비교 text만 교체해 keyboard focus와 pending 구매 상태를 보존한다.

### 비교 의미

- 현재 catalogue의 weapon/armor/helmet/cloak 보너스만 표시한다. 같은 슬롯의 `equipped:true` inventory row 한 개가 baseline이다. 다른 슬롯의 장비는 더하거나 빼지 않는다.
- 비교 candidate와 baseline의 itemKey가 같고 현재 착용이 확인되면 기존 formatter의 `현재 장착 중` 표현을 쓴다. 보유만 하고 미착용인 같은 상품을 착용 중이라고 표시하지 않는다.
- 조회가 성공했고 해당 슬롯이 확실히 비어 있으면 baseline `null`로 0과 비교한다. 조회 중/실패는 `undefined`; equipped row의 metadata가 없거나 잘못되어 슬롯을 알 수 없거나 같은 슬롯에 둘 이상이면 숫자 비교를 억제한다. Client itemKey→stat/slot 표를 새로 복제하지 않는다.
- 공격력 차이는 장비 보너스의 뺄셈이다. 단검2→사냥꾼 검6은 +4. 피해 감소는 비율 차이에 100을 곱한 **%p**이다. 누비옷15%→강화 갑옷30%는 +15%p. 다른 슬롯과 곱해지는 최종 방어율이나 직업 배율을 적용한 최종 피해량이라고 표현하지 않는다.
- 장비 정보가 있는 후보는 현재 장비 조회 실패와 무관하게 절대 수치를 읽을 수 있다. 구형/잘못된 metadata는 숫자를 추정하지 않는다. ring family는 현재 작업에서 concrete slot으로 선택하지 않는다.
- 좁은 화면과 두 theme에서 이름·가격·구매 버튼·비교 수치를 읽고 조작할 수 있도록 wrapping/scroll을 유지한다. 색만으로 양수/음수를 구분하지 않는다.

## 검증과 gate

- Server: 실제 `shopOffered`/NPC interaction listing이 catalogue helper 및 inventory metadata와 일치하는지 확인한다. 무기2/6/10, 방어구15/20/30%의 값과 0 축, 가격/순서/기존 stat 필드, 약초의 새 equipment key 부재를 검증한다. 새 구매 권한/정산 semantics가 없음을 기존 shop 회귀로 확인한다.
- Browser: 빈 슬롯·현재 단검 대비 검+4·반대 음수·동일 장비·갑옷 %p·다른 슬롯 무시·legacy/malformed metadata·HTTP 실패에서도 구매 유지. 장비 상점 open 조회1회, non-gear NPC 조회0회, live 3종 배선, 조회 중 다중 변경 합치기/옛 snapshot 폐기, close/reopen/다른 NPC/destroy 늦은 응답, focus/pending 구매 유지, 두 theme/작은 viewport를 확인한다.
- Component HTTP/event fixture와 실제 서버 통합 증거는 구분한다. 기존 `shop-ui.spec.ts`, `equipment-comparison.spec.ts` 및 적절한 기존 성장 회귀를 실행한다. 새 비교를 위해 production catalogue/기본 자산/RNG를 바꾸지 않는다.
- Main: 관련 server/browser tests, `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`. 실제 명령·결과·실행하지 못한 항목·남은 제한을 implementation record에 기록한다.

자체 검토: metadata 부재의 false zero, 잘못된 슬롯/중복 착용, 오래된 응답, 이벤트 폭주, close/destroy 후 DOM 오염, 구매 focus/nonce 손실을 계약으로 다룬다. 기존 formatter/HTTP/helper 재사용이 가장 작은 범위이며 DB/권한/자산 mutation 변경은 필요 없다. 사용자 결정이 필요한 열린 항목은 없다.
