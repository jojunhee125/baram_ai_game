import { Canvas, SCALE, SRC_TILE, upscale } from "./png.mjs";

const ORIGINAL_KINDS = [
  "female-deer", "rat", "bat", "snake", "python", "king-python", "bear", "pyeongung", "tiger",
  "blue-deer", "red-deer", "wild-boar", "forest-boar", "black-fox", "white-fox", "gumiho",
];

export const PROGRESSION_KINDS = [
  "marsh-slime", "reed-serpent", "cave-bat", "rock-boar",
  "snow-wolf", "frost-golem", "ruin-sentinel", "cursed-flame",
  ...ORIGINAL_KINDS,
];

const PALETTES = [
  ["#25382d", "#6f9a58", "#c2d798", "#466346"],
  ["#352b32", "#b98959", "#f0c989", "#71533f"],
  ["#293c53", "#77b9ce", "#e5f3e9", "#50718e"],
  ["#332a46", "#aa86cc", "#ead7b2", "#65547e"],
];

function painter(canvas, palette) {
  const colors = palette.map(color => [1, 3, 5].map(at => Number.parseInt(color.slice(at, at + 2), 16)));
  return (x, y, color) => {
    if (x < 0 || x >= SRC_TILE || y < 0 || y >= SRC_TILE) return;
    const at = canvas.at(x, y);
    for (let i = 0; i < 3; i++) canvas.data[at + i] = colors[color][i];
    canvas.data[at + 3] = 255;
  };
}

export function renderProgressionMonster(kind, direction, step) {
  if (ORIGINAL_KINDS.includes(kind)) return renderOriginalMonster(kind, direction, step);
  const index = PROGRESSION_KINDS.indexOf(kind);
  if (index < 0) throw new Error(`Unknown progression monster ${kind}`);
  const canvas = new Canvas(SRC_TILE, SRC_TILE);
  const pixel = painter(canvas, PALETTES[Math.floor(index / 2)]);
  const phase = step === "stepA" ? -1 : step === "stepB" ? 1 : 0;
  const bob = step === "stepB" ? -1 : 0;
  const mask = (x, y) => {
    const dx = x - 7.5;
    switch (kind) {
      case "marsh-slime": return y >= 6 && y <= 14 && dx * dx / 40 + (y - 11) ** 2 / 32 < 1;
      case "reed-serpent": return (y >= 2 && y <= 6 && x >= 7 && x <= 12) ||
        (y >= 5 && y <= 11 && Math.abs(x - (10 - (y - 5) * 0.7)) < 2) ||
        (y >= 11 && y <= 14 && x >= 2 && x <= 11);
      case "cave-bat": return (x >= 6 && x <= 9 && y >= 5 && y <= 13) ||
        (y >= 4 + Math.abs(dx) * 0.5 + phase && y <= 12 - Math.abs(dx) * 0.25 && Math.abs(dx) <= 7) ||
        ((x === 6 || x === 9) && y === 3);
      case "rock-boar": return (dx * dx / 42 + (y - 9) ** 2 / 22 < 1) ||
        (y >= 12 && y <= 14 && (x === 4 + phase || x === 10 - phase)) ||
        (y >= 3 && y <= 5 && (x === 4 || x === 10));
      case "snow-wolf": return (x >= 5 && x <= 11 && y >= 6 && y <= 11) ||
        (x >= 3 && x <= 9 && y >= 3 && y <= 7) ||
        ((x === 3 || x === 8) && y >= 1 && y <= 3) ||
        (x >= 11 && x <= 14 && y >= 7 && y <= 9) ||
        (y >= 11 && y <= 14 && (x === 5 + phase || x === 10 - phase));
      case "frost-golem": return (x >= 5 && x <= 10 && y >= 1 && y <= 4) ||
        (x >= 3 && x <= 12 && y >= 5 && y <= 11) ||
        (y >= 6 && y <= 11 && (x === 1 || x === 14)) ||
        (y >= 12 && y <= 14 && ((x >= 3 + phase && x <= 5 + phase) || (x >= 9 - phase && x <= 11 - phase)));
      case "ruin-sentinel": return (x >= 5 && x <= 10 && y >= 1 && y <= 5) ||
        (x >= 4 && x <= 11 && y >= 6 && y <= 10) ||
        (x === 13 && y >= 2 && y <= 13) || (x >= 1 && x <= 2 && y >= 6 && y <= 10) ||
        (y >= 11 && y <= 14 && (x === 5 + phase || x === 10 - phase));
      case "cursed-flame": return (dx * dx / 27 + (y - 10) ** 2 / 30 < 1) ||
        (y >= 1 && y <= 7 && x >= 7 - Math.floor(y / 3) && x <= 8 + Math.floor(y / 4)) ||
        (y >= 5 + phase && y <= 11 && (x === 2 || x === 12));
      default: return false;
    }
  };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (!mask(x, y)) continue;
    const edge = !mask(x - 1, y) || !mask(x + 1, y) || !mask(x, y - 1) || !mask(x, y + 1);
    pixel(direction === "right" ? 15 - x : x, y + bob,
      edge ? 0 : (x + y) % 7 === 0 ? 2 : x < 7 ? 1 : 3);
  }
  const faceX = direction === "left" ? 3 : direction === "right" ? 10 : 6;
  const faceY = (kind === "marsh-slime" ? 10 : kind === "reed-serpent" ? 4 : 7) + bob;
  if (direction === "up") {
    pixel(7, faceY - 2, 2); pixel(8, faceY - 1, 2); pixel(8, faceY, 3);
  } else {
    pixel(faceX, faceY, 2); pixel(faceX + 3, faceY, 2);
    pixel(faceX, faceY + 1, 0); pixel(faceX + 3, faceY + 1, 0);
  }
  if (phase !== 0) {
    pixel(phase < 0 ? 4 : 11, 15, 3);
    pixel(phase < 0 ? 5 : 10, 15, 0);
  }
  return upscale(canvas, SCALE);
}

