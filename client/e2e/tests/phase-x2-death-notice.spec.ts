import { expect, test } from "@playwright/test";
import { holdKey } from "../helpers/input";
import { joinRoom, readVitalsText } from "../helpers/flows";

/**
 * Phase X-2 (docs/design-phase-x-lowcost-ux.md §2.3/§7): dying used to be legible only as a
 * full-health warp home, with no text saying the player was ever killed. This drives an actual
 * fight to `hpRemaining === 0` rather than injecting a fake `PlayerHit` — the real
 * `damagePlayer()` -> `leaveBossCombat()` -> `warpTo(home)` sequence (metaverseRoom.ts:1822-1861)
 * is exactly what the new death notice has to survive without racing.
 *
 * No colour-based assertion (design §7, [[zep_client_verification_harness]] precedent): every
 * check below reads text or the `현재 좌표` label, never a pixel.
 *
 * The walk itself reuses pass-f-qol.spec.ts's own proven route rather than inventing a new one:
 * that spec already established (its own comments record the 2026-09-02 measurements) that a
 * plain `holdKey(ArrowUp, 3200)` + `holdKey(ArrowLeft, 1200)` from this room's spawn reliably
 * crosses into the monster band along the x=35 axis (hg-rabbit-05 sits at (35,10)), and that
 * spawn/wander offsets occasionally push first contact a few polling ticks later — accepted there
 * without a retry. This test's own poll window is much longer (the fight runs to 0 HP, not just
 * "any reaction"), which absorbs that same slack.
 */

const PLAYER_MAX_HP = 100; // shared/src/constants.ts

test("사망 시 사망 문구가 뜨고, 체력바가 리필되고, 마을 스폰으로 스냅한다", async ({ page }) => {
  // Rabbit solo TTK is ~11.4s once aggroed (monsterDefinitions.ts's own comment; damage 7 every
  // 800ms against PLAYER_MAX_HP 100) and the walk crosses squirrel ground on the way too, so
  // whichever monster actually lands the aggro, death should land well inside this budget. The
  // generous ceiling (vs. the ~15s a quiet sandbox needs) is deliberate: this session runs
  // alongside several other agents' own Chromium instances, and a heavily contended run measured
  // here took 90s wall-clock for what is normally a ~15-20s scenario.
  test.setTimeout(180_000);

  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await joinRoom(page, "hunting-ground", { skinIndex: 0 });

  await holdKey(page, "ArrowUp", 3_200);
  await holdKey(page, "ArrowLeft", 1_200);

  const notice = page.locator("#death-notice");
  await expect(notice).toBeHidden({ timeout: 10_000 });

  // Stand still and take it from here — no attack, no retreat, so nothing but the monster's own
  // attack cadence moves HP.
  await expect
    .poll(() => readVitalsText(page), { timeout: 120_000, intervals: [500] })
    .toBe("0 / 100");

  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toHaveText("쓰러졌습니다 — 마을로 돌아갑니다");

  // playerVitals.ts's REVIVAL_HOLD_MS(700ms) refills the bar on its own timer.
  await expect
    .poll(() => readVitalsText(page), { timeout: 10_000 })
    .toBe(`${PLAYER_MAX_HP} / ${PLAYER_MAX_HP}`);

  // damagePlayer()'s warpTo(home): the spawn centre with the join spread dropped
  // (metaverseRoom.ts:264) — the one tile a dead player in this room can ever land on, regardless
  // of where the fight itself happened.
  await expect(page.getByLabel("현재 좌표")).toHaveText("35, 27", { timeout: 10_000 });

  // transitionOverlay.ts's own DEATH_NOTICE_MS(1600ms): transient, not left on screen.
  await expect(notice).toBeHidden({ timeout: 10_000 });

  expect(consoleErrors).toEqual([]);
});
