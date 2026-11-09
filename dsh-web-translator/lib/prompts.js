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
  TRANSLATION_STYLES,
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
  'pageTitle',
  'pageUrl',
  'pageSite',
  'pageContext',
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

/** Signals that a page is software/programming documentation, used for terminology hints. */
const TECHNICAL_HOST_PATTERN = /(^|\.)((github|gitlab)\.com|stackoverflow\.com|stackexchange\.com|developer\.|docs?\.|rust-lang\.org|go\.dev|python\.org|mozilla\.org|npmjs\.com|kubernetes\.io|reactjs\.org|react\.dev)$/i;
const TECHNICAL_TERMS = Object.freeze([
  'rust', 'cargo', 'trait', 'struct', 'enum', 'impl', 'compiler', 'programming',
  'javascript', 'typescript', 'python', 'function', 'api', 'sdk', 'framework',
  'library', 'runtime', 'async', 'database', 'server', 'kubernetes', 'react',
  'documentation', 'developer', 'source code', 'repository', 'pointer', 'socket',
]);

/**
 * Heuristic: does this page look like software/programming documentation?
 * Used only to append a terminology hint; safe to be conservative.
 * @param {{title?: string, url?: string, texts?: readonly string[]}} input
 * @returns {boolean}
 */
export function looksLikeTechnicalContent({ title = '', url = '', texts = [] } = {}) {
  let host = '';
  try {
    host = new URL(String(url)).host;
  } catch {
    host = '';
  }
  if (TECHNICAL_HOST_PATTERN.test(host)) return true;
  const haystack = `${title}\n${url}\n${Array.isArray(texts) ? texts.join('\n') : ''}`.toLowerCase();
  let hits = 0;
  for (const term of TECHNICAL_TERMS) {
    if (haystack.includes(term)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

/**
 * Context block prepended to prompts. Metadata is not translated; the technical
 * hint only nudges terminology and is not used for non-programming pages.
 * @param {{title?: string, url?: string, technical?: boolean}} [pageContext]
 * @param {{compact?: boolean}} [options]
 * @returns {string}
 */
export function renderPageContext(pageContext = {}, { compact = false } = {}) {
  const title = typeof pageContext?.title === 'string' ? pageContext.title.trim().slice(0, 240) : '';
  const url = typeof pageContext?.url === 'string' ? pageContext.url.trim().slice(0, 2048) : '';
  const style = TRANSLATION_STYLES.includes(pageContext?.style) ? pageContext.style : 'auto';
  const technical = pageContext?.technical === true || style === 'programming';
  const lines = [];
  if (title.length > 0 || url.length > 0) {
    lines.push('Page context (do not translate this metadata; use it only to disambiguate terminology):');
    if (title.length > 0) lines.push(`- Page title: ${title}`);
    if (url.length > 0) lines.push(`- Page URL: ${url}`);
  }
  if (technical && (style === 'auto' || style === 'programming')) {
    if (lines.length === 0) lines.push('Page context:');
    lines.push(
      compact
        ? 'This is software/programming content. Mandatory terminology: keep "trait"/"traits" in English (never 特征/特质), keep "crate"/"impl" unchanged; translate "port" in networking as 端口. Apply the same rule in headings.'
        : 'This page appears to be software/programming documentation. Prefer standard technical Chinese terminology and follow these mandatory rules even in prose/headings: keep "trait" and "traits" in English exactly (never translate them as "特征" or "特质"); keep "crate", "impl" and language keywords unchanged when they are identifiers; translate "port" in a networking/programming context as "端口". For example, the heading "Defining Shared Behavior" with "Traits" must keep "Traits" as "Traits". Protected terms may appear as tokens like [[DSH_KEEP_0_0]]; copy every token verbatim into the translation and never translate or remove it.',
    );
  } else if (style === 'tech') {
    if (lines.length === 0) lines.push('Page context:');
    lines.push(
      compact
        ? 'Translation style: technology/engineering. Use standard Chinese technical terminology; keep product, company, API, command and code names in their original form; avoid over-literal translation.'
        : 'Translation style: technology/engineering content. Use standard, precise Chinese technical terminology. Keep product names, company names, API names, commands, code identifiers and version numbers in their original form. Avoid over-literal translation; when a term has an established Chinese technical translation, use it consistently.',
    );
  } else if (style === 'finance') {
    if (lines.length === 0) lines.push('Page context:');
    lines.push(
      compact
        ? 'Translation style: finance/markets. Use formal, precise Chinese financial terminology; preserve numbers, currencies, tickers, dates and percentages exactly.'
        : 'Translation style: finance/markets content. Use formal, precise Chinese financial terminology and preserve numbers, currencies, tickers, dates, percentages and units exactly as written. Avoid literal translations of market idioms; for example yield → 收益率, position → 持仓, liquidity → 流动性, drawdown → 回撤, bullish/bearish → 看涨/看跌.',
    );
  }
  return lines.join('\n');
}

/**
 * Render the system + user prompts for one translation batch (DESIGN §4.1).
 * @param {{systemPrompt?: string, userTemplate?: string, texts: readonly string[],
 *   targetLanguage: string, sourceLanguage?: string,
 *   pageContext?: {title?: string, url?: string, technical?: boolean}}} input - batch context.
 * @returns {{system: string, user: string, textsJson: string, segmentCount: number}}
 */
export function renderTranslatePrompts({ systemPrompt, userTemplate, texts, targetLanguage, sourceLanguage = 'auto', pageContext }) {
  const segments = Array.isArray(texts) ? texts : [];
  const textsJson = JSON.stringify(segments);
  const contextText = renderPageContext(pageContext);
  const values = {
    targetLanguage,
    sourceLanguage,
    segmentCount: segments.length,
    segmentsJson: textsJson,
    segments: renderNumberedSegments(segments),
    pageTitle: pageContext?.title ?? '',
    pageUrl: pageContext?.url ?? '',
    pageSite: pageContext?.site ?? '',
    pageContext: contextText,
  };
  const baseSystem = renderTemplate(systemPrompt ?? DEFAULT_SYSTEM_PROMPT, values);
  const hasLinkMarkers = segments.some((text) => typeof text === 'string' && /\[\[\s*\d+\s*\]\]/.test(text));
  const linkNote = hasLinkMarkers
    ? 'Inline link/code markers look like [[1]]...[[/1]]: preserve each marker pair exactly, translate only the text between them, and keep code marker contents literal (file names, commands, identifiers).'
    : '';
  let system = contextText.length > 0 ? contextText + '\n\n' + baseSystem : baseSystem;
  if (linkNote.length > 0) system += '\n\n' + linkNote;
  return {
    system,
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
export function renderLookupPrompts({ text, context, targetLanguage, pageContext }) {
  const lines = [`Source text: ${text}`];
  if (typeof context === 'string' && context.trim().length > 0) lines.push(`Context: ${context.trim()}`);
  const pageText = renderPageContext(pageContext, { compact: true });
  if (pageText.length > 0) lines.push(pageText);
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
