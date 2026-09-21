import { expect, test, type Page } from "@playwright/test";
import { joinRoom } from "../helpers/flows";

async function expectUnclipped(page: Page, selector: string): Promise<void> {
  const node = page.locator(selector);
  await expect(node).toBeVisible();
  const geometry = await node.evaluate(element => {
    const box = element.getBoundingClientRect();
    const clips: string[] = [];
    if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) {
      clips.push("viewport");
    }
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      const left = bounds.left + parent.clientLeft;
      const top = bounds.top + parent.clientTop;
      if ((style.overflowX !== "visible" && (box.left < left - 1 || box.right > left + parent.clientWidth + 1)) ||
          (style.overflowY !== "visible" && (box.top < top - 1 || box.bottom > top + parent.clientHeight + 1))) {
        clips.push(parent.id || parent.className);
      }
    }
    return { box: box.toJSON(), clips };
  });
  expect.soft(geometry.clips, `${selector}: ${JSON.stringify(geometry)}`).toEqual([]);
}

for (const viewport of [{ width: 720, height: 480 }, { width: 1440, height: 900 }]) {
  test(`compact world, panels and caster HUD remain reachable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize(viewport);
    try {
      await joinRoom(page, "plaza");
      const canvas = page.locator("#game-root canvas");
      await expect(canvas).toHaveAttribute("width", "1024");
      await expect(canvas).toHaveAttribute("height", "576");
      const box = (await canvas.boundingBox())!;
      const root = (await page.locator("#game-root").boundingBox())!;
      const stage = (await page.locator(".stage").boundingBox())!;
      expect.soft(box.width / box.height).toBeCloseTo(16 / 9, 2);
      expect.soft(root.width, "world must span the stage without a reserved sidebar").toBeGreaterThanOrEqual(stage.width - 4);
      expect.soft(stage.y + stage.height, "stage including footer fits viewport").toBeLessThanOrEqual(viewport.height);
      await expectUnclipped(page, "#game-root canvas");
      await expectUnclipped(page, ".region-guide strong");
      await expectUnclipped(page, "#chat-input");
      await expectUnclipped(page, "#vitals-count");
      await page.screenshot({ path: testInfo.outputPath("world.png") });

      for (const [button, panel, close] of [
        ["#inventory-button", "#inventory", "#inventory-close"],
        ["#loot-table-button", "#loot-table", "#loot-table-close"],
        ["#character-menu-button", "#character-menu", "#character-menu-close"],
        ["#landmark-button", "#landmark-panel", "#landmark-panel-close"],
      ]) {
        await expectUnclipped(page, button!);
        await page.locator(button!).click();
        await expect(page.locator(panel!)).toBeVisible();
        await expectUnclipped(page, close!);
        await page.screenshot({ path: testInfo.outputPath(`${panel!.slice(1)}.png`) });
        await page.locator(close!).click();
        await expect(page.locator(panel!)).toBeHidden();
      }

      await page.locator("#character-menu-button").click();
      await page.locator("#character-menu-choose-class").click();
      await page.locator('[data-class-key="shaman"]').click();
      await page.locator("#class-picker-choose").click();
      await page.locator("#class-picker-confirm-yes").click();
      await expect(page.locator("#class-picker")).toBeHidden();
      if (await page.locator("#character-menu").isVisible()) {
        await page.locator("#character-menu-close").click();
      }
      await expect(page.locator("#vitals-mp-count")).toHaveText("100 / 100");
      await expect(page.locator(".skills__name")).toHaveText("화염구");
      for (const selector of ["#vitals-count", "#vitals-track", "#vitals-mp-count", "#vitals-mp-track", ".skills__name", "#chat-log", "#chat-input"]) {
        await expectUnclipped(page, selector);
      }
      await page.screenshot({ path: testInfo.outputPath("caster-hud.png") });

      const input = page.locator("#chat-input");
      await input.fill("좁은 화면 회귀 확인 한글 123");
      await input.press("Enter");
      await expect(page.locator("#chat-log")).toContainText("좁은 화면 회귀 확인 한글 123");
      await input.press("Escape");

      for (let cycle = 0; cycle < 3; cycle += 1) {
        await page.setViewportSize(cycle % 2 ? { width: 1440, height: 900 } : { width: 720, height: 480 });
        await page.locator("#inventory-button").click();
        await page.locator("#inventory-close").click();
      }
      await page.setViewportSize(viewport);
      await expectUnclipped(page, "#vitals-mp-count");
      await expectUnclipped(page, "#chat-input");
      expect(errors).toEqual([]);
    } finally {
      await page.screenshot({ path: testInfo.outputPath("final.png") });
    }
  });
}
