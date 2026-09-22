# 가방의 같은 슬롯 장비 비교 계약

상태: 2026-09-22 구현 승인에 따른 설계. 앞선 세 작업은 `ac70d3f`로 main에 반영되었으며, 사용자의 다음 코드 작업 한 건 지시에 따라 roadmap의 장비 교체 전 비교 공백을 구현한다. main 담당자가 fetch 후 `main == origin/main == ac70d3f`, clean 상태를 확인했다. 추가 branch·승인 절차 없이 진행한다. 이 문서는 구현/검증/배포 완료 기록이 아니다.

## Task Plan: 장비 metadata와 가방 비교

- Phase 0 Design → architect: 현재 inventory API, 구매/전리품 ItemGranted, 장비 변경 알림과 catalogue 확인; 이 계약 확정.
- Phase 1 Implementation → coder(server/shared metadata) | ui-engineer(client 가방 비교). **parallel: yes; file_overlap: 없음**. 새 shared type 반영 전 UI typecheck만 기다릴 수 있다.
- Phase 2 Verification → tester: API/실시간 획득 metadata 일치, 비교값·장착/해제·판매·재접속·구형 응답·늦은 응답 regression. main: 전체 typecheck/test/build.
- Phase 3 Review → read-only reviewer 또는 별도 context 검토; main이 implementation 기록과 roadmap/decisions를 정리하고 main에서 commit/push.

Git root `code/` 기준으로 기존 파일의 존재를 확인했다. 신규 파일은 아래에서 따로 표시한다. 다른 작업자의 변경을 되돌리지 않는다.

| 담당 | 독점 소유 경로 | 출력·의존성 |
|---|---|---|
| coder | `shared/src/protocol.ts`, `server/src/rooms/itemDefinitions.ts`, `server/src/http/routes.ts`, `server/src/rooms/metaverseRoom.ts`; 관련 `server/src/http/routes.inventory.test.ts`, `server/src/rooms/shopSystem.test.ts` 및 필요한 신규 server metadata test | 아래 optional metadata 정의 및 세 전송 지점의 일치. 기존 mutation/정산 의미 보존 |
| ui-engineer | `client/src/net/inventory.ts`, `client/src/ui/inventoryPanel.ts`, 필요한 신규 비교 helper, `client/src/style.css`/`heritage.css` | 가방 내부 같은 슬롯 비교와 live 갱신. shared contract 의존 |
| tester | main이 배정하는 신규 client E2E spec 및 별도 신규 test 파일 | 구현 파일을 직접 수정하지 않고 수치/동시 갱신/호환성 검증 |
| architect | 신규 `docs/design-2026-09-22-equipment-comparison.md` | 이 계약만 작성 |
| main | implementation record, `docs/roadmap.md`, `docs/decisions.md`, Git | 실제 구현·검증·배포 상태 구분 |

## Design Decision: 서버 metadata

Options: 1) client에 itemKey별 능력치를 복사 — 변경 파일은 적지만 배포 시 catalogue와 수치가 달라지고 새 장비가 누락된다. 2) 기존 API와 ItemGranted에 optional 장비 metadata를 추가 — server catalogue를 그대로 쓰며 현재 응답/요청 형식을 보존한다.

Decision: **2**. 실제 catalogue가 사용하는 공격력 보너스와 피해 감소만 전달한다. `maxHp` 장비, 새 장비/슬롯 기능, 최종 전투력 계산, shop 구매 전 비교는 이번 범위가 아니다.

Interface: `shared/src/protocol.ts`에 아래 타입을 export하고 `ItemGranted`에 optional `equipment`를 추가한다. 기존 `shared/src/index.ts`는 protocol을 이미 wildcard export하므로 수정 불필요다.

```ts
export interface EquipmentMetadata {
  slot: Exclude<EquipmentSlot, "ring1" | "ring2"> | "ring";
  attackDamage: number;
  damageReduction: number;
}

// Additive member of existing ItemGranted and client InventoryItem / HTTP item view.
equipment?: EquipmentMetadata;
```

