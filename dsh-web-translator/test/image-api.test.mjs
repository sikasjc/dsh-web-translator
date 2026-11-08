/** `POST /image-translate`: vision model, cache, usage, attachment cleanup. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createApi } from '../lib/api.js';
import { LIMITS } from '../lib/constants.js';
import { createFakeCtx, createFakeLlm, createFakeLogger, createTempDir, removeTempDir, textStream } from './helpers.mjs';

/** Known 1x1 transparent PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Fake DSH attachment service that records saves and can expose a host path. */
function createFakeAttachments({ hostPath, fail } = {}) {
  const state = { saveCalls: [], refs: [] };
  return {
    state,
    async saveImage(input) {
      state.saveCalls.push({ mediaType: input.mediaType, bytes: input.data.byteLength, name: input.name });
      if (fail !== undefined) throw fail;
      const ref = {
        attachmentId: 'attachment-' + state.refs.length,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 10,
        height: 10,
      };
      state.refs.push(ref);
      return ref;
    },
    imageHostPath() {
      return hostPath;
    },
  };
}

/** Fake model info: image-capable by default. */
function imageModelInfo(provider, model, { vision = true } = {}) {
  return {
    provider,
    id: model,
    name: model,
    inputModalities: vision ? ['text', 'image'] : ['text'],
    context: { contextWindow: 1048576 },
    defaultMaxTokens: 393216,
    reasoning: { efforts: [{ id: 'off', name: 'off' }, { id: 'max', name: 'max' }], defaultEffort: 'off' },
  };
}

/** Build an API over a temp dir with an image-capable model and fake attachments. */
async function setupImageApi(t, { streams = [], attachments = createFakeAttachments(), llmOptions = {}, selection, imageCacheDir } = {}) {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const llm = createFakeLlm({
    modelInfo: (provider, model) => imageModelInfo(provider, model),
    ...llmOptions,
  });
  for (const factory of streams) llm.pushStream(factory);
  const ctx = createFakeCtx({ llm, logger, selection });
  const cacheDir = imageCacheDir ?? join(dir, 'request-images');
  const api = createApi({ ctx, logger, dataDir: dir, attachments, imageCacheDir: cacheDir });
  return { api, llm, attachments, logger, dir, cacheDir };
}

function imageBody(extra = {}) {
  return {
    image: { mediaType: 'image/png', data: PNG_BASE64 },
    targetLanguage: 'zh-CN',
    sourceUrl: 'https://example.com/post',
    sourceTitle: 'Example',
    client: 'extension',
    turnId: 'img_test_1',
    stepIndex: 0,
    mode: 'image',
    ...extra,
  };
}

test('imageTranslate sends an image block to the vision model and records usage/cache', async (t) => {
  const blocks = [{ text: 'Hello', translation: '你好', bbox: [0.1, 0.1, 0.4, 0.2] }];
  const attachments = createFakeAttachments();
  const { api, llm } = await setupImageApi(t, {
    attachments,
    streams: [() => textStream(JSON.stringify({ blocks }), { usage: { inputTokens: 10, outputTokens: 5 } })],
  });
  const first = await api.imageTranslate(imageBody());
  assert.equal(first.result.blocks.length, 1);
  assert.equal(first.result.blocks[0].translation, '你好');
  assert.equal(first.result.cached, false);
  assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(llm.state.streamCalls.length, 1);
  const options = llm.state.streamCalls[0];
  assert.equal(options.provider, 'modelhub');
  assert.equal(options.model, 'deepseek-flash');
  assert.equal(options.messages[0].content.length, 2);
  assert.equal(options.messages[0].content[1].type, 'image');
  assert.equal(options.messages[0].content[1].attachment.attachmentId, 'attachment-0');
  assert.equal(attachments.state.saveCalls.length, 1);
  assert.equal(attachments.state.saveCalls[0].bytes, Buffer.from(PNG_BASE64, 'base64').byteLength);

  // Same image + model + language hits the result cache: no save, no model call.
  const second = await api.imageTranslate(imageBody({ turnId: 'img_test_2' }));
  assert.equal(second.result.cached, true);
  assert.deepEqual(second.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(llm.state.streamCalls.length, 1);
  assert.equal(attachments.state.saveCalls.length, 1);

  const usage = await api.getUsage({ days: 1 });
  assert.equal(usage.usage.byKind.image.requests, 2);
  assert.equal(usage.usage.byKind.image.cached, 1);
  assert.equal(usage.usage.byKind.translate.requests, 0);
  const events = await api.listUsageEvents({ limit: 10 });
  assert.deepEqual(events.events.map((event) => event.kind), ['image', 'image']);
  assert.equal(events.events[0].provider, 'modelhub');
});

test('imageTranslate deletes the new attachment object and request cache files', async (t) => {
  const objectDir = await createTempDir();
  t.after(() => removeTempDir(objectDir));
  const objectPath = join(objectDir, 'image.jpg');
  await writeFile(objectPath, 'image-bytes');
  const attachments = createFakeAttachments({ hostPath: objectPath });
  const { api, cacheDir } = await setupImageApi(t, {
    attachments,
    streams: [() => textStream(JSON.stringify({ blocks: [{ text: 'A', translation: '甲', bbox: [0.1, 0.1, 0.3, 0.2] }] }))],
  });
  await mkdir(cacheDir, { recursive: true });
  const variantPath = join(cacheDir, 'variant.bin');
  await writeFile(variantPath, 'variant');
  await api.imageTranslate(imageBody());
  await assert.rejects(readFile(objectPath, 'utf8'));
  await assert.rejects(readFile(variantPath, 'utf8'));
});

test('imageTranslate fails with MODEL_NO_VISION when no configured model accepts images', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const llm = createFakeLlm({ modelInfo: (provider, model) => imageModelInfo(provider, model, { vision: false }) });
  const ctx = createFakeCtx({ llm, logger });
  const api = createApi({ ctx, logger, dataDir: dir, attachments: createFakeAttachments() });
  await assert.rejects(api.imageTranslate(imageBody()), (error) => error.code === 'MODEL_NO_VISION');
});

