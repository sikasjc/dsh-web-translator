/** End-to-end host API facade: settings, models, translate/lookup, wordbook (DESIGN §4/§5). */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApi } from '../lib/api.js';
import { createFakeAgents, createFakeCtx, createFakeLlm, createFakeLogger, createTempDir, removeTempDir, streamFromChunks, textStream } from './helpers.mjs';
import { VERSION } from '../lib/version.js';

const DAY = 24 * 60 * 60 * 1000;

/** Happy-path JSON stream factory. */
function jsonStream(payload, usage) {
  return () => textStream(JSON.stringify(payload), { usage });
}

/** Plain-text stream factory (lookup / single-segment fallback). */
function plainStream(text) {
  return () => textStream(text);
}

/** Failure-finish stream factory. */
function failStream(code, status) {
  return () => streamFromChunks([{
    type: 'finish',
    reason: { kind: 'error', failure: { code, message: `failure ${code}`, ...(status ? { status } : {}) } },
  }]);
}

/** Fresh API over a temp data dir with a fake model service. */
async function setupApi(t, { streams = [], selection, llmOptions = {}, config = {}, fetchImpl, now, agents } = {}) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const llm = createFakeLlm(llmOptions);
  for (const factory of streams) llm.pushStream(factory);
  const ctx = createFakeCtx({ llm, logger, selection, agents });
  const api = createApi({ ctx, logger, dataDir: dir, config, fetchImpl, now });
  return { api, llm, logger, dir };
}

/** Assert one promise rejects with an API code. */
async function assertApiError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('health reports version, uptime and LLM counts', async (t) => {
  const { api } = await setupApi(t);
  const health = await api.health();
  assert.equal(health.version, VERSION);
  assert.ok(health.uptimeMs >= 0);
  assert.deepEqual(health.llm, { providers: 1, models: 1 });
});

test('health still answers when the model service fails', async (t) => {
  const { api, llm } = await setupApi(t);
  llm.listProviders = () => {
    throw new Error('model service down');
  };
  const health = await api.health();
  assert.deepEqual(health.llm, { providers: 0, models: 0 });
});

test('models catalog resolves capacities and includes the DSH default selection', async (t) => {
  const { api } = await setupApi(t);
  const result = await api.listModels();
  assert.equal(result.catalog.length, 1);
  assert.equal(result.catalog[0].provider, 'modelhub');
  assert.equal(result.catalog[0].name, 'modelhub');
  assert.deepEqual(result.catalog[0].models, [{
    id: 'deepseek-flash',
    name: 'deepseek-flash',
    contextWindow: 1048576,
    maxTokens: 393216,
  }]);
  assert.deepEqual(result.defaultSelection, {
    provider: 'modelhub',
    model: 'deepseek-flash',
    reasoningEffort: 'max',
  });
});

test('a provider whose listModels fails is kept with an error field', async (t) => {
  const { api } = await setupApi(t, {
    llmOptions: {
      providers: [{ id: 'modelhub', name: 'modelhub' }, { id: 'broken', name: 'Broken' }],
      models: { modelhub: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] },
    },
  });
  const { catalog } = await api.listModels();
  assert.equal(catalog.length, 2);
  const broken = catalog.find((entry) => entry.provider === 'broken');
  assert.deepEqual(broken.models, []);
  assert.match(broken.error, /unknown provider/);
});

test('resolve returns the DESIGN §5.3 model shape', async (t) => {
  const { api } = await setupApi(t);
  const { model } = await api.resolveModel('modelhub', 'deepseek-flash');
  assert.equal(model.provider, 'modelhub');
  assert.equal(model.model, 'deepseek-flash');
  assert.equal(model.name, 'deepseek-flash');
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.maxTokens, 393216);
  assert.deepEqual(model.reasoningEfforts.map((effort) => effort.id), ['off', 'max']);
  assert.equal(model.defaultEffort, 'off');
  await assertApiError(api.resolveModel('', ''), 'BAD_REQUEST');
});

test('GET settings returns the effective defaults and the additive fields', async (t) => {
  const { api } = await setupApi(t);
  const payload = await api.getSettings();
  assert.equal(payload.settings.provider, 'modelhub');
  assert.equal(payload.settings.model, 'deepseek-flash');
  assert.equal(payload.settings.reasoningEffort, 'auto');
  assert.equal(payload.settings.targetLanguage, 'zh-CN');
  assert.equal(payload.settings.batchSegments, 10);
  assert.equal(payload.settings.batchChars, 1600);
  assert.equal(payload.settings.concurrency, 2);
  assert.ok(payload.settings.systemPrompt.length > 0);
  assert.ok(payload.settings.userTemplate.length > 0);
  assert.equal(payload.defaults.provider, 'modelhub');
  assert.equal(payload.defaults.model, 'deepseek-flash');
  assert.deepEqual(payload.selected, {
    provider: 'modelhub',
    model: 'deepseek-flash',
    reasoningEffort: 'off',
    source: 'default',
  });
  assert.equal(payload.modelInfo.contextWindow, 1048576);
  assert.equal(payload.targetLanguages.length, 12);
  assert.ok(payload.targetLanguages.includes('zh-CN'));
  assert.equal(payload.catalog[0].provider, 'modelhub');
});

test('GET settings survives a failing resolveModelInfo', async (t) => {
  const { api, llm } = await setupApi(t);
  llm.resolveModelInfo = async () => {
    throw Object.assign(new Error('no adapter'), { code: 'NO_ADAPTER' });
  };
  const payload = await api.getSettings();
  assert.deepEqual(payload.modelInfo.reasoningEfforts, []);
  assert.equal(payload.modelInfo.contextWindow, 0);
  assert.equal(payload.selected.reasoningEffort, 'auto');
  await assertApiError(api.resolveModel('modelhub', 'deepseek-flash'), 'MODEL_UNAVAILABLE');
});

test('PUT settings validates, persists and re-reads', async (t) => {
  const { api, dir } = await setupApi(t);
  const updated = await api.putSettings({ batchSegments: 4, targetLanguage: 'ja', systemPrompt: 'translate {{segmentCount}}' });
  assert.equal(updated.settings.batchSegments, 4);
  assert.equal(updated.settings.targetLanguage, 'ja');
  assert.equal(updated.settings.systemPrompt, 'translate {{segmentCount}}');

  const raw = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.settings.batchSegments, 4);
  assert.equal(typeof raw.updatedAt, 'number');

  // Choosing a model flips the selected source and is persisted.
  const selected = await api.putSettings({ provider: 'modelhub', model: 'deepseek-flash' });
  assert.equal(selected.selected.source, 'settings');
  assert.equal((await api.getSettings()).selected.source, 'settings');

  // Blank prompts restore the defaults; explicit effort passes through.
  const reset = await api.putSettings({ systemPrompt: '', userTemplate: '', reasoningEffort: 'max' });
  assert.equal(reset.settings.systemPrompt, reset.defaults.systemPrompt);
  assert.equal(reset.settings.userTemplate, reset.defaults.userTemplate);
  assert.equal(reset.selected.reasoningEffort, 'max');
});

test('PUT settings rejects invalid values and unknown models', async (t) => {
  const { api } = await setupApi(t);
  for (const body of [
    { batchSegments: 0 },
    { batchChars: 100 },
    { concurrency: 9 },
    { targetLanguage: 'xx-YY' },
    { systemPrompt: 'x'.repeat(8001) },
    {},
    { unknownField: true },
  ]) {
    await assertApiError(api.putSettings(body), 'INVALID_SETTINGS');
  }
  await assertApiError(api.putSettings({ provider: 'nope', model: 'm' }), 'INVALID_SETTINGS');
  await assertApiError(api.putSettings({ provider: 'modelhub', model: 'nope' }), 'INVALID_SETTINGS');
  await assertApiError(api.putSettings({ provider: 'modelhub' }), 'INVALID_SETTINGS');
});

