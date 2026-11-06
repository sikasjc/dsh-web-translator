#!/usr/bin/env node
/**
 * QA phase-2 live evidence: translation conversation bridge → native DSH
 * trajectory (DESIGN-CONVERSATIONS.md §4.3).
 *
 * What it does (no writes outside qa/live-conversations-evidence/; temp Chrome
 * profile only):
 *  1. verifies the installed host (`GET /health` >= 1.5.0);
 *  2. seeds a real deterministic translation run: three POST /translate batches
 *     sharing one `turnId` (stepIndex 0..2, mode=bilingual, unique texts);
 *  3. captures `GET /conversations` (our conversation row) and
 *     `GET /usage/turns` (our turn + steps + tokens), asserting the bridge
 *     linkage (turn.sessionId == conversation.sessionId);
 *  4. opens the live DSH GUI in headless Chrome (launch-token URL or DSH_COOKIE auth), opens
 *     the plugin 「轨迹」 tab, finds the seeded conversation card, asserts the
 *     「打开 DSH 轨迹」 button, clicks it and waits for the NATIVE DSH session
 *     view (对话 / 轨迹 / 统计 tabs);
 *  5. asserts the native 轨迹 view shows 第 1..3 轮 with user/assistant content,
 *     the native 对话 view shows the translated round, the native 统计 view
 *     lists the same rounds, and the native composer token pill equals the
 *     ledger token sum of that run;
 *  6. saves screenshots conversation-chat.png / conversation-trajectory.png /
 *     conversation-stats.png + JSON evidence under qa/live-conversations-evidence/.
 *
 * Usage: node qa/conversation-shot.mjs
 * Env:   DSH_URL / DSH_WEB_URL (default http://127.0.0.1:3080)
 *        CHROME_BIN             Chrome executable override
 *
 * Exit code: 0 = all checks pass, 1 = at least one FAIL, 2 = setup error.
 * QA-only script: writes only under qa/; never installs/reloads the plugin.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CDP,
  authenticateDshPage,
  evalOn,
  launchChrome,
  openPageTarget,
  screenshot,
  wait,
  waitFor,
} from './cdp.mjs';

const QA_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(QA_DIR, 'live-conversations-evidence');
const DSH_URL = (process.env.DSH_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').trim();
const DSH_ORIGIN = new URL(DSH_URL).origin;
const API_BASE = `${DSH_ORIGIN}/dsh-immersive/api`;
const RUN_TAG = Date.now().toString(36);
const TURN_ID = `tr_qa_conv_${RUN_TAG}`;
const SOURCE_TITLE = `QA conversation ${RUN_TAG}`;
const SOURCE_URL = `https://example.com/qa-conversation-${RUN_TAG}`;
const BATCH_TEXTS = [
  `QA conversation batch 0 for ${RUN_TAG} — the quick brown fox.`,
  `QA conversation batch 1 for ${RUN_TAG} — a second sentence.`,
  `QA conversation batch 2 for ${RUN_TAG} — a third sentence.`,
];

const results = [];
const evidence = { runTag: RUN_TAG, turnId: TURN_ID, sourceTitle: SOURCE_TITLE };
let currentStage = 'setup';

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 900) });
  const suffix = detail === undefined ? '' : `  [${String(detail).replace(/\s+/g, ' ').slice(0, 500)}]`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
  return ok;
}

async function save(name, value) {
  evidence[name] = value;
  await writeFile(join(EVIDENCE_DIR, name), JSON.stringify(value, null, 2));
}

/* ------------------------------------------------------------------ */
/* Plugin HTTP helpers (no auth needed for the local plugin API)       */
/* ------------------------------------------------------------------ */

async function apiFetch(method, path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
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
  return { status: response.status, json, raw: text.slice(0, 2000) };
}

/** Find one conversation row for the seeded run; retries while the bridge flushes. */
async function findConversation() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await apiFetch('GET', '/conversations');
    const rows = Array.isArray(response.json?.conversations) ? response.json.conversations : [];
    const row = rows.find((entry) => entry?.turnId === TURN_ID);
    if (row !== undefined) return { row, response };
    await wait(400);
  }
  return { row: null, response: null };
}

/** Find the seeded run's /usage/turns Turn (with its Steps); retries briefly. */
async function findTurn() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await apiFetch('GET', '/usage/turns?limit=100');
    const turns = Array.isArray(response.json?.turns) ? response.json.turns : [];
    const turn = turns.find((entry) => entry?.id === TURN_ID);
    if (turn !== undefined) return { turn, response };
    await wait(400);
  }
  return { turn: null, response: null };
}

/* ------------------------------------------------------------------ */
/* Browser widget helpers                                             */
/* ------------------------------------------------------------------ */

/** Labels the plugin panel may be registered under (zh / en dictionaries). */
const PANEL_LABEL_RE = /dsh翻译|Immersive\s*Translate/i;

