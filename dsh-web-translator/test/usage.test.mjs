/** Persistent token ledger: buckets, day windows, pagination, pruning, faults (DESIGN-TOKEN-USAGE §2). */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { LIMITS, USAGE_VERSION } from '../lib/constants.js';
import { createJsonStore } from '../lib/store.js';
import {
  createUsageService,
  emptyUsageBuckets,
  emptyUsageSummaryBuckets,
  MAX_LATENCY_MS,
  usageDayKey,
} from '../lib/usage.js';
import { createFakeLogger, createTempDir, removeTempDir } from './helpers.mjs';

/** Fixed local noon so day bucketing never depends on the machine's clock. */
const T0 = new Date(2026, 10, 6, 12, 0, 0, 0).getTime();

/** Local-calendar day arithmetic (DST safe, unlike `ms + n*86400000`). */
function addDays(at, days) {
  const date = new Date(at);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** One service over a temp usage.json with an injectable clock. */
async function setupUsage(t, { clock = () => T0, maxEvents, maxDays } = {}) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const file = join(dir, 'usage.json');
  const store = createJsonStore(file, {
    defaultValue: () => ({ version: USAGE_VERSION }),
    logger,
  });
  const service = createUsageService({ store, now: clock, logger, maxEvents, maxDays });
  return { dir, file, logger, store, service };
}

test('an empty ledger reports a zero summary with a continuous day window', async (t) => {
  const { service } = await setupUsage(t);
  const summary = await service.summary();
  assert.equal(summary.version, USAGE_VERSION);
  assert.equal(summary.updatedAt, 0);
  assert.deepEqual(summary.totals, emptyUsageSummaryBuckets());
  assert.deepEqual(summary.today, emptyUsageSummaryBuckets());
  assert.equal(summary.days.length, 14);
  assert.equal(summary.days.at(-1).date, usageDayKey(T0));
  for (const day of summary.days) {
    assert.equal(day.requests, 0);
    assert.equal(day.inputTokens, 0);
    assert.equal(day.avgLatencyMs, 0);
  }
  assert.deepEqual(summary.byModel, []);
  assert.deepEqual(summary.byKind, {
    translate: emptyUsageSummaryBuckets(),
    lookup: emptyUsageSummaryBuckets(),
    image: emptyUsageSummaryBuckets(),
  });
  assert.deepEqual(summary.recent, []);
  assert.deepEqual(await service.events(), { events: [], nextBefore: null, hasMore: false });
});

test('records success, failure and cached events into all buckets', async (t) => {
  const { service, file } = await setupUsage(t);
  await service.record({
    kind: 'translate',
    ok: true,
    provider: 'modelhub',
    model: 'deepseek-flash',
    segments: 2,
    chars: 11,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    latencyMs: 120,
  });
  await service.record({
    kind: 'translate',
    ok: false,
    errorCode: 'MODEL_TIMEOUT',
    provider: 'modelhub',
    model: 'deepseek-flash',
    inputTokens: 99,
    outputTokens: 99,
    latencyMs: 90_000,
  });
  await service.record({
    kind: 'lookup',
    ok: true,
    cached: true,
    provider: 'modelhub',
    model: 'deepseek-flash',
    inputTokens: 88,
    outputTokens: 44,
    retries: 0,
    latencyMs: 5,
  });

  const summary = await service.summary({ days: 1 });
  // Failed and cached requests count as requests but cost zero tokens (§2.3).
  assert.deepEqual(summary.totals, {
    requests: 3,
    ok: 2,
    errors: 1,
    cached: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    avgLatencyMs: 30_042,
  });
  assert.deepEqual(summary.byKind.translate, {
    requests: 2,
    ok: 1,
    errors: 1,
    cached: 0,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    avgLatencyMs: 45_060,
  });
  assert.deepEqual(summary.byKind.lookup, {
    requests: 1,
    ok: 1,
    errors: 0,
    cached: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    avgLatencyMs: 5,
  });
  assert.equal(summary.byModel.length, 1);
  assert.deepEqual(summary.byModel[0], {
    provider: 'modelhub',
    model: 'deepseek-flash',
    requests: 3,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    lastAt: T0,
  });

  const { events } = await service.events({ limit: 10 });
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'lookup');
  assert.equal(events[0].cached, true);
  assert.equal(events[0].inputTokens, 0, 'cached events store zero tokens');
  assert.equal(events[0].latencyMs, 5, 'cached events still carry a latency');
  assert.equal(events[1].ok, false);
  assert.equal(events[1].errorCode, 'MODEL_TIMEOUT');
  assert.equal(events[1].cached, false);
  assert.equal(events[1].inputTokens, 0, 'failed events store zero tokens');
  assert.equal(events[1].latencyMs, 90_000, 'failed events still carry a latency');
  assert.equal(events[2].inputTokens, 10);
  assert.equal(events[2].ok, true);
  assert.equal(events[2].errorCode, undefined);
  assert.equal(events[2].latencyMs, 120);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, USAGE_VERSION);
  assert.equal(raw.events.length, 3);
  assert.deepEqual(raw.totals, {
    ...emptyUsageBuckets(),
    requests: 3,
    ok: 2,
    errors: 1,
    cached: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    latencySum: 90_125,
    latencyCount: 3,
  });
});

