import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page): Promise<void> {
  await page.route("**/api/inventory", (route) => route.fulfill({ json: { items: [
    { itemKey: "den-fur", name: "굴짐승 털", icon: "herb", quantity: 8, equipped: false, tradeable: true },
    { itemKey: "entry-pass", name: "입장권", icon: "entry-pass", quantity: 1, equipped: false, tradeable: false },
    { itemKey: "padded-armor", name: "누비 갑옷", icon: "leather-armor", quantity: 1, equipped: true, tradeable: false },
  ] } }));
  await page.route("http://127.0.0.1:5173/", (route) => route.fulfill({ contentType: "text/html", body:
    '<html lang="ko"><head><link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/heritage.css"></head><body><main class="app"><div class="stage" style="height:680px"><div class="hud"><div class="hud__controls"></div></div></div></main></body></html>' }));
  await page.goto("/");
  await page.evaluate(async () => {
    const { SocialPanel } = await import("/src/ui/socialPanel.ts");
    const calls: unknown[][] = [];
    const connection = {
      sessionId: "self", hasLeft: false,
      players: new Map([["self", { nickname: "내 캐릭터", level: 4 }], ["ally", { nickname: "파티 동료", level: 5 }]]),
      createParty: () => calls.push(["create"]), inviteParty: (id: string) => calls.push(["invite", id]),
      respondParty: (...args: unknown[]) => calls.push(["partyRespond", ...args]), leaveParty: () => calls.push(["leave"]),
      requestTrade: (...args: unknown[]) => calls.push(["request", ...args]), respondTrade: (...args: unknown[]) => calls.push(["respond", ...args]),
      updateTrade: (...args: unknown[]) => calls.push(["offer", ...args]), confirmTrade: (...args: unknown[]) => calls.push(["confirm", ...args]),
      cancelTrade: (...args: unknown[]) => calls.push(["cancel", ...args]), craftItem: (...args: unknown[]) => calls.push(["craft", ...args]),
    };
    const panel = new SocialPanel(connection as never);
    panel.applyBalance(100);
    (window as any).socialTest = { panel, connection, calls };
  });
  await page.locator("#social-button").click();
}

async function trade(page: Page, revision = 1, phase = "negotiating", confirmed = false): Promise<void> {
  await page.evaluate(({ revision, phase, confirmed }) => {
    (window as any).socialTest.panel.applyTrade({ tradeId: "trade-1", revision, phase, initiatorSessionId: "self", expiresAt: Date.now() + 60000,
      participants: [{ sessionId: "self", nickname: "내 캐릭터", confirmed, offer: { currency: 0, items: [] } },
        { sessionId: "ally", nickname: "파티 동료", confirmed: false, offer: { currency: 20, items: [{ itemKey: "carrot", name: "당근", quantity: 2 }] } }] });
  }, { revision, phase, confirmed });
}

test.beforeEach(async ({ page }) => { await mount(page); });

test("응답 시간 초과 뒤 교환 확정 버튼을 다시 사용할 수 있다", async ({ page }) => {
  await page.clock.install();
  await trade(page);
  const confirm = page.getByRole("button", { name: "표시된 제안으로 교환 확정", exact: true });
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await page.clock.fastForward(8001);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  expect(await page.evaluate(() => (window as any).socialTest.calls)).toEqual([
    ["confirm", "trade-1", 1], ["confirm", "trade-1", 1],
  ]);
});

