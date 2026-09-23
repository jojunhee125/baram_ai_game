import { PROGRESSION_REGIONS } from "./progression";

export interface LandmarkDescriptor {
  id: string;
  name: string;
  room: string;
}

export const LANDMARK_DEFINITIONS: readonly LandmarkDescriptor[] = [
  { id: "landmark-plaza", name: "남문 마을", room: "plaza" },
  { id: "landmark-grand-plaza", name: "대광장", room: "grand-plaza" },
  ...PROGRESSION_REGIONS.map((region) => ({ id: `landmark-${region.roomId}`, name: `${region.name} · 권장 Lv ${region.minLevel}–${region.maxLevel}`, room: region.roomId })),
];
