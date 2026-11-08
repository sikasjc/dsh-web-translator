/**
 * Provider/model catalog for the host API (DESIGN §4, §5.2, §5.3).
 *
 * Wraps `ctx.llm.listProviders/listModels/resolveModelInfo` with a 30 s cache so
 * `GET /models`, `GET /settings` and `/models/resolve` stay cheap; per-model
 * capacity resolution is best effort (a failing route keeps id/name only and
 * `listModels` failures become a per-provider `error` field instead of failing
 * the whole catalog). Also owns the DSH default-model fallback used when the
 * user never picked a provider/model.
 */
import { LIMITS } from './constants.js';
import { apiError, isApiError } from './errors.js';
import { runPool } from './batch.js';
import { mapErrorToApiError } from './llm.js';
import { isNonEmptyString } from './validate.js';

const CATALOG_RESOLVE_PARALLEL = 4;
const MAX_CATALOG_RESOLVE = 200;

/**
 * Map one adapter `LlmResolvedModelInfo` to the DESIGN §5.3/§5.4 model shape.
 * @param {string} provider - provider route.
 * @param {string} model - model id requested.
 * @param {object} raw - adapter answer.
 * @returns {{provider: string, model: string, name: string,
 *   reasoningEfforts: {id: string, name: string, description?: string}[],
 *   contextWindow?: number, maxTokens?: number, defaultEffort?: string,
 *   inputModalities?: ('text'|'image')[]}}
 */
export function toModelInfo(provider, model, raw) {
  const reasoningEfforts = [];
  for (const effort of Array.isArray(raw?.reasoning?.efforts) ? raw.reasoning.efforts : []) {
    const id = typeof effort === 'string' ? effort : effort?.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const entry = { id, name: typeof effort?.name === 'string' && effort.name.length > 0 ? effort.name : id };
    if (typeof effort?.description === 'string' && effort.description.length > 0) entry.description = effort.description;
    reasoningEfforts.push(entry);
  }
  const info = {
    provider,
    model,
    name: typeof raw?.name === 'string' && raw.name.length > 0 ? raw.name : model,
    reasoningEfforts,
  };
  const contextWindow = raw?.context?.contextWindow;
  if (Number.isFinite(contextWindow) && contextWindow > 0) info.contextWindow = Math.trunc(contextWindow);
  if (Number.isFinite(raw?.defaultMaxTokens) && raw.defaultMaxTokens > 0) {
    info.maxTokens = Math.trunc(raw.defaultMaxTokens);
  }
  if (typeof raw?.reasoning?.defaultEffort === 'string' && raw.reasoning.defaultEffort.length > 0) {
    info.defaultEffort = raw.reasoning.defaultEffort;
  }
  if (Array.isArray(raw?.inputModalities)) {
    const modalities = raw.inputModalities.filter((value) => value === 'text' || value === 'image');
    if (modalities.length > 0) info.inputModalities = [...new Set(modalities)];
  }
  return info;
}

/**
 * Create the catalog collaborator.
 * @param {{ctx?: object, logger?: object, now?: () => number, ttlMs?: number}} input
 * @returns {object} catalog facade (see returned methods).
 */
