/**
 * Technical terminology support for programming / technical pages.
 *
 * Terminology is organized as **libraries** (DESIGN §5.7.3):
 *   - built-in packs (`rust`, `programming`) defined here and applied only on
 *     technical pages (translation style `programming`, or `auto` detected as
 *     technical content) — see `buildTerminologyRules()`;
 *   - user-created custom libraries persisted by `term-libraries.js` and applied
 *     on every page while enabled.
 *
 * Each entry either keeps the English term (`policy: 'keep'`, protected with an
 * opaque token the model is told to copy) or maps it to a fixed Chinese wording
 * (`policy: 'translate'`, enforced by the prompt hint and by a deterministic
 * post-translation fallback when `badRenderings` are known).
 *
 * The engine is deterministic: it never rewrites text unless the source segment
 * actually contains one of the active terms.
 */

/** Tokens used for keep-original terms (unlikely to appear in normal text). */
const TOKEN_PREFIX = '[[DSH_KEEP_';

/** Limits shared by the persisted service, the API contract and the settings UI. */
export const TERM_LIBRARY_LIMITS = Object.freeze({
  /** Maximum number of custom libraries (built-in packs do not count). */
  libraries: 20,
  /** Maximum terms per custom library. */
  termsPerLibrary: 200,
  /** Library name length cap. */
  nameChars: 40,
  /** Term source length cap. */
  sourceChars: 120,
  /** Fixed-translation target length cap. */
  targetChars: 120,
});

/** Supported entry policies. */
export const TERM_ENTRY_POLICIES = Object.freeze(['keep', 'translate']);

/**
 * Built-in terminology packs. `pattern`/`protect`/`badRenderings` are engine
 * fields; `name`/`description`/`source`/`target` are the read-only UI view
 * served by `GET /terms`. Built-in packs are only applied on technical pages.
 */
export const BUILTIN_TERM_LIBRARIES = Object.freeze([
  Object.freeze({
    id: 'rust',
    name: 'Rust 编程',
    description: 'Rust 语言与类型论术语：trait/crate/impl 保留原文，uninhabited type 固定译为「无值类型」。',
    builtin: true,
    hint: Object.freeze({
      compact: 'keep "trait"/"traits" in English (never 特征/特质), keep "crate"/"impl" unchanged; translate "uninhabited type" as 无值类型 (never 不可居住/不可继承).',
      full: 'keep "trait" and "traits" in English exactly (never translate them as "特征" or "特质"); keep "crate", "impl" and language keywords unchanged when they are identifiers; translate the type-theory term "uninhabited type" as "无值类型" (a type with no values; never render it as "不可居住" or "不可继承").',
    }),
    terms: Object.freeze([
      Object.freeze({
        id: 'trait',
        source: 'trait / traits',
        pattern: /\btrait(s)?\b/gi,
        policy: 'keep',
        badRenderings: Object.freeze(['特征', '特质']),
        protect: true,
      }),
      Object.freeze({
        id: 'crate-impl',
        source: 'crate / impl / language keywords',
        pattern: /\b(?:crate|impl)(?:s)?\b/gi,
        policy: 'keep',
        badRenderings: Object.freeze([]),
        protect: false,
      }),
      Object.freeze({
        id: 'uninhabited-type',
        source: 'uninhabited type / uninhabited types',
        pattern: /\buninhabited\s+types?\b/gi,
        policy: 'translate',
        target: '无值类型',
        badRenderings: Object.freeze(['不可继承', '不可居住', '无人居住', '无法居住', '不适居']),
        protect: false,
      }),
    ]),
  }),
  Object.freeze({
    id: 'programming',
    name: '通用编程 / 网络',
    description: '通用编程与网络语境术语：port 固定译为「端口」。',
    builtin: true,
    hint: Object.freeze({
      compact: 'translate "port" in networking as 端口.',
      full: 'translate "port" in a networking/programming context as "端口".',
    }),
    terms: Object.freeze([
      Object.freeze({
        id: 'port',
        source: 'port / ports',
        pattern: /\bport(s)?\b/gi,
        policy: 'translate',
        target: '端口',
        badRenderings: Object.freeze(['港口', '口岸']),
        protect: false,
      }),
    ]),
  }),
]);

/** Escape one literal string for a `RegExp` body. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile one custom-library term source into a case-insensitive matcher.
 * English words/phrases get word boundaries and an optional plural `s`; CJK or
 * punctuation-heavy terms are matched literally.
 * @param {unknown} source - raw term source.
 * @returns {RegExp | null}
 */
