import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { holdKey } from "../helpers/input";
import { joinRoom } from "../helpers/flows";

/**
 * Coverage for docs/design-npc-movement-block-fix.md: the entrance NPC at plaza (30,8) must no
 * longer freeze movement (it sits on the only corridor into the north door), while every other
 * interactable kind must still freeze movement exactly as before.
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

test("NPC 타일(30,8)을 지나며 화살표를 계속 눌러도 이동이 끊기지 않고 사냥터로 진입한다", async () => {
  await joinRoom(client.page, "plaza");
  await waitForCanvasReady(client.page);

  // Same BFS'd detour pass-g-tester-verification.spec.ts uses to reach (29,8), split into two
  // single-step holds for the last leg so the walk can be inspected while standing exactly on the
  // NPC tile, mid-walk, without releasing and re-pressing the key.
  await holdKey(client.page, "ArrowUp", 160);
  await client.page.waitForTimeout(80);
  await holdKey(client.page, "ArrowLeft", 280);
  await client.page.waitForTimeout(80);
  await holdKey(client.page, "ArrowUp", 1350);
  await client.page.waitForTimeout(80);

  await holdKey(client.page, "ArrowRight", 160); // (29,8) -> (30,8), the NPC tile
  await client.page.waitForTimeout(150); // let onInteractableEntered land

  await expect(client.page.locator("#object-panel")).toBeVisible();
  await expect(client.page.locator("#object-panel-kind")).toHaveText("안내");

  // The regression: this step used to never register because the still-open NPC panel blocked
  // movement, so the door trigger was never reached and the room never hopped.
  await holdKey(client.page, "ArrowRight", 160); // (30,8) -> (31,8), the door trigger
  await client.page.waitForTimeout(1500); // fade-out + reconnect + fade-in (hop())

  // A different signal from pass-g-tester-verification.spec.ts's loot-table check: the minimap
  // canvas's aria-label is set once per room at construction (Minimap ctor), independent of
  // whether the minimap panel is open.
  await expect(client.page.locator("#minimap-canvas")).toHaveAttribute(
    "aria-label",
    "hunting-ground 미니맵",
  );
  // The old panel instance is destroyed and a fresh one built closed — the NPC panel must not
  // survive the hop into the new room.
  await expect(client.page.locator("#object-panel")).toBeHidden();
});

test("퀴즈대(47,8)는 여전히 밟으면 이동이 멈추고, 패널을 닫으면 다시 움직인다", async () => {
  await joinRoom(client.page, "plaza");
  await waitForCanvasReady(client.page);

  // Row 20 (x=16..47) and column x=47 (y=8..20) are both fully walkable (verified against the
  // collision layer) and cross no door trigger, unlike the shorter path through the NPC's row.
  // Wait for the reached tile instead of assuming a fixed number of rendered frames.
  // On slower browsers the old 1960ms hold ended at x=46 and never reached the quiz.
  await client.page.keyboard.down("ArrowRight");
  try {
    await expect(client.page.getByLabel("현재 좌표")).toHaveText("47, 20", { timeout: 8000 });
  } finally {
    await client.page.keyboard.up("ArrowRight");
  }
  await client.page.keyboard.down("ArrowUp");
  try {
    await expect(client.page.locator("#object-panel")).toBeVisible({ timeout: 8000 });
  } finally {
    await client.page.keyboard.up("ArrowUp");
  }

  await expect(client.page.locator("#object-panel")).toBeVisible();
  await expect(client.page.locator("#object-panel-kind")).toHaveText("퀴즈");

  // Camera follows the local player exactly, so a real step pans the whole view; an ignored key
  // leaves every pixel identical. (47,9) south of the stand is the tile we just walked in from,
  // definitely walkable, so this isolates the panel gate rather than a wall.
  const clip = { x: 472, y: 248, width: 80, height: 80 };
  await client.page.waitForTimeout(300);
  const blockedBefore = await client.page.screenshot({ clip });
  await holdKey(client.page, "ArrowDown", 400);
  await client.page.waitForTimeout(150);
  const blockedAfter = await client.page.screenshot({ clip });
  expect(blockedAfter.equals(blockedBefore), "movement must stay frozen while the quiz panel is open").toBe(
    true,
  );

  await client.page.keyboard.press("Escape");
  await expect(client.page.locator("#object-panel")).toBeHidden();
  await client.page.waitForTimeout(300);
  const freeBefore = await client.page.screenshot({ clip });
  await holdKey(client.page, "ArrowDown", 400);
  await client.page.waitForTimeout(150);
  const freeAfter = await client.page.screenshot({ clip });
  expect(freeAfter.equals(freeBefore), "closing the panel must free movement again").toBe(false);
});

test.describe("ObjectPanel.blocksMovement — kind별 값과 close() 이후 리셋 (white-box)", () => {
  test("Npc는 false, Quiz/Notice/Link는 true이고, close() 이후 다음 open()이 리크 없이 새 값을 반영한다", async () => {
    await client.page.goto("/?room=plaza");
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/objectPanel.ts");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const panel = new (mod as any).ObjectPanel(() => {});

      const npcPayload = {
        kind: "npc",
        objectId: "test-npc",
        title: "안내",
        body: "text",
        blocksMovement: false,
      };
      const quizPayload = {
        kind: "quiz",
        objectId: "test-quiz",
        title: "퀴즈",
        question: "q",
        choices: ["a", "b"],
        blocksMovement: true,
      };
      const noticePayload = {
        kind: "notice",
        objectId: "test-notice",
        title: "공지",
        body: "text",
        blocksMovement: true,
      };
      const linkPayload = {
        kind: "link",
        objectId: "test-link",
        title: "링크",
        url: "https://example.com",
        blocksMovement: true,
      };

      const beforeAnyOpen = panel.blocksMovement;

      panel.open(npcPayload);
      const afterNpcOpen = { isOpen: panel.isOpen, blocksMovement: panel.blocksMovement };

      panel.close();
      const afterCloseFromNpc = panel.blocksMovement;

      panel.open(quizPayload);
      const afterQuizOpen = { isOpen: panel.isOpen, blocksMovement: panel.blocksMovement };

      panel.close();
      panel.open(noticePayload);
      const afterNoticeOpen = panel.blocksMovement;

      panel.close();
      panel.open(linkPayload);
      const afterLinkOpen = panel.blocksMovement;

      // Opposite direction from the first check: a blocking panel closing must not leave a stale
      // `true` behind for the next non-blocking NPC open.
      panel.close();
      panel.open(npcPayload);
      const afterNpcReopen = panel.blocksMovement;

      return {
        beforeAnyOpen,
        afterNpcOpen,
        afterCloseFromNpc,
        afterQuizOpen,
        afterNoticeOpen,
        afterLinkOpen,
        afterNpcReopen,
      };
    });

    expect(result.beforeAnyOpen, "nothing open yet").toBe(false);
    expect(result.afterNpcOpen).toEqual({ isOpen: true, blocksMovement: false });
    expect(result.afterCloseFromNpc, "a closed panel never blocks").toBe(false);
    expect(result.afterQuizOpen).toEqual({ isOpen: true, blocksMovement: true });
    expect(result.afterNoticeOpen).toBe(true);
    expect(result.afterLinkOpen).toBe(true);
    expect(
      result.afterNpcReopen,
      "a blocking Quiz/Notice/Link must not leak true onto a later Npc open",
    ).toBe(false);
  });
});
