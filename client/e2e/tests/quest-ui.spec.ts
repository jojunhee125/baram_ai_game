import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { holdKey } from "../helpers/input";
import { joinRoom } from "../helpers/flows";

/**
 * Coverage for the client half of roadmap R03 (docs/implementation-2026-09-17-quest-ui.md): the
 * guide NPC's panel offers 첫 사냥 and can accept it, and the tracker under the vitals shows what
 * the account is carrying.
 *
 * Kill progress is not driven from a browser here. Without SSO the server keys an account by
 * `client.sessionId` (metaverseRoom.ts), so walking through the north door into the hunting ground
 * rejoins as a *different* account and the accepted quest does not follow — the counter itself is
 * covered by the server suite (questSystem.test.ts), and the white-box blocks below cover how the
 * counting states are drawn.
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

test("안내 NPC 패널에서 첫 사냥을 수락하면 패널이 진행 중으로 바뀌고 트래커에 줄이 생긴다", async () => {
  await joinRoom(client.page, "plaza");
  await waitForCanvasReady(client.page);

  // The same BFS'd walk to (29,8) npc-movement-block-fix.spec.ts uses.
  await holdKey(client.page, "ArrowUp", 160);
  await client.page.waitForTimeout(80);
  await holdKey(client.page, "ArrowLeft", 280);
  await client.page.waitForTimeout(80);
  await holdKey(client.page, "ArrowUp", 1350);
  await client.page.waitForTimeout(80);
  // Shorter than STEP_TWEEN_MS (120ms), so the hold can only produce the one step onto the NPC
  // tile. A second step would land on the door trigger at (31,8) and hop rooms out from under the
  // panel this test is about — which is exactly what a 160ms hold did under full-suite load.
  await holdKey(client.page, "ArrowRight", 100);
  // Asserted rather than assumed: overshooting is the one failure that would otherwise look like
  // a broken panel instead of a walk that went one tile too far.
  await expect(client.page.getByLabel("현재 좌표")).toHaveText("30, 8");

  await expect(client.page.locator("#object-panel")).toBeVisible();
  // The quest rides on the NPC panel payload, so it is drawn with the panel rather than fetched.
  await expect(client.page.locator(".object__quest-title")).toHaveText("첫 사냥");
  await expect(client.page.locator(".object__quest-status")).toHaveText("아직 수락하지 않았습니다.");
  // Nothing is tracked before an accept — the tracker holds accepted quests only.
  await expect(client.page.locator("#quest-tracker")).toBeHidden();

  await client.page.locator(".object__quest-accept").click();

  // Both readings come from the server's own `quest:updated`, never from the click: the button
  // draws no accepted state itself, so these passing means the round trip landed.
  await expect(client.page.locator(".object__quest-status")).toHaveText("진행 중 · 0 / 3");
  await expect(client.page.locator(".object__quest-accept")).toBeHidden();
  await expect(client.page.locator("#quest-tracker")).toBeVisible();
  await expect(client.page.locator(".quests__title")).toHaveText("첫 사냥");
  await expect(client.page.locator(".quests__count")).toHaveText("0 / 3");
  await expect(client.page.locator(".quests__objective")).toHaveText("사냥터에서 다람쥐 3마리 처치");
});

test.describe("QuestTracker — 상태별 표시와 destroy (white-box)", () => {
  test("offered는 무시하고, accepted/completed는 줄을 갱신하며, destroy()가 DOM을 비운다", async () => {
    await client.page.goto("/?room=plaza");
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/questTracker.ts");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tracker = new (mod as any).QuestTracker();
      const base = {
        questId: "first-hunt",
        title: "첫 사냥",
        summary: "북쪽 문을 지나면 사냥터입니다.",
        objectiveText: "사냥터에서 다람쥐 3마리 처치",
        completionText: "벌써 세 마리를 잡았군요.",
        status: "offered",
        killCount: 0,
        requiredCount: 3,
      };
      const panel = document.querySelector<HTMLElement>("#quest-tracker")!;
      const rows = () => document.querySelectorAll(".quests__row").length;
      const read = () => {
        const row = document.querySelector<HTMLElement>(".quests__row")!;
        return {
          status: row.dataset["status"],
          count: row.querySelector<HTMLElement>(".quests__count")!.textContent,
          objective: row.querySelector<HTMLElement>(".quests__objective")!.textContent,
          fill: row.querySelector<HTMLElement>(".quests__fill")!.style.transform,
          valuenow: row.querySelector<HTMLElement>(".quests__track")!.getAttribute("aria-valuenow"),
        };
      };

      tracker.apply(base);
      const afterOffered = { hidden: panel.hidden, rows: rows() };

      tracker.apply({ ...base, status: "accepted" });
      const afterAccepted = { hidden: panel.hidden, rows: rows(), ...read() };

      tracker.apply({ ...base, status: "accepted", killCount: 2 });
      const afterProgress = { rows: rows(), ...read() };

      tracker.apply({ ...base, status: "completed", killCount: 3 });
      const afterCompleted = { rows: rows(), ...read() };

      // A requirement lowered by a deploy leaves stored rows above it; the bar must clamp rather
      // than overshoot its track.
      tracker.apply({ ...base, status: "completed", killCount: 5, requiredCount: 3 });
      const afterOvershoot = read().fill;

      tracker.apply({ ...base, questId: "second", title: "두 번째", status: "accepted" });
      const afterSecond = rows();

      tracker.destroy();
      const afterDestroy = { hidden: panel.hidden, rows: rows() };

      return {
        afterOffered,
        afterAccepted,
        afterProgress,
        afterCompleted,
        afterOvershoot,
        afterSecond,
        afterDestroy,
      };
    });

    expect(result.afterOffered, "an offer is the NPC panel's business, never the tracker's").toEqual({
      hidden: true,
      rows: 0,
    });
    expect(result.afterAccepted).toEqual({
      hidden: false,
      rows: 1,
      status: "accepted",
      count: "0 / 3",
      objective: "사냥터에서 다람쥐 3마리 처치",
      fill: "scaleX(0)",
      valuenow: "0",
    });
    expect(result.afterProgress, "an update patches the row rather than adding one").toEqual({
      rows: 1,
      status: "accepted",
      count: "2 / 3",
      objective: "사냥터에서 다람쥐 3마리 처치",
      // The browser's own serialisation of 2/3 — CSS rounds the transform to six decimals.
      fill: "scaleX(0.666667)",
      valuenow: "2",
    });
    expect(result.afterCompleted).toEqual({
      rows: 1,
      status: "completed",
      count: "3 / 3",
      objective: "벌써 세 마리를 잡았군요.",
      fill: "scaleX(1)",
      valuenow: "3",
    });
    expect(result.afterOvershoot, "killCount above the requirement must not overfill").toBe("scaleX(1)");
    expect(result.afterSecond, "a second quest is a second row").toBe(2);
    expect(result.afterDestroy, "shared DOM must not survive into the next room").toEqual({
      hidden: true,
      rows: 0,
    });
  });
});

test.describe("ObjectPanel 퀘스트 블록 — 수락 전송과 갱신 (white-box)", () => {
  test("수락은 서버 응답으로만 상태가 바뀌고, 모르는 questId는 무시되며, 다시 열면 버튼이 되살아난다", async () => {
    await client.page.goto("/?room=plaza");
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/objectPanel.ts");
      const sent: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const panel = new (mod as any).ObjectPanel(
        () => {},
        (questId: string) => sent.push(questId),
      );
      const quest = {
        questId: "first-hunt",
        title: "첫 사냥",
        summary: "북쪽 문을 지나면 사냥터입니다.",
        objectiveText: "사냥터에서 다람쥐 3마리 처치",
        completionText: "벌써 세 마리를 잡았군요.",
        status: "offered",
        killCount: 0,
        requiredCount: 3,
      };
      const npcPayload = {
        kind: "npc",
        objectId: "plaza-hunting-ground-npc",
        title: "안내",
        body: "북쪽 문으로 나가면 사냥터입니다.",
        blocksMovement: false,
        quests: [quest],
      };
      const accept = () => document.querySelector<HTMLButtonElement>(".object__quest-accept")!;
      const status = () => document.querySelector<HTMLElement>(".object__quest-status")!.textContent;
      const objective = () =>
        document.querySelector<HTMLElement>(".object__quest-objective")!.textContent;

      panel.open(npcPayload);
      const offered = { hidden: accept().hidden, status: status(), objective: objective() };

      accept().click();
      const inFlight = { sent: [...sent], disabled: accept().disabled, status: status() };

      // An update for a quest this panel is not showing must change nothing on it.
      panel.applyQuestUpdate({ ...quest, questId: "another", status: "accepted", killCount: 3 });
      const afterForeign = status();

      panel.applyQuestUpdate({ ...quest, status: "accepted" });
      const accepted = { hidden: accept().hidden, status: status() };

      panel.applyQuestUpdate({ ...quest, status: "accepted", killCount: 2 });
      const progressed = status();

      panel.applyQuestUpdate({ ...quest, status: "completed", killCount: 3 });
      const completed = { status: status(), objective: objective() };

      // Stepping off the tile and back on is the retry for an accept the server never answered.
      panel.close();
      panel.open(npcPayload);
      const reopened = { disabled: accept().disabled, hidden: accept().hidden, status: status() };

      // An NPC with nothing to offer renders exactly what it did before quests existed.
      panel.open({ ...npcPayload, quests: undefined });
      const plainNpc = document.querySelectorAll(".object__quest").length;

      return { offered, inFlight, afterForeign, accepted, progressed, completed, reopened, plainNpc };
    });

    expect(result.offered).toEqual({
      hidden: false,
      status: "아직 수락하지 않았습니다.",
      objective: "사냥터에서 다람쥐 3마리 처치",
    });
    expect(result.inFlight).toEqual({
      sent: ["first-hunt"],
      disabled: true,
      status: "수락하는 중…",
    });
    expect(result.afterForeign, "another quest's update must not touch this block").toBe("수락하는 중…");
    expect(result.accepted).toEqual({ hidden: true, status: "진행 중 · 0 / 3" });
    expect(result.progressed).toBe("진행 중 · 2 / 3");
    expect(result.completed).toEqual({ status: "완료", objective: "벌써 세 마리를 잡았군요." });
    expect(result.reopened, "a reopen must not inherit the previous block's disabled button").toEqual({
      disabled: false,
      hidden: false,
      status: "아직 수락하지 않았습니다.",
    });
    expect(result.plainNpc, "an NPC without quests draws no quest block").toBe(0);
  });
});
