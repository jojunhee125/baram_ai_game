import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { holdKey, tapKey } from "../helpers/input";
import { joinRoom } from "../helpers/flows";

/**
 * Independent tester coverage for design-hunting-inventory.md §G-4, items not already exercised by
 * pass-g-combat-loot.spec.ts: room-hop round trip (G-2 #3), modifier/IME guards (G-2 #5), and the
 * network-failure -> retry -> cache path (G-2 #6).
 */

let browser: Awaited<ReturnType<typeof launchSharedBrowser>>;
let client: Client;

test.beforeAll(async () => {
  browser = await launchSharedBrowser();
});

test.afterAll(async () => {
  await browser.close();
});

test.beforeEach(async () => {
  client = await openFreshClient(browser);
});

test.afterEach(async () => {
  await client.close();
});

test("Ctrl+L / Alt+L 은 패널을 열지 않는다", async () => {
  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);

  await client.page.keyboard.down("Control");
  await client.page.keyboard.press("KeyL");
  await client.page.keyboard.up("Control");
  await expect(client.page.locator("#loot-table")).toBeHidden();

  await client.page.keyboard.down("Alt");
  await client.page.keyboard.press("KeyL");
  await client.page.keyboard.up("Alt");
  await expect(client.page.locator("#loot-table")).toBeHidden();
});

test("채팅 입력창에 포커스가 있으면 KeyL(및 조합 중 이벤트)이 패널을 열지 않는다", async () => {
  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);

  const chatInput = client.page.locator("#chat-input");
  await chatInput.click();
  await expect(chatInput).toBeFocused();

  // A plain KeyL while the composer holds focus — isTextEntry(document.activeElement) blocks it.
  await client.page.keyboard.press("KeyL");
  await expect(client.page.locator("#loot-table")).toBeHidden();

  // The IME case proper: a composing keydown carrying the physical KeyL code (e.g. one step of
  // typing "ㅣㅏㄹ"), still targeted at the composer. Same guard, exercised directly.
  await client.page.evaluate(() => {
    document
      .querySelector("#chat-input")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyL", isComposing: true, bubbles: true, cancelable: true }),
      );
  });
  await expect(client.page.locator("#loot-table")).toBeHidden();

  // Sanity: the composer itself still has focus and the guard is not just "always hidden".
  await expect(chatInput).toBeFocused();
});

test("사냥터→plaza→사냥터 왕복 후에도 room에 맞는 확률표가 뜬다 (실제 포탈 이동)", async () => {
  // plaza's spawn is deterministic (spreadRadiusInTiles: 0, server/src/rooms/definitions.ts),
  // unlike hunting-ground's own join spawn — start here so the walk is exact. The straight column
  // is blocked by the central fountain (assets/README.md: spawn sits "분수 남쪽"/south of it), so
  // this detours around it: BFS'd against assets/maps/plaza.json's collision layer, U,L,L,U*11,R,R
  // from (31,20) to the door trigger at (31,8)/(32,8).
  await joinRoom(client.page, "plaza");
  await waitForCanvasReady(client.page);

  await tapKey(client.page, "KeyL");
  await expect(client.page.locator("#loot-table-status-text")).toHaveText(
    "이 지역에는 몬스터가 없습니다.",
  );
  await client.page.keyboard.press("Escape");
  await expect(client.page.locator("#loot-table")).toBeHidden();

  await holdKey(client.page, "ArrowUp", 160);
  await client.page.waitForTimeout(80);
  await holdKey(client.page, "ArrowLeft", 280);
  await client.page.waitForTimeout(80);
  await holdKey(client.page, "ArrowUp", 1350);
  await client.page.waitForTimeout(80);
  await holdKey(client.page, "ArrowRight", 280);
  await client.page.waitForTimeout(1200); // fade-out + reconnect + fade-in (hop())

  const monsters = client.page.locator(".loot-table__monster");
  await tapKey(client.page, "KeyL");
  await expect(monsters).toHaveCount(2);
  await expect(monsters.nth(0).locator(".loot-table__monster-name")).toHaveText("다람쥐");
  await expect(monsters.nth(1).locator(".loot-table__monster-name")).toHaveText("토끼");
  await client.page.keyboard.press("Escape");
  await expect(client.page.locator("#loot-table")).toBeHidden();

  // Arrival (35,30) -> hunting-ground-south-door trigger (35,31)/(36,31): 1 tile south, and both
  // this arrival and the door trigger are spreadRadiusInTiles: 0 (portal arrivals, unlike a room's
  // own join spawn, never carry spread), so this is exact.
  await holdKey(client.page, "ArrowDown", 180);
  await client.page.waitForTimeout(1200);

  await tapKey(client.page, "KeyL");
  await expect(client.page.locator("#loot-table-status-text")).toHaveText(
    "이 지역에는 몬스터가 없습니다.",
  );
  await client.page.keyboard.press("Escape");
  await expect(client.page.locator("#loot-table")).toBeHidden();

  // Arrival (31,9) -> plaza-north-door trigger (31,8)/(32,8): 1 tile north, same reasoning.
  await holdKey(client.page, "ArrowUp", 180);
  await client.page.waitForTimeout(1200);

  await tapKey(client.page, "KeyL");
  await expect(monsters).toHaveCount(2);
  await expect(monsters.nth(0).locator(".loot-table__monster-name")).toHaveText("다람쥐");
  await expect(monsters.nth(1).locator(".loot-table__monster-name")).toHaveText("토끼");
});

test("첫 오픈에서 네트워크 실패 시 에러+재시도, 복구 후 재시도 성공하면 재오픈은 캐시로 즉시 표시된다", async () => {
  let requestCount = 0;
  let shouldFail = true;
  await client.page.route("**/api/loot-table/**", (route) => {
    requestCount += 1;
    if (shouldFail) {
      return route.abort("failed");
    }
    return route.continue();
  });

  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);

  await tapKey(client.page, "KeyL");
  await expect(client.page.locator("#loot-table-status-text")).toHaveText(
    "확률표를 읽지 못했습니다.",
  );
  const retryButton = client.page.locator("#loot-table-retry");
  await expect(retryButton).toBeVisible();
  expect(requestCount).toBe(1);

  shouldFail = false;
  await retryButton.click();

  const monsters = client.page.locator(".loot-table__monster");
  await expect(monsters).toHaveCount(2);
  expect(requestCount).toBe(2);

  // Close and reopen: a successful read is cached for this instance's lifetime, so this must not
  // fire a third request and must not pass through the loading state on the way to showing rows.
  await client.page.keyboard.press("Escape");
  await expect(client.page.locator("#loot-table")).toBeHidden();
  await tapKey(client.page, "KeyL");
  await expect(monsters).toHaveCount(2);
  expect(requestCount).toBe(2);
});
