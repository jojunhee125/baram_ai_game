# assets — Ninja Adventure 기반 리스킨 아트

Phase1.5 리스킨 적용본. 절차적 placeholder가 아니라 **[Ninja Adventure Asset Pack](https://github.com/pixel-boy/NinjaAdventure)**(제작자 pixel-boy, **CC0** — 귀속 불필요, 상업 이용 가능)의 원본 픽셀 아트를 잘라 만든 실제 에셋이다. 파일 규약(치수·행 배치·`collides` 규약)만 지키면 여전히 통째로 리스킨 가능하다.

`code/client`(Phaser 렌더)와 `code/server`(collision 검증)가 **같은 `plaza.json`을 읽는다.** 그래서 `assets/`는 `client/public/`이 아니라 `client/`·`server/`의 형제 위치에 있고, Vite는 `publicDir`로 이 폴더를 그대로 서빙한다.

## 재생성

```
node tools/import-ninja-assets.mjs <ninja-adventure-repo-root>      # cwd = code/
NINJA_ASSET_ROOT=<ninja-adventure-repo-root> node tools/import-ninja-assets.mjs
```

소스 저장소 위치는 인자 또는 `NINJA_ASSET_ROOT` 로 넘긴다 — 스크립트에 하드코딩된 경로는 없다. 결정적(deterministic) 생성이라 같은 소스면 같은 PNG가 나온다.

**`maps/plaza.json`은 이 파이프라인에서 절대 바뀌지 않는다** — 맵을 읽어 타일셋에 대해 그것이 거는 전제(tile 크기, `firstgid`, `columns`/`tilecount`, 이미지 치수, `collides` 타일 개수, 레이어 gid 범위)를 전부 재검증한 뒤 **원본 바이트를 그대로 다시 쓴다.** 리스킨이 그 전제 중 하나를 깨면 조용히 통과하지 않고 그 자리에서 실패한다.

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

현재 맵의 통행 가능 칸은 300칸 중 218칸. **추천 spawn tile은 `{ tileX: 9, tileY: 11 }`** (중앙 분수 남쪽, 통행 가능) — `RoomCreateOptions.spawn`에 넣으면 된다. spawn은 맵이 아니라 room 설정에서 온다(`server/src/rooms/contracts.ts`).

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
