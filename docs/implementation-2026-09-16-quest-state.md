# 첫 퀘스트 상태·처치 목표 구현 기록

기준일: 2026-09-16. [로드맵](roadmap.md) §7의 **3번**(첫 퀘스트 상태·처치 목표) 서버 구현이다.
승인 근거는 [결정 기록](decisions.md) 2026-09-16 항목. 기준 커밋은 `e438f35`, 작업 브랜치는 `main`.

## 범위와 제외

구현한 것은 퀘스트 1개의 **수락·진행·완료 저장**과 **기존 몬스터 처치 이벤트 연결**이다.
보상 지급은 구현하지 않았고, 지급 경로 자체를 만들지 않았다 — `QuestDefinition`에 보상 필드가 없다.
클라이언트 UI(퀘스트 패널·트래커)는 이번 범위가 아니다. 서버가 계약과 메시지를 모두 갖추었고,
화면은 로드맵의 "현재 PC 전용" 절반으로 남아 있다.

## 구현한 계약

```
NPC 진입 ──→ InteractableEntered(quests[]) ── 읽는 사람의 진행도 동봉
수락 ────→ quest:accept {questId} ──→ QuestStore.accept ──→ quest:updated
처치 ────→ lastHit ──→ QuestStore.recordKill ──→ quest:updated (변화 있을 때만)
재접속 ──→ onJoin hydrate ──→ 수락한 퀘스트마다 quest:updated
```

| 항목 | 값 |
|---|---|
| 퀘스트 행 | `first-hunt` — 안내 NPC `plaza-hunting-ground-npc`가 제시, 다람쥐 3마리 처치 |
| 저장 | `quest_progress(owner_key, quest_id)` PK, `kill_count`, `completed_at` |
| 상태 파생 | `completed_at IS NULL` = 진행, 아니면 완료. status 컬럼 없음 |
| 요구 수량 | DB에 저장하지 않고 `QUEST_DEFINITIONS`에서 매 호출 파라미터로 전달 |
| 귀속 | last-hit. EXP·드롭과 같은 규칙, 같은 `lastHit` 값 |
| 보상 | 없음 (R04 정산 설계 전까지 비활성) |

### 동시성

처치 반영은 단일 UPDATE다. `completed_at IS NULL` 가드가 미수락·완료 행을 0행으로 만들고,
`LEAST($3, kill_count + 1)`이 요구 수량을 넘지 못하게 한다. 두 탭이 같은 계정으로 동시에 잡아도
증가는 두 번, 완료는 한 번이다. 수락은 `ON CONFLICT ... DO UPDATE`(자기대입) 한 번의 왕복이며
`updated_at`을 건드리지 않아 재수락이 진행으로 보이지 않는다.

세션 캐시(`PlayerSession.questRows`)는 최적화일 뿐이고, 완결 여부는 별도 플래그
`questRowsHydrated`가 판정한다. hydration이 끝나기 전의 처치는 캐시를 믿지 않고 스토어에 직접
묻는다 — 스토어가 미수락 행에 대해 no-op이므로 이 비관적 경로는 안전하다. 캐시 쓰기는
단조(monotonic)라서 늦게 도착한 오래된 답이 카운터를 되돌리지 못한다.

> **리뷰에서 잡힌 결함(수정 완료).** 처음 구현은 "캐시 맵이 null이 아니면 hydration 완료"로
> 판정했다. 그런데 hydration 창 안에서 수락이 먼저 커밋되면 맵이 한 행만 든 채 non-null이 되고,
> 그 상태에서 *다른* 퀘스트의 처치가 들어오면 "미수락"으로 오판해 스토어를 호출하지 않는다 —
> 지연이 아니라 **영구 유실**이다. 퀘스트가 1개뿐인 현재는 관측되지 않지만 2개째가 추가되는
> 순간 조용히 발생한다. 플래그를 분리해 고쳤고, 회귀 테스트
> (`questSystem.test.ts` — "keeps asking the store for a quest the cache has not been told about yet")가
> 옛 판정식으로 되돌리면 실패하는 것까지 확인했다.

## 변경 파일

| 경로 | 내용 |
|---|---|
| `server/migrations/0007_quest_progress.sql` | 신규 테이블 |
| `server/src/db/questStore.ts` | `QuestStore` 인터페이스 + In-memory/Postgres 구현 |
| `server/src/rooms/questDefinitions.ts` | 퀘스트 테이블·인덱스·부팅 검증 |
| `shared/src/protocol.ts` | `quest:accept`, `quest:updated`, `QuestState`, `NpcInteraction.quests` |
| `server/src/rooms/contracts.ts` | `RoomCreateOptions.questStore`, `PlayerSession.questRows` |
| `server/src/rooms/metaverseRoom.ts` | 수락 핸들러·처치 반영·조인 hydration·NPC 패널 동봉 |
| `server/src/server.ts` | 스토어 주입, 퀘스트 테이블 부팅 검증 |
| `server/src/index.ts` | `DATABASE_URL` 유무에 따른 스토어 선택 |
| `server/src/db/questStore.test.ts` | 스토어 계약 20 케이스 |
| `server/src/rooms/questSystem.test.ts` | 룸 통합 17 케이스 |
| `server/src/rooms/metaverseRoom.interactables.test.ts` | NPC 패널 기대값에 `quests` 반영 |
| `server/src/rooms/guardian-phaseW-createOptions.test.ts` | `createGameServer` 인자 위치 변경 반영 |

