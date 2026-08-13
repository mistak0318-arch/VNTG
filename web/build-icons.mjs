/**
 * public/icon.svg 하나에서 파비콘·PWA 아이콘을 전부 만들어낸다.
 *
 * 아이콘을 바꿀 때마다 여러 크기의 PNG를 손으로 맞추면 반드시 하나가 어긋난다.
 * 원본은 SVG 하나만 고치고 이 스크립트를 돌린다.
 *
 *   node build-icons.mjs
 */
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";

const svg = readFileSync("public/icon.svg");

/** density를 높게 줘야 작은 크기에서 획이 뭉개지지 않는다 */
const png = (size) => sharp(svg, { density: 1200 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

const targets = [
  ["public/icon-32.png", 32],
  ["public/icon-64.png", 64],
  ["public/icon-192.png", 192],
  ["public/icon-512.png", 512],
  ["public/apple-touch-icon.png", 180],
];

for (const [path, size] of targets) {
  writeFileSync(path, await png(size));
  console.log(`${path} (${size}px)`);
}

/**
 * favicon.ico — PNG를 담은 멀티사이즈 ICO.
 *
 * ICO는 컨테이너일 뿐이라 안에 PNG를 그대로 넣을 수 있다(Vista 이후 표준).
 * 헤더 6바이트 + 항목당 16바이트 디렉터리 + 이미지 데이터 순서다.
 */
const icoSizes = [16, 32, 48];
const images = await Promise.all(icoSizes.map((s) => png(s)));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = 아이콘
header.writeUInt16LE(icoSizes.length, 4);

let offset = 6 + 16 * icoSizes.length;
const entries = icoSizes.map((size, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // 0은 256을 뜻한다
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // 팔레트 색 수 (트루컬러라 0)
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});

writeFileSync("public/favicon.ico", Buffer.concat([header, ...entries, ...images]));
console.log(`public/favicon.ico (${icoSizes.join("/")}px)`);
