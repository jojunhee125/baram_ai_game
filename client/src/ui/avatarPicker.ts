import { AVATAR_SKIN_COUNT } from "@zep-test/shared";
import { AVATAR_CATALOG, resolveAvatarPreview, type AvatarCatalog } from "../world/avatarArt";

const PREVIEW_PX = 64;

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
 * `initialSkin` is the cell to open on — the account's stored choice at boot, or the current
 * skin when this reopens mid-session from the character menu (Phase H). The caller owns that
 * range check: a value with no cell would leave the grid with nothing selected and nothing
 * focused.
 *
 * Resolves once and then tears itself down, so unlike the chat panel or the minimap there is no
 * `destroy()` for a caller to forget. That still holds now that this can reopen mid-session:
 * `WorldScene` blocks room transitions for as long as this is open (`skinPickerOpen`), so there
 * is never a scene restart for this promise to survive —
 * `docs/design-phase-h-skin-skip-menu.md` §2.3. Escape resolves with `initialSkin` unchanged,
 * the only way to leave without picking (§2.4); the boot call passes through the same branch
 * but has no reason to trigger it.
 */
export function chooseAvatarSkin(initialSkin: number, catalog: AvatarCatalog = AVATAR_CATALOG): Promise<number> {
  return new Promise((resolve) => {
    const { cells, dispose } = buildCells(catalog);
    const columns = Math.min(COLUMNS, cells.length);
    let selected = 0;

    grid.style.setProperty("--picker-columns", String(columns));
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
      dispose();
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
      // Cancel: resolve with whatever was already chosen, as if nothing happened. Only reachable
      // when this reopens mid-session (Phase H) — the boot call has nothing to cancel back to
      // besides the same fallback `initialSkin` it opened on, so the branch is harmless there too.
      if (event.key === "Escape") {
        event.preventDefault();
        selected = initialSkin;
        finish();
        return;
      }
      const step = ARROW_STEPS[event.key];
      if (step === undefined) {
        return;
      }
      event.preventDefault();
      if (step.axis === "row") {
        select(selected + step.delta * columns);
        return;
      }
      // Column moves stay inside the visual row: `select()` only guards against falling off
      // the whole grid, so without this a right-arrow off the last column would silently
      // continue onto the next row's first cell instead of stopping.
      const rowStart = Math.floor(selected / columns) * columns;
      const rowEnd = Math.min(rowStart + columns, cells.length) - 1;
      select(Math.min(Math.max(selected + step.delta, rowStart), rowEnd));
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

function buildCells(catalog: AvatarCatalog): { cells: HTMLButtonElement[]; dispose(): void } {
  const cells: HTMLButtonElement[] = [];
  const images: HTMLImageElement[] = [];
  let disposed = false;
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
    preview.setAttribute("aria-hidden", "true");
    const unavailable = new Set<string>();
    let previewCatalog = catalog;
    const loadPreview = (): void => {
      if (disposed) return;
      const visual = resolveAvatarPreview(skin, previewCatalog, (path) => !unavailable.has(path));
      if (!visual) {
        preview.textContent = "미리보기 없음";
        cell.title = "이미지를 불러오지 못했습니다. 캐릭터 번호로 선택할 수 있습니다.";
        cell.removeAttribute("aria-busy");
        return;
      }
      preview.textContent = "불러오는 중";
      cell.setAttribute("aria-busy", "true");
      const image = new Image();
      images.push(image);
      image.onload = () => {
        if (disposed) return;
        const { manifest, frame, path } = visual;
        const texture = manifest.textures[frame.texture]!;
        if (image.naturalWidth !== texture.width || image.naturalHeight !== texture.height) {
          const entry = catalog.get(skin)!;
          if (manifest !== entry.legacy) {
            previewCatalog = new Map([[skin, { primary: entry.legacy, legacy: entry.legacy }]]);
          } else unavailable.add(path);
          loadPreview();
          return;
        }
        const scale = PREVIEW_PX / Math.max(manifest.displaySize.width, manifest.displaySize.height);
        const width = manifest.displaySize.width * scale;
        const height = manifest.displaySize.height * scale;
        const scaleX = width / frame.rect.width;
        const scaleY = height / frame.rect.height;
        preview.textContent = "";
        preview.style.width = `${width}px`;
        preview.style.height = `${height}px`;
        preview.style.backgroundImage = `url(${JSON.stringify(path)})`;
        preview.style.backgroundSize = `${texture.width * scaleX}px ${texture.height * scaleY}px`;
        preview.style.backgroundPosition = `${-frame.rect.x * scaleX}px ${-frame.rect.y * scaleY}px`;
        cell.removeAttribute("aria-busy");
      };
      image.onerror = () => {
        if (disposed) return;
        unavailable.add(visual.path);
        loadPreview();
      };
      image.src = visual.path;
    };
    loadPreview();
    cell.append(preview);

    cells.push(cell);
  }
  grid.replaceChildren(...cells);
  return { cells, dispose: () => {
    disposed = true;
    for (const image of images) {
      image.onload = null;
      image.onerror = null;
    }
  } };
}
