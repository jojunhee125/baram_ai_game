import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLegacyAvatarManifests, validateAvatarManifest } from "../shared/src/avatarManifest";
import type { AvatarSize } from "../shared/src/avatarManifest";

const ASSETS_DIR = fileURLToPath(new URL("../assets", import.meta.url));

function readPngSize(path: string): AvatarSize {
  const bytes = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${path}: expected a PNG with an IHDR header`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1]?.trim())) {
    throw new Error("usage: npx tsx tools/avatar-manifest.ts [--output <path>]");
  }
  const manifests = createLegacyAvatarManifests();
  const pngSizes = new Map<string, AvatarSize>();
  const errors: string[] = [];
  for (const manifest of manifests) {
    errors.push(...validateAvatarManifest(manifest).map((error) => `skin ${manifest.skinId}: ${error}`));
    for (const [key, texture] of Object.entries(manifest.textures)) {
      let actual = pngSizes.get(texture.path);
      if (!actual) {
        actual = readPngSize(resolve(ASSETS_DIR, `.${texture.path}`));
        pngSizes.set(texture.path, actual);
      }
      if (actual.width !== texture.width || actual.height !== texture.height) {
        errors.push(`skin ${manifest.skinId} texture ${key}: expected ${texture.width}x${texture.height}, got ${actual.width}x${actual.height}`);
      }
      for (const [frameId, frame] of Object.entries(manifest.frames)) {
        if (frame.texture === key
          && (frame.rect.x + frame.rect.width > actual.width || frame.rect.y + frame.rect.height > actual.height)) {
          errors.push(`skin ${manifest.skinId} frame ${frameId}: rect exceeds actual PNG bounds`);
        }
      }
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  if (args[1]) {
    writeFileSync(resolve(args[1]), `${JSON.stringify(manifests, null, 2)}\n`, "utf8");
  }
  console.log(`Validated ${manifests.length} avatar manifests and ${pngSizes.size} PNG textures.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
