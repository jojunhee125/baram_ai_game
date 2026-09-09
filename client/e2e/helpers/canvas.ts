import type { Page } from "@playwright/test";
import { PNG } from "pngjs";

/**
 * "월드가 실제로 그려졌다"를 기다린다 — <canvas> 존재는 페이지 로드 시점부터 항상 참이라
 * 대기 조건으로 쓰면 아무것도 기다리지 않는다(함정 5, 과거 가짜 FAIL 2건의 원인).
 *
 * `#boot-status[data-state="ready"][hidden]`을 기다린다 — WorldScene.create()가 맵/아틀라스를
 * 다 지은 뒤에만 부르는 hideBootStatus()(WorldScene.ts:249, 이 트랙이 건드리지 않는 기존 코드)
 * 가 유일하게 그 상태를 만든다. 그 다음 rAF 2프레임을 더 기다려, 그 호출을 한 프레임이 실제로
 * 페인트할 시간을 준다.
 */
export async function waitForCanvasReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const el = document.querySelector("#boot-status");
      return el instanceof HTMLElement && el.dataset["state"] === "ready" && el.hidden;
    },
    undefined,
    { timeout: timeoutMs },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * `durationMs` 동안 실제 애니메이션 프레임 수를 센다. "아무 일도 안 일어났다"는 결과를
 * 판정하기 **전에** 먼저 호출할 것 — 렌더 루프가 죽은 것(함정 2의 스로틀, 또는 진짜 크래시)과
 * 검증 대상 동작이 정말 실패한 것을 구분하기 위해서다(함정 6: 정상 60fps면 600ms에 약 37프레임,
 * 0에 가까우면 루프 문제).
 */
