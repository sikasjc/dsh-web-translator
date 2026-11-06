/** Prompt rendering, placeholder handling and default fallbacks (DESIGN §4.1). */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORRECTION_MESSAGE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_TEMPLATE,
  LOOKUP_SYSTEM_PROMPT,
  PROMPT_LIMITS,
  effectivePrompts,
  findUnknownPlaceholders,
  renderLookupPrompts,
  renderNumberedSegments,
  renderTemplate,
  renderTranslatePrompts,
} from '../lib/prompts.js';

test('renderTemplate substitutes known placeholders and keeps unknown ones', () => {
  const rendered = renderTemplate('A {{targetLanguage}} B {{unknown}} C', { targetLanguage: 'zh-CN' });
  assert.equal(rendered, 'A zh-CN B {{unknown}} C');
});

test('renderTemplate tolerates whitespace inside braces and non-string values', () => {
  assert.equal(renderTemplate('n={{ segmentCount }}', { segmentCount: 3 }), 'n=3');
  assert.equal(renderTemplate('', { a: 1 }), '');
  assert.equal(renderTemplate(null, { a: 1 }), '');
});

test('findUnknownPlaceholders reports unique unsupported names only', () => {
  assert.deepEqual(findUnknownPlaceholders('{{targetLanguage}} {{foo}} {{foo}} {{bar}}'), ['foo', 'bar']);
  assert.deepEqual(findUnknownPlaceholders('{{segmentsJson}} {{segments}}'), []);
  assert.deepEqual(findUnknownPlaceholders('{{other}}', ['targetLanguage']), ['other']);
});

test('renderNumberedSegments numbers lines in order', () => {
  assert.equal(renderNumberedSegments(['a', 'b']), '1. a\n2. b');
});

test('default translate prompts render target language, count and JSON segments', () => {
  const rendered = renderTranslatePrompts({
    texts: ['hello', 'world'],
    targetLanguage: 'zh-CN',
    sourceLanguage: 'auto',
  });
  assert.equal(rendered.segmentCount, 2);
  assert.equal(rendered.textsJson, '["hello","world"]');
  assert.ok(rendered.system.includes('zh-CN'));
  assert.ok(rendered.system.includes('2 strings in input order'));
  assert.ok(rendered.user.includes('Source language: auto'));
  assert.ok(rendered.user.includes('Target language: zh-CN'));
  assert.ok(rendered.user.includes('["hello","world"]'));
});

test('custom prompts are rendered with the same variables', () => {
  const rendered = renderTranslatePrompts({
    systemPrompt: 'Translate to {{targetLanguage}}; {{segmentCount}} segs; {{segments}}',
    userTemplate: 'JSON={{segmentsJson}}',
    texts: ['x'],
    targetLanguage: 'ja',
    sourceLanguage: 'en',
  });
  assert.equal(rendered.system, 'Translate to ja; 1 segs; 1. x');
  assert.equal(rendered.user, 'JSON=["x"]');
});

test('lookup prompts are plain-text oriented and include context when present', () => {
  const withContext = renderLookupPrompts({ text: 'immersive', context: 'immersive UI', targetLanguage: 'zh-CN' });
  assert.ok(withContext.system.includes('zh-CN'));
  assert.ok(withContext.system.includes('no quotes'));
  assert.ok(withContext.user.includes('Source text: immersive'));
  assert.ok(withContext.user.includes('Context: immersive UI'));
  const withoutContext = renderLookupPrompts({ text: 'immersive', targetLanguage: 'zh-CN' });
  assert.equal(withoutContext.user.includes('Context:'), false);
  assert.equal(LOOKUP_SYSTEM_PROMPT.includes('{{targetLanguage}}'), true);
});

test('effectivePrompts falls back to defaults for missing or blank values', () => {
  assert.deepEqual(effectivePrompts({}), {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: DEFAULT_USER_TEMPLATE,
  });
  assert.deepEqual(effectivePrompts({ systemPrompt: '   ', userTemplate: null }), {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: DEFAULT_USER_TEMPLATE,
  });
  assert.deepEqual(effectivePrompts({ systemPrompt: 'p1', userTemplate: 'p2' }), {
    systemPrompt: 'p1',
    userTemplate: 'p2',
  });
});

test('prompt limits and correction message match the contract', () => {
  assert.deepEqual(PROMPT_LIMITS, { systemPrompt: 8000, userTemplate: 4000 });
  assert.equal(CORRECTION_MESSAGE, 'Return only the required JSON.');
});
