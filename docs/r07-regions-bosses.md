# R07 테마 지역·단계 보스 — 설계·구현·검증

[로드맵](roadmap.md) R07의 단일 문서. 남문·들판·굴·숲, 1~30 성장 지역, 원작 사냥터 교체까지의 지역 콘텐츠 기록. 굴→숲 퀘스트·첫 보스 예고는 [R06 문서](r06-gear-progression.md)의 병렬 코드 묶음 절에 있다.

## 성장·사냥터·남문 홈 격차 점검

> 원본: `review-2026-09-22-classic-world-gap.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

> **과거 작업 기록:** 당시 남문 구현은 `5eb0f33`으로 저장한 뒤 main에 통합했다. 후속 숲·실DB·성장 검증 `ac70d3f`, 가방 비교 `e7b01d5`, 상점 비교 `a8fbcb0`도 origin/main에 push 완료했다. 아래 미구현·미검증·branch 표기는 당시 범위이며 현재 정본은 [메모리](../PROJECT_MEMORY.md)와 [로드맵](roadmap.md)이다. 운영 배포는 미수행이다.

> **2026-09-22 상태 갱신:** 이 문서 본문은 묶음 구현 전의 격차 점검 기록이다. 아래의 미구현·미승인 표기는 점검 당시 기준이며 현재 작업 상태를 뜻하지 않는다. 남문 홈, 초기 장비 구매·전리품 판매, 들판·굴 차별화는 구현 및 검증을 마쳤다. 실제 변경 사항, 검증 결과와 남은 작업은 [구현 기록](r07-regions-bosses.md)을 기준으로 확인한다. 커밋·푸시·배포는 수행하지 않았다.

### 요청과 범위

사용자는 전체 레벨 시스템 점검, 사냥터 다양화, 부여성 남쪽 스타일의 최초 홈을 요청했으며 현재 바람의나라와의 격차가 크다고 지적했다. 이번 작업은 코드와 자산을 점검하고 첫 구현 범위를 구체화하는 단계다. 전체 월드 재구축이나 성장 수치 변경은 아직 구현하지 않는다.

Git 기준은 main/origin/main `297e7bafacef989478cb938e6add65b918b544b6`. 이전 도사 치유 테스트·KeyH 조사 문서 변경은 보존한다. 처음 최상위 docs에 작성한 검토를 사용자 요청에 따라 Git 저장소의 이 문서로 옮겼다. 최신 실행 계획은 [로드맵](roadmap.md), 인계 요약은 [프로젝트 메모리](../PROJECT_MEMORY.md)를 따른다. 본문 코드 경로의 `code/`는 상위 프로젝트 기준이다.

### 핵심 진단

통신·저장·UI 기능이 동작하는 것과 RPG로서 목표한 경험을 제공하는 것은 별개다. 다음 우선순위는 자동 테스트 수 확대보다 '성문에서 출발해 사냥하고, 얻은 보상으로 강해져 다음 지역으로 가는 경험'을 완성하는 것이다. 실제 레벨·콘텐츠·맵 구조의 연결을 기준으로 완료를 판단한다.

#### 성장 수치

`code/shared/src/leveling.ts`에서 레벨 상한은 30, 다음 레벨 경험치는 `round(20 * level^1.7)`, 레벨당 HP +10·공격 +1이다. 누적 경험치가 저장된 값이므로 기존 곡선을 바꾸면 기존 플레이어의 표시 레벨도 재해석된다. 상한만 늘리거나 기존 경험치를 일괄 증폭하기 전에 기존 계정 처리 방침을 정해야 한다.

| 목표 레벨 | 누적 EXP | 사슴 EXP 3만으로 올릴 때 처치 수 |
|---|---:|---:|
| 2 | 20 | 7 |
| 5 | 425 | 142 |
| 10 | 3,226 | 1,076 |
| 20 | 22,521 | 7,507 |
| 30 | 68,881 | 22,961 |

표는 코드의 식을 그대로 계산한 값이다. 사슴만 처치하고 다른 EXP·사망 손실이 없다는 가정이며 실제 소요 시간 측정이 아니다. 저레벨이 사슴을 안전하게 잡는다는 뜻도 아니다.

`code/server/src/rooms/monsterDefinitions.ts`의 일반 몬스터는 다람쥐·토끼·사슴이고 EXP는 1·2·3이다. 숫자상 레벨 구간을 열어 둔 것에 비해 다음 구간을 담당할 일반 사냥 콘텐츠가 얕다. 초반 성장을 늦춘 결정은 기존 요구로 존중하되, 낮은 보상 구간을 반복하게 만드는 방식과 구분해야 한다.

#### 성장·보상 연결의 실제 공백

독립 소스 감사에서 다음을 확인했다. 테스트로 재현한 결함 목록이 아니라 현재 구현 정책과 콘텐츠 공백이다.

- EXP·드롭은 지역이 아닌 MonsterKind에 연결된다. 두 지역에서 같은 토끼·보스를 잡으면 보상이 같고, 굴 차이는 사슴과 갑옷 드롭 정도다(`monsterDefinitions.ts`, `metaverseRoom.ts:2395`).
- 장비 수치는 적용되지만 무기는 단검 하나이며 단검·갑옷은 저확률 드롭에 의존한다. 단검 공격 +2, 갑옷 피해 감소 20%, 투구 15%는 실제 반영된다. 레벨·직업별 착용 해금은 없다(`itemDefinitions.ts:75`, `metaverseRoom.ts:2241,2461`).
- 퀘스트는 다람쥐 3마리·50전 한 건, 상점 판매품은 약초뿐이다. 도토리·당근·구리 동전·중복 단검은 판매 불가라 반복 사냥으로 장비 구매 자금을 마련하는 연결이 없다(`questDefinitions.ts:93`, `shopDefinitions.ts:46`, `metaverseRoom.ts:2049`).
- 직업당 스킬 하나를 처음부터 쓰고 레벨별 해금은 없다. EXP·드롭·퀘스트 처치는 마지막 타격자 기준이므로 회복·방어 기여가 협동 성장 보상으로 연결되지 않는다(`classes.ts:67`, `metaverseRoom.ts:2372`).
- EXP의 지속 저장은 동일 SSO 계정과 PostgreSQL 환경에 의존한다. 비인증 세션과 인메모리 모드에서는 장기 성장을 보장하지 않는다. 사망은 현재 방 home 복귀, HP/MP 회복, 누적 EXP 1% 차감이며 레벨 하락은 막는다. 만렙 이후 EXP 적립도 계속된다. 이 정책을 수정 결함으로 단정하지 않는다(`metaverseRoom.ts:687,3300`, `server/src/index.ts:57`, `progressStore.ts:101`).

#### 최초 홈과 미술

현재 지역 안내는 plaza를 '마을 광장/만남의 공간', 사냥터를 '초보 사냥터·1굴', 두 번째 방을 '숲 안쪽·2굴'로 정의한다(`code/client/src/ui/regionGuide.ts`). 기본 접속과 H 귀환은 부팅 방을 기준으로 한다(`code/client/src/net/roomTarget.ts`).

맵 담당 독립 분석의 구체적 근거:

- plaza는 전체 64×35타일, 내부 32×18타일의 분수 중심 대칭 광장, 시작점 (31,20)이다(`definitions.ts:9`, `generate-plaza.mjs:106`).
- 남문 (31~32,25)은 grand-plaza로, 첫 사냥터는 북문으로 연결된다(`portalDefinitions.ts:18`). 최초 홈을 남문 거점으로 바꾸려면 이름 변경이 아니라 포털과 보행 동선을 바꿔야 한다.
- 두 사냥터 내부는 각각 40×24·32×20이며 중앙 폭 2타일 직선길과 흩어진 장애물 구성이 유사하다(`generate-hunting-ground.mjs:86`, `generate-hunting-den.mjs:86`).
- 일반 몬스터는 배회·추격·공격 AI를 공유한다. 현재 차이는 주로 배치·수치다(`server/src/game/monsterAi.ts:151`).
- 맵 ground/collision과 큰 환경 장식의 클라이언트 좌표표가 분리돼 있다. 맵·충돌·장식·포털·NPC를 함께 맞춰야 한다(`client/src/world/heritageArt.ts:20,67`).

실제 `classic-village-ground.png`와 `heritage-environment.png`를 열어 확인했다. 전자는 네 종류 바닥, 후자는 건물·나무·바위·문 형태의 소수 자산이다. 현재 자산의 확대·재배치만으로 남문·성벽·거리·건물군의 시각적 차이를 충분히 만들 수 있다고 보기는 어렵다. 성문 폭, 벽의 반복 단위, 문 뒤 거리, 건물 문턱과 충돌, 캐릭터 대비 높이를 함께 설계해야 한다. 이번에는 현재 게임 실행 화면과 원작 화면의 픽셀 대조까지 수행하지 않았다.

### 첫 구현 제안 — 남문 홈과 첫 성장 구간

아래는 설계 제안이며 바람의나라 원본 배치나 수치를 그대로 재현한 명세가 아니다.

1. **남문 홈**: 최초 화면에 남문·성벽·성 안쪽 길·성 밖 길이 읽히게 구성한다. 귀환 지점은 몬스터와 문 전환 판정에서 떨어진 안전 지점으로 통일한다. 안내 NPC·회복/소모품 상점·첫 장비 획득 지점을 실제 보행 동선에 배치한다.
2. **초기 성장**: 우선 Lv1~10 구간의 처치 수·처치 시간·회복 비용·보상·스킬 사용을 직업별로 점검한다. Lv30 전체를 완성했다고 주장하지 않는다. 현재 곡선을 바꿀지, 지역 보상을 추가할지 계산 결과로 정한다.
3. **사냥터 세 단계**: 초보 들판 → 좁은 굴 → 위험한 숲으로 구성한다. 각 지역에 지형·몬스터 행동·보상·다음 장비 목표의 차이가 있어야 한다. 단순 색 변경과 HP 증가는 완료 조건이 아니다.
4. **첫 장비 보상**: 사냥 결과가 무기/방어구 교체와 실제 처치 횟수 변화로 이어지게 한다. 장비 단계·직업 조건·획득 경로를 함께 정한다.

### 구현 순서와 완료 기준

- 1차: 남문 홈의 실제 게임 화면, 충돌·입구·귀환을 먼저 완성하고 출발 화면의 시각 기준을 확인한다.
- 1차의 명시적 승인 대상: 기존 plaza ID를 보존하면서 남문 중심 첫 홈으로 재배치하고, 시작/귀환 안전점·남문과 초보 사냥터 연결·안내/상점 위치·미니맵/지역 안내를 함께 맞춘다. 필요한 성문/성벽/거리 자산과 큰 장식 좌표를 포함한다. 장기 성장 곡선·다른 지역 대량 추가·계정 데이터 재계산은 이 단계에 포함하지 않는다. grand-plaza 기능은 유지하되 이동 입구를 새 레이아웃에서 명시한다.
- 2차: 첫 두 사냥 구간과 Lv1~10 보상/장비 흐름을 연결한다. 최소 한 번의 장비 교체와 다음 사냥터 이동 이유를 플레이로 확인한다.
- 2차의 첫 경제 연결 후보: 첫 퀘스트 → 단검 확정 구매 → 일반 전리품 판매 → 갑옷·다음 지역 진입 목표. 기존 정산 계약을 사용하되 가격·필요 처치 수는 먼저 계산하고 재접속·중복 정산 검증을 포함한다.
- 3차: 세 번째 사냥터와 직업별 성장 보정을 연결하고 이후 레벨 확장을 결정한다.

첫 20~30분은 제안하는 플레이 점검 단위이며 Lv10 도달 시간의 확정 약속이 아니다. 경험치·전투 시간은 현재 코드 데이터로 비교한 후 목표를 정한다. 테스트 통과와 별개로 남문 화면·캐릭터 동작·전투 가독성은 실제 화면으로 확인한다.

### 원작 reference 확인 한계

기존 목표였던 2009~2010 PC 버전을 기본 기준으로 삼는다. 검색에서는 현대 PC, 바람의나라: 연, 메이플월드 클래식 자료가 섞여 나왔다. [넥슨 사이트의 2018년 남쪽 관련 질문·스크린샷](https://baram.nexon.com/BaramKin/View/2076?sc=3)은 목표 시대보다 늦고 사용자 게시물이므로 2009~2010 부여성 남쪽의 정확한 배치를 확정하는 근거로 쓰지 않는다. 원작과의 상세 시각 대조에는 사용자가 기준으로 삼는 화면 또는 시기가 확인된 추가 reference가 필요하다.

### 추가 사용자 요구 — 사냥터별 드롭 차별화

사용자는 현재 몬스터 드롭의 중복이 심하며 사냥터가 늘어나면 해당 지역에 맞는 아이템이 나와야 한다고 지적했다. 이 요구는 사냥터 다양화의 완료 조건에 포함한다. 단순히 같은 드롭의 확률이나 수량만 조절하는 것으로 충족했다고 판단하지 않는다.

다음은 구현 전 설계 제안이다.

- 몬스터 고유 드롭: 가죽·이빨 등 해당 몬스터와 연결되는 재료.
- 사냥터 전용 드롭: 지역별 장비·제작 재료·퀘스트 아이템. 같은 몬스터 종류라도 지역별 보상을 구분할 수 있어야 한다.
- 공통 드롭: 화폐·회복품 중심으로 제한하되 구체 목록·확률은 지역 난도와 경제 흐름을 보고 정한다.
- 보스 드롭: 다음 장비 단계나 지역 진입에 연결되는 고유 목표를 둔다.
- 데이터 구조 후보: 몬스터 기본 테이블 + 사냥터별 테이블. 합산/대체 규칙, 중복 아이템 처리, 확률·수량·평균 획득량은 구현 전에 명시한다. 아직 이 구조를 구현하거나 최종 확정하지 않았다.
- 각 아이템에 판매·착용·퀘스트·제작 중 실제 용도를 지정한다. 제작 기능이 없는 단계에서 제작 재료 이름만 추가해 쓸모없는 드롭을 늘리지 않는다.
- 완료 확인: 지역별 드롭 목록·획득 경로·용도·장비 단계가 구분되고, 서버 지급 결과와 클라이언트 드롭 안내가 일치해야 한다. 공통 테이블과 지역 테이블의 결합으로 의도하지 않은 중복 지급·과잉 보상이 생기지 않는지 검증한다.

요구사항 기록은 완료했으며 구체 아이템 목록·수치·코드 구현은 미확정이다.

### 검증 상태

코드·자산 읽기와 성장식 계산을 수행했다. 이번 작업에서 production 코드 수정, 새 테스트, build, 게임 실제 플레이, commit·push·배포는 수행하지 않았다. 레벨 시스템 무결성 전체 검증이나 최종 밸런스 검증 완료 보고가 아니다.

## 남문·초기 성장·사냥터 묶음 구현 계약

> 원본: `design-2026-09-22-south-gate-progression.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

