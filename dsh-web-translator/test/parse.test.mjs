/** Translation JSON extraction, fenced output and single-segment fallback (DESIGN §4.3). */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseTranslations,
  plainTextTranslation,
  stripCodeFences,
} from '../lib/parse.js';

test('parses the canonical JSON object', () => {
  const result = parseTranslations('{"translations":["你好","世界"]}', { expectedCount: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.translations, ['你好', '世界']);
  assert.equal(result.source, 'json');
});

test('parses a bare JSON array', () => {
  const result = parseTranslations('["你好","世界"]', { expectedCount: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.translations, ['你好', '世界']);
  assert.equal(result.source, 'array');
});

test('strips markdown fences and surrounding prose', () => {
  const fenced = 'Here you go:\n```json\n{"translations":["a","b"]}\n```\nDone.';
  assert.equal(stripCodeFences(fenced), '{"translations":["a","b"]}');
  const result = parseTranslations(fenced, { expectedCount: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.translations, ['a', 'b']);

  const prose = 'Sure. {"translations":["x"]} trailing words';
  assert.deepEqual(parseTranslations(prose, { expectedCount: 1 }).translations, ['x']);
});

test('rejects length mismatches', () => {
  const result = parseTranslations('{"translations":["only"]}', { expectedCount: 2 });
  assert.equal(result.ok, false);
});

test('rejects non-string entries and unrelated JSON', () => {
  assert.equal(parseTranslations('{"translations":[1,2]}', { expectedCount: 2 }).ok, false);
  assert.equal(parseTranslations('{"foo":"bar"}', { expectedCount: 1 }).ok, false);
  assert.equal(parseTranslations('not json at all', { expectedCount: 2 }).ok, false);
  assert.equal(parseTranslations('', { expectedCount: 1 }).ok, false);
});

test('single-segment batches may fall back to plain text', () => {
  const plain = parseTranslations('沉浸式的', { expectedCount: 1 });
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.translations, ['沉浸式的']);
  assert.equal(plain.source, 'plain');

  const quoted = parseTranslations('"沉浸式的"', { expectedCount: 1 });
  assert.equal(quoted.ok, true);
  assert.deepEqual(quoted.translations, ['沉浸式的']);

  const fenced = parseTranslations('```\n沉浸式的\n```', { expectedCount: 1 });
  assert.equal(fenced.ok, true);
  assert.deepEqual(fenced.translations, ['沉浸式的']);
});

test('single-segment fallback accepts a translation key but never JSON garbage', () => {
  const objectForm = parseTranslations('{"translation":"沉浸式的"}', { expectedCount: 1 });
  assert.equal(objectForm.ok, true);
  assert.deepEqual(objectForm.translations, ['沉浸式的']);
  assert.equal(parseTranslations('{"translations":', { expectedCount: 1 }).ok, false);
});

test('plainTextTranslation strips quotes/fences and rejects JSON-looking text', () => {
  assert.equal(plainTextTranslation('  "hello"  '), 'hello');
  assert.equal(plainTextTranslation("'hello'"), 'hello');
  assert.equal(plainTextTranslation('```\nhello\n```'), 'hello');
  assert.equal(plainTextTranslation('{"translations":[]}'), null);
  assert.equal(plainTextTranslation('[1,2]'), null);
  assert.equal(plainTextTranslation('   '), null);
});

test('multi-segment batches never use the plain fallback', () => {
  const result = parseTranslations('just some prose', { expectedCount: 2 });
  assert.equal(result.ok, false);
});
