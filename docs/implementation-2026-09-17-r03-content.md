# R03 잔여 콘텐츠 — 상점 NPC·귀환 안내 (2026-09-17)

**승인**: `docs/decisions.md` "2026-09-17 — R03 잔여 코드작업 일괄 승인" (1항·2항). 3항(Postgres 동시성 검증)은 별도 기록(`docs/verification-2026-09-17-postgres-quest.md`)으로 분리.

## 목적

로드맵 R03(`docs/roadmap.md` §5)의 "남은 것" 중 코드로 가능한 두 항목을 자리표시로 채운다.

1. plaza에 상점 NPC — 회복 소모품·기본 장비를 예고하되, 화폐·구매 경로는 R04 정산 전까지 열지 않는다.
2. hunting-ground → plaza 귀환 동선의 실제 안내 — 포털·랜드마크·홈워프는 이미 존재하므로 표지판(NPC)만 추가한다.

## 변경 사항

### `server/src/rooms/interactableDefinitions.ts`

두 행을 `INTERACTABLE_DEFINITIONS`에 추가했다. 프로토콜(`InteractableEntered` 등)·클라이언트 변경 없음 — 기존 링크판/공지판/퀴즈대/안내 NPC와 같은 자리표시 관례.

- `plaza-shop-npc` (`Npc`, `plaza`, `{47,25}`): 화폐·구매 필드 없음. 본문은 "회복 소모품과 기본 장비를 준비 중입니다. 구매는 아직 열리지 않았습니다."
- `hunting-ground-return-npc` (`Npc`, `hunting-ground`, `{39,29}`): 본문은 "남쪽 문을 나가면 마을 광장입니다."

`plaza-shop-npc`는 `blocksMovement`를 생략(기본값 `true`)한다 — 아래 좌표 근거에서 보듯 통행로가 아니라 남동쪽 막다른 모서리이므로 실제 동선을 막지 않는다.

`hunting-ground-return-npc`는 **`blocksMovement: false`** 다(검토 중 수정, 2026-09-17). 곁가지 자리라는 점만 보면 `true`로 둬도 동선은 막히지 않지만, 이 행은 **몬스터가 있는 방에 놓인 첫 오브젝트**다. 쫓기는 중에 밟으면 패널이 뜬 동안 맞으면서 못 움직인다 — 같은 방에서 가방·확률표가 이동을 잠그지 않는 이유(`docs/design-hunting-inventory.md` §3.4)가 그대로 적용된다. 읽고 닫기만 하는 행이라 걸어서 지나가도 잃는 상태가 없다(`docs/design-npc-movement-block-fix.md`).

## 좌표와 통행 가능성 근거

boot의 `validateInteractableDefinitions`가 타일 통행 가능 여부·포탈/오브젝트 겹침을 검증하지만(실제로 `npm test` boot 스위트가 통과했다 — 아래 검증 참조), 그와 별개로 **서버의 실제 디코드 로직**(`server/src/game/tiledMap.ts`의 flip-mask → tileId → `collides` 프로퍼티 조회)을 그대로 재현하는 스크립트로 두 좌표를 직접 대조했다.

```
plaza (47,25) walkable: true
hunting-ground (39,29) walkable: true
```

(기존 오브젝트·포탈 타일도 같은 스크립트로 재확인 — 전부 `true`, 회귀 없음. 스크립트는 검증용 1회성이라 커밋 대상에 없다.)

- **`plaza-shop-npc` (47,25)**: plaza interior는 x16–47, y8–25(`assets/README.md`). x=47은 마지막 열, y=25는 마지막 행 — 남·동 양쪽이 테두리 밴드인 막다른 모서리로, `plaza-quiz-stand`의 북동쪽 모서리(47,8)와 대칭이다. `tools/generate-plaza.mjs`의 `GROUND_ROWS`/`COLLISION_ROWS`를 좌표로 환산(`row = y-8`, `col = x-16`)해도 이 칸은 평범한 stoneFloor이고 `COLLISION_ROWS` 어떤 소품 행에도 걸리지 않는다. 남문 트리거(31,25)/(32,25)·도착(31,24), 북문 트리거(31,8)/(32,8)·도착(31,9), 그리고 기존 오브젝트 4개(17,23 / 44,23 / 45,23 / 47,8 / 30,8) 전부와 겹치지 않는다. spawn 행(y=20, x16–47)·열(x=16)·남문까지의 열(x=31)도 피했다 — `metaverseRoom.integration.test.ts`가 그 구간을 걷는다.
- **`hunting-ground-return-npc` (39,29)**: `tools/generate-hunting-ground.mjs`의 `GROUND_ROWS`/`COLLISION_ROWS`를 같은 방식으로 환산하면 y=29(row21)는 `COLLISION_ROWS`가 전 구간 공백(전부 통행 가능)이고, x=39는 grass(통행 가능 ground). 남문 트레일(x=35–36)의 동쪽 2칸 옆으로, 도착 타일(35,30)·남문 트리거(35,31)/(36,31)·북문 트리거(35,8)/(36,8)·북문 도착(35,9) 어느 것과도 겹치지 않는다. room의 join-spawn 산개 범위(x33–37, y25–29, `server/src/rooms/definitions.ts`)와 모든 몬스터의 spawn+wander 박스(`server/src/rooms/monsterDefinitions.ts`; 가장 가까운 `hg-squirrel-04`(41,24) wander 2 → y22–26)를 모두 벗어난다.

