# R03 마을과 첫 사냥 — 설계·구현·검증

[로드맵](roadmap.md) R03 "목표를 가진 마을"의 단일 문서. 승인 이력은 [decisions.md](decisions.md).
**구현 완료(2026-09-16~17, `f06d20d`).** 보상 지급은 없다 — 지급 경로 자체를 만들지 않았고 [R04](r04-settlement.md)가 그 자리다.

## 1. 구현된 계약

```
NPC 진입 ──→ InteractableEntered(quests[]) ──→ 패널: 제목·제안문·목표·[수락]
[수락]  ──→ quest:accept {questId} ──→ QuestStore.accept ──→ quest:updated ─┬→ 패널: 진행 중 n/m
처치    ──→ lastHit ──→ QuestStore.recordKill ──→ quest:updated(변화시만) ──┴→ 트래커 갱신
재접속  ──→ onJoin hydrate ──→ 수락분마다 quest:updated ──────────────────→ 트래커 복원
```

| 항목 | 값 |
|---|---|
| 퀘스트 | `first-hunt` — 안내 NPC `plaza-hunting-ground-npc`가 제시, 다람쥐 3마리 |
| 저장 | `quest_progress(owner_key, quest_id)` PK + `kill_count` + `completed_at` |
| 상태 파생 | `completed_at IS NULL` = 진행. status 컬럼 없음 |
| 요구 수량 | DB에 저장하지 않고 `QUEST_DEFINITIONS`에서 호출마다 파라미터로 전달 |
| 귀속 | last-hit — EXP·드롭과 같은 규칙, 같은 `lastHit` 값 |
| 트래커 | 수락·완료만 표시. `offered`는 NPC 패널의 몫 |
| 텍스트 | 전부 서버 문자열. 클라이언트에 퀘스트 표가 없다 |

콘텐츠 자리표시 2개도 함께 넣었다 — `plaza-shop-npc`(47,25)와 `hunting-ground-return-npc`(39,29). 둘 다 대화만 있고 화폐·구매·새 이동 수단이 없다. 후자는 **`blocksMovement: false`** 다: 몬스터가 있는 방에 놓인 첫 오브젝트라, 쫓기는 중에 밟아 패널이 뜨면 맞으면서 못 움직이게 된다.

## 2. 동시성

처치 반영은 단일 UPDATE다. `completed_at IS NULL` 가드가 미수락·완료 행을 0행으로 만들고 `LEAST($3, kill_count + 1)`이 요구 수량을 넘지 못하게 한다. 두 탭이 동시에 잡아도 증가는 두 번, 완료는 한 번이다. 수락은 자기대입 `ON CONFLICT DO UPDATE` 한 번의 왕복이라 `updated_at`을 건드리지 않아 재수락이 진행으로 보이지 않는다.

세션 캐시는 최적화일 뿐이고 완결 여부는 별도 플래그가 판정한다. hydration 전의 처치는 캐시를 믿지 않고 스토어에 직접 묻는다.

## 3. 구현 중 잡은 결함 3건 (전부 수정됨)

**퀘스트 유실 — hydration 완료 판정.** 처음에는 "캐시 맵이 non-null이면 hydration 완료"로 봤다. hydration 창 안에서 수락이 먼저 커밋되면 맵이 한 행만 든 채 non-null이 되고, 그 상태에서 *다른* 퀘스트의 처치가 들어오면 미수락으로 오판해 스토어를 호출하지 않는다 — 지연이 아니라 **영구 유실**이다. 퀘스트가 1개인 지금은 관측되지 않고 2개째가 추가되는 순간 조용히 발생한다. 플래그를 분리했고, 옛 판정식으로 되돌리면 실패하는 회귀 테스트를 남겼다.

**join 직후 메시지 유실.** 서버는 join 직후 hydration이 끝나자마자 `quest:updated`를 보내는데 클라이언트는 `attach()`에서야 핸들러를 등록했고 그 사이에 맵 로딩 전체가 들어간다. Colyseus는 핸들러 없는 메시지를 버리므로 "방을 옮기면 퀘스트가 트래커에서 사라졌다가 다음 처치 때 되살아나는" 증상이 된다. → 이 핸들러만 생성자에서 등록하고 `attach()` 이전 도착분은 버퍼에 모았다가 microtask로 재생한다. 다른 메시지는 전부 플레이어 자신의 행동이 원인이라 `attach()` 이전에 발생할 수 없다.

