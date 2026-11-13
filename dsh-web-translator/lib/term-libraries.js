/**
 * Multiple terminology libraries (DESIGN §5.7.3): built-in packs from
 * `lib/terms.js` plus user-created custom libraries persisted here.
 *
 * `term-libraries.json` stores `{version:1, active:string[],
 * libraries:[{id,name,createdAt,updatedAt,terms:[{id,source,policy,target,
 * createdAt,updatedAt}]}]}`. Built-in packs are code-defined and never written
 * to disk. When the file does not exist yet every built-in pack is enabled; a
 * newly created custom library starts enabled and can be switched off again.
 *
 * Writes go through the shared JSON store (serialized, atomic tmp+rename), so a
 * crash never leaves a truncated document.
 */
import { randomBytes } from 'node:crypto';

import { apiError } from './errors.js';
import { BUILTIN_TERM_LIBRARIES, TERM_ENTRY_POLICIES, TERM_LIBRARY_LIMITS } from './terms.js';

/** Persisted document version. */
export const TERM_LIBRARIES_VERSION = 1;

/** Scope description returned by `GET /terms` (prompt hints only). */
const APPLIES_TO = Object.freeze({
  styles: Object.freeze(['auto', 'programming']),
  endpoints: Object.freeze(['translate', 'lookup']),
  builtinScope: 'technical-pages',
  customScope: 'always',
});

/** @returns {string} */
function newLibraryId() {
  return `tl_${randomBytes(4).toString('hex')}`;
}

/** @returns {string} */
function newEntryId() {
  return `te_${randomBytes(4).toString('hex')}`;
}

/** Normalize one library name. */
function normalizeName(value) {
  if (typeof value !== 'string') throw apiError('BAD_REQUEST', 'name must be a string');
  const name = value.trim();
  if (name.length === 0) throw apiError('BAD_REQUEST', 'name must not be empty');
  if (name.length > TERM_LIBRARY_LIMITS.nameChars) {
    throw apiError('BAD_REQUEST', `name exceeds ${TERM_LIBRARY_LIMITS.nameChars} characters`);
  }
  return name;
}

/** Normalize one term source. */
function normalizeSource(value) {
  if (typeof value !== 'string') throw apiError('BAD_REQUEST', 'source must be a string');
  const source = value.trim();
  if (source.length === 0) throw apiError('BAD_REQUEST', 'source must not be empty');
  if (source.length > TERM_LIBRARY_LIMITS.sourceChars) {
    throw apiError('BAD_REQUEST', `source exceeds ${TERM_LIBRARY_LIMITS.sourceChars} characters`);
  }
  return source;
}

/** Normalize one entry policy. */
function normalizePolicy(value) {
  if (typeof value !== 'string' || !TERM_ENTRY_POLICIES.includes(value)) {
    throw apiError('BAD_REQUEST', `policy must be one of ${TERM_ENTRY_POLICIES.join(', ')}`);
  }
  return value;
}

/** Normalize the target of one entry (`translate` requires it, `keep` ignores it). */
function normalizeTarget(value, policy) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (policy === 'keep') return '';
  if (raw.length === 0) throw apiError('BAD_REQUEST', 'target is required when policy is translate');
  if (raw.length > TERM_LIBRARY_LIMITS.targetChars) {
    throw apiError('BAD_REQUEST', `target exceeds ${TERM_LIBRARY_LIMITS.targetChars} characters`);
  }
  return raw;
}