> **과거 작업 기록:** 당시 남문 구현은 `5eb0f33`으로 저장한 뒤 main에 통합했다. 후속 숲·실DB·성장 검증 `ac70d3f`, 가방 비교 `e7b01d5`, 상점 비교 `a8fbcb0`도 origin/main에 push 완료했다. 아래 미구현·미검증·branch 표기는 당시 범위이며 현재 정본은 [메모리](../PROJECT_MEMORY.md)와 [로드맵](roadmap.md)이다. 운영 배포는 미수행이다.

> **2026-09-22 상태 갱신:** 사용자가 여러 작업의 묶음 진행을 승인한 뒤 이 계약의 남문 홈, 초기 장비 구매·전리품 판매, 들판·굴 차별화를 구현하고 검증했다. 아래 설계·승인 대기 표현은 구현 전 계약 수립 당시의 기록이다. 실제 구현 범위, 검증 결과 및 남은 제한은 [구현 기록](r07-regions-bosses.md)을 따른다. 커밋·푸시·배포는 수행하지 않았다.

상태: 2026-09-22 사용자의 여러 항목 묶음 진행 승인에 따른 구현 설계. 구현·검증 결과는 [구현 기록](r07-regions-bosses.md)에 별도로 남긴다. 기준 HEAD는 `297e7ba`, 작업 branch는 `feat/south-gate-progression`이다.

### Task Plan: 남문과 Lv1–10 성장 연결

- Phase 0 Design → architect: 현재 room/아이템/전투/지도 생성 구조 확인, 아래 계약 확정.
- Phase 1 Implementation → ui-engineer: 남문·들판·굴 지도와 client 표시. coder: 지역별 몬스터·보상·상점·AI. **parallel: yes; file_overlap: 없음**. 소유 파일 추가가 필요하면 main이 먼저 조정한다.
- Phase 2 Verification → tester: 지도 연결·안전 거리, 지역별 실제 보상과 API 일치, 장비 구매·장착·재접속·중복 정산, browser 화면과 실제 이동 확인.
- Phase 3 Review → reviewer: 계약·기존 자료 보존 확인. guardian: 판매 가능한 장비 추가에 따른 정산/장착 동시성 검토.

#### 파일 소유권과 입출력

기존에 존재하는 아래 파일들을 수정 대상으로 확인했다. `client/src/**`는 UI 담당 범위이며 필요 파일만 수정한다. 모든 상대 경로는 Git 저장소 `code/` 기준이다.

| 단위 | Agent / 입력 | 출력 파일·모듈 | 의존 |
|---|---|---|---|
| 남문 및 사냥터 지형 | ui-engineer / 아래 좌표 계약 | `tools/generate-plaza.mjs`, `tools/generate-hunting-ground.mjs`, `tools/generate-hunting-den.mjs`, `assets/maps/plaza.json`, `assets/maps/hunting-ground.json`, `assets/maps/hunting-den.json`, `client/src/world/heritageArt.ts` | 설계 |
| 이동·NPC·지역 이름 | ui-engineer / 기존 ID 보존 | `server/src/rooms/definitions.ts`, `portalDefinitions.ts`, `interactableDefinitions.ts`, `landmarkDefinitions.ts`, `shared/src/landmarks.ts`, `client/src/ui/regionGuide.ts` | 좌표 계약 |
| 가방·드랍·무기 표시 | ui-engineer / 아이템 키 및 API 계약 | `client/src/net/lootTable.ts`, `client/src/ui/lootTablePanel.ts`, `inventoryPanel.ts`, `client/src/world/weaponVisual.ts`; 필요 시 동일 client 범위의 연관 화면 | 계약 확정; server 완료 전 병렬 가능 |
| 지역 몬스터와 경제 | coder / 아래 수치·불변식 | `server/src/rooms/monsterDefinitions.ts`, `itemDefinitions.ts`, `shopDefinitions.ts`, `questDefinitions.ts`, `lootTableView.ts`, `metaverseRoom.ts`, `server/src/game/monsterAi.ts`, `items.ts`, `server/src/server.ts` | 설계 |
| 회귀 및 증거 | tester / 구현 완료 코드 | 위 모듈의 기존 `*.test.ts`, `client/e2e/tests/`의 관련 기존 spec 및 필요한 신규 regression spec | 양 구현 완료 |
| 기록 | main | `docs/implementation-2026-09-22-south-gate-progression.md`, `docs/roadmap.md`, `docs/decisions.md` | 실제 변경·검증 결과 |

`server/src/rooms/contracts.ts`와 `shared/src/protocol.ts`는 현재 설계상 변경 불필요하다. 필요해지면 coder 소유로 추가하며 UI 담당에게 알려야 한다. tester 외 담당자의 test 수정은 main이 경계를 배분한다. 사용자의 기존 미커밋 변경은 유지한다.

### Design Decision: 기존 두 사냥 지역으로 연결

Options: 1) 신규 숲 room까지 추가 — 세 테마를 갖추지만 room 등록·지도·portal·landmark·boss 지속성·검증 면적이 늘어난다. 2) 기존 들판/굴을 먼저 완결 — 기존 ID·두 hunting room의 인원 제한·계정 데이터를 유지하면서 남문→사냥→판매→장비 교체 흐름을 완성할 수 있다.

Decision: **2**. 이번 묶음은 남문 홈, 두 사냥 지역의 지형·행동·보상 차이, Lv1–10의 장비 목표를 구현한다. 세 번째 위험한 숲은 후속이며 이번 결과를 세 테마 완성으로 표현하지 않는다. 기존 SSO gateway/500 CCU PoC를 검증했다고 주장하지 않는다.

### 남문 좌표 계약

plaza 전체 64×35와 내부 x16..47/y8..25 유지. 최초 spawn 및 H 귀환의 plaza 내부 지점은 `(31,20,radius0)`. room ID 및 landmark ID는 유지한다. H의 기존 시작 room 의미도 유지하여 `?room=` 검증 진입을 깨뜨리지 않는다.

| 항목 | 최종 좌표/대상 |
|---|---|
| `plaza-south-door` trigger | `(31,25)`, `(32,25)` → hunting-ground `(35,30,r0)` |
| `plaza-north-door` trigger | `(31,8)`, `(32,8)` → grand-plaza `(22,9,r0)` |
| `hunting-ground-south-door` 복귀 | 기존 trigger 유지 → plaza `(31,23,r0)` |
| `grand-plaza-north-door` 복귀 | 기존 trigger 유지 → plaza `(31,10,r0)` |
| `plaza-hunting-ground-npc` | `(29,22)`, nonblocking, 남문·첫 사냥 안내 |
| `plaza-shop-npc` | `(35,20)`, nonblocking, 약초·장비·전리품 판매 안내 |
| 기존 안내물 | link `(17,23)`, notice `(44/45,23)`, quiz `(47,8)` 유지 |

남쪽 성벽의 지면 footprint는 y24, x17..28 및 x35..46. 열린 문은 x29..34이고 중앙 거리와 남쪽 출구를 연결한다. x16 측면 길은 유지하고 남쪽 문이 주동선으로 보이도록 표현한다. 기존 분수 중심 대칭 구도를 제거하고 건물·장사 공간·성벽을 구성한다. 모든 큰 장식의 지면 footprint와 실제 충돌은 일치해야 한다. 통과 가능한 문 위쪽 지붕은 보행자와 높이 기준을 맞춘다.

들판은 넓은 초지와 길, 굴은 암반 띠와 연결된 두 공간으로 구조를 구별한다. 단순 색상/장애물 tile ID 교체만으로 지형 완성 판정을 하지 않는다. 기존 두 hunting room의 portal, join spawn, landmark 좌표는 유지한다. 모든 통로는 2타일 이상이며 greedy AI를 가두는 오목한 막다른 길을 만들지 않는다. 생성 script와 JSON, client 장식, server 좌표를 함께 검증한다.

### Design Decision: 지역별 몬스터 정의

Options: 1) monster kind를 지역마다 추가 — 기존 sprite·quest kind·wire mapping 전체를 확장해야 한다. 2) 현재 kind를 유지하고 room별 유효 type map을 해석 — 표시·quest 연속성을 보존하면서 전투/보상을 지역별로 바꿀 수 있다.

Decision: **2**. 기본 `MONSTER_TYPES`의 기존 HP·EXP·loot 값은 유지한다. 최초 들판의 EXP1/2/3이라는 기존 초반 성장 결정도 유지한다. 변경은 명시적 room override에만 둔다.

Interface: `server/src/rooms/monsterDefinitions.ts`의 기존 type을 아래 형태로 확장하고, coder가 구현한다.

```ts
export type MonsterBehavior = "aggressive" | "timid";

// Existing MonsterType fields remain unchanged.
export interface MonsterType {
  behavior?: MonsterBehavior; // omitted = existing aggressive behavior
}

export function monsterTypesForRoom(
  roomName: string | undefined,
): ReadonlyMap<MonsterKind, MonsterType>;
```

이 블록은 기존 interface에 추가할 계약이며 기존 필드를 지우는 재선언 지시가 아니다. 알려지지 않은 room/undefined는 기본 map을 반환한다. resolver는 기본 type이나 기본 loot 배열을 mutate하지 않는다. 같은 room의 동일 kind에는 하나의 유효 type만 존재한다. `MetaverseRoom.monsterTypes()`가 resolver를 사용하되 현재 test subclass override seam을 유지한다. runtime의 `type` 하나가 HP·행동·EXP·loot를 모두 제공하고 `buildLootTableView(roomName)`도 같은 resolver를 사용한다. 부팅 시 각 등록 room의 유효 map과 spawn을 검증하여 override의 잘못된 item key/확률/EXP가 누락되지 않게 한다.

