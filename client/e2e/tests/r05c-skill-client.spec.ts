import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";

/**
 * R05-c (docs/r05-classes-and-skills.md §8): the MP gauge, the skill slots and the hotkey that
 * spends them. The server half (execution contract, cooldowns, target selection, denial reasons)
 * is R05-b's and is covered by server/src/rooms/*.test.ts — nothing here re-tests it.
 *
 * White-box against the real `index.html` markup with no room connection, the precedent
 * `phase-w2-level-client.spec.ts` and `pass-i-boss-hp-bar.spec.ts` set: both `PlayerVitals` and
 * `SkillBar` resolve their nodes with `querySelector(...)!` in the constructor, so the document
 * has to be the real one — but neither needs a server to exercise.
 *
 * 리터럴 상수 복사는 `phase-w2-level-client.spec.ts`와 같은 이유다(`docs/design-client-test-
 * harness.md` §2). 브라우저 쪽은 실제 모듈을 그대로 문다.
 */
const MONSTER_TICK_MS = 200; // shared/src/constants.ts
const MP_RECOVERY_FRACTION_PER_TICK = 0.02; // shared/src/constants.ts
const MP_COMBAT_RECOVERY_FRACTION_PER_TICK = 0.005; // shared/src/constants.ts
/** 주술사 `maxMpBase` — shared/src/classes.ts. 100이라 두 회복률이 2 / 1 로 갈라져 구분된다. */
const SHAMAN_MP_BASE = 100;
/** 화염구 `mpCost` / `cooldownMs` — shared/src/skills.ts. */
const FIREBALL_MP_COST = 18;
const FIREBALL_COOLDOWN_MS = 1_500;

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
  await client.page.goto("/?room=plaza");
});

test.afterEach(async () => {
  await client.close();
});

test.describe("playerVitals.ts MP 화이트박스 (R05-c)", () => {
  test("직업 없는 계정에는 마력 게이지가 없고, 직업이 생기면 몬스터 없는 방에서도 나타난다", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/playerVitals.ts");
      const vitals = new mod.PlayerVitals();
      const panel = document.querySelector<HTMLElement>("#vitals")!;
      const head = document.querySelector<HTMLElement>("#vitals-mp-head")!;
      const track = document.querySelector<HTMLElement>("#vitals-mp-track")!;
      const count = document.querySelector<HTMLElement>("#vitals-mp-count")!;

      // 직업 미선택 계정의 서버 값 그대로 — `totalMaxMp`는 0을 돌려준다.
      vitals.setMp(0, 0);
      const classless = { panelHidden: panel.hidden, headHidden: head.hidden, trackHidden: track.hidden };

      vitals.setMp(40, 100);
      const withClass = {
        panelHidden: panel.hidden,
        headHidden: head.hidden,
        trackHidden: track.hidden,
        count: count.textContent,
        now: track.getAttribute("aria-valuenow"),
        max: track.getAttribute("aria-valuemax"),
      };

      vitals.destroy();
      return { classless, withClass };
    });

    // 몬스터를 한 번도 보지 않은 방이므로 reveal()은 아직 불리지 않았다 — 직업이 없으면 패널째 숨김.
    expect(result.classless).toEqual({ panelHidden: true, headHidden: true, trackHidden: true });
    // 직업이 생기면 패널이 열린다: 마력은 광장에서도 차고 쓰이므로 "첫 몬스터"를 기다리지 않는다.
    expect(result.withClass).toEqual({
      panelHidden: false,
      headHidden: false,
      trackHidden: false,
      count: "40 / 100",
      now: "40",
      max: "100",
    });
  });

  test("마력은 전투 중에도 회복하되 더 느리고, 직업 동기화(피해 0)는 전투로 세지 않는다", async () => {
    const result = await client.page.evaluate(async (tickMs: number) => {
      const mod = await import("/src/ui/playerVitals.ts");
      const vitals = new mod.PlayerVitals();
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      // 두 tick 분량을 한 번에 소화시킨다 — update()가 프레임 수가 아니라 경과 시간으로 세기 때문에
      // 실제 렌더 루프 없이도 정확히 같은 계산을 탄다.
      const advance = async (): Promise<number> => {
        await wait(tickMs * 2 + tickMs / 2);
        vitals.update();
        return vitals.currentMp;
      };

      // (1) 평시 회복.
      vitals.setMp(0, 100);
      const idleGain = await advance();

      // (2) 직업 동기화가 보내는 피해 0짜리 PlayerHit — WorldScene.applyClassChanged의 그 경로다.
      //     이것을 피격으로 세면 입장 직후 2초 동안 마력이 느리게 찬다.
      vitals.setMp(0, 100);
      vitals.applyHit({ monsterId: "", damage: 0, hpRemaining: 100, hpMax: 100 });
      const afterClassSyncGain = await advance();

      // (3) 진짜 피격.
      vitals.setMp(0, 100);
      vitals.applyHit({ monsterId: "m", damage: 7, hpRemaining: 93, hpMax: 100 });
      const inCombatGain = await advance();

      vitals.destroy();
      return { idleGain, afterClassSyncGain, inCombatGain };
    }, MONSTER_TICK_MS);

    const idlePerTick = Math.max(1, Math.round(SHAMAN_MP_BASE * MP_RECOVERY_FRACTION_PER_TICK));
    const combatPerTick = Math.max(1, Math.round(SHAMAN_MP_BASE * MP_COMBAT_RECOVERY_FRACTION_PER_TICK));

    expect(result.idleGain).toBe(idlePerTick * 2);
    expect(
      result.afterClassSyncGain,
      "a zero-damage PlayerHit is a class sync, not a hit — MP must not slow down",
    ).toBe(idlePerTick * 2);
    expect(result.inCombatGain).toBe(combatPerTick * 2);
    // 두 비율이 실제로 다르다는 것 자체가 이 테스트의 요점 — 같으면 위 세 단정이 전부 참이어도 무의미하다.
    expect(result.inCombatGain).toBeLessThan(result.idleGain);
  });

  test("사망 후 부활은 체력과 함께 마력도 가득 채운다", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/playerVitals.ts");
      const vitals = new mod.PlayerVitals();
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      vitals.setMp(12, 100);
      vitals.applyHit({ monsterId: "m", damage: 100, hpRemaining: 0, hpMax: 100 });
      const atDeath = vitals.currentMp;

      // REVIVAL_HOLD_MS(700ms)보다 넉넉히 기다린다.
      await wait(1_100);
      const afterRevival = {
        mp: vitals.currentMp,
        count: document.querySelector<HTMLElement>("#vitals-mp-count")!.textContent,
      };

      vitals.destroy();
      return { atDeath, afterRevival };
    });

    expect(result.atDeath).toBe(12);
    expect(result.afterRevival).toEqual({ mp: 100, count: "100 / 100" });
  });
});

