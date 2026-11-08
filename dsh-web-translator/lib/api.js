/**
 * Host API facade for the dsh-web-translator plugin (DESIGN §5).
 *
 * Assembles the persistence, catalog, settings, wordbook and model collaborators
 * and exposes one method per endpoint. `index.js` only wires this facade to the
 * DSH web server through `lib/http.js`; every method returns a plain object that
 * the HTTP layer wraps in `{ok:true,...}`.
 */
import { join } from 'node:path';
import { createPersistentBatchCache, PERSISTENT_CACHE_VERSION } from './cache.js';
import { createCatalogService } from './catalog.js';
import {
  DEFAULTS,
  LIMITS,
  SETTINGS_VERSION,
  TARGET_LANGUAGES,
  USAGE_VERSION,
  WORDBOOK_VERSION,
} from './constants.js';
import { createConversationBridge, composeTitle } from './conversations.js';
import { createDictionaryLookup } from './dictionary.js';
import { apiError, isApiError } from './errors.js';
import {
  buildImagePrompt,
  cleanupImageAttachment,
  imageCacheKey,
  imageHash,
  normalizeImagePayload,
  parseImageTranslation,
} from './image.js';
import { callModel, resolveReasoningEffort } from './llm.js';
import {
  createSettingsService,
  effectiveSettings,
  normalizeSettingsPatch,
} from './settings.js';
import { createJsonStore, resolveDataDir, resolveDshHome } from './store.js';
import { createTranslateService } from './translate.js';
import { createUsageService } from './usage.js';
import { VERSION } from './version.js';
import {
  isPlainObject,
  normalizeHttpUrl,
  normalizeLanguageTag,
  normalizeLimit,
  normalizeOptionalString,
} from './validate.js';
import { createBallSitesService, BALL_SITES_VERSION } from './ball-sites.js';
import { createWordbookService } from './wordbook.js';

/** All four DSH usage buckets (DESIGN-TOKEN-USAGE §2.3). */
const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);

/** Deterministic `kinds` order of one `/conversations` row. */
const CONVERSATION_KIND_ORDER = Object.freeze(['translate', 'lookup', 'image']);

/** Default `GET /usage?days=` window. */
const DEFAULT_USAGE_DAYS = 14;

/** Default `GET /usage/events?limit=` page size. */
const DEFAULT_USAGE_EVENTS = 50;

/** Default `GET /usage/turns?limit=` page size (DESIGN-TURN-TRACE §2.2). */
const DEFAULT_USAGE_TURNS = LIMITS.usageTurnsDefault;

/** No-op logger used when the host does not hand one over (tests). */
const NULL_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/**
 * Wrap a host logger so a throwing logger can never break a request.
 * Cordis' `ctx.logger` is a callable service object, so both `function` and
 * `object` shapes are accepted.
 * @param {unknown} logger - `ctx.logger` or a test double.
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function normalizeLogger(logger) {
  if (logger === null || (typeof logger !== 'object' && typeof logger !== 'function')) return NULL_LOGGER;
  const safe = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    const method = logger[level];
    safe[level] = typeof method === 'function'
      ? (...args) => {
        try {
          method.apply(logger, args);
        } catch {
          // Diagnostics only.
        }
      }
      : () => {};
  }
  return safe;
}

/**
 * Normalize the configured extension-origin allowlist (empty = allow any
 * extension origin, per DESIGN §5).
 * @param {unknown} value - config value (array or comma-separated string).
 * @returns {string[]}
 */
function normalizeExtensionOrigins(value) {
  const list = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
    .filter((item) => item.length > 0);
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
 * Coerce an optional string field.
 * @param {unknown} value - raw value.
 * @param {number} [max] - character cap.
 * @returns {string | undefined}
 */
function optionalText(value, max = 200) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

/**
 * Coerce a required string field (provider/model are never omitted).
 * @param {unknown} value - raw value.
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value.slice(0, 200) : '';
}

/**
 * Truncate one result text for the event `outputPreview` field (no trimming:
 * the preview shows what the model returned; DESIGN-TURN-TRACE §2.1).
 * @param {unknown} value - result text.
 * @param {number} max - character cap.
 * @returns {string | undefined}
 */
function previewText(value, max) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, max);
}

/**
 * Validate the optional `stepIndex` turn field: an integer in
 * `0..LIMITS.stepIndexMax` (DESIGN-TURN-TRACE §2.3).
 * @param {unknown} value - raw body field.
 * @returns {number | undefined}
 */
function normalizeStepIndex(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > LIMITS.stepIndexMax) {
    throw apiError('BAD_REQUEST', `stepIndex must be an integer between 0 and ${LIMITS.stepIndexMax}`);
  }
  return value;
}

/**
 * Strict turn metadata of a translate/lookup body (DESIGN-TURN-TRACE §2.3):
 * every field is optional, but a present invalid field is a BAD_REQUEST.
 * @param {unknown} body - request body.
 * @returns {{turnId?: string, stepIndex?: number, mode?: string}}
 */
function normalizeTurnMeta(body) {
  const plain = isPlainObject(body) ? body : {};
  const turnId = normalizeOptionalString(plain.turnId, { field: 'turnId', max: LIMITS.turnIdChars });
  const stepIndex = normalizeStepIndex(plain.stepIndex);
  const mode = normalizeOptionalString(plain.mode, { field: 'mode', max: LIMITS.modeChars });
  const meta = {};
  if (turnId !== undefined) meta.turnId = turnId;
  if (stepIndex !== undefined) meta.stepIndex = stepIndex;
  if (mode !== undefined) meta.mode = mode;
  return meta;
}

/**
 * Best-effort turn metadata for a failure event: strict validation may have
 * rejected a sibling metadata field, so each turn field is read independently.
 * @param {unknown} body - request body.
 * @returns {{turnId?: string, stepIndex?: number, mode?: string}}
 */
function bestEffortTurnMeta(body) {
  const plain = isPlainObject(body) ? body : {};
  const meta = {};
  for (const [field, max] of [['turnId', LIMITS.turnIdChars], ['mode', LIMITS.modeChars]]) {
    try {
      const value = normalizeOptionalString(plain[field], { field, max });
      if (value !== undefined) meta[field] = value;
    } catch {
      // The request itself is already failing with BAD_REQUEST.
    }
  }
  try {
    const stepIndex = normalizeStepIndex(plain.stepIndex);
    if (stepIndex !== undefined) meta.stepIndex = stepIndex;
  } catch {
    // Same as above.
  }
  return meta;
}

/**
 * Validate/normalize a request language field for the ledger, best effort.
 * @param {unknown} value - raw body field.
 * @returns {string | undefined}
 */
function requestLanguage(value) {
  try {
    return normalizeLanguageTag(value, {});
  } catch {
    return undefined;
  }
}