test("불확실한 교환 결과는 같은 교환 ID로만 재확인한다", async ({ page }) => {
  await trade(page, 3, "settling");
  await page.evaluate(() => {
    const panel = (window as any).socialTest.panel;
    panel.applyTrade({ ...panel.trade, reason: "storage-error" });
  });
  await expect(page.locator(".social__trade-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "교환 취소", exact: true })).toHaveCount(0);
  const retry = page.getByRole("button", { name: "같은 교환 다시 확인", exact: true });
  await retry.click();
  await expect(retry).toBeDisabled();
  expect(await page.evaluate(() => (window as any).socialTest.calls)).toEqual([["confirm", "trade-1", 3]]);
});

test("파티 치유 대상 선택과 탈퇴 시 자기 대상 복귀", async ({ page }) => {
  await page.getByRole("button", { name: "파티 만들기", exact: true }).click();
  expect(await page.evaluate(() => (window as any).socialTest.calls)).toEqual([["create"]]);
  await page.evaluate(() => {
    (window as any).socialTest.panel.applyParty({ party: { partyId: "p1", leaderSessionId: "self", members: [
      { sessionId: "self", nickname: "내 캐릭터", playerClass: "healer", hp: 90, maxHp: 100, mp: 50, maxMp: 80, level: 4 },
      { sessionId: "ally", nickname: "파티 동료", playerClass: "warrior", hp: 40, maxHp: 120, mp: 20, maxMp: 40, level: 5 },
    ] } });
  });
  await page.getByRole("button", { name: "파티 동료 치유 대상 선택" }).click();
  await expect(page.getByRole("button", { name: "파티 동료 치유 대상 선택" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).socialTest.panel.healingTarget)).toBe("ally");
  await page.evaluate(() => {
    const state = (window as any).socialTest.panel;
    state.applyParty({ party: { partyId: "p1", leaderSessionId: "self", members: [
      { sessionId: "self", nickname: "내 캐릭터", playerClass: "healer", hp: 90, maxHp: 100, mp: 50, maxMp: 80, level: 4 },
      { sessionId: "ally", nickname: "파티 동료", playerClass: "warrior", hp: 60, maxHp: 120, mp: 20, maxMp: 40, level: 5 },
    ] } });
  });
  await expect(page.getByRole("button", { name: "파티 동료 치유 대상 선택" })).toBeFocused();
  await page.evaluate(() => (window as any).socialTest.panel.applyParty({ party: null }));
  expect(await page.evaluate(() => (window as any).socialTest.panel.healingTarget)).toBe("self");
});

test("교환은 metadata로 아이템 제한, 편집 후 적용, 최신 제안 재확인", async ({ page }) => {
  await trade(page);
  await expect(page.getByText("당근 × 2", { exact: true })).toBeVisible();
  await expect(page.getByLabel("교환 아이템 1", { exact: true }).locator("option")).toHaveText(["선택 안 함", "굴짐승 털 (보유 8)"]);
  await page.getByLabel("교환 아이템 1", { exact: true }).selectOption("den-fur");
  await page.getByLabel("교환 수량 1", { exact: true }).fill("3");
  await expect(page.getByRole("button", { name: "제안 적용 후 확정하세요" })).toBeDisabled();
  await page.getByRole("button", { name: "제안 적용", exact: true }).click();
  expect(await page.evaluate(() => (window as any).socialTest.calls.at(-1))).toEqual(["offer", "trade-1", 1, { currency: 0, items: [{ itemKey: "den-fur", quantity: 3 }] }]);
  await trade(page, 2);
  await page.getByRole("button", { name: "표시된 제안으로 교환 확정" }).click();
  expect(await page.evaluate(() => (window as any).socialTest.calls.at(-1))).toEqual(["confirm", "trade-1", 2]);
  await trade(page, 2, "negotiating", true);
  await expect(page.getByRole("button", { name: "확인 완료 · 상대 대기" })).toBeDisabled();
  await trade(page, 3);
  await expect(page.getByRole("button", { name: "표시된 제안으로 교환 확정" })).toBeEnabled();
  await page.locator("#social-panel").screenshot({ path: test.info().outputPath("social-panel.png") });
});

test("교환 처리 중 변경 불가, 패널 닫기는 교환 취소와 분리", async ({ page }) => {
  await trade(page, 2, "settling");
  await expect(page.getByRole("button", { name: "교환 취소", exact: true })).toHaveCount(0);
  await expect(page.locator(".social__trade-form")).toHaveCount(0);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator("#social-panel")).toBeHidden();
  expect(await page.evaluate(() => (window as any).socialTest.calls)).toEqual([]);
  await page.locator("#social-button").click();
  await trade(page, 2, "completed");
  await page.getByRole("button", { name: "교환 내역 닫기" }).click();
  await expect(page.getByText("주변 사람에게 교환을 요청해 보세요.")).toBeVisible();
});

test("제작 중복 클릭 차단과 일시 오류 재시도 nonce 유지", async ({ page }) => {
  await page.evaluate(() => (window as any).socialTest.panel.applyRecipes({ recipes: [{ recipeId: "reinforced-armor", name: "갑옷 보강",
    ingredients: [{ itemKey: "den-fur", name: "굴짐승 털", quantity: 3 }], currencyCost: 30,
    output: { itemKey: "reinforced-armor", name: "보강 갑옷", quantity: 1 } }] }));
  await page.getByRole("button", { name: "제작하기", exact: true }).click();
  await expect(page.getByRole("button", { name: "제작 중…" })).toBeDisabled();
  const first = await page.evaluate(() => (window as any).socialTest.calls.at(-1));
  await page.evaluate(() => {
    const state = (window as any).socialTest;
    state.panel.applyCraftResult({ recipeId: "reinforced-armor", nonce: state.calls.at(-1)[2], ok: false, reason: "storage-error" });
  });
  await page.getByRole("button", { name: "같은 제작 다시 확인" }).click();
  expect(await page.evaluate(() => (window as any).socialTest.calls.at(-1))).toEqual(first);
  await page.evaluate(() => {
    const state = (window as any).socialTest;
    state.panel.applyCraftResult({ recipeId: "reinforced-armor", nonce: state.calls.at(-1)[2], ok: true });
  });
  await expect(page.getByRole("button", { name: "제작하기", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => sessionStorage.getItem("zep:pending-craft"))).toBe("{}");
});

test("900px부터 1920px까지 패널 영역, 키보드 닫기와 destroy 정리", async ({ page }) => {
  for (const width of [900, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const box = (await page.locator("#social-panel").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await page.locator("#social-panel").evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "닫기", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#social-button")).toBeFocused();
  await page.evaluate(() => (window as any).socialTest.panel.destroy());
  await expect(page.locator("#social-button")).toHaveCount(0);
  await expect(page.locator("#social-panel")).toHaveCount(0);
});
