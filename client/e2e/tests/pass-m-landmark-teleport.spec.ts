import { expect, test } from "@playwright/test";
import { LANDMARK_DEFINITIONS } from "@zep-test/shared";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { probeAnimationLoop, waitForCanvasReady } from "../helpers/canvas";
import { tapKey } from "../helpers/input";
import { dismissClassPicker, joinRoom } from "../helpers/flows";

const landmarkName = (room: string) => LANDMARK_DEFINITIONS.find(landmark => landmark.room === room)!.name;

/**
 * Independent ui-engineer coverage for docs/design-phase-m-landmark-teleport.md §7 Pass C's golden
 * path. The entry-pass admit path (§2.4's "holds the item -> join succeeds") is not re-proven here:
 * it is already exhaustively unit-tested server-side
 * (server/src/rooms/metaverseRoom.landmarks.test.ts), and reaching it live would need a stable SSO
 * identity plus farming a random (15%) squirrel drop, which this suite has no fixture for. What is
 * genuinely new on the client — a join that refuses outright — is (e) below.
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

test.describe("Phase M (a)(b) — T 단축키로 패널을 열고 닫는다, 등록된 랜드마크가 표시된다", () => {
  test("T로 열리고, 모든 항목이 표시되며, T나 Escape로 닫힌다", async () => {
    await joinRoom(client.page, "plaza");
    const button = client.page.locator("#landmark-button");
    await expect(button).toBeVisible();

    await tapKey(client.page, "KeyT");
    const panel = client.page.locator("#landmark-panel");
    await expect(panel).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");

    const rows = client.page.locator("#landmark-panel-list .landmark-panel__item");
    await expect(rows).toHaveText(LANDMARK_DEFINITIONS.map(landmark => landmark.name));

    await tapKey(client.page, "KeyT");
    await expect(panel).toBeHidden();
    await expect(button).toHaveAttribute("aria-expanded", "false");

    await tapKey(client.page, "KeyT");
    await expect(panel).toBeVisible();
    await client.page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });
});

test.describe("Phase M (h)(i) — 키 바인딩 충돌", () => {
  test("채팅 입력 중 T를 입력해도 패널이 열리지 않는다", async () => {
    await joinRoom(client.page, "plaza");
    const chatInput = client.page.locator("#chat-input");
    await chatInput.click();
    await expect(chatInput).toBeFocused();

    await client.page.keyboard.press("KeyT");
    await expect(client.page.locator("#landmark-panel")).toBeHidden();
    await expect(chatInput).toBeFocused();
  });

  test("Ctrl+T는 패널을 열지 않는다", async () => {
    await joinRoom(client.page, "plaza");
    await client.page.keyboard.down("Control");
    await client.page.keyboard.press("KeyT");
    await client.page.keyboard.up("Control");
    await expect(client.page.locator("#landmark-panel")).toBeHidden();
  });
});

test.describe("Phase M (c) — 같은 room 랜드마크는 hop 없이 워프한다", () => {
  test("분수 광장에서 자신의 랜드마크를 클릭하면 hop이 시작되지 않고, 워프 쿨다운만 걸린다", async () => {
    await joinRoom(client.page, "grand-plaza");
    await tapKey(client.page, "KeyT");
    const ownRow = client.page
      .locator("#landmark-panel-list")
      .getByRole("button", { name: landmarkName("grand-plaza"), exact: true });
    await ownRow.click();

    // Row click closes the panel before anything else happens (design §3.4).
    await expect(client.page.locator("#landmark-panel")).toBeHidden();
    // No hop was attempted: the wipe never went opaque.
    await expect(client.page.locator("#transition")).toHaveAttribute("data-state", "clear");

    await tapKey(client.page, "KeyT");
    // The optimistic cooldown began immediately — proof the same-room branch, not startHop(), ran.
    await expect(ownRow).toBeDisabled();
  });
});

test.describe("Phase M (d) — 다른 room 랜드마크는 hop한다", () => {
  test("마을 광장에서 '사냥터 입구'를 클릭하면 hunting-ground로 hop한다", async () => {
    await joinRoom(client.page, "plaza");
    await tapKey(client.page, "KeyT");
    await client.page
      .locator("#landmark-panel-list")
      .getByRole("button", { name: landmarkName("hunting-ground"), exact: true })
      .click();

    await client.page.waitForTimeout(1500); // fade-out + rejoin + fade-in (hop())
    await waitForCanvasReady(client.page);
    await dismissClassPicker(client.page);

    await tapKey(client.page, "KeyM");
    await expect(client.page.locator("#minimap-canvas")).toHaveAttribute(
      "aria-label",
      `${landmarkName("hunting-ground")} 미니맵`,
    );
  });
});

test.describe("Phase M (e) — 입장권 없이 '사냥굴 입구'를 클릭하면 hop이 거부되고 출발 room에 남는다", () => {
  test("plaza에서 입장권 없이 시도하면 실패 문구가 뜨고 plaza에 그대로 남는다", async () => {
    await joinRoom(client.page, "plaza");
    await tapKey(client.page, "KeyT");
    await client.page
      .locator("#landmark-panel-list")
      .getByRole("button", { name: landmarkName("hunting-den"), exact: true })
      .click();

    await client.page.waitForTimeout(1500); // failed join round trip + abandonTransition's fade-in

    await expect(client.page.locator("#transition-notice")).toHaveText(
      "랜드마크로 이동하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
    await expect(client.page.locator("#transition")).toHaveAttribute("data-state", "clear");

    await tapKey(client.page, "KeyM");
    await expect(client.page.locator("#minimap-canvas")).toHaveAttribute("aria-label", `${landmarkName("plaza")} 미니맵`);
  });
});

test.describe("Phase M (g) — 홈 워프 직후에도 랜드마크 패널의 표시는 독립적이다 (§8-1)", () => {
  test("H로 홈 워프한 직후, 랜드마크 행은 disabled로 보이지 않는다", async () => {
    await joinRoom(client.page, "plaza");
    await tapKey(client.page, "KeyH");
    await expect(client.page.locator("#home-button")).toBeDisabled();

    await tapKey(client.page, "KeyT");
    const ownRow = client.page
      .locator("#landmark-panel-list")
      .getByRole("button", { name: landmarkName("plaza"), exact: true });
    // Independent module-scope cooldowns (design §2.3/§8-1): the home warp just started the
    // server's shared budget, but the panel's own display has not, so the row still reads
    // clickable even though the server will silently drop the click that follows.
    await expect(ownRow).toBeEnabled();

    const consoleErrors: string[] = [];
    client.page.on("pageerror", (error) => consoleErrors.push(String(error)));
    await ownRow.click();
    await client.page.waitForTimeout(200);
    expect(consoleErrors).toEqual([]);

    await tapKey(client.page, "KeyT");
    // The click still ran the client's own optimistic cooldown, regardless of what the server did
    // with the (silently dropped) request.
    await expect(ownRow).toBeDisabled();
  });
});

test.describe("Phase M (j) — 이동 중 같은 room 랜드마크로 워프해도 렌더 루프가 죽지 않는다", () => {
  test("방향키를 누른 채 워프해도 콘솔 에러 없이 계속 렌더링된다", async () => {
    await joinRoom(client.page, "grand-plaza");
    const consoleErrors: string[] = [];
    client.page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await tapKey(client.page, "KeyT");
    await client.page.keyboard.down("ArrowDown");
    await client.page.waitForTimeout(150);
    await client.page
      .locator("#landmark-panel-list")
      .getByRole("button", { name: landmarkName("grand-plaza"), exact: true })
      .click();
    await client.page.waitForTimeout(150);
    await client.page.keyboard.up("ArrowDown");
    await client.page.waitForTimeout(300);

    expect(consoleErrors).toEqual([]);
    const frames = await probeAnimationLoop(client.page, 300);
    expect(frames).toBeGreaterThan(0);
  });
});