export async function probeAnimationLoop(page: Page, durationMs: number): Promise<number> {
  return page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        let count = 0;
        const start = performance.now();
        const tick = (): void => {
          count += 1;
          if (performance.now() - start >= ms) {
            resolve(count);
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    durationMs,
  );
}

interface RgbSample {
  r: number;
  g: number;
  b: number;
}

function toRgb(hexColor: number): RgbSample {
  return {
    r: (hexColor >> 16) & 0xff,
    g: (hexColor >> 8) & 0xff,
    b: hexColor & 0xff,
  };
}

interface CanvasGeometry {
  box: { x: number; y: number; width: number; height: number };
  internalSize: { width: number; height: number };
  /** Whether `readViaWebgl` can ever succeed on this page — see its own doc comment. */
  webglUsable: boolean;
}

const geometryCache = new WeakMap<Page, CanvasGeometry>();

/**
 * `#game-root canvas`'s bounding box, internal backing size and WebGL-readback usability, cached
 * per `page` (Scale.FIT never changes these mid-test on this project's fixed viewport,
 * `helpers/browser.ts`'s `GAME_VIEWPORT`). Assertions timed against a short-lived effect — the
 * swing arc's `SWING_MS` (`combatEffects.ts`) is 350ms total — need every one of the 2-3 CDP round
 * trips this used to cost on *every* call back; a cache miss on the very first call in a test still
 * pays it once, which is why timing-critical callers should `primeCanvasGeometry` right after
 * `waitForCanvasReady` rather than right before the action they are timing.
 */
async function getCanvasGeometry(page: Page): Promise<CanvasGeometry> {
  const cached = geometryCache.get(page);
  if (cached) {
    return cached;
  }
  const canvasHandle = page.locator("#game-root canvas");
  const box = await canvasHandle.boundingBox();
  if (!box) {
    throw new Error("expectPixelColor: #game-root canvas has no bounding box");
  }
  const info = await canvasHandle.evaluate((canvas: HTMLCanvasElement) => {
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    return {
      width: canvas.width,
      height: canvas.height,
      // See `readViaWebgl`: without `preserveDrawingBuffer`, `gl.readPixels` silently returns a
      // cleared buffer instead of failing, so this has to be checked up front rather than
      // discovered from a bad read.
      webglUsable: Boolean(gl?.getContextAttributes()?.preserveDrawingBuffer),
    };
  });
  const geometry: CanvasGeometry = {
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    internalSize: { width: info.width, height: info.height },
    webglUsable: info.webglUsable,
  };
  geometryCache.set(page, geometry);
  return geometry;
}

/**
 * Pre-fetches and caches this page's canvas geometry so a later timing-critical
 * `expectPixelColor` call spends its whole budget on the one screenshot that matters, not on
 * re-deriving geometry it already knows. Optional — `expectPixelColor` populates the same cache
 * lazily on first use — but the first call in a test pays the cost of populating it, so a call
 * timed against a short-lived effect should not be that first call.
 */
export async function primeCanvasGeometry(page: Page): Promise<void> {
  await getCanvasGeometry(page);
}

/**
 * 게임 캔버스에서 픽셀 1개(또는 `sampleRadius`로 준 작은 정사각형의 최빈값)를 읽어
 * `hexColor`와 `tolerancePerChannel`(R/G/B 채널별 0-255) 이내인지 비교한다.
 *
 * 1순위: 캔버스 자신의 WebGL 컨텍스트(`canvas.getContext("webgl2")`/`"webgl"` — Phaser가 이미
 * 만든 것과 동일한 컨텍스트가 반환된다, 캔버스는 컨텍스트를 하나만 가질 수 있으므로)에서
 * `gl.readPixels`로 직접 읽는다 — `page.screenshot()`의 PNG를 손으로 디코딩하지 않는다.
 * 과거 raw CDP 스크립트가 `Page.captureScreenshot`의 실제 출력(colorType 2, RGB 3바이트/px)을
 * RGBA 4바이트로 가정해 전부 쓰레기 값을 읽은 사고(함정 1)를 원천적으로 피한다.
 *
 * 폴백(WebGL 컨텍스트를 못 얻을 때만): `page.screenshot({ clip })`을 실제 PNG 라이브러리
 * (pngjs — IHDR의 colorType을 읽고 RGB/RGBA를 모두 png.data에 RGBA로 정규화해 돌려준다,
 * 직접 파싱 금지)로 디코딩한다.
 *
 * 좌표는 캔버스 **내부** 픽셀(0,0~1024,576 — shared/src/camera.ts의 32×18타일×32px)이지
 * CSS/뷰포트 좌표가 아니다: Scale.FIT 때문에 창 크기가 1024×576이 아닌 한 이 둘은 다르다.
 */
export async function expectPixelColor(
  page: Page,
  canvasXY: { x: number; y: number },
  hexColor: number,
  options?: { tolerancePerChannel?: number; sampleRadius?: number },
): Promise<void> {
  const tolerance = options?.tolerancePerChannel ?? 12;
  const sampleRadius = options?.sampleRadius ?? 0;
  const expected = toRgb(hexColor);

  const geometry = await getCanvasGeometry(page);
  const actual = geometry.webglUsable
    ? ((await readViaWebgl(page, canvasXY, sampleRadius)) ?? (await readViaScreenshot(page, geometry, canvasXY, sampleRadius)))
    : await readViaScreenshot(page, geometry, canvasXY, sampleRadius);

  const withinTolerance =
    Math.abs(actual.r - expected.r) <= tolerance &&
    Math.abs(actual.g - expected.g) <= tolerance &&
    Math.abs(actual.b - expected.b) <= tolerance;

  if (!withinTolerance) {
    throw new Error(
      `expectPixelColor: at (${canvasXY.x},${canvasXY.y}) expected rgb(${expected.r},${expected.g},${expected.b}) ` +
        `±${tolerance}, got rgb(${actual.r},${actual.g},${actual.b})`,
    );
  }
}

/**
 * 키 입력으로 동기 발생하는 아주 짧은 이펙트(스윙 아크: 전체 수명 SWING_MS=350ms,
 * combatEffects.ts) 전용. 키 디스패치와 픽셀 판독을 보통의 `tapKey` + `expectPixelColor`처럼
 * 별도의 CDP 왕복 두 번으로 나누면, 이 세션처럼 동시에 여러 브라우저/Node 프로세스가 떠 있는
 * 환경(실측 당시 chrome 29개·node 22개 동시 실행)에서는 그 왕복들 자체의 지연만으로 350ms를
 * 넘기는 일이 실제로 일어난다 — 좌표/허용오차가 맞아도 배경색만 읽혔다(F-6 #3 튜닝 중 실측,
 * 2026-09-02).
 *
 * Playwright Clock API(`page.clock`)로 이펙트 내부 시계를 통제하는 방법도 시도했으나 기각했다:
 * Phaser의 게임 루프(`raf` 매니저)는 부팅 시점에 **진짜** `window.requestAnimationFrame`
 * 참조를 붙잡아 두고 그것만 계속 호출하는 것으로 보여, 이후 `clock.install()`이 `window`의
 * 전역을 바꿔치기해도 Phaser의 루프 자체는 여전히 실시간으로 돈다(실측: `runFor(20)`으로 정확히
 * 20ms만 전진시켰다고 믿었는데, 매번 스윙이 이미 끝난 뒤였다 — 그사이 벌어진 `install`+
 * `pauseAt`+`keyboard.press`+`runFor` 네 번의 실제 CDP 왕복 시간만큼 Phaser의 **진짜** 시계는
 * 이미 흘러 있었다). 즉 이 프로젝트의 캔버스에는 Clock API가 먹히지 않는다.
 *
 * 대신 keydown/keyup 디스패치와 픽셀 판독을 **하나의 `page.evaluate()` 안에서** 수행해 그 사이의
 * CDP 왕복 자체를 없앤다. `readViaWebgl`이 별도 호출에서는 못 쓰는 것과 같은 이유(그 함수 자체의
 * 주석 참고)로 `preserveDrawingBuffer:false`를 우회할 수 있는 것도 이 방식뿐이다 — 렌더링한 바로
 * 그 rAF 콜백 다음에 큐잉된 콜백 안에서 읽으니 그 사이 CDP가 끼어들 일이 없어 버퍼가 아직
 * 지워지지 않는다.
 *
 * 정확히 몇 번째 rAF에서 Phaser가 그 스윙을 실제로 반영하는지는 시스템 부하에 따라 갈린다(실측:
 * 고정 1프레임 판독은 부하가 큰 순간 간헐적으로 배경색만 읽었다) — `maxFrames`(기본 20, 60fps
 * 기준 ~330ms로 SWING_MS=350ms 안쪽)까지 매 프레임 판독해 하나라도 허용오차 안이면 그 프레임에서
 * 즉시 통과시킨다. 이 재시도도 페이지 안에서 끝나므로(각 시도 사이 CDP 왕복 없음) 여러 번
 * 시도한다고 다시 레이스가 생기지 않는다 — 그래도 실제 렌더 프레임 자체가 350ms 안에 단 한 번도
 * 오지 않을 만큼 시스템이 멈춰 있으면(=이 함수가 손댈 수 없는 영역) 여전히 놓칠 수 있다.
 *
 * `sampleRadius`로 잡은 박스 안에서는 "최빈값"이 아니라 "허용오차 안인 픽셀이 하나라도 있는가"로
 * 본다 — 스윙 아크는 프레임마다 폭 몇 px짜리 얇은 호 하나뿐이라, 궤적 전체를 덮을 만큼 박스를
 * 넓히면(아크가 프레임마다 반경이 자라며 위치가 바뀐다, `combatEffects.ts`의 `SWING_RADIUS_PX`)
 * 그 안 대부분은 배경이라 최빈값은 사실상 항상 배경이 이긴다 — 좌표/허용오차가 맞아도 매번
 * 배경만 잡히는 원인이었다(실측, 2026-09-02, F-6 #3).
 *
 * 좌표는 캔버스 **내부** 픽셀을 왜곡 없이 그대로 읽는다 — `page.screenshot()`은 Scale.FIT이
 * 만드는 CSS 크기(1024×576 백킹 스토어보다 살짝 작다)로 다운스케일하며 얇은 스트로크의 색을
 * 이웃 픽셀에 섞어 버려서, 스크린샷 기준으로 맞춘 좌표와 이 함수 기준 좌표는 서로 안 맞는다.
 */
export async function expectPixelColorAfterKeydown(
  page: Page,
  code: string,
  canvasXY: { x: number; y: number },
  hexColor: number,
  options?: { tolerancePerChannel?: number; sampleRadius?: number; maxFrames?: number },
): Promise<void> {
  const tolerance = options?.tolerancePerChannel ?? 12;
  const sampleRadius = options?.sampleRadius ?? 0;
  const maxFrames = options?.maxFrames ?? 20;
  const expected = toRgb(hexColor);

  const result = await page.evaluate(
    ({ code, x, y, radius, frames, er, eg, eb, tol }) => {
      return new Promise<{ hit: { r: number; g: number; b: number } | null; framesChecked: number }>(
        (resolve) => {
          const canvas = document.querySelector("#game-root canvas");
          const gl =
            canvas instanceof HTMLCanvasElement
              ? ((canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
                (canvas.getContext("webgl") as WebGLRenderingContext | null))
              : null;

          // 최빈값이 아니라 "박스 안에 허용오차 안인 픽셀이 하나라도 있는가"로 본다 — 스윙
          // 아크는 프레임마다 폭이 몇 px 안 되는 얇은 호 하나뿐이라(실측: 11×11 박스 안에서
          // 골드는 많아야 한 줄, 나머지는 전부 배경), 박스를 넓혀 궤적을 덮으면 최빈값은 거의
          // 항상 배경이 이긴다 — 그래서 좌표/허용오차가 맞아도 매번 배경만 잡혔다(실측,
          // 2026-09-02, F-6 #3).
          function findHitInBox(): { r: number; g: number; b: number } | null {
            if (!(canvas instanceof HTMLCanvasElement) || !gl) {
              return null;
            }
            const size = radius * 2 + 1;
            const glY = canvas.height - 1 - y;
            const startX = Math.max(0, x - radius);
            const startY = Math.max(0, glY - radius);
            const pixels = new Uint8Array(size * size * 4);
            gl.readPixels(startX, startY, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            for (let i = 0; i < pixels.length; i += 4) {
              const r = pixels[i]!;
              const g = pixels[i + 1]!;
              const b = pixels[i + 2]!;
              if (Math.abs(r - er) <= tol && Math.abs(g - eg) <= tol && Math.abs(b - eb) <= tol) {
                return { r, g, b };
              }
            }
            return null;
          }

          window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));
          let n = 0;
          const step = (): void => {
            const hit = findHitInBox();
            n += 1;
            if (hit || n >= frames) {
              window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true, cancelable: true }));
              resolve({ hit, framesChecked: n });
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        },
      );
    },
    {
      code,
      x: canvasXY.x,
      y: canvasXY.y,
      radius: sampleRadius,
      frames: maxFrames,
      er: expected.r,
      eg: expected.g,
      eb: expected.b,
      tol: tolerance,
    },
  );

  if (!result.hit) {
    throw new Error(
      `expectPixelColorAfterKeydown: no pixel within rgb(${expected.r},${expected.g},${expected.b})±${tolerance} ` +
        `near (${canvasXY.x},${canvasXY.y})±${sampleRadius} across ${result.framesChecked} frame(s)`,
    );
  }
}