test('day buckets follow the injected local clock and stay continuous', async (t) => {
  let current = T0;
  const { service } = await setupUsage(t, { clock: () => current });
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 10 });
  current = addDays(T0, 1);
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 20 });
  await service.record({ kind: 'lookup', ok: true, provider: 'p', model: 'm', latencyMs: 30 });

  const summary = await service.summary({ days: 2 });
  assert.equal(summary.days.length, 2);
  assert.equal(summary.days[0].date, usageDayKey(T0));
  assert.equal(summary.days[0].requests, 1);
  assert.equal(summary.days[0].avgLatencyMs, 10);
  assert.equal(summary.days[1].date, usageDayKey(current));
  assert.equal(summary.days[1].requests, 2);
  assert.equal(summary.days[1].avgLatencyMs, 25, '(20+30)/2 per local day');
  assert.equal(summary.totals.avgLatencyMs, 20);
  const expectedToday = { ...summary.days[1] };
  delete expectedToday.date;
  assert.deepEqual(summary.today, expectedToday);

  // `days` is clamped into 1..LIMITS.usageDays (90).
  assert.equal((await service.summary({ days: 1000 })).days.length, LIMITS.usageDays);
  assert.equal((await service.summary({ days: 0 })).days.length, 1);
  assert.equal((await service.summary({ days: 3 })).days.length, 3);
});

test('aggregates by model and by kind, newest model first', async (t) => {
  const { service } = await setupUsage(t);
  await service.record({ kind: 'translate', ok: true, provider: 'p1', model: 'm1', inputTokens: 2, outputTokens: 1 });
  await service.record({ kind: 'translate', ok: true, provider: 'p1', model: 'm1', inputTokens: 3, outputTokens: 2 });
  await service.record({ kind: 'lookup', ok: true, provider: 'p2', model: 'm2', inputTokens: 4, outputTokens: 0 });

  const { byModel, byKind } = await service.summary();
  assert.equal(byModel.length, 2);
  const m1 = byModel.find((entry) => entry.model === 'm1');
  assert.deepEqual(m1, {
    provider: 'p1',
    model: 'm1',
    requests: 2,
    inputTokens: 5,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastAt: T0,
  });
  const m2 = byModel.find((entry) => entry.model === 'm2');
  assert.equal(m2.requests, 1);
  assert.equal(m2.inputTokens, 4);
  assert.equal(byKind.translate.requests, 2);
  assert.equal(byKind.translate.inputTokens, 5);
  assert.equal(byKind.translate.avgLatencyMs, 0);
  assert.equal(byKind.lookup.requests, 1);
  assert.equal(byKind.lookup.inputTokens, 4);
  assert.equal(byKind.lookup.avgLatencyMs, 0);
});

test('keeps events newest-first, caps the event list but not the totals', async (t) => {
  const { service } = await setupUsage(t, { maxEvents: 5 });
  for (let index = 0; index < 8; index += 1) {
    await service.record({ kind: 'translate', ok: true, provider: 'p', model: `m${index}` });
  }
  const page = await service.events({ limit: 10 });
  assert.equal(page.events.length, 5);
  assert.deepEqual(page.events.map((event) => event.model), ['m7', 'm6', 'm5', 'm4', 'm3']);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextBefore, null);

  const summary = await service.summary();
  assert.equal(summary.totals.requests, 8, 'totals keep counting after the event cap');
  assert.equal(summary.recent.length, 5);
});

