import { type Browser, type BrowserContext, type Page, chromium } from "@playwright/test";

/**
 * The game's own backing resolution (`VIEWPORT_WIDTH_TILES/HEIGHT_TILES * TILE_SIZE_PX`,
 * `client/src/main.ts`). Every context this module opens uses it as the viewport so
 * `Scale.FIT` maps 1:1 (CSS px === canvas-internal px) — any other viewport size leaves
 * Phaser scaling the canvas and Chromium re-sampling it for `page.screenshot()`, which blurs
 * sharp single-colour shapes (e.g. `combatEffects.ts`'s swing arc) into blended neighbour
 * colours and makes `expectPixelColor`'s screenshot fallback read the wrong value even at the
 * right coordinate (found while tuning F-6 #3, 2026-09-02).
 */
const GAME_VIEWPORT = { width: 1024, height: 576 };

export interface Client {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  /** page.close() — 절대 page.goto()/reload()로 세션을 리셋하지 않는다 (함정 3). */
  close(): Promise<void>;
}

/**
 * 한 spec 파일의 순차 시나리오 전체가 공유하는 브라우저 프로세스 하나. 테스트마다
 * chromium.launch()를 새로 하지 않는다 — 매번 재시작하는 비용이 기존 CDP 스크립트를 느리게
 * 만든 원인 중 하나였고, "탭 하나 재사용"이 아니라 "프로세스 하나 재사용 + 탭은 매번 새로"가
 * 이 프로젝트가 실측한 안전한 조합이다(아래 openConcurrentClients와 대비).
 */
export async function launchSharedBrowser(): Promise<Browser> {
  return chromium.launch();
}

/**
 * `browser`에 새 탭 하나. 순차 시나리오 하나를 위한 것 — 끝나면 반드시 close()하고, 상태를
 * 리셋해야 하면 이 Client를 버리고 openFreshClient를 다시 부른다(함정 3).
 */
export async function openFreshClient(browser: Browser): Promise<Client> {
  const context = await browser.newContext({ viewport: GAME_VIEWPORT });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    close: () => page.close(),
  };
}

/**
 * 동시에 2개 이상의 클라이언트가 "동시에 렌더링·갱신"되어야 하는 시나리오(멀티플레이어 가시성,
 * 근접 채팅 — "A가 B를 보는가")를 위해 **별도 브라우저 프로세스 n개**를 띄운다.
 *
 * 이걸 "한 브라우저의 탭 n개"나 "컨텍스트 n개"로 최적화하지 말 것 — 이 프로젝트가 raw CDP로
 * 실제로 겪은 함정이다: 헤드리스 Chrome 한 프로세스에 탭을 2개 열었더니 나중 탭만 정상
 * 진행되고 먼저 연 탭은 WorldScene이 아니라 **BootScene 단계("맵을 불러오는 중")에서 영구
 * 정지**했다(Pass E4/E5, 2026-09-02). 배경 탭의 rAF가 스로틀되어 Phaser 로더 루프 자체가
 * 멈춘 것 — 프로세스를 완전히 분리하자 즉시 해결됐다. 헤드리스가 실 브라우저의 포커스/가시성
 * 기반 스로틀링을 재현할지는 Chromium 버전마다 다를 수 있어, 검증된 해법(프로세스 분리)을
 * 다시 재현해보지 않고 그대로 쓴다.
 */
export async function openConcurrentClients(count: number): Promise<Client[]> {
  const clients: Client[] = [];
  for (let i = 0; i < count; i += 1) {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: GAME_VIEWPORT });
    const page = await context.newPage();
    clients.push({
      browser,
      context,
      page,
      close: async () => {
        await page.close();
        await browser.close();
      },
    });
  }
  return clients;
}
