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
  looksLikeTechnicalContent,
  renderPageContext,
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

test('link markers add a conditional preservation note to the system prompt', () => {
  const plain = renderTranslatePrompts({ texts: ['hello'], targetLanguage: 'zh-CN' });
  assert.equal(plain.system.includes('[[1]]'), false);
  const linked = renderTranslatePrompts({
    texts: ['Read [[1]]the documentation[[/1]] for details.'],
    targetLanguage: 'zh-CN',
  });
  assert.match(linked.system, /\[\[1\]\]\.\.\.\[\[\/1\]\]/);
  assert.match(linked.system, /preserve each marker pair/);
  assert.equal(linked.user.includes('[[1]]'), true);
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

test('page context is prepended for technical pages and not for generic pages', () => {
  const technical = renderTranslatePrompts({
    texts: ['Rust traits define shared behavior; the port is configurable.'],
    targetLanguage: 'zh-CN',
    pageContext: {
      title: 'Traits: Defining Shared Behavior - The Rust Programming Language',
      url: 'https://doc.rust-lang.org/book/ch10-02-traits.html',
      technical: true,
    },
  });
  assert.ok(technical.system.includes('Page context'));
  assert.ok(technical.system.includes('doc.rust-lang.org'));
  assert.ok(technical.system.includes('trait'));
  assert.ok(technical.system.includes('端口'));
  assert.ok(technical.system.indexOf('Page context') < technical.system.indexOf('You are a professional translator'));

  const generic = renderTranslatePrompts({
    texts: ['The port of Rotterdam is busy.'],
    targetLanguage: 'zh-CN',
    pageContext: { title: 'Rotterdam news', url: 'https://news.example.com/port', technical: false },
  });
  assert.ok(generic.system.includes('Rotterdam news'));
  assert.equal(generic.system.includes('software/programming'), false);
  assert.equal(generic.system.includes('端口'), false);
});

test('explicit translation styles inject domain rules instead of auto detection', () => {
  const programming = renderTranslatePrompts({
    texts: ['A plain sentence'],
    targetLanguage: 'zh-CN',
    pageContext: { title: 'A generic page', url: 'https://example.com/a', style: 'programming', technical: true },
  });
  assert.ok(programming.system.includes('trait'));
  assert.ok(programming.system.includes('programming documentation'));

  const finance = renderTranslatePrompts({
    texts: ['Yield and liquidity'],
    targetLanguage: 'zh-CN',
    pageContext: { title: 'Markets', url: 'https://example.com/markets', style: 'finance' },
  });
  assert.ok(finance.system.includes('finance/markets'));
  assert.ok(finance.system.includes('收益率'));
  assert.ok(finance.system.includes('回撤'));
  assert.equal(finance.system.includes('DSH_KEEP'), false);

  const tech = renderTranslatePrompts({
    texts: ['The API returns a port.'],
    targetLanguage: 'zh-CN',
    pageContext: { title: 'Tech', url: 'https://example.com/tech', style: 'tech' },
  });
  assert.ok(tech.system.includes('technology/engineering'));
  assert.ok(tech.system.includes('product names'));

  const general = renderTranslatePrompts({
    texts: ['Rust traits and ports'],
    targetLanguage: 'zh-CN',
    pageContext: { title: 'Rust', url: 'https://doc.rust-lang.org', style: 'general', technical: true },
  });
  assert.equal(general.system.includes('DSH_KEEP'), false);
  assert.equal(general.system.includes('编程'), false);
});

test('looksLikeTechnicalContent detects docs hosts and repeated technical terms', () => {
  assert.equal(looksLikeTechnicalContent({ url: 'https://doc.rust-lang.org/book/ch10-02-traits.html' }), true);
  assert.equal(looksLikeTechnicalContent({ title: 'Rust traits', texts: ['trait and struct'] }), true);
  assert.equal(looksLikeTechnicalContent({ title: 'Port of Rotterdam news', texts: ['The port is busy today.'] }), false);
  assert.equal(renderPageContext({ title: 'x' }), 'Page context (do not translate this metadata; use it only to disambiguate terminology):\n- Page title: x');
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
