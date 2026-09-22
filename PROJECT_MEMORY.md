# 프로젝트 메모리

## 세션 종료 — 2026-09-22

- 사용자 요청으로 세션을 종료한다. 추가 코드 작업은 시작하지 않는다.
- 장착 외형 구현 `57fe304`까지 origin/main에 push 완료. 최신 검증은 전체1193개·browser50개·workspace/E2E typecheck·build 통과다. branch/worktree 없이 main만 사용한다.
- 로컬 게임: http://127.0.0.1:5173/ , 서버2567. 종료 기록 시 두 포트 LISTEN을 확인했으며 사용자가 실행을 요청한 프로세스는 그대로 유지했다. 서버는 DB 연결 없이 실행 중이다. 다음 세션에는 프로세스 생존을 다시 확인한다.
- 로컬 실행 로그: `%TEMP%/ksc-local-run/`. 원격 운영 배포는 수행하지 않았다.
- 다음 확인: 사용자의 실제 화면 피드백,20~30분 성장·전투 밸런스 측정. 원격 빈공격·투구/망토 외형·24종 맞춤 원화는 별도 승인 후 진행한다. KeyH 원인 미확정·SSO gateway/500CCU·다중process cache 한계는 유지한다.
- [종료 기록](docs/implementation-2026-09-22-session-close.md) · [로드맵](docs/roadmap.md).


## 2026-09-22 후속 — 장착 외형

사용자1번 승인으로 무기3종·갑옷3종의 원본 pixel overlay와 공개 장착 외형키2개를 구현했다. 모든 방에서 복원하고 로컬/원격 방향·이동·장착 변경과 로컬 공격을 따라간다. 기존 composite atlas는 유지한다. 전체1193개·browser50개 및 typecheck/build 통과. 상세 검증과 Git 반영 결과는 [구현 기록](docs/implementation-2026-09-22-equipped-appearance.md) 및 main 이력을 따른다. 아래 a8fbcb0 요약은 이 작업 직전 코드 기준이다.

같은 행 actor layer 혼합·공격후 방향잔상을 수정했다. 원격 빈공격 protocol·helmet/cloak/ring 외형·24종 맞춤 원화·500CCU·운영 배포·사용자 시각 승인은 추가하지 않았다. legacy 무기 HTTP export는 남아 있으나 현행 WorldScene 외형은 authoritative replicated state만 사용한다.

기준일: 2026-09-22. 최신 코드 커밋은 `57fe304`이며 `origin/main`에 push 완료했다. 문서 최신화 시작 시 main과 origin/main이 일치하고 작업 트리는 깨끗했다. 운영 배포는 수행하지 않았다.

## 사용자 방향과 작업 규칙

- 2009~2010년 PC 바람의나라를 참고한 회사용 2D 메타버스/RPG. 최초 홈은 부여성 남쪽 분위기를 따른다. 원작과의 시각적 동등성이나 자산 사용 허가를 확보한 것으로 간주하지 않는다.
- **branch·worktree 분기 금지. main에서만 작업·커밋·push한다.** 기존 남문 branch의 작업은 main에 통합했다. 다음 작업 전 fetch/status로 원격 동기화를 확인한다.
- 사용자는 다음 코드 작업과 관련 문서·메모리의 저장을 승인했다. 새로운 큰 범위의 기능이나 운영 배포 승인을 추정하지 않는다.
- 실제 Git 저장소는 `code/`다. 이 메모리와 `docs/`가 Git에 보존되는 정본이며 상위 HANDOFF/메모리는 안내와 과거 스냅샷이다.

## 구현 및 Git 반영

