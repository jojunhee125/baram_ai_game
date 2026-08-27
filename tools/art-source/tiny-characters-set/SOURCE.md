# Tiny Characters Set — 원본 아트 소스

`assets/sprites/avatar.png` 의 원본. `tools/import-avatar.mjs` 가 이 파일만 읽어 아바타 시트를 생성한다.

## 출처 / 라이선스

| 항목 | 값 |
|---|---|
| 팩 이름 | Tiny Characters Set |
| 제작자 | Fleurman |
| 라이선스 | **CC0 1.0 (Public Domain)** — 귀속 불필요, 상업 이용·개작·재배포 가능 |
| 원본 URL | https://opengameart.org/content/tiny-characters-set |
| 파일 | `tiny_characters_set.png` (20,274 bytes) |
| SHA-256 | `9317b8d33378921e78a3a46e18bbcdfaf9824d1b7f06ce80b7ab1e026f1b38d6` |

취득 경로: 사내망에서 opengameart.org 가 차단되어 있어 **wsrv.nl 이미지 프록시**를 경유해 내려받았다.
프록시는 전송만 담당하고 픽셀을 재인코딩하지 않았음을 아래 검증으로 확인했다(알파값이 `{0,255}` 2종뿐 —
리샘플링·손실 압축이 끼었다면 중간 알파값이 생긴다).

라이선스가 CC0 이므로 이 파일을 저장소에 그대로 커밋해 둔다. 외부 다운로드 없이 임포터를 재실행할 수 있고,
원본 사이트가 막히거나 사라져도 파이프라인이 살아남는다.

## 왜 `assets/` 가 아니라 `tools/art-source/` 인가

`client/vite.config.ts` 가 `publicDir` 를 `../assets` 로 잡는다. 즉 `assets/` 아래 전부가 브라우저에 서빙되고
`client/dist` 에 그대로 실린다. 24종 캐릭터가 다 들어있는 원본 시트를 배포 이미지에 실을 이유가 없으므로,
소스는 빌드 입력만 모아두는 `tools/art-source/` 에 두고 산출물만 `assets/` 로 내보낸다.

## 시트 구조 (실측 검증됨)

- 크기 **288×256**, 16px 네이티브 픽셀 아트 → **18×16 칸** 그리드
- 캐릭터 1명 = **3열 × 4행 블록**(48×64px) → 총 **24블록**(가로 6 × 세로 4)
- **행 = 방향**: `row0 Down / row1 Right / row2 Up / row3 Left`
- **열 = 프레임**: `col1` = idle, `col0`/`col2` = 좌우 스텝 포즈
  (좌우 대칭 복사가 아니라 각각 따로 그려져 있음 → 둘 중 하나를 생략하거나 미러링으로 대체할 수 없다)
- 블록 `(bx,by)` 의 시작 칸 = `(bx*3, by*4)`

검증 근거(취득 직후 실측):

- 크기 288×256 일치
- 알파 채널 값이 **`{0, 255}` 2종뿐** — 반투명 픽셀 없음, 프록시 재인코딩 흔적 없음
- 불투명 색상 **232종** (+ 완전 투명 배경)
- **24블록 전체의 SHA-256 이 서로 고유** — 리컬러 중복이나 복제 캐릭터가 하나도 없음

## 사용 중인 블록

`tools/import-avatar.mjs` 의 `SKINS` 가 이 중 4개만 쓴다 (`AVATAR_SKIN_COUNT = 4`).

| skin id | 블록 `(bx,by)` | 캐릭터 |
|---|---|---|
| 0 | `(0,0)` | 갈색 롱헤어 / 빨강 상의 |
| 1 | `(3,0)` | 금발 / 녹색 튜닉 |
| 2 | `(2,0)` | 적발 트윈테일 / 파랑 원피스 |
| 3 | `(5,2)` | 어두운 피부 + 아프로 / 핑크 상의 |

4종 모두 **원본에 따로 그려진 별개 캐릭터**다. 이전 Ninja Adventure 파이프라인에 있던 리컬러 복제
(`ninja_blue` 를 crimson 으로 치환해 4번째 스킨을 만들던 로직)는 제거됐고, 임포터가 매 실행마다
스킨 4종의 픽셀 해시가 서로 다른지 검사해 리컬러가 되살아나지 못하게 막는다.

## 재생성

```
cd code
node tools/import-avatar.mjs                 # 기본 소스 = 이 폴더의 PNG
node tools/import-avatar.mjs <다른-시트.png>  # 소스 교체 시
```

결정적(deterministic) 생성이다 — 난수도 타임스탬프도 없어서, 같은 소스로 몇 번을 돌려도
`assets/sprites/avatar.png` 의 바이트가 완전히 동일하다.
