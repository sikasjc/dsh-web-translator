/** Wordbook add/dedupe/list/update/review/remove + persistence (DESIGN §5.8). */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createFakeLogger, createTempDir, removeTempDir } from './helpers.mjs';
import { createJsonStore } from '../lib/store.js';
import { createWordbookService, WORDBOOK_ITEM_LIMIT } from '../lib/wordbook.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Set up one wordbook service over a temp file.
 * @param {import('node:test').TestContext} t - test context for cleanup.
 * @param {{start?: number}} [options]
 */
async function setup(t, { start = 1_000_000 } = {}) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const file = join(dir, 'wordbook.json');
  const logger = createFakeLogger();
  const store = createJsonStore(file, {
    defaultValue: () => ({ version: 1, items: [], updatedAt: 0 }),
    logger,
  });
  const clock = { now: start };
  const service = createWordbookService({ store, logger, now: () => clock.now });
  return { dir, file, logger, clock, service };
}

/** Assert one API error rejection. */
async function assertApiError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('add creates a full item and persists the document', async (t) => {
  const { file, clock, service } = await setup(t);
  const { item, existed } = await service.add({
    word: '  immersive  ',
    translation: '沉浸式的',
    phonetic: '/ɪˈmɜːsɪv/',
    context: 'an immersive experience',
    sourceUrl: 'https://example.com/article',
    sourceTitle: 'Article',
    audioUrl: 'https://example.com/immersive.mp3',
    targetLanguage: 'zh-CN',
  });
  assert.equal(existed, false);
  assert.match(item.id, /^wb_/);
  assert.equal(item.word, 'immersive');
  assert.equal(item.translation, '沉浸式的');
  assert.equal(item.phonetic, '/ɪˈmɜːsɪv/');
  assert.equal(item.audioUrl, 'https://example.com/immersive.mp3');
  assert.equal(item.targetLanguage, 'zh-CN');
  assert.equal(item.createdAt, clock.now);
  assert.equal(item.dueAt, clock.now);
  assert.equal(item.reviews, 0);
  assert.equal(item.lapses, 0);
  assert.equal(item.level, 0);
  assert.equal(item.mastered, false);
  assert.equal(item.suspended, false);
  assert.equal(item.note, '');

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.items.length, 1);
  assert.equal(raw.updatedAt, clock.now);
});

test('deduplicates on word + targetLanguage and preserves SRS state', async (t) => {
  const { clock, service, file } = await setup(t);
  const first = await service.add({ word: 'immersive', translation: '沉浸式的', targetLanguage: 'zh-CN' });
  clock.now += 500;
  const reviewed = await service.review({ id: first.item.id, grade: 'good' });
  assert.equal(reviewed.item.level, 1);

  clock.now += 500;
  const duplicate = await service.add({
    word: 'immersive',
    translation: '另一个译文',
    context: 'new context',
    phonetic: '/new/',
    targetLanguage: 'zh-CN',
  });
  assert.equal(duplicate.existed, true);
  assert.equal(duplicate.item.id, first.item.id);
  assert.equal(duplicate.item.context, 'new context');
  assert.equal(duplicate.item.phonetic, '/new/');
  // SRS state and the original translation survive a re-add.
  assert.equal(duplicate.item.level, 1);
  assert.equal(duplicate.item.reviews, 1);
  assert.equal(duplicate.item.translation, '沉浸式的');
  assert.equal(duplicate.item.dueAt, reviewed.item.dueAt);
  assert.equal(duplicate.item.updatedAt, clock.now);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.items.length, 1);
});

test('trimmed exact match deduplicates but a different language is a new entry', async (t) => {
  const { service } = await setup(t);
  await service.add({ word: 'immersive', translation: '沉浸式的', targetLanguage: 'zh-CN' });
  const spaced = await service.add({ word: ' immersive ', translation: '沉浸式的', targetLanguage: 'zh-CN' });
  assert.equal(spaced.existed, true);
  const otherLanguage = await service.add({ word: 'immersive', translation: 'immersive 的', targetLanguage: 'en' });
  assert.equal(otherLanguage.existed, false);
  const listed = await service.list({});
  assert.equal(listed.stats.total, 2);
});