export function renderProgressionItem(key, index) {
  if (index >= 48) return renderOriginalItem(key);
  const tier = key.startsWith("wetland-") || ["marsh-fiber", "serpent-scale", "swamp-pearl", "marsh-tonic"].includes(key) ? 0
    : key.startsWith("quarry-") || ["iron-ore", "bat-wing", "rough-crystal"].includes(key) ? 1
    : key.startsWith("frost-") || ["white-fur", "ice-heart"].includes(key) ? 2 : 3;
  const canvas = new Canvas(SRC_TILE, SRC_TILE);
  const pixel = painter(canvas, PALETTES[tier]);
  const rect = (x, y, width, height, color) => {
    for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) pixel(col, row, color);
  };
  const box = (x, y, width, height) => { rect(x, y, width, height, 0); rect(x + 1, y + 1, width - 2, height - 2, 1); };
  if (key.endsWith("-sword") || key.endsWith("-dagger")) {
    const top = key.endsWith("-dagger") ? 5 : 1;
    rect(7, top, 3, 10 - top, 0); rect(8, top + 1, 1, 9 - top, 2);
    rect(4, 10, 9, 2, 0); rect(5, 10, 7, 1, 1); rect(7, 12, 3, 3, 0); pixel(8, 13, 1);
  } else if (key.endsWith("-staff")) {
    rect(7, 4, 3, 11, 0); rect(8, 6, 1, 8, 1); box(5, 1, 7, 6); rect(7, 2, 3, 3, 2);
  } else if (key.endsWith("-charm")) {
    box(4, 2, 9, 11); rect(5, 3, 7, 9, 2); rect(7, 4, 2, 6, 1); rect(6, 6, 5, 1, 3);
    rect(6, 13, 1, 2, 1); rect(10, 13, 1, 2, 1);
  } else if (key.endsWith("-armor")) {
    box(4, 3, 8, 11); box(1, 4, 4, 5); box(11, 4, 4, 5); rect(6, 2, 4, 3, 0);
    rect(5, 6, 6, 1, 2); rect(7, 7, 2, 6, 3);
  } else if (key.endsWith("-helmet")) {
    box(3, 4, 10, 9); box(5, 2, 6, 4); rect(5, 8, 6, 3, 0); rect(7, 7, 2, 6, 2);
  } else if (key.endsWith("-boots")) {
    box(2, 3, 4, 10); box(9, 3, 4, 10); box(2, 11, 6, 3); box(9, 11, 6, 3);
    rect(3, 5, 2, 2, 2); rect(10, 5, 2, 2, 2);
  } else if (key.endsWith("-cloak")) {
    for (let y = 2; y < 14; y++) { const half = 2 + Math.floor(y / 4); rect(8 - half, y, half * 2, 1, 0); rect(9 - half, y, half * 2 - 2, 1, 1); }
    rect(7, 3, 2, 3, 2); rect(7, 7, 1, 6, 3);
  } else if (key.endsWith("-ring")) {
    for (let y = 5; y < 14; y++) for (let x = 3; x < 13; x++) {
      const r = (x - 7.5) ** 2 + (y - 9) ** 2;
      if (r >= 6 && r <= 20) pixel(x, y, r >= 14 ? 0 : 1);
    }
    box(5, 2, 6, 5); rect(7, 3, 2, 2, 2);
  } else if (key.endsWith("-necklace")) {
    for (let y = 2; y < 11; y++) { pixel(3 + Math.floor(y / 3), y, 2); pixel(12 - Math.floor(y / 3), y, 1); }
    box(5, 9, 6, 6); rect(7, 10, 2, 3, 2);
  } else if (key.endsWith("-tonic")) {
    box(5, 1, 6, 4); box(3, 5, 10, 10); rect(4, 6, 8, 3, 2); rect(7, 10, 2, 3, 2);
  } else if (["marsh-fiber", "iron-ore", "white-fur", "ancient-shard"].includes(key)) {
    for (let i = 0; i < 4; i++) { box(2 + i * 2, 3 + i % 2, 4, 10); pixel(3 + i * 2, 5, 2); }
  } else if (["serpent-scale", "bat-wing", "frost-shard", "spirit-dust"].includes(key)) {
    for (let y = 2; y < 14; y++) { const half = 6 - Math.abs(y - 8); if (half > 0) { rect(8 - half, y, half * 2, 1, 0); rect(9 - half, y, half * 2 - 2, 1, 1); } }
    rect(7, 5, 2, 6, 2);
  } else {
    for (let y = 3; y < 14; y++) for (let x = 3; x < 14; x++) {
      const r = (x - 8) ** 2 + (y - 8) ** 2;
      if (r <= 26) pixel(x, y, r > 17 ? 0 : x < 8 ? 2 : 1);
    }
    pixel(10, 10, 3);
  }
  return upscale(canvas, SCALE);
}