export function compileTermPattern(source) {
  const text = typeof source === 'string' ? source.trim() : '';
  if (!text) return null;
  const body = escapeRegExp(text).replace(/\\ /g, '\\s+').replace(/\s+/g, '\\s+');
  const startsWord = /^[A-Za-z0-9]/.test(text);
  const endsWord = /[A-Za-z0-9]$/.test(text);
  const plural = /^[A-Za-z]+$/.test(text) ? '(?:s)?' : '';
  return new RegExp(`${startsWord ? '\\b' : ''}${body}${plural}${endsWord ? '\\b' : ''}`, 'gi');
}

/** Build a deterministic token for one matched keep term. */
function makeToken(value, tokens) {
  const base = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'TERM';
  let token = `${TOKEN_PREFIX}${base}]]`;
  let counter = 2;
  while (tokens.some((entry) => entry.token === token && entry.value !== value)) {
    token = `${TOKEN_PREFIX}${base}_${counter}]]`;
    counter += 1;
  }
  return token;
}

/**
 * Convert one persisted custom library into the engine library shape.
 * @param {unknown} library - service library record.
 * @returns {{id: string, name: string, builtin: false, terms: object[]} | null}
 */
function customLibraryToEngine(library) {
  if (!library || typeof library !== 'object') return null;
  const libraryId = typeof library.id === 'string' ? library.id : '';
  const terms = [];
  for (const term of Array.isArray(library.terms) ? library.terms : []) {
    if (!term || typeof term !== 'object' || typeof term.source !== 'string') continue;
    const pattern = compileTermPattern(term.source);
    if (!pattern) continue;
    const policy = term.policy === 'translate' ? 'translate' : 'keep';
    const target = policy === 'translate' && typeof term.target === 'string' ? term.target.trim() : '';
    if (policy === 'translate' && target.length === 0) continue;
    const entryId = typeof term.id === 'string' ? term.id : '';
    terms.push({
      id: entryId,
      source: term.source,
      pattern,
      policy,
      target,
      badRenderings: [],
      protect: policy === 'keep',
      libraryId,
      entryId,
      key: `${libraryId}:${entryId}`,
    });
  }
  return {
    id: libraryId,
    name: typeof library.name === 'string' ? library.name : '',
    builtin: false,
    terms,
  };
}

/**
 * Build the terminology rules for one translation request.
 *
 * @param {{builtin?: readonly object[], custom?: readonly object[]}} [libraries] -
 *   enabled libraries (`builtin` packs are applied only when `technical`).
 * @param {{technical?: boolean}} [options] - whether the page is technical.
 * @returns {null | {
 *   hint: (compact?: boolean) => string,
 *   protect: (texts: readonly string[]) => {texts: string[], tokens: Array<{token: string, value: string}>},
 *   restore: (text: string, tokens: readonly object[]) => string,
 *   applyFallback: (sourceText: string, translatedText: string) => string
 * }}
 */