test('translate renders the prompts, calls the model and reports usage', async (t) => {
  const { api, llm } = await setupApi(t, {
    streams: [jsonStream({ translations: ['你好', '世界'] }, { inputTokens: 11, outputTokens: 7 })],
  });
  const result = await api.translate({ texts: ['hello', 'world'] });
  assert.deepEqual(result.translations, ['你好', '世界']);
  assert.equal(result.provider, 'modelhub');
  assert.equal(result.model, 'deepseek-flash');
  assert.equal(result.reasoningEffort, 'off');
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(result.cached, false);
  assert.equal(result.retries, 0);

  assert.equal(llm.state.streamCalls.length, 1);
  const call = llm.state.streamCalls[0];
  assert.equal(call.provider, 'modelhub');
  assert.equal(call.model, 'deepseek-flash');
  assert.equal(call.reasoningEffort, 'off');
  assert.equal(call.temperature, 0.2);
  assert.equal(call.maxTokens, 512);
  assert.equal(call.system.includes('zh-CN'), true);
  assert.equal('sessionId' in call, false);
  assert.equal('purpose' in call, false);
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(call.messages.length, 1);
  assert.equal(call.messages[0].role, 'user');
  assert.equal(call.messages[0].content[0].type, 'text');
  assert.ok(call.messages[0].content[0].text.includes('["hello","world"]'));
});

test('translate serves repeated batches from the LRU cache', async (t) => {
  const { api, llm } = await setupApi(t, { streams: [jsonStream({ translations: ['你好'] })] });
  const first = await api.translate({ texts: ['hello'] });
  assert.equal(first.cached, false);
  const second = await api.translate({ texts: ['hello'] });
  assert.equal(second.cached, true);
  assert.deepEqual(second.translations, ['你好']);
  assert.equal(llm.state.streamCalls.length, 1, 'second call must not hit the model');
});

test('translate re-chunks by settings and aggregates batch usage', async (t) => {
  const { api, llm } = await setupApi(t, {
    streams: [
      jsonStream({ translations: ['o1', 'o2'] }, { inputTokens: 1, outputTokens: 2 }),
      jsonStream({ translations: ['o3', 'o4'] }, { inputTokens: 1, outputTokens: 2 }),
      jsonStream({ translations: ['o5'] }, { inputTokens: 1, outputTokens: 2 }),
    ],
  });
  await api.putSettings({ batchSegments: 2 });
  const result = await api.translate({ texts: ['t1', 't2', 't3', 't4', 't5'], sourceLanguage: 'en' });
  assert.deepEqual(result.translations, ['o1', 'o2', 'o3', 'o4', 'o5']);
  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 6,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(result.retries, 0);
  assert.equal(llm.state.streamCalls.length, 3);
});

test('translate retries once with a correction message and temperature 0', async (t) => {
  const { api, llm } = await setupApi(t, {
    streams: [
      plainStream('sorry, no JSON here'),
      jsonStream({ translations: ['甲', '乙'] }),
    ],
  });
  const result = await api.translate({ texts: ['one', 'two'] });
  assert.deepEqual(result.translations, ['甲', '乙']);
  assert.equal(result.retries, 1, 'the JSON-correction retry is surfaced');
  assert.equal(llm.state.streamCalls.length, 2);
  const retry = llm.state.streamCalls[1];
  assert.equal(retry.temperature, 0);
  assert.equal(retry.messages.length, 2);
  assert.equal(retry.messages[1].content[0].text, 'Return only the required JSON.');
});

test('translate maps unparseable output to INVALID_MODEL_OUTPUT and logs 200 chars', async (t) => {
  const { api, llm, logger } = await setupApi(t, {
    streams: [plainStream('nope'), plainStream('still nope')],
  });
  await assertApiError(api.translate({ texts: ['one', 'two'] }), 'INVALID_MODEL_OUTPUT');
  assert.equal(llm.state.streamCalls.length, 2);
  assert.ok(logger.lines.warn.some((line) => line.includes('invalid model output')));
});

test('single-segment batches accept plain-text model answers', async (t) => {
  const { api } = await setupApi(t, { streams: [plainStream('沉浸式的')] });
  const result = await api.translate({ texts: ['immersive'] });
  assert.deepEqual(result.translations, ['沉浸式的']);
});

test('translate validates text limits and language overrides', async (t) => {
  const { api } = await setupApi(t);
  await assertApiError(api.translate({ texts: [] }), 'BAD_REQUEST');
  await assertApiError(api.translate({ texts: Array.from({ length: 51 }, () => 'x') }), 'BAD_REQUEST');
  await assertApiError(api.translate({ texts: ['x'.repeat(8001)] }), 'BAD_REQUEST');
  await assertApiError(api.translate({ texts: ['x'], targetLanguage: 'xx-YY' }), 'BAD_REQUEST');
  await assertApiError(api.translate({}), 'BAD_REQUEST');
});

test('translate keeps empty segments in place without calling the model for them', async (t) => {
  const { api, llm } = await setupApi(t, { streams: [jsonStream({ translations: ['你好'] })] });
  const result = await api.translate({ texts: ['', 'hello', ''] });
  assert.deepEqual(result.translations, ['', '你好', '']);
  assert.equal(llm.state.streamCalls.length, 1);
  assert.ok(llm.state.streamCalls[0].messages[0].content[0].text.includes('["hello"]'));
});

test('translate maps model failures to the DESIGN error codes', async (t) => {
  const { api } = await setupApi(t, { streams: [failStream('RATE_LIMIT', 429)] });
  await assert.rejects(api.translate({ texts: ['x'] }), (error) => {
    assert.equal(error.code, 'MODEL_RATE_LIMITED');
    assert.equal(error.status, 429);
    return true;
  });
});

test('no configured model yields MODEL_UNAVAILABLE', async (t) => {
  const { api } = await setupApi(t, {
    selection: null,
    llmOptions: { providers: [], models: {} },
  });
  await assertApiError(api.translate({ texts: ['x'] }), 'MODEL_UNAVAILABLE');
  const settings = await api.getSettings();
  assert.equal(settings.settings.provider, '');
  assert.equal(settings.selected.source, 'default');
});

test('explicit reasoningEffort passes through and auto picks the least effort', async (t) => {
  const { api, llm } = await setupApi(t, {
    streams: [jsonStream({ translations: ['a'] }), jsonStream({ translations: ['b'] })],
  });
  await api.putSettings({ reasoningEffort: 'max' });
  await api.translate({ texts: ['one'] });
  assert.equal(llm.state.streamCalls[0].reasoningEffort, 'max');

  const second = await setupApi(t, {
    llmOptions: { modelInfo: { reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } } },
    streams: [jsonStream({ translations: ['a'] })],
  });
  await second.api.translate({ texts: ['one'] });
  assert.equal(second.llm.state.streamCalls[0].reasoningEffort, 'low');
});

