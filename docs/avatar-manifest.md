# Avatar manifest와 legacy adapter

로드맵 R01의 첫 실행 항목. 기존 24개 skin ID를 유지하는 shared/offline 계약과 Phaser runtime 연결을 구현했다.
실제 master 제작·시각 승인·24종 외형 통일은 후속 작업이다.

## 계약

- `version: 1`은 manifest schema 버전, `format`의 `legacy12`와 `native60`은 asset 형식이다.
- `nativeSize`, 실제 atlas의 frame `rect`, 게임의 `displaySize`를 구분한다.
- `foot`은 frame 안의 좌표다. `foot.x / rect.width`, `foot.y / rect.height`로 기존 origin을 표현할 수 있다.
- 방향은 `Down, Left, Right, Up`. 동작은 `idle, walk, attack, cast, hit, death`다.
- 각 clip에 named frame·재생 시간·반복 여부를 기록한다. 미제작 동작은 명시적 fallback을 사용한다.
- 현재 layer는 합성된 `composite` 하나다. 손 anchor와 장비 layer 제작은 후속 R02 범위다.

## 기존 asset 호환

| 대상 | 원화/셀 | 표시 | 발 기준점 |
|---|---|---|---|
| skin 1–23 | native 16×16 → atlas cell 32×32 | 32×32 | (16, 32) |
| skin 0 | 고해상도 source cell 362×362 | 48×48 | (181, 347.52) |

skin 0의 `nativeSize`는 현재 source cell 크기를 기록한 호환값이며, 검증된 pixel 제작 격자가 아니다.
소수점 foot은 기존 origin `(0.5, 0.96)`을 보존한 값이다. 새 master의 정수 anchor 승인과 구분한다.
skin 0의 좌우 교차 frame 보정은 legacy에만 남긴다. 새 asset에는 이 보정을 적용하지 않는다.

미제작 동작은 manifest에 지정한 동작으로 대체한다. 요청 clip의 texture가 없으면 같은 skin ID의 legacy 동작을 조회한다.
legacy texture도 없으면 `null`을 반환한다. 다른 ID로 바꾸거나 저장된 skin 선택을 수정하지 않는다.

## Offline 사용

`code` 폴더에서 `npx tsx tools/avatar-manifest.ts`를 실행하면 24개 manifest와 실제 PNG 3개의 header 크기·frame 범위를 검사한다.
JSON이 필요하면 `npx tsx tools/avatar-manifest.ts --output avatar-manifests.json`을 사용한다. 기본 실행은 파일을 쓰지 않는다.
새 manifest는 shared의 `validateAvatarManifest`로 검사하고, `resolveAvatarClip`으로 동작 및 동일 ID legacy fallback을 조회한다.
이 CLI는 현재 legacy asset 검사·내보내기용이며 임의의 새 PNG를 가져오는 importer는 아니다.

## Client runtime 연결

[avatarArt.ts](../client/src/world/avatarArt.ts)의 `AVATAR_REPLACEMENTS`가 새 manifest 등록 위치다.
현재 배열은 비어 있으며 24개 ID 모두 legacy manifest를 사용한다. 승인된 manifest를 등록하면 해당 ID의 primary로 사용하고 같은 ID의 legacy를 보관한다.
`createAvatarCatalog`로 catalog를 만들고 `createAvatarArt`로 Phaser loader·named frame·animation을 준비한다.

- `WorldScene`이 texture를 preload하고 실제 이미지 크기·frame 범위를 확인한 뒤 clip을 cache한다. 업데이트마다 manifest를 다시 검증하지 않는다.
- `PlayerSprites`가 manifest의 방향·clip 시간·표시 크기·프레임별 발 anchor를 사용한다. 이동·회전·skin 변경·warp·제거·scene 종료 시 공격 상태를 정리한다.
- 전용 공격 clip이 없거나 명시적으로 idle로 fallback하면 기존 일반 공격 효과를 사용한다. 대기·걷기 표시도 해결되지 않으면 기존 boot error 경로로 중단한다.
- NPC와 선택기는 플레이어와 같은 catalog의 Down idle을 사용한다. NPC skin 0은 이제 플레이어·선택기와 같은 heritage 외형과 발 기준점으로 표시된다.
- 선택기는 manifest의 실제 frame 영역을 64px preview 안에 표시한다. 이미지 실패 시 동일 ID legacy를 조회하며, 닫힌 선택기의 비동기 callback은 화면을 수정하지 않는다.

새 texture 실패 시 다른 ID로 바꾸지 않는다. 기존 24개 선택 번호·키보드 조작·저장된 skin ID를 유지한다.
runtime은 native60 fixture를 처리하지만 실제 새 atlas는 등록하지 않았다. 시전·피격·사망의 게임 이벤트 연결과 장비 layer는 후속 범위다.

## 다음 단계

새 60프레임 규격은 방향당 대기 1·걷기 4·공격 3·시전 3·피격 1·사망 3을 계획한다.
테스트용 frame 데이터는 실제 제작된 PNG가 아니다. 다음 실행 항목에서 reference·master를 확정하고 승인된 idle/walk atlas와 manifest를 registry에 등록한다.
R01은 master 비례·발 기준점·native 규격 승인을 기다리는 IN PROGRESS다. R06의 24종 통일도 완료 처리하지 않는다.

## 2026-09-15 검증 기록: shared/offline 단계

- R01 첫 실행 항목: shared manifest·legacy adapter·offline CLI 구현.
- manifest 테스트 26개 통과: 24개 ID, legacy 방향/anchor, synthetic native60, 누락 texture·동작 fallback, 잘못된 참조·범위·순환 검사.
- `npm run typecheck` 통과, `npm run build` 성공(84 modules). 기존 500kB 초과 chunk 경고는 남아 있다.
- Offline 검사: 24개 manifest·실제 PNG 3개 통과. JSON export의 결정성 및 잘못된 CLI 인자 실패 확인.
- 기존 `npm test` 935개 통과. 이 실행 당시 신규 shared suite는 별도 실행했으며, 이후 shared `test` script를 추가해 표준 workspace 실행에 연결했다.
- commit·push·배포 미실행. 실제 게임 외형 변경·시각 승인 미실행.

## 2026-09-15 검증 기록: runtime 연결 단계

- 신규 browser 테스트 11개, live skin 변경·room hop smoke 2개, manifest API로 이관한 기존 공격 회귀 1개 통과: 총 14개.
- 기존 24개 skin × 4방향의 96개 legacy pixel 비교에서 차이 0. native fixture의 360ms 공격 완료·프레임별 anchor·동일 ID fallback·NPC·preview·선택기 검증 통과.
- shared 테스트 26개, client 및 E2E TypeScript 검사 통과.
- client build 성공: 85 modules, 5.42s. 기존 500kB 초과 chunk 경고 유지.
- 새 master 원화 제작·시각 승인·24종 외형 통일·commit·push·배포 미실행.
