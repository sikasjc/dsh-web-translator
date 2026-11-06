/**
 * Token-usage ledger for the dsh-web-translator host half
 * (DESIGN-TOKEN-USAGE §2).
 *
 * Translation/lookup are plugin-owned auxiliary `ctx.llm.stream` calls, so the
 * DSH session log never sees their tokens; this module keeps its own ledger in
 * `$DSH_HOME/immersive-translate/usage.json` through the shared
 * {@link createJsonStore} (atomic tmp+rename writes, serialized mutations,
 * corrupt-file fallback).
 *
 * Invariants:
 *  - every public method is completely fault tolerant: a broken or unwritable
 *    ledger must never make a translation request fail (failures are logged and
 *    swallowed);
 *  - statistics follow the DSH bucket model: `requests / ok / errors / cached`
 *    plus the four token buckets; `cached` requests and failed requests record
 *    zero tokens (DESIGN-TOKEN-USAGE §2.3);
 *  - day buckets are local-time `YYYY-MM-DD`, retained for `LIMITS.usageDays`,
 *    and `events` keeps the newest `LIMITS.usageEvents` entries (newest first);
 *  - `turns()` only aggregates that capped in-memory event list into per-Turn
 *    rows (DESIGN-TURN-TRACE §2.2): grouping is by `turnId`, or `evt:<eventId>`
 *    for legacy events recorded before Turn metadata existed;
 *  - every bucket also persists `latencySum`/`latencyCount` so `summary()` can
 *    expose an exact `avgLatencyMs` (the panel's 平均时延) without replaying
 *    the capped event list.
 */
import { randomBytes } from 'node:crypto';
import { LIMITS, USAGE_VERSION } from './constants.js';

/** Event kinds accepted by `record` (DESIGN-TOKEN-USAGE §2.1). */
export const USAGE_EVENT_KINDS = Object.freeze(['translate', 'lookup']);

/** Counter keys shared by totals / days / kinds buckets. */
const BUCKET_KEYS = Object.freeze([
  'requests',
  'ok',
  'errors',
  'cached',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
]);

/** Latency aggregation keys persisted alongside the eight counters. */
const LATENCY_KEYS = Object.freeze(['latencySum', 'latencyCount']);

/** Every key persisted in one stat bucket. */
const PERSISTED_BUCKET_KEYS = Object.freeze([...BUCKET_KEYS, ...LATENCY_KEYS]);

/**
 * Upper bound for one request's latency contribution: anything above is junk
 * (e.g. a clock jump while a batch was queued) and is clamped, not dropped.
 */
export const MAX_LATENCY_MS = 600_000;

/** Event fields shared by every model aggregation entry (DESIGN-TOKEN-USAGE §2.1). */
const MODEL_TOKEN_KEYS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
]);

/** Optional string event fields with their on-disk truncation caps. */
const OPTIONAL_TEXT_FIELDS = Object.freeze([
  ['reasoningEffort', 40],
  ['targetLanguage', 32],
  ['sourceLanguage', 32],
  ['client', LIMITS.clientChars],
  ['site', 300],
  ['sourceUrl', LIMITS.urlChars],
  ['sourceTitle', LIMITS.sourceTitleChars],
  ['sample', LIMITS.eventSampleChars],
  // Turn metadata (DESIGN-TURN-TRACE §2.1): legacy events simply omit them.
  ['turnId', LIMITS.turnIdChars],
  ['mode', LIMITS.modeChars],
  ['outputPreview', LIMITS.outputPreviewChars],
  ['sessionId', LIMITS.sessionIdChars],
]);

/** Turn status values (DESIGN-TURN-TRACE §2.2). */
export const TURN_STATUSES = Object.freeze(['ok', 'partial', 'error']);

/** `summary().recent` cap (DESIGN-TOKEN-USAGE §2.2). */
const RECENT_EVENTS = 20;

/** Default `summary({days})` window. */
const DEFAULT_DAYS = 14;

/** Default `events({limit})` page size. */
const DEFAULT_EVENT_LIMIT = 50;

