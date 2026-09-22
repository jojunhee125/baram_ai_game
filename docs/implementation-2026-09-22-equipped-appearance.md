# 2026-09-22 장착 장비 외형 반영

## 승인·시작 상태

사용자가 제안1번 “장착 장비 외형 반영”에 “네 1번으로 코드 개발 시작”으로 구현을 승인했다. 무기·방어구를 캐릭터에 표시하고 이동·공격·방향 전환에 맞춰 정렬하는 범위다. 기존 자산과 렌더링을 확인해 상세 계약을 설계한다.

git fetch origin 후 main과 origin/main은 `28f8d39`로 일치하며 작업 트리는 깨끗했다. branch/worktree 분기 없이 main에서만 작업·커밋·push한다.

## 진행 상태

구현·독립 검토·검증 완료. 전체1193개·browser50개와 typecheck/build를 통과했다. 기존 atlas는 옷까지 합쳐진 이미지이므로 원본 이미지를 변형하지 않고 새 code-native pixel 레이어를 사용한다. 단검·사냥꾼 검·철검 및 누비옷·가죽갑옷·강화 갑옷을 구분한다. main에 커밋·push하며 운영 배포는 수행하지 않았다.

- 서버는 실제 장착 cache에서 weaponItemKey/armorItemKey만 replicated Player에 반영한다. 모든 방에서 초기 장비를 읽어 재접속/방 이동 후 외형을 복원한다.
- 본인과 원격 플레이어의 현재 렌더링 위치·방향·이동을 따라간다. 본인의 공격 동작에도 정렬한다. 현재 원격 빈 공격에는 broadcast가 없으므로 새 공격 protocol을 추가하거나 skill hit를 평타로 추측하지 않는다.
- 기존 전투 수치·DB·장착 권한·가격은 변경하지 않는다. helmet/cloak/ring의 외형과24종 전용 장비 원화는 이번 범위 밖이다. 사용자 시각 승인·운영 배포는 별도다.

## 실제 변경

- `shared/src/state.ts`: 기존 Player 마지막에 공개 외형키2개 append. `server/src/rooms/metaverseRoom.ts`: store 구독·승인된 hydration·장착 성공 cache에서만 key를 투영하며 unknown/slot 불일치는 빈값으로 처리한다. 기존 StateView 가시성 범위를 따른다.
- `client/src/net/roomConnection.ts`: snapshot에 optional 외형키를 전달한다. `localPlayer.ts`: 이동 reconciliation의 early return 전에 서버 외형을 반영한다.
- `client/src/world/equipmentAppearance.ts`: 원본 pixel texture15개를 공유 cache로 생성하고 플레이어마다 무기/갑옷 sprite최대2개를 부착한다. 공격 clip이 없는 기본 아바타에도180ms local weapon pose를 제공한다.
- `avatarArt.ts`는 현재 manifest/frame의 읽기 accessor, `playerSprites.ts`는 실제 frame foot·위치·방향·scale·alpha·visibility·depth 동기화 및 제거/scene 종료 정리를 담당한다.
- `client/src/scenes/WorldScene.ts`: 이전 로컬 HTTP 기반 무기 추정과 중복 단검 icon 호출을 해제했다. 기존 WeaponVisualState/CombatEffects의 legacy export는 호환 테스트를 위해 남아 있으나 새 외형의 상태 근거로 사용하지 않는다.
- 독립 검토에서 같은 행 actor 사이 장비 혼합과 공격 직후 방향 변경 시 옛 무기 pose 유지2건을 발견했다. actor별 좁은 depth 구간과 swing 취소를 적용했다. shutdown 중 반복 rank 재계산도 방지했다.
- `server/src/rooms/equipmentAppearance.verification.test.ts` 신규6개. 기존 armorEquip/equipmentSlots/entryPass의 grand-plaza 장비조회0 기대값을 공개 외형 hydration1회로 갱신했으며 portal 소지품조회0 검증은 유지했다.

## 검증

