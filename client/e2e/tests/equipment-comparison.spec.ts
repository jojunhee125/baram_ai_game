import { expect, test, type Locator, type Page } from "@playwright/test";
import type { EquipmentChanged, EquipmentMetadata, ItemGranted, ItemRemoved } from "@zep-test/shared";
import type { InventoryPanel } from "../../src/ui/inventoryPanel";

type Item = { itemKey: string; name: string; icon: string; quantity: number; equipped: boolean; sellValue: number; equipment?: EquipmentMetadata };
type Fixture = { panel: InventoryPanel; equip: unknown[]; unequip: unknown[] };
type Change = { kind: "grant"; data: ItemGranted } | { kind: "equip"; data: EquipmentChanged } | { kind: "remove"; data: ItemRemoved };
const item = (itemKey: string, name: string, slot: EquipmentMetadata["slot"], attackDamage: number,
  damageReduction: number, equipped = false): Item => ({
  itemKey, name, icon: slot === "weapon" ? "old-dagger" : "leather-armor", quantity: 1,
  equipped, sellValue: 10, equipment: { slot, attackDamage, damageReduction },
});
const dagger = () => item("old-dagger", "낡은 단검", "weapon", 2, 0, true);
const blade = () => item("hunting-blade", "사냥꾼 검", "weapon", 6, 0);
const row = (page: Page, key: string) => page.locator(`#inventory-list [data-item-key="${key}"]`);
const line = (page: Page, key: string, name: string) => row(page, key).locator(`.bag__comparison-${name}`);
const grant = (value: Item, total = value.quantity): Change => ({ kind: "grant", data: { ...value, quantity: 1, total } });
const remove = (value: Item, total: number): Change => ({ kind: "remove", data: { ...value, quantity: 1, total, reason: "shop-sell" } });
const equip = (itemKey: string | null, applied = true): Change => ({ kind: "equip", data: { slot: "weapon", itemKey, applied } });

async function emit(page: Page, changes: Change[]): Promise<void> {
  await page.evaluate(events => {
    const { panel } = (window as unknown as { comparisonFixture: Fixture }).comparisonFixture;
    for (const event of events) {
      if (event.kind === "grant") panel.applyGrant(event.data);
      else if (event.kind === "equip") panel.applyEquipmentChange(event.data);
      else panel.applyItemRemoved(event.data);
    }
  }, changes);
}

async function mount(page: Page, initial: Item[], theme = "heritage") {
  // Isolated display fixture: real document/CSS/parser/panel, controlled HTTP and committed events.
  // The unchanged first-growth-loop spec separately covers real gameplay and account persistence.
  const state = { items: initial, reads: 0, hold: null as null | { started: () => void; wait: Promise<void> } };
  await page.route("**/src/main.ts", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/inventory", async route => {
    state.reads += 1;
    const snapshot = structuredClone(state.items);
    const hold = state.hold;
    state.hold = null;
    if (hold) { hold.started(); await hold.wait; }
    await route.fulfill({ json: { items: snapshot } });
  });
  await page.goto("/");
  await page.evaluate(async activeTheme => {
    if (activeTheme === "standard") document.querySelector('link[href="/src/heritage.css"]')?.remove();
    document.querySelector<HTMLElement>("#boot-status")!.hidden = true;
    document.querySelector<HTMLElement>("#avatar-picker")!.hidden = true;
    const { InventoryPanel } = await import("/src/ui/inventoryPanel.ts");
    const calls = { equip: [] as unknown[], unequip: [] as unknown[] };
    const panel = new InventoryPanel((itemKey, slot) => calls.equip.push({ itemKey, slot }),
      slot => calls.unequip.push(slot), () => {}, () => {});
    (window as unknown as { comparisonFixture: Fixture }).comparisonFixture = { panel, ...calls };
  }, theme);
  await page.locator("#inventory-button").click();
  await expect(page.locator("#inventory-list")).toHaveAttribute("aria-busy", "false");
  return {
    state,
    async pendingRefresh() {
      let release!: () => void;
      let started!: () => void;
      const beginning = new Promise<void>(resolve => { started = resolve; });
      state.hold = { started, wait: new Promise<void>(resolve => { release = resolve; }) };
      await page.locator("#inventory-close").click();
      await page.locator("#inventory-button").click();
      await beginning;
      return release;
    },
  };
}

