#!/usr/bin/env node
/**
 * QA: headless-browser acceptance walkthrough of the DSH "dsh翻译" left
 * toolbar page (token usage / traces / settings / wordbook) on the live GUI.
 *
 * What it does (no writes to the DSH profile; temp Chrome profile only):
 *  1. launches headless Chrome with a throwaway profile;
 *  2. authenticates the page target against the live `dsh web` server
 *     (launch-token URL via DSH_URL, or an operator-supplied DSH_COOKIE; see
 *     qa/cdp.mjs — the helper never reads DSH credentials);
 *  3. boots the dashboard, clicks the sidebar.panellist entry
 *     dsh翻译 / dsh-web-translator, asserts the main panel switched and the
 *     entry shows an active state;
 *  4. asserts the four tabs (概览/轨迹/设置/单词本), captures PNG screenshots for
 *     overview, Turn traces, expanded Turn, settings, wordbook (light) + dark
 *     attempt, and records console errors/warnings + /dsh-immersive/api codes;
 *     the 轨迹 assertions cover the Turn-trace redesign (DESIGN-TURN-TRACE §3):
 *     DSH-like Turn cards, newest auto-expanded, expandable steps with input /
 *     output samples, step-detail expansion, and 「加载更早」paging;
 *  5. cross-checks the overview 今日 values against a same-moment
 *     `GET /usage` (curl-equivalent from Node) and the model chip against
 *     `GET /settings`;
 *  6. seeds a deterministic 3-batch Turn (same turnId, stepIndex 0..2, mode)
 *     through the HTTP API, then verifies it renders as ONE Turn card with 3
 *     expandable steps, and cross-checks the panel page against
 *     GET /usage/turns?limit=20 (cards == page size, hasMore -> load-more);
 *  7. optionally (`--settings-roundtrip`) saves a systemPrompt edit through the
 *     设置 tab UI, verifies it via GET /settings, then ALWAYS restores the
 *     original prompt over HTTP in a finally block;
 *  8. cross-checks the 单词本 tab against `GET /wordbook` when entries exist.
 *
 * Usage: node qa/panel-shot.mjs [--allow-console-errors] [--settings-roundtrip]
 * Env:   DSH_URL  GUI URL (default http://127.0.0.1:3080; may carry ?token=)
 *        DSH_WEB_URL  fallback
 *        CHROME_BIN   Chrome executable override
 *
 * Exit code 0 = all checks passed; 1 = at least one FAIL; 2 = setup error.
 * QA-only script: writes only under qa/.
 */
import { writeFile } from 'node:fs/promises';
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
const DSH_URL = (process.env.DSH_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').trim();
const DSH_ORIGIN = new URL(DSH_URL).origin;
const API_BASE = `${DSH_ORIGIN}/dsh-immersive/api`;
const ALLOW_CONSOLE_ERRORS = process.argv.includes('--allow-console-errors');
const SETTINGS_ROUNDTRIP = process.argv.includes('--settings-roundtrip');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 800) });
  const suffix = detail === undefined ? '' : `  [${String(detail).slice(0, 400)}]`;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${suffix}`);
}

/** Labels the plugin panel may be registered under (zh / en dictionaries). */
const PANEL_LABEL_RE = /dsh翻译|Immersive\s*Translate/i;
/** Expected tab labels per locale. */
const TAB_SETS = [
  ['概览', '轨迹', '设置', '单词本'],
  ['Overview', 'Traces', 'Settings', 'Wordbook'],
  ['Overview', 'Traces', 'Settings', 'Word book'],
];
/** Labels for a tab, given its canonical names. */
const TAB_ALIASES = {
  overview: ['概览', 'Overview'],
  traces: ['轨迹', 'Traces', 'Trajectory', 'Trace'],
  settings: ['设置', 'Settings'],
  wordbook: ['单词本', 'Wordbook', 'Word book', 'Words'],
};

const TABS_QUERY = `(() => Array.from(document.querySelectorAll('[role="tab"]')).map((el) => ({
  text: (el.textContent || '').trim().replace(/\\s+/g, ' '),
  selected: el.getAttribute('aria-selected') === 'true',
  controls: el.getAttribute('aria-controls') || '',
})))()`;

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
  if (hit === -1) {
    return {
      found: false,
      samples: all.filter((entry) => entry.label || entry.text).slice(0, 80),
      sidebarPresent: !!(document.querySelector('[data-sidebar-toggle], [data-sidebar-opener]')),
      bodyText: (document.body.innerText || '').slice(0, 400),
    };
  }
  const el = buttons[hit];
  el.scrollIntoView({ block: 'center' });
  el.click();
  return { found: true, label: all[hit].label || all[hit].text };
})()`;

/** Click the tab whose label matches one of the aliases (by role=tab). */
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

