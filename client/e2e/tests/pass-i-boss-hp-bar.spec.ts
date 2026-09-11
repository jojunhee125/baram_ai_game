import { expect, test, type Page } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { holdKey, tapKey } from "../helpers/input";
import { joinRoom } from "../helpers/flows";

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

/**
 * 상단 알림 밴드(`.notice`, `#portal-denial-banner`: top `--space-3` + 패딩 2줄 + 12px 본문 1행)와
 * HUD 컨트롤 줄(`--control-height` 34px)이 쓰는 첫 줄의 높이. 보스 바는 그 아래에서 시작한다.
 */
const NOTICE_BAND_PX = 34;

/**
 * ## 실제 보스를 때려서 뜨는지는 왜 자동화하지 않는가 (2026-09-09 실측)
 *
 * 이 파일에는 "사냥터에 들어가 보스를 찾아 때린다"는 시나리오가 없다. 시도해서 버렸다 —
 * **보스의 위치가 서버에 남는 상태이고, 그 테스트 자신이 그것을 옮겨 버리기 때문이다.**
 *
 * - 보스는 6시간 리젠(`BOSS_RESPAWN_MS`)이라 room 인스턴스가 사는 동안 재배치되지 않는다.
 * - 교전하면 플레이어를 따라와(chase) 자기 배회 상자(x31-37/y13-19) 밖으로 최대 leash 10칸까지
 *   끌려 나온다. 플레이어가 나가면 걸어서 돌아오는데, 그 속도가 `wanderStepIntervalMs` 2400ms/칸
 *   이라 7칸이면 17초다.
 * - 그래서 같은 걸음 시나리오를 연속으로 돌리면 1회차는 보스를 만나고(실측: `보스 4996 / 5000`
 *   기록됨) 2회차는 한 번도 못 만난다 — 실측으로 재현했다. 안정화 대기를 넣으면 테스트 하나가
 *   1분을 넘고, 그래도 "반드시 만난다"는 보장은 없다(배회 상자 49칸, 어그로 반경 2칸).
 *
 * 그래서 여기서는 (1) 트리거 계약(때리기 전엔 안 뜬다 / 보스 없는 room에선 안 뜬다), (2) 실제
 * `bossVitals.ts` 모듈의 그리기 계약을 white-box로, (3) 배치와 room 전환 정리를 검증한다.
 * "실제 보스를 때리면 상단 바에 `보스 / 4988 / 5000`이 그려진다"는 것은 수동으로 확인해
 * handoff에 스크린샷과 기록값으로 남겼다.
 */

test("보스를 때리기 전에는 상단 HP바가 뜨지 않는다 (hit-to-reveal)", async () => {
  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);

  const bar = client.page.locator("#boss-vitals");
  await expect(bar).toBeHidden();

  // 스폰 지점 사거리 안에는 아무것도 없다(가장 가까운 다람쥐 배회 상자가 x27-31 / x39-43,
  // 스폰은 x33-37) — 허공 스윙은 서버가 침묵으로 버리므로 바는 계속 숨어 있어야 한다.
  await holdKey(client.page, "Space", 700);
  await client.page.waitForTimeout(300);
  await expect(bar).toBeHidden();
});

test("보스가 없는 room에서는 상단 HP바가 뜨지 않는다", async () => {
  await joinRoom(client.page, "grand-plaza");
  await waitForCanvasReady(client.page);

  await holdKey(client.page, "Space", 700);
  await holdKey(client.page, "ArrowUp", 700);
  await holdKey(client.page, "Space", 700);
  await client.page.waitForTimeout(300);

  await expect(client.page.locator("#boss-vitals")).toBeHidden();
  // 이 room에도 뜨는 상시 HP 패널(Pass F)과 혼동하지 않았음을 같은 자리에서 확인한다.
  await expect(client.page.locator("#vitals")).toBeVisible();
});

