/** Unknown-term suggestion validation, known/conventional filtering and marker insertion. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TERM_SUGGESTION_LIMITS,
  isConventionalTerm,
  isKnownTerm,
  markUnknownTerms,
  normalizeTermSuggestions,
  parseSuggestionCache,
  serializeSuggestionCache,
} from '../lib/term-suggest.js';
import { compileTermPattern } from '../lib/terms.js';

const knownEntries = [
  { source: 'port / ports', pattern: compileTermPattern('port'), target: '端口', policy: 'translate' },
  { source: 'behavior tree', pattern: compileTermPattern('behavior tree'), target: '行为树', policy: 'translate' },
];

test('isKnownTerm matches patterns and overlapping library labels', () => {
  assert.equal(isKnownTerm('port', knownEntries), true);
  assert.equal(isKnownTerm('ports', knownEntries), true);
  assert.equal(isKnownTerm('behavior tree', knownEntries), true);
  assert.equal(isKnownTerm('tree', knownEntries), true, 'sub-phrases of a known term are covered');
  assert.equal(isKnownTerm('port number', knownEntries), false, 'a new compound is not hidden by a known prefix');
  assert.equal(isKnownTerm('context engineering', knownEntries), false);
  assert.equal(isKnownTerm('', knownEntries), false);
});

test('isConventionalTerm skips terms with an established Chinese rendering', () => {
  assert.equal(isConventionalTerm('server', 'zh-CN'), true);
  assert.equal(isConventionalTerm('Deadlock', 'zh'), true);
  assert.equal(isConventionalTerm('feature flags', 'zh-CN'), true, 'plural forms are recognized');
  assert.equal(isConventionalTerm('APIs', 'zh-CN'), true);
  assert.equal(isConventionalTerm('context engineering', 'zh-CN'), false);
  assert.equal(isConventionalTerm('vibe coding', 'zh-CN'), false);
  assert.equal(isConventionalTerm('deadlock', 'ja-JP'), false, 'the list is Chinese-target only');
});

test('normalizeTermSuggestions validates, dedupes, caps and filters known/conventional terms', () => {
  const sources = ['A context engineering workflow runs on the server and port', 'The vibe coding tool'];
  const translations = ['上下文工程流程在服务器和端口上运行', '氛围编程工具'];
  const raw = [
    { segment: 0, source: 'context engineering', target: '上下文工程' },
    { segment: 0, source: 'Context Engineering', target: '上下文工程' }, // duplicate
    { segment: 0, source: 'server', target: '服务器' }, // conventional
    { segment: 0, source: 'port', target: '端口' }, // known
    { segment: 1, source: 'vibe coding', target: '氛围编程' },
    { segment: 1, source: 'Vibe Coding', target: '氛围编程' }, // duplicate
    { segment: 9, source: 'retry', target: '重试' }, // bad segment
    { segment: 1, source: 'missing', target: '缺失' }, // not in source
    { segment: 1, source: 'vibe coding', target: '不存在' }, // target not in translation
    { segment: 0, source: 'x'.repeat(121), target: 'y' },
    { segment: 0, source: '   ', target: 'y' },
    'bad',
  ];
  const result = normalizeTermSuggestions(raw, {
    segmentCount: 2,
    sources,
    translations,
    knownEntries,
    targetLanguage: 'zh-CN',
  });
  assert.deepEqual(result, [
    { segment: 0, source: 'context engineering', target: '上下文工程' },
    { segment: 1, source: 'vibe coding', target: '氛围编程' },
  ]);
  assert.equal(TERM_SUGGESTION_LIMITS.items, 6);
  assert.equal(TERM_SUGGESTION_LIMITS.perSegment, 2);
});

test('normalizeTermSuggestions enforces the per-segment cap', () => {
  const sources = ['alpha beta gamma delta epsilon zeta eta theta'];
  const translations = ['甲 乙 丙 丁 戊 己 庚 辛'];
  const raw = [
    ['alpha', '甲'], ['beta', '乙'], ['gamma', '丙'], ['delta', '丁'], ['epsilon', '戊'], ['zeta', '己'],
  ].map(([source, target], index) => ({ segment: 0, source, target, index }));
  const result = normalizeTermSuggestions(raw, {
    segmentCount: 1,
    sources,
    translations,
    knownEntries: [],
    targetLanguage: 'zh-CN',
  });
  assert.equal(result.length, TERM_SUGGESTION_LIMITS.perSegment);
});

test('markUnknownTerms wraps target occurrences and falls back to the source form', () => {
  const suggestions = [
    { segment: 0, source: 'context engineering', target: '上下文工程' },
    { segment: 1, source: 'vibe coding', target: '氛围编程' },
  ];
  const sources = ['A context engineering workflow', 'The vibe coding tool is on', 'Another context engineering pass'];
  const translations = ['上下文工程流程', 'The vibe coding tool is on', '另一个上下文工程'];
  const marked = markUnknownTerms(suggestions, { sources, translations });
  assert.equal(marked.translations[0], '[[TE1]]上下文工程[[/TE1]]流程');
  assert.equal(marked.translations[1], 'The [[TE3]]vibe coding[[/TE3]] tool is on');
  assert.equal(marked.translations[2], '另一个[[TE2]]上下文工程[[/TE2]]', 'the same source is marked in other segments');
  assert.deepEqual(
    marked.annotations.map((item) => ({ id: item.id, key: item.key, form: item.form, segment: item.segment })),
    [
      { id: 1, key: 'unknown:context engineering', form: 'target', segment: 0 },
      { id: 2, key: 'unknown:context engineering', form: 'target', segment: 2 },
      { id: 3, key: 'unknown:vibe coding', form: 'source', segment: 1 },
    ],
  );

  const linked = markUnknownTerms(suggestions, {
    sources: ['A context engineering workflow'],
    translations: ['[[1]]上下文工程[[/1]]流程'],
  });
  assert.deepEqual(linked.annotations, [], 'terms inside link/code markers are skipped');
  assert.equal(linked.translations[0], '[[1]]上下文工程[[/1]]流程');
});

test('suggestion cache serialization round-trips and rejects junk', () => {
  const suggestions = [{ segment: 0, source: 'context engineering', target: '上下文工程' }];
  const cached = serializeSuggestionCache(suggestions);
  assert.deepEqual(parseSuggestionCache(cached), suggestions);
  assert.deepEqual(parseSuggestionCache(undefined), []);
  assert.deepEqual(parseSuggestionCache([]), []);
  assert.deepEqual(parseSuggestionCache(['not json']), []);
  assert.deepEqual(parseSuggestionCache(['{}']), []);
});
