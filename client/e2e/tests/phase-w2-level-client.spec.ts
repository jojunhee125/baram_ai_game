import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { holdKey, tapKey } from "../helpers/input";
import { joinRoom } from "../helpers/flows";

/**
 * Phase W-2b (docs/design-phase-w2-level-client.md §2): level/EXP made visible in the client.
 * Server-side hydration and the curve itself (Phase W-1/W-2a) are out of scope here and already
 * covered by server/src/rooms/levelSystem*.test.ts and progressCache.test.ts.
 *
 * 리터럴 상수/공식 복사 — `@zep-test/shared`를 이 파일(Node 쪽)에서 import하지 않는 이유는
 * `docs/design-client-test-harness.md` §2 "상수 중복 — 의도적"(pass-f-qol.spec.ts의 관례) 그대로다.
 * 브라우저 쪽(`page.evaluate`의 동적 `import("/src/...")`)은 실제 모듈을 그대로 문다.
 */
function expToNextLevel(level: number): number {
  return Math.round(20 * level ** 1.7); // shared/src/leveling.ts
}
function cumulativeExpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l += 1) total += expToNextLevel(l);
  return total; // shared/src/leveling.ts
}

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

test.describe("Phase W-2b 실사용자 흐름", () => {
  test("레벨 배지·EXP 바·캐릭터 메뉴 스탯 행이 몬스터 없는 room에서도 즉시 Lv.1을 보여준다", async () => {
    await joinRoom(client.page, "plaza");
    await waitForCanvasReady(client.page);

    // §1.3 설계(캐시 히든이지만 그랜드플라자/plaza 모두 join 시 hydrate)의 클라이언트 쪽 절반:
    // 신규 계정이라 실제 값도 1이지만, 여기서 확인하는 것은 "이 값이 서버 값을 그대로 반영한다"는
    // 배선이지 특정 레벨 숫자가 아니다.
    await expect(client.page.locator("#vitals-level")).toHaveText("Lv.1");
    await expect(client.page.locator("#vitals-exp-track")).toHaveAttribute("aria-valuenow", "0");
    await expect(client.page.locator("#vitals")).toBeVisible();

    await tapKey(client.page, "KeyC");
    await expect(client.page.locator("#character-menu")).toBeVisible();
    await expect(client.page.locator("#character-menu-level")).toHaveText("1");
    await expect(client.page.locator("#character-menu-atk-bonus")).toHaveText("0");
    await expect(client.page.locator("#character-menu-hp-bonus")).toHaveText("0");
  });

  test("실제 처치로 EXP 바가 갱신되고, plaza로 이동해도 레벨 배지는 유지되며 EXP 바는 새 room에서 0%로 재시작한다(잔존 없음)", async () => {
    // Combat e2e 항상 넉넉한 예산 — phase-x2-death-notice.spec.ts와 같은 이유(공유 세션 경합 시
    // 실측 90s 왕복) + 아래 walk 자체의 접촉 지연(다음 주석). 폴 타임아웃(150s)보다 여유 있게.
    test.setTimeout(200_000);
    const consoleErrors: string[] = [];
    client.page.on("pageerror", (error) => consoleErrors.push(String(error)));

    await joinRoom(client.page, "hunting-ground", { skinIndex: 0 });

    // phase-x2-death-notice.spec.ts가 이미 증명한 그 walk(스폰 → 어그로 범위), pass-f-qol.spec.ts의
    // "스폰 근처는 무반응, 몬스터 밀집 지역으로 걸어 들어가면 HP가 줄어든다"가 실측 기록한 바로 그
    // 접촉 지연과 같은 성격을 그대로 물려받는다: 스폰/방랑 오프셋이 겹치면 접촉 자체가 몇 초~몇십 초
    // 늦어질 수 있고(그 스펙 자신의 주석: "드물게 8초 안에도 안 맞는 경우가 있었다"), 그 스펙은
    // 그 경우를 재시도 없이 1회 실패로 받아들이는 것이 이 코드베이스의 방침이다 — 여기서도 같은
    // 방침을 따르되, 접촉 이후 실제로 몇 대 더 때려 죽여야 하는 만큼 폴 예산을 그보다 넉넉히 잡는다.
    //
    // 여기서는 그 자리에서 가만히 서서 "몬스터가 나를 때린다"를 확인하는 대신 Space를 누른 채
    // "내가 몬스터를 때린다"를 확인한다 — 사거리 밖에서의 스윙은 서버가 조용히 버리므로(design §6.1)
    // 몬스터가 다가오기까지 홀드해도 비용은 시간뿐이다. 다람쥐/토끼 중 어느 쪽이 어그로를 물든 각자의
    // 보상(1 / 2, 2026-09-17 하향)이 레벨1의 20 EXP 문턱보다 작아, 이 한 번의 처치만으로는 의도치
    // 않은 레벨업이 생길 수 없다. 아래 폴이 보는 aria-valuenow는 Math.round(ratio*100)이므로
    // 다람쥐 한 마리도 1/20 = "5"로 올라간다 — 하향 후에도 "0"이 아님은 유지된다.
    await holdKey(client.page, "ArrowUp", 3_200);
    await holdKey(client.page, "ArrowLeft", 1_200);

    const expTrack = client.page.locator("#vitals-exp-track");
    await client.page.keyboard.down("Space");
    try {
      await expect
        .poll(() => expTrack.getAttribute("aria-valuenow"), { timeout: 150_000, intervals: [500] })
        .not.toBe("0");
    } finally {
      await client.page.keyboard.up("Space");
    }

    await expect(client.page.locator("#vitals-level")).toHaveText("Lv.1");

    // 랜드마크 패널(T)의 "마을 광장" 행 = 다른 room으로의 실제 hop, 씬 재시작 경로 —
    // pass-i-boss-hp-bar.spec.ts가 보스 HP바의 방-이동 정리를 검증한 것과 같은 패턴을 EXP
    // 바/레벨 배지에 적용한다.
    await tapKey(client.page, "KeyT");
    await client.page.getByRole("button", { name: "마을 광장", exact: true }).click();
    await client.page.waitForTimeout(1_500); // fade-out + reconnect + fade-in (hop())

    // 레벨은 Player.level 스키마 그대로라 room이 바뀌어도 유지된다. EXP 바는 세션 전용
    // ExpGranted가 데이터 소스라 이 room에서는 아직 한 번도 안 왔으므로 0%로 재시작하는 것이
    // 옳다(design §2.1) — 이전 room의 채워진 값이 새 PlayerVitals 인스턴스에 유령으로 남아
    // 있지 않았음을 함께 확인한다.
    await expect(client.page.locator("#vitals-level")).toHaveText("Lv.1");
    await expect(expTrack).toHaveAttribute("aria-valuenow", "0");

    expect(consoleErrors).toEqual([]);
  });
});

