#!/usr/bin/env node
/**
 * QA phase-2 live contract check against the installed plugin.
 *
 * IMPORTANT: the live ledger may change under us (another agent's real Chrome
 * extension can translate concurrently), so this script verifies DELTAS and
 * identifies its own events by unique metadata tags instead of absolute counts.
 *
 * Validates DESIGN-TOKEN-USAGE §2/§5 on the live host:
 *   - GET /usage baseline shape + ledger invariants;
 *   - one small POST /translate and one POST /lookup: their events appear with
 *     kind/client/site/sourceUrl/sourceTitle/segments/chars/four token buckets/
 *     latency, totals grow by at least those events, cached => zero tokens;
 *   - one synthetic extension-origin translate (client=extension, unique
 *     sourceUrl/sourceTitle; expected cache hit, no extra model cost);
 *   - DESIGN-TURN-TRACE §2/§3 live checks: a synthetic 3-batch run sharing one
 *     turnId (stepIndex 0,1,2 + mode), a synthetic lookup turn, then
 *     GET /usage/turns: grouping (steps=3, ordered), token/request/sum
 *     invariants, ok/partial/error status, kind/status filters, pagination
 *     (?limit / ?before), outputPreview presence and per-turn step sums;
 *   - totals == sum(days/byModel/byKind); events newest-first; non-negative buckets;
 *   - optional `--delete-usage`: back up the live usage.json to /tmp first,
 *     DELETE /usage, verify `cleared:true`, repopulate with one translate and
 *     record the exact before/after JSON. Run this LAST (it clears events the
 *     other agent's active testing may have produced too).
 *
 * Usage: node qa/live-check.mjs [--delete-usage]
 * Env: DSH_URL / DSH_WEB_URL (default http://127.0.0.1:3080)
 *      DSH_HOME (default ~/.dsh) for the usage.json backup path
 * Writes evidence under qa/live-evidence/ + qa/live-check.result.json. Exit 0 = pass.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const QA_DIR = dirname(fileURLToPath(import.meta.url));
const API = (process.env.DSH_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '') + '/dsh-immersive/api';
const DELETE_MODE = process.argv.includes('--delete-usage');
const EVIDENCE_DIR = join(QA_DIR, 'live-evidence');
const BUCKETS = ['requests', 'ok', 'errors', 'cached', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const TOKEN_BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const RUN_TAG = Date.now().toString(36);
const results = [];
const evidence = { runTag: RUN_TAG, concurrentTrafficObserved: false };

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 900) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `  [${String(detail).replace(/\s+/g, ' ').slice(0, 400)}]`}`);
}

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw: text.slice(0, 4000) };
}

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object?.[key]]));
const sumBuckets = (list, keys = BUCKETS) => {
  const out = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const entry of list) for (const key of keys) out[key] += Number.isFinite(entry?.[key]) ? entry[key] : 0;
  return out;
};
const same = (left, right, keys = BUCKETS) => JSON.stringify(pick(left, keys)) === JSON.stringify(pick(right, keys));
const numeric = (object, keys = BUCKETS) => object !== null && typeof object === 'object' && keys.every((key) => Number.isFinite(object[key]));
const delta = (after, before, keys = BUCKETS) => Object.fromEntries(keys.map((key) => [key, (after?.[key] ?? 0) - (before?.[key] ?? 0)]));
const localToday = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

async function save(name, value) {
  evidence[name] = value;
  await writeFile(join(EVIDENCE_DIR, name), JSON.stringify(value, null, 2));
}

/** Latest events list (asks for the max page size the host allows). */
async function eventsPage(limit = 500) {
  const response = await call('GET', `/usage/events?limit=${limit}`);
  return { response, events: Array.isArray(response.json?.events) ? response.json.events : [] };
}

/**
 * Find an event produced by this QA run (unique sourceTitle tag). Returns
 * `{ event, pageIndex, total }`; retries briefly because the ledger write is
 * asynchronous to our HTTP response.
 */
