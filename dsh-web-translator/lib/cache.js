/**
 * Translation batch cache (DESIGN §4.2 + DESIGN-CACHE v5).
 *
 * Two layers share one synchronous `get`/`set` interface (so `translate.js`
 * stays unchanged):
 *  - `createLruCache`: the legacy in-process LRU (512 batches);
 *  - `createPersistentBatchCache`: the same fast in-memory LRU plus a disk
 *    mirror through the shared JSON store, so a DSH restart / plugin reload can
 *    serve the same page from disk with zero model calls and zero tokens.
 *
 * Persistence is strictly best-effort: any failure only warns once and leaves
 * the in-memory cache working, so it can never fail a translation.
 */
import { createHash } from 'node:crypto';
import { LIMITS } from './constants.js';

/** Capacity from DESIGN §4.2 ("进程内 LRU（512 批）"). */
export const TRANSLATION_CACHE_SIZE = 512;

/** On-disk translation-cache envelope version (DESIGN-CACHE §2). */
export const PERSISTENT_CACHE_VERSION = 1;

/** Default persistent capacity, in batch entries (DESIGN-CACHE §2: 1000). */
export const PERSISTENT_CACHE_MAX = LIMITS.translationCacheEntries;

/** Default persistent entry TTL: 7 days (DESIGN-CACHE §2). */
export const PERSISTENT_CACHE_TTL_MS = LIMITS.translationCacheTtlMs;

/** Serialized-envelope cap; oldest entries are dropped beyond it (DESIGN-CACHE §2: ~4 MB). */
export const PERSISTENT_CACHE_MAX_BYTES = LIMITS.translationCacheFileBytes;

/** Coalescing window for the writes scheduled by `set` (DESIGN-CACHE §3: ~300 ms). */
export const PERSISTENT_FLUSH_DELAY_MS = 300;

/**
 * Create a fixed-capacity LRU map.
 * @param {{max?: number}} [options] - capacity; defaults to 512.
 * @returns {{get: (key: string) => any, set: (key: string, value: any) => void,
 *   has: (key: string) => boolean, delete: (key: string) => boolean,
 *   clear: () => void, readonly size: number}} cache facade.
 */
