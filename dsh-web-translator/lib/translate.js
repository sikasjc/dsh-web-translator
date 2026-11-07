/**
 * Translation and lookup orchestration (DESIGN §4.2, §4.3, §5.6, §5.7).
 *
 * Translate: re-chunk the request, serve batches from the process LRU, run the
 * rest through `ctx.llm.stream` with bounded concurrency, one parse-correction
 * retry per batch, and aggregate usage. Lookup: one plain-text model call plus
 * a concurrent dictionaryapi.dev lookup that degrades silently.
 */
import { chunkSegments, countBatchChars, runPool } from './batch.js';
import { createBatchCacheKey } from './cache.js';
import { LIMITS, TARGET_LANGUAGES, TRANSLATION_STYLES } from './constants.js';
import { apiError } from './errors.js';
import { BATCH_TIMEOUT_MS, callModel, estimateMaxTokens, userMessage } from './llm.js';
import { plainTextTranslation, parseTranslations } from './parse.js';
import { CORRECTION_MESSAGE, looksLikeTechnicalContent, renderLookupPrompts, renderTranslatePrompts } from './prompts.js';
import { applyTechnicalFallback, protectTechnicalTerms, restoreTechnicalTerms } from './terms.js';
import {
  isPlainObject,
  normalizeHttpUrl,
  normalizeLanguageTag,
  validateTextsList,
} from './validate.js';

/** Default sampling temperature (DESIGN §4). */
export const DEFAULT_TEMPERATURE = 0.2;

/** Output cap for one lookup answer. */
const LOOKUP_MAX_TOKENS = 1024;

/** All four DSH usage buckets (DESIGN-TOKEN-USAGE §2.3). */
const USAGE_KEYS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);

/** @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}} */
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Clamp the configured concurrency into DESIGN §4 range.
 * @param {unknown} value - configured concurrency.
 * @returns {number}
 */
function clampConcurrency(value) {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : LIMITS.concurrency.default;
  return Math.min(LIMITS.concurrency.max, Math.max(LIMITS.concurrency.min, parsed));
}

/**
 * Add two usage counters (all four DSH buckets).
 * @param {object} left - accumulator.
 * @param {object} right - addition.
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}}
 */
function addUsage(left, right) {
  const sum = emptyUsage();
  for (const key of USAGE_KEYS) {
    const base = Number.isFinite(left?.[key]) ? left[key] : 0;
    sum[key] = base + (Number.isFinite(right?.[key]) ? right[key] : 0);
  }
  return sum;
}

/**
 * Build DESIGN §4 GenerateOptions (no `sessionId`, no `purpose`).
 * @param {{provider: string, model: string, system: string, messages: object[],
 *   temperature: number, maxTokens: number, reasoningEffort?: string}} input
 * @returns {object}
 */
function buildGenerateOptions({ provider, model, system, messages, temperature, maxTokens, reasoningEffort }) {
  const options = { provider, model, system, messages, temperature, maxTokens };
  if (typeof reasoningEffort === 'string' && reasoningEffort.length > 0) options.reasoningEffort = reasoningEffort;
  return options;
}

/**
 * Create the translate/lookup service.
 * @param {{resolveSelection: () => Promise<object>, cache?: object, logger?: object,
 *   dictionary?: {lookupWord: Function}, timeoutMs?: number}} input
 * @returns {{translate: Function, lookup: Function}}
 */
/**
 * 段落内空白/换行归一：防止 <br>、HTML 缩进换行、NBSP 等导致模型误译或译文异常换行。
 * 可读性优先：段落总是以完整句子送给模型，译文不人为断行。
 * @param {unknown} value - 原始文本。
 * @returns {string}
 */
