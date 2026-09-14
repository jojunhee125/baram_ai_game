# 캐릭터·스킨 픽셀 제작 규격

상위 계획: [MMORPG 로드맵](roadmap.md). 기준일: 2026-09-14.
사용자가 확정한 시각 기준은 **2009–2010년 PC 바람의나라**다.
R01/R02/R06의 규격안이며 asset 제작·Higgsfield 인증·유료 생성 완료 기록이 아니다.
모든 UI·시각 적용과 화면 확인은 **현재 PC**에서 수행한다.

## 1. 현재 asset과 방향

기존 avatar는 16px CC0 원화를 2배 확대한 32px 셀이다. 24종 × 4방향 × 3포즈이며 atlas는 96×3072다.
단순 48px 표시로 native 도트 정보가 생기지는 않는다. [import-avatar.mjs](../tools/import-avatar.mjs)
skin 0은 362×362 source cell을 48px로 표시하며 origin `(0.5, 0.96)`을 쓴다. 나머지는 32px, `(0.5, 1)`이다.
제작 격자·발 기준점·비례부터 통일한다. [heritageArt.ts](../client/src/world/heritageArt.ts)
이동은 3개 고유 포즈의 4프레임 루프, skin 0 공격은 방향당 3프레임이다. 새 계약은 이 경로와 공존한다. [playerSprites.ts](../client/src/world/playerSprites.ts)

## 2. 시대 reference pack

- 날짜/출처가 확인된 시대 화면에 URL·확인 날짜·해상도·확대 여부를 기록한다.
- 정면/좌/우/후면, 기본 복장/장포/갑옷, 칼/지팡이, 밝은/어두운 배경을 대표 표본으로 둔다.
- 리마스터·모바일 화면을 혼합하지 않는다. 시기가 불명확하면 `[needs verification]`으로 표시한다.
- 캐릭터와 타일을 함께 crop해 상대 크기를 비교한다. 확대된 화면으로 native 크기를 단정하지 않는다.
- 기준 원본·현재 캐릭터·후보를 같은 발 기준선에 놓은 **1x와 nearest 4x contact sheet**를 만든다.
- 1x에서 필드 가독성·실루엣, 4x에서 얼굴 점·외곽선·색 단계·흔들림을 확인한다.
- 반투명 overlay는 비례/anchor 비교용이다. 원본과 픽셀 값 동일 여부로 합격을 결정하지 않는다.
- 당시 표현 규칙을 따르는 독자 asset을 제작하고 reference와 생성/수정 결과를 구분한다.

## 3. Golden master

**native 48×48 transparent RGBA는 후보**다. 현행 표시 크기에서 출발했으며 당시 게임 원본 규격이라는 뜻이 아니다.
R01 reference 비교 후 확정한다. 미결정 수치는 `[needs verification]`으로 남긴다.

| 항목 | 기록할 규칙 | 승인 조건 |
|---|---|---|
| 몸/머리 | 불투명 bbox, 머리 bbox, 어깨폭, 머리:몸 비율 | 4방향 같은 인물, 시대 표본에 맞는 비례 |
| 얼굴 | 눈/코/입 pixel 위치·색·방향별 노출 | 확대 얼룩 없이 1x에서 읽힘 |
| 외곽선 | 명암별 outline 색·허용 두께 | 의도하지 않은 이중선·반투명 경계 없음 |
| 팔레트 | 피부/머리/의상/금속 ramp·색 목록 | 피부/광원 일치, 의상별 제한 팔레트 |
| 그림자 | 발 아래 중심·범위·opacity·layer 여부 | 이동과 지면 접점 일치 |
| 발 anchor | canvas 정수 pixel 좌표·tile 기준 위치 | 방향/의상 교체에 지면 위치가 튀지 않음 |
| 손 anchor | 방향/동작/frame별 손 위치·무기 grip | 공격/시전 중 장비 분리 없음 |
| 여백/bbox | 몸체/무기 범위·effect canvas | 잘림 없음, 충돌 범위와 구분 |

표시 확대는 정수 배율·nearest를 기본으로 한다. 임의 축소·antialias로 native 표현을 흐리지 않는다.
격자에서 정리한 master를 기준으로 삼는다. 고해상도 생성 이미지의 단순 축소를 완성본으로 취급하지 않는다.
의도하지 않은 단독 잡점·색 번짐·반투명 테두리를 정리한다. 장식은 1x에서 읽힐 때 남긴다.

## 4. 방향·동작 계약

방향은 기존 `Down, Left, Right, Up`을 유지한다. atlas 배치와 재생 배열은 manifest에 명시한다.
단순 mirror는 무기 손과 의상 비대칭을 바꿀 수 있으므로 방향별 승인 프레임을 사용한다.
현재 skin 0의 좌우 포즈 교차 index 보정을 복제하지 않고 source 방향을 정상화한다. [heritageArt.ts](../client/src/world/heritageArt.ts)

| 동작 | 방향당 계획 프레임 | 순서/판정 |
|---|---:|---|
| idle | 1 | 기준 몸체·발 위치 |
| walk | 4 | 왼발 접지→중간→오른발 접지→중간 |
| attack | 3 | 준비→타격 표현→회수 |
| cast | 3 | 준비→발동 표현→회수 |
| hit | 1 | 반응; 이동/사망과 우선순위 명시 |
| death | 3 | 반응→쓰러짐→정지; 마지막 pose 유지 |

