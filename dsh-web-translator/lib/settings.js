/**
 * Settings defaults, validation, merge and persistence (DESIGN §4.1, §5.4, §5.5).
 *
 * `settings.json` stores only what the user saved (`{version:1, settings,
 * updatedAt}`); the effective view overlays those values on {@link DEFAULTS} and
 * falls back to the DSH agent default model when no provider/model was saved.
 * Prompt fields are always non-empty in the effective view by contract.
 */
import {
  DEFAULTS,
  LIMITS,
  SETTINGS_KEYS,
  SETTINGS_VERSION,
  TARGET_LANGUAGES,
  TRANSLATION_STYLES,
  DICTIONARY_PROVIDERS,
} from './constants.js';
import { apiError } from './errors.js';
import { effectivePrompts, findUnknownPlaceholders } from './prompts.js';
import { isNonEmptyString, isPlainObject } from './validate.js';

const REASONING_EFFORT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_ID_MAX_CHARS = 200;

/**
 * Throw the DESIGN §5.5 validation error.
 * @param {string} message - what failed.
 * @returns {never}
 */
function invalidSettings(message) {
  throw apiError('INVALID_SETTINGS', message);
}

/**
 * Validate one prompt field. Blank/null restores the default (encoded as an
 * `undefined` patch value); unknown placeholders only produce warnings.
 * @param {unknown} value - raw field value.
 * @param {'systemPrompt'|'userTemplate'} field - field name.
 * @param {number} maxChars - length cap.
 * @param {string[]} warnings - collector.
 * @returns {string | undefined}
 */
function normalizePromptValue(value, field, maxChars, warnings) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalidSettings(`${field} must be a string`);
  if (value.length > maxChars) invalidSettings(`${field} exceeds ${maxChars} characters`);
  if (value.trim().length === 0) return undefined;
  for (const placeholder of findUnknownPlaceholders(value)) {
    warnings.push(`unknown placeholder {{${placeholder}}} in ${field}`);
  }
  return value;
}

/**
 * Validate a provider/model id.
 * @param {unknown} value - raw field value.
 * @param {string} field - field name.
 * @returns {string}
 */
function normalizeModelId(value, field) {
  if (!isNonEmptyString(value, MODEL_ID_MAX_CHARS)) {
    invalidSettings(`${field} must be a non-empty string of at most ${MODEL_ID_MAX_CHARS} characters`);
  }
  return value.trim();
}

/**
 * Validate a bounded integer setting.
 * @param {unknown} value - raw field value.
 * @param {string} field - field name.
 * @param {{min: number, max: number}} range - allowed range.
 * @returns {number}
 */
function normalizeInteger(value, field, range) {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    invalidSettings(`${field} must be an integer between ${range.min} and ${range.max}`);
  }
  return value;
}

/**
 * Validate and normalize one `PUT /settings` body (DESIGN §5.5).
 *
 * Unknown keys are ignored with a warning; a body with no recognized key is an
 * error. The returned `values` map uses `undefined` to mean "restore default".
 * @param {unknown} raw - untrusted request body.
 * @returns {{values: Record<string, unknown>, warnings: string[]}}
 */
export function normalizeSettingsPatch(raw) {
  if (!isPlainObject(raw)) invalidSettings('settings must be a JSON object');
  const values = {};
  const warnings = [];
  let recognized = 0;

  for (const [key, value] of Object.entries(raw)) {
    if (!SETTINGS_KEYS.includes(key)) {
      warnings.push(`unknown settings field: ${key}`);
      continue;
    }
    recognized += 1;
    if (key === 'provider' || key === 'model') {
      values[key] = normalizeModelId(value, key);
    } else if (key === 'reasoningEffort') {
      if (typeof value !== 'string' || !REASONING_EFFORT_PATTERN.test(value.trim())) {
        invalidSettings('reasoningEffort must be "auto" or an effort id');
      }
      values.reasoningEffort = value.trim();
    } else if (key === 'targetLanguage') {
      if (typeof value !== 'string' || !TARGET_LANGUAGES.includes(value.trim())) {
        invalidSettings(`targetLanguage must be one of: ${TARGET_LANGUAGES.join(', ')}`);
      }
      values.targetLanguage = value.trim();
    } else if (key === 'translationStyle') {
      if (typeof value !== 'string' || !TRANSLATION_STYLES.includes(value.trim())) {
        invalidSettings(`translationStyle must be one of: ${TRANSLATION_STYLES.join(', ')}`);
      }
      values.translationStyle = value.trim();
    } else if (key === 'dictionaryProvider') {
      if (typeof value !== 'string' || !DICTIONARY_PROVIDERS.includes(value.trim())) {
        invalidSettings(`dictionaryProvider must be one of: ${DICTIONARY_PROVIDERS.join(', ')}`);
      }
      values.dictionaryProvider = value.trim();
    } else if (key === 'imageModel') {
      if (typeof value !== 'string') invalidSettings('imageModel must be a string');
      const trimmed = value.trim();
      if (trimmed !== 'auto' && !/^[A-Za-z0-9._-]{1,120}::[A-Za-z0-9._\/-]{1,200}$/u.test(trimmed)) {
        invalidSettings('imageModel must be "auto" or "provider::model"');
      }
      values.imageModel = trimmed;
    } else if (key === 'systemPrompt') {
      values.systemPrompt = normalizePromptValue(value, key, LIMITS.systemPromptChars, warnings);
    } else if (key === 'userTemplate') {
      values.userTemplate = normalizePromptValue(value, key, LIMITS.userTemplateChars, warnings);
    } else if (key === 'batchSegments') {
      values.batchSegments = normalizeInteger(value, key, LIMITS.batchSegments);
    } else if (key === 'batchChars') {
      values.batchChars = normalizeInteger(value, key, LIMITS.batchChars);
    } else if (key === 'concurrency') {
      values.concurrency = normalizeInteger(value, key, LIMITS.concurrency);
    } else if (key === 'recordHistory') {
      if (typeof value !== 'boolean') invalidSettings('recordHistory must be a boolean');
      values.recordHistory = value;
    }
  }

  if (recognized === 0) invalidSettings('no settings fields were provided');
  return { values, warnings };
}