test('paginates with before and filters by kind', async (t) => {
  const { service } = await setupUsage(t);
  for (let index = 0; index < 6; index += 1) {
    await service.record({
      kind: index % 2 === 0 ? 'translate' : 'lookup',
      ok: index !== 3,
      provider: 'p',
      model: 'm',
    });
  }

  const first = await service.events({ limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].kind, 'lookup');
  assert.equal(first.events[1].kind, 'translate');
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBefore, first.events[1].id);

  const second = await service.events({ limit: 2, before: first.nextBefore });
  assert.equal(second.events.length, 2);
  assert.equal(second.events[0].ok, false);
  assert.equal(second.hasMore, true);

  const third = await service.events({ limit: 2, before: second.nextBefore });
  assert.equal(third.events.length, 2);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextBefore, null);

  const errors = await service.events({ kind: 'error' });
  assert.equal(errors.events.length, 1);
  assert.equal(errors.events[0].ok, false);

  const translates = await service.events({ kind: 'translate', limit: 1 });
  assert.equal(translates.events.length, 1);
  assert.equal(translates.events[0].kind, 'translate');
  assert.equal(translates.hasMore, true);

  const unknown = await service.events({ before: 'evt_missing', limit: 1 });
  assert.equal(unknown.events[0].id, first.events[0].id, 'unknown before restarts from the newest');

  const defaults = await service.events();
  assert.equal(defaults.events.length, 6);
});

test('clear resets the ledger on disk and in the summary', async (t) => {
  const { service, file } = await setupUsage(t);
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', inputTokens: 4 });
  const cleared = await service.clear();
  assert.deepEqual(cleared.totals, emptyUsageSummaryBuckets());
  assert.equal((await service.summary()).totals.requests, 0);
  assert.deepEqual((await service.events()).events, []);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, USAGE_VERSION);
  assert.deepEqual(raw.events, []);
  assert.deepEqual(raw.totals, emptyUsageBuckets());
  assert.deepEqual(raw.days, {});
  assert.deepEqual(raw.models, {});
});

test('prunes day buckets older than LIMITS.usageDays but keeps all-time totals', async (t) => {
  let current = T0;
  const { service, file } = await setupUsage(t, { clock: () => current });
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 100 });
  const oldKey = usageDayKey(T0);

  current = addDays(T0, 91);
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 200 });

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(raw.days), [usageDayKey(current)]);
  const summary = await service.summary({ days: 90 });
  assert.equal(summary.days.length, 90);
  assert.equal(summary.totals.requests, 2);
  assert.equal(summary.totals.avgLatencyMs, 150, 'all-time latency survives day pruning');
  assert.equal(summary.days.at(-1).avgLatencyMs, 200);
  assert.ok(!summary.days.some((day) => day.date === oldKey));
});

test('a corrupt usage.json falls back to an empty ledger and is rewritten', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const file = join(dir, 'usage.json');
  await writeFile(file, '{not json at all', 'utf8');
  const store = createJsonStore(file, { defaultValue: () => ({ version: USAGE_VERSION }), logger });
  const service = createUsageService({ store, now: () => T0, logger });

  const empty = await service.summary();
  assert.deepEqual(empty.totals, emptyUsageSummaryBuckets());
  assert.ok(logger.lines.warn.some((line) => line.includes('usage.json')));

  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm' });
  assert.equal((await service.summary()).totals.requests, 1);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, USAGE_VERSION);
  assert.equal(raw.events.length, 1);
});

test('serializes concurrent records without losing any', async (t) => {
  const { service, file } = await setupUsage(t);
  await Promise.all(Array.from({ length: 20 }, (_, index) => service.record({
    kind: index % 2 === 0 ? 'translate' : 'lookup',
    ok: true,
    provider: 'p',
    model: 'm',
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 10,
  })));

  const summary = await service.summary({ days: 1 });
  assert.equal(summary.totals.requests, 20);
  assert.equal(summary.totals.inputTokens, 20);
  assert.equal(summary.totals.outputTokens, 20);
  assert.equal(summary.totals.avgLatencyMs, 10);
  assert.equal(summary.byKind.translate.requests, 10);
  assert.equal(summary.byKind.lookup.requests, 10);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.events.length, 20);
  assert.equal(new Set(raw.events.map((event) => event.id)).size, 20);
  assert.equal(raw.totals.latencySum, 200);
  assert.equal(raw.totals.latencyCount, 20);
});

