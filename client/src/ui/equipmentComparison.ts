import type { InventoryItem } from "../net/inventory";

export interface EquipmentComparisonDescription {
  stats: string;
  baseline: string;
  difference: string;
}

const format = (value: number): string => Number(value.toFixed(4)).toLocaleString("ko-KR", { maximumFractionDigits: 4 });
const signed = (value: number): string => `${value > 0 ? "+" : ""}${format(value)}`;

export function describeEquipmentComparison(
  item: Pick<InventoryItem, "name" | "equipped" | "equipment">,
  current: Pick<InventoryItem, "name" | "equipped" | "equipment"> | null | undefined,
): EquipmentComparisonDescription {
  const stats = item.equipment
    ? `장비 공격력 +${format(item.equipment.attackDamage)} · 피해 감소 ${format(item.equipment.damageReduction * 100)}%`
    : "장비 수치 정보 없음";
  if (item.equipped) return { stats, baseline: "현재 장착 중", difference: "" };
  const baseline = current === null ? "비교: 빈 슬롯" : current ? `비교: ${current.name}` : "비교 장비 확인 필요";
  if (!item.equipment || current === undefined || (current !== null && !current.equipment)) {
    return { stats, baseline, difference: "비교 수치 정보 없음" };
  }
  return {
    stats,
    baseline,
    difference: `공격력 ${signed(item.equipment.attackDamage - (current?.equipment?.attackDamage ?? 0))} · 피해 감소 ${signed((item.equipment.damageReduction - (current?.equipment?.damageReduction ?? 0)) * 100)}%p`,
  };
}