/**
 * Validate the optional request metadata accepted by `POST /translate` and
 * `POST /lookup` (DESIGN-TOKEN-USAGE §2.3 item 4, DESIGN-TURN-TRACE §2.3).
 * @param {unknown} body - request body.
 * @returns {{sourceUrl?: string, sourceTitle?: string, client: string, site?: string,
 *   turnId?: string, stepIndex?: number, mode?: string}}
 */
function normalizeRequestMeta(body) {
  const plain = isPlainObject(body) ? body : {};
  const sourceUrl = normalizeHttpUrl(plain.sourceUrl, { field: 'sourceUrl' });
  const sourceTitle = normalizeOptionalString(plain.sourceTitle, {
    field: 'sourceTitle',
    max: LIMITS.sourceTitleChars,
  });
  const client = normalizeOptionalString(plain.client, {
    field: 'client',
    max: LIMITS.clientChars,
  }) ?? 'dsh';
  const meta = { client, ...normalizeTurnMeta(plain) };
  if (sourceUrl !== undefined) {
    meta.sourceUrl = sourceUrl;
    meta.site = siteOfUrl(sourceUrl);
  }
  if (sourceTitle !== undefined) meta.sourceTitle = sourceTitle;
  return meta;
}

/**
 * `sourceUrl` host for the ledger `site` column.
 * @param {string} sourceUrl - validated http(s) URL.
 * @returns {string | undefined}
 */
