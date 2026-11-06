/**
 * Three-grade spaced repetition for the wordbook (DESIGN §5.8).
 *
 * Intervals are `[10min, 1, 2, 4, 7, 15, 30, 60, 120]` days by level 0..8:
 * - `again`: level = 0, lapses++, due now + 10 min;
 * - `hard`: level = max(0, level - 1), due now + interval[level];
 * - `good`: level = min(8, level + 1), due now + interval[level].
 * `mastered` follows level >= 8 unless the user overrides it manually.
 */
import { apiError } from './errors.js';

/** Accepted review grades (DESIGN §5.8). */
export const REVIEW_GRADES = Object.freeze(['again', 'hard', 'good']);

/** Level intervals in milliseconds; index 0 is the 10-minute first step. */
export const REVIEW_INTERVALS_MS = Object.freeze([
  10 * 60 * 1000,
  24 * 60 * 60 * 1000,
  2 * 24 * 60 * 60 * 1000,
  4 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  15 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  60 * 24 * 60 * 60 * 1000,
  120 * 24 * 60 * 60 * 1000,
]);

/** Highest level / interval index. */
export const MAX_LEVEL = REVIEW_INTERVALS_MS.length - 1;

/** A level at or above this marks the entry mastered. */
export const MASTERED_LEVEL = MAX_LEVEL;

/**
 * Coerce a stored level into 0..8.
 * @param {unknown} value - stored level.
 * @returns {number}
 */
export function normalizeLevel(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_LEVEL, Math.max(0, Math.trunc(value)));
}

/**
 * Coerce a stored counter into a non-negative integer.
 * @param {unknown} value - stored counter.
 * @returns {number}
 */
function normalizeCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Compute the next schedule for one review grade without mutating the item.
 * @param {object} item - existing wordbook entry.
 * @param {'again'|'hard'|'good'} grade - user grade.
 * @param {number} [nowMs] - current timestamp.
 * @returns {object} new entry fields (shallow-merged by the caller).
 */
export function scheduleReview(item, grade, nowMs = Date.now()) {
  if (!REVIEW_GRADES.includes(grade)) {
    throw apiError('BAD_REQUEST', 'grade must be again, hard or good');
  }
  const timestamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  const level = normalizeLevel(item?.level);
  const reviews = normalizeCount(item?.reviews) + 1;
  let lapses = normalizeCount(item?.lapses);
  let nextLevel = level;
  let dueAt;

  if (grade === 'again') {
    nextLevel = 0;
    lapses += 1;
    dueAt = timestamp + REVIEW_INTERVALS_MS[0];
  } else if (grade === 'hard') {
    nextLevel = Math.max(0, level - 1);
    dueAt = timestamp + REVIEW_INTERVALS_MS[nextLevel];
  } else {
    nextLevel = Math.min(MAX_LEVEL, level + 1);
    dueAt = timestamp + REVIEW_INTERVALS_MS[nextLevel];
  }

  return {
    ...item,
    level: nextLevel,
    lapses,
    reviews,
    dueAt,
    mastered: nextLevel >= MASTERED_LEVEL,
    updatedAt: timestamp,
  };
}

/**
 * Whether an entry is due for review right now.
 * @param {object} item - wordbook entry.
 * @param {number} [nowMs] - current timestamp.
 * @returns {boolean}
 */
export function isDue(item, nowMs = Date.now()) {
  if (item?.mastered === true || item?.suspended === true) return false;
  return Number.isFinite(item?.dueAt) && item.dueAt <= nowMs;
}

/**
 * End of the local calendar day containing `nowMs`.
 * @param {number} nowMs - current timestamp.
 * @returns {number}
 */
export function endOfLocalDay(nowMs) {
  const end = new Date(nowMs);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/**
 * Aggregate wordbook counters (`GET /wordbook.stats`, DESIGN §5.8).
 * `due` means due now; `todayDue` means due before the local day ends.
 * @param {readonly object[]} items - all entries.
 * @param {number} [nowMs] - current timestamp.
 * @returns {{total: number, due: number, todayDue: number, mastered: number, newCount: number}}
 */
export function wordbookStats(items, nowMs = Date.now()) {
  const dayEnd = endOfLocalDay(nowMs);
  const stats = { total: 0, due: 0, todayDue: 0, mastered: 0, newCount: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    stats.total += 1;
    if (item?.mastered === true) stats.mastered += 1;
    if (normalizeCount(item?.reviews) === 0) stats.newCount += 1;
    if (item?.mastered === true || item?.suspended === true) continue;
    if (Number.isFinite(item?.dueAt)) {
      if (item.dueAt <= nowMs) stats.due += 1;
      if (item.dueAt <= dayEnd) stats.todayDue += 1;
    }
  }
  return stats;
}