test("same-slot values use additive attack and percentage-point armor differences", async ({ page }) => {
  await mount(page, [dagger(), blade(), item("padded-armor", "누비옷", "armor", 0, 0.15, true),
    item("reinforced-armor", "강화 가죽갑옷", "armor", 0, 0.3),
    item("golden-helmet", "황금 투구", "helmet", 0, 0.15, true),
    item("forest-cloak", "숲지기 망토", "cloak", 0, 0.1)]);
  await expect(line(page, "hunting-blade", "stats")).toHaveText("장비 공격력 +6 · 피해 감소 0%");
  await expect(line(page, "hunting-blade", "baseline")).toHaveText("비교: 낡은 단검");
  await expect(line(page, "hunting-blade", "difference")).toHaveText("공격력 +4 · 피해 감소 0%p");
  await expect(line(page, "reinforced-armor", "difference")).toHaveText("공격력 0 · 피해 감소 +15%p");
  await expect(line(page, "padded-armor", "stats")).toHaveText("장비 공격력 +0 · 피해 감소 15%");
  await expect(line(page, "padded-armor", "baseline")).toHaveText("현재 장착 중");
  await expect(line(page, "padded-armor", "difference")).toBeHidden();
  await expect(line(page, "forest-cloak", "baseline")).toHaveText("비교: 빈 슬롯");
  await expect(line(page, "forest-cloak", "difference")).toHaveText("공격력 0 · 피해 감소 +10%p");
});

test("keyboard equip waits for success, keeps focus and updates negative, zero and empty baselines", async ({ page }) => {
  const { state } = await mount(page, [dagger(), blade()]);
  const button = row(page, "hunting-blade").locator(".bag__equip");
  await button.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as unknown as { comparisonFixture: Fixture }).comparisonFixture.equip))
    .toEqual([{ itemKey: "hunting-blade", slot: "weapon" }]);
  await expect(line(page, "hunting-blade", "baseline")).toHaveText("비교: 낡은 단검");
  await emit(page, [equip("hunting-blade", false)]);
  await expect(row(page, "old-dagger")).toHaveAttribute("data-equipped", "true");
  await expect(button).toBeFocused();
  await emit(page, [equip("hunting-blade")]);
  await expect(line(page, "hunting-blade", "baseline")).toHaveText("현재 장착 중");
  await expect(line(page, "old-dagger", "difference")).toHaveText("공격력 -4 · 피해 감소 0%p");
  await expect(button).toBeFocused();
  await emit(page, [grant(blade(), 2)]);
  await expect(row(page, "hunting-blade")).toHaveAttribute("data-equipped", "true");
  await expect(row(page, "hunting-blade").locator(".bag__count")).toHaveText("2");
  await expect(button).toBeFocused();
  await emit(page, [grant({ ...dagger(), equipment: { slot: "weapon", attackDamage: 6, damageReduction: 0 } })]);
  await expect(line(page, "old-dagger", "difference")).toHaveText("공격력 0 · 피해 감소 0%p");
  await emit(page, [equip(null)]);
  await expect(line(page, "hunting-blade", "baseline")).toHaveText("비교: 빈 슬롯");
  await expect(line(page, "hunting-blade", "difference")).toHaveText("공격력 +6 · 피해 감소 0%p");
  expect(state.reads, "known live metadata must not trigger new HTTP requests").toBe(1);
});

