#!/usr/bin/env node
/**
 * QA: unknown-term candidates and the add-to-library menu in the extension.
 *
 * Loads the real `content.js` into a local test page (no DSH process, no model
 * calls) and stubs `chrome.runtime.sendMessage` so `/translate` returns marked
 * unknown-term candidates plus `termSuggestions`. Verifies:
 *   - the first occurrence shows `译文 (原文)＋`, later occurrences stay plain;
 *   - clicking a candidate opens the「未收录术语」menu with an editable target;
 *   - 「以后显示译文」/「以后显示原文」POST `terms/quick-add` and update every
 *     occurrence on the page;
 *   - 「忽略」removes the candidate without a request.
 *
 * Usage: node qa/term-annotations.mjs
 * Writes qa/term-suggest-live.png, qa/term-suggest-menu-live.png and
 * qa/term-annotations.result.json. QA-only: writes under qa/ only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CDP, evalOn, launchChrome, openPageTarget, screenshot, wait, waitFor } from './cdp.mjs';

const QA_DIR = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(QA_DIR, '..', '..', 'dsh-web-translator-extension');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 1200) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `  [${String(detail).replace(/\s+/g, ' ').slice(0, 500)}]`}`);
}

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>term qa</title></head>
<body>
  <h2 id="h">The context engineering workflow</h2>
  <p id="p">A vibe coding tool and another context engineering pass.</p>
  <p id="p2">Prompt chaining is useful.</p>
</body></html>`;

/** Stub used by the content script instead of the real MV3 background. */
const STUB = `(() => {
  const calls = [];
  window.__dshQaCalls = calls;
  let nextId = 1;
  function mark(source, target, form) {
    const id = nextId++;
    return {
      id: id,
      marker: '[[TE' + id + ']]' + (form === 'source' ? source : target) + '[[/TE' + id + ']]',
      suggestion: { id: id, key: 'unknown:' + source.toLowerCase(), source: source, target: target, form: form || 'target', segment: 0 }
    };
  }
  function translate(texts, suggest) {
    const translations = [];
    const termSuggestions = [];
    for (const text of texts) {
      const lower = String(text || '').toLowerCase();
      const parts = [];
      if (lower.includes('prompt chaining') && !lower.includes('vibe coding')) {
        const chaining = mark('prompt chaining', '提示链', 'target');
        parts.push('使用');
        parts.push(chaining.marker);
        parts.push('很有用。');
        termSuggestions.push(chaining.suggestion);
      } else if (lower.includes('context engineering') && lower.includes('vibe coding')) {
        const vibe = mark('vibe coding', '氛围编程', 'target');
        const engineering = mark('context engineering', '上下文工程', 'target');
        parts.push('一个');
        parts.push(vibe.marker);
        parts.push('工具和另一次');
        parts.push(engineering.marker);
        parts.push('。');
        termSuggestions.push(vibe.suggestion, engineering.suggestion);
      } else {
        const engineering = mark('context engineering', '上下文工程', 'target');
        parts.push(engineering.marker);
        parts.push('工作流');
        termSuggestions.push(engineering.suggestion);
      }
      translations.push(parts.join(''));
    }
    return {
      translations: translations,
      termSuggestions: suggest ? termSuggestions : [],
      usage: { inputTokens: 12, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cached: false, provider: 'qa', model: 'fake'
    };
  }
  function reply(message) {
    const payload = message.payload || {};
    if (message.method === 'translate') return translate(payload.texts || [], payload.suggestTerms === true);
    if (message.method === 'settings') return { settings: { targetLanguage: 'zh-CN' }, selected: { provider: 'qa', model: 'fake' } };
    if (message.method === 'health') return { version: 'qa', llm: { providers: 1, models: 1 } };
    if (message.method === 'ball-sites') return { sites: [] };
    if (message.method === 'usage') return { days: [] };
    if (message.method === 'terms/quick-add') {
      calls.push({ method: message.method, payload: payload });
      return { libraryName: '我的术语' };
    }
    return {};
  }
  const baseChrome = window.chrome && typeof window.chrome === 'object' ? window.chrome : {};
  window.chrome = Object.assign({}, baseChrome, {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        const done = (value) => { if (typeof callback === 'function') setTimeout(() => callback(value), 0); };
        if (message && message.type === 'dsh-it:rpc') {
          done({ type: 'dsh-it:result', id: message.id, ok: true, data: reply(message) });
          return;
        }
        done({ ok: true, following: false });
      },
      onMessage: { addListener() {} },
      getURL(path) { return path; }
    },
    storage: {
      local: {
        get(keys, callback) { if (typeof callback === 'function') setTimeout(() => callback({}), 0); },
        set(items, callback) { if (typeof callback === 'function') setTimeout(callback, 0); }
      },
      onChanged: { addListener() {} }
    }
  });
})();`;

