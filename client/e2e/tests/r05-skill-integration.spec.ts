import { expect, test, type Page } from "@playwright/test";
import { unpack } from "@colyseus/msgpackr";
import { decode } from "@colyseus/schema";
import { Protocol } from "@colyseus/shared-types";
import {
  ClientMessage, COMBAT_EXIT_MS, ServerMessage,
  type PlayerHealed, type PlayerHit, type SkillUsed, type UseSkillRequest,
} from "@zep-test/shared";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { probeAnimationLoop, waitForCanvasReady } from "../helpers/canvas";
import { completeAvatarPicker } from "../helpers/flows";
import { holdKey } from "../helpers/input";

let browser: Awaited<ReturnType<typeof launchSharedBrowser>>;
let client: Client;
let sent: string[];
let received: string[];

test.beforeAll(async () => { browser = await launchSharedBrowser(); });
test.afterAll(async () => { await browser.close(); });
test.beforeEach(async () => {
  client = await openFreshClient(browser);
  sent = [];
  received = [];
  client.page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => sent.push(payload.toString()));
    socket.on("framereceived", ({ payload }) => received.push(payload.toString()));
  });
});
test.afterEach(async () => { await client.context.close(); });

async function enterClassPicker(page: Page, room = "plaza"): Promise<void> {
  await page.goto(`/?room=${room}`);
  await completeAvatarPicker(page);
  await waitForCanvasReady(page);
  await expect(page.locator("#class-picker")).toBeVisible();
}

async function chooseClass(page: Page, classKey: string): Promise<void> {
  await page.locator(`[data-class-key="${classKey}"]`).click();
  await page.locator("#class-picker-choose").click();
  await expect(page.locator("#class-picker-confirm")).toBeVisible();
  await page.locator("#class-picker-confirm-yes").click();
  await expect(page.locator("#class-picker")).toBeHidden();
  await expect(page.locator("#skills")).toBeVisible();
}

test("실제 입장 동기화와 직업 확정 후 숫자키 시전이 MP·쿨다운까지 연결된다", async () => {
  const page = client.page;
  await enterClassPicker(page);
  await expect(page.locator("#skills")).toBeHidden();
  await expect(page.locator("#class-picker-choose")).toBeDisabled();
  await page.locator('[data-class-key="warrior"]').click();
  await page.locator("#class-picker-choose").click();
  await expect(page.locator("#class-picker-confirm")).toBeVisible();
  expect(sent.filter((frame) => frame.includes("class:choose"))).toHaveLength(0);
  await page.locator("#class-picker-confirm-back").click();
  await chooseClass(page, "warrior");
  expect(sent.filter((frame) => frame.includes("class:choose"))).toHaveLength(1);
  await expect(page.locator(".skills__name")).toHaveText("방어 태세");
  await expect(page.locator("#vitals-mp-count")).toHaveText("30 / 30");

  await page.keyboard.press("Digit1");
  await expect(page.locator(".skills__slot")).toHaveAttribute("data-state", "cooling");
  await expect(page.locator("#vitals-mp-track")).toHaveAttribute("aria-valuenow", /^2[2-9]$/);
  expect(received.some((frame) => frame.includes("skill:used"))).toBe(true);
  expect(sent.filter((frame) => frame.includes("skill:use"))).toHaveLength(1);

  await page.keyboard.press("Digit1");
  await expect(page.locator("#skills-denial")).toHaveText("아직 준비되지 않았습니다");
  await page.keyboard.press("Digit2");
  await page.keyboard.press("Digit3");
  await page.keyboard.press("Digit4");
  expect(await probeAnimationLoop(page, 300)).toBeGreaterThan(0);
  expect(sent.filter((frame) => frame.includes("skill:use"))).toHaveLength(1);
});