`slot`은 기존 server `EquipmentSlotFamily`와 같은 구조이며 실제 착용 위치가 아닌 장비 family다. 현재 catalogue의 weapon/armor/helmet/cloak만 비교한다. ring family 정의를 전달할 수 있다는 것만으로 ring1/ring2 비교·장착 기능을 추가하지 않는다.

두 수치는 metadata 객체 안에서 필수다. `definition.equipment.stats.attackDamage ?? 0`, `damageReduction ?? 0`으로 정규화하며 `0`은 해당 장비의 그 보너스가 실제로 없다는 뜻이다. `equipment` 부재는 장비 정보가 제공되지 않은 상태이므로 0으로 간주하지 않는다. 일반 전리품에는 metadata를 생략한다. 기존 `damageReductionRatio`, `sellValue`, `consumable`, `equipped` 및 모든 필수 필드는 유지한다.

같은 변환을 세 번 복사하지 않도록 기존 `server/src/rooms/itemDefinitions.ts`에 다음 순수 helper를 두고 아래 경로에서 함께 사용한다. 별도 catalogue, DB column, API endpoint, generic serializer framework는 만들지 않는다.

```ts
export function equipmentMetadata(
  definition: ItemDefinition,
): EquipmentMetadata | undefined;
```

| 전송 지점 | 현재 동작·필수 변경 |
|---|---|
| `server/src/http/routes.ts`의 `presentInventory` | DB 수량/장착 여부를 catalogue와 결합하는 기존 응답에 metadata 추가 |
| `MetaverseRoom` 구매 성공의 `ItemGranted` | 실제 settlement 성공 뒤 보내는 기존 event에 같은 metadata 추가 |
| `MetaverseRoom.awardLoot`의 `ItemGranted` | 실제 drop grant 성공 뒤 보내는 기존 event에 같은 metadata 추가. 새 가방 row와 기존 stack 양쪽 처리 |

`EquipmentChanged {slot,itemKey,applied}`는 변경하지 않는다. 이 알림은 현재 착용 itemKey만 바꾸며 장비 수치 자체는 변하지 않는다. DB store/장비 cache/정산 lock/성공 판정/알림 순서도 변경하지 않는다.

## Design Decision: 비교 의미와 갱신

Options: 1) 매번 server에서 최종 공격력/종합 방어율 preview를 계산 — 직업 배율, 반올림, 다른 슬롯, 임시 skill까지 포함하는 새 API가 필요하다. 2) 가방에서 같은 슬롯 장비의 catalogue 보너스만 비교 — 교체 판단에 필요한 차이를 현재 metadata만으로 정확하게 표시한다.

Decision: **2**. 가방 안의 장비 row에 현재 장비 이름과 후보 장비 보너스/차이를 표시한다. 추가 modal·자동장착·새 필터는 만들지 않는다. 모바일/좁은 화면에서 기존 장착·판매 버튼을 가리지 않는다.

- 공격력은 `장비 공격력 +N`, 차이는 후보 attackDamage − 현재 attackDamage. 단검2 → 사냥꾼 검6은 `+4`다. 직업 배율을 적용한 최종 피해 증가라고 표현하지 않는다.
- 피해 감소는 해당 장비 자체의 비율이다. 누비옷15% → 강화 가죽갑옷30%는 `+15%p`다. helmet/cloak 등 다른 슬롯과의 곱연산 최종 피해 감소율 차이라고 표현하지 않는다.
- 같은 슬롯의 장비가 비어 있음이 확인되면 `미장착`을 기준으로 0과 비교한다. 다른 슬롯 장비를 비교 대상으로 선택하지 않는다. 같은 장비가 장착 중이면 그 상태를 표시한다.
- 확인된 metadata가 없거나 유효하지 않으면 수치 비교를 생략하고 정보 부족 상태를 표현한다. 구형 응답을 받아도 row·수량·기존 장착/판매 동작은 유지한다. 기존 itemKey→slot fallback은 호환성을 위해 유지할 수 있지만 stat을 hardcode하지 않는다.
- 새 parser는 optional metadata의 object shape, 허용 slot, finite한 비음수 attackDamage, `0 <= damageReduction <= 1`을 검사한다. 손상된 optional metadata 때문에 정상 inventory row 전체를 버리지는 않는다.

