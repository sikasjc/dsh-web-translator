/** Cross-platform local OCR helpers: language choice, word grouping, code filtering. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseOcrLanguage, groupOcrWords, looksLikeCodeBlock } from '../lib/local-ocr.js';

test('chooseOcrLanguage maps supported scripts and rejects unsupported ones', () => {
  assert.equal(chooseOcrLanguage('en'), 'eng');
  assert.equal(chooseOcrLanguage('en-US'), 'eng');
  assert.equal(chooseOcrLanguage('fr'), 'eng');
  assert.equal(chooseOcrLanguage('zh-CN'), 'chi_sim');
  assert.equal(chooseOcrLanguage('zh-Hant'), 'chi_sim');
  assert.equal(chooseOcrLanguage('auto'), 'eng');
  assert.equal(chooseOcrLanguage('ja'), null);
  assert.equal(chooseOcrLanguage('ar'), null);
});

test('looksLikeCodeBlock catches JSON, leading punctuation and URLs only', () => {
  assert.equal(looksLikeCodeBlock('{"flagged": true}'), true);
  assert.equal(looksLikeCodeBlock('"reason": "ransomware"'), true);
  assert.equal(looksLikeCodeBlock('https://example.com/x'), true);
  assert.equal(looksLikeCodeBlock('A normal English sentence with a URL'), false);
  assert.equal(looksLikeCodeBlock('Human'), false);
});

test('groupOcrWords splits label/message columns, merges paragraph lines and drops code regions', () => {
  const word = (text, left, top, right, bottom) => ({
    text,
    rect: { left, top, right, bottom },
    confidence: 0.9,
  });
  const words = [
    word('Human', 10, 10, 80, 30),
    word("I'm", 120, 10, 160, 30),
    word('here.', 168, 10, 230, 30),
    word('Second', 120, 36, 190, 56),
    word('line.', 198, 36, 250, 56),
    word('Assistant', 10, 70, 105, 90),
    word('{"flagged":', 10, 120, 180, 140),
    word('"reason":', 10, 146, 150, 166),
    word('"ransomware"}', 10, 172, 220, 192),
    word('and', 130, 146, 160, 166),
    word('spreading,', 168, 146, 250, 166),
  ];
  const blocks = groupOcrWords(words, 1000, 500);
  assert.ok(blocks.length >= 3);
  const texts = blocks.map((block) => block.text);
  assert.ok(texts.includes('Human'));
  assert.ok(texts.includes('Assistant'));
  assert.ok(texts.some((text) => text.includes("I'm here.") && text.includes('Second line.')));
  assert.ok(!texts.some((text) => text.includes('flagged') || text.includes('spreading')));
  for (const block of blocks) {
    assert.equal(block.bbox.length, 4);
    for (const value of block.bbox) assert.ok(value >= 0 && value <= 1);
    assert.ok(block.confidence > 0);
  }
});
