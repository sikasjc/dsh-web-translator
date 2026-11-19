/**
 * Unknown-term discovery for the browser extension (DESIGN §5.7.4).
 *
 * The translation model is asked to return, next to `translations`, a
 * `terms` array with source/target pairs it used. This module validates those
 * candidates, drops terms already covered by an enabled terminology library,
 * drops common technical terms with an established Chinese rendering, caps the
 * list, and marks the remaining target occurrences in the translated segments
 * with `[[TE1]]...[[/TE1]]` markers for the extension.
 *
 * It never talks to a model and never mutates its inputs.
 */
/** Hard caps for one model suggestion batch (kept deliberately small). */
export const TERM_SUGGESTION_LIMITS = Object.freeze({
  /** Candidate terms kept for one request. */
  items: 6,
  /** Candidate terms kept for one segment. */
  perSegment: 2,
  /** Source term length cap. */
  sourceChars: 120,
  /** Target term length cap. */
  targetChars: 120,
});

/**
 * Common technical vocabulary with an established Chinese rendering. These are
 * exactly the terms the extension should NOT ask the reader to decide about;
 * the model is told to skip them, and this set is the deterministic backstop
 * for Chinese targets. Product/API names and emerging jargon stay out of it.
 */
const CONVENTIONAL_ZH_TERMS = new Set([
  'server', 'client', 'database', 'cache', 'function', 'method', 'module', 'package',
  'library', 'framework', 'compiler', 'runtime', 'interpreter', 'repository', 'branch',
  'commit', 'merge', 'pull request', 'issue', 'deployment', 'deploy', 'container',
  'cluster', 'node', 'pod', 'service', 'microservice', 'request', 'response', 'protocol',
  'socket', 'port', 'memory', 'process', 'thread', 'lock', 'mutex', 'semaphore', 'queue',
  'stack', 'heap', 'pointer', 'reference', 'array', 'list', 'map', 'set', 'object', 'class',
  'interface', 'inheritance', 'polymorphism', 'abstraction', 'encapsulation', 'variable',
  'constant', 'parameter', 'argument', 'exception', 'error', 'bug', 'debug', 'test',
  'build', 'dependency', 'version', 'release', 'feature', 'flag', 'feature flag',
  'deadlock', 'concurrency', 'parallelism', 'asynchronous', 'async', 'callback', 'promise',
  'middleware', 'proxy', 'gateway', 'load balancer', 'api gateway', 'encryption',
  'authentication', 'authorization', 'token', 'session', 'cookie', 'header', 'payload',
  'endpoint', 'route', 'handler', 'event', 'event loop', 'stream', 'buffer', 'latency',
  'throughput', 'bandwidth', 'message queue', 'rate limit', 'rate limiting', 'circuit breaker',
  'garbage collection', 'dependency injection', 'design pattern', 'unit test', 'code review',
  'agent', 'model', 'prompt', 'embedding', 'inference', 'multimodal', 'fine-tuning',
  'vector', 'vector store', 'vector database', 'context window', 'dataset', 'training',
  'algorithm', 'llm', 'api', 'sdk', 'cli', 'ui', 'ux', 'http', 'https', 'json', 'xml',
  'html', 'css', 'sql', 'url', 'uri', 'id', 'cpu', 'gpu', 'ram', 'os', 'db', 'jwt',
  'oauth', 'cors', 'cdn', 'dns', 'tcp', 'udp', 'ip', 'tls', 'ssl', 'ssh', 'ftp', 'rest',
  'graphql', 'workflow', 'pipeline', 'configuration', 'config', 'environment', 'infrastructure',
  'architecture', 'component', 'template', 'schema', 'metadata', 'instance', 'namespace',
  'source code', 'command line', 'machine learning', 'deep learning', 'neural network',
  'large language model', 'natural language processing', 'computer vision', 'reinforcement learning',
  'quantization', 'distillation', 'retrieval-augmented generation', 'rag', 'hallucination',
  'scaffold', 'tool use', 'function calling', 'chain of thought', 'zero-shot', 'few-shot',
  'tokenizer', 'attention', 'diffusion', 'prompt injection', 'jailbreak',
]);

/** True when a term has an established Chinese rendering and should not be suggested. */
export function isConventionalTerm(source, targetLanguage) {
  const language = String(targetLanguage || '').toLowerCase();
  if (!language.startsWith('zh')) return false;
  const lower = String(source || '').trim().toLowerCase();
  if (!lower) return false;
  if (CONVENTIONAL_ZH_TERMS.has(lower)) return true;
  if (lower.endsWith('es') && CONVENTIONAL_ZH_TERMS.has(lower.slice(0, -2))) return true;
  if (lower.endsWith('s') && CONVENTIONAL_ZH_TERMS.has(lower.slice(0, -1))) return true;
  return false;
}

