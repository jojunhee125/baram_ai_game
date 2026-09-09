import type { Page } from "@playwright/test";
import { waitForCanvasReady } from "./canvas";

/**
 * 최초 접속마다 뜨는 캐릭터 선택 화면(avatarPicker.ts)을 통과시킨다. `skinIndex` 생략 시
 * 이미 포커스된 스킨(새 프로필이면 0번) 그대로 시작한다. 새 test id를 추가하지 않고
 * 기존 `aria-label`("N번 캐릭터")로 셀을 찾는다 — Pass F 영역 파일을 건드릴 수 없고, 이미
 * 접근성 라벨이 있어 새로 추가할 이유가 없다.
 */
export async function completeAvatarPicker(page: Page, skinIndex?: number): Promise<void> {
  const picker = page.locator("#avatar-picker");
  await picker.waitFor({ state: "visible" });

  if (skinIndex !== undefined) {
    // `exact: true` is mandatory: Playwright's default accessible-name match is substring-based,
    // and "1번 캐릭터" is a literal substring of "11번 캐릭터" and "21번 캐릭터" alike (AVATAR_SKIN_COUNT
    // is 24), so any single- or double-digit skinIndex used to resolve to 3 elements and throw a
    // strict-mode violation instead of picking the one cell that was actually meant.
    await page.getByRole("radio", { name: `${skinIndex + 1}번 캐릭터`, exact: true }).click();
  }

  await page.locator("#avatar-picker-start").click();
  await picker.waitFor({ state: "hidden" });
}

/**
 * `?room=<roomName>` 쿼리(roomTarget.ts가 이미 노출하는, grand-plaza 검증용 진입점,
 * docs/decisions.md 2026-08-26)로 접속해 캐릭터 선택을 통과시킨다. waitForCanvasReady까지
 * 확인한 뒤 resolve한다.
 */
export async function joinRoom(
  page: Page,
  roomName: string,
  options?: { skinIndex?: number },
): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomName)}`);
  await completeAvatarPicker(page, options?.skinIndex);
  await waitForCanvasReady(page);
}

/** 상시 HP 패널(F-2, `#vitals-count`, 예: "30 / 30")의 텍스트를 읽는다. */
export async function readVitalsText(page: Page): Promise<string> {
  return page.locator("#vitals-count").innerText();
}
