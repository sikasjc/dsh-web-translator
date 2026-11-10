/**
 * Cross-platform local OCR for image translation (Tesseract WASM).
 *
 * The goal is to keep the image entirely inside the local DSH process and use
 * a normal text-translation call afterwards. The visual-model image path stays
 * available as a fallback for unsupported languages, non-JPEG inputs and
 * low-confidence OCR results.
 *
 * Runtime assets are vendored under lib/ocr so Windows/Linux/macOS behave the
 * same and no network access or native OCR installation is required.
 */
import { readFile } from 'node:fs/promises';

import jpeg from './ocr/vendor/node_modules/jpeg-js/index.js';
import { createOCRClient } from './ocr/vendor/node_modules/tesseract-wasm/src/node-worker.js';

/** Language packs shipped with this plugin. */
const OCR_MODELS = Object.freeze({
  eng: new URL('./ocr/lang/eng.traineddata', import.meta.url),
  chi_sim: new URL('./ocr/lang/chi_sim.traineddata', import.meta.url),
});

const LATIN_LANGUAGES = new Set(['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'tr']);

/** @type {Map<string, Promise<object>>} */
const engines = new Map();

/**
 * Pick a bundled OCR model for a page/source language.
 * Unsupported scripts intentionally return null so the caller can fall back to
 * the visual model instead of producing garbage OCR.
 * @param {string} [sourceLanguage] - BCP-47-ish page language.
 * @returns {'eng'|'chi_sim'|null}
 */
export function chooseOcrLanguage(sourceLanguage) {
  const value = typeof sourceLanguage === 'string' ? sourceLanguage.trim().toLowerCase() : '';
  if (value.startsWith('zh')) return 'chi_sim';
  const base = value.split('-')[0];
  if (base === 'en' || LATIN_LANGUAGES.has(base) || value === '' || value === 'auto') return 'eng';
  return null;
}

/** @param {number[]} values @returns {number} */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** @param {string} text @returns {boolean} */
export function looksLikeCodeBlock(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length === 0) return false;
  if (/^[{}\[\]"']/.test(value)) return true;
  if (/"[$A-Za-z_][\w$-]*"\s*:/.test(value)) return true;
  if (/\b(?:https?:\/\/|ftp:\/\/)\S+/.test(value)) return true;
  return false;
}

/**
 * Group OCR words into visual lines, split wide horizontal gaps (e.g. a label
 * column followed by a message column), then merge vertically adjacent runs
 * into paragraph-like blocks.
 * @param {{text: string, rect: {left: number, top: number, right: number, bottom: number}, confidence: number}[]} words
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @returns {{text: string, bbox: number[], confidence: number}[]}
 */
export function groupOcrWords(words, imageWidth, imageHeight) {
  const width = Math.max(1, imageWidth);
  const height = Math.max(1, imageHeight);
  const items = [];
  for (const word of Array.isArray(words) ? words : []) {
    const text = typeof word?.text === 'string' ? word.text.trim() : '';
    const rect = word?.rect;
    if (text.length === 0 || !rect) continue;
    const left = Number(rect.left);
    const top = Number(rect.top);
    const right = Number(rect.right);
    const bottom = Number(rect.bottom);
    if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) continue;
    items.push({ text, left, top, right, bottom, confidence: Number(word.confidence) || 0 });
  }
  if (items.length === 0) return [];
  const medianHeight = Math.max(4, median(items.map((item) => item.bottom - item.top)));
  const lineTolerance = Math.max(3, medianHeight * 0.55);

  const lines = [];
  for (const item of items.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const center = (item.top + item.bottom) / 2;
    let line = null;
    for (const candidate of lines) {
      if (Math.abs(candidate.center - center) <= lineTolerance) {
        line = candidate;
        break;
      }
    }
    if (!line) {
      line = { center, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.center = line.items.reduce((sum, entry) => sum + (entry.top + entry.bottom) / 2, 0) / line.items.length;
  }

  const segments = [];
  for (const line of lines) {
    const sorted = line.items.sort((a, b) => a.left - b.left);
    let run = [];
    const flush = () => {
      if (run.length === 0) return;
      const text = run.map((item) => item.text).join(' ');
      const left = Math.min(...run.map((item) => item.left));
      const top = Math.min(...run.map((item) => item.top));
      const right = Math.max(...run.map((item) => item.right));
      const bottom = Math.max(...run.map((item) => item.bottom));
      const confidence = run.reduce((sum, item) => sum + item.confidence, 0) / run.length;
      segments.push({ text, left, top, right, bottom, confidence });
      run = [];
    };
    for (const item of sorted) {
      if (run.length > 0) {
        const previous = run[run.length - 1];
        const gap = item.left - previous.right;
        const splitGap = Math.max(medianHeight * 1.15, width * 0.018);
        if (gap > splitGap) flush();
      }
      run.push(item);
    }
    flush();
  }

  const blocks = [];
  const paragraphGap = medianHeight * 0.95;
  for (const segment of segments.sort((a, b) => a.top - b.top || a.left - b.left)) {
    let target = null;
    for (const block of blocks) {
      const gap = segment.top - block.bottom;
      const overlap = Math.min(block.right, segment.right) - Math.max(block.left, segment.left);
      const minWidth = Math.min(block.right - block.left, segment.right - segment.left);
      if (gap >= -medianHeight * 0.2 && gap <= paragraphGap && overlap >= Math.max(2, minWidth * 0.35)) {
        target = block;
        break;
      }
    }
    if (!target) {
      blocks.push({
        text: segment.text,
        left: segment.left,
        top: segment.top,
        right: segment.right,
        bottom: segment.bottom,
        confidence: segment.confidence,
      });
    } else {
      target.text += ' ' + segment.text;
      target.left = Math.min(target.left, segment.left);
      target.top = Math.min(target.top, segment.top);
      target.right = Math.max(target.right, segment.right);
      target.bottom = Math.max(target.bottom, segment.bottom);
      target.confidence = (target.confidence + segment.confidence) / 2;
    }
  }

  // A JSON/code region may be split into several OCR runs by punctuation or
  // indentation. Drop any block fully contained inside a detected code block
  // as well, so fragments like `and network spreading,` are not translated.
  const codeBlocks = blocks.filter((block) => looksLikeCodeBlock(block.text));
  const proseBlocks = blocks.filter((block) => {
    if (looksLikeCodeBlock(block.text)) return false;
    return !codeBlocks.some((code) => {
      const overlapWidth = Math.min(block.right, code.right) - Math.max(block.left, code.left);
      const overlapHeight = Math.min(block.bottom, code.bottom) - Math.max(block.top, code.top);
      if (overlapWidth <= 0 || overlapHeight <= 0) return false;
      const area = (block.right - block.left) * (block.bottom - block.top);
      return (overlapWidth * overlapHeight) >= area * 0.6;
    });
  });

  return proseBlocks
    .filter((block) => block.text.trim().length > 0)
    .map((block) => ({
      text: block.text.trim(),
      bbox: [
        Math.max(0, Math.min(1, block.left / width)),
        Math.max(0, Math.min(1, block.top / height)),
        Math.max(0, Math.min(1, block.right / width)),
        Math.max(0, Math.min(1, block.bottom / height)),
      ].map((value) => Math.round(value * 10000) / 10000),
      confidence: Math.round(block.confidence * 10000) / 10000,
    }));
}

/** Lazy OCR worker per language. A worker stays warm across image requests. */
async function getEngine(language) {
  let pending = engines.get(language);
  if (!pending) {
    pending = (async () => {
      const client = createOCRClient();
      const model = await readFile(OCR_MODELS[language]);
      await client.loadModel(model);
      return client;
    })();
    engines.set(language, pending);
  }
  return pending;
}

/**
 * Run local OCR on one JPEG image.
 * @param {Uint8Array|Buffer} bytes - JPEG bytes.
 * @param {{sourceLanguage?: string}} [options] - OCR language hint.
 * @returns {Promise<{blocks: {text: string, bbox: number[], confidence: number}[], language: string}|null>}
 */
export async function recognizeImage(bytes, { sourceLanguage } = {}) {
  const language = chooseOcrLanguage(sourceLanguage);
  if (language === null || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
  const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
  if (!decoded || !decoded.width || !decoded.height || !decoded.data) return null;
  const client = await getEngine(language);
  const image = {
    data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    width: decoded.width,
    height: decoded.height,
  };
  await client.loadImage(image);
  const words = await client.getTextBoxes('word');
  const blocks = groupOcrWords(words, decoded.width, decoded.height);
  if (blocks.length === 0) return { blocks: [], language };
  const averageConfidence = blocks.reduce((sum, block) => sum + block.confidence, 0) / blocks.length;
  return { blocks, language, averageConfidence };
}

/**
 * Test/cleanup helper; not used by the request path.
 */
export async function disposeLocalOcr() {
  const pending = [...engines.values()];
  engines.clear();
  for (const entry of pending) {
    try {
      const client = await entry;
      await client.destroy();
    } catch {
      // ignore
    }
  }
}
