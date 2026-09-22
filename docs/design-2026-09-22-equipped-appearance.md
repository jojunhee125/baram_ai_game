# 장착 무기·갑옷 외형 반영 계약

상태: 2026-09-22 설계 확정. 사용자가 제안된 1번 작업인 장착 장비 외형 반영을 승인했다. main 담당자가 fetch 후 `main == origin/main == 28f8d39`, clean 상태를 확인했다. branch/worktree를 만들지 않고 main에서만 반영한다. 이 문서는 설계이며 실제 결과·테스트·Git·배포 상태는 별도 implementation record와 roadmap/decisions에 기록한다.

## Task Plan: 실제 착용 상태를 캐릭터에 표시

- Phase 0 Design → architect: 기존 renderer·동기화·원화를 확인하고 공개 외형키/attachment/lifecycle 계약 확정.
- Phase 1 Implementation → coder(shared/server) | ui-engineer(client). **parallel: yes; file_overlap: 없음.** 아래 두 snapshot 필드 이름은 고정하며 UI typecheck는 shared 변경 후 수행.
- Phase 2 Verification → tester: 실제 server의 hydration·상태 변경·관전자 전달, 실제 Phaser의 장착/이동/공격/종료·두 avatar profile 화면 확인. main은 전체 회귀/typecheck/build.
- Phase 3 Review → 독립 read-only 검토. main은 implementation 기록과 roadmap/decisions, 실제 main commit/push 상태를 정리.

| 담당 | 독점 소유 경로 | 입력·출력/의존성 |
|---|---|---|
| coder | `shared/src/state.ts`, `server/src/rooms/metaverseRoom.ts`; 소유권을 배정받은 server tests | 공개 외형키 두 개를 기존 authoritative cache에서 투영. 모든 room hydration 및 기존 per-slot version 보호 |
| ui-engineer | `client/src/net/roomConnection.ts`, `client/src/world/localPlayer.ts`, `client/src/world/playerSprites.ts`, `client/src/world/avatarArt.ts`, 신규 `client/src/world/equipmentAppearance.ts`, `client/src/scenes/WorldScene.ts`; 필요한 `client/src/world/weaponVisual.ts`/`combatEffects.ts` 최소 정리 | 두 필드를 모든 player renderer로 전달하고 원본 pixel overlays 부착. 오래된 로컬 HTTP/단검 아이콘 중복 경로 제거 |
| tester | main이 배정하는 신규 server appearance test 및 신규 `client/e2e/tests/equipped-appearance.spec.ts` | 기존 `avatar-manifest.spec.ts`의 실제 Phaser.CANVAS harness 재사용 가능. production 직접 수정 없음 |
| architect | 신규 `docs/design-2026-09-22-equipped-appearance.md` | 이 계약만 작성 |
| main | implementation record, `docs/roadmap.md`, `docs/decisions.md`, 필요 assets provenance 설명, Git | 승인·실제 구현·검증·남은 아트/성능 한계 구분 |

파일은 Git root 기준이다. 기존 파일 존재를 확인했고 신규 파일은 위에 명시했다. nested AGENTS 파일은 발견하지 않았으며 주입된 규칙을 다시 읽지 않았다. 다른 담당자의 변경을 되돌리지 않고 테스트 파일 소유권·browser port는 main이 조율한다.

## 확인한 현재 구조와 자산

