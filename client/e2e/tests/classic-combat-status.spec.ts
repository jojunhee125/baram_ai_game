import { expect, test } from "@playwright/test";
import { joinRoom } from "../helpers/flows";

test("weapon visuals follow equipment and ignore stale inventory reads", async ({ page }) => {
  await page.route("**/api/inventory", async route => {
    await new Promise(resolve => setTimeout(resolve, 150));
    await route.fulfill({ json: { items: [{ itemKey: "old-dagger", name: "dagger", icon: "old-dagger", quantity: 1, equipped: true }] } });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/world/weaponVisual.ts";
    const { WeaponVisualState } = await import(path);
    const state = new WeaponVisualState();
    state.applyEquipmentChange({ slot: "weapon", itemKey: null, applied: true });
    await new Promise(resolve => setTimeout(resolve, 400));
    const afterRead = state.hasOldDagger;
    state.applyEquipmentChange({ slot: "weapon", itemKey: "old-dagger", applied: true });
    const equipped = state.hasOldDagger;
    state.applyEquipmentChange({ slot: "armor", itemKey: null, applied: true });
    const afterArmor = state.hasOldDagger;
    state.applyEquipmentChange({ slot: "weapon", itemKey: null, applied: true });
    return { afterRead, equipped, afterArmor, unequipped: state.hasOldDagger };
  });
  expect(result).toEqual({ afterRead: false, equipped: true, afterArmor: true, unequipped: false });
});

test("attack status returns to ready and remains single after room hop", async ({ page }) => {
  await joinRoom(page, "hunting-ground", { skinIndex: 0 });
  const status = page.locator(".vitals__attack-status");
  await expect(status).toHaveText("공격 준비");
  await expect(page.locator("#transition")).toHaveAttribute("data-state", "clear");
  await page.keyboard.down("Space");
  await expect(status).toHaveText("재사용 대기");
  await page.keyboard.up("Space");
  await expect(status).toHaveText("공격 준비");
  await page.locator("#landmark-button").click();
  await page.locator("#landmark-panel-list").getByRole("button", { name: "남문 마을", exact: true }).click();
  await expect(page.getByLabel("현재 좌표")).toHaveText("31, 20");
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText("공격 준비");
});
