import { expect, test, type Locator, type Page } from "@playwright/test";
import type { EquipmentChanged, EquipmentMetadata, ItemGranted, ItemRemoved, NpcInteraction, ShopListingView } from "@zep-test/shared";
import type { ObjectPanel } from "../../src/ui/objectPanel";

type Item = { itemKey: string; name: string; icon: string; quantity: number; equipped: boolean; equipment?: EquipmentMetadata };
type Purchase = { npcObjectId: string; itemKey: string; quantity: number; nonce: string };
type Fixture = { panel: ObjectPanel; purchases: Purchase[] };
type Change = { kind: "grant"; data: ItemGranted } | { kind: "remove"; data: ItemRemoved } | { kind: "equip"; data: EquipmentChanged };
const gear = (itemKey: string, name: string, slot: EquipmentMetadata["slot"], attackDamage: number,
  damageReduction = 0, equipped = false): Item => ({ itemKey, name, icon: slot === "weapon" ? "old-dagger" : "leather-armor",
  quantity: 1, equipped, equipment: { slot, attackDamage, damageReduction } });
const dagger = () => gear("old-dagger", "낡은 단검", "weapon", 2, 0, true);
const blade = () => gear("hunting-blade", "사냥꾼 검", "weapon", 6);
const offer = (item: Item, price = 180): ShopListingView => ({ itemKey: item.itemKey, name: item.name,
  icon: item.icon, price, equipment: item.equipment, attackBonus: item.equipment?.attackDamage,
  damageReductionRatio: item.equipment?.damageReduction });
const payload = (listings: ShopListingView[]): NpcInteraction => ({ kind: "npc", objectId: "plaza-shop-npc",
  title: "잡화상", body: "장비를 살펴보세요.", blocksMovement: false, shop: { listings } });
const row = (page: Page, key = "hunting-blade") => page.locator(`.object__shop-row[data-item-key="${key}"]`);
const line = (page: Page, part: string, key = "hunting-blade") => row(page, key).locator(`.object__shop-comparison-${part}`);
const status = (page: Page) => page.locator(".object__shop-comparison-status");
const changedEquipment = (itemKey: string | null, applied = true): Change => ({ kind: "equip", data: { slot: "weapon", itemKey, applied } });
const granted = (): Change => ({ kind: "grant", data: { ...blade(), total: 1 } });
const removed = (): Change => ({ kind: "remove", data: { ...dagger(), total: 0, reason: "shop-sell" } });

