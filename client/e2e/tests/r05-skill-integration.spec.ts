import { expect, test, type Page } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { probeAnimationLoop, waitForCanvasReady } from "../helpers/canvas";
import { completeAvatarPicker } from "../helpers/flows";

let browser: Awaited<ReturnType<typeof launchSharedBrowser>>;
let client: Client;
let sent: string[];
let received: string[];

test.beforeAll(async () => { browser = await launchSharedBrowser(); });
test.afterAll(async () => { await browser.close(); });
test.beforeEach(async () => {
  client = await openFreshClient(browser);
  sent = [];
  received = [];
  client.page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => sent.push(payload.toString()));
    socket.on("framereceived", ({ payload }) => received.push(payload.toString()));
  });
  await client.page.goto("/?room=plaza");
  await completeAvatarPicker(client.page);
  await waitForCanvasReady(client.page);
  await expect(client.page.locator("#class-picker")).toBeVisible();
});
test.afterEach(async () => { await client.context.close(); });

async function chooseClass(page: Page, classKey: string): Promise<void> {
  await page.locator(`[data-class-key="${classKey}"]`).click();
  await page.locator("#class-picker-choose").click();
  await expect(page.locator("#class-picker-confirm")).toBeVisible();
  await page.locator("#class-picker-confirm-yes").click();
  await expect(page.locator("#class-picker")).toBeHidden();
  await expect(page.locator("#skills")).toBeVisible();
}

test("실제 입장 동기화와 직업 확정 후 숫자키 시전이 MP·쿨다운까지 연결된다", async () => {
  const page = client.page;
  await expect(page.locator("#skills")).toBeHidden();
  await expect(page.locator("#class-picker-choose")).toBeDisabled();
  await page.locator('[data-class-key="warrior"]').click();
  await page.locator("#class-picker-choose").click();
  await expect(page.locator("#class-picker-confirm")).toBeVisible();
  expect(sent.filter((frame) => frame.includes("class:choose"))).toHaveLength(0);
  await page.locator("#class-picker-confirm-back").click();
  await chooseClass(page, "warrior");
  expect(sent.filter((frame) => frame.includes("class:choose"))).toHaveLength(1);
  await expect(page.locator(".skills__name")).toHaveText("방어 태세");
  await expect(page.locator("#vitals-mp-count")).toHaveText("30 / 30");

  await page.keyboard.press("Digit1");
  await expect(page.locator(".skills__slot")).toHaveAttribute("data-state", "cooling");
  await expect(page.locator("#vitals-mp-track")).toHaveAttribute("aria-valuenow", /^2[2-9]$/);
  expect(received.some((frame) => frame.includes("skill:used"))).toBe(true);
  expect(sent.filter((frame) => frame.includes("skill:use"))).toHaveLength(1);

  await page.keyboard.press("Digit1");
  await expect(page.locator("#skills-denial")).toHaveText("아직 준비되지 않았습니다");
  await page.keyboard.press("Digit2");
  await page.keyboard.press("Digit3");
  await page.keyboard.press("Digit4");
  expect(await probeAnimationLoop(page, 300)).toBeGreaterThan(0);
  expect(sent.filter((frame) => frame.includes("skill:use"))).toHaveLength(1);
});

test("몬스터 없는 광장에서 서버의 스킬 거절이 표시되고 MP는 유지된다", async () => {
  const page = client.page;
  await chooseClass(page, "shaman");
  await expect(page.locator(".skills__name")).toHaveText("화염구");
  await expect(page.locator("#vitals-mp-count")).toHaveText("100 / 100");
  await page.keyboard.press("Digit1");
  await expect(page.locator("#skills-denial")).toBeVisible();
  await expect(page.locator("#skills-denial")).toHaveText("대상이 없습니다");
  expect(sent.filter((frame) => frame.includes("skill:use"))).toHaveLength(1);
  expect(received.some((frame) => frame.includes("skill:denied"))).toBe(true);
  expect(received.some((frame) => frame.includes("skill:used"))).toBe(false);
  await expect(page.locator("#vitals-mp-count")).toHaveText("100 / 100");
});
