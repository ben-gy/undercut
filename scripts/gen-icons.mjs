#!/usr/bin/env node
/**
 * gen-icons.mjs — generate the PWA / home-screen icon set from the same visual
 * identity as public/favicon.svg. No dependencies: sharp and canvas are native
 * modules that break CI on a whim, so this plots pixels into an RGBA buffer and
 * emits the PNG itself (zlib ships with Node; the rest is IHDR/IDAT/IEND + CRC32).
 *
 *   node scripts/gen-icons.mjs
 *
 * Deterministic: same bytes on every run and every machine.
 *
 * Outputs (public/icons/): icon-192, icon-512, icon-512-maskable, apple-touch-icon.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ── palette (must match public/favicon.svg and src/palette.ts) ──────────────
const BG = [0x0d, 0x10, 0x14]; // dark tarmac
const RUBBER = [0x33, 0x39, 0x3f]; // tyre
const STEEL = [0xc6, 0xd0, 0xdc]; // bright rim edge
const RIM = [0x82, 0x8d, 0x9b]; // wheel rim
const HUB = [0xf4, 0xa0, 0x24]; // hazard amber centre nut
const CLOCK = [0x4b, 0xc6, 0xe8]; // ice-blue clock hand — the pit window

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

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

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing ─────────────────────────────────────────────────────────────────

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** Signed distance to a segment, for the clock hand. */
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

function makeCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  return {
    size,
    buf,
    blend(i, [r, g, b], a) {
      if (a <= 0) return;
      const dr = buf[i];
      const dg = buf[i + 1];
      const db = buf[i + 2];
      const da = buf[i + 3] / 255;
      const outA = a + da * (1 - a);
      if (outA <= 0) return;
      buf[i] = Math.round((r * a + dr * da * (1 - a)) / outA);
      buf[i + 1] = Math.round((g * a + dg * da * (1 - a)) / outA);
      buf[i + 2] = Math.round((b * a + db * da * (1 - a)) / outA);
      buf[i + 3] = Math.round(outA * 255);
    },
  };
}

/**
 * The mark is a WHEEL that is also a STOPWATCH — a tyre with a bright steel edge,
 * a rim, an ice-blue clock hand pointing at the pit window, and a hazard-amber
 * centre nut. The whole game in a glyph: the tyre you change, timed to the call.
 */
function render(size, opts = {}) {
  const { maskable = false, opaque = false } = opts;
  const canvas = makeCanvas(size);
  const { buf } = canvas;

  const scale = maskable ? 0.72 : 1;
  const toArt = (p) => (((p + 0.5) / size - 0.5) * 64) / scale + 32;
  const pxPerUnit = (size * scale) / 64;
  const cover = (d) => clamp01(0.5 - d * pxPerUnit);
  const bleed = maskable || opaque;

  // Two clock hands from the hub: a long one to the pit window (upper-right) and
  // a short one, like a stopwatch reading the moment to box.
  const hands = [
    [32, 32, 44, 22, 1.9], // long hand
    [32, 32, 26, 26, 1.6], // short hand
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = toArt(x);
      const v = toArt(y);

      // 1. Tarmac.
      if (bleed) canvas.blend(i, BG, 1);
      else canvas.blend(i, BG, cover(sdRoundRect(u, v, 0, 0, 64, 64, 14)));

      // 2. Tyre body + bright steel edge stroke so it pops off the dark tarmac.
      canvas.blend(i, RUBBER, cover(sdCircle(u, v, 32, 32, 23)));
      canvas.blend(i, STEEL, cover(Math.abs(sdCircle(u, v, 32, 32, 23)) - 1.5));

      // 3. Rim face.
      canvas.blend(i, RIM, cover(sdCircle(u, v, 32, 32, 13)));

      // 4. Clock hands.
      for (const [ax, ay, bx, by, r] of hands) {
        canvas.blend(i, CLOCK, cover(sdSegment(u, v, ax, ay, bx, by, r)));
      }

      // 5. Centre nut.
      canvas.blend(i, HUB, cover(sdCircle(u, v, 32, 32, 4.6)));

      if (opaque) buf[i + 3] = 255;
    }
  }

  return encodePng(buf, size);
}

// ── emit ────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-512-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { opaque: true }],
];

for (const [name, size, opts] of targets) {
  const png = render(size, opts);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}
