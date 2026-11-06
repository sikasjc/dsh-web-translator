/**
 * Model-call plumbing for the dsh-web-translator host half (DESIGN §4).
 *
 * Owns: GenerateOptions assembly, AsyncIterable chunk collection, the 90 s
 * per-batch timeout with caller-abort linkage, reasoning-effort resolution
 * (auto prefers `off`, then the least advertised effort), output-token
 * estimation, and the finish-reason / failure-code -> API error mapping.
 * The module never touches persistence or HTTP.
 */
import { LIMITS } from './constants.js';
import { apiError, isApiError } from './errors.js';

/** Default per-batch model timeout (DESIGN §4). */
export const BATCH_TIMEOUT_MS = LIMITS.batchTimeoutMs;

/** Desired output-token ceiling before the per-model clamp. */
const MAX_OUTPUT_ESTIMATE = 8192;

/** Minimum output-token estimate. */
const MIN_OUTPUT_ESTIMATE = 512;

/** Exact provider-neutral failure codes from DESIGN §4. */
const FAILURE_CODE_MAP = Object.freeze({
  NO_ADAPTER: 'MODEL_UNAVAILABLE',
  MISSING_CREDENTIAL: 'MODEL_AUTH',
  AUTH: 'MODEL_AUTH',
  INVALID_CREDENTIAL: 'MODEL_AUTH',
  INVALID_API_KEY: 'MODEL_AUTH',
  RATE_LIMIT: 'MODEL_RATE_LIMITED',
  CONTEXT_WINDOW_EXCEEDED: 'TEXT_LIMIT',
});

/** Generic, provider-neutral message per API error code. */
const DEFAULT_MESSAGES = Object.freeze({
  MODEL_UNAVAILABLE: 'the configured model is unavailable',
  MODEL_AUTH: 'the model provider rejected the configured credentials',
  MODEL_RATE_LIMITED: 'the model provider is rate limiting requests',
  MODEL_FAILED: 'the model call failed',
  MODEL_TIMEOUT: 'the model call timed out',
  TEXT_LIMIT: 'the input exceeds the model context window',
  OUTPUT_TRUNCATED: 'the model output was truncated',
});

/**
 * Map a provider failure code (plus optional HTTP status) to a DESIGN §5.9 code.
 * @param {unknown} code - provider-neutral failure code, e.g. `NO_ADAPTER`.
 * @param {number} [status] - provider HTTP status when known.
 * @returns {string} API error code.
 */
export function mapFailureCode(code, status) {
  const text = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (text.length > 0) {
    if (Object.hasOwn(FAILURE_CODE_MAP, text)) return FAILURE_CODE_MAP[text];
    if (/AUTH|CREDENTIAL|UNAUTHORI[SZ]ED|FORBIDDEN/.test(text)) return 'MODEL_AUTH';
    if (/RATE.?LIMIT|TOO.?MANY.?REQUESTS|QUOTA/.test(text)) return 'MODEL_RATE_LIMITED';
    if (/CONTEXT.*(WINDOW|LENGTH)|MAX.?CONTEXT/.test(text)) return 'TEXT_LIMIT';
    if (/NO.?ADAPTER|MODEL.?NOT.?FOUND|UNKNOWN.?MODEL|NO.?MODEL/.test(text)) return 'MODEL_UNAVAILABLE';
    if (/TIMEOUT|TIMED.?OUT/.test(text)) return 'MODEL_TIMEOUT';
    if (/ABORT|CANCEL/.test(text)) return 'MODEL_TIMEOUT';
  }
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'MODEL_AUTH';
    if (status === 404) return 'MODEL_UNAVAILABLE';
    if (status === 408 || status === 504) return 'MODEL_TIMEOUT';
    if (status === 413) return 'TEXT_LIMIT';
    if (status === 429) return 'MODEL_RATE_LIMITED';
  }
  return 'MODEL_FAILED';
}