| 지역/kind | HP / EXP | 행동·수치 변경 |
|---|---|---|
| 들판 squirrel | 기존 12 / 1 | timid, 플레이어를 피함. flee step 1000ms로 player 600ms보다 느림 |
| 들판 rabbit | 기존 19 / 2 | 기존 공격·추격 유지 |
| 기본 deer | 기존 28 / 3 | 원래 값 유지 |
| 굴 rabbit | 48 / 20 | aggressive, aggro3, damage9, chase400ms, attack800ms |
| 굴 deer | 80 / 32 | aggressive, aggro3, damage13, chase600ms, attack1200ms |
| boss | 기존 5000 / 600 | 공격·respawn6시간·지속성·ID·위치 모두 유지 |

timid도 기존 Hold/Step action을 사용하고 새 wire enum은 추가하지 않는다. 감지 거리2 이내에서 플레이어 반대 방향으로 움직이되 모든 후보는 leash 안쪽으로 제한한다. 공격 action을 반환하지 않는다. step 대기 중·갈 곳이 없는 벽 모서리에서는 Hold하며, 무한 왕복이나 map 외부 이동을 허용하지 않는다. 안전한 상대축 후보가 있으면 그쪽으로 피할 수 있다. 플레이어가 따라잡을 수 있어야 하므로 더 빠른 flee나 무적 상태를 도입하지 않는다.

#### 굴 도착 안전 보정

aggro 확대만 적용하면 기존 ordinary wander radius3의 일부가 도착 spread에 접근한다. 굴 일반 몬스터의 wander radius는 모두1로 바꾸고 `hd-rabbit-04`는 `(26,20)`에서 `(25,19)`로 옮긴다. boss wander3는 그대로다. UI 지도는 `(25,19)`를 비워둔다. 전체 join spread `(30..32,23..25)`, portal arrival `(31,26)`, death home `(31,24)`에 대해 `Chebyshev(spawn,arrival) > wanderRadius + aggroRadius`를 확인한다. portal trigger 안전성도 별도로 검사한다.

### Design Decision: 성장·상점·드랍

Options: 1) 누적 EXP 곡선 자체를 완화 — 기존 계정의 표시 레벨을 재해석하고 초반 성장 결정도 바꾼다. 2) 기존 곡선과 초반 보상을 보존하고 강화된 지역 보상과 장비 판매 경로를 추가 — 기존 데이터 migration 없이 다음 지역에 갈 이유를 만든다.

Decision: **2**. `shared/src/leveling.ts`는 변경하지 않는다. Lv cap30, EXP threshold, 클래스 배율/스킬, 50전 첫 사냥 quest 보상도 유지한다. 첫 사냥 문구의 북쪽을 남쪽으로 수정한다. 새 장비는 전 직업 공용이며 level/class 착용 제한은 없다. Lv 안내는 추천 구간이고 입장 조건은 기존 entry-pass이다.

| 아이템 key | 용도 / icon | 구매 | 판매 |
|---|---|---:|---:|
| acorn | 기존 전리품 | — | 4 |
| carrot | 기존 전리품 | — | 6 |
| copper-coin | 기존 전리품, 자동 재화 전환 아님 | — | 8 |
| herb | 기존 HP30 회복 | 12 | 기존3 |
| old-dagger | 기존 weapon 공격+2 | 40 | 10 |
| hunting-blade | 사냥꾼 검, weapon 공격+6 / old-dagger | 180 | 45 |
| iron-blade | 철검, weapon 공격+10 / old-dagger | 480 | 120 |
| padded-armor | 누비옷, armor 피해감소15% / leather-armor | 100 | 25 |
| reinforced-armor | 강화 가죽갑옷, armor 피해감소30% / leather-armor | 300 | 75 |
| den-fur | 굴짐승 털, 판매용 / acorn | — | 10 |
| antler | 단단한 뿔, 판매용 / carrot | — | 18 |

새 장비/전리품은 일반 stack item으로 두고 `possession:true`를 붙이지 않는다. 기존 leather-armor20%, golden-helmet15%, entry-pass의 possession 성격 및 이전 소유권은 유지하고 판매 대상으로 만들지 않는다. 장착 중인 장비 판매 거절을 유지하고 판매/장착이 겹치는 실제 경로를 검토한다. 모든 판매 가격은 구매 가격 미만이며 새로운 가격·stat 값도 부팅 validation 범위에 포함한다. 재료라는 이름만 있고 쓰임이 없는 새 아이템은 만들지 않는다.

지역 loot는 **기본 table과 합산하지 않는 전체 대체**이다. 각 entry는 독립 Bernoulli이고 한 table 안에 중복 itemKey를 허용하지 않는다. 다음 수량은 모두1이다.

| 대상 | 실제 loot |
|---|---|
| 들판 전체 | 기본 `MONSTER_TYPES` table 그대로 |
| 굴 rabbit | den-fur75%, copper-coin25%, herb10%, hunting-blade3% |
| 굴 deer | antler70%, copper-coin35%, herb15%, reinforced-armor3%, iron-blade2% |
| 굴 boss | golden-helmet25%, iron-blade50%; EXP600 유지 |

두 지역에서 같은 rabbit을 잡아도 드랍 목표가 다르다. 기존 boss 장비는 유지하면서 굴 boss에는 최종 초기 무기 획득 경로를 더한다. 상점 구매가 확정 경로이며 boss나 희귀 드랍을 얻어야만 성장할 수 있는 구조가 아니다.

#### 수치 근거와 한계

기존 계산식은 `round((4 + level - 1 + equipmentAttack) * classMultiplier)`, 기본 공격 간격600ms다. 아래는 이동·스킬·miss·회복을 제외한 단일 대상 정지 계산이며 실플레이 시간 측정이 아니다.

| Lv3 직업 | 단검+2 → 사냥꾼 검+6 → 철검+10 공격력 | 굴 rabbit48HP 타격 수 | 굴 deer80HP 타격 수 |
|---|---|---|---|
| 전사 | 7 → 11 → 14 | 7 → 5 → 4 | 12 → 8 → 6 |
| 도적 | 10 → 14 → 19 | 5 → 4 → 3 | 8 → 6 → 5 |
| 주술사 | 10 → 16 → 21 | 5 → 3 → 3 | 8 → 5 → 4 |
| 도사 | 6 → 10 → 13 | 8 → 5 → 4 | 14 → 8 → 7 |

첫 quest의50전은 단검40전을 확정 구매할 수 있다. 전리품을 전부 판매할 때 kill당 기대 수입은 들판 squirrel4.64전, rabbit6.76전, 굴 rabbit11.15전, deer20.50전이다. 예: 굴 deer는 `0.7*18 + 0.35*8 + 0.15*3 + 0.03*75 + 0.02*120 = 20.50`. 첫 획득 장비를 착용하거나 약초를 쓰면 실제 현금 수입은 이보다 적다. 확률은 구매 보장이 아니며 각 개인의 편차가 있다.

들판에서 squirrel:rabbit=7:3으로66회 사냥하면 평균85.8EXP·348.2전이며 Lv3 threshold85를 넘는다. 이후 굴 rabbit:deer=1:1로121회면 평균3146EXP가 추가되어 합계3231.8EXP로 Lv10 threshold3226을 넘는다. 이는 약187회라는 비교 모델이며, 이동·드랍 편차·몬스터 분포·사망·스킬·동시 이용을 반영한 시간 보장은 아니다. 단검→사냥꾼 검→철검의 두 교체와 방어구 구매가 그 과정에 들어갈 수 있다.

기존 약초 가격12전/HP30 및 out-of-combat 회복은 변경하지 않는다. 최종 balance 판정은 클래스별 짧은 실플레이로 보완하고 Lv30 완성이나 20–30분 내 Lv10을 보장하지 않는다.

### Client/API 계약

기존 `/api/loot-table/:roomName`의 `monsters` envelope와 unknown room의 빈 배열 동작 유지. 다음 additive fields를 server와 client에 함께 반영한다.

```ts
export interface LootTableDropView {
  itemKey: string;
  name: string;
  icon: string;
  chancePercent: number;
  quantity: number;
  sellValue?: number;
}
export interface LootTableMonsterView {
  kind: string;
  name: string;
  expReward: number;
  drops: readonly LootTableDropView[];
}
```

Client는 EXP·수량·판매가를 서버 결과에서 표시한다. 오래된 optional field가 없는 응답을 수용할지는 UI 담당이 결정하되 오표시는 없어야 한다. bag의 기존 `EQUIPMENT_ITEM_SLOTS`에 네 새 장비 key를 추가하고 weapon visual이 새 weapon도 인식하도록 한다. 기존 atlas를 재사용할 수 있지만 아이템 이름과 stats/장착 결과는 구별되어야 한다. 지역명은 남문 마을 / 초보 들판(Lv1–3) / 바위 사냥굴(Lv3–10), 안내는 실제 south gate와 entry-pass 경로를 설명한다.

### 검증 계약

- `npm run typecheck`, `npm test`, `npm run build` 결과를 기록한다. 각 지도 generator 실행 및 생성 결과 일치, spawn·portal·NPC reachability, 도착·boss 안전거리와 camera invariant를 검사한다.
- 유효 몬스터 table에 잘못된 loot key/확률/중복 key/EXP가 있으면 boot 실패. room A 해석 후 B/기본 map 불변. 실제 kill의 EXP/loot와 API의 동일 room 값 일치. 기본 EXP1/2/3과 boss600 고정 확인.
- timid의 도주 간격·벽/모서리·leash·죽음/respawn·추격 가능성을 pure AI regression으로 확인한다. 굴 도착 spread에서 일반 몬스터/보스 즉시 aggro가 없는지 전체 좌표로 검사한다.
- 첫 quest→단검 구매→장착→전리품 판매→다음 무기/방어구 구매. 부족 잔액, 가방 full, nonce replay, 동일 장비 구매, 장착 중 판매·장착/판매 경쟁, 재접속의 계정 결과를 확인한다. In-memory 검증과 실제 PostgreSQL 검증을 구분한다.
- browser에서 최초 남문 화면, shop 접근, 두 방향 portal 왕복, H 귀환, grand-plaza 접근, 지도별 지형 차이, 드랍 정보와 새 장비 장착을 확인한다. 사용자 기존 변경을 수정했다고 오해할 만한 test 전체 덮어쓰기를 금지한다.

### 설계 자체 검토

기존 계정 EXP/아이템 key·boss 지속성과 보상600을 보존한다. 신규 migration·세 번째 room·class/level 착용 gate 없이 기존 시스템 조합으로 한정한다. 지역 table이 runtime·API·boot 검증 중 일부에만 반영되는 실패, spawn aggro 확대, 장비 판매 경쟁, 잘못된 아이콘/장착 키, 장식과 충돌 불일치를 필수 검증 대상으로 분리했다. 배포는 이번 설계나 테스트 통과만으로 완료 처리하지 않는다.

## 2026-09-22 남문 홈·성장·사냥터 통합 구현 기록

