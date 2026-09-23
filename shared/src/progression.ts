export type ProgressionRegionId = "buyeo-novice" | "buyeo-rat-cave" | "buyeo-snake-cave" | "buyeo-bear-cave" | "buyeo-deer-cave" | "buyeo-pig-cave" | "buyeo-fox-cave";

export interface ProgressionRegionDescriptor {
  readonly roomId: ProgressionRegionId;
  readonly name: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly theme: "novice" | "rat" | "snake" | "bear" | "deer" | "pig" | "fox";
  readonly monsterKinds: readonly string[];
  readonly color: number;
  readonly itemKeys: readonly string[];
}

export const PROGRESSION_REGIONS: readonly ProgressionRegionDescriptor[] = [
  { roomId: "buyeo-novice", name: "부여 왕초보사냥터", minLevel: 1, maxLevel: 5, theme: "novice", monsterKinds: ["squirrel", "rabbit", "female-deer"], color: 0x83ad58, itemKeys: ["acorn", "rabbit-meat"] },
  { roomId: "buyeo-rat-cave", name: "부여 쥐굴", minLevel: 5, maxLevel: 10, theme: "rat", monsterKinds: ["rat", "bat"], color: 0x948578, itemKeys: ["rat-meat", "bat-meat"] },
  { roomId: "buyeo-snake-cave", name: "부여 뱀굴", minLevel: 10, maxLevel: 15, theme: "snake", monsterKinds: ["snake", "python", "king-python"], color: 0x78915b, itemKeys: ["snake-meat", "good-snake-meat", "strength-helmet-1"] },
  { roomId: "buyeo-bear-cave", name: "부여 곰굴", minLevel: 12, maxLevel: 18, theme: "bear", monsterKinds: ["bear", "pyeongung", "tiger"], color: 0xa4855d, itemKeys: ["bear-hide", "bear-gall", "tiger-hide"] },
  { roomId: "buyeo-deer-cave", name: "부여 사슴굴", minLevel: 17, maxLevel: 23, theme: "deer", monsterKinds: ["blue-deer", "red-deer"], color: 0x73a88a, itemKeys: ["deer-meat"] },
  { roomId: "buyeo-pig-cave", name: "부여 돼지굴", minLevel: 22, maxLevel: 28, theme: "pig", monsterKinds: ["wild-boar", "forest-boar"], color: 0xb79078, itemKeys: ["wild-pork", "forest-pork"] },
  { roomId: "buyeo-fox-cave", name: "부여 여우굴", minLevel: 25, maxLevel: 30, theme: "fox", monsterKinds: ["black-fox", "white-fox", "gumiho"], color: 0xbe8961, itemKeys: ["fox-fur", "square-shield"] },
];

export const PROGRESSION_ITEM_ICON_ORDER: readonly string[] = [
  "wetland-sword", "wetland-dagger", "wetland-staff", "wetland-charm", "wetland-armor", "wetland-helmet", "wetland-boots", "wetland-cloak", "marsh-fiber", "serpent-scale", "swamp-pearl", "marsh-tonic",
  "quarry-sword", "quarry-dagger", "quarry-staff", "quarry-charm", "quarry-armor", "quarry-helmet", "quarry-ring", "quarry-necklace", "iron-ore", "bat-wing", "rough-crystal", "quarry-tonic",
  "frost-sword", "frost-dagger", "frost-staff", "frost-charm", "frost-armor", "frost-helmet", "frost-boots", "frost-cloak", "white-fur", "frost-shard", "ice-heart", "frost-tonic",
  "ruin-sword", "ruin-dagger", "ruin-staff", "ruin-charm", "ruin-armor", "ruin-helmet", "ruin-ring", "ruin-necklace", "ancient-shard", "spirit-dust", "guardian-core", "ruin-tonic",
  "rabbit-meat", "rat-meat", "bat-meat", "snake-meat", "good-snake-meat", "strength-helmet-1", "bear-hide", "bear-gall", "tiger-hide", "deer-meat", "wild-pork", "forest-pork", "fox-fur", "square-shield",
];