const ANIMAL_PALETTES = {
  "female-deer": ["#34271e", "#b88a55", "#ead3a2", "#775637"],
  rat: ["#302823", "#927963", "#d6b29c", "#635445"],
  bat: ["#302738", "#706179", "#c8b8bc", "#493f56"],
  snake: ["#2a3525", "#82944e", "#d5d99a", "#506038"],
  python: ["#3e3021", "#b2954d", "#e4ce84", "#74613a"],
  "king-python": ["#422724", "#a4613c", "#e9bf65", "#703e32"],
  bear: ["#2d251f", "#78553a", "#c2a078", "#4e3c2d"],
  pyeongung: ["#26292a", "#5f6260", "#b6b59c", "#414747"],
  tiger: ["#342820", "#c18b45", "#e3c892", "#67462c"],
  "blue-deer": ["#283639", "#658c90", "#c2d5c1", "#466366"],
  "red-deer": ["#3c2924", "#a55f46", "#dcb994", "#704335"],
  "wild-boar": ["#302924", "#786249", "#d0bb95", "#524436"],
  "forest-boar": ["#363025", "#998264", "#e0c7a0", "#69553e"],
  "black-fox": ["#28272b", "#5d5860", "#c5bdb0", "#413e46"],
  "white-fox": ["#494b49", "#cecdb7", "#eee5c6", "#92988e"],
  gumiho: ["#453832", "#ceb992", "#f0dfbb", "#998061"],
};

