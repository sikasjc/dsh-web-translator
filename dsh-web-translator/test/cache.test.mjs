/** Translation LRU / cache-key identity (DESIGN §4.2) and the persistent cache (DESIGN-CACHE). */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  createBatchCacheKey,
  createLruCache,
  createPersistentBatchCache,
  PERSISTENT_CACHE_MAX,
  PERSISTENT_CACHE_MAX_BYTES,
  PERSISTENT_CACHE_TTL_MS,
  PERSISTENT_CACHE_VERSION,
  PERSISTENT_FLUSH_DELAY_MS,
  sha1,
  TRANSLATION_CACHE_SIZE,
} from '../lib/cache.js';
import { LIMITS } from '../lib/constants.js';
import { createJsonStore } from '../lib/store.js';
import { createFakeLogger, createTempDir, removeTempDir } from './helpers.mjs';

const baseKey = {
  provider: 'modelhub',
  model: 'deepseek-flash',
  targetLanguage: 'zh-CN',
  system: 'system prompt',
  userTemplate: 'user template {{segmentsJson}}',
  sourceLanguage: 'auto',
  textsJson: '["hello"]',
};

test('LRU evicts the least recently used entry', () => {
  const cache = createLruCache({ max: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1); // refresh a, so b is oldest
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size, 2);
});

test('LRU updates existing keys without growing', () => {
  const cache = createLruCache({ max: 2 });
  cache.set('a', 1);
  cache.set('a', 2);
  assert.equal(cache.get('a'), 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.size, 0);
  cache.clear();
});

test('default capacity is 512 batches', () => {
  assert.equal(TRANSLATION_CACHE_SIZE, 512);
  const cache = createLruCache();
  for (let index = 0; index < 520; index += 1) cache.set(`key-${index}`, index);
  assert.equal(cache.size, 512);
  assert.equal(cache.get('key-0'), undefined);
  assert.equal(cache.get('key-519'), 519);
});

test('cache key follows provider|model|target|sha1 format', () => {
  const key = createBatchCacheKey(baseKey);
  assert.match(key, /^modelhub\|deepseek-flash\|zh-CN\|[0-9a-f]{40}$/);
  assert.ok(key.endsWith(sha1([
    baseKey.system,
    baseKey.userTemplate,
    baseKey.sourceLanguage,
    baseKey.textsJson,
  ].join('\u0000'))));
});

test('cache key changes with provider/model/target/prompts/source/texts', () => {
  const key = createBatchCacheKey(baseKey);
  assert.notEqual(key, createBatchCacheKey({ ...baseKey, provider: 'other' }));
  assert.notEqual(key, createBatchCacheKey({ ...baseKey, model: 'other' }));
  assert.notEqual(key, createBatchCacheKey({ ...baseKey, targetLanguage: 'ja' }));
  assert.notEqual(key, createBatchCacheKey({ ...baseKey, system: 'changed' }));
  assert.notEqual(key, createBatchCacheKey({ ...baseKey, userTemplate: 'changed' }));
  assert.notEqual(key, createBatchCacheKey({ ...baseKey, sourceLanguage: 'en' }));
  assert.notEqual(key, createBatchCacheKey({ ...baseKey, textsJson: '["hello","world"]' }));
  assert.equal(key, createBatchCacheKey({ ...baseKey }));
});

/* ------------------------------------------------------------------ */
/* Persistent disk-backed cache (DESIGN-CACHE §2/§3)                   */
/* ------------------------------------------------------------------ */

/** In-memory JSON-store double the persistent cache mutates (mirrors lib/store.js API). */
function createMemoryStore(initial = { v: PERSISTENT_CACHE_VERSION, savedAt: 0, entries: {} }) {
  const state = { data: initial, reads: 0, writes: 0, failRead: false, failWrite: false };
  return {
    state,
    async read() {
      state.reads += 1;
      if (state.failRead) throw new Error('read boom');
      return state.data;
    },
    async mutate(mutator) {
      state.writes += 1;
      if (state.failWrite) throw new Error('write boom');
      const draft = structuredClone(state.data);
      mutator(draft);
      state.data = draft;
      return undefined;
    },
  };
}