export interface SpritePosition {
  x: number;
  y: number;
}

/**
 * 셔츠 색으로 플레이어 스프라이트를 찾는다. 단순 색 매칭은 타일셋 색과 허용오차 안에서
 * 겹친다(함정 4: 스킨3 녹색↔잔디, 스킨5 파랑↔분수, 스킨2 그림자↔짙은 나무 탁자) — 매칭 픽셀을
 * connected-component로 묶고, 셔츠 모양(가로 6~12px·세로 3~10px, 정면/후면 스프라이트는
 * 세로 약 10px, 측면은 약 8px)에 맞는 컴포넌트만 남긴 뒤 가장 큰 것의 중심을 반환한다.
 * 아무것도 안 맞으면 `undefined`.
 */
export async function findSpriteByShirtColor(
  page: Page,
  hexColor: number,
  options?: { tolerancePerChannel?: number },
): Promise<SpritePosition | undefined> {
  const tolerance = options?.tolerancePerChannel ?? 12;
  const target = toRgb(hexColor);

  return page.evaluate(
    ({ r, g, b, tol }) => {
      const canvas = document.querySelector("#game-root canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        return undefined;
      }
      const gl =
        (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
        (canvas.getContext("webgl") as WebGLRenderingContext | null);
      // Same `preserveDrawingBuffer` caveat as `readViaWebgl` below — this function has no PNG
      // fallback (unused by any test today, `docs/design-client-test-harness.md` §6), so on this
      // project's canvas config it will always report "no sprite found" rather than a false match;
      // a future caller needs a fallback path before relying on it for a real assertion.
      if (!gl || !gl.getContextAttributes()?.preserveDrawingBuffer) {
        return undefined;
      }
      const width = canvas.width;
      const height = canvas.height;
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      // WebGL's origin is bottom-left; row-flip into top-left/row-major so indices below match
      // the canvas-internal coordinate space the rest of this module's contract promises.
      const matches = new Uint8Array(width * height);
      for (let py = 0; py < height; py += 1) {
        const glRow = height - 1 - py;
        for (let px = 0; px < width; px += 1) {
          const idx = (glRow * width + px) * 4;
          const dr = Math.abs(pixels[idx]! - r);
          const dg = Math.abs(pixels[idx + 1]! - g);
          const db = Math.abs(pixels[idx + 2]! - b);
          if (dr <= tol && dg <= tol && db <= tol) {
            matches[py * width + px] = 1;
          }
        }
      }

      // Connected-component labeling, 4-connectivity, explicit stack (no recursion depth risk
      // on a 1024x576 canvas).
      const visited = new Uint8Array(width * height);
      let best: { minX: number; maxX: number; minY: number; maxY: number; size: number } | undefined;

      for (let py = 0; py < height; py += 1) {
        for (let px = 0; px < width; px += 1) {
          const start = py * width + px;
          if (!matches[start] || visited[start]) {
            continue;
          }
          let minX = px;
          let maxX = px;
          let minY = py;
          let maxY = py;
          let size = 0;
          const stack = [start];
          visited[start] = 1;
          while (stack.length > 0) {
            const idx = stack.pop()!;
            const cx = idx % width;
            const cy = (idx - cx) / width;
            size += 1;
            minX = Math.min(minX, cx);
            maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy);
            maxY = Math.max(maxY, cy);
            const up = cy > 0 ? idx - width : -1;
            const down = cy < height - 1 ? idx + width : -1;
            const left = cx > 0 ? idx - 1 : -1;
            const right = cx < width - 1 ? idx + 1 : -1;
            for (const n of [up, down, left, right]) {
              if (n >= 0 && matches[n] && !visited[n]) {
                visited[n] = 1;
                stack.push(n);
              }
            }
          }
          const w = maxX - minX + 1;
          const h = maxY - minY + 1;
          if (w < 6 || w > 12 || h < 3 || h > 10) {
            continue;
          }
          if (!best || size > best.size) {
            best = { minX, maxX, minY, maxY, size };
          }
        }
      }

      if (!best) {
        return undefined;
      }
      return {
        x: Math.round((best.minX + best.maxX) / 2),
        y: Math.round((best.minY + best.maxY) / 2),
      };
    },
    { r: target.r, g: target.g, b: target.b, tol: tolerance },
  );
}

