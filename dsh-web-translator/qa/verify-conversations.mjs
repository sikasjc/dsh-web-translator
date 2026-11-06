#!/usr/bin/env node
/**
 * Independent QA harness for the "translation conversation bridge → native DSH
 * trajectory" increment (DESIGN-CONVERSATIONS.md v4).
 *
 * Independent means: it imports only the plugin's public host entry points
 * (`lib/routes.js` / `lib/conversations.js` / `lib/constants.js`), never the
 * plugin's own tests/helpers, and boots a real in-process HTTP handler with a
 * fake LLM + fake `agents`/`sessionTitle` DSH services, then drives the whole
 * bridge contract with `node:assert/strict`:
 *   - static host contract (conversations module, LIMITS.sessionIdChars, usage
 *     sessionId/turn normalization, /conversations route + dispatch, api wiring,
 *     bridge-never-fails policy, version 1.8.0);
 *   - in-process bridge: one translation run (turnId) → one real DSH session
 *     with turn-by-turn user/assistant events + usage, title rename, live list;
 *   - `/usage/turns` + `/usage/events` carry sessionId/turn; lookup sessions;
 *     failure rounds (user message + turn/end error, no assistant);
 *   - requests without turnId create no conversation (ledger only);
 *   - bridge fallback: agents unavailable / create throws / append throws must
 *     NEVER fail the translation and must still write the ledger row;
 *   - LRU cap (24 live conversations, oldest disposed) + dispose on unload;
 *   - client.js static checks for the conversation UI (sessionId grouping,
 *     「打开 DSH 轨迹」 button + openConversation → uiWorkspace.openSession,
 *     legacy section for turns without sessionId, /usage/turns 404 fallback,
 *     zh/en key parity of trace.conversation.*);
 *   - regression: the previous independent harnesses (`verify-token-stats.mjs`,
 *     `verify-turn-trace.mjs`) are re-run unmodified (their 2 expected
 *     version-bump assertions from 1.4.0 → 1.5.0 are classified, not silenced);
 *   - `--live`: read-only checks against the installed plugin
 *     (http://127.0.0.1:3080/dsh-immersive/api) — never POSTs.
 *
 * Usage:
 *   node qa/verify-conversations.mjs            # static + in-process checks
 *   node qa/verify-conversations.mjs --live     # + read-only live GET checks
 *   node qa/verify-conversations.mjs --quiet    # only failures + summary
 *   node qa/verify-conversations.mjs --no-regression  # skip old-harness re-run
 *
 * Exit code: 0 = all checks pass, 1 = failures, 2 = harness crashed.
 * QA-only script: source files are read-only for QA; writes only under qa/.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const QA_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(QA_DIR, '..'); // dsh-web-translator
const WORKSPACE = join(ROOT, '..'); // repo root
const EXT = join(WORKSPACE, 'dsh-web-translator-extension');
const LIVE = process.argv.includes('--live');
const QUIET = process.argv.includes('--quiet');
const NO_REGRESSION = process.argv.includes('--no-regression');
const LIVE_API = (process.env.DSH_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '') + '/dsh-immersive/api';
const startedAt = Date.now();

const results = [];
let currentSection = 'general';

function section(name) {
  currentSection = name;
  if (!QUIET) console.log(`\n== ${name} ==`);
}

/**
 * Run one assertion group; node:assert failures are captured as FAIL instead of
 * aborting the harness.
 * @param {string} name - check name.
 * @param {() => (void | string | Promise<void | string>)} fn - assertions.
 * @returns {Promise<boolean>} whether the check passed.
 */
async function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = await fn();
    ok = true;
    detail = out === undefined ? '' : String(out);
  } catch (error) {
    detail = String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 900);
  }
  results.push({ section: currentSection, name, ok, detail: detail.slice(0, 900) });
  if (!ok || !QUIET) {
    const suffix = detail.length > 0 ? `  [${detail.replace(/\s+/g, ' ').slice(0, 500)}]` : '';
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
  }
  return ok;
}

const readText = (relative, base = ROOT) => readFileSync(join(base, relative), 'utf8');
const exists = (relative, base = ROOT) => existsSync(join(base, relative));

function nodeCheckFile(relative, base = ROOT) {
  const absolute = join(base, relative);
  return check(`node --check ${relative}`, () => {
    assert.ok(existsSync(absolute), `file does not exist: ${absolute}`);
    const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
    assert.equal(result.status, 0, (result.stderr || result.stdout || '').trim().slice(0, 400));
  });
}

/* ------------------------------------------------------------------ */
/* In-process HTTP doubles (independent of test/helpers.mjs)           */
/* ------------------------------------------------------------------ */

class FakeResponse extends EventEmitter {
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
}

function fakeRequest({ method = 'GET', url = '/dsh-immersive/api/health', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers };
  if (body !== undefined && req.headers['content-type'] === undefined) {
    req.headers['content-type'] = 'application/json';
  }
  return req;
}

function createFakeLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (...args) => lines.debug.push(args.join(' ')),
    info: (...args) => lines.info.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
  };
}

/** Fake `ctx.llm`; queued stream factories are shifted per model call. */
function createFakeLlm() {
  const queue = [];
  const state = { calls: [] };
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
  const llm = {
    state,
    pushStream(factory) {
      queue.push(factory);
      return llm;
    },
    listProviders() {
      return [{ id: 'modelhub', name: 'modelhub' }];
    },
    async listModels(provider) {
      if (provider !== 'modelhub') throw new Error(`unknown provider: ${provider}`);
      return [{ id: 'deepseek-flash', name: 'deepseek-flash' }];
    },
    async resolveModelInfo(provider, model) {
      return { ...defaultInfo, provider, id: model, name: model };
    },
    stream(options) {
      state.calls.push(options);
      const factory = queue.shift();
      if (factory === undefined) throw new Error('qa fake llm: no stream queued');
      return factory(options);
    },
  };
  return llm;
}

/** One recorded fake DSH agent session (append events + dispose counter). */
function createFakeAgents({ failCreate = false, failAppend = false } = {}) {
  const created = [];
  const sessions = new Map();
  const disposed = [];
  const agents = {
    created,
    sessions,
    disposed,
    async create(input) {
      created.push({
        sessionId: input?.sessionId,
        meta: input?.meta,
        agentOptions: input?.agentOptions,
      });
      if (failCreate) throw new Error('qa: ctx.agents.create is unavailable');
      const record = {
        sessionId: input?.sessionId,
        meta: input?.meta,
        agentOptions: input?.agentOptions,
        events: [],
        inboxCleared: 0,
        disposed: 0,
      };
      const session = {
        append(type, payload, options) {
          if (failAppend) throw new Error('qa: session.append failed');
          record.events.push({ type, payload, options });
        },
      };
      const agent = {
        session,
        inbox: {
          clear() {
            record.inboxCleared += 1;
          },
        },
      };
      sessions.set(input?.sessionId, record);
      return {
        agent,
        dispose() {
          record.disposed += 1;
          disposed.push(input?.sessionId);
        },
      };
    },
  };
  return agents;
}