> 원본: `implementation-2026-09-22-south-gate-progression.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

> **과거 작업 기록:** 당시 남문 구현은 `5eb0f33`으로 저장한 뒤 main에 통합했다. 후속 숲·실DB·성장 검증 `ac70d3f`, 가방 비교 `e7b01d5`, 상점 비교 `a8fbcb0`도 origin/main에 push 완료했다. 아래 미구현·미검증·branch 표기는 당시 범위이며 현재 정본은 [메모리](../PROJECT_MEMORY.md)와 [로드맵](roadmap.md)이다. 운영 배포는 미수행이다.

### 승인과 목적

사용자는 다음 코드 작업을 요청한 뒤 남문 홈 단일 범위 확인에 대해 “하나씩 작업하지 말고 여러개 묶어서 진행 시작해라”라고 지시했다. 이에 최신 로드맵의 남문 홈, Lv1~10 성장·장비 획득 연결, 지역별 지형·행동·보상 차별화를 하나의 구현 묶음으로 착수한다. 단계별 추가 승인 없이 설계·구현·관련 검증까지 진행한다.

기존 EXP 곡선과 저장된 계정 데이터, 왕초보 몬스터 EXP 하향 및 보스 600 EXP 결정을 보존한다. 기존 정산·상점·장비 시스템을 활용하고, 지역 전용 아이템은 판매 또는 장착 등 실제 용도를 가진다. 정확한 2009~2010 원작 배치 재현이나 최종 미술 승인을 자동 테스트로 대체하지 않는다.

### 시작 상태

- 실제 Git 저장소: `code/`.
- `git fetch origin` 성공. HEAD와 origin/main, merge-base는 모두 `297e7bafacef989478cb938e6add65b918b544b6`.
- 작업 branch: `feat/south-gate-progression`.
- 기존 r05 E2E·로드맵·결정·아트 문서 및 미추적 조사/메모리 변경을 보존한다.

### 상태

통합 구현, 독립 코드·보안 검토, 최종 회귀 검증을 완료했다. commit·push·배포는 수행하지 않았다. 설계는 [구현 계약](r07-regions-bosses.md)을 참고한다.

### 변경 전 성장·경제 점검

독립 tester가 실제 `MetaverseRoom.totalAttack/totalMaxHp`와 기존 콘텐츠를 읽고 산출했다. 일반 공격 간격은 600ms이며 아래는 Lv1/Lv5/Lv10의 무장비 공격력이다: 전사 4/7/12, 도적 5/10/16, 주술사 5/10/17, 도사 3/6/10. 공격 횟수는 `ceil(몬스터 HP / 공격력)`, 첫 명중부터 처치까지 시간은 `(횟수-1)*0.6초`다. 이동·리젠·스킬·네트워크를 제외한 산식이므로 실제 성장 시간이나 직업 종합 밸런스로 해석하지 않는다.

Lv5 누적 EXP 425, Lv10 3,226은 유지한다. 기존 약초는 구매 12전/판매 3전/회복 30 HP다. 일반 전리품의 판매가 없어 약초만 판매할 경우 처치당 환금 기대값이 다람쥐 0.24전, 토끼 0.36전, 사슴 1.5전이었다. 첫 퀘스트 50전 이후 장비 구매 목표가 없던 공백을 이번 묶음에서 연결한다.

변경 전 검사: `npm run typecheck` 3 workspace 통과. `server/`에서 `npx tsx --test --test-timeout=90000 src/rooms/shopSystem.test.ts src/rooms/monsterDefinitions.test.ts src/rooms/levelSystem.test.ts src/rooms/lootTableView.test.ts` → 89 pass / 0 fail. 이것은 변경 전 기준이며 구현 후 검증을 대신하지 않는다.

### 실제 구현 범위

- 남문 홈: plaza ID·시작점(31,20)을 유지하고 성벽·문루·거리·가옥 및 실제 충돌을 구성했다. 남문은 초보 들판, 북쪽 길은 기존 대광장으로 연결한다. 안내 NPC와 상점, 지역명·미니맵도 함께 맞췄다.
- 지형: 초보 들판의 열린 교차로와 바위굴의 암벽 띠를 구분했다. 생성기와 map JSON을 함께 수정했다. 세 번째 위험한 숲은 이번 구현에 포함하지 않았다.
- 성장·경제: 첫 사냥 보상 50전과 기존 성장식을 유지한다. 단검 40전, 누비옷 100전, 사냥꾼 검 180전, 강화 가죽갑옷 300전, 철검 480전의 구매 경로를 추가하고 일반 전리품을 판매 가능하게 했다. 기존 아이콘/무기 렌더링을 재사용하며 새 아이템의 장착·능력치·판매가를 화면에 연결했다.
- 지역 보상: 들판 EXP1/2/3 및 보스600을 유지한다. 굴 토끼48HP/20EXP, 사슴80HP/32EXP와 지역 전용 털·뿔·장비 테이블을 적용했다. 지역 테이블은 기본 드롭과 합산하지 않고 전체 대체하며 runtime/API/boot 검증이 동일 resolver를 사용한다.
- 행동: 들판 다람쥐는 플레이어보다 느린 도주형, 굴 몬스터는 강화된 추격형이다. 굴 도착 구역의 안전거리를 맞춰 배회 범위/배치를 조정했다.

### 중간 검증 및 수정 중 발견

- UI 담당: client typecheck·build 통과. 기존 큰 bundle 경고 유지. 맵 생성 self-check 3개 통과: 연결된 walkable tile 498/860/584, 사냥맵 좁은 통로 0.
- UI 브라우저 smoke: 남문/들판/굴 pageerror0, 900px/1920px 화면 확인. main이 남문·굴 PNG를 직접 열어 화면을 확인했다. 이미지 위치 `client/e2e/test-results/world-screens/`는 테스트 산출물이며 Git 영속 기록은 아니다. 이 검사는 실제 포털 왕복이나 성장 루프 완주를 대신하지 않는다.
- backend 담당: 초기 관련 회귀149/149, workspace typecheck 통과. 이후 독립 tester가 새로 판매 가능해진 장비의 equip/sell 경합과 같은 계정 다른 접속의 stale 장비 cache에서 High 결함을 재현했다. 당시 저장 단계의 장착 장비 debit 거절과 접속 간 cache 정합성을 수정·검증했고 아래 최종 결과에서 통과를 확인했다. 초기149 통과만으로 이 문제의 해결을 주장하지 않는다.

### 독립 검증에서 발견하여 수정한 사항

- 장착과 판매가 같은 turn에 겹치거나 다른 접속의 장비 cache가 뒤처지면 판매 이후에도 능력치가 남는 High 결함을 재현했다. `settlementStore`는 장착 행을 debit하지 않으며 PostgreSQL에서는 행 잠금과 조건부 차감으로 보호한다. `inventoryStore`는 계정별 장비 변경을 같은 process/store의 세션에 알리고 `MetaverseRoom`은 cache와 요청 version을 갱신한다. 실제 장착 변경 기준의 응답 및 실패 rollback을 보존한다.
- 가방을 연 채 새 전리품·구매 장비를 받으면 판매 버튼이 즉시 나타나지 않는 live metadata 누락을 수정했다. `ItemGranted`의 `sellValue/consumable`을 구매·드롭 두 경로에서 전달하고 client의 새 행에 반영한다.
- guardian은 위 경합 수정의 저장소 잠금·이벤트 순서·요청 재전송·rollback을 독립 검토했다. reviewer는 지역 resolver·포털·장식 footprint·장비 표시·알림 수정 diff를 확인했고 잔여 지적 0건으로 반환했다. reviewer 직접 실행한 독립 회귀는 11 pass / 0 fail이다.

### 영향받은 주요 경로

- 지도와 렌더: `tools/generate-{plaza,hunting-ground,hunting-den}.mjs`, `assets/maps/{plaza,hunting-ground,hunting-den}.json`, `client/src/world/heritageArt.ts`, `client/src/ui/minimapTerrain.ts`, `minimap.ts`, `regionGuide.ts`, `client/src/scenes/WorldScene.ts`, `client/src/heritage.css`.
- 동선: `server/src/rooms/portalDefinitions.ts`, `interactableDefinitions.ts`, `questDefinitions.ts`, `shared/src/landmarks.ts`.
- 지역 콘텐츠·상품: `server/src/rooms/monsterDefinitions.ts`, `itemDefinitions.ts`, `shopDefinitions.ts`, `lootTableView.ts`, `server/src/game/monsterAi.ts`, `items.ts`, `server/src/server.ts`.
- 거래·동기화: `server/src/db/inventoryStore.ts`, `settlementStore.ts`, `server/src/rooms/metaverseRoom.ts`, `shared/src/protocol.ts`.
- 아이템 표시: `client/src/net/lootTable.ts`, `client/src/ui/{inventoryPanel,lootTablePanel,objectPanel}.ts`, `client/src/world/weaponVisual.ts`.
- 검증: 관련 server test fixture와 `server/src/rooms/southGateProgression.verification.test.ts`, 관련 client E2E. 기존 사용자 수정 `r05-skill-integration.spec.ts`는 이번 작업 소유 변경에 포함하지 않는다.

### 검증·운영 한계

- 실제 PostgreSQL 실행 환경이 없다: `ZEP_TEST_DATABASE_URL` 미설정, Docker command 없음, WSL 미설치. DB 행 잠금은 코드 검토·SQL test double로 검증했으며 실제 DB 동시성 검증 완료로 표시하지 않는다.
- 장착 알림은 단일 process의 공유 InventoryStore 범위다. 다중 process 배포에는 별도의 invalidation/정합성 설계가 필요하다.
- 세 번째 숲, 새 전용 장비 원화, 원작 시대 화면과의 픽셀 대조·사용자 시각 승인, 네 직업의 실제 장시간 성장/밸런스 확정은 남아 있다. 기존 아이콘과 code-native 도형을 재사용했다.
- SSO gateway와 500 CCU PoC, 실배포는 검증하지 않았다. 기존 bundle size 경고는 유지한다.

### 최종 검증 결과

중간 실패는 변경된 map/판매가/동기화/알림 필드에 대한 기존 fixture를 갱신하고 재검증했다. 아래는 최종 코드 기준이다.

| 실행 위치 / 명령 | 결과 |
|---|---|
| `code/`: `npm test` | exit0. shared26/26 + server1146/1146 = **1172 pass / 0 fail**. server37.62초. 실DB opt-in suite는 환경 미설정으로 등록되지 않으므로 report의 skipped0을 실DB 실행으로 해석하지 않는다 |
| `code/`: `npm run typecheck` | shared/server/client 모두 통과 |
| `code/`: `npm run build` | exit0, 92 modules, 4.30초. 기존 500KB bundle 경고 유지 |
| `code/client/e2e/`: `npx playwright test tests/south-gate-progression.spec.ts` | **3 passed, 26.0초** |
| `code/client/e2e/`: `npx tsc --noEmit` | exit0 |
| `code/server/`: `npx tsx --test --test-reporter=spec src/rooms/passE-combat-verification.test.ts src/rooms/passI-boss-verification.test.ts src/rooms/southGateProgression.verification.test.ts` | 80 pass / 0 fail, 1.01초 |
| `git diff --check` | 통과; CRLF 안내 외 whitespace 오류 없음 |

전체 test 로그: `%TEMP%/ksc-southgate-tests-complete.log`. 최종 browser 이미지: `client/e2e/test-results/progression-screens/{plaza,hunting-ground,hunting-den}.png`. 앞의 `world-screens`는 Playwright 재실행으로 정리될 수 있는 중간 결과이며, 위 progression-screens가 현재 결과다.

신규 server regression15개는 실제 지역별 rabbit 처치 EXP/드롭과 API 일치, 기본 정의 불변, 구매/장착/업그레이드/재접속, nonce25회·잔액 경계·가방 full, 장비 경합3경로, map BFS·굴 도착 안전거리, boot 검증, timid1734개 위치/대상 조합과 cooldown/corner/respawn, 거절 후 판매 재시도 및 live grant metadata를 다룬다.

Browser는 실제 키입력으로 상점 접근, 남문↔들판, 남문→대광장→H, 굴→들판→남문을 검증했다. 들판에서 입장권을 획득해 굴로 들어가는 전체 browser 흐름은 새 test 범위가 아니며 기존 server integration으로 검증했다. 구매 test는 첫 quest 보상과 같은50전을 직접 주입하므로 quest 수령→구매를 단일 browser 흐름으로 검증했다고 표현하지 않는다. 열린 가방의 버튼은 실제 `InventoryPanel.applyGrant` browser component test와 서버 grant metadata regression으로 나눠 검증했다. 전체 E2E suite는 실행하지 않았으며 이번 변경의 이동·상점·드롭·live inventory에 한정했다.

독립 tester/reviewer/guardian 검증과 구현 기록 저장을 완료했다. 잔여 범위는 위 검증·운영 한계와 로드맵에 남겼다.

### 후속 문서 동기화 — 2026-09-22

사용자의 최신화 확인 요청에서 roadmap 상단, 상위 HANDOFF/PROJECT_MEMORY, 저장소 PROJECT_MEMORY, 상위 roadmap 안내에 구현 미승인/미착수 표현이 남은 것을 발견하여 수정했다. 구현 전 review/design은 역사·계약 문서임을 상태 배너로 구분하고 구현 기록에 연결했다. roadmap §7의 실제 후속 후보와 최근 완료 요약도 분리했다. 현재 상태·테스트 결과·미커밋/미배포·남은 제한을 일치시켰다. 문서만 변경했으므로 코드 테스트를 재실행하지 않았다. 링크 대상 존재와 문서 상태 검색 및 git diff --check로 확인했다.

## 병렬 성장 검증과 위험한 숲 구현 계약

> 원본: `design-2026-09-22-parallel-progression.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