`createGameServer`의 5번째 인자가 `questStore`가 되면서 `adminOwnerKeys`가 6번째로 밀렸다.
위치 인자를 쓰던 호출부는 두 곳(`index.ts`, guardian 테스트)뿐이고 둘 다 수정했다.

## 검증

| 검사 | 결과 |
|---|---|
| `npm run typecheck` (shared/server/client) | 통과 |
| `npm test --workspace=@zep-test/server` | **973/973 통과** (신규 38 포함) |
| `client/e2e` 전체 스위트 (90개) | 1차 89/1 실패 → spec 수정 후 **90/90 통과** (6.6분) |

1차 실행에서 `heritage-monsters.spec.ts`의 "classic normal attack plays directional frames" 하나가
실패했다. 이번 변경(서버 전용)과 무관한 **`e438f35`가 남긴 기존 실패**다: 그 spec은 skin 0이
heritage 외형과 `classic-adventurer-attack.png` 공격 프레임을 쓴다고 단언하는데, `e438f35`가
skin 0의 primary manifest를 master로 교체했고 master는 공격 원화가 없어 idle fallback이 된다.
같은 커밋이 `avatar-manifest.spec.ts`만 갱신하고 이 spec은 두고 갔다.

**수정 방식(사용자 지시로 이번 작업에 포함):** classic 공격 원화는 삭제된 게 아니라 skin 0의
*fallback*으로 여전히 살아 있고(master 이미지 로드 실패 시 실제로 보이는 그림), 이를 덮는 다른
테스트가 없다. 그래서 기대값을 master 동작으로 바꾸는 대신, 기존 `missingTextures` 픽스처로
`master-adventurer.png`를 404 처리해 fallback 경로를 강제하고 단언은 그대로 두었다
(`avatar-manifest.spec.ts`의 "missing master image" 블록과 같은 방식). master 자신의
idle-fallback 공격은 `avatar-manifest.spec.ts`가 이미 덮고 있어 중복되지 않는다.
master 외형이 승인되고 공격 원화가 제작되면 이 블록은 그때 다시 판단할 대상이다.

서버 스위트에는 다음이 포함된다: 미수락 계정의 처치가 행을 만들지 않음, 요구 수량 초과 처치가
네 번째 메시지를 만들지 않음, 다른 계정·다른 몬스터 종에 반영되지 않음, 방을 떠난 뒤 스토어가
답해도 계정에 반영됨, 재접속 시 진행도가 그대로 전달됨, 수락한 퀘스트가 없는 세션은 처치 때
스토어를 호출하지 않음.

Postgres 경로는 실제 DB가 아니라 `progressStore.test.ts`와 같은 stub pool로 검증했다. SQL 문자열의
가드(`completed_at IS NULL`)와 클램프(`LEAST`)는 직접 단언하지만, **실제 Postgres에서의 동시성
동작은 이번에 측정하지 않았다** — `[needs verification]`.

## 보안 검토 결과

별도 감사에서 패치가 필요한 취약점은 나오지 않았다. 확인된 것: `questId`는 방 단위로 좁혀진
`roomQuests`를 통과해야만 스토어에 닿으므로 미인가 id가 DB에 도달하지 않고, `ownerKey`는 항상
서버가 SSO `sub`에서 유도하므로 클라이언트가 남의 행을 쓸 수 없으며, 모든 쿼리는 파라미터
바인딩이고, 행 수는 `계정 수 × 퀘스트 수`로 상한이 잡힌다.

- **[Low, 미적용]** `quest:accept`에 in-flight 중복 가드가 없다(equip/unequip에는 있다). 논리적으로는
  멱등이지만 Postgres MVCC상 매 호출이 heap tuple + WAL을 쓴다. 정상 트래픽은 계정당 평생 1회라
  적용하지 않았고, `handleQuizAnswer`의 선례와 같은 판단이다. 퀘스트가 늘거나 수락류 메시지가
  잦아지면 재검토할 것.
- **[R04 필수 인계]** 완료 전이(`completed_at NULL → NOT NULL`)를 관측하는 것은 `recordKill`의
  **그 호출의 반환값뿐**이다. 보상을 붙일 때 반드시 이 반환값에 직접 걸어야 하며, `list()`나 캐시로
  "방금 완료됨"을 재유도하면 안 된다. 또한 지금 구조에는 재시도 경로가 없다 — 완료 후 보상 지급이
  실패하면 영구히 미지급이 된다. 보상 지급을 완료 UPDATE와 같은 트랜잭션에 넣거나,
  `reward_granted_at` 컬럼을 따로 두어 재시도 가능하게 만들 것.

## 남은 한계와 후속

- 클라이언트 UI 없음. 지금은 서버 계약만 존재하므로 게임 화면에서 퀘스트를 수락할 수 없다.
  (로드맵 R03의 "현재 PC 전용" 절반)
- 수락에 위치 검사가 없다. 방 단위로만 좁힌다 — 퀴즈 응답과 같은 근거이며, 보상이 붙는 R04에서
  다시 판단해야 한다. 이 판단이 만료되는 지점을 `handleAcceptQuest` 주석에 명시했다.
- 실제 Postgres 동시성 미측정(위 참조).
- 요구 수량을 낮추는 재배포를 해도, 이미 옛 요구치를 채운 진행 중 행은 **다음 처치가 있어야**
  완료로 넘어간다. 표시용 클램프가 진행바를 가득 찬 것처럼 보이게 하므로 그 사이에는 "가득 찼는데
  완료가 아닌" 상태가 보일 수 있다. 퀘스트 1개·재조정 이력 없음이라 지금은 고치지 않았다.
- 운영 배포는 수행하지 않았다. KAD 재배포는 사용자 몫.