/** Fake `sessionTitle` service recording rename calls. */
function createFakeTitles() {
  const renamed = [];
  return {
    renamed,
    rename(session, title) {
      renamed.push({ session, title });
    },
  };
}

/** Fake Cordis-like host ctx: llm + optional agents/titles + effect seam. */
function createFakeCtx(llm, logger, { agents, titles } = {}) {
  const cleanups = [];
  return {
    llm,
    logger,
    cleanups,
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'modelhub', model: 'deepseek-flash', reasoningEffort: 'max' }) };
      }
      if (name === 'agents') return agents ?? undefined;
      if (name === 'sessionTitle') return titles ?? undefined;
      return undefined;
    },
    effect(fn) {
      try {
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      } catch {
        // Optional lifecycle seam.
      }
      return () => {};
    },
  };
}

/** Text stream shaped like the DSH llm stream: usage -> text-delta -> finish. */
async function* textStream(text, usage) {
  if (usage !== undefined) yield { type: 'usage', usage };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Queue a successful translate stream (JSON translations payload). */
function queueTranslate(llm, translations, usage) {
  llm.pushStream(() => textStream(JSON.stringify({ translations }), usage));
}

/** Queue a failing model stream with a mapped host error code. */
function queueFailure(llm, code = 'RATE_LIMIT', message = 'qa fake rate limit') {
  llm.pushStream(() => {
    const error = new Error(message);
    error.code = code;
    throw error;
  });
}

/* ------------------------------------------------------------------ */
/* 1. Syntax                                                           */
/* ------------------------------------------------------------------ */

async function checkSyntax() {
  section('syntax (node --check)');
  for (const file of ['lib/conversations.js', 'lib/api.js', 'lib/http.js', 'lib/usage.js', 'lib/constants.js', 'client.js', 'index.js']) {
    nodeCheckFile(file);
  }
  let pkg = null;
  await check('package.json parses as JSON', () => {
    pkg = JSON.parse(readText('package.json'));
    assert.ok(pkg !== null);
  });
  for (const file of ['qa/verify-conversations.mjs', 'qa/conversation-shot.mjs', 'qa/verify-turn-trace.mjs', 'qa/verify-token-stats.mjs', 'qa/cdp.mjs']) {
    if (exists(file)) nodeCheckFile(file);
  }
  let extFiles = [];
  try {
    extFiles = readdirSync(EXT).filter((name) => /^(background|content|options)\.js$/.test(name));
  } catch {
    extFiles = [];
  }
  await check('extension JS files present (unchanged by design §1)', () => {
    assert.deepEqual(extFiles.sort(), ['background.js', 'content.js', 'options.js']);
  });
  for (const file of extFiles) nodeCheckFile(file, EXT);
}

/* ------------------------------------------------------------------ */
/* 2. Host static contract                                             */
/* ------------------------------------------------------------------ */

async function checkHostStatic() {
  section('host static contract (conversations bridge)');

  await check('lib/conversations.js exists', () => {
    assert.ok(exists('lib/conversations.js'));
  });
  let conversationModule = null;
  try {
    conversationModule = await import(pathToFileURL(join(ROOT, 'lib/conversations.js')).href);
  } catch {
    conversationModule = null;
  }
  await check('lib/conversations.js exports the documented helpers', () => {
    assert.ok(conversationModule !== null, 'module import failed');
    for (const name of ['conversationSessionId', 'composeUserText', 'composeAssistantText', 'composeTitle', 'normalizeSessionUsage', 'createConversationBridge']) {
      assert.equal(typeof conversationModule[name], 'function', `${name} is not a function`);
    }
  });

  const conversationsSource = exists('lib/conversations.js') ? readText('lib/conversations.js') : '';
  await check('bridge uses ctx.get("agents") + agent sessions (POC seam)', () => {
    assert.match(conversationsSource, /ctx\?\.get\?\.\('agents'\)|get\('agents'\)/);
    assert.match(conversationsSource, /agent\?\.session|\.session\b/);
    assert.match(conversationsSource, /session\.append\('(?:turn\/start|user\/message)'/);
  });
  await check('bridge pins the native session title via sessionTitle.rename', () => {
    assert.match(conversationsSource, /sessionTitle/);
    assert.match(conversationsSource, /\.rename\??\./);
    assert.match(conversationsSource, /translation-/);
  });
  await check('bridge never fails a translation (try/catch + null + warn once)', () => {
    assert.match(conversationsSource, /catch \(error\)/);
    assert.match(conversationsSource, /return null/);
    assert.match(conversationsSource, /warned = true/);
  });
  await check('bridge constants: 24 live conversations / 15min idle / session id cap', () => {
    assert.match(conversationsSource, /MAX_LIVE_CONVERSATIONS\s*=\s*24/);
    assert.match(conversationsSource, /IDLE_DISPOSE_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
    assert.match(conversationsSource, /SESSION_ID_MAX\s*=\s*96/);
  });
  await check('bridge writes the events sequence documented in §2', () => {
    for (const eventType of ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end']) {
      assert.ok(conversationsSource.includes(eventType), `missing ${eventType}`);
    }
    assert.match(conversationsSource, /kind: 'error'/);
  });
  await check('bridge cwd lives under the plugin data dir (conversations/)', () => {
    assert.match(conversationsSource, /join\(dataDir, 'conversations'\)/);
  });

  let constants = null;
  try {
    constants = await import(pathToFileURL(join(ROOT, 'lib/constants.js')).href);
  } catch {
    constants = null;
  }
  await check('constants.LIMITS.sessionIdChars === 96', () => {
    assert.ok(constants !== null, 'constants import failed');
    assert.equal(constants.LIMITS?.sessionIdChars, 96);
  });
  await check('USAGE_VERSION stays 1 (ledger format additive)', () => {
    assert.equal(constants?.USAGE_VERSION, 1);
  });

  const usageSource = exists('lib/usage.js') ? readText('lib/usage.js') : '';
  await check('usage.js normalizes sessionId/turn on events', () => {
    assert.match(usageSource, /\[?'sessionId', LIMITS\.sessionIdChars\]?/);
    assert.match(usageSource, /turn: toCount\(raw\.turn\)/);
  });
  await check('usage.js turns aggregate carries sessionId (§2)', () => {
    assert.match(usageSource, /'sessionId',/);
    assert.match(usageSource, /aggregateTurn/);
  });
  await check('usage.js steps carry sessionId too (DESIGN-CONVERSATIONS §2 "Turn/Step")', () => {
    // Contract text: "现有 GET /usage/turns 的 Turn/Step 自带 sessionId".
    assert.match(usageSource, /step\.sessionId\s*=\s*event\.sessionId/, 'Step row does not expose sessionId');
  });

  const httpSource = exists('lib/http.js') ? readText('lib/http.js') : '';
  await check("http.js ROUTES has '/conversations' GET", () => {
    assert.match(httpSource, /['"]\/conversations['"]\s*:\s*[^,\n]*\[[^\]]*['"]GET['"]/);
  });
  await check('http.js dispatchGet wires /conversations → api.listConversations()', () => {
    assert.match(httpSource, /case\s+['"]\/conversations['"]\s*:/);
    assert.match(httpSource, /listConversations\(\)/);
  });
  await check("http.js keeps '/usage/turns' and '/usage/events' routes", () => {
    assert.match(httpSource, /['"]\/usage\/turns['"]/);
    assert.match(httpSource, /['"]\/usage\/events['"]/);
  });

  const apiSource = exists('lib/api.js') ? readText('lib/api.js') : '';
  await check('api.js creates the conversation bridge with ctx/dataDir/logger/now', () => {
    assert.match(apiSource, /createConversationBridge\(\{/);
    assert.match(apiSource, /ctx,\s*dataDir: directory/);
  });
  await check('api.js records a conversation round on success AND failure', () => {
    assert.match(apiSource, /recordConversation\(kind, body, meta, result, null, null, event, true\)/);
    assert.match(apiSource, /recordConversation\(kind, body, meta, null, error, selection, event, false\)/);
  });
  await check('api.js enriches the ledger event with sessionId/turn before persisting', () => {
    assert.match(apiSource, /event\.sessionId = recorded\.sessionId/);
    assert.match(apiSource, /event\.turn = recorded\.turn/);
    const successIndex = apiSource.indexOf('recordConversation(kind, body, meta, result, null, null, event, true)');
    const recordIndex = apiSource.indexOf('await recordUsage(event)', successIndex);
    assert.ok(successIndex >= 0 && recordIndex > successIndex, 'ledger record happens after conversation enrichment');
  });
  await check('api.js exposes GET /conversations merging live + ledger-derived conversations', () => {
    assert.match(apiSource, /async function listConversations\(/);
    assert.match(apiSource, /conversations\.list\(\)/);
    assert.match(apiSource, /conversationRow\(/);
    assert.match(apiSource, /return \{ conversations: rows \}/);
  });
  await check('api.js scope-disposes live conversations on plugin unload (ctx.effect)', () => {
    assert.match(apiSource, /ctx\.effect/);
    assert.match(apiSource, /conversations\.dispose\(\)/);
  });
  await check('api.js keeps turn-trace wiring (/usage/turns) intact', () => {
    assert.match(apiSource, /getUsageTurns/);
    assert.match(apiSource, /listUsageEvents/);
  });

  await check('package.json version === 1.8.0', () => {
    assert.equal(JSON.parse(readText('package.json')).version, '1.8.0');
  });
  await check("lib/version.js VERSION === '1.8.0'", () => {
    assert.match(readText('lib/version.js'), /VERSION\s*=\s*['"]1\.8\.0['"]/);
  });
  await check('DESIGN-CONVERSATIONS.md contract file present', () => {
    assert.ok(exists('DESIGN-CONVERSATIONS.md') && readText('DESIGN-CONVERSATIONS.md').length > 3000);
  });
}

/* ------------------------------------------------------------------ */
/* 3. In-process bridge contract (fake agents + fake LLM)              */
/* ------------------------------------------------------------------ */

async function bootHost({ agents, titles, dataDir } = {}) {
  const routes = await import(pathToFileURL(join(ROOT, 'lib/routes.js')).href);
  const llm = createFakeLlm();
  const logger = createFakeLogger();
  const ctx = createFakeCtx(llm, logger, { agents, titles });
  const api = routes.createApi({
    ctx,
    dataDir,
    logger,
    now: Date.now,
    fetchImpl: async () => {
      throw new Error('qa: off-network dictionary lookup');
    },
  });
  const handler = routes.createHttpHandler(api);
  return { api, handler, llm, logger, ctx, routes };
}

function createCall(handler) {
  return async (method, path, body) => {
    const res = new FakeResponse();
    await handler(fakeRequest({ method, url: `/dsh-immersive/api${path}`, body }), res);
    let json = null;
    try {
      json = JSON.parse(res.body);
    } catch {
      json = null;
    }
    return { status: res.statusCode, json, raw: res.body };
  };
}

const newTempDir = async (list) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-conv-'));
  list.push(dir);
  return dir;
};

const eventTypes = (session) => (Array.isArray(session?.events) ? session.events.map((entry) => entry.type) : []);

async function checkBridgeContract(tempDirs) {
  section('bridge contract (in-process HTTP + fake DSH agents)');
  const agents = createFakeAgents();
  const titles = createFakeTitles();
  const dataDir = await newTempDir(tempDirs);
  const host = await bootHost({ agents, titles, dataDir });
  const call = createCall(host.handler);

  /* ---- empty conversations list ---- */
  const empty = await call('GET', '/conversations');
  await check('GET /conversations 200 {ok:true, conversations:[]} on fresh host', () => {
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { ok: true, conversations: [] });
  });

  /* ---- one translate round with a turnId creates a real session ---- */
  queueTranslate(host.llm, ['译文甲'], { inputTokens: 12, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 });
  const first = await call('POST', '/translate', {
    texts: ['Hello conversation'],
    targetLanguage: 'zh-CN',
    sourceUrl: 'https://example.com/conv-qa',
    sourceTitle: 'Conversation QA',
    client: 'extension',
    turnId: 'tr_conv_qa_a',
    stepIndex: 0,
    mode: 'bilingual',
  });
  await check('POST /translate (turnId) still returns the v2 translation payload', () => {
    assert.equal(first.status, 200);
    assert.equal(first.json?.ok, true);
    assert.deepEqual(first.json?.translations, ['译文甲']);
  });
  await check('bridge created ONE DSH agent with translation-<turnId> session id', () => {
    assert.equal(agents.created.length, 1, `created=${agents.created.length}`);
    assert.equal(agents.created[0].sessionId, 'translation-tr_conv_qa_a');
    assert.ok(String(agents.created[0].meta?.cwd).endsWith('/conversations'), `cwd=${agents.created[0].meta?.cwd}`);
    assert.equal(agents.created[0].agentOptions?.provider, 'modelhub');
    assert.equal(agents.created[0].agentOptions?.model, 'deepseek-flash');
  });
  const sessionA = agents.sessions.get('translation-tr_conv_qa_a');
  await check('native session event sequence = turn/start→step/start→user→assistant→step/end→turn/end', () => {
    assert.deepEqual(eventTypes(sessionA), ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end']);
    assert.equal(sessionA.events[0].payload?.turn, 1);
  });
  await check('user message text follows the contract template (single segment)', () => {
    const user = sessionA.events.find((entry) => entry.type === 'user/message');
    assert.equal(user.payload?.message?.content?.[0]?.text ?? user.payload?.content?.[0]?.text, '将以下内容翻译为 zh-CN：\nHello conversation');
    assert.equal(user.payload?.message?.role ?? user.payload?.role, 'user');
  });
  await check('assistant message carries the translated text + 4-bucket usage', () => {
    const assistant = sessionA.events.find((entry) => entry.type === 'assistant/message');
    const message = assistant.payload?.message ?? assistant.payload;
    assert.equal(message?.content?.[0]?.text, '译文甲');
    assert.equal(message?.role, 'assistant');
    assert.deepEqual(assistant.payload?.usage, { inputTokens: 12, outputTokens: 5, cacheReadTokens: 2 });
    assert.ok(Array.isArray(assistant.payload?.stream) && assistant.payload.stream[0]?.type === 'text-chunks');
  });
  await check('session title pinned via sessionTitle.rename → 翻译 · Conversation QA', () => {
    assert.equal(titles.renamed.length, 1);
    assert.equal(titles.renamed[0].title, '翻译 · Conversation QA');
    assert.ok(titles.renamed[0].session !== null && titles.renamed[0].session !== undefined, 'rename called without a session');
  });
  await check('the created agent inbox was cleared (no queued native turns)', () => {
    assert.equal(sessionA.inboxCleared, 1);
  });

  /* ---- GET /conversations shape ---- */
  const list1 = await call('GET', '/conversations');
  await check('GET /conversations lists the live conversation with the documented shape', () => {
    assert.equal(list1.status, 200);
    assert.equal(list1.json?.ok, true);
    assert.equal(list1.json?.conversations?.length, 1);
    const row = list1.json.conversations[0];
    // Contract §2 required keys (additive QA-friendly fields are allowed).
    for (const key of ['turnId', 'sessionId', 'title', 'turns', 'createdAt', 'lastAt', 'live']) {
      assert.ok(Object.hasOwn(row, key), `missing ${key}`);
    }
    assert.equal(row.turnId, 'tr_conv_qa_a');
    assert.equal(row.sessionId, 'translation-tr_conv_qa_a');
    assert.equal(row.title, '翻译 · Conversation QA');
    assert.equal(row.turns, 1);
    assert.equal(row.live, true);
    assert.equal(typeof row.createdAt, 'number');
    assert.equal(typeof row.lastAt, 'number');
    // Additive row fields used by the client conversation cards.
    assert.equal(row.status, 'ok');
    assert.deepEqual(row.kinds, ['translate']);
    assert.equal(row.inputTokens, 12);
    assert.equal(row.outputTokens, 5);
  });

  /* ---- ledger event enriched with sessionId/turn ---- */
  const events1 = await call('GET', '/usage/events?limit=50');
  await check('ledger event carries sessionId + turn (native round number)', () => {
    const event = events1.json?.events?.find((entry) => entry?.turnId === 'tr_conv_qa_a');
    assert.ok(event !== undefined, 'ledger event missing');
    assert.equal(event.sessionId, 'translation-tr_conv_qa_a');
    assert.equal(event.turn, 1);
  });

  /* ---- /usage/turns turns carry sessionId ---- */
  const turns1 = await call('GET', '/usage/turns?limit=50');
  await check('/usage/turns Turn carries sessionId (and steps retain order)', () => {
    const turn = turns1.json?.turns?.find((entry) => entry.id === 'tr_conv_qa_a');
    assert.ok(turn !== undefined, 'turn missing');
    assert.equal(turn.sessionId, 'translation-tr_conv_qa_a');
    assert.equal(turn.steps?.length, 1);
    assert.equal(turn.steps[0]?.stepIndex, 0);
  });
  await check('/usage/turns Step carries sessionId too (contract §2 wording)', () => {
    const turn = turns1.json?.turns?.find((entry) => entry.id === 'tr_conv_qa_a');
    assert.equal(turn?.steps?.[0]?.sessionId, 'translation-tr_conv_qa_a');
  });

  /* ---- second batch of the same translation run = native turn 2 ---- */
  queueTranslate(host.llm, ['译文乙'], { inputTokens: 8, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const second = await call('POST', '/translate', {
    texts: ['Second batch'],
    targetLanguage: 'zh-CN',
    sourceUrl: 'https://example.com/conv-qa',
    sourceTitle: 'Conversation QA',
    client: 'extension',
    turnId: 'tr_conv_qa_a',
    stepIndex: 1,
    mode: 'bilingual',
  });
  await check('same turnId reuses the SAME live conversation (no second agent)', () => {
    assert.equal(second.status, 200);
    assert.equal(agents.created.length, 1, `created=${agents.created.length}`);
    assert.equal(sessionA.events.filter((entry) => entry.type === 'turn/start').length, 2);
    assert.deepEqual(sessionA.events.filter((entry) => entry.type === 'turn/start').map((entry) => entry.payload?.turn), [1, 2]);
  });
  await check('conversation turns counter advances to 2 and ./usage/turns keeps 2 steps', async () => {
    const list = await call('GET', '/conversations');
    assert.equal(list.json?.conversations?.[0]?.turns, 2);
    const turns = await call('GET', '/usage/turns?limit=50');
    const turn = turns.json?.turns?.find((entry) => entry.id === 'tr_conv_qa_a');
    assert.equal(turn?.steps?.length, 2);
    assert.equal(turn?.sessionId, 'translation-tr_conv_qa_a');
  });

  /* ---- lookup conversation ---- */
  host.llm.pushStream(() => textStream('查词译文', { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }));
  const lookup = await call('POST', '/lookup', {
    text: 'hello',
    context: 'hello world',
    targetLanguage: 'zh-CN',
    sourceUrl: 'https://example.com/conv-qa',
    sourceTitle: 'Lookup QA',
    client: 'extension',
    turnId: 'lk_conv_qa',
    stepIndex: 0,
  });
  await check('lookup with turnId keeps the v2 result shape', () => {
    assert.equal(lookup.status, 200);
    assert.equal(lookup.json?.result?.translation, '查词译文');
  });
  const sessionLk = agents.sessions.get('translation-lk_conv_qa');
  await check('lookup conversation: session, title prefix 翻译查词, 查词 user text', () => {
    assert.ok(sessionLk !== undefined, 'lookup conversation missing');
    const user = sessionLk.events.find((entry) => entry.type === 'user/message');
    assert.equal(user.payload?.message?.content?.[0]?.text ?? user.payload?.content?.[0]?.text, '查词（zh-CN）：hello\n上下文：hello world');
    const rename = titles.renamed.find((entry) => String(entry.title).startsWith('翻译查词 · '));
    assert.ok(rename !== undefined, `titles=${JSON.stringify(titles.renamed.map((entry) => entry.title))}`);
    assert.equal(rename.title, '翻译查词 · Lookup QA');
  });
  await check('lookup conversation assistant text = dictionary/model translation', () => {
    const assistant = sessionLk.events.find((entry) => entry.type === 'assistant/message');
    assert.equal((assistant.payload?.message ?? assistant.payload)?.content?.[0]?.text, '查词译文');
  });

  /* ---- failure round: user message + turn/end error, no assistant ---- */
  queueFailure(host.llm, 'RATE_LIMIT');
  const failed = await call('POST', '/translate', {
    texts: ['Fail batch'],
    targetLanguage: 'zh-CN',
    sourceTitle: 'Failure QA',
    turnId: 'tr_conv_qa_fail',
    stepIndex: 0,
  });
  await check('failed translation keeps its error envelope (bridge did not swallow it)', () => {
    assert.ok(failed.status >= 400);
    assert.equal(failed.json?.ok, false);
    assert.equal(failed.json?.error?.code, 'MODEL_RATE_LIMITED');
  });
  const sessionFail = agents.sessions.get('translation-tr_conv_qa_fail');
  await check('failed round records user message + turn/end{reason:error}, no assistant message', () => {
    assert.ok(sessionFail !== undefined, 'failure conversation missing');
    assert.deepEqual(eventTypes(sessionFail), ['turn/start', 'step/start', 'user/message', 'step/end', 'turn/end']);
    const end = sessionFail.events.find((entry) => entry.type === 'turn/end');
    assert.equal(end.payload?.reason?.kind, 'error');
    assert.equal(typeof end.payload?.reason?.error?.message, 'string');
    assert.equal(sessionFail.events.filter((entry) => entry.type === 'assistant/message').length, 0);
  });
  await check('failure ledger row still recorded with sessionId + turn', async () => {
    const events = await call('GET', '/usage/events?limit=50');
    const event = events.json?.events?.find((entry) => entry?.turnId === 'tr_conv_qa_fail');
    assert.ok(event !== undefined);
    assert.equal(event.ok, false);
    assert.equal(event.sessionId, 'translation-tr_conv_qa_fail');
    assert.equal(event.turn, 1);
  });

  /* ---- no turnId → ledger only, no conversation ---- */
  const beforeNoTurn = agents.created.length;
  queueTranslate(host.llm, ['无会话译文'], { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const noTurn = await call('POST', '/translate', { texts: ['No turn id'], targetLanguage: 'zh-CN' });
  await check('translate without turnId: 200 + no conversation created (ledger only)', async () => {
    assert.equal(noTurn.status, 200);
    assert.equal(agents.created.length, beforeNoTurn);
    const turns = await call('GET', '/usage/turns?limit=50');
    const legacy = turns.json?.turns?.find((entry) => entry.kind === 'translate' && String(entry.id).startsWith('evt:'));
    assert.ok(legacy !== undefined, 'legacy turn missing');
    assert.equal(legacy.sessionId, undefined);
  });

  /* ---- persistence of sessionId/turn in the ledger JSON ---- */
  await check('usage.json persists sessionId + turn on every conversation-backed event', () => {
    const ledger = JSON.parse(readFileSync(join(dataDir, 'usage.json'), 'utf8'));
    const events = ledger.events.filter((entry) => entry?.turnId === 'tr_conv_qa_a');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((entry) => entry.turn).sort((left, right) => left - right), [1, 2]);
    for (const event of events) assert.equal(event.sessionId, 'translation-tr_conv_qa_a');
  });

  /* ---- route methods ---- */
  const postConversations = await call('POST', '/conversations', {});
  await check('POST /conversations is rejected with 405 (GET-only route)', () => {
    assert.equal(postConversations.status, 405);
    assert.equal(postConversations.json?.error?.code, 'METHOD_NOT_ALLOWED');
  });

  /* ---- plugin unload disposes live conversations (ctx.effect cleanup) ---- */
  await check('ctx.effect cleanup disposes every live conversation agent on unload', async () => {
    assert.ok(host.ctx.cleanups.length >= 1, 'no ctx.effect cleanup registered');
    for (const cleanup of host.ctx.cleanups) cleanup();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(agents.disposed.length >= 3, `disposed=${agents.disposed.length}`);
    const list = await call('GET', '/conversations');
    const rows = list.json?.conversations ?? [];
    assert.equal(rows.filter((row) => row.live === true).length, 0, 'live rows must be gone after unload');
    // History rows derived from the ledger are additive and may remain (live:false).
    assert.ok(rows.every((row) => row.live === false));
    assert.ok(rows.some((row) => row.sessionId === 'translation-tr_conv_qa_a'), JSON.stringify({ status: list.status, rows: rows.map((row) => ({ id: row.sessionId, live: row.live })).slice(0, 8), raw: String(list.raw).slice(0, 200) }));
  });

  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 4. Bridge fallback contract (never fail a translation)              */
/* ------------------------------------------------------------------ */

async function checkBridgeFallback(tempDirs) {
  section('bridge fallback (agents unavailable / create fails / append fails)');

  /* -- 4.1 agents service unavailable: translation + ledger unaffected -- */
  {
    const agents = null; // ctx.get('agents') → undefined
    const dataDir = await newTempDir(tempDirs);
    const host = await bootHost({ agents, dataDir });
    const call = createCall(host.handler);
    queueTranslate(host.llm, ['无桥译文'], { inputTokens: 6, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const response = await call('POST', '/translate', {
      texts: ['No bridge'], targetLanguage: 'zh-CN', sourceTitle: 'No bridge QA', turnId: 'tr_conv_no_bridge', stepIndex: 0,
    });
    await check('agents unavailable: translate still 200 with translations', () => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.ok, true);
      assert.deepEqual(response.json?.translations, ['无桥译文']);
    });
    await check('agents unavailable: ledger row recorded (no sessionId) + conversations empty', async () => {
      const events = await call('GET', '/usage/events?limit=50');
      const event = events.json?.events?.find((entry) => entry?.turnId === 'tr_conv_no_bridge');
      assert.ok(event !== undefined, 'ledger row missing');
      assert.equal(event.ok, true);
      assert.equal(event.sessionId, undefined);
      const list = await call('GET', '/conversations');
      assert.deepEqual(list.json, { ok: true, conversations: [] });
    });
    await check('agents unavailable: warning logged exactly once (no per-request spam)', () => {
      const warnings = host.logger.lines.warn.filter((line) => /agents service is unavailable/i.test(line));
      assert.equal(warnings.length, 1, `warnings=${JSON.stringify(host.logger.lines.warn)}`);
    });
    await check('agents unavailable: /usage/turns still serves the ledger turn', async () => {
      const turns = await call('GET', '/usage/turns?limit=50');
      const turn = turns.json?.turns?.find((entry) => entry.id === 'tr_conv_no_bridge');
      assert.ok(turn !== undefined);
      assert.equal(turn.sessionId, undefined);
      assert.equal(turn.ok, 1);
    });
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  /* -- 4.2 agents.create throws: translation + ledger unaffected -- */
  {
    const agents = createFakeAgents({ failCreate: true });
    const titles = createFakeTitles();
    const dataDir = await newTempDir(tempDirs);
    const host = await bootHost({ agents, titles, dataDir });
    const call = createCall(host.handler);
    queueTranslate(host.llm, ['创建失败译文'], { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const response = await call('POST', '/translate', {
      texts: ['Create fails'], targetLanguage: 'zh-CN', sourceTitle: 'Create fails QA', turnId: 'tr_conv_create_fail', stepIndex: 0,
    });
    await check('agents.create failure: translate still 200, no conversation, ledger row exists', async () => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.ok, true);
      const events = await call('GET', '/usage/events?limit=50');
      const event = events.json?.events?.find((entry) => entry?.turnId === 'tr_conv_create_fail');
      assert.ok(event !== undefined, 'ledger row missing');
      assert.equal(event.sessionId, undefined);
      const list = await call('GET', '/conversations');
      assert.deepEqual(list.json?.conversations, []);
      assert.ok(host.logger.lines.warn.some((line) => /conversation create failed/i.test(line)));
    });
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  /* -- 4.3 session.append throws: translation + ledger unaffected -- */
  {
    const agents = createFakeAgents({ failAppend: true });
    const dataDir = await newTempDir(tempDirs);
    const host = await bootHost({ agents, dataDir });
    const call = createCall(host.handler);
    queueTranslate(host.llm, ['追加失败译文'], { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const response = await call('POST', '/translate', {
      texts: ['Append fails'], targetLanguage: 'zh-CN', sourceTitle: 'Append fails QA', turnId: 'tr_conv_append_fail', stepIndex: 0,
    });
    await check('session.append failure: translate still 200 + ledger row recorded (bridge swallowed)', async () => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.ok, true);
      assert.deepEqual(response.json?.translations, ['追加失败译文']);
      const events = await call('GET', '/usage/events?limit=50');
      const event = events.json?.events?.find((entry) => entry?.turnId === 'tr_conv_append_fail');
      assert.ok(event !== undefined, 'ledger row missing');
      assert.equal(event.sessionId, undefined);
      assert.ok(host.logger.lines.warn.some((line) => /record failed/i.test(line)));
    });
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* 5. Lifecycle: 24-live-conversation LRU cap                          */
/* ------------------------------------------------------------------ */

async function checkConversationLru(tempDirs) {
  section('lifecycle: 24 live conversation LRU cap');
  const agents = createFakeAgents();
  const titles = createFakeTitles();
  const dataDir = await newTempDir(tempDirs);
  const host = await bootHost({ agents, titles, dataDir });
  const call = createCall(host.handler);
  for (let index = 0; index < 25; index += 1) {
    queueTranslate(host.llm, [`LRU 译文 ${index}`], { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const response = await call('POST', '/translate', {
      texts: [`lru batch ${index}`], targetLanguage: 'zh-CN', sourceTitle: `LRU ${index}`, turnId: `tr_lru_${index}`, stepIndex: 0,
    });
    assert.equal(response.status, 200);
  }
  const list = await call('GET', '/conversations');
  const liveRows = (list.json?.conversations ?? []).filter((row) => row.live === true);
  await check('25 translation runs keep at most 24 live conversations', () => {
    assert.equal(agents.created.length, 25);
    assert.equal(liveRows.length, 24);
  });
  await check('oldest conversation was disposed (LRU) while newer ones stay live', () => {
    assert.equal(liveRows.some((row) => row.turnId === 'tr_lru_0'), false);
    assert.ok(liveRows.some((row) => row.turnId === 'tr_lru_24'));
    assert.ok(agents.disposed.includes('translation-tr_lru_0'), `disposed=${JSON.stringify(agents.disposed)}`);
    // The disposed run is still listed as a ledger-derived history row (live:false).
    assert.ok((list.json?.conversations ?? []).some((row) => row.turnId === 'tr_lru_0' && row.live === false), JSON.stringify({ status: list.status, all: (list.json?.conversations ?? []).map((row) => ({ id: row.turnId, live: row.live })).slice(0, 5), raw: String(list.raw).slice(0, 200) }));
  });
  await check('the disposed conversation events stay recorded (persisted session, agent released)', () => {
    // Only the live list drops it; the ledger rows remain.
    assert.equal(agents.sessions.get('translation-tr_lru_0')?.events.length, 6);
  });
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* 6. Pure helper unit contract (no HTTP)                              */
/* ------------------------------------------------------------------ */

async function checkHelperUnits() {
  section('conversation helper units');
  let mod = null;
  try {
    mod = await import(pathToFileURL(join(ROOT, 'lib/conversations.js')).href);
  } catch {
    mod = null;
  }
  await check('conversationSessionId: path-safe translation-<turnId>', () => {
    assert.equal(mod.conversationSessionId('tr_qa_1'), 'translation-tr_qa_1');
    assert.equal(mod.conversationSessionId('tr a/b?c'), 'translation-tr-a-b-c');
  });
  await check('conversationSessionId: capped at 96 chars and never empty', () => {
    const long = mod.conversationSessionId('x'.repeat(300));
    assert.ok(long.length <= 96, `len=${long.length}`);
    assert.ok(long.startsWith('translation-'));
    const empty = mod.conversationSessionId('');
    assert.ok(empty.length > 'translation-'.length);
  });
  await check('composeTitle: 翻译 · / 翻译查词 · prefixes + 60 char cap', () => {
    assert.equal(mod.composeTitle({ kind: 'translate', sourceTitle: 'Example Article' }), '翻译 · Example Article');
    assert.equal(mod.composeTitle({ kind: 'translate', site: 'example.com' }), '翻译 · example.com');
    assert.equal(mod.composeTitle({ kind: 'lookup', sourceTitle: 'Word' }), '翻译查词 · Word');
    assert.equal(mod.composeTitle({ kind: 'translate', sourceTitle: 'x'.repeat(200) }).length, 60);
  });
  await check('composeUserText / composeAssistantText: single, multi, lookup', () => {
    assert.equal(mod.composeUserText({ kind: 'translate', targetLanguage: 'zh-CN', texts: ['one'] }), '将以下内容翻译为 zh-CN：\none');
    assert.equal(mod.composeUserText({ kind: 'translate', targetLanguage: 'zh-CN', texts: ['a', 'b'] }), '将以下 2 段内容翻译为 zh-CN：\n1. a\n2. b');
    assert.match(mod.composeUserText({ kind: 'lookup', targetLanguage: 'zh-CN', text: 'hi', context: 'hello world' }), /^查词（zh-CN）：hi\n上下文：hello world$/);
    assert.equal(mod.composeAssistantText({ kind: 'translate', translations: ['x'] }), 'x');
    assert.equal(mod.composeAssistantText({ kind: 'translate', translations: ['a', 'b'] }), '1. a\n2. b');
    assert.equal(mod.composeAssistantText({ kind: 'lookup', translation: '你好' }), '你好');
  });
  await check('normalizeSessionUsage: cache buckets omitted when zero, kept when >0', () => {
    assert.deepEqual(mod.normalizeSessionUsage({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }), { inputTokens: 3, outputTokens: 2 });
    assert.deepEqual(mod.normalizeSessionUsage({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 1 }), { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 1 });
    assert.equal(mod.normalizeSessionUsage(null), undefined);
  });
}

/* ------------------------------------------------------------------ */
/* 7. Client 「轨迹」 conversation UI static contract                   */
/* ------------------------------------------------------------------ */

async function checkClientStatic() {
  section('client.js conversation UI contract');
  if (!exists('client.js')) {
    await check('client.js exists', () => assert.fail('client.js missing'));
    return;
  }
  const source = readText('client.js');
  const literalCount = (literal) => source.split(literal).length - 1;

  await check('client.js calls GET /conversations (title/live enrichment)', () => {
    assert.match(source, /request\(\s*['"]conversations['"]|['"]conversations['"]/);
  });
  await check('client.js still calls GET /usage/turns (primary conversation data source)', () => {
    assert.match(source, /['"]usage\/turns['"]/);
  });
  await check('client.js groups turns into conversations by sessionId', () => {
    assert.match(source, /sessionId/);
    assert.match(source, /conversation/i);
    assert.ok(
      /group\w*Conversation|conversationsFromTurns|buildConversation|conversationGroups|groupTurns/i.test(source) ||
        /new Map\(\)/.test(source),
      'no conversation grouping helper found',
    );
  });
  await check('conversation card UI exists (dsh-it-conversation* classes)', () => {
    assert.match(source, /dsh-it-conversation/);
  });
  await check('zh dictionary has 「打开 DSH 轨迹」/「在 DSH 中查看轨迹」 button label', () => {
    assert.match(source, /打开\s*DSH\s*轨迹|在 DSH 中查看轨迹|在 DSH 中打开/);
  });
  await check('「打开 DSH 轨迹」 button rendered for conversation rows', () => {
    assert.ok(literalCount('trace.openConversation') >= 2, `trace.openConversation x${literalCount('trace.openConversation')}`);
    assert.ok(/openConversation\(/.test(source));
  });
  await check('openConversation(sessionId) calls uiWorkspace.openSession(sessionId)', () => {
    const index = source.indexOf('function openConversation(');
    assert.ok(index >= 0, 'openConversation function missing');
    const block = source.slice(index, index + 700);
    assert.match(block, /openSession\(sessionId\)/);
  });
  await check('uiWorkspace service is injected/looked up (optional, graceful)', () => {
    assert.match(source, /uiWorkspace/);
    assert.ok(/inject\(\s*\[\s*['"]uiWorkspace['"]\s*\]/.test(source) || /get\(\s*['"]uiWorkspace['"]/.test(source), 'uiWorkspace service resolution missing');
  });
  await check('button hidden with an explicit reason when no uiWorkspace/sessionId (§3)', () => {
    assert.match(source, /trace\.conversation\.[A-Za-z]*[Uu]navailable|trace\.conversation\.noWorkspace|无法打开|unavailable|无需|没有会话/i);
  });
  await check('legacy section for turns without sessionId (§1/§3 旧版请求)', () => {
    assert.ok(
      /旧版请求|无 DSH 会话|legacy/i.test(source),
      'legacy conversation section missing',
    );
    assert.match(source, /sessionId/);
  });
  await check('/usage/turns 404 → legacy inline Turn fallback kept (§3)', () => {
    assert.match(source, /trace\.legacy/);
    assert.ok(/404/.test(source));
    assert.match(source, /['"]usage\/events['"]/);
  });
  await check('new trace.conversation.* i18n keys have zh→en parity', () => {
    const keys = new Set();
    for (const match of source.matchAll(/['"]trace\.(conversation\.[A-Za-z0-9_.]+)['"]/g)) keys.add(`trace.${match[1]}`);
    assert.ok(keys.size >= 5, `found only ${keys.size} trace.conversation.* keys`);
    const missing = [...keys].filter((key) => literalCount(key) < 2);
    assert.deepEqual(missing, [], `keys missing an en or zh translation: ${missing.join(', ')}`);
  });
  await check('conversation cards keep a11y + 5s usage polling + clear/filters', () => {
    assert.match(source, /aria-expanded/);
    assert.match(source, /visibilityState/);
    assert.match(source, /trace\.filter\./);
    assert.match(source, /trace\.clear/);
  });
  await check('no regression: overview/settings/wordbook tabs still registered', () => {
    assert.match(source, /panel\.tab\.overview/);
    assert.match(source, /panel\.tab\.traces/);
    assert.match(source, /panel\.tab\.settings/);
    assert.match(source, /panel\.tab\.wordbook/);
  });
}

/* ------------------------------------------------------------------ */
/* 8. Regression: old independent harnesses, unmodified                */
/* ------------------------------------------------------------------ */

function runChildHarness(relative) {
  const result = spawnSync(process.execPath, [relative], { cwd: ROOT, encoding: 'utf8', timeout: 180_000, env: { ...process.env } });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return { status: result.status, output };
}

async function checkRegression() {
  section('regression: previous QA harnesses (unmodified)');
  if (NO_REGRESSION) {
    await check('regression harnesses skipped (--no-regression)', () => {});
    return;
  }
  // verify-token-stats (v2/v3 token accounting) must stay fully green.
  const tokenStats = runChildHarness('qa/verify-token-stats.mjs');
  await check('verify-token-stats.mjs (unmodified) exits 0', () => {
    assert.equal(tokenStats.status, 0, tokenStats.output.split('\n').filter((line) => /^(FAIL|# \d+)/.test(line)).slice(-4).join(' | '));
    assert.match(tokenStats.output, /# \d+\/\d+ checks passed, 0 failed/);
  });
  // verify-turn-trace (v3 Turn contract) must stay behaviourally green; the only
  // allowed failures are its two strict version pins now bumped by contract §2
  // (plugin 1.4.0 → 1.5.0).
  const turnTrace = runChildHarness('qa/verify-turn-trace.mjs');
  const failures = turnTrace.output.split('\n').filter((line) => /^FAIL /.test(line));
  const allowedVersionFailures = failures.filter((line) =>
    /package\.json version === 1\.4\.0/.test(line) ||
    /lib\/version\.js VERSION === '1\.4\.0'/.test(line) ||
    /manifest\.version === 1\.7\.0/.test(line) ||
    /content\.js EXT_VERSION === 1\.7\.0/.test(line));
  const unexpected = failures.filter((line) => !allowedVersionFailures.includes(line));
  await check('verify-turn-trace.mjs (updated for v4) has no behavioural regressions', () => {
    assert.deepEqual(unexpected, [], `unexpected failures: ${unexpected.join(' | ')}`);
    assert.ok(allowedVersionFailures.length <= 4, `unexpected version-pin failures: ${allowedVersionFailures.join(' | ')}`);
    assert.match(turnTrace.output, /# \d+\/\d+ checks passed/);
  });
  await check('verify-turn-trace.mjs (updated for v4) passes fully on the current code', () => {
    assert.equal(allowedVersionFailures.length, 0, `stale version pins still failing: ${allowedVersionFailures.join(' | ')}`);
    const passed = /# (\d+)\/(\d+) checks passed/.exec(turnTrace.output);
    assert.ok(passed !== null, 'summary line missing');
    assert.equal(Number(passed[1]), Number(passed[2]), `failed=${Number(passed[2]) - Number(passed[1])}`);
    assert.equal(turnTrace.status, 0);
  });
}

/* ------------------------------------------------------------------ */
/* 9. Live read-only checks (--live)                                   */
/* ------------------------------------------------------------------ */

async function checkLiveReadOnly() {
  section(`live read-only contract (${LIVE_API})`);
  const callLive = async (path) => {
    const response = await fetch(`${LIVE_API}${path}`, { signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, raw: text.slice(0, 600) };
  };
  let health = null;
  let conversations = null;
  let turns = null;
  await check('GET /health 200 with plugin version >= 1.5.0', async () => {
    const response = await callLive('/health');
    health = response;
    assert.equal(response.status, 200);
    assert.equal(response.json?.ok, true);
    const parts = String(response.json?.version ?? '0.0.0').split('.').map((part) => Number(part) || 0);
    assert.ok(parts[0] > 1 || (parts[0] === 1 && parts[1] >= 5), `installed version=${response.json?.version}`);
  });
  await check('GET /conversations 200 with documented shape', async () => {
    const response = await callLive('/conversations');
    conversations = response;
    assert.equal(response.status, 200);
    assert.equal(response.json?.ok, true);
    assert.ok(Array.isArray(response.json?.conversations));
    for (const row of response.json.conversations) {
      for (const key of ['turnId', 'sessionId', 'title', 'turns', 'createdAt', 'lastAt', 'live']) {
        assert.ok(Object.hasOwn(row, key), `conversation row missing ${key}`);
      }
      assert.equal(typeof row.turnId, 'string');
      assert.equal(typeof row.sessionId, 'string');
      assert.ok(row.sessionId.startsWith('translation-'), `sessionId=${row.sessionId}`);
      assert.equal(typeof row.turns, 'number');
      assert.equal(typeof row.live, 'boolean');
    }
  });
  await check('GET /usage/turns 200 and conversation-backed turns carry sessionId', async () => {
    const response = await callLive('/usage/turns?limit=100');
    turns = response;
    assert.equal(response.status, 200);
    assert.equal(response.json?.ok, true);
    assert.ok(Array.isArray(response.json?.turns));
    const sessionIds = new Set((conversations?.json?.conversations ?? []).map((row) => row.sessionId));
    const withSession = response.json.turns.filter((turn) => typeof turn?.sessionId === 'string' && turn.sessionId.length > 0);
    if (sessionIds.size > 0) {
      assert.ok(withSession.length > 0, 'no turn carries sessionId despite live conversations');
      const matched = withSession.filter((turn) => sessionIds.has(turn.sessionId));
      assert.ok(matched.length > 0, 'no live turn sessionId matches a /conversations row');
    }
  });
  await check('sessionId naming: translation-<path-safe turnId>', () => {
    for (const row of conversations?.json?.conversations ?? []) {
      const expected = `translation-${String(row.turnId).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 83)}`;
      assert.equal(row.sessionId, expected);
    }
    for (const turn of turns?.json?.turns ?? []) {
      if (typeof turn?.sessionId !== 'string' || turn.sessionId.length === 0) continue;
      assert.ok(turn.sessionId.startsWith('translation-'), `turn ${turn.id} sessionId=${turn.sessionId}`);
    }
  });
  await check('GET /usage/events 200 + summary unchanged (bridge is additive)', async () => {
    const events = await callLive('/usage/events?limit=5');
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.json?.events));
    const usage = await callLive('/usage?days=14');
    assert.equal(usage.status, 200);
    assert.ok(usage.json?.usage?.totals && Array.isArray(usage.json.usage.days));
    assert.ok(Array.isArray(usage.json.usage.recent));
  });
  await check('GET /usage/turns legacy fallback intact (pre-bridge turns stay without sessionId)', () => {
    const rows = turns?.json?.turns ?? [];
    assert.ok(rows.length > 0, 'no turns on live host');
    // Pre-bridge events can carry a turnId (tr_/lk_) without a sessionId: those
    // are exactly the turns the client must render in the legacy inline section.
    const noSession = rows.filter((turn) => typeof turn?.sessionId !== 'string' || turn.sessionId.length === 0);
    for (const turn of noSession) {
      assert.equal(typeof turn.id, 'string');
      assert.ok(turn.id.length > 0);
      assert.ok(turn.id.startsWith('evt:') || /^(tr|lk)_/.test(turn.id), `unexpected legacy turn id ${turn.id}`);
    }
    const withSession = rows.filter((turn) => typeof turn?.sessionId === 'string' && turn.sessionId.length > 0);
    for (const turn of withSession) assert.ok(turn.sessionId.startsWith('translation-'));
  });
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`# qa verify-conversations @ ${new Date().toISOString()}`);
  console.log(`# root: ${ROOT}${LIVE ? ` | live: ${LIVE_API}` : ''}`);
  let gitStatus = '';
  try {
    const status = spawnSync('git', ['-C', WORKSPACE, 'status', '--short'], { encoding: 'utf8' });
    gitStatus = (status.stdout || '').trim();
  } catch {
    /* git optional */
  }
  const tempDirs = [];
  try {
    await checkSyntax();
    await checkHostStatic();
    await checkBridgeContract(tempDirs);
    await checkBridgeFallback(tempDirs);
    await checkConversationLru(tempDirs);
    await checkHelperUnits();
    await checkClientStatic();
    await checkRegression();
    if (LIVE) await checkLiveReadOnly();
  } catch (error) {
    console.error('# harness crashed:', error && error.stack ? error.stack : String(error));
    process.exitCode = 2;
    return;
  } finally {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((entry) => !entry.ok);
  const passed = results.length - failed.length;
  const durationMs = Date.now() - startedAt;
  if (!LIVE) {
    console.log('# live checks skipped (pass --live to run read-only live GETs)');
  }
  console.log(`\n# ${passed}/${results.length} checks passed, ${failed.length} failed in ${durationMs}ms`);
  if (failed.length > 0) {
    console.log('\nFAILURES:');
    for (const entry of failed) console.log(`- [${entry.section}] ${entry.name}${entry.detail ? ` :: ${entry.detail.slice(0, 320)}` : ''}`);
  }
  try {
    writeFileSync(
      join(QA_DIR, 'verify-conversations.result.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          root: ROOT,
          mode: LIVE ? 'in-process+live' : 'in-process',
          liveApi: LIVE ? LIVE_API : null,
          passed: failed.length === 0,
          total: results.length,
          failed: failed.length,
          durationMs,
          checks: results,
          gitStatus,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`# WARN: could not write result artifact: ${String(error && error.message)}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`verify-conversations crashed: ${error && error.stack ? error.stack : String(error)}`);
  process.exitCode = 2;
});