test('add requires translation and a whitelisted targetLanguage', async (t) => {
  const { service } = await setup(t);
  await assertApiError(service.add({ word: 'hello' }), 'BAD_REQUEST');
  await assertApiError(service.add({ word: 'hello', translation: '   ' }), 'BAD_REQUEST');
  await assertApiError(service.add({ word: 'hello', translation: '안녕하세요' }), 'BAD_REQUEST');
  await assertApiError(service.add({ word: 'hello', translation: 'x', targetLanguage: 'xx-YY' }), 'BAD_REQUEST');
  const { item } = await service.add({ word: 'hello', translation: '안녕하세요', targetLanguage: 'ko' });
  assert.equal(item.targetLanguage, 'ko');
});

test('add validates word, target language, URLs and dictionary payloads', async (t) => {
  const { service } = await setup(t);
  await assertApiError(service.add({ word: '   ', translation: 'x' }), 'BAD_REQUEST');
  await assertApiError(service.add({ word: 'x'.repeat(201), translation: 'x' }), 'BAD_REQUEST');
  await assertApiError(service.add({ word: 'x', translation: 'x', targetLanguage: 'xx-YY' }), 'BAD_REQUEST');
  await assertApiError(service.add({ word: 'x', translation: 'x', targetLanguage: 'zh-CN', sourceUrl: 'javascript:alert(1)' }), 'INVALID_URL_OR_TEXT');
  await assertApiError(service.add({ word: 'x', translation: 42, targetLanguage: 'zh-CN' }), 'BAD_REQUEST');

  const { item } = await service.add({
    word: 'immersive',
    translation: '沉浸式的',
    targetLanguage: 'zh-CN',
    dictionary: {
      word: 'immersive',
      audio: 'javascript:alert(1)',
      meanings: [
        { partOfSpeech: 'adjective', definitions: ['giving a feeling of being surrounded', '  deep   involvement  '] },
        { partOfSpeech: 'noun', definitions: [''] },
      ],
    },
  });
  assert.equal(item.dictionary.audio, undefined);
  assert.deepEqual(item.dictionary.meanings, [
    { partOfSpeech: 'adjective', definitions: ['giving a feeling of being surrounded', 'deep involvement'] },
  ]);
});

test('list filters, searches, sorts and clamps limits', async (t) => {
  const { service, clock } = await setup(t);
  const a = await service.add({ word: 'alpha', translation: '阿尔法', targetLanguage: 'zh-CN' });
  clock.now += 10;
  const b = await service.add({ word: 'beta', translation: '贝塔', context: 'beta context', targetLanguage: 'zh-CN' });
  clock.now += 10;
  const c = await service.add({ word: 'gamma', translation: '伽马', targetLanguage: 'zh-CN' });
  await service.update({ id: b.item.id, patch: { mastered: true } });
  clock.now += 10;
  await service.review({ id: a.item.id, grade: 'good' }); // a no longer due

  const all = await service.list({});
  assert.equal(all.items.length, 3);
  assert.deepEqual(all.items.map((item) => item.word), ['gamma', 'beta', 'alpha'], 'newest first');
  assert.deepEqual(all.stats, { total: 3, due: 1, todayDue: 1, mastered: 1, newCount: 2 });

  const due = await service.list({ filter: 'due' });
  assert.deepEqual(due.items.map((item) => item.word), ['gamma']);
  const mastered = await service.list({ filter: 'mastered' });
  assert.deepEqual(mastered.items.map((item) => item.word), ['beta']);
  const searched = await service.list({ query: 'BETA context' });
  assert.deepEqual(searched.items.map((item) => item.word), ['beta']);
  const translated = await service.list({ query: '伽马' });
  assert.deepEqual(translated.items.map((item) => item.word), ['gamma']);

  assert.equal((await service.list({ limit: 2 })).items.length, 2);
  assert.equal((await service.list({ limit: '2' })).items.length, 2);
  assert.equal((await service.list({ limit: 0 })).items.length, 1, 'limit clamps to minimum 1');
  assert.equal((await service.list({ limit: 10_000 })).items.length, 3, 'limit clamps to max');
  await assertApiError(service.list({ filter: 'nope' }), 'BAD_REQUEST');
  assert.ok(c.item.id.length > 0);
});

