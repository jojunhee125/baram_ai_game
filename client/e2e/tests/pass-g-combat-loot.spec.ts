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

// Full-world input/loot regression. Authoritative appearance rendering and actual atlas pixels
// are tested independently in equipped-appearance.spec.ts; HTTP inventory is only a bag fixture.
test("스윙이 무기 비주얼 도입 후에도 콘솔 에러 없이 실행된다 (old-dagger 미보유)", async () => {
  const consoleErrors: string[] = [];
  client.page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);
  await client.page.waitForTimeout(300);
  await tapKey(client.page, "Space");
  await client.page.waitForTimeout(400); // SWING_MS(350ms) 전체가 지나가는 걸 지켜본다

  expect(consoleErrors).toEqual([]);
});

test("외형은 공개 장착 상태를 사용하므로 부팅 시 인벤토리를 조회하지 않는다", async () => {
  let inventoryRequests = 0;
  await client.page.route("**/api/inventory", (route) => {
    inventoryRequests += 1;
    return route.continue();
  });

  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);
  await client.page.waitForTimeout(300);

  expect(inventoryRequests).toBe(0);
});

test("HTTP 가방에 단검을 표시한 뒤에도 실제 공격 입력은 오류 없이 동작한다", async () => {
  const consoleErrors: string[] = [];
  client.page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await client.page.route("**/api/inventory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ itemKey: "old-dagger", name: "낡은 단검", icon: "old-dagger", quantity: 1, equipped: false }],
      }),
    }),
  );

  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);
  await tapKey(client.page, "KeyI");
  await expect(client.page.locator('.bag__row[data-item-key="old-dagger"]')).toBeVisible();
  await client.page.keyboard.press("Escape");
  await tapKey(client.page, "Space");
  await client.page.waitForTimeout(400);

  expect(consoleErrors).toEqual([]);
});

test("L 키로 확률표가 열리고 다람쥐/토끼/보스 드랍률이 표시된다", async () => {
  await joinRoom(client.page, "hunting-ground");

  const button = client.page.locator("#loot-table-button");
  await expect(button).toBeVisible();
  await tapKey(client.page, "KeyL");

  const panel = client.page.locator("#loot-table");
  await expect(panel).toBeVisible();

  const monsters = panel.locator(".loot-table__monster");
  // Phase I (2026-09-09) added a boss spawn row to this room (`hg-boss-01`,
  // server/src/rooms/monsterDefinitions.ts), so this room's table grew from 2 kinds to 3. The
  // order follows MONSTER_TYPES' own insertion order, which puts the boss last.
  await expect(monsters).toHaveCount(3);

  const squirrel = monsters.nth(0);
  await expect(squirrel.locator(".loot-table__monster-name")).toHaveText("다람쥐 · 경험치 1");
  const squirrelChances = await squirrel.locator(".loot-table__drop-chance").allTextContents();
  // A 4th row ("entry-pass", 15%) was added to the squirrel loot table after this literal was
  // written (server/src/rooms/monsterDefinitions.ts); the array grew from 3 rows to 4.
  expect(squirrelChances).toEqual(["60%", "25%", "8%", "15%"]);

  const rabbit = monsters.nth(1);
  await expect(rabbit.locator(".loot-table__monster-name")).toHaveText("토끼 · 경험치 2");
  const rabbitChances = await rabbit.locator(".loot-table__drop-chance").allTextContents();
  expect(rabbitChances).toEqual(["55%", "35%", "12%", "3%"]);

  const boss = monsters.nth(2);
  await expect(boss.locator(".loot-table__monster-name")).toHaveText("보스 · 경험치 600");
  await expect(boss.locator(".loot-table__drop-name")).toHaveText("황금투구 ×1");
  const bossChances = await boss.locator(".loot-table__drop-chance").allTextContents();
  expect(bossChances).toEqual(["25%"]);

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
