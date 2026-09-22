import { TILE_SIZE_PX } from "@zep-test/shared";

const REGIONS: Readonly<Record<string, { name: string; kind: string; hint: string }>> = {
  plaza: { name: "남문 마을", kind: "마을 · 시작 지점", hint: "남쪽 성문은 들판, 북쪽 길은 대광장입니다. 성문 옆 길잡이에게 임무를 받고 동쪽 상점에서 준비하세요." },
  "grand-plaza": { name: "대광장", kind: "만남의 공간", hint: "동료와 대화하거나 T를 눌러 다른 지역을 방문하세요." },
  "hunting-ground": { name: "초보 들판", kind: "사냥 지역 · 권장 Lv 1–3", hint: "들판에서 사냥하고 입장권을 얻어 북쪽 바위 사냥굴로 향하세요. 남쪽 문은 남문 마을로 이어집니다." },
  "hunting-den": { name: "바위 사냥굴", kind: "사냥 지역 · 권장 Lv 3–10", hint: "바위 사이의 넓은 길을 따라 사냥하세요. 남쪽 출구는 들판이며 L에서 경험치와 전리품을 확인할 수 있습니다." },
};

/** Scene-owned DOM; each hop removes the old panel and creates the destination's guide. */
export class RegionGuide {
  private readonly root = document.createElement("section");
  private readonly coordinates = document.createElement("span");
  private lastPosition = "";

  constructor(mapKey: string) {
    const region = REGIONS[mapKey] ?? { name: mapKey, kind: "탐험 지역", hint: "T를 눌러 이동할 지역을 확인하세요." };
    this.root.className = "region-guide";
    this.root.setAttribute("aria-label", "현재 지역 안내");
    const label = document.createElement("span");
    label.className = "region-guide__kind";
    label.textContent = region.kind;
    const title = document.createElement("strong");
    title.textContent = region.name;
    this.coordinates.className = "region-guide__coordinates";
    this.coordinates.setAttribute("aria-label", "현재 좌표");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "지역 안내 · 조작법";
    // Keep native disclosure activation; global Enter/Space handlers otherwise open chat/attack.
    summary.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.code === "Space") event.stopPropagation();
    });
    summary.addEventListener("click", event => {
      if (event.detail > 0) summary.blur();
    });
    const hint = document.createElement("p");
    hint.textContent = region.hint;
    const controls = document.createElement("p");
    controls.textContent = "방향키 / WASD 이동 · Space 공격 · Enter 채팅 · I 가방 · L 드랍 정보 · C 캐릭터 · T 지역 이동 · H 귀환";
    const body = document.createElement("div");
    body.className = "region-guide__body";
    body.append(hint, controls);
    details.append(summary, body);
    this.root.append(label, title, this.coordinates, details);
    document.querySelector(".stage")?.append(this.root);
  }

  update(x: number, y: number): void {
    const position = `${Math.round(x / TILE_SIZE_PX - 0.5)}, ${Math.round(y / TILE_SIZE_PX - 1)}`;
    if (position === this.lastPosition) return;
    this.lastPosition = position;
    this.coordinates.textContent = position;
  }

  destroy(): void { this.root.remove(); }
}