- `WeaponVisualState`는 로컬 inventory HTTP에서 세 무기를 단검 하나의 boolean으로 합친다. `WorldScene.swing`/`CombatEffects.swing`은 공격 순간 `items.png`의 단검 아이콘만 붙이며 상시 착용/갑옷/원격 장비 표시는 없다.
- `Player` schema는 위치·방향·skin·level·class만 공개한다. 장비는 session의 `equippedItemKeys`에 있고 `EquipmentChanged`는 소유자 세션에게 전달한다. 기존 `subscribeEquipment`는 같은 process/store의 동일 계정 세션에 cache 변경을 알린다.
- `hydrateEquipmentCache`는 지금 `hasMonsters` 방에서만 실행된다. 따라서 장비를 착용하고 plaza/grand-plaza에 재접속한 원격 외형을 위해 모든 room의 hydration이 필요하다.
- `PlayerSprites`는 각 avatar의 sprite/tween/attackTimer를 소유한다. `AvatarArt`는 실제 animation frame마다 display size와 foot origin을 맞춘다. `LocalPlayer.applyServerState`는 이동 확인 도중 여러 early return이 있어 새 외형 필드는 그 전에 적용해야 한다.
- 실제 `assets/sprites/items.png`, `baram-adventurer.png`, `avatar.png`를 열어 확인했다. items는 가방 아이콘이며 착용용 갑옷 layer가 아니다. skin0은 313px composite frame을 48px로 표시하고 frame별 foot이 다르다. legacy avatars는 다른 display size/비례를 쓰므로 skin 번호만으로 48px anchor를 공통 적용하면 안 된다. composite의 머리/몸/장비를 분리한 원화는 없다.
- 기존 assets README는 avatar CC0 원본과 절차적 item icons를 구분한다. 이번에는 기존 원화를 훼손하거나 외부 저작물을 가져오지 않고 새 원본 pixel overlays를 코드로 만든다. 2009–2010 PC pixel 스타일 방향을 따르되 원작 동일 품질·원화 재현 완료를 주장하지 않는다.

## Design Decision: authoritative 공개 외형

Options: 1) owner-only EquipmentChanged를 모든 관전자에게 중계하고 별도 재접속 snapshot을 만든다 — 순서/재진입/권한 전달 경로가 중복된다. 2) 기존 view-tagged Player state에 외형키 두 개를 추가한다 — 이미 구현한 가까운 player snapshot/patch/재진입 경로를 재사용한다.

Decision: **2**. 기존 Player schema 마지막에 다음 필드를 append한다. 필드별 새 view tag를 만들지 않고 `RoomState.players`의 기존 StateView 경계를 그대로 따른다. 공개되는 것은 현재 무기·갑옷 key뿐이며 가방 목록·수량·가격·HP/MP·계정 ID는 추가하지 않는다.

```ts
// Append within existing Player schema, after existing fields.
weaponItemKey: "string",
armorItemKey: "string",

// Additive plain snapshot; optional permits old fixtures/older missing values.
interface PlayerSnapshot {
  weaponItemKey?: string;
  armorItemKey?: string;
  // Existing fields unchanged.
}
```

`onJoin`은 두 schema 필드를 `""`로 초기화한다. `toSnapshot`은 string을 전달하고 누락/잘못된 타입은 `""`로 정규화한다. 빈 문자열·알 수 없는 key는 overlay 없음이다. 클라이언트 요청에서 이 값을 받지 않고 실제 equipped cache에서만 투영한다.

| authoritative 경로 | 필수 처리 |
|---|---|
| store `subscribeEquipment` callback | 기존 cache/version 갱신 직후 현재 두 key를 Player에 투영 |
| `hydrateEquipmentCache` | 모든 room에서 inventoryStore가 있으면 실행. 기존 per-slot version 승인을 통과한 최종 cache를 투영. 오래된 조회가 새 장착/해제를 되돌리지 않음 |
| `settleEquipRequest` | 실제 applied 및 기존 version 검사를 통과한 cache만 투영. 실패/예외/오래된 요청/떠난 세션은 외형 변경 없음 |

server catalogue에서 해당 key가 실제 장비이고 slot family가 weapon/armor와 일치할 때만 공개한다. 불명/slot 불일치는 외형만 `""`로 투영하고 기존 session/combat 데이터를 임의로 고치지 않는다. 투영 helper를 둔다면 기존 room 안의 작은 helper로 한정한다. DB schema/query/정산/장착 권한/전투 수치를 바꾸지 않는다. 모든 room join의 장비 조회 1회는 외형 기능에 필요한 변경이며 grand-plaza 무조회 가정을 검증하던 기존 test는 이 계약으로 수정한다. 500 CCU 성능 검증 완료로 해석하지 않는다.

