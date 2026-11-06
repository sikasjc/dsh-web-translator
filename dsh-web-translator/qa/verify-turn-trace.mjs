#!/usr/bin/env node
/**
 * Independent QA harness for the "per-Turn trace" increment
 * (DESIGN-TURN-TRACE.md §2 / §3 / §4 / §5).
 *
 * Independent means: it imports only the plugin's public host entry points
 * (`lib/routes.js` / `lib/usage.js` / `lib/constants.js`) — never the plugin's
 * own test helpers — boots a real in-process HTTP handler against a temp
 * data dir with a fake LLM, and drives the Turn contract end to end:
 *   - LIB constants for the new request fields / query limits;
 *   - `usageService.turns()` aggregation: grouping by turnId, out-of-order
 *     stepIndex sorting, token/request sums, ok/partial/error status,
 *     duration/avgLatency, mixed kinds, legacy single-step turns, truncation,
 *     pagination (`before`/`limit`/clamping) and filters;
 *   - `POST /translate` + `POST /lookup` turn metadata (turnId/stepIndex/mode,
 *     validation + 400 BAD_REQUEST, outputPreview capture);
 *   - `GET /usage/turns` HTTP route + query dispatch + legacy-ledger tolerance;
 *   - `/usage` summary + `/usage/events` stay unchanged (backward compat);
 *   - client.js 「轨迹」Turn/Steps UI wiring (static) and the extension's
 *     turnId/stepIndex/mode tagging (static);
 *   - with `--full`, the host unit tests and extension verify/e2e suites.
 *
 * Usage:
 *   node qa/verify-turn-trace.mjs           # static + in-process contract checks
 *   node qa/verify-turn-trace.mjs --full    # also host tests + extension verify/e2e
 *   node qa/verify-turn-trace.mjs --quiet   # only failures + summary
 *
 * Exit code: 0 = all checks pass, 1 = failures, 2 = harness crashed.
 * QA-only script: source files are read-only for QA; writes only under qa/.
 */
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
const WORKTREE = join(ROOT, '..'); // git worktree root
const EXT = join(WORKTREE, 'dsh-web-translator-extension');
const FULL = process.argv.includes('--full');
const QUIET = process.argv.includes('--quiet');
const startedAt = Date.now();

const results = [];
let currentSection = 'general';

function section(name) {
  currentSection = name;
  if (!QUIET) console.log(`\n== ${name} ==`);
}

function check(name, ok, detail) {
  const entry = {
    section: currentSection,
    name,
    ok: !!ok,
    detail: detail === undefined ? '' : String(detail).slice(0, 900),
  };
  results.push(entry);
  if (!entry.ok || !QUIET) {
    const suffix = entry.detail.length > 0 ? `  [${entry.detail.replace(/\s+/g, ' ').slice(0, 500)}]` : '';
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
  }
  return entry.ok;
}

const readText = (relative, base = ROOT) => readFileSync(join(base, relative), 'utf8');
const exists = (relative, base = ROOT) => existsSync(join(base, relative));

function nodeCheckFile(relative, base = ROOT) {
  const absolute = join(base, relative);
  if (!existsSync(absolute)) return check(`node --check ${relative}`, false, 'file does not exist');
  const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
  return check(`node --check ${relative}`, result.status === 0, result.status === 0 ? '' : (result.stderr || result.stdout || '').trim().slice(0, 400));
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

/** Fake Cordis-like host context with a default model selection. */
function createFakeCtx(llm, logger) {
  return {
    llm,
    logger,
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'modelhub', model: 'deepseek-flash', reasoningEffort: 'max' }) };
      }
      return undefined;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

const BUCKETS = ['requests', 'ok', 'errors', 'cached', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const TOKEN_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

const pickBuckets = (object, keys = BUCKETS) => Object.fromEntries(keys.map((key) => [key, object?.[key]]));
const numericBuckets = (object, keys = BUCKETS) => object !== null && typeof object === 'object' && keys.every((key) => Number.isFinite(object[key]));
const sameBuckets = (left, right, keys = BUCKETS) => JSON.stringify(pickBuckets(left, keys)) === JSON.stringify(pickBuckets(right, keys));
const sumBuckets = (list, keys = BUCKETS) => {
  const out = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const entry of Array.isArray(list) ? list : []) {
    for (const key of keys) out[key] += Number.isFinite(entry?.[key]) ? entry[key] : 0;
  }
  return out;
};

const TURN_SUM_KEYS = [...TOKEN_BUCKETS];
const STEP_SUM_KEYS = ['segments', 'chars', 'cached', 'retries', ...TOKEN_BUCKETS];

/** Text stream shaped like the DSH llm stream: usage -> text-delta -> finish stop. */
async function* textStream(text, usage) {
  if (usage !== undefined) yield { type: 'usage', usage };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Queue a successful model stream with a JSON translate payload. */
function queueTranslateSuccess(llm, translations, usage = {}) {
  llm.pushStream(() => textStream(JSON.stringify({ translations }), usage));
}

/** Queue a failing model stream with a mapped host error code. */
function queueTranslateFailure(llm, code = 'RATE_LIMIT', message = 'qa fake rate limit') {
  llm.pushStream(() => {
    const error = new Error(message);
    error.code = code;
    throw error;
  });
}

/** Invariants each Turn must satisfy on its own (DESIGN-TURN-TRACE §2.2). */
function turnInvariantProblems(turn) {
  const problems = [];
  if (turn === null || typeof turn !== 'object') return ['turn is not an object'];
  if (typeof turn.id !== 'string' || turn.id.length === 0) problems.push('id');
  if (!Array.isArray(turn.steps) || turn.steps.length === 0) {
    problems.push('steps');
    return problems;
  }
  const steps = turn.steps;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (!Number.isFinite(turn[key])) problems.push(`${key} not numeric`);
  }
  const stepTokenSum = sumBuckets(steps, TOKEN_BUCKETS);
  if (!sameBuckets(stepTokenSum, turn, TOKEN_BUCKETS)) problems.push('token sums != sum(steps)');
  const okSum = steps.filter((step) => step?.ok === true).length;
  const errorSum = steps.length - okSum;
  if (turn.requests !== steps.length) problems.push(`requests ${turn.requests} != steps ${steps.length}`);
  if (turn.ok !== okSum) problems.push(`ok ${turn.ok} != ${okSum}`);
  if (turn.errors !== errorSum) problems.push(`errors ${turn.errors} != ${errorSum}`);
  if (turn.cached !== steps.filter((step) => step?.cached === true).length) problems.push('cached sum');
  const expectedStatus = errorSum === 0 ? 'ok' : okSum > 0 ? 'partial' : 'error';
  if (turn.status !== expectedStatus) problems.push(`status ${turn.status} != ${expectedStatus}`);
  for (const key of ['segments', 'chars']) {
    const expected = steps.reduce((total, step) => total + (Number.isFinite(step?.[key]) ? step[key] : 0), 0);
    if (turn[key] !== expected) problems.push(`${key} ${turn[key]} != ${expected}`);
  }
  if (turn.steps.some((step) => !Number.isFinite(step?.retries))) problems.push('step.retries missing');
  const ats = steps.map((step) => step?.at).filter((at) => Number.isFinite(at));
  if (ats.length === steps.length) {
    if (turn.startedAt !== Math.min(...ats)) problems.push('startedAt != min(step.at)');
    if (turn.endedAt !== Math.max(...ats)) problems.push('endedAt != max(step.at)');
  }
  const latencies = steps.map((step) => step?.latencyMs).filter((value) => Number.isFinite(value));
  if (latencies.length === steps.length) {
    const avg = Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length);
    if (turn.avgLatencyMs !== avg) problems.push(`avgLatencyMs ${turn.avgLatencyMs} != ${avg}`);
    if (steps.length === 1 && turn.durationMs !== steps[0].latencyMs) {
      problems.push(`durationMs ${turn.durationMs} != single-step latencyMs ${steps[0].latencyMs}`);
    }
  }
  if (steps.length > 1 && Number.isFinite(turn.startedAt) && Number.isFinite(turn.endedAt) && turn.durationMs !== turn.endedAt - turn.startedAt) {
    problems.push(`durationMs ${turn.durationMs} != endedAt-startedAt ${turn.endedAt - turn.startedAt}`);
  }
  const byIndex = steps.map((step) => step?.stepIndex);
  if (!byIndex.every((value) => Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 10000)) problems.push('stepIndex range');
  for (let index = 1; index < byIndex.length; index += 1) {
    if (byIndex[index] <= byIndex[index - 1]) problems.push(`steps not ascending at ${index}`);
  }
  if (!['translate', 'lookup', 'mixed'].includes(turn.kind)) problems.push(`kind ${turn.kind}`);
  if (!['ok', 'partial', 'error'].includes(turn.status)) problems.push(`status ${turn.status}`);
  return problems;
}