test('lookup translates and attaches a trimmed dictionary for English words', async (t) => {
  const dictionaryFixture = [{
    word: 'immersive',
    phonetic: '/ɪˈmɜːsɪv/',
    phonetics: [{ audio: '' }, { audio: 'https://example.com/immersive.mp3' }],
    meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'Giving the impression of immersion.' }] }],
  }];
  const fetchCalls = [];
  const { api, llm } = await setupApi(t, {
    streams: [plainStream('沉浸式的')],
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return { ok: true, json: async () => dictionaryFixture };
    },
  });
  const lookup = await api.lookup({ text: 'immersive', context: 'an immersive experience', sourceUrl: 'https://example.com/a' });
  const { result } = lookup;
  assert.deepEqual(lookup.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(lookup.retries, 0);
  assert.equal(result.text, 'immersive');
  assert.equal(result.translation, '沉浸式的');
  assert.equal(result.provider, 'modelhub');
  assert.equal(result.model, 'deepseek-flash');
  assert.equal(result.dictionary.word, 'immersive');
  assert.equal(result.dictionary.audio, 'https://example.com/immersive.mp3');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /dictionaryapi\.dev/);
  assert.equal(llm.state.streamCalls[0].system.includes('zh-CN'), true);
});

test('lookup skips the dictionary for phrases and degrades on dictionary errors', async (t) => {
  let fetches = 0;
  const { api } = await setupApi(t, {
    streams: [plainStream('你好，世界'), plainStream('沉浸式的')],
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('dictionary offline');
    },
  });
  const phrase = await api.lookup({ text: 'hello world' });
  assert.equal(phrase.result.translation, '你好，世界');
  assert.equal(phrase.result.dictionary, undefined);
  assert.equal(fetches, 0, 'phrases never query the dictionary');

  const word = await api.lookup({ text: 'immersive' });
  assert.equal(word.result.translation, '沉浸式的');
  assert.equal(word.result.dictionary, undefined, 'dictionary failure degrades silently');
  assert.equal(fetches, 1);
});

test('lookup validates its input', async (t) => {
  const { api } = await setupApi(t);
  await assertApiError(api.lookup({ text: '' }), 'BAD_REQUEST');
  await assertApiError(api.lookup({ text: 'x'.repeat(501) }), 'BAD_REQUEST');
  await assertApiError(api.lookup({ text: 'x', sourceUrl: 'javascript:alert(1)' }), 'INVALID_URL_OR_TEXT');
  await assertApiError(api.lookup({ text: 'x', targetLanguage: 'xx-YY' }), 'BAD_REQUEST');
  await assertApiError(api.lookup({}), 'BAD_REQUEST');
});

test('wordbook API adds/dedupes/reviews/removes with persistence', async (t) => {
  const now = 1_700_000_000_000;
  const { api, dir } = await setupApi(t, { now: () => now });
  const added = await api.addWordbookEntry({
    word: 'immersive',
    translation: '沉浸式的',
    targetLanguage: 'zh-CN',
    context: 'an immersive experience',
  });
  assert.equal(added.existed, false);
  assert.equal(added.item.id.startsWith('wb_'), true);

  const duplicate = await api.addWordbookEntry({ word: 'immersive', translation: 'x', targetLanguage: 'zh-CN', context: 'newer' });
  assert.equal(duplicate.existed, true);
  assert.equal(duplicate.item.id, added.item.id);
  assert.equal(duplicate.item.context, 'newer');

  const listed = await api.listWordbook({});
  assert.equal(listed.items.length, 1);
  assert.deepEqual(listed.stats, { total: 1, due: 1, todayDue: 1, mastered: 0, newCount: 1 });

  const reviewed = await api.reviewWordbookEntry({ id: added.item.id, grade: 'good' });
  assert.equal(reviewed.item.level, 1);
  assert.equal(reviewed.item.dueAt, now + DAY);

  const persisted = JSON.parse(await readFile(join(dir, 'wordbook.json'), 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.items[0].level, 1);

  await api.removeWordbookEntry({ id: added.item.id });
  assert.equal((await api.listWordbook({})).items.length, 0);
  await assertApiError(api.reviewWordbookEntry({ id: 'wb_missing', grade: 'good' }), 'NOT_FOUND');
});

test('config extensionOrigins is normalized on the facade', async (t) => {
  const { api } = await setupApi(t, { config: { extensionOrigins: [' Chrome-Extension://ABC ', ''] } });
  assert.deepEqual(api.extensionOrigins, ['chrome-extension://abc']);
});

test('saved settings survive an API restart over the same data dir', async (t) => {
  const { api, dir } = await setupApi(t);
  await api.putSettings({ provider: 'modelhub', model: 'deepseek-flash', targetLanguage: 'ko', batchChars: 900 });
  const restarted = createApi({
    ctx: createFakeCtx({ llm: createFakeLlm({}), logger: createFakeLogger() }),
    logger: createFakeLogger(),
    dataDir: dir,
  });
  const payload = await restarted.getSettings();
  assert.equal(payload.settings.targetLanguage, 'ko');
  assert.equal(payload.settings.batchChars, 900);
  assert.equal(payload.selected.source, 'settings');
  assert.equal(payload.selected.provider, 'modelhub');
});

test('accepts a callable Cordis-style logger service', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const lines = [];
  const callableLogger = (...args) => lines.push(args.join(' '));
  for (const level of ['debug', 'info', 'warn', 'error']) {
    callableLogger[level] = (...args) => lines.push(args.join(' '));
  }
  const api = createApi({
    ctx: createFakeCtx({ llm: createFakeLlm({}) }),
    logger: callableLogger,
    dataDir: dir,
  });
  api.logger.warn('warn line');
  api.logger.debug('debug line');
  assert.ok(lines.includes('warn line'));
  assert.ok(lines.includes('debug line'));
});

/* ------------------------------------------------------------------ */
/* Token usage ledger (DESIGN-TOKEN-USAGE §2.3)                        */
/* ------------------------------------------------------------------ */

test('records a translate usage event with request metadata', async (t) => {
  const { api, dir } = await setupApi(t, {
    streams: [jsonStream(
      { translations: ['你好', '世界'] },
      { inputTokens: 11, outputTokens: 7, cacheReadTokens: 2, cacheWriteTokens: 3 },
    )],
  });
  const result = await api.translate({
    texts: ['hello', 'world'],
    targetLanguage: 'ja',
    sourceLanguage: 'en',
    sourceUrl: 'https://example.com/page?a=1',
    sourceTitle: 'Example page',
    client: 'extension',
  });
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
  });

  const { usage } = await api.getUsage({ days: 2 });
  assert.equal(usage.version, 1);
  assert.equal(usage.totals.requests, 1);
  assert.equal(usage.totals.ok, 1);
  assert.equal(usage.totals.errors, 0);
  assert.equal(usage.totals.cached, 0);
  assert.equal(usage.totals.inputTokens, 11);
  assert.equal(usage.totals.outputTokens, 7);
  assert.equal(usage.totals.cacheReadTokens, 2);
  assert.equal(usage.totals.cacheWriteTokens, 3);
  assert.equal(usage.today.requests, 1);
  assert.equal(usage.days.length, 2);
  assert.equal(usage.byKind.translate.requests, 1);
  assert.equal(usage.byKind.lookup.requests, 0);
  assert.equal(usage.byModel.length, 1);
  assert.equal(usage.byModel[0].provider, 'modelhub');
  assert.equal(usage.byModel[0].model, 'deepseek-flash');
  assert.equal(usage.byModel[0].requests, 1);
  assert.equal(usage.byModel[0].inputTokens, 11);
  assert.equal(usage.recent.length, 1);

  const page = await api.listUsageEvents({ limit: '10' });
  assert.equal(page.hasMore, false);
  assert.equal(page.nextBefore, null);
  assert.equal(page.events.length, 1);
  const event = page.events[0];
  assert.match(event.id, /^evt_/);
  assert.equal(event.kind, 'translate');
  assert.equal(event.ok, true);
  assert.equal(event.provider, 'modelhub');
  assert.equal(event.model, 'deepseek-flash');
  assert.equal(event.reasoningEffort, 'off');
  assert.equal(event.targetLanguage, 'ja');
  assert.equal(event.sourceLanguage, 'en');
  assert.equal(event.client, 'extension');
  assert.equal(event.site, 'example.com');
  assert.equal(event.sourceUrl, 'https://example.com/page?a=1');
  assert.equal(event.sourceTitle, 'Example page');
  assert.equal(event.segments, 2);
  assert.equal(event.chars, 10);
  assert.equal(event.sample, 'hello');
  assert.equal(event.cached, false);
  assert.equal(event.retries, 0);
  assert.equal(event.inputTokens, 11);
  assert.equal(event.outputTokens, 7);
  assert.equal(event.cacheReadTokens, 2);
  assert.equal(event.cacheWriteTokens, 3);
  assert.ok(event.latencyMs >= 0);
  assert.equal(event.errorCode, undefined);

  const raw = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.events.length, 1);
  assert.equal(raw.totals.inputTokens, 11);
});

