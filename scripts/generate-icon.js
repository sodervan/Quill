/**
 * Generates assets/icon.png — a 1024×1024 Quill branded icon.
 * Dark navy background (#060810) with a golden feather quill (#C8AA6E).
 * Pure Node.js, no native dependencies.
 *
 * Run: node scripts/generate-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

// --- Color helpers ---
function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const BG    = hex('#060810');
const GOLD  = hex('#C8AA6E');
const GOLDD = hex('#9A7D48');   // darker gold for shadow
const GOLDI = hex('#E8D4A0');   // lighter gold for highlight
const WHITE = [255, 255, 255];

// --- Pixel buffer (RGBA) ---
const buf = Buffer.alloc(SIZE * SIZE * 4, 0);

function px(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // Alpha blend over existing colour
  const alpha = a / 255;
  buf[i]     = Math.round(buf[i]     * (1 - alpha) + r * alpha);
  buf[i + 1] = Math.round(buf[i + 1] * (1 - alpha) + g * alpha);
  buf[i + 2] = Math.round(buf[i + 2] * (1 - alpha) + b * alpha);
  buf[i + 3] = 255;
}

// Anti-aliased circle fill
function circle(cx, cy, r, [R, G, B]) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const alpha = Math.max(0, Math.min(1, r - dist + 0.5)) * 255;
      if (alpha > 0) px(x, y, R, G, B, alpha);
    }
  }
}

// Anti-aliased filled ellipse
function ellipse(cx, cy, rx, ry, angle, [R, G, B], alpha = 255) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const pad = Math.max(rx, ry) + 2;
  for (let y = Math.floor(cy - pad); y <= cy + pad; y++) {
    for (let x = Math.floor(cx - pad); x <= cx + pad; x++) {
      const dx = x - cx, dy = y - cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      const dist = Math.sqrt((lx / rx) ** 2 + (ly / ry) ** 2);
      const a = Math.max(0, Math.min(1, 1 - dist + 0.5 / Math.max(rx, ry))) * alpha;
      if (a > 0) px(x, y, R, G, B, a);
    }
  }
}

// Anti-aliased thick line
function line(x1, y1, x2, y2, [R, G, B], thickness = 2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = -dy / len, ny = dx / len;
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mx = x1 + dx * t, my = y1 + dy * t;
    for (let w = -thickness; w <= thickness; w += 0.5) {
      const wx = mx + nx * w, wy = my + ny * w;
      const dist = Math.abs(w);
      const a = Math.max(0, Math.min(1, thickness - dist + 0.5)) * 255;
      px(Math.round(wx), Math.round(wy), R, G, B, a);
    }
  }
}

// Bezier curve (quadratic)
function bezier(x0, y0, x1, y1, x2, y2, [R, G, B], thickness = 2) {
  const steps = 200;
  let px1 = x0, py1 = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const nx = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
    const ny = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
    line(px1, py1, nx, ny, [R, G, B], thickness);
    px1 = nx; py1 = ny;
  }
}

// --- Draw background ---
for (let i = 0; i < SIZE * SIZE; i++) {
  buf[i * 4]     = BG[0];
  buf[i * 4 + 1] = BG[1];
  buf[i * 4 + 2] = BG[2];
  buf[i * 4 + 3] = 255;
}

// Subtle radial vignette glow (gold tint in centre)
const CX = SIZE / 2, CY = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.sqrt((x - CX) ** 2 + (y - CY) ** 2) / (SIZE * 0.6);
    const glow = Math.max(0, 1 - d) * 0.12;
    const i = (y * SIZE + x) * 4;
    buf[i]     = Math.min(255, buf[i]     + Math.round(GOLD[0] * glow));
    buf[i + 1] = Math.min(255, buf[i + 1] + Math.round(GOLD[1] * glow));
    buf[i + 2] = Math.min(255, buf[i + 2] + Math.round(GOLD[2] * glow));
  }
}

// --- Draw the quill feather ---
// Feather runs top-right to bottom-left at ~40° angle
// Spine (thick central line)
bezier(680, 160, 512, 512, 300, 860, GOLDD, 12);
bezier(680, 160, 512, 512, 300, 860, GOLD,  6);

// Left barbs (from spine to left)
for (let t = 0.08; t < 0.92; t += 0.06) {
  const mt = 1 - t;
  const sx = mt * mt * 680 + 2 * mt * t * 512 + t * t * 300;
  const sy = mt * mt * 160 + 2 * mt * t * 512 + t * t * 860;
  const spread = 130 * Math.sin(Math.PI * t);
  const ex = sx - spread;
  const ey = sy - spread * 0.3;
  const thickness = Math.max(1.5, 4 * (1 - Math.abs(t - 0.5) * 1.5));
  line(sx, sy, ex, ey, GOLDD, thickness + 1);
  line(sx, sy, ex, ey, GOLD, thickness);
}

// Right barbs (from spine to right)
for (let t = 0.08; t < 0.85; t += 0.06) {
  const mt = 1 - t;
  const sx = mt * mt * 680 + 2 * mt * t * 512 + t * t * 300;
  const sy = mt * mt * 160 + 2 * mt * t * 512 + t * t * 860;
  const spread = 110 * Math.sin(Math.PI * t * 0.9);
  const ex = sx + spread * 0.9;
  const ey = sy - spread * 0.6;
  const thickness = Math.max(1.5, 3.5 * (1 - Math.abs(t - 0.5) * 1.6));
  line(sx, sy, ex, ey, GOLDD, thickness + 1);
  line(sx, sy, ex, ey, GOLD, thickness);
}

// Quill tip highlight
circle(682, 158, 10, GOLDI);
circle(682, 158, 6, WHITE);

// --- Writing nib (bottom) ---
line(300, 860, 270, 920, GOLDD, 8);
line(300, 860, 270, 920, GOLDI, 4);
line(270, 920, 280, 930, GOLD, 6); // nib split left
line(270, 920, 260, 930, GOLD, 6); // nib split right
circle(270, 922, 5, GOLDI);

// Ink dot at nib tip
circle(270, 934, 14, GOLDD);
circle(270, 934, 9, GOLD);
circle(270, 934, 5, GOLDI);

// --- Re-draw spine on top for crispness ---
bezier(680, 160, 512, 512, 300, 860, GOLD, 4);

// --- PNG encoder ---
function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBytes, data]);
  let crc = 0xFFFFFFFF;
  for (const b of crcBuf) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  crc = (~crc) >>> 0;
  const crcOut = Buffer.alloc(4);
  crcOut.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBytes, data, crcOut]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // colour type: RGB (no alpha in output — Expo wants RGB PNG)
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// Image data: filter byte + RGB rows
const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 3);
  row[0] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const src = (y * SIZE + x) * 4;
    row[1 + x * 3]     = buf[src];
    row[1 + x * 3 + 1] = buf[src + 1];
    row[1 + x * 3 + 2] = buf[src + 2];
  }
  rows.push(row);
}
const rawData = Buffer.concat(rows);
const compressed = zlib.deflateSync(rawData, { level: 6 });

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', compressed),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`✓ icon.png written (${(png.length / 1024).toFixed(0)} KB)`);

// Also write the android foreground (same design, slightly smaller padding)
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'android-icon-foreground.png'), png);
console.log('✓ android-icon-foreground.png written');
