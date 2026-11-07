/**
 * Technical terminology protection for programming pages.
 *
 * Small models sometimes translate Rust concepts ("trait" → "特征"/"特质") or
 * choose the wrong sense of common words ("port" → "港口"). When the page looks
 * like software documentation we:
 *   1. protect keep-original terms with opaque tokens the model is told to copy;
 *   2. restore them after parsing;
 *   3. fall back to fixing the most common bad Chinese renderings if the model
 *      dropped a token anyway.
 *
 * The module is intentionally deterministic: it never rewrites text unless the
 * source segment actually contains the term.
 */

/** Tokens used for keep-original terms (unlikely to appear in normal text). */
const TOKEN_PREFIX = '[[DSH_KEEP_';

/** Terms that should stay in English on programming pages. */
const KEEP_TERMS = /\btrait(s)?\b/gi;

/** Common bad renderings of "trait" in technical Chinese. */
const TRAIT_BAD = /特征|特质/g;

/** Networking/programming senses of "port". */
const PORT_SOURCE = /\bport(s)?\b/i;
const PORT_BAD = /港口|口岸/g;

/**
 * Replace keep-original terms in a batch with opaque tokens.
 * @param {readonly string[]} texts - source segments.
 * @returns {{texts: string[], tokens: Array<{token: string, value: string}>}}
 */
export function protectTechnicalTerms(texts) {
  const tokens = [];
  const protectedTexts = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    let index = 0;
    const next = String(text).replace(KEEP_TERMS, (match) => {
      const token = `${TOKEN_PREFIX}${tokens.length}_${index}]]`;
      index += 1;
      tokens.push({ token, value: match });
      return token;
    });
    protectedTexts.push(next);
  }
  return { texts: protectedTexts, tokens };
}

/**
 * Restore protected tokens in one translated segment.
 * @param {string} text - model translation.
 * @param {readonly {token: string, value: string}[]} tokens - token map.
 * @returns {string}
 */
export function restoreTechnicalTerms(text, tokens) {
  let result = typeof text === 'string' ? text : '';
  for (const entry of Array.isArray(tokens) ? tokens : []) {
    if (!entry || typeof entry.token !== 'string') continue;
    result = result.split(entry.token).join(entry.value);
  }
  return result;
}

/**
 * Last-resort terminology fix when a keep token was translated anyway.
 * @param {string} sourceText - original source segment.
 * @param {string} translatedText - translated segment (tokens restored).
 * @returns {string}
 */
export function applyTechnicalFallback(sourceText, translatedText) {
  let result = typeof translatedText === 'string' ? translatedText : '';
  const source = typeof sourceText === 'string' ? sourceText : '';
  if (PORT_SOURCE.test(source)) result = result.replace(PORT_BAD, '端口');
  if (KEEP_TERMS.test(source)) {
    const match = source.match(KEEP_TERMS);
    const kept = match && match[0] ? match[0].replace(/[^\w]/g, '') : 'trait';
    result = result.replace(TRAIT_BAD, kept);
  }
  // RegExp instances are global; reset state so later calls do not start mid-match.
  KEEP_TERMS.lastIndex = 0;
  PORT_SOURCE.lastIndex = 0;
  return result;
}