**4 × 15 = 60프레임/master** 계획이다. 48px 확정 시 단순 10×6 배치는 480×288이며 padding은 별도다.
packer 배치가 달라도 named frame·foot/hand anchor를 보존한다.
idle/walk부터 완성하고 나머지 동작을 추가한다. 미제작 동작에는 명시된 legacy/fallback을 사용한다.
재생 시간은 manifest/config에 두고 서버 cooldown·발동과 연결한다. 생성 영상 길이가 전투 시간을 결정하지 않는다.
현행 공격 10fps/300ms·이동 16fps는 새 최적값으로 확정한 것이 아니다. [playerSprites.ts](../client/src/world/playerSprites.ts)

## 5. Layer와 24종

1. master 1종의 몸체·anchor를 확정한다.
2. 평상복·중갑·장포 3종으로 모든 방향/동작의 가림을 확인한다.
3. 머리·복장·색의 승인 조합으로 기존 24개 ID를 단계 교체한다.
4. 무기·투구부터 실제 장비 외형을 연결하고 나머지는 표현 필요에 따라 추가한다.

기본 분리는 몸체, 얼굴/머리, 머리카락, 상의/장포, 무기, 투구, 그림자다.
긴 머리·장포·무기는 필요하면 앞/뒤 mask를 나눈다. 후면 무기를 무조건 몸 앞에 그리지 않는다.
방향·동작별 layer order와 head/hair/body/robe/weapon/helmet occlusion을 manifest에 기록한다.
스킨은 같은 몸체 규칙·anchor와 의상별 palette를 공유한다. 무작위 recolor만으로 24종을 채우지 않는다.
skin ID를 재번호화하지 않는다. 기존 12프레임과 새 60프레임 version을 함께 읽는 adapter부터 도입한다.
누락 asset/동작은 승인 fallback으로 표시하고 기존 DB의 skin 선택을 유지한다.

## 6. Higgsfield 연결과 제한된 batch

공식 안내는 코딩 agent에 CLI + Skills를 권장한다. 계정 credits를 쓰며 웹 Unlimited/무료 생성 혜택은 연결 생성에 적용되지 않는다. [공식 연결 안내](https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-access-higgsfield-via-cli)
공식 CLI는 Windows 설치와 이미지·영상·배경 제거 등 제작 기능을 제공한다. 우선 사용처는 캐릭터/의상 후보 이미지다. [공식 CLI](https://github.com/higgsfield-ai/cli)
reference·캐릭터 재사용은 보조 수단이며 정확한 pixel·방향·프레임 일치를 보장하지 않는다. [공식 Skills](https://higgsfield.ai/skills)
현재 세션의 연결·인증은 미검증이다. 앞선 확인에서 노출 도구와 CLI PATH가 확인되지 않았으므로 별도 확인한다.

1. 현재 PC의 설치·버전·인증을 확인하고 가능한 읽기 전용 방법으로 credit 잔액을 확인한다.
2. 선택 모델의 입력/출력·예상 비용을 확인한다. 알 수 없는 가격을 추정 숫자로 채우지 않는다.
3. reference pack과 요구사항을 확정한다. 여기까지 실제 생성 없이 준비할 수 있다.
4. 별도 생성 착수 시 **후보 최대 3장 × 1회**, 선택한 **1장 수정 × 1회**를 첫 batch 상한안으로 쓴다.
5. 채택본을 native pixel로 정리한 후 방향/포즈를 제작한다. 추가 생성은 기존 결과와 비용을 보고 범위를 정한다.

흐름: reference → 제한된 후보 → pixel 정리 → 정확한 frame/anchor/palette → PNG atlas + manifest → 현재 PC 승인 → 의상 확장.
첫 투자는 플레이 sprite다. 3D·장편 cinematic·대량 보스 영상은 master와 첫 플레이 루프 뒤에 둔다.
완성 asset만 게임에 넣으며 gameplay 중 AI 요청을 발생시키지 않는다.
batch마다 prompt, model/version, 날짜, reference 출처, job ID, 예상/실제 credits, 파일, 채택/반려 이유를 기록한다.
출력과 승인 prompt를 cache한다. 한 frame 오류 때문에 전체 스킨을 반복 생성하지 않는다.
계정 기능 보유와 이번 세션의 인증·생성 성공은 구분한다.

## 7. 전달·성능·완료

- 원화·native PNG·palette·atlas·manifest·1x/4x 비교표·제작 출처를 함께 보관한다.
- manifest에는 version·skin ID·native size·named frames·duration·anchors·layer order·fallback을 포함한다.
- 정적 의상은 offline 합성, 동적 장비는 변경 시 cache한다. 매 프레임 합성하지 않는다.
- 현재 지역/사용 외형 중심으로 preload하고 cache 크기·해제 시점을 정한다.
- PNG 용량과 디코딩 RGBA 메모리를 구분한다. GPU 메모리·FPS 개선은 측정 전 단정하지 않는다.
- 문서·단순 asset 교체에 자동 테스트·전체 build를 실행하지 않는다. 제작 비교표와 현재 PC 화면으로 판단한다.
- R01은 reference/master/native 규격, R02는 동작/layer, R06은 24개 ID 결과를 각각 승인한다.
- 문서 승인·후보 생성·게임 적용·Git push를 구분하고 수행한 단계만 완료로 기록한다.
