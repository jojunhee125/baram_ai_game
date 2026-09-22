import { expect, test, type Page } from "@playwright/test";
import { launchSharedBrowser, openFreshClient } from "../helpers/browser";
import { dismissClassPicker, joinRoom } from "../helpers/flows";
import { holdKey } from "../helpers/input";

async function step(page: Page, direction: string): Promise<void> {
  await holdKey(page, direction, 65);
  await page.waitForTimeout(180);
}

async function walk(page: Page, targetX: number, targetY: number): Promise<void> {
  for (let count = 0; count < 50; count += 1) {
    const [x, y] = (await page.locator(".region-guide__coordinates").innerText()).split(",").map(Number);
    if (x === targetX && y === targetY) return;
    await step(page, x! < targetX ? "ArrowRight" : x! > targetX ? "ArrowLeft"
      : y! < targetY ? "ArrowDown" : "ArrowUp");
  }
  throw new Error(`Forest route did not reach ${targetX},${targetY}`);
}

test("forest displays its rewards, exits to the den and refuses reentry without a pass", async ({}, testInfo) => {
  const browser = await launchSharedBrowser();
  const client = await openFreshClient(browser);
  const errors: string[] = [];
  const page = client.page;
  page.on("pageerror", error => errors.push(error.message));
  try {
    // Direct room entry is the existing map-preview test entry point, not proof of passing a gate.
    await joinRoom(page, "hunting-forest");
    await expect(page.locator(".region-guide strong")).toHaveText("위험한 숲");
    await expect(page.locator(".region-guide__kind")).toContainText("Lv 8–15");
    await expect(page.locator(".region-guide")).toContainText("매복");
    await expect(page.locator(".region-guide")).toContainText("추격");
    await page.screenshot({ path: testInfo.outputPath("forest-arrival.png") });
    await page.keyboard.press("KeyL");
    const rewards = page.locator("#loot-table-list");
    await expect(rewards).toContainText("경험치 45");
    await expect(rewards).toContainText("경험치 70");
    await expect(rewards).toContainText("숲의 수지");
    await expect(rewards).toContainText("오래된 나무껍질");
    await expect(rewards).toContainText("숲지기 망토");
    await page.screenshot({ path: testInfo.outputPath("forest-rewards.png") });
    await page.locator("#loot-table-close").click();
    await walk(page, 31, 26);
    await step(page, "ArrowDown");
    await expect(page.locator(".region-guide strong")).toHaveText("바위 사냥굴");
    await expect(page.locator(".region-guide__coordinates")).toHaveText("46, 25");
    await dismissClassPicker(page);
    await page.screenshot({ path: testInfo.outputPath("den-forest-door.png") });
    await step(page, "ArrowRight");
    await expect(page.getByText("입장권은 다람쥐를 잡아서 획득하세요", { exact: true })).toBeVisible();
    await expect(page.locator(".region-guide strong")).toHaveText("바위 사냥굴");
    await expect(page.locator("#transition")).toHaveAttribute("data-state", "clear");
    await page.screenshot({ path: testInfo.outputPath("forest-pass-refused.png") });
    expect(errors).toEqual([]);
  } finally {
    await client.context.close();
    await browser.close();
  }
});