/**
 * Instruction appended to the translate system prompt when `suggestTerms` is
 * on. It explicitly overrides the default "no extra keys" contract.
 */
export const TERM_SUGGESTION_NOTE = [
  'Terminology discovery (this request only): additionally include a top-level "terms" array in the same JSON object.',
  'Only include terms that do NOT already have an established, conventional translation in the target language: product/API/command names, emerging jargon, abbreviations, or terms a professional would likely keep in English or translate differently each time.',
  'Exclude ordinary technical vocabulary with a standard dictionary/industry rendering (for example server, client, database, cache, function, module, framework, library, compiler, runtime, thread, process, queue, port, protocol, request, response, feature flag, deadlock).',
  'At most 2 items per segment and 6 per request; prefer 0-3 for the whole batch. Skip everyday words, numbers, and anything already covered by the terminology instructions above.',
  'Each item must be {"segment": <0-based segment index>, "source": "<exact source wording>", "target": "<exact wording used in that translation>"}.',
  'Use [] when there are none. "terms" is the only allowed extra key and overrides any earlier instruction that forbids extra keys.',
].join(' ');

/** @param {unknown} value @returns {string} */
function asTrimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** True when an enabled terminology entry already covers this source. */
export function isKnownTerm(source, entries) {
  const text = asTrimmed(source);
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.pattern instanceof RegExp) {
      entry.pattern.lastIndex = 0;
      const match = entry.pattern.exec(text);
      entry.pattern.lastIndex = 0;
      // Only a full-candidate match counts: a known "deadlock" must not hide a
      // new compound candidate such as "deadlock detection".
      if (match && match.index === 0 && match[0].length === text.length) return true;
    }
    const label = typeof entry.source === 'string' ? entry.source.trim().toLowerCase() : '';
    // A candidate that is a sub-phrase of a known label ("tree" of "behavior
    // tree", "port" of "port / ports") is already covered.
    if (label && label.includes(lower)) return true;
  }
  return false;
}

