# KeyH 귀환 실패 재현 조사

## 범위와 결과

사용자 요청에 따라 `heritage-first-play.spec.ts`에 기록된 KeyH 귀환 실패를 조사했다. 기준은 clean `main`, `origin/main`과 동일한 `297e7bafacef989478cb938e6add65b918b544b6`이다.

현재 코드에서 원본 테스트 2개와 귀환 시나리오 반복 10회가 모두 통과했다. 과거 실패 trace는 저장소에 없으며, 원인이 확인된 수정이나 해결 완료로 처리하지 않는다. production 코드와 테스트는 변경하지 않았다.

## 재현 시나리오와 실행 증거

대상은 `client/e2e/tests/heritage-first-play.spec.ts:5`다. 광장 접속·스킨 변경 후 landmark로 사냥터에 진입하고, Up → Space → I 두 번 → H를 입력해 광장 좌표 `31, 20`으로 돌아오는 흐름이다.

Astra tester가 `code/client/e2e/`에서 실행했다. 두 명령 모두 exit 0이다.

- `npm test -- heritage-first-play.spec.ts --output "$env:TEMP/keyh-initial-20260922-qa"` — 2 passed, 13.3초.
- `npm test -- heritage-first-play.spec.ts --grep 'new artwork' --repeat-each 10 --output "$env:TEMP/keyh-repeat-20260922-qa"` — 10 passed, 1.3분.

전체 suite는 실행하지 않았다. 이번 결과만으로 다른 실행 순서·부하 조건에서의 실패 가능성을 배제하지 않는다.

## 확인한 코드 경로

- `HomeButton.handleKey`: KeyH/Home을 받되 repeat·수정키·텍스트 입력 focus·귀환 버튼 disabled 상태에서는 무시한다.
- `WorldScene.returnHome`: 전환 중이거나 이동 차단 NPC 패널·스킨 선택창이 열려 있으면 귀환을 막는다.
- `resolveHomeRoomName`: 페이지 최초 진입 방을 귀환 대상으로 유지한다. 대상 시나리오는 광장으로 부팅한다.
- cross-room 귀환은 목적지 접속 성공 후 원래 방을 떠나며, 성공 시에만 귀환 버튼 cooldown을 시작한다.

이 차단 조건 중 어느 것이 과거 실패 당시 활성화됐는지는 확인하지 못했다. 실패가 재현되지 않은 상태에서 guard를 제거하거나 대기 시간을 늘리지 않는다.

별도 모델 `gpt-5.6-sol` architect의 독립 분석도 재현 가능한 production bug나 test race를 확인하지 못했다. 두 번째 KeyI는 가방을 동기적으로 닫고, 귀환의 전환·패널 차단 조건은 의도된 동작이므로 현재 근거로는 production 변경이 필요하지 않다는 결론이다.

## 남은 확인

재발 시 실패 trace와 함께 H 입력 직전의 현재 방·좌표, activeElement, home-button disabled, transition 상태, NPC/스킨 패널 표시, console 오류를 확보해야 한다. 실제 귀환 실패와 의도된 입력 차단, 테스트 타이밍 문제를 구분하는 데 필요하다.

기능 수정이 없어 build·전체 테스트를 추가 반복하지 않았다. commit·push는 수행하지 않았다.