async function emit(page: Page, changes: Change[]): Promise<void> {
  await page.evaluate(events => {
    const panel = (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.panel;
    for (const event of events) {
      if (event.kind === "grant") panel.applyGrant(event.data);
      else if (event.kind === "remove") panel.applyItemRemoved(event.data);
      else panel.applyEquipmentChange(event.data);
    }
  }, changes);
}

async function openShop(page: Page, listings = [offer(blade())]): Promise<void> {
  await page.evaluate(value => (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.panel.open(value), payload(listings));
}

async function mount(page: Page, items: Item[], options: { listings?: ShopListingView[]; holdInitial?: boolean; theme?: string; body?: unknown; httpStatus?: number } = {}) {
  // Display-only fixture: production document, CSS, parser, formatter and ObjectPanel. Account
  // mutation is never mocked in the separate unchanged first-growth-loop integration test.
  const state = { body: options.body ?? { items }, httpStatus: options.httpStatus ?? 200, reads: 0, active: 0, maxActive: 0 };
  const holds: { started: () => void; wait: Promise<void> }[] = [];
  const holdNext = () => {
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    holds.push({ started: began, wait: new Promise<void>(resolve => { release = resolve; }) });
    return { started, release };
  };
  const initial = options.holdInitial ? holdNext() : undefined;
  await page.route("**/src/main.ts", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/inventory", async route => {
    state.reads += 1;
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    const body = structuredClone(state.body);
    const httpStatus = state.httpStatus;
    const hold = holds.shift();
    try {
      if (hold) { hold.started(); await hold.wait; }
      await route.fulfill({ status: httpStatus, json: body });
    } finally { state.active -= 1; }
  });
  await page.goto("/");
  await page.evaluate(async theme => {
    if (theme === "standard") document.querySelector('link[href="/src/heritage.css"]')?.remove();
    document.querySelector<HTMLElement>("#boot-status")!.hidden = true;
    document.querySelector<HTMLElement>("#avatar-picker")!.hidden = true;
    const { ObjectPanel } = await import("/src/ui/objectPanel.ts");
    const purchases: Purchase[] = [];
    const panel = new ObjectPanel(() => {}, () => {}, (npcObjectId, itemKey, quantity, nonce) =>
      purchases.push({ npcObjectId, itemKey, quantity, nonce }));
    (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture = { panel, purchases };
  }, options.theme ?? "heritage");
  await openShop(page, options.listings);
  if (initial) await initial.started;
  else if (await status(page).count()) await expect(status(page)).not.toHaveText("장착 장비를 확인하는 중…");
  return { state, holdNext, initial };
}

test("shop compares same-slot bonuses, percentage points and currently worn products", async ({ page }) => {
  const padded = gear("padded-armor", "누비옷", "armor", 0, 0.15, true);
  const armor = gear("reinforced-armor", "강화 가죽갑옷", "armor", 0, 0.3);
  const { state } = await mount(page, [dagger(), blade(), padded,
    gear("golden-helmet", "황금 투구", "helmet", 0, 0.15, true),
    gear("forest-cloak", "숲지기 망토", "cloak", 0, 0.1, true)],
  { listings: [offer(blade()), offer(dagger(), 40), offer(armor, 300)] });
  await expect(line(page, "baseline")).toHaveText("비교: 낡은 단검");
  await expect(line(page, "difference")).toHaveText("공격력 +4 · 피해 감소 0%p");
  await expect(line(page, "baseline", "old-dagger")).toHaveText("현재 장착 중");
  await expect(line(page, "difference", "old-dagger")).toBeHidden();
  await expect(line(page, "difference", "reinforced-armor")).toHaveText("공격력 0 · 피해 감소 +15%p");
  await expect(row(page).locator(".object__shop-price")).toHaveText("180전");
  expect(state.reads).toBe(1);
});

test("only a successful empty snapshot permits a zero baseline", async ({ page }) => {
  const { initial } = await mount(page, [], { holdInitial: true });
  await expect(line(page, "baseline")).toHaveText("비교: 장비 확인 중");
  await expect(line(page, "difference")).not.toContainText("+6");
  await expect(row(page).locator(".object__shop-buy")).toBeEnabled();
  initial!.release();
  await expect(line(page, "baseline")).toHaveText("비교: 빈 슬롯");
  await expect(line(page, "difference")).toHaveText("공격력 +6 · 피해 감소 0%p");
});

test("failed and structurally invalid baseline reads keep purchase usable without false empty slots", async ({ page }) => {
  const harness = await mount(page, [], { httpStatus: 503 });
  await expect(line(page, "difference")).toHaveText("비교 수치 정보 없음");
  await expect(row(page).locator(".object__shop-buy")).toBeEnabled();
  const invalid = [{ items: "bad" }, { items: [{ ...dagger(), quantity: 0 }] },
    { items: [{ ...dagger(), quantity: 1.5 }] }, { items: [{ ...dagger(), equipped: "yes" }] }];
  for (const body of invalid) {
    harness.state.httpStatus = 200;
    harness.state.body = body;
    await openShop(page);
    await expect(status(page)).toContainText("읽지 못했습니다");
    await expect(line(page, "baseline")).not.toHaveText("비교: 빈 슬롯");
    await expect(line(page, "difference")).toHaveText("비교 수치 정보 없음");
    await expect(row(page).locator(".object__shop-price")).toHaveText("180전");
    await expect(row(page).locator(".object__shop-buy")).toBeEnabled();
  }
  expect(harness.state.reads, "failed snapshots must not retry in a loop").toBe(5);
});

test("legacy, malformed and ambiguous equipment suppress numeric comparisons", async ({ page }) => {
  const harness = await mount(page, [{ ...dagger(), equipment: undefined }]);
  await expect(line(page, "difference")).toHaveText("비교 수치 정보 없음");
  harness.state.body = { items: [dagger(), { ...blade(), equipped: true }] };
  await openShop(page);
  await expect(status(page)).not.toHaveText("장착 장비를 확인하는 중…");
  await expect(line(page, "difference")).toHaveText("비교 수치 정보 없음");
  harness.state.body = { items: [dagger()] };
  for (const equipment of [undefined, { slot: "weapon", attackDamage: -6, damageReduction: 0 },
    { slot: "weapon", attackDamage: 6, damageReduction: 2 },
    { slot: "ring", attackDamage: 6, damageReduction: 0 }]) {
    await openShop(page, [{ ...offer(blade()), equipment: equipment as EquipmentMetadata | undefined }]);
    await expect(row(page).locator(".object__shop-buy")).toBeEnabled();
    await expect(line(page, "difference")).toHaveText("비교 수치 정보 없음");
  }
});

test("ordinary merchandise and non-shop NPCs do not fetch equipment or show comparison warnings", async ({ page }) => {
  const { state } = await mount(page, [], { listings: [{ itemKey: "herb", name: "약초", icon: "herb", price: 12 }] });
  await expect(row(page, "herb").locator(".object__shop-buy")).toBeEnabled();
  await expect(page.locator(".object__shop-comparison")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.panel.open({
    kind: "npc", objectId: "guide", title: "길잡이", body: "남문으로 가세요.", blocksMovement: false,
  }));
  await expect(page.locator("#object-panel")).toContainText("남문으로 가세요.");
  await page.waitForTimeout(100);
  expect(state.reads).toBe(0);
});

test("each successful live change refreshes once, while denied equip does not change the baseline", async ({ page }) => {
  const harness = await mount(page, [dagger()], { listings: [offer(blade()), offer(dagger(), 40)] });
  await emit(page, [changedEquipment("hunting-blade", false)]);
  await expect(line(page, "difference")).toHaveText("공격력 +4 · 피해 감소 0%p");
  expect(harness.state.reads).toBe(1);
  for (const event of [granted(), removed(), changedEquipment("hunting-blade")]) {
    harness.state.body = { items: [{ ...blade(), equipped: true }] };
    const previous = harness.state.reads;
    await emit(page, [event]);
    await expect(line(page, "baseline")).toHaveText("현재 장착 중");
    await expect(line(page, "difference", "old-dagger")).toHaveText("공격력 -4 · 피해 감소 0%p");
    await expect.poll(() => harness.state.reads).toBe(previous + 1);
  }
});

test("changes during HTTP invalidate old snapshots, coalesce follow-up reads and preserve keyboard focus", async ({ page }) => {
  const harness = await mount(page, [dagger()]);
  const button = row(page).locator(".object__shop-buy");
  await button.focus();
  const pending = harness.holdNext();
  await emit(page, [granted()]);
  await pending.started;
  harness.state.body = { items: [{ ...blade(), equipped: true }] };
  await emit(page, Array.from({ length: 40 }, (_, index) => index % 2 ? changedEquipment("hunting-blade") : removed()));
  await expect(line(page, "baseline")).toHaveText("비교: 장비 확인 중");
  await expect(button).toBeFocused();
  pending.release();
  await expect(line(page, "baseline")).toHaveText("현재 장착 중");
  await expect(button).toBeFocused();
  expect(harness.state.reads).toBe(3);
  expect(harness.state.maxActive).toBe(1);
});

test("comparison refresh preserves a pending purchase, nonce and denial recovery", async ({ page }) => {
  const harness = await mount(page, [dagger()]);
  const button = row(page).locator(".object__shop-buy");
  await button.focus();
  await page.keyboard.press("Enter");
  const purchases = () => page.evaluate(() => (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.purchases);
  const first = (await purchases())[0]!;
  expect(first).toMatchObject({ npcObjectId: "plaza-shop-npc", itemKey: "hunting-blade", quantity: 1 });
  expect(first.nonce).not.toBe("");
  expect(harness.state.reads).toBe(1);
  await emit(page, [changedEquipment("old-dagger")]);
  await expect(line(page, "difference")).toHaveText("공격력 +4 · 피해 감소 0%p");
  await expect(button).toBeDisabled();
  await openShop(page);
  await expect(button).toHaveText("구매하는 중…");
  expect(await purchases()).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.panel.applyShopDenied({
    action: "buy", itemKey: "hunting-blade", reason: "insufficient-balance",
  }));
  await expect(button).toBeEnabled();
  await button.click();
  expect((await purchases())[1]!.nonce).not.toBe(first.nonce);
  await page.evaluate(() => (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.panel.resolveShopAttempt("hunting-blade"));
  await expect(button).toBeEnabled();
});

test("close, non-shop replacement and destroy ignore late responses and retired live events", async ({ page }) => {
  const harness = await mount(page, [dagger()], { holdInitial: true });
  await page.locator("#object-panel-close").click();
  await page.evaluate(() => (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.panel.open({
    kind: "npc", objectId: "guide", title: "길잡이", body: "새 안내문", blocksMovement: false,
  }));
  const response = page.waitForResponse("**/api/inventory");
  harness.initial!.release();
  await response;
  await emit(page, [granted(), removed(), changedEquipment("hunting-blade")]);
  await expect(page.locator("#object-panel")).toContainText("새 안내문");
  await expect(page.locator(".object__shop-comparison")).toHaveCount(0);
  expect(harness.state.reads).toBe(1);
  const pending = harness.holdNext();
  await openShop(page);
  await pending.started;
  await page.evaluate(() => (window as unknown as { shopComparisonFixture: Fixture }).shopComparisonFixture.panel.destroy());
  const finalResponse = page.waitForResponse("**/api/inventory");
  pending.release();
  await finalResponse;
  await emit(page, [granted(), removed(), changedEquipment("hunting-blade")]);
  await expect(page.locator("#object-panel")).toBeHidden();
  await expect(page.locator(".object__shop-comparison")).toHaveCount(0);
  expect(harness.state.reads).toBe(2);
});

test("a quick close and reopen discards the old baseline and loads the new shop", async ({ page }) => {
  const harness = await mount(page, [dagger()], { holdInitial: true });
  await page.locator("#object-panel-close").click();
  harness.state.body = { items: [{ ...blade(), equipped: true }] };
  await openShop(page, [offer(dagger(), 40)]);
  harness.initial!.release();
  await expect(line(page, "baseline", "old-dagger")).toHaveText("비교: 사냥꾼 검");
  await expect(line(page, "difference", "old-dagger")).toHaveText("공격력 -4 · 피해 감소 0%p");
  expect(harness.state.reads).toBe(2);
});

async function unclipped(node: Locator): Promise<void> {
  await node.scrollIntoViewIfNeeded();
  await expect(node).toBeVisible();
  const failures = await node.evaluate(element => {
    const box = element.getBoundingClientRect();
    const clipped: string[] = [];
    if (box.left < -1 || box.top < -1 || box.right > innerWidth + 1 || box.bottom > innerHeight + 1) clipped.push("viewport");
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (style.overflowX !== "visible" && (box.left < rect.left - 1 || box.right > rect.right + 1)) clipped.push(`${parent.className}:x`);
      if (style.overflowY !== "visible" && (box.top < rect.top - 1 || box.bottom > rect.bottom + 1)) clipped.push(`${parent.className}:y`);
    }
    return clipped;
  });
  expect(failures).toEqual([]);
}

for (const theme of ["standard", "heritage"]) {
  test(`${theme} narrow shop keeps comparison, price and purchase control accessible`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 720, height: 480 });
    await mount(page, [dagger()], { theme, listings: [offer({ ...blade(), name: "아주 긴 이름의 사냥꾼 검 구매 전 비교" })] });
    await unclipped(line(page, "difference"));
    await unclipped(row(page).locator(".object__shop-price"));
    await unclipped(row(page).locator(".object__shop-buy"));
    await page.screenshot({ path: testInfo.outputPath(`shop-comparison-${theme}.png`) });
    await page.keyboard.press("Escape");
    await expect(page.locator("#object-panel")).toBeHidden();
  });
}