test('records cached translate calls with zero tokens', async (t) => {
  const { api } = await setupApi(t, {
    streams: [jsonStream({ translations: ['你好'] }, { inputTokens: 9, outputTokens: 4 })],
  });
  await api.translate({ texts: ['hello'] });
  const cached = await api.translate({ texts: ['hello'] });
  assert.equal(cached.cached, true);

  const { usage } = await api.getUsage({ days: 1 });
  assert.equal(usage.totals.requests, 2);
  assert.equal(usage.totals.cached, 1);
  assert.equal(usage.totals.inputTokens, 9);
  const { events } = await api.listUsageEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].cached, true);
  assert.equal(events[0].inputTokens, 0);
  assert.equal(events[1].cached, false);
  assert.equal(events[1].inputTokens, 9);
});

test('records a lookup usage event with tokens and metadata', async (t) => {
  const { api } = await setupApi(t, {
    streams: [
      () => textStream('你好，世界', { usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0 } }),
    ],
  });
  const lookup = await api.lookup({
    text: 'hello world',
    targetLanguage: 'zh-CN',
    sourceUrl: 'https://example.com/word',
    sourceTitle: 'Example',
    client: 'extension',
  });
  assert.equal(lookup.result.translation, '你好，世界');
  assert.deepEqual(lookup.usage, {
    inputTokens: 6,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
  });
  assert.equal(lookup.retries, 0);

  const { usage } = await api.getUsage({ days: 1 });
  assert.equal(usage.totals.requests, 1);
  assert.equal(usage.byKind.lookup.requests, 1);
  assert.equal(usage.byKind.translate.requests, 0);
  assert.equal(usage.totals.inputTokens, 6);

  const { events } = await api.listUsageEvents();
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.kind, 'lookup');
  assert.equal(event.ok, true);
  assert.equal(event.provider, 'modelhub');
  assert.equal(event.model, 'deepseek-flash');
  assert.equal(event.segments, 1);
  assert.equal(event.chars, 11);
  assert.equal(event.sample, 'hello world');
  assert.equal(event.targetLanguage, 'zh-CN');
  assert.equal(event.sourceUrl, 'https://example.com/word');
  assert.equal(event.site, 'example.com');
  assert.equal(event.sourceTitle, 'Example');
  assert.equal(event.client, 'extension');
  assert.equal(event.cached, false);
  assert.equal(event.retries, 0);
  assert.equal(event.inputTokens, 6);
  assert.equal(event.outputTokens, 2);
  assert.equal(event.cacheReadTokens, 1);
});

test('records a failed translate call without masking the original error', async (t) => {
  const { api } = await setupApi(t, { streams: [failStream('RATE_LIMIT', 429)] });
  await assert.rejects(api.translate({
    texts: ['hello', 'world'],
    targetLanguage: 'zh-CN',
    sourceUrl: 'https://example.com/x',
    client: 'extension',
  }), (error) => {
    assert.equal(error.code, 'MODEL_RATE_LIMITED');
    assert.equal(error.status, 429);
    return true;
  });

  const { usage } = await api.getUsage({ days: 1 });
  assert.equal(usage.totals.requests, 1);
  assert.equal(usage.totals.ok, 0);
  assert.equal(usage.totals.errors, 1);
  assert.equal(usage.totals.inputTokens, 0);
  assert.equal(usage.byModel[0].requests, 1);

  const { events } = await api.listUsageEvents({ kind: 'error' });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.ok, false);
  assert.equal(event.errorCode, 'MODEL_RATE_LIMITED');
  assert.equal(event.provider, 'modelhub', 'best-effort provider from the resolved selection');
  assert.equal(event.model, 'deepseek-flash');
  assert.equal(event.targetLanguage, 'zh-CN');
  assert.equal(event.client, 'extension');
  assert.equal(event.site, 'example.com');
  assert.equal(event.segments, 2);
  assert.equal(event.chars, 10);
  assert.equal(event.inputTokens, 0);
  assert.equal(event.outputTokens, 0);
  assert.equal(event.retries, 0);
  assert.ok(event.latencyMs >= 0);
});

test('a failed selection still records an event with empty provider/model', async (t) => {
  const { api } = await setupApi(t, {
    selection: null,
    llmOptions: { providers: [], models: {} },
  });
  await assertApiError(api.translate({ texts: ['x'] }), 'MODEL_UNAVAILABLE');

  const { events } = await api.listUsageEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
  assert.equal(events[0].errorCode, 'MODEL_UNAVAILABLE');
  assert.equal(events[0].provider, '');
  assert.equal(events[0].model, '');
  const { usage } = await api.getUsage();
  assert.equal(usage.totals.errors, 1);
  assert.deepEqual(usage.byModel, []);
});

test('validates sourceUrl/sourceTitle/client metadata and defaults client', async (t) => {
  const { api, llm } = await setupApi(t);
  await assertApiError(api.translate({ texts: ['x'], sourceUrl: 'javascript:alert(1)' }), 'INVALID_URL_OR_TEXT');
  await assertApiError(api.translate({ texts: ['x'], sourceUrl: 'not a url' }), 'INVALID_URL_OR_TEXT');
  await assertApiError(api.translate({ texts: ['x'], sourceTitle: 't'.repeat(201) }), 'BAD_REQUEST');
  await assertApiError(api.translate({ texts: ['x'], sourceTitle: 42 }), 'BAD_REQUEST');
  await assertApiError(api.translate({ texts: ['x'], client: 'c'.repeat(33) }), 'BAD_REQUEST');
  await assertApiError(api.lookup({ text: 'hola', sourceUrl: 'ftp://example.com/x' }), 'INVALID_URL_OR_TEXT');
  await assertApiError(api.lookup({ text: 'hola', client: 7 }), 'BAD_REQUEST');
  assert.equal(llm.state.streamCalls.length, 0, 'metadata validation happens before the model call');

  const { events } = await api.listUsageEvents({ limit: '20' });
  assert.equal(events.length, 7, 'even rejected metadata calls leave a failure event');
  assert.ok(events.every((event) => event.ok === false));

  const valid = await setupApi(t, {
    streams: [jsonStream({ translations: ['你好'] })],
  });
  const result = await valid.api.translate({
    texts: ['hello'],
    sourceUrl: 'https://example.com/a',
    sourceTitle: 'A',
    client: 'extension',
  });
  assert.deepEqual(result.translations, ['你好']);
  const { events: validEvents } = await valid.api.listUsageEvents();
  assert.equal(validEvents[0].client, 'extension');
  assert.equal(validEvents[0].sourceUrl, 'https://example.com/a');
  assert.equal(validEvents[0].sourceTitle, 'A');

  const defaulted = await setupApi(t, {
    streams: [jsonStream({ translations: ['你好'] })],
  });
  await defaulted.api.translate({ texts: ['hello'] });
  const { events: defaultEvents } = await defaulted.api.listUsageEvents();
  assert.equal(defaultEvents[0].client, 'dsh');
});