test.describe("playerVitals.ts 화이트박스 (design-phase-w2-level-client.md §2.1/§2.4/§2.5)", () => {
  // 실제 index.html 마크업(#vitals-* 등)이 있어야 PlayerVitals 생성자의 querySelector(...)! 가
  // 성공한다 — bossVitals.ts 화이트박스(pass-i-boss-hp-bar.spec.ts)와 같은 이유로 room 접속 없이
  // 문서만 로드한다.
  test.beforeEach(async () => {
    await client.page.goto("/?room=plaza");
  });

  test("EXP 바 계산은 상한 포함 정확하고, 레벨 배지와는 서로 다른 데이터 소스로 남는다", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/playerVitals.ts");
      const vitals = new mod.PlayerVitals();
      const fill = document.querySelector<HTMLElement>("#vitals-exp-fill")!;
      const track = document.querySelector<HTMLElement>("#vitals-exp-track")!;
      const badge = document.querySelector<HTMLElement>("#vitals-level")!;
      const parseRatio = (): number => {
        const match = /scaleX\(([-\d.]+)\)/.exec(fill.style.transform);
        return match ? Number(match[1]) : NaN;
      };

      const atBoot = { ratio: parseRatio(), now: track.getAttribute("aria-valuenow") };

      // setLevel()이 EXP 쪽을 건드리지 않는지 먼저 확인.
      vitals.setLevel(5);
      const afterSetLevel = { ratio: parseRatio(), now: track.getAttribute("aria-valuenow"), badge: badge.textContent };

      // applyExpGranted()가 레벨 배지를 건드리지 않는지 확인 — event.level(1)은 badge의 5와 다르게
      // 일부러 둔다: 두 값이 항상 같이 움직이는 시스템이면 이 비대칭을 못 잡는다(design §2.1의
      // "데이터 소스가 둘로 나뉜다" 의도를 그 자체로 검증).
      vitals.applyExpGranted({
        monsterId: "m", amount: 4, totalExp: 4, level: 1, expToNextLevel: 6, hpMax: 100, hpRemaining: 100,
      });
      const afterFirstGrant = { ratio: parseRatio(), now: track.getAttribute("aria-valuenow"), badge: badge.textContent };

      vitals.applyExpGranted({
        monsterId: "m", amount: 4, totalExp: 8, level: 1, expToNextLevel: 2, hpMax: 100, hpRemaining: 100,
      });
      const afterSecondGrant = { ratio: parseRatio(), now: track.getAttribute("aria-valuenow") };

      // 상한 도달(expToNextLevel === null) — 항상 가득.
      vitals.applyExpGranted({
        monsterId: "m", amount: 5000, totalExp: 999_999, level: 30, expToNextLevel: null, hpMax: 390, hpRemaining: 390,
      });
      const afterCap = { ratio: parseRatio(), now: track.getAttribute("aria-valuenow") };

      vitals.destroy();
      return { atBoot, afterSetLevel, afterFirstGrant, afterSecondGrant, afterCap };
    });

    expect(result.atBoot).toEqual({ ratio: 0, now: "0" });
    expect(result.afterSetLevel).toEqual({ ratio: 0, now: "0", badge: "Lv.5" });

    const floor1 = cumulativeExpForLevel(1);
    const span1 = cumulativeExpForLevel(2) - floor1;
    expect(result.afterFirstGrant.ratio).toBeCloseTo((4 - floor1) / span1);
    expect(result.afterFirstGrant.now).toBe(String(Math.round(((4 - floor1) / span1) * 100)));
    expect(result.afterFirstGrant.badge, "applyExpGranted must never touch the level badge").toBe("Lv.5");

    expect(result.afterSecondGrant.ratio).toBeCloseTo((8 - floor1) / span1);

    expect(result.afterCap).toEqual({ ratio: 1, now: "100" });
  });

  test("ExpGranted는 PlayerHit과 같은 방식으로 HP 상한/현재값을 갱신한다(레벨업 즉시 풀회복 포함)", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/playerVitals.ts");
      const vitals = new mod.PlayerVitals();
      const count = document.querySelector<HTMLElement>("#vitals-count")!;

      // 레벨업 없이 그냥 한 킬 — hpMax/hpRemaining을 그대로 echo(design §6 ExpGranted 주석).
      vitals.applyExpGranted({
        monsterId: "m", amount: 4, totalExp: 4, level: 1, expToNextLevel: 6, hpMax: 100, hpRemaining: 63,
      });
      const midFight = count.textContent;

      // 레벨업 — totalMaxHp가 늘고 즉시 풀회복(design §6).
      vitals.applyExpGranted({
        monsterId: "m", amount: 6, totalExp: 10, level: 2, expToNextLevel: 32, hpMax: 110, hpRemaining: 110,
      });
      const afterLevelUp = count.textContent;

      vitals.destroy();
      return { midFight, afterLevelUp };
    });

    expect(result.midFight).toBe("63 / 100");
    expect(result.afterLevelUp).toBe("110 / 110");
  });

  test("전투 회복은 세션의 hpMax 비율로 계산된다(레벨1 3/tick 앵커 유지, 레벨업 후에는 그 비율을 따라간다)", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/playerVitals.ts");
      const vitals = new mod.PlayerVitals() as unknown as {
        nextRecoveryAt: number;
        update: () => void;
        applyHit: (e: unknown) => void;
        destroy: () => void;
      };
      const count = document.querySelector<HTMLElement>("#vitals-count")!;

      // 레벨1 앵커: hpMax=100이면 round(100*0.03)=3 — 오늘의 COMBAT_RECOVERY_HP_PER_TICK과 동일.
      vitals.applyHit({ monsterId: "m", damage: 0, hpRemaining: 90, hpMax: 100 });
      vitals.nextRecoveryAt = performance.now() - 1; // 다음 update() 호출이 즉시 1틱을 회복하도록.
      vitals.update();
      const level1Tick = count.textContent;

      // hpMax=200이면 round(200*0.03)=6 — 옛 고정값(3)이었다면 여기서 93이 나왔을 것.
      vitals.applyHit({ monsterId: "m", damage: 0, hpRemaining: 150, hpMax: 200 });
      vitals.nextRecoveryAt = performance.now() - 1;
      vitals.update();
      const leveledTick = count.textContent;

      vitals.destroy();
      return { level1Tick, leveledTick };
    });

    expect(result.level1Tick).toBe("93 / 100");
    expect(result.leveledTick).toBe("156 / 200");
  });

  test("레벨업 배너가 뜨고 배지가 펄스하며, 타이머로 스스로 닫히고 destroy()가 즉시 정리한다", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/playerVitals.ts");
      const vitals = new mod.PlayerVitals();
      const badge = document.querySelector<HTMLElement>("#vitals-level")!;
      const banner = document.querySelector<HTMLElement>("#vitals-levelup")!;
      const read = () => ({ hidden: banner.hidden, text: banner.textContent, pulsing: badge.dataset["levelup"] ?? null });

      const before = read();
      vitals.announceLevelUp(7);
      const after = read();
      await new Promise((resolve) => setTimeout(resolve, 2_600)); // LEVEL_UP_BANNER_MS(2400) + slack
      const afterTimeout = read();
      vitals.announceLevelUp(8);
      const afterSecond = read();
      vitals.destroy();
      const afterDestroy = read();

      return { before, after, afterTimeout, afterSecond, afterDestroy };
    });

    expect(result.before).toEqual({ hidden: true, text: "", pulsing: null });
    expect(result.after).toEqual({ hidden: false, text: "Lv.7 달성!", pulsing: "true" });
    expect(result.afterTimeout).toEqual({ hidden: true, text: "Lv.7 달성!", pulsing: null });
    expect(result.afterSecond).toMatchObject({ hidden: false, text: "Lv.8 달성!" });
    expect(result.afterDestroy).toEqual({ hidden: true, text: "Lv.8 달성!", pulsing: null });
  });
});