/**
 * Build an {@link ApiError} for one `finish.reason.failure` payload.
 * @param {{code?: string, message?: string, status?: number} | undefined} failure - provider failure.
 * @returns {import('./errors.js').ApiError}
 */
export function failureToApiError(failure) {
  const code = mapFailureCode(failure?.code, failure?.status);
  const message = typeof failure?.message === 'string' && failure.message.trim().length > 0
    ? failure.message.trim().slice(0, 300)
    : (DEFAULT_MESSAGES[code] ?? 'the model call failed');
  return apiError(code, message);
}

/**
 * Map a terminal `finish` reason to an API error, or null on success.
 * @param {{kind?: string, failure?: object} | undefined} reason - finish reason.
 * @returns {import('./errors.js').ApiError | null}
 */
export function mapFinishReason(reason) {
  const kind = reason?.kind;
  if (kind === 'stop') return null;
  if (kind === 'max-tokens') return apiError('OUTPUT_TRUNCATED', DEFAULT_MESSAGES.OUTPUT_TRUNCATED);
  if (kind === 'tool-calls') return apiError('MODEL_FAILED', 'the model returned tool calls instead of text');
  if (kind === 'error' || kind === 'aborted') return failureToApiError(reason?.failure);
  return apiError('MODEL_FAILED', `unexpected model finish reason: ${String(kind ?? 'none')}`);
}

/**
 * Map a thrown adapter/runtime error to an API error using its code/status.
 * @param {unknown} error - caught value.
 * @param {{debug?: Function}} [logger] - optional logger for diagnostics.
 * @returns {import('./errors.js').ApiError}
 */
export function mapErrorToApiError(error, logger) {
  if (isApiError(error)) return error;
  const code = mapFailureCode(error?.code, typeof error?.status === 'number' ? error.status : undefined);
  const detail = error instanceof Error && typeof error.message === 'string' && error.message.length > 0
    ? error.message.slice(0, 300)
    : (DEFAULT_MESSAGES[code] ?? 'the model call failed');
  try {
    logger?.debug?.(`[dsh-web-translator] model failure ${String(error?.code ?? 'unknown')}: ${detail}`);
  } catch {
    // Logging must never mask the mapped error.
  }
  return apiError(code, detail);
}

/**
 * Consume a model stream: concatenate visible text, keep the last usage chunk,
 * and remember the terminal finish reason.
 * @param {AsyncIterable<object>} stream - `ctx.llm.stream(...)` result.
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number,
 *   cacheReadTokens: number, cacheWriteTokens: number}, reason: object | undefined}>}
 */
export async function collectStream(stream) {
  let text = '';
  let usage = emptyUsage();
  let reason;
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') text += chunk.text;
    } else if (chunk.type === 'usage') {
      // Keep the whole DSH usage bucket: prompt input, cache read/write and output.
      usage = {
        inputTokens: toTokenCount(chunk.usage?.inputTokens),
        outputTokens: toTokenCount(chunk.usage?.outputTokens),
        cacheReadTokens: toTokenCount(chunk.usage?.cacheReadTokens),
        cacheWriteTokens: toTokenCount(chunk.usage?.cacheWriteTokens),
      };
    } else if (chunk.type === 'finish') {
      reason = chunk.reason;
    }
  }
  return { text, usage, reason };
}

/** @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}} */
function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Coerce a token counter to a non-negative integer.
 * @param {unknown} value - raw count.
 * @returns {number}
 */
function toTokenCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Estimate output tokens for one batch and clamp to the model's default cap
 * (DESIGN §4: `min(defaultMaxTokens ?? 8192, max(512, ceil(chars*1.5)))`).
 * @param {number} chars - source characters in the batch.
 * @param {number} [defaultMaxTokens] - model-advertised output cap.
 * @returns {number}
 */