test('a broken store never throws out of the ledger service', async (t) => {
  const logger = createFakeLogger();
  const service = createUsageService({
    store: {
      read: async () => {
        throw new Error('read boom');
      },
      mutate: async () => {
        throw new Error('write boom');
      },
    },
    now: () => T0,
    logger,
  });
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm' });
  assert.deepEqual((await service.summary()).totals, emptyUsageSummaryBuckets());
  assert.deepEqual((await service.events()).events, []);
  assert.ok(logger.lines.warn.some((line) => line.includes('cannot read the ledger')));
  assert.ok(logger.lines.warn.some((line) => line.includes('cannot persist the ledger')));
});

test('fills id/at and truncates long optional strings before writing', async (t) => {
  const { service } = await setupUsage(t);
  await service.record({
    kind: 'translate',
    ok: true,
    provider: 'p',
    model: 'm',
    reasoningEffort: 'off',
    targetLanguage: 'zh-CN',
    sourceLanguage: 'en',
    client: 'c'.repeat(50),
    site: 's'.repeat(400),
    sourceUrl: `https://example.com/${'a'.repeat(2100)}`,
    sourceTitle: 't'.repeat(300),
    sample: 'x'.repeat(200),
    segments: 2,
    chars: 9,
    retries: 1,
    latencyMs: 5,
  });
  const [event] = (await service.events()).events;
  assert.match(event.id, /^evt_/);
  assert.equal(event.at, T0);
  assert.equal(event.reasoningEffort, 'off');
  assert.equal(event.targetLanguage, 'zh-CN');
  assert.equal(event.sourceLanguage, 'en');
  assert.equal(event.client.length, LIMITS.clientChars);
  assert.equal(event.site.length, 300);
  assert.equal(event.sourceUrl.length, LIMITS.urlChars);
  assert.equal(event.sourceTitle.length, LIMITS.sourceTitleChars);
  assert.equal(event.sample.length, LIMITS.eventSampleChars);
  assert.equal(event.retries, 1);
  assert.equal(event.latencyMs, 5);
});

/* ------------------------------------------------------------------ */
/* Latency aggregation (Design addendum: avgLatencyMs)                 */
/* ------------------------------------------------------------------ */

test('persists latencySum/latencyCount and exposes the rounded avgLatencyMs', async (t) => {
  const { service, file } = await setupUsage(t);
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 5 });
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 10 });
  await service.record({ kind: 'lookup', ok: true, provider: 'p', model: 'm', latencyMs: 10 });

  const summary = await service.summary({ days: 1 });
  assert.equal(summary.totals.avgLatencyMs, 8, '25 / 3 rounds to 8');
  assert.equal(summary.today.avgLatencyMs, 8);
  assert.equal(summary.days[0].avgLatencyMs, 8);
  assert.equal(summary.byKind.translate.avgLatencyMs, 8, '(5 + 10) / 2 = 7.5 rounds to 8');
  assert.equal(summary.byKind.lookup.avgLatencyMs, 10);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.totals.latencySum, 25);
  assert.equal(raw.totals.latencyCount, 3);
  assert.equal(raw.days[usageDayKey(T0)].latencySum, 25);
  assert.equal(raw.days[usageDayKey(T0)].latencyCount, 3);
  assert.equal(raw.kinds.translate.latencySum, 15);
  assert.equal(raw.kinds.translate.latencyCount, 2);
  assert.equal(raw.kinds.lookup.latencySum, 10);
  assert.equal(raw.kinds.lookup.latencyCount, 1);
});

test('guards latency values: negative, fractional, non-finite and absurd', async (t) => {
  const { service, file } = await setupUsage(t);
  const inputs = [-5, Number.NaN, Number.POSITIVE_INFINITY, 'nope', 900_000, 12.6];
  for (const latencyMs of inputs) {
    await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs });
  }

  const { events } = await service.events({ limit: 10 });
  assert.deepEqual(events.map((event) => event.latencyMs), [
    13, MAX_LATENCY_MS, 0, 0, 0, 0,
  ]);
  const summary = await service.summary({ days: 1 });
  assert.equal(summary.totals.avgLatencyMs, 100_002, '600013 / 6 rounds to 100002');

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.totals.latencySum, 600_013);
  assert.equal(raw.totals.latencyCount, 6);
});