async function readViaWebgl(
  page: Page,
  canvasXY: { x: number; y: number },
  sampleRadius: number,
): Promise<RgbSample | undefined> {
  return page.evaluate(
    ({ x, y, radius }) => {
      const canvas = document.querySelector("#game-root canvas");
      if (!(canvas instanceof HTMLCanvasElement)) {
        return undefined;
      }
      const gl =
        (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
        (canvas.getContext("webgl") as WebGLRenderingContext | null);
      if (!gl) {
        return undefined;
      }
      // Without `preserveDrawingBuffer`, the spec allows the browser to clear the drawing buffer
      // once control returns from the animation frame that rendered it — which is always, by the
      // time a `page.evaluate()` round trip (a separate CDP call) gets here. Phaser's own default
      // config (`client/src/main.ts`) never sets this, so `gl.readPixels` below would silently
      // return an all-black buffer instead of throwing — indistinguishable from "black is really
      // there" and never treated as this path failing, so the PNG fallback never ran (found while
      // tuning F-6 #3, 2026-09-02: every coordinate read back (0,0,0) even on a lit scene).
      if (!gl.getContextAttributes()?.preserveDrawingBuffer) {
        return undefined;
      }
      const size = radius * 2 + 1;
      // WebGL's readPixels origin is bottom-left; the caller's y is top-left (canvas-internal).
      const glY = canvas.height - 1 - y;
      const startX = Math.max(0, x - radius);
      const startY = Math.max(0, glY - radius);
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(startX, startY, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      const counts = new Map<string, { count: number; r: number; g: number; b: number }>();
      for (let i = 0; i < pixels.length; i += 4) {
        const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
        const entry = counts.get(key);
        if (entry) {
          entry.count += 1;
        } else {
          counts.set(key, { count: 1, r: pixels[i]!, g: pixels[i + 1]!, b: pixels[i + 2]! });
        }
      }
      let mode: { count: number; r: number; g: number; b: number } | undefined;
      for (const entry of counts.values()) {
        if (!mode || entry.count > mode.count) {
          mode = entry;
        }
      }
      return mode ? { r: mode.r, g: mode.g, b: mode.b } : undefined;
    },
    { x: canvasXY.x, y: canvasXY.y, radius: sampleRadius },
  );
}

async function readViaScreenshot(
  page: Page,
  geometry: CanvasGeometry,
  canvasXY: { x: number; y: number },
  sampleRadius: number,
): Promise<RgbSample> {
  const { box, internalSize } = geometry;
  // Scale.FIT can render the canvas at a CSS size different from its internal backing size
  // (1024x576) — map the caller's internal-pixel coordinate into CSS/viewport space before
  // clipping the screenshot.
  const scaleX = box.width / internalSize.width;
  const scaleY = box.height / internalSize.height;
  const cssRadius = Math.max(1, Math.round(sampleRadius * Math.max(scaleX, scaleY)));
  const clip = {
    x: box.x + canvasXY.x * scaleX - cssRadius,
    y: box.y + canvasXY.y * scaleY - cssRadius,
    width: cssRadius * 2 + 1,
    height: cssRadius * 2 + 1,
  };
  const buffer = await page.screenshot({ clip });
  // pngjs reads the IHDR colorType itself and always normalizes `png.data` to RGBA — this is the
  // real-library requirement from 함정 1 (Page.captureScreenshot's raw bytes are colorType 2 / RGB,
  // not RGBA; hand-parsing IHDR and assuming RGBA is exactly the past mistake this avoids).
  const png = PNG.sync.read(buffer);

  const counts = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!;
    const g = png.data[i + 1]!;
    const b = png.data[i + 2]!;
    const key = `${r},${g},${b}`;
    const entry = counts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(key, { count: 1, r, g, b });
    }
  }
  let mode: { count: number; r: number; g: number; b: number } | undefined;
  for (const entry of counts.values()) {
    if (!mode || entry.count > mode.count) {
      mode = entry;
    }
  }
  if (!mode) {
    throw new Error("expectPixelColor: screenshot fallback produced no pixel data");
  }
  return mode;
}
