# 왕초보 사냥터 EXP·레벨 곡선 8배 하향 (2026-09-17)

결정 근거: [decisions.md](decisions.md) "왕초보 사냥터 EXP·레벨 곡선 8배 하향".

## 목적

레벨업이 너무 빠르다는 사용자 지적. 다람쥐·토끼·사슴은 최하급 사냥터의 몬스터이므로 이 사냥터만으로는 성장이 매우 느려야 한다.
원인은 커브가 아니라 **왕초보 몬스터 보상이 커브 대비 과대**했던 것이다 — 다람쥐 4 EXP, 레벨1 문턱 10 EXP, 즉 3킬이면 Lv2.

## 실제 변경

| 파일 | 변경 |
|---|---|
| [shared/src/leveling.ts](../shared/src/leveling.ts) | `expToNextLevel` 계수 `10` → `20`. 누적 30레벨 34,438 → 68,881 |
| [server/src/rooms/monsterDefinitions.ts](../server/src/rooms/monsterDefinitions.ts) | `expReward` 다람쥐 4→1, 토끼 7→2, 사슴 11→3. **보스 600 유지** |
| [server/src/rooms/levelSystem.test.ts](../server/src/rooms/levelSystem.test.ts) | 곡선 공식 단언 `10 * L^1.7` → `20 * L^1.7`, 누적 총량 단언 ~34,000 → ~69,000 |
| [client/e2e/tests/phase-w2-level-client.spec.ts](../client/e2e/tests/phase-w2-level-client.spec.ts) | 스펙이 들고 있던 곡선 사본 계수 10→20, 1킬 후 EXP 바 판정 근거 주석 갱신 |

프로토콜·스키마·저장 데이터는 바꾸지 않았다. 레벨은 항상 `levelForExp(exp)`로 파생되므로([0006 주석](../server/migrations/0006_player_progress.sql)) **마이그레이션도 브로드캐스트도 없고, 기존 계정의 저장된 EXP가 새 곡선으로 재해석되어 레벨이 내려간다.** 마이그레이션이 필요 없다는 것이지 레벨이 보존된다는 뜻이 아니다 — 아래 §한계 참조.

## 전후 비교

가정: 다람쥐 1킬 ≈ 6초(전투 1.2s + 이동). 측정치가 아니라 산식 기반 추정이다.

| | 전 (exp 4 · k 10) | 후 (exp 1 · k 20) |
|---|---|---|
| Lv2 | 3킬 (18초) | 20킬 (2분) |
| Lv5 | 54킬 (5분) | 425킬 (43분) |
| Lv10 | 403킬 (40분) | 3,226킬 (5.4시간) |
| Lv30 | 8,610킬 (14시간) | 68,881킬 (115시간) |

## 검증

```
$ npx tsx --test --test-timeout=90000 src/rooms/levelSystem.test.ts \
    src/rooms/levelSystem-raceCondition.test.ts src/rooms/monsterDefinitions.test.ts \
    src/db/progressCache.test.ts
ℹ tests 56   ℹ pass 56   ℹ fail 0   duration_ms 1112.7

$ (shared) npx tsc --noEmit    → exit 0
```

전체 스위트도 호출자가 직접 실행했다.

```
$ npm test --workspace @zep-test/server      → 1005 pass / 0 fail (38.3초)
$ npm run typecheck                          → shared·server·client 전부 에러 0
$ (client/e2e) npx playwright test           → 92 passed / 1 failed (11.8분)
```

**e2e 실패 1건은 이 변경과 무관하다 — 통제 실험으로 확인했다.**
`phase-x2-death-notice.spec.ts`가 180초 타임아웃으로 실패한다. 이 스펙은 플레이어가 공격하지 않고 서서 맞아 죽는 것만 검증하므로 킬이 없고 따라서 EXP 경로를 타지 않는다. 확인을 위해 `shared/src/leveling.ts`와 `server/src/rooms/monsterDefinitions.ts`를 HEAD(`f06d20d`) 상태로 되돌리고 같은 스펙을 단독 실행했고, **되돌린 코드에서도 동일하게 실패**했다(3.3분, 같은 teardown 타임아웃). 되돌렸던 두 파일은 즉시 복원했다.
→ 이 변경 이전부터 있던 실패다. 원인 규명은 별도 과제로 남긴다.

**실행하지 않은 것**
- 실플레이 체감 확인: 미실시. 위 소요시간은 전부 산식 추정이다.

## 한계·후속

- **기존 계정의 레벨이 내려간다.** 곡선이 2배가 되었으므로 저장된 EXP가 그대로여도 `levelForExp`가 낮은 레벨을 돌려준다(예: 구 Lv10 = 1,612 EXP → 신 Lv7). 프로토타입이고 계정 수가 적어 보정 없이 받아들인다. 필요하면 별도 1회성 EXP 배수 보정이 필요하다.
- **왕초보 사냥터만으로는 Lv30 도달이 사실상 불가**하다(의도). R07 테마 지역은 더 강한 몬스터만이 아니라 자기 몫의 EXP 보상을 함께 정의해야 한다.
- 사망 패널티(총 EXP의 1%)는 손대지 않았다. 획득이 8배 느려진 만큼 회복 킬수도 8배가 된다.
- 보스 1킬 = 다람쥐 600마리. 6시간 리스폰이 상한 역할을 하지만, 사냥터의 최속 성장 경로가 보스라는 점은 R07에서 재검토 대상이다.
