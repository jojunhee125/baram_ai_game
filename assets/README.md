# assets — Phase1 placeholder art

Phase1(공간이동 + 텍스트 채팅 MVP) 로컬 검증용 임시 아트. 최종 프로덕션 아트가 아니며, 파일 규약만 지키면 통째로 리스킨 가능하다.

`code/client`(Phaser 렌더)와 `code/server`(collision 검증)가 **같은 `plaza.json`을 읽는다.** 그래서 `assets/`는 `client/public/`이 아니라 `client/`·`server/`의 형제 위치에 있고, Vite는 `publicDir`로 이 폴더를 그대로 서빙한다.

## 재생성

```
node tools/generate-assets.mjs      # cwd = code/
```

결정적(deterministic) 생성이라 같은 소스면 같은 PNG가 나온다. **`maps/plaza.json`도 같이 덮어쓴다** — Tiled 에디터로 맵을 직접 편집하기 시작한 뒤에는 generator를 다시 돌리지 말 것(또는 generator 안의 ASCII 레이아웃을 대신 수정할 것).

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

> 참고(규칙 아님): 현재 generator 출력에서는 `collision` 레이어의 gid ≠ 0 인 칸과 `collides: true` 인 칸이 정확히 일치한다(82칸). 다만 이건 `generate-assets.mjs` 의 `COLLISION_LEGEND` 가 통행 불가 타일만 매핑하기 때문에 생기는 *현재 사실*일 뿐, 파일 포맷이 보장하는 성질이 아니다. Tiled에서 맵을 직접 편집하면서 장식용으로 통행 가능 타일(id 0-7)을 `collision` 레이어에 올리는 순간 둘은 갈라진다. **어느 쪽도 `gid !== 0` 로 구현하지 말 것** — 한쪽만 그렇게 구현하면 서버는 통과시키는데 클라이언트는 막는(또는 그 반대) 조용한 desync가 된다.

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
| 3 | 4 | 나무 바닥 | |
| 4 | 5 | 흙길 | |
| 5 | 6 | 광장 문양 타일 | |
| 6 | 7 | 모래 | |
| 7 | 8 | 꽃 잔디 | |
| 8 | 9 | 벽돌 벽 | O |
| 9 | 10 | 석재 벽(모서리용) | O |
| 10 | 11 | 기둥 | O |
| 11 | 12 | 생울타리 | O |
| 12 | 13 | 물(분수) | O |
| 13 | 14 | 나무 상자 | O |
| 14 | 15 | 탁자 | O |
| 15 | 16 | 안내판 | O |

기둥·상자·탁자·안내판은 배경이 투명하다 — `collision` 레이어에 놓으면 `ground`가 비쳐 보인다.

## sprites/avatar.png

- **96 x 1024 px**, frame **32 x 32**, `margin 0` / `spacing 0` → 3 columns x 32 rows = 96 frames
- 행 배치: **`row = skin * 4 + direction`**
  - `skin`: 0–7 (shared `AVATAR_SKIN_COUNT` = 8). 셔츠 색만 다르고 실루엣은 동일
  - `direction`: shared `Direction` enum 값 **그대로** — `Down 0, Left 1, Right 2, Up 3`
- 열 배치: **`0` = 한쪽 발 step, `1` = idle/contact, `2` = 반대쪽 발 step**

Phaser 프레임 인덱스:

```ts
const base = (skin * 4 + direction) * 3;
// idle  = base + 1
// walk  = [base, base + 1, base + 2, base + 1]  (loop)
```

- 32x32 프레임 안에서 캐릭터는 **x 8–23, y 6–29** 를 차지한다. 발바닥이 y=29이므로 origin을 `(0.5, 1)` 로 두고 타일의 아래 변에 맞추면 그리드에 정렬된다.
- `Right(2)`는 `Left(1)`의 좌우 반전이지만 런타임 `flipX` 대신 시트에 구워 넣었다. direction → row 매핑을 분기 없이 유지하기 위함.