test('review persists the new SRS schedule to disk', async (t) => {
  const { service, file, clock } = await setup(t);
  const { item } = await service.add({ word: 'immersive', translation: '沉浸式的', targetLanguage: 'zh-CN' });
  const again = await service.review({ id: item.id, grade: 'again' });
  assert.equal(again.item.level, 0);
  assert.equal(again.item.lapses, 1);
  assert.equal(again.item.reviews, 1);
  assert.equal(again.item.dueAt, clock.now + 10 * 60 * 1000);

  const good = await service.review({ id: item.id, grade: 'good' });
  assert.equal(good.item.level, 1);
  assert.equal(good.item.reviews, 2);
  assert.equal(good.item.dueAt, clock.now + DAY);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.items[0].level, 1);
  assert.equal(raw.items[0].reviews, 2);
  assert.equal(raw.items[0].dueAt, clock.now + DAY);
  await assertApiError(service.review({ id: item.id, grade: 'perfect' }), 'BAD_REQUEST');
  await assertApiError(service.review({ id: 'wb_missing', grade: 'good' }), 'NOT_FOUND');
});

test('update patches supported fields and rejects junk', async (t) => {
  const { service } = await setup(t);
  const { item } = await service.add({ word: 'immersive', translation: '沉浸式的', targetLanguage: 'zh-CN' });
  const updated = await service.update({
    id: item.id,
    patch: { note: 'remember this', translation: '沉浸式的（新）', mastered: true, suspended: true },
  });
  assert.equal(updated.item.note, 'remember this');
  assert.equal(updated.item.translation, '沉浸式的（新）');
  assert.equal(updated.item.mastered, true);
  assert.equal(updated.item.suspended, true);

  await assertApiError(service.update({ id: item.id, patch: { mastered: 'yes' } }), 'BAD_REQUEST');
  await assertApiError(service.update({ id: item.id, patch: { unrelated: 1 } }), 'BAD_REQUEST');
  await assertApiError(service.update({ id: 'wb_missing', patch: { note: 'x' } }), 'NOT_FOUND');
  await assertApiError(service.update({ id: '', patch: { note: 'x' } }), 'BAD_REQUEST');
});

test('remove deletes one entry and reports missing ids', async (t) => {
  const { service, file } = await setup(t);
  const { item } = await service.add({ word: 'immersive', translation: '沉浸式的', targetLanguage: 'zh-CN' });
  const removed = await service.remove({ id: item.id });
  assert.deepEqual(removed, {});
  assert.equal((await service.list({})).stats.total, 0);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).items.length, 0);
  await assertApiError(service.remove({ id: item.id }), 'NOT_FOUND');
});

test('refuses to grow past the 5000-item file cap', async (t) => {
  const { dir, service } = await setup(t);
  const seeded = {
    version: 1,
    updatedAt: 0,
    items: Array.from({ length: WORDBOOK_ITEM_LIMIT }, (_, index) => ({
      id: `wb_seed_${index}`,
      word: `word-${index}`,
      translation: 'x',
      targetLanguage: 'zh-CN',
      createdAt: 0,
      updatedAt: 0,
      reviews: 0,
      lapses: 0,
      level: 0,
      dueAt: 0,
      mastered: false,
      suspended: false,
    })),
  };
  await writeFile(join(dir, 'wordbook.json'), JSON.stringify(seeded), 'utf8');
  await assertApiError(service.add({ word: 'new', translation: 'x', targetLanguage: 'zh-CN' }), 'BAD_REQUEST');
});