test("몬스터 없는 광장에서 서버의 스킬 거절이 표시되고 MP는 유지된다", async () => {
  const page = client.page;
  await enterClassPicker(page);
  await chooseClass(page, "shaman");
  await expect(page.locator(".skills__name")).toHaveText("화염구");
  await expect(page.locator("#vitals-mp-count")).toHaveText("100 / 100");
  await page.keyboard.press("Digit1");
  await expect(page.locator("#skills-denial")).toBeVisible();
  await expect(page.locator("#skills-denial")).toHaveText("대상이 없습니다");
  expect(sent.filter((frame) => frame.includes("skill:use"))).toHaveLength(1);
  expect(received.some((frame) => frame.includes("skill:denied"))).toBe(true);
  expect(received.some((frame) => frame.includes("skill:used"))).toBe(false);
  await expect(page.locator("#vitals-mp-count")).toHaveText("100 / 100");
});

test("실제로 피해를 입은 도사의 Digit1 치유가 서버 회복량과 HP·MP·쿨다운 UI에 반영된다", async () => {
  const page = client.page;
  type Observed<T> = { at: number; data: T };
  const hits: Observed<PlayerHit>[] = [];
  const heals: Observed<PlayerHealed>[] = [];
  const uses: Observed<SkillUsed>[] = [];
  const requests: Observed<UseSkillRequest>[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Passive wire decoding follows the installed SDK's ROOM_DATA decoder; no room/state hooks.
  const readMessage = (payload: string | Buffer) => {
    if (!Buffer.isBuffer(payload) || payload[0] !== Protocol.ROOM_DATA) return;
    const iterator = { offset: 1 };
    const type = decode.stringCheck(payload, iterator)
      ? decode.string(payload, iterator) : decode.number(payload, iterator);
    const data: unknown = payload.length > iterator.offset
      ? unpack(payload, { start: iterator.offset }) : undefined;
    return { type, data, at: performance.now() };
  };
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      const event = readMessage(payload);
      if (event?.type === ServerMessage.PlayerHit) hits.push({ at: event.at, data: event.data as PlayerHit });
      if (event?.type === ServerMessage.PlayerHealed) heals.push({ at: event.at, data: event.data as PlayerHealed });
      if (event?.type === ServerMessage.SkillUsed) uses.push({ at: event.at, data: event.data as SkillUsed });
    });
    socket.on("framesent", ({ payload }) => {
      const event = readMessage(payload);
      if (event?.type === ClientMessage.UseSkill) requests.push({ at: event.at, data: event.data as UseSkillRequest });
    });
  });

  await enterClassPicker(page, "hunting-ground");
  await chooseClass(page, "cleric");
  await expect(page.locator(".skills__name")).toHaveText("치유");
  await expect(page.locator("#vitals-count")).toHaveText("100 / 100");
  await expect(page.locator("#vitals-mp-count")).toHaveText("80 / 80");

  // hg-squirrel-04's spawn (41,24): its entire wander radius fits its aggro radius (2).
  // Like npc-movement-block-fix, verify real movement with the coordinate UI. Short pulses
  // and a settled re-read also correct an extra step queued before a keyup reaches the game.
  const coordinates = page.getByLabel("현재 좌표");
  for (const [axis, target] of [[1, 24], [0, 41]] as const) {
    for (let step = 0; step < 20; step += 1) {
      const current = Number((await coordinates.innerText()).split(",")[axis]);
      if (current === target) break;
      const key = axis === 1
        ? current > target ? "ArrowUp" : "ArrowDown"
        : current > target ? "ArrowLeft" : "ArrowRight";
      await holdKey(page, key, 80);
      await page.waitForTimeout(180);
    }
    expect(Number((await coordinates.innerText()).split(",")[axis])).toBe(target);
  }
  await expect(coordinates).toHaveText("41, 24");
  await expect.poll(() => {
    const hit = hits.at(-1);
    return hit !== undefined && hit.data.damage > 0 && hit.data.hpRemaining > 30
      && hit.data.hpRemaining <= 70 && performance.now() - hit.at < 500;
  }, { timeout: 20_000, intervals: [50], message: "real monster damage must leave 31–70 HP" }).toBe(true);
  const damaged = hits.at(-1)!;
  expect(damaged.data.monsterId).not.toBe("");
  await expect(page.locator("#vitals-count")).toHaveText(`${damaged.data.hpRemaining} / 100`);
  expect(heals).toHaveLength(0);
  expect(requests).toHaveLength(0);

  // Observe rendered DOM only. A later monster hit must not erase the heal/MP evidence
  // before Playwright receives the wire frames and gets its next turn to read the page.
  const vitalsObservation = await page.evaluateHandle(() => {
    const hpCount = document.querySelector("#vitals-count")!;
    const hpTrack = document.querySelector("#vitals-track")!;
    const mpCount = document.querySelector("#vitals-mp-count")!;
    const mpTrack = document.querySelector("#vitals-mp-track")!;
    const read = () => ({
      hp: hpCount.textContent, hpValue: hpTrack.getAttribute("aria-valuenow"),
      mp: mpCount.textContent, mpValue: mpTrack.getAttribute("aria-valuenow"),
    });
    const samples = [read()];
    const observer = new MutationObserver(() => samples.push(read()));
    observer.observe(hpTrack, { attributes: true, attributeFilter: ["aria-valuenow"] });
    observer.observe(mpTrack, { attributes: true, attributeFilter: ["aria-valuenow"] });
    return { samples, observer };
  });

  await page.keyboard.press("Digit1");
  await expect.poll(() => heals.length, { timeout: 1_500, intervals: [25] }).toBe(1);
  await expect.poll(() => uses.length, { timeout: 1_500, intervals: [25] }).toBe(1);
  expect(requests).toHaveLength(1);
  const healed = heals[0]!;
  const used = uses[0]!;
  const request = requests[0]!;
  const lastHit = hits.filter((hit) => hit.at <= healed.at).at(-1)!;
  expect(lastHit.data.damage).toBeGreaterThan(0);
  expect(lastHit.data.hpRemaining).toBeGreaterThan(0);
  expect(lastHit.at).toBeLessThan(request.at);
  expect(request.at).toBeLessThanOrEqual(healed.at);
  // Both server delta and the elapsed combat window exclude natural recovery/full-HP noops.
  expect(healed.at - lastHit.at).toBeLessThan(COMBAT_EXIT_MS);
  expect(healed.data.healAmount).toBe(30);
  expect(healed.data.hpRemaining).toBe(lastHit.data.hpRemaining + healed.data.healAmount);
  expect(healed.data.hpMax).toBe(100);
  expect(healed.data.hpRemaining).toBeLessThanOrEqual(healed.data.hpMax);
  expect(request.data).toMatchObject({ skillKey: "heal", targetSessionId: used.data.casterSessionId });
  expect(request.data.nonce).not.toBe("");
  expect(used.data).toMatchObject({
    skillKey: "heal", targetSessionId: healed.data.targetSessionId, mpRemaining: 60, mpMax: 80,
  });
  expect(healed.data.targetSessionId).toBe(used.data.casterSessionId);
  expect(used.data.cooldownUntil).toBeGreaterThan(Date.now());
  await expect.poll(() => vitalsObservation.evaluate(({ samples }, hp) =>
    samples.some((sample) => sample.hp === `${hp} / 100` && sample.hpValue === String(hp)),
  healed.data.hpRemaining), { timeout: 1_500 }).toBe(true);
  await expect.poll(() => vitalsObservation.evaluate(({ samples }, mp) =>
    samples.some((sample) => sample.mp === `${mp} / 80` && sample.mpValue === String(mp)),
  used.data.mpRemaining), { timeout: 1_500 }).toBe(true);
  await expect(page.locator(".skills__slot")).toHaveAttribute("data-state", "cooling");

  await page.keyboard.press("Digit1");
  await expect(page.locator("#skills-denial")).toHaveText("아직 준비되지 않았습니다");
  expect(await probeAnimationLoop(page, 300)).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
  expect(heals).toHaveLength(1);
  expect(uses).toHaveLength(1);
  expect(hits.some((hit) => hit.data.hpRemaining === 0)).toBe(false);
  expect(errors).toEqual([]);
  const uiSamples = await vitalsObservation.evaluate(({ samples, observer }) => {
    observer.disconnect();
    return samples;
  });
  await vitalsObservation.dispose();
  console.log("cleric heal evidence", JSON.stringify({ lastHit, request, healed, used, uiSamples }));
});
