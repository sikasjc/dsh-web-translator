/**
 * Shared constants for the dsh-web-translator host half.
 *
 * Single source of truth for the target-language whitelist, factory defaults,
 * request/batch limits and on-disk document versions. Both the API layer and
 * the unit tests read from here, so the contract cannot drift between them.
 */

/** Fixed target-language whitelist (Lead裁决 2026-11-05; DESIGN defaults zh-CN). */
export const TARGET_LANGUAGES = Object.freeze([
  'zh-CN',
  'zh-TW',
  'en',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'ru',
  'pt',
  'it',
  'ar',
]);

/** Default target language (DESIGN §4.1 / §5.5). */
export const DEFAULT_TARGET_LANGUAGE = 'zh-CN';

/** Supported translation styles/domains (auto uses page heuristics). */
export const TRANSLATION_STYLES = Object.freeze(['auto', 'general', 'programming', 'tech', 'finance']);

/** Selectable third-party dictionaries for English single-word lookups. */
export const DICTIONARY_PROVIDERS = Object.freeze(['dictionaryapi.dev', 'wiktionary', 'off']);

/** On-disk `settings.json` schema version. */
export const SETTINGS_VERSION = 1;

/** On-disk `wordbook.json` schema version. */
export const WORDBOOK_VERSION = 1;

/** On-disk `usage.json` schema version (DESIGN-TOKEN-USAGE §2.1). */
export const USAGE_VERSION = 1;

/** Default system prompt (DESIGN §4.1, verbatim). */
export const DEFAULT_SYSTEM_PROMPT = [
  'You are a professional translator. Translate every source segment into {{targetLanguage}}.',
  'Preserve meaning, tone, formatting and order. Do not add explanations or commentary.',
  'If a segment is already in {{targetLanguage}}, return it unchanged.',
  'Output ONLY a JSON object exactly like {"translations":["...","..."]} containing',
  '{{segmentCount}} strings in input order. No markdown fences, no extra keys.',
].join('\n');

/** Default user template (DESIGN §4.1, verbatim). */
export const DEFAULT_USER_TEMPLATE = [
  'Source language: {{sourceLanguage}}',
  'Target language: {{targetLanguage}}',
  'Segments (JSON array; translate each element, keep the same order):',
  '{{segmentsJson}}',
].join('\n');

