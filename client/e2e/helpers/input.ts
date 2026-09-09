import type { Page } from "@playwright/test";

/**
 * keydown → durationMs 대기 → keyup. keydown 직후 바로 keyup을 보내면 그 사이 update
 * 루프가 한 프레임도 못 돌아 이동/입력이 0으로 관측되고 "입력이 막혔다"는 오탐이 된다(함정 6).
 * 효과가 안 보일 때는 이 함수를 의심하기 전에 probeAnimationLoop로 루프 생존부터 확인할 것.
 */
export async function holdKey(page: Page, code: string, durationMs: number): Promise<void> {
  await page.keyboard.down(code);
  await page.waitForTimeout(durationMs);
  await page.keyboard.up(code);
}

/** 명시적인 단발 입력 — 메뉴 확인/버튼 클릭처럼 탭이 실제로 맞는 몇 안 되는 경우 전용.
 *  이동/공격류에 복붙되지 않도록 홀드 계열과 이름을 분리해 둔다. */
export async function tapKey(page: Page, code: string): Promise<void> {
  await page.keyboard.press(code);
}