### e2e 회귀 하자드 확인

`pass-f-qol.spec.ts`(스폰 근처 무반응 테스트)와 `pass-g-tester-verification.spec.ts`(사냥터↔plaza 왕복)가 hunting-ground에서 x=35–36 열을 남북으로, 도착(35,30)→트리거(35,31) 구간을 걷는다 — 두 스펙 모두 `39,29`를 지나지 않는다(실행 결과는 아래 검증 참조). plaza 쪽은 `metaverseRoom.integration.test.ts`가 걷는 행/열(위 근거)과 겹치지 않는다.

## 하지 않은 것 (의도적)

- 상점 NPC에 화폐·가격·구매 메시지·인벤토리 지급 경로를 추가하지 않았다 — R04 정산 설계 전까지 비활성 규칙 그대로.
- 귀환 안내는 표지판(NPC)만 추가했다 — 포털·랜드마크 텔레포트·H 홈워프는 이미 존재하므로 새 이동 수단을 만들지 않았다.
- 맵 파일(`assets/maps/*.json`)·프로토콜(`InteractableEntered` 등)·클라이언트 코드는 건드리지 않았다 — 자리표시 콘텐츠는 서버 테이블만으로 완결된다.

## 파일 변경 목록

- `server/src/rooms/interactableDefinitions.ts` — 두 행 추가.
- `server/src/rooms/metaverseRoom.interactables.test.ts` — `SHOP_NPC`/`RETURN_NPC` 상수 추가, hunting-ground용 `CollisionMap`·`walkTo`/`pathTo`/`detours`의 room 매개변수화, 마커 발행·패널 내용(화폐 필드 부재 포함) 테스트 4건 추가.
- `assets/README.md` — plaza 오브젝트 표에 상점 NPC 행 추가, hunting-ground용 "고정 오브젝트 타일" 절 신설.
- `docs/roadmap.md` §5 R03 — 구현 완료 줄 추가, "남은 것"에서 두 항목 제거.
- `docs/implementation-2026-09-17-r03-content.md` — 본 기록.

## 검증

- `npm run typecheck` (repo root, 3 workspace 전부): 통과, 에러 0.
- `npm test --workspace=@zep-test/server`: **976 pass / 0 fail** (신규 4건 포함, 회귀 없음).
- `client/e2e`에서 `npx playwright test npc-movement-block-fix.spec.ts pass-g-tester-verification.spec.ts`: **7 passed** (46.8s) — 두 스펙 모두 새 타일과 무관하게 통과.
- 전체 `client/e2e` 스위트: 호출자가 이 변경까지 포함해 단독 실행 — **93/93 통과** (9.9분, 13 spec). 이 실행 직전에 서버 테스트와 동시에 돌린 회차가 있었는데, e2e의 webServer(2567)와 서버 부팅 테스트가 포트를 다퉈 3건이 실패했다. 코드 결함이 아니라 실행 방식 문제이므로 잔여 프로세스를 정리하고 단독으로 재실행했다.
- 실제 Postgres 동시성 확인(WSL Docker)은 이 기록의 범위 밖 — `docs/verification-2026-09-17-postgres-quest.md`(별도 작업)에서 다룬다.

## 남은 한계

- 상점 NPC·귀환 NPC 둘 다 브라우저에서 눈으로 확인한 스크린샷 검증은 하지 않았다(서버 테이블·e2e 회귀만 확인). 시각 확인이 필요하면 별도로 요청.
- 두 NPC 모두 `avatarSkin`만 지정했고 실제 대사 연출(감정 표현 등)은 없다 — 기존 안내 NPC와 동일한 수준의 자리표시다.