## Design Decision: 착용용 원화가 없는 상태의 rendering

Options: 1) 24개 avatar와 모든 장비 조합의 새 composite atlas를 제작한다 — 큰 아트 범위와 조합/cache 관리가 필요하다. 2) 제한된 원본 pixel overlays를 별도 sprite로 만들어 실제 avatar transform/frame에 정렬한다 — 기존 atlas를 보존하면서 장비별 silhouette과 재접속 동작을 작은 범위로 구현할 수 있다.

Decision: **2**. 아래 여섯 품목만 상시 착용 외형으로 지원한다. 단순 캐릭터 전체 tint나 몸 옆에 가방 아이콘을 띄우는 방식으로 완료하지 않는다.

| family | 품목 | 구분할 표현 |
|---|---|---|
| weapon | old-dagger, hunting-blade, iron-blade | 짧은 단검/중간 검/긴 철검의 길이·날끝·손잡이·guard 차이 |
| armor | padded-armor, leather-armor, reinforced-armor | 누비 천의 봉제선, 가죽 조끼의 갈색 패널/버클, 강화 갑옷의 테두리/리벳 등 torso 형태와 재질 차이 |

무기/갑옷당 최대 한 overlay sprite, 현재 보이는 player당 최대 두 개로 제한한다. 원본 palette와 pixel mask는 immutable source에 두고 방향/profile별 작은 texture를 scene당 한 번만 만든다. 매 frame canvas 합성, player별 texture, 장비 조합별 무제한 cache를 만들지 않는다. 머리·손·발을 덮는 사각 badge가 아니라 몸에 입은 작은 torso 형태로 그리고 원화의 collar opening/팔 움직임을 고려한다. helmet/cloak/ring 외형과 24종 원화 재제작은 이번 범위에 없다.

실제 renderer는 primary와 legacy fallback 모두 지원한다. profile은 현재 resolved manifest/display size를 기준으로 고르고, 필요 최소한의 방향/frame별 hand/torso anchor를 명시한다. static skin0 좌표를 legacy fallback에 적용하지 않는다. 예상하지 못한 manifest는 보수적으로 처리하며 기존 avatar 자체를 숨기거나 깨뜨리지 않는다.

### Attachment interface와 lifecycle

`AvatarArt`는 private WeakMap의 현재 visual/frame을 읽을 수 있는 작은 accessor를 제공할 수 있다. 캐릭터 animation 선택·frame origin 계산을 두 군데로 복사하지 않는다. 이름은 UI 구현 내에서 일관되게 정하되 반환 의미는 다음과 같다.

```ts
interface AvatarAttachmentFrame {
  manifest: AvatarManifest;
  frame: AvatarFrame;
  action: AvatarAction;
  frameIndex: number;
}
// Read-only accessor on AvatarArt; no sprite mutation.
attachmentFrame(sprite: Phaser.GameObjects.Sprite): AvatarAttachmentFrame | null;
```

새 appearance component는 base sprite와 현재 실제 frame metadata를 받아 장비 keys/facing 변경, local swing, transform 동기화, destroy만 맡는다. PlayerSprites가 component를 소유하고 add/update/remove/shutdown와 연결한다. 매 frame에는 위치/각도/scale/visible/alpha/depth 등 transform만 동기화한다. base의 실제 tween 위치와 frame foot origin을 따른다. 걷기 중 torso/손 anchor와 depth, 위쪽을 볼 때 몸 뒤 무기, 좌우 실루엣을 확인한다. 동일 위치/행의 player가 겹칠 때 다른 player의 overlay가 자신의 몸에 붙어 보이지 않도록 draw ordering도 확인한다.

