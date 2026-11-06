/** HTTP handler: routing, envelopes, Origin fence, body limits (DESIGN §5). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiError } from '../lib/errors.js';
import {
  API_BASE,
  apiSubPath,
  createHttpHandler,
  evaluateOrigin,
  readJsonBody,
  sendJson,
} from '../lib/http.js';
import { createFakeLogger, fakeRequest, invokeHandler } from './helpers.mjs';

const HOST = '127.0.0.1:3080';

/** Minimal API facade recording dispatched calls. */
function createStubApi(overrides = {}) {
  const logger = createFakeLogger();
  const calls = [];
  return {
    extensionOrigins: [],
    logger,
    calls,
    health: async () => ({ version: '1.0.0', uptimeMs: 7, llm: { providers: 1, models: 2 } }),
    listModels: async () => ({ catalog: [], defaultSelection: { provider: 'p', model: 'm' } }),
    resolveModel: async (provider, model) => {
      calls.push({ op: 'resolveModel', provider, model });
      return { model: { provider, model } };
    },
    getSettings: async () => ({ settings: {} }),
    getUsage: async (query) => {
      calls.push({ op: 'getUsage', query });
      return { usage: { version: 1, totals: { requests: 3 } } };
    },
    listUsageEvents: async (query) => {
      calls.push({ op: 'listUsageEvents', query });
      return { events: [], nextBefore: null, hasMore: false };
    },
    getUsageTurns: async (query) => {
      calls.push({ op: 'getUsageTurns', query });
      return { turns: [], nextBefore: null, hasMore: false };
    },
    clearUsage: async () => {
      calls.push({ op: 'clearUsage' });
      return { cleared: true, usage: { version: 1, totals: { requests: 0 } } };
    },
    clearCache: async () => {
      calls.push({ op: 'clearCache' });
      return { cleared: true, entries: 0 };
    },
    clearRecords: async () => {
      calls.push({ op: 'clearRecords' });
      return { cleared: true, usage: { totals: { requests: 0 } }, conversations: { sessions: 0, archived: 0 } };
    },
    putSettings: async (body) => {
      calls.push({ op: 'putSettings', body });
      return { settings: body };
    },
    translate: async (body, { signal } = {}) => {
      calls.push({ op: 'translate', body, hasSignal: signal instanceof AbortSignal });
      return { translations: body.texts.map((text) => text.toUpperCase()) };
    },
    lookup: async (body) => ({ result: { text: body.text } }),
    listWordbook: async (query) => {
      calls.push({ op: 'listWordbook', query });
      return { items: [], stats: {} };
    },
    addWordbookEntry: async (body) => ({ item: { id: 'wb_1', word: body.word }, existed: false }),
    updateWordbookEntry: async (body) => ({ item: { id: body.id } }),
    reviewWordbookEntry: async (body) => ({ item: { id: body.id } }),
    removeWordbookEntry: async () => ({}),
    ...overrides,
  };
}

test('apiSubPath strips the registered prefix and trailing slashes', () => {
  assert.equal(apiSubPath(`${API_BASE}/health`), '/health');
  assert.equal(apiSubPath(API_BASE), '/');
  assert.equal(apiSubPath(`${API_BASE}/`), '/');
  assert.equal(apiSubPath('/health'), '/health');
  assert.equal(apiSubPath('/settings/'), '/settings');
  assert.equal(apiSubPath(undefined), '/');
});