/** Case-insensitive substring test. */
function contains(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

/**
 * Validate and filter raw model suggestions.
 *
 * @param {unknown} rawTerms - model `terms` array.
 * @param {{segmentCount?: number, sources?: readonly string[], translations?: readonly string[],
 *   knownEntries?: readonly object[], targetLanguage?: string}} [context] - request segments and libraries.
 * @returns {Array<{segment: number, source: string, target: string}>}
 */
export function normalizeTermSuggestions(rawTerms, {
  segmentCount = 0,
  sources = [],
  translations = [],
  knownEntries = [],
  targetLanguage = '',
} = {}) {
  const list = Array.isArray(rawTerms) ? rawTerms : [];
  const sourceTexts = Array.isArray(sources) ? sources : [];
  const translatedTexts = Array.isArray(translations) ? translations : [];
  const total = Number.isInteger(segmentCount) && segmentCount > 0 ? segmentCount : sourceTexts.length;
  const result = [];
  const perSegment = Object.create(null);
  const seenSources = Object.create(null);

  for (const raw of list) {
    if (result.length >= TERM_SUGGESTION_LIMITS.items) break;
    if (!raw || typeof raw !== 'object') continue;
    const segment = Number.isInteger(raw.segment) ? raw.segment : -1;
    if (segment < 0 || segment >= total) continue;
    const source = asTrimmed(raw.source);
    const target = asTrimmed(raw.target);
    if (!source || !target) continue;
    if (source.length > TERM_SUGGESTION_LIMITS.sourceChars) continue;
    if (target.length > TERM_SUGGESTION_LIMITS.targetChars) continue;
    if (source.toLowerCase() === target.toLowerCase()) continue;
    if (!contains(sourceTexts[segment], source)) continue;
    if (!contains(translatedTexts[segment], target) && !contains(translatedTexts[segment], source)) continue;
    const key = source.toLowerCase();
    if (seenSources[key]) continue;
    if (isKnownTerm(source, knownEntries)) continue;
    if (isConventionalTerm(source, targetLanguage)) continue;
    const count = perSegment[segment] || 0;
    if (count >= TERM_SUGGESTION_LIMITS.perSegment) continue;
    perSegment[segment] = count + 1;
    seenSources[key] = true;
    result.push({ segment, source, target });
  }
  return result;
}

/** Ranges occupied by the extension's inline link/code markers `[[n]]...[[/n]]`. */
function linkMarkerRanges(text) {
  const ranges = [];
  const pattern = /\[\[\s*(\d+)\s*\]\][\s\S]*?\[\[\s*\/\s*\1\s*\]\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/** Find every literal occurrence of `needle` (case-insensitive). */
function findLiteralOccurrences(haystack, needle) {
  const found = [];
  const text = typeof haystack === 'string' ? haystack : '';
  const value = typeof needle === 'string' ? needle : '';
  if (!text || !value) return found;
  const source = text.toLowerCase();
  const target = value.toLowerCase();
  let from = 0;
  while (from <= source.length - target.length) {
    const at = source.indexOf(target, from);
    if (at < 0) break;
    found.push({ start: at, end: at + value.length });
    from = at + Math.max(1, target.length);
  }
  return found;
}

/** True when `[start, end)` overlaps any range. */
function overlapsRanges(start, end, ranges) {
  return ranges.some((range) => start < range.end && end > range.start);
}

/**
 * Wrap unknown-term occurrences in the translated segments.
 *
 * The source segment must contain the suggested source wording; the target
 * from the model is preferred, with the source wording as fallback when the
 * model kept it untranslated. Link/code markers are left untouched.
 *
 * @param {readonly {segment: number, source: string, target: string}[]} suggestions
 * @param {{sources?: readonly string[], translations?: readonly string[]}} input
 * @returns {{translations: string[], annotations: Array<object>}}
 */
export function markUnknownTerms(suggestions, { sources = [], translations = [] } = {}) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  const sourceTexts = Array.isArray(sources) ? sources : [];
  const translatedTexts = Array.isArray(translations) ? translations : [];
  const annotations = [];
  const output = translatedTexts.map((translated) => (typeof translated === 'string' ? translated : ''));
  const linksBySegment = output.map((text) => linkMarkerRanges(text));
  const rangesBySegment = output.map(() => []);
  let nextId = 1;

  for (const suggestion of list) {
    if (!suggestion || typeof suggestion.source !== 'string' || typeof suggestion.target !== 'string') continue;
    const sourceLower = suggestion.source.toLowerCase();
    const key = `unknown:${sourceLower}`;
    let addedForSource = 0;
    for (let segment = 0; segment < output.length; segment += 1) {
      if (addedForSource >= 20) break;
      if (!contains(sourceTexts[segment], suggestion.source)) continue;
      const text = output[segment];
      if (!text) continue;
      let form = 'target';
      let occurrences = findLiteralOccurrences(text, suggestion.target);
      if (occurrences.length === 0) {
        form = 'source';
        occurrences = findLiteralOccurrences(text, suggestion.source);
      }
      for (const occurrence of occurrences) {
        if (addedForSource >= 20) break;
        if (overlapsRanges(occurrence.start, occurrence.end, linksBySegment[segment])) continue;
        if (overlapsRanges(occurrence.start, occurrence.end, rangesBySegment[segment])) continue;
        const id = nextId;
        nextId += 1;
        rangesBySegment[segment].push({ start: occurrence.start, end: occurrence.end, id });
        annotations.push({
          id,
          key,
          source: suggestion.source,
          target: suggestion.target,
          form,
          segment,
        });
        addedForSource += 1;
      }
    }
  }

  if (annotations.length === 0) return { translations: output, annotations };
  // Rebuild each segment with markers and account for ranges within it.
  const marked = output.map((text, segment) => {
    const ranges = rangesBySegment[segment]
      .slice()
      .sort((left, right) => left.start - right.start || right.end - left.end);
    if (ranges.length === 0) return text;
    let cursor = 0;
    let result = '';
    let lastEnd = -1;
    for (const range of ranges) {
      if (range.start < lastEnd) continue;
      result += text.slice(cursor, range.start);
      result += `[[TE${range.id}]]${text.slice(range.start, range.end)}[[/TE${range.id}]]`;
      cursor = range.end;
      lastEnd = range.end;
    }
    result += text.slice(cursor);
    return result;
  });
  return { translations: marked, annotations };
}

/** Serialize suggestions for the persistent suggestion cache (one string cell). */
export function serializeSuggestionCache(suggestions) {
  try {
    return [JSON.stringify(Array.isArray(suggestions) ? suggestions : [])];
  } catch {
    return ['[]'];
  }
}

/** Parse one suggestion-cache value (a one-element JSON string array). */
export function parseSuggestionCache(value) {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string') return [];
  try {
    const parsed = JSON.parse(value[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
