/** Batch chunking and bounded concurrency (DESIGN §4.2). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkSegments, countBatchChars, runPool } from '../lib/batch.js';

/** Build indexed entries from raw strings. */
function entries(texts) {
  return texts.map((text, index) => ({ index, text }));
}

test('chunks by segment count', () => {
  const batches = chunkSegments(entries(['a', 'b', 'c', 'd', 'e']), { batchSegments: 2, batchChars: 10_000 });
  assert.deepEqual(batches.map((batch) => batch.map((entry) => entry.text)), [['a', 'b'], ['c', 'd'], ['e']]);
});

test('chunks by character budget, keeping order and indexes', () => {
  const batches = chunkSegments(entries(['aaaa', 'bbbb', 'cc']), { batchSegments: 10, batchChars: 8 });
  assert.deepEqual(batches.map((batch) => batch.map((entry) => entry.text)), [['aaaa', 'bbbb'], ['cc']]);
  assert.deepEqual(batches[0].map((entry) => entry.index), [0, 1]);
  assert.deepEqual(batches[1].map((entry) => entry.index), [2]);
});

test('an over-long single segment gets its own batch', () => {
  const batches = chunkSegments(entries(['x'.repeat(50), 'short']), { batchSegments: 10, batchChars: 10 });
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].text.length, 50);
  assert.equal(batches[1][0].text, 'short');
});

test('defaults mirror DESIGN §4.2 (10 segments, 1600 chars)', () => {
  const thirteen = entries(Array.from({ length: 13 }, (_, index) => `s${index}`));
  const bySegments = chunkSegments(thirteen);
  assert.deepEqual(bySegments.map((batch) => batch.length), [10, 3]);

  const long = entries(['a'.repeat(800), 'b'.repeat(800), 'c']);
  const byChars = chunkSegments(long);
  assert.deepEqual(byChars.map((batch) => batch.length), [2, 1]);
});

test('empty entry list yields no batches', () => {
  assert.deepEqual(chunkSegments([]), []);
  assert.deepEqual(chunkSegments(undefined), []);
});

test('countBatchChars sums segment lengths', () => {
  assert.equal(countBatchChars(entries(['ab', 'cde'])), 5);
  assert.equal(countBatchChars([]), 0);
});

test('runPool keeps result order and respects the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const results = await runPool([1, 2, 3, 4, 5, 6, 7], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded 2`);
});

test('runPool propagates worker failures', async () => {
  await assert.rejects(
    runPool([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('boom');
      return value;
    }),
    /boom/,
  );
});

test('runPool with empty input resolves to an empty array', async () => {
  assert.deepEqual(await runPool([], 2, async () => 1), []);
});
