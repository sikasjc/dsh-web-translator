/**
 * Translation-output parsing (DESIGN §4.3).
 *
 * Models are asked for `{"translations":[...]}`, but replies arrive fenced,
 * preceded by prose, or as a bare array. This module extracts the first usable
 * payload, enforces the segment count, and offers the single-segment plain-text
 * fallback. It never mutates the input and never talks to a model.
 */

/**
 * Remove Markdown code fences, returning the longest fenced block when present.
 * @param {unknown} raw - model output.
 * @returns {string}
 */
export function stripCodeFences(raw) {
  const text = String(raw ?? '').trim();
  if (!text.includes('```')) return text;
  const blocks = [];
  const pattern = /```[^\n`]*\n?([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    const block = match[1].trim();
    if (block.length > 0) blocks.push(block);
  }
  if (blocks.length === 0) return text.replaceAll('```', '').trim();
  return blocks.sort((left, right) => right.length - left.length)[0];
}

/**
 * Slice the first `open` through the last `close` (both characters).
 * @param {string} text - haystack.
 * @param {string} open - opening character, e.g. `{`.
 * @param {string} close - closing character, e.g. `}`.
 * @returns {string | null}
 */
function sliceBetween(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Try `JSON.parse` without throwing.
 * @param {string} text - candidate JSON text.
 * @returns {{ok: true, value: unknown} | {ok: false}}
 */
function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Extract a translation array from one parsed JSON value.
 * @param {unknown} value - parsed JSON.
 * @param {number | null} expectedCount - required array length, or null.
 * @returns {string[] | null}
 */
function translationsFromJsonValue(value, expectedCount) {
  let list = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (value !== null && typeof value === 'object' && Array.isArray(value.translations)) {
    list = value.translations;
  } else if (expectedCount === 1 && value !== null && typeof value === 'object' && typeof value.translation === 'string') {
    // Tolerated convenience: some models answer a single segment this way.
    list = [value.translation];
  }
  if (list === null) return null;
  if (list.some((item) => typeof item !== 'string')) return null;
  if (expectedCount !== null && list.length !== expectedCount) return null;
  return list;
}

/**
 * Plain-text fallback for a single-segment batch (DESIGN §4.3 step 3).
 * Rejects JSON-looking leftovers so a broken object never leaks as a translation.
 * @param {unknown} raw - model output.
 * @returns {string | null}
 */
export function plainTextTranslation(raw) {
  let text = stripCodeFences(raw).trim();
  if (text.length === 0) return null;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    text = text.slice(1, -1).trim();
    if (text.length === 0) return null;
  }
  if (text.startsWith('{') || text.startsWith('[')) return null;
  if (text.length > 4000) return null;
  return text;
}

/**
 * Parse one model reply into a translation array (DESIGN §4.3).
 * @param {unknown} raw - model output text.
 * @param {{expectedCount?: number}} [options] - number of segments in the batch.
 * @returns {{ok: true, translations: string[], source: 'json'|'array'|'plain'}
 *   | {ok: false, reason: string}}
 */
export function parseTranslations(raw, { expectedCount } = {}) {
  const count = Number.isInteger(expectedCount) && expectedCount > 0 ? expectedCount : null;
  const text = String(raw ?? '').trim();
  if (text.length === 0) return { ok: false, reason: 'empty model output' };

  const unfenced = stripCodeFences(text);
  const candidates = [];
  const whole = tryParseJson(unfenced);
  if (whole.ok) candidates.push(whole.value);

  const objectSlice = sliceBetween(unfenced, '{', '}');
  const arraySlice = sliceBetween(unfenced, '[', ']');
  const openObject = unfenced.indexOf('{');
  const openArray = unfenced.indexOf('[');
  const objectFirst = openObject !== -1 && (openArray === -1 || openObject < openArray);
  const slices = objectFirst ? [objectSlice, arraySlice] : [arraySlice, objectSlice];
  for (const slice of slices) {
    if (!slice) continue;
    const parsed = tryParseJson(slice);
    if (parsed.ok) candidates.push(parsed.value);
  }

  let sawCandidate = false;
  for (const candidate of candidates) {
    sawCandidate = true;
    const translations = translationsFromJsonValue(candidate, count);
    if (translations !== null) {
      return { ok: true, translations, source: Array.isArray(candidate) ? 'array' : 'json' };
    }
  }
  if (sawCandidate && count === 1) {
    // A malformed JSON object is not a translation; plain fallback only for
    // non-JSON-looking replies (handled by plainTextTranslation).
  }

  if (count === 1) {
    const plain = plainTextTranslation(unfenced);
    if (plain !== null) return { ok: true, translations: [plain], source: 'plain' };
  }
  return { ok: false, reason: 'model output does not match the translation JSON contract' };
}