/** Default `turns({limit})` page size (DESIGN-TURN-TRACE §2.2). */
const DEFAULT_TURN_LIMIT = LIMITS.usageTurnsDefault;

/**
 * @returns {object} a zeroed persisted statistic bucket: the eight counters plus
 *   `latencySum`/`latencyCount`.
 */
export function emptyUsageBuckets() {
  const buckets = {};
  for (const key of PERSISTED_BUCKET_KEYS) buckets[key] = 0;
  return buckets;
}

/**
 * @returns {object} a zeroed summary bucket: the eight counters plus the derived
 *   rounded `avgLatencyMs` (0 when no request was recorded).
 */
export function emptyUsageSummaryBuckets() {
  const buckets = {};
  for (const key of BUCKET_KEYS) buckets[key] = 0;
  buckets.avgLatencyMs = 0;
  return buckets;
}

/** @returns {object} a zeroed ledger matching DESIGN-TOKEN-USAGE §2.1. */
export function emptyUsageLedger() {
  return {
    version: USAGE_VERSION,
    updatedAt: 0,
    totals: emptyUsageBuckets(),
    days: {},
    models: {},
    kinds: {
      translate: emptyUsageBuckets(),
      lookup: emptyUsageBuckets(),
    },
    events: [],
  };
}

/**
 * Local-time `YYYY-MM-DD` key for one epoch-ms timestamp.
 * @param {number} at - epoch milliseconds (defaults to now when not finite).
 * @returns {string}
 */
export function usageDayKey(at) {
  const date = new Date(Number.isFinite(at) ? at : Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Coerce a counter to a non-negative integer.
 * @param {unknown} value - raw value.
 * @returns {number}
 */
function toCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Coerce one request latency into a safe integer contribution: non-finite -> 0,
 * negatives -> 0, fractional -> rounded, absurd values -> {@link MAX_LATENCY_MS}.
 * @param {unknown} value - raw latency in milliseconds.
 * @returns {number}
 */
function clampLatency(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(value)));
}

/**
 * Coerce a string field to a non-empty truncated string.
 * @param {unknown} value - raw value.
 * @param {number} max - character cap.
 * @returns {string | undefined}
 */
function clip(value, max) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, max);
}

/** @returns {string} one fresh event id. */
function newEventId() {
  return `evt_${randomBytes(8).toString('hex')}`;
}

/**
 * Format an unknown error for a log line.
 * @param {unknown} error - caught value.
 * @returns {string}
 */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Normalize one statistic bucket, treating anything unexpected as zero.
 * @param {unknown} raw - candidate bucket.
 * @returns {object}
 */
function normalizeBuckets(raw) {
  const buckets = emptyUsageBuckets();
  if (raw === null || typeof raw !== 'object') return buckets;
  for (const key of BUCKET_KEYS) buckets[key] = toCount(raw[key]);
  // Legacy ledgers have no latency keys: they normalize to a zero count, and
  // new records merge additively from there.
  for (const key of LATENCY_KEYS) buckets[key] = toCount(raw[key]);
  return buckets;
}

/**
 * Add a delta bucket into an existing bucket (returns a new object).
 * @param {unknown} target - current bucket (may be undefined).
 * @param {object} delta - bucket-sized delta.
 * @returns {object}
 */
function addBuckets(target, delta) {
  const next = normalizeBuckets(target);
  for (const key of PERSISTED_BUCKET_KEYS) next[key] += delta[key];
  return next;
}

/**
 * Convert one persisted bucket into the summary shape: the eight counters plus
 * the rounded `avgLatencyMs` (integer ms; 0 when no request was counted).
 * @param {unknown} raw - persisted bucket (or undefined for a missing day).
 * @returns {object}
 */
function summarizeBuckets(raw) {
  const persisted = normalizeBuckets(raw);
  const buckets = emptyUsageSummaryBuckets();
  for (const key of BUCKET_KEYS) buckets[key] = persisted[key];
  buckets.avgLatencyMs = persisted.latencyCount > 0
    ? Math.round(persisted.latencySum / persisted.latencyCount)
    : 0;
  return buckets;
}