export const PROGRESSION_MONSTER_NAMES: Readonly<Record<string, string>> = {"squirrel": "다람쥐", "rabbit": "토끼", "female-deer": "암사슴", "rat": "쥐", "bat": "박쥐", "snake": "뱀", "python": "구렁이", "king-python": "왕구렁이", "bear": "곰", "pyeongung": "평웅", "tiger": "호랑이", "blue-deer": "청순록", "red-deer": "적순록", "wild-boar": "산돼지", "forest-boar": "숲돼지", "black-fox": "흑여우", "white-fox": "백여우", "gumiho": "구미호"};

export interface ProgressionTile { readonly tileX: number; readonly tileY: number }

export interface ProgressionConnection {
  readonly id: string;
  readonly from: { readonly room: string; readonly tiles: readonly ProgressionTile[] };
  readonly to: { readonly room: string; readonly arrival: ProgressionTile & { readonly spreadRadiusInTiles: number } };
  readonly requiresItemKey?: string;
  readonly deniedMessage?: string;
}

export const PROGRESSION_CONNECTIONS: readonly ProgressionConnection[] = [
  { id: "plaza-south-door", from: { room: "plaza", tiles: [{ tileX: 31, tileY: 25 }, { tileX: 32, tileY: 25 }] }, to: { room: "buyeo-novice", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-novice-south-door", from: { room: "buyeo-novice", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] }, to: { room: "plaza", arrival: { tileX: 31, tileY: 23, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-novice-rat-door", from: { room: "buyeo-novice", tiles: [{ tileX: 20, tileY: 8 }, { tileX: 21, tileY: 8 }] }, to: { room: "buyeo-rat-cave", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-rat-cave-south-door", from: { room: "buyeo-rat-cave", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] }, to: { room: "buyeo-novice", arrival: { tileX: 20, tileY: 9, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-novice-bear-door", from: { room: "buyeo-novice", tiles: [{ tileX: 26, tileY: 8 }, { tileX: 27, tileY: 8 }] }, to: { room: "buyeo-bear-cave", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-bear-cave-south-door", from: { room: "buyeo-bear-cave", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] }, to: { room: "buyeo-novice", arrival: { tileX: 26, tileY: 9, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-novice-deer-door", from: { room: "buyeo-novice", tiles: [{ tileX: 36, tileY: 8 }, { tileX: 37, tileY: 8 }] }, to: { room: "buyeo-deer-cave", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-deer-cave-south-door", from: { room: "buyeo-deer-cave", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] }, to: { room: "buyeo-novice", arrival: { tileX: 36, tileY: 9, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-novice-pig-door", from: { room: "buyeo-novice", tiles: [{ tileX: 42, tileY: 8 }, { tileX: 43, tileY: 8 }] }, to: { room: "buyeo-pig-cave", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-pig-cave-south-door", from: { room: "buyeo-pig-cave", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] }, to: { room: "buyeo-novice", arrival: { tileX: 42, tileY: 9, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-novice-fox-door", from: { room: "buyeo-novice", tiles: [{ tileX: 47, tileY: 17 }, { tileX: 47, tileY: 18 }] }, to: { room: "buyeo-fox-cave", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-fox-cave-south-door", from: { room: "buyeo-fox-cave", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] }, to: { room: "buyeo-novice", arrival: { tileX: 46, tileY: 17, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-rat-cave-snake-door", from: { room: "buyeo-rat-cave", tiles: [{ tileX: 47, tileY: 25 }, { tileX: 47, tileY: 26 }] }, to: { room: "buyeo-snake-cave", arrival: { tileX: 31, tileY: 26, spreadRadiusInTiles: 0 } } },
  { id: "buyeo-snake-cave-south-door", from: { room: "buyeo-snake-cave", tiles: [{ tileX: 31, tileY: 27 }, { tileX: 32, tileY: 27 }] }, to: { room: "buyeo-rat-cave", arrival: { tileX: 46, tileY: 25, spreadRadiusInTiles: 0 } } },
];
