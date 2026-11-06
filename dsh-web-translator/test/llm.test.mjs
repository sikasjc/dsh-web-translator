/** Model stream collection, timeout/abort handling and error mapping (DESIGN §4). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeLlm, streamFromChunks } from './helpers.mjs';
import {
  BATCH_TIMEOUT_MS,
  callModel,
  collectStream,
  estimateMaxTokens,
  failureToApiError,
  mapErrorToApiError,
  mapFailureCode,
  mapFinishReason,
  resolveReasoningEffort,
  userMessage,
} from '../lib/llm.js';

/** One stop-finish stream factory. */
function okStream(text, usage) {
  return () => streamFromChunks([
    ...(usage ? [{ type: 'usage', usage }] : []),
    ...(text ? [{ type: 'text-delta', index: 0, text }] : []),
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
}

/** One error-finish stream factory. */
function errorStream(failure) {
  return () => streamFromChunks([{ type: 'finish', reason: { kind: 'error', failure } }]);
}

/** Run callModel and return the thrown ApiError. */
async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the model call to fail');
}

test('collectStream concatenates text, keeps usage and the finish reason', async () => {
  const stream = streamFromChunks([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Hel' },
    { type: 'reasoning-delta', index: 1, text: 'ignored' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 1, totalTokens: 50 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const result = await collectStream(stream);
  assert.equal(result.text, 'Hello');
  assert.deepEqual(result.usage, {
    inputTokens: 5,
    outputTokens: 3,
    cacheReadTokens: 7,
    cacheWriteTokens: 1,
  });
  assert.equal(result.reason.kind, 'stop');
});

test('collectStream keeps all four usage buckets at zero when absent or invalid', async () => {
  const stream = streamFromChunks([
    { type: 'usage', usage: { inputTokens: -3, outputTokens: 'nope' } },
    { type: 'text-delta', index: 0, text: 'ok' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const result = await collectStream(stream);
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test('callModel returns text and usage on a clean stop', async () => {
  const llm = createFakeLlm({ streams: [okStream('hi', { inputTokens: 3, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 6 })] });
  const result = await callModel({ llm, options: { provider: 'modelhub', model: 'deepseek-flash' } });
  assert.equal(result.text, 'hi');
  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: 6,
  });
  assert.ok(llm.state.streamCalls[0].signal instanceof AbortSignal);
});

test('maps finish failures to DESIGN §5.9 codes', async (t) => {
  const cases = [
    [{ code: 'NO_ADAPTER', message: 'no adapter' }, 'MODEL_UNAVAILABLE', 502],
    [{ code: 'MISSING_CREDENTIAL', message: 'no key' }, 'MODEL_AUTH', 502],
    [{ code: 'AUTH', message: 'bad key' }, 'MODEL_AUTH', 502],
    [{ code: 'INVALID_CREDENTIAL', message: 'bad key' }, 'MODEL_AUTH', 502],
    [{ code: 'RATE_LIMIT', message: 'slow down', status: 429 }, 'MODEL_RATE_LIMITED', 429],
    [{ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' }, 'TEXT_LIMIT', 413],
    [{ code: 'SOMETHING_ELSE', message: 'weird' }, 'MODEL_FAILED', 502],
  ];
  for (const [failure, code, status] of cases) {
    await t.test(`${failure.code} -> ${code}`, async () => {
      const llm = createFakeLlm({ streams: [errorStream(failure)] });
      const error = await captureError(callModel({ llm, options: { provider: 'p', model: 'm' } }));
      assert.equal(error.code, code);
      assert.equal(error.status, status);
    });
  }
});

test('max-tokens maps to OUTPUT_TRUNCATED and tool-calls to MODEL_FAILED', async () => {
  const truncated = createFakeLlm({
    streams: [() => streamFromChunks([{ type: 'text-delta', index: 0, text: 'par' }, { type: 'finish', reason: { kind: 'max-tokens' } }])],
  });
  const truncatedError = await captureError(callModel({ llm: truncated, options: { provider: 'p', model: 'm' } }));
  assert.equal(truncatedError.code, 'OUTPUT_TRUNCATED');

  const toolCalls = createFakeLlm({ streams: [() => streamFromChunks([{ type: 'finish', reason: { kind: 'tool-calls' } }])] });
  const toolError = await captureError(callModel({ llm: toolCalls, options: { provider: 'p', model: 'm' } }));
  assert.equal(toolError.code, 'MODEL_FAILED');
});

test('aborted finish maps through its failure payload', async () => {
  const llm = createFakeLlm({ streams: [() => streamFromChunks([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'RATE_LIMIT', message: 'aborted by retry policy' } } }])] });
  const error = await captureError(callModel({ llm, options: { provider: 'p', model: 'm' } }));
  assert.equal(error.code, 'MODEL_RATE_LIMITED');
});

test('a thrown adapter error is mapped, not leaked', async () => {
  const throwing = createFakeLlm({
    streams: [() => {
      throw Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' });
    }],
  });
  const error = await captureError(callModel({ llm: throwing, options: { provider: 'p', model: 'm' } }));
  assert.equal(error.code, 'MODEL_UNAVAILABLE');
  assert.match(error.message, /no adapter/);

  const generic = createFakeLlm({
    streams: [() => {
      throw new Error('connection reset');
    }],
  });
  const genericError = await captureError(callModel({ llm: generic, options: { provider: 'p', model: 'm' } }));
  assert.equal(genericError.code, 'MODEL_FAILED');
});

test('a stream without a finish event fails cleanly', async () => {
  const llm = createFakeLlm({ streams: [() => streamFromChunks([{ type: 'text-delta', index: 0, text: 'partial' }])] });
  const error = await captureError(callModel({ llm, options: { provider: 'p', model: 'm' } }));
  assert.equal(error.code, 'MODEL_FAILED');
});

test('a missing LLM service yields MODEL_UNAVAILABLE', async () => {
  const error = await captureError(callModel({ llm: undefined, options: {} }));
  assert.equal(error.code, 'MODEL_UNAVAILABLE');
});

test('times out a hanging model call with MODEL_TIMEOUT', async () => {
  const hanging = (options) => (async function* hangingStream() {
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    });
  })();
  const llm = createFakeLlm({ streams: [hanging] });
  const started = Date.now();
  const error = await captureError(callModel({ llm, options: { provider: 'p', model: 'm' }, timeoutMs: 25 }));
  assert.equal(error.code, 'MODEL_TIMEOUT');
  assert.equal(error.status, 504);
  assert.ok(Date.now() - started < 2000);
});

test('a caller abort yields MODEL_TIMEOUT and an already-aborted signal fails fast', async () => {
  const hanging = (options) => (async function* hangingStream() {
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    });
  })();
  const llm = createFakeLlm({ streams: [hanging] });
  const controller = new AbortController();
  const pending = callModel({ llm, options: { provider: 'p', model: 'm' }, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const error = await captureError(pending);
  assert.equal(error.code, 'MODEL_TIMEOUT');

  const preAborted = new AbortController();
  preAborted.abort();
  const fast = await captureError(callModel({ llm, options: { provider: 'p', model: 'm' }, signal: preAborted.signal }));
  assert.equal(fast.code, 'MODEL_TIMEOUT');
});

test('default batch timeout matches DESIGN §4 (90 s)', () => {
  assert.equal(BATCH_TIMEOUT_MS, 90_000);
});

test('mapFailureCode handles unknown codes and HTTP statuses', () => {
  assert.equal(mapFailureCode('missing_credential'), 'MODEL_AUTH');
  assert.equal(mapFailureCode('AUTHENTICATION_FAILED'), 'MODEL_AUTH');
  assert.equal(mapFailureCode('MODEL_RATE_LIMITED'), 'MODEL_RATE_LIMITED');
  assert.equal(mapFailureCode('MODEL_NOT_FOUND'), 'MODEL_UNAVAILABLE');
  assert.equal(mapFailureCode('ETIMEDOUT'), 'MODEL_TIMEOUT');
  assert.equal(mapFailureCode('REQUEST_ABORTED'), 'MODEL_TIMEOUT');
  assert.equal(mapFailureCode(undefined, 401), 'MODEL_AUTH');
  assert.equal(mapFailureCode(undefined, 403), 'MODEL_AUTH');
  assert.equal(mapFailureCode(undefined, 404), 'MODEL_UNAVAILABLE');
  assert.equal(mapFailureCode(undefined, 408), 'MODEL_TIMEOUT');
  assert.equal(mapFailureCode(undefined, 413), 'TEXT_LIMIT');
  assert.equal(mapFailureCode(undefined, 429), 'MODEL_RATE_LIMITED');
  assert.equal(mapFailureCode(undefined, 504), 'MODEL_TIMEOUT');
  assert.equal(mapFailureCode(undefined, 500), 'MODEL_FAILED');
  assert.equal(mapFailureCode(undefined, undefined), 'MODEL_FAILED');
});

test('failureToApiError keeps a short message and defaults it', () => {
  const error = failureToApiError({ code: 'RATE_LIMIT', message: 'x'.repeat(500) });
  assert.equal(error.code, 'MODEL_RATE_LIMITED');
  assert.equal(error.message.length, 300);
  assert.match(failureToApiError({ code: 'NO_ADAPTER' }).message, /unavailable/);
});

test('mapFinishReason returns null only for stop', () => {
  assert.equal(mapFinishReason({ kind: 'stop' }), null);
  assert.equal(mapFinishReason({ kind: 'max-tokens' }).code, 'OUTPUT_TRUNCATED');
  assert.equal(mapFinishReason({ kind: 'weird' }).code, 'MODEL_FAILED');
});

test('mapErrorToApiError preserves ApiErrors and sanitizes details', () => {
  const apiError = mapFinishReason({ kind: 'max-tokens' });
  assert.equal(mapErrorToApiError(apiError), apiError);
  const mapped = mapErrorToApiError(Object.assign(new Error('boom'), { code: 'RATE_LIMIT' }));
  assert.equal(mapped.code, 'MODEL_RATE_LIMITED');
});

test('estimateMaxTokens follows the DESIGN formula and clamp', () => {
  assert.equal(estimateMaxTokens(0), 512);
  assert.equal(estimateMaxTokens(100), 512);
  assert.equal(estimateMaxTokens(1000), 1500);
  assert.equal(estimateMaxTokens(10_000), 8192);
  assert.equal(estimateMaxTokens(1000, 400), 400);
  assert.equal(estimateMaxTokens(1000, 393_216), 1500);
  assert.equal(estimateMaxTokens(1000, undefined), 1500);
});

test('resolveReasoningEffort implements auto/explicit rules', () => {
  assert.deepEqual(resolveReasoningEffort('auto', [{ id: 'off' }, { id: 'max' }]), { effort: 'off', source: 'auto' });
  assert.deepEqual(resolveReasoningEffort('auto', [{ id: 'low' }, { id: 'high' }]), { effort: 'low', source: 'auto' });
  assert.deepEqual(resolveReasoningEffort('auto', ['off', 'max']), { effort: 'off', source: 'auto' });
  assert.deepEqual(resolveReasoningEffort('auto', []), { effort: undefined, source: 'auto' });
  assert.deepEqual(resolveReasoningEffort('max', [{ id: 'off' }, { id: 'max' }]), { effort: 'max', source: 'explicit' });
  assert.deepEqual(resolveReasoningEffort('max', [{ id: 'off' }]), { effort: undefined, source: 'unavailable' });
  assert.deepEqual(resolveReasoningEffort(undefined, [{ id: 'off' }]), { effort: 'off', source: 'auto' });
});

test('userMessage builds one text content block', () => {
  assert.deepEqual(userMessage('hello'), { role: 'user', content: [{ type: 'text', text: 'hello' }] });
});
