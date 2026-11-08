/**
 * Image text translation support (`POST /image-translate`).
 *
 * Pure helpers plus one best-effort cleanup routine:
 *  - validate one wire image payload (media type, canonical base64, byte cap);
 *  - build the OCR + translation prompt for an image-capable model;
 *  - parse the model's strict-JSON blocks answer (with a safe plain-text fallback);
 *  - derive the cache key from the image digest and model configuration;
 *  - delete the durable attachment (and its request-variant cache entries) after
 *    the model call, because image translations discard the image immediately.
 *
 * The host keeps no image bytes after the call; only OCR text / translations are
 * cached (see DESIGN-IMAGE.md).
 */
import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { LIMITS } from './constants.js';
import { apiError } from './errors.js';
import { isPlainObject } from './validate.js';

/** Image media types accepted by the DSH attachment service. */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Prompt/cache version: bump when the OCR prompt or block contract changes. */
export const IMAGE_PROMPT_VERSION = '1';

/** Upper bound for one base64 image payload (bytes + JSON envelope headroom). */
const IMAGE_BASE64_MAX = Math.ceil((LIMITS.imageBytes * 4) / 3) + 4;

/**
 * Normalize one wire image payload: `{mediaType, data}` with optional data-URL prefix.
 * @param {unknown} raw - request field.
 * @returns {{mediaType: string, bytes: Uint8Array, base64: string}}
 */
export function normalizeImagePayload(raw) {
  if (!isPlainObject(raw)) throw apiError('IMAGE_INVALID', 'image must be an object with mediaType and data');
  const declared = typeof raw.mediaType === 'string' ? raw.mediaType.trim().toLowerCase() : '';
  if (!IMAGE_MEDIA_TYPES.includes(declared)) {
    throw apiError('IMAGE_UNSUPPORTED', `unsupported image media type; expected one of: ${IMAGE_MEDIA_TYPES.join(', ')}`);
  }
  if (typeof raw.data !== 'string' || raw.data.length === 0) {
    throw apiError('IMAGE_INVALID', 'image.data must be a non-empty base64 string');
  }
  let base64 = raw.data.trim();
  const dataUrl = /^data:([^;,]+);base64,/iu.exec(base64);
  if (dataUrl !== null) {
    const prefixType = dataUrl[1].toLowerCase();
    if (prefixType !== declared) {
      throw apiError('IMAGE_INVALID', `image data URL type "${prefixType}" does not match mediaType "${declared}"`);
    }
    base64 = base64.slice(dataUrl[0].length);
  }
  if (base64.length > IMAGE_BASE64_MAX) {
    throw apiError('IMAGE_TOO_LARGE', `image exceeds ${LIMITS.imageBytes} bytes`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64) || base64.length % 4 !== 0) {
    throw apiError('IMAGE_INVALID', 'image.data must be canonical base64');
  }
  let bytes;
  try {
    bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  } catch {
    throw apiError('IMAGE_INVALID', 'image.data is not valid base64');
  }
  if (bytes.byteLength === 0) throw apiError('IMAGE_INVALID', 'image payload is empty');
  if (bytes.byteLength > LIMITS.imageBytes) {
    throw apiError('IMAGE_TOO_LARGE', `image exceeds ${LIMITS.imageBytes} bytes`);
  }
  return { mediaType: declared, bytes, base64 };
}

/**
 * SHA-256 of one image payload; used as the result-cache key.
 * @param {Uint8Array|Buffer} bytes - decoded image bytes.
 * @returns {string}
 */
export function imageHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build the system/user prompts for one image call.
 *
 * The model returns blocks with normalized bounding boxes so the browser
 * extension can cover the original text in place (DESIGN-IMAGE §2).
 * @param {{targetLanguage: string, sourceTitle?: string, site?: string,
 *   translationStyle?: string}} input - prompt context.
 * @returns {{system: string, user: string}}
 */
export function buildImagePrompt({ targetLanguage, sourceTitle, site, translationStyle } = {}) {
  const language = typeof targetLanguage === 'string' && targetLanguage.trim().length > 0
    ? targetLanguage.trim()
    : 'zh-CN';
  const style = typeof translationStyle === 'string' && translationStyle.length > 0 ? translationStyle : 'auto';
  const system = [
    'You are an OCR and translation engine for images.',
    `Read every readable text block in the image and translate each block into ${language}.`,
    `Translation style: ${style}.`,
    'Keep numbers, code, URLs, file names, product names and identifiers unchanged unless they are ordinary prose.',
    'Preserve line breaks inside a block; do not merge separate UI elements, labels, columns or captions.',
    'Return ONLY a JSON object with this exact shape:',
    '{"blocks":[{"text":"original text as shown","translation":"translated text","bbox":[x0,y0,x1,y1]}]}',
    'bbox is normalized to 0..1 relative to the image: [left, top, right, bottom].',
    'If the image contains no readable text, return {"blocks":[]}. No markdown fences, no commentary.',
  ].join('\n');
  const context = [];
  if (typeof sourceTitle === 'string' && sourceTitle.trim().length > 0) context.push(`Page title: ${sourceTitle.trim().slice(0, 200)}`);
  if (typeof site === 'string' && site.trim().length > 0) context.push(`Site: ${site.trim().slice(0, 200)}`);
  const user = [
    `Translate the text in this image into ${language}.`,
    ...context,
  ].join('\n');
  return { system, user };
}