export function estimateMaxTokens(chars, defaultMaxTokens) {
  const estimate = Math.ceil(Math.max(0, Number(chars) || 0) * 1.5);
  const desired = Math.min(MAX_OUTPUT_ESTIMATE, Math.max(MIN_OUTPUT_ESTIMATE, estimate));
  return Number.isFinite(defaultMaxTokens) && defaultMaxTokens > 0
    ? Math.min(desired, Math.floor(defaultMaxTokens))
    : desired;
}

/**
 * Resolve the reasoning effort to pass to the model (DESIGN §4):
 * explicit settings pass through only when advertised; `auto` prefers `off`,
 * then the least advertised effort, and omits the field when nothing is known.
 * @param {unknown} settingValue - saved setting (`'auto'` or an effort id).
 * @param {readonly (string | {id?: string})[]} [efforts] - advertised efforts, least first.
 * @returns {{effort: string | undefined, source: 'explicit'|'auto'|'unavailable'}}
 */
export function resolveReasoningEffort(settingValue, efforts = []) {
  const ids = [];
  for (const entry of Array.isArray(efforts) ? efforts : []) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  if (typeof settingValue === 'string' && settingValue.length > 0 && settingValue !== 'auto') {
    return ids.includes(settingValue)
      ? { effort: settingValue, source: 'explicit' }
      : { effort: undefined, source: 'unavailable' };
  }
  if (ids.includes('off')) return { effort: 'off', source: 'auto' };
  if (ids.length > 0) return { effort: ids[0], source: 'auto' };
  return { effort: undefined, source: 'auto' };
}

/**
 * Build one user message with a text content block.
 * @param {string} text - user prompt text.
 * @returns {{role: 'user', content: {type: 'text', text: string}[]}}
 */
export function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text: String(text) }] };
}

/**
 * Run one streaming model call to completion with a timeout and abort linkage.
 *
 * Design notes: no automatic retries (the translate path owns its one
 * parse-correction retry); a timeout or caller abort surfaces as
 * `MODEL_TIMEOUT`; no `sessionId`/`purpose` is passed so the call never enters
 * the DSH session log.
 * @param {{llm: {stream: Function}, options: object, timeoutMs?: number,
 *   signal?: AbortSignal, logger?: {debug?: Function}}} input - call context.
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number,
 *   cacheReadTokens: number, cacheWriteTokens: number}}>}
 */
export async function callModel({ llm, options, timeoutMs = BATCH_TIMEOUT_MS, signal, logger } = {}) {
  if (!llm || typeof llm.stream !== 'function') {
    throw apiError('MODEL_UNAVAILABLE', DEFAULT_MESSAGES.MODEL_UNAVAILABLE);
  }
  if (options === null || typeof options !== 'object') {
    throw apiError('MODEL_FAILED', 'model call options are missing');
  }

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) throw apiError('MODEL_TIMEOUT', 'the request was aborted before the model call');
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const effectiveTimeout = Math.max(1, Math.trunc(Number(timeoutMs)) || BATCH_TIMEOUT_MS);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeout);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const stream = llm.stream({ ...options, signal: controller.signal });
    const { text, usage, reason } = await collectStream(stream);
    if (timedOut) throw apiError('MODEL_TIMEOUT', DEFAULT_MESSAGES.MODEL_TIMEOUT);
    if (!reason) throw apiError('MODEL_FAILED', 'the model stream ended without a finish event');
    const failure = mapFinishReason(reason);
    if (failure !== null) {
      if (callerAborted) throw apiError('MODEL_TIMEOUT', 'the request was aborted');
      throw failure;
    }
    return { text, usage };
  } catch (error) {
    if (isApiError(error)) throw error;
    if (timedOut) throw apiError('MODEL_TIMEOUT', DEFAULT_MESSAGES.MODEL_TIMEOUT);
    if (callerAborted || signal?.aborted) throw apiError('MODEL_TIMEOUT', 'the request was aborted');
    throw mapErrorToApiError(error, logger);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
  }
}