상태: 2026-09-22 구현 승인에 따른 설계 계약. 사용자는 직전 제안의 **성장 루프 E2E, 세 번째 위험한 숲, 실제 PostgreSQL 거래 경합 검증**을 대상으로 “병렬 코드작업 시작해라”라고 명시적으로 승인했다. 이후 모든 작업·commit·push는 `main`에서 수행하고 branch를 만들지 않도록 지시했다. main 담당자가 기존 작업을 fast-forward하여 `main == origin/main == d14ab02`로 동기화했다. 추가 기능 승인 절차는 필요하지 않다.

이 문서는 구현·검증·배포 완료 기록이 아니다. 실제 변경·실행 결과는 main 담당자가 별도 implementation 기록과 roadmap/decisions에 남긴다. 기존 EXP 곡선, 들판 EXP 1/2/3, 굴 EXP 20/32, 기존 boss EXP 600과 영속 respawn을 보존한다. DB migration, 신규 boss, 직업·스킬, SSO gateway/500 CCU PoC, 배포는 범위 밖이다.

### Task Plan: 독립된 세 작업과 숲의 두 구현 단위

- Phase 0 Design → architect: 기존 room/portal/AI/loot/store/client 경로를 조사하고 이 계약 확정.
- Phase 1 Implementation → tester(E2E) | tester(DB) | coder(숲 server) → ui-engineer(숲 map/client). **parallel: yes; file_overlap: 아래 소유권을 지키면 없음**. 가용 agent slot에 따라 coder와 UI는 순차로 시작할 수 있다.
- Phase 2 Verification → tester: 실제 browser 루프, PostgreSQL 연결 간 경합, 숲 왕복·행동·보상·map 안전거리. main: 전체 typecheck/test/build 통합.
- Phase 3 Review → reviewer, 거래·권한 수정이 발생하면 guardian. 구현 기록 저장 후 main에서 commit/push; 서버 배포 여부는 별도로 기록.

모든 경로는 Git root `code/` 기준이다. 기존 경로는 확인했고 신규 산출물은 아래에서 신규로 표시한다. 각 담당자는 다른 작업자의 변경을 되돌리지 않는다.

| 단위 / Agent | 입력·의존성 | 독점 소유 경로 / 출력 |
|---|---|---|
| 성장 루프 / tester | 기존 field·quest·shop API; 숲과 독립 | 신규 `client/e2e/tests/first-growth-loop.spec.ts`, 필요한 신규 `client/e2e/helpers/` helper. 기존 config/helper 수정은 main과 먼저 경계 조정. browser 증거·실행 결과 |
| DB 경합 / tester | 기존 PostgreSQL store; main이 실제 DB 실행 환경 확보 | 신규 `server/src/db/settlementStore.realdb.test.ts`, 필요한 신규 test helper. 경합 증거·SQL 최종 상태·실행 결과 |
| 숲 server / coder | 아래 좌표·수치 계약 | 기존 `server/src/rooms/{definitions,portalDefinitions,landmarkDefinitions,monsterDefinitions,itemDefinitions}.ts`, `server/src/game/monsterAi.ts`, `shared/src/landmarks.ts`. 기존 관련 server test 및 신규 숲 test. API 변경은 없음 |
| 숲 map/client / ui-engineer | 아래 계약; JSON 생성 후 server 통합 검증 | 신규 `tools/generate-hunting-forest.mjs`, `assets/maps/hunting-forest.json`; 기존 `tools/generate-hunting-den.mjs`, `assets/maps/hunting-den.json`; 기존 `client/src/world/{heritageArt,heritageMonsterArt}.ts`, `client/src/ui/{regionGuide,minimapTerrain,inventoryPanel}.ts`. 필요한 신규 forest browser spec |
| 통합 / main | 각 담당자 handoff | implementation record, `docs/roadmap.md`, `docs/decisions.md`, Git 동기화·commit·push, DB 실행 환경 |

coder는 map/client 경로를 수정하지 않고 UI는 server/shared 정의를 수정하지 않는다. `metaverseRoom.ts`, `server.ts`, wire protocol 및 DB production 변경은 현재 불필요하며, 실제 결함이 확인되면 main이 별도 담당자를 정한다. E2E tester가 기존 2567/5173 browser 실행을 먼저 독점하고 종료를 알려준 뒤 UI/숲 tester가 사용한다.

### Design Decision: 새 지역 연결과 재사용

Options: 1) 새 monster kind·wire schema·별도 전투 시스템을 도입 — 독자적 표현이 가능하지만 client sprite/quest/protocol/DB까지 변경 면적이 커진다. 2) 새 room·map을 기존 room별 monster resolver, item catalogue, portal/landmark에 추가 — 현재 API와 저장 데이터를 보존하고 지역별 전투·보상 차이를 구현할 수 있다.

Decision: **2**. 기존 rabbit/deer sprite를 사용하며 숲 전용 수치·행동·보상을 제공한다. 같은 스킨을 쓴다는 한계는 implementation 기록에 명시한다. room 표시 이름은 **위험한 숲**, 권장 Lv 8–15이며 level 입장 제한은 만들지 않는다.

#### 좌표·room 계약

| 정의 | 고정 값 |
|---|---|
| room name / roomType / mapKey | `hunting-forest` |
| 수용 인원 | `maxClients: 500`, `realCapacity: 20` — 기존 굴 구조 재사용, 500 CCU 검증 주장이 아님 |
| map | 64×37 tiles, 기존 camera border 유지, interior x16..47 / y8..27 |
| join/home spawn | `(31,24)`, `spreadRadiusInTiles: 1` |
| `hunting-den-forest-door` | 굴 trigger `(47,25)`, `(47,26)` → 숲 `(31,26,r0)` |
| `hunting-forest-south-door` | 숲 trigger `(31,27)`, `(32,27)` → 굴 `(46,25,r0)` |
| `landmark-hunting-forest` | name `위험한 숲 · Lv 8–15`, room `hunting-forest`, tile `(31,26,r0)` |
| 입장권 | 숲 진입 portal/landmark에 기존 `entry-pass`, 기존 안내 `입장권은 다람쥐를 잡아서 획득하세요`. 숲 탈출에는 gate 없음 |

실제 굴 JSON의 x30..47/y23..27은 모두 walkable이다. 남동쪽을 연결하면 기존 몬스터 좌표를 바꾸지 않고 새 도착지·문과 몬스터 사이 안전거리를 유지할 수 있다. 기존 굴 남쪽 출구/도착지와 모든 boss 위치는 보존한다. 굴 generator는 새 문 그림·self-check만 추가하고 기존 collision을 보존한다.

숲은 짙은 나무 군집 사이 넓은 순환 길과 사냥 공터로 구성한다. 중앙 x30..33 남쪽 동선은 열어두고 모든 walkable tile은 연결한다. 각 통로는 최소 2 tiles 폭, 나무 지면 footprint와 collision 일치, camera border 안 walkable tile 0을 검사한다. 단순 전체 tint 변경만으로 숲 지형을 완료 처리하지 않는다.

### Design Decision: 매복 행동

Options: 1) 돌진/원거리/새 상태 기계를 추가 — 표현은 크지만 action·wire·연출·cooldown 계약이 넓어진다. 2) 현재 Hold/Attack/Respawn만 사용하는 제자리 매복형을 추가 — 접근 시 공격하지만 추격하지 않아 들판의 도주형 및 굴의 추격형과 구별된다.

Decision: **2**. `ambush`는 보이는 제자리 공격형이며 은신 기능이 아니다. 일반 몬스터 분기와 기존 cooldown/respawn 처리 순서를 보존한다.

Interface: 기존 `server/src/rooms/monsterDefinitions.ts`의 type alias에 한 값만 추가한다. 아래 나머지 서명은 **현존 API 유지 계약**이며 신규 파일/추상화가 아니다.

```ts
export type MonsterBehavior = "aggressive" | "timid" | "ambush";

export function monsterTypesForRoom(
  roomName: string | undefined,
): ReadonlyMap<MonsterKind, MonsterType>;

export function decideMonsterAction(
  snapshot: MonsterSnapshot,
  nearbyPlayers: readonly MonsterTarget[],
  now: number,
  type: MonsterType,
): MonsterAction;
```

- dead이면 기존 respawn deadline 처리; alive인 ambush는 1 tile 이내 가장 가까운 상대에게만 기존 Attack을 사용한다. tie-break와 attack cooldown도 기존 규칙을 사용한다.
- 상대가 없거나 1 tile 밖이면 Idle/Hold, target null. cooldown 중 인접 상대가 있으면 Attack 상태/Hold. **Step을 반환하지 않는다.** 공격 타깃이 같은 tile인 경우도 허용한다.
- `ambush` spawn은 wander radius 0, aggro radius 1. boot validator에 enum 값을 추가하고 이 두 불변 조건을 검사한다. AI tests는 target 부재/거리2/인접/동일tile/cooldown/dead/respawn을 포함한다.
- 일반 aggressive/timid 및 기존 unknown-room fallback을 변경하지 않는다. forest resolver는 base map과 기존 field/den map/loot 배열을 mutate하지 않는다.

#### 전투·spawn 수치

아래는 초기 콘텐츠 수치이며 장시간 실플레이 균형이 검증되었다는 뜻이 아니다. 표에 없는 MonsterType 값은 기존 kind에서 상속한다.

| 숲 kind | HP / EXP | behavior | damage / attack ms | aggro / leash | chase / wander / respawn ms |
|---|---|---|---|---|---|
| rabbit | 96 / 45 | ambush | 20 / 1600 | 1 / 기존10 | 기존400 / 기존1600 / 기존12000 |
| deer | 140 / 70 | aggressive | 17 / 1200 | 3 / 기존10 | 400 / 기존2000 / 기존16000 |

상속 값은 구현 시 기존 type을 spread하며 표의 `기존` 값 때문에 base를 수정하지 않는다. rabbit/deer의 기존 원본 interval이 표와 다르면 원본을 보존하고 기록을 정정한다.

| spawn IDs | 좌표 | wander radius |
|---|---|---|
| `hf-rabbit-01` .. `04` | `(22,12)`, `(41,12)`, `(22,19)`, `(41,19)` | 0 |
| `hf-deer-01` .. `04` | `(27,12)`, `(36,12)`, `(25,18)`, `(38,18)` | 1 |

모든 spawn과 wander 범위를 map에서 열어둔다. 전체 join spread x30..32/y23..25, portal arrival/trigger, landmark/home에서 `Chebyshev(monsterSpawn, arrival) > wanderRadius + aggroRadius`를 검사한다. 새 굴 arrival/trigger도 기존 전체 spawn/boss에 대해 같은 검사를 한다. 새 boss나 영속 monster row는 추가하지 않는다.

### Design Decision: 용도 있는 보상

Options: 1) 미래 제작용 소재만 추가 — 현재 사용할 수 없어 보상 연결 요구를 만족하지 못한다. 2) 즉시 판매 가능한 전리품과 기존 cloak slot 장비 추가 — 현재 상점/가방/장착/재접속 경로를 그대로 사용한다.

Decision: **2**. 기존 catalogue 뒤에 아래 stackable item을 추가한다. `possession`은 설정하지 않는다. cloak은 기존 아이콘을 재사용하고 장착 표시는 cloak slot으로 처리한다. 신규 sprite나 제작 시스템은 만들지 않는다.