export function createLruCache({ max = TRANSLATION_CACHE_SIZE } = {}) {
  const capacity = Number.isInteger(max) && max > 0 ? max : TRANSLATION_CACHE_SIZE;
  const entries = new Map();

  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      if (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    has(key) {
      return entries.has(key);
    },
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Build the cache key from DESIGN §4.2:
 * `provider|model|target|sha1(system|userTemplate|textsJson)`.
 *
 * The source language joins the hash material because it changes the rendered
 * prompt without otherwise changing the key. Placeholders are rendered before
 * hashing, so editing a prompt invalidates cached translations.
 * @param {{provider: string, model: string, targetLanguage: string,
 *   system: string, userTemplate: string, sourceLanguage?: string,
 *   textsJson: string}} input - request identity.
 * @returns {string}
 */
export function createBatchCacheKey({ provider, model, targetLanguage, system, userTemplate, sourceLanguage = '', textsJson }) {
  const material = [system, userTemplate, sourceLanguage, textsJson].join('\u0000');
  const digest = createHash('sha1').update(material).digest('hex');
  return `${provider}|${model}|${targetLanguage}|${digest}`;
}

/**
 * sha1 helper exposed for tests and diagnostics.
 * @param {string} material - arbitrary text.
 * @returns {string} hex digest.
 */
export function sha1(material) {
  return createHash('sha1').update(String(material)).digest('hex');
}

/** @returns {boolean} whether a value is a `string[]` translations payload. */
function isTranslations(value) {
  return Array.isArray(value) && value.every((text) => typeof text === 'string');
}

/** @returns {string} one-line description of an unknown error. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create the disk-backed translation batch cache (DESIGN-CACHE §3).
 *
 * `get`/`set` are synchronous and never throw; writes are coalesced into one
 * `store.mutate` about {@link PERSISTENT_FLUSH_DELAY_MS} later. `hydrate()`
 * loads the previous process' entries, `clear()` empties memory and disk and
 * `flush()` forces a write (used on plugin unload).
 *
 * @param {{store?: {read: Function, mutate: Function}, max?: number,
 *   ttlMs?: number, now?: (() => number) | number,
 *   logger?: {warn?: Function}, flushDelayMs?: number,
 *   maxBytes?: number}} [options] - JSON store and tunables.
 * @returns {{get: Function, set: Function, clear: Function, flush: Function,
 *   hydrate: Function, whenReady: Function, stats: Function}}
 */
export function createPersistentBatchCache({
  store,
  max = PERSISTENT_CACHE_MAX,
  ttlMs = PERSISTENT_CACHE_TTL_MS,
  now = Date.now,
  logger,
  flushDelayMs = PERSISTENT_FLUSH_DELAY_MS,
  maxBytes = PERSISTENT_CACHE_MAX_BYTES,
} = {}) {
  const clock = typeof now === 'function' ? now : () => (Number.isFinite(now) ? now : Date.now());
  const capacity = Number.isInteger(max) && max > 0 ? max : PERSISTENT_CACHE_MAX;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.trunc(ttlMs) : PERSISTENT_CACHE_TTL_MS;
  const delay = Number.isFinite(flushDelayMs) && flushDelayMs >= 0
    ? Math.trunc(flushDelayMs)
    : PERSISTENT_FLUSH_DELAY_MS;
  const sizeLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : PERSISTENT_CACHE_MAX_BYTES;
  const persistent = store !== null && typeof store === 'object'
    && typeof store.read === 'function'
    && typeof store.mutate === 'function';

  /** key -> `{at, translations}`; Map insertion order is the LRU order (oldest first). */
  const entries = new Map();
  let timer = null;
  let warned = false;
  let dirty = false;
  let persisted = false;
  let hydrated = false;
  let revision = 0;
  let hydratePromise;

  /** @returns {number} the injected clock, coerced to a safe integer. */
  function timestamp() {
    const value = Number(clock());
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }

  /**
   * Entries expire once `now - at > ttlMs` (DESIGN-CACHE §2: `at + ttlMs < now`).
   * @param {number} at - entry write time.
   * @returns {boolean}
   */
  function isExpired(at) {
    return timestamp() - at > ttl;
  }

  /** @param {string} message - diagnostic line (logged once per cache). */
  function warn(message) {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(`[dsh-web-translator] cache: ${message}`);
    } catch {
      // Diagnostics only.
    }
  }

  /** Keep the Map at the LRU capacity, dropping the oldest insertion first. */
  function trimLru() {
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) return;
      entries.delete(oldest.value);
    }
  }

  /** Drop the oldest entries by `at` until the cache respects its capacity. */
  function trimByAge() {
    while (entries.size > capacity) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, entry] of entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      entries.delete(oldestKey);
    }
  }

  /** @param {string} key - cache key. @returns {object | undefined} the LRU-touched entry. */
  function touch(key) {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  }

  /**
   * Read one cached translation batch (synchronous fast path).
   * @param {string} key - `createBatchCacheKey()` output.
   * @returns {string[] | undefined} a copy of the cached translations.
   */
  function get(key) {
    try {
      if (typeof key !== 'string' || key.length === 0) return undefined;
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (isExpired(entry.at)) {
        entries.delete(key);
        return undefined;
      }
      const live = touch(key);
      return live === undefined ? undefined : live.translations.slice();
    } catch {
      return undefined;
    }
  }

  /**
   * Store one translation batch in memory and schedule a debounced flush.
   * @param {string} key - `createBatchCacheKey()` output.
   * @param {unknown} translations - translated segments.
   * @returns {boolean} whether the value was accepted.
   */
  function set(key, translations) {
    try {
      if (typeof key !== 'string' || key.length === 0) return false;
      if (!isTranslations(translations)) return false;
      entries.delete(key);
      entries.set(key, { at: timestamp(), translations: translations.slice() });
      trimLru();
      revision += 1;
      dirty = true;
      scheduleFlush();
      return true;
    } catch {
      return false;
    }
  }

  /** Arm the coalescing timer for the next write (idempotent while armed). */
  function scheduleFlush() {
    if (!persistent || timer !== null) return;
    try {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, delay);
      if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    } catch {
      timer = null;
    }
  }

  /** Cancel a pending debounced write. */
  function cancelScheduledFlush() {
    if (timer === null) return;
    try {
      clearTimeout(timer);
    } catch {
      // Optional timer seam.
    }
    timer = null;
  }

  /**
   * Build the compact on-disk envelope (DESIGN-CACHE §2), pruning expired
   * entries and dropping the oldest ones until the JSON size cap is honoured.
   * @returns {{v: number, savedAt: number, entries: Record<string, [number, string[]]>}}
   */
  function buildEnvelope() {
    const kept = [];
    for (const [key, entry] of entries) {
      if (isExpired(entry.at)) {
        entries.delete(key);
        continue;
      }
      const pair = JSON.stringify([entry.at, entry.translations]);
      kept.push({
        key,
        at: entry.at,
        translations: entry.translations,
        bytes: Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(pair) + 4,
      });
    }
    let used = 128; // envelope overhead: {"v":1,"savedAt":…,"entries":{}}
    for (const item of kept) used += item.bytes;
    let start = 0;
    while (used > sizeLimit && start < kept.length) {
      used -= kept[start].bytes;
      entries.delete(kept[start].key);
      start += 1;
    }
    const out = {};
    for (let index = start; index < kept.length; index += 1) {
      const item = kept[index];
      out[item.key] = [item.at, item.translations];
    }
    return { v: PERSISTENT_CACHE_VERSION, savedAt: timestamp(), entries: out };
  }

  /**
   * Replace the store document with one envelope.
   * @param {object} envelope - complete next document.
   * @returns {Promise<boolean>} whether the write succeeded.
   */
  async function persist(envelope) {
    if (!persistent) return false;
    try {
      await store.mutate((draft) => {
        for (const key of Object.keys(draft)) delete draft[key];
        Object.assign(draft, envelope);
      });
      return true;
    } catch (error) {
      warn(`cannot persist the translation cache: ${describe(error)}`);
      return false;
    }
  }

  /**
   * Force-write the current in-memory state (best effort).
   * @returns {Promise<boolean>} whether the write succeeded.
   */
  async function flush() {
    if (!persistent) return false;
    cancelScheduledFlush();
    const snapshotRevision = revision;
    let envelope;
    try {
      envelope = buildEnvelope();
    } catch (error) {
      warn(`cannot serialize the translation cache: ${describe(error)}`);
      return false;
    }
    const ok = await persist(envelope);
    if (!ok) return false;
    persisted = true;
    if (revision === snapshotRevision) dirty = false;
    else if (dirty) scheduleFlush();
    return true;
  }

  /**
   * Load the previous process' cache document into memory (idempotent).
   * Missing/corrupt documents start empty and warn once.
   * @returns {Promise<boolean>} whether a valid document was loaded.
   */
  async function hydrate() {
    if (hydratePromise === undefined) {
      hydratePromise = hydrateInternal().catch((error) => {
        warn(`cannot hydrate the translation cache: ${describe(error)}`);
        hydrated = true;
        return false;
      });
    }
    return hydratePromise;
  }

  /** @returns {Promise<boolean>} hydration worker. */
  async function hydrateInternal() {
    if (!persistent) {
      hydrated = true;
      return true;
    }
    let raw;
    try {
      raw = await store.read();
    } catch (error) {
      warn(`cannot read the translation cache: ${describe(error)}`);
      hydrated = true;
      return false;
    }
    hydrated = true;
    const valid = raw !== null
      && typeof raw === 'object'
      && !Array.isArray(raw)
      && raw.v === PERSISTENT_CACHE_VERSION
      && raw.entries !== null
      && typeof raw.entries === 'object'
      && !Array.isArray(raw.entries);
    if (!valid) {
      warn('unexpected cache document; starting with an empty cache');
      return false;
    }
    const loaded = [];
    for (const [key, value] of Object.entries(raw.entries)) {
      if (typeof key !== 'string' || key.length === 0) continue;
      if (!Array.isArray(value) || value.length !== 2) continue;
      const at = Number(value[0]);
      if (!Number.isFinite(at) || at < 0) continue;
      if (!isTranslations(value[1])) continue;
      if (isExpired(Math.trunc(at))) continue;
      loaded.push({ key, at: Math.trunc(at), translations: value[1].slice() });
    }
    loaded.sort((left, right) => left.at - right.at);
    for (const item of loaded) {
      // Entries written by this process after startup win over disk state.
      if (entries.has(item.key)) continue;
      entries.set(item.key, { at: item.at, translations: item.translations });
    }
    trimByAge();
    persisted = true;
    return true;
  }

  /**
   * Wait until the startup hydration attempt finished (never rejects).
   * @returns {Promise<boolean>} resolves once the cache is ready to serve.
   */
  function whenReady() {
    if (hydratePromise === undefined) return Promise.resolve(true);
    return hydratePromise.then(() => true, () => true);
  }

  /**
   * Empty the cache in memory and on disk (DESIGN-CACHE §3).
   * @returns {Promise<boolean>} whether the empty document was written.
   */
  function clear() {
    try {
      entries.clear();
    } catch {
      // Map.clear cannot throw on a healthy cache.
    }
    revision += 1;
    dirty = false;
    cancelScheduledFlush();
    if (!persistent) {
      persisted = false;
      return Promise.resolve(true);
    }
    return persist({
      v: PERSISTENT_CACHE_VERSION,
      savedAt: timestamp(),
      entries: {},
    }).then((ok) => {
      if (ok) {
        persisted = true;
        dirty = false;
      } else {
        dirty = true;
      }
      return ok;
    });
  }

  /**
   * Observable cache state (DESIGN-CACHE §3).
   * @returns {{entries: number, max: number, ttlMs: number, persisted: boolean,
   *   dirty: boolean, hydrated: boolean}}
   */
  function stats() {
    return {
      entries: entries.size,
      max: capacity,
      ttlMs: ttl,
      persisted,
      dirty,
      hydrated,
    };
  }

  return { get, set, clear, flush, hydrate, whenReady, stats };
}