test('a broken usage ledger never fails a translation', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  await mkdir(join(dir, 'usage.json'), { recursive: true });
  const logger = createFakeLogger();
  const llm = createFakeLlm({ streams: [jsonStream({ translations: ['你好'] })] });
  const ctx = createFakeCtx({ llm, logger });
  const api = createApi({ ctx, logger, dataDir: dir });

  const result = await api.translate({ texts: ['hello'] });
  assert.deepEqual(result.translations, ['你好']);
  assert.ok(logger.lines.warn.some((line) => line.includes('usage')));
  const { usage } = await api.getUsage();
  assert.equal(usage.totals.requests, 0);
});

test('clears the ledger and paginates usage events', async (t) => {
  const { api } = await setupApi(t, {
    streams: [
      jsonStream({ translations: ['a'] }),
      jsonStream({ translations: ['b'] }),
      jsonStream({ translations: ['c'] }),
    ],
  });
  await api.translate({ texts: ['one'] });
  await api.translate({ texts: ['two'] });
  await api.translate({ texts: ['three'] });

  const first = await api.listUsageEvents({ limit: '2' });
  assert.equal(first.events.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextBefore, 'string');
  const second = await api.listUsageEvents({ limit: '2', before: first.nextBefore });
  assert.equal(second.events.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextBefore, null);

  const cleared = await api.clearUsage();
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.usage.totals.requests, 0);
  assert.equal((await api.getUsage({ days: '3' })).usage.days.length, 3);
  assert.equal((await api.getUsage({ days: '1000' })).usage.days.length, 90);
  assert.equal((await api.getUsage({ days: '0' })).usage.days.length, 1);
  assert.equal((await api.getUsage({ days: 'abc' })).usage.days.length, 14);
  assert.deepEqual((await api.listUsageEvents()).events, []);
});

test('recordHistory=false stops ledger/conversation recording until re-enabled', async (t) => {
  const { api } = await setupApi(t, {
    streams: [
      jsonStream({ translations: ['你好'] }),
      jsonStream({ translations: ['世界'] }),
    ],
  });
  const disabled = await api.putSettings({ recordHistory: false });
  assert.equal(disabled.settings.recordHistory, false);
  await api.translate({ texts: ['hello'] });
  assert.equal((await api.listUsageEvents()).events.length, 0, 'no usage event while recording is off');
  assert.equal((await api.getUsage()).usage.totals.requests, 0);

  await api.putSettings({ recordHistory: true });
  await api.translate({ texts: ['world'] });
  assert.equal((await api.listUsageEvents()).events.length, 1, 'recording resumes after re-enabling');
});

test('clearRecords clears the ledger and is idempotent', async (t) => {
  const { api } = await setupApi(t, {
    streams: [
      jsonStream({ translations: ['a'] }),
      jsonStream({ translations: ['b'] }),
    ],
  });
  await api.translate({ texts: ['one'] });
  await api.translate({ texts: ['two'] });
  assert.equal((await api.getUsage()).usage.totals.requests, 2);

  const first = await api.clearRecords();
  assert.equal(first.cleared, true);
  assert.equal(first.usage.totals.requests, 0);
  assert.deepEqual((await api.listUsageEvents()).events, []);
  assert.equal((await api.getUsage()).usage.totals.requests, 0);

  const second = await api.clearRecords();
  assert.equal(second.cleared, true);
  assert.equal(second.usage.totals.requests, 0);
});

test('exposes avgLatencyMs from the persisted latency aggregation', async (t) => {
  const { api, dir } = await setupApi(t, {
    streams: [
      jsonStream({ translations: ['a'] }),
      jsonStream({ translations: ['b'] }),
    ],
  });
  await api.translate({ texts: ['one'] });
  await api.translate({ texts: ['two'] });

  const { usage } = await api.getUsage({ days: 2 });
  assert.ok(Number.isInteger(usage.totals.avgLatencyMs), 'rounded integer milliseconds');
  assert.ok(usage.totals.avgLatencyMs >= 0);
  assert.equal(usage.today.avgLatencyMs, usage.totals.avgLatencyMs);
  assert.equal(usage.days.at(-1).avgLatencyMs, usage.totals.avgLatencyMs);
  assert.equal(usage.byKind.translate.avgLatencyMs, usage.totals.avgLatencyMs);
  assert.equal(usage.byKind.lookup.avgLatencyMs, 0);

  const raw = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
  assert.equal(raw.totals.latencyCount, 2);
  assert.ok(Number.isInteger(raw.totals.latencySum));
  assert.ok(raw.totals.latencySum >= 0);
  assert.equal(
    raw.totals.latencySum,
    usage.recent.reduce((sum, event) => sum + event.latencyMs, 0),
    'persisted sum equals the recorded event latencies',
  );
});

/* ------------------------------------------------------------------ */
/* Turn trace aggregation (DESIGN-TURN-TRACE §2.3)                     */
/* ------------------------------------------------------------------ */

test('records turn metadata and outputPreview on successful translate and lookup', async (t) => {
  const longTranslation = '你'.repeat(250);
  const { api } = await setupApi(t, {
    streams: [
      jsonStream({ translations: [longTranslation, '世界'] }, { inputTokens: 11, outputTokens: 7 }),
      () => textStream('沉浸式的'),
    ],
    fetchImpl: async () => {
      throw new Error('dictionary offline');
    },
  });
  await api.translate({
    texts: ['hello', 'world'],
    turnId: ' tr_1 ',
    stepIndex: 0,
    mode: 'bilingual',
    client: 'extension',
  });
  await api.lookup({ text: 'immersive', turnId: 'lk_1', stepIndex: 0, mode: 'only', client: 'extension' });

  const { events } = await api.listUsageEvents();
  const [lookupEvent, translateEvent] = events;
  assert.equal(translateEvent.turnId, 'tr_1', 'turnId is trimmed');
  assert.equal(translateEvent.stepIndex, 0);
  assert.equal(translateEvent.mode, 'bilingual');
  assert.equal(translateEvent.outputPreview, '你'.repeat(200), 'preview keeps the first 200 result chars');
  assert.equal(lookupEvent.turnId, 'lk_1');
  assert.equal(lookupEvent.stepIndex, 0);
  assert.equal(lookupEvent.mode, 'only');
  assert.equal(lookupEvent.outputPreview, '沉浸式的');

  const page = await api.getUsageTurns();
  assert.equal(page.hasMore, false);
  assert.equal(page.nextBefore, null);
  assert.equal(page.turns.length, 2);
  assert.equal(page.turns[0].id, 'lk_1');
  assert.equal(page.turns[0].kind, 'lookup');
  assert.equal(page.turns[0].steps[0].outputPreview, '沉浸式的');
  assert.equal(page.turns[1].id, 'tr_1');
  assert.equal(page.turns[1].mode, 'bilingual');
  assert.equal(page.turns[1].client, 'extension');
  assert.equal(page.turns[1].steps[0].outputPreview.length, 200, 'outputPreview is capped at 200 chars');
});