```ts
const forestItems: readonly ItemDefinition[] = [
  { key: "forest-resin", name: "숲의 수지", icon: "acorn", sellValue: 16 },
  { key: "ancient-bark", name: "오래된 나무껍질", icon: "carrot", sellValue: 28 },
  {
    key: "forest-cloak", name: "숲지기 망토", icon: "leather-armor", sellValue: 90,
    equipment: { slot: "cloak", stats: { damageReduction: 0.1 } },
  },
];
```

이 블록은 catalogue에 삽입할 row 계약이며 별도 exported collection이나 파일을 만들라는 요구가 아니다. client `EQUIPMENT_ITEM_SLOTS`에 `forest-cloak: EquipmentSlot.Cloak`만 추가한다. 기존 가방/character stat 기능을 이용한다.

구현 검토에서 최초 제안의 HP+20은 장착 변경 시 HP cap 동기화가 추가로 필요함을 확인했다. 이번 범위를 새 자원 동기화 체계로 넓히지 않고 기존 서버 계산·API 표시가 지원하는 피해 감소 10%로 확정했다. 다른 방어구와는 기존 곱연산으로 결합하며 10%p 단순 합산하지 않는다.

| 숲 kind | 전체 교체 loot table — 각 quantity 1, 독립 확률 |
|---|---|
| rabbit | forest-resin 80%, copper-coin 30%, herb 15%, forest-cloak 2% |
| deer | ancient-bark 75%, copper-coin 40%, herb 20%, forest-cloak 4% |

runtime kill과 `/api/loot-table/hunting-forest`는 같은 room resolver를 사용한다. 기존 response envelope/fields를 보존하고 EXP·수량·판매가 표시는 server 값을 따른다. 지역 안내에서 제자리 공격형·추격형, 판매 전리품과 망토, 남쪽 굴 출구를 설명한다. 숲 전용 map palette/minimap/heritage monster enable을 추가하되 old-region rendering은 보존한다.

### 성장 루프 E2E 계약

Options: 1) 기존처럼 50전/quest/loot를 주입해 UI 경로만 검사 — 빠르지만 이번 실제 획득 루프 요구를 충족하지 못한다. 2) 인증 identity만 준비하고 실제 입력과 서버 이벤트로 완주 — 시간이 길어도 획득·정산·판매·장착의 연결을 검증한다. **2 선택.**

1. 새 UUID account의 local gateway header fixture를 준비한다. 기존 `x-auth-request-access-token`의 JWT payload `sub`를 사용하며 돈·아이템·EXP·quest row는 0에서 시작한다. 실제 gateway 통과를 검증한 것으로 표현하지 않는다.
2. 남문 마을 guide `(29,22)`에서 `first-hunt`를 실제 버튼으로 수락, 남문을 걸어 들판 진입, 실제 Space 공격으로 squirrel 3마리 처치. 도주형을 추격하고 필요 시 실제 추가 사냥으로 판매 가능한 전리품을 얻는다. RNG 결과는 서버에서 관찰하고 고정하지 않는다.
3. `quest:updated`와 reward/currency 이벤트, tracker/balance로 완료와 50전 지급을 관찰한다. 이 구현의 보상은 완료 즉시 자동 정산이므로 없는 수령 버튼을 만들지 않는다.
4. 마을로 걸어 귀환하고 실제 가방 판매 버튼으로 획득 전리품을 판매. shop `(35,20)`에서 40전 `old-dagger`를 구매하고 weapon slot 장착. 관측한 판매 수량×sellValue로 정확한 잔액을 계산한다.
5. 같은 identity/context에서 tab을 닫고 새 tab으로 재접속. quest 정산 재발 없음, 잔액·판매 감소량·단검 수량·장착·stat 유지 확인. 단순 페이지 reload로 초기화를 가장하지 않는다.

읽기 전용 WS decode와 map collision을 이용한 경로 계획은 허용한다. Phaser 내부 상태 변경, synthetic server message, fake loot RNG, inventory/currency/quest API 응답 대체는 금지한다. 몬스터 위치 관찰이 필요하면 수신 state를 decode하거나 실제 화면을 사용한다. 제한시간/최대 사냥 수/실패 screenshot을 두고 무한 재시도하지 않는다. 새 spec은 기존 E2E와 분리하며 full suite 성공을 이 spec 성공으로 대체하지 않는다.

### 실제 PostgreSQL 거래 계약

현존 API는 다음과 같으며 production store 인터페이스 변경은 필요하지 않다.

```ts
interface SettlementEffects {
  readonly currencyDelta?: number;
  readonly items?: readonly SettlementItemGrant[];
  readonly itemDebits?: readonly SettlementItemDebit[];
}
interface SettlementStore {
  settle(grantKey: string, ownerKey: string, effects: SettlementEffects): Promise<SettlementOutcome>;
}
```

`PostgresSettlementStore(pool)`, `PostgresInventoryStore(executor).equip(ownerKey, itemKey, slot)`를 실제 독립 연결/store instance에서 실행한다. `ZEP_TEST_DATABASE_URL`이 없으면 명시적으로 skip하고 실제 DB 성공으로 보고하지 않는다. 기존 `runMigrations`를 사용하며 새 revision은 필요하지 않다. test 전용 schema/고유 owner·grantKey로 격리하고 자신의 데이터만 정리한다.

- 동일 판매 key 동시·순차 replay: item 1회 감소, balance 1회 증가, reward_grant 1행, replay outcome 동일.
- equip 선점 후 sale: 실제 row lock 대기를 관찰하고 sale이 equipped-item으로 거절되는지 확인. equip·item은 유지, currency/ledger는 불변.
- sale 선점 후 equip: sale commit 후 equip 실패, item 제거, equipped slot 비어 있음. `pg_backend_pid()`로 물리 연결 구분 및 `pg_stat_activity`/lock 등으로 실제 대기를 확인한다. 단순 `Promise.all`만으로 순서를 추측하지 않는다.
- 실패 원인: 부족한 item/balance 또는 뒤쪽 DB statement 실패. 앞쪽 currency/item write도 rollback, ledger 없음, 같은 key 정상 retry 성공. DB failpoint는 test schema/transaction에 제한하고 production fail hook은 추가하지 않는다.
- DB test는 저장 상태 원자성을 검증한다. runtime 장비 cache/다중 process invalidation까지 검증했다고 표현하지 않는다. 이번 코드에서 그 결함이 발견되면 별도 production 수정 소유권과 regression을 정한다.

### 검증·자체 검토

- 숲 generator self-check, 기존 굴 generator 결과 재현, room boot, portal/landmark gate, full spread 안전거리, monster resolver 불변성, 실제 kill EXP/loot/API 일치, cloak 장착·판매 거절·해제 후 판매를 검사한다.
- `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`; 새 E2E와 숲 browser 왕복; `ZEP_TEST_DATABASE_URL` 설정 실제 DB suite 실행. 실행하지 않은 검사는 이유와 함께 implementation 기록에 명시한다.
- 실패 모드 검토: map 등록 누락, client sprite enable 누락, loot 표시 불일치, gate 우회, portal 재진입 loop, spawn aggro, 제자리 AI chase 누출, old-region 값 변경, identity 분리, RNG 무한 대기, replay 중복 정산, DB lock 순서·rollback, equipped cache와 DB 검증 혼동을 각 담당자의 검사에 배정했다.
- 가장 작은 변경으로 기존 data table/AI action/store를 조합하고 신규 protocol/migration/상속 계층을 도입하지 않는다. 코드 구현 전 사용자 승인은 위에 기록했으며 모든 작업은 main에서 수행한다. 구현 후 reviewer 승인·실제 검증·implementation 기록이 남아 있으므로 이 설계만으로 완료를 선언하지 않는다.

## 2026-09-22 성장 루프·위험한 숲·실DB 병렬 구현 기록