test('cached and failed requests still contribute to the latency average', async (t) => {
  const { service, file } = await setupUsage(t);
  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 10, inputTokens: 5 });
  await service.record({
    kind: 'translate', ok: true, cached: true, provider: 'p', model: 'm', latencyMs: 20, inputTokens: 7,
  });
  await service.record({
    kind: 'translate', ok: false, errorCode: 'MODEL_FAILED', provider: 'p', model: 'm', latencyMs: 30, inputTokens: 9,
  });

  const summary = await service.summary({ days: 1 });
  assert.equal(summary.totals.avgLatencyMs, 20, '(10 + 20 + 30) / 3');
  assert.equal(summary.totals.inputTokens, 5, 'cached/failed tokens stay zero');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.totals.latencySum, 60);
  assert.equal(raw.totals.latencyCount, 3);
});

test('legacy buckets without latency keys normalize to zero and merge additively', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const file = join(dir, 'usage.json');
  const dayKey = usageDayKey(T0);
  const legacy = {
    requests: 2,
    ok: 2,
    errors: 0,
    cached: 0,
    inputTokens: 4,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  await writeFile(file, JSON.stringify({
    version: 1,
    updatedAt: T0,
    totals: legacy,
    days: { [dayKey]: { ...legacy, requests: 1 } },
    models: {},
    kinds: {
      translate: { ...legacy, requests: 1 },
      lookup: { ...legacy, requests: 1 },
    },
    events: [],
  }), 'utf8');
  const store = createJsonStore(file, { defaultValue: () => ({ version: USAGE_VERSION }), logger });
  const service = createUsageService({ store, now: () => T0, logger });

  const before = await service.summary({ days: 1 });
  assert.equal(before.totals.requests, 2);
  assert.equal(before.totals.avgLatencyMs, 0, 'legacy ledgers start with a zero latency count');
  assert.equal(before.today.avgLatencyMs, 0);
  assert.equal(before.byKind.translate.avgLatencyMs, 0);

  await service.record({ kind: 'translate', ok: true, provider: 'p', model: 'm', latencyMs: 40 });
  const after = await service.summary({ days: 1 });
  assert.equal(after.totals.requests, 3);
  assert.equal(after.totals.avgLatencyMs, 40, 'only the new record contributes latency');
  assert.equal(after.days[0].avgLatencyMs, 40);
  assert.equal(after.byKind.translate.avgLatencyMs, 40);

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.totals.latencySum, 40);
  assert.equal(raw.totals.latencyCount, 1);
  assert.equal(raw.days[dayKey].latencySum, 40);
  assert.equal(raw.days[dayKey].latencyCount, 1);
});

/* ------------------------------------------------------------------ */
/* Per-Turn aggregation (DESIGN-TURN-TRACE §2.2)                       */
/* ------------------------------------------------------------------ */

test('an empty ledger pages zero Turns', async (t) => {
  const { service } = await setupUsage(t);
  assert.deepEqual(await service.turns(), { turns: [], nextBefore: null, hasMore: false });
});