| 커밋 | 완료 범위 | 검증 근거 |
|---|---|---|
| `297e7ba` | R05 실제 접속 통합 테스트·E2E 타입 오류 정리, KeyH 조사 기록 | 관련 browser11개·typecheck/build |
| `5eb0f33` | 남문 홈·전리품 판매/장비 구매·들판/굴 차별화 | 당시 전체1172개·browser3개 |
| `ac70d3f` | 실제 첫 성장 루프·세 번째 위험한 숲·실PostgreSQL 거래 경합 | 당시 전체1182개·실DB187개(신규7개)·browser10개 |
| `e7b01d5` | 가방의 같은 슬롯 장비 비교 | 당시 전체1185개·browser15개·추가layout2개 |
| `a8fbcb0` | 상점 구매 전 같은 슬롯 장비 비교 | 최신 전체1187개·browser26개·typecheck/build |

위 커밋은 모두 origin/main 이력에 포함된다. 과거 미커밋·미병합 표현은 해당 작업 당시 기록이며 현재 상태가 아니다. 테스트 수는 시점별 실행 범위로, 합산한 고유 테스트 수가 아니다.

## 현재 동작과 검증 범위

- 남문→들판→굴→위험한 숲으로 지역 지형·행동·드롭을 연결했다. 굴/숲 전용 table은 기본 table과 합산하지 않는 전체 대체다. 전리품은 판매 또는 장착 용도가 있다. 숲지기 망토는 피해 감소10%이며 HP+20 후보는 채택하지 않았다.
- 실제 성장 E2E는 수락→사냥→보상→판매→단검 구매/장착→재접속 유지를 자산 주입 없이 검증했다. 20~30분 루프 및 네 직업 성장 밸런스를 검증한 것은 아니다.
- 가방/상점 비교는 서버 metadata의 같은 슬롯 장비 보너스만 비교한다. 피해 감소 차이는 %p이며 최종 캐릭터 피해량·합산 방어율 예측이 아니다. unknown을0으로 추정하지 않고 늦은 HTTP/live 이벤트와 lifecycle을 처리한다.
- 최신 browser26개는 신규 상점12개+기존 가방12개+상점2개다. ObjectPanel component fixture와 서버 검증을 구분하며 WorldScene 실제 wire 이벤트를 이번에 별도 강제하지 않았다.
- 실PostgreSQL16.15 검증은 ac70d3f 당시 수행했다. 로컬 임시 DB는 중지했고 서비스는 설치하지 않았다. 이후 metadata/UI 작업은 DB 로직을 바꾸지 않아 실DB 검증을 반복하지 않았다.
- 기존 계정 EXP·성장 곡선·초보 EXP1/2/3·boss600을 유지했다. 장비 비교로 가격·정산·전투 수치를 변경하지 않았다.

## 남은 확인과 제한

- R01 시대 reference·native pixel·사용자 외형 승인, R02 전용 동작/장비 원화, R04 실제20~30분 루프, R05 두 스킨 및 네 직업 장시간 플레이는 남아 있다.
- KeyH 실패는 원본2개+추가10회에서 미재현이며 원인 미확정이다. 해결 완료로 표시하지 않는다.
- 직접 room join의 portal/landmark 입장 조건 우회, 다중 process 장비 cache 동기화는 기존 한계다.
- KAD/APISIX 경유 WebSocket SSO와500CCU PoC는 미검증이다. 운영 배포·다른OS 검증을 완료했다고 보고하지 않는다.
- 기존 Vite500KB chunk 경고가 유지된다. R06/R07 전체를 개별 장비/숲 구현만으로 완료 처리하지 않는다.

## 재개할 문서

- [로드맵](docs/roadmap.md) · [결정 기록](docs/decisions.md)
- [상점 비교 구현·검증](docs/implementation-2026-09-22-shop-equipment-comparison.md)
- [가방 비교 구현·검증](docs/implementation-2026-09-22-equipment-comparison.md)
- [성장·숲·실DB 구현·검증](docs/implementation-2026-09-22-parallel-progression.md)
- [남문 구현 이력](docs/implementation-2026-09-22-south-gate-progression.md)

다음 작업은 위 남은 항목과 로드맵을 기준으로 정한다. 사용자 승인과 구현·검증·push·배포 상태를 계속 구분한다.