test('validates turn metadata on translate and lookup bodies', async (t) => {
  const { api, llm } = await setupApi(t);
  const invalidTranslateBodies = [
    { turnId: 42 },
    { turnId: 't'.repeat(65) },
    { stepIndex: -1 },
    { stepIndex: 10_001 },
    { stepIndex: 1.5 },
    { stepIndex: '0' },
    { mode: 7 },
    { mode: 'm'.repeat(17) },
  ];
  for (const extra of invalidTranslateBodies) {
    await assertApiError(api.translate({ texts: ['x'], ...extra }), 'BAD_REQUEST');
  }
  await assertApiError(api.lookup({ text: 'hola', turnId: 't'.repeat(65) }), 'BAD_REQUEST');
  await assertApiError(api.lookup({ text: 'hola', stepIndex: 10_001 }), 'BAD_REQUEST');
  assert.equal(llm.state.streamCalls.length, 0, 'turn metadata validation happens before the model call');

  const { events } = await api.listUsageEvents({ limit: '50' });
  assert.equal(events.length, invalidTranslateBodies.length + 2, 'each rejected call leaves a failure event');
  assert.ok(events.every((event) => event.ok === false));

  // Valid sibling turn fields survive an unrelated metadata rejection.
  const { api: second } = await setupApi(t);
  await assertApiError(second.translate({
    texts: ['x'],
    turnId: 'tr_1',
    stepIndex: 4,
    mode: 'source',
    sourceTitle: 't'.repeat(201),
  }), 'BAD_REQUEST');
  const { events: failureEvents } = await second.listUsageEvents();
  assert.equal(failureEvents.length, 1);
  assert.equal(failureEvents[0].ok, false);
  assert.equal(failureEvents[0].turnId, 'tr_1');
  assert.equal(failureEvents[0].stepIndex, 4);
  assert.equal(failureEvents[0].mode, 'source');
});

test('records turn metadata on failed calls', async (t) => {
  const { api } = await setupApi(t, { streams: [failStream('RATE_LIMIT', 429)] });
  await assert.rejects(api.translate({
    texts: ['x'],
    turnId: 'tr_fail',
    stepIndex: 3,
    mode: 'only',
  }), (error) => {
    assert.equal(error.code, 'MODEL_RATE_LIMITED');
    return true;
  });

  const { events } = await api.listUsageEvents({ kind: 'error' });
  assert.equal(events.length, 1);
  assert.equal(events[0].turnId, 'tr_fail');
  assert.equal(events[0].stepIndex, 3);
  assert.equal(events[0].mode, 'only');
  assert.equal(events[0].outputPreview, undefined);

  const { turns } = await api.getUsageTurns({ kind: 'error' });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].id, 'tr_fail');
  assert.equal(turns[0].status, 'error');
  assert.equal(turns[0].steps[0].stepIndex, 3);
});

test('getUsageTurns aggregates one run into a Turn and supports paging/filters', async (t) => {
  const { api } = await setupApi(t, {
    streams: [
      jsonStream({ translations: ['a1', 'a2'] }, { inputTokens: 5, outputTokens: 3 }),
      jsonStream({ translations: ['b1', 'b2'] }, { inputTokens: 4, outputTokens: 2 }),
    ],
  });
  const meta = {
    turnId: 'tr_run',
    mode: 'bilingual',
    client: 'extension',
    sourceUrl: 'https://example.com/article',
  };
  await api.translate({ texts: ['t1', 't2'], ...meta, stepIndex: 0 });
  await api.translate({ texts: ['t3', 't4'], ...meta, stepIndex: 1 });

  const page = await api.getUsageTurns({ limit: '1' });
  assert.deepEqual(Object.keys(page).sort(), ['hasMore', 'nextBefore', 'turns']);
  assert.deepEqual(JSON.parse(JSON.stringify(page)), page, 'the envelope is JSON-serializable');
  assert.equal(page.hasMore, false);
  assert.equal(page.nextBefore, null);
  assert.equal(page.turns.length, 1);

  const [turn] = page.turns;
  assert.equal(turn.id, 'tr_run');
  assert.equal(turn.kind, 'translate');
  assert.equal(turn.mode, 'bilingual');
  assert.equal(turn.client, 'extension');
  assert.equal(turn.site, 'example.com');
  assert.equal(turn.sourceUrl, 'https://example.com/article');
  assert.equal(turn.provider, 'modelhub');
  assert.equal(turn.model, 'deepseek-flash');
  assert.equal(turn.requests, 2);
  assert.equal(turn.ok, 2);
  assert.equal(turn.errors, 0);
  assert.equal(turn.status, 'ok');
  assert.equal(turn.segments, 4);
  assert.equal(turn.chars, 8);
  assert.equal(turn.inputTokens, 9);
  assert.equal(turn.outputTokens, 5);
  assert.equal(typeof turn.avgLatencyMs, 'number');
  assert.deepEqual(turn.steps.map((step) => step.stepIndex), [0, 1]);
  assert.deepEqual(turn.steps.map((step) => step.outputPreview), ['a1', 'b1']);
  assert.deepEqual(turn.steps.map((step) => step.segments), [2, 2]);

  // Query pass-through: unknown `before` restarts, filters read the ledger.
  assert.equal((await api.getUsageTurns({ before: 'tr_missing' })).turns.length, 1);
  assert.equal((await api.getUsageTurns({ limit: '0' })).turns.length, 1, 'limit clamps to at least 1');
  assert.deepEqual((await api.getUsageTurns({ kind: 'lookup' })).turns, []);
  assert.equal((await api.getUsageTurns({ kind: 'translate' })).turns.length, 1);
  assert.equal((await api.getUsageTurns({ status: 'ok' })).turns.length, 1);
  assert.deepEqual((await api.getUsageTurns({ kind: 'error' })).turns, []);
});

/* ------------------------------------------------------------------ */
/* Native DSH conversations (DESIGN-CONVERSATIONS §2)                 */
/* ------------------------------------------------------------------ */

test('listConversations merges live bridge rows with ledger aggregates', async (t) => {
  const agents = createFakeAgents();
  const { api } = await setupApi(t, {
    agents,
    streams: [
      jsonStream({ translations: ['甲一'] }, { inputTokens: 11, outputTokens: 7 }),
      jsonStream({ translations: ['乙一'] }, { inputTokens: 4, outputTokens: 2 }),
    ],
  });
  const meta = {
    turnId: 'tr_live',
    mode: 'bilingual',
    client: 'extension',
    sourceTitle: 'Live Page',
    sourceUrl: 'https://example.com/live',
  };
  await api.translate({ texts: ['one'], ...meta, stepIndex: 0 });
  await api.translate({ texts: ['two'], ...meta, stepIndex: 1 });

  const page = await api.listConversations();
  assert.deepEqual(Object.keys(page), ['conversations']);
  assert.deepEqual(JSON.parse(JSON.stringify(page)), page, 'the envelope is JSON-serializable');
  assert.equal(page.conversations.length, 1, 'one turnId owns exactly one native session');
  const [row] = page.conversations;
  assert.equal(row.sessionId, 'translation-tr_live');
  assert.equal(row.turnId, 'tr_live');
  assert.equal(row.title, '翻译 · Live Page');
  assert.equal(row.live, true);
  assert.equal(row.turns, 2);
  assert.equal(row.requests, 2);
  assert.equal(row.ok, 2);
  assert.equal(row.errors, 0);
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.kinds, ['translate']);
  assert.equal(row.sourceTitle, 'Live Page');
  assert.equal(row.site, 'example.com');
  assert.equal(row.model, 'deepseek-flash');
  assert.equal(row.inputTokens, 15);
  assert.equal(row.outputTokens, 9);
  assert.equal(row.cacheReadTokens, 0);
  assert.equal(row.cacheWriteTokens, 0);
  assert.equal(typeof row.createdAt, 'number');
  assert.equal(typeof row.firstAt, 'number');
  assert.ok(row.lastAt >= row.createdAt);

  // The bridge created one agent and both ledger events point at its session.
  assert.equal(agents.state.created.length, 1);
  assert.equal(agents.state.created[0].sessionId, 'translation-tr_live');
  assert.equal(agents.state.appended.filter((entry) => entry.type === 'assistant/message').length, 2);
  const { events } = await api.listUsageEvents();
  assert.deepEqual(events.map((event) => [event.sessionId, event.turn]), [
    ['translation-tr_live', 2],
    ['translation-tr_live', 1],
  ]);
  const { turns } = await api.getUsageTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, 'translation-tr_live');
});