export function normalizeSegmentText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ *\n */g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function createTranslateService({ resolveSelection, cache, logger, dictionary, timeoutMs = BATCH_TIMEOUT_MS } = {}) {
  /**
   * Log the first 200 characters of an unusable model answer; never returned to
   * the client (DESIGN §4.3 step 5).
   * @param {unknown} raw - raw model output.
   */
  function logInvalidOutput(raw) {
    try {
      logger?.warn?.(`[dsh-web-translator] invalid model output (first 200 chars): ${String(raw ?? '').slice(0, 200)}`);
    } catch {
      // Diagnostics only.
    }
  }

  /**
   * Translate one batch with the DESIGN §4.3 retry policy.
   * @param {{batch: object[], segments: string[], rendered: {system: string, user: string}}} plan - batch plan.
   * @param {object} context - selection and abort context.
   * @param {AbortSignal} [signal] - caller abort signal.
   * @returns {Promise<{translations: string[], usage: object, retries: number}>}
   */
  async function translateBatch(plan, context, signal) {
    const { llm, provider, model, reasoningEffort, modelInfo } = context;
    const maxTokens = estimateMaxTokens(countBatchChars(plan.batch), modelInfo?.maxTokens);
    const baseMessages = [userMessage(plan.rendered.user)];
    const options = buildGenerateOptions({
      provider,
      model,
      system: plan.rendered.system,
      messages: baseMessages,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens,
      reasoningEffort,
    });

    const first = await callModel({ llm, options, timeoutMs, signal, logger });
    let usage = first.usage;
    let retries = 0;
    let parsed = parseTranslations(first.text, { expectedCount: plan.batch.length });

    if (!parsed.ok) {
      retries = 1;
      const retryOptions = buildGenerateOptions({
        provider,
        model,
        system: plan.rendered.system,
        messages: [...baseMessages, userMessage(CORRECTION_MESSAGE)],
        temperature: 0,
        maxTokens,
        reasoningEffort,
      });
      const retry = await callModel({ llm, options: retryOptions, timeoutMs, signal, logger });
      usage = addUsage(usage, retry.usage);
      parsed = parseTranslations(retry.text, { expectedCount: plan.batch.length });
      if (!parsed.ok) {
        logInvalidOutput(retry.text);
        throw apiError('INVALID_MODEL_OUTPUT', 'the model did not return the required translation JSON');
      }
    }
    return { translations: parsed.translations, usage, retries };
  }

  return {
    /**
     * `POST /translate` (DESIGN §5.6).
     * @param {unknown} input - request body.
     * @param {{signal?: AbortSignal}} [options] - caller abort signal.
     * @returns {Promise<{translations: string[], provider: string, model: string,
     *   reasoningEffort: string, usage: object, cached: boolean, retries: number}>}
     */
    async translate(input, { signal } = {}) {
      const body = isPlainObject(input) ? input : {};
      const invalid = validateTextsList(body.texts);
      if (invalid !== null) throw apiError('BAD_REQUEST', invalid);
      const requestTarget = normalizeLanguageTag(body.targetLanguage, {
        field: 'targetLanguage',
        allowed: TARGET_LANGUAGES,
      });
      const sourceLanguage = normalizeLanguageTag(body.sourceLanguage, {
        field: 'sourceLanguage',
        fallback: 'auto',
        allowAuto: true,
      }) ?? 'auto';
      const texts = body.texts.map((text) => normalizeSegmentText(typeof text === 'string' ? text : ''));
      const sourceTitle = typeof body.sourceTitle === 'string' ? body.sourceTitle.slice(0, LIMITS.sourceTitleChars) : '';
      const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.slice(0, LIMITS.urlChars) : '';
      const selection = await resolveSelection();
      const llm = selection.llm;
      const provider = selection.provider;
      const model = selection.model;
      const reasoningEffort = selection.reasoningEffort;
      const modelInfo = selection.modelInfo ?? null;
      const settings = selection.settings ?? {};
      const targetLanguage = requestTarget ?? settings.targetLanguage;
      if (typeof targetLanguage !== 'string' || targetLanguage.length === 0) {
        throw apiError('INTERNAL', 'the effective target language is missing');
      }

      const style = TRANSLATION_STYLES.includes(settings.translationStyle) ? settings.translationStyle : 'auto';
      const pageContext = {
        title: sourceTitle,
        url: sourceUrl,
        style,
        technical: style === 'programming'
          || (style === 'auto' && looksLikeTechnicalContent({ title: sourceTitle, url: sourceUrl, texts })),
      };

      const entries = [];
      texts.forEach((text, index) => {
        if (text.length > 0) entries.push({ index, text });
      });

      if (entries.length === 0) {
        return {
          translations: texts.map(() => ''),
          provider,
          model,
          reasoningEffort: reasoningEffort ?? 'auto',
          usage: emptyUsage(),
          cached: true,
          retries: 0,
        };
      }

      const batches = chunkSegments(entries, {
        batchSegments: settings.batchSegments,
        batchChars: settings.batchChars,
      });
      const plans = batches.map((batch) => {
        const segments = batch.map((entry) => entry.text);
        const protection = pageContext.technical
          ? protectTechnicalTerms(segments)
          : { texts: segments, tokens: [] };
        const rendered = renderTranslatePrompts({
          systemPrompt: settings.systemPrompt,
          userTemplate: settings.userTemplate,
          texts: protection.texts,
          targetLanguage,
          sourceLanguage,
          pageContext,
        });
        const key = createBatchCacheKey({
          provider,
          model,
          targetLanguage,
          system: rendered.system,
          userTemplate: settings.userTemplate ?? '',
          sourceLanguage,
          textsJson: rendered.textsJson,
        });
        const cached = cache?.get?.(key);
        return {
          batch,
          segments,
          protection,
          rendered,
          key,
          cached: Array.isArray(cached) ? cached : undefined,
          translations: undefined,
          usage: undefined,
        };
      });

      const misses = plans.filter((plan) => plan.cached === undefined);
      await runPool(misses, clampConcurrency(settings.concurrency), async (plan) => {
        const result = await translateBatch(plan, { llm, provider, model, reasoningEffort, modelInfo }, signal);
        const finalized = result.translations.map((value, index) => applyTechnicalFallback(
          plan.segments[index] ?? '',
          restoreTechnicalTerms(value, plan.protection.tokens),
        ));
        plan.translations = finalized;
        plan.usage = result.usage;
        plan.retries = result.retries;
        try {
          cache?.set?.(plan.key, finalized);
        } catch {
          // A cache failure must never fail a paid-for translation.
        }
      });

      const translations = new Array(texts.length).fill('');
      let usage = emptyUsage();
      let retries = 0;
      for (const plan of plans) {
        const values = plan.cached ?? plan.translations ?? [];
        plan.batch.forEach((entry, offset) => {
          translations[entry.index] = values[offset] ?? '';
        });
        if (plan.cached === undefined) {
          usage = addUsage(usage, plan.usage);
          retries += Number.isFinite(plan.retries) ? plan.retries : 0;
        }
      }

      return {
        translations: translations.map((value) => normalizeSegmentText(value)),
        provider,
        model,
        reasoningEffort: reasoningEffort ?? 'auto',
        usage,
        cached: misses.length === 0,
        retries,
      };
    },

    /**
     * `POST /lookup` (DESIGN §5.7, DESIGN-TOKEN-USAGE §2.3).
     * @param {unknown} input - request body.
     * @param {{signal?: AbortSignal}} [options] - caller abort signal.
     * @returns {Promise<{result: object, usage: object, retries: number}>}
     */
    async lookup(input, { signal } = {}) {
      const body = isPlainObject(input) ? input : {};
      const text = normalizeSegmentText(typeof body.text === 'string' ? body.text : '');
      if (text.length < 1 || text.length > LIMITS.lookupTextChars) {
        throw apiError('BAD_REQUEST', `text must be between 1 and ${LIMITS.lookupTextChars} characters`);
      }
      const context = body.context;
      if (context !== undefined && context !== null && typeof context !== 'string') {
        throw apiError('BAD_REQUEST', 'context must be a string');
      }
      if (typeof context === 'string' && context.length > LIMITS.lookupContextChars) {
        throw apiError('BAD_REQUEST', `context exceeds ${LIMITS.lookupContextChars} characters`);
      }
      normalizeHttpUrl(body.sourceUrl, { field: 'sourceUrl' });
      const sourceTitle = typeof body.sourceTitle === 'string' ? body.sourceTitle.slice(0, LIMITS.sourceTitleChars) : '';
      const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.slice(0, LIMITS.urlChars) : '';
      const requestTarget = normalizeLanguageTag(body.targetLanguage, {
        field: 'targetLanguage',
        allowed: TARGET_LANGUAGES,
      });

      const selection = await resolveSelection();
      const settings = selection.settings ?? {};
      const targetLanguage = requestTarget ?? settings.targetLanguage;
      if (typeof targetLanguage !== 'string' || targetLanguage.length === 0) {
        throw apiError('INTERNAL', 'the effective target language is missing');
      }
      const style = TRANSLATION_STYLES.includes(settings.translationStyle) ? settings.translationStyle : 'auto';
      const pageContext = {
        title: sourceTitle,
        url: sourceUrl,
        style,
        technical: style === 'programming'
          || (style === 'auto' && looksLikeTechnicalContent({ title: sourceTitle, url: sourceUrl, texts: [text, context ?? ''] })),
      };

      const lookupProtection = pageContext.technical
        ? protectTechnicalTerms([text])
        : { texts: [text], tokens: [] };
      const rendered = renderLookupPrompts({ text: lookupProtection.texts[0], context, targetLanguage, pageContext });
      const options = buildGenerateOptions({
        provider: selection.provider,
        model: selection.model,
        system: rendered.system,
        messages: [userMessage(rendered.user)],
        temperature: DEFAULT_TEMPERATURE,
        maxTokens: LOOKUP_MAX_TOKENS,
        reasoningEffort: selection.reasoningEffort,
      });

      const dictionaryLookup = Promise.resolve(dictionary?.lookupWord?.(text)).catch(() => undefined);
      const [generated, dictionaryResult] = await Promise.all([
        callModel({ llm: selection.llm, options, timeoutMs, signal, logger }),
        dictionaryLookup,
      ]);

      const rawTranslation = plainTextTranslation(generated.text);
      const restoredTranslation = rawTranslation === null ? null : restoreTechnicalTerms(rawTranslation, lookupProtection.tokens);
      const translation = restoredTranslation === null ? null : normalizeSegmentText(applyTechnicalFallback(text, restoredTranslation));
      if (translation === null) {
        logInvalidOutput(generated.text);
        throw apiError('INVALID_MODEL_OUTPUT', 'the model returned an empty translation');
      }

      const result = {
        text,
        translation,
        provider: selection.provider,
        model: selection.model,
      };
      if (dictionaryResult !== undefined) result.dictionary = dictionaryResult;
      return { result, usage: generated.usage, retries: 0 };
    },
  };
}
