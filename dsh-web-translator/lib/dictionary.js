/**
 * English dictionary lookup for `POST /lookup` (DESIGN §5.7).
 *
 * Only an English word (not a phrase) queries dictionaryapi.dev; the request is
 * capped at 5 s and every failure degrades silently to "no dictionary". The
 * trim helper keeps stored/looked-up payloads small and free of unknown keys.
 */
import { LIMITS } from './constants.js';

/** A single English word accepted for dictionary lookup (DESIGN §5.7). */
export const WORD_PATTERN = /^[A-Za-z][A-Za-z'-]{0,40}$/;

/** dictionaryapi.dev English endpoint. */
export const DICTIONARY_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

/** Upstream timeout before degrading silently. */
export const DICTIONARY_TIMEOUT_MS = 5000;

const MAX_MEANINGS = 4;
const MAX_DEFINITIONS = 3;
const MAX_FIELD_CHARS = 300;
const MAX_WORD_CHARS = 100;
const MAX_PHONETIC_CHARS = 200;
const MAX_AUDIO_CHARS = 1000;

/**
 * Whether the text is a single English word eligible for dictionary lookup.
 * @param {unknown} text - candidate.
 * @returns {boolean}
 */
export function isEnglishWord(text) {
  return typeof text === 'string' && WORD_PATTERN.test(text.trim());
}

/**
 * Collapse whitespace and cap a free-form dictionary string.
 * @param {unknown} value - raw string.
 * @param {number} max - maximum length.
 * @returns {string}
 */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
}

/**
 * Keep only http(s) audio URLs.
 * @param {unknown} value - raw URL.
 * @returns {string | undefined}
 */
function cleanAudioUrl(value) {
  const text = clean(value, MAX_AUDIO_CHARS);
  if (text.length === 0) return undefined;
  if (!text.startsWith('https://') && !text.startsWith('http://')) return undefined;
  return text;
}

/**
 * Normalize one `meanings` array from an untrusted source, or drop it.
 * @param {unknown} meanings - raw meanings.
 * @returns {{partOfSpeech: string, definitions: string[]}[]}
 */
function cleanMeanings(meanings) {
  const result = [];
  for (const meaning of Array.isArray(meanings) ? meanings : []) {
    if (result.length >= MAX_MEANINGS) break;
    const definitions = [];
    for (const definition of Array.isArray(meaning?.definitions) ? meaning.definitions : []) {
      if (definitions.length >= MAX_DEFINITIONS) break;
      const text = clean(typeof definition === 'string' ? definition : definition?.definition, MAX_FIELD_CHARS);
      if (text.length > 0) definitions.push(text);
    }
    if (definitions.length === 0) continue;
    result.push({
      partOfSpeech: clean(meaning?.partOfSpeech, MAX_WORD_CHARS) || 'unknown',
      definitions,
    });
  }
  return result;
}

/**
 * Trim a dictionaryapi.dev response to the DESIGN §5.7 vocabulary.
 * @param {unknown} raw - parsed JSON response (array of entries).
 * @returns {{word?: string, phonetic?: string, audio?: string,
 *   meanings: {partOfSpeech: string, definitions: string[]}[]} | undefined}
 */
export function trimDictionary(raw) {
  const entry = Array.isArray(raw) ? raw[0] : undefined;
  if (entry === null || typeof entry !== 'object') return undefined;

  const meanings = cleanMeanings(entry.meanings);
  if (meanings.length === 0) return undefined;

  const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
  const phoneticsText = clean(entry.phonetic, MAX_PHONETIC_CHARS)
    || clean(phonetics.find((item) => typeof item?.text === 'string' && item.text.trim().length > 0)?.text, MAX_PHONETIC_CHARS);
  const audio = phonetics
    .map((item) => cleanAudioUrl(item?.audio))
    .find((value) => value !== undefined);

  const dictionary = { meanings };
  const word = clean(entry.word, MAX_WORD_CHARS);
  if (word.length > 0) dictionary.word = word;
  if (phoneticsText.length > 0) dictionary.phonetic = phoneticsText;
  if (audio !== undefined) dictionary.audio = audio;
  return dictionary;
}

/**
 * Sanitize a dictionary object supplied by the extension on `wordbook/add`.
 * Accepts the same shape `POST /lookup` returns and drops anything else.
 * @param {unknown} input - untrusted dictionary payload.
 * @returns {{word?: string, phonetic?: string, audio?: string,
 *   meanings: {partOfSpeech: string, definitions: string[]}[]} | undefined}
 */
export function sanitizeDictionary(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const meanings = cleanMeanings(input.meanings);
  if (meanings.length === 0) return undefined;
  const dictionary = { meanings };
  const word = clean(input.word, MAX_WORD_CHARS);
  if (word.length > 0) dictionary.word = word;
  const phonetic = clean(input.phonetic, MAX_PHONETIC_CHARS);
  if (phonetic.length > 0) dictionary.phonetic = phonetic;
  const audio = cleanAudioUrl(input.audio ?? input.audioUrl);
  if (audio !== undefined) dictionary.audio = audio;
  return dictionary;
}

/**
 * Create the dictionary lookup used by the lookup path.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number,
 *   logger?: {debug?: Function}}} [options] - injectable fetch for tests.
 * @returns {{lookupWord: (word: string) => Promise<object | undefined>}}
 */
export function createDictionaryLookup({ fetchImpl = globalThis.fetch, timeoutMs = DICTIONARY_TIMEOUT_MS, logger } = {}) {
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : undefined;
  const effectiveTimeout = Math.max(1, Math.trunc(Number(timeoutMs)) || DICTIONARY_TIMEOUT_MS);

  return {
    /**
     * Look up one English word; never throws.
     * @param {string} word - candidate word.
     * @returns {Promise<object | undefined>}
     */
    async lookupWord(word) {
      if (!isEnglishWord(word) || fetcher === undefined) return undefined;
      try {
        const url = `${DICTIONARY_ENDPOINT}${encodeURIComponent(word.trim().toLowerCase())}`;
        const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(effectiveTimeout) : undefined;
        const response = await fetcher(url, { headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) });
        if (!response || response.ok !== true) return undefined;
        return trimDictionary(await response.json());
      } catch (error) {
        try {
          logger?.debug?.(`[dsh-web-translator] dictionary lookup degraded: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // Degrading silently is the contract; logging must not throw either.
        }
        return undefined;
      }
    },
  };
}