async function findEvent(predicate, { attempts = 6, delayMs = 400 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { events } = await eventsPage();
    const index = events.findIndex(predicate);
    if (index !== -1) return { event: events[index], index, total: events.length };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { event: null, index: -1, total: 0 };
}

/** One page of Turns (GET /usage/turns). `turns` is [] on an old host (404). */
async function turnsPage({ limit = 100, kind, status, before } = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (kind !== undefined) params.set('kind', kind);
  if (status !== undefined) params.set('status', status);
  if (before !== undefined) params.set('before', before);
  const response = await call('GET', `/usage/turns?${params.toString()}`);
  const turns = Array.isArray(response.json?.turns) ? response.json.turns : [];
  return { response, turns };
}

/** Find one turn by id; retries briefly because ledger writes are async to us. */
async function findTurn(predicate, { attempts = 8, delayMs = 300 } = {}) {
  let lastResponse = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { response, turns } = await turnsPage({ limit: 100 });
    lastResponse = response;
    const turn = turns.find(predicate);
    if (turn !== undefined) return { turn, response, turns };
    if (response.status === 404) return { turn: null, response, turns };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { turn: null, response: lastResponse, turns: [] };
}

/** Per-Turn invariants from DESIGN-TURN-TRACE §2.2 (returns problem labels). */
function turnProblems(turn) {
  const problems = [];
  if (turn === null || typeof turn !== 'object') return ['not an object'];
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  if (steps.length === 0) return ['no steps'];
  if (turn.requests !== steps.length) problems.push('requests!=steps');
  const okCount = steps.filter((step) => step?.ok === true).length;
  if (turn.ok !== okCount) problems.push('ok!=sum(steps)');
  if (turn.errors !== steps.length - okCount) problems.push('errors!=sum(steps)');
  if (turn.cached !== steps.filter((step) => step?.cached === true).length) problems.push('cached!=sum(steps)');
  const expectedStatus = turn.errors === 0 ? 'ok' : turn.ok > 0 ? 'partial' : 'error';
  if (turn.status !== expectedStatus) problems.push('status');
  for (const key of TOKEN_BUCKETS) {
    const sum = steps.reduce((total, step) => total + (Number.isFinite(step?.[key]) ? step[key] : 0), 0);
    if (turn[key] !== sum) problems.push(`${key}!=sum(steps)`);
  }
  const indices = steps.map((step) => step?.stepIndex);
  if (!indices.every((value) => Number.isInteger(value) && value >= 0 && value <= 10000)) problems.push('stepIndex');
  for (let index = 1; index < indices.length; index += 1) if (indices[index] <= indices[index - 1]) problems.push('steps order');
  const ats = steps.map((step) => step?.at).filter((at) => Number.isFinite(at));
  if (ats.length === steps.length && (turn.startedAt !== Math.min(...ats) || turn.endedAt !== Math.max(...ats))) problems.push('startedAt/endedAt');
  const latencies = steps.map((step) => step?.latencyMs).filter((value) => Number.isFinite(value));
  if (latencies.length === steps.length) {
    const avg = Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length);
    if (turn.avgLatencyMs !== avg) problems.push('avgLatencyMs');
    if (steps.length > 1 && turn.durationMs !== turn.endedAt - turn.startedAt) problems.push('durationMs');
    if (steps.length === 1 && turn.durationMs !== steps[0].latencyMs) problems.push('durationMs(single)');
  }
  return problems;
}