- `npx tsx --test --test-timeout=90000 server/src/rooms/equipmentAppearance.verification.test.ts server/src/rooms/equipmentSlots-verification.test.ts server/src/rooms/armorEquip-verification.test.ts`: **32/32 PASS**. 신규6개는 전5room·재접속·late hydration·같은 계정 구독·성공/실패·잘못된 key·Encoder/Decoder 및 실제2client socket의 장착/해제·시야제외/재진입·비공개 verdict 미유출을 검증한다.
- 최초 전체 검사에서 entryPass의 기존 무전투방 장비조회0 기대값1건이 실패했다. 위 새 계약으로 기대값만 수정한 뒤 해당 파일 **9/9 PASS**. 담당 coder 재호출은 thread limit로 거절되어 main이 이 작은 fixture만 수정했고 독립 reviewer가 검토했다.
- `npm test` 최종 **1193/1193 PASS**(shared26+server1167), 실패·skip0, 서버37.64초. 로그 `%TEMP%/ksc-equipped-appearance-all-tests-final.log`.
- `npm run typecheck`: shared/server/client PASS. UI 최종수정 후 client typecheck 및 `npm run build`: PASS,94modules,4.28초. 기존500KB chunk 경고 유지.
- 실제 Phaser screenshot의 기본 아바타/legacy32px×3장비조합×4방향을 main·tester·reviewer가 직접 확인했다. 세 무기의 길이·형태와 갑옷 차이를 구분할 수 있고 머리·손·발이 보인다.
- `client/e2e`에서 `npx playwright test tests/equipped-appearance.spec.ts tests/avatar-manifest.spec.ts tests/classic-combat-status.spec.ts tests/heritage-monsters.spec.ts tests/pass-g-combat-loot.spec.ts --output=test-results/equipment-appearance-final`: **50/50 PASS**,1.1분. 신규9개는 실제 renderer의 장착/해제·24조합·보호영역·예측이동 중 외형patch·warp·local공격·동일위치 actor 겹침·교체100회/종료·fallback을 검증했다.
- 첫 browser 회귀41/50 통과 후 기존4개 spec의 오래된 지역명·atlas 실패route·depth기대값·HTTP무기추정·전리품 경험치 표시 fixture를 현재 계약으로 교정했다. 기본 geometry/실제 frame·가격과 무관한 기존 drop확률·공격 입력 검증은 유지했다. 첫 신규7개 실행의 보호영역/manifest 확인2건도 실제 frame기준으로 교정했다.
- `npx tsc --noEmit -p client/e2e/tsconfig.json` PASS. Screenshot3개는 `client/e2e/test-results/equipment-appearance-final/` 아래 조합·겹침·fallback PNG로 보존(Git 제외). 독립 tester는3개를 직접 확인했고 main은 조합·겹침을 직접 확인했다. 테스트용2567/5173 LISTEN 해제 확인.
- 독립 reviewer가 시각결함2건 수정 delta와 server/state privacy 및 entryPass fixture를 승인했다. `git diff --check` PASS.

## 한계

- 원격 idle/walk와 장비 변경은 replicated state로 표시한다. 원격 빈 공격/skill별 attack pose 신호는 추가하지 않았다.
- 전용 hand-painted native 장비 atlas가 아닌 원본 code-native overlay이며 완전한24skin 맞춤 원화나 원작 품질 재현 완료가 아니다.
- 무전투방도 장비 복원 조회1회가 필요하다.500CCU 성능 PoC를 수행한 것은 아니다. DB schema/query/정산은 변경하지 않아 PostgreSQL opt-in2suite는 환경변수 미설정으로 이번에 실행하지 않았다.
- 기존 다중 process cache 동기화·직접 room 입장 조건 우회·장시간 플레이·사용자 시각 승인·운영 배포는 별도다.
- 시각 검증은 Windows/Chromium의 실제 Phaser·배포 atlas fixture이며 실제 서버2client 검증과 분리한 증거다. 다른OS/500CCU 및 실제 계정 장시간 플레이는 이번 검증 범위 밖이다.