test('aggregates events into a multi-step Turn with sorted steps, sums and status', async (t) => {
  const { service } = await setupUsage(t);
  await service.record({
    kind: 'translate',
    ok: true,
    turnId: 'tr_abc',
    stepIndex: 2,
    mode: 'bilingual',
    client: 'extension',
    provider: 'modelhub',
    model: 'deepseek-flash',
    segments: 2,
    chars: 10,
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 4,
    latencyMs: 100,
    at: T0 + 200,
    sample: 'hello world',
    outputPreview: '你好，世界',
  });
  await service.record({
    kind: 'translate',
    ok: false,
    errorCode: 'MODEL_FAILED',
    turnId: 'tr_abc',
    stepIndex: 0,
    provider: 'modelhub',
    model: 'deepseek-flash',
    segments: 1,
    chars: 5,
    inputTokens: 99,
    outputTokens: 99,
    latencyMs: 500,
    at: T0 + 50,
    sample: 'oops',
  });
  await service.record({
    kind: 'translate',
    ok: true,
    turnId: 'tr_abc',
    stepIndex: 1,
    provider: 'modelhub',
    model: 'deepseek-flash',
    segments: 1,
    chars: 5,
    inputTokens: 7,
    outputTokens: 8,
    latencyMs: 50,
    at: T0 + 100,
  });
  await service.record({ kind: 'lookup', ok: true, provider: 'modelhub', model: 'deepseek-flash', latencyMs: 20 });

  const envelope = await service.turns();
  assert.equal(envelope.hasMore, false);
  assert.equal(envelope.nextBefore, null);
  assert.equal(envelope.turns.length, 2, 'one turnId group plus one legacy single-step Turn');

  const [turn, legacy] = envelope.turns;
  assert.equal(turn.id, 'tr_abc');
  assert.equal(turn.kind, 'translate');
  assert.equal(turn.mode, 'bilingual');
  assert.equal(turn.client, 'extension');
  assert.equal(turn.provider, 'modelhub');
  assert.equal(turn.model, 'deepseek-flash');
  assert.equal(turn.startedAt, T0 + 50, 'startedAt is the oldest step');
  assert.equal(turn.endedAt, T0 + 200, 'endedAt is the newest step');
  assert.equal(turn.durationMs, 150);
  assert.equal(turn.requests, 3);
  assert.equal(turn.ok, 2);
  assert.equal(turn.errors, 1);
  assert.equal(turn.cached, 0);
  assert.equal(turn.segments, 4);
  assert.equal(turn.chars, 20);
  assert.equal(turn.inputTokens, 10);
  assert.equal(turn.outputTokens, 10);
  assert.equal(turn.cacheReadTokens, 1);
  assert.equal(turn.cacheWriteTokens, 4);
  assert.equal(turn.avgLatencyMs, 217, '(100 + 500 + 50) / 3 rounds to 217');
  assert.equal(turn.status, 'partial');

  assert.deepEqual(turn.steps.map((step) => step.stepIndex), [0, 1, 2]);
  assert.deepEqual(turn.steps.map((step) => step.latencyMs), [500, 50, 100]);
  assert.equal(turn.steps[0].ok, false);
  assert.equal(turn.steps[0].errorCode, 'MODEL_FAILED');
  assert.equal(turn.steps[0].inputTokens, 0, 'failed requests carry zero tokens');
  assert.equal(turn.steps[2].outputPreview, '你好，世界');
  assert.equal(turn.steps[2].sample, 'hello world');
  assert.equal(turn.steps[2].cacheReadTokens, 1);
  assert.equal(turn.steps[2].cacheWriteTokens, 4);

  assert.match(legacy.id, /^evt:evt_/);
  assert.equal(legacy.kind, 'lookup');
  assert.equal(legacy.requests, 1);
  assert.equal(legacy.durationMs, 20, 'a single-step Turn takes the step latency as its duration');
  assert.equal(legacy.steps.length, 1);
  assert.equal(legacy.steps[0].stepIndex, 0);
});

test('derives ok / partial / error Turn statuses and filters by status', async (t) => {
  const { service } = await setupUsage(t);
  await service.record({ kind: 'translate', ok: true, turnId: 'tr_ok', stepIndex: 0, latencyMs: 10, at: T0 + 10 });
  await service.record({ kind: 'translate', ok: true, turnId: 'tr_ok', stepIndex: 1, latencyMs: 20, at: T0 + 20 });
  await service.record({ kind: 'translate', ok: true, cached: true, turnId: 'tr_partial', stepIndex: 0, latencyMs: 5, at: T0 + 30 });
  await service.record({
    kind: 'translate', ok: false, errorCode: 'MODEL_TIMEOUT', turnId: 'tr_partial', stepIndex: 1, latencyMs: 6, at: T0 + 40,
  });
  await service.record({ kind: 'translate', ok: false, errorCode: 'MODEL_FAILED', turnId: 'tr_error', stepIndex: 0, latencyMs: 7, at: T0 + 50 });
  await service.record({ kind: 'translate', ok: false, errorCode: 'MODEL_FAILED', turnId: 'tr_error', stepIndex: 1, latencyMs: 8, at: T0 + 60 });

  const { turns } = await service.turns();
  assert.deepEqual(turns.map((turn) => [turn.id, turn.status]), [
    ['tr_error', 'error'],
    ['tr_partial', 'partial'],
    ['tr_ok', 'ok'],
  ]);
  assert.equal(turns[0].cached, 0);
  assert.equal(turns[1].cached, 1);
  assert.equal(turns[2].requests, 2);
  assert.equal(turns[2].ok, 2);
  assert.equal(turns[2].errors, 0);
  assert.equal(turns[2].segments, 0);

  assert.deepEqual((await service.turns({ status: 'partial' })).turns.map((turn) => turn.id), ['tr_partial']);
  assert.deepEqual((await service.turns({ status: 'error' })).turns.map((turn) => turn.id), ['tr_error']);
  assert.equal((await service.turns({ status: 'nope' })).turns.length, 3, 'unknown status is ignored');
});

