/** SRS intervals, review scheduling and aggregate stats (DESIGN §5.8). */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MASTERED_LEVEL,
  MAX_LEVEL,
  REVIEW_GRADES,
  REVIEW_INTERVALS_MS,
  endOfLocalDay,
  isDue,
  normalizeLevel,
  scheduleReview,
  wordbookStats,
} from '../lib/srs.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0); // fixed instant for deterministic math

/** Minimal wordbook item. */
function item(overrides = {}) {
  return {
    id: 'wb_test',
    word: 'immersive',
    translation: '沉浸式的',
    targetLanguage: 'zh-CN',
    note: '',
    createdAt: NOW,
    updatedAt: NOW,
    reviews: 0,
    lapses: 0,
    level: 0,
    dueAt: NOW,
    mastered: false,
    suspended: false,
    ...overrides,
  };
}

test('interval table matches DESIGN (10min, 1,2,4,7,15,30,60,120 days)', () => {
  assert.deepEqual(REVIEW_GRADES, ['again', 'hard', 'good']);
  assert.deepEqual([...REVIEW_INTERVALS_MS], [
    10 * 60 * 1000, DAY, 2 * DAY, 4 * DAY, 7 * DAY, 15 * DAY, 30 * DAY, 60 * DAY, 120 * DAY,
  ]);
  assert.equal(MAX_LEVEL, 8);
  assert.equal(MASTERED_LEVEL, 8);
});

test('again resets level, increments lapses and schedules +10min', () => {
  const next = scheduleReview(item({ level: 5, reviews: 3, lapses: 1 }), 'again', NOW);
  assert.equal(next.level, 0);
  assert.equal(next.lapses, 2);
  assert.equal(next.reviews, 4);
  assert.equal(next.dueAt, NOW + 10 * 60 * 1000);
  assert.equal(next.mastered, false);
  assert.equal(next.updatedAt, NOW);
  // original is not mutated
  assert.equal(next.word, 'immersive');
});

test('hard moves one level down and schedules interval[level]', () => {
  const next = scheduleReview(item({ level: 3 }), 'hard', NOW);
  assert.equal(next.level, 2);
  assert.equal(next.dueAt, NOW + 2 * DAY);
  assert.equal(next.reviews, 1);

  const floor = scheduleReview(item({ level: 0 }), 'hard', NOW);
  assert.equal(floor.level, 0);
  assert.equal(floor.dueAt, NOW + 10 * 60 * 1000);
});

test('good moves one level up and schedules interval[level], mastering at 8', () => {
  const next = scheduleReview(item({ level: 0 }), 'good', NOW);
  assert.equal(next.level, 1);
  assert.equal(next.dueAt, NOW + DAY);
  assert.equal(next.mastered, false);

  const top = scheduleReview(item({ level: 7 }), 'good', NOW);
  assert.equal(top.level, 8);
  assert.equal(top.dueAt, NOW + 120 * DAY);
  assert.equal(top.mastered, true);

  const capped = scheduleReview(item({ level: 8, mastered: true }), 'good', NOW);
  assert.equal(capped.level, 8);
  assert.equal(capped.dueAt, NOW + 120 * DAY);
});

test('rejects an unknown grade and coerces odd levels', () => {
  assert.throws(() => scheduleReview(item(), 'perfect', NOW), (error) => error.code === 'BAD_REQUEST');
  assert.equal(normalizeLevel(undefined), 0);
  assert.equal(normalizeLevel(-3), 0);
  assert.equal(normalizeLevel(99), 8);
  assert.equal(normalizeLevel(3.9), 3);
});

test('isDue respects due time, mastered and suspended flags', () => {
  assert.equal(isDue(item({ dueAt: NOW - 1 }), NOW), true);
  assert.equal(isDue(item({ dueAt: NOW }), NOW), true);
  assert.equal(isDue(item({ dueAt: NOW + 1 }), NOW), false);
  assert.equal(isDue(item({ dueAt: NOW - 1, mastered: true }), NOW), false);
  assert.equal(isDue(item({ dueAt: NOW - 1, suspended: true }), NOW), false);
});

test('endOfLocalDay covers the whole local day', () => {
  const end = endOfLocalDay(NOW);
  assert.ok(end >= NOW);
  const date = new Date(end);
  assert.equal(date.getHours(), 23);
  assert.equal(date.getMinutes(), 59);
  assert.equal(date.getSeconds(), 59);
  assert.equal(date.getMilliseconds(), 999);
});

test('wordbookStats counts total/due/todayDue/mastered/new', () => {
  const stats = wordbookStats([
    item({ id: 'a', dueAt: NOW - 1000, reviews: 0 }),
    item({ id: 'b', dueAt: NOW + DAY, reviews: 2, level: 1 }),
    item({ id: 'c', dueAt: NOW - 1000, mastered: true, reviews: 9, level: 8 }),
    item({ id: 'd', dueAt: NOW - 1000, suspended: true, reviews: 1 }),
  ], NOW);
  assert.deepEqual(stats, { total: 4, due: 1, todayDue: 1, mastered: 1, newCount: 1 });

  const dayEnd = endOfLocalDay(NOW);
  const tomorrowWithinDay = dayEnd - 1000;
  const late = wordbookStats([item({ id: 'e', dueAt: tomorrowWithinDay })], NOW);
  assert.equal(late.todayDue, 1);
  assert.equal(late.due, 0);
});
