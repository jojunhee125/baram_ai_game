import { expect, test, type Page } from "@playwright/test";
import { launchSharedBrowser, openFreshClient } from "../helpers/browser";
import { joinRoom } from "../helpers/flows";

async function step(page: Page, direction: string): Promise<void> {
  await page.keyboard.down(direction);
  await page.waitForTimeout(65);
  await page.keyboard.up(direction);
  await page.waitForTimeout(180);
}
async function position(page: Page): Promise<number[]> {
  return (await page.locator(".region-guide__coordinates").innerText()).split(",").map(Number);
}
async function walk(page: Page, targetX: number, targetY: number): Promise<void> {
  for (let steps = 0; steps < 50; steps++) {
    const [x,y] = await position(page);
    if (x === targetX && y === targetY) return;
    await step(page, x! < targetX ? "ArrowRight" : x! > targetX ? "ArrowLeft" : y! < targetY ? "ArrowDown" : "ArrowUp");
  }
  throw new Error(`could not walk to ${targetX},${targetY}; actual ${await position(page)}`);
}
const region = (page: Page) => page.locator(".region-guide strong");

test("남문에서 상점 접근, 들판 왕복, 대광장 진입과 H 귀환이 실제 입력으로 연결된다", async () => {
  const browser = await launchSharedBrowser();
  const client = await openFreshClient(browser);
  const errors: string[] = [];
  client.page.on("pageerror", error => errors.push(String(error)));
  try {
    const page = client.page;
    await joinRoom(page, "plaza");
    await expect(region(page)).toHaveText("남문 마을");
    await expect(page.locator(".region-guide__coordinates")).toHaveText("31, 20");
    await page.screenshot({path:"test-results/progression-screens/plaza.png"});
    await walk(page, 35, 20);
    await expect(page.locator("#object-panel")).toBeVisible();
    await expect(page.locator(".object__shop-name")).toContainText(["약초", "낡은 단검", "누비옷", "사냥꾼 검", "강화 가죽갑옷", "철검"]);
    await expect(page.locator(".object__shop-price")).toContainText(["12전", "40전", "100전", "180전", "300전", "480전"]);
    await page.locator("#object-panel-close").click();
    await walk(page, 31, 24);
    await step(page, "ArrowDown");
    await expect(region(page)).toHaveText("초보 들판");
    await expect(page.locator(".region-guide__coordinates")).toHaveText("35, 30");
    await page.screenshot({path:"test-results/progression-screens/hunting-ground.png"});
    await step(page, "ArrowDown");
    await expect(region(page)).toHaveText("남문 마을");
    await expect(page.locator(".region-guide__coordinates")).toHaveText("31, 23");
    await walk(page, 31, 9);
    await step(page, "ArrowUp");
    await expect(region(page)).toHaveText("대광장");
    await page.keyboard.press("KeyH");
    await expect(region(page)).toHaveText("남문 마을");
    await expect(page.locator(".region-guide__coordinates")).toHaveText("31, 20");
    expect(errors).toEqual([]);
  } finally { await client.close(); await browser.close(); }
});

test("굴 지역 보상 표시와 굴→들판→남문 출구를 실제 입력으로 확인한다", async () => {
  const browser = await launchSharedBrowser();
  const client = await openFreshClient(browser);
  try {
    const page = client.page;
    await joinRoom(page, "hunting-den");
    await page.screenshot({path:"test-results/progression-screens/hunting-den.png"});
    await page.keyboard.press("KeyL");
    await expect(page.locator("#loot-table")).toBeVisible();
    await expect(page.locator("#loot-table-list")).toContainText("경험치 20");
    await expect(page.locator("#loot-table-list")).toContainText("경험치 32");
    await expect(page.locator("#loot-table-list")).toContainText("굴짐승 털");
    await expect(page.locator("#loot-table-list")).toContainText("단단한 뿔");
    await page.locator("#loot-table-close").click();
    await walk(page, 31, 26);
    await step(page, "ArrowDown");
    await expect(region(page)).toHaveText("초보 들판");
    // The field's central route is traversed from its northern arrival to the southern exit.
    await walk(page, 35, 30);
    await step(page, "ArrowDown");
    await expect(region(page)).toHaveText("남문 마을");
  } finally { await client.close(); await browser.close(); }
});

test("열린 빈 가방의 실시간 획득 이벤트가 판매·사용·새 무기 장착 버튼을 즉시 만든다", async () => {
  const browser=await launchSharedBrowser();
  const client=await openFreshClient(browser);
  try {
    const page=client.page;
    await page.route("**/api/inventory",route=>route.fulfill({json:{items:[]}}));
    await page.goto("/?room=plaza");
    await page.evaluate(async()=>{
      const {InventoryPanel}=await import("/src/ui/inventoryPanel.ts");
      const panel=new InventoryPanel(()=>{},()=>{},()=>{},()=>{});
      (window as unknown as {auditPanel:typeof panel}).auditPanel=panel;
      document.querySelector<HTMLButtonElement>("#inventory-button")!.click();
    });
    await expect(page.locator("#inventory-list")).toHaveAttribute("aria-busy","false");
    await page.evaluate(()=>{
      const panel=(window as unknown as {auditPanel:{applyGrant(event:unknown):void}}).auditPanel;
      for(const [itemKey,icon,sellValue] of [["acorn","acorn",4],["den-fur","acorn",10],["antler","carrot",18],
        ["old-dagger","old-dagger",10],["hunting-blade","old-dagger",45],["herb","herb",3]] as const) {
        panel.applyGrant({itemKey,name:itemKey,icon,sellValue,quantity:1,total:1,...(itemKey==="herb"?{consumable:true}:{})});
      }
    });
    await expect(page.locator("#inventory-list .bag__sell")).toHaveCount(6);
    await expect(page.locator("#inventory-list .bag__use")).toHaveCount(1);
    await expect(page.locator('#inventory-list [data-item-key="hunting-blade"]')).toContainText("장착");
  } finally {await client.close();await browser.close();}
});