test('filters Turns by kind, treating mixed Turns as both kinds', async (t) => {
  const { service } = await setupUsage(t);
  await service.record({ kind: 'translate', ok: true, turnId: 'tr_1', stepIndex: 0, latencyMs: 10, at: T0 + 10 });
  await service.record({ kind: 'lookup', ok: true, turnId: 'lk_1', stepIndex: 0, latencyMs: 20, at: T0 + 20 });
  await service.record({
    kind: 'translate', ok: false, errorCode: 'MODEL_FAILED', turnId: 'tr_2', stepIndex: 0, latencyMs: 30, at: T0 + 30,
  });
  await service.record({ kind: 'translate', ok: true, turnId: 'mx_1', stepIndex: 0, latencyMs: 40, at: T0 + 40 });
  await service.record({ kind: 'lookup', ok: true, turnId: 'mx_1', stepIndex: 1, latencyMs: 50, at: T0 + 50 });

  const all = await service.turns();
  assert.deepEqual(all.turns.map((turn) => [turn.id, turn.kind]), [
    ['mx_1', 'mixed'],
    ['tr_2', 'translate'],
    ['lk_1', 'lookup'],
    ['tr_1', 'translate'],
  ]);

  assert.deepEqual((await service.turns({ kind: 'translate' })).turns.map((turn) => turn.id), ['mx_1', 'tr_2', 'tr_1']);
  assert.deepEqual((await service.turns({ kind: 'lookup' })).turns.map((turn) => turn.id), ['mx_1', 'lk_1']);
  assert.deepEqual((await service.turns({ kind: 'error' })).turns.map((turn) => turn.id), ['tr_2']);
  assert.deepEqual((await service.turns({ kind: 'error', status: 'ok' })).turns, []);
  assert.equal((await service.turns({ kind: 'bogus' })).turns.length, 4, 'unknown kind is ignored');
});

test('orders steps without an explicit stepIndex by their timestamp', async (t) => {
  const { service } = await setupUsage(t);
  await service.record({ kind: 'translate', ok: true, turnId: 'tr_x', provider: 'p', model: 'm', latencyMs: 10, at: T0 + 300 });
  await service.record({ kind: 'translate', ok: true, turnId: 'tr_x', provider: 'p', model: 'm', latencyMs: 10, at: T0 + 100 });
  await service.record({ kind: 'translate', ok: true, turnId: 'tr_x', provider: 'p', model: 'm', latencyMs: 10, at: T0 + 200 });

  const [turn] = (await service.turns()).turns;
  assert.deepEqual(turn.steps.map((step) => step.at), [T0 + 100, T0 + 200, T0 + 300]);
  assert.deepEqual(turn.steps.map((step) => step.stepIndex), [0, 0, 0]);
  assert.equal(turn.durationMs, 200);
});

test('paginates Turns newest-first with before and clamps the limit', async (t) => {
  const { service } = await setupUsage(t, { maxEvents: 130 });
  for (let index = 0; index < 105; index += 1) {
    await service.record({
      kind: 'translate',
      ok: true,
      turnId: `tr_${String(index).padStart(3, '0')}`,
      stepIndex: 0,
      latencyMs: 1,
      at: T0 + index,
    });
  }

  const defaults = await service.turns();
  assert.equal(defaults.turns.length, LIMITS.usageTurnsDefault);
  assert.equal(defaults.hasMore, true);
  assert.equal(defaults.turns[0].id, 'tr_104');
  assert.equal(defaults.nextBefore, 'tr_085');

  const capped = await service.turns({ limit: 5000 });
  assert.equal(capped.turns.length, LIMITS.usageTurnsMax, 'limit clamps to 100');
  assert.equal(capped.hasMore, true);
  assert.equal(capped.turns[0].id, 'tr_104');
  assert.equal(capped.turns.at(-1).id, 'tr_005');
  assert.equal(capped.nextBefore, 'tr_005');

  const first = await service.turns({ limit: 2 });
  assert.deepEqual(first.turns.map((turn) => turn.id), ['tr_104', 'tr_103']);
  const second = await service.turns({ limit: 2, before: first.nextBefore });
  assert.deepEqual(second.turns.map((turn) => turn.id), ['tr_102', 'tr_101']);
  const unknown = await service.turns({ limit: 1, before: 'tr_missing' });
  assert.equal(unknown.turns[0].id, 'tr_104', 'unknown before restarts from the newest');
  assert.equal((await service.turns({ limit: 0 })).turns.length, 1, 'limit clamps to at least 1');
  assert.equal((await service.turns({ limit: 'abc' })).turns.length, LIMITS.usageTurnsDefault);
});

