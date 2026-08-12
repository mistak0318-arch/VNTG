/**
 * public/icon.svg 하나로 PWA/파비콘용 PNG·ICO를 생성한다.
 * 아이콘 디자인을 바꾸면 icon.svg만 수정하고 `npm run icons`를 다시 실행하면 된다.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = resolve(root, "public");
const svg = await readFile(resolve(publicDir, "icon.svg"));

const PNG_SIZES = [
  { size: 192, name: "icon-192.png" },
  { size: 512, name: "icon-512.png" },
  { size: 180, name: "apple-touch-icon.png" },
  { size: 64, name: "icon-64.png" },
  { size: 32, name: "icon-32.png" },
];

for (const { size, name } of PNG_SIZES) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(resolve(publicDir, name));
  console.log(`generated ${name} (${size}x${size})`);
}

// favicon.ico는 32/64를 함께 담아 브라우저가 상황에 맞게 고르게 한다
const ico = await pngToIco([resolve(publicDir, "icon-32.png"), resolve(publicDir, "icon-64.png")]);
await writeFile(resolve(publicDir, "favicon.ico"), ico);
console.log("generated favicon.ico");
