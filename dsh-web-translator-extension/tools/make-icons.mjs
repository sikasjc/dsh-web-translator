#!/usr/bin/env node
/**
 * 生成扩展图标：icons/icon{16,32,48,128}.png
 *
 * 零依赖：只用 node:zlib 手工编码 PNG（RGBA / 8bit / 无滤波）。
 * 图案为原创矢量绘制（渐变圆角底 + 双对话气泡 + "A"/"文"字形），
 * 用 4x 超采样做抗锯齿，不依赖任何外部图片资源或字体。
 *
 * 用法：node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // 超采样倍数

/* ------------------------------------------------------------------ */
/* PNG 编码                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba: Uint8Array，长度 width*height*4 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ */
/* 绘图原语（坐标全部为 0..1 归一化）                                   */
/* ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** 圆角矩形有符号距离，<=0 在内部 */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** 点到线段距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function strokeHit(px, py, segments, halfWidth) {
  for (const s of segments) {
    if (distToSegment(px, py, s[0], s[1], s[2], s[3]) <= halfWidth) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 图标图案                                                            */
/* ------------------------------------------------------------------ */

const BG_FROM = [79, 70, 229]; // #4F46E5 indigo
const BG_TO = [6, 182, 212]; // #06B6D4 cyan
const WHITE = [255, 255, 255];
const INK = [49, 46, 129]; // #312E81
const AMBER = [245, 158, 11]; // #F59E0B

// 左侧白色气泡（含尾巴）
const BUBBLE1 = { cx: 0.35, cy: 0.35, hw: 0.21, hh: 0.15, r: 0.065 };
const TAIL1 = [
  [0.235, 0.49],
  [0.225, 0.625],
  [0.385, 0.49]
];
// 气泡 1 里的 "A"
const LETTER_A = [
  [0.285, 0.452, 0.35, 0.262],
  [0.35, 0.262, 0.415, 0.452],
  [0.309, 0.386, 0.391, 0.386]
];
const A_HALF_WIDTH = 0.023;

// 右侧琥珀色气泡（含尾巴）
const BUBBLE2 = { cx: 0.65, cy: 0.575, hw: 0.205, hh: 0.145, r: 0.058 };
const TAIL2 = [
  [0.7, 0.712],
  [0.765, 0.845],
  [0.6, 0.712]
];
// 气泡 2 里的 "文"
const GLYPH_WEN = [
  [0.652, 0.452, 0.644, 0.483], // 点
  [0.566, 0.512, 0.744, 0.512], // 横
  [0.652, 0.512, 0.558, 0.662], // 撇
  [0.652, 0.548, 0.74, 0.665] // 捺
];
const WEN_HALF_WIDTH = 0.017;

function inBubble1(px, py) {
  return sdRoundRect(px, py, BUBBLE1.cx, BUBBLE1.cy, BUBBLE1.hw, BUBBLE1.hh, BUBBLE1.r) <= 0 ||
    pointInTriangle(px, py, TAIL1[0][0], TAIL1[0][1], TAIL1[1][0], TAIL1[1][1], TAIL1[2][0], TAIL1[2][1]);
}

function inBubble2(px, py) {
  return sdRoundRect(px, py, BUBBLE2.cx, BUBBLE2.cy, BUBBLE2.hw, BUBBLE2.hh, BUBBLE2.r) <= 0 ||
    pointInTriangle(px, py, TAIL2[0][0], TAIL2[0][1], TAIL2[1][0], TAIL2[1][1], TAIL2[2][0], TAIL2[2][1]);
}

/* 16px 等小尺寸使用简化构图：一个大气泡 + 字母 A + 小气泡，避免笔画糊成一团 */
const COMPACT = {
  bubble: { cx: 0.4, cy: 0.4, hw: 0.29, hh: 0.225, r: 0.1 },
  tail: [
    [0.225, 0.6],
    [0.205, 0.775],
    [0.405, 0.615]
  ],
  letter: [
    [0.29, 0.565, 0.4, 0.25],
    [0.4, 0.25, 0.51, 0.565],
    [0.322, 0.46, 0.478, 0.46]
  ],
  letterHalfWidth: 0.027,
  accent: { cx: 0.775, cy: 0.755, hw: 0.135, hh: 0.1, r: 0.05 },
  accentTail: [
    [0.8, 0.845],
    [0.835, 0.925],
    [0.715, 0.85]
  ]
};

function inCompactBubble(px, py) {
  return sdRoundRect(px, py, COMPACT.bubble.cx, COMPACT.bubble.cy, COMPACT.bubble.hw, COMPACT.bubble.hh, COMPACT.bubble.r) <= 0 ||
    pointInTriangle(px, py, COMPACT.tail[0][0], COMPACT.tail[0][1], COMPACT.tail[1][0], COMPACT.tail[1][1], COMPACT.tail[2][0], COMPACT.tail[2][1]);
}

function inCompactAccent(px, py) {
  return sdRoundRect(px, py, COMPACT.accent.cx, COMPACT.accent.cy, COMPACT.accent.hw, COMPACT.accent.hh, COMPACT.accent.r) <= 0 ||
    pointInTriangle(px, py, COMPACT.accentTail[0][0], COMPACT.accentTail[0][1], COMPACT.accentTail[1][0], COMPACT.accentTail[1][1], COMPACT.accentTail[2][0], COMPACT.accentTail[2][1]);
}

/** 返回 [r,g,b,a]，a 为 0..1；compact 为小尺寸简化版 */
function sample(x, y, compact) {
  // 半透明/未覆盖时返回透明
  let rgb = null;
  let alpha = 0;

  const bgSd = sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.215);
  if (bgSd <= 0) {
    const t = clamp01((x + y) / 2);
    rgb = [lerp(BG_FROM[0], BG_TO[0], t), lerp(BG_FROM[1], BG_TO[1], t), lerp(BG_FROM[2], BG_TO[2], t)];
    // 左上到右下轻微提亮
    const shine = (1 - clamp01((x + y) / 2)) * 18;
    rgb = [rgb[0] + shine, rgb[1] + shine, rgb[2] + shine];
    alpha = 1;
  }

  if (compact) {
    if (inCompactBubble(x, y)) {
      rgb = WHITE.slice();
      alpha = 1;
      if (strokeHit(x, y, COMPACT.letter, COMPACT.letterHalfWidth)) rgb = INK.slice();
    }
    if (inCompactAccent(x, y)) {
      rgb = AMBER.slice();
      alpha = 1;
    }
    return [rgb ? rgb[0] : 0, rgb ? rgb[1] : 0, rgb ? rgb[2] : 0, alpha];
  }

  if (inBubble1(x, y)) {
    rgb = WHITE.slice();
    alpha = 1;
    if (strokeHit(x, y, LETTER_A, A_HALF_WIDTH)) rgb = INK.slice();
  }

  if (inBubble2(x, y)) {
    rgb = AMBER.slice();
    alpha = 1;
    if (strokeHit(x, y, GLYPH_WEN, WEN_HALF_WIDTH)) rgb = WHITE.slice();
  }

  return [rgb ? rgb[0] : 0, rgb ? rgb[1] : 0, rgb ? rgb[2] : 0, alpha];
}

/* ------------------------------------------------------------------ */
/* 渲染 + 降采样                                                        */
/* ------------------------------------------------------------------ */

function renderIcon(size) {
  const hi = size * SS;
  const compact = size <= 24;
  // 超采样画布（RGBA，非预乘）
  const hiPixels = new Float32Array(hi * hi * 4);
  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < hi; x++) {
      const px = (x + 0.5) / hi;
      const py = (y + 0.5) / hi;
      const rgba = sample(px, py, compact);
      const idx = (y * hi + x) * 4;
      hiPixels[idx] = rgba[0];
      hiPixels[idx + 1] = rgba[1];
      hiPixels[idx + 2] = rgba[2];
      hiPixels[idx + 3] = rgba[3];
    }
  }

  // 盒式降采样（预乘 alpha 平均，避免边缘发黑）
  const out = new Uint8Array(size * size * 4);
  const samplesPerPixel = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const idx = ((y * SS + sy) * hi + (x * SS + sx)) * 4;
          const sa = hiPixels[idx + 3];
          r += hiPixels[idx] * sa;
          g += hiPixels[idx + 1] * sa;
          b += hiPixels[idx + 2] * sa;
          a += sa;
        }
      }
      const outIdx = (y * size + x) * 4;
      if (a > 0) {
        out[outIdx] = Math.round(clamp01(r / a / 255) * 255);
        out[outIdx + 1] = Math.round(clamp01(g / a / 255) * 255);
        out[outIdx + 2] = Math.round(clamp01(b / a / 255) * 255);
        out[outIdx + 3] = Math.round(clamp01(a / samplesPerPixel) * 255);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const pixels = renderIcon(size);
    const png = encodePng(size, size, pixels);
    const file = join(OUT_DIR, `icon${size}.png`);
    writeFileSync(file, png);
    console.log(`written ${file} (${size}x${size}, ${png.length} bytes)`);
  }
}

main();