/**
 * Clip one normalized bbox to 0..1; returns undefined when unusable.
 * @param {unknown} raw - candidate array.
 * @returns {number[] | undefined}
 */
function normalizeBbox(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const values = raw.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) return undefined;
  const clamped = values.map((value) => Math.min(1, Math.max(0, value)));
  const [x0, y0, x1, y1] = clamped;
  if (x1 - x0 < 0.004 || y1 - y0 < 0.004) return undefined;
  return clamped.map((value) => Math.round(value * 10000) / 10000);
}

/** @param {unknown} value - raw field. @returns {string} trimmed capped text. */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/gu, '\n').trim().slice(0, LIMITS.imageBlockChars);
}

/**
 * Parse one model answer into sanitized blocks; never throws.
 *
 * Preferred shape is the strict JSON object. A model that ignores the contract
 * degrades to one block containing the plain answer (the extension falls back
 * to a result card because it has no bbox).
 * @param {unknown} text - model answer.
 * @returns {{blocks: {text: string, translation: string, bbox?: number[]}[], fallback: boolean}}
 */
export function parseImageTranslation(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return { blocks: [], fallback: false };
  const raw = text.trim();
  let parsed;
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw);
  if (fenced !== null) candidates.push(fenced[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      parsed = undefined;
    }
  }
  let rawBlocks;
  if (Array.isArray(parsed)) rawBlocks = parsed;
  else if (isPlainObject(parsed) && Array.isArray(parsed.blocks)) rawBlocks = parsed.blocks;

  if (rawBlocks !== undefined) {
    const blocks = [];
    for (const entry of rawBlocks) {
      if (blocks.length >= LIMITS.imageBlocks) break;
      if (!isPlainObject(entry)) continue;
      const blockText = cleanText(entry.text);
      const translation = cleanText(entry.translation ?? entry.translated);
      if (translation.length === 0) continue;
      const block = { text: blockText, translation };
      const bbox = normalizeBbox(entry.bbox);
      if (bbox !== undefined) block.bbox = bbox;
      blocks.push(block);
    }
    return { blocks, fallback: false };
  }

  const plain = cleanText(raw);
  return plain.length > 0
    ? { blocks: [{ text: '', translation: plain }], fallback: true }
    : { blocks: [], fallback: false };
}

/**
 * Cache key for one image translation. Image bytes are never stored in the cache:
 * only the OCR/translation blocks keyed by the image digest are kept.
 * @param {{hash: string, provider: string, model: string, targetLanguage: string,
 *   translationStyle?: string}} input - key parts.
 * @returns {string}
 */
export function imageCacheKey({ hash, provider, model, targetLanguage, translationStyle }) {
  return [
    'image',
    IMAGE_PROMPT_VERSION,
    String(hash ?? ''),
    String(provider ?? ''),
    String(model ?? ''),
    String(targetLanguage ?? ''),
    String(translationStyle ?? 'auto'),
  ].join(':');
}

/** Recursively list files under one cache directory (best effort, bounded depth). */
async function listFiles(dir, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, depth + 1));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * Best-effort deletion of one image attachment and its request-variant cache.
 *
 * DSH's attachment store has no delete API, so this routine removes the
 * normalized object only when it was created during this request (mtime guard),
 * plus any request-variant files created after the call started. Failures are
 * logged and never affect the translation result.
 * @param {{attachments: object, ref: object, cacheDir?: string,
 *   startedAt: number, logger?: {debug?: Function}}} input - cleanup context.
 * @returns {Promise<{removedObject: boolean, removedVariants: number}>}
 */
export async function cleanupImageAttachment({ attachments, ref, cacheDir, startedAt, logger } = {}) {
  let removedObject = false;
  let removedVariants = 0;
  try {
    const hostPath = typeof attachments?.imageHostPath === 'function'
      ? await attachments.imageHostPath(ref)
      : undefined;
    if (typeof hostPath === 'string' && hostPath.length > 0) {
      try {
        const info = await stat(hostPath);
        if (Number.isFinite(info.mtimeMs) && info.mtimeMs >= startedAt - 1000) {
          await rm(hostPath, { force: true });
          removedObject = true;
        }
      } catch {
        // Already gone / not a local host path.
      }
    }
    if (typeof cacheDir === 'string' && cacheDir.length > 0) {
      const files = await listFiles(cacheDir);
      for (const file of files) {
        try {
          const info = await stat(file);
          if (Number.isFinite(info.mtimeMs) && info.mtimeMs >= startedAt - 1000) {
            await rm(file, { force: true });
            removedVariants += 1;
          }
        } catch {
          // Race with another cleanup; ignore.
        }
      }
    }
  } catch (error) {
    try {
      logger?.debug?.(`[dsh-web-translator] image cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // Diagnostics only.
    }
  }
  return { removedObject, removedVariants };
}
