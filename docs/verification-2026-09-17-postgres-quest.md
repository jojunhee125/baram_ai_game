# 퀘스트 진행도 실제 Postgres 동시성 검증

기준일: 2026-09-17. `docs/implementation-2026-09-16-quest-state.md` §동시성이 남긴
`[needs verification]`(Postgres 경로는 stub pool로만 검증, 실제 DB 동시성 미측정)을 닫는다.
승인 근거는 `docs/decisions.md` 2026-09-17 항목 "R03 잔여 코드작업 일괄 승인" (3).

## 결론

`PostgresQuestStore`(`server/src/db/questStore.ts`)의 SQL은 실제 Postgres 16에서
`implementation-2026-09-16-quest-state.md`가 서술한 동작 그대로 동작한다. 기존 문서의 주장은
모두 사실로 확인되었고, 틀린 것은 없었다. 버그도 발견되지 않아 프로덕션 코드는 수정하지 않았다.

## 무엇을 증명했는가 (모두 실제 Postgres 대상, stub 아님)

1. **동시 처치 2회 → 카운터 정확히 2회 증가, 완료전이는 정확히 1회 관측.** 같은 계정·퀘스트에
   `requiredCount=2`로 동시 `recordKill` 2회를 쏘면 반환값의 `killCount`는 `{1,2}` 집합이고,
   `completed:true`는 둘 중 정확히 하나에서만 관측된다. 이 관측은 **그 호출의 반환값에만
   존재**한다는 것도 확인 — 구현 문서의 R04 인계 경고("`list()`나 캐시로 재유도하면 안 된다")가
   실측으로 뒷받침된다.
2. **`completed_at IS NULL` 가드.** 완료 후 추가 처치는 `null`을 반환하고, `kill_count`·
   `completed_at` 모두 완료 시점 값에서 변하지 않는다(원본 쿼리로 직접 대조).
3. **`LEAST($3, kill_count + 1)` 클램프.** `requiredCount=3`에 대해 동시 5회 처치 시 정확히
   3회만 진행을 인정(`killCount<=3`)하고 나머지 2회는 가드에 걸려 `null` — 저장된 카운터는
   5번 다 몰려도 3을 넘지 않는다.
4. **`accept` 멱등성, `updated_at` 불변.** 진행 중인 퀘스트를 재수락해도 `updated_at`이
   그대로다(원본 쿼리 대조). 완전히 새 계정에 대한 동시 2회 `accept`도 정확히 한 행만 만들고
   (`count(*) = 1`), 둘 다 같은 `{killCount:0, completed:false}`를 반환한다.
5. **미수락 계정의 처치는 행을 만들지 않음.** `recordKill`은 `null`을 반환하고, 해당
   owner+quest 조합의 행은 아예 존재하지 않는다(원본 SELECT로 확인).

## 실행 명령

```
# 컨테이너 기동 (Windows PATH에 docker 없음 → WSL Ubuntu 경유, WSL 세션 유지를 위해
# 백그라운드로 & sleep infinity를 붙임 — 그렇지 않으면 유휴 WSL VM이 곧바로 종료되어
# dockerd와 함께 컨테이너도 죽는다는 것을 실제로 겪었다: 5432 포트 충돌 회피 겸
# 55432로 첫 실행 후, VM 유휴 종료로 컨테이너가 "Exited"된 것을 docker ps -a로 확인함)
wsl -d Ubuntu -- bash -c "docker run -d --name zep-pg -e POSTGRES_PASSWORD=zep -p 55432:5432 postgres:16 && sleep infinity"

# Windows → WSL 컨테이너 연결 확인 (localhost 포트포워딩으로 바로 성공)
node -e "require('pg') ..." # SELECT 1 OK 확인

# 마이그레이션은 앱이 쓰는 실제 경로 재사용 — server/src/db/migrate.ts의 runMigrations(pool)를
# 새 테스트 파일의 before()에서 그대로 호출, 0001~0007을 순서대로 적용

cd server
ZEP_TEST_DATABASE_URL="postgres://postgres:zep@127.0.0.1:55432/postgres" \
  npx tsx --test --test-timeout=90000 "src/db/questStore.realdb.test.ts"

# 정리
wsl -d Ubuntu -- docker rm -f zep-pg
```

Postgres 버전: `postgres:16` 이미지, 컨테이너 로그 기준 **PostgreSQL 16.15**.

## 실제 출력

```
[zep-test] applied migration 0001_player_profile
[zep-test] applied migration 0002_inventory_item
[zep-test] applied migration 0003_inventory_item_equipped
[zep-test] applied migration 0004_equipment_slots
[zep-test] applied migration 0005_monster_defeat
[zep-test] applied migration 0006_player_progress
[zep-test] applied migration 0007_quest_progress
▶ PostgresQuestStore — concurrency against a real server
  ✔ two concurrent kills increase the counter exactly twice and only one observes completion (17.9012ms)
  ✔ completed_at IS NULL guard: a kill after completion changes nothing (7.05ms)
  ✔ LEAST clamp: the counter never exceeds the requirement under concurrency (17.7316ms)
  ✔ accept is idempotent and does not touch updated_at, including concurrent accepts (14.7084ms)
  ✔ a kill for an account that never accepted creates no row (2.5147ms)
✔ PostgresQuestStore — concurrency against a real server (169.8546ms)
ℹ tests 5
ℹ suites 1
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 379.0396
```

기본 스위트(환경변수 없이)는 이 신규 파일을 건드리지 않는다 — describe 레벨 `skip`이라
`tests 0`으로 집계되어(`inventoryStore.test.ts`·`equipmentSlotsMigration.test.ts`의 기존
관례와 동일한 node:test 동작) 개수가 늘지 않는다:

```
npm test --workspace=@zep-test/server
...
ℹ tests 973
ℹ suites 203
ℹ pass 973
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

`implementation-2026-09-16-quest-state.md`가 기록한 973/973과 정확히 같은 수 — 신규 opt-in
파일이 기본 실행에서 0개로 스킵되는 것과 일치한다.

```
npm run typecheck   (루트, shared/server/client 전부)
> 세 워크스페이스 모두 통과, 에러 없음
```

## 새로 추가한 파일

- `server/src/db/questStore.realdb.test.ts` — opt-in 실제 Postgres 동시성 스위트,
  `ZEP_TEST_DATABASE_URL` 미설정 시 스킵. `runMigrations`로 실제 마이그레이션을 적용하고
  매 테스트가 `randomUUID()` owner로 격리되어 대상 DB의 기존 데이터를 건드리지 않는다.

프로덕션 코드는 변경하지 않았다 — 버그가 발견되지 않았다.

## 남은 한계 / 미검증

- 컨테이너 1개, 커넥션 풀 1개(`max: 8`) 안에서의 동시성만 확인했다. 여러 서버 프로세스(다중
  Coolify 컨테이너)가 각자의 풀로 같은 행을 동시에 치는 시나리오는 이번에 재현하지 않았다 —
  다만 Postgres 행 잠금은 커넥션 출처와 무관하므로 위험이 다르다고 볼 근거는 없다.
- 5회 동시 처치까지만 스트레스를 걸었다. 그보다 큰 동시성(수십~수백)에서의 동일 보장은
  외삽이지 실측이 아니다.
- `reward_granted_at` 재시도 경로는 여전히 존재하지 않는다 — 이는 R04 설계 대상이라는
  기존 문서의 인계 사항 그대로이며 이번 작업 범위 밖이다.
- 컨테이너는 검증 후 `docker rm -f zep-pg`로 제거했다 — 재확인: `docker ps -a`에 `zep-pg`
  없음.