/** Persistent cache over a memory store, with capture-friendly defaults. */
function setupPersistent({ store = createMemoryStore(), now = () => 10_000, ...options } = {}) {
  const logger = createFakeLogger();
  const cache = createPersistentBatchCache({ store, now, logger, ...options });
  return { cache, store, logger };
}

test('persistent cache defaults: 1000 entries, 7 day TTL, ~4MB cap, 300ms debounce', () => {
  assert.equal(PERSISTENT_CACHE_MAX, 1000);
  assert.equal(LIMITS.translationCacheEntries, 1000);
  assert.equal(PERSISTENT_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(LIMITS.translationCacheTtlMs, PERSISTENT_CACHE_TTL_MS);
  assert.equal(PERSISTENT_CACHE_MAX_BYTES, 4 * 1024 * 1024);
  assert.equal(LIMITS.translationCacheFileBytes, PERSISTENT_CACHE_MAX_BYTES);
  assert.equal(PERSISTENT_FLUSH_DELAY_MS, 300);
  assert.equal(PERSISTENT_CACHE_VERSION, 1);

  const { cache } = setupPersistent();
  assert.deepEqual(cache.stats(), {
    entries: 0,
    max: 1000,
    ttlMs: PERSISTENT_CACHE_TTL_MS,
    persisted: false,
    dirty: false,
    hydrated: false,
  });
});

test('persistent cache set/get round-trips translations and touches the LRU', () => {
  const { cache, store } = setupPersistent({ max: 2 });
  assert.equal(cache.set('a', ['甲']), true);
  assert.equal(cache.set('b', ['乙']), true);
  assert.deepEqual(cache.get('a'), ['甲']);
  cache.set('c', ['丙']);
  assert.equal(cache.get('b'), undefined, 'b was the least recently used entry');
  assert.deepEqual(cache.get('a'), ['甲']);
  assert.deepEqual(cache.get('c'), ['丙']);
  assert.equal(cache.stats().entries, 2);
  assert.equal(store.state.writes, 0, 'writes are debounced, never synchronous');

  assert.equal(cache.set('', ['x']), false);
  assert.equal(cache.set('k', 'not-an-array'), false);
  assert.equal(cache.set('k', [1, 2]), false);
  assert.equal(cache.get(42), undefined);
});

test('persistent cache ignores expired entries at the TTL boundary', () => {
  let current = 1000;
  const { cache } = setupPersistent({ now: () => current, ttlMs: 500 });
  cache.set('k', ['x']);
  current = 1500;
  assert.deepEqual(cache.get('k'), ['x'], 'at exactly at+ttl the entry is still live (DESIGN-CACHE §2)');
  current = 1501;
  assert.equal(cache.get('k'), undefined, 'one ms past the TTL the entry is ignored');
  assert.equal(cache.stats().entries, 0, 'the expired entry was pruned on read');
});

test('persistent cache prunes expired entries before writing', async () => {
  let current = 1000;
  const { cache, store } = setupPersistent({ now: () => current, ttlMs: 500, flushDelayMs: 10_000 });
  cache.set('old', ['旧']);
  current = 1400;
  cache.set('fresh', ['新']);
  current = 1600; // old: 600ms > ttl; fresh: 200ms
  assert.equal(await cache.flush(), true);
  assert.deepEqual(Object.keys(store.state.data.entries), ['fresh']);
  assert.deepEqual(store.state.data.entries.fresh[1], ['新']);
});

test('persistent cache hydrate validates, drops expired/invalid and keeps the newest', async () => {
  const store = createMemoryStore({
    v: PERSISTENT_CACHE_VERSION,
    savedAt: 1,
    entries: {
      good_old: [4100, ['旧']],
      good_mid: [4500, ['中']],
      good_new: [4900, ['新']],
      expired: [3000, ['过期']],
      bad_value: 'nope',
      bad_pair: [1000],
      bad_at: ['soon', ['x']],
      bad_translations: [4500, [1, 2]],
    },
  });
  const { cache, logger } = setupPersistent({ store, now: () => 5000, ttlMs: 1000, max: 2 });
  assert.equal(await cache.hydrate(), true);
  assert.equal(cache.stats().hydrated, true);
  assert.equal(cache.stats().persisted, true);
  assert.deepEqual(cache.get('good_new'), ['新']);
  assert.deepEqual(cache.get('good_mid'), ['中']);
  assert.equal(cache.get('good_old'), undefined, 'over-cap history keeps the newest entries');
  assert.equal(cache.get('expired'), undefined);
  assert.equal(cache.get('bad_value'), undefined);
  assert.equal(cache.get('bad_pair'), undefined);
  assert.equal(cache.get('bad_at'), undefined);
  assert.equal(cache.get('bad_translations'), undefined);
  assert.equal(logger.lines.warn.length, 0, 'a valid document hydrates without noisy warnings');
});

test('persistent cache hydrate never overwrites entries written after startup', async () => {
  const store = createMemoryStore({
    v: PERSISTENT_CACHE_VERSION,
    savedAt: 0,
    entries: { k1: [1000, ['disk']], k2: [1000, ['disk2']] },
  });
  const { cache } = setupPersistent({ store, now: () => 2000, ttlMs: 10_000, flushDelayMs: 10_000 });
  cache.set('k1', ['memory']);
  assert.equal(await cache.hydrate(), true);
  assert.deepEqual(cache.get('k1'), ['memory']);
  assert.deepEqual(cache.get('k2'), ['disk2']);
});

test('persistent cache hydrate tolerates broken documents and only runs once', async () => {
  const foreign = setupPersistent({ store: createMemoryStore({ v: 2, entries: { a: [1, ['x']] } }) });
  assert.equal(await foreign.cache.hydrate(), false);
  assert.equal(foreign.cache.stats().entries, 0);
  assert.equal(foreign.logger.lines.warn.length, 1);
  assert.match(foreign.logger.lines.warn[0], /unexpected cache document/);
  const readsBefore = foreign.store.state.reads;
  assert.equal(await foreign.cache.hydrate(), false, 'idempotent second call');
  assert.equal(foreign.store.state.reads, readsBefore, 'hydration reads the store once');

  const throwing = setupPersistent({ store: createMemoryStore() });
  throwing.store.state.failRead = true;
  assert.equal(await throwing.cache.hydrate(), false);
  assert.equal(throwing.cache.stats().entries, 0);
  assert.match(throwing.logger.lines.warn[0], /cannot read the translation cache/);

  const memoryOnly = createPersistentBatchCache({});
  assert.equal(await memoryOnly.hydrate(), true);
  assert.equal(await memoryOnly.whenReady(), true);
  assert.equal(memoryOnly.set('k', ['甲']), true);
  assert.deepEqual(memoryOnly.get('k'), ['甲']);
  assert.equal(await memoryOnly.flush(), false);
  assert.equal(await memoryOnly.clear(), true);
});

test('persistent cache flush writes the compact v1 envelope', async () => {
  let current = 1_793_940_000_000;
  const { cache, store } = setupPersistent({ now: () => current, flushDelayMs: 10_000 });
  cache.set('key-one', ['译文一', '译文二']);
  cache.set('key-two', ['译文三']);
  current += 1234;
  assert.equal(await cache.flush(), true);

  assert.deepEqual(Object.keys(store.state.data).sort(), ['entries', 'savedAt', 'v']);
  assert.equal(store.state.data.v, PERSISTENT_CACHE_VERSION);
  assert.equal(store.state.data.savedAt, current);
  assert.deepEqual(store.state.data.entries, {
    'key-one': [1_793_940_000_000, ['译文一', '译文二']],
    'key-two': [1_793_940_000_000, ['译文三']],
  });
  assert.equal(store.state.writes, 1, 'flush cancels the pending debounced write');
  assert.equal(cache.stats().persisted, true);
  assert.equal(cache.stats().dirty, false);
});

test('persistent cache writes a real cache.json through the JSON store', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const file = join(dir, 'cache.json');
  const logger = createFakeLogger();
  const makeStore = () => createJsonStore(file, {
    defaultValue: () => ({ v: PERSISTENT_CACHE_VERSION, savedAt: 0, entries: {} }),
    logger,
  });

  const cache = createPersistentBatchCache({ store: makeStore(), now: () => 42_000, logger, flushDelayMs: 10_000 });
  assert.equal(await cache.hydrate(), true);
  cache.set('k', ['甲', '乙']);
  assert.equal(await cache.flush(), true);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw, { v: 1, savedAt: 42_000, entries: { k: [42_000, ['甲', '乙']] } });

  // A fresh cache over the same file restores the entry (the persistence goal).
  const restored = createPersistentBatchCache({ store: makeStore(), now: () => 42_500, logger });
  assert.equal(await restored.hydrate(), true);
  assert.deepEqual(restored.get('k'), ['甲', '乙']);
});

