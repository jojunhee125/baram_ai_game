import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { holdKey, tapKey } from "../helpers/input";
import { captureWebSocketFrames } from "../helpers/network";
import { joinRoom } from "../helpers/flows";

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

/**
 * 픽셀 색 검증(`expectPixelColor` 등)을 여기서는 쓰지 않는다 — 이 스펙 작성 중 이 샌드박스에서
 * 실측한 두 가지 함정 때문이다: (1) `expectPixelColor`의 1순위 경로(WebGL `gl.readPixels`)가
 * 렌더 루프 밖의 호출 시점에 이미 지워진 프레임버퍼를 읽어 항상 (0,0,0)을 반환하고
 * (`preserveDrawingBuffer` 미설정 — Phaser 기본값), 폴백 조건("gl이 null")에는 걸리지 않아
 * 조용히 틀린 값을 성공으로 리포트한다. (2) 스크린샷 폴백 경로로 바꿔도 아바타 자체의 피부/머리
 * 색조가 이 색 계열과 자주 겹쳐 오탐이 났고, 반대로 실제 확장 스윙 지속시간(SWING_MS 임시 7초로
 * 늘려 확인)에도 스윙 아크 색이 화면 어디에도 잡히지 않아 "렌더링 여부"를 픽셀로 단정할 수 없었다
 * (동일 세션에서 기존 Graphics 기반 기능인 포탈/상호작용 마커는 스크린샷에 정상적으로 잡히는 것도
 * 확인했다 — Graphics 자체가 이 환경에서 전혀 안 그려지는 문제는 아니다). 그래서 여기서는 "그려
 * 졌다"를 픽셀로 주장하는 대신, 새 코드 경로가 콘솔 에러 없이 끝까지 실행되는지(회귀 없음)와
 * `WeaponVisualState`의 배선(부팅 시 1회 인벤토리 읽기 → 스윙 시 분기)이 계약대로 도는지를
 * 확인한다. 시각적 최종 확인은 handoff에 별도로 남긴다.
 */
test("스윙이 무기 비주얼 도입 후에도 콘솔 에러 없이 실행된다 (old-dagger 미보유)", async () => {
  const consoleErrors: string[] = [];
  client.page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);
  await client.page.waitForTimeout(300); // WeaponVisualState의 부팅 시 인벤토리 읽기가 끝날 시간
  await tapKey(client.page, "Space");
  await client.page.waitForTimeout(400); // SWING_MS(350ms) 전체가 지나가는 걸 지켜본다

  expect(consoleErrors).toEqual([]);
});

test("부팅 시 인벤토리를 1회 읽어 old-dagger 보유 여부를 확인한다", async () => {
  let inventoryRequests = 0;
  await client.page.route("**/api/inventory", (route) => {
    inventoryRequests += 1;
    return route.continue();
  });

  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);
  await client.page.waitForTimeout(300);

  expect(inventoryRequests).toBe(1);
});

test("old-dagger를 보유한 계정도 스윙이 콘솔 에러 없이 실행된다(무기 오버레이 경로)", async () => {
  // WeaponVisualState는 부팅 시 1회 GET /api/inventory를 읽는다 — 실제 드랍(3% 확률)을
  // 기다리는 대신, 그 응답을 가로채 "이미 보유"를 재현해 weaponFrame이 정의된 분기
  // (itemFrame 조회 + 무기 스프라이트 생성/트윈)를 실행시킨다.
  const consoleErrors: string[] = [];
  client.page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await client.page.route("**/api/inventory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ itemKey: "old-dagger", name: "낡은 단검", icon: "old-dagger", quantity: 1 }],
      }),
    }),
  );

  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);
  await client.page.waitForTimeout(300);
  await tapKey(client.page, "Space");
  await client.page.waitForTimeout(400);

  expect(consoleErrors).toEqual([]);
});

test("L 키로 확률표가 열리고 다람쥐/토끼 드랍률이 표시된다", async () => {
  await joinRoom(client.page, "hunting-ground");

  const button = client.page.locator("#loot-table-button");
  await expect(button).toBeVisible();
  await tapKey(client.page, "KeyL");

  const panel = client.page.locator("#loot-table");
  await expect(panel).toBeVisible();

  const monsters = panel.locator(".loot-table__monster");
  await expect(monsters).toHaveCount(2);

  const squirrel = monsters.nth(0);
  await expect(squirrel.locator(".loot-table__monster-name")).toHaveText("다람쥐");
  const squirrelChances = await squirrel.locator(".loot-table__drop-chance").allTextContents();
  // A 4th row ("entry-pass", 15%) was added to the squirrel loot table after this literal was
  // written (server/src/rooms/monsterDefinitions.ts); the array grew from 3 rows to 4.
  expect(squirrelChances).toEqual(["60%", "25%", "8%", "15%"]);

  const rabbit = monsters.nth(1);
  await expect(rabbit.locator(".loot-table__monster-name")).toHaveText("토끼");
  const rabbitChances = await rabbit.locator(".loot-table__drop-chance").allTextContents();
  expect(rabbitChances).toEqual(["55%", "35%", "12%", "3%"]);

  // Escape로 닫힌다.
  await client.page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("몬스터가 없는 room에서는 빈 상태 문구가 뜬다", async () => {
  await joinRoom(client.page, "grand-plaza");
  await tapKey(client.page, "KeyL");

  const status = client.page.locator("#loot-table-status-text");
  await expect(status).toHaveText("이 지역에는 몬스터가 없습니다.");
});

test("확률표가 열려 있어도 공격은 계속된다", async () => {
  // network.ts의 계약대로 room 조인 "전"에 호출한다 — 조인 후에 호출하면 이미 열린 WS의
  // "websocket" 이벤트를 놓쳐 프레임이 하나도 안 잡힌다(pass-f-qol.spec.ts와 같은 함정).
  const capture = captureWebSocketFrames(client.page);
  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);
  await tapKey(client.page, "KeyL");
  await expect(client.page.locator("#loot-table")).toBeVisible();

  // 함정 6: 단발 tap은 렌더/입력 타이밍에 따라 관측이 0이 될 수 있어 hold로 확인한다.
  await holdKey(client.page, "Space", 200);
  await client.page.waitForTimeout(100);
  capture.stop();
  const attackFrames = capture.frames.filter(
    (frame) => frame.direction === "sent" && frame.byteLength === 15,
  );
  expect(attackFrames.length).toBeGreaterThanOrEqual(1);

  // 2026-09-03 결정: 어떤 패널이 열려 있든 공격은 항상 가능해야 한다(design §3.4).
  // 이동이 막히지 않는 것은 pass-f-qol.spec.ts의 probeAnimationLoop 계열이 이미 다룬다.
});