/* ------------------------------------------------------------------ */
/* 1. Syntax                                                           */
/* ------------------------------------------------------------------ */

function checkSyntax() {
  section('syntax (node --check)');
  let libFiles = [];
  try {
    libFiles = readdirSync(join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).sort();
  } catch {
    libFiles = [];
  }
  check('lib/ contains .js modules', libFiles.length >= 15, `${libFiles.length} files`);
  for (const file of libFiles) nodeCheckFile(`lib/${file}`);
  nodeCheckFile('index.js');
  nodeCheckFile('client.js');
  let packageJson = null;
  try {
    packageJson = JSON.parse(readText('package.json'));
    check('package.json parses as JSON', packageJson !== null);
  } catch (error) {
    check('package.json parses as JSON', false, String(error && error.message));
  }
  for (const file of ['qa/verify-turn-trace.mjs', 'qa/verify-token-stats.mjs', 'qa/live-check.mjs', 'qa/panel-shot.mjs', 'qa/cdp.mjs']) {
    nodeCheckFile(file);
  }
  let extFiles = [];
  try {
    extFiles = readdirSync(EXT).filter((name) => /^(background|content|options)\.js$/.test(name)).sort();
  } catch {
    extFiles = [];
  }
  check('extension has background/content/options JS', extFiles.length === 3, extFiles.join(', '));
  for (const file of extFiles) nodeCheckFile(file, EXT);
  let toolFiles = [];
  try {
    toolFiles = readdirSync(join(EXT, 'tools')).filter((name) => name.endsWith('.mjs')).sort();
  } catch {
    toolFiles = [];
  }
  for (const file of toolFiles) nodeCheckFile(`tools/${file}`, EXT);
}

/* ------------------------------------------------------------------ */
/* 2. Host static contract                                             */
/* ------------------------------------------------------------------ */

