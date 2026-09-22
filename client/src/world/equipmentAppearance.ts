import Phaser from "phaser";
import { Direction } from "@zep-test/shared";
import type { AvatarAttachmentFrame } from "./avatarArt";

export const EQUIPMENT_SWING_MS = 180;
export const WEAPON_APPEARANCE_KEYS = ["old-dagger", "hunting-blade", "iron-blade"] as const;
export const ARMOR_APPEARANCE_KEYS = ["leather-armor", "padded-armor", "reinforced-armor"] as const;

const WEAPONS: Record<string, readonly string[]> = {
  "old-dagger": [
    "...o...", "..oso..", "..oso..", "..oso..", "..oso..", "..omo..", "..omo..",
    ".ooooo.", ".gbbbg.", "..obo..", "..obo..", "..obo..", "..ogo..", "...o...",
  ],
  "hunting-blade": [
    ".....o.", "....oso", "...osso", "..osmso", "..osmso", "..osmso", "..osmso",
    "..osmso", "..osmso", "..osmso", "..ommo.", ".ooooo.", "ogbbbgo", "..obo..",
    "..obo..", "..obo..", "..obo..", "..ogo..", "...o...",
  ],
  "iron-blade": [
    "....o....", "...oso...", "..ossmo..", "..ossmo..", "..ossmo..", "..ossmo..",
    "..ossmo..", "..ossmo..", "..ossmo..", "..ossmo..", "..ossmo..", "..ossmo..",
    "..ossmo..", "..ommmo..", ".ooooooo.", "oggbbbggo", "...obo...", "...obo...",
    "...obo...", "...obo...", "...ogo...", "....o....",
  ],
};

const ARMOR_FRONT = [
  "....ooo.....ooo....", "..ooahao...oahaoo..", ".oahaaaao.oaaaahao.", ".oaaaaaaaoaaaaaaao.",
  "..oaaasaaasaaao...", "...oaasaaasaao....", "...oaaasaaasao....", "...oaaasaaasao....",
  "...oaasaaasaao....", "...obbbbgbbbbo....", "...obbbggbbbbo....", "...oaaaa.aaaao....", "....oooo.oooo.....",
];
const ARMOR_BACK = [
  "....oooooooooo....", "..ooahaaaaaahaoo..", ".oahaaaaasaaaahao.", ".oaaaaaaasaaaaaao.",
  "..oaaasaaasaaao...", "...oaasaaasaao....", "...oaaasaaasao....", "...oaaasaaasao....",
  "...oaasaaasaao....", "...obbbbgbbbbo....", "...obbbbbbbbbo....", "...oaaaa.aaaao....", "....oooo.oooo.....",
];
const ARMOR_SIDE = [
  "...oooo....", "..oahhao...", ".oahaaaao..", ".oaaaaaao..", "..oasaao...", "..oaasao...",
  "..oasaao...", "..oaasao...", "..oasaao...", "..obbbgo...", "..obbbbo...",
  "..oaaaao...", "...oooo....",
];

const ARMOR_PALETTES: Record<string, Record<string, string>> = {
  "leather-armor": { o: "#382b22", a: "#8a593b", h: "#bc8154", s: "#70452f", b: "#53392b", g: "#caa361" },
  "padded-armor": { o: "#293640", a: "#586e7c", h: "#94a8aa", s: "#3d505f", b: "#3b4244", g: "#c4b282" },
  "reinforced-armor": { o: "#30353c", a: "#818e94", h: "#c9d3ca", s: "#4d5b65", b: "#564737", g: "#d0af6d" },
};
const WEAPON_PALETTE = { o: "#34343b", s: "#e0e5d7", m: "#8d9ba3", b: "#75513b", g: "#c4a36b" };
const DIRECTIONS = [Direction.Down, Direction.Left, Direction.Right, Direction.Up] as const;
const textureKey = (kind: string, key: string, facing?: Direction): string => `equipment:${kind}:${key}${facing === undefined ? "" : `:${facing}`}`;

function drawTexture(scene: Phaser.Scene, key: string, rows: readonly string[], palette: Record<string, string>): void {
  if (scene.textures.exists(key)) return;
  const texture = scene.textures.createCanvas(key, Math.max(...rows.map((row) => row.length)), rows.length);
  if (!texture) throw new Error(`Could not create equipment texture ${key}`);
  rows.forEach((row, y) => [...row].forEach((pixel, x) => {
    const color = palette[pixel];
    if (!color) return;
    texture.context.fillStyle = color;
    texture.context.fillRect(x, y, 1, 1);
  }));
  texture.refresh();
  texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
}