test("legacy and malformed optional metadata retain usable rows without inventing zero stats", async ({ page }) => {
  const legacy = { ...dagger(), equipment: undefined };
  const malformed = [null, { slot: "weapon", attackDamage: -1, damageReduction: 0 },
    { slot: "weapon", attackDamage: 2, damageReduction: 1.1 },
    { slot: "weapon", attackDamage: "6", damageReduction: 0 },
    { slot: "unknown", attackDamage: 6, damageReduction: 0 }];
  const { state } = await mount(page, [legacy, blade()]);
  await expect(line(page, "old-dagger", "stats")).toHaveText("장비 수치 정보 없음");
  await expect(line(page, "hunting-blade", "difference")).toHaveText("비교 수치 정보 없음");
  for (const metadata of malformed) {
    state.items = [dagger(), { ...blade(), equipment: metadata as unknown as EquipmentMetadata }];
    await page.locator("#inventory-close").click();
    await page.locator("#inventory-button").click();
    await expect(row(page, "hunting-blade").locator(".bag__count")).toHaveText("1");
    await expect(line(page, "hunting-blade", "stats")).toHaveText("장비 수치 정보 없음");
    await expect(line(page, "hunting-blade", "difference")).toHaveText("비교 수치 정보 없음");
    await expect(row(page, "hunting-blade").locator(".bag__equip")).toBeEnabled();
    await expect(row(page, "hunting-blade").locator(".bag__sell")).toBeEnabled();
  }
});

test("late HTTP cannot overwrite committed equip, grant and removal events", async ({ page }) => {
  const harness = await mount(page, [dagger(), blade()]);
  const release = await harness.pendingRefresh();
  await emit(page, [equip("hunting-blade"), grant(blade(), 2), remove(dagger(), 0)]);
  release();
  await expect(row(page, "old-dagger")).toHaveCount(0);
  await expect(row(page, "hunting-blade")).toHaveAttribute("data-equipped", "true");
  await expect(row(page, "hunting-blade").locator(".bag__count")).toHaveText("2");
  await expect(line(page, "hunting-blade", "baseline")).toHaveText("현재 장착 중");
  expect(harness.state.reads).toBe(2);
});

test("a new stack granted then partially sold during HTTP remains in the bag", async ({ page }) => {
  const harness = await mount(page, [dagger()]);
  const release = await harness.pendingRefresh();
  await emit(page, [grant(blade(), 2), remove(blade(), 1)]);
  release();
  await expect(row(page, "hunting-blade").locator(".bag__count")).toHaveText("1");
  await expect(line(page, "hunting-blade", "difference")).toHaveText("공격력 +4 · 피해 감소 0%p");
  expect(harness.state.reads).toBeLessThanOrEqual(3);
});

test("grant then equip then another grant during HTTP preserves the new stack's equipment state", async ({ page }) => {
  const harness = await mount(page, [dagger()]);
  const release = await harness.pendingRefresh();
  await emit(page, [grant(blade()), equip("hunting-blade"), grant(blade(), 2)]);
  release();
  await expect(row(page, "hunting-blade")).toHaveAttribute("data-equipped", "true");
  await expect(row(page, "hunting-blade").locator(".bag__count")).toHaveText("2");
  await expect(line(page, "old-dagger", "difference")).toHaveText("공격력 -4 · 피해 감소 0%p");
  expect(harness.state.reads).toBe(2);
});

test("unknown equipped key stays unknown until an authoritative refresh resolves it", async ({ page }) => {
  const harness = await mount(page, [dagger(), blade()]);
  const release = await harness.pendingRefresh();
  harness.state.items = [{ ...dagger(), equipped: false }, blade(),
    { ...blade(), itemKey: "future-weapon", name: "알 수 없는 무기", equipped: true, equipment: undefined }];
  await emit(page, [equip("future-weapon"), equip("future-weapon"), equip("future-weapon")]);
  release();
  await expect.poll(() => harness.state.reads).toBe(3);
  await expect(line(page, "hunting-blade", "difference")).toHaveText("비교 수치 정보 없음");
  await expect(line(page, "hunting-blade", "baseline")).toHaveText("비교: 알 수 없는 무기");
  await page.waitForTimeout(100);
  expect(harness.state.reads, "duplicate unknown-key notifications must coalesce").toBe(3);
});