test("bossVitals.ts 모듈: 히트가 이름·HP·게이지·aria를 그리고, 해당 몬스터만 바를 내린다", async () => {
  // white-box — 실제 모듈을 실제 DOM 위에서 직접 돌린다(Phase J #1 스펙과 같은 방식). 6시간
  // 리젠 몬스터를 찾아가지 않고도 "MonsterHit이 실어 온 값을 그대로 그리는가"를 확정할 수 있다.
  await client.page.goto("/?room=plaza");

  const result = await client.page.evaluate(async () => {
    const mod = await import("/src/ui/bossVitals.ts");
    const panel = document.querySelector<HTMLElement>("#boss-vitals")!;
    const track = document.querySelector<HTMLElement>("#boss-vitals-track")!;
    const read = (): Record<string, string | boolean | null> => ({
      hidden: panel.hidden,
      name: document.querySelector<HTMLElement>("#boss-vitals-name")!.textContent,
      count: document.querySelector<HTMLElement>("#boss-vitals-count")!.textContent,
      transform: document.querySelector<HTMLElement>("#boss-vitals-fill")!.style.transform,
      valueNow: track.getAttribute("aria-valuenow"),
      valueMax: track.getAttribute("aria-valuemax"),
    });

    const vitals = new mod.BossVitals();
    const atBoot = read();

    vitals.applyHit("hg-boss-01", "보스", 4000, 5000);
    const afterHit = read();

    vitals.applyHit("hg-boss-01", "보스", 1250, 5000);
    const afterSecondHit = read();

    // 옆에서 다람쥐가 죽어도 보스의 바는 내려가지 않는다.
    vitals.release("hg-squirrel-01");
    const afterOtherRelease = read();

    vitals.release("hg-boss-01");
    const afterRelease = read();

    // 리젠으로 같은 id가 다시 살아나도 "아직 안 맞은 개체"라 히트 전까지는 숨어 있다.
    vitals.applyHit("hg-boss-01", "보스", 5000, 5000);
    const afterRespawnHit = read();
    vitals.destroy();
    const afterDestroy = read();

    return {
      atBoot,
      afterHit,
      afterSecondHit,
      afterOtherRelease,
      afterRelease,
      afterRespawnHit,
      afterDestroy,
    };
  });

  expect(result.atBoot).toMatchObject({ hidden: true });
  expect(result.afterHit).toMatchObject({
    hidden: false,
    name: "보스",
    count: "4000 / 5000",
    transform: "scaleX(0.8)",
    valueNow: "4000",
    valueMax: "5000",
  });
  expect(result.afterSecondHit).toMatchObject({
    hidden: false,
    count: "1250 / 5000",
    transform: "scaleX(0.25)",
    valueNow: "1250",
  });
  expect(result.afterOtherRelease).toMatchObject({ hidden: false, count: "1250 / 5000" });
  expect(result.afterRelease).toMatchObject({ hidden: true });
  expect(result.afterRespawnHit).toMatchObject({
    hidden: false,
    count: "5000 / 5000",
    transform: "scaleX(1)",
  });
  expect(result.afterDestroy).toMatchObject({ hidden: true });
});