test('listConversations derives historical conversations from ledger sessionIds', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const ledger = {
    version: 1,
    updatedAt: 4000,
    totals: {},
    days: {},
    models: {},
    kinds: {},
    events: [
      // Newest first, exactly as the ledger stores them.
      {
        id: 'evt_h4', at: 4000, kind: 'translate', ok: true, provider: 'p', model: 'm',
        turnId: 'tr_nosession', segments: 1, chars: 3, latencyMs: 5,
      },
      {
        id: 'evt_h3', at: 3000, kind: 'lookup', ok: true, provider: 'p2', model: 'm2',
        sessionId: 'translation-lk_b', turnId: 'lk_b', turn: 1,
        sourceTitle: 'B Page', site: 'b.example', inputTokens: 2, outputTokens: 1, latencyMs: 6,
      },
      {
        id: 'evt_h2', at: 2000, kind: 'translate', ok: false, errorCode: 'MODEL_FAILED',
        provider: 'p', model: 'm', sessionId: 'translation-a', turnId: 'tr_a', turn: 2,
        sourceTitle: 'Page A', site: 'a.example', latencyMs: 7,
      },
      {
        id: 'evt_h1', at: 1000, kind: 'translate', ok: true, provider: 'p', model: 'm',
        sessionId: 'translation-a', turnId: 'tr_a', turn: 1,
        sourceTitle: 'Page A', site: 'a.example',
        inputTokens: 10, outputTokens: 5, latencyMs: 8,
      },
    ],
  };
  await writeFile(join(dir, 'usage.json'), JSON.stringify(ledger), 'utf8');
  const logger = createFakeLogger();
  const api = createApi({ ctx: createFakeCtx({ llm: createFakeLlm({}), logger }), logger, dataDir: dir });

  const { conversations } = await api.listConversations();
  assert.deepEqual(conversations.map((row) => row.sessionId), ['translation-lk_b', 'translation-a']);
  const [lookupRow, translateRow] = conversations;

  assert.equal(lookupRow.live, false);
  assert.equal(lookupRow.turnId, 'lk_b');
  assert.equal(lookupRow.title, '翻译查词 · B Page');
  assert.deepEqual(lookupRow.kinds, ['lookup']);
  assert.equal(lookupRow.turns, 1);
  assert.equal(lookupRow.requests, 1);
  assert.equal(lookupRow.status, 'ok');
  assert.deepEqual(
    [lookupRow.inputTokens, lookupRow.outputTokens, lookupRow.cacheReadTokens, lookupRow.cacheWriteTokens],
    [2, 1, 0, 0],
  );
  assert.deepEqual([lookupRow.createdAt, lookupRow.firstAt, lookupRow.lastAt], [3000, 3000, 3000]);

  assert.equal(translateRow.turnId, 'tr_a');
  assert.equal(translateRow.title, '翻译 · Page A');
  assert.equal(translateRow.requests, 2);
  assert.equal(translateRow.turns, 2, 'historical turns are derived from ledger rows');
  assert.equal(translateRow.ok, 1);
  assert.equal(translateRow.errors, 1);
  assert.equal(translateRow.status, 'partial');
  assert.deepEqual(translateRow.kinds, ['translate']);
  assert.deepEqual(
    [translateRow.inputTokens, translateRow.outputTokens, translateRow.cacheReadTokens, translateRow.cacheWriteTokens],
    [10, 5, 0, 0],
  );
  assert.deepEqual([translateRow.createdAt, translateRow.firstAt, translateRow.lastAt], [1000, 1000, 2000]);
  assert.equal(translateRow.sourceTitle, 'Page A');
  assert.equal(translateRow.site, 'a.example');
  assert.equal(translateRow.model, 'm');

  // Events without a sessionId never create a conversation row.
  assert.ok(!conversations.some((row) => row.turnId === 'tr_nosession'));
  // The pre-existing /usage/* endpoints keep reading the same ledger.
  assert.equal((await api.listUsageEvents()).events.length, 4);
  assert.equal((await api.getUsageTurns()).turns.length, 3);
});

test('a failed translation with a turnId records an error conversation row', async (t) => {
  const agents = createFakeAgents();
  const { api } = await setupApi(t, { agents, streams: [failStream('RATE_LIMIT', 429)] });
  await assert.rejects(api.translate({
    texts: ['x'],
    turnId: 'tr_fail_conv',
    stepIndex: 0,
    sourceTitle: 'Fail Page',
    client: 'extension',
  }), (error) => {
    assert.equal(error.code, 'MODEL_RATE_LIMITED');
    return true;
  });

  const { events } = await api.listUsageEvents({ kind: 'error' });
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, 'translation-tr_fail_conv');
  assert.equal(events[0].turn, 1);

  const { conversations } = await api.listConversations();
  assert.equal(conversations.length, 1);
  const [row] = conversations;
  assert.equal(row.sessionId, 'translation-tr_fail_conv');
  assert.equal(row.turnId, 'tr_fail_conv');
  assert.equal(row.title, '翻译 · Fail Page');
  assert.equal(row.live, true);
  assert.equal(row.status, 'error');
  assert.equal(row.turns, 1);
  assert.equal(row.requests, 1);
  assert.equal(row.ok, 0);
  assert.equal(row.errors, 1);
  assert.equal(row.inputTokens, 0);
  assert.equal(row.outputTokens, 0);
  assert.equal(row.model, 'deepseek-flash');

  // The native round is user message + error turn end, without an assistant reply.
  const appendedTypes = agents.state.appended.map((entry) => entry.type);
  assert.deepEqual(appendedTypes, ['turn/start', 'step/start', 'user/message', 'step/end', 'turn/end']);
  const end = agents.state.appended.at(-1).payload;
  assert.equal(end.reason.kind, 'error');
  assert.equal(end.reason.error.code, 'MODEL_RATE_LIMITED');
});

test('listConversations still lists live sessions when the ledger is broken', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  // A directory where usage.json should be makes every ledger write fail.
  await mkdir(join(dir, 'usage.json'), { recursive: true });
  const logger = createFakeLogger();
  const agents = createFakeAgents();
  const llm = createFakeLlm({ streams: [jsonStream({ translations: ['甲'] })] });
  const api = createApi({
    ctx: createFakeCtx({ llm, logger, agents }),
    logger,
    dataDir: dir,
  });

  const result = await api.translate({ texts: ['one'], turnId: 'tr_broken_ledger', stepIndex: 0 });
  assert.deepEqual(result.translations, ['甲'], 'a broken ledger never fails the translation');

  const { conversations } = await api.listConversations();
  assert.equal(conversations.length, 1);
  const [row] = conversations;
  assert.equal(row.sessionId, 'translation-tr_broken_ledger');
  assert.equal(row.live, true);
  assert.equal(row.turns, 1);
  assert.equal(row.requests, 0, 'the broken ledger simply hides historical stats');
  assert.equal(row.status, 'ok');
  assert.equal(row.inputTokens, 0);
});