function renderOriginalMonster(kind, direction, step) {
  const canvas = new Canvas(SRC_TILE, SRC_TILE);
  const pixel = painter(canvas, ANIMAL_PALETTES[kind]);
  const phase = step === "stepA" ? -1 : step === "stepB" ? 1 : 0;
  const bob = step === "stepB" ? -1 : 0;
  const deer = kind.endsWith("-deer"), serpent = ["snake", "python", "king-python"].includes(kind);
  const fox = kind.endsWith("-fox") || kind === "gumiho";
  const boar = kind.endsWith("-boar"), bear = kind === "bear" || kind === "pyeongung";
  const ellipse = (x, y, cx, cy, rx, ry) => (x - cx) ** 2 / rx ** 2 + (y - cy) ** 2 / ry ** 2 <= 1;
  const mask = (x, y) => {
    if (kind === "rat") return ellipse(x,y,7,10,5,3) || ellipse(x,y,4,7,3,3) ||
      ellipse(x,y,3,4,1.5,1.5) || (x >= 10 && x <= 14 && y === 11 - Math.floor((x - 10) / 2)) ||
      (y >= 12 && y <= 14 && (x === 4 + phase || x === 10 - phase));
    if (kind === "bat") return ellipse(x,y,7.5,9,2,4) || ((x === 6 || x === 9) && y >= 3 && y <= 5) ||
      (x >= 1 && x <= 14 && y >= 4 + Math.abs(x - 7.5) * 0.45 + phase && y <= 12 - Math.abs(x - 7.5) * 0.4);
    if (serpent) return ellipse(x,y,8,11,6,3) || ellipse(x,y,9,5,kind === "king-python" ? 4 : 2.5,3) ||
      (x >= 8 && x <= 10 && y >= 5 && y <= 11) || (kind === "king-python" && y === 1 && x >= 7 && x <= 11);
    if (deer) return ellipse(x,y,8,9,4,3) || ellipse(x,y,4,5,2,3) ||
      (x >= 4 && x <= 5 && y >= 6 && y <= 11) || (y >= 11 && y <= 14 && (x === 5 + phase || x === 10 - phase)) ||
      (kind === "female-deer" ? ((x === 2 || x === 6) && y === 2) :
        (y <= 3 && y >= 0 && ((x === 2 || x === 6) || (y === 1 && (x === 1 || x === 7)))));
    if (bear) return ellipse(x,y,8,10,5,4) || ellipse(x,y,7.5,5,4,3) ||
      ((x === 4 || x === 11) && y >= 1 && y <= 3) ||
      (y >= 12 && y <= 14 && ((x >= 3 + phase && x <= 5 + phase) || (x >= 10 - phase && x <= 12 - phase)));
    if (boar) return ellipse(x,y,8,9,6,4) || (x >= 1 && x <= 5 && y >= 7 && y <= 10) ||
      ((x === 4 || x === 9) && y >= 3 && y <= 5) || (y >= 12 && y <= 14 && (x === 4 + phase || x === 11 - phase)) ||
      (kind === "wild-boar" && x >= 3 && x <= 6 && y === 11);
    if (fox) return ellipse(x,y,7,10,3.5,3) || ellipse(x,y,4.5,6,2.5,2) ||
      ((x === 3 || x === 6) && y >= 2 && y <= 4) ||
      ellipse(x,y,11,7,3,kind === "gumiho" ? 5 : 3) ||
      (kind === "gumiho" && x >= 8 && x <= 14 && y >= 1 && y <= 9 && (x + y) % 3 !== 0) ||
      (y >= 12 && y <= 14 && (x === 5 + phase || x === 9 - phase));
    return ellipse(x,y,8,9,5,3) || ellipse(x,y,4,5,3,3) ||
      ((x === 2 || x === 6) && y >= 1 && y <= 3) ||
      (x >= 12 && x <= 14 && y === 6) || (y >= 11 && y <= 14 && (x === 4 + phase || x === 11 - phase));
  };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (!mask(x,y)) continue;
    const edge = !mask(x-1,y) || !mask(x+1,y) || !mask(x,y-1) || !mask(x,y+1);
    let color = edge ? 0 : x < 8 ? 1 : 3;
    if (kind === "tiger" && x % 3 === 0 && y >= 6 && y <= 10) color = 0;
    if (serpent && y >= 10 && (x + y) % 4 === 0) color = 2;
    if (deer && y >= 8 && y <= 10 && x % 3 === 0) color = 2;
    if (fox && x >= 12) color = 2;
    if (bear && y === 8 && x >= 5 && x <= 10) color = 2;
    pixel(direction === "right" ? 15-x : x, y+bob, color);
  }
  const faceX = serpent ? 8 : bear ? 6 : kind === "bat" ? 6 : 3;
  const faceY = (boar ? 8 : kind === "rat" ? 6 : 5) + bob;
  const put = (x,y,c) => pixel(direction === "right" ? 15-x : x,y,c);
  if (direction === "up") { put(faceX,faceY,3); put(faceX+1,faceY+1,1); put(faceX+2,faceY,3); }
  else if (direction === "down") { put(faceX,faceY,2); put(faceX+2,faceY,2); put(faceX,faceY+1,0); put(faceX+2,faceY+1,0); }
  else { put(faceX,faceY,2); put(faceX,faceY+1,0); put(faceX-1,faceY+2,0); }
  if (phase) { put(phase < 0 ? 4 : 10,14,3); put(phase < 0 ? 5 : 11,14,0); }
  return upscale(canvas, SCALE);
}