/** True when two term sources refer to the same rule (case-insensitive). */
function sameSource(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Normalize one persisted entry; returns null for unusable records. */
function normalizeStoredEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (!source || source.length > TERM_LIBRARY_LIMITS.sourceChars) return null;
  const policy = TERM_ENTRY_POLICIES.includes(raw.policy) ? raw.policy : 'keep';
  const target = policy === 'translate' && typeof raw.target === 'string'
    ? raw.target.trim().slice(0, TERM_LIBRARY_LIMITS.targetChars)
    : '';
  if (policy === 'translate' && target.length === 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : newEntryId(),
    source,
    policy,
    target,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

/** Normalize one persisted custom library; returns null for unusable records. */
function normalizeStoredLibrary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > TERM_LIBRARY_LIMITS.nameChars) return null;
  const terms = [];
  for (const item of Array.isArray(raw.terms) ? raw.terms : []) {
    const entry = normalizeStoredEntry(item);
    if (entry !== null) terms.push(entry);
    if (terms.length >= TERM_LIBRARY_LIMITS.termsPerLibrary) break;
  }
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : newLibraryId(),
    name,
    terms,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

/** Public UI view of one built-in pack. */
function publicBuiltinLibrary(library, enabled) {
  return {
    id: library.id,
    name: library.name,
    description: library.description,
    builtin: true,
    enabled,
    updatedAt: 0,
    terms: library.terms.map((term) => ({
      id: term.id,
      source: term.source,
      policy: term.policy,
      target: term.policy === 'translate' && typeof term.target === 'string' ? term.target : '',
      badRenderings: Array.isArray(term.badRenderings) ? term.badRenderings.slice() : [],
    })),
  };
}

/** Public UI view of one custom library. */
function publicCustomLibrary(library, enabled) {
  return {
    id: library.id,
    name: library.name,
    description: '',
    builtin: false,
    enabled,
    updatedAt: library.updatedAt,
    terms: library.terms.map((term) => ({
      id: term.id,
      source: term.source,
      policy: term.policy,
      target: term.target,
      badRenderings: [],
    })),
  };
}

/**
 * Build the terminology-library service over one JSON store.
 * @param {{store: {read: Function, mutate: Function}, now?: () => number}} options
 * @returns {object}
 */
export function createTermLibrariesService({ store, now = Date.now } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.mutate !== 'function') {
    throw new TypeError('createTermLibrariesService requires a JSON store');
  }
  const clock = typeof now === 'function' ? now : () => Date.now();

  /**
   * Normalize the persisted document. A missing `active` array means "defaults",
   * i.e. every built-in pack enabled.
   * @param {object} doc - persisted document.
   * @returns {{libraries: object[], active: string[] | null}}
   */
  function readDoc(doc) {
    const libraries = [];
    for (const raw of Array.isArray(doc?.libraries) ? doc.libraries : []) {
      const library = normalizeStoredLibrary(raw);
      if (library !== null) libraries.push(library);
      if (libraries.length >= TERM_LIBRARY_LIMITS.libraries) break;
    }
    const active = Array.isArray(doc?.active)
      ? doc.active.filter((id) => typeof id === 'string' && id.length > 0)
      : null;
    return { libraries, active };
  }

  /** All existing ids (built-in first, custom after). */
  function allIds(customLibraries) {
    return [
      ...BUILTIN_TERM_LIBRARIES.map((library) => library.id),
      ...customLibraries.map((library) => library.id),
    ];
  }

  /** Effective enabled-id set for one document. */
  function enabledIds(docState) {
    const ids = allIds(docState.libraries);
    if (docState.active === null) return new Set(ids);
    return new Set(docState.active.filter((id) => ids.includes(id)));
  }

  /** Public `GET /terms` payload for one document. */
  function snapshot(docState) {
    const enabled = enabledIds(docState);
    const libraries = [
      ...BUILTIN_TERM_LIBRARIES.map((library) => publicBuiltinLibrary(library, enabled.has(library.id))),
      ...docState.libraries.map((library) => publicCustomLibrary(library, enabled.has(library.id))),
    ];
    return {
      libraries,
      limits: { ...TERM_LIBRARY_LIMITS },
      appliesTo: {
        styles: [...APPLIES_TO.styles],
        endpoints: [...APPLIES_TO.endpoints],
        builtinScope: APPLIES_TO.builtinScope,
        customScope: APPLIES_TO.customScope,
      },
    };
  }

  /** Ensure the draft document carries an explicit active list before mutation. */
  function prepareDraft(draft, docState) {
    if (!draft || typeof draft !== 'object') draft = {};
    draft.version = TERM_LIBRARIES_VERSION;
    if (!Array.isArray(draft.active)) draft.active = [...enabledIds(docState)];
    if (!Array.isArray(draft.libraries)) draft.libraries = docState.libraries;
    return draft;
  }

  /** Find one custom library or throw. */
  function requireCustomLibrary(draft, id) {
    const libraries = Array.isArray(draft.libraries) ? draft.libraries : [];
    const index = libraries.findIndex((library) => library && library.id === id);
    if (index < 0) throw apiError('NOT_FOUND', 'term library not found');
    return { library: libraries[index], index, libraries };
  }

  async function readState() {
    return readDoc(await store.read());
  }

  /** `GET /terms` */
  async function list() {
    return snapshot(await readState());
  }

  /**
   * Enabled libraries for one translation request. Built-in packs are returned
   * only when the page is technical; custom libraries always.
   * @returns {Promise<{builtin: object[], custom: object[]}>}
   */
  async function activeLibraries() {
    const state = await readState();
    const enabled = enabledIds(state);
    return {
      builtin: BUILTIN_TERM_LIBRARIES.filter((library) => enabled.has(library.id)),
      custom: state.libraries.filter((library) => enabled.has(library.id)),
    };
  }

  /** `POST /terms/libraries/add` */
  async function addLibrary(body) {
    const name = normalizeName(body?.name);
    const state = await readState();
    return store.mutate((draft) => {
      const next = prepareDraft(draft, state);
      if (next.libraries.length >= TERM_LIBRARY_LIMITS.libraries) {
        throw apiError('BAD_REQUEST', `at most ${TERM_LIBRARY_LIMITS.libraries} custom libraries are allowed`);
      }
      if (next.libraries.some((library) => sameSource(library.name, name))) {
        throw apiError('BAD_REQUEST', 'a library with this name already exists');
      }
      const timestamp = clock();
      const library = { id: newLibraryId(), name, terms: [], createdAt: timestamp, updatedAt: timestamp };
      next.libraries.push(library);
      next.active.push(library.id);
      return { ...snapshot(readDoc(next)), id: library.id };
    });
  }

  /** `POST /terms/libraries/update` */
  async function renameLibrary(body) {
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) throw apiError('BAD_REQUEST', 'id is required');
    const name = normalizeName(body?.name);
    const state = await readState();
    return store.mutate((draft) => {
      const next = prepareDraft(draft, state);
      const { library } = requireCustomLibrary(next, id);
      if (next.libraries.some((item) => item.id !== id && sameSource(item.name, name))) {
        throw apiError('BAD_REQUEST', 'a library with this name already exists');
      }
      library.name = name;
      library.updatedAt = clock();
      return { ...snapshot(readDoc(next)), id };
    });
  }

  /** `POST /terms/libraries/remove` */
  async function removeLibrary(body) {
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) throw apiError('BAD_REQUEST', 'id is required');
    const state = await readState();
    return store.mutate((draft) => {
      const next = prepareDraft(draft, state);
      const { index, libraries } = requireCustomLibrary(next, id);
      libraries.splice(index, 1);
      next.active = next.active.filter((item) => item !== id);
      return { ...snapshot(readDoc(next)), id };
    });
  }

  /** `POST /terms/libraries/toggle` */
  async function setEnabled(body) {
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) throw apiError('BAD_REQUEST', 'id is required');
    if (typeof body?.enabled !== 'boolean') throw apiError('BAD_REQUEST', 'enabled must be a boolean');
    const state = await readState();
    return store.mutate((draft) => {
      const next = prepareDraft(draft, state);
      const ids = allIds(next.libraries);
      if (!ids.includes(id)) throw apiError('NOT_FOUND', 'term library not found');
      next.active = next.active.filter((item) => item !== id);
      if (body.enabled) next.active.push(id);
      return { ...snapshot(readDoc(next)), id, enabled: body.enabled };
    });
  }

  /** `POST /terms/entries/add` */
  async function addEntry(body) {
    const libraryId = typeof body?.libraryId === 'string' ? body.libraryId.trim() : '';
    if (!libraryId) throw apiError('BAD_REQUEST', 'libraryId is required');
    const source = normalizeSource(body?.source);
    const policy = normalizePolicy(body?.policy);
    const target = normalizeTarget(body?.target, policy);
    const state = await readState();
    return store.mutate((draft) => {
      const next = prepareDraft(draft, state);
      const { library } = requireCustomLibrary(next, libraryId);
      if (library.terms.length >= TERM_LIBRARY_LIMITS.termsPerLibrary) {
        throw apiError('BAD_REQUEST', `at most ${TERM_LIBRARY_LIMITS.termsPerLibrary} terms per library are allowed`);
      }
      if (library.terms.some((term) => sameSource(term.source, source))) {
        throw apiError('BAD_REQUEST', 'a term with this source already exists in the library');
      }
      const timestamp = clock();
      const entry = { id: newEntryId(), source, policy, target, createdAt: timestamp, updatedAt: timestamp };
      library.terms.push(entry);
      library.updatedAt = timestamp;
      return { ...snapshot(readDoc(next)), libraryId, entryId: entry.id };
    });
  }

  /** `POST /terms/entries/update` */
  async function updateEntry(body) {
    const libraryId = typeof body?.libraryId === 'string' ? body.libraryId.trim() : '';
    const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
    if (!libraryId) throw apiError('BAD_REQUEST', 'libraryId is required');
    if (!entryId) throw apiError('BAD_REQUEST', 'entryId is required');
    const state = await readState();
    return store.mutate((draft) => {
      const next = prepareDraft(draft, state);
      const { library } = requireCustomLibrary(next, libraryId);
      const entry = library.terms.find((term) => term.id === entryId);
      if (!entry) throw apiError('NOT_FOUND', 'term entry not found');
      const source = body?.source === undefined ? entry.source : normalizeSource(body.source);
      const policy = body?.policy === undefined ? entry.policy : normalizePolicy(body.policy);
      const target = normalizeTarget(body?.target === undefined ? entry.target : body.target, policy);
      if (library.terms.some((term) => term.id !== entryId && sameSource(term.source, source))) {
        throw apiError('BAD_REQUEST', 'a term with this source already exists in the library');
      }
      const timestamp = clock();
      entry.source = source;
      entry.policy = policy;
      entry.target = target;
      entry.updatedAt = timestamp;
      library.updatedAt = timestamp;
      return { ...snapshot(readDoc(next)), libraryId, entryId };
    });
  }

  /** `POST /terms/entries/remove` */
  async function removeEntry(body) {
    const libraryId = typeof body?.libraryId === 'string' ? body.libraryId.trim() : '';
    const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
    if (!libraryId) throw apiError('BAD_REQUEST', 'libraryId is required');
    if (!entryId) throw apiError('BAD_REQUEST', 'entryId is required');
    const state = await readState();
    return store.mutate((draft) => {
      const next = prepareDraft(draft, state);
      const { library } = requireCustomLibrary(next, libraryId);
      const index = library.terms.findIndex((term) => term.id === entryId);
      if (index < 0) throw apiError('NOT_FOUND', 'term entry not found');
      library.terms.splice(index, 1);
      library.updatedAt = clock();
      return { ...snapshot(readDoc(next)), libraryId, entryId };
    });
  }

  return {
    list,
    activeLibraries,
    addLibrary,
    renameLibrary,
    removeLibrary,
    setEnabled,
    addEntry,
    updateEntry,
    removeEntry,
  };
}
