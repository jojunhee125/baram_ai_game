import { AVATAR_SKIN_COUNT } from "@zep-test/shared";

/**
 * Previews are the walk sheet itself at 2x, so the picker ships no new art and can never offer a
 * skin the world would not draw. Geometry of `assets/sprites/avatar.png`: three frame columns,
 * one row per direction, four directions per skin, 32px cells.
 */
const PREVIEW_PX = 64;
/** Middle column of the three, which is the standing frame. */
const PREVIEW_COLUMN_PX = PREVIEW_PX;
/** A skin owns four direction rows; row 0 of its block faces the camera. */
const PREVIEW_BLOCK_PX = PREVIEW_PX * 4;

/** Lives here rather than in CSS because arrow-key row jumps need the same number. */
const COLUMNS = 6;

const ARROW_STEPS: Readonly<Record<string, { axis: "row" | "column"; delta: number }>> = {
  ArrowUp: { axis: "row", delta: -1 },
  ArrowDown: { axis: "row", delta: 1 },
  ArrowLeft: { axis: "column", delta: -1 },
  ArrowRight: { axis: "column", delta: 1 },
};

const panel = document.querySelector<HTMLElement>("#avatar-picker")!;
const grid = document.querySelector<HTMLElement>("#avatar-picker-grid")!;
const startButton = document.querySelector<HTMLButtonElement>("#avatar-picker-start")!;

/**
 * Runs character select and resolves with the chosen skin.
 *
 * `initialSkin` is the cell to open on — the account's stored choice, or 0 when there is none.
 * The caller owns that range check: a value with no cell would leave the grid with nothing
 * selected and nothing focused.
 *
 * Resolves once and then tears itself down, so unlike the chat panel or the minimap there is no
 * `destroy()` for a caller to forget: this is a boot step that ends before the world exists.
 */
export function chooseAvatarSkin(initialSkin: number): Promise<number> {
  return new Promise((resolve) => {
    const cells = buildCells();
    const columns = Math.min(COLUMNS, cells.length);
    let selected = 0;

    grid.style.setProperty("--picker-columns", String(columns));
    // The sheet's full height at 2x, so `background-size` follows AVATAR_SKIN_COUNT instead of
    // CSS carrying a second copy of it that would silently squash every preview when it changes.
    grid.style.setProperty(
      "--picker-sheet-height",
      `${AVATAR_SKIN_COUNT * PREVIEW_BLOCK_PX}px`,
    );

    const select = (next: number): void => {
      const cell = cells[next];
      if (!cell) {
        return;
      }
      cells[selected]?.setAttribute("aria-checked", "false");
      cells[selected]?.setAttribute("tabindex", "-1");
      selected = next;
      cell.setAttribute("aria-checked", "true");
      cell.setAttribute("tabindex", "0");
      cell.focus();
    };

    const finish = (): void => {
      grid.removeEventListener("keydown", handleGridKey);
      startButton.removeEventListener("click", finish);
      panel.hidden = true;
      grid.replaceChildren();
      resolve(selected);
    };

    const handleGridKey = (event: KeyboardEvent): void => {
      // Enter starts instead of re-selecting the focused cell, so the keyboard path is arrows
      // then Enter with no detour through the start button.
      if (event.key === "Enter") {
        event.preventDefault();
        finish();
        return;
      }
      const step = ARROW_STEPS[event.key];
      if (step === undefined) {
        return;
      }
      event.preventDefault();
      select(selected + (step.axis === "row" ? step.delta * columns : step.delta));
    };

    for (const [skin, cell] of cells.entries()) {
      cell.addEventListener("click", () => select(skin));
    }
    grid.addEventListener("keydown", handleGridKey);
    startButton.addEventListener("click", finish);

    panel.hidden = false;
    // Selecting after unhiding, because focus() on a hidden element does nothing and arrows
    // have to work without a Tab first.
    select(initialSkin);
  });
}

function buildCells(): HTMLButtonElement[] {
  const cells: HTMLButtonElement[] = [];
  for (let skin = 0; skin < AVATAR_SKIN_COUNT; skin += 1) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "picker__cell";
    cell.setAttribute("role", "radio");
    cell.setAttribute("aria-checked", "false");
    cell.setAttribute("tabindex", "-1");
    cell.setAttribute("aria-label", `${skin + 1}번 캐릭터`);

    const preview = document.createElement("span");
    preview.className = "picker__preview";
    preview.style.backgroundPosition = `-${PREVIEW_COLUMN_PX}px -${skin * PREVIEW_BLOCK_PX}px`;
    cell.append(preview);

    cells.push(cell);
  }
  grid.replaceChildren(...cells);
  return cells;
}