test('persistent cache debounces set writes into one flush', async () => {
  const { cache, store } = setupPersistent({ flushDelayMs: 20 });
  cache.set('a', ['x']);
  cache.set('b', ['y']);
  assert.equal(store.state.writes, 0, 'nothing is written synchronously');
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
  assert.equal(store.state.writes, 1, 'both sets coalesce into one write');
  assert.deepEqual(Object.keys(store.state.data.entries).sort(), ['a', 'b']);
});

test('persistent cache clear empties memory and disk', async () => {
  const { cache, store } = setupPersistent({ flushDelayMs: 10_000 });
  cache.set('a', ['x']);
  assert.equal(await cache.clear(), true);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.stats().entries, 0);
  assert.deepEqual(store.state.data.entries, {});
  assert.equal(cache.stats().persisted, true);
  assert.equal(cache.stats().dirty, false);
  assert.equal(await cache.clear(), true, 'clear is repeatable');
  assert.deepEqual(store.state.data.entries, {});
});

test('a throwing store never breaks persistent cache get/set/flush/clear', async () => {
  const { cache, store, logger } = setupPersistent({ flushDelayMs: 10_000 });
  store.state.failRead = true;
  assert.equal(await cache.hydrate(), false);
  store.state.failWrite = true;

  assert.equal(cache.set('k', ['甲']), true);
  assert.deepEqual(cache.get('k'), ['甲']);
  assert.equal(await cache.flush(), false);
  assert.equal(await cache.clear(), false);
  assert.equal(cache.get('k'), undefined);
  assert.equal(logger.lines.warn.length, 1, 'persistence failures warn only once');
  assert.equal(cache.stats().persisted, false);
  assert.equal(cache.stats().dirty, true);

  // The in-memory fast path keeps working after every persistence failure.
  store.state.failWrite = false;
  assert.equal(cache.set('k2', ['乙']), true);
  assert.deepEqual(cache.get('k2'), ['乙']);
});