test("보스 HP바는 화면 상단에 고정되고 다른 HUD와 겹치지 않는다", async () => {
  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);

  // 배치는 순수 CSS 계약이라 보스와 실제로 싸우지 않고 확인한다 — 위 white-box 테스트가 "뜬다"를
  // 담당하고, 이 테스트는 "떴을 때 어디에 있나"만 본다.
  await revealBossBar(client.page);
  // 바의 y 밴드로 펼쳐지는 두 패널을 열어 둔다 — 접힌 상태만 보면 겹침을 놓친다.
  await tapKey(client.page, "KeyM");
  await tapKey(client.page, "KeyI");
  await expect(client.page.locator("#minimap")).toBeVisible();
  await expect(client.page.locator("#inventory")).toBeVisible();

  const stage = (await client.page.locator(".stage").boundingBox())!;
  const bar = (await client.page.locator("#boss-vitals").boundingBox())!;

  // 상단 밴드 안에 있다 — 단, 일시적·강조 알림(.notice / #portal-denial-banner)과 HUD 컨트롤
  // 줄이 쓰는 첫 줄보다는 아래다. 보스전 중에 "이동하지 못했습니다"가 가려지면 안 된다.
  expect(bar.y - stage.y).toBeGreaterThan(NOTICE_BAND_PX);
  expect(bar.y - stage.y).toBeLessThan(stage.height / 4);

  // 같은 화면에 떠 있는 다른 HUD와 사각형이 겹치지 않는다. `.hud__controls`는 버튼 6개의 실제
  // 폭이 `.hud`의 23.4375%를 넘겨 왼쪽으로 삐져나오므로, 컨테이너가 아니라 이 줄 자체를 잰다.
  // `.region-guide`는 2026-09-11 클래식 UI 병합에서 새로 생긴 좌상단 패널이다. 이 목록에 없던
  // 동안 stage 폭 1306px 미만에서 보스 이름·HP 수치를 덮고 있었고(기본 뷰포트 1024×576에서
  // 104px 겹침), 이 파일은 보스바만, `heritage-first-play.spec.ts`는 1440×900에서 안내만 보느라
  // 둘을 동시에 노출시키는 테스트가 없어 아무도 못 잡았다.
  for (const selector of ["#vitals", ".hud__controls", "#minimap", "#inventory", ".region-guide"]) {
    const other = (await client.page.locator(selector).boundingBox())!;
    const overlaps =
      bar.x < other.x + other.width &&
      other.x < bar.x + bar.width &&
      bar.y < other.y + other.height &&
      other.y < bar.y + bar.height;
    expect(overlaps, `보스 HP바가 ${selector}와 겹친다`).toBe(false);
  }

  // 가운데 정렬 — 기준은 `.stage`가 아니라 실제 게임 화면(`.stage__canvas`)이다. Phase I 당시에는
  // HUD가 캔버스 위에 겹쳐 있어 둘이 같은 사각형이었지만, 2026-09-11 클래식 UI 병합으로 HUD가
  // 우측 사이드바로 분리되면서 `.stage`는 사이드바 폭만큼 더 넓어졌다. "보고 있는 화면의 중앙"이
  // 원래 계약이므로 캔버스를 기준으로 잰다.
  const canvas = (await client.page.locator(".stage__canvas").boundingBox())!;
  const centreOffset = Math.abs(bar.x + bar.width / 2 - (canvas.x + canvas.width / 2));
  expect(centreOffset).toBeLessThan(2);
});

test("사냥터를 떠나면 보스 HP바가 새 room에 남지 않는다", async () => {
  await joinRoom(client.page, "hunting-ground");
  await waitForCanvasReady(client.page);

  // 두 사냥터가 각자 보스를 갖고 있어(hg-boss-01 / hd-boss-01) 공유 DOM이 정리되지 않으면 다음
  // zone에 그대로 걸린다. 떠 있는 상태를 만들어 두고 실제로 방을 옮긴다.
  const bar = client.page.locator("#boss-vitals");
  await revealBossBar(client.page);
  await expect(bar).toBeVisible();

  // 랜드마크 패널(T)의 "마을 광장" 행 = 다른 room으로의 hop, 즉 씬 재시작 경로.
  await tapKey(client.page, "KeyT");
  await client.page.getByRole("button", { name: "마을 광장", exact: true }).click();
  // 도착 판정은 room 고유 신호로 한다 — 확률표 내용은 room별이라 "몬스터 없음" 문구가 곧
  // "사냥터를 떠났다"는 뜻이다.
  await tapKey(client.page, "KeyL");
  await expect(client.page.locator("#loot-table-status-text")).toHaveText(
    "이 지역에는 몬스터가 없습니다.",
  );

  await expect(bar).toBeHidden();
});

/** 게임 로직을 거치지 않고 패널만 화면에 올린다 — 배치/정리만 보는 테스트 전용. */
async function revealBossBar(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#boss-vitals")!.hidden = false;
  });
}