/**
 * Leniently clean a persisted settings object: every invalid/unknown field is
 * dropped rather than rejected, so a hand-edited file cannot brick the plugin.
 * @param {unknown} raw - `settings.json`.settings value.
 * @returns {Record<string, unknown>}
 */
export function sanitizeSavedSettings(raw) {
  if (!isPlainObject(raw)) return {};
  const clean = {};
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    try {
      const { values } = normalizeSettingsPatch({ [key]: raw[key] });
      const value = values[key];
      if (value !== undefined) clean[key] = value;
    } catch {
      // Drop the invalid field; the effective view falls back to defaults.
    }
  }
  return clean;
}

/**
 * Build the effective settings view (`GET /settings.settings`): factory
 * defaults, then saved values, then the default-model selection when the user
 * never chose a provider/model, then non-empty prompts.
 * @param {unknown} saved - persisted settings.
 * @param {{provider?: string, model?: string}} [defaultSelection] - DSH agent default model.
 * @returns {{settings: Record<string, unknown>, source: 'settings'|'default'}}
 */
export function effectiveSettings(saved, defaultSelection = {}) {
  const stored = sanitizeSavedSettings(saved);
  const hasSavedModel = isNonEmptyString(stored.provider, MODEL_ID_MAX_CHARS)
    && isNonEmptyString(stored.model, MODEL_ID_MAX_CHARS);
  const provider = hasSavedModel
    ? stored.provider
    : (typeof defaultSelection?.provider === 'string' ? defaultSelection.provider : '');
  const model = hasSavedModel
    ? stored.model
    : (typeof defaultSelection?.model === 'string' ? defaultSelection.model : '');
  const prompts = effectivePrompts(stored);

  const settings = {
    ...DEFAULTS,
    ...stored,
    provider,
    model,
    systemPrompt: prompts.systemPrompt,
    userTemplate: prompts.userTemplate,
  };
  if (!isNonEmptyString(settings.reasoningEffort, 64)) settings.reasoningEffort = DEFAULTS.reasoningEffort;
  return { settings, source: hasSavedModel ? 'settings' : 'default' };
}

/**
 * Read/merge/persist saved settings in one collaborator.
 * @param {{store: import('./store.js').JsonFileStore, logger?: object,
 *   now?: () => number}} input - injected dependencies.
 * @returns {{loadSaved: () => Promise<Record<string, unknown>>,
 *   save: (values: Record<string, unknown>) => Promise<Record<string, unknown>>}}
 */
export function createSettingsService({ store, logger, now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();

  return {
    /**
     * Load persisted settings, leniently sanitized.
     * @returns {Promise<Record<string, unknown>>}
     */
    async loadSaved() {
      const data = await store.read();
      return sanitizeSavedSettings(data?.settings);
    },

    /**
     * Merge one validated patch into the stored settings and persist atomically.
     * A patch value of `undefined` deletes the stored field (restore default).
     * @param {Record<string, unknown>} values - result of {@link normalizeSettingsPatch}.
     * @returns {Promise<Record<string, unknown>>} the new stored settings.
     */
    async save(values) {
      const patch = isPlainObject(values) ? values : {};
      return store.mutate((data) => {
        const next = { ...sanitizeSavedSettings(data?.settings) };
        for (const [key, value] of Object.entries(patch)) {
          if (!SETTINGS_KEYS.includes(key)) continue;
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        data.version = SETTINGS_VERSION;
        data.settings = next;
        data.updatedAt = clock();
        try {
          logger?.debug?.('[dsh-web-translator] settings saved');
        } catch {
          // Logging must not break persistence.
        }
        return next;
      });
    },
  };
}