test('imageTranslate validates image payloads and body metadata', async (t) => {
  const { api } = await setupImageApi(t, {
    streams: [() => textStream('{"blocks":[]}')],
  });
  await assert.rejects(
    api.imageTranslate(imageBody({ image: { mediaType: 'image/svg+xml', data: PNG_BASE64 } })),
    (error) => error.code === 'IMAGE_UNSUPPORTED',
  );
  await assert.rejects(
    api.imageTranslate(imageBody({ image: { mediaType: 'image/png', data: 'not base64' } })),
    (error) => error.code === 'IMAGE_INVALID',
  );
  await assert.rejects(
    api.imageTranslate(imageBody({ turnId: 'x'.repeat(LIMITS.turnIdChars + 1) })),
    (error) => error.code === 'BAD_REQUEST',
  );
});

test('imageTranslate falls back to another image-capable catalog model when auto', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const llm = createFakeLlm({
    providers: [{ id: 'p', name: 'p' }],
    models: { p: [{ id: 'text-model', name: 'text-model' }, { id: 'vision-model', name: 'vision-model' }] },
    modelInfo: (provider, model) => imageModelInfo(provider, model, { vision: model === 'vision-model' }),
  });
  llm.pushStream(() => textStream(JSON.stringify({ blocks: [{ text: 'X', translation: 'Y', bbox: [0.1, 0.1, 0.2, 0.2] }] }), { usage: { inputTokens: 1, outputTokens: 1 } }));
  const ctx = createFakeCtx({ llm, logger, selection: { provider: 'p', model: 'text-model' } });
  const api = createApi({ ctx, logger, dataDir: dir, attachments: createFakeAttachments() });
  const result = await api.imageTranslate(imageBody());
  assert.equal(result.result.model, 'vision-model');
});

test('PUT settings validates imageModel and exposes it in GET settings', async (t) => {
  const { api } = await setupImageApi(t, {
    llmOptions: { modelInfo: (provider, model) => imageModelInfo(provider, model) },
  });
  assert.equal((await api.getSettings()).settings.imageModel, 'auto');
  const updated = await api.putSettings({ imageModel: 'modelhub::deepseek-flash' });
  assert.equal(updated.settings.imageModel, 'modelhub::deepseek-flash');
  await assert.rejects(api.putSettings({ imageModel: 'modelhub::missing' }), (error) => error.code === 'INVALID_SETTINGS');
  await assert.rejects(api.putSettings({ imageModel: 'deepseek-flash' }), (error) => error.code === 'INVALID_SETTINGS');
});

test('PUT settings rejects an imageModel that cannot accept images', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const logger = createFakeLogger();
  const llm = createFakeLlm({ modelInfo: (provider, model) => imageModelInfo(provider, model, { vision: false }) });
  const ctx = createFakeCtx({ llm, logger });
  const api = createApi({ ctx, logger, dataDir: dir, attachments: createFakeAttachments() });
  await assert.rejects(
    api.putSettings({ imageModel: 'modelhub::deepseek-flash' }),
    (error) => error.code === 'INVALID_SETTINGS',
  );
});