function prepareTextures(scene: Phaser.Scene): void {
  for (const [key, rows] of Object.entries(WEAPONS)) drawTexture(scene, textureKey("weapon", key), rows, WEAPON_PALETTE);
  for (const [key, palette] of Object.entries(ARMOR_PALETTES)) {
    for (const facing of DIRECTIONS) {
      let rows = facing === Direction.Down ? ARMOR_FRONT : facing === Direction.Up ? ARMOR_BACK : ARMOR_SIDE;
      if (facing === Direction.Left) rows = rows.map((row) => [...row].reverse().join(""));
      if (key === "leather-armor") rows = rows.map((row) => row.replaceAll("s", "a"));
      if (key === "reinforced-armor") rows = rows.map((row, y) => y === 3 || y === 8 ? row.replaceAll("s", "g") : row);
      drawTexture(scene, textureKey("armor", key, facing), rows, palette);
    }
  }
}

export class EquipmentAppearance {
  private readonly armor: Phaser.GameObjects.Sprite;
  private readonly weapon: Phaser.GameObjects.Sprite;
  private weaponKey = "";
  private armorKey = "";
  private attackAt = Number.NEGATIVE_INFINITY;
  private attackFacing: Direction = Direction.Down;

  constructor(private readonly scene: Phaser.Scene, sessionId: string) {
    prepareTextures(scene);
    this.armor = scene.add.sprite(0, 0, "__DEFAULT").setName(`equipment:armor:${sessionId}`).setVisible(false);
    this.weapon = scene.add.sprite(0, 0, "__DEFAULT").setName(`equipment:weapon:${sessionId}`).setVisible(false);
  }

  setEquipment(weaponItemKey: string, armorItemKey: string): void {
    const weaponKey = Object.hasOwn(WEAPONS, weaponItemKey) ? weaponItemKey : "";
    if (weaponKey !== this.weaponKey) this.attackAt = Number.NEGATIVE_INFINITY;
    this.weaponKey = weaponKey;
    this.armorKey = Object.hasOwn(ARMOR_PALETTES, armorItemKey) ? armorItemKey : "";
    this.weapon.setVisible(weaponKey.length > 0);
    this.armor.setVisible(this.armorKey.length > 0);
  }

  attack(facing: Direction): void {
    if (!this.weaponKey) return;
    this.attackAt = this.scene.time.now;
    this.attackFacing = facing;
  }

  cancelSwing(): void {
    this.attackAt = Number.NEGATIVE_INFINITY;
  }

  sync(base: Phaser.GameObjects.Sprite, facing: Direction, visual: AvatarAttachmentFrame | null, depthStep = 0.01): void {
    if (!visual) {
      this.armor.setVisible(false);
      this.weapon.setVisible(false);
      return;
    }
    const scale = base.displayHeight / 48;
    const headToFoot = base.displayHeight * base.originY;
    const walking = visual.action === "walk";
    const bob = walking && visual.frameIndex % 2 === 1 ? -scale : 0;
    const attackProgress = (this.scene.time.now - this.attackAt) / EQUIPMENT_SWING_MS;
    const attacking = attackProgress >= 0 && attackProgress < 1;
    const direction = attacking ? this.attackFacing : facing;
    const nativeAdventurer = visual.frame.texture === "baram-adventurer";
    const torsoRatio = nativeAdventurer && facing === Direction.Up ? 0.45
      : nativeAdventurer && facing !== Direction.Down ? 0.5 : 0.53;
    const handRatio = nativeAdventurer && direction === Direction.Up ? 0.7 : 0.76;
    const place = (layer: Phaser.GameObjects.Sprite, x: number, y: number, angle: number, depth: number): void => {
      const cosine = Math.cos(base.rotation);
      const sine = Math.sin(base.rotation);
      layer.setPosition(base.x + x * cosine - y * sine, base.y + x * sine + y * cosine);
      layer.setScale(scale).setAngle(base.angle + angle).setDepth(base.depth + depth);
      layer.setAlpha(base.alpha).setFlip(base.flipX, base.flipY).setTint(base.tintTopLeft);
    };
    this.armor.setVisible(base.active && base.visible && this.armorKey.length > 0);
    this.weapon.setVisible(base.active && base.visible && this.weaponKey.length > 0);
    if (this.armorKey) {
      this.armor.setTexture(textureKey("armor", this.armorKey, facing)).setOrigin(0.5, 0);
      place(this.armor, 0, base.displayHeight * torsoRatio - headToFoot + bob, 0, depthStep);
    }
    if (this.weaponKey) {
      const side = direction === Direction.Left || direction === Direction.Up ? -1 : 1;
      const handX = (direction === Direction.Up || direction === Direction.Down ? 10 : 6) * side * scale;
      const reach = attacking ? Math.sin(attackProgress * Math.PI) * 3 * scale : 0;
      const angle = side * (attacking ? -65 + attackProgress * 145 : direction === Direction.Down || direction === Direction.Up ? 12 : 30);
      this.weapon.setTexture(textureKey("weapon", this.weaponKey)).setOrigin(0.5, 0.82);
      place(this.weapon, handX + side * reach, base.displayHeight * handRatio - headToFoot + bob, angle, direction === Direction.Up ? -depthStep : depthStep * 2);
    }
  }

  destroy(): void {
    this.armor.destroy();
    this.weapon.destroy();
  }
}
