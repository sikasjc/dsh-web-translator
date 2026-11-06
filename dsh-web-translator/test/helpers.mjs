/**
 * Shared test doubles: fake DSH LLM service, fake logger, temp dirs and
 * Node-http request/response stand-ins. No test performs a real network call.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/** Collect log lines for assertions. */
export function createFakeLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (...args) => lines.debug.push(args.join(' ')),
    info: (...args) => lines.info.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
  };
}

/**
 * Build an async iterable from an array of chunks.
 * @param {object[]} chunks - stream chunks.
 */
export async function* streamFromChunks(chunks) {
  for (const chunk of chunks) yield chunk;
}

/**
 * Stream that yields `text` as one text-delta, then optional usage and a stop
 * finish — the common happy-path shape used across tests.
 * @param {string} text - model output text.
 * @param {{usage?: {inputTokens: number, outputTokens: number}}} [options]
 */
export function textStream(text, { usage } = {}) {
  return streamFromChunks([
    ...(usage ? [{ type: 'usage', usage }] : []),
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
}

/**
 * Build a fake `ctx.llm` with call recording.
 * @param {{providers?: object[], models?: Record<string, object[]>,
 *   modelInfo?: object | ((provider: string, model: string) => object),
 *   streams?: Array<(options: object) => AsyncIterable<object>>}} [options]
 */
export function createFakeLlm({ providers, models, modelInfo, streams } = {}) {
  const providerList = providers ?? [{ id: 'modelhub', name: 'modelhub' }];
  const modelMap = models ?? { modelhub: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] };
  const queue = Array.isArray(streams) ? [...streams] : [];
  const defaultInfo = {
    provider: 'modelhub',
    id: 'deepseek-flash',
    name: 'deepseek-flash',
    context: { contextWindow: 1048576 },
    defaultMaxTokens: 393216,
    reasoning: {
      efforts: [{ id: 'off', name: 'off' }, { id: 'max', name: 'max' }],
      defaultEffort: 'off',
    },
  };
  const state = { streamCalls: [], listModelsCalls: 0, listProvidersCalls: 0, resolveCalls: [] };

  const llm = {
    state,
    /** Queue one more stream factory. */
    pushStream(factory) {
      queue.push(factory);
    },
    listProviders() {
      state.listProvidersCalls += 1;
      return providerList;
    },
    async listModels(provider) {
      state.listModelsCalls += 1;
      const modelsForProvider = modelMap[provider];
      if (modelsForProvider === undefined) throw new Error(`unknown provider: ${provider}`);
      return modelsForProvider.map((model) => ({ provider, ...model }));
    },
    async resolveModelInfo(provider, model) {
      state.resolveCalls.push({ provider, model });
      if (typeof modelInfo === 'function') return modelInfo(provider, model);
      return { ...(modelInfo ?? defaultInfo), provider, id: model, name: model };
    },
    stream(options) {
      state.streamCalls.push(options);
      const factory = queue.shift();
      if (factory === undefined) throw new Error('fake llm: no stream queued');
      return factory(options);
    },
  };
  return llm;
}

/**
 * Build a fake Cordis-like context.
 * @param {{llm?: object, logger?: object,
 *   selection?: {provider: string, model: string, reasoningEffort?: string} | null,
 *   agents?: object, sessionTitle?: object, workspaceRegistry?: object,
 *   sessionPersistence?: object, effect?: Function}} [options]
 */
export function createFakeCtx({ llm, logger, selection, agents, sessionTitle, workspaceRegistry, sessionPersistence, effect } = {}) {
  const defaultSelection = selection === undefined
    ? { provider: 'modelhub', model: 'deepseek-flash', reasoningEffort: 'max' }
    : selection;
  return {
    llm,
    logger,
    get(name) {
      if (name === 'agentDefaultModel') {
        if (defaultSelection === null) return undefined;
        return { currentSelection: () => ({ ...defaultSelection }) };
      }
      if (name === 'agents') return agents;
      if (name === 'sessionTitle') return sessionTitle;
      if (name === 'workspaceRegistry') return workspaceRegistry;
      if (name === 'sessionPersistence') return sessionPersistence;
      return undefined;
    },
    ...(typeof effect === 'function' ? { effect } : {}),
  };
}

/**
 * Fake DSH `agents` service for conversation-bridge tests: records creation
 * options, appended session events, cleared inboxes and disposals.
 * @param {{create?: (options: object, state: object) => Promise<object | undefined>}} [options]
 *   optional `create` hook: throw to simulate failures, or return a custom handle.
 */
export function createFakeAgents({ create } = {}) {
  const state = { created: [], appended: [], disposed: [], handles: [], inboxCleared: 0 };
  return {
    state,
    async create(options) {
      state.created.push(options);
      if (typeof create === 'function') {
        const custom = await create(options, state);
        if (custom !== undefined) return custom;
      }
      const session = {
        append(type, payload, appendOptions) {
          state.appended.push({ sessionId: options.sessionId, type, payload, options: appendOptions });
        },
      };
      const handle = {
        agent: {
          session,
          inbox: { clear() { state.inboxCleared += 1; } },
        },
        dispose() {
          state.disposed.push(options.sessionId);
        },
      };
      state.handles.push(handle);
      return handle;
    },
  };
}

/**
 * Fake DSH `workspaceRegistry` service for conversation-bridge tests: records
 * `create()` calls and every session attached to the returned workspace.
 * @param {{create?: (path: string, title: string) => Promise<object | undefined>,
 *   attachSession?: (sessionId: string) => Promise<void>}} [options]
 *   optional hooks: throw to simulate failures, or return a custom workspace.
 */
export function createFakeWorkspaceRegistry({ create, attachSession, existing } = {}) {
  const state = { createCalls: [], attached: [], reordered: [], resolveCalls: [], archived: [], deleted: [], detached: [], workspace: null };
  if (existing !== undefined) state.workspace = existing;
  const registry = {
    state,
    async create(path, title) {
      state.createCalls.push({ path, title });
      if (typeof create === 'function') {
        const custom = await create(path, title);
        if (custom !== undefined) return custom;
      }
      const workspace = {
        id: 'ws-translations',
        path,
        title,
        sessionIds: state.attached.slice(),
        async attachSession(sessionId) {
          state.attached.push(sessionId);
          workspace.sessionIds = state.attached.slice();
          if (typeof attachSession === 'function') await attachSession(sessionId);
        },
        async setTitle() {},
        async insertSessionBefore() {},
        async detachSession(sessionId) {
          state.detached.push(sessionId);
          workspace.sessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
        },
        async status() { return 'ok'; },
      };
      state.workspace = workspace;
      return workspace;
    },
    async resolveByPath(path) {
      state.resolveCalls.push(path);
      return state.workspace !== null && state.workspace.path === path ? state.workspace : undefined;
    },
    async insertBefore(id, beforeId) {
      state.reordered.push({ id, beforeId });
      return [];
    },
    async archiveSession(sessionId, options = {}) {
      state.archived.push({ sessionId, options });
    },
    async delete(id) {
      state.deleted.push(id);
      state.workspace = null;
      return true;
    },
    list() {
      return state.workspace === null ? [] : [state.workspace];
    },
  };
  return registry;
}

/**
 * Create a temp directory the caller must remove (see {@link removeTempDir}).
 * @returns {Promise<string>}
 */
export async function createTempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-it-test-'));
}

/** Remove a temp directory created by {@link createTempDir}. */
export async function removeTempDir(directory) {
  await rm(directory, { recursive: true, force: true });
}

/** Node http request stand-in over a Readable body. */
export function fakeRequest({
  method = 'GET',
  url = '/dsh-immersive/api/health',
  headers = {},
  body,
  host = '127.0.0.1:3080',
} = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { host, ...headers };
  if (body !== undefined && req.headers['content-type'] === undefined) {
    req.headers['content-type'] = 'application/json';
  }
  return req;
}

/** Node http response stand-in capturing status, headers and body. */
export class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = '';
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = { ...headers };
    this.headersSent = true;
    return this;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    }
    this.writableEnded = true;
    this.emit('finish');
    return this;
  }

  destroy() {
    this.destroyed = true;
  }

  /** Parsed JSON body. */
  json() {
    return JSON.parse(this.body);
  }
}

/**
 * Invoke one handler invocation and return the fake response.
 * @param {(req: object, res: object) => Promise<void>} handler - http handler.
 * @param {object} request - fake request.
 * @returns {Promise<FakeResponse>}
 */
export async function invokeHandler(handler, request) {
  const res = new FakeResponse();
  await handler(request, res);
  return res;
}