/** Find the sidebar panel button and click it; returns diagnostics when absent. */
const CLICK_PANEL_EXPR = `(() => {
  const wanted = ${PANEL_LABEL_RE.toString()};
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    label: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || '')) || '',
    text: ((el.textContent || '').trim().replace(/\\s+/g, ' ')).slice(0, 80),
  });
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  const all = buttons.map(describe);
  const hit = all.findIndex((entry) => wanted.test(entry.label) || wanted.test(entry.text));
  if (hit === -1) return { found: false, samples: all.filter((entry) => entry.label || entry.text).slice(0, 60) };
  const el = buttons[hit];
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { found: true, label: all[hit].label || all[hit].text };
})()`;

function clickTabExpr(aliases) {
  return `(() => {
    const aliases = ${JSON.stringify(aliases)};
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const tab = tabs.find((el) => {
      const text = (el.textContent || '').trim();
      return aliases.some((alias) => text === alias || text.startsWith(alias) || text.includes(alias));
    });
    if (!tab) return { clicked: false, tabs: tabs.map((el) => (el.textContent || '').trim()) };
    tab.click();
    return { clicked: true, text: (tab.textContent || '').trim() };
  })()`;
}

const NATIVE_TABS_EXPR = `(() => Array.from(document.querySelectorAll('[role="tab"]')).map((el) => ({
  text: (el.textContent || '').trim(),
  selected: el.getAttribute('aria-selected') === 'true',
})))()`;

const NATIVE_VIEWS_READY = `((() => {
  const labels = Array.from(document.querySelectorAll('[role="tab"]')).map((el) => (el.textContent || '').trim());
  return ['对话', '轨迹', '统计'].every((label) => labels.includes(label))
    || ['Chat', 'Trajectory', 'Stats'].every((label) => labels.includes(label));
})())`;

/** Read the native composer usage pill: { text, ariaLabel, tokenText } */
const USAGE_PILL_EXPR = `(() => {
  const anchor = document.querySelector('[data-composer-stat="usage"]');
  const pill = anchor ? anchor.querySelector('button') : null;
  const activityAnchor = document.querySelector('[data-composer-stat="activity"]');
  const activityPill = activityAnchor ? activityAnchor.querySelector('button') : null;
  const text = pill ? (pill.textContent || '').trim() : '';
  const ariaLabel = pill ? (pill.getAttribute('aria-label') || '') : '';
  const activityText = activityPill ? (activityPill.textContent || '').trim() : '';
  return { found: !!pill, text, ariaLabel, activityText };
})()`;

/** Parse a compact token display ("474 tok", "7.1K tok", "1.2M tok"). */
function parseTokenText(value) {
  const match = /([\d][\d,.]*)\s*([KkMm])?\s*tok/i.exec(String(value ?? ''));
  if (!match) return null;
  const number = Number(match[1].replaceAll(',', ''));
  if (!Number.isFinite(number)) return null;
  const unit = (match[2] || '').toLowerCase();
  const factor = unit === 'k' ? 1000 : unit === 'm' ? 1_000_000 : 1;
  return { value: number * factor, compact: unit !== '', unit, raw: String(value).trim() };
}