const contentSource = await readFile(join(EXT_DIR, 'content.js'), 'utf8');
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE_HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const chrome = await launchChrome({ label: 'dsh-term-qa' });
let page = null;
const consoleErrors = [];
try {
  const target = await openPageTarget(`http://127.0.0.1:${chrome.port}`, pageUrl);
  page = await new CDP(target.webSocketDebuggerUrl).connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  page.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push(String(params?.exceptionDetails?.text || 'exception').slice(0, 300));
  });
  page.on('Runtime.consoleAPICalled', (params) => {
    if (params && params.type === 'error') {
      const text = (params.args || []).map((arg) => arg && arg.value !== undefined ? String(arg.value) : '').join(' ');
      if (text) consoleErrors.push(text.slice(0, 300));
    }
  });
  await page.send('Page.navigate', { url: pageUrl });
  await waitFor(page, 'document.readyState === "complete"', { timeoutMs: 15000 });
  await evalOn(page, STUB);
  await evalOn(page, contentSource);

  const ready = await waitFor(page, `!!document.getElementById('dsh-it-host')`, { timeoutMs: 15000 });
  check('content script creates the shadow-host UI', ready.ok, ready.error);
  const bubbleClick = await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const bubble = host && host.shadowRoot && host.shadowRoot.querySelector('.dsh-bubble');
    if (!bubble) return false;
    bubble.click();
    return true;
  })()`);
  check('floating ball starts translation', bubbleClick === true);

  const injected = await waitFor(page, `document.querySelectorAll('[data-dsh-term-suggest]').length >= 4`, { timeoutMs: 20000 });
  check('candidate markers become suggestion spans', injected.ok, injected.error);

  const state = await evalOn(page, `(() => {
    const all = Array.from(document.querySelectorAll('[data-dsh-term-suggest]'));
    const first = all.find((el) => el.getAttribute('data-dsh-term-key') === 'unknown:context engineering' && el.getAttribute('data-dsh-term-first') === '1');
    const later = all.find((el) => el.getAttribute('data-dsh-term-key') === 'unknown:context engineering' && el.getAttribute('data-dsh-term-first') !== '1');
    return {
      count: all.length,
      first: first ? { text: first.textContent, role: first.getAttribute('role') } : null,
      later: later ? later.textContent : null
    };
  })()`);
  check('first occurrence shows translation, original and add badge', state.first && state.first.text === '上下文工程 (context engineering)＋', JSON.stringify(state));
  check('later occurrence stays plain', state.later === '上下文工程＋', JSON.stringify(state));
  check('candidate span is a keyboard/click target', state.first && state.first.role === 'button', JSON.stringify(state));

  const openMenu = await evalOn(page, `(() => {
    const el = Array.from(document.querySelectorAll('[data-dsh-term-suggest]'))
      .find((node) => node.getAttribute('data-dsh-term-key') === 'unknown:context engineering' && node.getAttribute('data-dsh-term-first') === '1');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  check('clicking a candidate opens the menu', openMenu === true);
  const menuVisible = await waitFor(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const menu = host && host.shadowRoot && host.shadowRoot.querySelector('.dsh-term-menu');
    return !!(menu && !menu.hidden);
  })()`, { timeoutMs: 5000 });
  check('unknown-term menu opens', menuVisible.ok, menuVisible.error);
  const menu = await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const root = host.shadowRoot;
    const menu = root.querySelector('.dsh-term-menu');
    const input = root.querySelector('.dsh-term-input');
    return {
      title: menu.querySelector('.dsh-term-menu-title').textContent,
      source: menu.querySelector('.dsh-term-menu-source').textContent,
      input: input ? input.value : '',
      choices: Array.from(menu.querySelectorAll('.dsh-term-menu-btn')).map((b) => b.getAttribute('data-choice'))
    };
  })()`);
  check('menu shows the source and an editable translation', menu && menu.source === 'context engineering' && menu.input === '上下文工程', JSON.stringify(menu));
  check('menu offers translation/original/ignore choices', menu && menu.choices.join(',') === 'target,source,ignore', JSON.stringify(menu));
  const menuColors = await evalOn(page, `(() => {
    const root = document.getElementById('dsh-it-host').shadowRoot;
    const pick = (choice) => getComputedStyle(root.querySelector('.dsh-term-menu-btn[data-choice="' + choice + '"]')).color;
    return { source: pick('source'), ignore: pick('ignore'), target: pick('target') };
  })()`);
  check('ignore uses the same text color as the secondary button', menuColors.source === menuColors.ignore, JSON.stringify(menuColors));

  await mkdir(QA_DIR, { recursive: true });
  await screenshot(page, join(QA_DIR, 'term-suggest-menu-live.png'));

  await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const input = host.shadowRoot.querySelector('.dsh-term-input');
    input.value = '上下文工程实践';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    host.shadowRoot.querySelector('.dsh-term-menu-btn[data-choice="target"]').click();
  })()`);
  await wait(150);
  const pageAfterTarget = await evalOn(page, `document.body.textContent`);
  check('choosing 译文 replaces every occurrence with the edited target', (pageAfterTarget.match(/上下文工程实践/g) || []).length >= 2, pageAfterTarget);
  const targetCall = await evalOn(page, `(() => { const calls = window.__dshQaCalls || []; return calls.length ? calls[calls.length - 1] : null; })()`);
  check('译文 choice posts source/policy/target to quick-add', targetCall && targetCall.method === 'terms/quick-add'
    && targetCall.payload.source === 'context engineering' && targetCall.payload.policy === 'translate' && targetCall.payload.target === '上下文工程实践', JSON.stringify(targetCall));
  check('saved candidate type disappears', (await evalOn(page, `document.querySelectorAll('[data-dsh-term-key="unknown:context engineering"]').length`)) === 0);

  await evalOn(page, `(() => {
    const el = Array.from(document.querySelectorAll('[data-dsh-term-suggest]'))
      .find((node) => node.getAttribute('data-dsh-term-key') === 'unknown:vibe coding');
    if (el) el.click();
  })()`);
  await waitFor(page, `(() => { const host = document.getElementById('dsh-it-host'); const menu = host && host.shadowRoot && host.shadowRoot.querySelector('.dsh-term-menu'); return !!(menu && !menu.hidden); })()`, { timeoutMs: 5000 });
  await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    host.shadowRoot.querySelector('.dsh-term-menu-btn[data-choice="source"]').click();
  })()`);
  await wait(150);
  const pageAfterSource = await evalOn(page, `document.body.textContent`);
  check('choosing 原文 shows the original wording', pageAfterSource.includes('vibe coding') && !pageAfterSource.includes('氛围编程'), pageAfterSource);
  const sourceCall = await evalOn(page, `(() => { const calls = window.__dshQaCalls || []; return calls.length ? calls[calls.length - 1] : null; })()`);
  check('原文 choice posts policy keep without a target', sourceCall && sourceCall.payload.policy === 'keep' && !Object.hasOwn(sourceCall.payload, 'target'), JSON.stringify(sourceCall));

  const beforeIgnore = await evalOn(page, `(window.__dshQaCalls || []).length`);
  await evalOn(page, `(() => {
    const el = Array.from(document.querySelectorAll('[data-dsh-term-suggest]'))
      .find((node) => node.getAttribute('data-dsh-term-key') === 'unknown:prompt chaining');
    if (el) el.click();
  })()`);
  await waitFor(page, `(() => { const host = document.getElementById('dsh-it-host'); const menu = host && host.shadowRoot && host.shadowRoot.querySelector('.dsh-term-menu'); return !!(menu && !menu.hidden); })()`, { timeoutMs: 5000 });
  await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    host.shadowRoot.querySelector('.dsh-term-menu-btn[data-choice="ignore"]').click();
  })()`);
  await wait(120);
  check('ignore removes the candidate without an RPC', (await evalOn(page, `(window.__dshQaCalls || []).length`)) === beforeIgnore
    && (await evalOn(page, `document.querySelectorAll('[data-dsh-term-key="unknown:prompt chaining"]').length`)) === 0);

  await screenshot(page, join(QA_DIR, 'term-suggest-live.png'));
  check('no page exceptions or console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  await writeFile(
    join(QA_DIR, 'term-annotations.result.json'),
    JSON.stringify({ ok: results.every((item) => item.ok), results, consoleErrors }, null, 2) + '\n',
  );
  process.exitCode = results.every((item) => item.ok) ? 0 : 1;
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 2;
} finally {
  if (page) page.close();
  await chrome.close();
  await new Promise((resolve) => server.close(resolve));
}