test('GET /health answers the success envelope with JSON headers', async () => {
  const handler = createHttpHandler(createStubApi(), {});
  const response = await invokeHandler(handler, fakeRequest({ url: '/dsh-immersive/api/health' }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, '1.0.0');
  assert.deepEqual(body.llm, { providers: 1, models: 2 });
});

test('HEAD is answered like GET without a body', async () => {
  const handler = createHttpHandler(createStubApi(), {});
  const response = await invokeHandler(handler, fakeRequest({ method: 'HEAD', url: '/dsh-immersive/api/health' }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '');
});

test('unknown paths answer 404 and wrong methods answer 405 with Allow', async () => {
  const handler = createHttpHandler(createStubApi(), {});
  const notFound = await invokeHandler(handler, fakeRequest({ url: '/dsh-immersive/api/nope' }));
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.json().error.code, 'NOT_FOUND');

  const method = await invokeHandler(handler, fakeRequest({ method: 'DELETE', url: '/dsh-immersive/api/health' }));
  assert.equal(method.statusCode, 405);
  assert.equal(method.json().error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(method.headers.allow, 'GET');
});

test('the Origin fence runs before routing', async () => {
  const handler = createHttpHandler(createStubApi(), {});
  const badOrigin = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/health',
    headers: { origin: 'https://evil.example' },
  }));
  assert.equal(badOrigin.statusCode, 403);
  assert.equal(badOrigin.json().error.code, 'FORBIDDEN_ORIGIN');

  const badOriginUnknownPath = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/nope',
    headers: { origin: 'https://evil.example' },
  }));
  assert.equal(badOriginUnknownPath.statusCode, 403);

  const extension = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/health',
    headers: { origin: 'chrome-extension://abcdefghijklmnop' },
  }));
  assert.equal(extension.statusCode, 200);

  const sameHost = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/health',
    headers: { origin: 'http://127.0.0.1:3080' },
  }));
  assert.equal(sameHost.statusCode, 200);
});

test('configured extensionOrigins narrow the allowlist', async () => {
  const api = createStubApi({ extensionOrigins: ['chrome-extension://allowed'] });
  const handler = createHttpHandler(api, {});
  const rejected = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/health',
    headers: { origin: 'chrome-extension://other' },
  }));
  assert.equal(rejected.statusCode, 403);
  const allowed = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/health',
    headers: { origin: 'chrome-extension://allowed' },
  }));
  assert.equal(allowed.statusCode, 200);
});

test('dispatches GET/PUT/POST routes with parsed bodies and signals', async () => {
  const api = createStubApi();
  const handler = createHttpHandler(api, {});

  const translate = await invokeHandler(handler, fakeRequest({
    method: 'POST',
    url: '/dsh-immersive/api/translate',
    body: { texts: ['hello'] },
  }));
  assert.equal(translate.statusCode, 200);
  assert.deepEqual(translate.json(), { ok: true, translations: ['HELLO'] });
  assert.deepEqual(api.calls.at(-1).body, { texts: ['hello'] });
  assert.equal(api.calls.at(-1).hasSignal, true);

  const settings = await invokeHandler(handler, fakeRequest({
    method: 'PUT',
    url: '/dsh-immersive/api/settings',
    body: { batchSegments: 3 },
  }));
  assert.equal(settings.statusCode, 200);
  assert.deepEqual(api.calls.at(-1).body, { batchSegments: 3 });

  const wordbook = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/wordbook?query=im&filter=due&limit=7',
  }));
  assert.deepEqual(api.calls.at(-1).query, { query: 'im', filter: 'due', limit: '7' });
  assert.equal(wordbook.json().ok, true);

  const resolve = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/models/resolve?provider=modelhub&model=deepseek-flash',
  }));
  assert.equal(resolve.statusCode, 200);
  assert.deepEqual(api.calls.at(-1), { op: 'resolveModel', provider: 'modelhub', model: 'deepseek-flash' });

  const add = await invokeHandler(handler, fakeRequest({
    method: 'POST',
    url: '/dsh-immersive/api/wordbook/add',
    body: { word: 'immersive', translation: '沉浸式的', targetLanguage: 'zh-CN' },
  }));
  assert.equal(add.json().item.word, 'immersive');

  for (const [path, method] of [
    ['/wordbook/update', 'POST'],
    ['/wordbook/review', 'POST'],
    ['/wordbook/remove', 'POST'],
    ['/lookup', 'POST'],
    ['/models', 'GET'],
    ['/settings', 'GET'],
    ['/usage', 'GET'],
    ['/usage/events', 'GET'],
    ['/usage/turns', 'GET'],
  ]) {
    const response = await invokeHandler(handler, fakeRequest({
      method,
      url: `${API_BASE}${path}`,
      ...(method === 'POST' ? { body: { id: 'wb_1', text: 'hi', grade: 'good' } } : {}),
    }));
    assert.equal(response.statusCode, 200, `${method} ${path}`);
  }
});