test.describe("localPlayer.ts 화이트박스 — 이름표 호출부 ③ (design §2.2)", () => {
  test("레벨이 실제로 바뀔 때만 자신의 이름표를 'Lv.N 닉네임'으로 다시 그린다", async () => {
    await client.page.goto("/?room=plaza");
    const result = await client.page.evaluate(async () => {
      const { LocalPlayer } = await import("/src/world/localPlayer.ts");

      const addCalls: Array<{ id: string; label: string }> = [];
      const fakeSprite = {};
      const fakeNameTags = {
        add: (id: string, _sprite: unknown, label: string) => addCalls.push({ id, label }),
      };
      const fakeSprites = {
        update: () => {},
        get: () => fakeSprite,
      };
      const spawn = { nickname: "테스터", tileX: 5, tileY: 5, facing: 0, avatarSkin: 0, level: 1 };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const player = new (LocalPlayer as any)(
        "self",
        spawn,
        fakeSprites,
        fakeNameTags,
        () => {},
        () => true,
      );

      player.applyServerState({ ...spawn, level: 1 }); // unchanged — must not redraw
      const afterNoChange = addCalls.length;

      player.applyServerState({ ...spawn, level: 2 }); // level-up — must redraw with the new format
      const afterLevelUp = [...addCalls];

      player.applyServerState({ ...spawn, level: 2 }); // same level again — must not redraw a second time
      const afterRepeat = addCalls.length;

      return { afterNoChange, afterLevelUp, afterRepeat };
    });

    expect(result.afterNoChange).toBe(0);
    expect(result.afterLevelUp).toEqual([{ id: "self", label: "Lv.2 테스터" }]);
    expect(result.afterRepeat).toBe(1);
  });
});
