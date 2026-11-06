/**
 * Wordbook persistence and operations (DESIGN §5.8).
 *
 * `wordbook.json` stores `{version, items, updatedAt}`; every mutation goes
 * through the store's serialized atomic write. Entries deduplicate on
 * `word + targetLanguage` (trimmed exact match) and keep their SRS state when
 * the extension re-adds a word with fresh context/phonetics.
 */
import { randomBytes } from 'node:crypto';
import {
  LIMITS,
  TARGET_LANGUAGES,
  WORDBOOK_VERSION,
} from './constants.js';
import { sanitizeDictionary } from './dictionary.js';
import { apiError } from './errors.js';
import {
  isDue,
  REVIEW_GRADES,
  scheduleReview,
  wordbookStats,
} from './srs.js';
import {
  isNonEmptyString,
  isPlainObject,
  normalizeHttpUrl,
  normalizeLanguageTag,
  normalizeLimit,
  normalizeOptionalString,
} from './validate.js';

/** Maximum stored entries (DESIGN §5.8). */
export const WORDBOOK_ITEM_LIMIT = LIMITS.wordbookItems;

/** Filters accepted by `GET /wordbook`. */
export const WORDBOOK_FILTERS = Object.freeze(['all', 'due', 'mastered']);

const MAX_ID_CHARS = 100;

/**
 * Build a fresh opaque wordbook id.
 * @param {number} [nowMs] - current timestamp.
 * @returns {string} e.g. `wb_lxp4c8a1f3b2c4d5`.
 */
export function wordbookEntryId(nowMs = Date.now()) {
  const stamp = Math.max(0, Number(nowMs) || 0).toString(36);
  return `wb_${stamp}${randomBytes(4).toString('hex')}`;
}

/**
 * Validate the `id` field shared by update/review/remove.
 * @param {unknown} value - request id.
 * @returns {string}
 */
