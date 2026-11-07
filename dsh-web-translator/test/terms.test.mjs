/** Technical terminology protection (page-context translation). */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTechnicalFallback,
  protectTechnicalTerms,
  restoreTechnicalTerms,
} from '../lib/terms.js';

test('protectTechnicalTerms replaces trait/traits with opaque tokens', () => {
  const protectedBatch = protectTechnicalTerms(['Traits define behavior', 'A trait object']);
  assert.equal(protectedBatch.texts.length, 2);
  assert.equal(protectedBatch.texts[0].includes('Traits'), false);
  assert.equal(protectedBatch.texts[1].includes('trait'), false);
  assert.deepEqual(protectedBatch.tokens.map((entry) => entry.value), ['Traits', 'trait']);
});

test('restoreTechnicalTerms restores original spelling and plural form', () => {
  const protectedBatch = protectTechnicalTerms(['Traits and a trait']);
  const translated = `使用 ${protectedBatch.tokens[0].token} 和 a ${protectedBatch.tokens[1].token}`;
  assert.equal(restoreTechnicalTerms(translated, protectedBatch.tokens), '使用 Traits 和 a trait');
  assert.equal(restoreTechnicalTerms('no tokens', []), 'no tokens');
});

test('applyTechnicalFallback fixes the known bad renderings only when the source has the term', () => {
  assert.equal(applyTechnicalFallback('Rust traits', 'Rust 特征'), 'Rust traits');
  assert.equal(applyTechnicalFallback('Configure the port', '配置港口'), '配置端口');
  assert.equal(applyTechnicalFallback('A feature of the city', '港口城市的特点'), '港口城市的特点');
  assert.equal(applyTechnicalFallback('Something else', '原样返回'), '原样返回');
});