**클래식 스킨 배치 회귀.** 트래커를 좌상단 새 컬럼에 넣었더니 `heritage.css`가 `.vitals`를 우측 사이드바 하단으로 재배치하는 오프셋이 깨졌다 — 그 오프셋은 `.vitals`가 `position: absolute`일 때만 먹는데 컬럼으로 감싸며 `relative`가 됐다. 컬럼을 버리고 두 스킨이 이미 공유하는 `.hud` 안으로 옮겼다.

## 4. 검증

| 검사 | 결과 |
|---|---|
| 서버 스위트 | 976 pass / 0 fail |
| `npm run typecheck` (3 workspace) | 에러 0 |
| `client/e2e` 전체 | 93/93 통과 (9.9분) |
| 실제 PostgreSQL 16.15 동시성 | 5/5 통과 (opt-in, `ZEP_TEST_DATABASE_URL`) |

실DB에서 증명한 것: 동시 처치 2회 → 카운터 정확히 2증가·완료전이 정확히 1회 관측 / 완료 후 추가 처치는 `null`이고 저장값 불변 / 동시 5회 처치에도 클램프가 3을 넘기지 않음 / 동시 `accept` 2회가 정확히 한 행만 생성 / 미수락 계정의 처치는 행을 만들지 않음.

컨테이너 기동은 Windows PATH에 docker가 없어 WSL Ubuntu를 경유한다. 유휴 WSL VM이 종료되면 dockerd와 함께 컨테이너도 죽으므로 세션 유지가 필요하다:

```
wsl -d Ubuntu -- bash -c "docker run -d --name zep-pg -e POSTGRES_PASSWORD=zep -p 55432:5432 postgres:16 && sleep infinity"
cd server && ZEP_TEST_DATABASE_URL="postgres://postgres:zep@127.0.0.1:55432/postgres" npx tsx --test src/db/questStore.realdb.test.ts
wsl -d Ubuntu -- docker rm -f zep-pg   # 정리
```

## 5. 한계와 인계

- **브라우저에서 처치 진행이 올라가는 장면은 SSO 환경에서만 확인 가능하다** `[needs verification]`. e2e 환경은 SSO가 없어 계정 키가 `client.sessionId`라, 북문으로 사냥터에 들어가는 순간 다른 계정으로 재접속되어 수락분이 따라오지 않는다. 카운터 자체는 서버 스위트가, 그려지는 모습은 white-box 테스트가 덮는다.
- **R04 인계(일부 해소됨).** 완료 전이를 관측하는 것은 `recordKill`의 **그 호출 반환값뿐**이다. 보상은 반드시 이 반환값에 걸어야 하고 `list()`나 캐시로 "방금 완료됨"을 재유도하면 안 된다. 재시도 경로가 없다는 문제는 R04-a의 멱등 원장이 받아가며, 실제 배선은 R04-b다.
- 수락에 위치 검사가 없다(방 단위로만 좁힘). 보상이 붙는 R04-b에서 다시 판단할 것 — 만료 지점을 `handleAcceptQuest` 주석에 명시했다.
- `[Low, 미적용]` `quest:accept`에 in-flight 중복 가드가 없다. 논리적으로 멱등이나 호출마다 heap tuple + WAL을 쓴다. 계정당 평생 1회라 적용하지 않았다.
- 요구 수량을 낮추는 재배포를 해도 이미 옛 요구치를 채운 진행 행은 다음 처치가 있어야 완료로 넘어간다. 그 사이 "가득 찼는데 완료가 아닌" 표시가 보일 수 있다.
- 상점·귀환 NPC의 브라우저 시각 확인은 하지 않았다(서버 테이블·e2e 회귀만).
- 운영 배포는 사용자 몫(KAD 재배포).