### Live 갱신·응답 경합 계약

서버 metadata가 이미 있는 row는 비교 표시만 다시 계산하며 매 클릭마다 HTTP를 호출하지 않는다. 현재 `ItemGranted`는 장착 상태를 포함하지 않으므로 기존 stack을 갱신할 때 이미 확인된 equipped 상태를 유지한다.

| 사건 | 필수 결과 |
|---|---|
| 가방 snapshot 로드/재접속 | 전체 row metadata와 장착 상태로 비교 재계산 |
| 구매/전리품 `ItemGranted` | 새 row·기존 stack 모두 metadata 보관, 열린 가방 비교 즉시 갱신 |
| 성공한 `EquipmentChanged` | 해당 슬롯의 기존 착용 표시를 지우고 새 itemKey를 반영, 모든 같은 슬롯 후보 비교 갱신 |
| 성공한 해제 | 해당 슬롯 기준을 미장착으로 바꿔 후보 비교 갱신 |
| 판매/소비 `ItemRemoved` | total 반영/row 삭제 후 비교 재계산. 같은 key의 metadata를 다른 item에 남기지 않음 |
| 알려지지 않은 착용 key 알림 | 기준을 정보 부족으로 표시하고 필요한 inventory refresh를 합친다. 기준값0으로 거짓 비교하지 않음 |

HTTP snapshot이 진행 중일 때 grant/equipment/removal이 먼저 도착하면, 늦은 snapshot이 새 상태를 덮어쓰지 못하도록 generation/version을 검사하고 필요 시 한 번 더 읽는다. 닫힌 가방·destroy된 panel에서는 새 DOM 갱신을 하지 않고 다음 open 시 snapshot으로 복구한다. 연속 알림마다 무제한 HTTP를 발생시키지 않는다. `applied:false`는 기존 거절/정리 처리를 유지하며 요청 click만으로 비교 기준을 낙관 변경하지 않는다.

## 검증과 자체 검토

- API: weapon 공격력2/6/10, armor 감소15/20/30%, helmet15%, cloak10%가 catalogue와 일치; 비장비 metadata 부재; 구형 필드 보존. 구매와 실제 drop event metadata가 같은 API row와 일치.
- UI: 빈 슬롯, 같은 슬롯 교체의 양수/음수/0 차이, 서로 다른 슬롯, 기존 장비/신규 stack, 장착/해제/판매/재접속, malformed/구형 metadata, HTTP 중간 live event 후 늦은 응답을 검증한다. 피해 감소 차이는 %p로 확인한다.
- 테스트에서는 component fixture와 실제 server 통합 증거를 구분한다. 기존 무주입 성장 E2E와 일반 shop/inventory regression을 유지한다. 장비 비교 검증을 위해 RNG/production catalogue/계정 기본 자산을 변경하지 않는다.
- `npm run typecheck`, 관련 server tests, 관련 browser E2E, `npm test`, `npm run build`, `git diff --check` 결과를 implementation record에 남긴다. 실행하지 않은 검사는 이유를 명시한다.
- 실패 모드 검토: client 수치 복사, unknown을0으로 처리, 다른 슬롯끼리 비교, 피해 감소 합산 오해, 기존 stack 장착 상태 손실, 장착 변경 뒤 비교 stale, live event를 HTTP가 덮어씀, 구형 client/server 호환성 손상은 위 계약으로 제한한다. 새 권한·정산·전투 동작은 도입하지 않는다.
