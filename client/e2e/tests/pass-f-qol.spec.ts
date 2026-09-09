import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import {
  expectPixelColorAfterKeydown,
  probeAnimationLoop,
  waitForCanvasReady,
} from "../helpers/canvas";
import { holdKey } from "../helpers/input";
import { captureWebSocketFrames } from "../helpers/network";
import { joinRoom, readVitalsText } from "../helpers/flows";

// 리터럴 상수 — @zep-test/shared를 import하지 않는 이유는
// docs/design-client-test-harness.md §2 "상수 중복 — 의도적" 참고.
const ATTACK_COOLDOWN_MS = 600; // shared/src/constants.ts
const PLAYER_MAX_HP = 100; // shared/src/constants.ts (raised from 30 since this literal was written)
const SWING_COLOR = 0xffcc33; // client/src/world/combatEffects.ts
/**
 * 실측(2026-09-02): `client/e2e/tests/../..`에서 방금 접속한 클라이언트로 Space 1회 tap 직후
 * `combat:attack`(`ClientMessage.Attack`, 페이로드 없음) 프레임의 실제 와이어 바이트 길이.
 * `holdKey`로 3쿨다운을 홀드했을 때도 반복되는 sent 프레임이 전부 이 길이였고, 그 간격이
 * ATTACK_COOLDOWN_MS(600ms)에 수렴했다 — join 핸드셰이크 트래픽(20/18/1/724/1035/13x바이트)과
 * 확실히 구분된다.
 */
const ATTACK_FRAME_BYTE_LENGTH = 15;

let browser: Awaited<ReturnType<typeof launchSharedBrowser>>;
let client: Client;

test.beforeAll(async () => {
  browser = await launchSharedBrowser();
});

test.afterAll(async () => {
  await browser.close();
});

test.beforeEach(async () => {
  client = await openFreshClient(browser);
});

test.afterEach(async () => {
  await client.close();
});

// F-6 #1: 홀드 공격 간격이 ATTACK_COOLDOWN_MS(600ms)에 수렴하는가.
test("홀드 공격 간격이 서버 쿨다운에 수렴한다", async () => {
  // network.ts의 계약대로 room 조인 "전"에 호출한다 — 조인 후에 호출하면 이미 열린 WS의
  // "websocket" 이벤트를 놓쳐 프레임이 하나도 안 잡힌다(실측으로 발견한 버그, 원래 TODO 자리에
  // join 다음 줄에서 호출하고 있었다).
  const capture = captureWebSocketFrames(client.page);
  await joinRoom(client.page, "hunting-ground");

  const holdMs = ATTACK_COOLDOWN_MS * 3 + 200; // 3쿨다운 + 여유
  const [frameCount] = await Promise.all([
    probeAnimationLoop(client.page, holdMs),
    holdKey(client.page, "Space", holdMs),
  ]);
  capture.stop();

  // 함정 6: 간격 판정 전에 렌더 루프 생존부터 배제.
  expect(frameCount).toBeGreaterThan(0);

  const attackFrames = capture.frames.filter(
    (frame) => frame.direction === "sent" && frame.byteLength === ATTACK_FRAME_BYTE_LENGTH,
  );
  // 3쿨다운을 홀드했으니 최소 3번(첫 스윙 + 이후 주기)은 나가야 한다.
  expect(attackFrames.length).toBeGreaterThanOrEqual(3);

  const intervals = attackFrames
    .slice(1)
    .map((frame, i) => frame.atMs - attackFrames[i]!.atMs);
  for (const interval of intervals) {
    expect(interval).toBeGreaterThan(ATTACK_COOLDOWN_MS * 0.75);
    expect(interval).toBeLessThan(ATTACK_COOLDOWN_MS * 1.4);
  }
});

// F-6 #2: grand-plaza 첫 프레임부터 HP "30/30"이 보이는가.
test("hunting-ground 첫 프레임부터 HP가 표시된다", async () => {
  await joinRoom(client.page, "hunting-ground");
  const vitals = client.page.locator("#vitals");
  await expect(vitals).toBeVisible();
  expect(await readVitalsText(client.page)).toBe(`${PLAYER_MAX_HP} / ${PLAYER_MAX_HP}`);
});

