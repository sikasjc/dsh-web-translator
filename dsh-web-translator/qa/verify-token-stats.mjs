#!/usr/bin/env node
/**
 * Independent QA harness for the "token usage / traces / sidebar panel" v3
 * increment (DESIGN-TOKEN-USAGE.md §2–§5).
 *
 * Independent means: it imports the plugin's public host entry point
 * (`lib/routes.js`) but never its tests/helpers, and it boots a real in-process
 * HTTP handler against a temp `$DSH_HOME`-style data dir with a fake LLM, then
 * drives the contract: usage ledger semantics, capture on success/cache/error,
 * metadata validation, /usage + /usage/events + DELETE routes, summary
 * invariants, pagination/filtering, and v2 regressions.
 *
 * Usage:
 *   node qa/verify-token-stats.mjs            # static + in-process contract checks
 *   node qa/verify-token-stats.mjs --full     # also run node --test test/,
 *                                             # extension tools/verify.mjs and
 *                                             # tools/e2e-chrome.mjs
 *   node qa/verify-token-stats.mjs --quiet    # only failures + summary
 *
 * Exit code: 0 = all checks pass, 1 = failures, 2 = harness crashed.
 * QA-only script: source files are read-only; writes only under qa/.
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
    detail: detail === undefined ? '' : String(detail).slice(0, 800),
  };
  results.push(entry);
  if (!entry.ok || !QUIET) {
    const suffix = entry.detail.length > 0 ? `  [${entry.detail.replace(/\s+/g, ' ').slice(0, 400)}]` : '';
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
  }
  return entry.ok;
}

const readText = (relative, base = ROOT) => readFileSync(join(base, relative), 'utf8');
const exists = (relative, base = ROOT) => existsSync(join(base, relative));

function nodeCheck(absolutePath) {
  const result = spawnSync(process.execPath, ['--check', absolutePath], { encoding: 'utf8' });
  return { ok: result.status === 0, error: (result.stderr || result.stdout || '').trim().slice(0, 400) };
}

function nodeCheckFile(relative, base = ROOT) {
  const absolute = join(base, relative);
  if (!existsSync(absolute)) return check(`node --check ${relative}`, false, 'file does not exist');
  const result = nodeCheck(absolute);
  return check(`node --check ${relative}`, result.ok, result.ok ? '' : result.error);
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

const BUCKETS = [
  'requests',
  'ok',
  'errors',
  'cached',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
];
const TOKEN_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const MODEL_BUCKETS = ['requests', ...TOKEN_BUCKETS];

function pickBuckets(object, keys = BUCKETS) {
  const out = {};
  for (const key of keys) out[key] = object?.[key];
  return out;
}

function numericBuckets(object, keys = BUCKETS) {
  return object !== null && typeof object === 'object' && keys.every((key) => Number.isFinite(object[key]));
}

function zeroBuckets(object, keys = BUCKETS) {
  return numericBuckets(object, keys) && keys.every((key) => object[key] === 0);
}

function sameBuckets(left, right, keys = BUCKETS) {
  return JSON.stringify(pickBuckets(left, keys)) === JSON.stringify(pickBuckets(right, keys));
}

function sumBuckets(list, keys = BUCKETS) {
  const out = {};
  for (const key of keys) out[key] = 0;
  for (const entry of Array.isArray(list) ? list : []) {
    for (const key of keys) out[key] += Number.isFinite(entry?.[key]) ? entry[key] : 0;
  }
  return out;
}

function localToday(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Text stream shaped like the DSH llm stream: usage -> text-delta -> finish stop. */
async function* textStream(text, usage) {
  if (usage !== undefined) yield { type: 'usage', usage };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** Queue a successful model stream with a JSON translate payload. */
function queueTranslateSuccess(llm, translations, usage) {
  llm.pushStream(() => textStream(JSON.stringify({ translations }), usage));
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
  for (const file of ['index.js', 'client.js', 'package.json']) {
    if (file.endsWith('.json')) {
      const absolute = join(ROOT, file);
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(absolute, 'utf8'));
      } catch (error) {
        check(`${file} parses as JSON`, false, String(error && error.message));
        continue;
      }
      check(`${file} parses as JSON`, parsed !== null);
      continue;
    }
    nodeCheckFile(file);
  }
  // Also check the QA scripts themselves stay executable.
  for (const file of ['qa/verify-token-stats.mjs', 'qa/panel-shot.mjs', 'qa/cdp.mjs']) nodeCheckFile(file);

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
  section('host static contract');

  check('lib/usage.js exists', exists('lib/usage.js'));
  try {
    const usageModule = await import(pathToFileURL(join(ROOT, 'lib/usage.js')).href);
    check('lib/usage.js exports createUsageService', typeof usageModule.createUsageService === 'function');
  } catch (error) {
    check('lib/usage.js exports createUsageService', false, String(error && error.message));
  }

  try {
    const constants = await import(pathToFileURL(join(ROOT, 'lib/constants.js')).href);
    check('constants.USAGE_VERSION === 1', constants.USAGE_VERSION === 1, String(constants.USAGE_VERSION));
    const limits = constants.LIMITS ?? {};
    check('constants.LIMITS.usageEvents === 500', limits.usageEvents === 500, String(limits.usageEvents));
    check('constants.LIMITS.usageDays === 90', limits.usageDays === 90, String(limits.usageDays));
    check('constants.LIMITS.sourceTitleChars === 200', limits.sourceTitleChars === 200, String(limits.sourceTitleChars));
    check('constants.LIMITS.clientChars === 32', limits.clientChars === 32, String(limits.clientChars));
    check('constants.LIMITS.eventSampleChars === 80', limits.eventSampleChars === 80, String(limits.eventSampleChars));
  } catch (error) {
    check('constants module importable', false, String(error && error.message));
  }

  // collectStream must preserve all four usage buckets (§2.3.1).
  try {
    const llm = await import(pathToFileURL(join(ROOT, 'lib/llm.js')).href);
    const fourFieldUsage = { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 };
    const collected = await llm.collectStream(
      (async function* () {
        yield { type: 'usage', usage: fourFieldUsage };
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    );
    check(
      'llm.collectStream preserves all 4 usage buckets',
      collected.usage && TOKEN_BUCKETS.every((key) => collected.usage[key] === fourFieldUsage[key]),
      JSON.stringify(collected.usage),
    );
    const fakeLlm = { stream: () => textStream('hi', fourFieldUsage) };
    const called = await llm.callModel({ llm: fakeLlm, options: { provider: 'modelhub', model: 'deepseek-flash' } });
    check(
      'llm.callModel returns all 4 usage buckets',
      called.usage && TOKEN_BUCKETS.every((key) => called.usage[key] === fourFieldUsage[key]),
      JSON.stringify(called.usage),
    );
  } catch (error) {
    check('llm.collectStream preserves all 4 usage buckets', false, String(error && error.message));
  }

  const httpSource = exists('lib/http.js') ? readText('lib/http.js') : '';
  check(
    "http.js ROUTES has '/usage' GET+DELETE",
    /['"]\/usage['"]\s*:\s*[^,\n]*\[[^\]]*['"]GET['"][^\]]*['"]DELETE['"]/.test(httpSource),
    httpSource.match(/['"]\/usage['"][^\n]*/)?.[0] ?? 'route entry not found',
  );
  check(
    "http.js ROUTES has '/usage/events' GET",
    /['"]\/usage\/events['"]\s*:\s*[^,\n]*\[[^\]]*['"]GET['"]/.test(httpSource),
    httpSource.match(/['"]\/usage\/events['"][^\n]*/)?.[0] ?? 'route entry not found',
  );
  check('http.js dispatchGet wires /usage', /case\s+['"]\/usage['"]\s*:/.test(httpSource));
  check('http.js dispatchGet wires /usage/events', /case\s+['"]\/usage\/events['"]\s*:/.test(httpSource));
  check('http.js dispatchWrite wires DELETE /usage', /case\s+['"]\/usage['"]\s*:/.test(httpSource) && /clearUsage|clearUsageLedger|clear\w*Usage/i.test(httpSource));

  const apiSource = exists('lib/api.js') ? readText('lib/api.js') : '';
  check('lib/api.js imports/creates the usage service', /createUsageService/.test(apiSource));
  check('lib/api.js records failures (ok:false/errorCode)', /errorCode/.test(apiSource) && /ok\s*:\s*false/.test(apiSource));
  check('lib/api.js records translate+lookup usage', /record/.test(apiSource) && /translate/i.test(apiSource) && /lookup/i.test(apiSource));

  const translateSource = exists('lib/translate.js') ? readText('lib/translate.js') : '';
  check('lib/translate.js aggregates 4-field usage', TOKEN_BUCKETS.every((key) => new RegExp(key).test(translateSource)));
  check('lib/translate.js returns cached/retries', /cached/.test(translateSource) && /retries/.test(translateSource));

  const indexSource = exists('index.js') ? readText('index.js') : '';
  check('index.js still mounts /dsh-immersive/api prefix (unchanged wiring)', /path:\s*['"]\/dsh-immersive\/api['"]/.test(indexSource));

  const designSource = exists('DESIGN-TOKEN-USAGE.md') ? readText('DESIGN-TOKEN-USAGE.md') : '';
  check('DESIGN-TOKEN-USAGE.md contract file present', designSource.length > 5000);
}

/* ------------------------------------------------------------------ */
/* 3. Host in-process integration contract                             */
/* ------------------------------------------------------------------ */

async function checkHostIntegration() {
  section('host in-process integration (temp dataDir + fake LLM)');
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
  if (!check('lib/routes.js exports createApi/createHttpHandler', typeof createApi === 'function' && typeof createHttpHandler === 'function')) {
    return;
  }

  const llm = createFakeLlm();
  const logger = createFakeLogger();
  const tempDirs = [];
  const newTempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-usage-'));
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
    const { handler } = await boot(dataDir);
    check('createApi boots with temp dataDir', true, dataDir);
    const call = (method, path, body) => callOn(handler, method, path, body);

    /* ---- baseline empty ledger ---- */
    const usageFile = join(dataDir, 'usage.json');
    const baselineResponse = await call('GET', '/usage');
    const baseline = baselineResponse.json?.usage;
    check(
      'GET /usage returns 200 {ok:true, usage}',
      baselineResponse.status === 200 && baselineResponse.json?.ok === true && baseline && typeof baseline === 'object',
      `status=${baselineResponse.status} body=${baselineResponse.raw.slice(0, 200)}`,
    );
    check('usage.version === 1', baseline?.version === 1, String(baseline?.version));
    check('usage.totals starts as 8 zero buckets', zeroBuckets(baseline?.totals), JSON.stringify(baseline?.totals));
    check('usage.today starts as a zero day bucket', zeroBuckets(baseline?.today), JSON.stringify(baseline?.today));
    const todayStr = localToday();
    const baselineDays = baseline?.days;
    check(
      'usage.days: 14 continuous ascending days ending today',
      Array.isArray(baselineDays) &&
        baselineDays.length === 14 &&
        baselineDays.every((day) => numericBuckets(day) && zeroBuckets(day)) &&
        baselineDays[13]?.date === todayStr &&
        baselineDays.every((day, index) => index === 0 || baselineDays[index - 1].date < day.date),
      `len=${baselineDays?.length} last=${baselineDays?.[baselineDays.length - 1]?.date} today=${todayStr}`,
    );
    check(
      'usage.byModel/byKind/recent empty on fresh ledger',
      Array.isArray(baseline?.byModel) &&
        baseline.byModel.length === 0 &&
        baseline?.byKind &&
        typeof baseline.byKind === 'object' &&
        Array.isArray(baseline?.recent) &&
        baseline.recent.length === 0,
      JSON.stringify({ byModel: baseline?.byModel, byKind: baseline?.byKind, recent: baseline?.recent }),
    );
    const eventsBaseline = await call('GET', '/usage/events');
    check(
      'GET /usage/events empty page shape',
      eventsBaseline.status === 200 &&
        eventsBaseline.json?.ok === true &&
        Array.isArray(eventsBaseline.json.events) &&
        eventsBaseline.json.events.length === 0 &&
        eventsBaseline.json.hasMore === false &&
        eventsBaseline.json.nextBefore === null,
      JSON.stringify(eventsBaseline.json),
    );

    /* ---- v2 regressions ---- */
    const health = await call('GET', '/health');
    check(
      'v2 regression: GET /health still works',
      health.status === 200 && health.json?.ok === true && typeof health.json.version === 'string',
      `status=${health.status}`,
    );
    const settings = await call('GET', '/settings');
    check(
      'v2 regression: GET /settings still works',
      settings.status === 200 && settings.json?.ok === true && settings.json.settings && settings.json.selected?.provider === 'modelhub' && settings.json.selected?.model === 'deepseek-flash',
      `status=${settings.status} body=${settings.raw.slice(0, 200)}`,
    );

    /* ---- success translate with metadata ---- */
    const successUsage = { inputTokens: 120, outputTokens: 45, cacheReadTokens: 30, cacheWriteTokens: 7 };
    queueTranslateSuccess(llm, ['你好，世界'], successUsage);
    const translateBody = {
      texts: ['Hello world'],
      targetLanguage: 'zh-CN',
      sourceUrl: 'https://example.com/articles/1?x=1',
      sourceTitle: 'Example Article',
      client: 'extension',
    };
    const first = await call('POST', '/translate', translateBody);
    check(
      'POST /translate returns translations (v2 shape)',
      first.status === 200 && first.json?.ok === true && Array.isArray(first.json.translations) && first.json.translations[0] === '你好，世界',
      `status=${first.status} body=${first.raw.slice(0, 200)}`,
    );
    check(
      'translate response carries 4-field usage',
      first.json?.usage && TOKEN_BUCKETS.every((key) => first.json.usage[key] === successUsage[key]),
      JSON.stringify(first.json?.usage),
    );
    check('translate response cached=false retries=0', first.json?.cached === false && first.json?.retries === 0, JSON.stringify({ cached: first.json?.cached, retries: first.json?.retries }));
    check('translate response provider/model forwarded', first.json?.provider === 'modelhub' && first.json?.model === 'deepseek-flash', JSON.stringify({ provider: first.json?.provider, model: first.json?.model }));

    const afterFirst = (await call('GET', '/usage')).json?.usage;
    check(
      'usage.totals updated by translate',
      afterFirst?.totals?.requests === 1 &&
        afterFirst.totals.ok === 1 &&
        afterFirst.totals.errors === 0 &&
        afterFirst.totals.cached === 0 &&
        TOKEN_BUCKETS.every((key) => afterFirst.totals[key] === successUsage[key]),
      JSON.stringify(afterFirst?.totals),
    );
    check('usage.today matches totals (fresh ledger)', sameBuckets(afterFirst?.today, afterFirst?.totals), JSON.stringify({ today: afterFirst?.today }));
    check('all-time totals == sum(days) after first event', sameBuckets(sumBuckets(afterFirst?.days), afterFirst?.totals));
    const modelBucket = Array.isArray(afterFirst?.byModel)
      ? afterFirst.byModel.find((entry) => entry.provider === 'modelhub' && entry.model === 'deepseek-flash')
      : undefined;
    check(
      'usage.models aggregates provider/model route',
      modelBucket && modelBucket.provider === 'modelhub' && modelBucket.model === 'deepseek-flash' && modelBucket.requests === 1 && modelBucket.inputTokens === 120 && modelBucket.outputTokens === 45 && modelBucket.cacheReadTokens === 30 && modelBucket.cacheWriteTokens === 7 && Number.isFinite(modelBucket.lastAt),
      JSON.stringify(modelBucket),
    );
    check(
      'usage.kinds.translate aggregates',
      afterFirst?.byKind?.translate?.requests === 1 && afterFirst.byKind.translate.inputTokens === 120 && afterFirst.byKind.translate.outputTokens === 45,
      JSON.stringify(afterFirst?.byKind?.translate),
    );
    check('usage.recent holds the event', Array.isArray(afterFirst?.recent) && afterFirst.recent.length === 1 && afterFirst.recent[0].kind === 'translate', String(afterFirst?.recent?.length));

    const eventsFirst = (await call('GET', '/usage/events')).json;
    const event = eventsFirst?.events?.[0];
    check(
      'event token fields recorded',
      event && TOKEN_BUCKETS.every((key) => event[key] === successUsage[key]),
      JSON.stringify(event && pickBuckets(event, TOKEN_BUCKETS)),
    );
    check(
      'event metadata recorded (kind/client/site/sourceUrl/sourceTitle/targetLanguage)',
      event?.kind === 'translate' &&
        event?.client === 'extension' &&
        event?.site === 'example.com' &&
        event?.sourceUrl === translateBody.sourceUrl &&
        event?.sourceTitle === 'Example Article' &&
        event?.targetLanguage === 'zh-CN',
      JSON.stringify({ kind: event?.kind, client: event?.client, site: event?.site, sourceUrl: event?.sourceUrl, sourceTitle: event?.sourceTitle, targetLanguage: event?.targetLanguage }),
    );
    check(
      'event request shape recorded (segments/chars/sample)',
      event?.segments === 1 && event?.chars === 'Hello world'.length && typeof event?.sample === 'string',
      JSON.stringify({ segments: event?.segments, chars: event?.chars, sample: event?.sample }),
    );
    check(
      'event identity/latency/shape',
      typeof event?.id === 'string' &&
        event.id.startsWith('evt_') &&
        Number.isFinite(event?.at) &&
        event?.provider === 'modelhub' &&
        event?.model === 'deepseek-flash' &&
        Number.isFinite(event?.latencyMs) &&
        event.latencyMs >= 0 &&
        event?.cached === false &&
        event?.retries === 0,
      JSON.stringify({ id: event?.id, at: event?.at, latencyMs: event?.latencyMs, cached: event?.cached, retries: event?.retries }),
    );

    /* ---- cached request ---- */
    const callsBeforeCache = llm.state.calls.length;
    const second = await call('POST', '/translate', translateBody);
    check(
      'cached translate returns cached=true with no model call',
      second.status === 200 && second.json?.cached === true && llm.state.calls.length === callsBeforeCache,
      `status=${second.status} cached=${second.json?.cached} calls=${llm.state.calls.length}`,
    );
    const afterCached = (await call('GET', '/usage')).json?.usage;
    check(
      'cached request counts as requests+cached but records 0 tokens',
      afterCached?.totals?.requests === 2 &&
        afterCached.totals.cached === 1 &&
        afterCached.totals.ok === 2 &&
        afterCached.totals.inputTokens === 120 &&
        afterCached.totals.outputTokens === 45,
      JSON.stringify(afterCached?.totals),
    );
    const cachedEvent = (await call('GET', '/usage/events')).json?.events?.[0];
    check(
      'cached event cached=true and all tokens 0',
      cachedEvent?.cached === true && zeroBuckets(cachedEvent, TOKEN_BUCKETS),
      JSON.stringify({ cached: cachedEvent?.cached, tokens: pickBuckets(cachedEvent, TOKEN_BUCKETS) }),
    );

    /* ---- failure request ---- */
    llm.pushStream(() => {
      const error = new Error('qa fake rate limit');
      error.code = 'RATE_LIMIT';
      throw error;
    });
    const failed = await call('POST', '/translate', { texts: ['A different sentence for failure.'] });
    check(
      'failed translate returns error envelope with mapped code',
      failed.status >= 400 && failed.json?.ok === false && failed.json?.error?.code === 'MODEL_RATE_LIMITED',
      `status=${failed.status} body=${failed.raw.slice(0, 200)}`,
    );
    const afterFailed = (await call('GET', '/usage')).json?.usage;
    check(
      'failed request counted in requests+errors, tokens unchanged',
      afterFailed?.totals?.requests === 3 &&
        afterFailed.totals.errors === 1 &&
        afterFailed.totals.ok === 2 &&
        afterFailed.totals.inputTokens === 120 &&
        afterFailed.totals.outputTokens === 45,
      JSON.stringify(afterFailed?.totals),
    );
    const afterFailedEvents = (await call('GET', '/usage/events')).json?.events ?? [];
    check(
      'failed event ok=false with errorCode and 0 tokens',
      afterFailedEvents[0]?.ok === false &&
        afterFailedEvents[0]?.errorCode === 'MODEL_RATE_LIMITED' &&
        afterFailedEvents[0]?.kind === 'translate' &&
        zeroBuckets(afterFailedEvents[0], TOKEN_BUCKETS),
      JSON.stringify({ ok: afterFailedEvents[0]?.ok, errorCode: afterFailedEvents[0]?.errorCode, tokens: pickBuckets(afterFailedEvents[0], TOKEN_BUCKETS) }),
    );
    check(
      'events are newest-first',
      afterFailedEvents.length >= 2 && afterFailedEvents[0].at >= afterFailedEvents[1].at && afterFailedEvents[0].id !== afterFailedEvents[1].id,
      afterFailedEvents.map((entry) => entry?.at).join(','),
    );

    /* ---- metadata validation failure ---- */
    const invalid = await call('POST', '/translate', { texts: ['x'], sourceUrl: 'ftp://example.com/file' });
    check(
      'invalid sourceUrl rejected with INVALID_URL_OR_TEXT',
      invalid.status === 400 && invalid.json?.ok === false && invalid.json?.error?.code === 'INVALID_URL_OR_TEXT',
      `status=${invalid.status} body=${invalid.raw.slice(0, 200)}`,
    );
    const afterInvalid = (await call('GET', '/usage')).json?.usage;
    check(
      'thrown validation error is recorded too (contract §2.3.3)',
      afterInvalid?.totals?.requests === 4 && afterInvalid.totals.errors === 2,
      JSON.stringify(afterInvalid?.totals),
    );

    /* ---- lookup ---- */
    llm.pushStream(() => textStream('你好', { inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    const lookup = await call('POST', '/lookup', { text: 'hello', context: 'hello world', sourceUrl: 'https://example.com/page', client: 'extension' });
    check(
      'POST /lookup keeps v2 result shape',
      lookup.status === 200 && lookup.json?.ok === true && lookup.json?.result?.text === 'hello' && lookup.json?.result?.translation === '你好' && lookup.json?.result?.provider === 'modelhub',
      `status=${lookup.status} body=${lookup.raw.slice(0, 250)}`,
    );
    const afterLookup = (await call('GET', '/usage')).json?.usage;
    check(
      'lookup aggregated under kinds.lookup',
      afterLookup?.totals?.requests === 5 &&
        afterLookup.totals.ok === 3 &&
        afterLookup?.byKind?.lookup?.requests === 1 &&
        afterLookup.byKind.lookup.inputTokens === 10 &&
        afterLookup.byKind.lookup.outputTokens === 3 &&
        afterLookup?.byKind?.translate?.requests === 4,
      JSON.stringify({ totals: afterLookup?.totals, lookup: afterLookup?.byKind?.lookup, translate: afterLookup?.byKind?.translate }),
    );
    const lookupEvent = (await call('GET', '/usage/events')).json?.events?.[0];
    check(
      'lookup event kind=lookup, retries=0, tokens recorded',
      lookupEvent?.kind === 'lookup' && lookupEvent?.ok === true && lookupEvent?.retries === 0 && lookupEvent?.inputTokens === 10 && lookupEvent?.outputTokens === 3,
      JSON.stringify({ kind: lookupEvent?.kind, retries: lookupEvent?.retries, inputTokens: lookupEvent?.inputTokens }),
    );

    /* ---- cross-checks / invariants ---- */
    check('totals == sum(days) for all buckets', sameBuckets(sumBuckets(afterLookup?.days), afterLookup?.totals));
    const modelSum = sumBuckets(afterLookup?.byModel ?? [], MODEL_BUCKETS);
    check(
      'totals requests/tokens == sum(models)',
      sameBuckets(modelSum, afterLookup?.totals, MODEL_BUCKETS),
      JSON.stringify({ modelSum, totals: pickBuckets(afterLookup?.totals, MODEL_BUCKETS) }),
    );
    const kindSum = sumBuckets([afterLookup?.byKind?.translate, afterLookup?.byKind?.lookup]);
    check('totals == sum(kinds) for all buckets', sameBuckets(kindSum, afterLookup?.totals), JSON.stringify({ kindSum }));
    check(
      'today count == days-today bucket requests',
      afterLookup?.days?.find?.((day) => day.date === localToday())?.requests === afterLookup?.today?.requests,
    );
    check(
      'usage.updatedAt is a recent epoch-ms',
      Number.isFinite(afterLookup?.updatedAt) && afterLookup.updatedAt >= startedAt - 60_000 && afterLookup.updatedAt <= Date.now() + 60_000,
      String(afterLookup?.updatedAt),
    );

    /* ---- events filtering + pagination ---- */
    const page1 = (await call('GET', '/usage/events?limit=2')).json;
    check(
      'events ?limit=2 honoured with hasMore/nextBefore',
      page1?.events?.length === 2 && page1.hasMore === true && typeof page1.nextBefore === 'string',
      JSON.stringify({ len: page1?.events?.length, hasMore: page1?.hasMore, nextBefore: page1?.nextBefore }),
    );
    const page2 = (await call('GET', `/usage/events?limit=2&before=${encodeURIComponent(page1?.nextBefore ?? '')}`)).json;
    check(
      'events ?before= returns the next older page',
      page2?.events?.length === 2 &&
        page2.events[0]?.id !== page1?.events?.[1]?.id &&
        page2.events.every((entry) => entry.at <= page1.events[1].at),
      JSON.stringify({ ids: page2?.events?.map((entry) => entry.id) }),
    );
    const errorEvents = (await call('GET', '/usage/events?kind=error')).json;
    check(
      "events ?kind=error returns only failures",
      errorEvents?.events?.length === 2 && errorEvents.events.every((entry) => entry.ok === false),
      JSON.stringify({ len: errorEvents?.events?.length, ok: errorEvents?.events?.map((entry) => entry.ok) }),
    );
    const translateEvents = (await call('GET', '/usage/events?kind=translate')).json;
    check(
      "events ?kind=translate filters kind",
      Array.isArray(translateEvents?.events) && translateEvents.events.length === 4 && translateEvents.events.every((entry) => entry.kind === 'translate'),
      JSON.stringify({ len: translateEvents?.events?.length }),
    );
    const lookupEvents = (await call('GET', '/usage/events?kind=lookup')).json;
    check(
      "events ?kind=lookup filters kind",
      lookupEvents?.events?.length === 1 && lookupEvents.events[0]?.kind === 'lookup',
      JSON.stringify({ len: lookupEvents?.events?.length }),
    );
    const unknownBefore = (await call('GET', '/usage/events?limit=50&before=evt_this_does_not_exist')).json;
    check(
      'events ?before=<unknown id> falls back to the newest page',
      unknownBefore?.events?.length === 5 && unknownBefore.events[0]?.id === page1.events[0]?.id,
      JSON.stringify({ len: unknownBefore?.events?.length }),
    );

    /* ---- summary days clamp / continuity ---- */
    const days7 = (await call('GET', '/usage?days=7')).json?.usage;
    check('summary ?days=7 returns 7 continuous days', days7?.days?.length === 7 && days7.days[6]?.date === localToday(), JSON.stringify(days7?.days?.map((day) => day.date)));
    const days1 = (await call('GET', '/usage?days=0')).json?.usage;
    check('summary ?days=0 clamps to 1', days1?.days?.length === 1, String(days1?.days?.length));
    const days999 = (await call('GET', '/usage?days=999')).json?.usage;
    check('summary ?days=999 clamps to 90', days999?.days?.length === 90, String(days999?.days?.length));

    /* ---- persistence ---- */
    check('usage ledger persisted as dataDir/usage.json', existsSync(usageFile), usageFile);
    if (existsSync(usageFile)) {
      let ledger = null;
      try {
        ledger = JSON.parse(readFileSync(usageFile, 'utf8'));
      } catch (error) {
        check('usage.json is valid JSON', false, String(error && error.message));
      }
      check(
        'usage.json has version/totals/days/models/kinds/events',
        ledger?.version === 1 &&
          numericBuckets(ledger?.totals) &&
          ledger?.days &&
          typeof ledger.days === 'object' &&
          ledger?.models &&
          ledger?.kinds &&
          Array.isArray(ledger?.events) &&
          ledger.events.length === 5,
        JSON.stringify({ version: ledger?.version, events: ledger?.events?.length }),
      );
    }

    /* ---- DELETE /usage ---- */
    const cleared = await call('DELETE', '/usage');
    check(
      'DELETE /usage returns {cleared:true, usage: zero summary}',
      cleared.status === 200 && cleared.json?.ok === true && cleared.json?.cleared === true && zeroBuckets(cleared.json?.usage?.totals),
      `status=${cleared.status} body=${cleared.raw.slice(0, 250)}`,
    );
    const afterClear = (await call('GET', '/usage')).json?.usage;
    const afterClearEvents = (await call('GET', '/usage/events')).json;
    check(
      'after DELETE the ledger is empty',
      zeroBuckets(afterClear?.totals) && afterClearEvents?.events?.length === 0 && afterClear?.days?.length === 14,
      JSON.stringify({ totals: afterClear?.totals, events: afterClearEvents?.events?.length }),
    );

    /* ---- corrupt ledger tolerance ---- */
    const corruptDir = await newTempDir();
    await writeFile(join(corruptDir, 'usage.json'), '{this is not valid json');
    const corruptBoot = await boot(corruptDir);
    const corrupt = await callOn(corruptBoot.handler, 'GET', '/usage');
    check(
      'corrupt usage.json degrades to an empty ledger (200)',
      corrupt.status === 200 && corrupt.json?.ok === true && zeroBuckets(corrupt.json?.usage?.totals),
      `status=${corrupt.status} body=${corrupt.raw.slice(0, 200)}`,
    );

    /* ---- ledger write failure must never fail a translation ---- */
    const unwritableBase = join(dataDir, 'blocked-as-file');
    writeFileSync(unwritableBase, 'not a directory');
    const brokenBoot = await boot(unwritableBase);
    queueTranslateSuccess(llm, ['仍应成功'], { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const resilient = await callOn(brokenBoot.handler, 'POST', '/translate', { texts: ['Still works'] });
    check(
      'ledger write failure does not fail the translation (§2.2)',
      resilient.status === 200 && resilient.json?.ok === true && resilient.json?.translations?.[0] === '仍应成功',
      `status=${resilient.status} body=${resilient.raw.slice(0, 200)}`,
    );
  } catch (error) {
    check('host integration suite completed without crashing', false, String(error && error.stack ? error.stack : error));
  } finally {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. DSH client contract (client.js)                                  */
/* ------------------------------------------------------------------ */

/** Fake React module: components are never rendered, only registered. */
function createFakeReact() {
  const base = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
  };
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property];
      if (property === 'useState') return (initial) => [initial, () => {}];
      if (property === 'useReducer') return (_reducer, initial) => [initial, () => {}];
      if (property === 'useRef') return (initial) => ({ current: initial });
      if (property === 'useMemo') return (factory) => factory();
      if (property === 'useId') return () => 'qa-use-id';
      return () => {};
    },
  });
}

/** Load client.js as a module bundle and return its factory face. */
async function loadClientModule() {
  const captured = {};
  const fakeDocument = {
    baseURI: 'http://127.0.0.1:3080/',
    visibilityState: 'visible',
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild() {} },
    createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        captured.entry = entry;
      },
    },
    document: fakeDocument,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  };
  globalThis.document = fakeDocument;
  const url = `${pathToFileURL(join(ROOT, 'client.js')).href}?qa=${Date.now()}`;
  await import(url);
  if (!captured.entry || typeof captured.entry.factory !== 'function') throw new Error('client.js did not call window.__ModuleLoader__.load({factory})');
  const moduleFace = captured.entry.factory((id) => {
    if (id === 'react') return createFakeReact();
    throw new Error(`client.js required unexpected module: ${id}`);
  });
  return { entry: captured.entry, moduleFace };
}

/** Fake client plugin ctx recording slot registrations. */
function createFakeClientCtx() {
  const registrations = [];
  const service = {
    register() {
      return () => {};
    },
    subscribe() {
      return () => {};
    },
    bind() {
      return (key) => key;
    },
    translate(key) {
      return key;
    },
  };
  const ctx = {
    registrations,
    slots: {
      inject(_name, callback) {
        return callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
      entriesOfSlot() {
        return [];
      },
      subscribe() {
        return () => {};
      },
    },
    effect() {
      return () => {};
    },
    get(name) {
      if (name === 'locale') return service;
      if (name === 'layout') return { selectPanel() {}, get activePanelId() { return undefined; } };
      return undefined;
    },
    locale: service,
  };
  return ctx;
}

async function checkClient() {
  section('DSH client contract (client.js)');

  if (!exists('client.js')) {
    check('client.js exists', false);
    return;
  }
  const source = readText('client.js');
  const count = (pattern) => (source.match(pattern) ?? []).length;

  check(
    'client.js PANEL_ID = immersive-translate',
    /PANEL_ID\s*=\s*['"]immersive-translate['"]/.test(source) || (/['"]main['"]/.test(source) && /key:\s*['"]immersive-translate['"]/.test(source)),
  );
  check('client.js registers settings.section (v2 kept)', /name:\s*['"]settings\.section['"]/.test(source));
  check('client.js registers main slot', /slots\.inject\(\s*['"]main['"]/.test(source) && /name:\s*['"]main['"]/.test(source));
  check(
    'client.js registers sidebar.panellist slot',
    /slots\.inject\(\s*['"]sidebar\.panellist['"]/.test(source) && /name:\s*['"]sidebar\.panellist['"]/.test(source) && /order:\s*2\b/.test(source),
  );
  check('client.js defines ImmersiveTranslatePage', /function\s+ImmersiveTranslatePage\s*\(/.test(source) || /const\s+ImmersiveTranslatePage\s*=/.test(source));
  check(
    'client.js reuses TranslationSettings + WordbookPage components',
    /function\s+TranslationSettings\s*\(/.test(source) &&
      /function\s+WordbookPage\s*\(/.test(source) &&
      count(/h\(\s*TranslationSettings\b/g) >= 2 &&
      count(/h\(\s*WordbookPage\b/g) >= 2,
    `TranslationSettings=${count(/h\(\s*TranslationSettings\b/g)} WordbookPage=${count(/h\(\s*WordbookPage\b/g)}`,
  );
  check(
    'client.js has the four tabs (概览/轨迹/设置/单词本 + en)',
    ['概览', '轨迹', '设置', '单词本'].every((label) => source.includes(label)) &&
      ['Overview', 'Traces', 'Settings', 'Wordbook'].every((label) => source.includes(label)),
  );
  check(
    'client.js tab a11y (tablist/tab/aria-selected/aria-controls)',
    /tablist/.test(source) && /aria-selected/.test(source) && /aria-controls/.test(source),
  );
  check(
    'client.js fetches GET /usage (days=14) and GET /usage/events',
    /request\(\s*['"]usage['"]\s*,\s*\{\s*query:\s*\{\s*days:\s*USAGE_CHART_DAYS/.test(source) &&
      /request\(\s*['"]usage\/events['"]/.test(source) &&
      /USAGE_CHART_DAYS\s*=\s*14/.test(source),
  );
  check('client.js polls usage while visible (~5s)', /5000/.test(source) && /visibilityState/.test(source));
  check(
    'client.js supports DELETE /usage clear action',
    /request\(\s*['"]usage['"]\s*,\s*\{\s*method:\s*['"]DELETE['"]/.test(source),
  );
  check('client.js has old-host compatibility notice', /Host\s*版本过旧|Host version is too old|host.*too old/i.test(source));
  check('client.js uses layout.selectPanel when available', /selectPanel\(/.test(source) && /layout/.test(source));
  const panelKeys = count(/['"]panel\./g);
  const usageKeys = count(/['"]usage\./g);
  const traceKeys = count(/['"]trace\./g);
  check(
    'client.js i18n keys panel./usage./trace. added',
    panelKeys >= 5 && usageKeys >= 5 && traceKeys >= 3,
    `panel.=${panelKeys} usage.=${usageKeys} trace.=${traceKeys}`,
  );
  check('client.js i18n key panel.title exists', /['"]panel\.title['"]/.test(source));
  check(
    'client.js overview has average-latency stat wiring',
    /usageAverageLatency/.test(source) && /usage\.stat\.avgLatency/.test(source),
  );
  check(
    'client.js supports keyboard tab switching (ArrowLeft/ArrowRight)',
    /ArrowRight/.test(source) && /ArrowLeft/.test(source) && /onKeyDown/.test(source),
  );
  check(
    'client.js 14-day chart uses role=img + aria-label + CSS bars',
    /className: 'dsh-it-bars'/.test(source) && /role: 'img'/.test(source) && /usage\.chartAria/.test(source),
  );
  check('client.js keeps dsh-it- CSS prefix and theme tokens', /dsh-it-/.test(source) && /--dsw-alias-/.test(source));

  // Dynamic module load: exercise the real factory + apply() with a fake ctx.
  try {
    const { moduleFace } = await loadClientModule();
    const ctx = createFakeClientCtx();
    check('client.js module face = { inject, apply }', moduleFace && Array.isArray(moduleFace.inject) && typeof moduleFace.apply === 'function');
    check('client.js inject includes slots', Array.isArray(moduleFace?.inject) && moduleFace.inject.includes('slots'), JSON.stringify(moduleFace?.inject));
    moduleFace.apply(ctx);
    const regs = ctx.registrations;
    const mainReg = regs.find((entry) => entry.options?.name === 'main');
    const sideReg = regs.find((entry) => entry.options?.name === 'sidebar.panellist');
    const settingsReg = regs.find((entry) => entry.options?.name === 'settings.section');
    check('dynamic: main registered with key=immersive-translate', mainReg?.options?.key === 'immersive-translate' && typeof mainReg.component === 'function', JSON.stringify(mainReg?.options));
    check(
      'dynamic: sidebar.panellist registered with id=immersive-translate, order=2',
      sideReg?.options?.id === 'immersive-translate' && sideReg?.options?.order === 2 && typeof sideReg.component === 'function',
      JSON.stringify(sideReg?.options),
    );
    check(
      'dynamic: settings.section registration kept',
      settingsReg?.options?.id === 'immersive-translate' && typeof settingsReg.component === 'function',
      JSON.stringify(settingsReg?.options),
    );
    const labelFn = mainReg?.options?.label;
    let labelValue;
    try {
      labelValue = typeof labelFn === 'function' ? labelFn() : labelFn;
    } catch (error) {
      labelValue = `threw: ${error && error.message}`;
    }
    check('dynamic: main label resolves without throwing', typeof labelValue === 'string' && labelValue.length > 0 && !String(labelValue).startsWith('threw'), String(labelValue));
  } catch (error) {
    check('dynamic: client.js factory/apply loads under fake platform', false, String(error && error.message ? error.message : error));
  }
}

/* ------------------------------------------------------------------ */
/* 5. Chrome extension contract                                        */
/* ------------------------------------------------------------------ */

function checkExtension() {
  section('Chrome extension contract');

  let manifest = null;
  try {
    manifest = JSON.parse(readText('manifest.json', EXT));
    check('extension manifest.json parses', true);
  } catch (error) {
    check('extension manifest.json parses', false, String(error && error.message));
  }
  const versionAtLeast = (value, major, minor) => {
    const parts = String(value ?? '0.0.0').split('.').map((part) => Number(part) || 0);
    return parts[0] > major || (parts[0] === major && parts[1] >= minor);
  };
  check('manifest.version >= 1.3.0 (v3 token stats, later increments allowed)', versionAtLeast(manifest?.version, 1, 3), String(manifest?.version));
  const backgroundSource = exists('background.js', EXT) ? readText('background.js', EXT) : '';
  const contentSource = exists('content.js', EXT) ? readText('content.js', EXT) : '';
  const e2eSource = exists('tools/e2e-chrome.mjs', EXT) ? readText('tools/e2e-chrome.mjs', EXT) : '';
  const readmeSource = exists('README.md', EXT) ? readText('README.md', EXT) : '';

  const contentVersion = contentSource.match(/EXT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
  check('content.js EXT_VERSION >= 1.3.0 (v3 token stats, later increments allowed)', versionAtLeast(contentVersion, 1, 3), contentVersion ?? 'not found');
  check('background.js ALLOWED_ROUTES.usage = GET', /usage\s*:\s*['"]GET['"]/.test(backgroundSource), backgroundSource.match(/usage\s*:\s*['"]GET['"]/)?.[0] ?? 'not found');
  check('background.js still only allows known routes (no wildcard)', !/ALLOWED_ROUTES\s*=\s*Object\.freeze\(\{[^}]*\*\s*:/.test(backgroundSource));

  check(
    'content.js state.tokenStats declared',
    /tokenStats\s*[:=]/.test(contentSource) && /page\s*:/.test(contentSource) && /todayFetchedAt/.test(contentSource),
  );
  const tokenKeys = ['tokensPage', 'tokensToday', 'tokensInput', 'tokensOutput', 'tokensRequests', 'tokensCache', 'statusDoneTokens', 'cardTokens'];
  const missingTokenKeys = tokenKeys.filter((key) => (contentSource.match(new RegExp(key, 'g')) ?? []).length < 2);
  check(
    'content.js i18n token keys in zh+en dictionaries',
    missingTokenKeys.length === 0,
    `missing/once: ${missingTokenKeys.join(', ')}`,
  );
  check('content.js accumulates translation usage into state', /data\.usage/.test(contentSource) && /inputTokens/.test(contentSource) && /outputTokens/.test(contentSource));
  check('content.js counts cached requests', /cached/.test(contentSource) && /tokenStats/.test(contentSource));
  check('content.js fetches today usage via RPC', /rpc\(\s*['"]usage['"]/.test(contentSource) && /today/.test(contentSource));
  check('content.js lookup card shows per-query tokens', /cardTokens/.test(contentSource) && /renderLookup/.test(contentSource));
  check('content.js done status has token summary', /statusDoneTokens/.test(contentSource) && /statusDone\b/.test(contentSource));
  const extensionClientLiterals = (contentSource.match(/client:\s*['"]extension['"]/g) ?? []).length;
  const requestMetaUses = (contentSource.match(/requestMeta\(\)/g) ?? []).length;
  check(
    'content.js sends extension metadata (client/sourceUrl/sourceTitle) on translate+lookup',
    (extensionClientLiterals >= 2 ||
      (extensionClientLiterals >= 1 && /function requestMeta\(\)/.test(contentSource) && requestMetaUses >= 2)) &&
      /sourceUrl/.test(contentSource) &&
      /sourceTitle/.test(contentSource),
    `client:'extension' x${extensionClientLiterals}, requestMeta() uses=${requestMetaUses}`,
  );
  check('content.js today-usage throttle is 60s', /USAGE_REFRESH_MS\s*=\s*60000/.test(contentSource));
  check(
    'content.js floating panel has tokens-page/tokens-today rows',
    /data-role[^\n]*tokens-page/.test(contentSource) && /data-role[^\n]*tokens-today/.test(contentSource),
  );
  check('content.js resets page usage on new run/restore/navigation', (contentSource.match(/resetPageTokenStats\(\)/g) ?? []).length >= 3, `calls=${(contentSource.match(/resetPageTokenStats\(\)/g) ?? []).length}`);
  check('content.js keeps background-only network rule (no fetch to models)', !/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(contentSource.replace(/http:\/\/\*\/\*|https:\/\/\*\/\*/g, '')));

  check('manifest host_permissions only DSH 3080', JSON.stringify(manifest?.host_permissions) === JSON.stringify(['http://127.0.0.1:3080/*', 'http://localhost:3080/*']), JSON.stringify(manifest?.host_permissions));
  check('manifest MV3 + service worker unchanged', manifest?.manifest_version === 3 && manifest?.background?.service_worker === 'background.js');

  check(
    'e2e-chrome.mjs mocks /usage route',
    /\/usage/.test(e2eSource) && /usage\s*:\s*\{/.test(e2eSource),
  );
  check(
    'e2e-chrome.mjs translate mock includes 4-field usage',
    /usage\s*:\s*\{[^}]*inputTokens[^}]*outputTokens[^}]*cacheReadTokens[^}]*cacheWriteTokens/.test(e2eSource),
  );
  const tokenAssertions = (e2eSource.match(/check\([\s\S]{0,400}?(?:token|本页消耗|今日累计|statusDoneTokens)/gi) ?? []).length;
  check('e2e-chrome.mjs has new token/usage assertions', tokenAssertions >= 3, `found ${tokenAssertions}`);
  check('e2e-chrome.mjs lookup mock includes usage', /lookup[\s\S]{0,400}usage\s*:\s*\{/.test(e2eSource));
  check('extension README documents token display section', /Token/.test(readmeSource) && /本页消耗|今日累计/.test(readmeSource));
}

/* ------------------------------------------------------------------ */
/* 6. Optional full suites (host tests + extension verify/e2e)         */
/* ------------------------------------------------------------------ */

function runSuite(name, command, args, cwd, timeoutMs) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env } });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const summaryLine =
    output
      .split('\n')
      .filter((line) => /(?:^# (?:pass|fail|tests|suites|skipped)|PASS:|FAIL:|^[0-9]+ (?:passing|failing)|问题|\bproblems?\b)/i.test(line))
      .slice(-4)
      .join(' | ')
      .slice(0, 500) || output.split('\n').slice(-3).join(' | ').slice(0, 500);
  const ok = result.status === 0;
  check(`${name} exits 0`, ok, result.error ? `${result.error.message} :: ${summaryLine}` : summaryLine);
  return { ok, output };
}

function checkFullSuites() {
  section('full suites (--full)');
  console.log('# running host node --test test/ ...');
  runSuite('host unit tests (node --test test/)', process.execPath, ['--test', 'test/'], ROOT, 240_000);
  console.log('# running extension tools/verify.mjs ...');
  runSuite('extension tools/verify.mjs', process.execPath, ['tools/verify.mjs'], EXT, 120_000);
  console.log('# running extension tools/e2e-chrome.mjs (headless Chrome, may take ~1-2 min) ...');
  runSuite('extension tools/e2e-chrome.mjs', process.execPath, ['tools/e2e-chrome.mjs'], EXT, 420_000);
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log(`# qa verify-token-stats @ ${new Date().toISOString()}`);
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

  await checkSyntax();
  await checkHostStatic();
  await checkHostIntegration();
  await checkClient();
  checkExtension();
  if (FULL) checkFullSuites();

  const failed = results.filter((entry) => !entry.ok);
  const passed = results.length - failed.length;
  const durationMs = Date.now() - startedAt;
  console.log(`\n# ${passed}/${results.length} checks passed, ${failed.length} failed in ${durationMs}ms`);
  if (failed.length > 0) {
    console.log('\nFAILURES:');
    for (const entry of failed) console.log(`- [${entry.section}] ${entry.name}${entry.detail ? ` :: ${entry.detail.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
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
    writeFileSync(join(QA_DIR, 'verify-token-stats.result.json'), JSON.stringify(artifact, null, 2));
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
    console.error(`verify harness crashed: ${error && error.stack ? error.stack : String(error)}`);
    process.exitCode = 2;
  });
