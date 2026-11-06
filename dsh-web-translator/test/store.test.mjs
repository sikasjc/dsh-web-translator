/** JSON store: data-dir resolution, atomic writes, serialized mutations, corruption. */
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createFakeLogger, createTempDir, removeTempDir } from './helpers.mjs';
import { createJsonStore, resolveDataDir } from '../lib/store.js';

test('resolveDataDir prefers DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveDataDir({ DSH_HOME: '/custom/home' }, '/home/user'), '/custom/home/immersive-translate');
  assert.equal(resolveDataDir({ DSH_HOME: '  ' }, '/home/user'), '/home/user/.dsh/immersive-translate');
  assert.equal(resolveDataDir({}, '/home/user'), '/home/user/.dsh/immersive-translate');
  assert.equal(resolveDataDir({ DSH_HOME: '/h' }, '/home/user'), join('/h', 'immersive-translate'));
});

test('reads defaults when the file is absent, then persists atomically', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const file = join(dir, 'nested', 'wordbook.json');
  const store = createJsonStore(file, {
    defaultValue: () => ({ version: 1, items: [], updatedAt: 0 }),
    logger,
  });
  assert.deepEqual(await store.read(), { version: 1, items: [], updatedAt: 0 });

  await store.mutate((data) => {
    data.items.push({ id: 'a' });
    data.updatedAt = 1;
    return 'ok';
  });
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw, { version: 1, items: [{ id: 'a' }], updatedAt: 1 });

  const names = await readdir(join(dir, 'nested'));
  assert.deepEqual(names, ['wordbook.json'], 'no temp files left behind');
});

test('mutations are serialized and see each other', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const store = createJsonStore(join(dir, 'counter.json'), { defaultValue: () => ({ version: 1, count: 0 }) });
  await Promise.all(Array.from({ length: 10 }, () => store.mutate(async (data) => {
    const current = data.count;
    await new Promise((resolve) => setTimeout(resolve, 2));
    data.count = current + 1;
  })));
  assert.equal((await store.read()).count, 10);
  assert.equal(JSON.parse(await readFile(join(dir, 'counter.json'), 'utf8')).count, 10);
});

test('a throwing mutator writes nothing and rejects only its caller', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const store = createJsonStore(join(dir, 'data.json'), { defaultValue: () => ({ version: 1, value: 'initial' }) });
  await assert.rejects(store.mutate(() => {
    throw new Error('nope');
  }), /nope/);
  assert.deepEqual(await store.read(), { version: 1, value: 'initial' });
  await store.mutate((data) => {
    data.value = 'later';
  });
  assert.equal((await store.read()).value, 'later');
});

test('a corrupt document falls back to defaults with a warning', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const file = join(dir, 'broken.json');
  await writeFile(file, '{not json', 'utf8');
  const logger = createFakeLogger();
  const store = createJsonStore(file, { defaultValue: () => ({ version: 1, items: [] }), logger });
  assert.deepEqual(await store.read(), { version: 1, items: [] });
  assert.equal(logger.lines.warn.length, 1);
});