const ORIGINAL_ITEM_COLORS = {
  "rabbit-meat": ["#49332c", "#be826f", "#ecd1ac", "#925644"],
  "rat-meat": ["#42312b", "#9b725f", "#d2b89c", "#74503f"],
  "bat-meat": ["#3b2d37", "#8e6374", "#c5a3a9", "#604451"],
  "snake-meat": ["#3d422f", "#91a36f", "#d3d8a3", "#687849"],
  "good-snake-meat": ["#494029", "#bba75d", "#ead898", "#877442"],
  "strength-helmet-1": ["#39342d", "#a89462", "#e4ce8c", "#706448"],
  "bear-hide": ["#332820", "#82613f", "#b7996c", "#58422c"],
  "bear-gall": ["#343926", "#778345", "#c7ca83", "#505c31"],
  "tiger-hide": ["#352b22", "#bf914a", "#e3c58a", "#6b4b2a"],
  "deer-meat": ["#493229", "#b97556", "#e4bc96", "#865039"],
  "wild-pork": ["#46302b", "#a97564", "#dec4a3", "#764d40"],
  "forest-pork": ["#4e382e", "#c99473", "#efcfac", "#946047"],
  "fox-fur": ["#42352e", "#bd9d71", "#e9d5ae", "#887250"],
  "square-shield": ["#323a39", "#83978b", "#ced9b6", "#566c61"],
};

function renderOriginalItem(key) {
  const palette = ORIGINAL_ITEM_COLORS[key];
  if (!palette) throw new Error(`Unknown original item ${key}`);
  const canvas = new Canvas(SRC_TILE, SRC_TILE);
  const pixel = painter(canvas, palette);
  const rect = (x,y,w,h,c) => { for(let row=y;row<y+h;row++) for(let col=x;col<x+w;col++) pixel(col,row,c); };
  if (key.endsWith("meat") || key.endsWith("pork")) {
    for(let y=4;y<13;y++) for(let x=3;x<13;x++) {
      const r = (x-7.5)**2/24 + (y-8)**2/17;
      if(r<=1) pixel(x,y,r>0.65?0:x<7?1:3);
    }
    rect(6,6,4,4,2); rect(7,7,2,2,1);
    if(key.includes("snake")) { rect(4,3,7,2,1); rect(6,11,5,2,2); }
    if(key.endsWith("pork")) { rect(3,7,4,2,2); rect(10,8,3,2,2); }
  } else if(key.endsWith("hide") || key === "fox-fur") {
    for(let y=2;y<14;y++) { const half = y<5 || y>10 ? 5 : 3; rect(8-half,y,half*2,1,0); rect(9-half,y,half*2-2,1,1); }
    rect(7,4,2,8,2);
    if(key === "tiger-hide") for(let y=4;y<13;y+=3) { rect(4,y,3,1,0);rect(9,y+1,3,1,0); }
    if(key === "fox-fur") { rect(6,12,4,3,2);rect(3,2,2,2,2); }
  } else if(key === "bear-gall") {
    rect(8,1,2,4,0);rect(9,2,1,4,2);
    for(let y=5;y<14;y++) for(let x=4;x<12;x++) if((x-7.5)**2/14+(y-9)**2/20<=1) pixel(x,y,x<6?2:x>9?0:1);
  } else if(key === "strength-helmet-1") {
    rect(3,5,10,8,0);rect(5,2,6,3,0);rect(4,5,8,6,1);rect(6,3,4,3,2);
    rect(5,8,6,2,0);rect(7,6,2,7,2);rect(2,12,12,2,3);
  } else if(key === "square-shield") {
    rect(2,2,12,13,0);rect(3,3,10,11,2);rect(4,4,8,9,1);rect(7,5,2,7,3);rect(5,7,6,2,3);
    pixel(4,4,0);pixel(11,4,0);pixel(4,12,0);pixel(11,12,0);
  }
  return upscale(canvas, SCALE);
}
