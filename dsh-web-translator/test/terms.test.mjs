/** Technical terminology libraries, protection tokens and deterministic fallbacks. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILTIN_TERM_LIBRARIES,
  TERM_LIBRARY_LIMITS,
  buildTerminologyRules,
  compileTermPattern,
} from '../lib/terms.js';

/** Rules for the default setup: every built-in pack enabled, technical page. */
function builtinRules({ technical = true, custom = [] } = {}) {
  return buildTerminologyRules({ builtin: BUILTIN_TERM_LIBRARIES, custom }, { technical });
}

/** A custom library record shaped like the persisted service record. */
function customLibrary(terms) {
  return { id: 'tl_test', name: '项目术语', terms };
}

test('BUILTIN_TERM_LIBRARIES documents every built-in rule and matches the engine', () => {
  assert.ok(Array.isArray(BUILTIN_TERM_LIBRARIES));
  assert.ok(BUILTIN_TERM_LIBRARIES.length >= 2);
  const ids = BUILTIN_TERM_LIBRARIES.map((library) => library.id);
  assert.equal(new Set(ids).size, ids.length, 'library ids are unique');
  const termIds = [];
  for (const library of BUILTIN_TERM_LIBRARIES) {
    assert.ok(library.name.length > 0);
    assert.ok(library.description.length > 0);
    assert.ok(library.hint && library.hint.compact && library.hint.full);
    for (const term of library.terms) {
      termIds.push(`${library.id}:${term.id}`);
      assert.ok(term.source.length > 0);
      assert.ok(term.policy === 'keep' || term.policy === 'translate');
      if (term.policy === 'translate') assert.ok(term.target.length > 0);
      assert.ok(Array.isArray(term.badRenderings));
    }
  }
  assert.equal(new Set(termIds).size, termIds.length, 'term ids are unique within a library');
  const rules = builtinRules();
  for (const library of BUILTIN_TERM_LIBRARIES) {
    for (const term of library.terms) {
      for (const bad of term.badRenderings) {
        const source = term.policy === 'translate' ? term.source : 'Rust trait';
        const translated = term.policy === 'translate' ? `${bad}类型` : `Rust ${bad}`;
        const fallback = rules.applyFallback(source, translated);
        assert.notEqual(fallback, translated, `${library.id}/${term.id}: ${bad} must be fixed`);
      }
    }
  }
  assert.deepEqual(TERM_LIBRARY_LIMITS, { libraries: 20, termsPerLibrary: 200, nameChars: 40, sourceChars: 120, targetChars: 120 });
});

test('built-in keep terms are protected with deterministic tokens', () => {
  const rules = builtinRules();
  const protectedBatch = rules.protect(['Traits define behavior', 'A trait object']);
  assert.equal(protectedBatch.texts.length, 2);
  assert.equal(protectedBatch.texts[0].includes('Traits'), false);
  assert.equal(protectedBatch.texts[1].includes('trait'), false);
  assert.deepEqual(protectedBatch.tokens.map((entry) => entry.value), ['Traits', 'trait']);
  assert.equal(protectedBatch.tokens[0].token, '[[DSH_KEEP_TRAITS]]');
  assert.equal(rules.protect(['trait']).tokens[0].token, '[[DSH_KEEP_TRAIT]]');

  const restored = rules.restore(`使用 ${protectedBatch.tokens[0].token} 和 a ${protectedBatch.tokens[1].token}`, protectedBatch.tokens);
  assert.equal(restored, '使用 Traits 和 a trait');
  assert.equal(rules.restore('no tokens', []), 'no tokens');
});

test('built-in fallbacks fix the known bad renderings only when the source has the term', () => {
  const rules = builtinRules();
  assert.equal(rules.applyFallback('Rust traits', 'Rust 特征'), 'Rust traits');
  assert.equal(rules.applyFallback('Configure the port', '配置港口'), '配置端口');
  assert.equal(rules.applyFallback('The canonical uninhabited type', '标准的不可居住类型'), '标准的无值类型');
  assert.equal(rules.applyFallback('An uninhabited type has no values', '不可继承的类型没有值'), '无值类型没有值');
  assert.equal(rules.applyFallback('A feature of the city', '港口城市的特点'), '港口城市的特点');
  assert.equal(rules.applyFallback('Something else', '原样返回'), '原样返回');
  // crate/impl are prompt-only keep rules: they never claim a fallback wording.
  const crate = BUILTIN_TERM_LIBRARIES.find((library) => library.id === 'rust').terms.find((term) => term.id === 'crate-impl');
  assert.deepEqual(crate.badRenderings, []);
});