> 원본: `implementation-2026-09-22-parallel-progression.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

### 승인·목적

사용자가 제안된 세 작업에 “병렬 코드작업 시작해라”로 착수를 승인했다. 실제 성장 흐름의 자동 검증, 세 번째 사냥 지역 구현, 실제 PostgreSQL 거래 경합 검증을 수행한다. [설계 계약](r07-regions-bosses.md)을 따른다.

### Git 및 시작 상태

- 저장소는 `code/`이며 `git fetch origin`과 `git status -sb`를 확인했다. 시작 작업 트리는 깨끗했고 기존 branch의 base는 최신 origin/main `297e7ba`였다.
- 사용자 추가 지시로 신규 branch 생성 없이 main으로 전환, 기존 두 커밋을 fast-forward한 뒤 origin/main에 push했다. 병렬 구현 기준은 main `d14ab02`다.
- 이후 변경·커밋·push는 main에서만 수행한다. 운영 배포는 별도다.

### 진행 상태

세 작업의 구현·독립 검증·통합 회귀를 완료했다. 구현 커밋 `ac70d3f`를 origin/main에 push 완료했으며 운영 배포는 수행하지 않았다. 사용자 시각 승인과 장시간 실플레이는 아래 한계대로 별도다.

### 실제 변경

- `hunting-forest`를 신규 room으로 등록했다. 굴 남동쪽 `(47,25)/(47,26)`에서 기존 입장권으로 진입하고 숲 남쪽에서 굴 `(46,25)`로 돌아온다. 지역 이동 목록에도 같은 입장권 조건을 적용한다.
- `tools/generate-hunting-forest.mjs`와 생성 JSON을 추가했다. 나무 군집 사이 순환길·공터를 구성하고 미니맵, 지역 안내, 굴 샛길 표식, 숲 지형 표현을 연결했다. 기존 굴 collision은 유지하고 출입구 두 ground tile만 바꿨다.
- 숲 토끼는 HP96/EXP45·제자리 매복, 사슴은 HP140/EXP70·추격형이다. 기존 두 지역·boss600EXP는 보존한다. 매복 AI는 인접 공격·cooldown·죽음/respawn을 재사용하고 Step을 반환하지 않는다.
- 숲의 수지(판매16전), 오래된 나무껍질(28전), 숲지기 망토(판매90전·cloak slot·피해 감소10%)를 추가했다. 실제 처치와 드롭 정보가 같은 room resolver를 사용한다. 기존 몬스터 sprite와 item icon을 재사용했다.
- 검토 중 최초 망토 후보 HP+20이 기존 장착 변경의 HP cap 동기화 공백을 활성화함을 발견했다. 새 자원 동기화 기능으로 범위를 넓히지 않고 기존 API 표시와 서버 계산이 지원하는 피해 감소10%로 확정했다. maxHp 장비 지원을 수정했다고 주장하지 않는다.
- E2E와 실DB 테스트는 독립 agent가 병렬 작성했다. 설계 agent 이후 추가 coder/UI thread 생성은 도구의 thread limit로 거절되어 main이 확정 계약에 따라 숲 production을 구현했다. 별도 context의 설계 agent가 읽기 전용 검토를 수행하고 tester가 독립 검증한다.
- 성장 E2E 최종 실행은 실제 다람쥐3마리→50전 보상→구리 동전1개 판매(+8전)→단검 구매(-40전)·장착→새 session 재접속을 완주했다. 판매 직후 실제 inventory의 수량1 감소, 재접속 후18전·전체 inventory(단검1개 장착·입장권1개 포함)·퀘스트 완료 유지, 퀘스트 보상 중복 지급 없음을 확인했다. 이전 실행의 도토리 판매14전도 통과했으며 무작위 전리품을 그대로 사용하므로 품목/잔액은 실제 획득값으로 계산한다.
- 테스트 작성 중 로컬 두 port의 CORS preflight, 포털 후 직업 선택창, 사냥 위치에 따른 충돌 경로, 저장된 외형으로 선택창을 생략하는 재접속 대기 조건을 보완했다. 공개 map의 collision을 읽는 BFS는 키입력 경로만 정하며 서버/Phaser 상태를 바꾸지 않는다. 이 과정에서 production 사냥·보상·인증 코드는 변경하지 않았다.

### 중간 검증

- 공식 [EDB Windows 바이너리](https://www.enterprisedb.com/download-postgresql-binaries)의 PostgreSQL16.15를 `C:/Temp/ksc-pg-20260922/`에 준비했다. 전용 cluster/database `ksc_parallel_test`, loopback `127.0.0.1:55432`만 사용하며 운영 DB/서비스를 변경하지 않는다.
- `ZEP_TEST_DATABASE_URL` 설정 후 실제 migration0001–0011과 신규 경합7개를 포함한 관련 DB 회귀 **187 pass / 0 fail / 0 skip**. 독립 backend PID4개와 `pg_blocking_pids`로 실제 lock 대기를 확인했다. rollback 테스트의 의도한 integer overflow22003 로그는 예상 결과다. 로그 `%TEMP%/ksc-settlement-realdb-tests.log`.
- `node tools/generate-hunting-forest.mjs`: 첫 self-check가 북쪽 1tile 통로를 거절했다. 나무 군집을 경계로 붙여 수정 후 **576 walkable·전체 연결·좁은 통로0·도착/배회 안전성** 통과. 굴 generator는 기존584 walkable 유지.
- workspace typecheck와 build 통과(92 modules,19.03초; 기존500KB bundle 경고 유지).
- 첫 전체 테스트에서 기존 catalogue 기대값2건·굴 portal 기대값1건, 이동 타이밍1건이 실패했다. fixture 갱신 및 독립 재검증 후 최종 결과를 아래에 기록한다. 이 중간 실행을 통과로 보고하지 않는다.

### 검증 및 한계

- 자동 성장 E2E는 동일 서버의 InMemory store를 실제 UUID 계정으로 이용한다. 브라우저 인증 header fixture와 로컬 CORS preflight만 준비하고 보상/아이템/EXP/퀘스트·게임 응답을 주입하지 않는다. APISIX·SSO 배포 경로 및 DB 재시작 내구성의 증거는 아니다.
- 실DB 경합 검증은 저장 상태 원자성에 대한 것이다. 다중 process 장비 cache invalidation을 구현·검증하지 않았다.
- 숲 browser 검증은 직접 room 입장으로 화면을 보고, 실제 키입력으로 굴 출구와 입장권 없는 재진입 거절을 확인한다. 입장권 보유 왕복·landmark 수용인원은 서버 통합 테스트로 검증한다. 기존 직접 room join 경로는 입장권을 강제하지 않으므로 portal/landmark 조건을 room 전체 접근 통제로 표현하지 않는다.
- 숲은 기존 토끼/사슴 sprite·기존 item icon을 재사용한다. 망토의 캐릭터 외형 layer는 추가하지 않았다. 실제 20–30분 체감 밸런스, 네 직업 장시간 플레이, 시대 reference·사용자 시각 승인, 500CCU 및 운영 배포는 이번 검증에 포함하지 않는다.
- main이 browser screenshot의 숲 도착 화면·보상표·굴 샛길을 직접 열어 확인했다. 이는 최종 아트 승인과 구분한다.
- 테스트용 PostgreSQL은 검증 후 `pg_ctl -D C:/Temp/ksc-pg-20260922/data -m fast -w stop`으로 정상 종료했다. 전용 파일은 재현을 위해 남기며 Windows service는 설치하지 않았다.

### 최종 검증 결과

| 실행 위치 / 명령·검증 | 결과 |
|---|---|
| `code/`: `npm test` | shared26 + server1156 = **1182 pass / 0 fail**, server39.09초. 실DB opt-in은 이 명령과 별도로 실행했으며 skipped0을 실DB 실행 증거로 해석하지 않는다 |
| `code/`: `npm run typecheck` | shared/server/client 통과 |
| `code/`: `npm run build` | exit0,92modules,8.39초. 기존500KB bundle 경고 유지 |
| 실제 PostgreSQL settlement/inventory/currency 회귀 | **187/187**, 신규 경합7개 포함, skip0 |
| 숲 신규·monsterDefinitions·items 검증 | **47/47**, 신규 숲9개 포함 |
| 숲·기존 지역·AI 회귀 | **58/58** |
| `server/`: `npx tsx --test --test-timeout=90000 src/rooms/metaverseRoom.integration.test.ts` | **40/40**,33.60초. 최초 전체 실행의 이동 타이밍 실패는 독립 재실행과 최종 전체 실행에서 미재현 |
| 두 map generator 재실행 및 SHA256 전후 비교 | 동일 출력, self-check 통과 |
| `client/e2e/`: `npx playwright test tests/first-growth-loop.spec.ts --output=test-results/growth-run` | **1 passed**,1.2분(testcase1.1분). 실제 획득·판매 후 persisted 수량 차감·구매·장착·계정 재접속 |
| `client/e2e/`: `npx playwright test tests/hunting-forest.spec.ts tests/pass-m-landmark-teleport.spec.ts` | **9 passed**. 숲 화면·출구·입장권 거절 및 지역 이동 회귀 |
| `client/e2e/`: `npx tsc --noEmit` | 통과 |
| `git diff --check` | exit0, CRLF 변환 안내 외 오류 없음 |

전체 테스트 로그: `%TEMP%/ksc-parallel-all-tests-final.log`. 독립 숲 로그: `%TEMP%/ksc-forest-verification.log`, `%TEMP%/ksc-forest-regression.log`. Browser 관련 **10개 통과**이며 전체 E2E suite는 미실행(변경 범위의 성장·숲·지역 이동 검증에 한정). 테스트 browser/server port2567/5173은 종료했다. Screenshot과 trace는 Playwright 산출물이며 Git 영속 자료는 아니다.

### 영향받은 경로

- 지역 정의·AI·보상: `server/src/rooms/{definitions,portalDefinitions,landmarkDefinitions,monsterDefinitions,itemDefinitions}.ts`, `server/src/game/monsterAi.ts`, `shared/src/landmarks.ts`.
- map·표시: `tools/generate-hunting-{forest,den}.mjs`, `assets/maps/hunting-{forest,den}.json`, `client/src/world/{heritageArt,heritageMonsterArt}.ts`, `client/src/ui/{inventoryPanel,minimapTerrain,regionGuide}.ts`.
- 검증: `server/src/db/settlementStore.realdb.test.ts`, `server/src/rooms/forestProgression.verification.test.ts`, 관련 catalogue/굴/monster fixture, `client/e2e/tests/{first-growth-loop,hunting-forest,pass-m-landmark-teleport}.spec.ts`.
- 기록: 본 문서, 설계 계약, `docs/roadmap.md`, `docs/decisions.md`.

## Lv1~30 후속 지역·아이템 성장 경로 보강

> 원본: `design-2026-09-23-level30-regions-items.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

### 목적과 상태

2026-09-23 사용자가 “현재 1~30 성장 경로 보강을 위해 후속 지역들을 추가하고 그에 따른 아이템을 대량으로 추가해라”고 명시 승인했다. 이 문서는 해당 구현 범위와 상태를 기록한다.

- **상태:** 범위 승인·상세 설계 확정; 구현 진행 중
- **목적:** 현재 레벨 상한 30을 유지하며 후속 사냥 지역과 지역 아이템을 추가해 레벨 1~30 성장 경로를 보강한다.
- **승인 범위:** 여러 후속 사냥 지역과 그 지역에 연계되는 다수의 아이템. 필요에 따라 지역 퀘스트, 몬스터 드롭, 제작 재료·조합, 이동 연결 및 이를 이용하는 UI를 포함할 수 있다.
- **유지 조건:** 현행 네 직업, 스킬 구성, 레벨 상한 30을 유지한다. 레벨은 지역 권장 구간이며 입장 차단 조건으로 쓰지 않는다. 기존 entry-pass 조건은 유지한다.
- **범위 경계:** 이 승인은 위 성장 경로 보강에 필요한 콘텐츠 구현을 승인한다. 문파·PvP·endgame, 레벨 상한 상향, 음성/영상 등 별도 기능은 포함하지 않는다.

### 확정 구성

- **후속 지역:** 물안개습지 `hunting-wetland`(권장 Lv10~15, 장비 Lv10), 붉은채석장 `hunting-quarry`(Lv14~20, 장비 Lv15), 서리설원 `hunting-frost`(Lv19~25, 장비 Lv20), 고대유적 `hunting-ruins`(Lv24~30, 장비 Lv25). 이동은 위험한 숲→습지→채석장→설원→유적 순서로 양방향 연결한다.
- **콘텐츠:** 지역별 몬스터 2종(신규 kind 총 8), 퀘스트 2개(총 11), 제작 레시피 9개(총 37), 지역 상점/퀘스트 NPC 1명(총 4)을 추가한다.
- **아이템:** 신규 48개(직업별 무기 16, 기타 장비 16, 재료 12, HP 회복약 4)로 기존 카탈로그 19개에서 67개가 된다. 최대 고유 아이템 한도는 24에서 80으로 넓힌다. 기존 키·행·8개 아이콘 프레임 순서는 보존하고 새 아이콘 프레임은 뒤에 추가한다.
- **맵·연결:** 맵은 64×37이며 카메라 안전 여백을 유지한다. 동쪽 출구 (47,25/26), 남쪽 귀환 출구 (31/32,27), 야영지 (28,25)를 사용한다. 지역 특징은 습지 수로·목교, 채석장 U자 벽, 설원 능선, 유적 교차 회랑이다.
- **데이터·UI 연결:** 공유 progression descriptor로 서버·클라이언트·생성 도구를 연결한다. 신규 콘텐츠는 기존 text `item_key`/`quest_id`와 슬롯 종류를 사용하므로 DB migration은 계획하지 않는다. 지역별 제작 목록, 지도·미니맵·안내, 직업 무기 및 방어구 외형, 반지 1·2 슬롯 표시를 연결한다.

### 상태 구분

- **승인:** 위 후속 지역·아이템 성장 경로 확장이 승인됐고 상세 구성도 확정됐다.
- **구현:** 진행 중이다. 코드 구현 완료를 의미하지 않는다.
- **검증:** 아직 전체 검증 전이다. 독립 산술 모델은 4개 단계×4개 직업의 기본 공격 생존성만 다뤘고, 스킬·회복·기타 액세서리를 제외했으므로 실제 밸런스 검증이 아니다.
- **push·배포:** 수행되지 않았다.

### 선행 기준과 후속 기록

현행 지역·성장 기반과 미완료 조건은 [로드맵 §7](roadmap.md)의 최신 상태를 따른다. 기존 코드와 실제 테스트 증거를 확인한 뒤 상세 콘텐츠 구성을 이 문서에 갱신한다. 구현을 마치면 별도 구현 기록에 실제 변경 경로, 실행한 검증 및 결과, 제한 사항을 기록하고 이 문서와 [결정 로그](decisions.md)를 연결한다.

## Lv1~30 후속 지역·아이템 — 구현 및 검증 기록