test('legacy events without Turn metadata stay valid as single-step Turns', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const file = join(dir, 'usage.json');
  const legacyEvent = {
    id: 'evt_legacy_1',
    at: T0 - 1000,
    kind: 'translate',
    ok: true,
    provider: 'p',
    model: 'm',
    segments: 1,
    chars: 3,
    cached: false,
    retries: 0,
    inputTokens: 2,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 42,
    client: 'dsh',
  };
  const lookupEvent = { ...legacyEvent, id: 'evt_legacy_2', at: T0 - 500, kind: 'lookup', latencyMs: 7 };
  await writeFile(file, JSON.stringify({
    version: USAGE_VERSION,
    updatedAt: T0,
    events: [lookupEvent, legacyEvent],
  }), 'utf8');
  const store = createJsonStore(file, { defaultValue: () => ({ version: USAGE_VERSION }), logger });
  const service = createUsageService({ store, now: () => T0, logger });

  const { turns } = await service.turns();
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.id), ['evt:evt_legacy_2', 'evt:evt_legacy_1']);
  assert.deepEqual(turns.map((turn) => turn.kind), ['lookup', 'translate']);
  for (const turn of turns) {
    assert.equal(turn.requests, 1);
    assert.equal(turn.steps.length, 1);
    assert.equal(turn.steps[0].stepIndex, 0);
    assert.equal(turn.durationMs, turn.steps[0].latencyMs);
    assert.equal(turn.status, 'ok');
  }
  assert.equal(turns[1].inputTokens, 2);
  assert.equal(turns[1].client, 'dsh');

  const { events } = await service.events();
  assert.equal(events.length, 2);
  assert.equal(events[0].turnId, undefined, 'legacy events keep the old event shape');
  assert.equal(events[0].stepIndex, undefined);
});

test('persists and truncates turn metadata and clamps stepIndex', async (t) => {
  const { service, file } = await setupUsage(t);
  await service.record({
    kind: 'translate',
    ok: true,
    turnId: 't'.repeat(100),
    stepIndex: 99_999,
    mode: 'm'.repeat(40),
    outputPreview: 'x'.repeat(400),
    provider: 'p',
    model: 'm',
    latencyMs: 5,
    at: T0,
  });
  await service.record({
    kind: 'lookup',
    ok: true,
    turnId: 'lk_1',
    stepIndex: -5,
    mode: '',
    outputPreview: '',
    provider: 'p',
    model: 'm',
    latencyMs: 5,
    at: T0 + 1,
  });
  await service.record({
    kind: 'translate',
    ok: true,
    turnId: 'tr_1',
    stepIndex: 'nope',
    provider: 'p',
    model: 'm',
    latencyMs: 5,
    at: T0 + 2,
  });

  const raw = JSON.parse(await readFile(file, 'utf8'));
  // Ledger events are newest first.
  const [invalid, clamped, truncated] = raw.events;
  assert.equal(truncated.turnId.length, LIMITS.turnIdChars);
  assert.equal(truncated.stepIndex, LIMITS.stepIndexMax);
  assert.equal(truncated.mode.length, LIMITS.modeChars);
  assert.equal(truncated.outputPreview.length, LIMITS.outputPreviewChars);
  assert.equal(clamped.turnId, 'lk_1');
  assert.equal(clamped.stepIndex, 0, 'negative stepIndex clamps to 0');
  assert.equal('mode' in clamped, false, 'blank optional fields stay omitted');
  assert.equal('outputPreview' in clamped, false);
  assert.equal('stepIndex' in invalid, false, 'non-numeric stepIndex is omitted');

  assert.equal((await service.events()).events.length, 3);
  assert.equal((await service.turns()).turns.length, 3);
});
