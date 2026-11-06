/** 悬浮球不展示域名列表：normalize + service + API (DESIGN-BALL §1). */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApi } from '../lib/api.js';
import {
  BALL_SITES_VERSION,
  MAX_BALL_SITES,
  createBallSitesService,
  normalizeBallSite,
} from '../lib/ball-sites.js';
import { createJsonStore } from '../lib/store.js';
import { createFakeCtx, createTempDir, removeTempDir } from './helpers.mjs';

/** Fresh service over a temp store. */
async function setupService(t) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const file = join(dir, 'ball-sites.json');
  const store = createJsonStore(file, {
    defaultValue: () => ({ version: BALL_SITES_VERSION, sites: [], updatedAt: 0 }),
  });
  const service = createBallSitesService({ store, now: () => 1234 });
  return { dir, file, store, service };
}

/** Fresh API facade over a temp data dir. */
async function setupApi(t) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const api = createApi({ ctx: createFakeCtx(), dataDir: dir });
  return { dir, api };
}

test('normalizeBallSite accepts hostnames, URLs and www prefixes', () => {
  assert.equal(normalizeBallSite('Example.COM'), 'example.com');
  assert.equal(normalizeBallSite('www.example.com'), 'example.com');
  assert.equal(normalizeBallSite('https://www.example.com/path?q=1'), 'example.com');
  assert.equal(normalizeBallSite('example.com:8443'), 'example.com');
  assert.equal(normalizeBallSite('example.com.'), 'example.com');
  assert.equal(normalizeBallSite('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeBallSite('localhost'), 'localhost');
  assert.equal(normalizeBallSite(''), '');
  assert.equal(normalizeBallSite('not a domain'), '');
  assert.equal(normalizeBallSite('http://'), '');
  assert.equal(normalizeBallSite(null), '');
});

test('add / list / remove persists domains and dedupes', async (t) => {
  const { service, file } = await setupService(t);
  assert.deepEqual(await service.list(), { sites: [], updatedAt: 0 });
  const added = await service.add({ domain: 'https://www.Example.com/post' });
  assert.equal(added.added, true);
  assert.deepEqual(added.sites, ['example.com']);
  assert.equal(added.updatedAt, 1234);
  const again = await service.add({ domain: 'example.com' });
  assert.equal(again.added, false);
  assert.deepEqual(again.sites, ['example.com']);
  const removed = await service.remove({ domain: 'example.com' });
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.sites, []);
  const doc = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(doc.version, BALL_SITES_VERSION);
  assert.deepEqual(doc.sites, []);
});

test('add rejects invalid domains and caps the list', async (t) => {
  const { service } = await setupService(t);
  await assert.rejects(service.add({ domain: 'not a domain' }), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(service.add({}), (error) => error.code === 'BAD_REQUEST');
  await assert.rejects(service.remove({ domain: '--' }), (error) => error.code === 'BAD_REQUEST');
  for (let index = 0; index < MAX_BALL_SITES; index += 1) {
    await service.add({ domain: 'site-' + index + '.example.com' });
  }
  await assert.rejects(
    service.add({ domain: 'overflow.example.com' }),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('API exposes GET /ball-sites and add/remove methods', async (t) => {
  const { api, dir } = await setupApi(t);
  assert.deepEqual(await api.getBallSites(), { sites: [], updatedAt: 0 });
  const added = await api.addBallSite({ domain: 'www.example.com' });
  assert.equal(added.added, true);
  assert.deepEqual((await api.getBallSites()).sites, ['example.com']);
  const removed = await api.removeBallSite({ domain: 'example.com' });
  assert.equal(removed.removed, true);
  assert.deepEqual((await api.getBallSites()).sites, []);
  const doc = JSON.parse(await readFile(join(dir, 'ball-sites.json'), 'utf8'));
  assert.deepEqual(doc.sites, []);
});