test('listConversations keeps at most 24 live rows and history for released sessions', async (t) => {
  const agents = createFakeAgents();
  const streams = Array.from({ length: 25 }, () => jsonStream({ translations: ['译文'] }, { inputTokens: 1, outputTokens: 1 }));
  const { api } = await setupApi(t, { agents, streams });
  for (let index = 0; index < 25; index += 1) {
    await api.translate({ texts: [`batch ${index}`], turnId: `tr_lru_${index}`, stepIndex: 0 });
  }
  const { conversations } = await api.listConversations();
  const liveRows = conversations.filter((row) => row.live === true);
  assert.equal(liveRows.length, 24, 'at most 24 conversation agents stay live');
  assert.equal(liveRows.some((row) => row.turnId === 'tr_lru_0'), false);
  assert.equal(liveRows.some((row) => row.turnId === 'tr_lru_24'), true);
  assert.ok(agents.state.disposed.includes('translation-tr_lru_0'));

  const released = conversations.find((row) => row.turnId === 'tr_lru_0');
  assert.equal(released?.live, false, 'the released session remains as a ledger-derived history row');
  assert.equal(released?.requests, 1);
  assert.equal(released?.inputTokens, 1);
  assert.equal(released?.outputTokens, 1);
  // The ledger keeps every round; `/usage/turns` still serves all 25 runs.
  const { turns } = await api.getUsageTurns({ limit: '100' });
  assert.equal(turns.length, 25);
});

test('listConversations keeps sessions from a previous host instance as history', async (t) => {
  const firstAgents = createFakeAgents();
  const first = await setupApi(t, {
    agents: firstAgents,
    streams: [jsonStream({ translations: ['旧译文'] }, { inputTokens: 7, outputTokens: 3 })],
  });
  await first.api.translate({
    texts: ['old batch'],
    turnId: 'tr_old',
    stepIndex: 0,
    sourceTitle: 'Old Page',
    client: 'extension',
  });
  assert.equal((await first.api.listConversations()).conversations[0].live, true);

  // A second host instance over the same data dir only inherits the ledger.
  const logger = createFakeLogger();
  const secondAgents = createFakeAgents();
  const llm = createFakeLlm({ streams: [jsonStream({ translations: ['新译文'] })] });
  const second = createApi({
    ctx: createFakeCtx({ llm, logger, agents: secondAgents }),
    logger,
    dataDir: first.dir,
  });

  const historyPage = await second.listConversations();
  assert.equal(historyPage.conversations.length, 1);
  const [historyRow] = historyPage.conversations;
  assert.equal(historyRow.sessionId, 'translation-tr_old');
  assert.equal(historyRow.turnId, 'tr_old');
  assert.equal(historyRow.live, false, 'a fresh host lists earlier sessions as history');
  assert.equal(historyRow.title, '翻译 · Old Page');
  assert.equal(historyRow.requests, 1);
  assert.equal(historyRow.inputTokens, 7);
  assert.equal(historyRow.outputTokens, 3);

  await second.translate({ texts: ['new batch'], turnId: 'tr_new', stepIndex: 0, sourceTitle: 'New Page' });
  const { conversations } = await second.listConversations();
  assert.equal(conversations.length, 2);
  const [liveRow, oldRow] = conversations;
  assert.equal(liveRow.sessionId, 'translation-tr_new');
  assert.equal(liveRow.live, true);
  assert.equal(oldRow.sessionId, 'translation-tr_old');
  assert.equal(oldRow.live, false);
});

/* ------------------------------------------------------------------ */
/* Persistent translation cache (DESIGN-CACHE §2/§3)                  */
/* ------------------------------------------------------------------ */

/** Poll until `predicate` is truthy (async cache flush / file write). */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return false;
}

/** Read cache.json and return its parsed envelope, or null while unwritten/corrupt. */
async function readCacheFile(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8'));
  } catch {
    return null;
  }
}

test('persistent cache hits across API instances and DELETE /cache clears it', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();

  const firstLlm = createFakeLlm({ streams: [jsonStream({ translations: ['你好'] }, { inputTokens: 11, outputTokens: 7 })] });
  const first = createApi({ ctx: createFakeCtx({ llm: firstLlm, logger }), logger, dataDir: dir });
  const cold = await first.translate({ texts: ['hello'] });
  assert.deepEqual(cold.translations, ['你好']);
  assert.equal(cold.cached, false);
  assert.equal(firstLlm.state.streamCalls.length, 1);

  const written = await waitFor(async () => {
    const raw = await readCacheFile(dir);
    return raw !== null && raw.v === 1 && Object.keys(raw.entries ?? {}).length === 1;
  });
  assert.equal(written, true, 'the debounced flush wrote cache.json');
  const raw = await readCacheFile(dir);
  assert.equal(raw.v, 1);
  assert.equal(typeof raw.savedAt, 'number');
  const [cacheKey, entry] = Object.entries(raw.entries)[0];
  assert.match(cacheKey, /^modelhub\|deepseek-flash\|zh-CN\|[0-9a-f]{40}$/);
  assert.equal(typeof entry[0], 'number');
  assert.deepEqual(entry[1], ['你好'], 'the value is [at, translations[]]');

  // A second host instance (DSH restart / plugin reload) hydrates the file.
  const secondLlm = createFakeLlm({ streams: [jsonStream({ translations: ['你好'] })] });
  const secondLogger = createFakeLogger();
  const second = createApi({
    ctx: createFakeCtx({ llm: secondLlm, logger: secondLogger }),
    logger: secondLogger,
    dataDir: dir,
  });
  const warm = await second.translate({ texts: ['hello'] });
  assert.deepEqual(warm.translations, ['你好']);
  assert.equal(warm.cached, true, 'a restart serves the persisted translations');
  assert.equal(secondLlm.state.streamCalls.length, 0, 'zero model calls on a persisted hit');
  assert.deepEqual(warm.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const { events } = await second.listUsageEvents({ limit: '5' });
  assert.equal(events[0].cached, true, 'the ledger still records the cached request');

  const cleared = await second.clearCache();
  assert.deepEqual(cleared, { cleared: true, entries: 0 });
  assert.deepEqual((await readCacheFile(dir)).entries, {});

  const coldAgain = await second.translate({ texts: ['hello'] });
  assert.deepEqual(coldAgain.translations, ['你好']);
  assert.equal(coldAgain.cached, false);
  assert.equal(secondLlm.state.streamCalls.length, 1, 'after DELETE /cache the model is called again');
});

test('a corrupt cache.json starts cold, warns once and is repaired', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  await writeFile(join(dir, 'cache.json'), '{definitely not json', 'utf8');
  const logger = createFakeLogger();
  const llm = createFakeLlm({ streams: [jsonStream({ translations: ['甲'] })] });
  const api = createApi({ ctx: createFakeCtx({ llm, logger }), logger, dataDir: dir });

  const result = await api.translate({ texts: ['x'] });
  assert.deepEqual(result.translations, ['甲'], 'a corrupt cache never fails a translation');
  assert.equal(result.cached, false);
  assert.equal(llm.state.streamCalls.length, 1);
  assert.ok(logger.lines.warn.some((line) => line.includes('cache.json')), 'the corrupt read is logged');

  const repaired = await waitFor(async () => {
    const raw = await readCacheFile(dir);
    return raw !== null && raw.v === 1 && Object.keys(raw.entries ?? {}).length === 1;
  });
  assert.equal(repaired, true, 'the next write repairs cache.json into the compact envelope');
});