test('built-in packs apply only on technical pages; custom libraries apply everywhere', () => {
  const technical = builtinRules({ technical: true });
  assert.ok(technical.hint(false).includes('trait'));
  assert.ok(technical.hint(false).includes('端口'));
  assert.ok(technical.hint(false).includes('无值类型'));

  const generic = builtinRules({ technical: false });
  assert.equal(generic, null, 'no terminology context when no custom library is enabled');

  const custom = [customLibrary([{ id: 'te_1', source: 'behavior tree', policy: 'translate', target: '行为树' }])];
  const genericWithCustom = builtinRules({ technical: false, custom });
  assert.ok(genericWithCustom !== null);
  const hint = genericWithCustom.hint(false);
  assert.ok(hint.includes('behavior tree'));
  assert.ok(hint.includes('行为树'));
  assert.equal(hint.includes('端口'), false, 'built-in packs stay disabled outside technical pages');
  assert.equal(genericWithCustom.applyFallback('x', 'y'), 'y');
});

test('custom keep and translate entries feed tokens, hints and fallbacks', () => {
  const custom = [customLibrary([
    { id: 'te_1', source: 'behavior tree', policy: 'keep' },
    { id: 'te_2', source: 'feature flag', policy: 'translate', target: '功能开关' },
  ])];
  const rules = builtinRules({ technical: false, custom });
  const protectedBatch = rules.protect(['A behavior tree with a feature flag']);
  assert.equal(protectedBatch.texts[0].includes('behavior tree'), false);
  assert.equal(protectedBatch.texts[0].includes('feature flag'), true, 'translate entries stay in the source text');
  assert.equal(protectedBatch.tokens.length, 1);
  assert.match(protectedBatch.tokens[0].token, /^\[\[DSH_KEEP_BEHAVIOR_TREE\]\]$/);
  assert.equal(rules.restore(`保留 ${protectedBatch.tokens[0].token}`, protectedBatch.tokens), '保留 behavior tree');

  const hint = rules.hint(false);
  assert.ok(hint.includes('keep "behavior tree" in English'));
  assert.ok(hint.includes('translate "feature flag" as "功能开关"'));
  assert.ok(hint.includes('[[DSH_KEEP_0_0]]'), 'token preservation instruction is present');
});

test('the hint switches between compact and full variants', () => {
  const rules = builtinRules();
  const compact = rules.hint(true);
  const full = rules.hint(false);
  assert.ok(compact.startsWith('This is software/programming content. Mandatory terminology:'));
  assert.ok(full.startsWith('This page appears to be software/programming documentation.'));
  assert.ok(compact.length < full.length);
});

test('compileTermPattern handles English plurals, phrases, CJK and punctuation', () => {
  const plural = compileTermPattern('port');
  assert.ok(plural.test('ports'));
  plural.lastIndex = 0;
  assert.ok(plural.test('port'));
  plural.lastIndex = 0;
  assert.equal(plural.test('important'), false, 'word boundaries avoid substrings');

  const phrase = compileTermPattern('behavior tree');
  assert.ok(phrase.test('behavior  tree'), 'whitespace in the source matches any run of spaces');

  const cjk = compileTermPattern('无值类型');
  assert.ok(cjk.test('这是无值类型的例子'));

  const cpp = compileTermPattern('C++');
  cpp.lastIndex = 0;
  assert.ok(cpp.test('C++ 编译器'));
  cpp.lastIndex = 0;
  assert.equal(cpp.test('编译器'), false);

  assert.equal(compileTermPattern('   '), null);
  assert.equal(compileTermPattern(undefined), null);
});

test('token generation keeps distinct spellings of the same base apart', () => {
  const rules = buildTerminologyRules({
    custom: [customLibrary([
      { id: 'te_1', source: 'a-b', policy: 'keep' },
      { id: 'te_2', source: 'a b', policy: 'keep' },
    ])],
  }, { technical: false });
  const rules2 = rules.protect(['a-b and a b']);
  const tokens = rules2.tokens.map((entry) => entry.token);
  assert.equal(new Set(tokens).size, tokens.length, 'token strings are unique when values differ');
  assert.equal(rules.restore(rules2.texts[0], rules2.tokens), 'a-b and a b');
});