/** Main content summaries used for assertions / report evidence. */
const PAGE_STATE_EXPR = `(() => {
  const main = document.querySelector('main') || document.body;
  const text = (main.innerText || '').slice(0, 8000);
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panelButton = Array.from(document.querySelectorAll('button')).find((el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    const content = (el.textContent || '').trim();
    return ${PANEL_LABEL_RE.toString()}.test(label) || ${PANEL_LABEL_RE.toString()}.test(content);
  });
  const statCards = Array.from(document.querySelectorAll('.dsh-it-usage-stat')).map((el) => {
    const value = el.querySelector('.dsh-it-usage-stat-value');
    const label = el.querySelector('.dsh-it-usage-stat-label');
    return {
      value: value ? (value.textContent || '').trim() : '',
      exact: value ? (value.getAttribute('title') || '') : '',
      label: label ? (label.textContent || '').trim() : '',
    };
  });
  const todayChip = document.querySelector('.dsh-it-usage-today-chip');
  const modelChip = document.querySelector('.dsh-it-usage-model-chip');
  return {
    title: document.title,
    tabs: tabs.map((el) => (el.textContent || '').trim()),
    selectedTab: (tabs.find((el) => el.getAttribute('aria-selected') === 'true') || {}).textContent || '',
    panelButtonActive: panelButton ? panelButton.getAttribute('aria-current') === 'page' : null,
    hasTablist: !!document.querySelector('[role="tablist"]'),
    bodyText: text,
    hasHostOutdated: /Host\\s*版本过旧|Host version is too old|host version too old/i.test(text),
    hasLoadError: /加载失败|无法加载|加载统计失败|Failed to load|NetworkError/i.test(text),
    hasTokenText: /token|Token|tokens/i.test(text),
    selects: document.querySelectorAll('select').length,
    textareas: document.querySelectorAll('textarea').length,
    inputs: document.querySelectorAll('input').length,
    buttons: Array.from(document.querySelectorAll('main button, main [role="button"]')).map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 40),
    todayChip: todayChip ? { text: (todayChip.textContent || '').trim(), title: todayChip.getAttribute('title') || '' } : null,
    modelChip: modelChip ? (modelChip.textContent || '').trim() : null,
    todayStats: statCards,
    traceRows: document.querySelectorAll('.dsh-it-usage-row').length,
    expandedTraceDetails: document.querySelectorAll('.dsh-it-usage-detail, .dsh-it-usage-row-detail').length,
    turnCards: document.querySelectorAll('.dsh-it-turn').length,
    turnBodies: document.querySelectorAll('.dsh-it-turn-body').length,
    expandedTurnDetails: document.querySelectorAll('.dsh-it-turn-head[aria-expanded="true"]').length,
    stepRows: document.querySelectorAll('.dsh-it-steps-row').length,
    stepItems: document.querySelectorAll('.dsh-it-steps-item').length,
    stepPreviews: document.querySelectorAll('.dsh-it-steps-preview').length,
    loadMoreButton: !!document.querySelector('.dsh-it-turn-loadmore-btn'),
    filterOptions: document.querySelectorAll('select option').length,
    // v4 conversation list (DESIGN-CONVERSATIONS §3)
    conversationCards: document.querySelectorAll('.dsh-it-conv').length,
    conversationExpanded: document.querySelectorAll('.dsh-it-conv-toggle[aria-expanded="true"]').length,
    conversationTurnItems: document.querySelectorAll('.dsh-it-conv-turn-item').length,
    conversationOpenButtons: document.querySelectorAll('.dsh-it-conv-open').length,
    legacyGroupPresent: !!document.querySelector('.dsh-it-conv-legacy'),
    legacyGroupExpanded: document.querySelector('.dsh-it-conv-legacy-toggle')?.getAttribute('aria-expanded') === 'true',
    legacyGroupCount: (document.querySelector('.dsh-it-conv-legacy-count')?.textContent || '').trim(),
    legacyTurnCards: document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-turn').length,
    legacyStepItems: document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-steps-item').length,
    tabpanelCount: document.querySelectorAll('[role="tabpanel"]').length,
    clearButtons: Array.from(document.querySelectorAll('button')).map((el) => (el.textContent || '').trim()).filter((text) => /清空|Clear/i.test(text)).slice(0, 5),
  };
})()`;

/** Parse the today-tokens chip title into exact input/output numbers. */
function parseTodayChip(chip) {
  if (!chip || typeof chip.title !== 'string') return null;
  const zh = /输入\s*([\d,]+)\s*·\s*输出\s*([\d,]+)/.exec(chip.title);
  if (zh) return { input: Number(zh[1].replaceAll(',', '')), output: Number(zh[2].replaceAll(',', '')) };
  const en = /Today:\s*([\d,]+)\s*input\s*·\s*([\d,]+)\s*output/i.exec(chip.title);
  if (en) return { input: Number(en[1].replaceAll(',', '')), output: Number(en[2].replaceAll(',', '')) };
  const any = /([\d,]+)[^\d]+([\d,]+)/.exec(chip.title);
  if (any) return { input: Number(any[1].replaceAll(',', '')), output: Number(any[2].replaceAll(',', '')) };
  return null;
}

/** Parse a display number that may use compact form (1.2k / 3.4M). */
function parseCompactNumber(value) {
  const text = String(value ?? '').replaceAll(',', '').trim();
  const match = /^(-?\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (!Number.isFinite(number)) return null;
  return unit === 'k' ? Math.round(number * 1000) : unit === 'm' ? Math.round(number * 1_000_000) : number;
}

/** Call the installed plugin's HTTP API from Node (used for cross-checks). */
async function apiFetch(method, path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw: text.slice(0, 600) };
}

/**
 * Seed one deterministic 3-batch Turn through the live HTTP API: same turnId,
 * stepIndex 0..2 and mode=bilingual (DESIGN-TURN-TRACE §2.1). Unique texts/tags
 * avoid host caches, so all three /translate calls become real Steps.
 * @param {string} tag - unique run tag.
 * @returns {Promise<{turnId: string, sourceTitle: string, posted: number, responses: object[]}>}
 */
async function createSyntheticTurn(tag) {
  const turnId = `tr_qa_${tag}`;
  const sourceTitle = `QA trace turn ${tag}`;
  const created = { turnId, sourceTitle, posted: 0, responses: [] };
  for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
    const response = await apiFetch('POST', '/translate', {
      texts: [`QA trace step ${stepIndex} ${tag}`],
      targetLanguage: 'zh-CN',
      sourceUrl: `https://example.com/qa-trace-${tag}`,
      sourceTitle,
      client: 'qa',
      turnId,
      stepIndex,
      mode: 'bilingual',
    });
    created.responses.push({ stepIndex, status: response.status, cached: response.json?.cached });
    if (response.status === 200 && response.json?.ok === true) created.posted += 1;
  }
  return created;
}

