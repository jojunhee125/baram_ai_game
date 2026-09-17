# 퀘스트 패널·트래커 구현 기록

기준일: 2026-09-17. [로드맵](roadmap.md) §7의 **3번**(첫 퀘스트 상태·처치 목표) **클라이언트 절반**이다.
서버 절반은 [2026-09-16 기록](implementation-2026-09-16-quest-state.md), 승인 근거는 [결정 기록](decisions.md) 2026-09-17 항목.
기준 커밋은 `4b818a6`, 작업 브랜치는 `main`.

## 범위와 제외

구현한 것은 **NPC 패널의 퀘스트 블록(제시·수락)** 과 **좌측 상단 퀘스트 트래커**다.
프로토콜·서버는 한 줄도 바꾸지 않았다 — 2026-09-16 계약(`quest:accept`, `quest:updated`, `NpcInteraction.quests`)을 그대로 소비한다.
보상 UI는 만들지 않았다. 서버에 지급 경로 자체가 없다(R04 정산 전까지 비활성).
상점 NPC·귀환 동선과 실제 Postgres 동시성 확인은 이번 범위 밖이며 R03 잔여로 남는다.

## 화면 계약

```
NPC 진입 ──→ InteractableEntered(quests[]) ──→ ObjectPanel: 제목·제안문·목표·[수락]
[수락] 클릭 ──→ quest:accept ──→ (서버) ──→ quest:updated ─┬→ ObjectPanel: 진행 중 n / m
                                                          └→ QuestTracker: 줄 추가·갱신
처치 ────────────────────────→ quest:updated ─────────────→ 트래커 카운트·바 갱신
재접속 ─→ (join 직후 서버가 수락분마다 전송) ─────────────→ 트래커 복원
```

| 항목 | 값 |
|---|---|
| 수락 버튼 | `status === offered`일 때만 표시. 클릭 시 **비활성 + "수락하는 중…"** 으로 바뀌고, 상태는 서버 `quest:updated`가 와야 바뀐다 |
| 무시되는 수락 | 서버가 모르는 id는 침묵 처리 → 블록이 "수락됨"으로 거짓 표시되지 않고 미수락으로 남는다 |
| 재시도 | 타일에서 내려갔다 다시 밟으면 블록이 새로 그려져 버튼이 살아난다(퀴즈와 같은 제스처) |
| 트래커 대상 | 수락·완료만. `offered`는 트래커에 절대 들어가지 않는다(제안은 NPC 패널의 몫) |
| 완료 줄 | 사라지지 않는다. R04 전까지 turn-in이 없어 "완료"가 종착 상태다 |
| 진행바 | `killCount / requiredCount`를 0..1로 **클램프**. 요구치를 낮춘 재배포가 남긴 초과 행이 바를 넘치게 하지 않는다 |
| 텍스트 | 전부 서버 문자열(`title`/`summary`/`objectiveText`/`completionText`). 클라이언트에 퀘스트 표가 없다 |

### join 직후 메시지 유실 문제(실제로 고친 결함)

서버는 join 직후 `hydrateQuestCache`가 DB를 읽자마자 수락분마다 `quest:updated`를 보낸다.
반면 클라이언트는 `RoomConnection.attach()`에서야 `onMessage`를 등록했고, 그 사이에는
**맵 로딩 전체 구간**이 들어간다. Colyseus는 핸들러가 없는 메시지를 그냥 버리므로, 이대로면
"방을 옮기면 수락한 퀘스트가 트래커에서 사라지고 다음 처치 때 되살아나는" 증상이 된다
(로컬 in-memory 스토어처럼 hydration이 빠를수록 확실히 재현).

→ `quest:updated` 핸들러만 **생성자에서** 등록하고, `attach()` 이전 도착분은
`pendingQuestUpdates`에 모았다가 microtask로 재생한다. 기존 `pendingLifecycle`과 같은 패턴이고,
microtask인 이유도 같다 — `WorldScene.create()`가 `attach()` **뒤에** 패널을 만들기 때문에
동기 재생은 아직 없는 렌더러에게 배달된다. 트래커만은 `attach()` 앞에서 생성한다.

다른 메시지들은 이 처리가 필요 없다: 전부 플레이어 자신의 행동(공격·수락·이동)이 원인이라
`attach()` 이전에는 발생할 수 없다. join 자체가 원인인 것은 퀘스트 hydration 하나뿐이다.

## 변경 파일

