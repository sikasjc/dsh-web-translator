/** Image payload validation, prompt, block parsing, cache keys and cleanup. */
import assert from 'node:assert/strict';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { LIMITS } from '../lib/constants.js';
import {
  IMAGE_MEDIA_TYPES,
  buildImagePrompt,
  cleanupImageAttachment,
  imageCacheKey,
  imageHash,
  normalizeImagePayload,
  parseImageTranslation,
} from '../lib/image.js';
import { createFakeLogger, createTempDir, removeTempDir } from './helpers.mjs';

/** Known 1x1 transparent PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('normalizeImagePayload accepts canonical base64 and data URLs', () => {
  assert.deepEqual(IMAGE_MEDIA_TYPES, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const png = normalizeImagePayload({ mediaType: 'image/png', data: PNG_BASE64 });
  assert.equal(png.mediaType, 'image/png');
  assert.equal(png.bytes.byteLength, Buffer.from(PNG_BASE64, 'base64').byteLength);
  const dataUrl = normalizeImagePayload({ mediaType: 'image/png', data: `data:image/png;base64,${PNG_BASE64}` });
  assert.equal(dataUrl.base64, PNG_BASE64);
  assert.equal(imageHash(png.bytes), imageHash(dataUrl.bytes));
});

test('normalizeImagePayload rejects bad payloads with image error codes', () => {
  const cases = [
    [{ data: PNG_BASE64 }, 'IMAGE_UNSUPPORTED'],
    [{ mediaType: 'image/svg+xml', data: PNG_BASE64 }, 'IMAGE_UNSUPPORTED'],
    [{ mediaType: 'image/png', data: '' }, 'IMAGE_INVALID'],
    [{ mediaType: 'image/png', data: 'not base64!' }, 'IMAGE_INVALID'],
    [{ mediaType: 'image/png', data: 'data:image/jpeg;base64,' + PNG_BASE64 }, 'IMAGE_INVALID'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => normalizeImagePayload(input), (error) => error.code === code);
  }
  const huge = Buffer.alloc(LIMITS.imageBytes + 1).toString('base64');
  assert.throws(() => normalizeImagePayload({ mediaType: 'image/png', data: huge }), (error) => error.code === 'IMAGE_TOO_LARGE');
});

test('buildImagePrompt describes the strict JSON block/bbox contract', () => {
  const prompt = buildImagePrompt({ targetLanguage: 'ja', sourceTitle: 'Docs', site: 'example.com', translationStyle: 'tech' });
  assert.match(prompt.system, /OCR and translation/);
  assert.match(prompt.system, /"blocks"/);
  assert.match(prompt.system, /bbox/);
  assert.match(prompt.system, /ja/);
  assert.match(prompt.user, /ja/);
  assert.match(prompt.user, /Docs/);
  assert.match(prompt.user, /example\.com/);
});

test('buildImagePrompt compact mode omits the original-text schema', () => {
  const prompt = buildImagePrompt({ targetLanguage: 'zh-CN', compact: true });
  assert.match(prompt.system, /Do NOT include the original OCR text/);
  assert.match(prompt.system, /Do not merge separate UI elements/);
  assert.match(prompt.system, /"translation"/);
  assert.doesNotMatch(prompt.system, /"text":"original text as shown"/);
});

test('parseImageTranslation keeps blocks, clamps bboxes, caps fields and drops junk', () => {
  const answer = JSON.stringify({
    blocks: [
      { text: '  Hello  ', translation: ' 你好 ', bbox: [-0.1, 0.1, 0.5, 0.2] },
      { text: 'Code', translation: 'const x = 1', bbox: [0.5, 0.5, 0.5, 0.6] },
      { text: '', translation: 'only translation' },
      { text: 'Dropped', translation: '   ' },
      'junk',
    ],
  });
  const parsed = parseImageTranslation(answer);
  assert.equal(parsed.fallback, false);
  assert.equal(parsed.blocks.length, 3);
  assert.deepEqual(parsed.blocks[0], { text: 'Hello', translation: '你好', bbox: [0, 0.1, 0.5, 0.2] });
  assert.equal(parsed.blocks[1].text, 'Code');
  assert.equal(parsed.blocks[1].bbox, undefined);
  assert.deepEqual(parsed.blocks[2], { text: '', translation: 'only translation' });
});

test('parseImageTranslation accepts fenced/array answers and falls back to plain text', () => {
  const fenced = '```json\n{"blocks":[{"text":"A","translation":"甲","bbox":[0.1,0.1,0.4,0.2]}]}\n```';
  assert.equal(parseImageTranslation(fenced).blocks[0].translation, '甲');
  const array = '[{"text":"B","translation":"乙"}]';
  assert.equal(parseImageTranslation(array).blocks[0].translation, '乙');
  const plain = parseImageTranslation('  just a translation  ');
  assert.equal(plain.fallback, true);
  assert.deepEqual(plain.blocks, [{ text: '', translation: 'just a translation' }]);
  assert.deepEqual(parseImageTranslation('   '), { blocks: [], fallback: false });
  assert.deepEqual(parseImageTranslation(null), { blocks: [], fallback: false });
});

test('imageCacheKey separates image/model/language/style and prompt version', () => {
  const base = { hash: 'abc', provider: 'modelhub', model: 'deepseek-flash', targetLanguage: 'zh-CN', translationStyle: 'auto' };
  assert.equal(imageCacheKey(base), imageCacheKey({ ...base }));
  for (const key of ['hash', 'provider', 'model', 'targetLanguage', 'translationStyle']) {
    assert.notEqual(imageCacheKey(base), imageCacheKey({ ...base, [key]: 'other' }));
  }
  // Compact (translation-only) results have no OCR text and must never be
  // served to a bilingual request.
  assert.notEqual(imageCacheKey(base), imageCacheKey({ ...base, compact: true }));
});

test('cleanupImageAttachment removes the new object and new request variants only', async (t) => {
  const dir = await createTempDir();
  t.after(() => removeTempDir(dir));
  const objectDir = join(dir, 'objects');
  const cacheDir = join(dir, 'request-images');
  await mkdir(objectDir, { recursive: true });
  await mkdir(join(cacheDir, 'deep'), { recursive: true });
  const oldObject = join(objectDir, 'old.png');
  const newObject = join(objectDir, 'new.png');
  const oldVariant = join(cacheDir, 'old.bin');
  const newVariant = join(cacheDir, 'deep', 'new.bin');
  await writeFile(oldObject, 'old');
  await writeFile(oldVariant, 'old');
  const past = new Date(Date.now() - 60_000);
  await utimes(oldObject, past, past);
  await utimes(oldVariant, past, past);
  const startedAt = Date.now();
  await writeFile(newObject, 'new');
  await writeFile(newVariant, 'new');
  const logger = createFakeLogger();
  const result = await cleanupImageAttachment({
    attachments: { imageHostPath: () => newObject },
    ref: { attachmentId: 'a' },
    cacheDir,
    startedAt,
    logger,
  });
  assert.deepEqual(result, { removedObject: true, removedVariants: 1 });
  assert.equal(await readFile(oldObject, 'utf8'), 'old');
  assert.equal(await readFile(oldVariant, 'utf8'), 'old');
  await assert.rejects(readFile(newObject, 'utf8'));
  await assert.rejects(readFile(newVariant, 'utf8'));

  const missing = await cleanupImageAttachment({ attachments: {}, ref: {}, cacheDir: join(dir, 'nope'), startedAt: Date.now() });
  assert.deepEqual(missing, { removedObject: false, removedVariants: 0 });
});