/** Persist the machine-readable result next to the screenshots. */
async function writeFinalResult({ authMode, tabs, error, apiResponses, failedResources, consoleErrors, consoleWarnings, pageExceptions, screenshots, crossChecks, settingsRoundtrip, wordbook, runStartedAt }) {
  const failed = results.filter((entry) => !entry.ok);
  const okCount = results.length - failed.length;
  console.log(`\nRESULT: ${okCount}/${results.length} passed (${failed.length} failed) in ${Date.now() - runStartedAt}ms`);
  if (consoleWarnings.length > 0) console.log(`# console warnings: ${consoleWarnings.length} (recorded, not fatal)`);
  await writeFile(
    join(QA_DIR, 'panel-shot.result.json'),
    JSON.stringify(
      {
        url: DSH_URL,
        authMode,
        generatedAt: new Date().toISOString(),
        passed: failed.length === 0 && !error,
        error: error ?? null,
        checks: results,
        screenshots,
        tabs,
        crossChecks: crossChecks ?? null,
        settingsRoundtrip: settingsRoundtrip ?? null,
        wordbook: wordbook ?? null,
        apiResponses: (apiResponses || []).filter((entry) => entry.url.includes('/usage')).slice(0, 30),
        failedResources: (failedResources || []).filter((entry) => !/favicon/i.test(entry.url)).slice(0, 20),
        consoleErrors: (consoleErrors || []).slice(0, 30),
        consoleWarnings: (consoleWarnings || []).slice(0, 30),
        pageExceptions: (pageExceptions || []).slice(0, 10),
      },
      null,
      2,
    ),
  );
  return failed.length === 0 && !error ? 0 : 1;
}

/**
 * Optional systemPrompt UI save + restore roundtrip.
 * The original prompt is restored over HTTP in a finally block no matter what.
 */
