import { expect, test } from "@playwright/test";
import { joinRoom, completeAvatarPicker } from "../helpers/flows";
import { holdKey } from "../helpers/input";

test("new artwork, movement, live skin changes and round-trip region guide", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await joinRoom(page, "plaza", { skinIndex: 0 });
  const guide = page.getByRole("region", { name: "현재 지역 안내" });
  await expect(guide).toHaveCount(1);
  await expect(guide).toContainText("마을 광장");
  const coords = guide.getByLabel("현재 좌표");
  await expect(coords).toHaveText("31, 20");
  await holdKey(page, "ArrowRight", 90);
  await expect(coords).not.toHaveText("31, 20");
  await guide.locator("summary").click();
  await expect(guide).toContainText("WASD");
  await page.screenshot({ path: testInfo.outputPath("plaza.png") });

  for (const skinIndex of [1, 0]) {
    await page.locator("#character-menu-button").click();
    await page.locator("#character-menu-change-skin").click();
    await completeAvatarPicker(page, skinIndex);
    const before = await coords.textContent();
    await holdKey(page, "ArrowRight", 150);
    await expect(coords).not.toHaveText(before!);
  }

  await page.locator("#landmark-button").click();
  await page.locator("#landmark-panel-list").getByRole("button", { name: "사냥터 입구", exact: true }).click();
  await expect(guide).toContainText("초보 사냥터 · 1굴");
  await expect(guide).toHaveCount(1);
  await expect(page.locator("#transition")).toHaveAttribute("data-state", "clear");
  await page.screenshot({ path: testInfo.outputPath("hunting-ground.png") });
  await guide.locator("summary").click();
  await expect(guide).toContainText("입장권");
  await holdKey(page, "ArrowUp", 90);
  await holdKey(page, "Space", 90);
  await page.keyboard.press("KeyI");
  await expect(page.locator("#inventory")).toBeVisible();
  await page.keyboard.press("KeyI");
  await page.keyboard.press("KeyH");
  await expect(guide).toContainText("마을 광장");
  await expect(guide).toHaveCount(1);
  await expect(coords).toHaveText("31, 20");
  expect(errors).toEqual([]);
});

test("guide fits narrow viewport and keeps keyboard focus visible", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await joinRoom(page, "plaza");
  const guide = page.getByRole("region", { name: "현재 지역 안내" });
  await guide.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(guide.locator("details")).toHaveAttribute("open", "");
  await expect(page.locator("#chat-input")).not.toBeFocused();
  await page.keyboard.press("Space");
  await expect(guide.locator("details")).not.toHaveAttribute("open", "");
  const box = await guide.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(720);
});
