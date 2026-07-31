/**
 * tools/gen-icons.mjs — generates the extension's PNG icons with no
 * dependencies. Draws a stylized "AI eye" on a teal gradient, writes
 * icons/icon16.png, icon48.png, icon128.png.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- minimal PNG writer --------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing helpers ------------------------------------------------------
function makeCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) };
}
function setPx(cv, x, y, r, g, b, a = 255) {
  const { size, data } = cv;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  const blend = a / 255;
  data[i] = Math.round(r * blend + data[i] * (1 - blend));
  data[i + 1] = Math.round(g * blend + data[i + 1] * (1 - blend));
  data[i + 2] = Math.round(b * blend + data[i + 2] * (1 - blend));
  data[i + 3] = Math.max(data[i + 3], a);
}
function fillCircle(cv, cx, cy, radius, r, g, b, a = 255) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPx(cv, x, y, r, g, b, a);
    }
  }
}
function fillRect(cv, x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(cv, x, y, r, g, b, a);
}
function fillRoundRect(cv, x0, y0, x1, y1, radius, r, g, b, a = 255) {
  fillRect(cv, x0 + radius, y0, x1 - radius, y1, r, g, b, a);
  fillRect(cv, x0, y0 + radius, x1, y1 - radius, r, g, b, a);
  fillCircle(cv, x0 + radius, y0 + radius, radius, r, g, b, a);
  fillCircle(cv, x1 - radius, y0 + radius, radius, r, g, b, a);
  fillCircle(cv, x0 + radius, y1 - radius, radius, r, g, b, a);
  fillCircle(cv, x1 - radius, y1 - radius, radius, r, g, b, a);
}
function gradient(cv, y0, y1, cTop, cBot) {
  const { size, data } = cv;
  const h = y1 - y0;
  for (let y = y0; y < y1; y++) {
    const t = Math.min(1, Math.max(0, (y - y0) / Math.max(1, h)));
    const r = Math.round(cTop[0] + (cBot[0] - cTop[0]) * t);
    const g = Math.round(cTop[1] + (cBot[1] - cTop[1]) * t);
    const b = Math.round(cTop[2] + (cBot[2] - cTop[2]) * t);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
}

function draw(size) {
  const cv = makeCanvas(size);
  gradient(cv, 0, size, [26, 92, 140], [20, 130, 120]);
  // rounded-rect panel
  const m = Math.max(2, Math.round(size * 0.08));
  fillRoundRect(cv, m, m, size - m, size - m, Math.max(2, Math.round(size * 0.22)), 255, 255, 255, 235);
  // eye outline (ellipse-ish) via two circles
  const cx = size / 2;
  const cy = size / 2;
  const rx = size * 0.32;
  const ry = size * 0.22;
  // draw filled ellipse using ellipse equation
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPx(cv, x, y, 23, 68, 105, 255);
    }
  }
  // iris
  const iris = size * 0.18;
  fillCircle(cv, cx, cy, iris, 43, 162, 150, 255);
  // pupil
  const pup = size * 0.085;
  fillCircle(cv, cx, cy, pup, 10, 30, 40, 255);
  // highlight
  fillCircle(cv, cx - size * 0.09, cy - size * 0.09, size * 0.05, 255, 255, 255, 230);
  return cv.data;
}

mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(join(root, 'icons', `icon${size}.png`), encodePNG(size, size, draw(size)));
  console.log(`icons/icon${size}.png`);
}
