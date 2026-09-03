# assets — Ninja Adventure 기반 리스킨 아트

Phase1.5 리스킨 적용본. 절차적 placeholder가 아니라 **[Ninja Adventure Asset Pack](https://github.com/pixel-boy/NinjaAdventure)**(제작자 pixel-boy, **CC0** — 귀속 불필요, 상업 이용 가능)의 원본 픽셀 아트를 잘라 만든 실제 에셋이다. 파일 규약(치수·행 배치·`collides` 규약)만 지키면 여전히 통째로 리스킨 가능하다.

`code/client`(Phaser 렌더)와 `code/server`(collision 검증)가 **같은 `plaza.json`을 읽는다.** 그래서 `assets/`는 `client/public/`이 아니라 `client/`·`server/`의 형제 위치에 있고, Vite는 `publicDir`로 이 폴더를 그대로 서빙한다.

## 재생성

### 타일셋 + 맵 (Ninja Adventure 기반 리스킨)

```
node tools/import-ninja-assets.mjs <ninja-adventure-repo-root>      # cwd = code/
NINJA_ASSET_ROOT=<ninja-adventure-repo-root> node tools/import-ninja-assets.mjs
```

소스 저장소 위치는 인자 또는 `NINJA_ASSET_ROOT` 로 넘긴다 — 스크립트에 하드코딩된 경로는 없다. 결정적(deterministic) 생성이라 같은 소스면 같은 PNG가 나온다.

**`maps/plaza.json`·`maps/grand-plaza.json`은 이 파이프라인에서 절대 바뀌지 않는다** — 두 맵을 각각 읽어 타일셋에 대해 그것이 거는 전제(tile 크기, `firstgid`, `columns`/`tilecount`, 이미지 치수, `collides` 타일 개수, 레이어 gid 범위)를 전부 재검증한 뒤 **원본 바이트를 그대로 다시 쓴다.** 리스킨이 그 전제 중 하나를 깨면 조용히 통과하지 않고 그 자리에서 실패한다.

> 타일셋을 공유하는 맵을 새로 추가하면 `import-ninja-assets.mjs`의 `MAP_FILES` 에도 넣을 것. 빠뜨리면 그 맵만 검증 없이 남아 다음 리스킨 때 조용히 깨진다.

> **`tools/generate-assets.mjs` 는 Phase1 절차적 placeholder 전용 스크립트로 축소됨.** 실행하면 `tilesets/plaza-tiles.png` 와 `sprites/avatar.png` 가 placeholder로 되돌아간다. 더 이상 `maps/plaza.json`을 재생성하지 않음 — plaza 맵은 이제 `tools/generate-plaza.mjs`(신규, 비파괴)가 전담하고, `generate-assets.mjs`는 placeholder 아트 생성 전용으로 축소됐다. 맵은 더 이상 안 건드리지만 아트 2장(타일셋/아바타)은 여전히 파괴적으로 되돌리므로, 실행 후 `import-ninja-assets.mjs`와 `import-avatar.mjs`를 다시 돌려야 한다.

### 아바타 (Tiny Characters Set 기반 리스킨)

```
node tools/import-avatar.mjs                                        # cwd = code/
```

Tiny Characters Set(Fleurman, CC0) 소스로부터 24스킨×4방향×3프레임 아바타 시트를 재생성한다. 소스 시트의 6 x 4 캐릭터 블록을 하나도 빠짐없이 굽는다 — 스킨↔블록 매핑은 스크립트 내부 `SKINS` 테이블에 고정. 결정적 생성이라 같은 소스면 항상 같은 PNG가 나온다.

> `SKINS` 행 수와 shared `AVATAR_SKIN_COUNT`가 다르면 임포터가 그 자리에서 실패한다(`assertSkinCountMatchesShared`). **둘은 반드시 한 번에 같이 바꿀 것** — 상수만 올리면 서버가 존재하지 않는 행의 스킨을 나눠주고 Phaser가 빈 프레임을 그린다.

### 몬스터 + 아이템 아이콘 (절차적 생성)

```
node tools/generate-monster-art.mjs                                 # cwd = code/
```

`sprites/monster.png`과 `sprites/items.png`를 한 번에 굽는다. 다른 두 시트와 달리 **소스 팩이 없다** — 리포의 CC0 아트는 남는 게 없고(아바타 24블록 전량 소진, 타일셋 잔여 2종은 프레임·방향 개념 없음) 사내망에서 itch.io·opengameart가 차단이라 신규 다운로드를 전제할 수 없다. 그래서 `generate-assets.mjs`가 아바타 placeholder를 굽는 것과 **같은 기법**(ASCII 행 배열 → 16px 네이티브 셀 → 2배 확대)으로 절차 생성한다. 근거는 `docs/design-hunting-inventory.md` 부록 D-1.

난수·타임스탬프가 없어 같은 소스면 같은 바이트가 나온다. **디스크에 쓰기 전 메모리에서 검증을 전부 통과해야 첫 바이트를 쓴다**(다른 생성기와 같은 규율): 두 시트 치수 / 전 프레임 비어 있지 않음 / 종별 3개 보행 열이 서로 다름 / 종별 4방향 행이 서로 다름 / 아이템 5종이 서로 다름 / 클라이언트 `MONSTER_SPRITE_ORDER`·`ITEM_ICON_ORDER`와 생성기 테이블 일치.

> 마지막 항목은 `import-avatar.mjs`의 `assertSkinCountMatchesShared`와 같은 이유다. 클라이언트 배열이 정본이고(그게 Phaser가 시트를 인덱싱하는 값이다) 생성기가 거기에 맞춘다 — 어긋나면 다람쥐가 토끼 프레임을 그리는데 런타임은 아무 오류도 내지 않는다.

**아트 품질은 자리표시 수준이다**(설계 부록 D-5). 사내망이 풀리거나 CC0 몬스터 팩을 확보하면 아래 프레임 배치 규약만 지켜 통째로 교체하면 되고, 서버·프로토콜은 영향을 받지 않는다.

### plaza 맵 (비파괴, 손 배치 + 절차적 테두리)

```
node tools/generate-plaza.mjs                                        # cwd = code/
```

plaza 내부 walkable(32×18)을 손으로 배치하고 테두리 밴드(1,664칸)를 절차적으로 채운다(성벽→마을→정원→숲→해변→물 6층). 결정적 생성(난수 없음)이고, 검증 9종(통행 가능 칸 수 일치/gid↔collides 일치/spawn 도달성/테두리 무침반/통로 21칸 이상/**경계 링 불투명** 등)을 디스크 쓰기 전에 메모리에서 전부 확인 후 하나라도 어긋나면 아무것도 쓰지 않고 exit 1.

성벽 링은 `BOUNDARY_RING_DEPTH` = **2타일 두께**다(1타일이 아니다). 아래 "경계 링 불투명 규칙" 참고.

### hunting-ground 맵 (비파괴, 손 배치 + 절차적 테두리)

```
node tools/generate-hunting-ground.mjs                                  # cwd = code/
```

`generate-plaza.mjs`와 같은 구조다 — 내부 walkable(40×24)은 손으로 배치하고 테두리 밴드는 절차적(성벽 2링 → 숲 → 해변 → 물 4층). 난수 없음. 타일셋 블록은 `plaza.json`에서 읽어 그대로 복사하므로 리스킨을 자동으로 따라간다. **디스크에 쓰기 전 메모리에서 검증 8종을 전부 확인하고 하나라도 어긋나면 아무것도 쓰지 않고 exit 1**: 통행 가능 칸 수 일치 / gid↔`collides` 일치 / spawn 통행 가능 / spawn flood fill 도달(고립 0) / 테두리 밴드 내 통행 가능 0칸 / 경계 링 불투명 / **폭 1칸 통로 0칸** / 포탈 트리거·도착 타일 통행 가능 + 트리거가 문 그림(나무 바닥) 위.

**폭 1칸 통로 금지는 스타일이 아니라 제약이다.** 몬스터가 그리디 스텝으로 이동하므로(로드맵 항목7 §7) 폭 1칸 막다른 길에 들어가면 영원히 진동한다. 검증 구현은 "모든 통행 가능 칸은 완전 통행 가능한 2×2 블록에 최소 하나 속한다".

### hunting-den 맵 (비파괴, 손 배치 + 절차적 테두리)

```
node tools/generate-hunting-den.mjs                                     # cwd = code/
```

`generate-hunting-ground.mjs`와 완전히 같은 구조·검증(8종 + 자기 남문 문턱 검증)이다(Phase E, `docs/design-phase-e-second-hunting-ground.md` §3.2). 내부 walkable(32×20)은 손으로 배치하고 테두리 밴드는 절차적(성벽 2링 → 숲 → 해변 → 물 4층). 난수 없음. 타일셋 블록은 `plaza.json`에서 읽어 그대로 복사한다.

hunting-ground와의 유일한 구조적 차이: 문이 남문 하나뿐이다 — 이 방은 hunting-ground의 오솔길 북쪽 끝(북문)에서만 들어올 수 있고, 그 남문이 들어올 때의 도착 지점(hunting-ground-north-door)과 나갈 때의 트리거(hunting-den-south-door)를 동시에 겸한다.

### grand-plaza 맵 (재생성, 크기/좌표 재설정)

```
node tools/generate-load-map.mjs                                        # cwd = code/
node tools/generate-load-map.mjs --width 92 --height 147 --out assets/maps/half.json
```

grand-plaza를 맵 크기 172×147, 내부 140×130(BORDER {16,16,8,9})로 재생성한다(기존 160×145 구형 제거). 테두리 밴드는 **벽돌 벽 2겹 + 그 바깥 전부 물**이다(구 버전의 잔디 밴드 아님 — 위 "경계 링 불투명 규칙"). 난수를 쓰지 않고 좌표 함수만으로 만들어 **같은 인자면 항상 같은 바이트**가 나온다. `--width`/`--height`는 `docs/poc2-design.md` 밀도 고정 측정용 축소판을 뽑기 위한 것. 내부 치수가 10의 배수가 아니면 거부.

## maps/plaza.json

- Tiled JSON format `1.10`, orthogonal, renderorder `right-down`, `infinite: false`
- **64 x 35 tiles**, tile size **32 x 32 px** (= shared `TILE_SIZE_PX`). 내부 walkable 영역은 **32 x 18**(x16–47, y8–25)로 뷰포트 16:9 확대에 대응. 테두리 밴드(좌우 16열, 상 8행, 하 9행)는 통행 불가 장식 레이어.
- tileset은 **embedded**(인라인). Phaser tilemap loader가 external tileset(`source` 참조)을 해석하지 못하므로 의도적으로 map 안에 넣었다. 서버 입장에서도 파일 1개만 읽으면 된다.

레이어는 2개이며 배열 순서가 곧 렌더 순서다.

| name | type | 역할 |
|---|---|---|
| `ground` | tilelayer | 바닥. 그 자체로는 통행 판정에 관여하지 않는다 |
| `collision` | tilelayer | 벽·장애물. **화면에 보이는 레이어** — `ground` 위에 그린다 |

통행 판정 규약 (decisions.md #2 타일 그리드 충돌):

**정본 규칙: tileset tile property `collides: true` 가 붙은 타일만 통행 불가.** 서버·클라이언트 양쪽 다 이 규칙을 구현한다.

- 클라이언트(Phaser): `layer.setCollisionByProperty({ collides: true })`
- 서버 `MapLoader`: `collision` 레이어의 raw gid를 아래 4단계로 디코드한다.

```
1. flip 비트 마스킹            gid = raw & 0x1FFFFFFF     // 반드시 먼저
                               // Tiled flip 3종(H/V/대각)을 clear. orthogonal 맵에서 켜질 수 있는 건 이 3개뿐
2. local tile id 계산          id  = gid - tileset.firstgid
3. tileset.tiles[] 에서 id 매칭
4. properties[] 에서 collides === true 인지 확인
   gid 0 이거나 매칭 실패 → 통행 가능 / 맵 밖 좌표 → blocked
```

**1번(flip bit 마스킹)을 빼먹지 말 것.** 지금 맵은 flip을 쓰지 않지만, 나중에 Tiled에서 타일 하나만 뒤집어도 raw gid 상위 비트가 켜져서 `gid - firstgid` 가 엉뚱한 id를 만들고 → property 매칭 실패 → **벽이 통과 가능해진다.** 조용히 터지는 종류의 버그다.

> 참고(규칙 아님): 현재 `grand-plaza.json`은 `collision` 레이어의 gid ≠ 0 인 칸과 `collides: true` 인 칸이 정확히 일치한다(1,701칸). 다만 이건 이 파일이 애초에 그렇게 배치돼 고정(`import-ninja-assets.mjs`도 이 파일을 재검증 후 원본 그대로 재출력할 뿐 손대지 않는다)됐기 때문에 생기는 *현재 사실*일 뿐, 파일 포맷이 보장하는 성질이 아니다. Tiled에서 맵을 직접 편집하면서 장식용으로 통행 가능 타일(id 0-7)을 `collision` 레이어에 올리는 순간 둘은 갈라진다. **어느 쪽도 `gid !== 0` 로 구현하지 말 것** — 한쪽만 그렇게 구현하면 서버는 통과시키는데 클라이언트는 막는(또는 그 반대) 조용한 desync가 된다.

- 타일을 추가할 때 tileset의 **"0행 통행 가능 / 1행 통행 불가"** 행 분리를 지키면 `collides` 를 빠뜨릴 일이 없다.

현재 맵의 통행 가능 칸은 2,240칸 중 **539칸**. **추천 spawn tile은 `{ tileX: 31, tileY: 20 }`** (중앙 분수 남쪽, 통행 가능) — `RoomCreateOptions.spawn`에 넣으면 된다. spawn은 맵이 아니라 room 설정에서 온다(`server/src/rooms/contracts.ts`의 `SpawnArea`). `plaza`는 `spreadRadiusInTiles: 0` 이라 전원이 이 타일 하나에 그대로 선다.

### plaza 포탈 타일

좌표 정본은 `server/src/rooms/portalDefinitions.ts`(코드 측 테이블, 근거는 `docs/design-portal-object.md` §1). 여기 기록은 맵을 편집할 때 대조하기 위한 것이다 — 문 그림을 옮기면 양쪽을 같이 고쳐야 한다.

| 역할 | 타일 | 포탈 |
|---|---|---|
| 트리거 (남쪽 문) | `{31,25}` `{32,25}` | `plaza-south-door` → `grand-plaza` |
| 도착 | `{31,24}` | `grand-plaza-north-door` 로 들어올 때 |
| 트리거 (북쪽 문) | `{31,8}` `{32,8}` | `plaza-north-door` → `hunting-ground` |
| 도착 | `{31,9}` | `hunting-ground-south-door` 로 들어올 때 |

남문 트리거는 walkable 최남단 행(row 25), 북문 트리거는 최북단 행(row 8)이고 도착은 각각 한 칸 안쪽이다 — 북문은 남문의 정확한 대칭이다. **spawn row 20(x 16–47)과 테두리 밴드(x<16, x>47, y<8, y>25)에는 문을 두지 말 것** — `metaverseRoom.integration.test.ts`가 그 영역을 통째로 걸어 다니므로 포탈과 무관한 테스트가 문을 밟는다. 이 제약은 `server/src/game/portals.test.ts`가 검증한다.

### plaza 고정 오브젝트 타일

좌표·콘텐츠 정본은 `server/src/rooms/interactableDefinitions.ts`(코드 측 테이블, 근거는 `docs/design-fixed-objects.md` §4). 포탈 타일과 같은 이유로 여기 기록은 맵 편집 시 대조용이다. 포탈처럼 **진입 트리거**이고(밟는 이동에서만 발동), 서버가 콘텐츠째로 보내준다 — 맵에는 아무것도 들어가지 않는다.

| 역할 | 타일 | 오브젝트 | kind |
|---|---|---|---|
| 링크판 | `{17,23}` | `plaza-link-board` | link |
| 공지판 | `{44,23}` `{45,23}` | `plaza-notice-board` | notice |
| 퀴즈대 | `{47,8}` | `plaza-quiz-stand` | quiz |

콘텐츠는 전부 **자리표시(placeholder)** 이고 나중에 실제 내용으로 교체한다. 타일은 통행량이 적은 자리를 골랐다 — 링크판은 남서쪽 상자(`{18,23}`)·수풀(`{17,24}`)에 낀 구석, 공지판은 남동쪽 수풀 행(y=22) 아래 2칸, 퀴즈대는 북동쪽 막다른 모서리다. 오브젝트에 올라서면 패널이 열리면서 **클라이언트 이동이 잠기므로**(`docs/design-fixed-objects.md` §9.5) 길목에 두면 지나가는 사람이 매번 멈춘다.

**포탈과 같은 회피 규칙에 더해, 포탈 트리거·도착 타일 자체도 피할 것**: 트리거와 겹치면 부팅 거부(패널이 뜨는 즉시 방을 떠난다), 도착과 겹치면 부팅 경고(도착은 이동이 아니라 패널이 안 뜬다). 한 타일에 오브젝트는 하나만 — 겹치면 부팅 거부다. `grand-plaza`에는 오브젝트를 두지 않는다: 500 CCU 측정용 맵이라 `tools/loadtest-poc2.mjs`의 봇이 밟으면 측정에 없던 메시지가 섞인다.

## maps/grand-plaza.json

Go/No-go PoC #2(500 CCU broadcast 측정) 전용 맵. 설계 근거와 수치 유도는 `docs/poc2-design.md` §1.

- **172 x 147 tiles**, 내부 walkable **140 x 130**, 통행 가능 **14,800칸** / 통행 불가 10,484칸
- `plaza.json`과 **완전히 동일한 포맷·동일한 embedded 타일셋**(아트 신규 제작 0). 서버 `MapLoader`·Phaser 로더 양쪽 다 무수정
- spawn 중심 `{ tileX: 86, tileY: 73 }`, `spreadRadiusInTiles: 70` (중앙 광장 한가운데, 반경이 통행 가능 영역 전체를 덮는다). 기존 좌표 대비 `+6,+1` 시프트

레이아웃은 세 겹이다.

| 영역 | 범위 | 내용 |
|---|---|---|
| 경계 밴드 | 좌우 16열, 상 8행, 하 9행 | 전부 통행 불가 (뷰포트 32x18 무클램프 유지). 안쪽 2링은 벽돌 벽, 그 바깥은 물 |
| 내부 | 140 x 130 | 10x10 super-tile 14 x 13개, 각 super-tile에 5x4 건물 + 나머지는 거리 |
| 중앙 광장 | `x 66–105`, `y 58–87` | super-tile 12개를 비운 40 x 30 완전 개방 |

### grand-plaza 포탈 타일

| 역할 | 타일 | 포탈 |
|---|---|---|
| 트리거 (북서 골목 북단) | `{22,8}` `{23,8}` | `grand-plaza-north-door` → `plaza` |
| 도착 | `{22,9}` | `plaza-south-door` 로 들어올 때 |

북서 골목(`x 21–25`, `y 8–11`)의 막힌 북쪽 끝 2칸이다. 도착 타일은 그 바로 남쪽 칸 — 도착 타일이 역방향 트리거와 정확히 겹치면 부팅이 **경고**를 낸다(거부는 아니다. 폭 1칸 통로처럼 옆 칸이 없는 정당한 레이아웃이 있으므로). 트리거·도착이 통행 불가면 **부팅 거부**다(`validateRoomMaps`).

**경계 밴드에 통행 가능 칸이 하나라도 생기면 안 된다.** 아바타 origin이 `(0.5, 1)`(타일 아래변)이라 밴드 두께가 상하 비대칭인 것도 같은 이유 — 이 밴드가 비어 있는 동안에만 Phaser 카메라가 `setBounds` 클램프에 걸리지 않고, 로컬 플레이어가 **항상 정확히 화면 중앙**에 있다. 그 불변식 위에서 "화면에 보일 수 있는 최대 Chebyshev 거리"가 성립하고 `VIEW_RADIUS_TILES`가 그로부터 유도된다. 밴드가 뚫리면 반경 상수의 근거가 통째로 무너진다.

위 "## 재생성" 섹션의 "grand-plaza 맵" 항목(`generate-load-map.mjs`)으로 생성/재생성한다.

타일셋 블록은 `plaza.json`에서 **읽어서 그대로 복사**된다 — 리스킨으로 타일셋이 바뀌면 자동으로 따라가고, 스크립트에 타일셋을 하드코딩할 일이 없다.

**디스크에 쓰기 전에 메모리에서 전부 검증하고, 하나라도 어긋나면 아무것도 쓰지 않고 exit 1 한다**(`import-ninja-assets.mjs`와 같은 순서, 사유는 `docs/decisions.md` 2026-08-26): 통행 가능 칸 수, `collision` 레이어의 `gid ≠ 0` 칸과 `collides: true` 칸의 일치, spawn 중심의 통행 가능 여부, spawn에서의 4방향 flood fill 도달 수(= 고립 영역 0), 경계 밴드 내 통행 가능 칸 0개, 경계 링 불투명(위 "경계 링 불투명 규칙").

## maps/hunting-ground.json

로드맵 항목7(사냥터·몬스터·전투) 조각 C의 맵. 설계 근거는 `docs/design-hunting-inventory.md` §4.1. **이 시점에는 몬스터가 없다** — 걸어 들어갈 수 있는 빈 사냥터와 문뿐이고, 스포너는 조각 D에서 붙는다.

- **72 x 41 tiles**, 내부 walkable **40 x 24**(x16–55, y8–31), 통행 가능 **860칸** / 통행 불가 2,092칸
- `plaza.json`과 **완전히 동일한 포맷·동일한 embedded 타일셋**(아트 신규 제작 0)
- spawn 중심 `{ tileX: 35, tileY: 27 }`, `spreadRadiusInTiles: 2` (남문 트리거(y=31)와 최소 2칸 거리 — 2026-09-03 spawn이 포탈 트리거와 겹쳐 의도치 않게 순간이동되는 버그가 발견돼 `tileY: 29`에서 조정됨)
- 뷰포트(32×18)보다 넓어 한 화면에 다 들어오지 않는다 — 사냥터는 돌아다니는 곳이다

| 영역 | 범위 | 내용 |
|---|---|---|
| 경계 밴드 | 좌우 16열, 상 8행, 하 9행 | 전부 통행 불가. 안쪽 2링은 벽돌 성벽, 그 바깥은 숲 → 해변 → 물 |
| 내부 | 40 x 24 | 개활지 + 2칸 깊이 장애물 덩어리(바위·그루터기·수풀)와 연못 1개 |
| 오솔길 | `x 35–36` 세로 전 구간 | 남문에서 북쪽 끝까지 이어지는 흙길. 남문 안쪽(`x 33–38`, `y 28–31`)은 길목으로 넓어진다 |

**장애물 덩어리는 서로, 그리고 성벽과 최소 2칸 떨어져 있다.** 폭 1칸 통로를 만들지 않기 위한 배치이고, 생성기가 검증한다(위 "hunting-ground 맵" 항목).

### hunting-ground 포탈 타일

| 역할 | 타일 | 포탈 |
|---|---|---|
| 트리거 (남쪽 문) | `{35,31}` `{36,31}` | `hunting-ground-south-door` → `plaza` |
| 도착 | `{35,30}` | `plaza-north-door` 로 들어올 때 |
| 트리거 (북쪽 문) | `{35,8}` `{36,8}` | `hunting-ground-north-door` → `hunting-den` (Phase E) |
| 도착 | `{35,9}` | `hunting-den-south-door` 로 들어올 때 |

남문 트리거는 walkable 최남단 행(row 31)이고 도착은 그 북쪽 칸, spawn은 다시 그 북쪽 칸이다. 북문은 오솔길(interior col 19-20, map x35-36)의 북쪽 종점으로, 남문의 정확한 대칭이다. 두 문의 트리거 전부 **나무 바닥(tile id 3)** 으로 그려 문턱임을 보이며(plaza 남문과 같은 규약), 생성기가 그 일치를 검증한다.

## maps/hunting-den.json

로드맵 Phase E("사냥터 2번째 방")의 맵. 설계 근거는 `docs/design-phase-e-second-hunting-ground.md` §3. hunting-ground의 오솔길 북쪽 끝(북문)을 통해서만 들어올 수 있고, plaza에서는 보이지 않는다.

- **64 x 37 tiles**, 내부 walkable **32 x 20**(x16–47, y8–27), 통행 가능 **592칸** / 통행 불가 1,776칸
- `plaza.json`과 **완전히 동일한 포맷·동일한 embedded 타일셋**(아트 신규 제작 0)
- spawn 중심 `{ tileX: 31, tileY: 24 }`, `spreadRadiusInTiles: 1` (남문 트리거(y=27)와 최소 2칸 거리 — 원래 `tileY: 25`/radius 2였으나 hunting-ground와 같은 spawn/포탈 겹침 버그가 발견돼 조정, radius 1인 이유는 2였다면 hd-rabbit-07 배회 범위와도 겹쳤기 때문)
- 뷰포트(32×18)보다 살짝 크다 — hunting-ground보다는 뚜렷이 작아, 몬스터 10마리 대비 밀도가 hunting-ground와 비슷한 자릿수가 되도록 역산된 크기(설계 §3.1)

| 영역 | 범위 | 내용 |
|---|---|---|
| 경계 밴드 | 좌우 16열, 상 8행, 하 9행 | 전부 통행 불가. 안쪽 2링은 벽돌 성벽, 그 바깥은 숲 → 해변 → 물 |
| 내부 | 32 x 20 | 개활지 + 2칸 깊이 장애물 덩어리(바위·그루터기·수풀)와 연못 1개 |
| 오솔길 | `x 31–32` 세로 전 구간 | 남문(이 방의 유일한 문)에서 북쪽 끝까지 이어지는 흙길. hunting-ground의 오솔길이 북문을 지나 그대로 이어진다는 서사 |

**장애물 덩어리는 서로, 오솔길, 그리고 성벽과 최소 2칸 떨어져 있다.** hunting-ground와 같은 이유(폭 1칸 통로 금지), 생성기가 검증한다(위 "hunting-den 맵" 항목).

### hunting-den 포탈 타일

| 역할 | 타일 | 포탈 |
|---|---|---|
| 트리거 (남쪽 문, 이 방의 유일한 문) | `{31,27}` `{32,27}` | `hunting-den-south-door` → `hunting-ground` |
| 도착 | `{31,26}` | `hunting-ground-north-door` 로 들어올 때 |

트리거는 walkable 최남단 행(row 27)이고 도착은 그 북쪽 칸, spawn은 다시 그 북쪽 칸 — hunting-ground의 남문과 완전히 같은 관례다. 트리거 2칸은 **나무 바닥(tile id 3)** 으로 그려 문턱임을 보이며, 생성기가 그 일치를 검증한다.

## tilesets/plaza-tiles.png

- **256 x 64 px**, 8 columns x 2 rows, tile 32 x 32, `margin 0` / `spacing 0`, `firstgid 1`
- **규약: 0행(tile id 0–7)은 통행 가능, 1행(tile id 8–15)은 `collides: true`.** 타일을 추가할 때 이 행 분리를 유지하면 collision 정의가 계속 자명하다.
- `gid = tile id + 1`

| tile id | gid | 타일 | collides |
|---|---|---|---|
| 0 | 1 | 석재 바닥 | |
| 1 | 2 | 석재 바닥(균열) | |
| 2 | 3 | 잔디 | |
| 3 | 4 | 나무 바닥 (plaza 남문 문턱용) | |
| 4 | 5 | 흙길 | |
| 5 | 6 | 광장 문양 타일 | |
| 6 | 7 | 모래 (plaza 테두리 해변 아트용) | |
| 7 | 8 | 꽃 잔디 | |
| 8 | 9 | 벽돌 벽(running-bond 벽돌쌓기) | O |
| 9 | 10 | 벽돌 벽(모서리용, id 8과 동일 아트) | O |
| 10 | 11 | 그루터기 | O |
| 11 | 12 | 수풀 | O |
| 12 | 13 | 물(분수) | O |
| 13 | 14 | 나무 상자 | O |
| 14 | 15 | 항아리 | O |
| 15 | 16 | 이끼 낀 바위 | O |

**id 8/9가 같은 텍스처인 건 의도적이다.** `plaza.json`이 네 모서리 전부에 같은 id 9를 쓰므로 방향성 있는 코너 캡을 쓸 수 없다 — 한 모서리에 맞추면 나머지 셋은 반전되어 틀어진다. 그래서 코너 전용 아트를 포기하고, 벽돌 줄눈 2줄을 세로로 반복시켜 가로·세로 어느 방향으로 이어 붙여도 이음새가 안 보이게 만들었다.

배경이 투명한 타일: id 10(87% 불투명), 11(67%), 13(79%), 14(76%), 15(45%). id 8/9/12는 100% 불투명. 투명한 타일을 `collision` 레이어에 놓으면 `ground`가 비쳐 보인다.

### 경계 링 불투명 규칙 (두 생성기 공통 검증)

**통행 가능 칸에서 Chebyshev 거리 `BOUNDARY_RING_DEPTH`(=2) 이내인 모든 테두리 밴드 칸은 100% 불투명 타일(id 8/9/12)이어야 한다.** `generate-plaza.mjs`·`generate-load-map.mjs` 양쪽이 쓰기 전에 검증하고, 어긋나면 exit 1.

런타임은 이걸 절대 못 잡는다 — 서버는 어느 쪽이든 그 칸을 막으므로 맵은 "정상"인 채로 그림만 걸어 들어오라고 유혹한다. 실제로 그렇게 새 나갔던 사례가 id 11 "수풀"이다: 이 타일의 실체는 **67% 불투명 잔디 텍스처**라, `ground: 잔디` 위에 얹으면 잔디 위에 잔디가 되어 밴드 전체가 걸어 다닐 수 있는 들판으로 보였다(구 grand-plaza 테두리가 정확히 이 조합이었다).

그래서 두 맵 모두 안쪽 2링을 벽돌로 채운다. plaza는 6층 디오라마의 성벽 층을 2타일로 두껍게 했을 뿐 나머지 5층은 그대로고, grand-plaza는 **벽돌 벽 2겹 + 그 바깥은 물(모래 바닥)** 로 바꿨다. 어느 쪽도 walkable 좌표는 1칸도 건드리지 않았다.

## sprites/avatar.png

- **96 x 3072 px**, frame **32 x 32**, `margin 0` / `spacing 0` → 3 columns x 96 rows = 288 frames
- 행 배치: **`row = skin * 4 + direction`**
  - `skin`: 0–23 (shared `AVATAR_SKIN_COUNT` = 24). **Tiny Characters Set(Fleurman, CC0)** 소스 시트의 6 x 4 캐릭터 블록 **전체**를 굽는다 — 한 블록이 곧 한 스킨이고, 리컬러가 아니라 전부 따로 그려진 캐릭터다.
  - `direction`: shared `Direction` enum 값 **그대로** — `Down 0, Left 1, Right 2, Up 3`. 소스 및 목표 시트 규약과 일치.

스킨 id ↔ 소스 블록 `(bx,by)`. 정본은 `tools/import-avatar.mjs`의 `SKINS` 테이블이고, 아래는 대조용 사본이다. **id 0–3은 4스킨만 굽던 시절의 블록을 그대로 유지**했다(시트 순서로 재번호하지 않음) — 그래서 확대 전에 나온 스크린샷·문서가 여전히 같은 캐릭터를 가리킨다. 4–23은 시트 순서.

| id | 블록 | 캐릭터 | id | 블록 | 캐릭터 |
|---|---|---|---|---|---|
| 0 | (0,0) | 갈색 롱헤어 / 빨강 상의 | 12 | (5,1) | 어두운 피부 / 은발 / 연두 셔츠 |
| 1 | (3,0) | 금발 / 녹색 튜닉 | 13 | (0,2) | 어두운 피부 / 하늘색 뿔머리 / 노랑 튜닉 |
| 2 | (2,0) | 적발 트윈테일 / 파랑 원피스 | 14 | (1,2) | 금발 / 진녹색 셔츠 |
| 3 | (5,2) | 어두운 피부 / 아프로 / 핑크 상의 | 15 | (2,2) | 적발 / 하늘색 줄무늬 셔츠 |
| 4 | (1,0) | 어두운 피부 / 애시 금발 단발 / 빨강 셔츠 | 16 | (3,2) | 갈색 머리 / 빨강 상의 |
| 5 | (4,0) | 어두운 피부 / 주황 브릿지 흑발 / 주황 셔츠 | 17 | (4,2) | 밝은 피부 / 짧은 머리 / 흰 셔츠 |
| 6 | (5,0) | 어두운 피부 / 짙은 아프로 / 핑크 줄무늬 상의 | 18 | (0,3) | 금발 뿔머리 / 청록 플로럴 상의 |
| 7 | (0,1) | 어두운 피부 / 마젠타 단발 / 플로럴 원피스 | 19 | (1,3) | 어두운 피부 / 흑발 / 진녹색 조끼 |
| 8 | (1,1) | 주황 바가지머리 / 녹색 셔츠 | 20 | (2,3) | 적발 / 보라 상의 |
| 9 | (2,1) | 어두운 피부 / 녹색 머리 / 보라 상의 | 21 | (3,3) | 백발 / 파랑 고글 / 주황 코트 |
| 10 | (3,1) | 금발+회발 투톤 / 올리브 재킷 | 22 | (4,3) | 어두운 피부 / 갈색 머리 / 파랑 셔츠 |
| 11 | (4,1) | 적갈색 웨이브 / 파랑 탱크톱 | 23 | (5,3) | 갈색 머리+수염 / 녹색 셔츠 |
- 열 배치: **`0` = stepA, `1` = idle, `2` = stepB** (소스와 목표의 열 배치가 동일)

Phaser 프레임 인덱스:

```ts
const base = (skin * 4 + direction) * 3;
// idle  = base + 1
// walk  = [base, base + 1, base + 2, base + 1]  (loop)
```

- 32x32 프레임을 거의 꽉 채운다(최악 케이스 기준 y 0–31 불투명). 이 때문에 말풍선 오프셋(`code/client/src/world/chatBubbles.ts` 의 `BUBBLE_OFFSET_Y`)이 30 → 36 으로 조정됐다(사유는 해당 코드 주석 참고 — 여기 중복 기술하지 않는다). origin을 `(0.5, 1)` 로 두고 타일의 아래 변에 맞추면 그리드에 정렬된다.
- `Right(2)`는 `Left(1)`의 좌우 반전이 아니라 소스에서 각각 독립 프레임으로 구워 넣었다. 목표 규약의 direction → row 매핑을 분기 없이 유지하기 위함.

## sprites/monster.png

- **96 x 256 px**, frame **32 x 32**, `margin 0` / `spacing 0` → 3 columns x 8 rows = 24 frames
- 행 배치: **`row = kindIndex * 4 + direction`** — `avatar.png`와 **글자 그대로 같은 규약**이다. 그래서 `client/src/world/monsterSprites.ts`가 `playerSprites.ts`의 프레임 계산식을 `skin` → `kindIndex` 치환만으로 그대로 쓴다.
  - `direction`: shared `Direction` enum 값 그대로 — `Down 0, Left 1, Right 2, Up 3`
- 열 배치: **`0` = stepA, `1` = idle, `2` = stepB** (아바타와 동일)
- origin `(0.5, 1)`. 아바타와 같은 규약이라 `setDepth(sprite.y)` 정렬에 사람과 몬스터가 같이 섞인다

| kindIndex | kind | 행 | idle 프레임(Down/Left/Right/Up) | 아트 |
|---|---|---|---|---|
| 0 | `squirrel` | 0–3 | 1 / 4 / 7 / 10 | 주황빛 갈색 다람쥐. 등 뒤로 크게 말려 올라간 꼬리 + 작고 둥근 귀. 보행 = 웅크림/직립/홉, 방향은 눈 위치(Up은 눈 없음) |
| 1 | `rabbit` | 4–7 | 13 / 16 / 19 / 22 | 흰색/크림색 토끼. 머리 위로 곧게 솟은 긴 귀 + 작고 동그란 꼬리. 보행 = 웅크림/직립/홉, 방향은 눈 위치(Up은 눈 없음) |

```ts
const base = (kindIndex * 4 + direction) * 3;
// idle  = base + 1
// walk  = [base, base + 1, base + 2, base + 1]  (loop)
```

**`kindIndex`는 선언 순서에 의존하지 않는다.** 정본은 `client/src/world/monsterSprites.ts`의 `MONSTER_SPRITE_ORDER`이고 생성기가 그 배열을 읽어 대조한다(위 "몬스터 + 아이템 아이콘" 항목). **재정렬 금지** — 순서를 바꾸면 다람쥐가 토끼 프레임을 그린다.

- 두 종 모두 지상형이다: 바닥 접지(프레임 아래 여백 없음)이고, 몸통은 4방향 행 전부에 동일하게 그려지며 얼굴만 방향별로 다르다. 아바타와 같은 관례라 **말풍선·이름표 오프셋과 무관하다** — 몬스터에는 둘 다 붙지 않는다.
- 사람과 혼동되지 않는 실루엣이 이 두 종을 고른 이유다(설계 부록 D-1). 공격 대상을 서버가 자동 선정하므로 "저게 때릴 수 있는 것인가"가 한눈에 보여야 한다. 귀 모양·크기(다람쥐=작고 둥근, 토끼=길고 곧음)와 꼬리 위치(다람쥐=등 위로 크게, 토끼=뒤쪽에 살짝)가 두 종을 구분하는 핵심이다.

## sprites/items.png

- **160 x 32 px**, frame **32 x 32**, `margin 0` / `spacing 0` → 5 columns x 1 row = 5 frames
- 열 배치: `frameIndex = ITEM_ICON_ORDER.indexOf(definition.icon)`
- 스프라이트시트가 아니라 **DOM 배경 이미지**로 쓰인다(`client/src/style.css`의 `.bag__icon`, `background-position`으로 열 선택). 가방 창이 DOM이라 Phaser 로더를 타지 않는다

| frame | icon | 아트 |
|---|---|---|
| 0 | `acorn` | 갈색 도토리(어두운 갈색 갓 + 황갈색 나무 몸통) |
| 1 | `carrot` | 주황 당근 뿌리(초록 잎) |
| 2 | `copper-coin` | 구리 동전 |
| 3 | `herb` | 약초 |
| 4 | `old-dagger` | 낡은 단검 |

정본은 `client/src/ui/inventoryPanel.ts`의 `ITEM_ICON_ORDER`이고 생성기가 대조한다. `ItemDefinition.icon`이 이 목록에 없는 값이면 가방 창은 **빈 슬롯(점선 테두리)** 을 그린다 — 서버 카탈로그가 번들보다 새로울 수 있으므로 다른 아이템 그림을 대신 쓰지 않는다.

## 뷰포트 / 카메라 설정값

와이드스크린(16:9) 전환에 따른 공통 뷰포트 설정. 모든 room이 동일하게 적용되며, 개별 room별 커스터마이징은 없다.

| 상수 | 값 | 의미 |
|---|---|---|
| `VIEWPORT_WIDTH_TILES` | 32 | 화면에 보이는 타일 가로 수 (1024px @ 32px/tile) |
| `VIEWPORT_HEIGHT_TILES` | 18 | 화면에 보이는 타일 세로 수 (576px @ 32px/tile) |
| `VIEW_RADIUS_TILES` | 19 | 아바타 상태 동기화 반경 (interest management) |
| `CHAT_RADIUS_TILES` | 8 | 근접 채팅 수신 반경 |

역산 도출(아바타 origin `(0.5,1)` 기준):
- 가로 오프셋: `floor(32/2) = 16`
- 세로 위쪽: `floor((18-1)/2) = 8`
- 세로 아래쪽: `floor(18/2) = 9`
- `VIEW_RADIUS = max(16, 9) + 3 = 19`
- `CHAT_RADIUS = 위 오프셋 = 8`

이 값들은 타일맵 크기와 비의존적으로 설계돼, plaza(64×35)와 grand-plaza(172×147) 둘 다 같은 상수를 사용하면서 각 맵의 경계 밴드가 무클램프를 보장한다.
