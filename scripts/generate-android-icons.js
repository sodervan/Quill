/**
 * Generates android-icon-background.png and android-icon-monochrome.png.
 * Run: node scripts/generate-android-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;

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

function writePng(filePath, rgbOrRgba, colourType) {
  // colourType: 2 = RGB, 6 = RGBA
  const channels = colourType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = colourType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * channels);
    row[0] = 0;
    for (let x = 0; x < SIZE; x++) {
      const src = (y * SIZE + x) * channels;
      for (let c = 0; c < channels; c++) {
        row[1 + x * channels + c] = rgbOrRgba[src + c];
      }
    }
    rows.push(row);
  }
  const rawData = Buffer.concat(rows);
  const compressed = zlib.deflateSync(rawData, { level: 6 });
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
  console.log(`✓ ${path.basename(filePath)} (${(png.length / 1024).toFixed(0)} KB)`);
}

const assetsDir = path.join(__dirname, '..', 'assets');

// 1. Background — solid dark navy #060810
const bgBuf = Buffer.alloc(SIZE * SIZE * 3);
for (let i = 0; i < SIZE * SIZE; i++) {
  bgBuf[i * 3]     = 0x06;
  bgBuf[i * 3 + 1] = 0x08;
  bgBuf[i * 3 + 2] = 0x10;
}
writePng(path.join(assetsDir, 'android-icon-background.png'), bgBuf, 2);

// 2. Monochrome — white feather silhouette on transparent bg (RGBA)
const mbuf = Buffer.alloc(SIZE * SIZE * 4, 0); // all transparent

function px(x, y, r, g, b, a) {
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const alpha = a / 255;
  mbuf[i]     = Math.round(mbuf[i]     * (1 - alpha) + r * alpha);
  mbuf[i + 1] = Math.round(mbuf[i + 1] * (1 - alpha) + g * alpha);
  mbuf[i + 2] = Math.round(mbuf[i + 2] * (1 - alpha) + b * alpha);
  mbuf[i + 3] = Math.min(255, mbuf[i + 3] + a);
}

function line(x1, y1, x2, y2, thickness) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const nx = -dy / len, ny = dx / len;
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mx = x1 + dx * t, my = y1 + dy * t;
    for (let w = -thickness; w <= thickness; w += 0.5) {
      const wx = mx + nx * w, wy = my + ny * w;
      const dist = Math.abs(w);
      const a = Math.max(0, Math.min(1, thickness - dist + 0.5)) * 255;
      px(Math.round(wx), Math.round(wy), 255, 255, 255, a);
    }
  }
}

function bezierLine(x0, y0, x1, y1, x2, y2, thickness) {
  const steps = 200;
  let px1 = x0, py1 = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const nx = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
    const ny = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
    line(px1, py1, nx, ny, thickness);
    px1 = nx; py1 = ny;
  }
}

// Spine
bezierLine(680, 160, 512, 512, 300, 860, 10);
bezierLine(680, 160, 512, 512, 300, 860, 6);

// Left barbs
for (let t = 0.08; t < 0.92; t += 0.06) {
  const mt = 1 - t;
  const sx = mt * mt * 680 + 2 * mt * t * 512 + t * t * 300;
  const sy = mt * mt * 160 + 2 * mt * t * 512 + t * t * 860;
  const spread = 130 * Math.sin(Math.PI * t);
  const ex = sx - spread, ey = sy - spread * 0.3;
  const th = Math.max(1.5, 4 * (1 - Math.abs(t - 0.5) * 1.5));
  line(sx, sy, ex, ey, th);
}

// Right barbs
for (let t = 0.08; t < 0.85; t += 0.06) {
  const mt = 1 - t;
  const sx = mt * mt * 680 + 2 * mt * t * 512 + t * t * 300;
  const sy = mt * mt * 160 + 2 * mt * t * 512 + t * t * 860;
  const spread = 110 * Math.sin(Math.PI * t * 0.9);
  const ex = sx + spread * 0.9, ey = sy - spread * 0.6;
  const th = Math.max(1.5, 3.5 * (1 - Math.abs(t - 0.5) * 1.6));
  line(sx, sy, ex, ey, th);
}

// Nib
line(300, 860, 270, 920, 7);
line(270, 920, 280, 930, 5);
line(270, 920, 260, 930, 5);

writePng(path.join(assetsDir, 'android-icon-monochrome.png'), mbuf, 6);