`LocalPlayer.applyServerState`는 위치 reconciliation에 앞서 weapon/armor 값을 predicted snapshot에 무조건 반영한다. 예측 이동과 외형 truth를 섞지 않는다. 원격 player는 기존 add/change/remove를 그대로 사용한다. 장비만 바뀐 patch에서도 overlay를 즉시 갱신하고, 방향/skin/frame/warp 변경과 공격 중 교체·해제에도 이전 layer가 남지 않는다.

local 공격은 기본 avatar에 실제 attack clip이 있으면 그 clip을 따르고, idle fallback이어도 짧은 weapon swing pose(약180ms)를 제공한다. 무기 pose가 base 이동 tween의 x/y를 덮어쓰지 않게 한다. `CombatEffects`의 기존 타격 arc/피드백은 유지하되 old-dagger icon을 중복으로 찍는 경로와 `WeaponVisualState`의 로컬 HTTP truth를 제거/대체한다. 더 이상 쓰지 않는 export/load/import만 범위 안에서 정리한다.

새 remote attack protocol은 만들지 않는다. 원격 장비는 idle/walk/방향/기존 실제 avatar action을 따르며 기존 hit/skill 표시를 보존한다. `MonsterHit`에는 일반 공격과 skill 피해가 섞이므로 이 메시지만으로 원격 무기 swing을 추론하지 않는다. 현재 서버가 broadcast하지 않는 원격 빈 공격 animation은 이번에도 제공하지 않는 한계로 명시한다.

remove/view 이탈/scene shutdown에서는 overlay sprite, appearance timer/tween, listener를 모두 정리한다. 장비 교체 중 사용하던 pose도 새 key/빈 key에 안전하게 수렴한다. 오래된 controller가 재사용된 scene/sprite를 변경하지 못하게 한다. 실패한 장착 응답이나 구매/획득만으로 외형을 낙관적으로 바꾸지 않는다.

## Verification과 자체 검토

- Server: 빈 초기값; social/hunt/grand-plaza 재접속 hydrate; 성공한 장착/교체/해제; failed/exception/late response; per-slot 경합; 같은 계정 다른 session subscription; remote observer 및 view 이탈 후 재진입 snapshot. 알 수 없는/mismatched key는 외형만 숨김, 보유만 한 장비는 표시 안 함. private inventory/HP/MP를 공개하지 않는 기존 경계 유지.
- Client: primary skin0과 실제 legacy profile, 네 방향 idle/walk, 세 무기와 세 갑옷의 구별, 두 player의 독립 장비, pending movement 중 외형 patch, 막힌 이동 방향·warp·skin/fallback 변경, local attack 도중 장비 교체/해제, view remove/re-add/shutdown 후 유령 sprite/timer 없음. 실제 Phaser.CANVAS fixture 및 확대 screenshot으로 anchor/손·머리 가림/두께/겹침을 확인한다.
- 실제 서버 observer/reconnect 테스트와 component 주입 fixture를 구분한다. 새 기본 자산·RNG·상점 가격을 바꿔 테스트를 쉽게 만들지 않는다. 기존 avatar manifest/weapon/combat/movement/equipment/sale 경합 회귀를 유지한다.
- main은 관련 tests/browser 결과와 `npm run typecheck`, `npm test`, `npm run build`, `git diff --check` 결과를 implementation 기록에 저장한다. 실행하지 못한 검사는 이유를 기록한다. 운영 배포·사용자 아트 승인·장시간 플레이·500 CCU는 자동 완료하지 않는다.

자체 검토: 두 공개 key와 기존 state view는 필요한 최소 계약이며 per-slot race guard를 유지한다. composite 원화의 한계는 두 실제 profile의 attachment 확인으로 제한한다. local prediction early return, all-room hydration, 중복 아이콘, stale controller, 알 수 없는 key, remote skill 오인까지 실패 모드를 반영했다. 새 user 결정이 필요한 열린 항목은 없다.