test.describe("skillBar.ts 화이트박스 (R05-c)", () => {
  test("슬롯은 직업의 skillKeys에서 만들어지고, 마력이 모자라면 서버에 보내기 전에 거절된다", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/skillBar.ts");
      const sent: string[] = [];
      const bar = new mod.SkillBar((skillKey: string) => {
        sent.push(skillKey);
        return true;
      });
      const list = document.querySelector<HTMLElement>("#skills")!;
      const denial = document.querySelector<HTMLElement>("#skills-denial")!;

      const classless = { hidden: list.hidden, slots: list.children.length };

      bar.applyClass("shaman");
      const slot = list.querySelector<HTMLElement>(".skills__slot")!;
      const chosen = {
        hidden: list.hidden,
        slots: list.children.length,
        key: slot.querySelector<HTMLElement>(".skills__key")!.textContent,
        name: slot.querySelector<HTMLElement>(".skills__name")!.textContent,
        cost: slot.querySelector<HTMLElement>(".skills__cost")!.textContent,
      };

      // 마력 0 — 로컬에서 거절되고 서버로 나가지 않는다.
      bar.applyMp(0);
      const brokeCast = bar.castSlot(0);
      const brokeState = { state: slot.dataset.state, denialHidden: denial.hidden, denial: denial.textContent };

      // 충분한 마력 — 실제로 나간다.
      bar.applyMp(100);
      const richCast = bar.castSlot(0);

      // 존재하지 않는 슬롯은 조용히 거절한다(키는 4개까지 듣지만 스킬은 1개다).
      const emptySlotCast = bar.castSlot(3);

      bar.destroy();
      return { classless, chosen, brokeCast, brokeState, richCast, emptySlotCast, sent };
    });

    expect(result.classless).toEqual({ hidden: true, slots: 0 });
    expect(result.chosen).toEqual({
      hidden: false,
      slots: 1,
      key: "1",
      name: "화염구",
      cost: `${FIREBALL_MP_COST} MP`,
    });

    expect(result.brokeCast).toBe(false);
    expect(result.brokeState.state, "an unaffordable slot has to read as unavailable").toBe("unaffordable");
    expect(result.brokeState.denialHidden).toBe(false);
    expect(result.brokeState.denial).toBe("마력이 부족합니다");

    expect(result.richCast).toBe(true);
    expect(result.emptySlotCast).toBe(false);
    // 딱 한 번 — 마력이 모자랐던 시도와 빈 슬롯은 서버까지 가지 않는다.
    expect(result.sent).toEqual(["fireball"]);
  });

  test("쿨다운은 서버 시각이 아니라 정의된 길이로 돌고, 도는 동안 두 번째 시전을 막는다", async () => {
    const result = await client.page.evaluate(async (cooldownMs: number) => {
      const mod = await import("/src/ui/skillBar.ts");
      const sent: string[] = [];
      const bar = new mod.SkillBar((skillKey: string) => {
        sent.push(skillKey);
        return true;
      });
      bar.applyClass("shaman");
      bar.applyMp(100);
      const slot = document.querySelector<HTMLElement>(".skills__slot")!;
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      bar.castSlot(0);
      // 인자가 skillKey 하나뿐인 것 자체가 계약이다 — 구현이 SkillUsed.cooldownUntil(서버의
      // Date.now())을 읽는 쪽으로 바뀌면 이 호출은 컴파일되지 않는다. 클라이언트 시계가 서버보다
      // 앞서거나 뒤진 만큼 쿨다운이 통째로 어긋나는 것을 막는 유일한 방어선이다.
      bar.beginCooldown("fireball");
      const cooling = { state: slot.dataset.state, secondCast: bar.castSlot(0) };

      // 절반 지점 — 여기서 이미 풀려 있으면 길이가 정의값이 아니다. 즉시 풀리는 구현(쿨다운을 0으로
      // 계산하거나 서버 시각을 잘못 빼는 경우)은 바로 위 동기 검사는 통과하고 이 검사에서 걸린다.
      await wait(cooldownMs / 2);
      const midway = { state: slot.dataset.state, castAtMidpoint: bar.castSlot(0) };

      await wait(cooldownMs / 2 + 300);
      const ready = { state: slot.dataset.state, thirdCast: bar.castSlot(0) };

      bar.destroy();
      return { cooling, midway, ready, sent };
    }, FIREBALL_COOLDOWN_MS);

    expect(result.cooling.state).toBe("cooling");
    expect(result.cooling.secondCast, "a cooling slot must not reach the server").toBe(false);
    expect(result.midway.state, "the cooldown must still be running halfway through it").toBe("cooling");
    expect(result.midway.castAtMidpoint).toBe(false);
    expect(result.ready.state).toBeUndefined();
    expect(result.ready.thirdCast).toBe(true);
    expect(result.sent).toEqual(["fireball", "fireball"]);
  });

  test("서버 거절 사유는 각각 읽을 수 있는 한국어 한 줄로 바뀐다", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/skillBar.ts");
      const bar = new mod.SkillBar(() => true);
      const denial = document.querySelector<HTMLElement>("#skills-denial")!;
      const texts: Record<string, string | null> = {};
      for (const reason of ["no-class", "on-cooldown", "no-target", "out-of-range", "target-dead"]) {
        bar.applyDenied({ skillKey: "fireball", reason, nonce: "n" });
        texts[reason] = denial.textContent;
      }
      bar.destroy();
      const afterDestroy = denial.hidden;
      return { texts, afterDestroy };
    });

    expect(result.texts).toEqual({
      "no-class": "직업을 먼저 선택하세요",
      "on-cooldown": "아직 준비되지 않았습니다",
      "no-target": "대상이 없습니다",
      "out-of-range": "거리가 너무 멉니다",
      "target-dead": "대상이 쓰러져 있습니다",
    });
    expect(result.afterDestroy).toBe(true);
  });
});

