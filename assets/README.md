# assets — Ninja Adventure 기반 리스킨 아트

Phase1.5 리스킨 적용본. 절차적 placeholder가 아니라 **[Ninja Adventure Asset Pack](https://github.com/pixel-boy/NinjaAdventure)**(제작자 pixel-boy, **CC0** — 귀속 불필요, 상업 이용 가능)의 원본 픽셀 아트를 잘라 만든 실제 에셋이다. 파일 규약(치수·행 배치·`collides` 규약)만 지키면 여전히 통째로 리스킨 가능하다.

`code/client`(Phaser 렌더)와 `code/server`(collision 검증)가 **같은 `plaza.json`을 읽는다.** 그래서 `assets/`는 `client/public/`이 아니라 `client/`·`server/`의 형제 위치에 있고, Vite는 `publicDir`로 이 폴더를 그대로 서빙한다.

## 재생성

```
node tools/import-ninja-assets.mjs <ninja-adventure-repo-root>      # cwd = code/
NINJA_ASSET_ROOT=<ninja-adventure-repo-root> node tools/import-ninja-assets.mjs
```

소스 저장소 위치는 인자 또는 `NINJA_ASSET_ROOT` 로 넘긴다 — 스크립트에 하드코딩된 경로는 없다. 결정적(deterministic) 생성이라 같은 소스면 같은 PNG가 나온다.

**`maps/plaza.json`·`maps/grand-plaza.json`은 이 파이프라인에서 절대 바뀌지 않는다** — 두 맵을 각각 읽어 타일셋에 대해 그것이 거는 전제(tile 크기, `firstgid`, `columns`/`tilecount`, 이미지 치수, `collides` 타일 개수, 레이어 gid 범위)를 전부 재검증한 뒤 **원본 바이트를 그대로 다시 쓴다.** 리스킨이 그 전제 중 하나를 깨면 조용히 통과하지 않고 그 자리에서 실패한다.

> 타일셋을 공유하는 맵을 새로 추가하면 `import-ninja-assets.mjs`의 `MAP_FILES` 에도 넣을 것. 빠뜨리면 그 맵만 검증 없이 남아 다음 리스킨 때 조용히 깨진다.

> **경고: `tools/generate-assets.mjs` 는 Phase1 절차적 placeholder 전용 스크립트다.** 실행하면 `tilesets/plaza-tiles.png` 와 `sprites/avatar.png` 가 placeholder로 되돌아가고, **`maps/plaza.json` 까지 스크립트 내부의 ASCII 레이아웃으로 재생성**된다 — 리스킨 자산을 통째로 덮어쓰는 파괴적 동작이다. 그래서 최상단에 `--force-placeholder` 플래그 가드가 있고, 플래그 없이 실행하면 아무것도 쓰지 않고 즉시 exit 1 한다.

## maps/plaza.json

- Tiled JSON format `1.10`, orthogonal, renderorder `right-down`, `infinite: false`
- **20 x 15 tiles**, tile size **32 x 32 px** (= shared `TILE_SIZE_PX`)
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

> 참고(규칙 아님): 현재 `plaza.json`은 `collision` 레이어의 gid ≠ 0 인 칸과 `collides: true` 인 칸이 정확히 일치한다(82칸). 다만 이건 이 파일이 애초에 그렇게 배치돼 고정(`import-ninja-assets.mjs`도 이 파일을 재검증 후 원본 그대로 재출력할 뿐 손대지 않는다)됐기 때문에 생기는 *현재 사실*일 뿐, 파일 포맷이 보장하는 성질이 아니다. Tiled에서 맵을 직접 편집하면서 장식용으로 통행 가능 타일(id 0-7)을 `collision` 레이어에 올리는 순간 둘은 갈라진다. **어느 쪽도 `gid !== 0` 로 구현하지 말 것** — 한쪽만 그렇게 구현하면 서버는 통과시키는데 클라이언트는 막는(또는 그 반대) 조용한 desync가 된다.

- 타일을 추가할 때 tileset의 **"0행 통행 가능 / 1행 통행 불가"** 행 분리를 지키면 `collides` 를 빠뜨릴 일이 없다.

현재 맵의 통행 가능 칸은 300칸 중 218칸. **추천 spawn tile은 `{ tileX: 9, tileY: 11 }`** (중앙 분수 남쪽, 통행 가능) — `RoomCreateOptions.spawn`에 넣으면 된다. spawn은 맵이 아니라 room 설정에서 온다(`server/src/rooms/contracts.ts`의 `SpawnArea`). `plaza`는 `spreadRadiusInTiles: 0` 이라 전원이 이 타일 하나에 그대로 선다.

### plaza 포탈 타일

좌표 정본은 `server/src/rooms/portalDefinitions.ts`(코드 측 테이블, 근거는 `docs/design-portal-object.md` §1). 여기 기록은 맵을 편집할 때 대조하기 위한 것이다 — 문 그림을 옮기면 양쪽을 같이 고쳐야 한다.

| 역할 | 타일 | 포탈 |
|---|---|---|
| 트리거 (남쪽 문) | `{15,13}` `{16,13}` | `plaza-south-door` → `grand-plaza` |
| 도착 | `{15,12}` | `grand-plaza-north-door` 로 들어올 때 |

트리거는 남쪽 벽(row 14) 바로 위 2칸이고 도착은 그 북쪽 옆 칸이다. **spawn row 11(x 1–18)과 x=1 열에는 문을 두지 말 것** — `metaverseRoom.integration.test.ts`가 그 경로를 통째로 걸어 다니므로 포탈과 무관한 테스트가 문을 밟는다. 이 제약은 `server/src/game/portals.test.ts`가 검증한다.

## maps/grand-plaza.json

Go/No-go PoC #2(500 CCU broadcast 측정) 전용 맵. 설계 근거와 수치 유도는 `docs/poc2-design.md` §1.

- **160 x 145 tiles**, 통행 가능 **14,800칸** / 통행 불가 8,400칸
- `plaza.json`과 **완전히 동일한 포맷·동일한 embedded 타일셋**(아트 신규 제작 0). 서버 `MapLoader`·Phaser 로더 양쪽 다 무수정
- spawn 중심 `{ tileX: 80, tileY: 72 }`, `spreadRadiusInTiles: 70` (중앙 광장 한가운데, 반경이 통행 가능 영역 전체를 덮는다)

레이아웃은 세 겹이다.

| 영역 | 범위 | 내용 |
|---|---|---|
| 경계 밴드 | 좌우 10열, 상 7행, 하 8행 | 전부 통행 불가 |
| 내부 | 140 x 130 | 10x10 super-tile 14 x 13개, 각 super-tile에 5x4 건물 + 나머지는 거리 |
| 중앙 광장 | `x 60–99`, `y 57–86` | super-tile 12개를 비운 40 x 30 완전 개방 |

### grand-plaza 포탈 타일

| 역할 | 타일 | 포탈 |
|---|---|---|
| 트리거 (북서 골목 북단) | `{16,7}` `{17,7}` | `grand-plaza-north-door` → `plaza` |
| 도착 | `{16,8}` | `plaza-south-door` 로 들어올 때 |

북서 골목(`x 15–19`, `y 7–10`)의 막힌 북쪽 끝 2칸이다. 도착 타일은 그 바로 남쪽 칸 — 도착 타일이 역방향 트리거와 정확히 겹치면 부팅이 **경고**를 낸다(거부는 아니다. 폭 1칸 통로처럼 옆 칸이 없는 정당한 레이아웃이 있으므로). 트리거·도착이 통행 불가면 **부팅 거부**다(`validateRoomMaps`).

**경계 밴드에 통행 가능 칸이 하나라도 생기면 안 된다.** 아바타 origin이 `(0.5, 1)`(타일 아래변)이라 밴드 두께가 상하 비대칭인 것도 같은 이유 — 이 밴드가 비어 있는 동안에만 Phaser 카메라가 `setBounds` 클램프에 걸리지 않고, 로컬 플레이어가 **항상 정확히 화면 중앙**에 있다. 그 불변식 위에서 "화면에 보일 수 있는 최대 Chebyshev 거리 = 10"이 성립하고 `VIEW_RADIUS_TILES`가 그로부터 유도된다. 밴드가 뚫리면 반경 상수의 근거가 통째로 무너진다.

### 재생성

```
node tools/generate-load-map.mjs                                        # cwd = code/
node tools/generate-load-map.mjs --width 90 --height 145 --out assets/maps/half.json
```

난수를 쓰지 않고 좌표 함수만으로 만들어 **같은 인자면 항상 같은 바이트**가 나온다. `--width`/`--height`는 `docs/poc2-design.md` §6.3의 밀도 고정 측정(맵 면적을 봇 수에 비례시켜 이웃 수를 20으로 묶어두는 스윕)용 축소판을 뽑기 위한 것이다. 내부 치수가 10의 배수가 아니면 거부한다.

타일셋 블록은 `plaza.json`에서 **읽어서 그대로 복사**한다 — 리스킨으로 타일셋이 바뀌면 자동으로 따라가고, 이 스크립트에 타일셋을 하드코딩할 일이 없다.

**디스크에 쓰기 전에 메모리에서 전부 검증하고, 하나라도 어긋나면 아무것도 쓰지 않고 exit 1 한다**(`import-ninja-assets.mjs`와 같은 순서, 사유는 `docs/decisions.md` 2026-08-26): 통행 가능 칸 수, `collision` 레이어의 `gid ≠ 0` 칸과 `collides: true` 칸의 일치, spawn 중심의 통행 가능 여부, spawn에서의 4방향 flood fill 도달 수(= 고립 영역 0), 경계 밴드 내 통행 가능 칸 0개.

## tilesets/plaza-tiles.png

- **256 x 64 px**, 8 columns x 2 rows, tile 32 x 32, `margin 0` / `spacing 0`, `firstgid 1`
- **규약: 0행(tile id 0–7)은 통행 가능, 1행(tile id 8–15)은 `collides: true`.** 타일을 추가할 때 이 행 분리를 유지하면 collision 정의가 계속 자명하다.
- `gid = tile id + 1`

| tile id | gid | 타일 | collides |
|---|---|---|---|
| 0 | 1 | 석재 바닥 | |
| 1 | 2 | 석재 바닥(균열) | |
| 2 | 3 | 잔디 | |
| 3 | 4 | 나무 바닥 *(현재 맵엔 미사용, 시트엔 존재)* | |
| 4 | 5 | 흙길 | |
| 5 | 6 | 광장 문양 타일 | |
| 6 | 7 | 모래 *(현재 맵엔 미사용, 시트엔 존재)* | |
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

## sprites/avatar.png

- **96 x 512 px**, frame **32 x 32**, `margin 0` / `spacing 0` → 3 columns x 16 rows = 48 frames
- 행 배치: **`row = skin * 4 + direction`**
  - `skin`: 0–3 (shared `AVATAR_SKIN_COUNT` = 4). skin 0=닌자(청), 1=사무라이(청), 2=사무라이(녹) — Ninja Adventure Asset Pack의 서로 다른 캐릭터. skin 3은 skin 0(닌자 청)의 팔레트 리컬러(크림즌)로 실루엣이 동일하다. 4방향 시트 그리드를 갖춘 캐릭터가 소스에 3종뿐이라 4번째를 리컬러로 채웠다(2026-08-26 사용자 승인, `docs/decisions.md` 참고)
  - `direction`: shared `Direction` enum 값 **그대로** — `Down 0, Left 1, Right 2, Up 3`
- 열 배치: **`0` = 한쪽 발 step, `1` = idle/contact, `2` = 반대쪽 발 step**

Phaser 프레임 인덱스:

```ts
const base = (skin * 4 + direction) * 3;
// idle  = base + 1
// walk  = [base, base + 1, base + 2, base + 1]  (loop)
```

- 새 아트는 32x32 프레임을 거의 꽉 채운다(최악 케이스 기준 y 0–31 불투명). 이 때문에 말풍선 오프셋(`code/client/src/world/chatBubbles.ts` 의 `BUBBLE_OFFSET_Y`)이 30 → 36 으로 조정됐다(사유는 해당 코드 주석 참고 — 여기 중복 기술하지 않는다). origin을 `(0.5, 1)` 로 두고 타일의 아래 변에 맞추면 그리드에 정렬된다.
- `Right(2)`는 `Left(1)`의 좌우 반전이지만 런타임 `flipX` 대신 시트에 구워 넣었다. direction → row 매핑을 분기 없이 유지하기 위함.
