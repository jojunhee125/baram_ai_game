# 서버 작업 완료 기록

## 2026-09-14 — EXP 오류 처리·고레벨 입장 HP 보정 완료

- EXP 저장 queue의 정리용 Promise에서 발생하던 추가 unhandled rejection을 제거했다. 원래 오류는 호출자에게 전달하며 같은 계정의 후속 작업은 계속 처리한다.
- PostgreSQL 공통 pool에 실행 제한 `statement_timeout=5,000ms`, 응답 대기 제한 `query_timeout=10,000ms`를 추가했다. 기존 연결 획득 제한 5초와 최대 연결 4개를 유지했다. 자동 재시도는 추가하지 않았다.
- 저장된 EXP로 레벨을 복원할 때 현재 HP에 최대 HP 증가분을 반영한다. 복원을 기다리는 동안 받은 피해·회복 결과를 유지한다.
- 검증: 신규 회귀 3개와 직접 영향받는 기존 사망 사례 4개만 선택 실행하여 **7개 통과, 실패 0개**. 서버 `typecheck` 통과. 독립 production 코드 리뷰에서 지적 사항 없음.
- 전체 테스트·build·브라우저 E2E·부하 테스트는 실행하지 않았다. 실제 PostgreSQL timeout은 미검증이며, 공통 pool 제한은 시작 시 migration·advisory lock에도 적용된다.
- UI 변경·배포는 포함하지 않는다. 보상 재시도/중복 방지와 다른 session의 성장 정보 동기화는 이번 완료 범위가 아니다.