test('dispatches the usage endpoints with query params and DELETE', async () => {
  const api = createStubApi();
  const handler = createHttpHandler(api, {});

  const usage = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/usage?days=7',
  }));
  assert.equal(usage.statusCode, 200);
  assert.deepEqual(usage.json(), {
    ok: true,
    usage: { version: 1, totals: { requests: 3 } },
  });
  assert.deepEqual(api.calls.at(-1), { op: 'getUsage', query: { days: '7' } });

  const events = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/usage/events?limit=5&kind=translate&before=evt_1',
  }));
  assert.equal(events.statusCode, 200);
  assert.deepEqual(events.json(), { ok: true, events: [], nextBefore: null, hasMore: false });
  assert.deepEqual(api.calls.at(-1), {
    op: 'listUsageEvents',
    query: { limit: '5', kind: 'translate', before: 'evt_1' },
  });

  const turns = await invokeHandler(handler, fakeRequest({
    url: '/dsh-immersive/api/usage/turns?limit=5&kind=translate&status=partial&before=tr_1',
  }));
  assert.equal(turns.statusCode, 200);
  assert.deepEqual(turns.json(), { ok: true, turns: [], nextBefore: null, hasMore: false });
  assert.deepEqual(api.calls.at(-1), {
    op: 'getUsageTurns',
    query: { limit: '5', kind: 'translate', status: 'partial', before: 'tr_1' },
  });

  const turnsHead = await invokeHandler(handler, fakeRequest({
    method: 'HEAD',
    url: '/dsh-immersive/api/usage/turns?limit=2',
  }));
  assert.equal(turnsHead.statusCode, 200);
  assert.equal(turnsHead.body, '');
  assert.deepEqual(api.calls.at(-1), {
    op: 'getUsageTurns',
    query: { limit: '2', kind: undefined, status: undefined, before: undefined },
  });

  const cleared = await invokeHandler(handler, fakeRequest({
    method: 'DELETE',
    url: '/dsh-immersive/api/usage',
  }));
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.json(), {
    ok: true,
    cleared: true,
    usage: { version: 1, totals: { requests: 0 } },
  });
  assert.deepEqual(api.calls.at(-1), { op: 'clearUsage' });

  const wrongMethod = await invokeHandler(handler, fakeRequest({
    method: 'POST',
    url: '/dsh-immersive/api/usage',
    body: { days: 1 },
  }));
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, DELETE');

  const eventsDelete = await invokeHandler(handler, fakeRequest({
    method: 'DELETE',
    url: '/dsh-immersive/api/usage/events',
  }));
  assert.equal(eventsDelete.statusCode, 405);
  assert.equal(eventsDelete.headers.allow, 'GET');

  const turnsDelete = await invokeHandler(handler, fakeRequest({
    method: 'DELETE',
    url: '/dsh-immersive/api/usage/turns',
  }));
  assert.equal(turnsDelete.statusCode, 405);
  assert.equal(turnsDelete.headers.allow, 'GET');


  const head = await invokeHandler(handler, fakeRequest({
    method: 'HEAD',
    url: '/dsh-immersive/api/usage',
  }));
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
});

test('DELETE /cache clears the persistent translation cache', async () => {
  const api = createStubApi();
  const handler = createHttpHandler(api, {});

  const cleared = await invokeHandler(handler, fakeRequest({
    method: 'DELETE',
    url: '/dsh-immersive/api/cache',
  }));
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.json(), { ok: true, cleared: true, entries: 0 });
  assert.deepEqual(api.calls.at(-1), { op: 'clearCache' });

  for (const request of [
    { url: '/dsh-immersive/api/cache' },
    { method: 'POST', url: '/dsh-immersive/api/cache', body: {} },
  ]) {
    const response = await invokeHandler(handler, fakeRequest(request));
    assert.equal(response.statusCode, 405);
    assert.equal(response.json().error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(response.headers.allow, 'DELETE');
  }
});