// F-6 #3: 스윙 아크 색/지속/반경 — 로컬 플레이어는 화면 중심(512,288)에 고정된다.
test("스윙 시 아크 색이 화면 중심 부근에 나타난다", async () => {
  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);

  // 실측(2026-09-02): 매 접속마다 facing=Down으로 스폰하므로(server onJoin, metaverseRoom.ts)
  // 스윙 방향은 "오른쪽"이 아니라 "아래"다 — 원래 TODO 좌표(중심+28,0)는 이 가정이 틀려서
  // 검게(0,0,0) 실패했었다.
  //
  // 이 세션은 동시에 chrome/node 프로세스가 수십 개 떠 있는 환경이라(다른 에이전트들의 병렬
  // 작업) tapKey()+expectPixelColor()처럼 "키 디스패치"와 "픽셀 판독"을 별도의 CDP 왕복 두 번
  // 으로 나누면 그 왕복들 자체의 지연만으로 SWING_MS=350ms를 실제로 넘긴다.
  // expectPixelColorAfterKeydown은 그 둘을 하나의 evaluate() 안에서 수행하고, 부하가 큰 순간의
  // 프레임 드롭까지 감안해 최대 20프레임(~330ms)까지 재시도한다(canvas.ts의 함수 주석 참고 —
  // Clock API로 시계 자체를 얼리는 방법도 시도했으나 Phaser의 루프가 진짜 rAF를 붙잡고 있어
  // 안 먹혔다).
  //
  // 좌표(510,294)·반경 5는 스윙 궤적을 실측한 값 — 아크는 중심(512,272 = 카메라 중심 512,288
  // 에서 TILE_SIZE_PX/2만큼 위)에서 아래로 자라며(반경 28px까지), 프레임이 지날수록 반경이
  // 커져 (505~517, 291~297) 부근을 훑고 지나간다. 이 박스는 그 궤적을 덮으면서도, 그 오른쪽에
  // 있는 스윙과 무관한 고정 장식 요소(x≈521,y≈290 부근, 실측으로 확인 — 정확히 골드색으로
  // 오검출될 수 있다)는 피한다.
  await expectPixelColorAfterKeydown(client.page, "Space", { x: 510, y: 294 }, SWING_COLOR, {
    tolerancePerChannel: 50,
    sampleRadius: 5,
  });
});

// F-6 #4: 어그로 3칸=무반응/2칸=추격 시작(aggroRadiusTiles=2, monsterDefinitions.ts) —
// 몬스터 좌표를 픽셀로 추적하지 않고 #vitals-count(HP) 변화 여부로 판정한다.
test("스폰 근처는 무반응, 몬스터 밀집 지역으로 걸어 들어가면 HP가 줄어든다", async () => {
  await joinRoom(client.page, "hunting-ground");

  // spawn(35,29, spreadRadiusInTiles=2)은 모든 몬스터 스폰 지점과 최소 6타일 이상 떨어지도록
  // 저작되어 있다(monsterDefinitions.ts 표 상단 주석) — aggroRadiusTiles(2)보다 훨씬 밖이라
  // 가만히 있으면 한 번의 방랑 주기 동안 반응이 없어야 한다.
  const atSpawn = await readVitalsText(client.page);
  expect(atSpawn).toBe(`${PLAYER_MAX_HP} / ${PLAYER_MAX_HP}`);
  await client.page.waitForTimeout(1_200);
  expect(await readVitalsText(client.page)).toBe(atSpawn);

  // spawn과 같은 x=35 축에 hg-rabbit-05(35,10)가 있어 경로탐색 없이 곧장 위(ArrowUp)로만 걸어도
  // 접근한다. 다만 몬스터도 매 wanderStepIntervalMs마다 자기 스폰 주변(반경 2~3타일)을 방랑하고
  // 플레이어 스폰도 spreadRadiusInTiles=2로 흔들리므로, 위로만 곧장 걸으면 두 오프셋이 겹쳐
  // Chebyshev 2(aggroRadiusTiles) 밖에 멈추는 경우가 실측상 잦았다(북쪽 도달 후 5초 폴링에도
  // 무반응 1회 관측). ArrowUp 뒤에 ArrowLeft로 옆으로 훑어 접촉 범위를 넓힌다 — 실측
  // (2026-09-02): 3.2초(Up, ~26타일) + 1.2초(Left, ~10타일) 조합으로 다회 반복 거의 전부
  // 250ms 폴링 첫 틱 안에 HP가 줄었고(간헐적으로 몇 틱 더 걸린 사례도 있어 폴링 타임아웃을
  // 넉넉히 8초로 잡았다), 드물게 그 안에도 안 맞는 경우가 있었다(스폰/방랑 오프셋이 겹칠 때) —
  // 그 경우도 재시도 없이 그대로 1회 실패로 보고한다(스윙 아크 쪽과 달리 여긴 서버 쿨다운/방랑
  // 주기가 실제 게임플레이 제약이라 같은 관측을 인위적으로 여러 번 다시 찍는 게 의미가 없다).
  await holdKey(client.page, "ArrowUp", 3_200);
  await holdKey(client.page, "ArrowLeft", 1_200);
  await expect
    .poll(() => readVitalsText(client.page), { timeout: 8_000, intervals: [250] })
    .not.toBe(`${PLAYER_MAX_HP} / ${PLAYER_MAX_HP}`);
});