export function buildTerminologyRules(libraries = {}, { technical = false } = {}) {
  const engineLibraries = [];
  if (technical && Array.isArray(libraries.builtin)) {
    for (const library of libraries.builtin) {
      if (library && Array.isArray(library.terms)) engineLibraries.push(library);
    }
  }
  for (const library of Array.isArray(libraries.custom) ? libraries.custom : []) {
    const converted = customLibraryToEngine(library);
    if (converted !== null) engineLibraries.push(converted);
  }

  const keepRules = [];
  const fallbackRules = [];
  const fragments = { compact: [], full: [] };
  const entries = [];
  let usesBuiltin = false;

  for (const library of engineLibraries) {
    if (library.builtin) usesBuiltin = true;
    const libraryId = typeof library.id === 'string' ? library.id : '';
    const builtin = library.builtin === true;
    if (library.hint) {
      if (typeof library.hint.compact === 'string' && library.hint.compact.length > 0) {
        fragments.compact.push(library.hint.compact);
      }
      if (typeof library.hint.full === 'string' && library.hint.full.length > 0) {
        fragments.full.push(library.hint.full);
      }
    }
    const customFragments = { compact: [], full: [] };
    for (const term of Array.isArray(library.terms) ? library.terms : []) {
      const badRenderings = Array.isArray(term.badRenderings) ? term.badRenderings : [];
      const entryId = typeof term.id === 'string' ? term.id : '';
      const fixedTarget = term.policy === 'translate' && typeof term.target === 'string' ? term.target : '';
      if (term.pattern instanceof RegExp) {
        entries.push({
          key: `${libraryId}:${entryId}`,
          libraryId,
          entryId,
          builtin,
          source: typeof term.source === 'string' ? term.source : '',
          target: fixedTarget,
          policy: term.policy === 'translate' ? 'translate' : 'keep',
          pattern: term.pattern,
        });
      }
      if (term.policy === 'keep') {
        if (term.protect === true && term.pattern instanceof RegExp) keepRules.push(term);
        if (badRenderings.length > 0 && term.pattern instanceof RegExp) {
          fallbackRules.push({ pattern: term.pattern, badRenderings, keep: true });
        }
        if (!library.hint) {
          customFragments.compact.push(`keep "${term.source}" in English`);
          customFragments.full.push(`keep "${term.source}" in English exactly`);
        }
      } else if (term.policy === 'translate' && typeof term.target === 'string' && term.target.length > 0) {
        if (badRenderings.length > 0 && term.pattern instanceof RegExp) {
          fallbackRules.push({ pattern: term.pattern, badRenderings, target: term.target });
        }
        if (!library.hint) {
          customFragments.compact.push(`translate "${term.source}" as "${term.target}"`);
          customFragments.full.push(`translate "${term.source}" as "${term.target}" (use exactly this wording)`);
        }
      }
    }
    if (!library.hint) {
      if (customFragments.compact.length > 0) fragments.compact.push(customFragments.compact.join('; '));
      if (customFragments.full.length > 0) fragments.full.push(customFragments.full.join('; '));
    }
  }

  if (fragments.compact.length === 0 && fragments.full.length === 0) return null;

  const hasKeepTokens = keepRules.length > 0;

  /** Compose the prompt hint for the active libraries. */
  function hint(compact = false) {
    const parts = compact ? fragments.compact : fragments.full;
    if (parts.length === 0) return '';
    const prefix = usesBuiltin
      ? (compact
        ? 'This is software/programming content. Mandatory terminology: '
        : 'This page appears to be software/programming documentation. Prefer standard technical Chinese terminology and follow these mandatory rules even in prose/headings: ')
      : 'Mandatory terminology for this translation (user-defined terminology libraries): ';
    let text = prefix + parts.join(' ');
    if (hasKeepTokens) {
      text += ' Protected terms may appear as tokens like [[DSH_KEEP_0_0]]; copy every token verbatim into the translation and never translate or remove it.';
    }
    return text;
  }

  /** Replace keep terms with deterministic opaque tokens. */
  function protect(texts) {
    const tokens = [];
    const protectedTexts = [];
    for (const sourceText of Array.isArray(texts) ? texts : []) {
      let next = String(sourceText);
      for (const rule of keepRules) {
        rule.pattern.lastIndex = 0;
        next = next.replace(rule.pattern, (match) => {
          const token = makeToken(match, tokens);
          tokens.push({ token, value: match });
          return token;
        });
      }
      protectedTexts.push(next);
    }
    return { texts: protectedTexts, tokens };
  }

  /** Restore protected tokens in one translated segment. */
  function restore(text, tokens) {
    let result = typeof text === 'string' ? text : '';
    for (const entry of Array.isArray(tokens) ? tokens : []) {
      if (!entry || typeof entry.token !== 'string') continue;
      result = result.split(entry.token).join(entry.value);
    }
    return result;
  }

  /** Last-resort terminology fix when the model ignored the prompt. */
  function applyFallback(sourceText, translatedText) {
    let result = typeof translatedText === 'string' ? translatedText : '';
    const source = typeof sourceText === 'string' ? sourceText : '';
    for (const rule of fallbackRules) {
      rule.pattern.lastIndex = 0;
      const matched = source.match(rule.pattern);
      rule.pattern.lastIndex = 0;
      if (!matched || matched.length === 0) continue;
      const badList = rule.badRenderings.map(escapeRegExp).join('|');
      // A target that already carries the Chinese noun (e.g. 无值类型) replaces
      // the whole phrase including an optional 的 + 类型, so the noun never
      // appears twice. Noun-free targets (e.g. 端口) only replace the bad wording.
      const badPattern = rule.keep === true
        ? new RegExp(badList, 'g')
        : new RegExp(rule.target.endsWith('类型') ? `(?:${badList})(?:的)?类型` : `(?:${badList})`, 'g');
      const replacement = rule.keep === true ? String(matched[0]) : rule.target;
      result = result.replace(badPattern, replacement);
    }
    return result;
  }

  return { hint, protect, restore, applyFallback, entries };
}

/** Remove `[[TE1]]...[[/TE1]]` markers, keeping the text inside them. */
export function stripTermAnnotationMarkers(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\[\[\s*TE\d+\s*\]\]/g, '')
    .replace(/\[\[\s*\/\s*TE\d+\s*\]\]/g, '');
}
