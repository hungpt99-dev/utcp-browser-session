#!/usr/bin/env node
/**
 * Generates the extension icons as PNGs with no image dependencies.
 * Run: node scripts/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function png(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const set = (x, y, r, g, b, a) => {
    const index = (y * size + x) * 4;
    buffer[index] = r;
    buffer[index + 1] = g;
    buffer[index + 2] = b;
    buffer[index + 3] = a;
  };
  const insideRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!insideRounded(x + 0.5, y + 0.5)) {
        set(x, y, 0, 0, 0, 0);
        continue;
      }
      const t = (x + y) / (2 * size);
      const r = Math.round(59 + (139 - 59) * t);
      const g = Math.round(130 + (92 - 130) * t);
      const b = Math.round(246 + (246 - 246) * t);
      set(x, y, r, g, b, 255);
    }
  }

  // Browser window motif: a rounded panel with a title bar and two lines.
  const pad = size * 0.2;
  const panelW = size - pad * 2;
  const panelH = size * 0.52;
  const panelY = size * 0.24;
  const barH = Math.max(2, Math.round(size * 0.07));
  for (let y = Math.round(panelY); y < Math.round(panelY + panelH); y += 1) {
    for (let x = Math.round(pad); x < Math.round(pad + panelW); x += 1) {
      const edge = x < pad + 1 || x > pad + panelW - 2 || y < panelY + 1 || y > panelY + panelH - 2;
      if (edge) set(x, y, 255, 255, 255, 90);
      else set(x, y, 255, 255, 255, 235);
    }
  }
  for (let y = Math.round(panelY); y < Math.round(panelY + barH); y += 1) {
    for (let x = Math.round(pad); x < Math.round(pad + panelW); x += 1) set(x, y, 17, 24, 39, 255);
  }
  const lineY = Math.round(panelY + panelH * 0.62);
  const lineH = Math.max(1, Math.round(size * 0.045));
  for (let y = lineY; y < lineY + lineH && y < size; y += 1) {
    for (let x = Math.round(pad + panelW * 0.12); x < Math.round(pad + panelW * 0.66); x += 1) set(x, y, 59, 130, 246, 255);
  }
  const line2Y = lineY + lineH * 3;
  for (let y = line2Y; y < line2Y + lineH && y < size; y += 1) {
    for (let x = Math.round(pad + panelW * 0.12); x < Math.round(pad + panelW * 0.48); x += 1) set(x, y, 148, 163, 184, 255);
  }
  return buffer;
}

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'extension', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

/** Render at 4x and box-downsample so corners are anti-aliased. */
function render(size) {
  const scale = 4;
  const big = draw(size * scale);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const index = ((y * scale + sy) * size * scale + (x * scale + sx)) * 4;
          const alpha = big[index + 3] / 255;
          r += big[index] * alpha;
          g += big[index + 1] * alpha;
          b += big[index + 2] * alpha;
          a += alpha;
        }
      }
      const index = (y * size + x) * 4;
      out[index] = a ? Math.round(r / a) : 0;
      out[index + 1] = a ? Math.round(g / a) : 0;
      out[index + 2] = a ? Math.round(b / a) : 0;
      out[index + 3] = Math.round((a / (scale * scale)) * 255);
    }
  }
  return out;
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, size, render(size)));
  process.stdout.write(`wrote ${file}\n`);
}