function requireItemId(value) {
  if (!isNonEmptyString(value, MAX_ID_CHARS)) {
    throw apiError('BAD_REQUEST', `id must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
  }
  return value.trim();
}

/**
 * Normalize and validate the `filter` query parameter.
 * @param {unknown} value - raw filter.
 * @returns {'all'|'due'|'mastered'}
 */
function normalizeFilter(value) {
  if (value === undefined || value === null || value === '') return 'all';
  if (typeof value !== 'string' || !WORDBOOK_FILTERS.includes(value)) {
    throw apiError('BAD_REQUEST', `filter must be one of: ${WORDBOOK_FILTERS.join(', ')}`);
  }
  return value;
}

/**
 * Case-insensitive search across the useful text fields.
 * @param {object} item - wordbook entry.
 * @param {string} query - lowercased query.
 * @returns {boolean}
 */
function matchesQuery(item, query) {
  if (query.length === 0) return true;
  return [item.word, item.translation, item.context, item.note]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(query));
}

/**
 * Sort key comparator for one filter mode.
 * @param {object} left - first entry.
 * @param {object} right - second entry.
 * @param {'all'|'due'|'mastered'} filter - active filter.
 * @returns {number}
 */
function compareItems(left, right, filter) {
  if (filter === 'due') return (left.dueAt ?? 0) - (right.dueAt ?? 0) || (left.createdAt ?? 0) - (right.createdAt ?? 0);
  if (filter === 'mastered') return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  return (right.createdAt ?? 0) - (left.createdAt ?? 0);
}

/**
 * Create the wordbook collaborator.
 * @param {{store: import('./store.js').JsonFileStore, logger?: object,
 *   now?: () => number}} input
 * @returns {{list: Function, add: Function, update: Function, review: Function, remove: Function}}
 */
export function createWordbookService({ store, logger, now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();

  /**
   * @param {object} data - loaded document.
   * @returns {object[]} entry array (shared reference; callers must not mutate).
   */
  function readItems(data) {
    return Array.isArray(data?.items) ? data.items : [];
  }

  return {
    /**
     * List entries plus aggregate stats.
     * @param {{query?: string, filter?: string, limit?: string|number}} [options]
     * @returns {Promise<{items: object[], stats: object}>}
     */
    async list(options = {}) {
      const data = await store.read();
      const items = readItems(data);
      const timestamp = clock();
      const query = typeof options.query === 'string' ? options.query.trim().toLowerCase().slice(0, 100) : '';
      const filter = normalizeFilter(options.filter);
      const limit = normalizeLimit(options.limit, {
        fallback: LIMITS.wordbookListDefault,
        min: 1,
        max: LIMITS.wordbookListMax,
      });
      const matching = items
        .filter((item) => {
          if (filter === 'due') return isDue(item, timestamp);
          if (filter === 'mastered') return item?.mastered === true;
          return true;
        })
        .filter((item) => matchesQuery(item, query))
        .sort((left, right) => compareItems(left, right, filter));
      return {
        items: matching.slice(0, limit).map((item) => structuredClone(item)),
        stats: wordbookStats(items, timestamp),
      };
    },

    /**
     * Add one entry, or update the existing `word + targetLanguage` entry while
     * preserving its SRS state (DESIGN §5.8).
     * @param {unknown} input - request body.
     * @returns {Promise<{item: object, existed: boolean}>}
     */
    async add(input) {
      const body = isPlainObject(input) ? input : {};
      const word = typeof body.word === 'string' ? body.word.trim() : '';
      if (!isNonEmptyString(word, 200)) {
        throw apiError('BAD_REQUEST', 'word must be a non-empty string of at most 200 characters');
      }
      const translation = typeof body.translation === 'string' ? body.translation.trim() : '';
      if (translation.length === 0 || translation.length > 4000) {
        throw apiError('BAD_REQUEST', 'translation must be a non-empty string of at most 4000 characters');
      }
      const targetLanguage = normalizeLanguageTag(body.targetLanguage, { field: 'targetLanguage', allowed: TARGET_LANGUAGES });
      if (typeof targetLanguage !== 'string' || targetLanguage.length === 0) {
        throw apiError('BAD_REQUEST', 'targetLanguage is required');
      }
      const phonetic = normalizeOptionalString(body.phonetic, { field: 'phonetic', max: 200 });
      const context = normalizeOptionalString(body.context, { field: 'context', max: LIMITS.lookupContextChars });
      const sourceTitle = normalizeOptionalString(body.sourceTitle, { field: 'sourceTitle', max: 500 });
      const note = normalizeOptionalString(body.note, { field: 'note', max: 2000 });
      const sourceUrl = normalizeHttpUrl(body.sourceUrl, { field: 'sourceUrl' });
      let audioUrl = normalizeHttpUrl(body.audioUrl, { field: 'audioUrl' });
      if (audioUrl !== undefined && audioUrl.length > 1000) throw apiError('BAD_REQUEST', 'audioUrl is too long');
      if (audioUrl !== undefined && /^(https?:\/\/)/i.test(audioUrl) === false) audioUrl = undefined;
      const dictionary = sanitizeDictionary(body.dictionary);
      const timestamp = clock();

      return store.mutate((data) => {
        const items = readItems(data);
        const existing = items.find((item) => item.word === word && item.targetLanguage === targetLanguage);
        if (existing !== undefined) {
          if (context !== undefined) existing.context = context;
          if (phonetic !== undefined) existing.phonetic = phonetic;
          if (audioUrl !== undefined) existing.audioUrl = audioUrl;
          if (dictionary !== undefined && existing.dictionary === undefined) existing.dictionary = dictionary;
          if (sourceUrl !== undefined && existing.sourceUrl === undefined) existing.sourceUrl = sourceUrl;
          if (sourceTitle !== undefined && existing.sourceTitle === undefined) existing.sourceTitle = sourceTitle;
          existing.updatedAt = timestamp;
          data.version = WORDBOOK_VERSION;
          data.updatedAt = timestamp;
          return { item: structuredClone(existing), existed: true };
        }
        if (items.length >= WORDBOOK_ITEM_LIMIT) {
          throw apiError('BAD_REQUEST', `wordbook is full (${WORDBOOK_ITEM_LIMIT} entries)`);
        }
        const item = {
          id: wordbookEntryId(timestamp),
          word,
          translation,
          targetLanguage,
          note: note ?? '',
          createdAt: timestamp,
          updatedAt: timestamp,
          reviews: 0,
          lapses: 0,
          level: 0,
          dueAt: timestamp,
          mastered: false,
          suspended: false,
        };
        if (phonetic !== undefined) item.phonetic = phonetic;
        if (audioUrl !== undefined) item.audioUrl = audioUrl;
        if (context !== undefined) item.context = context;
        if (sourceUrl !== undefined) item.sourceUrl = sourceUrl;
        if (sourceTitle !== undefined) item.sourceTitle = sourceTitle;
        if (dictionary !== undefined) item.dictionary = dictionary;
        items.push(item);
        data.version = WORDBOOK_VERSION;
        data.items = items;
        data.updatedAt = timestamp;
        return { item: structuredClone(item), existed: false };
      });
    },

    /**
     * Apply a manual patch (`note`, `translation`, `mastered`, `suspended`).
     * @param {unknown} input - request body.
     * @returns {Promise<{item: object}>}
     */
    async update(input) {
      const body = isPlainObject(input) ? input : {};
      const id = requireItemId(body.id);
      if (!isPlainObject(body.patch)) throw apiError('BAD_REQUEST', 'patch must be a JSON object');
      const changes = {};
      for (const [key, value] of Object.entries(body.patch)) {
        if (key === 'note') {
          if (typeof value !== 'string' || value.length > 2000) throw apiError('BAD_REQUEST', 'note must be a string of at most 2000 characters');
          changes.note = value;
        } else if (key === 'translation') {
          if (typeof value !== 'string' || value.length > 4000) throw apiError('BAD_REQUEST', 'translation must be a string of at most 4000 characters');
          changes.translation = value;
        } else if (key === 'mastered' || key === 'suspended') {
          if (typeof value !== 'boolean') throw apiError('BAD_REQUEST', `${key} must be a boolean`);
          changes[key] = value;
        } else {
          try {
            logger?.warn?.(`[dsh-web-translator] wordbook: ignoring unknown patch field ${key}`);
          } catch {
            // Diagnostics only.
          }
        }
      }
      if (Object.keys(changes).length === 0) throw apiError('BAD_REQUEST', 'patch contains no supported fields');
      const timestamp = clock();
      return store.mutate((data) => {
        const items = readItems(data);
        const item = items.find((entry) => entry.id === id);
        if (item === undefined) throw apiError('NOT_FOUND', 'wordbook item not found');
        Object.assign(item, changes);
        item.updatedAt = timestamp;
        data.version = WORDBOOK_VERSION;
        data.updatedAt = timestamp;
        return { item: structuredClone(item) };
      });
    },

    /**
     * Record one graded review and persist the new schedule immediately.
     * @param {unknown} input - request body.
     * @returns {Promise<{item: object}>}
     */
    async review(input) {
      const body = isPlainObject(input) ? input : {};
      const id = requireItemId(body.id);
      if (!REVIEW_GRADES.includes(body.grade)) {
        throw apiError('BAD_REQUEST', 'grade must be again, hard or good');
      }
      const timestamp = clock();
      return store.mutate((data) => {
        const items = readItems(data);
        const item = items.find((entry) => entry.id === id);
        if (item === undefined) throw apiError('NOT_FOUND', 'wordbook item not found');
        Object.assign(item, scheduleReview(item, body.grade, timestamp));
        data.version = WORDBOOK_VERSION;
        data.updatedAt = timestamp;
        return { item: structuredClone(item) };
      });
    },

    /**
     * Remove one entry.
     * @param {unknown} input - request body.
     * @returns {Promise<object>} empty result object.
     */
    async remove(input) {
      const body = isPlainObject(input) ? input : {};
      const id = requireItemId(body.id);
      const timestamp = clock();
      return store.mutate((data) => {
        const items = readItems(data);
        const index = items.findIndex((entry) => entry.id === id);
        if (index === -1) throw apiError('NOT_FOUND', 'wordbook item not found');
        items.splice(index, 1);
        data.version = WORDBOOK_VERSION;
        data.items = items;
        data.updatedAt = timestamp;
        return {};
      });
    },
  };
}