function siteOfUrl(sourceUrl) {
  try {
    return new URL(sourceUrl).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Error code for a failed invocation (ApiError code, else `INTERNAL`).
 * @param {unknown} error - caught value.
 * @returns {string}
 */
function errorCodeOf(error) {
  if (isApiError(error)) return error.code;
  return 'INTERNAL';
}

/**
 * Request-size fields shared by success and failure events.
 * @param {'translate'|'lookup'} kind - invocation kind.
 * @param {unknown} body - request body.
 * @returns {{segments: number, chars: number, sample?: string}}
 */
function describeRequest(kind, body) {
  const plain = isPlainObject(body) ? body : {};
  if (kind === 'lookup') {
    const text = typeof plain.text === 'string' ? plain.text : '';
    const sample = text.slice(0, LIMITS.eventSampleChars);
    return {
      segments: text.length > 0 ? 1 : 0,
      chars: text.length,
      ...(sample.length > 0 ? { sample } : {}),
    };
  }
  const texts = Array.isArray(plain.texts) ? plain.texts : [];
  let chars = 0;
  for (const text of texts) {
    if (typeof text === 'string') chars += text.length;
  }
  const first = texts.find((text) => typeof text === 'string' && text.length > 0);
  const sample = typeof first === 'string' ? first.slice(0, LIMITS.eventSampleChars) : '';
  return {
    segments: texts.length,
    chars,
    ...(sample.length > 0 ? { sample } : {}),
  };
}

/**
 * Common fields of one usage event (DESIGN-TOKEN-USAGE §2.1).
 * @param {'translate'|'lookup'} kind - invocation kind.
 * @param {unknown} body - request body.
 * @param {object} meta - validated request metadata.
 * @param {number} startedAt - epoch ms before the invocation.
 * @returns {object}
 */
function baseUsageEvent(kind, body, meta, startedAt) {
  const event = {
    kind,
    ok: false,
    provider: '',
    model: '',
    ...describeRequest(kind, body),
    cached: false,
    retries: 0,
    latencyMs: Math.max(0, Date.now() - startedAt),
    client: meta.client,
  };
  if (meta.turnId !== undefined) event.turnId = meta.turnId;
  if (meta.stepIndex !== undefined) event.stepIndex = meta.stepIndex;
  if (meta.mode !== undefined) event.mode = meta.mode;
  if (meta.sourceUrl !== undefined) event.sourceUrl = meta.sourceUrl;
  if (meta.sourceTitle !== undefined) event.sourceTitle = meta.sourceTitle;
  if (meta.site !== undefined) event.site = meta.site;
  const plain = isPlainObject(body) ? body : {};
  const targetLanguage = requestLanguage(plain.targetLanguage);
  if (targetLanguage !== undefined) event.targetLanguage = targetLanguage;
  const sourceLanguage = requestLanguage(plain.sourceLanguage);
  if (sourceLanguage !== undefined) event.sourceLanguage = sourceLanguage;
  for (const key of USAGE_KEYS) event[key] = 0;
  return event;
}

/**
 * Build the success event for one translate/lookup invocation.
 * @param {'translate'|'lookup'} kind - invocation kind.
 * @param {unknown} body - request body.
 * @param {object} meta - validated request metadata.
 * @param {object} result - service result.
 * @param {number} startedAt - epoch ms before the invocation.
 * @returns {object}
 */
function successUsageEvent(kind, body, meta, result, startedAt) {
  const event = baseUsageEvent(kind, body, meta, startedAt);
  event.ok = true;
  if (kind === 'lookup') {
    const lookupResult = isPlainObject(result?.result) ? result.result : {};
    event.provider = asString(lookupResult.provider);
    event.model = asString(lookupResult.model);
    const preview = previewText(lookupResult.translation, LIMITS.outputPreviewChars);
    if (preview !== undefined) event.outputPreview = preview;
  } else {
    event.provider = asString(result?.provider);
    event.model = asString(result?.model);
    const effort = optionalText(result?.reasoningEffort, 40);
    if (effort !== undefined && effort !== 'auto') event.reasoningEffort = effort;
    event.cached = result?.cached === true;
    const translations = Array.isArray(result?.translations) ? result.translations : [];
    const first = translations.find((value) => typeof value === 'string' && value.length > 0);
    const preview = previewText(first, LIMITS.outputPreviewChars);
    if (preview !== undefined) event.outputPreview = preview;
  }
  event.retries = toCount(result?.retries);
  for (const key of USAGE_KEYS) event[key] = toCount(result?.usage?.[key]);
  return event;
}

/**
 * Build the failure event for one translate/lookup invocation. Provider/model
 * are filled best effort from the already-resolved selection (DESIGN-TOKEN-
 * USAGE §2.3 item 3); tokens are zero because the call errored.
 * @param {'translate'|'lookup'} kind - invocation kind.
 * @param {unknown} body - request body.
 * @param {object} meta - validated request metadata (or empty when validation failed first).
 * @param {{provider?: string, model?: string, reasoningEffort?: string, targetLanguage?: string}} selection
 * @param {unknown} error - caught invocation error.
 * @param {number} startedAt - epoch ms before the invocation.
 * @returns {object}
 */
function failureUsageEvent(kind, body, meta, selection, error, startedAt) {
  // Metadata validation may itself have failed: keep a best-effort client and
  // best-effort turn metadata (DESIGN-TURN-TRACE §2.3).
  const rawClient = optionalText(isPlainObject(body) ? body.client : undefined, LIMITS.clientChars);
  const event = baseUsageEvent(
    kind,
    body,
    { client: rawClient ?? 'dsh', ...bestEffortTurnMeta(body), ...meta },
    startedAt,
  );
  event.ok = false;
  event.errorCode = errorCodeOf(error);
  event.provider = asString(selection?.provider);
  event.model = asString(selection?.model);
  const effort = optionalText(selection?.reasoningEffort, 40);
  if (event.reasoningEffort === undefined && effort !== undefined && effort !== 'auto') {
    event.reasoningEffort = effort;
  }
  const targetLanguage = requestLanguage(selection?.targetLanguage);
  if (event.targetLanguage === undefined && targetLanguage !== undefined) {
    event.targetLanguage = targetLanguage;
  }
  return event;
}


/**
 * Build the conversation-bridge round description for one invocation.
 * Conversation recording must never fail a translation, so this mirrors the
 * usage event fields instead of re-validating the request.
 * @param {'translate'|'lookup'} kind - invocation kind.
 * @param {unknown} body - request body.
 * @param {object} meta - validated request metadata.
 * @param {object|null} result - service result on success.
 * @param {unknown} error - caught invocation error on failure.
 * @param {{provider?: string, model?: string, reasoningEffort?: string, targetLanguage?: string}} selection
 * @param {boolean} ok - whether the invocation succeeded.
 * @returns {object|null}
 */
function conversationRound(kind, body, meta, result, error, selection, ok) {
  const plain = isPlainObject(body) ? body : {};
  const turnId = meta?.turnId ?? (typeof plain.turnId === 'string' ? plain.turnId : undefined);
  if (typeof turnId !== 'string' || turnId.trim().length === 0) return null;
  const round = {
    turnId,
    kind,
    ok,
    client: meta?.client,
    sourceUrl: meta?.sourceUrl,
    sourceTitle: meta?.sourceTitle,
    site: meta?.site,
    mode: meta?.mode,
  };
  const targetLanguage = meta?.targetLanguage ?? requestLanguage(plain.targetLanguage) ?? selection?.targetLanguage;
  if (targetLanguage !== undefined) round.targetLanguage = targetLanguage;
  if (kind === 'lookup') {
    round.text = typeof plain.text === 'string' ? plain.text : '';
    const context = typeof plain.context === 'string' ? plain.context : '';
    if (context.length > 0) round.context = context;
  } else {
    round.texts = Array.isArray(plain.texts) ? plain.texts.filter((text) => typeof text === 'string') : [];
  }
  if (ok && result !== null && typeof result === 'object') {
    round.provider = kind === 'lookup' ? result.result?.provider : result.provider;
    round.model = kind === 'lookup' ? result.result?.model : result.model;
    round.usage = result.usage;
    if (kind === 'lookup') {
      round.translation = isPlainObject(result.result) ? result.result.translation : undefined;
    } else {
      round.translations = Array.isArray(result.translations) ? result.translations : [];
    }
  } else {
    round.provider = selection?.provider;
    round.model = selection?.model;
    const failure = error !== null && typeof error === 'object' ? error : {};
    round.error = {
      code: typeof failure.code === 'string' ? failure.code : 'INTERNAL',
      message: typeof failure.message === 'string' ? failure.message : 'translation failed',
    };
  }
  const effort = selection?.reasoningEffort;
  if (typeof effort === 'string' && effort.length > 0 && effort !== 'auto') round.reasoningEffort = effort;
  return round;
}

/**
 * First non-empty string field among one conversation's usage events, oldest
 * round first (the ledger hands events out newest-first).
 * @param {object[]} events - normalized usage events.
 * @param {string} field - event field name.
 * @returns {string | undefined}
 */
function firstEventText(events, field) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = events[index]?.[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Merge the usage-ledger events of one native conversation (and its live bridge
 * row when it is still live) into one `GET /conversations` row
 * (DESIGN-CONVERSATIONS §2).
 * @param {string} sessionId - native DSH session id.
 * @param {object[]} events - ledger events carrying that `sessionId` (newest first).
 * @param {object} [liveRow] - matching row from the conversation bridge.
 * @returns {object}
 */
function conversationRow(sessionId, events, liveRow) {
  const buckets = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const kindSet = new Set();
  let ok = 0;
  let errors = 0;
  let cached = 0;
  let firstAt = 0;
  let lastAt = 0;
  for (const event of events) {
    if (event.ok === true) ok += 1;
    else errors += 1;
    if (event.cached === true) cached += 1;
    for (const key of USAGE_KEYS) buckets[key] += toCount(event[key]);
    kindSet.add(event.kind === 'lookup' ? 'lookup' : event.kind === 'image' ? 'image' : 'translate');
    const at = toCount(event.at);
    if (at > 0 && (firstAt === 0 || at < firstAt)) firstAt = at;
    if (at > lastAt) lastAt = at;
  }
  const kinds = CONVERSATION_KIND_ORDER.filter((kind) => kindSet.has(kind));
  const sourceTitle = firstEventText(events, 'sourceTitle');
  const site = firstEventText(events, 'site');
  const model = firstEventText(events, 'model');
  const turnId = (liveRow !== undefined ? liveRow.turnId : undefined) ?? firstEventText(events, 'turnId');
  const status = errors === 0 ? 'ok' : ok > 0 ? 'partial' : 'error';
  const createdAt = liveRow !== undefined && Number.isFinite(liveRow.createdAt) ? liveRow.createdAt : firstAt;
  const lastAtLive = liveRow !== undefined && Number.isFinite(liveRow.lastAt) ? liveRow.lastAt : 0;
  const liveTurns = liveRow !== undefined && Number.isFinite(liveRow.turns) ? toCount(liveRow.turns) : 0;
  const row = {
    sessionId,
    title: liveRow?.title ?? composeTitle({ kind: kinds.length === 1 ? kinds[0] : 'translate', sourceTitle, site }),
    turns: Math.max(liveTurns, events.length),
    requests: events.length,
    ok,
    errors,
    cached,
    status,
    kinds,
    createdAt,
    firstAt: firstAt > 0 ? firstAt : createdAt,
    lastAt: Math.max(lastAtLive, lastAt, createdAt),
    live: liveRow !== undefined,
    ...buckets,
  };
  if (turnId !== undefined) row.turnId = turnId;
  if (sourceTitle !== undefined) row.sourceTitle = sourceTitle;
  if (site !== undefined) row.site = site;
  if (model !== undefined) row.model = model;
  return row;
}

/**
 * Build the host API facade.
 * @param {{ctx?: object, config?: object, logger?: object, dataDir?: string,
 *   fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number,
 *   dictionaryTimeoutMs?: number, attachments?: object,
 *   imageCacheDir?: string}} [options] - host context and test seams.
 * @returns {object} API facade consumed by `createHttpHandler`.
 */
export function createApi({
  ctx,
  config = {},
  logger,
  dataDir,
  fetchImpl,
  now = Date.now,
  timeoutMs,
  dictionaryTimeoutMs,
  attachments,
  imageCacheDir,
} = {}) {
  const log = normalizeLogger(logger ?? ctx?.logger);
  const clock = typeof now === 'function' ? now : () => Number(now) || Date.now();
  const directory = typeof dataDir === 'string' && dataDir.length > 0 ? dataDir : resolveDataDir();
  const imageVariantCacheDir = typeof imageCacheDir === 'string' && imageCacheDir.length > 0
    ? imageCacheDir
    : join(resolveDshHome(), 'cache', 'attachments', 'request-images');
  const startedAt = Date.now();

  const settingsStore = createJsonStore(join(directory, 'settings.json'), {
    defaultValue: () => ({ version: SETTINGS_VERSION, settings: {}, updatedAt: 0 }),
    logger: log,
  });
  const wordbookStore = createJsonStore(join(directory, 'wordbook.json'), {
    defaultValue: () => ({ version: WORDBOOK_VERSION, items: [], updatedAt: 0 }),
    logger: log,
  });
  const ballSitesStore = createJsonStore(join(directory, 'ball-sites.json'), {
    defaultValue: () => ({ version: BALL_SITES_VERSION, sites: [], updatedAt: 0 }),
    logger: log,
  });
  const usageStore = createJsonStore(join(directory, 'usage.json'), {
    defaultValue: () => ({ version: USAGE_VERSION }),
    logger: log,
  });
  const cacheStore = createJsonStore(join(directory, 'cache.json'), {
    defaultValue: () => ({ v: PERSISTENT_CACHE_VERSION, savedAt: 0, entries: {} }),
    logger: log,
  });
  const catalog = createCatalogService({ ctx, logger: log, now: clock });
  const settingsService = createSettingsService({ store: settingsStore, logger: log, now: clock });
  /** 是否记录翻译历史（token 统计/轨迹 + DSH 原生会话）；由 settings.recordHistory 控制。 */
  let recordHistoryEnabled = true;
  const recordHistoryReady = settingsService
    .loadSaved()
    .then((saved) => {
      recordHistoryEnabled = saved.recordHistory !== false;
    })
    .catch(() => {
      recordHistoryEnabled = true;
    });
  /** 等待启动时读取的记录开关（只读一次，保存设置时同步更新）。 */
  async function recordingEnabled() {
    try {
      await recordHistoryReady;
    } catch {
      /* fall back to the current value */
    }
    return recordHistoryEnabled;
  }
  const cache = createPersistentBatchCache({
    store: cacheStore,
    max: LIMITS.translationCacheEntries,
    ttlMs: LIMITS.translationCacheTtlMs,
    now: clock,
    logger: log,
  });
  // Load the previous process' cache in the background; requests await
  // `cache.whenReady()` so a restart can hit disk without delaying startup.
  void cache.hydrate();
  const dictionary = createDictionaryLookup({
    fetchImpl,
    logger: log,
    timeoutMs: dictionaryTimeoutMs,
    resolveProvider: async () => {
      const effective = await getEffective();
      return effective.settings.dictionaryProvider;
    },
  });
  const wordbook = createWordbookService({ store: wordbookStore, logger: log, now: clock });
  const ballSites = createBallSitesService({ store: ballSitesStore, now: clock });
  const usageService = createUsageService({ store: usageStore, now: clock, logger: log });
  const conversations = createConversationBridge({ ctx, dataDir: directory, logger: log, now: clock });
  // Release live conversation agents with the plugin fiber; their Sessions stay persisted.
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => conversations.dispose(), 'dsh-web-translator: translation conversations');
    } catch {
      // Optional lifecycle seam (tests mount createApi without a full ctx).
    }
  }
  // Persist the translation cache when the plugin unloads (best effort: the
  // in-flight write must never delay or fail plugin teardown).
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        void cache.flush();
      }, 'dsh-web-translator: translation cache flush');
    } catch {
      // Optional lifecycle seam (tests mount createApi without a full ctx).
    }
  }
  // Group existing translation conversations under the「dsh翻译记录」workspace on
  // startup when the ledger already contains conversation-backed events; a
  // fresh profile creates the group lazily with its first conversation.
  Promise.resolve()
    .then(async () => {
      try {
        const page = await usageService.events({ limit: 500 });
        const events = Array.isArray(page?.events) ? page.events : [];
        const hasHistory = events.some(
          (event) => typeof event?.sessionId === 'string' && event.sessionId.length > 0,
        );
        if (hasHistory) await conversations.ensureWorkspace();
      } catch (error) {
        try {
          log.debug?.(`[dsh-web-translator] conversations: workspace bootstrap skipped: ${error instanceof Error ? error.message : String(error)}`);
        } catch {
          // Diagnostics only.
        }
      }
    })
    .catch(() => {});
  const translateService = createTranslateService({
    resolveSelection,
    cache,
    logger: log,
    dictionary,
    timeoutMs,
  });

  /**
   * Effective settings plus the DSH default selection they may inherit.
   * @returns {Promise<{settings: object, source: 'settings'|'default',
   *   defaultSelection: {provider: string, model: string, reasoningEffort?: string}}>}
   */
  async function getEffective() {
    const [saved, defaultSelection] = await Promise.all([
      settingsService.loadSaved(),
      catalog.getDefaultSelection(),
    ]);
    const effective = effectiveSettings(saved, defaultSelection);
    return { ...effective, defaultSelection };
  }

  /**
   * Resolve the provider/model/effort actually used by a model call.
   * `resolveModelInfo` failure degrades (no effort, default token estimate)
   * instead of blocking the call.
   * @returns {Promise<object>}
   */
  async function resolveSelection() {
    const effective = await getEffective();
    const settings = effective.settings;
    const provider = typeof settings.provider === 'string' ? settings.provider : '';
    const model = typeof settings.model === 'string' ? settings.model : '';
    if (provider.length === 0 || model.length === 0) {
      throw apiError('MODEL_UNAVAILABLE', 'no translation model is configured');
    }
    const llm = catalog.requireLlm();
    const resolved = await catalog.resolveModelInfoSafe(provider, model);
    const modelInfo = resolved.info ?? null;
    if (resolved.error !== undefined) {
      log.debug(`model info unavailable for ${provider}/${model}: ${resolved.error instanceof Error ? resolved.error.message : String(resolved.error)}`);
    }
    const planned = resolveReasoningEffort(settings.reasoningEffort, modelInfo?.reasoningEfforts ?? []);
    return {
      llm,
      provider,
      model,
      reasoningEffort: planned.effort,
      modelInfo,
      settings,
      source: effective.source,
    };
  }

  /**
   * Best-effort selection for a failed invocation: never throws and never adds
   * a new failure path (DESIGN-TOKEN-USAGE §2.3 item 3).
   * @returns {Promise<{provider: string, model: string, reasoningEffort?: string,
   *   targetLanguage?: string}>}
   */
  async function bestEffortSelection() {
    try {
      const selection = await resolveSelection();
      const settings = selection.settings ?? {};
      return {
        provider: typeof selection.provider === 'string' ? selection.provider : '',
        model: typeof selection.model === 'string' ? selection.model : '',
        reasoningEffort: selection.reasoningEffort,
        targetLanguage: settings.targetLanguage,
      };
    } catch {
      return { provider: '', model: '', reasoningEffort: undefined, targetLanguage: undefined };
    }
  }

  /**
   * Image-attachment service (optional host capability).
   * @returns {object | null}
   */
  function getAttachments() {
    if (attachments !== undefined && attachments !== null) return attachments;
    try {
      if (ctx && typeof ctx.get === 'function') return ctx.get('attachments') ?? null;
      return ctx?.attachments ?? null;
    } catch {
      return null;
    }
  }

  /** @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}} */
  function zeroUsage() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }

  /**
   * First catalog model declaring image input (used when the translation model
   * is text-only and the user left `imageModel` on "auto").
   * @returns {Promise<{provider: string, model: string} | null>}
   */
  async function findImageCapableModel() {
    try {
      const tree = await catalog.getCatalog();
      for (const provider of Array.isArray(tree?.providers) ? tree.providers : []) {
        for (const model of Array.isArray(provider?.models) ? provider.models : []) {
          if (Array.isArray(model?.inputModalities) && model.inputModalities.includes('image')) {
            return { provider: provider.provider, model: model.id };
          }
        }
      }
    } catch {
      // Fall through to the explicit MODEL_NO_VISION failure.
    }
    return null;
  }

  /**
   * Resolve the model used for one image translation: settings.imageModel
   * ("auto" follows the current translation model) must accept image input.
   * @returns {Promise<{llm: object, provider: string, model: string,
   *   reasoningEffort?: string, modelInfo: object, settings: object}>}
   */
  async function resolveImageSelection() {
    const effective = await getEffective();
    const settings = effective.settings;
    const configured = typeof settings.imageModel === 'string' && settings.imageModel !== 'auto'
      ? settings.imageModel
      : '';
    let provider = '';
    let model = '';
    if (configured.length > 0) {
      const separator = configured.indexOf('::');
      provider = configured.slice(0, separator);
      model = configured.slice(separator + 2);
    } else {
      provider = typeof settings.provider === 'string' ? settings.provider : '';
      model = typeof settings.model === 'string' ? settings.model : '';
    }

    const imageInfo = async (candidateProvider, candidateModel) => {
      if (candidateProvider.length === 0 || candidateModel.length === 0) return null;
      const resolved = await catalog.resolveModelInfoSafe(candidateProvider, candidateModel);
      const info = resolved.info ?? null;
      return info !== null && Array.isArray(info.inputModalities) && info.inputModalities.includes('image')
        ? info
        : null;
    };

    let info = await imageInfo(provider, model);
    if (info === null) {
      if (configured.length > 0) {
        throw apiError('MODEL_NO_VISION', `the configured image model does not accept image input`);
      }
      const candidate = await findImageCapableModel();
      if (candidate === null) {
        throw apiError('MODEL_NO_VISION', 'no image-capable model is configured; pick one in Settings');
      }
      provider = candidate.provider;
      model = candidate.model;
      info = await imageInfo(provider, model);
      if (info === null) throw apiError('MODEL_UNAVAILABLE', 'the image-capable model could not be resolved');
    }
    const llm = catalog.requireLlm();
    const planned = resolveReasoningEffort(settings.reasoningEffort, info.reasoningEfforts ?? []);
    return { llm, provider, model, reasoningEffort: planned.effort, modelInfo: info, settings };
  }

  /**
   * Map one attachment-service failure to the image API envelope.
   * @param {unknown} error - caught value.
   * @returns {import('./errors.js').ApiError}
   */
  function mapImageAttachmentError(error) {
    if (isApiError(error)) return error;
    const detail = error instanceof Error && error.message.length > 0 ? error.message.slice(0, 300) : 'image attachment rejected';
    if (/TOO_LARGE|EXCEED|MAX_BYTES|MAX_PIXEL/iu.test(detail)) return apiError('IMAGE_TOO_LARGE', detail);
    if (/FORMAT|TYPE|UNSUPPORTED|DECODE/iu.test(detail)) return apiError('IMAGE_UNSUPPORTED', detail);
    return apiError('IMAGE_INVALID', detail);
  }

  /**
   * Build the success usage event for one image translation.
   * @returns {object}
   */
  function imageSuccessUsageEvent(body, meta, result, usage, cached, startedAt) {
    const event = baseUsageEvent('image', body, meta ?? {}, startedAt);
    event.ok = true;
    event.provider = asString(result?.provider);
    event.model = asString(result?.model);
    event.cached = cached === true;
    const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
    event.segments = blocks.length;
    let chars = 0;
    let sample;
    let preview;
    for (const block of blocks) {
      const text = typeof block?.text === 'string' ? block.text : '';
      chars += text.length;
      if (sample === undefined && text.length > 0) sample = text;
      if (preview === undefined && typeof block?.translation === 'string' && block.translation.length > 0) {
        preview = block.translation;
      }
    }
    event.chars = chars;
    if (sample !== undefined) event.sample = sample.slice(0, LIMITS.eventSampleChars);
    if (preview !== undefined) event.outputPreview = previewText(preview, LIMITS.outputPreviewChars);
    if (typeof result?.targetLanguage === 'string' && result.targetLanguage.length > 0) {
      event.targetLanguage = result.targetLanguage;
    }
    event.retries = 0;
    for (const key of USAGE_KEYS) event[key] = toCount(usage?.[key]);
    return event;
  }

  /**
   * Build the failure usage event for one image translation.
   * @returns {object}
   */
  function imageFailureUsageEvent(body, meta, selection, error, startedAt) {
    const event = baseUsageEvent('image', body, meta ?? {}, startedAt);
    event.ok = false;
    event.errorCode = errorCodeOf(error);
    event.provider = asString(selection?.provider);
    event.model = asString(selection?.model);
    return event;
  }

  /**
   * Build the conversation round of one image translation.
   * @returns {object | null}
   */
  function imageConversationRound(body, meta, selection, result, error, ok, usage) {
    const plain = isPlainObject(body) ? body : {};
    const turnId = meta?.turnId ?? (typeof plain.turnId === 'string' ? plain.turnId : undefined);
    if (typeof turnId !== 'string' || turnId.trim().length === 0) return null;
    const round = {
      turnId,
      kind: 'image',
      ok,
      client: meta?.client,
      sourceUrl: meta?.sourceUrl,
      sourceTitle: meta?.sourceTitle,
      site: meta?.site,
    };
    if (ok) {
      const blocks = Array.isArray(result?.blocks) ? result.blocks : [];
      round.provider = asString(result?.provider);
      round.model = asString(result?.model);
      round.usage = usage;
      round.translations = blocks.map((block) => (typeof block?.translation === 'string' ? block.translation : ''));
      if (typeof result?.targetLanguage === 'string' && result.targetLanguage.length > 0) {
        round.targetLanguage = result.targetLanguage;
      }
    } else {
      round.provider = asString(selection?.provider);
      round.model = asString(selection?.model);
      const failure = error !== null && typeof error === 'object' ? error : {};
      round.error = {
        code: typeof failure.code === 'string' ? failure.code : 'INTERNAL',
        message: typeof failure.message === 'string' ? failure.message : 'image translation failed',
      };
    }
    const effort = selection?.reasoningEffort;
    if (typeof effort === 'string' && effort.length > 0 && effort !== 'auto') round.reasoningEffort = effort;
    return round;
  }

  /**
   * Persist one usage event; a ledger failure is logged and swallowed so it can
   * never turn a translation into an error (DESIGN-TOKEN-USAGE §2.3 item 3).
   * @param {object} event - event fields.
   * @returns {Promise<void>}
   */
  async function recordUsage(event) {
    try {
      await usageService.record(event);
    } catch (error) {
      log.warn(`[dsh-web-translator] usage: dropped event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Run one translate/lookup invocation and record exactly one usage event for
   * its completion or failure. Recording never masks the original error.
   * @param {'translate'|'lookup'} kind - invocation kind.
   * @param {unknown} body - request body (metadata validated here first).
   * @param {() => Promise<object>} run - decorated service call.
   * @returns {Promise<object>}
   */
  async function withUsage(kind, body, run) {
    const record = await recordingEnabled();
    const startedAt = Date.now();
    let meta;
    try {
      meta = normalizeRequestMeta(body);
    } catch (error) {
      if (record) {
        const selection = await bestEffortSelection();
        const event = failureUsageEvent(kind, body, {}, selection, error, startedAt);
        await recordConversation(kind, body, {}, null, error, selection, event, false);
        await recordUsage(event);
      }
      throw error;
    }
    let result;
    try {
      result = await run();
    } catch (error) {
      if (record) {
        const selection = await bestEffortSelection();
        const event = failureUsageEvent(kind, body, meta, selection, error, startedAt);
        await recordConversation(kind, body, meta, null, error, selection, event, false);
        await recordUsage(event);
      }
      throw error;
    }
    if (record) {
      const event = successUsageEvent(kind, body, meta, result, startedAt);
      await recordConversation(kind, body, meta, result, null, null, event, true);
      await recordUsage(event);
    }
    return result;
  }

  /**
   * Record one native DSH conversation turn for the request when the caller
   * supplied a conversation turn id. Never throws: a bridge failure only
   * removes the native trajectory link, keeping the ledger row (DESIGN-
   * CONVERSATIONS.md §2).
   * @param {'translate'|'lookup'} kind - invocation kind.
   * @param {unknown} body - request body.
   * @param {object} meta - validated request metadata.
   * @param {object|null} result - service result on success.
   * @param {unknown} error - caught invocation error on failure.
   * @param {object|null} selection - resolved model selection (failure path).
   * @param {object} event - usage event to enrich with `sessionId`/`turn`.
   * @param {boolean} ok - whether the invocation succeeded.
   * @returns {Promise<void>}
   */
  async function recordConversation(kind, body, meta, result, error, selection, event, ok) {
    try {
      const round = conversationRound(kind, body, meta, result, error, selection, ok);
      if (round === null) return;
      const recorded = await conversations.recordTurn(round);
      if (recorded !== null) {
        event.sessionId = recorded.sessionId;
        event.turn = recorded.turn;
      }
    } catch (bridgeError) {
      log.warn(`[dsh-web-translator] conversations: round dropped: ${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)}`);
    }
  }

  /**
   * `GET /usage?days=` (DESIGN-TOKEN-USAGE §2.3): the aggregated ledger.
   * @param {{days?: unknown}} [query] - query parameters.
   * @returns {Promise<{usage: object}>}
   */
  async function getUsage(query = {}) {
    const days = normalizeLimit(query?.days, {
      fallback: DEFAULT_USAGE_DAYS,
      min: 1,
      max: LIMITS.usageDays,
    });
    return { usage: await usageService.summary({ days }) };
  }

  /**
   * `GET /usage/events?limit=&kind=&before=` (DESIGN-TOKEN-USAGE §2.3).
   * @param {{limit?: unknown, kind?: unknown, before?: unknown}} [query] - query parameters.
   * @returns {Promise<{events: object[], nextBefore: string | null, hasMore: boolean}>}
   */
  async function listUsageEvents(query = {}) {
    return usageService.events({
      limit: normalizeLimit(query?.limit, {
        fallback: DEFAULT_USAGE_EVENTS,
        min: 1,
        max: LIMITS.usageEvents,
      }),
      kind: typeof query?.kind === 'string' && query.kind.trim().length > 0
        ? query.kind.trim()
        : undefined,
      before: typeof query?.before === 'string' && query.before.trim().length > 0
        ? query.before.trim()
        : undefined,
    });
  }

  /**
   * `GET /usage/turns?limit=&kind=&status=&before=` (DESIGN-TURN-TRACE §2.3):
   * the per-Turn aggregation used by the 「轨迹」 tab.
   * @param {{limit?: unknown, kind?: unknown, status?: unknown, before?: unknown}} [query] - query parameters.
   * @returns {Promise<{turns: object[], nextBefore: string | null, hasMore: boolean}>}
   */
  async function getUsageTurns(query = {}) {
    const options = {
      limit: normalizeLimit(query?.limit, {
        fallback: DEFAULT_USAGE_TURNS,
        min: 1,
        max: LIMITS.usageTurnsMax,
      }),
    };
    for (const field of ['kind', 'status', 'before']) {
      const value = query?.[field];
      if (typeof value === 'string' && value.trim().length > 0) options[field] = value.trim();
    }
    return usageService.turns(options);
  }

  /**
   * `GET /conversations` (DESIGN-CONVERSATIONS §2): live translation
   * conversations merged with historical ones derived from the usage ledger's
   * `sessionId`s, newest first.
   * @returns {Promise<{conversations: object[]}>}
   */
  async function listConversations() {
    let ledgerEvents = [];
    try {
      const page = await usageService.events({ limit: LIMITS.usageEvents });
      ledgerEvents = Array.isArray(page?.events) ? page.events : [];
    } catch (error) {
      log.debug(`conversations: usage ledger unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const groups = new Map();
    for (const event of ledgerEvents) {
      const sessionId = typeof event?.sessionId === 'string' && event.sessionId.length > 0 ? event.sessionId : '';
      if (sessionId.length === 0) continue;
      const group = groups.get(sessionId);
      if (group === undefined) groups.set(sessionId, [event]);
      else group.push(event);
    }
    const liveRows = conversations.list();
    const liveBySession = new Map();
    for (const row of liveRows) liveBySession.set(row.sessionId, row);
    const rows = [];
    const seen = new Set();
    for (const [sessionId, events] of groups) {
      seen.add(sessionId);
      rows.push(conversationRow(sessionId, events, liveBySession.get(sessionId)));
    }
    for (const liveRow of liveRows) {
      if (seen.has(liveRow.sessionId)) continue;
      seen.add(liveRow.sessionId);
      rows.push(conversationRow(liveRow.sessionId, [], liveRow));
    }
    rows.sort((left, right) => (
      right.lastAt - left.lastAt
      || right.createdAt - left.createdAt
      || left.sessionId.localeCompare(right.sessionId)
    ));
    return { conversations: rows };
  }

  /**
   * Await the startup hydration before the first translation batch lookup so a
   * restart still serves persisted translations with zero model calls.
   * @param {() => Promise<object>} run - the translation invocation.
   * @returns {Promise<object>}
   */
  async function withCacheReady(run) {
    try {
      await cache.whenReady();
    } catch {
      // Cache readiness must never block a translation.
    }
    return run();
  }

  /**
   * `DELETE /cache` (DESIGN-CACHE §3): clear the persistent translation cache.
   * @returns {Promise<{cleared: true, entries: number}>}
   */
  async function clearCache() {
    await cache.clear();
    return { cleared: true, entries: cache.stats().entries };
  }

  /**
   * `DELETE /usage` (DESIGN-TOKEN-USAGE §2.3): reset the ledger.
   * @returns {Promise<{cleared: true, usage: object}>}
   */
  async function clearUsage() {
    const usage = await usageService.clear();
    return { cleared: true, usage };
  }

  /**
   * `DELETE /records`：清理全部翻译记录。
   * 清空 usage 账本，并让 conversations 桥把「dsh翻译记录」里的会话从侧边栏
   * 归档/移出分组、停止 live 会话（DSH 不提供删除会话 API）。
   * @returns {Promise<{cleared: true, usage: object, conversations: object}>}
   */
  async function clearRecords() {
    let conversationResult = { sessions: 0, archived: 0 };
    try {
      conversationResult = await conversations.clearRecords();
    } catch (error) {
      log.warn(`[dsh-web-translator] records: conversation cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const usage = await usageService.clear();
    return { cleared: true, usage, conversations: conversationResult };
  }

  /**
   * `GET /health` (DESIGN §5.1): LLM counts never block the response.
   * @returns {Promise<object>}
   */
  async function health() {
    let providers = 0;
    let models = 0;
    try {
      const counts = await catalog.getCounts();
      providers = counts.providers;
      models = counts.models;
    } catch (error) {
      log.debug(`health: model counts unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      version: VERSION,
      uptimeMs: Math.max(0, Date.now() - startedAt),
      llm: { providers, models },
    };
  }

  /**
   * `GET /models` (DESIGN §5.2).
   * @returns {Promise<object>}
   */
  async function listModels() {
    const [catalogData, defaultSelection] = await Promise.all([
      catalog.getCatalog(),
      catalog.getDefaultSelection(),
    ]);
    return { catalog: catalogData.providers, defaultSelection };
  }

  /**
   * `GET /models/resolve` (DESIGN §5.3).
   * @param {string} provider - provider route.
   * @param {string} model - model id.
   * @returns {Promise<object>}
   */
  async function resolveModel(provider, model) {
    const info = await catalog.resolveModelInfo(provider, model);
    return { model: info };
  }

  /**
   * `GET /settings` (DESIGN §5.4, plus additive `catalog`/`targetLanguages`).
   * @returns {Promise<object>}
   */
  async function getSettings() {
    const effective = await getEffective();
    const settings = effective.settings;
    const provider = typeof settings.provider === 'string' ? settings.provider : '';
    const model = typeof settings.model === 'string' ? settings.model : '';
    const resolved = provider.length > 0 && model.length > 0
      ? await catalog.resolveModelInfoSafe(provider, model)
      : {};
    const modelInfo = resolved.info ?? {
      provider,
      model,
      name: model,
      reasoningEfforts: [],
      contextWindow: 0,
      maxTokens: 0,
    };
    const planned = resolveReasoningEffort(settings.reasoningEffort, modelInfo.reasoningEfforts ?? []);
    const defaults = {
      ...DEFAULTS,
      provider: effective.defaultSelection.provider || '',
      model: effective.defaultSelection.model || '',
    };
    const response = {
      settings,
      defaults,
      selected: {
        provider,
        model,
        reasoningEffort: planned.effort ?? 'auto',
        source: effective.source,
      },
      modelInfo,
      targetLanguages: [...TARGET_LANGUAGES],
    };
    try {
      response.catalog = (await catalog.getCatalog()).providers;
    } catch (error) {
      log.debug(`settings: model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return response;
  }

  /**
   * `PUT /settings` (DESIGN §5.5).
   * @param {unknown} body - request body.
   * @returns {Promise<object>} the same shape as `GET /settings`.
   */
  async function putSettings(body) {
    const { values, warnings } = normalizeSettingsPatch(body);
    for (const warning of warnings) log.warn(`[dsh-web-translator] settings warning: ${warning}`);
    const touchedModel = Object.hasOwn(values, 'provider') || Object.hasOwn(values, 'model');
    if (touchedModel) {
      // provider/model are one choice: merge with the saved pair, require both,
      // then verify the pair exists in the live catalog (DESIGN §5.5).
      const saved = await settingsService.loadSaved();
      const provider = Object.hasOwn(values, 'provider') ? values.provider : saved.provider;
      const model = Object.hasOwn(values, 'model') ? values.model : saved.model;
      if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
        throw apiError('INVALID_SETTINGS', 'provider and model must be configured together');
      }
      await catalog.assertModelExists(provider, model);
    }
    if (Object.hasOwn(values, 'imageModel') && typeof values.imageModel === 'string' && values.imageModel !== 'auto') {
      const separator = values.imageModel.indexOf('::');
      const imageProvider = values.imageModel.slice(0, separator);
      const imageModel = values.imageModel.slice(separator + 2);
      try {
        await catalog.assertModelExists(imageProvider, imageModel);
        const info = await catalog.resolveModelInfo(imageProvider, imageModel);
        if (!Array.isArray(info.inputModalities) || !info.inputModalities.includes('image')) {
          throw apiError('INVALID_SETTINGS', 'imageModel must accept image input');
        }
      } catch (error) {
        if (isApiError(error) && error.code === 'INVALID_SETTINGS') throw error;
        throw apiError('INVALID_SETTINGS', error instanceof Error ? error.message.slice(0, 300) : 'invalid imageModel');
      }
    }
    const saved = await settingsService.save(values);
    recordHistoryEnabled = saved.recordHistory !== false;
    return getSettings();
  }

  /**
   * `POST /image-translate`: OCR + translate one image and discard the image.
   *
   * The image is saved only to build one model request; the durable attachment
   * and its request variants are deleted after the call (DESIGN-IMAGE §4).
   * Results are cached by image digest + model + target language, so a repeated
   * image never stores or uploads the image again.
   * @param {unknown} body - request body.
   * @param {{signal?: AbortSignal}} [options] - caller abort signal.
   * @returns {Promise<{result: object, usage: object, retries: number}>}
   */
  async function imageTranslateInner(body, { signal } = {}) {
    const startedAt = Date.now();
    const record = await recordingEnabled();
    let meta;
    let selection;
    let result;
    let usage = zeroUsage();
    let cached = false;
    let failure = null;
    try {
      meta = normalizeRequestMeta(body);
      const plain = isPlainObject(body) ? body : {};
      if (!isPlainObject(plain.image)) throw apiError('IMAGE_INVALID', 'image is required');
      const image = normalizeImagePayload(plain.image);
      const hash = imageHash(image.bytes);
      selection = await resolveImageSelection();
      const settings = selection.settings ?? {};
      const targetLanguage = normalizeLanguageTag(plain.targetLanguage, { allowed: TARGET_LANGUAGES })
        ?? settings.targetLanguage;
      if (typeof targetLanguage !== 'string' || targetLanguage.length === 0) {
        throw apiError('INTERNAL', 'the effective target language is missing');
      }
      const style = typeof settings.translationStyle === 'string' ? settings.translationStyle : 'auto';
      const cacheKey = imageCacheKey({
        hash,
        provider: selection.provider,
        model: selection.model,
        targetLanguage,
        translationStyle: style,
      });
      await cache.whenReady();
      let blocks;
      let fallback = false;
      const cachedPayload = cache.get(cacheKey);
      if (Array.isArray(cachedPayload) && cachedPayload.length > 0) {
        try {
          const parsed = JSON.parse(cachedPayload[0]);
          if (Array.isArray(parsed?.blocks)) {
            blocks = parsed.blocks;
            fallback = parsed.fallback === true;
            cached = true;
          }
        } catch {
          blocks = undefined;
        }
      }
      if (blocks === undefined) {
        const attachmentService = getAttachments();
        if (attachmentService === null || typeof attachmentService.saveImage !== 'function') {
          throw apiError('MODEL_UNAVAILABLE', 'the DSH image attachment service is unavailable');
        }
        const prompt = buildImagePrompt({
          targetLanguage,
          sourceTitle: meta.sourceTitle,
          site: meta.site,
          translationStyle: style,
        });
        const callStartedAt = Date.now();
        let ref;
        try {
          try {
            ref = await attachmentService.saveImage({
              data: image.bytes,
              mediaType: image.mediaType,
              name: 'image-translate',
            });
          } catch (error) {
            throw mapImageAttachmentError(error);
          }
          const options = {
            provider: selection.provider,
            model: selection.model,
            system: prompt.system,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt.user },
                { type: 'image', attachment: ref },
              ],
            }],
            temperature: 0.2,
            maxTokens: LIMITS.imageMaxTokens,
          };
          if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
            options.reasoningEffort = selection.reasoningEffort;
          }
          const call = await callModel({
            llm: selection.llm,
            options,
            timeoutMs: LIMITS.imageTimeoutMs,
            signal,
            logger: log,
          });
          usage = call.usage;
          const parsed = parseImageTranslation(call.text);
          blocks = parsed.blocks;
          fallback = parsed.fallback;
          cache.set(cacheKey, [JSON.stringify({ blocks, fallback })]);
        } finally {
          if (ref !== undefined) {
            await cleanupImageAttachment({
              attachments: attachmentService,
              ref,
              cacheDir: imageVariantCacheDir,
              startedAt: callStartedAt,
              logger: log,
            });
          }
        }
      }
      result = {
        blocks,
        provider: selection.provider,
        model: selection.model,
        cached,
        fallback,
        imageHash: hash,
        targetLanguage,
      };
      return { result, usage, retries: 0 };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (record) {
        try {
          const eventMeta = meta ?? { client: 'dsh', ...bestEffortTurnMeta(body) };
          const event = failure === null
            ? imageSuccessUsageEvent(body, eventMeta, result, usage, cached, startedAt)
            : imageFailureUsageEvent(body, eventMeta, selection, failure, startedAt);
          const round = imageConversationRound(body, eventMeta, selection, result, failure, failure === null, usage);
          if (round !== null) {
            const recorded = await conversations.recordTurn(round);
            if (recorded !== null) {
              event.sessionId = recorded.sessionId;
              event.turn = recorded.turn;
            }
          }
          await recordUsage(event);
        } catch (error) {
          try {
            log.debug(`image usage recording failed: ${error instanceof Error ? error.message : String(error)}`);
          } catch {
            // Diagnostics only.
          }
        }
      }
    }
  }

  /** Serialize image translations so cleanup never races another image request. */
  let imageQueue = Promise.resolve();

  /**
   * `POST /image-translate`: see {@link imageTranslateInner}; calls are serialized
   * because every call cleans up its own attachment + request-variant cache.
   * @param {unknown} body - request body.
   * @param {{signal?: AbortSignal}} [options] - caller abort signal.
   * @returns {Promise<{result: object, usage: object, retries: number}>}
   */
  function imageTranslate(body, options) {
    const run = imageQueue.then(
      () => imageTranslateInner(body, options),
      () => imageTranslateInner(body, options),
    );
    imageQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * `GET /wordbook` (DESIGN §5.8).
   * @param {object} query - query parameters.
   * @returns {Promise<object>}
   */
  async function listWordbook(query) {
    return wordbook.list(query ?? {});
  }

  return {
    version: VERSION,
    extensionOrigins: normalizeExtensionOrigins(config?.extensionOrigins),
    logger: log,
    health,
    listModels,
    resolveModel,
    getSettings,
    putSettings,
    translate: (body, options) => withCacheReady(
      () => withUsage('translate', body, () => translateService.translate(body, options)),
    ),
    lookup: (body, options) => withUsage('lookup', body, () => translateService.lookup(body, options)),
    imageTranslate: (body, options) => imageTranslate(body, options),
    getUsage,
    listUsageEvents,
    getUsageTurns,
    listConversations,
    clearCache,
    clearUsage,
    clearRecords,
    getBallSites: () => ballSites.list(),
    addBallSite: (body) => ballSites.add(body),
    removeBallSite: (body) => ballSites.remove(body),
    listWordbook,
    addWordbookEntry: (body) => wordbook.add(body),
    updateWordbookEntry: (body) => wordbook.update(body),
    reviewWordbookEntry: (body) => wordbook.review(body),
    removeWordbookEntry: (body) => wordbook.remove(body),
  };
}
