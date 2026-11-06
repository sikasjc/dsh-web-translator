/**
 * Small pure validators shared by the HTTP/API layer.
 *
 * Each helper either returns a normalized value or throws an {@link ApiError}
 * with the DESIGN §5.9 code appropriate to the failure. Keeping them pure makes
 * both the request handlers and the unit tests straightforward.
 */
import { LIMITS } from './constants.js';
import { apiError } from './errors.js';

/** Limits from DESIGN §4.2 / §7.2 (re-exported for tests and callers). */
export const MAX_REQUEST_TEXTS = LIMITS.requestTexts;
export const MAX_TEXT_CHARS = LIMITS.requestTextChars;
export const MAX_LOOKUP_TEXT_CHARS = LIMITS.lookupTextChars;
export const MAX_LOOKUP_CONTEXT_CHARS = LIMITS.lookupContextChars;
export const MAX_URL_CHARS = LIMITS.urlChars;

/** BCP-47-ish language tag accepted for request overrides. */
export const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/;

/**
 * Whether a value is a plain JSON object (not null, not an array).
 * @param {unknown} value - value to test.
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a value is a non-blank string within an optional length cap.
 * @param {unknown} value - value to test.
 * @param {number} [max] - maximum accepted length.
 * @returns {value is string}
 */
export function isNonEmptyString(value, max = Number.POSITIVE_INFINITY) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/**
 * Validate the `texts` array of `POST /translate` (DESIGN §4.2 / §5.6).
 * @param {unknown} texts - untrusted request field.
 * @returns {string | null} error message, or null when valid.
 */
export function validateTextsList(texts) {
  if (!Array.isArray(texts)) return 'texts must be an array of strings';
  if (texts.length < 1 || texts.length > MAX_REQUEST_TEXTS) {
    return `texts must contain between 1 and ${MAX_REQUEST_TEXTS} segments`;
  }
  for (let index = 0; index < texts.length; index += 1) {
    const value = texts[index];
    if (typeof value !== 'string') return `texts[${index}] must be a string`;
    if (value.length > MAX_TEXT_CHARS) {
      return `texts[${index}] exceeds ${MAX_TEXT_CHARS} characters`;
    }
  }
  return null;
}

/**
 * Normalize a language override. Absent/blank values fall back to the default.
 * @param {unknown} value - request field.
 * @param {{field?: string, fallback?: string, allowAuto?: boolean, allowed?: readonly string[]}} [options]
 * @returns {string | undefined}
 */
export function normalizeLanguageTag(value, { field = 'targetLanguage', fallback, allowAuto = false, allowed } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw apiError('BAD_REQUEST', `${field} must be a language tag string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  if (allowAuto && trimmed.toLowerCase() === 'auto') return 'auto';
  if (!LANGUAGE_TAG_PATTERN.test(trimmed) || trimmed.length > 20) {
    throw apiError('BAD_REQUEST', `${field} is not a valid language tag`);
  }
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(trimmed)) {
    throw apiError('BAD_REQUEST', `${field} is not in the supported language list`);
  }
  return trimmed;
}

/**
 * Validate an optional http(s) URL without rewriting it.
 * @param {unknown} value - request field.
 * @param {{field?: string, optional?: boolean}} [options]
 * @returns {string | undefined} the trimmed URL, or undefined when absent.
 */
export function normalizeHttpUrl(value, { field = 'sourceUrl', optional = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw apiError('INVALID_URL_OR_TEXT', `${field} is required`);
  }
  if (typeof value !== 'string') throw apiError('INVALID_URL_OR_TEXT', `${field} must be a URL string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (optional) return undefined;
    throw apiError('INVALID_URL_OR_TEXT', `${field} is required`);
  }
  if (trimmed.length > MAX_URL_CHARS) throw apiError('INVALID_URL_OR_TEXT', `${field} is too long`);
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw apiError('INVALID_URL_OR_TEXT', `${field} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw apiError('INVALID_URL_OR_TEXT', `${field} must be an http(s) URL`);
  }
  return trimmed;
}

/**
 * Normalize an optional free-form string field.
 * @param {unknown} value - request field.
 * @param {{field: string, max: number, trim?: boolean}} options - field rules.
 * @returns {string | undefined}
 */
export function normalizeOptionalString(value, { field, max, trim = true }) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw apiError('BAD_REQUEST', `${field} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length === 0) return undefined;
  if (normalized.length > max) throw apiError('BAD_REQUEST', `${field} exceeds ${max} characters`);
  return normalized;
}

/**
 * Clamp a `limit` query parameter into a safe integer range.
 * @param {unknown} value - raw query value.
 * @param {{fallback?: number, min?: number, max?: number}} [options]
 * @returns {number}
 */
export function normalizeLimit(value, { fallback = 200, min = 1, max = LIMITS.wordbookListMax } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