async function checkHostStatic() {
  section('host static contract (constants / usage / api / http)');

  /* lib/constants.js: the new LIMITS from DESIGN-TURN-TRACE §2.3. */
  try {
    const constants = await import(pathToFileURL(join(ROOT, 'lib/constants.js')).href);
    const limits = constants.LIMITS ?? {};
    const expected = {
      turnIdChars: 64,
      modeChars: 16,
      stepIndexMax: 10000,
      outputPreviewChars: 200,
      usageTurnsDefault: 20,
      usageTurnsMax: 100,
    };
    for (const [key, value] of Object.entries(expected)) {
      check(`constants.LIMITS.${key} === ${value}`, limits[key] === value, String(limits[key]));
    }
  } catch (error) {
    check('constants module importable', false, String(error && error.message));
  }

  /* lib/usage.js exposes turns() and the turn-aware normalizer. */
  const usageSource = exists('lib/usage.js') ? readText('lib/usage.js') : '';
  check('usage.js declares turns(', /async\s+function\s+turns\s*\(/.test(usageSource) || /turns\s*[:=]\s*async\s*\(/.test(usageSource) || /function\s+turns\s*\(/.test(usageSource));
  check('usage.js turn fields normalized (turnId/stepIndex/mode/outputPreview)', ['turnId', 'stepIndex', 'mode', 'outputPreview'].every((field) => usageSource.includes(field)));
  check('usage.js turn aggregation helpers present (grouping/status/duration)', /buildTurn|aggregateTurn|toTurn/i.test(usageSource) && /status/.test(usageSource));
  try {
    const usageModule = await import(pathToFileURL(join(ROOT, 'lib/usage.js')).href);
    check('usage.js exports createUsageService', typeof usageModule.createUsageService === 'function');
    const service = usageModule.createUsageService({ now: () => 5_000 });
    check('createUsageService().turns is a function', typeof service?.turns === 'function');
    const exported = ['createUsageService', 'USAGE_EVENT_KINDS'];
    check('usage.js keeps legacy exports', exported.every((name) => usageModule[name] !== undefined), exported.filter((name) => usageModule[name] === undefined).join(','));
  } catch (error) {
    check('usage.js importable + turns() exposed', false, String(error && error.message));
  }

  /* lib/api.js: metadata validation + preview capture + turns listing. */
  const apiSource = exists('lib/api.js') ? readText('lib/api.js') : '';
  check('api.js references turnId', /turnId/.test(apiSource));
  check('api.js validates stepIndex against LIMITS.stepIndexMax', /stepIndexMax/.test(apiSource) && /stepIndex/.test(apiSource));
  check('api.js validates mode against LIMITS.modeChars', /modeChars/.test(apiSource));
  check('api.js caps turnId with LIMITS.turnIdChars', /turnIdChars/.test(apiSource));
  check('api.js records outputPreview (LIMITS.outputPreviewChars)', /outputPreview/.test(apiSource) && /outputPreviewChars/.test(apiSource));
  check('api.js exposes a turns listing (/usage/turns backend)', /listUsageTurns|getUsageTurns|usageTurns/.test(apiSource));
  check('api.js keeps /usage/events listing (backward compat)', /listUsageEvents/.test(apiSource));

  /* lib/http.js: route registration + dispatch. */
  const httpSource = exists('lib/http.js') ? readText('lib/http.js') : '';
  check(
    "http.js ROUTES has '/usage/turns' GET",
    /['"]\/usage\/turns['"]\s*:\s*[^,\n]*\[[^\]]*['"]GET['"]/.test(httpSource),
    httpSource.match(/['"]\/usage\/turns['"][^\n]*/)?.[0] ?? 'route entry not found',
  );
  check('http.js dispatchGet wires /usage/turns', /case\s+['"]\/usage\/turns['"]\s*:/.test(httpSource));
  check(
    'http.js dispatches turns limit/kind/status/before query params',
    /\/usage\/turns/.test(httpSource) &&
      /listUsageTurns|getUsageTurns|usageTurns/.test(httpSource) &&
      ['limit', 'kind', 'status', 'before'].every((param) => httpSource.includes(param)),
  );
  check("http.js keeps '/usage/events' route unchanged", /['"]\/usage\/events['"]\s*:\s*[^,\n]*\[[^\]]*['"]GET['"]/.test(httpSource));

  /* Versions (Lead owns them, QA asserts). */
  const versionAtLeast = (value, major, minor) => {
    const parts = String(value ?? '0.0.0').split('.').map((part) => Number(part) || 0);
    return parts[0] > major || (parts[0] === major && parts[1] >= minor);
  };
  try {
    const pkg = JSON.parse(readText('package.json'));
    // The Turn-trace increment shipped plugin 1.4.0; later increments (v4
    // conversations) bump the version, so assert "at least" here.
    check('package.json version >= 1.4.0 (turn-trace increment)', versionAtLeast(pkg?.version, 1, 4), String(pkg?.version));
  } catch {
    /* already reported in syntax */
  }
  const versionSource = exists('lib/version.js') ? readText('lib/version.js') : '';
  const moduleVersion = versionSource.match(/VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  check('lib/version.js VERSION >= 1.4.0 (turn-trace increment)', versionAtLeast(moduleVersion, 1, 4), moduleVersion ?? 'not found');

  check('DESIGN-TURN-TRACE.md contract file present', exists('DESIGN-TURN-TRACE.md') && readText('DESIGN-TURN-TRACE.md').length > 5000);

  /* Host unit tests mention the Turn contract. */
  let testSources = '';
  try {
    testSources = readdirSync(join(ROOT, 'test')).filter((name) => name.endsWith('.mjs')).map((name) => readText(`test/${name}`)).join('\n');
  } catch {
    testSources = '';
  }
  check('host test/ covers turns() (turnId/turns assertions)', /turnId/.test(testSources) && /\.turns\(|turns\(/.test(testSources));
  check('host test/ covers /usage/turns HTTP route', /usage\/turns/.test(testSources));
}

/* ------------------------------------------------------------------ */
/* 3. usageService.turns() unit contract (deterministic in-memory)     */
/* ------------------------------------------------------------------ */

async function checkUsageServiceTurns() {
  section('usageService.turns() contract (in-process, deterministic clock)');
  let createUsageService;
  try {
    ({ createUsageService } = await import(pathToFileURL(join(ROOT, 'lib/usage.js')).href));
  } catch (error) {
    check('lib/usage.js importable', false, String(error && error.message));
    return;
  }
  if (typeof createUsageService !== 'function') {
    check('createUsageService available', false);
    return;
  }
  const service = createUsageService({ now: () => 9_000 });
  const base = { kind: 'translate', ok: true, provider: 'modelhub', model: 'deepseek-flash', targetLanguage: 'zh-CN', client: 'extension' };
  const record = (event) => service.record({ ...base, ...event });

  // Turn U1: stepIndex 1 recorded BEFORE stepIndex 0 (ordering must be by stepIndex).
  await record({ at: 1_000, turnId: 'tr_u1', stepIndex: 1, mode: 'bilingual', outputPreview: 'second step', segments: 2, chars: 20, inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 0, latencyMs: 100 });
  await record({ at: 900, turnId: 'tr_u1', stepIndex: 0, mode: 'bilingual', outputPreview: 'first step', segments: 1, chars: 9, inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 2, latencyMs: 50 });
  // Legacy single-event turn (no turnId).
  await record({ at: 2_000, kind: 'lookup', segments: 1, chars: 5, inputTokens: 3, outputTokens: 1, latencyMs: 30 });
  // Explicit failure turn (errors only -> status error).
  await record({ at: 3_000, ok: false, errorCode: 'MODEL_RATE_LIMITED', turnId: 'tr_fail', stepIndex: 0, latencyMs: 20 });
  // Partial turn: one ok + one error.
  await record({ at: 4_000, turnId: 'tr_partial', stepIndex: 0, inputTokens: 1, outputTokens: 1, latencyMs: 10 });
  await record({ at: 4_100, ok: false, errorCode: 'INTERNAL', turnId: 'tr_partial', stepIndex: 1, latencyMs: 10 });
  // Mixed kind turn: translate + lookup under one turnId.
  await record({ at: 5_000, turnId: 'tr_mixed', stepIndex: 0, inputTokens: 2, outputTokens: 2, latencyMs: 40 });
  await record({ at: 5_100, kind: 'lookup', turnId: 'tr_mixed', stepIndex: 1, inputTokens: 4, outputTokens: 1, latencyMs: 60 });
  // Truncation: over-long turnId/mode/outputPreview must be clipped, not rejected.
  await record({ at: 6_000, turnId: 'T'.repeat(100), stepIndex: 7, mode: 'M'.repeat(30), outputPreview: 'P'.repeat(300), latencyMs: 11 });

  let page = null;
  try {
    page = await service.turns({ limit: 50 });
  } catch (error) {
    check('service.turns() resolves', false, String(error && error.message));
    return;
  }
  check(
    'turns() page shape {turns, nextBefore, hasMore}',
    page !== null && Array.isArray(page.turns) && Object.hasOwn(page, 'nextBefore') && typeof page.hasMore === 'boolean',
    JSON.stringify({ keys: page && Object.keys(page), turns: page?.turns?.length }),
  );
  const turns = Array.isArray(page?.turns) ? page.turns : [];
  check('turns() newest-first by startedAt', turns.every((turn, index) => index === 0 || turns[index - 1].startedAt >= turn.startedAt), turns.map((turn) => turn.id).join(','));
  check('turns() has 6 groups (5 turnIds + 1 legacy event)', turns.length === 6, turns.map((turn) => turn.id).join(','));

  const byId = (id) => turns.find((turn) => turn.id === id);
  const u1 = byId('tr_u1');
  const u1Problems = turnInvariantProblems(u1);
  check(
    'turn tr_u1: grouped 2 steps, sorted 0..1 despite insertion order',
    u1 && u1.steps.length === 2 && JSON.stringify(u1.steps.map((step) => step.stepIndex)) === '[0,1]',
    JSON.stringify(u1 && u1.steps.map((step) => ({ stepIndex: step.stepIndex, outputPreview: step.outputPreview }))),
  );
  check('turn tr_u1 satisfies turn invariants', u1Problems.length === 0, u1Problems.join('; '));
  check(
    'turn tr_u1 sums: requests=2 ok=2 errors=0 cached=0 tokens 15/6/1/2',
    u1?.requests === 2 && u1.ok === 2 && u1.errors === 0 && u1.cached === 0 && sameBuckets(u1, { inputTokens: 15, outputTokens: 6, cacheReadTokens: 1, cacheWriteTokens: 2 }, TOKEN_BUCKETS),
    JSON.stringify(u1 && pickBuckets(u1, ['requests', 'ok', 'errors', 'cached', ...TOKEN_BUCKETS])),
  );
  check('turn tr_u1 status ok, duration 100ms, avgLatency 75ms', u1?.status === 'ok' && u1?.durationMs === 100 && u1?.avgLatencyMs === 75, JSON.stringify({ status: u1?.status, durationMs: u1?.durationMs, avgLatencyMs: u1?.avgLatencyMs }));
  check('turn tr_u1 mode/provider/model/targetLanguage from steps', u1?.mode === 'bilingual' && u1?.provider === 'modelhub' && u1?.model === 'deepseek-flash' && u1?.targetLanguage === 'zh-CN', JSON.stringify({ mode: u1?.mode, provider: u1?.provider, model: u1?.model, targetLanguage: u1?.targetLanguage }));

  const legacyTurn = turns.find((turn) => typeof turn.id === 'string' && turn.id.startsWith('evt:'));
  check('legacy event (no turnId) becomes its own 1-step turn id=evt:<id>', !!legacyTurn && legacyTurn.steps.length === 1 && legacyTurn.steps[0].stepIndex === 0, JSON.stringify(legacyTurn && { id: legacyTurn.id, steps: legacyTurn.steps.length }));
  check('legacy single-step turn kind lookup, durationMs == latencyMs', legacyTurn?.kind === 'lookup' && legacyTurn?.durationMs === 30, JSON.stringify({ kind: legacyTurn?.kind, durationMs: legacyTurn?.durationMs }));

  check('failed-only turn status error', byId('tr_fail')?.status === 'error', JSON.stringify(byId('tr_fail')));
  check(
    'partial turn status partial (ok>0 && errors>0)',
    byId('tr_partial')?.status === 'partial' && byId('tr_partial')?.errors === 1 && byId('tr_partial')?.ok === 1,
    JSON.stringify(byId('tr_partial')),
  );
  check('mixed translate+lookup turn kind=mixed', byId('tr_mixed')?.kind === 'mixed' && byId('tr_mixed')?.steps.length === 2, JSON.stringify(byId('tr_mixed') && { kind: byId('tr_mixed').kind, steps: byId('tr_mixed').steps.length }));

  const clipped = turns.find((turn) => turn.steps?.some?.((step) => step.stepIndex === 7));
  check(
    'over-long turnId/mode/outputPreview are clipped (64/16/200), not dropped',
    clipped?.id?.length === 64 && clipped?.mode?.length === 16 && clipped?.steps?.[0]?.outputPreview?.length === 200,
    JSON.stringify({ idLen: clipped?.id?.length, modeLen: clipped?.mode?.length, previewLen: clipped?.steps?.[0]?.outputPreview?.length }),
  );

  /* pagination: limit + before + unknown before fallback */
  const page1 = await service.turns({ limit: 2 });
  check(
    'turns({limit:2}) pages with hasMore + nextBefore == last turn id',
    page1.turns.length === 2 && page1.hasMore === true && page1.nextBefore === page1.turns[1].id,
    JSON.stringify({ len: page1.turns?.length, hasMore: page1.hasMore, nextBefore: page1.nextBefore }),
  );
  const page2 = await service.turns({ limit: 2, before: page1.nextBefore });
  check(
    'turns({before}) returns the next older page (no overlap)',
    page2.turns.length === 2 && page2.turns.every((turn) => !page1.turns.some((entry) => entry.id === turn.id)),
    JSON.stringify(page2.turns.map((turn) => turn.id)),
  );
  const headPartial = await service.turns({ limit: 100, before: page1.nextBefore });
  check('before=last id of page 1 drops that turn', !headPartial.turns.some((turn) => turn.id === page1.turns[1].id), JSON.stringify(headPartial.turns.map((turn) => turn.id)));
  const unknown = await service.turns({ limit: 100, before: 'does-not-exist' });
  check('unknown before falls back to the newest page', unknown.turns[0]?.id === turns[0]?.id && unknown.turns.length === turns.length, JSON.stringify(unknown.turns.map((turn) => turn.id)));

  /* filters */
  const translateOnly = await service.turns({ limit: 100, kind: 'translate' });
  check(
    'turns({kind:translate}) keeps translate + mixed turns, drops pure lookup',
    translateOnly.turns.length > 0 &&
      translateOnly.turns.every((turn) => turn.kind === 'translate' || turn.kind === 'mixed') &&
      !translateOnly.turns.some((turn) => turn.kind === 'lookup'),
    JSON.stringify(translateOnly.turns.map((turn) => ({ id: turn.id, kind: turn.kind }))),
  );
  const lookupOnly = await service.turns({ limit: 100, kind: 'lookup' });
  check(
    'turns({kind:lookup}) keeps lookup + mixed turns, drops pure translate',
    lookupOnly.turns.length > 0 &&
      lookupOnly.turns.every((turn) => turn.kind === 'lookup' || turn.kind === 'mixed') &&
      !lookupOnly.turns.some((turn) => turn.kind === 'translate'),
    JSON.stringify(lookupOnly.turns.map((turn) => ({ id: turn.id, kind: turn.kind }))),
  );
  const errorOnly = await service.turns({ limit: 100, kind: 'error' });
  check(
    'turns({kind:error}) returns only non-ok turns',
    errorOnly.turns.length > 0 && errorOnly.turns.every((turn) => turn.status !== 'ok'),
    JSON.stringify(errorOnly.turns.map((turn) => ({ id: turn.id, status: turn.status }))),
  );
  const partialOnly = await service.turns({ limit: 100, status: 'partial' });
  check('turns({status:partial}) filters by status', partialOnly.turns.length === 1 && partialOnly.turns[0].id === 'tr_partial', JSON.stringify(partialOnly.turns.map((turn) => turn.id)));

  const clampedZero = await service.turns({ limit: 0 });
  check('turns({limit:0}) clamps to 1', clampedZero.turns.length === 1, String(clampedZero.turns?.length));
  const clampedLarge = await service.turns({ limit: 100_000 });
  check('turns({limit:100000}) clamps to <= 100 without error', Array.isArray(clampedLarge.turns) && clampedLarge.turns.length <= 100, String(clampedLarge.turns?.length));
}

/* ------------------------------------------------------------------ */
/* 4. Host in-process HTTP contract (temp dataDir + fake LLM)          */
/* ------------------------------------------------------------------ */

async function checkHostIntegration() {
  section('host HTTP contract (/usage/turns + turn metadata)');
  let createApi;
  let createHttpHandler;
  try {
    const routes = await import(pathToFileURL(join(ROOT, 'lib/routes.js')).href);
    createApi = routes.createApi;
    createHttpHandler = routes.createHttpHandler;
  } catch (error) {
    check('lib/routes.js importable', false, String(error && error.message));
    return;
  }
  if (!check('lib/routes.js exports createApi/createHttpHandler', typeof createApi === 'function' && typeof createHttpHandler === 'function')) return;

  const llm = createFakeLlm();
  const logger = createFakeLogger();
  const tempDirs = [];
  const newTempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-turns-'));
    tempDirs.push(dir);
    return dir;
  };
  const boot = async (dataDir) => {
    const api = createApi({
      ctx: createFakeCtx(llm, logger),
      dataDir,
      logger,
      now: Date.now,
      fetchImpl: async () => {
        throw new Error('qa: off-network dictionary lookup');
      },
    });
    return { api, handler: createHttpHandler(api) };
  };
  const callOn = async (handler, method, path, body) => {
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

  try {
    const dataDir = await newTempDir();
    const { api, handler } = await boot(dataDir);
    const call = (method, path, body) => callOn(handler, method, path, body);

    /* ---- empty page ---- */
    const empty = await call('GET', '/usage/turns');
    check(
      'GET /usage/turns 200 {ok:true, turns:[], nextBefore:null, hasMore:false}',
      empty.status === 200 && empty.json?.ok === true && Array.isArray(empty.json.turns) && empty.json.turns.length === 0 && empty.json.hasMore === false && empty.json.nextBefore === null,
      `status=${empty.status} body=${empty.raw.slice(0, 250)}`,
    );

    /* ---- build 4 turns: A (3 translate steps, one failure), B (lookup), C (mixed), D (legacy event) ---- */
    const postTranslate = async (body) => call('POST', '/translate', body);
    const postLookup = async (body) => call('POST', '/lookup', body);

    // Turn A: steps recorded OUT OF ORDER (1, 0, then a failing step 2).
    queueTranslateSuccess(llm, ['译一'], { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const aStep1 = await postTranslate({
      texts: ['A one'], targetLanguage: 'zh-CN', sourceUrl: 'https://example.com/turn-a', sourceTitle: 'Turn A', client: 'extension',
      turnId: 'tr_qa_a', stepIndex: 1, mode: 'bilingual',
    });
    check('POST /translate accepts turnId/stepIndex/mode (step 1)', aStep1.status === 200 && aStep1.json?.ok === true, `status=${aStep1.status} body=${aStep1.raw.slice(0, 200)}`);

    queueTranslateSuccess(llm, ['译二'], { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2 });
    const aStep0 = await postTranslate({
      texts: ['A two'], targetLanguage: 'zh-CN', sourceUrl: 'https://example.com/turn-a', sourceTitle: 'Turn A', client: 'extension',
      turnId: 'tr_qa_a', stepIndex: 0, mode: 'bilingual',
    });
    check('POST /translate accepts turnId/stepIndex/mode (step 0)', aStep0.status === 200 && aStep0.json?.ok === true, `status=${aStep0.status}`);

    queueTranslateFailure(llm, 'RATE_LIMIT');
    const aStep2 = await postTranslate({
      texts: ['A three'], targetLanguage: 'zh-CN', sourceUrl: 'https://example.com/turn-a', sourceTitle: 'Turn A', client: 'extension',
      turnId: 'tr_qa_a', stepIndex: 2, mode: 'bilingual',
    });
    check(
      'failing step still recorded with turnId (HTTP error mapped, host 4xx/5xx)',
      aStep2.status >= 400 && aStep2.json?.ok === false && aStep2.json?.error?.code === 'MODEL_RATE_LIMITED',
      `status=${aStep2.status} body=${aStep2.raw.slice(0, 200)}`,
    );

    // Turn B: lookup, one step.
    llm.pushStream(() => textStream('查词译文', { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    const bLookup = await postLookup({ text: 'hello', context: 'hello world', targetLanguage: 'zh-CN', sourceUrl: 'https://example.com/turn-b', client: 'extension', turnId: 'lk_qa_b', stepIndex: 0 });
    check('POST /lookup accepts turnId/stepIndex', bLookup.status === 200 && bLookup.json?.ok === true, `status=${bLookup.status} body=${bLookup.raw.slice(0, 200)}`);

    // Turn C: mixed (translate + lookup under one turnId).
    queueTranslateSuccess(llm, ['混合甲'], { inputTokens: 60, outputTokens: 12, cacheReadTokens: 1, cacheWriteTokens: 0 });
    const cTranslate = await postTranslate({ texts: ['C mixed'], targetLanguage: 'zh-CN', sourceUrl: 'https://example.com/turn-c', client: 'extension', turnId: 'tr_qa_mixed', stepIndex: 0, mode: 'only' });
    check('mixed turn translate step accepted', cTranslate.status === 200 && cTranslate.json?.ok === true, `status=${cTranslate.status}`);
    llm.pushStream(() => textStream('混合乙', { inputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    const cLookup = await postLookup({ text: 'mixed', context: 'mixed turn', targetLanguage: 'zh-CN', sourceUrl: 'https://example.com/turn-c', client: 'extension', turnId: 'tr_qa_mixed', stepIndex: 1 });
    check('mixed turn lookup step accepted', cLookup.status === 200 && cLookup.json?.ok === true, `status=${cLookup.status}`);

    // Turn D: legacy event without turnId.
    queueTranslateSuccess(llm, ['旧事件'], { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const legacy = await postTranslate({ texts: ['legacy text'], targetLanguage: 'zh-CN', client: 'qa' });
    check('legacy /translate without turnId still works', legacy.status === 200 && legacy.json?.ok === true, `status=${legacy.status}`);

    /* ---- /usage/turns page ---- */
    const pageResponse = await call('GET', '/usage/turns?limit=50');
    const page = pageResponse.json;
    check(
      'GET /usage/turns?limit=50 200 {ok:true, turns, nextBefore, hasMore}',
      pageResponse.status === 200 && page?.ok === true && Array.isArray(page.turns) && typeof page.hasMore === 'boolean' && Object.hasOwn(page, 'nextBefore'),
      `status=${pageResponse.status} body=${pageResponse.raw.slice(0, 300)}`,
    );
    const turns = Array.isArray(page?.turns) ? page.turns : [];
    check('turns page holds the 4 created turns', turns.length === 4, `len=${turns.length} ids=${turns.map((turn) => turn.id).join(',')}`);
    check(
      'turns are newest-first by startedAt',
      turns.every((turn, index) => index === 0 || turns[index - 1].startedAt >= turn.startedAt),
      turns.map((turn) => ({ id: turn.id, startedAt: turn.startedAt })).map((entry) => `${entry.id}@${entry.startedAt}`).join(','),
    );

    const turnA = turns.find((turn) => turn.id === 'tr_qa_a');
    const turnAProblems = turnInvariantProblems(turnA);
    check('turn tr_qa_a satisfies all Turn invariants', !!turnA && turnAProblems.length === 0, turnAProblems.join('; '));
    check(
      'turn tr_qa_a: 3 steps in stepIndex order 0,1,2 despite insertion order',
      turnA && JSON.stringify(turnA.steps.map((step) => step.stepIndex)) === '[0,1,2]',
      JSON.stringify(turnA && turnA.steps.map((step) => step.stepIndex)),
    );
    check(
      'turn tr_qa_a: requests=3 ok=2 errors=1 cached=0 status=partial',
      turnA?.requests === 3 && turnA?.ok === 2 && turnA?.errors === 1 && turnA?.cached === 0 && turnA?.status === 'partial',
      JSON.stringify(turnA && pickBuckets(turnA, ['requests', 'ok', 'errors', 'cached', 'status'])),
    );
    check(
      'turn tr_qa_a: token sums 140/28/5/2 and segments/chars summed',
      sameBuckets(turnA, { inputTokens: 140, outputTokens: 28, cacheReadTokens: 5, cacheWriteTokens: 2 }, TOKEN_BUCKETS) &&
        turnA?.segments === 3 &&
        turnA?.chars === 'A one'.length + 'A two'.length + 'A three'.length,
      JSON.stringify({ tokens: turnA && pickBuckets(turnA, TOKEN_BUCKETS), segments: turnA?.segments, chars: turnA?.chars }),
    );
    check(
      'turn tr_qa_a metadata (kind/mode/client/site/sourceUrl/sourceTitle/targetLanguage)',
      turnA?.kind === 'translate' && turnA?.mode === 'bilingual' && turnA?.client === 'extension' && turnA?.site === 'example.com' &&
        turnA?.sourceUrl === 'https://example.com/turn-a' && turnA?.sourceTitle === 'Turn A' && turnA?.targetLanguage === 'zh-CN',
      JSON.stringify(turnA && { kind: turnA.kind, mode: turnA.mode, client: turnA.client, site: turnA.site, sourceUrl: turnA.sourceUrl, sourceTitle: turnA.sourceTitle, targetLanguage: turnA.targetLanguage }),
    );
    check(
      'failed step carries ok=false + errorCode, success steps ok=true',
      turnA?.steps?.map((step) => step.ok).join(',') === 'true,true,false' && turnA?.steps?.[2]?.errorCode === 'MODEL_RATE_LIMITED',
      JSON.stringify(turnA && turnA.steps.map((step) => ({ stepIndex: step.stepIndex, ok: step.ok, errorCode: step.errorCode }))),
    );
    check(
      'success steps record outputPreview (first translated segment)',
      turnA?.steps?.[0]?.outputPreview === '译二' && turnA?.steps?.[1]?.outputPreview === '译一',
      JSON.stringify(turnA && turnA.steps.map((step) => step.outputPreview)),
    );
    check(
      'turn tr_qa_a duration/avgLatency derived from steps',
      turnA && Number.isFinite(turnA.durationMs) && turnA.durationMs >= 0 && turnA.durationMs === turnA.endedAt - turnA.startedAt &&
        turnA.avgLatencyMs === Math.round(turnA.steps.reduce((total, step) => total + step.latencyMs, 0) / turnA.steps.length),
      JSON.stringify(turnA && { startedAt: turnA.startedAt, endedAt: turnA.endedAt, durationMs: turnA.durationMs, avgLatencyMs: turnA.avgLatencyMs }),
    );

    const turnB = turns.find((turn) => turn.id === 'lk_qa_b');
    check(
      'lookup turn lk_qa_b: kind lookup, 1 step, ok status, 10/3 tokens, outputPreview set',
      turnB?.kind === 'lookup' && turnB?.steps?.length === 1 && turnB?.status === 'ok' &&
        sameBuckets(turnB, { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }, TOKEN_BUCKETS) &&
        typeof turnB?.steps?.[0]?.outputPreview === 'string' && turnB.steps[0].outputPreview.length > 0,
      JSON.stringify(turnB && { kind: turnB.kind, steps: turnB.steps.length, status: turnB.status, tokens: pickBuckets(turnB, TOKEN_BUCKETS), preview: turnB.steps[0]?.outputPreview }),
    );

    const turnMixed = turns.find((turn) => turn.id === 'tr_qa_mixed');
    check(
      'mixed turn tr_qa_mixed: kind=mixed, 2 steps, status ok',
      turnMixed?.kind === 'mixed' && turnMixed?.steps?.length === 2 && turnMixed?.status === 'ok',
      JSON.stringify(turnMixed && { kind: turnMixed.kind, steps: turnMixed.steps.length, status: turnMixed.status, stepKinds: turnMixed.steps.map((step) => step.kind) }),
    );

    const turnLegacy = turns.find((turn) => typeof turn.id === 'string' && turn.id.startsWith('evt:'));
    check(
      'legacy turn id=evt:<eventId>, kind translate, 1 step, ok',
      !!turnLegacy && turnLegacy.kind === 'translate' && turnLegacy.steps?.length === 1 && turnLegacy.status === 'ok' &&
        sameBuckets(turnLegacy, { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, TOKEN_BUCKETS),
      JSON.stringify(turnLegacy && { id: turnLegacy.id, kind: turnLegacy.kind, steps: turnLegacy.steps.length, tokens: pickBuckets(turnLegacy, TOKEN_BUCKETS) }),
    );

    /* ---- cross-checks vs /usage + /usage/events ---- */
    const usage = (await call('GET', '/usage?days=14')).json?.usage;
    check(
      '/usage summary totals unchanged in shape (8 numeric buckets + days/byModel/byKind/recent)',
      numericBuckets(usage?.totals) && Array.isArray(usage?.days) && usage.days.length === 14 && Array.isArray(usage?.byModel) && usage?.byKind && Array.isArray(usage?.recent),
      JSON.stringify({ totals: usage?.totals, days: usage?.days?.length }),
    );
    const turnSums = sumBuckets(turns.map((turn) => ({ ...turn })), BUCKETS.map((key) => key).filter((key) => BUCKETS.includes(key)));
    // requests/ok/errors/cached come from turn-level counters, tokens too.
    const aggregate = { requests: 0, ok: 0, errors: 0, cached: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const turn of turns) for (const key of BUCKETS) aggregate[key] += Number.isFinite(turn?.[key]) ? turn[key] : 0;
    void turnSums;
    check(
      'sum(turn counters) == /usage summary totals (requests/ok/errors/tokens)',
      sameBuckets(aggregate, usage?.totals),
      JSON.stringify({ aggregate, totals: usage && pickBuckets(usage.totals) }),
    );
    check('7 recorded requests visible in /usage totals', usage?.totals?.requests === 7 && usage?.totals?.errors === 1, JSON.stringify(usage?.totals));
    check('turns totals == sum of their own steps (per turn invariants)', turns.every((turn) => turnInvariantProblems(turn).length === 0), turns.map((turn) => `${turn.id}:${turnInvariantProblems(turn).join('|')}`).join('; '));

    const eventsResponse = await call('GET', '/usage/events?limit=50');
    const events = eventsResponse.json?.events ?? [];
    check('/usage/events kept working (7 events, newest-first)', eventsResponse.status === 200 && events.length === 7 && events.every((event, index) => index === 0 || events[index - 1].at >= event.at), `len=${events.length}`);
    const eventA0 = events.find((event) => event.turnId === 'tr_qa_a' && event.stepIndex === 0);
    check(
      '/usage/events exposes the new turn fields (turnId/stepIndex/mode/outputPreview)',
      !!eventA0 && eventA0.mode === 'bilingual' && typeof eventA0.outputPreview === 'string' && eventA0.outputPreview === '译二',
      JSON.stringify(eventA0 && { turnId: eventA0.turnId, stepIndex: eventA0.stepIndex, mode: eventA0.mode, outputPreview: eventA0.outputPreview }),
    );

    /* ---- filters over HTTP ---- */
    const translateTurns = (await call('GET', '/usage/turns?limit=100&kind=translate')).json?.turns ?? [];
    check(
      'GET /usage/turns?kind=translate keeps translate + mixed turns (drops pure lookup)',
      translateTurns.length > 0 && translateTurns.every((turn) => turn.kind === 'translate' || turn.kind === 'mixed') && !translateTurns.some((turn) => turn.id === 'lk_qa_b'),
      JSON.stringify(translateTurns.map((turn) => ({ id: turn.id, kind: turn.kind }))),
    );
    const lookupTurns = (await call('GET', '/usage/turns?limit=100&kind=lookup')).json?.turns ?? [];
    check(
      'GET /usage/turns?kind=lookup keeps lookup + mixed turns (drops pure translate)',
      lookupTurns.length > 0 && lookupTurns.every((turn) => turn.kind === 'lookup' || turn.kind === 'mixed') && !lookupTurns.some((turn) => turn.id === 'tr_qa_a'),
      JSON.stringify(lookupTurns.map((turn) => ({ id: turn.id, kind: turn.kind }))),
    );
    const errorTurns = (await call('GET', '/usage/turns?limit=100&kind=error')).json?.turns ?? [];
    check('GET /usage/turns?kind=error returns non-ok turns only', errorTurns.length > 0 && errorTurns.every((turn) => turn.status !== 'ok') && errorTurns.some((turn) => turn.id === 'tr_qa_a'), JSON.stringify(errorTurns.map((turn) => ({ id: turn.id, status: turn.status }))));
    const okTurns = (await call('GET', '/usage/turns?limit=100&status=ok')).json?.turns ?? [];
    check('GET /usage/turns?status=ok filters status', okTurns.length > 0 && okTurns.every((turn) => turn.status === 'ok'), JSON.stringify(okTurns.map((turn) => turn.id)));
    const partialTurns = (await call('GET', '/usage/turns?limit=100&status=partial')).json?.turns ?? [];
    check('GET /usage/turns?status=partial returns the partial turn', partialTurns.length === 1 && partialTurns[0].id === 'tr_qa_a', JSON.stringify(partialTurns.map((turn) => turn.id)));

    /* ---- pagination over HTTP ---- */
    const page1 = (await call('GET', '/usage/turns?limit=2')).json;
    check(
      'GET /usage/turns?limit=2 pages newest-first with hasMore/nextBefore',
      page1?.turns?.length === 2 && page1.hasMore === true && page1.nextBefore === page1.turns[1].id,
      JSON.stringify({ ids: page1?.turns?.map((turn) => turn.id), hasMore: page1?.hasMore, nextBefore: page1?.nextBefore }),
    );
    const page2 = (await call('GET', `/usage/turns?limit=2&before=${encodeURIComponent(page1?.nextBefore ?? '')}`)).json;
    check(
      'GET /usage/turns?before= returns the next older page (no overlap)',
      page2?.turns?.length === 2 && page2.turns.every((turn) => !page1.turns.some((entry) => entry.id === turn.id)),
      JSON.stringify(page2?.turns?.map((turn) => turn.id)),
    );
    const unknownBefore = (await call('GET', '/usage/turns?limit=100&before=does-not-exist')).json;
    check('GET /usage/turns?before=<unknown> falls back to the newest page', unknownBefore?.turns?.[0]?.id === turns[0]?.id, JSON.stringify(unknownBefore?.turns?.map((turn) => turn.id)));
    const limitZero = (await call('GET', '/usage/turns?limit=0')).json;
    check('GET /usage/turns?limit=0 clamps to 1', limitZero?.turns?.length === 1, String(limitZero?.turns?.length));
    const limitMax = await call('GET', '/usage/turns?limit=100000');
    check('GET /usage/turns?limit=100000 clamps without error', limitMax.status === 200 && Array.isArray(limitMax.json?.turns) && limitMax.json.turns.length <= 100, `status=${limitMax.status} len=${limitMax.json?.turns?.length}`);

    /* ---- persistence ---- */
    const usageFile = join(dataDir, 'usage.json');
    check('usage ledger persisted as dataDir/usage.json', existsSync(usageFile), usageFile);
    if (existsSync(usageFile)) {
      let ledger = null;
      try {
        ledger = JSON.parse(readFileSync(usageFile, 'utf8'));
      } catch (error) {
        check('usage.json is valid JSON', false, String(error && error.message));
      }
      const persistedTurnA = Array.isArray(ledger?.events)
        ? ledger.events.find((event) => event.turnId === 'tr_qa_a' && event.stepIndex === 0)
        : undefined;
      check(
        'persisted events keep turnId/stepIndex/mode/outputPreview',
        !!persistedTurnA && Number.isInteger(persistedTurnA.stepIndex) && typeof persistedTurnA.mode === 'string' && typeof persistedTurnA.outputPreview === 'string' && persistedTurnA.outputPreview === '译二',
        JSON.stringify(persistedTurnA && { turnId: persistedTurnA.turnId, stepIndex: persistedTurnA.stepIndex, mode: persistedTurnA.mode, outputPreview: persistedTurnA.outputPreview }),
      );
    }

    /* ---- invalid turn metadata -> 400 BAD_REQUEST (isolated boot) ---- */
    const validationDir = await newTempDir();
    const validation = await boot(validationDir);
    const vcall = (method, path, body) => callOn(validation.handler, method, path, body);
    const longTurnId = 't'.repeat(64);
    queueTranslateSuccess(llm, ['边界一'], { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const boundaryOk = await vcall('POST', '/translate', { texts: ['boundary one'], turnId: longTurnId, stepIndex: 0, mode: 'm'.repeat(16) });
    check('POST /translate accepts boundary metadata (turnId 64 / stepIndex 0 / mode 16)', boundaryOk.status === 200 && boundaryOk.json?.ok === true, `status=${boundaryOk.status} body=${boundaryOk.raw.slice(0, 200)}`);
    queueTranslateSuccess(llm, ['边界二'], { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const boundaryMax = await vcall('POST', '/translate', { texts: ['boundary two'], turnId: 'b'.repeat(64), stepIndex: 10000, mode: 'x' });
    check('POST /translate accepts stepIndex 10000 boundary', boundaryMax.status === 200 && boundaryMax.json?.ok === true, `status=${boundaryMax.status} body=${boundaryMax.raw.slice(0, 200)}`);
    const boundaryPage = (await vcall('GET', '/usage/turns?limit=10')).json;
    check(
      'turns() handles turnId 64 + stepIndex 10000 boundary events',
      boundaryPage?.turns?.length === 2 && boundaryPage.turns.some((turn) => turn.steps?.some?.((step) => step.stepIndex === 10000)),
      JSON.stringify(boundaryPage?.turns?.map((turn) => ({ id: turn.id, ids: turn.steps?.map((step) => step.stepIndex) }))),
    );

    // §2.1/§2.3: trim turnId/mode + cap outputPreview at LIMITS.outputPreviewChars.
    queueTranslateSuccess(llm, ['x'.repeat(300)], { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const trimmed = await vcall('POST', '/translate', { texts: ['trim test'], turnId: '  tr_trim_qa  ', stepIndex: 0, mode: '  bilingual  ' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const trimEvents = (await vcall('GET', '/usage/events?limit=20')).json?.events ?? [];
    const trimEvent = trimEvents.find((event) => event.turnId === 'tr_trim_qa');
    check('turnId/mode are trimmed before recording', trimmed.status === 200 && trimEvent?.turnId === 'tr_trim_qa' && trimEvent?.mode === 'bilingual', JSON.stringify(trimEvent && { turnId: trimEvent.turnId, mode: trimEvent.mode }));
    check(
      'success event outputPreview is truncated to 200 chars',
      trimEvent?.outputPreview?.length === 200 && trimEvent.outputPreview === 'x'.repeat(200),
      JSON.stringify({ len: trimEvent?.outputPreview?.length }),
    );

    const invalidCases = [
      ['turnId longer than 64 chars', { texts: ['bad turn'], turnId: 'x'.repeat(65) }],
      ['turnId not a string', { texts: ['bad turn'], turnId: 123 }],
      ['stepIndex negative', { texts: ['bad step'], stepIndex: -1 }],
      ['stepIndex above 10000', { texts: ['bad step'], stepIndex: 10001 }],
      ['stepIndex non-integer', { texts: ['bad step'], stepIndex: 1.5 }],
      ['stepIndex not a number', { texts: ['bad step'], stepIndex: 'zero' }],
      ['mode longer than 16 chars', { texts: ['bad mode'], mode: 'm'.repeat(17) }],
      ['mode not a string', { texts: ['bad mode'], mode: 7 }],
    ];
    for (const [label, body] of invalidCases) {
      const response = await vcall('POST', '/translate', body);
      check(
        `invalid ${label} rejected with 400 BAD_REQUEST`,
        response.status === 400 && response.json?.ok === false && response.json?.error?.code === 'BAD_REQUEST',
        `status=${response.status} body=${response.raw.slice(0, 200)}`,
      );
    }
    const lookupInvalid = await vcall('POST', '/lookup', { text: 'hello', turnId: 'x'.repeat(65), stepIndex: 0 });
    check('invalid lookup turnId rejected with 400 BAD_REQUEST', lookupInvalid.status === 400 && lookupInvalid.json?.error?.code === 'BAD_REQUEST', `status=${lookupInvalid.status} body=${lookupInvalid.raw.slice(0, 200)}`);

    /* ---- legacy ledger (old events without turn fields) ---- */
    const legacyDir = await newTempDir();
    const legacyLedger = {
      version: 1,
      updatedAt: 3_500,
      totals: { requests: 5, ok: 4, errors: 1, cached: 0, inputTokens: 22, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, latencySum: 265, latencyCount: 5 },
      days: {},
      models: {},
      kinds: {},
      events: [
        { id: 'evt_old_1', at: 1_000, kind: 'translate', ok: true, provider: 'modelhub', model: 'deepseek-flash', segments: 1, chars: 5, cached: false, retries: 0, inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 120 },
        { id: 'evt_old_2', at: 2_000, kind: 'lookup', ok: true, provider: 'modelhub', model: 'deepseek-flash', segments: 1, chars: 5, cached: false, retries: 0, inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 80 },
        { id: 'evt_old_3', at: 3_000, kind: 'translate', ok: true, provider: 'modelhub', model: 'deepseek-flash', segments: 1, chars: 6, cached: false, retries: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 33, turnId: 'L'.repeat(100), stepIndex: 2, mode: 'M'.repeat(20), outputPreview: 'P'.repeat(300) },
        { id: 'evt_old_4', at: 2_500, kind: 'translate', ok: true, provider: 'modelhub', model: 'deepseek-flash', segments: 2, chars: 12, cached: false, retries: 0, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 22, turnId: 'L'.repeat(100), stepIndex: 0 },
        { id: 'evt_old_5', at: 500, kind: 'translate', ok: false, errorCode: 'INTERNAL', provider: 'modelhub', model: 'deepseek-flash', segments: 1, chars: 4, cached: false, retries: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 10 },
      ],
    };
    await writeFile(join(legacyDir, 'usage.json'), JSON.stringify(legacyLedger));
    const legacyBoot = await boot(legacyDir);
    const legacyPage = (await callOn(legacyBoot.handler, 'GET', '/usage/turns?limit=50')).json;
    const legacyTurns = Array.isArray(legacyPage?.turns) ? legacyPage.turns : [];
    check('legacy ledger without turn fields still yields /usage/turns (no crash)', legacyPage?.ok === true && legacyTurns.length === 4, JSON.stringify(legacyTurns.map((turn) => turn.id)));
    check(
      'each legacy event becomes a 1-step turn (id=evt:<id>)',
      legacyTurns.filter((turn) => String(turn.id).startsWith('evt:')).length === 3 &&
        legacyTurns.filter((turn) => String(turn.id).startsWith('evt:')).every((turn) => turn.steps.length === 1),
      JSON.stringify(legacyTurns.map((turn) => ({ id: turn.id, steps: turn.steps?.length }))),
    );
    const groupedLegacy = legacyTurns.find((turn) => turn.id === 'L'.repeat(64));
    check(
      'legacy same-turnId events grouped + truncated turnId (64) / mode (16) / outputPreview (200)',
      !!groupedLegacy && groupedLegacy.steps.length === 2 && JSON.stringify(groupedLegacy.steps.map((step) => step.stepIndex)) === '[0,2]' &&
        groupedLegacy.mode === 'M'.repeat(16) && groupedLegacy.steps[1]?.outputPreview?.length === 200 &&
        groupedLegacy.steps[0]?.stepIndex === 0,
      JSON.stringify(groupedLegacy && { idLen: groupedLegacy.id.length, modeLen: groupedLegacy.mode?.length, steps: groupedLegacy.steps.map((step) => step.stepIndex), previewLen: groupedLegacy.steps[1]?.outputPreview?.length }),
    );
    check('failed legacy event turn status=error', legacyTurns.find((turn) => turn.id === 'evt:evt_old_5')?.status === 'error', JSON.stringify(legacyTurns.find((turn) => turn.id === 'evt:evt_old_5')));
    const legacyUsage = (await callOn(legacyBoot.handler, 'GET', '/usage')).json?.usage;
    check('legacy summary still readable after turns feature (5 requests)', legacyUsage?.totals?.requests === 5, JSON.stringify(legacyUsage?.totals));
  } catch (error) {
    check('host HTTP integration suite completed without crashing', false, String(error && error.stack ? error.stack : error));
  } finally {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. DSH client 轨迹 tab contract (client.js, static)                 */
/* ------------------------------------------------------------------ */

function checkClientStatic() {
  section('client.js 轨迹 tab contract (conversation list + legacy Turn cards)');
  if (!exists('client.js')) {
    check('client.js exists', false);
    return;
  }
  const source = readText('client.js');
  const occurrences = (pattern) => (source.match(pattern) ?? []).length;
  const literalCount = (literal) => (source.split(literal).length - 1);

  check('client.js fetches GET /usage/turns', /['"]usage\/turns['"]/.test(source), source.match(/['"]usage\/turns['"][^\n]*/)?.[0] ?? 'not found');
  check(
    'client.js load-more uses before=<last turn id>',
    /before\s*:/.test(source) && /nextBefore/.test(source) && /trace\.loadMore/.test(source),
    `before= occurrences: ${occurrences(/before\s*:/g)}`,
  );
  check(
    'client.js keeps /usage/events fallback for old hosts',
    /['"]usage\/events['"]/.test(source) && /404/.test(source),
    `usage/events occurrences: ${occurrences(/['"]usage\/events['"]/g)}`,
  );
  check('client.js shows legacy-host notice trace.legacy', /trace\.legacy/.test(source));
  check('client.js keeps kind/status filters for turns', /['"]translate['"]/.test(source) && /['"]lookup['"]/.test(source) && /['"]error['"]/.test(source) && /status/.test(source));
  check('client.js keeps 5s usage polling + visibilityState', /5000/.test(source) && /visibilityState/.test(source));
  check('client.js keeps DELETE /usage clear action', /request\(\s*['"]usage['"]\s*,\s*\{\s*method:\s*['"]DELETE['"]/.test(source));

  const traceKeys = [
    'trace.turnLabel',
    'trace.steps',
    'trace.stepLabel',
    'trace.loadMore',
    'trace.loadingMore',
    'trace.legacy',
    'trace.inputSample',
    'trace.outputSample',
    'trace.step.tokens',
  ];
  const missing = traceKeys.filter((key) => literalCount(key) < 2);
  check(
    'client.js turn/steps i18n keys exist in BOTH dictionaries (zh+en)',
    missing.length === 0,
    missing.map((key) => `${key} x${literalCount(key)}`).join(', '),
  );
  const prefixKeys = ['trace.mode.', 'trace.status.', 'trace.turnMeta.'];
  const missingPrefixes = prefixKeys.filter((key) => literalCount(key) < 2);
  check('client.js mode/status/turnMeta i18n prefixes in BOTH dictionaries', missingPrefixes.length === 0, missingPrefixes.map((key) => `${key} x${literalCount(key)}`).join(', '));

  check('client.js turn CSS classes added (.dsh-it-turn / .dsh-it-step)', /dsh-it-turn/.test(source) && /dsh-it-step/.test(source));
  check('client.js keeps --dsw-alias-* theme tokens', /--dsw-alias-/.test(source));
  check(
    'client.js Turn header a11y: button/role=button + aria-expanded',
    /aria-expanded/.test(source) && (/role:\s*['"]button['"]/.test(source) || /h\(\s*'button'/.test(source)),
  );
  check(
    'client.js renders step input/output samples (sample + outputPreview)',
    /outputPreview/.test(source) && /\bsample\b/.test(source) && /trace\.inputSample/.test(source) && /trace\.outputSample/.test(source),
  );
  check(
    'client.js newest conversation expanded by default (v4 trace list)',
    /newestConversationRef|expandedConversations/.test(source),
    'conversation expand-state heuristic',
  );

  // v4 (DESIGN-CONVERSATIONS §3): the 轨迹 tab is now a conversation list; the
  // inline Turn cards live on inside the collapsed legacy group.
  check('client.js groups turns into conversation cards (.dsh-it-conv*)', /dsh-it-conv/.test(source) && /sessionId/.test(source));
  const openConversationIndex = source.indexOf('function openConversation(');
  check(
    'client.js conversation cards call openConversation(sessionId) via uiWorkspace.openSession',
    openConversationIndex >= 0 && /openSession\(sessionId\)/.test(source.slice(openConversationIndex, openConversationIndex + 700)),
  );
  check(
    'client.js legacy group for turns without sessionId (旧版请求（无 DSH 会话）)',
    /dsh-it-conv-legacy/.test(source) && /trace\.conversation\.legacyTitle/.test(source),
  );
  check(
    'legacy inline Turn cards (.dsh-it-turn) remain reachable inside the legacy group',
    /dsh-it-turn/.test(source) && /renderLegacyGroup|legacyGroupExpanded/.test(source),
  );
  check('client.js load-more still wired for conversations', /trace\.loadMore/.test(source) && /nextBefore/.test(source));
  check('client.js keeps overview/设置/单词本 tabs (no regression)', /概览/.test(source) && /设置/.test(source) && /单词本/.test(source) && /Overview/.test(source) && /Settings/.test(source));
}

/* ------------------------------------------------------------------ */
/* 6. Chrome extension tagging contract                                */
/* ------------------------------------------------------------------ */

function checkExtensionStatic() {
  section('Chrome extension Turn tagging contract');
  let manifest = null;
  try {
    manifest = JSON.parse(readText('manifest.json', EXT));
    check('extension manifest.json parses', true);
  } catch (error) {
    check('extension manifest.json parses', false, String(error && error.message));
  }
  const extVersionAtLeast = (value, major, minor) => {
    const parts = String(value ?? '0.0.0').split('.').map((part) => Number(part) || 0);
    return parts[0] > major || (parts[0] === major && parts[1] >= minor);
  };
  check('manifest.version >= 1.7.0 (turn-tagging increment)', extVersionAtLeast(manifest?.version, 1, 7), String(manifest?.version));
  const contentSource = exists('content.js', EXT) ? readText('content.js', EXT) : '';
  const e2eSource = exists('tools/e2e-chrome.mjs', EXT) ? readText('tools/e2e-chrome.mjs', EXT) : '';
  const verifySource = exists('tools/verify.mjs', EXT) ? readText('tools/verify.mjs', EXT) : '';
  const readmeSource = exists('README.md', EXT) ? readText('README.md', EXT) : '';

  const contentVersion = contentSource.match(/EXT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  check('content.js EXT_VERSION >= 1.7.0 (turn-tagging increment)', extVersionAtLeast(contentVersion, 1, 7), contentVersion ?? 'not found');
  check('content.js has makeTurnId(prefix)', /function\s+makeTurnId\s*\(/.test(contentSource), 'makeTurnId');
  check("content.js run ids use makeTurnId('tr') / makeTurnId('lk')", /makeTurnId\(\s*['"]tr['"]\s*\)/.test(contentSource) && /makeTurnId\(\s*['"]lk['"]\s*\)/.test(contentSource));
  check(
    'content.js state declares runId/runStep/cardTurnId',
    /runId\s*:/.test(contentSource) && /runStep\s*:/.test(contentSource) && /cardTurnId\s*:/.test(contentSource),
    JSON.stringify({ runId: /runId/.test(contentSource), runStep: /runStep/.test(contentSource), cardTurnId: /cardTurnId/.test(contentSource) }),
  );
  check(
    'content.js translate payload sends turnId/stepIndex/mode',
    /turnId\s*:\s*state\.runId/.test(contentSource) && /stepIndex\s*:\s*state\.runStep\s*\+\+/.test(contentSource) && /mode\s*:\s*state\.mode/.test(contentSource),
    JSON.stringify({
      turnId: /turnId\s*:\s*state\.runId/.test(contentSource),
      stepIndex: /stepIndex\s*:\s*state\.runStep\s*\+\+/.test(contentSource),
      mode: /mode\s*:\s*state\.mode/.test(contentSource),
    }),
  );
  check(
    'content.js lookup payload sends turnId + stepIndex 0',
    /turnId\s*:\s*state\.cardTurnId/.test(contentSource) && /stepIndex\s*:\s*0/.test(contentSource),
    'lookup payload',
  );
  check('content.js clears runId when a run ends', /state\.runId\s*=\s*['"]{2}/.test(contentSource) || /runId\s*=\s*['"]{2}/.test(contentSource), contentSource.match(/runId\s*=\s*['"]{2}/)?.[0] ?? 'not found');
  check('content.js keeps extension metadata (client/sourceUrl/sourceTitle)', /client:\s*['"]extension['"]/.test(contentSource) || /requestMeta/.test(contentSource));

  const turnAssertions = (e2eSource.match(/check\([\s\S]{0,500}?(?:turnId|stepIndex)/g) ?? []).length;
  check('e2e-chrome.mjs asserts turnId/stepIndex on requests', /turnId/.test(e2eSource) && /stepIndex/.test(e2eSource) && turnAssertions >= 2, `assertions=${turnAssertions}`);
  check('e2e-chrome.mjs captures request bodies incl. turn metadata', /requestBodies|requests\.push|body\.turnId|json\(\)/.test(e2eSource), 'body capture heuristic');
  check('extension README documents 轨迹 (Turn) behavior', /轨迹/.test(readmeSource) && /Turn/.test(readmeSource));
  check('tools/verify.mjs updated for extension version/turn wiring', /1\.7\.0|turnId|makeTurnId/.test(verifySource), 'verify.mjs heuristic');
}

/* ------------------------------------------------------------------ */
/* 7. Optional full suites (host tests + extension verify/e2e)         */
/* ------------------------------------------------------------------ */

function runSuite(name, command, args, cwd, timeoutMs) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env } });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const summaryLine =
    output
      .split('\n')
      .filter((line) => /(?:^# (?:pass|fail|tests|suites|skipped)|PASS:|FAIL:|^[0-9]+ (?:passing|failing)|All\s|问题|\bproblems?\b)/i.test(line))
      .slice(-5)
      .join(' | ')
      .slice(0, 500) || output.split('\n').slice(-3).join(' | ').slice(0, 500);
  const ok = result.status === 0;
  check(`${name} exits 0`, ok, result.error ? `${result.error.message} :: ${summaryLine}` : summaryLine);
  return { ok, output, summaryLine };
}

function checkFullSuites() {
  section('full suites (--full)');
  console.log('# running host node --test test/ ...');
  runSuite('host unit tests (node --test test/)', process.execPath, ['--test', 'test/'], ROOT, 300_000);
  console.log('# running extension tools/verify.mjs ...');
  runSuite('extension tools/verify.mjs', process.execPath, ['tools/verify.mjs'], EXT, 120_000);
  console.log('# running extension tools/e2e-chrome.mjs (headless Chrome, may take ~1-2 min) ...');
  runSuite('extension tools/e2e-chrome.mjs', process.execPath, ['tools/e2e-chrome.mjs'], EXT, 420_000);
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`# qa verify-turn-trace @ ${new Date().toISOString()}`);
  console.log(`# root: ${ROOT}`);
  let gitStatus = '';
  let gitDiffStat = '';
  try {
    const status = spawnSync('git', ['-C', WORKTREE, 'status', '--short'], { encoding: 'utf8' });
    gitStatus = (status.stdout || '').trim();
    const diff = spawnSync('git', ['-C', WORKTREE, 'diff', '--stat'], { encoding: 'utf8' });
    gitDiffStat = (diff.stdout || '').trim();
  } catch {
    /* git optional */
  }

  checkSyntax();
  await checkHostStatic();
  await checkUsageServiceTurns();
  await checkHostIntegration();
  checkClientStatic();
  checkExtensionStatic();
  if (FULL) checkFullSuites();

  const failed = results.filter((entry) => !entry.ok);
  const passed = results.length - failed.length;
  const durationMs = Date.now() - startedAt;
  console.log(`\n# ${passed}/${results.length} checks passed, ${failed.length} failed in ${durationMs}ms`);
  if (failed.length > 0) {
    console.log('\nFAILURES:');
    for (const entry of failed) console.log(`- [${entry.section}] ${entry.name}${entry.detail ? ` :: ${entry.detail.replace(/\s+/g, ' ').slice(0, 320)}` : ''}`);
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    durationMs,
    full: FULL,
    passed: failed.length === 0,
    total: results.length,
    failed: failed.length,
    sections: [...new Set(results.map((entry) => entry.section))],
    checks: results,
    gitStatus,
    gitDiffStat,
  };
  try {
    writeFileSync(join(QA_DIR, 'verify-turn-trace.result.json'), JSON.stringify(artifact, null, 2));
  } catch (error) {
    console.error(`# WARN: could not write result artifact: ${String(error && error.message)}`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`verify-turn-trace crashed: ${error && error.stack ? error.stack : String(error)}`);
    process.exitCode = 2;
  });