test("closed and destroyed panels ignore live events and late responses", async ({ page }) => {
  const harness = await mount(page, [dagger(), blade()]);
  await page.locator("#inventory-close").click();
  await emit(page, [grant(blade(), 2), equip("hunting-blade")]);
  await expect(page.locator("#inventory-list .bag__row")).toHaveCount(0);
  harness.state.items = [{ ...dagger(), equipped: false }, { ...blade(), equipped: true, quantity: 2 }];
  await page.locator("#inventory-button").click();
  await expect(line(page, "hunting-blade", "baseline")).toHaveText("현재 장착 중");
  const before = await page.locator("#inventory-list").innerHTML();
  await page.evaluate(() => (window as unknown as { comparisonFixture: Fixture }).comparisonFixture.panel.destroy());
  await emit(page, [remove(blade(), 0), grant(dagger(), 3), equip("old-dagger")]);
  expect(await page.locator("#inventory-list").innerHTML()).toBe(before);
});

test("destroy invalidates an already pending inventory response", async ({ page }) => {
  const harness = await mount(page, [dagger(), blade()]);
  const release = await harness.pendingRefresh();
  await page.evaluate(() => (window as unknown as { comparisonFixture: Fixture }).comparisonFixture.panel.destroy());
  const before = await page.locator("#inventory-list").innerHTML();
  const response = page.waitForResponse("**/api/inventory");
  release();
  await response;
  await page.waitForTimeout(100);
  expect(await page.locator("#inventory-list").innerHTML()).toBe(before);
});

test("a burst of live updates during HTTP coalesces recovery and keeps the final committed state", async ({ page }) => {
  const harness = await mount(page, [dagger()]);
  const release = await harness.pendingRefresh();
  harness.state.items = [{ ...dagger(), equipped: false }, { ...blade(), quantity: 200, equipped: true }];
  await emit(page, [...Array.from({ length: 200 }, (_, index) => grant(blade(), index + 1)), equip("hunting-blade")]);
  release();
  await expect(row(page, "hunting-blade").locator(".bag__count")).toHaveText("200");
  await expect(row(page, "hunting-blade")).toHaveAttribute("data-equipped", "true");
  await expect(line(page, "old-dagger", "difference")).toHaveText("공격력 -4 · 피해 감소 0%p");
  expect(harness.state.reads).toBeLessThanOrEqual(3);
});

async function expectInsidePanel(node: Locator): Promise<void> {
  await node.scrollIntoViewIfNeeded();
  await expect(node).toBeVisible();
  const geometry = await node.evaluate(element => {
    const box = element.getBoundingClientRect();
    const panel = document.querySelector("#inventory")!.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      panelLeft: panel.left, panelRight: panel.right, panelTop: panel.top, panelBottom: panel.bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(Math.max(0, geometry.panelLeft) - 1);
  expect(geometry.right).toBeLessThanOrEqual(Math.min(geometry.viewportWidth, geometry.panelRight) + 1);
  expect(geometry.top).toBeGreaterThanOrEqual(Math.max(0, geometry.panelTop) - 1);
  expect(geometry.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(Math.min(geometry.viewportHeight, geometry.panelBottom) + 1);
}

for (const theme of ["standard", "heritage"]) {
  test(`${theme} comparison and existing actions remain reachable at a narrow viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 720, height: 480 });
    await mount(page, [dagger(), { ...blade(), name: "아주 긴 이름의 사냥꾼 검 장비 비교" }], theme);
    await expectInsidePanel(line(page, "hunting-blade", "difference"));
    await page.screenshot({ path: testInfo.outputPath(`equipment-comparison-${theme}.png`) });
    await expectInsidePanel(row(page, "hunting-blade").locator(".bag__equip"));
    await expectInsidePanel(row(page, "hunting-blade").locator(".bag__sell"));
    await page.keyboard.press("Escape");
    await expect(page.locator("#inventory")).toBeHidden();
    await page.keyboard.press("KeyI");
    await expect(line(page, "hunting-blade", "difference")).toHaveText("공격력 +4 · 피해 감소 0%p");
  });
}
