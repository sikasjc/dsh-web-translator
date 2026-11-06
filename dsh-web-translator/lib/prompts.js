/**
 * Prompt templates and `{{placeholder}}` rendering (DESIGN §4.1).
 *
 * The translate prompts are user-editable settings; the lookup prompts are
 * fixed because `POST /lookup` has a different output contract (plain
 * translation text, no JSON). Default prompt text lives in `constants.js` so
 * the settings API, the tests and this renderer share one source of truth.
 */
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_TEMPLATE,
  LIMITS,
} from './constants.js';

export { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE };

/** Hard caps enforced when saving prompts (DESIGN §4.1). */
export const PROMPT_LIMITS = Object.freeze({
  systemPrompt: LIMITS.systemPromptChars,
  userTemplate: LIMITS.userTemplateChars,
});

/** Placeholders the host renders for translation prompts. */
export const TRANSLATE_PLACEHOLDERS = Object.freeze([
  'targetLanguage',
  'sourceLanguage',
  'segmentCount',
  'segmentsJson',
  'segments',
]);

/** Fixed lookup system prompt: plain translation, no JSON envelope. */
export const LOOKUP_SYSTEM_PROMPT = [
  'You are a bilingual dictionary and translator. Translate the given source text into {{targetLanguage}}.',
  'For a single English word, answer with a concise dictionary-style gloss, separating senses with "; ".',
  'For a phrase or sentence, answer with a natural translation and nothing else.',
  'Output only the translation text: no quotes, no markdown, no explanations.',
].join('\n');

/** Message appended when a translation reply cannot be parsed (DESIGN §4.3.4). */
export const CORRECTION_MESSAGE = 'Return only the required JSON.';

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/**
 * Render `{{name}}` placeholders with the supplied values. Unknown placeholders
 * are preserved literally (the settings API only warns about them, DESIGN §4.1).
 * @param {string} template - template text.
 * @param {Record<string, unknown>} values - placeholder values.
 * @returns {string}
 */
export function renderTemplate(template, values) {
  const source = typeof template === 'string' ? template : '';
  return source.replace(PLACEHOLDER_PATTERN, (match, name) => (
    Object.hasOwn(values, name) ? String(values[name]) : match
  ));
}

/**
 * List placeholders a template uses that the host will not render.
 * @param {string} template - template text.
 * @param {readonly string[]} [allowed] - supported placeholder names.
 * @returns {string[]} unique unknown names in order of appearance.
 */
export function findUnknownPlaceholders(template, allowed = TRANSLATE_PLACEHOLDERS) {
  const known = new Set(allowed);
  const unknown = [];
  const source = typeof template === 'string' ? template : '';
  for (const match of source.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (!known.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

/**
 * Render the numbered `{{segments}}` placeholder form.
 * @param {readonly string[]} texts - source segments.
 * @returns {string} `1. ...\n2. ...`
 */
export function renderNumberedSegments(texts) {
  return texts.map((text, index) => `${index + 1}. ${text}`).join('\n');
}

/**
 * Render the system + user prompts for one translation batch (DESIGN §4.1).
 * @param {{systemPrompt?: string, userTemplate?: string, texts: readonly string[],
 *   targetLanguage: string, sourceLanguage?: string}} input - batch context.
 * @returns {{system: string, user: string, textsJson: string, segmentCount: number}}
 */
export function renderTranslatePrompts({ systemPrompt, userTemplate, texts, targetLanguage, sourceLanguage = 'auto' }) {
  const segments = Array.isArray(texts) ? texts : [];
  const textsJson = JSON.stringify(segments);
  const values = {
    targetLanguage,
    sourceLanguage,
    segmentCount: segments.length,
    segmentsJson: textsJson,
    segments: renderNumberedSegments(segments),
  };
  return {
    system: renderTemplate(systemPrompt ?? DEFAULT_SYSTEM_PROMPT, values),
    user: renderTemplate(userTemplate ?? DEFAULT_USER_TEMPLATE, values),
    textsJson,
    segmentCount: segments.length,
  };
}

/**
 * Render the fixed dictionary/translation prompt used by `POST /lookup`.
 * @param {{text: string, context?: string, targetLanguage: string}} input - lookup context.
 * @returns {{system: string, user: string}}
 */
export function renderLookupPrompts({ text, context, targetLanguage }) {
  const lines = [`Source text: ${text}`];
  if (typeof context === 'string' && context.trim().length > 0) lines.push(`Context: ${context.trim()}`);
  lines.push(`Target language: ${targetLanguage}`);
  return {
    system: renderTemplate(LOOKUP_SYSTEM_PROMPT, { targetLanguage }),
    user: lines.join('\n'),
  };
}

/**
 * Resolve prompt settings to their effective values: missing/blank text falls
 * back to the defaults (DESIGN §4.1).
 * @param {{systemPrompt?: unknown, userTemplate?: unknown}} [saved] - stored settings.
 * @returns {{systemPrompt: string, userTemplate: string}}
 */
export function effectivePrompts({ systemPrompt, userTemplate } = {}) {
  return {
    systemPrompt: typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
      ? systemPrompt
      : DEFAULT_SYSTEM_PROMPT,
    userTemplate: typeof userTemplate === 'string' && userTemplate.trim().length > 0
      ? userTemplate
      : DEFAULT_USER_TEMPLATE,
  };
}