async function exerciseSettingsRoundtrip(page, apiResponses) {
  const info = { changed: false, restored: false, originalPrompt: null, savedPrompt: null, error: null };
  let originalSettings = null;
  let originalSelectedSource = null;
  try {
    const before = await apiFetch('GET', '/settings');
    if (before.status !== 200 || before.json?.ok !== true || !before.json.settings) {
      check('settings roundtrip: GET /settings reachable', false, `status=${before.status} body=${before.raw}`);
      return info;
    }
    originalSettings = before.json.settings;
    originalSelectedSource = before.json.selected?.source;
    info.originalPrompt = typeof originalSettings.systemPrompt === 'string' ? originalSettings.systemPrompt : '';
    check('settings roundtrip: GET /settings reachable', true, `source=${originalSelectedSource}`);
    if (info.originalPrompt.length === 0) {
      check('settings roundtrip: original systemPrompt available', false, 'empty systemPrompt');
      return info;
    }

    // Make sure the 设置 tab is selected and the prompt editor rendered.
    await evalOn(page, clickTabExpr(TAB_ALIASES.settings));
    const editorReady = await waitFor(page, `document.querySelectorAll('textarea').length >= 2`, { timeoutMs: 15_000, intervalMs: 250 });
    check('settings roundtrip: prompt editors rendered', editorReady.ok, `waited=${editorReady.waitedMs}ms`);

    const marker = '[qa-roundtrip] ';
    info.savedPrompt = marker + info.originalPrompt;
    const filled = await evalOn(page, `(() => {
      const wanted = /系统提示词|System prompt/i;
      const textarea = Array.from(document.querySelectorAll('textarea')).find((el) => wanted.test(el.getAttribute('aria-label') || ''));
      if (!textarea) return { found: false, labels: Array.from(document.querySelectorAll('textarea')).map((el) => el.getAttribute('aria-label') || '') };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(info.savedPrompt)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return { found: true, valueLength: textarea.value.length };
    })()`);
    check('settings roundtrip: systemPrompt textarea found and edited', filled?.found === true, JSON.stringify(filled));

    const clicked = await evalOn(page, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((el) => /保存设置|Save settings/i.test((el.textContent || '').trim()));
      if (!button) return { clicked: false, buttons: Array.from(document.querySelectorAll('button')).map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 60) };
      button.click();
      return { clicked: true, text: (button.textContent || '').trim() };
    })()`);
    check('settings roundtrip: save button clicked', clicked?.clicked === true, JSON.stringify(clicked));

    const savedNotice = await waitFor(page, `/设置已保存|Settings saved/.test(document.body.innerText || '')`, { timeoutMs: 15_000, intervalMs: 250 });
    check('settings roundtrip: UI shows saved notice', savedNotice.ok, `waited=${savedNotice.waitedMs}ms`);
    if (savedNotice.ok) await screenshot(page, join(QA_DIR, 'token-stats-settings-saved.png'));

    const after = await apiFetch('GET', '/settings');
    const savedValue = after.json?.settings?.systemPrompt;
    info.changed = typeof savedValue === 'string' && savedValue.startsWith(marker);
    check(
      'settings roundtrip: systemPrompt persisted via UI save',
      info.changed,
      `status=${after.status} startsWithMarker=${info.changed} len=${typeof savedValue === 'string' ? savedValue.length : 'n/a'}`,
    );
    return info;
  } catch (error) {
    info.error = String(error && error.message ? error.message : error);
    check('settings roundtrip: completed UI save flow', false, info.error);
    return info;
  } finally {
    // ALWAYS restore the original prompt over HTTP.
    if (originalSettings !== null && info.originalPrompt !== null) {
      try {
        const restore = await apiFetch('PUT', '/settings', { systemPrompt: info.originalPrompt });
        const verify = await apiFetch('GET', '/settings');
        const restoredPrompt = verify.json?.settings?.systemPrompt;
        const untouched = ['provider', 'model', 'reasoningEffort', 'targetLanguage', 'userTemplate'].every((key) => {
          if (originalSettings[key] === undefined) return true;
          return verify.json?.settings?.[key] === originalSettings[key] || String(verify.json?.settings?.[key] ?? '') === String(originalSettings[key] ?? '');
        });
        info.restored = restore.status === 200 && restoredPrompt === info.originalPrompt && untouched;
        check('settings roundtrip: original systemPrompt restored', info.restored, `PUT=${restore.status} provider=${verify.json?.selected?.provider}`);
      } catch (error) {
        check('settings roundtrip: original systemPrompt restored', false, String(error && error.message));
      }
    }
  }
}

async function main() {
  const runStartedAt = Date.now();
  console.log(`# panel-shot: ${DSH_URL}${SETTINGS_ROUNDTRIP ? ' (settings roundtrip enabled)' : ''}`);
  let chrome;
  let page;
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageExceptions = [];
  const apiResponses = [];
  const failedResources = [];
  const screenshots = [];
  const crossChecks = {};
  let settingsRoundtrip = null;
  let wordbook = null;
  const shot = async (name) => {
    const path = join(QA_DIR, name);
    await screenshot(page, path);
    screenshots.push(name);
    return path;
  };

  try {
    chrome = await launchChrome({ label: 'dsh-qa-panel', windowSize: '1440,960' });
    const baseHttp = `http://127.0.0.1:${chrome.port}`;
    const target = await openPageTarget(baseHttp, 'about:blank');
    page = new CDP(target.webSocketDebuggerUrl, { commandTimeoutMs: 45_000 });
    await page.connect();
    page.on('Runtime.exceptionThrown', (params) => {
      pageExceptions.push(JSON.stringify(params.exceptionDetails).slice(0, 500));
    });
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
    page.on('Network.responseReceived', (params) => {
      const response = params.response || {};
      if (typeof response.url !== 'string') return;
      if (response.status >= 400) failedResources.push({ url: response.url, status: response.status });
      if (response.url.includes('/dsh-immersive/api/')) {
        apiResponses.push({ url: response.url, status: response.status });
      }
    });

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Log.enable');

    // 1) Authenticate before navigation.
    let authMode = 'unknown';
    try {
      const auth = await authenticateDshPage(page, DSH_URL);
      authMode = auth.mode;
      check('DSH GUI auth prepared', true, authMode === 'cookie' ? 'DSH_COOKIE supplied by the operator' : 'launch-token URL');
    } catch (error) {
      check('DSH GUI auth prepared', false, error && error.message ? error.message : String(error));
      throw error;
    }

    // 2) Navigate and wait for the DSH shell (sidebar) to render.
    await page.send('Page.navigate', { url: DSH_URL });
    const boot = await waitFor(page, `document.readyState === 'complete' && !!document.querySelector('[data-sidebar-toggle], [data-sidebar-opener], [data-platform]')`, { timeoutMs: 45_000, intervalMs: 300 });
    check('DSH dashboard booted (sidebar shell)', boot.ok, boot.ok ? `after ${boot.waitedMs}ms` : `not booted after ${boot.waitedMs}ms`);
    const warningsAtBoot = consoleWarnings.length;
    crossChecks.bootConsole = { errors: consoleErrors.length, warnings: warningsAtBoot };

    // Capture the main area before clicking the panel (to prove the click switches it).
    const beforeClickMain = await evalOn(page, `(() => ((document.querySelector('main') || document.body).innerText || '').slice(0, 3000))()`);
    crossChecks.mainBeforeClick = String(beforeClickMain).slice(0, 500);

    // 3) Click the plugin's left-toolbar entry.
    let clicked = await evalOn(page, CLICK_PANEL_EXPR);
    if (!clicked.found) {
      // The sidebar may be closed as a drawer on narrow/drawer layouts: open it once, retry.
      const opened = await evalOn(page, `(() => {
        const opener = document.querySelector('[data-sidebar-opener]');
        if (opener) { opener.click(); return true; }
        return false;
      })()`);
      if (opened) {
        await wait(800);
        clicked = await evalOn(page, CLICK_PANEL_EXPR);
      }
    }
    check('sidebar.panellist entry dsh翻译 found', clicked.found, clicked.found ? clicked.label : `sidebarPresent=${clicked.sidebarPresent}; candidates=${JSON.stringify(clicked.samples).slice(0, 500)}`);
    if (!clicked.found) {
      await shot('token-stats-panel-not-found.png').catch(() => {});
      await writeFinalResult({ authMode, tabs: [], error: 'immersive-translate sidebar entry not found: plugin panel not registered in this GUI (old plugin?)', apiResponses, failedResources, consoleErrors, consoleWarnings, pageExceptions, screenshots, crossChecks, settingsRoundtrip, wordbook, runStartedAt });
      return 1;
    }

    // 4) Wait for the page tabs.
    const tabsWait = await waitFor(page, `${TABS_QUERY}.length >= 4`, { timeoutMs: 25_000, intervalMs: 250 });
    const tabs = await evalOn(page, TABS_QUERY);
    const tabTexts = tabs.map((tab) => tab.text);
    const matchedTabSet = TAB_SETS.find((expected) => expected.every((label, index) => tabTexts[index] === label) || expected.every((label) => tabTexts.includes(label)));
    check('panel tab bar has 4 tabs', tabsWait.ok && tabs.length === 4, JSON.stringify(tabTexts));
    check('panel tabs are 概览/轨迹/设置/单词本', !!matchedTabSet, JSON.stringify(tabTexts));
    check('panel tablist uses role=tablist', await evalOn(page, `!!document.querySelector('[role="tablist"]')`));
    const afterClickMain = await evalOn(page, `(() => ((document.querySelector('main') || document.body).innerText || '').slice(0, 3000))()`);
    check(
      'clicking sidebar icon switches the main panel',
      String(afterClickMain).includes('概览') || String(afterClickMain).includes('Overview') || String(afterClickMain).includes('今日') || String(afterClickMain).includes('Today'),
      `beforeLen=${String(beforeClickMain).length} afterLen=${String(afterClickMain).length}`,
    );
    check('sidebar icon shows active state (aria-current=page)', (await evalOn(page, PAGE_STATE_EXPR)).panelButtonActive === true);

    // 5) Overview: wait for usage data, screenshot, cross-check against GET /usage.
    await wait(1200);
    let state = await evalOn(page, PAGE_STATE_EXPR);
    check('overview tab selected after opening', /概览|Overview/.test(state.selectedTab), state.selectedTab);
    check('overview shows token stats content', state.hasTokenText || /今日|Today/.test(state.bodyText), state.bodyText.slice(0, 200));
    check('overview does NOT show "Host 版本过旧"', !state.hasHostOutdated, state.hasHostOutdated ? 'host usage API returned 404: plugin/host mismatch' : '');
    check('overview has no load-error text', !state.hasLoadError, state.hasLoadError ? state.bodyText.slice(0, 300) : '');
    check('overview renders today-tokens chip', !!state.todayChip, JSON.stringify(state.todayChip));
    check('overview renders model chip', !!state.modelChip, String(state.modelChip));
    check('overview renders today stat cards', state.todayStats.length >= 4, JSON.stringify(state.todayStats));
    await shot('token-stats-panel.png');

    // Same-moment cross-check: panel 今日 values vs GET /usage (and model chip vs /settings).
    // The live ledger may be written concurrently by the real extension, so a
    // sample can land between the panel's last poll and our HTTP read: retry a
    // few times and accept the first exact match, recording every attempt.
    try {
      let matched = null;
      let lastSample = null;
      for (let attempt = 1; attempt <= 4 && matched === null; attempt += 1) {
        const panelState = attempt === 1 ? state : await evalOn(page, PAGE_STATE_EXPR);
        const usageNow = await apiFetch('GET', '/usage?days=14');
        const settingsNow = await apiFetch('GET', '/settings');
        const today = usageNow.json?.usage?.today;
        const selected = settingsNow.json?.selected;
        const chip = parseTodayChip(panelState.todayChip);
        const statValue = (index) => parseCompactNumber(panelState.todayStats[index]?.exact || panelState.todayStats[index]?.value);
        const chipOk = usageNow.status === 200 && !!today && !!chip && chip.input === today.inputTokens && chip.output === today.outputTokens;
        const cardsOk =
          usageNow.status === 200 &&
          !!today &&
          panelState.todayStats.length >= 5 &&
          statValue(0) === today.requests &&
          statValue(1) === today.inputTokens &&
          statValue(2) === today.outputTokens &&
          statValue(3) === today.cacheReadTokens &&
          statValue(4) === today.errors;
        const modelOk =
          settingsNow.status === 200 &&
          typeof selected?.provider === 'string' &&
          selected.provider.length > 0 &&
          typeof panelState.modelChip === 'string' &&
          panelState.modelChip.includes(selected.provider) &&
          panelState.modelChip.includes(selected.model);
        lastSample = {
          attempt,
          usageStatus: usageNow.status,
          chip,
          today: today && { requests: today.requests, inputTokens: today.inputTokens, outputTokens: today.outputTokens, cacheReadTokens: today.cacheReadTokens, errors: today.errors },
          todayStatValues: panelState.todayStats.slice(0, 5).map((card) => ({ label: card.label, value: card.value, exact: card.exact })),
          modelChip: panelState.modelChip,
          selected: selected ? { provider: selected.provider, model: selected.model } : null,
          chipOk,
          cardsOk,
          modelOk,
        };
        if (chipOk && cardsOk && modelOk) matched = lastSample;
        else if (attempt < 4) await wait(1600);
      }
      crossChecks.usage = lastSample;
      const attemptsUsed = lastSample?.attempt ?? 0;
      if (attemptsUsed > 1) console.log(`# cross-check matched after ${attemptsUsed} sample(s) (concurrent ledger traffic)`);
      check('cross-check: 今日 chip input/output tokens == GET /usage today', matched?.chipOk === true, JSON.stringify({ attempt: attemptsUsed, chip: lastSample?.chip, today: lastSample?.today }));
      check('cross-check: overview 今日 stat cards == GET /usage today (requests/input/output/cacheRead/errors)', matched?.cardsOk === true, JSON.stringify({ attempt: attemptsUsed, statValues: lastSample?.todayStatValues, today: lastSample?.today }));
      check('cross-check: model chip shows GET /settings selected provider/model', matched?.modelOk === true, JSON.stringify({ modelChip: lastSample?.modelChip, selected: lastSample?.selected && `${lastSample.selected.provider}/${lastSample.selected.model}` }));
    } catch (error) {
      check('cross-check: panel 今日 values vs GET /usage', false, String(error && error.message ? error.message : error));
    }

    // 6) 轨迹 tab: v4 conversation list (DESIGN-CONVERSATIONS §3).
    // Seed one deterministic 3-batch run (one turnId → one DSH conversation with
    // 3 native turns/steps) so the conversation card and legacy group are stable.
    const turnTag = `qa-panel-${Date.now().toString(36)}`;
    let syntheticTurn = null;
    try {
      syntheticTurn = await createSyntheticTurn(turnTag);
      crossChecks.syntheticTurn = syntheticTurn;
      check('synthetic 3-step turn seeded via POST /translate (turnId/stepIndex/mode)', syntheticTurn.posted === 3, JSON.stringify({ turnId: syntheticTurn.turnId, posted: syntheticTurn.posted, responses: syntheticTurn.responses }));
    } catch (error) {
      check('synthetic 3-step turn seeded via POST /translate (turnId/stepIndex/mode)', false, String(error && error.message ? error.message : error));
    }
    const tracesClick = await evalOn(page, clickTabExpr(TAB_ALIASES.traces));
    const convReady = await waitFor(page, `document.querySelectorAll('.dsh-it-conv').length >= 1`, { timeoutMs: 25_000, intervalMs: 250 });
    await wait(900);
    state = await evalOn(page, PAGE_STATE_EXPR);
    check('traces tab opened', tracesClick.clicked && /轨迹|Traces/.test(state.selectedTab), JSON.stringify({ click: tracesClick, selected: state.selectedTab }));
    check('轨迹 renders a conversation list (v4 `.dsh-it-conv` cards, not flat requests)', convReady.ok && state.conversationCards >= 1, `cards=${state.conversationCards} waited=${convReady.waitedMs}ms`);
    check('Turn-capable Host: legacy flat-request notice NOT shown', !state.hasHostOutdated, state.hasHostOutdated ? 'Host version too old: /usage/turns 404 -> flat request list' : '');
    check('轨迹 keeps the legacy group for turns without a DSH session', state.legacyGroupPresent === true, JSON.stringify({ legacyGroupPresent: state.legacyGroupPresent, count: state.legacyGroupCount }));
    check('traces tab renders (no load error)', !state.hasLoadError, state.hasLoadError ? state.bodyText.slice(0, 300) : '');
    check('traces tab keeps filter controls (全部/翻译/查词/仅失败 or en)', state.filterOptions >= 4 || /全部|翻译|查词|仅失败|All|Translate|Lookup|Errors/.test(state.bodyText), JSON.stringify({ filterOptions: state.filterOptions, buttons: state.buttons.slice(0, 12) }));
    check('traces tab shows clear-stats control', state.clearButtons.length > 0, JSON.stringify(state.clearButtons));
    await shot('token-stats-traces-turns.png');

    // Cross-check the panel list against the live API page.
    const turnApi = await apiFetch('GET', '/usage/turns?limit=100');
    const apiTurns = Array.isArray(turnApi.json?.turns) ? turnApi.json.turns : [];
    const apiSessions = new Set(apiTurns.filter((turn) => typeof turn?.sessionId === 'string' && turn.sessionId.length > 0).map((turn) => turn.sessionId));
    const apiLegacyTurns = apiTurns.filter((turn) => !turn.sessionId).length;
    crossChecks.conversations = {
      status: turnApi.status,
      panelCards: state.conversationCards,
      apiSessions: apiSessions.size,
      apiTurns: apiTurns.length,
      apiLegacyTurns,
      panelLegacyCount: state.legacyGroupCount,
      panelTurnItems: state.conversationTurnItems,
    };
    check(
      'cross-check: conversation cards == distinct sessions in /usage/turns page (limit 100, +-2 traffic tolerance)',
      turnApi.status === 200 && Math.abs(state.conversationCards - apiSessions.size) <= 2 && state.conversationCards >= 1,
      JSON.stringify(crossChecks.conversations),
    );
    check(
      'cross-check: legacy group count == turns without sessionId on the /usage/turns page',
      apiLegacyTurns === 0 ? state.legacyGroupPresent === false : state.legacyGroupCount === String(apiLegacyTurns),
      JSON.stringify({ apiLegacyTurns, panelLegacyCount: state.legacyGroupCount }),
    );

    // Newest conversation is auto-expanded, with compact turn rows + native hint.
    const autoExpand = await evalOn(page, `(() => {
      const card = document.querySelector('.dsh-it-conv');
      if (!card) return { cards: 0 };
      const toggle = card.querySelector('.dsh-it-conv-toggle');
      return {
        cards: document.querySelectorAll('.dsh-it-conv').length,
        firstExpanded: toggle ? toggle.getAttribute('aria-expanded') === 'true' : null,
        firstBody: !!card.querySelector('.dsh-it-conv-body'),
        firstTurnItems: card.querySelectorAll('.dsh-it-conv-turn-item').length,
        nativeHint: !!(card.querySelector('.dsh-it-conv-native-hint')),
        expandedCount: document.querySelectorAll('.dsh-it-conv-toggle[aria-expanded="true"]').length,
      };
    })()`);
    crossChecks.conversationAutoExpand = autoExpand;
    check('newest conversation expanded by default (aria-expanded + body + turn rows)', autoExpand.firstExpanded === true && autoExpand.firstBody === true && autoExpand.firstTurnItems >= 1, JSON.stringify(autoExpand));
    check('expanded conversation shows the native-trajectory hint', autoExpand.nativeHint === true, JSON.stringify(autoExpand));

    // The seeded runs are on ONE conversation card with THREE turn rows + open button.
    if (syntheticTurn !== null) {
      const syntheticCard = await evalOn(page, `(() => {
        const cards = Array.from(document.querySelectorAll('.dsh-it-conv'));
        const card = cards.find((el) => (el.innerText || '').includes(${JSON.stringify('QA trace turn ' + turnTag)}))
          || cards.find((el) => (el.innerText || '').includes(${JSON.stringify(String(syntheticTurn.sourceTitle))}));
        if (!card) return { found: false, cards: cards.length, titles: cards.map((el) => ((el.querySelector('.dsh-it-conv-title') || {}).textContent || '').trim()).slice(0, 8) };
        const toggle = card.querySelector('.dsh-it-conv-toggle');
        if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
        return {
          found: true,
          expanded: toggle ? toggle.getAttribute('aria-expanded') === 'true' : null,
          turnItems: card.querySelectorAll('.dsh-it-conv-turn-item').length,
          turnNumbers: Array.from(card.querySelectorAll('.dsh-it-conv-turn-seq')).map((el) => (el.textContent || '').trim()),
          openButton: !!card.querySelector('.dsh-it-conv-open'),
          openText: (card.querySelector('.dsh-it-conv-open')?.textContent || '').trim(),
          openAria: card.querySelector('.dsh-it-conv-open')?.getAttribute('aria-label') || '',
          title: (card.querySelector('.dsh-it-conv-title')?.textContent || '').trim(),
          text: (card.innerText || '').slice(0, 600),
        };
      })()`);
      crossChecks.syntheticConversationCard = syntheticCard;
      check('seeded 3-batch run collapses into ONE conversation card with 3 turn rows', syntheticCard.found === true && syntheticCard.turnItems === 3, JSON.stringify({ found: syntheticCard.found, turnItems: syntheticCard.turnItems, titles: syntheticCard.titles }));
      check(
        'conversation card exposes 「打开 DSH 轨迹」 button (uiWorkspace available)',
        syntheticCard.openButton === true && /打开 DSH 轨迹|Open DSH trajectory/.test(syntheticCard.openText),
        JSON.stringify({ openText: syntheticCard.openText, openAria: syntheticCard.openAria }),
      );
      await shot('token-stats-traces-turn-expanded.png');
    }

    // Clicking a conversation header expands another conversation card.
    const toggleConv = await evalOn(page, `(() => {
      const toggles = Array.from(document.querySelectorAll('.dsh-it-conv-toggle'));
      const toggle = toggles.find((el) => el.getAttribute('aria-expanded') !== 'true') || toggles[0];
      if (!toggle) return { clicked: false, toggles: toggles.length };
      toggle.click();
      return { clicked: true, toggles: toggles.length };
    })()`);
    await wait(700);
    const afterConvToggle = await evalOn(page, PAGE_STATE_EXPR);
    crossChecks.conversationExpand = { clicked: toggleConv, cards: afterConvToggle.conversationCards, expanded: afterConvToggle.conversationExpanded, turnItems: afterConvToggle.conversationTurnItems };
    check('clicking a conversation header expands its turn rows', toggleConv.clicked === true && afterConvToggle.conversationExpanded >= 1, JSON.stringify(crossChecks.conversationExpand));

    // Legacy group: expand it and verify the inline Turn cards (v3 UI) still work.
    const legacyToggle = await evalOn(page, `(() => {
      const toggle = document.querySelector('.dsh-it-conv-legacy-toggle');
      if (!toggle) return { clicked: false };
      toggle.click();
      return { clicked: true };
    })()`);
    await wait(800);
    const legacyState = await evalOn(page, PAGE_STATE_EXPR);
    crossChecks.legacyGroup = { toggle: legacyToggle, expanded: legacyState.legacyGroupExpanded, turnCards: legacyState.legacyTurnCards, stepItems: legacyState.legacyStepItems };
    check('legacy group expands to the inline Turn cards (.dsh-it-turn)', legacyToggle.clicked === true && legacyState.legacyGroupExpanded === true && legacyState.legacyTurnCards >= 1, JSON.stringify(crossChecks.legacyGroup));
    const legacyExpand = await evalOn(page, `(() => {
      const head = document.querySelector('.dsh-it-conv-legacy .dsh-it-turn-head');
      if (!head) return { clicked: false, cards: document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-turn').length };
      head.click();
      return { clicked: true, cards: document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-turn').length };
    })()`);
    await wait(700);
    const legacyDetail = await evalOn(page, `(() => ({
      bodies: document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-turn-body').length,
      steps: document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-steps-item').length,
      previews: document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-steps-preview').length,
    }))()`);
    crossChecks.legacyTurnExpand = { expand: legacyExpand, detail: legacyDetail };
    check('legacy inline Turn card expands to step rows with samples', legacyExpand.clicked === true && legacyDetail.steps >= 1 && legacyDetail.previews >= 1, JSON.stringify(crossChecks.legacyTurnExpand));

    // 「加载更早」pagination: rendered turn rows must grow after the click.
    const loadMoreState = await evalOn(page, `(() => {
      const btn = document.querySelector('.dsh-it-turn-loadmore-btn');
      return {
        present: !!btn,
        text: btn ? (btn.textContent || '').trim() : '',
        loading: !!document.querySelector('.dsh-it-turn-loadmore-btn[disabled]'),
        renderedTurns: document.querySelectorAll('.dsh-it-conv-turn-item').length + document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-turn').length,
        cards: document.querySelectorAll('.dsh-it-conv').length,
      };
    })()`);
    crossChecks.loadMore = loadMoreState;
    if (turnApi.json?.hasMore === true) {
      check('「加载更早」button present when Host reports hasMore', loadMoreState.present === true && loadMoreState.loading === false, JSON.stringify(loadMoreState));
      if (loadMoreState.present) {
        await evalOn(page, `document.querySelector('.dsh-it-turn-loadmore-btn').click()`);
        const appended = await waitFor(page, `(document.querySelectorAll('.dsh-it-conv-turn-item').length + document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-turn').length) > ${loadMoreState.renderedTurns}`, { timeoutMs: 15_000, intervalMs: 250 });
        const afterLoadMore = await evalOn(page, `(() => ({ renderedTurns: document.querySelectorAll('.dsh-it-conv-turn-item').length + document.querySelectorAll('.dsh-it-conv-legacy .dsh-it-turn').length, cards: document.querySelectorAll('.dsh-it-conv').length }))()`);
        crossChecks.loadMore.clicked = { ok: appended.ok, before: loadMoreState.renderedTurns, after: afterLoadMore.renderedTurns, cardsBefore: loadMoreState.cards, cardsAfter: afterLoadMore.cards };
        check('「加载更早」appends the next older page (turn rows grow)', appended.ok && afterLoadMore.renderedTurns > loadMoreState.renderedTurns, JSON.stringify(crossChecks.loadMore.clicked));
      }
    } else {
      check('「加载更早」button absent when Host reports no more turns (acceptable)', loadMoreState.present === false, JSON.stringify(loadMoreState));
    }

    // 7) Settings tab: reuses the existing TranslationSettings component.
    const settingsClick = await evalOn(page, clickTabExpr(TAB_ALIASES.settings));
    await wait(900);
    await shot('token-stats-settings.png');
    state = await evalOn(page, PAGE_STATE_EXPR);
    check('settings tab opened', settingsClick.clicked && /设置|Settings/.test(state.selectedTab), JSON.stringify({ click: settingsClick, selected: state.selectedTab }));
    check(
      'settings tab renders prompt/model editors',
      /提示词|模型|目标语言|System prompt|Model|Target language|systemPrompt/i.test(state.bodyText) && (state.selects > 0 || state.textareas > 0 || state.inputs > 0),
      `selects=${state.selects} textareas=${state.textareas} inputs=${state.inputs}`,
    );

    // 8) Wordbook tab + cross-check against GET /wordbook.
    const wordbookClick = await evalOn(page, clickTabExpr(TAB_ALIASES.wordbook));
    await wait(900);
    await shot('token-stats-wordbook.png');
    state = await evalOn(page, PAGE_STATE_EXPR);
    check('wordbook tab opened', wordbookClick.clicked && /单词本|Wordbook|Word book/i.test(state.selectedTab), JSON.stringify({ click: wordbookClick, selected: state.selectedTab }));
    check('wordbook tab renders (no crash)', !state.hasLoadError, state.hasLoadError ? state.bodyText.slice(0, 300) : '');
    try {
      const list = await apiFetch('GET', '/wordbook?limit=200');
      const items = Array.isArray(list.json?.items) ? list.json.items : [];
      const firstWord = items[0]?.word;
      wordbook = { status: list.status, count: items.length, firstWord: firstWord ?? null };
      if (items.length > 0 && typeof firstWord === 'string' && firstWord.length > 0) {
        await wait(800);
        const wbState = await evalOn(page, PAGE_STATE_EXPR);
        wordbook.uiShowsFirstWord = wbState.bodyText.includes(firstWord);
        check('wordbook tab lists pre-existing entries (GET /wordbook cross-check)', wordbook.uiShowsFirstWord, JSON.stringify({ count: items.length, firstWord }));
      } else {
        check('wordbook tab: no pre-existing entries to cross-check', true, JSON.stringify(wordbook));
      }
    } catch (error) {
      check('wordbook tab lists pre-existing entries (GET /wordbook cross-check)', false, String(error && error.message ? error.message : error));
    }

    // 9) Back to overview; leave the panel there, verify sidebar selection state.
    await evalOn(page, clickTabExpr(TAB_ALIASES.overview));
    await wait(400);
    state = await evalOn(page, PAGE_STATE_EXPR);
    check('sidebar entry marked aria-current=page', state.panelButtonActive === true, String(state.panelButtonActive));

    // 10) Usage API responses observed by the page.
    const usageCalls = apiResponses.filter((entry) => /\/usage(\/events|\/turns)?(\?|$)/.test(entry.url));
    check('/usage API called by the panel', usageCalls.length > 0, JSON.stringify(usageCalls.slice(0, 6)));
    check('/usage API returned 200', usageCalls.length > 0 && usageCalls.every((entry) => entry.status === 200), JSON.stringify(usageCalls.slice(0, 6)));
    const turnCalls = apiResponses.filter((entry) => /\/usage\/turns(\?|$)/.test(entry.url));
    check('/usage/turns API called by the 轨迹 tab', turnCalls.length > 0, JSON.stringify(turnCalls.slice(0, 6)));
    check('/usage/turns API returned 200 (no old-Host 404 fallback)', turnCalls.length > 0 && turnCalls.every((entry) => entry.status === 200), JSON.stringify(turnCalls.slice(0, 6)));
    const convCalls = apiResponses.filter((entry) => /\/conversations(\?|$)/.test(entry.url));
    check('/conversations API called by the 轨迹 tab', convCalls.length > 0, JSON.stringify(convCalls.slice(0, 6)));
    check('/conversations API returned 200', convCalls.length > 0 && convCalls.every((entry) => entry.status === 200), JSON.stringify(convCalls.slice(0, 6)));

    // 11) Optional settings prompt save + restore roundtrip.
    if (SETTINGS_ROUNDTRIP) {
      settingsRoundtrip = await exerciseSettingsRoundtrip(page, apiResponses);
    } else {
      console.log('# settings roundtrip skipped (pass --settings-roundtrip after install)');
    }

    // 12) Dark-theme attempt (best effort, not a hard requirement).
    try {
      const before = await evalOn(page, `getComputedStyle(document.body).backgroundColor`);
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await wait(600);
      const after = await evalOn(page, `getComputedStyle(document.body).backgroundColor`);
      await shot('token-stats-panel-dark.png');
      check('dark-mode screenshot captured (attempt)', true, `body bg ${before} -> ${after}`);
      await page.send('Emulation.setEmulatedMedia', { features: [] });
    } catch (error) {
      check('dark-mode screenshot captured (attempt)', false, error && error.message);
    }

    // 13) Failed network resources: an API 4xx/5xx is a hard failure; other
    //     resource failures (favicon, source maps) are recorded as diagnostics.
    const failedApi = failedResources.filter((entry) => entry.url.includes('/dsh-immersive/api/'));
    check('no /dsh-immersive/api request failed with 4xx/5xx', failedApi.length === 0, JSON.stringify(failedApi.slice(0, 6)));
    crossChecks.failedResources = failedResources.filter((entry) => !/favicon/i.test(entry.url)).slice(0, 20);
    if (crossChecks.failedResources.length > 0) {
      console.log(`# note: ${crossChecks.failedResources.length} failed non-API resource(s) recorded (not fatal): ${JSON.stringify(crossChecks.failedResources.slice(0, 4))}`);
    }

    // 14) Console hygiene.
    const benign = /favicon|ResizeObserver loop|Download the React DevTools|^log: network Failed to load resource/i;
    const errors = consoleErrors.filter((line) => !benign.test(line));
    const exceptions = pageExceptions.filter((line) => !benign.test(line));
    check('no uncaught page exceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
    check('no console errors on the panel page', errors.length === 0, errors.slice(0, 5).join(' | '));
    if ((errors.length > 0 || exceptions.length > 0) && ALLOW_CONSOLE_ERRORS) {
      console.log(`# NOTE: ${errors.length + exceptions.length} console error(s) tolerated by --allow-console-errors`);
    }

    return await writeFinalResult({ authMode, tabs: tabTexts, apiResponses, failedResources, consoleErrors, consoleWarnings, pageExceptions, screenshots, crossChecks, settingsRoundtrip, wordbook, runStartedAt });
  } finally {
    if (page) page.close();
    if (chrome) await chrome.close();
  }
}

// Hard watchdog: never let a stuck CDP/WebSocket handle hang the QA run.
const watchdog = setTimeout(() => {
  console.error('# WARN: panel-shot watchdog forced exit (stuck browser handle)');
  process.exit(process.exitCode ?? 1);
}, 480_000);
if (typeof watchdog.unref === 'function') watchdog.unref();

main()
  .then((code) => {
    process.exitCode = code;
    // Chrome/CDP sockets can keep the event loop alive after the report is
    // written; force a clean exit shortly after main() resolves.
    const exitTimer = setTimeout(() => process.exit(code), 300);
    if (typeof exitTimer.unref === 'function') exitTimer.unref();
  })
  .catch(async (error) => {
    console.error(`panel-shot setup/runtime error: ${error && error.stack ? error.stack : String(error)}`);
    try {
      await writeFile(
        join(QA_DIR, 'panel-shot.result.json'),
        JSON.stringify(
          {
            url: DSH_URL,
            generatedAt: new Date().toISOString(),
            passed: false,
            error: String(error && error.message ? error.message : error),
            checks: results,
          },
          null,
          2,
        ),
      );
    } catch {
      /* ignore */
    }
    process.exitCode = 2;
  });
