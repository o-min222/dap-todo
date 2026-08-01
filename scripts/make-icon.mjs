/**
 * icon.png 생성기 (한 번 돌리고 결과물을 커밋한다).
 *   node scripts/make-icon.mjs
 *
 * 이미지 라이브러리를 받지 않으려고 PNG를 직접 만든다 — node:zlib만 쓴다.
 * DAP 래디얼은 52px 원형에 여백 없이 그리므로 full-bleed 정사각형으로 뽑는다
 * (docs/APP_ICON_GUIDE.md).
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

const SIZE = 512;
const BG = [59, 130, 246]; // --accent와 같은 파랑
const FG = [255, 255, 255];

/** 선분까지의 거리 — 체크마크를 두 획으로 긋는다. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    // 체크마크: (140,270) → (215,345) → (375,180)
    const d = Math.min(
      distToSegment(x, y, 140, 270, 215, 345),
      distToSegment(x, y, 215, 345, 375, 180),
    );
    // 가장자리 1.5px를 섞어 계단현상을 없앤다.
    const a = Math.max(0, Math.min(1, (28 - d) / 1.5));
    for (let c = 0; c < 3; c++) raw[o++] = Math.round(BG[c] * (1 - a) + FG[c] * a);
  }
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolor RGB
writeFileSync(
  new URL("../icon.png", import.meta.url),
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log("icon.png 생성 완료");