test('persistent cache drops the oldest entries when the envelope exceeds the size cap', async () => {
  const { cache, store } = setupPersistent({ flushDelayMs: 10_000, maxBytes: 600 });
  for (let index = 0; index < 6; index += 1) {
    assert.equal(cache.set(`key-${index}`, ['x'.repeat(100)]), true);
  }
  assert.equal(await cache.flush(), true);
  const serialized = JSON.stringify(store.state.data);
  assert.ok(Buffer.byteLength(serialized) <= 600, `envelope bytes=${Buffer.byteLength(serialized)}`);
  const keys = Object.keys(store.state.data.entries);
  assert.ok(keys.length > 0 && keys.length < 6, `kept ${keys.length} entries`);
  assert.equal(keys.at(-1), 'key-5', 'kept entries are the newest');
  assert.equal(cache.stats().entries, keys.length, 'memory is pruned in step with the file');
});

test('persistent cache keeps the newest 1000 entries by LRU order', async () => {
  const { cache, store } = setupPersistent({ flushDelayMs: 10_000 });
  for (let index = 0; index < 1020; index += 1) cache.set(`key-${index}`, [`译文 ${index}`]);
  assert.equal(cache.stats().entries, 1000);
  assert.equal(cache.get('key-0'), undefined);
  assert.deepEqual(cache.get('key-1019'), ['译文 1019']);
  assert.equal(await cache.flush(), true);
  assert.equal(Object.keys(store.state.data.entries).length, 1000);
});
