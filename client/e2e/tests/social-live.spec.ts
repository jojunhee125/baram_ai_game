import { expect, test, type Page } from "@playwright/test";
import { openConcurrentClients, type Client } from "../helpers/browser";
import { completeAvatarPicker } from "../helpers/flows";
import { waitForCanvasReady } from "../helpers/canvas";

const firstOwner = "abcdef12-3456-4789-abcd-abcdefabcdef";
const secondOwner = "fedcba98-7654-4321-abcd-fedcbafedcba";
let clients: Client[] = [];

test.skip(process.env["ZEP_SOCIAL_TEST_SERVER"] !== "1", "Run with social.playwright.config.ts for the isolated seeded server");

async function enter(client: Client, owner: string, name: string): Promise<void> {
  const token = `header.${Buffer.from(JSON.stringify({ sub: owner, preferred_username: name })).toString("base64url")}.sig`;
  // The gateway supplies this header on HTTP and WebSocket upgrades in production.
  await client.context.setExtraHTTPHeaders({ "x-auth-request-access-token": token });
  await client.page.route("**/matchmake/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: {
        "access-control-allow-origin": "http://127.0.0.1:5173",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-auth-request-access-token",
        "access-control-allow-credentials": "true",
      } });
    } else await route.continue();
  });
  await client.page.goto("http://127.0.0.1:5173/?room=plaza");
  await completeAvatarPicker(client.page);
  try { await waitForCanvasReady(client.page); }
  catch (cause) {
    throw new Error(`Game boot failed: ${await client.page.locator("body").innerText()}`, { cause });
  }
  await client.page.locator("#social-button").click();
}

async function bag(page: Page): Promise<{ itemKey: string; quantity: number }[]> {
  return page.evaluate(async () => (await (await fetch("/api/inventory")).json()).items);
}

test.afterEach(async () => { await Promise.all(clients.map((client) => client.close())); clients = []; });

test("두 실제 브라우저의 파티, 양방향 교환, 제작이 서버 자산에 반영된다", async () => {
  clients = await openConcurrentClients(2);
  const [first, second] = clients as [Client, Client];
  const errors: string[] = [];
  for (const client of clients) {
    client.page.on("pageerror", (error) => { errors.push(error.message); console.error("browser page error", error.message); });
    client.page.on("console", (message) => { if (message.type() === "error") console.error("browser console", message.text()); });
  }
  await enter(first, firstOwner.toUpperCase(), "사회검증갑");
  await enter(second, secondOwner, "사회검증을");
  const a = first.page; const b = second.page;
  await a.getByRole("button", { name: "파티 만들기", exact: true }).click();
  await a.locator(".social__nearby").filter({ hasText: "사회검증을" }).getByRole("button", { name: "초대", exact: true }).click();
  await b.getByRole("button", { name: "파티 수락", exact: true }).click();
  await expect(a.locator(".social__member")).toHaveCount(2);
  await expect(b.locator(".social__member")).toHaveCount(2);
  await b.getByRole("button", { name: "사회검증갑 치유 대상 선택", exact: true }).click();
  await expect(b.getByRole("button", { name: "사회검증갑 치유 대상 선택", exact: true })).toHaveAttribute("aria-pressed", "true");
  await a.locator(".social__nearby").filter({ hasText: "사회검증을" }).getByRole("button", { name: "교환", exact: true }).click();
  await b.getByRole("button", { name: "교환 수락", exact: true }).click();
  await a.getByLabel("교환 아이템 1", { exact: true }).selectOption("den-fur");
  await a.getByLabel("교환 수량 1", { exact: true }).fill("1");
  await a.getByRole("button", { name: "제안 적용", exact: true }).click();
  await expect(b.locator(".social__offer").first()).toContainText("× 1");
  await b.getByLabel(/제시할 전/).fill("10");
  await b.getByRole("button", { name: "제안 적용", exact: true }).click();
  await expect(a.locator(".social__offer").nth(1)).toContainText("10전");
  await a.getByRole("button", { name: "표시된 제안으로 교환 확정", exact: true }).click();
  await b.getByRole("button", { name: "표시된 제안으로 교환 확정", exact: true }).click();
  await expect(a.getByText("교환 완료", { exact: true })).toBeVisible();
  await expect(b.getByText("교환 완료", { exact: true })).toBeVisible();
  expect((await bag(a)).find((item) => item.itemKey === "den-fur")?.quantity).toBe(3);
  expect((await bag(b)).find((item) => item.itemKey === "den-fur")?.quantity).toBe(1);
  await a.getByRole("button", { name: "제작하기", exact: true }).click();
  await expect(a.locator(".social__status")).toContainText("제작을 완료했습니다");
  const crafted = await bag(a);
  expect(crafted.find((item) => item.itemKey === "reinforced-armor")?.quantity).toBe(1);
  expect(crafted.some((item) => item.itemKey === "padded-armor" || item.itemKey === "den-fur")).toBe(false);
  await b.getByRole("button", { name: "파티 나가기", exact: true }).click();
  await expect(a.locator(".social__member")).toHaveCount(1);
  await expect(b.locator(".social__member")).toHaveCount(0);
  expect(errors).toEqual([]);
  await a.locator("#social-panel").screenshot({ path: test.info().outputPath("social-live-completed.png") });
});