| 경로 | 내용 |
|---|---|
| `client/src/ui/questTracker.ts` | **신규** — 트래커. `apply(QuestState)`/`destroy()` |
| `client/src/ui/objectPanel.ts` | NPC 렌더를 `renderNpc`로 분리, 퀘스트 블록·수락 버튼·`applyQuestUpdate` 추가, 생성자 2번째 인자 |
| `client/src/net/roomConnection.ts` | `sendAcceptQuest`, `onQuestUpdated`, `pendingQuestUpdates` 버퍼와 microtask 재생 |
| `client/src/scenes/WorldScene.ts` | 트래커 생성(attach 이전)·배선·`init()` 리셋·hop 시 `destroy()` |
| `client/index.html` | `.hud` 컬럼 안(컨트롤 줄 바로 아래)에 `#quest-tracker` 추가 |
| `client/src/style.css` | `.quests*`, `.object__quest*` |
| `client/src/heritage.css` | 트래커를 클래식 목재 패널 계열로(테두리·색·진행바) |
| `client/e2e/tests/quest-ui.spec.ts` | **신규** — 통합 1 + white-box 2 |

### 트래커 위치를 두 번 옮긴 이유(회귀 1건 실제 발생)

처음에는 좌상단에 `.stage-left` 컬럼을 만들어 vitals와 트래커를 세로로 쌓았다. 이 배치는
**`heritage.css`가 `.vitals`를 우측 사이드바 하단으로 재배치(`top:auto; left:auto; right:0; bottom:0`)**
한다는 사실을 깼다 — 그 오프셋은 `.vitals` 자신이 `position: absolute`일 때만 먹는데, 컬럼으로 감싸면서
`relative`로 바꾼 순간 vitals가 좌상단으로 튀어나와 보스 HP바·지역 안내와 겹쳤다
(`pass-i-boss-hp-bar.spec.ts`의 겹침 테스트가 이를 잡았다). 현재 UI는 클래식 스킨이 정본이므로,
컬럼을 버리고 트래커를 **두 스킨이 이미 공유하는 `.hud` 컬럼**(기본: 우상단, 클래식: 사이드바) 안에
넣었다. `.vitals`는 원래 상태 그대로 되돌려 이 변경에 포함되지 않는다.

## 검증

| 검사 | 결과 |
|---|---|
| `npm run typecheck` (shared/server/client) | 통과 |
| `npm run build` (client) | 통과 |
| `client/e2e` 신규 spec 3케이스 | 통과 (17.5s) |
| `client/e2e` 전체 스위트 | **93/93 통과** (7.2분). 1차 실행은 2건 실패 — 원인·수정은 아래 두 절 |

신규 spec이 덮는 것: 실제 서버 왕복 수락(패널이 서버 응답으로만 상태를 바꾸는지), `offered`가
트래커에 들어가지 않음, 줄 패치(추가가 아니라 갱신), 완료 시 문구 교체·색, 초과 killCount 클램프,
`destroy()`의 DOM 정리, 다른 questId 업데이트 무시, 재개봉 시 버튼 부활, 퀘스트 없는 NPC 무변화.

통합 테스트의 마지막 한 걸음은 `STEP_TWEEN_MS`(120ms)보다 짧은 100ms 홀드로 바꿨다. 160ms 홀드는
전체 스위트 부하에서 두 번 걸어져 문(31,8)을 밟고 방을 옮겨버렸고, 그 결과가 "수락 버튼이 DOM에서
사라짐"으로 나타났다. 지금은 좌표 `30, 8`을 먼저 단언하므로 걸음이 어긋나면 그 자리에서 실패한다.

**브라우저에서 처치 진행을 몰지 않았다.** SSO가 없는 e2e 환경에서는 서버가 계정 키를
`client.sessionId`로 잡으므로(`metaverseRoom.ts`), 북쪽 문으로 사냥터에 들어가는 순간 **다른 계정으로
재접속**되어 수락한 퀘스트가 따라오지 않는다. 카운터 자체는 서버 스위트(`questSystem.test.ts`)가,
카운트가 그려지는 모습은 white-box 블록이 덮는다. KAD(SSO) 환경에서는 `sub` 기반이라 해당 없음.

## 남은 한계와 후속

- 진행 카운트가 실제 처치로 올라가는 장면은 **SSO 환경에서만** 브라우저로 확인 가능하다(위 참조). 현재 PC 로컬에서는 미확인 `[needs verification]`.
- 수락 요청이 응답 없이 유실되면 버튼은 비활성인 채로 남는다. 복구는 타일 재진입뿐이며 타임아웃은 두지 않았다(퀴즈와 같은 판단).
- 트래커는 완료 줄을 계속 들고 있는다. R04에서 turn-in이 생기면 그때 정리 규칙을 정한다.
- 상점 NPC·귀환 동선(R03 잔여), 실제 Postgres 동시성 확인은 여전히 미착수.
- 운영 배포는 수행하지 않았다. KAD 재배포는 사용자 몫.
