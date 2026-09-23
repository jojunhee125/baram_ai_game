import { expect, test } from "@playwright/test";

test("blocked quest explains prerequisite and unlocks on a live update", async ({ page }) => {
  await page.route("**/src/main.ts", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { ObjectPanel } = await import("/src/ui/objectPanel.ts");
    const sent: string[] = [];
    const panel = new ObjectPanel(() => {}, questId => sent.push(questId), () => {});
    const quest = {
      questId: "den-trial", title: "굴 수련", summary: "굴에 들어갑니다.",
      objectiveText: "굴에서 적 처치", completionText: "수련 완료",
      status: "offered" as const, killCount: 0, requiredCount: 3,
      prerequisiteQuestId: "first-hunt", blocked: true,
    };
    panel.open({ kind: "npc", objectId: "quest-npc", title: "안내", body: "수련",
      blocksMovement: false, quests: [quest] });
    const button = document.querySelector<HTMLButtonElement>(".object__quest-accept")!;
    const status = document.querySelector<HTMLElement>(".object__quest-status")!;
    const blocked = { disabled: button.disabled, message: status.textContent };
    button.click();
    panel.applyQuestUpdate({ ...quest, blocked: false });
    const unblocked = { disabled: button.disabled, message: status.textContent };
    button.click();
    const pending = { disabled: button.disabled, sent: [...sent] };
    panel.applyQuestUpdate({ ...quest, blocked: false, status: "accepted" });
    const accepted = { hidden: button.hidden, message: status.textContent };
    panel.destroy();
    return { blocked, unblocked, pending, accepted };
  });
  expect(result.blocked.disabled).toBe(true);
  expect(result.blocked.message).toContain("선행 퀘스트");
  expect(result.unblocked).toEqual({ disabled: false, message: "아직 수락하지 않았습니다." });
  expect(result.pending).toEqual({ disabled: true, sent: ["den-trial"] });
  expect(result.accepted).toEqual({ hidden: true, message: "진행 중 · 0 / 3" });
});
