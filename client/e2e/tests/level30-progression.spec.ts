import { expect, test, type Page } from "@playwright/test";
import { PROGRESSION_MONSTER_NAMES, PROGRESSION_REGIONS, PROGRESSION_CONNECTIONS, PROGRESSION_ITEM_ICON_ORDER } from "@zep-test/shared";
import { completeAvatarPicker } from "../helpers/flows";
import { waitForCanvasReady } from "../helpers/canvas";
import { holdKey } from "../helpers/input";

test.skip(process.env["ZEP_LEVEL30_TEST_SERVER"] !== "1", "Requires isolated level30.playwright.config.ts fixture");

async function bag(page: Page): Promise<{ itemKey: string; quantity: number; equipped: boolean; equippedSlot?: string }[]> {
  return page.evaluate(async () => (await (await fetch("/api/inventory")).json()).items);
}

async function step(page: Page, key: string): Promise<void> {
  await holdKey(page, key, 65);
  await page.waitForTimeout(180);
}

async function walk(page: Page, targetX: number, targetY: number): Promise<void> {
  for (let attempt = 0; attempt < 45; attempt++) {
    const [x, y] = (await page.locator(".region-guide__coordinates").innerText()).split(",").map(Number);
    if (x === targetX && y === targetY) return;
    await step(page, y! < targetY ? "ArrowDown" : y! > targetY ? "ArrowUp" : x! < targetX ? "ArrowRight" : "ArrowLeft");
  }
  throw new Error(`Could not walk to ${targetX},${targetY}`);
}


for (const [index, region] of PROGRESSION_REGIONS.entries()) {
  test(`${region.name}: live loot, saved/new icons, equipment and graph return`, async ({ page, context }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const owner = `00000000-0000-4000-8000-00000000003${index}`;
    const token = `header.${Buffer.from(JSON.stringify({ sub: owner, preferred_username: `original-hunting-${index}` })).toString("base64url")}.sig`;
    await context.setExtraHTTPHeaders({ "x-auth-request-access-token": token });
    await page.route("**/matchmake/**", async route => {
      if (route.request().method() === "OPTIONS") await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": "http://127.0.0.1:5173", "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-auth-request-access-token", "access-control-allow-credentials": "true",
      } });
      else await route.continue();
    });
    await page.goto(`/?room=${region.roomId}`);
    await completeAvatarPicker(page);
    await waitForCanvasReady(page);
    await expect(page.locator(".region-guide strong")).toHaveText(region.name);
    await expect(page.locator(".region-guide__kind")).toContainText(`Lv ${region.minLevel}`);
    await page.keyboard.press("KeyL");
    for (const kind of region.monsterKinds) await expect(page.locator("#loot-table-list")).toContainText(PROGRESSION_MONSTER_NAMES[kind]!);
    const loot = await page.evaluate(async room => (await (await fetch(`/api/loot-table/${room}`)).json()).monsters, region.roomId);
    expect(new Set(loot.map((row: { kind: string }) => row.kind))).toEqual(new Set(region.monsterKinds));
    if (region.theme === "novice") expect(loot.find((row: { kind: string }) => row.kind === "female-deer").drops).toEqual([]);
    await page.locator("#loot-table-close").click();
    await page.locator("#inventory-button").click();
    await expect(page.locator("#inventory-list .bag__row")).toHaveCount(81);
    await expect(page.locator("#inventory-list .bag__icon--unknown")).toHaveCount(0);
    expect(PROGRESSION_ITEM_ICON_ORDER).toHaveLength(62);
    for (const key of ["ruin-sword", "strength-helmet-1"]) {
      await page.locator(`#inventory-list [data-item-key="${key}"] .bag__equip`).click();
      await expect.poll(async () => (await bag(page)).find(item => item.itemKey === key)?.equipped).toBe(true);
    }
    await expect(page.locator('#inventory-list [data-item-key="square-shield"] .bag__equip')).toHaveCount(0);
    await page.locator('#inventory-list [data-item-key="quarry-ring"]').getByRole("button", { name: "\ubc18\uc9c0 2 \uc7a5\ucc29", exact: true }).click();
    await expect.poll(async () => (await bag(page)).find(item => item.itemKey === "quarry-ring")?.equippedSlot).toBe("ring2");
    await page.locator('#inventory-list [data-item-key="ruin-ring"]').getByRole("button", { name: "\ubc18\uc9c0 1 \uc7a5\ucc29", exact: true }).click();
    await expect.poll(async () => (await bag(page)).find(item => item.itemKey === "ruin-ring")?.equippedSlot).toBe("ring1");
    await page.locator("#inventory-close").click();
    await page.locator("#social-button").click();
    expect(await page.locator('.social__recipe').count()).toBeLessThanOrEqual(1);
    await page.locator("#social-button").click();
    await page.screenshot({ path: testInfo.outputPath(`${region.roomId}.png`) });
    await walk(page, 31, 26);
    await step(page, "ArrowDown");
    const back = PROGRESSION_CONNECTIONS.find(edge => edge.id === `${region.roomId}-south-door`)!;
    const destination = PROGRESSION_REGIONS.find(row => row.roomId === back.to.room);
    if (destination) await expect(page.locator(".region-guide strong")).toHaveText(destination.name);
    else await expect(page.locator(".region-guide strong")).not.toHaveText(region.name);
    await expect(page.locator(".region-guide__coordinates")).toHaveText(`${back.to.arrival.tileX}, ${back.to.arrival.tileY}`);
    expect(errors).toEqual([]);
  });
}