async function main() {
  const startedAt = Date.now();
  await mkdir(EVIDENCE_DIR, { recursive: true });
  console.log(`# live-check ${new Date().toISOString()} runTag=${RUN_TAG} -> ${API}`);

  /* ---- 0. plugin alive? ---- */
  let health = null;
  try {
    health = await call('GET', '/health');
  } catch (error) {
    console.error(`# cannot reach ${API}: ${error && error.message}`);
    process.exitCode = 2;
    return;
  }
  await save('health.json', health.json || { raw: health.raw });
  check('GET /health reachable on the new host', health.status === 200 && health.json?.ok === true, `status=${health.status} version=${health.json?.version}`);
  check('installed plugin version >= 1.1.0 (token-stats host)', typeof health.json?.version === 'string' && Number(health.json.version.split('.')[1] ?? 0) >= 1, String(health.json?.version));
  const versionParts = String(health.json?.version ?? '0.0.0').split('.').map((part) => Number(part) || 0);
  check(
    'installed plugin version >= 1.4.0 (Turn trace host)',
    versionParts[0] > 1 || (versionParts[0] === 1 && versionParts[1] >= 4),
    String(health.json?.version),
  );

  /* ---- 1. baseline ledger + invariants ---- */
  const before = await call('GET', '/usage?days=14');
  await save('usage-before.json', before.json || { status: before.status, raw: before.raw });
  if (before.status === 404) {
    check('GET /usage exists (new host installed)', false, 'HTTP 404: the installed plugin is the OLD version (no usage API)');
    await writeFile(join(QA_DIR, 'live-check.result.json'), JSON.stringify({ generatedAt: new Date().toISOString(), api: API, passed: false, checks: results }, null, 2));
    process.exitCode = 1;
    return;
  }
  check('GET /usage 200 with summary', before.status === 200 && before.json?.ok === true && before.json?.usage && typeof before.json.usage === 'object', `status=${before.status} body=${before.raw.slice(0, 200)}`);
  const usageBefore = before.json?.usage;
  check('baseline totals has 8 numeric buckets', numeric(usageBefore?.totals), JSON.stringify(usageBefore?.totals));
  check('baseline days[] is 14 continuous days ending today', Array.isArray(usageBefore?.days) && usageBefore.days.length === 14 && usageBefore.days[13]?.date === localToday(), `${usageBefore?.days?.length} last=${usageBefore?.days?.[13]?.date}`);
  check('baseline totals == sum(days)', same(sumBuckets(usageBefore?.days ?? []), usageBefore?.totals));
  check('baseline summary has byModel / byKind / recent', Array.isArray(usageBefore?.byModel) && usageBefore?.byKind && typeof usageBefore.byKind === 'object' && Array.isArray(usageBefore?.recent), JSON.stringify({ byModel: usageBefore?.byModel?.length, recent: usageBefore?.recent?.length }));
  check('baseline includes real extension-origin events (client=extension)', (usageBefore?.recent ?? []).some((entry) => entry.client === 'extension'), JSON.stringify((usageBefore?.recent ?? []).slice(0, 3).map((entry) => ({ client: entry.client, site: entry.site, kind: entry.kind }))));

  /* ---- 2. one small live translate (unique tags) ---- */
  const translateBody = {
    texts: ['Hello world'],
    targetLanguage: 'zh-CN',
    sourceUrl: `https://example.com/qa-live-${RUN_TAG}`,
    sourceTitle: `QA live check ${RUN_TAG}`,
    client: 'qa',
  };
  const translate = await call('POST', '/translate', translateBody);
  await save('translate-response.json', translate.json || { status: translate.status, raw: translate.raw });
  check(
    'POST /translate 200 with translations + 4-field usage',
    translate.status === 200 && translate.json?.ok === true && Array.isArray(translate.json.translations) && translate.json.translations.length === 1 && numeric(translate.json.usage, TOKEN_BUCKETS),
    `status=${translate.status} body=${translate.raw.slice(0, 250)}`,
  );
  const translateUsage = translate.json?.usage ?? {};
  check(
    'translate tokens non-negative and cached flag boolean',
    TOKEN_BUCKETS.every((key) => Number.isFinite(translateUsage[key]) && translateUsage[key] >= 0) && typeof translate.json?.cached === 'boolean',
    JSON.stringify({ usage: translateUsage, cached: translate.json?.cached }),
  );

  const afterTranslate = await call('GET', '/usage?days=14');
  await save('usage-after-translate.json', afterTranslate.json || { status: afterTranslate.status, raw: afterTranslate.raw });
  const usageAfterTranslate = afterTranslate.json?.usage;
  const translateDelta = delta(usageAfterTranslate?.totals, usageBefore?.totals);
  check('translate grew totals.requests by >= 1', translateDelta.requests >= 1, JSON.stringify(translateDelta));
  check('translate counted as ok (delta)', translateDelta.ok >= 1 && translateDelta.errors === 0, JSON.stringify(translateDelta));
  if (translateDelta.requests > 1) {
    evidence.concurrentTrafficObserved = true;
    console.log(`# note: ${translateDelta.requests} requests landed in the translate window (concurrent extension traffic); using tagged-event checks`);
  }
  const translateEvent = await findEvent((entry) => {
    if (!entry || entry.kind !== 'translate') return false;
    if (translateBody.sourceTitle !== undefined) return entry.sourceTitle === translateBody.sourceTitle;
    return entry.sourceUrl === translateBody.sourceUrl;
  });
  const translateEventOk = translateEvent.event !== null;
  await save('translate-event.json', translateEvent.event ?? { missing: true });
  check('translate event recorded and findable (unique sourceTitle)', translateEventOk, JSON.stringify(translateEvent.event && pick(translateEvent.event, ['id', 'at', 'kind', 'ok', 'client', 'site', 'sourceUrl', 'sourceTitle'])));
  check(
    'translate event metadata (client/site/sourceUrl/sourceTitle/targetLanguage)',
    translateEventOk &&
      translateEvent.event.client === 'qa' &&
      translateEvent.event.site === 'example.com' &&
      translateEvent.event.sourceUrl === translateBody.sourceUrl &&
      translateEvent.event.sourceTitle === translateBody.sourceTitle &&
      translateEvent.event.targetLanguage === 'zh-CN',
    JSON.stringify(translateEvent.event && pick(translateEvent.event, ['client', 'site', 'sourceUrl', 'sourceTitle', 'targetLanguage'])),
  );
  check(
    'translate event request shape (segments/chars/sample/provider/model/latency)',
    translateEventOk &&
      translateEvent.event.segments === 1 &&
      translateEvent.event.chars === 'Hello world'.length &&
      typeof translateEvent.event.sample === 'string' &&
      typeof translateEvent.event.provider === 'string' &&
      translateEvent.event.provider.length > 0 &&
      typeof translateEvent.event.model === 'string' &&
      translateEvent.event.model.length > 0 &&
      Number.isFinite(translateEvent.event.latencyMs) &&
      translateEvent.event.latencyMs >= 0,
    JSON.stringify(translateEvent.event && pick(translateEvent.event, ['segments', 'chars', 'sample', 'provider', 'model', 'latencyMs'])),
  );
  if (translateEventOk && translate.json?.cached === true) {
    check('cached translate event records zero tokens (§2.3)', translateEvent.event.cached === true && TOKEN_BUCKETS.every((key) => translateEvent.event[key] === 0), JSON.stringify(pick(translateEvent.event, ['cached', ...TOKEN_BUCKETS])));
  } else {
    check(
      'translate event records the returned 4-field tokens',
      translateEventOk && translateEvent.event.cached === false && TOKEN_BUCKETS.every((key) => translateEvent.event[key] === (translateUsage[key] ?? 0)),
      JSON.stringify({ event: translateEvent.event && pick(translateEvent.event, TOKEN_BUCKETS), response: pick(translateUsage, TOKEN_BUCKETS) }),
    );
  }
  check('translate response keeps provider/model/reasoningEffort contract', typeof translate.json?.provider === 'string' && translate.json.provider.length > 0 && typeof translate.json?.model === 'string' && translate.json.model.length > 0 && typeof translate.json?.reasoningEffort === 'string', `${translate.json?.provider}/${translate.json?.model}/${translate.json?.reasoningEffort}`);
  check('translations payload is a non-empty string', typeof translate.json?.translations?.[0] === 'string' && String(translate.json.translations[0]).trim().length > 0, JSON.stringify(translate.json?.translations));

  /* ---- 3. one live lookup (unique tags) ---- */
  const lookupBody = {
    text: 'hello world',
    context: 'hello world example sentence',
    targetLanguage: 'zh-CN',
    sourceUrl: `https://example.com/qa-live-${RUN_TAG}`,
    sourceTitle: `QA live lookup ${RUN_TAG}`,
    client: 'qa',
  };
  const lookup = await call('POST', '/lookup', lookupBody);
  await save('lookup-response.json', lookup.json || { status: lookup.status, raw: lookup.raw });
  check(
    'POST /lookup 200 keeps v2 result shape',
    lookup.status === 200 && lookup.json?.ok === true && lookup.json?.result && typeof lookup.json.result === 'object' && typeof lookup.json.result.translation === 'string' && lookup.json.result.translation.length > 0,
    `status=${lookup.status} body=${lookup.raw.slice(0, 250)}`,
  );
  const afterLookup = await call('GET', '/usage?days=14');
  await save('usage-after-lookup.json', afterLookup.json || { status: afterLookup.status, raw: afterLookup.raw });
  const usageAfterLookup = afterLookup.json?.usage;
  const lookupEvent = await findEvent((entry) => entry?.kind === 'lookup' && entry?.sourceTitle === lookupBody.sourceTitle);
  await save('lookup-event.json', lookupEvent.event ?? { missing: true });
  check('lookup event recorded and findable (kind=lookup)', lookupEvent.event !== null, JSON.stringify(lookupEvent.event && pick(lookupEvent.event, ['id', 'kind', 'ok', 'client', 'site', 'sourceTitle'])));
  check(
    'lookup event records provider/model/retries=0/metadata',
    lookupEvent.event !== null &&
      lookupEvent.event.ok === true &&
      lookupEvent.event.retries === 0 &&
      lookupEvent.event.client === 'qa' &&
      typeof lookupEvent.event.provider === 'string' &&
      lookupEvent.event.provider.length > 0 &&
      typeof lookupEvent.event.model === 'string' &&
      lookupEvent.event.model.length > 0 &&
      numeric(lookupEvent.event, TOKEN_BUCKETS) &&
      TOKEN_BUCKETS.every((key) => lookupEvent.event[key] >= 0),
    JSON.stringify(lookupEvent.event && pick(lookupEvent.event, ['ok', 'retries', 'client', 'provider', 'model', ...TOKEN_BUCKETS])),
  );
  check('lookup aggregated under byKind.lookup', (usageAfterLookup?.byKind?.lookup?.requests ?? 0) >= 1, JSON.stringify(usageAfterLookup?.byKind?.lookup));

  /* ---- 4. synthetic extension-origin event (same text => expected cache hit, no extra model cost) ---- */
  const extensionBody = {
    texts: ['Hello world'],
    targetLanguage: 'zh-CN',
    sourceUrl: `https://example.com/article/qa-extension-${RUN_TAG}`,
    sourceTitle: `QA extension-origin event ${RUN_TAG}`,
    client: 'extension',
  };
  const extensionTranslate = await call('POST', '/translate', extensionBody);
  await save('translate-extension-response.json', extensionTranslate.json || { status: extensionTranslate.status, raw: extensionTranslate.raw });
  check('synthetic extension-origin translate accepted', extensionTranslate.status === 200 && extensionTranslate.json?.ok === true, `status=${extensionTranslate.status} cached=${extensionTranslate.json?.cached}`);
  const extensionEvent = await findEvent((entry) => entry?.sourceTitle === extensionBody.sourceTitle);
  await save('extension-event.json', extensionEvent.event ?? { missing: true });
  check(
    'extension-origin event carries client=extension + site/sourceUrl/sourceTitle',
    extensionEvent.event !== null &&
      extensionEvent.event.client === 'extension' &&
      extensionEvent.event.site === 'example.com' &&
      extensionEvent.event.sourceUrl === extensionBody.sourceUrl &&
      extensionEvent.event.sourceTitle === extensionBody.sourceTitle,
    JSON.stringify(extensionEvent.event && pick(extensionEvent.event, ['client', 'site', 'sourceUrl', 'sourceTitle'])),
  );

  /* ---- 4b. synthetic Turn trace: 3 translate batches + lookup + /usage/turns ---- */
  const turnId = `tr_qa_${RUN_TAG}`;
  const lookupTurnId = `lk_qa_${RUN_TAG}`;
  const turnSourceUrl = `https://example.com/qa-turn-${RUN_TAG}`;
  const turnSourceTitle = `QA turn check ${RUN_TAG}`;
  const turnResponses = [];
  for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
    const response = await call('POST', '/translate', {
      texts: [`QA turn step ${stepIndex} for ${RUN_TAG}`],
      targetLanguage: 'zh-CN',
      sourceUrl: turnSourceUrl,
      sourceTitle: turnSourceTitle,
      client: 'qa',
      turnId,
      stepIndex,
      mode: 'bilingual',
    });
    turnResponses.push({ stepIndex, status: response.status, cached: response.json?.cached, usage: response.json?.usage });
    check(
      `turn step ${stepIndex}: POST /translate accepts turnId/stepIndex/mode`,
      response.status === 200 && response.json?.ok === true,
      `status=${response.status} body=${response.raw.slice(0, 200)}`,
    );
  }
  await save('turn-steps.json', turnResponses);

  const turnsProbe = await call('GET', '/usage/turns?limit=20');
  await save('turns-page.json', turnsProbe.json || { status: turnsProbe.status, raw: turnsProbe.raw });
  if (turnsProbe.status === 404) {
    check('GET /usage/turns exists on the installed Host', false, 'HTTP 404: installed plugin is the OLD version (no Turn trace API)');
  } else {
    check(
      'GET /usage/turns 200 page shape {ok:true, turns, nextBefore, hasMore}',
      turnsProbe.status === 200 && turnsProbe.json?.ok === true && Array.isArray(turnsProbe.json.turns) && typeof turnsProbe.json.hasMore === 'boolean' && Object.hasOwn(turnsProbe.json, 'nextBefore'),
      `status=${turnsProbe.status} body=${turnsProbe.raw.slice(0, 250)}`,
    );
    const probeTurns = Array.isArray(turnsProbe.json?.turns) ? turnsProbe.json.turns : [];
    check('turns page is newest-first by startedAt', probeTurns.every((turn, index) => index === 0 || probeTurns[index - 1].startedAt >= turn.startedAt), probeTurns.slice(0, 4).map((turn) => `${turn.id}@${turn.startedAt}`).join(','));
    if (probeTurns.length === 20) {
      check('default turn page reports hasMore with nextBefore == last turn id', turnsProbe.json.hasMore === true && turnsProbe.json.nextBefore === probeTurns[19].id, JSON.stringify({ hasMore: turnsProbe.json.hasMore, nextBefore: turnsProbe.json.nextBefore }));
    }

    /* synthetic 3-step turn */
    const foundTurn = await findTurn((turn) => turn?.id === turnId);
    const turn = foundTurn.turn;
    await save('turn-created.json', turn ?? { missing: true });
    check('synthetic 3-step turn (one turnId) appears in /usage/turns', turn !== null, JSON.stringify(foundTurn.turns.slice(0, 5).map((entry) => entry.id)));
    if (turn !== null) {
      const problems = turnProblems(turn);
      check('synthetic turn satisfies all per-turn invariants (sums/status/order/duration)', problems.length === 0, problems.join('; '));
      check(
        'synthetic turn groups 3 steps in stepIndex order 0,1,2',
        turn.requests === 3 && turn.steps?.length === 3 && JSON.stringify(turn.steps.map((step) => step.stepIndex)) === '[0,1,2]',
        JSON.stringify(turn.steps?.map((step) => ({ stepIndex: step.stepIndex, kind: step.kind }))),
      );
      check(
        'synthetic turn: kind=translate mode=bilingual status=ok errors=0',
        turn.kind === 'translate' && turn.mode === 'bilingual' && turn.status === 'ok' && turn.errors === 0 && turn.ok === 3,
        JSON.stringify({ kind: turn.kind, mode: turn.mode, status: turn.status, ok: turn.ok, errors: turn.errors }),
      );
      check(
        'synthetic turn metadata (sourceUrl/sourceTitle/client/site)',
        turn.sourceUrl === turnSourceUrl && turn.sourceTitle === turnSourceTitle && turn.client === 'qa' && turn.site === 'example.com',
        JSON.stringify({ sourceUrl: turn.sourceUrl, sourceTitle: turn.sourceTitle, client: turn.client, site: turn.site }),
      );
      check(
        'synthetic turn steps carry outputPreview (success previews)',
        turn.steps.filter((step) => typeof step.outputPreview === 'string' && step.outputPreview.length > 0).length === 3,
        JSON.stringify(turn.steps.map((step) => step.outputPreview)),
      );
      const taggedEvents = (await eventsPage(500)).events.filter((entry) => entry?.sourceTitle === turnSourceTitle);
      await save('turn-events.json', taggedEvents);
      check(
        'the 3 tagged events share turnId and stepIndex 0,1,2',
        taggedEvents.length === 3 &&
          taggedEvents.every((entry) => entry.turnId === turnId) &&
          JSON.stringify(taggedEvents.map((entry) => entry.stepIndex).sort((left, right) => left - right)) === '[0,1,2]',
        JSON.stringify(taggedEvents.map((entry) => ({ turnId: entry.turnId, stepIndex: entry.stepIndex }))),
      );
      const eventTokens = sumBuckets(taggedEvents, TOKEN_BUCKETS);
      check(
        'turn token sums == sum of its recorded events (tokens/cache buckets)',
        same(eventTokens, turn, TOKEN_BUCKETS),
        JSON.stringify({ events: eventTokens, turn: pick(turn, TOKEN_BUCKETS) }),
      );
      const stepTokens = sumBuckets(turn.steps ?? [], TOKEN_BUCKETS);
      check('turn token sums == sum of its steps', same(stepTokens, turn, TOKEN_BUCKETS), JSON.stringify({ steps: stepTokens, turn: pick(turn, TOKEN_BUCKETS) }));
    }

    /* synthetic lookup turn (1 step) */
    const lookupTurnBody = {
      text: `qa lookup ${RUN_TAG}`,
      context: `qa lookup context ${RUN_TAG}`,
      targetLanguage: 'zh-CN',
      sourceUrl: `https://example.com/qa-lookup-turn-${RUN_TAG}`,
      sourceTitle: `QA lookup turn ${RUN_TAG}`,
      client: 'qa',
      turnId: lookupTurnId,
      stepIndex: 0,
    };
    const lookupTurnResponse = await call('POST', '/lookup', lookupTurnBody);
    check('lookup call with turnId accepted (synthetic lookup turn)', lookupTurnResponse.status === 200 && lookupTurnResponse.json?.ok === true, `status=${lookupTurnResponse.status} body=${lookupTurnResponse.raw.slice(0, 200)}`);
    const foundLookupTurn = await findTurn((entry) => entry?.id === lookupTurnId);
    const lookupTurn = foundLookupTurn.turn;
    await save('turn-lookup.json', lookupTurn ?? { missing: true });
    check(
      'lookup turn: kind=lookup, 1 step, ok, outputPreview set',
      lookupTurn !== null && lookupTurn.kind === 'lookup' && lookupTurn.steps?.length === 1 && lookupTurn.status === 'ok' &&
        typeof lookupTurn.steps?.[0]?.outputPreview === 'string' && lookupTurn.steps[0].outputPreview.length > 0,
      JSON.stringify(lookupTurn && { kind: lookupTurn.kind, steps: lookupTurn.steps?.length, status: lookupTurn.status, preview: lookupTurn.steps?.[0]?.outputPreview }),
    );

    /* filters */
    const translateFilter = await turnsPage({ kind: 'translate', limit: 100 });
    const lookupFilter = await turnsPage({ kind: 'lookup', limit: 100 });
    const errorFilter = await turnsPage({ kind: 'error', limit: 100 });
    await save('turns-filter-translate.json', { status: translateFilter.response.status, ids: translateFilter.turns.slice(0, 20).map((entry) => entry.id) });
    await save('turns-filter-lookup.json', { status: lookupFilter.response.status, ids: lookupFilter.turns.slice(0, 20).map((entry) => entry.id) });
    await save('turns-filter-error.json', { status: errorFilter.response.status, ids: errorFilter.turns.slice(0, 20).map((entry) => entry.id) });
    check(
      'filter kind=translate includes the synthetic translate turn and excludes the lookup turn',
      translateFilter.turns.some((entry) => entry.id === turnId) && !translateFilter.turns.some((entry) => entry.id === lookupTurnId),
      JSON.stringify({ total: translateFilter.turns.length, hasTranslate: translateFilter.turns.some((entry) => entry.id === turnId), hasLookup: translateFilter.turns.some((entry) => entry.id === lookupTurnId) }),
    );
    check(
      'filter kind=lookup includes the synthetic lookup turn and excludes the translate turn',
      lookupFilter.turns.some((entry) => entry.id === lookupTurnId) && !lookupFilter.turns.some((entry) => entry.id === turnId),
      JSON.stringify({ total: lookupFilter.turns.length, hasLookup: lookupFilter.turns.some((entry) => entry.id === lookupTurnId), hasTranslate: lookupFilter.turns.some((entry) => entry.id === turnId) }),
    );
    check('filter kind=error returns only non-ok turns', errorFilter.response.status === 200 && errorFilter.turns.every((entry) => entry.status !== 'ok'), JSON.stringify(errorFilter.turns.slice(0, 10).map((entry) => ({ id: entry.id, status: entry.status }))));

    /* pagination: limit + before */
    const firstTurnPage = await call('GET', '/usage/turns?limit=1');
    const firstTurn = firstTurnPage.json?.turns?.[0];
    check(
      'turns ?limit=1 returns one turn with hasMore/nextBefore',
      firstTurnPage.status === 200 && firstTurnPage.json?.turns?.length === 1 && typeof firstTurnPage.json.nextBefore === 'string' && firstTurnPage.json.hasMore === true,
      JSON.stringify({ id: firstTurn?.id, hasMore: firstTurnPage.json?.hasMore, nextBefore: firstTurnPage.json?.nextBefore }),
    );
    const secondTurnPage = await call('GET', `/usage/turns?limit=1&before=${encodeURIComponent(firstTurnPage.json?.nextBefore ?? '')}`);
    await save('turns-pagination.json', { first: firstTurnPage.json, second: secondTurnPage.json });
    check(
      'turns ?before= returns the next older turn (distinct id)',
      secondTurnPage.status === 200 && secondTurnPage.json?.turns?.length === 1 && secondTurnPage.json.turns[0]?.id !== firstTurn?.id,
      JSON.stringify({ first: firstTurn?.id, second: secondTurnPage.json?.turns?.[0]?.id }),
    );
    const clampedTurnPage = await call('GET', '/usage/turns?limit=0');
    check('turns ?limit=0 clamps to 1', clampedTurnPage.status === 200 && clampedTurnPage.json?.turns?.length === 1, `status=${clampedTurnPage.status} len=${clampedTurnPage.json?.turns?.length}`);

    /* ledger-wide invariant: paginate ALL turns and compare their sums to /usage totals.
     * Another agent's extension may write between our calls, so accept any value
     * between a before/after summary snapshot (the ledger only grows). */
    const usageI1 = (await call('GET', '/usage?days=14')).json?.usage;
    const allTurns = [];
    let turnBefore = '';
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await turnsPage({ limit: 100, ...(turnBefore.length > 0 ? { before: turnBefore } : {}) });
      if (page.response.status !== 200) break;
      allTurns.push(...page.turns);
      if (page.response.json?.hasMore !== true || typeof page.response.json?.nextBefore !== 'string' || page.turns.length === 0) break;
      turnBefore = page.response.json.nextBefore;
    }
    const usageI2 = (await call('GET', '/usage?days=14')).json?.usage;
    const turnAggregate = { requests: 0, ok: 0, errors: 0, cached: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const turn of allTurns) for (const key of BUCKETS) turnAggregate[key] += Number.isFinite(turn?.[key]) ? turn[key] : 0;
    const totalsBefore = usageI1?.totals ?? {};
    const totalsAfter = usageI2?.totals ?? {};
    const ledgerEventBudget = 500; // LIMITS.usageEvents: turns() aggregates only the retained event list
    const totalsInRange = (usageI1?.totals?.requests ?? 0) <= ledgerEventBudget && BUCKETS.every((key) => {
      const low = Number.isFinite(totalsBefore[key]) ? totalsBefore[key] : 0;
      const high = Number.isFinite(totalsAfter[key]) ? totalsAfter[key] : 0;
      return turnAggregate[key] >= low && turnAggregate[key] <= high;
    });
    await save('turns-all-pages.json', { turnCount: allTurns.length, turnAggregate, totalsBefore, totalsAfter, totalsInRange });
    check(
      'paginated ALL turns aggregate == /usage totals (within concurrent-write snapshot range)',
      allTurns.length > 0 && totalsInRange,
      JSON.stringify({ turns: allTurns.length, aggregate: turnAggregate, before: pick(totalsBefore, BUCKETS), after: pick(totalsAfter, BUCKETS) }),
    );
    check('paginated turns have no duplicate ids and stay newest-first', new Set(allTurns.map((turn) => turn.id)).size === allTurns.length && allTurns.every((turn, index) => index === 0 || allTurns[index - 1].startedAt >= turn.startedAt), `turns=${allTurns.length} unique=${new Set(allTurns.map((turn) => turn.id)).size}`);
  }

  /* ---- 5. ledger-wide invariants on the live file ---- */
  const finalUsage = (await call('GET', '/usage?days=14')).json?.usage;
  await save('usage-final.json', finalUsage ?? {});
  check('live totals == sum(days)', same(sumBuckets(finalUsage?.days ?? []), finalUsage?.totals));
  const modelSum = sumBuckets(finalUsage?.byModel ?? [], ['requests', ...TOKEN_BUCKETS]);
  check('live totals == sum(byModel) (requests+tokens)', same(modelSum, finalUsage?.totals, ['requests', ...TOKEN_BUCKETS]), JSON.stringify({ modelSum, totals: pick(finalUsage?.totals, ['requests', ...TOKEN_BUCKETS]) }));
  const kindSum = sumBuckets([finalUsage?.byKind?.translate, finalUsage?.byKind?.lookup]);
  check('live totals == sum(byKind)', same(kindSum, finalUsage?.totals), JSON.stringify({ kindSum, totals: pick(finalUsage?.totals, BUCKETS) }));
  check(
    'all live buckets are non-negative integers',
    numeric(finalUsage?.totals) && BUCKETS.every((key) => finalUsage.totals[key] >= 0) && BUCKETS.every((key) => finalUsage.days.every((day) => Number.isFinite(day[key]) && day[key] >= 0)),
  );
  check('today bucket matches today in days[]', same(finalUsage?.today, finalUsage?.days?.find((day) => day.date === localToday())));
  const recent = finalUsage?.recent;
  check('summary.recent capped at 20 and newest-first', Array.isArray(recent) && recent.length <= 20 && recent.every((entry, index, list) => index === 0 || list[index - 1].at >= entry.at), `len=${recent?.length}`);
  const allEvents = await eventsPage(500);
  check('events list is newest-first', allEvents.events.every((entry, index, list) => index === 0 || list[index - 1].at >= entry.at), allEvents.events.slice(0, 5).map((entry) => entry.at).join(','));
  check(
    'events carry dsh usage fields (at/kind/ok/provider/model/latency/four buckets)',
    allEvents.events.length > 0 &&
      allEvents.events.slice(0, 20).every((entry) =>
        Number.isFinite(entry?.at) &&
        (entry.kind === 'translate' || entry.kind === 'lookup') &&
        typeof entry.ok === 'boolean' &&
        typeof entry.provider === 'string' &&
        typeof entry.model === 'string' &&
        Number.isFinite(entry.latencyMs) &&
        entry.latencyMs >= 0 &&
        numeric(entry, TOKEN_BUCKETS),
      ),
  );
  check('events include real extension-origin traffic (client=extension)', allEvents.events.some((entry) => entry.client === 'extension'), JSON.stringify(allEvents.events.filter((entry) => entry.client === 'extension').slice(0, 3).map((entry) => ({ site: entry.site, sourceTitle: entry.sourceTitle, kind: entry.kind }))));

  /* ---- 6. optional DELETE /usage with backup + repopulate (LAST) ---- */
  if (DELETE_MODE) {
    await exerciseDelete(finalUsage, RUN_TAG);
  } else {
    console.log('# DELETE /usage skipped (pass --delete-usage to exercise it live)');
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\nRESULT: ${results.length - failed.length}/${results.length} passed (${failed.length} failed) in ${Date.now() - startedAt}ms`);
  await writeFile(
    join(QA_DIR, 'live-check.result.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        api: API,
        pluginVersion: health.json?.version,
        runTag: RUN_TAG,
        deleteUsageExercised: DELETE_MODE,
        passed: failed.length === 0,
        total: results.length,
        failed: failed.length,
        checks: results,
        evidence,
      },
      null,
      2,
    ),
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

/** Exercise DELETE /usage safely: back up the live ledger first, then repopulate. */
async function exerciseDelete(beforeUsage, runTag) {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh');
  const liveFile = join(dshHome, 'immersive-translate', 'usage.json');
  const backupFile = join(tmpdir(), `dsh-qa-usage-backup-${Date.now()}.json`);
  const hadEvents = (beforeUsage?.totals?.requests ?? 0) >= 1;
  console.log(`# DELETE mode: ${beforeUsage?.totals?.requests ?? 0} recorded requests will be cleared (backed up first)`);
  let backupOk = false;
  if (existsSync(liveFile)) {
    try {
      await copyFile(liveFile, backupFile);
      JSON.parse(await readFile(backupFile, 'utf8'));
      backupOk = true;
    } catch (error) {
      check('DELETE precondition: live usage.json backed up', false, String(error && error.message));
    }
  }
  check('DELETE precondition: live usage.json backed up', backupOk, backupOk ? `backup=${backupFile}` : `missing ${liveFile}`);
  if (!backupOk || !hadEvents) {
    check('DELETE /usage exercised live', false, 'skipped: precondition failed');
    return;
  }
  const preDelete = await call('GET', '/usage');
  const cleared = await call('DELETE', '/usage');
  await save('delete-response.json', cleared.json || { status: cleared.status, raw: cleared.raw });
  check('DELETE /usage 200 {cleared:true}', cleared.status === 200 && cleared.json?.ok === true && cleared.json?.cleared === true, `status=${cleared.status} body=${cleared.raw.slice(0, 250)}`);
  check('DELETE response usage summary is zeroed', numeric(cleared.json?.usage?.totals) && BUCKETS.every((key) => cleared.json.usage.totals[key] === 0), JSON.stringify(cleared.json?.usage?.totals));
  const afterClear = (await call('GET', '/usage')).json?.usage;
  await save('usage-after-delete.json', afterClear ?? {});
  const clearedRequests = afterClear?.totals?.requests ?? -1;
  check(
    'after DELETE the ledger no longer contains pre-DELETE events',
    numeric(afterClear?.totals) && clearedRequests >= 0 && clearedRequests <= 2,
    JSON.stringify({ clearedRequests, note: clearedRequests > 0 ? 'concurrent traffic landed right after clear (expected with another agent active)' : 'empty' }),
  );
  const staleTagEvents = (await eventsPage(100)).events.filter((entry) => typeof entry?.sourceTitle === 'string' && entry.sourceTitle.includes(runTag));
  check('after DELETE none of this run’s tagged events remain', staleTagEvents.length === 0, JSON.stringify(staleTagEvents.slice(0, 3).map((entry) => entry.sourceTitle)));
  // Repopulate immediately with one small translate so the ledger is not left empty.
  const repopulateBody = {
    texts: ['Hello world'],
    targetLanguage: 'zh-CN',
    sourceUrl: `https://example.com/qa-repopulate-${runTag}`,
    sourceTitle: `QA repopulate ${runTag}`,
    client: 'qa',
  };
  const repopulate = await call('POST', '/translate', repopulateBody);
  await save('repopulate-response.json', repopulate.json || { status: repopulate.status, raw: repopulate.raw });
  const repopulated = (await call('GET', '/usage')).json?.usage;
  await save('usage-after-repopulate.json', repopulated ?? {});
  const repopulateEvent = await findEvent((entry) => entry?.sourceTitle === repopulateBody.sourceTitle);
  check(
    'after DELETE: one translate repopulates the ledger (tagged event present)',
    repopulate.status === 200 && repopulate.json?.ok === true && repopulateEvent.event !== null,
    JSON.stringify({ requests: repopulated?.totals?.requests, repopulateCached: repopulate.json?.cached }),
  );
  evidence.deleteBackupFile = backupFile;
  evidence.preDeleteUsage = preDelete.json;
  evidence.postDeleteUsage = afterClear;
  console.log(`# usage.json backup kept at ${backupFile} (contains pre-DELETE ledger incl. other agent's events)`);
}

main().catch((error) => {
  console.error(`live-check crashed: ${error && error.stack ? error.stack : String(error)}`);
  process.exitCode = 2;
});