test.describe("skillKeys.ts 화이트박스 (R05-c)", () => {
  test("숫자키는 캔버스에서만 듣는다 — 채팅 입력 중과 key-repeat은 무시한다", async () => {
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/input/skillKeys.ts");
      const pressed: number[] = [];
      const keys = new mod.SkillKeys((index: number) => {
        pressed.push(index);
        return true;
      });
      const fire = (init: KeyboardEventInit): void => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
      };

      fire({ code: "Digit1" });
      fire({ code: "Digit2" });
      // key-repeat — 쿨다운이 초 단위인 스킬에는 의미가 없다.
      fire({ code: "Digit1", repeat: true });
      // 브라우저/OS 몫.
      fire({ code: "Digit1", ctrlKey: true });
      fire({ code: "Digit1", altKey: true });
      // 5번 슬롯은 없다.
      fire({ code: "Digit5" });
      // 물리 코드 바인딩이라 IME/레이아웃이 바뀌어도 같은 키다 — key 값만 숫자인 것은 듣지 않는다.
      fire({ code: "Numpad1" });

      const beforeChat = [...pressed];

      // 채팅 입력 중에는 "1"이 글자다. `#chat`은 room 접속 전까지 hidden 이고 hidden 요소는
      // 포커스를 받지 못하므로, 실제로 채팅을 여는 것과 같은 상태를 먼저 만든다.
      document.querySelector<HTMLElement>("#chat")!.hidden = false;
      const input = document.querySelector<HTMLInputElement>("#chat-input")!;
      input.focus();
      fire({ code: "Digit1" });
      const duringChat = [...pressed];
      input.blur();

      keys.destroy();
      fire({ code: "Digit1" });
      const afterDestroy = [...pressed];

      return { beforeChat, duringChat, afterDestroy };
    });

    expect(result.beforeChat).toEqual([0, 1]);
    expect(result.duringChat, "typing 1 in chat must never cast").toEqual([0, 1]);
    expect(result.afterDestroy, "destroy() must remove the global listener").toEqual([0, 1]);
  });
});
