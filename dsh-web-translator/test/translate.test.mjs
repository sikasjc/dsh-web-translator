import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSegmentText } from '../lib/translate.js';

test('normalizeSegmentText collapses HTML formatting newlines', () => {
  assert.equal(normalizeSegmentText('  First line\n    second line\nthird  '), 'First line second line third');
});

test('normalizeSegmentText converts NBSP and tabs to single spaces', () => {
  assert.equal(normalizeSegmentText('a\u00a0b\tc\u202fd'), 'a b c d');
});

test('normalizeSegmentText handles CRLF and repeated blank lines', () => {
  assert.equal(normalizeSegmentText('line1\r\n\r\nline2'), 'line1 line2');
});

test('normalizeSegmentText keeps single spaces and trims', () => {
  assert.equal(normalizeSegmentText('  hello world  '), 'hello world');
});

test('normalizeSegmentText degrades non-strings and empty values', () => {
  assert.equal(normalizeSegmentText(undefined), '');
  assert.equal(normalizeSegmentText(null), '');
  assert.equal(normalizeSegmentText(42), '');
  assert.equal(normalizeSegmentText('   '), '');
});