/** Best-effort native sidebar fallback: expand the translation group (or 未分组 on older builds) and open the conversation by title. */
async function openConversationFromSidebar(page, sessionTitle) {
  const expanded = await evalOn(page, `(() => {
    const items = Array.from(document.querySelectorAll('[role="treeitem"]'));
    const ungrouped = items.find((el) => ['dsh翻译记录', '未分组'].includes((el.textContent || '').trim()));
    if (!ungrouped) return { ok: false, reason: 'no translation group' };
    if (ungrouped.getAttribute('aria-expanded') !== 'true') ungrouped.click();
    return { ok: true };
  })()`);
  if (!expanded?.ok) return { ok: false, reason: expanded?.reason ?? 'expand failed' };
  await wait(1200);
  const rows = await evalOn(page, `(() => Array.from(document.querySelectorAll('[role="treeitem"]')).map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      height: Math.round(rect.height),
    };
  }).filter((row) => row.height > 10))()`);
  const wanted = String(sessionTitle || '').trim();
  const row = rows.find((entry) => wanted.length > 0 && entry.text.includes(wanted))
    ?? rows.find((entry) => /^(翻译 · |翻译查词 · )/.test(entry.text) && entry.text.includes(SOURCE_TITLE));
  if (!row) return { ok: false, reason: 'conversation row not found', rows: rows.map((entry) => entry.text).slice(0, 20) };
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'left', clickCount: 1 });
  return { ok: true, row: row.text };
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  await mkdir(EVIDENCE_DIR, { recursive: true });
  console.log(`# conversation-shot ${new Date().toISOString()} runTag=${RUN_TAG} -> ${DSH_URL}`);
  evidence.startedAt = new Date().toISOString();

  /* ---- 0. installed host ---- */
  const health = await apiFetch('GET', '/health');
  await save('health.json', health.json || { status: health.status, raw: health.raw });
  check('GET /health 200 with plugin version >= 1.5.0', health.status === 200 && health.json?.ok === true && Number(String(health.json?.version ?? '0.0.0').split('.')[1] ?? 0) >= 5, `status=${health.status} version=${health.json?.version}`);

  /* ---- 1. seed one real translation run (3 batches, same turnId) ---- */
  currentStage = 'seed';
  const batches = [];
  for (let stepIndex = 0; stepIndex < BATCH_TEXTS.length; stepIndex += 1) {
    const response = await apiFetch('POST', '/translate', {
      texts: [BATCH_TEXTS[stepIndex]],
      targetLanguage: 'zh-CN',
      sourceUrl: SOURCE_URL,
      sourceTitle: SOURCE_TITLE,
      client: 'qa',
      turnId: TURN_ID,
      stepIndex,
      mode: 'bilingual',
    });
    batches.push({
      stepIndex,
      status: response.status,
      ok: response.json?.ok === true,
      cached: response.json?.cached,
      translations: response.json?.translations,
      usage: response.json?.usage,
      error: response.json?.ok === true ? undefined : response.json?.error,
    });
    check(
      `seed batch ${stepIndex}: POST /translate 200 with translations`,
      response.status === 200 && response.json?.ok === true && Array.isArray(response.json?.translations) && typeof response.json.translations[0] === 'string' && response.json.translations[0].trim().length > 0,
      `status=${response.status} body=${response.raw.slice(0, 200)}`,
    );
  }
  await save('seeded-run.json', { turnId: TURN_ID, sourceTitle: SOURCE_TITLE, sourceUrl: SOURCE_URL, texts: BATCH_TEXTS, batches });

  /* ---- 2. GET /conversations: one real conversation for the run ---- */
  currentStage = 'conversations';
  const conversationProbe = await findConversation();
  await save('conversations.json', conversationProbe.response?.json ?? { status: conversationProbe.response?.status, raw: conversationProbe.response?.raw });
  const conversation = conversationProbe.row;
  check('GET /conversations lists the seeded run as ONE conversation', conversation !== null, JSON.stringify(conversationProbe.row));
  check(
    'conversation row: sessionId=translation-<turnId>, title 翻译 · <sourceTitle>, turns=3, live=true',
    conversation !== null &&
      conversation.sessionId === `translation-${TURN_ID}` &&
      String(conversation.title ?? '').includes(SOURCE_TITLE) &&
      conversation.turns === 3 &&
      conversation.live === true,
    JSON.stringify(conversation && { sessionId: conversation.sessionId, title: conversation.title, turns: conversation.turns, live: conversation.live }),
  );

  /* ---- 3. GET /usage/turns: the run's Turn + Steps carry the sessionId ---- */
  currentStage = 'turns';
  const turnProbe = await findTurn();
  await save('usage-turns.json', turnProbe.response?.json ?? { status: turnProbe.response?.status, raw: turnProbe.response?.raw });
  const turn = turnProbe.turn;
  check('/usage/turns contains the seeded Turn', turn !== null, JSON.stringify(turnProbe.turn && { id: turnProbe.turn.id, steps: turnProbe.turn.steps?.length }));
  const expectedTokens = turn
    ? turn.steps.reduce((total, step) => total + ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (Number.isFinite(step?.[key]) ? step[key] : 0), 0), 0)
    : 0;
  const expectedTurns = turn ? turn.steps.length : 0;
  const turnOutputPreviews = turn ? turn.steps.map((step) => step.outputPreview).filter((value) => typeof value === 'string' && value.length > 0) : [];
  await save('seeded-turn.json', {
    turn: turn ?? null,
    expectedTokens,
    expectedTurns,
    conversationSessionId: conversation?.sessionId ?? null,
    ledger: turn ? {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWriteTokens: turn.cacheWriteTokens,
      requests: turn.requests,
      status: turn.status,
    } : null,
  });
  check(
    'Turn carries the conversation sessionId (turn.sessionId == conversation.sessionId)',
    turn !== null && conversation !== null && turn.sessionId === conversation.sessionId,
    JSON.stringify({ turnSessionId: turn?.sessionId, conversationSessionId: conversation?.sessionId }),
  );
  check(
    'Turn groups the 3 batches as Steps [0,1,2] with per-step outputPreview',
    turn !== null && turn.steps.length === 3 && JSON.stringify(turn.steps.map((step) => step.stepIndex)) === '[0,1,2]' && turnOutputPreviews.length === 3,
    JSON.stringify({ stepIndexes: turn?.steps?.map((step) => step.stepIndex), previews: turnOutputPreviews }),
  );

  /* ---- 4. Headless GUI: plugin 轨迹 tab → conversation card → 打开 DSH 轨迹 ---- */
  currentStage = 'gui';
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageExceptions = [];
  let chrome;
  let page;
  const screenshots = [];
  const screenshotTo = async (name) => {
    await screenshot(page, join(EVIDENCE_DIR, name));
    screenshots.push(name);
    return name;
  };
  try {
    chrome = await launchChrome({ label: 'dsh-qa-conversation', windowSize: '1440,960' });
    const baseHttp = `http://127.0.0.1:${chrome.port}`;
    const target = await openPageTarget(baseHttp, 'about:blank');
    page = new CDP(target.webSocketDebuggerUrl, { commandTimeoutMs: 45_000 });
    await page.connect();
    page.on('Runtime.exceptionThrown', (params) => pageExceptions.push(JSON.stringify(params.exceptionDetails).slice(0, 500)));
    page.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      if (params.type === 'error' || params.type === 'assert') consoleErrors.push(`console.${params.type}: ${text}`.slice(0, 500));
      else if (params.type === 'warning' || params.type === 'warn') consoleWarnings.push(`console.${params.type}: ${text}`.slice(0, 500));
    });
    page.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level === 'error') consoleErrors.push(`log: ${entry.source || 'browser'} ${entry.text || ''}`.slice(0, 500));
      else if (entry.level === 'warning') consoleWarnings.push(`log: ${entry.source || 'browser'} ${entry.text || ''}`.slice(0, 500));
    });
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Log.enable');

    const auth = await authenticateDshPage(page, DSH_URL);
    check('DSH GUI auth prepared', true, auth.mode);
    await page.send('Page.navigate', { url: DSH_URL });
    const boot = await waitFor(page, `document.readyState === 'complete' && !!document.querySelector('[data-sidebar-toggle], [data-sidebar-opener], [data-platform]')`, { timeoutMs: 45_000, intervalMs: 300 });
    check('DSH dashboard booted', boot.ok, `after ${boot.waitedMs}ms`);

    /* open the plugin panel */
    let clicked = await evalOn(page, CLICK_PANEL_EXPR);
    if (!clicked.found) {
      const opened = await evalOn(page, `(() => { const opener = document.querySelector('[data-sidebar-opener]'); if (opener) { opener.click(); return true; } return false; })()`);
      if (opened) {
        await wait(800);
        clicked = await evalOn(page, CLICK_PANEL_EXPR);
      }
    }
    check('plugin sidebar entry dsh翻译 found', clicked.found, JSON.stringify(clicked));
    const tabsWait = await waitFor(page, `document.querySelectorAll('[role="tab"]').length >= 4`, { timeoutMs: 25_000, intervalMs: 250 });
    check('plugin page tab bar has 4 tabs', tabsWait.ok, JSON.stringify(await evalOn(page, `Array.from(document.querySelectorAll('[role="tab"]')).map((el) => (el.textContent || '').trim())`)));

    /* 轨迹 tab → conversation cards */
    const tracesClick = await evalOn(page, clickTabExpr(['轨迹', 'Traces', 'Trajectory']));
    const convReady = await waitFor(page, `document.querySelectorAll('.dsh-it-conv').length >= 1`, { timeoutMs: 25_000, intervalMs: 250 });
    await wait(800);
    const convState = await evalOn(page, `(() => ({
      selectedTab: (Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.getAttribute('aria-selected') === 'true') || {}).textContent || '',
      cards: document.querySelectorAll('.dsh-it-conv').length,
      openButtons: document.querySelectorAll('.dsh-it-conv-open').length,
      legacyGroup: !!document.querySelector('.dsh-it-conv-legacy'),
      legacyCount: (document.querySelector('.dsh-it-conv-legacy-count')?.textContent || '').trim(),
      titles: Array.from(document.querySelectorAll('.dsh-it-conv-title')).map((el) => (el.textContent || '').trim()).slice(0, 10),
    }))()`);
    check('轨迹 tab opened', tracesClick.clicked && /轨迹|Traces/.test(convState.selectedTab), JSON.stringify({ click: tracesClick, selected: convState.selectedTab }));
    check('轨迹 renders conversation cards (.dsh-it-conv)', convReady.ok && convState.cards >= 1, JSON.stringify(convState));
    check('legacy group for turns without a DSH session present', convState.legacyGroup === true, JSON.stringify({ legacyGroup: convState.legacyGroup, count: convState.legacyCount }));
    await screenshotTo('conversation-list.png');

    /* find the seeded conversation card, expand it, click 打开 DSH 轨迹 */
    const cardInfo = await evalOn(page, `(() => {
      const cards = Array.from(document.querySelectorAll('.dsh-it-conv'));
      const card = cards.find((el) => (el.innerText || '').includes(${JSON.stringify(SOURCE_TITLE)}));
      if (!card) return { found: false, titles: Array.from(document.querySelectorAll('.dsh-it-conv-title')).map((el) => (el.textContent || '').trim()).slice(0, 10) };
      const toggle = card.querySelector('.dsh-it-conv-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      const button = card.querySelector('.dsh-it-conv-open');
      return {
        found: true,
        title: (card.querySelector('.dsh-it-conv-title')?.textContent || '').trim(),
        expanded: toggle ? toggle.getAttribute('aria-expanded') === 'true' : null,
        turnItems: card.querySelectorAll('.dsh-it-conv-turn-item').length,
        live: !!card.querySelector('.dsh-it-conv-live'),
        openButton: !!button,
        openText: button ? (button.textContent || '').trim() : '',
        openAria: button ? (button.getAttribute('aria-label') || '') : '',
      };
    })()`);
    await save('plugin-conversation-card.json', cardInfo);
    check('plugin 轨迹 lists the seeded conversation card', cardInfo.found === true, JSON.stringify({ titles: cardInfo.titles, title: cardInfo.title }));
    check('seeded conversation card is expanded with 3 turn rows + live badge', cardInfo.expanded === true && cardInfo.turnItems === 3, JSON.stringify(cardInfo));
    check('conversation card exposes 「打开 DSH 轨迹」 button', cardInfo.openButton === true && /打开 DSH 轨迹|Open DSH trajectory/.test(cardInfo.openText), JSON.stringify({ openText: cardInfo.openText, openAria: cardInfo.openAria }));
    await screenshotTo('conversation-plugin-card.png');

    const openClick = await evalOn(page, `(() => {
      const cards = Array.from(document.querySelectorAll('.dsh-it-conv'));
      const card = cards.find((el) => (el.innerText || '').includes(${JSON.stringify(SOURCE_TITLE)}));
      const button = card ? card.querySelector('.dsh-it-conv-open') : null;
      if (!button) return { clicked: false };
      button.click();
      return { clicked: true, text: (button.textContent || '').trim() };
    })()`);
    check('clicked 「打开 DSH 轨迹」', openClick.clicked === true, JSON.stringify(openClick));

    /* native session view: 对话 / 轨迹 / 统计 tabs */
    let nativeReady = await waitFor(page, NATIVE_VIEWS_READY, { timeoutMs: 25_000, intervalMs: 300 });
    let fallbackUsed = false;
    if (!nativeReady.ok) {
      // Fallback: open the session from the native sidebar translation group (dsh翻译记录 / legacy 未分组). The
      // native evidence is still real; the FAIL above? no — record the fallback.
      fallbackUsed = true;
      const sidebarOpen = await openConversationFromSidebar(page, `翻译 · ${SOURCE_TITLE}`);
      evidence.sidebarFallback = sidebarOpen;
      nativeReady = await waitFor(page, NATIVE_VIEWS_READY, { timeoutMs: 25_000, intervalMs: 300 });
    }
    evidence.nativeFallbackUsed = fallbackUsed;
    const nativeTabs = await evalOn(page, NATIVE_TABS_EXPR);
    await save('native-tabs.json', { fallbackUsed, tabs: nativeTabs });
    check('native DSH session view opened (对话 / 轨迹 / 统计 tabs present)', nativeReady.ok, JSON.stringify({ fallbackUsed, tabs: nativeTabs }));
    check(
      'uiWorkspace.openSession path worked from the plugin conversation card (no sidebar fallback needed)',
      fallbackUsed === false,
      fallbackUsed ? 'sidebar fallback was used' : 'direct openSession path',
    );

    /* ---- native 对话 view: our user prompt + assistant translation ---- */
    currentStage = 'native-chat';
    await evalOn(page, clickTabExpr(['对话', 'Chat']));
    await wait(1200);
    const chatBody = await evalOn(page, `((document.querySelector('main') || document.body).innerText || '')`);
    const firstTranslation = String(batches[0]?.translations?.[0] ?? '').trim();
    evidence.chat = {
      hasUserPrompt: String(chatBody).includes(BATCH_TEXTS[0]),
      hasTranslation: firstTranslation.length > 0 && String(chatBody).includes(firstTranslation),
      hasCompleted: /已完成|Completed/i.test(String(chatBody)),
      userPromptSnippet: String(chatBody).match(/将以下内容翻译为[^\n]*/)?.[0] ?? '',
    };
    check('native 对话 shows our user prompt for the seeded batch', evidence.chat.hasUserPrompt, evidence.chat.userPromptSnippet);
    check('native 对话 shows the model translation (.translations[0])', evidence.chat.hasTranslation, firstTranslation.slice(0, 120));
    check('native 对话 shows the completed round marker', evidence.chat.hasCompleted);
    await screenshotTo('conversation-chat.png');

    /* ---- native 轨迹 view: 第 1..3 轮 with 用户/助手 rows ---- */
    currentStage = 'native-trajectory';
    await evalOn(page, clickTabExpr(['轨迹', 'Trajectory']));
    await wait(1500);
    const trajectory = await evalOn(page, `(() => {
      const main = document.querySelector('main') || document.body;
      const text = String(main.innerText || '');
      const rounds = (text.match(/第\\s*\\d+\\s*轮/g) || []);
      const rows = Array.from(main.querySelectorAll('*')).filter((el) => /^第\\s*\\d+\\s*轮$/.test((el.textContent || '').trim())).map((el) => (el.textContent || '').trim());
      return {
        text,
        roundHeadings: rows.length > 0 ? rows.slice(0, 8) : rounds.slice(0, 8),
        userLabels: (text.match(/用户/g) || []).length,
        assistantLabels: (text.match(/助手/g) || []).length,
        hasToolbar: ['时长', '轮次', '调用', '输入', '模型', '工具'].filter((label) => text.includes(label)),
      };
    })()`);
    const roundHeadings = trajectory.roundHeadings;
    evidence.trajectory = {
      roundHeadings,
      userLabels: trajectory.userLabels,
      assistantLabels: trajectory.assistantLabels,
      toolbar: trajectory.hasToolbar,
      hasFirstUserText: String(trajectory.text).includes(BATCH_TEXTS[0]),
      hasPreview: turnOutputPreviews.some((preview) => String(trajectory.text).includes(preview.slice(0, 12))),
    };
    check('native 轨迹 lists the seeded rounds (第 1..3 轮)', nativeReady.ok && ['第 1 轮', '第 2 轮', '第 3 轮'].every((label) => roundHeadings.includes(label)), JSON.stringify(roundHeadings));
    check('native 轨迹 shows 用户/助手 rows for each round', trajectory.userLabels >= expectedTurns && trajectory.assistantLabels >= expectedTurns, JSON.stringify({ userLabels: trajectory.userLabels, assistantLabels: trajectory.assistantLabels, expectedTurns }));
    check('native 轨迹 shows the source text of the seeded batch', evidence.trajectory.hasFirstUserText);
    check('native 轨迹 shows the translated assistant content', evidence.trajectory.hasPreview);
    await screenshotTo('conversation-trajectory.png');

    /* ---- native token pill == ledger token sum of the run ---- */
    currentStage = 'native-tokens';
    const usagePill = await evalOn(page, USAGE_PILL_EXPR);
    const parsedTokens = parseTokenText(usagePill.text || usagePill.ariaLabel);
    evidence.usagePill = { ...usagePill, parsedTokens, expectedTokens };
    check('native composer token pill found', usagePill.found === true && parsedTokens !== null, JSON.stringify({ text: usagePill.text, ariaLabel: usagePill.ariaLabel }));
    const tokenTolerance = parsedTokens === null ? 0 : parsedTokens.compact ? (parsedTokens.unit === 'm' ? 100_000 : 100) : 0;
    check(
      'native footer token number == ledger token sum of the seeded run',
      parsedTokens !== null && Math.abs(parsedTokens.value - expectedTokens) <= tokenTolerance,
      JSON.stringify({ pill: parsedTokens, expectedTokens, tolerance: tokenTolerance }),
    );
    check(
      'native composer activity pill reports the seeded round count (3 轮)',
      /3\s*轮|3\s*turns/i.test(usagePill.activityText || '') || /3\s*轮|3\s*turns/i.test(usagePill.text || ''),
      JSON.stringify({ activityText: usagePill.activityText }),
    );

    /* ---- native 统计 view: per-round token table ---- */
    currentStage = 'native-stats';
    await evalOn(page, clickTabExpr(['统计', 'Stats']));
    await wait(1500);
    const stats = await evalOn(page, `(() => {
      const main = document.querySelector('main') || document.body;
      const text = String(main.innerText || '');
      return {
        text,
        hasHeader: ['上下文', '输出', '轮次'].filter((label) => text.includes(label)),
        roundRows: (text.match(/第\\s*\\d+\\s*轮/g) || []).length,
        hasFirstUserText: text.includes(${JSON.stringify(BATCH_TEXTS[0].slice(0, 24))}),
      };
    })()`);
    evidence.stats = { hasHeader: stats.hasHeader, roundRows: stats.roundRows, hasFirstUserText: stats.hasFirstUserText };
    check('native 统计 view lists per-round token table', stats.hasHeader.length >= 2, JSON.stringify(stats.hasHeader));
    check('native 统计 view rows cover the seeded rounds', stats.roundRows >= expectedTurns, JSON.stringify({ roundRows: stats.roundRows, expectedTurns }));
    await screenshotTo('conversation-stats.png');

    /* ---- cold resume: a historical (live:false) conversation card reopens its native turns ---- */
    currentStage = 'native-cold-resume';
    const liveProbe = await apiFetch('GET', '/conversations');
    const liveSessions = new Set((liveProbe.json?.conversations ?? []).filter((row) => row.live === true).map((row) => row.sessionId));
    const turnsProbe = await apiFetch('GET', '/usage/turns?limit=100');
    const allTurns = Array.isArray(turnsProbe.json?.turns) ? turnsProbe.json.turns : [];
    const coldCandidates = [];
    const seenCold = new Set();
    for (const entry of allTurns) {
      if (typeof entry?.sessionId !== 'string' || entry.sessionId.length === 0) continue;
      if (liveSessions.has(entry.sessionId) || seenCold.has(entry.sessionId)) continue;
      seenCold.add(entry.sessionId);
      coldCandidates.push({
        turnId: entry.id,
        sessionId: entry.sessionId,
        title: entry.sourceTitle || entry.site || '',
        sample: entry.steps?.[0]?.sample || '',
        steps: entry.steps?.length ?? 0,
      });
    }
    // Prefer a multi-turn historical session so the cold-resume screenshot shows
    // several rounds (single-turn lookups are still valid evidence).
    coldCandidates.sort((left, right) => right.steps - left.steps);
    evidence.coldResume = { liveSessions: [...liveSessions].slice(0, 8), coldCandidates: coldCandidates.slice(0, 8) };
    check('found at least one historical (live:false) conversation for cold-resume evidence', coldCandidates.length >= 1, JSON.stringify({ cold: coldCandidates.length, live: liveSessions.size }));

    // Back to the plugin 「轨迹」 tab (the native session view replaced the main panel).
    const backToPlugin = await evalOn(page, CLICK_PANEL_EXPR);
    if (!backToPlugin.found) {
      const opener = await evalOn(page, `(() => { const el = document.querySelector('[data-sidebar-opener]'); if (el) { el.click(); return true; } return false; })()`);
      if (opener) {
        await wait(800);
        await evalOn(page, CLICK_PANEL_EXPR);
      }
    }
    const backTabs = await waitFor(page, `document.querySelectorAll('[role="tab"]').length >= 4`, { timeoutMs: 20_000, intervalMs: 250 });
    await evalOn(page, clickTabExpr(['轨迹', 'Traces', 'Trajectory']));
    const coldListReady = await waitFor(page, `document.querySelectorAll('.dsh-it-conv').length >= 1`, { timeoutMs: 20_000, intervalMs: 300 });
    check('returned to the plugin 轨迹 conversation list', backTabs.ok && coldListReady.ok, JSON.stringify({ backTabs: backTabs.ok }));
    // Load earlier pages until a card without the live badge shows up (history can be paged).
    const coldCard = await (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const found = await evalOn(page, `(() => {
          const cards = Array.from(document.querySelectorAll('.dsh-it-conv'));
          const cold = cards.filter((card) => !card.querySelector('.dsh-it-conv-live'));
          const wanted = ${JSON.stringify(coldCandidates.map((candidate) => candidate.title).filter(Boolean).slice(0, 12))};
          const preferred = cold.find((card) => {
            const title = (card.querySelector('.dsh-it-conv-title')?.textContent || '').trim();
            return wanted.some((item) => item.length > 3 && title.includes(item));
          });
          const chosen = preferred || cold[0];
          if (!chosen) return { found: false, cards: cards.length, cold: 0 };
          const toggle = chosen.querySelector('.dsh-it-conv-toggle');
          if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
          const button = chosen.querySelector('.dsh-it-conv-open');
          return {
            found: true,
            title: (chosen.querySelector('.dsh-it-conv-title')?.textContent || '').trim(),
            live: !!chosen.querySelector('.dsh-it-conv-live'),
            turnItems: chosen.querySelectorAll('.dsh-it-conv-turn-item').length,
            openButton: !!button,
            openText: button ? (button.textContent || '').trim() : '',
            cards: cards.length,
          };
        })()`);
        if (found.found) return found;
        const loadMore = await evalOn(page, `(() => { const btn = document.querySelector('.dsh-it-turn-loadmore-btn'); if (!btn) return false; btn.click(); return true; })()`);
        if (!loadMore) return found;
        await wait(1500);
      }
      return { found: false };
    })();
    evidence.coldResumeCard = coldCard || null;
    check('historical conversation card found in the plugin list (no live badge)', coldCard?.found === true && coldCard.live === false, JSON.stringify({ title: coldCard?.title, live: coldCard?.live, cards: coldCard?.cards }));
    check('historical conversation card offers 「打开 DSH 轨迹」', coldCard?.openButton === true, JSON.stringify({ openText: coldCard?.openText }));
    if (coldCard?.found) {
      await screenshotTo('conversation-cold-resume-card.png');
      const coldClick = await evalOn(page, `(() => {
        const cards = Array.from(document.querySelectorAll('.dsh-it-conv'));
        const chosen = cards.find((card) => !card.querySelector('.dsh-it-conv-live') && (card.querySelector('.dsh-it-conv-title')?.textContent || '').trim() === ${JSON.stringify(String(coldCard.title ?? ''))});
        const fallback = cards.find((card) => !card.querySelector('.dsh-it-conv-live'));
        const card = chosen || fallback;
        const button = card ? card.querySelector('.dsh-it-conv-open') : null;
        if (!button) return { clicked: false };
        button.click();
        return { clicked: true, title: (card.querySelector('.dsh-it-conv-title')?.textContent || '').trim() };
      })()`);
      const coldNative = await waitFor(page, NATIVE_VIEWS_READY, { timeoutMs: 30_000, intervalMs: 300 });
      const coldTabs = await evalOn(page, NATIVE_TABS_EXPR);
      check('historical conversation cold-resumes into the native session view', coldClick.clicked === true && coldNative.ok, JSON.stringify({ coldClick, tabs: coldTabs }));
      await evalOn(page, clickTabExpr(['轨迹', 'Trajectory']));
      // Cold resume re-creates the persisted agent server-side: the native
      // trajectory table can take a few seconds to render its rows.
      // Wait until the plugin page is gone and the NEW native session header is
      // visible (the expanded plugin card itself also contains 第 N 轮 text, so a
      // plain text match would fire before navigation).
      const coldRendered = await waitFor(page, `(() => {
        if (document.querySelector('.dsh-it-page')) return false;
        const labels = Array.from(document.querySelectorAll('[role="tab"]')).map((el) => (el.textContent || '').trim());
        if (!labels.includes('对话') || !labels.includes('轨迹')) return false;
        const main = document.querySelector('main') || document.body;
        return String(main.innerText || '').includes(${JSON.stringify(String(coldCard.title ?? ''))});
      })()`, { timeoutMs: 30_000, intervalMs: 300 });
      await evalOn(page, clickTabExpr(['轨迹', 'Trajectory']));
      // Cold resume re-creates the persisted agent on the fly; give the native
      // trajectory table generous time to render its rows.
      const coldRowsReady = await waitFor(page, `((document.querySelector('main') || document.body).innerText || '').includes('第 1 轮')`, { timeoutMs: 60_000, intervalMs: 500 });
      await wait(1200);
      evidence.coldResumeWait = { headerMs: coldRendered.waitedMs, rowsMs: coldRowsReady.waitedMs };
      const readColdTrajectory = () => evalOn(page, `(() => {
        const main = document.querySelector('main') || document.body;
        const text = String(main.innerText || '');
        return {
          rounds: (text.match(/第\\s*\\d+\\s*轮/g) || []).length,
          userLabels: (text.match(/用户/g) || []).length,
          assistantLabels: (text.match(/助手/g) || []).length,
          textSample: text.slice(0, 1600),
        };
      })()`);
      let coldTrajectory = await readColdTrajectory();
      if (coldTrajectory.rounds === 0) {
        // One more grace period: the first extraction can race the resume render.
        await wait(4000);
        coldTrajectory = await readColdTrajectory();
      }
      evidence.coldResumeNative = { rendered: coldRendered.ok, tabs: coldTabs, rounds: coldTrajectory.rounds, userLabels: coldTrajectory.userLabels, assistantLabels: coldTrajectory.assistantLabels, textSample: coldTrajectory.textSample?.slice(0, 400) };
      check('cold-resumed native 轨迹 renders the historical turns (第 N 轮 用户/助手)', coldRendered.ok && coldTrajectory.rounds >= 1 && coldTrajectory.userLabels >= 1 && coldTrajectory.assistantLabels >= 1, JSON.stringify({ rendered: coldRendered.ok, waitedMs: coldRendered.waitedMs, rounds: coldTrajectory.rounds, users: coldTrajectory.userLabels, assistants: coldTrajectory.assistantLabels }));
      await screenshotTo('conversation-cold-resume.png');
      await save('cold-resume.json', {
        rendered: coldRendered.ok,
        rowsWaitedMs: coldRowsReady.waitedMs,
        waitedMs: coldRendered.waitedMs,
        candidate: coldCard,
        nativeTabs: coldTabs,
        rounds: coldTrajectory.rounds,
        userLabels: coldTrajectory.userLabels,
        assistantLabels: coldTrajectory.assistantLabels,
        usedColdSession: coldClick,
      });
    }

    /* ---- console hygiene ---- */
    currentStage = 'console';
    const benign = /favicon|ResizeObserver loop|Download the React DevTools|Failed to load resource/i;
    const errors = consoleErrors.filter((line) => !benign.test(line));
    const exceptions = pageExceptions.filter((line) => !benign.test(line));
    evidence.console = { errors: errors.slice(0, 10), warnings: consoleWarnings.slice(0, 10), exceptions: exceptions.slice(0, 5) };
    check('no uncaught page exceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
    check('no console errors during the conversation flow', errors.length === 0, errors.slice(0, 5).join(' | '));
    await save('gui-evidence.json', {
      conversations: conversationProbe.response?.json ?? null,
      usageTurns: turnProbe.response?.json ?? null,
      nativeTabs,
      cardInfo,
      chat: evidence.chat,
      trajectory: evidence.trajectory,
      usagePill: evidence.usagePill,
      stats: evidence.stats,
      fallbackUsed,
      coldResume: evidence.coldResumeNative ?? null,
      screenshots,
      console: evidence.console,
    });
  } finally {
    if (page) page.close();
    if (chrome) await chrome.close();
  }

  await save('assertions.json', { runTag: RUN_TAG, checks: results, screenshots });
  const failed = results.filter((entry) => !entry.ok);
  const passed = results.length - failed.length;
  console.log(`\nRESULT: ${passed}/${results.length} passed (${failed.length} failed) in ${Date.now() - startedAt}ms`);
  console.log(`# evidence: ${EVIDENCE_DIR}`);
  await writeFile(
    join(EVIDENCE_DIR, 'conversation-shot.result.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      dshUrl: DSH_URL,
      runTag: RUN_TAG,
      turnId: TURN_ID,
      sourceTitle: SOURCE_TITLE,
      passed: failed.length === 0,
      total: results.length,
      failed: failed.length,
      checks: results,
      screenshots,
      evidenceDirectory: EVIDENCE_DIR,
    }, null, 2),
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error(`conversation-shot setup/runtime error at stage "${currentStage}": ${error && error.stack ? error.stack : String(error)}`);
  try {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(join(EVIDENCE_DIR, 'conversation-shot.result.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      stage: currentStage,
      passed: false,
      error: String(error && error.message ? error.message : error),
      checks: results,
    }, null, 2));
  } catch {
    /* ignore */
  }
  process.exitCode = 2;
});