test('DELETE /records dispatches clearRecords', async () => {
  const api = createStubApi();
  const handler = createHttpHandler(api, {});
  const response = await invokeHandler(handler, fakeRequest({
    method: 'DELETE',
    url: '/dsh-immersive/api/records',
    host: '127.0.0.1:3080',
  }));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(api.calls.at(-1), { op: 'clearRecords' });
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.cleared, true);
});

test('DELETE /records rejects GET with 405', async () => {
  const api = createStubApi();
  const handler = createHttpHandler(api, {});
  const response = await invokeHandler(handler, fakeRequest({
    method: 'GET',
    url: '/dsh-immersive/api/records',
    host: '127.0.0.1:3080',
  }));
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, 'DELETE');
});

test('rejects non-JSON and malformed bodies', async () => {
  const handler = createHttpHandler(createStubApi(), {});
  const cases = [
    { headers: { 'content-type': 'text/plain' }, body: 'hello' },
    { headers: { 'content-type': 'application/json' }, body: '{not json' },
    { headers: { 'content-type': 'application/json' }, body: '[1,2,3]' },
    { headers: { 'content-type': 'application/json' }, body: '' },
  ];
  for (const entry of cases) {
    const response = await invokeHandler(handler, fakeRequest({
      method: 'POST',
      url: '/dsh-immersive/api/translate',
      headers: entry.headers,
      body: entry.body,
    }));
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'BAD_REQUEST');
  }
});

test('enforces the 1 MiB body cap from Content-Length', async () => {
  const handler = createHttpHandler(createStubApi(), {});
  const response = await invokeHandler(handler, fakeRequest({
    method: 'POST',
    url: '/dsh-immersive/api/translate',
    headers: { 'content-length': String(2 * 1024 * 1024) },
    body: { texts: ['x'] },
  }));
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'TEXT_LIMIT');
});

test('maps ApiErrors and converts unexpected exceptions to INTERNAL', async () => {
  const api = createStubApi({
    translate: async () => {
      throw apiError('MODEL_RATE_LIMITED', 'slow down');
    },
  });
  const handler = createHttpHandler(api, {});
  const mapped = await invokeHandler(handler, fakeRequest({
    method: 'POST',
    url: '/dsh-immersive/api/translate',
    body: { texts: ['x'] },
  }));
  assert.equal(mapped.statusCode, 429);
  assert.deepEqual(mapped.json().error, { code: 'MODEL_RATE_LIMITED', message: 'slow down' });

  const broken = createHttpHandler(createStubApi({ getSettings: async () => {
    throw new Error('secret internal detail');
  } }), {});
  const internal = await invokeHandler(broken, fakeRequest({ url: '/dsh-immersive/api/settings' }));
  assert.equal(internal.statusCode, 500);
  assert.deepEqual(internal.json().error, { code: 'INTERNAL', message: 'internal server error' });
});

test('readJsonBody accepts charset parameters and rejects non-objects', async () => {
  const ok = await readJsonBody(fakeRequest({
    method: 'POST',
    body: '{"a":1}',
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
  assert.deepEqual(ok, { a: 1 });
  await assert.rejects(readJsonBody(fakeRequest({
    method: 'POST',
    body: '"just a string"',
    headers: { 'content-type': 'application/json' },
  })), (error) => error.code === 'BAD_REQUEST');
});

test('sendJson ignores responses that already ended', () => {
  const response = { writableEnded: true, writeHead() { throw new Error('must not be called'); } };
  sendJson(response, 200, { ok: true });
});

test('evaluateOrigin is re-exported for direct fence tests', () => {
  assert.equal(evaluateOrigin({ headers: { host: HOST } }).ok, true);
});