/**
 * Zero the four token fields of one event (cached / failed requests count 0).
 * @param {object} event - ledger event (mutated in place).
 * @returns {void}
 */
function zeroTokens(event) {
  for (const key of MODEL_TOKEN_KEYS) event[key] = 0;
}

/**
 * Normalize one model aggregation entry (DESIGN-TOKEN-USAGE §2.1).
 * @param {unknown} raw - candidate entry.
 * @returns {object | null}
 */
function normalizeModelEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const provider = clip(raw.provider, 120) ?? '';
  const model = clip(raw.model, 200) ?? '';
  if (provider.length === 0 && model.length === 0) return null;
  const entry = {
    provider,
    model,
    requests: toCount(raw.requests),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastAt: toCount(raw.lastAt),
  };
  for (const key of MODEL_TOKEN_KEYS) entry[key] = toCount(raw[key]);
  return entry;
}

/**
 * Normalize one event read from disk or handed to `record`.
 * Optional fields are omitted when absent/blank so the JSON stays compact.
 * @param {unknown} raw - candidate event.
 * @returns {object | null}
 */
function normalizeEvent(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const event = {
    id: clip(raw.id, 64) ?? newEventId(),
    at: toCount(raw.at),
    kind: raw.kind === 'lookup' ? 'lookup' : 'translate',
    ok: raw.ok === true,
    provider: clip(raw.provider, 120) ?? '',
    model: clip(raw.model, 200) ?? '',
    segments: toCount(raw.segments),
    chars: toCount(raw.chars),
    cached: raw.cached === true,
    turn: toCount(raw.turn),
    retries: toCount(raw.retries),
    inputTokens: toCount(raw.inputTokens),
    outputTokens: toCount(raw.outputTokens),
    cacheReadTokens: toCount(raw.cacheReadTokens),
    cacheWriteTokens: toCount(raw.cacheWriteTokens),
    latencyMs: clampLatency(raw.latencyMs),
  };
  if (!event.ok) {
    const errorCode = clip(raw.errorCode, 64);
    if (errorCode !== undefined) event.errorCode = errorCode;
  }
  for (const [field, max] of OPTIONAL_TEXT_FIELDS) {
    const value = clip(raw[field], max);
    if (value !== undefined) event[field] = value;
  }
  if (raw.stepIndex !== undefined && raw.stepIndex !== null) {
    const stepIndex = Number(raw.stepIndex);
    if (Number.isFinite(stepIndex)) {
      event.stepIndex = Math.min(LIMITS.stepIndexMax, Math.max(0, Math.trunc(stepIndex)));
    }
  }
  return event;
}

/**
 * Normalize a whole persisted document into the current schema. Tolerates
 * missing/rotten fields and stale versions; never throws for object input.
 * @param {unknown} raw - document read from the store.
 * @param {{maxEvents?: number}} [limits] - event cap to enforce on read.
 * @returns {object} a fresh ledger.
 */
function normalizeLedger(raw, { maxEvents = LIMITS.usageEvents } = {}) {
  const ledger = emptyUsageLedger();
  if (raw === null || typeof raw !== 'object') return ledger;
  ledger.updatedAt = toCount(raw.updatedAt);
  ledger.totals = normalizeBuckets(raw.totals);

  const days = raw.days !== null && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : {};
  for (const [key, value] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    ledger.days[key] = normalizeBuckets(value);
  }

  const models = raw.models !== null && typeof raw.models === 'object' && !Array.isArray(raw.models) ? raw.models : {};
  for (const value of Object.values(models)) {
    const entry = normalizeModelEntry(value);
    if (entry !== null) ledger.models[`${entry.provider}/${entry.model}`] = entry;
  }

  const kinds = raw.kinds !== null && typeof raw.kinds === 'object' ? raw.kinds : {};
  ledger.kinds.translate = normalizeBuckets(kinds.translate);
  ledger.kinds.lookup = normalizeBuckets(kinds.lookup);

  const events = Array.isArray(raw.events) ? raw.events : [];
  for (const value of events) {
    if (ledger.events.length >= maxEvents) break;
    const event = normalizeEvent(value);
    if (event !== null) ledger.events.push(event);
  }
  return ledger;
}