export function createCatalogService({ ctx, logger, now = Date.now, ttlMs = LIMITS.catalogTtlMs } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const cacheTtl = Math.max(0, Math.trunc(Number(ttlMs)) || LIMITS.catalogTtlMs);
  let treeCache;
  const resolveCache = new Map();

  /**
   * The LLM service, or null when the host did not provide one.
   * @returns {object | null}
   */
  function getLlm() {
    try {
      return ctx?.llm ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The LLM service, throwing the contract error when unavailable.
   * @returns {object}
   */
  function requireLlm() {
    const llm = getLlm();
    if (!llm || typeof llm.listProviders !== 'function') {
      throw apiError('MODEL_UNAVAILABLE', 'the DSH model service is unavailable');
    }
    return llm;
  }

  /**
   * Read the DSH agent default model selection, when configured.
   * @returns {{provider: string, model: string, reasoningEffort?: string} | null}
   */
  function readAgentDefaultSelection() {
    try {
      const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : null;
      const selection = service?.currentSelection?.();
      if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null;
      const provider = selection.provider.trim();
      const model = selection.model.trim();
      if (provider.length === 0 || model.length === 0) return null;
      const result = { provider, model };
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
        result.reasoningEffort = selection.reasoningEffort;
      }
      return result;
    } catch (error) {
      debug(`cannot read agent default model: ${messageOf(error)}`);
      return null;
    }
  }

  /**
   * Load (and cache) the provider -> models tree without resolving capacities.
   * @param {boolean} [force] - bypass the TTL cache.
   * @returns {Promise<{providers: object[]}>}
   */
  async function loadTree(force = false) {
    if (!force && treeCache !== undefined && clock() - treeCache.at < cacheTtl) return treeCache.value;
    const llm = requireLlm();
    let rawProviders;
    try {
      rawProviders = await llm.listProviders();
    } catch (error) {
      throw isApiError(error) ? error : mapErrorToApiError(error, logger);
    }

    const providers = [];
    for (const provider of Array.isArray(rawProviders) ? rawProviders : []) {
      const id = typeof provider?.id === 'string' ? provider.id : '';
      if (id.length === 0) continue;
      const name = typeof provider?.name === 'string' && provider.name.length > 0 ? provider.name : id;
      try {
        const rawModels = await llm.listModels(id);
        const models = [];
        for (const model of Array.isArray(rawModels) ? rawModels : []) {
          const modelId = typeof model?.id === 'string' ? model.id : '';
          if (modelId.length === 0) continue;
          models.push({
            provider: id,
            id: modelId,
            name: typeof model?.name === 'string' && model.name.length > 0 ? model.name : modelId,
          });
        }
        providers.push({ id, name, models });
      } catch (error) {
        warn(`listModels(${id}) failed: ${messageOf(error)}`);
        providers.push({ id, name, models: [], error: messageOf(error) });
      }
    }
    const value = { providers };
    treeCache = { at: clock(), value };
    return value;
  }

  /**
   * Default model selection: DSH agent default, else the first catalog model.
   * Never throws (an unavailable model service yields empty ids).
   * @returns {Promise<{provider: string, model: string, reasoningEffort?: string}>}
   */
  async function getDefaultSelection() {
    const fromAgent = readAgentDefaultSelection();
    if (fromAgent !== null) return fromAgent;
    try {
      const tree = await loadTree();
      const provider = tree.providers.find((entry) => entry.models.length > 0);
      if (provider) return { provider: provider.id, model: provider.models[0].id };
    } catch (error) {
      debug(`default model fallback unavailable: ${messageOf(error)}`);
    }
    return { provider: '', model: '' };
  }

  /**
   * Build `GET /models.catalog` (DESIGN §5.2), resolving capacities best effort.
   * @returns {Promise<{providers: object[]}>}
   */
  async function getCatalog() {
    const tree = await loadTree();
    const pairs = [];
    for (const provider of tree.providers) {
      for (const model of provider.models) pairs.push({ provider: provider.id, model: model.id });
    }
    const resolved = new Map();
    await runPool(pairs.slice(0, MAX_CATALOG_RESOLVE), CATALOG_RESOLVE_PARALLEL, async (pair) => {
      try {
        resolved.set(keyOf(pair.provider, pair.model), await resolveModelInfo(pair.provider, pair.model));
      } catch {
        // Capacities are optional; id/name still ship.
      }
    });
    const providers = tree.providers.map((provider) => {
      const entry = {
        provider: provider.id,
        name: provider.name,
        models: provider.models.map((model) => {
          const info = resolved.get(keyOf(provider.id, model.id));
          const item = { id: model.id, name: model.name };
          if (info !== undefined && Number.isFinite(info.contextWindow)) item.contextWindow = info.contextWindow;
          if (info !== undefined && Number.isFinite(info.maxTokens)) item.maxTokens = info.maxTokens;
          if (info !== undefined && Array.isArray(info.inputModalities) && info.inputModalities.length > 0) {
            item.inputModalities = [...info.inputModalities];
          }
          return item;
        }),
      };
      if (typeof provider.error === 'string') entry.error = provider.error;
      return entry;
    });
    return { providers };
  }

  /**
   * Counts for `GET /health`.
   * @returns {Promise<{providers: number, models: number}>}
   */
  async function getCounts() {
    const tree = await loadTree();
    return {
      providers: tree.providers.length,
      models: tree.providers.reduce((total, provider) => total + provider.models.length, 0),
    };
  }

  /**
   * Resolve one exact provider/model route, cached for the catalog TTL.
   * @param {string} provider - provider route.
   * @param {string} model - model id.
   * @param {{force?: boolean}} [options] - bypass the cache.
   * @returns {Promise<object>}
   */
  async function resolveModelInfo(provider, model, { force = false } = {}) {
    if (!isNonEmptyString(provider) || !isNonEmptyString(model)) {
      throw apiError('BAD_REQUEST', 'provider and model are required');
    }
    const key = keyOf(provider, model);
    const cached = resolveCache.get(key);
    if (!force && cached !== undefined && clock() - cached.at < cacheTtl) {
      if (cached.error !== undefined) throw cached.error;
      return cached.value;
    }
    try {
      const raw = await requireLlm().resolveModelInfo(provider, model);
      const info = toModelInfo(provider, model, raw);
      resolveCache.set(key, { at: clock(), value: info });
      return info;
    } catch (error) {
      const mapped = isApiError(error) ? error : mapErrorToApiError(error, logger);
      resolveCache.set(key, { at: clock(), error: mapped });
      throw mapped;
    }
  }

  /**
   * Resolve without throwing; used by `GET /settings` where a broken model must
   * not take the settings page down.
   * @param {string} provider - provider route.
   * @param {string} model - model id.
   * @returns {Promise<{info?: object, error?: Error}>}
   */
  async function resolveModelInfoSafe(provider, model) {
    if (!isNonEmptyString(provider) || !isNonEmptyString(model)) return { error: apiError('BAD_REQUEST', 'provider and model are required') };
    try {
      return { info: await resolveModelInfo(provider, model) };
    } catch (error) {
      return { error };
    }
  }

  /**
   * Verify a provider/model pair exists for `PUT /settings` (DESIGN §5.5).
   * A stale cache is refreshed once before rejecting the save.
   * @param {string} provider - provider route.
   * @param {string} model - model id.
   * @returns {Promise<void>}
   */
  async function assertModelExists(provider, model) {
    let tree = await loadTree();
    if (!treeHas(tree, provider, model)) tree = await loadTree(true);
    const providerEntry = tree.providers.find((entry) => entry.id === provider);
    if (providerEntry === undefined) throw apiError('INVALID_SETTINGS', `unknown provider: ${provider}`);
    if (typeof providerEntry.error === 'string') {
      throw apiError('MODEL_UNAVAILABLE', `cannot verify models for provider ${provider}: ${providerEntry.error}`);
    }
    if (!providerEntry.models.some((entry) => entry.id === model)) {
      throw apiError('INVALID_SETTINGS', `unknown model for provider ${provider}: ${model}`);
    }
  }

  /**
   * Drop both caches (tests and future config reloads).
   * @returns {void}
   */
  function invalidate() {
    treeCache = undefined;
    resolveCache.clear();
  }

  /**
   * Whether a provider/model pair exists in a loaded tree.
   * @param {{providers: object[]}} tree - loaded catalog tree.
   * @param {string} provider - provider route.
   * @param {string} model - model id.
   * @returns {boolean}
   */
  function treeHas(tree, provider, model) {
    const entry = tree.providers.find((candidate) => candidate.id === provider);
    return entry !== undefined && entry.models.some((candidate) => candidate.id === model);
  }

  /**
   * Cache key for one exact provider/model route.
   * @param {string} provider - provider route.
   * @param {string} model - model id.
   * @returns {string}
   */
  function keyOf(provider, model) {
    return `${provider}\u0000${model}`;
  }

  /** @param {string} message - log line. */
  function debug(message) {
    try {
      logger?.debug?.(`[dsh-web-translator] catalog: ${message}`);
    } catch {
      // Diagnostics only.
    }
  }

  /** @param {string} message - log line. */
  function warn(message) {
    try {
      logger?.warn?.(`[dsh-web-translator] catalog: ${message}`);
    } catch {
      // Diagnostics only.
    }
  }

  return {
    getLlm,
    requireLlm,
    loadTree,
    getDefaultSelection,
    getCatalog,
    getCounts,
    resolveModelInfo,
    resolveModelInfoSafe,
    assertModelExists,
    invalidate,
  };
}

/**
 * Format an unknown error for a log line.
 * @param {unknown} error - caught value.
 * @returns {string}
 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
