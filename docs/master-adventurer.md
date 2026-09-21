# Master adventurer 제작·적용 기록

기준일: 2026-09-22. `R01`은 **IN PROGRESS**다. skin 0의 현재 기본 이미지는 `cd8af86`의 AI 생성 `baram-adventurer.png`다. 바람의나라 원본 사용 허가는 확보하지 않았으며, 현재 이미지는 원본 또는 동일 품질의 재현물이 아니다. 허가된 대체 원화는 반입하지 않았고 두 번째 생성 후보도 적용하지 않았다. native pixel 규격·비례의 사용자 승인과 60프레임 master·24종 스킨 제작은 남아 있다.

## 구현 계약

[masterAvatar.ts](../client/src/world/masterAvatar.ts)를 [avatarArt.ts](../client/src/world/avatarArt.ts)의 `AVATAR_REPLACEMENTS`에 등록한다. 기존 catalog의 skin 0만 교체하며 legacy manifest도 fallback용으로 보존한다.

| 항목 | 현재 값 |
|---|---|
| runtime texture | `/sprites/baram-adventurer.png` |
| source·표시 크기 | texture 1254×1254px, 4×4의 313×313px frame, 표시 48×48px |
| 행 순서 | Down / Left / Right / Up |
| 열 순서 | idle / 걷기 포즈 1 / 걷기 포즈 2 / 걷기 포즈 3 |
| 발 기준점 | frame별 `foot`, x=156; y는 Down `[305,305,305,305]`, Left `[302,300,304,300]`, Right `[296,296,296,296]`, Up `[274,280,280,280]` |
| 대기 | column 0, 반복 없음 |
| 걷기 | columns `[1, 2, 3, 2]`, 프레임당 62.5ms, 반복 |
| 미제작 동작 | attack / cast / hit / death는 idle fallback |

manifest의 `format: "native60"`은 기존 계약 식별자다. 이 asset의 해상도나 제작 프레임 수를 나타내지 않는다. 현재 atlas는 16개 frame이며 전용 공격·시전·피격·사망 원화는 없다. 48px는 표시 크기이며 native pixel 제작 완료를 뜻하지 않는다. runtime origin은 frame별 `foot / rect`로 계산한다.

## 2026-09-22 검증 현황

`avatar-manifest.spec.ts`는 현재 경로·313px crop·404 mock·프레임별 foot 검증에 맞춰 갱신되었다. 2026-09-22 로컬 재실행 결과: `npm test -- avatar-manifest.spec.ts` **13 passed (25.2s)**, client typecheck·build 통과.

이전 `heritage-first-play` 2개 테스트 중 KeyH 귀환 단계에서 1개가 실패했다. 원인은 `[needs verification]`이며 해결 또는 전체 회귀 통과로 처리하지 않는다.

## Legacy 제작 원본과 재생성

이전 `master-adventurer.png`의 원본은 [pixels.json](../tools/art-source/master-adventurer/pixels.json)의 palette와 프레임별 pixel grid다. [prepare-master-avatar.mjs](../tools/prepare-master-avatar.mjs)가 이를 native pixel 그대로 atlas에 배치한다. 이 소스와 compiler는 legacy 제작 자료로 보존하며 현재 기본 `baram-adventurer.png`를 생성하지 않는다. 아래 비교 이미지도 이전 48px master 자료다.

repo root에서 `node tools/prepare-master-avatar.mjs`로 atlas와 비교 이미지를 만든다. `node tools/prepare-master-avatar.mjs --check`는 원본으로 재생성한 결과와 파일의 byte equality를 검사한다. 도구는 프레임 순서·발 위치·중복 프레임·분리된 픽셀·palette를 검사한다.

- [atlas 1x](art/master-adventurer-atlas-1x.png), [atlas 4x](art/master-adventurer-atlas-4x.png)
- [기존 외형 비교 1x](art/master-adventurer-comparison-1x.png), [기존 외형 비교 4x](art/master-adventurer-comparison-4x.png)

비교 이미지는 왼쪽에 기존 heritage idle, 한 셀 간격 뒤 오른쪽에 master의 네 포즈를 배치한다. 행은 Down / Left / Right / Up이고 금색 선은 각 셀의 y=46이다. checker 배경은 검토용 이미지에만 도구가 합성한다.

## 2026-09-16 제작·검증 이력과 남은 승인

아래 기록과 SHA-256은 당시 `master-adventurer.png`에 대한 결과이며 현재 기본 이미지의 품질 승인이나 최신 회귀 결과가 아니다. 시대 reference 픽셀 대조·사용자 외형 승인·허가된 원화 확보는 여전히 남아 있고 원본과의 동일 품질을 보장하지 않는다.

built-in `image_gen`으로 기존 heritage reference를 활용한 후보를 만들었다. checker 배경·큰 머리 비례·반복 포즈 때문에 최종 atlas로 채택하지 않았으며, native pixel grid를 별도로 구성했다. 후보·prompt·미공개 생성 metadata는 [SOURCE.md](../tools/art-source/master-adventurer/SOURCE.md)에 기록한다.

시대 reference의 [DC 원문](https://m.dcinside.com/board/baram/707700)은 이번 세션에서 제목 `해독의 귀걸이 이거 비싼거임?`, 게시 시각 `2010.11.30 21:43:33`, 첨부 `Baram010.jpg` 링크를 확인했다. 스크린샷 픽셀 자체의 시대 비례 대조는 `[needs verification]`이다. [Ruliweb reference](https://m.ruliweb.com/game/3052/read/3554819)는 이번 조회에서 Internal Error여서 `[needs verification]`이다. 시대 reference pack 승인 완료로 취급하지 않는다.

client typecheck와 Vite build가 통과했다. shared manifest 26개와 browser 16개(기존 회귀 10개, master·picker·공격 4개, 실제 맵 UI 2개), 총 42개 검증이 통과했다. 기본 catalog의 4방향 이동·idle 복귀·NPC·선택창·공격 효과와 이미지 누락 시 동일 skin의 legacy fallback을 확인했다.

`node tools/prepare-master-avatar.mjs --check`는 atlas와 비교 이미지 5개의 byte equality를 확인했다. 최종 atlas는 16개 고유 48px 프레임, 불투명 팔레트 20색, binary alpha, 발 기준점 `(24, 46)`이며 고립 픽셀 검사를 통과했다. runtime PNG와 build 배포 산출물의 SHA-256은 모두 `f411e6c28da0de3cab0d63a2d0d659737ea207fc76760c96baa4497bd175b06d`다.

[실제 광장 화면](art/master-adventurer-game.png)을 현재 PC에서 촬영하고 새 master의 표시와 발·이름 정렬을 확인했다. 최종 코드 검토에서 발견된 결함은 없다. Vite의 기존 500kB chunk 경고는 남아 있다. 다음 판단은 1x/4x와 맵 화면에서 비례·방향·발 위치를 비교한 사용자 시각 승인이다. 운영 배포는 수행하지 않았다. Git 반영은 사용자 요청에 따라 이 문서와 함께 `main`에서 commit·push하며, 실제 반영 이력은 Git 기록을 따른다.
