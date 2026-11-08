/**
 * Filesystem persistence for the dsh-web-translator host half.
 *
 * `settings.json` and `wordbook.json` live under `$DSH_HOME/immersive-translate/`.
 * Each document is cached in memory after the first read, every write is
 * serialized through a promise chain (so concurrent API calls never interleave
 * on one file), and a write commits atomically via temporary file + rename, so
 * a crash leaves either the old or the new document — never a truncated one.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Subdirectory of `$DSH_HOME` owned by this plugin. */
export const DATA_SUBDIR = 'immersive-translate';

/**
 * Resolve the DSH home directory: `$DSH_HOME`, falling back to `~/.dsh`.
 * @param {Record<string, string | undefined>} [env] - environment to inspect.
 * @param {string} [home] - home directory used when `DSH_HOME` is absent.
 * @returns {string} absolute DSH home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured.length > 0 ? configured : join(home, '.dsh');
}

/**
 * Resolve the data directory: `$DSH_HOME/immersive-translate`, falling back to
 * `~/.dsh/immersive-translate` when `DSH_HOME` is absent or blank.
 * @param {Record<string, string | undefined>} [env] - environment to inspect.
 * @param {string} [home] - home directory used when `DSH_HOME` is absent.
 * @returns {string} absolute data directory (not created until the first write).
 */
export function resolveDataDir(env = process.env, home = homedir()) {
  return join(resolveDshHome(env, home), DATA_SUBDIR);
}

/**
 * One lazily loaded JSON document with serialized atomic writes.
 *
 * `read()` returns the shared in-memory document; callers must treat it as
 * immutable. Mutations go through {@link JsonFileStore#mutate}, which clones the
 * document, applies the mutator, writes the clone atomically, and only then
 * publishes it as the new in-memory value.
 */
export class JsonFileStore {
  #filePath;
  #defaultValue;
  #logger;
  #loadPromise;
  #data;
  #chain = Promise.resolve();

  /**
   * @param {string} filePath - absolute target path.
   * @param {{defaultValue?: () => object, logger?: {warn?: Function}}} [options]
   */
  constructor(filePath, { defaultValue, logger } = {}) {
    this.#filePath = filePath;
    this.#defaultValue = typeof defaultValue === 'function' ? defaultValue : () => ({});
    this.#logger = logger;
  }

  /** @returns {string} absolute path of this document. */
  get filePath() {
    return this.#filePath;
  }

  /**
   * Read the document, loading it from disk on first use.
   * @returns {Promise<object>}
   */
  async read() {
    await this.#ensureLoaded();
    return this.#data;
  }

  /**
   * Apply one mutation and persist the result. Mutators run one at a time in
   * call order; a throwing mutator writes nothing and rejects only its caller.
   * @template T
   * @param {(draft: object) => T | Promise<T>} mutator - mutate `draft` and return a result.
   * @returns {Promise<T>}
   */
  async mutate(mutator) {
    return this.#enqueue(async () => {
      await this.#ensureLoaded();
      const draft = structuredClone(this.#data);
      const result = await mutator(draft);
      await this.#commit(draft);
      this.#data = draft;
      return result;
    });
  }

  /** @returns {Promise<void>} */
  #ensureLoaded() {
    if (!this.#loadPromise) this.#loadPromise = this.#load();
    return this.#loadPromise;
  }

  /** @returns {Promise<void>} */
  async #load() {
    try {
      const raw = await readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.#data = parsed;
        return;
      }
      this.#warn('document is not a JSON object; starting from defaults');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warn(`cannot read ${this.#filePath}: ${describe(error)}`);
      }
    }
    this.#data = this.#defaultValue();
    if (this.#data === null || typeof this.#data !== 'object') this.#data = {};
  }

  /**
   * Atomically replace the document: write a sibling temp file, then rename.
   * @param {object} data - complete next document.
   * @returns {Promise<void>}
   */
  async #commit(data) {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.#filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmpPath, this.#filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  /**
   * Serialize one task behind all previously queued tasks.
   * @template T
   * @param {() => Promise<T>} task - work to run in order.
   * @returns {Promise<T>}
   */
  #enqueue(task) {
    const result = this.#chain.then(task);
    this.#chain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** @param {string} message */
  #warn(message) {
    try {
      this.#logger?.warn?.(`[dsh-web-translator] store: ${message}`);
    } catch {
      // A broken logger must never take persistence down.
    }
  }
}

/**
 * Create one {@link JsonFileStore}; thin factory kept for symmetry with the
 * other `create*` helpers in this directory.
 * @param {string} filePath - absolute target path.
 * @param {{defaultValue?: () => object, logger?: {warn?: Function}}} [options]
 * @returns {JsonFileStore}
 */
export function createJsonStore(filePath, options) {
  return new JsonFileStore(filePath, options);
}

/**
 * Format an unknown error for a log line.
 * @param {unknown} error - caught value.
 * @returns {string}
 */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
