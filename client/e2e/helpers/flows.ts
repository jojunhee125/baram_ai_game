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
  await dismissClassPicker(page);
}

/**
 * 직업 미선택 계정마다 뜨는 직업 선택 화면(classPicker.ts, 설계 D9)을 닫는다 —
 * {@link completeAvatarPicker}와 같은 자리의 같은 문제다. 캐릭터 선택처럼 스테이지를 덮는
 * 모달이라, 닫지 않으면 뒤에 오는 모든 클릭·스크린샷이 이 패널을 맞는다.
 *
 * **고르는 대신 닫는다.** 직업은 계정당 한 번뿐인 되돌릴 수 없는 선택(설계 D1)이고, D9가
 * "게임에 못 들어가게 막지 않는다"고 명시한 대로 닫아도 이동·평타·퀘스트·상점은 그대로 된다 —
 * 즉 기존 spec들이 검증하던 세계가 그대로 남는다. 여기서 직업을 골라 버리면 그 spec들이
 * 직업 배율이 걸린 다른 전투를 재게 된다.
 *
 * 패널은 join 직후 서버가 스스로 보내는 `ClassChanged`에 반응해 열리므로 `waitForCanvasReady`
 * 뒤에야 뜰 수 있다. 이미 직업이 있는 계정에서는 아예 뜨지 않으므로, 안 뜨면 조용히 넘어간다.
 */
export async function dismissClassPicker(page: Page): Promise<void> {
  const picker = page.locator("#class-picker");
  try {
    await picker.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return;
  }
  await page.locator("#class-picker-close").click();
  await picker.waitFor({ state: "hidden" });
}

/** 상시 HP 패널(F-2, `#vitals-count`, 예: "30 / 30")의 텍스트를 읽는다. */
export async function readVitalsText(page: Page): Promise<string> {
  return page.locator("#vitals-count").innerText();
}