> 원본: `implementation-2026-09-23-level30-regions-items.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

**상태:** 승인 범위 구현·기록된 검증 완료 · 전체 제품 미완료 · 미 push · 미배포

4개 후속 지역과 아이템 성장 경로를 [승인된 설계](r07-regions-bosses.md)에 따라 추가했다. 변경은 지역 콘텐츠·맵·몬스터·퀘스트·제작·상점, 아이템 카탈로그와 저장/장착 처리, UI·표현 및 관련 회귀 검증을 포함한다. 레벨 상한 30, 네 직업, 기존 스킬 구성과 기존 19개 item key/행 및 아이콘 순서는 유지했다. 이 기록은 승인된 범위의 완료이며 전체 로드맵, 장시간 실제 플레이, 시각 승인 또는 배포 완료를 뜻하지 않는다.

### 구현 결과

- 습지·채석장·설원·유적 4곳, 신규 아이템 48개(총 67), 몬스터 kind 8개, 퀘스트 8개(총 11), 제작 레시피 36개(총 37), 지역 NPC 4명을 연결했다. 최대 고유 아이템 한도를 24에서 80으로 확장했다.
- 지역 이동·포털과 안전 여백, 직업 장비 및 외형, 인벤토리 장착 슬롯 snapshot, 두 반지 슬롯의 동일 아이템 중복 방지, 지역 제작 안내를 연결했다.
- 검증 중 확인한 오류도 수정했다: 기존 퀘스트 등록 순서/접두 콘텐츠 보존, 반지 두 슬롯 장착 검증 및 DB 슬롯 교체 순서, 단일 snapshot의 equipped slot metadata, legacy unknown-slot UI 회귀. HP tonic 및 투구 제작 재료·산출량은 상점 구매보다 제작이 불리하지 않도록 조정했다.

### 검증 증거

- 서버 관련 25개 파일의 첫 최종 실행은 399건 중 397 pass, 2개의 기존 fixture 기대값 불일치, skip 0이었다. 해당 변경 후 실제 PostgreSQL 16.15 (전용 port 55433, `ksc_level30_test`)에서 아래 두 파일을 실행해 112/112 통과, fail/skip 0을 확인했다. 새 동시성 사례를 포함해 중복을 제거한 관련 서버 사례 400개가 최종 통과했다. 이는 단일 400-case 실행 결과가 아니다.

  ```powershell
  $env:ZEP_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55433/ksc_level30_test'
  npx tsx --test --test-concurrency=1 --test-timeout=90000 server/src/db/inventoryStore.test.ts server/src/rooms/equipmentSlots-verification.test.ts
  ```

  독립 실행 로그: `C:/Temp/ksc-level30-independent-server-final.log`, `C:/Temp/ksc-level30-independent-pg-final.log`.
- 브라우저: `cd client/e2e; npx playwright test -c level30.playwright.config.ts` — 24/24 통과(40.9초). `cd client/e2e; npx playwright test -c social.playwright.config.ts tests/social-live.spec.ts` — 실제 browser 2개를 사용하는 party/trade/craft 1/1 통과(14.7초).
- 신규 지역 서버 회귀(`server/src/rooms/level30Progression.verification.test.ts`)를 포함해 공유 타입·데이터 사례 15개가 통과했다. Shared 26/26, 성장 모델 8/8 (`npx tsx --test tools/balance-growth.test.mjs`), root `npm run typecheck`, `npm run build`(99 modules; 기존 500KB 초과 bundle warning), E2E TypeScript 검사 및 `git diff --check` 통과.
- 독립 검사: 67개 전 아이템 획득 경로 도달, 48개 신규 아이템 사용 경로 및 37개 recipe 연결 확인; 4개 맵 BFS·카메라·포털 안전 확인; 기존 아이템 icon 8개와 monster sprite 4개 블록의 픽셀 보존 확인. 64개 전투 산술 사례에서 각 단계×직업의 기본 공격 생존성과 tonic 비용을 포함한 기대 순익 양수를 확인했다. 산술 모델은 실제 플레이 밸런스 측정이 아니다.
- 독립 보안/리뷰 단계에서 blocking finding은 보고되지 않았다.

### 남은 제한

전체 서버·브라우저 테스트 모음, 실제 20~30분 성장 플레이, 사용자 시각 승인, APISIX SSO 및 500 CCU PoC는 이 작업에서 수행하지 않았다. 생성 sprite/icon은 승인된 원작 pixel art나 시각 승인을 뜻하지 않는다. 새 레시피 경제와 전투는 automated/model evidence만 있으며 장기 실플레이 균형은 미확인이다. 코드 변경은 push·배포하지 않았다.

## 원작 사냥 콘텐츠 기준 확정 및 교체

> 원본: `implementation-2026-09-23-original-hunting-content.md` (날짜별 문서 단일화로 이 절에 통합, 2026-09-23)

### 목적 및 승인 범위

2026-09-23 사용자는 다음 코드 작업으로 2009~2010년 PC 바람의나라 원작 사냥터 기준표를 확정하고 기존 사냥 콘텐츠를 교체하도록 명시적으로 승인했다. 교체 범위는 사냥터 기준표와 지역 맵, 몬스터, 드롭이다. 저장된 캐릭터 정체성, EXP 성장 구조와 레벨 상한 30은 유지한다. 역사 자료로 확인되지 않은 맵이나 명칭은 원작과 동일하다고 단정하지 않는다.

### 확인한 현재 코드

기존 `shared/src/progression.ts`와 `server/src/rooms/progressionDefinitions.ts`의 창작 4지역 성장 콘텐츠를 부여 사냥터 구성으로 교체했다. 관련 구현은 `shared/src/progression.ts`, `server/src/rooms/`의 지역·아이템·몬스터 정의, `client/src/world/` 및 UI, `tools/`의 지도·아트 생성기와 밸런스 도구, `assets/maps/buyeo*.json` 및 스프라이트에 있다.

### 조사 기준표

아래는 콘텐츠 교체에 채택한 잠정 기준이다. 2009~2010년 당시의 정확한 좌표·층수·출현 확률·모든 드롭을 확인한 표가 아니며, 지역 맵은 원작 전체 층을 복원한 지도가 아니라 대표 사냥터를 표현하는 로컬 프로토타입 맵으로 취급한다. 몬스터 수치와 경제 밸런스도 프로토타입 값이다.

| 구분 | 잠정 콘텐츠 기준 | 근거 및 한계 |
|---|---|---|
| 사냥터 계열 | 부여의 초보 사냥터 및 쥐굴·뱀굴·곰굴·사슴굴·돼지굴·여우굴 계열의 7개 대표 지역 | 2008년 공략은 쥐굴·박쥐 및 뱀굴·돼지굴·여우굴의 존재를 언급한다. 이는 당시 개별 맵 구조·지역 간 연결·정확한 층수 증명이 아니다. |
| 초보 몬스터·재료 | 다람쥐→도토리, 토끼→토끼고기; 암사슴은 드롭 없음 기준 | 후대 혼합 시기의 비공식 사냥터 표를 참고한 기준이며 2009~2010 드롭 테이블의 직접 증거는 아니다. |
| 쥐굴 계열 | 쥐·큰쥐·시궁쥐→쥐고기, 박쥐→박쥐고기 | 후대 비공식 자료 기준. 당시 확률·층별 배치는 미확인. |
| 뱀굴 계열 | 뱀·독사는 뱀고기, 살쾡이는 좋은뱀고기 기준; 왕구렁이→힘의투구1 후보 | 왕구렁이 드롭은 2024년 구버전 공략과 후대 사냥터 표가 뒷받침하지만, 2009~2010의 동일 드롭·확률은 미확인. |
| 곰 계열 | 곰→곰가죽, 평웅→웅담 | 후대 비공식 자료 기준. 정확한 종별 구분과 드롭 확률 미확인. |
| 사슴·돼지·여우 | 청순록·적순록→사슴고기; 산돼지→산돼지고기, 숲돼지→숲돼지고기; 흑·백·불여우→여우모피, 구미호→사각방패 | 후대 비공식 자료 기준. 당시 명칭·출현 지역·드롭 테이블을 확정하는 2009~2010 자료는 확인되지 않음. |

참고 자료: [2008년 도적 육성 공략](https://karr.tistory.com/entry/바람의나라-도적-199-키우기)은 쥐굴의 쥐·박쥐와 뱀굴·돼지굴·여우굴의 존재 확인에만 사용했다. [후대 혼합 시기 사냥터 표](https://namu.moe/w/바람의%20나라(게임)/일반성/사냥터)는 위 잠정 몬스터·드롭 후보의 근거이며 2026-08-13 갱신 자료라 해당 시기 증거로 간주하지 않는다. [힘의투구1 공략](https://gosuoflife.tistory.com/entry/구버전-바람의-나라-클래식-힘의투구1-획득-방법-공략-및-가이드)은 2024-11-17 자료다. [공식 게임연혁](https://baram.nexon.com/GameGuide/View/3)은 연혁 확인에 한정되며 개별 드롭 정보를 제공하지 않는다.

구현 기준은 부여의 7개 대표 사냥 공간과 부여 마을 허브다. 허브↔초보 사냥터, 허브↔쥐굴/곰굴/사슴굴/돼지굴/여우굴, 쥐굴↔뱀굴로 이어지는 방향성 연결 14개를 두었고 입장권 게이트는 두지 않았다. 과거 입장권 아이템은 호환 목적으로 유지한다. 기존 아이템 67종의 메타데이터와 픽셀은 보존하고 새 아이템 14종을 추가해 총 81종(제한 96종)으로 구성했다. 기존 48종은 활성 획득·상점·제작 경로에서 제외한다. 새 사각방패는 수집·판매용이며 방패 장비 슬롯을 추가하지 않았고, 힘의투구1은 착용 가능하다. 기존 11개 퀘스트 ID·수량·보상량을 보존하고 목표와 의뢰자를 새 지역에 연결했다. 보스 EXP 600 정의는 남아 있으나 비활성 상태다.

활성 기본 강화 갑옷 레시피는 비활성 아이템인 굴가죽 대신 곰가죽 3개를 사용하도록 고쳤다. 레시피 ID·산출물·30전 수수료는 유지했다. 활성 레시피 재료의 획득 경로 닫힘 및 실제 제작을 회귀 테스트로 검증했다. 가격 검토에서 재료의 판매가치 기준 제작 원가는 151전(패딩 25 + 곰가죽 3개 96 + 수수료 30), 제작품 판매가는 75전으로 제작-판매 차익이 없다. 패딩을 상점에서 100전에 사는 경우 곰가죽 판매 기회비용과 수수료를 합친 총비용은 226전으로, 상점 갑옷 300전보다 낮다.

7개 지역 지도는 모두 64×37의 대표 로컬 지형이며 2009년 원작 층 지도의 복원본이 아니다. 지역별 통행 가능 타일 수는 588, 560, 580, 552, 544, 548, 560이다. 지역 레벨, 몬스터 능력치, 드롭 확률과 가격은 프로젝트 밸런스 값이며 역사적 수치가 아니다. 저장된 캐릭터 정체성, EXP 성장 체계와 레벨 상한 30은 유지했다.

### 검증 결과

- workspace typecheck 및 build 통과(99 modules); 기존 500KB 초과 번들 경고는 남아 있다.
- 생성기 검사에서 지도 7개 연결성·2타일 통로·통행 가능 타일 수를 확인했고, 스프라이트 아틀라스 28종×12프레임 및 아이템 아틀라스 70아이콘을 생성·육안 확인했다.
- 이전 아틀라스의 RGBA 백업 비교에서 기존 아이템 이미지 1792×32 영역 및 몬스터 이미지 96×1536 영역의 앞부분 픽셀이 새 파일과 일치함을 확인했다.
- 전체 최종 테스트: `npm test` 통과, shared 26/26 + server 1249/1249 = 1275 통과, 실패·skip 0 (서버 38.61초). 실행 로그: `C:/Users/b9812/AppData/Local/Temp/ksc-hunting-final-suite2.log`. 레거시 픽스처를 갱신했으며, 마지막 TCP 테스트의 테스트 전용 대기 로직은 각 이동 후 예상 위치 확인을 기다리도록 수정했다.
- `node tools/balance-growth.test.mjs` 6/6, `level30.playwright.config.ts` 27/27, `social.playwright.config.ts` 8/8 통과. 소셜 8개 중 실제 브라우저 거래·곰가죽 제작 2개를 포함한다. 소셜 suite의 7개 UI 테스트는 27개 suite와 겹치므로 테스트 수를 합산하지 않는다. E2E TypeScript 검사 통과.
- `npm run typecheck` (3개 workspace) 통과, `npm run build` 통과(99 modules, 4.77초; 기존 500KB 초과 번들 경고 유지), `git diff --check` 통과. 독립 reviewer는 미해결 프로덕션 지적 없음 및 레시피 재료 획득 경로·가격 검증 통과를 확인했다.
- 사냥 백엔드 112/112, 독립 기준 검증 43/43, 드롭·스폰 경계 13/13 통과. 과거 메커니즘 확인 127/127은 보존된 테스트 픽스처 기준이며 구 프로덕션 방의 회귀 증거로 간주하지 않는다. 이전 전체 회귀 실행에서 나온 레거시 실패는 픽스처 갱신 후 위 최종 suite에서 해소됐다.

### 상태

**구현 및 기록된 검증 완료.** 구현은 [4ae0045](https://github.com/jojunhee125/baram_ai_game/commit/4ae00455ada8ffb64cca0bb2012bcb8a6ee849ab)로 origin/main에 push됐다. 위 표는 후대 자료를 포함한 프로토타입 기준이며 2009~2010년의 정확한 맵·층수·출현 확률·드롭을 입증하지 않는다. 실 PostgreSQL 검증, 전체 제품 브라우저 suite, 장시간 플레이, APISIX SSO, 500 CCU, 사용자 시각 승인 및 운영 배포는 이번 작업에서 수행하지 않았다.
