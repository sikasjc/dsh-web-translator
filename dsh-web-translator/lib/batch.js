/**
 * Batch chunking and bounded concurrency for model calls (DESIGN §4.2).
 *
 * The client already groups segments, but the host re-chunks defensively:
 * at most `batchSegments` segments and `batchChars` characters per model call,
 * while a single over-long segment still gets a batch of its own. Batches run
 * with a small worker pool (settings `concurrency`, default 2).
 */

/**
 * Chunk non-empty segments into model-call batches.
 * @param {readonly {index: number, text: string}[]} entries - segments in request order.
 * @param {{batchSegments?: number, batchChars?: number}} [options] - batch limits.
 * @returns {{index: number, text: string}[][]} batches, each keeping request order.
 */
export function chunkSegments(entries, { batchSegments = 10, batchChars = 1600 } = {}) {
  const maxSegments = Math.max(1, Math.trunc(Number(batchSegments)) || 10);
  const maxChars = Math.max(1, Math.trunc(Number(batchChars)) || 1600);
  const batches = [];
  let current = [];
  let chars = 0;

  const flush = () => {
    if (current.length > 0) batches.push(current);
    current = [];
    chars = 0;
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    const length = typeof entry?.text === 'string' ? entry.text.length : 0;
    if (current.length > 0 && (current.length >= maxSegments || chars + length > maxChars)) flush();
    current.push(entry);
    chars += length;
    if (current.length >= maxSegments || chars >= maxChars) flush();
  }
  flush();
  return batches;
}

/**
 * Sum the characters of one batch (used for output-token estimation).
 * @param {readonly {text: string}[]} entries - batch segments.
 * @returns {number}
 */
export function countBatchChars(entries) {
  let total = 0;
  for (const entry of entries) {
    if (typeof entry?.text === 'string') total += entry.text.length;
  }
  return total;
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Results keep input
 * order; the first rejection rejects the returned promise.
 * @template T, R
 * @param {readonly T[]} items - work items.
 * @param {number} limit - maximum parallel workers.
 * @param {(item: T, index: number) => Promise<R>} worker - per-item task.
 * @returns {Promise<R[]>}
 */
export async function runPool(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.min(Math.trunc(Number(limit)) || 1, list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