/**
 * Replace every property of `target` with those of `source` (schema cleanup
 * when persisting a normalized draft).
 * @param {object} target - store draft.
 * @param {object} source - normalized ledger.
 * @returns {void}
 */
function replaceLedger(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

/**
 * Drop day buckets older than the retention window, anchored at one timestamp.
 * @param {Record<string, object>} days - mutable day map.
 * @param {number} referenceAt - epoch ms the window is anchored at.
 * @param {number} maxDays - retained local days including the anchor day.
 * @returns {void}
 */
function pruneDays(days, referenceAt, maxDays) {
  const anchor = new Date(referenceAt);
  anchor.setHours(12, 0, 0, 0);
  anchor.setDate(anchor.getDate() - (maxDays - 1));
  const cutoff = usageDayKey(anchor.getTime());
  for (const key of Object.keys(days)) {
    if (key < cutoff) delete days[key];
  }
}

/**
 * Apply one normalized event to a ledger draft.
 * @param {object} ledger - mutable ledger.
 * @param {object} event - normalized event.
 * @param {{maxEvents: number, maxDays: number}} retention - caps.
 * @returns {void}
 */
function applyRecord(ledger, event, { maxEvents, maxDays }) {
  const delta = emptyUsageBuckets();
  delta.requests = 1;
  delta.ok = event.ok ? 1 : 0;
  delta.errors = event.ok ? 0 : 1;
  delta.cached = event.cached ? 1 : 0;
  for (const key of MODEL_TOKEN_KEYS) delta[key] = event[key];
  delta.latencySum = event.latencyMs;
  delta.latencyCount = 1;

  ledger.totals = addBuckets(ledger.totals, delta);
  const dayKey = usageDayKey(event.at);
  ledger.days[dayKey] = addBuckets(ledger.days[dayKey], delta);
  ledger.kinds[event.kind] = addBuckets(ledger.kinds[event.kind], delta);

  if (event.provider.length > 0 || event.model.length > 0) {
    const modelKey = `${event.provider}/${event.model}`;
    const model = normalizeModelEntry(ledger.models[modelKey]) ?? {
      provider: event.provider,
      model: event.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastAt: 0,
    };
    model.requests += 1;
    for (const key of MODEL_TOKEN_KEYS) model[key] += event[key];
    model.lastAt = event.at;
    ledger.models[modelKey] = model;
  }

  ledger.updatedAt = event.at;
  ledger.version = USAGE_VERSION;
  ledger.events.unshift(event);
  if (ledger.events.length > maxEvents) ledger.events.length = maxEvents;
  pruneDays(ledger.days, event.at, maxDays);
}

/**
 * Clamp a numeric option into an integer range with a fallback.
 * @param {unknown} value - raw option.
 * @param {number} fallback - used when the value is not finite.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  const effective = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.min(max, Math.max(min, effective));
}

/**
 * Effective ordering key of one event inside its Turn: an explicit
 * `stepIndex`, else 0 so legacy events sort by `at` alone
 * (DESIGN-TURN-TRACE §2.2).
 * @param {object} event - normalized ledger event.
 * @returns {number}
 */
function stepIndexOf(event) {
  return typeof event.stepIndex === 'number' ? event.stepIndex : 0;
}

/**
 * Convert one ledger event into the Step row of a Turn (DESIGN-TURN-TRACE §2.2).
 * @param {object} event - normalized ledger event.
 * @returns {object}
 */
function stepOfEvent(event) {
  const step = {
    stepIndex: stepIndexOf(event),
    id: event.id,
    at: event.at,
    kind: event.kind,
    provider: event.provider,
    model: event.model,
    segments: event.segments,
    chars: event.chars,
    cached: event.cached,
    retries: event.retries,
    ok: event.ok,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    latencyMs: event.latencyMs,
  };
  if (event.sessionId !== undefined) step.sessionId = event.sessionId;
  if (event.errorCode !== undefined) step.errorCode = event.errorCode;
  if (event.sample !== undefined) step.sample = event.sample;
  if (event.outputPreview !== undefined) step.outputPreview = event.outputPreview;
  return step;
}

/**
 * First non-empty string field among a Turn's events in step order.
 * @param {object[]} events - events ordered by step.
 * @param {string} field - event field name.
 * @returns {string | undefined}
 */
function firstText(events, field) {
  for (const event of events) {
    const value = event[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Aggregate one group of same-turn events into the DSH-like Turn row
 * (DESIGN-TURN-TRACE §2.2): min/max timestamps, summed counters and tokens,
 * `ok|partial|error` status, and step rows sorted by stepIndex then `at`.
 * @param {string} id - turn id (`turnId`, or `evt:<eventId>` for legacy events).
 * @param {object[]} events - normalized ledger events of this turn.
 * @returns {object}
 */
function aggregateTurn(id, events) {
  const ordered = events
    .slice()
    .sort((left, right) => stepIndexOf(left) - stepIndexOf(right) || left.at - right.at);
  const steps = ordered.map(stepOfEvent);
  const tokens = {};
  for (const key of MODEL_TOKEN_KEYS) tokens[key] = 0;
  let startedAt = ordered[0].at;
  let endedAt = ordered[0].at;
  let ok = 0;
  let errors = 0;
  let cached = 0;
  let segments = 0;
  let chars = 0;
  let latencySum = 0;
  for (const event of ordered) {
    if (event.ok) ok += 1;
    else errors += 1;
    if (event.cached) cached += 1;
    segments += event.segments;
    chars += event.chars;
    latencySum += event.latencyMs;
    for (const key of MODEL_TOKEN_KEYS) tokens[key] += event[key];
    if (event.at < startedAt) startedAt = event.at;
    if (event.at > endedAt) endedAt = event.at;
  }
  const kinds = new Set(ordered.map((event) => event.kind));
  const kind = kinds.size > 1 ? 'mixed' : ordered[0].kind;
  const turn = {
    id,
    kind,
    startedAt,
    endedAt,
    // One step is measured by its own latency: `at` is the completion timestamp,
    // so a single-step span would otherwise collapse to 0.
    durationMs: ordered.length === 1 ? ordered[0].latencyMs : Math.max(0, endedAt - startedAt),
    requests: ordered.length,
    ok,
    errors,
    cached,
    segments,
    chars,
    ...tokens,
    avgLatencyMs: Math.round(latencySum / ordered.length),
    status: errors === 0 ? 'ok' : ok > 0 ? 'partial' : 'error',
    steps,
  };
  const optionalText = [
    'mode',
    'client',
    'site',
    'sourceUrl',
    'sourceTitle',
    'provider',
    'model',
    'targetLanguage',
    'sourceLanguage',
    'sessionId',
  ];
  for (const field of optionalText) {
    const value = firstText(ordered, field);
    if (value !== undefined) turn[field] = value;
  }
  return turn;
}

/**
 * Create the usage ledger service (DESIGN-TOKEN-USAGE §2.2).
 *
 * @param {{store?: object, now?: (() => number) | number, logger?: {warn?: Function},
 *   maxEvents?: number, maxDays?: number}} [options]
 *   `store` is a `lib/store.js` document (`read`/`mutate`); when omitted the
 *   ledger stays in memory. `now` is injectable for deterministic tests.
 * @returns {{record: Function, summary: Function, events: Function,
 *   turns: Function, clear: Function}}
 */
export function createUsageService({
  store,
  now = Date.now,
  logger,
  maxEvents = LIMITS.usageEvents,
  maxDays = LIMITS.usageDays,
} = {}) {
  const clock = typeof now === 'function' ? now : () => (Number.isFinite(now) ? now : Date.now());
  const retention = {
    maxEvents: clampInt(maxEvents, LIMITS.usageEvents, 1, 100_000),
    maxDays: clampInt(maxDays, LIMITS.usageDays, 1, LIMITS.usageDays),
  };
  const persistent = store !== null && typeof store === 'object'
    && typeof store.read === 'function'
    && typeof store.mutate === 'function';
  let memory = emptyUsageLedger();

  /**
   * @param {string} message - diagnostic line.
   * @returns {void}
   */
  function warn(message) {
    try {
      logger?.warn?.(`[dsh-web-translator] usage: ${message}`);
    } catch {
      // A broken logger must never take the ledger down.
    }
  }

  /**
   * Read a normalized snapshot of the ledger (never throws).
   * @returns {Promise<object>}
   */
  async function loadLedger() {
    if (!persistent) return normalizeLedger(memory, retention);
    try {
      return normalizeLedger(await store.read(), retention);
    } catch (error) {
      warn(`cannot read the ledger: ${describe(error)}`);
      return emptyUsageLedger();
    }
  }

  /**
   * Apply one mutation to the ledger and persist it (never throws).
   * @param {(ledger: object) => void} mutator - mutate the normalized draft.
   * @returns {Promise<void>}
   */
  async function mutateLedger(mutator) {
    if (!persistent) {
      const ledger = normalizeLedger(memory, retention);
      mutator(ledger);
      memory = ledger;
      return;
    }
    try {
      await store.mutate((draft) => {
        const ledger = normalizeLedger(draft, retention);
        mutator(ledger);
        replaceLedger(draft, ledger);
        return undefined;
      });
    } catch (error) {
      warn(`cannot persist the ledger: ${describe(error)}`);
    }
  }

  /**
   * Record one call event (DESIGN-TOKEN-USAGE §2.1). Failure to persist is
   * logged and swallowed so a translation can never fail because of stats.
   * @param {object} input - event fields; `id`/`at` are filled when absent.
   * @returns {Promise<void>}
   */
  async function record(input) {
    try {
      if (input === null || typeof input !== 'object') return;
      const at = Number.isFinite(input.at) && input.at > 0 ? Math.trunc(input.at) : Math.trunc(Number(clock()) || 0);
      const event = normalizeEvent({ ...input, at });
      if (event === null) return;
      if (!event.ok) {
        // Failed requests count as errors with zero tokens (§2.3).
        event.cached = false;
        zeroTokens(event);
      } else if (event.cached) {
        // Fully cached requests count as requests but cost zero tokens (§2.3).
        zeroTokens(event);
      }
      await mutateLedger((ledger) => applyRecord(ledger, event, retention));
    } catch (error) {
      warn(`record failed: ${describe(error)}`);
    }
  }

  /**
   * Aggregated statistics for the last N local days, including empty days so
   * the client chart stays continuous (DESIGN-TOKEN-USAGE §2.2).
   * @param {{days?: number}} [options] - window, clamped 1..LIMITS.usageDays.
   * @returns {Promise<object>}
   */
  async function summary(options = {}) {
    const ledger = await loadLedger();
    const days = clampInt(options?.days, DEFAULT_DAYS, 1, retention.maxDays);
    const nowMs = Math.trunc(Number(clock()) || 0);
    const todayKey = usageDayKey(nowMs);

    const dayList = [];
    const cursor = new Date(nowMs);
    cursor.setHours(12, 0, 0, 0);
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(cursor);
      day.setDate(cursor.getDate() - offset);
      const key = usageDayKey(day.getTime());
      dayList.push({ date: key, ...summarizeBuckets(ledger.days[key]) });
    }

    const byModel = Object.values(ledger.models)
      .map((entry) => normalizeModelEntry(entry))
      .filter((entry) => entry !== null)
      .sort((left, right) => right.requests - left.requests || right.lastAt - left.lastAt);

    return {
      version: ledger.version,
      updatedAt: ledger.updatedAt,
      totals: summarizeBuckets(ledger.totals),
      today: summarizeBuckets(ledger.days[todayKey]),
      days: dayList,
      byModel,
      byKind: {
        translate: summarizeBuckets(ledger.kinds.translate),
        lookup: summarizeBuckets(ledger.kinds.lookup),
      },
      recent: ledger.events.slice(0, RECENT_EVENTS),
    };
  }

  /**
   * One page of events, newest first, with keyset pagination on event id.
   * @param {{limit?: number, kind?: 'translate'|'lookup'|'error', before?: string}} [options]
   * @returns {Promise<{events: object[], nextBefore: string | null, hasMore: boolean}>}
   */
  async function events(options = {}) {
    const ledger = await loadLedger();
    const limit = clampInt(options?.limit, DEFAULT_EVENT_LIMIT, 1, retention.maxEvents);
    const kind = typeof options?.kind === 'string' ? options.kind.trim() : '';
    let filtered = ledger.events;
    if (kind === 'error') {
      filtered = filtered.filter((event) => event.ok !== true);
    } else if (USAGE_EVENT_KINDS.includes(kind)) {
      filtered = filtered.filter((event) => event.kind === kind);
    }

    let start = 0;
    const before = typeof options?.before === 'string' ? options.before.trim() : '';
    if (before.length > 0) {
      const index = filtered.findIndex((event) => event.id === before);
      if (index >= 0) start = index + 1;
    }

    const page = filtered.slice(start, start + limit);
    const hasMore = start + page.length < filtered.length;
    return {
      events: page,
      nextBefore: hasMore && page.length > 0 ? page[page.length - 1].id : null,
      hasMore,
    };
  }

  /**
   * One page of Turns, newest first, with keyset pagination on turn id
   * (DESIGN-TURN-TRACE §2.2). Events are grouped by `turnId`, or by
   * `evt:<eventId>` for legacy events without one, then aggregated in memory
   * from the capped event list.
   * @param {{limit?: number, kind?: 'translate'|'lookup'|'error',
   *   status?: 'ok'|'partial'|'error', before?: string}} [options]
   * @returns {Promise<{turns: object[], nextBefore: string | null, hasMore: boolean}>}
   */
  async function turns(options = {}) {
    const ledger = await loadLedger();
    const limit = clampInt(options?.limit, DEFAULT_TURN_LIMIT, 1, LIMITS.usageTurnsMax);
    const groups = new Map();
    for (const event of ledger.events) {
      const key = typeof event.turnId === 'string' && event.turnId.length > 0
        ? event.turnId
        : `evt:${event.id}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [event]);
      else group.push(event);
    }
    let list = [];
    for (const [id, group] of groups) list.push(aggregateTurn(id, group));
    // Newest turn first; the sort is stable, so ties keep the ledger's
    // newest-first insertion order.
    list.sort((left, right) => right.startedAt - left.startedAt);

    const kind = typeof options?.kind === 'string' ? options.kind.trim() : '';
    if (kind === 'error') {
      list = list.filter((turn) => turn.status !== 'ok');
    } else if (USAGE_EVENT_KINDS.includes(kind)) {
      list = list.filter((turn) => turn.kind === kind || turn.kind === 'mixed');
    }
    const status = typeof options?.status === 'string' ? options.status.trim() : '';
    if (TURN_STATUSES.includes(status)) {
      list = list.filter((turn) => turn.status === status);
    }

    let start = 0;
    const before = typeof options?.before === 'string' ? options.before.trim() : '';
    if (before.length > 0) {
      const index = list.findIndex((turn) => turn.id === before);
      if (index >= 0) start = index + 1;
    }

    const page = list.slice(start, start + limit);
    const hasMore = start + page.length < list.length;
    return {
      turns: page,
      nextBefore: hasMore && page.length > 0 ? page[page.length - 1].id : null,
      hasMore,
    };
  }

  /**
   * Reset the ledger to an empty document and return the fresh summary.
   * @returns {Promise<object>}
   */
  async function clear() {
    await mutateLedger((ledger) => replaceLedger(ledger, emptyUsageLedger()));
    return summary({ days: DEFAULT_DAYS });
  }

  return { record, summary, events, turns, clear };
}