/** Numeric limits from DESIGN §4.2, §4.1, §5, §5.8 (Lead裁决 for wordbook list). */
export const LIMITS = Object.freeze({
  /** `systemPrompt` max characters (DESIGN §4.1). */
  systemPromptChars: 8000,
  /** `userTemplate` max characters (DESIGN §4.1). */
  userTemplateChars: 4000,
  /** `POST /translate` texts per request (DESIGN §4.2). */
  requestTexts: 50,
  /** `POST /translate` characters per segment (DESIGN §4.2). */
  requestTextChars: 8000,
  /** Host re-chunking: segments per model batch, configurable 1..20. */
  batchSegments: Object.freeze({ min: 1, max: 20, default: 10 }),
  /** Host re-chunking: characters per model batch, configurable 200..4000. */
  batchChars: Object.freeze({ min: 200, max: 4000, default: 1600 }),
  /** Model-call concurrency, configurable 1..4. */
  concurrency: Object.freeze({ min: 1, max: 4, default: 2 }),
  /** JSON request body cap (DESIGN §5: 1 MiB). */
  bodyBytes: 1024 * 1024,
  /** Wordbook file cap (DESIGN §5.8). */
  wordbookItems: 5000,
  /** `GET /wordbook` limit default / hard maximum (Lead裁决). */
  wordbookListDefault: 200,
  wordbookListMax: 500,
  /** `POST /lookup` text / context caps. */
  lookupTextChars: 500,
  lookupContextChars: 2000,
  /** URL fields accepted by the API. */
  urlChars: 2048,
  /** Per-batch model timeout (DESIGN §4). */
  batchTimeoutMs: 90_000,
  /** `POST /image-translate` JSON body cap (base64 image fits inside). */
  imageBodyBytes: 8 * 1024 * 1024,
  /** Decoded image byte cap accepted by `POST /image-translate`. */
  imageBytes: 3 * 1024 * 1024,
  /** `POST /image-translate` model timeout (vision calls are slower). */
  imageTimeoutMs: 120_000,
  /** Output-token ceiling for one image translation call. */
  imageMaxTokens: 4096,
  /** Maximum text blocks accepted from one image response. */
  imageBlocks: 100,
  /** Maximum characters per OCR/translation block. */
  imageBlockChars: 2000,
  /** Translation LRU capacity (DESIGN §4.2). */
  translationCache: 512,
  /** Persistent translation-cache capacity, in batch entries (DESIGN-CACHE §2). */
  translationCacheEntries: 1000,
  /** Persistent translation-cache entry TTL: 7 days (DESIGN-CACHE §2). */
  translationCacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** Persistent translation-cache file size cap before dropping oldest entries (~4 MiB, DESIGN-CACHE §2). */
  translationCacheFileBytes: 4 * 1024 * 1024,
  /** Provider/model catalog cache TTL (DESIGN §5.2). */
  catalogTtlMs: 30_000,
  /** Usage ledger: events kept on disk (DESIGN-TOKEN-USAGE §2.1). */
  usageEvents: 500,
  /** Usage ledger: day buckets kept / `GET /usage` days clamp (DESIGN-TOKEN-USAGE §2.1). */
  usageDays: 90,
  /** `sourceTitle` metadata cap on translate/lookup bodies (DESIGN-TOKEN-USAGE §2.3). */
  sourceTitleChars: 200,
  /** `client` metadata cap (DESIGN-TOKEN-USAGE §2.3). */
  clientChars: 32,
  /** Event `sample` truncation (DESIGN-TOKEN-USAGE §2.1). */
  eventSampleChars: 80,
  sessionIdChars: 96,
  /** Turn id metadata cap on translate/lookup bodies (DESIGN-TURN-TRACE §2.1). */
  turnIdChars: 64,
  /** Turn display-mode cap: bilingual | only | source (DESIGN-TURN-TRACE §2.1). */
  modeChars: 16,
  /** Turn step index upper bound (DESIGN-TURN-TRACE §2.1). */
  stepIndexMax: 10000,
  /** Event `outputPreview` truncation (DESIGN-TURN-TRACE §2.1). */
  outputPreviewChars: 200,
  /** `GET /usage/turns?limit=` default page size (DESIGN-TURN-TRACE §2.2). */
  usageTurnsDefault: 20,
  /** `GET /usage/turns?limit=` hard maximum (DESIGN-TURN-TRACE §2.2). */
  usageTurnsMax: 100,
});

/** Factory defaults returned as `defaults` by `GET /settings` (DESIGN §5.4). */
export const DEFAULTS = Object.freeze({
  provider: '',
  model: '',
  reasoningEffort: 'auto',
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  translationStyle: 'auto',
  dictionaryProvider: 'dictionaryapi.dev',
  imageModel: 'auto',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  userTemplate: DEFAULT_USER_TEMPLATE,
  batchSegments: LIMITS.batchSegments.default,
  batchChars: LIMITS.batchChars.default,
  concurrency: LIMITS.concurrency.default,
  recordHistory: true,
});

/** Keys a settings PUT may address (DESIGN §5.5). */
export const SETTINGS_KEYS = Object.freeze([
  'provider',
  'model',
  'reasoningEffort',
  'targetLanguage',
  'translationStyle',
  'dictionaryProvider',
  'imageModel',
  'systemPrompt',
  'userTemplate',
  'batchSegments',
  'batchChars',
  'concurrency',
  'recordHistory',
]);
