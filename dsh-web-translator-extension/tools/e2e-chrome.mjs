#!/usr/bin/env node
/**
 * 可选 E2E 校验（需要本机 Chrome，未安装/版本过低会跳过）。
 *
 * 做法：
 *  - 用 Node 内置 http 起一个本地测试页（英文文章/表格/列表/code/可编辑区等）。
 *  - 启动 headless Chrome，通过 CDP `Extensions.loadUnpacked` 加载本目录扩展
 *    （Chrome 142+ 移除了 --load-extension 命令行开关，因此必须用 CDP；需要 Chrome ≥150）。
 *  - 通过 CDP `Fetch` 拦截 background service worker 发往 DSH 的请求并返回 mock JSON，
 *    不触发真实模型调用；然后真实驱动 content.js：
 *    注入 → 翻译流水线（health/settings/translate）→ 三模式切换（计算样式）→
 *    划词查词卡 → 加入单词本 → 还原。
 *  - 验证 options.html 能加载、12 语言下拉、默认值，以及 service worker 的 chrome API 可用。
 *
 * 用法：
 *   node tools/e2e-chrome.mjs
 *   环境变量 CHROME_BIN 可指定 Chrome/Chromium 可执行文件路径。
 *
 * 注意：headless + --no-sandbox 仅用于临时自动化 profile，测试结束会删除该 profile。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEST_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Extension E2E Test</title></head>
<body>
  <article>
    <style>
      .center-block { text-align: center; }
      .center-narrow { max-width: 320px; margin: 0 auto; text-align: center; }
    </style>
    <h1>A Very Long English Heading for Testing the Extension</h1>
    <h2>Short heading</h2>
    <div class="center-block"><p id="center-p">Centered paragraph text for alignment testing with enough words.</p></div>
    <h2 id="center-h2" style="text-align: center">Centered heading alignment test</h2>
    <p id="center-inline" class="center-narrow">Narrow centered paragraph with text.</p>
    <p id="link-block">This is the first paragraph with plenty of English words to translate and <a href="/docs" id="docs-link">the documentation</a> on the page.</p>
    <p><a id="next-link" href="/test.html?follow=clicked">Next page via link</a></p>
    <p><a id="blank-link" href="/test.html?follow=blank" target="_blank">Open new tab page</a></p>
    <p>Broken<br>line words here for translation.</p>
    <p>Roses are red<br>Violets are blue.</p>
    <p>Formatted
       source paragraph
       with newlines inside.</p>
    <p>12345</p>
    <p><a id="same-trans">Patreon</a></p>
    <p id="same-block">Kubernetes</p>
    <ul><li id="content-li">List item with <a href="#list-link">inline link words</a> and enough English content to be translated.</li></ul>
    <table><tbody><tr><td>Table cell with English words inside it.</td></tr></tbody></table>
    <table><tbody><tr><td id="structured-toc-cell"><dl><dt><a href="#section-a">Alpha section link</a></dt><dd><a href="#section-b">Beta section link</a></dd></dl></td></tr></tbody></table>
    <pre><code>const x = 1; // should not be translated</code></pre>
    <button>Button label should not be translated</button>
    <button id="dynamic-color" style="color: rgb(10, 10, 10); background-color: rgb(0, 0, 0);">Dynamic color button label</button>
    <div><span>Inline span text that is longer than twelve characters.</span></div>
    <div><span id="interleaved-inline">Header label text <a href="#interleaved-link">link label</a></span></div>
    <div contenteditable="true">Editable text should not be translated.</div>
  </article>
  <nav><ul><li><a href="#login">Login</a></li><li><a href="#help">Help</a></li></ul></nav>
  <ul class="tags"><li><a href="#linux">linux</a></li><li><a href="#security">security</a></li></ul>
  <footer><p>Footer text for translation.</p><a href="#privacy">Privacy</a></footer>
</body></html>`;

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok: !!ok, extra });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + String(extra).slice(0, 260) + ']' : ''));
}
function errorText(err) {
  return err && err.stack ? err.stack : String(err);
}
/** 解析浮窗/查词卡里的「输入 X · 输出 Y」token 行（兼容千分位分隔符） */
function parseTokenLine(text) {
  const match = String(text || '').match(/输入\s*([\d,.\s]+?)\s*·\s*输出\s*([\d,.\s]+)/);
  if (!match) return null;
  const toNumber = (value) => Number(String(value).replace(/[^\d]/g, ''));
  return { input: toNumber(match[1]), output: toNumber(match[2]) };
}
function parseInteger(text) {
  const digits = String(text || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : -1;
}

/** 本次 e2e 中 mock translate 响应返回过的 usage（用于计算浮窗「本页消耗」期望值） */
const translateUsages = [];
const ballSites = [];
let translateDelayMs = 0;

/** 本次 e2e 中捕获的 POST 请求体（用于校验 client / sourceUrl / sourceTitle 元数据与轨迹 turnId/stepIndex） */
const translateBodies = [];
const lookupBodies = [];

/* ------------------------------------------------------------------ */
/* 环境准备                                                            */
/* ------------------------------------------------------------------ */

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge'
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await getJson('http://127.0.0.1:' + port + '/json/version');
    } catch {
      await wait(250);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 轻量 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败: ' + this.url)), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message + ' ' + JSON.stringify(message.error.data ?? '')));
        else resolve(message.result);
      } else if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) {
          try {
            handler(message.params);
          } catch (err) {
            console.log('CDP handler error: ' + errorText(err));
          }
        }
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function evalOn(cdp, expression) {
  const out = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails).slice(0, 500));
  return out.result && out.result.value;
}

/* ------------------------------------------------------------------ */
/* mock DSH API（相对 DESIGN §5 契约的最小响应）                        */
/* ------------------------------------------------------------------ */

function mockApiResponse(path, request) {
  if (path.endsWith('/health')) {
    return { ok: true, version: 'mock-1.0', uptimeMs: 1234, llm: { providers: 1, models: 1 } };
  }
  if (path.endsWith('/settings')) {
    return {
      ok: true,
      settings: { provider: 'mock', model: 'mock-model', reasoningEffort: 'off', targetLanguage: 'zh-CN' },
      defaults: {},
      selected: { provider: 'mock', model: 'mock-model', reasoningEffort: 'off', source: 'settings' },
      modelInfo: { provider: 'mock', model: 'mock-model', reasoningEfforts: [], contextWindow: 0, maxTokens: 0 }
    };
  }
  if (path.endsWith('/ball-sites')) {
    return { ok: true, sites: ballSites.slice(), updatedAt: Date.now() };
  }
  if (path.endsWith('/ball-sites/add')) {
    const body = request.postData ? JSON.parse(request.postData) : {};
    const domain = String(body.domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (domain && ballSites.indexOf(domain) === -1) ballSites.push(domain);
    return { ok: true, sites: ballSites.slice(), updatedAt: Date.now(), added: true };
  }
  if (path.endsWith('/ball-sites/remove')) {
    const body = request.postData ? JSON.parse(request.postData) : {};
    const domain = String(body.domain || '').trim().toLowerCase().replace(/^www\./, '');
    const index = ballSites.indexOf(domain);
    if (index >= 0) ballSites.splice(index, 1);
    return { ok: true, sites: ballSites.slice(), updatedAt: Date.now(), removed: index >= 0 };
  }
  if (path.endsWith('/translate')) {
    const body = request.postData ? JSON.parse(request.postData) : {};
    translateBodies.push(body);
    const texts = (body.texts || []).map((text) => String(text));
    const chars = texts.reduce((sum, text) => sum + text.length, 0);
    const usage = {
      inputTokens: chars + texts.length * 4,
      outputTokens: Math.ceil(chars / 2) + texts.length * 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    };
    translateUsages.push(usage);
    return {
      ok: true,
      translations: texts.map((text) => {
        if (text === 'Patreon' || text === 'Kubernetes') return text;
        return text.indexOf('Formatted source paragraph') !== -1 ? '【译文】Formatted\nsource paragraph' : '【译文】' + text;
      }),
      provider: 'mock',
      model: 'mock-model',
      reasoningEffort: 'off',
      usage,
      cached: false
    };
  }
  if (path.endsWith('/usage')) {
    return {
      ok: true,
      usage: {
        version: 1,
        updatedAt: Date.now(),
        totals: {
          requests: 9, ok: 9, errors: 0, cached: 2,
          inputTokens: 5120, outputTokens: 2380, cacheReadTokens: 120, cacheWriteTokens: 0
        },
        today: {
          date: '2026-11-06', requests: 7, ok: 7, errors: 0, cached: 2,
          inputTokens: 3456, outputTokens: 1234, cacheReadTokens: 100, cacheWriteTokens: 0
        },
        days: [],
        byModel: [],
        byKind: {},
        recent: []
      }
    };
  }
  if (path.endsWith('/lookup')) {
    const body = request.postData ? JSON.parse(request.postData) : {};
    lookupBodies.push(body);
    return {
      ok: true,
      result: {
        text: 'paragraph',
        translation: '段落',
        provider: 'mock',
        model: 'mock-model',
        dictionary: {
          word: 'paragraph',
          phonetic: '/ˈpærəɡræf/',
          meanings: [{ partOfSpeech: 'noun', definitions: ['a distinct section of writing'] }]
        }
      },
      usage: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 }
    };
  }
  if (path.endsWith('/wordbook/add')) {
    return { ok: true, item: { id: 'wb_mock' }, existed: false };
  }
  return { ok: false, error: { code: 'NOT_FOUND', message: 'mock: no route for ' + path } };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let chromeProcess = null;
let profileDir = null;
let httpServer = null;

async function cleanup() {
  if (chromeProcess) {
    try {
      chromeProcess.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    try {
      spawnSync('pkill', ['-f', profileDir], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  if (httpServer) {
    try {
      await new Promise((resolve) => httpServer.close(resolve));
    } catch {
      /* ignore */
    }
  }
  if (profileDir) {
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('SKIP: 未找到 Chrome/Chromium（可用 CHROME_BIN 环境变量指定），跳过 E2E。');
    return 0;
  }

  // 本地测试页
  httpServer = createServer((request, response) => {
    if (request.url && request.url.startsWith('/test.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(TEST_HTML);
      return;
    }
    if (request.url && request.url.startsWith('/autosite.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Auto site</title></head><body>' +
          '<h1>Auto site heading</h1><p>Auto site paragraph with enough English text for automatic translation.</p>' +
          '</body></html>'
      );
      return;
    }
    if (request.url && request.url.startsWith('/iframe-parent.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Iframe parent</title></head><body>' +
          '<h1>Iframe parent page</h1><p>Parent page paragraph with enough English content for translation.</p>' +
          '<iframe id="test-frame" src="/iframe-child.html" width="600" height="220" title="child frame"></iframe>' +
          '</body></html>'
      );
      return;
    }
    if (request.url && request.url.startsWith('/iframe-child.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Child frame</title></head><body>' +
          '<h1>Child frame heading</h1><p>Child frame paragraph with enough English content for translation.</p>' +
          '</body></html>'
      );
      return;
    }
    if (request.url && request.url.startsWith('/compact.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compact nav</title>' +
          '<style>.compact-nav{width:56px}</style></head><body>' +
          '<h1>Compact nav test</h1><p>Body paragraph with enough English words for translation.</p>' +
          '<nav class="compact-nav"><ul><li><a id="compact-nav-link" href="#learn">Learn</a></li></ul></nav>' +
          '<div role="tablist" style="display:flex;width:44px"><a id="compact-tab" role="tab" href="#preview" style="max-width:44px">Preview</a></div>' +
          '</body></html>'
      );
      return;
    }
    if (request.url && request.url.startsWith('/flow-parents.html')) {
      const longGrid = 'A grid parent paragraph must still be translated even though inserting a new sibling would become another grid item. This paragraph is intentionally longer than the inline translation limit so the old scanner skipped it completely and the page showed untranslated English here.';
      const longFlex = 'A flex parent paragraph must also be translated: a new sibling would become a horizontal flex item, so the translation has to be inserted inside the paragraph itself rather than changing the flex row layout of the page.';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Flow parents</title></head><body>' +
          '<h1>Grid and flex parent paragraphs</h1>' +
          '<div id="grid-parent" style="display:grid;grid-template-columns:1fr"><p id="grid-long">' + longGrid + '</p>' +
            '<p id="after-grid">A following grid item paragraph should stay separated from the translation above.</p></div>' +
          '<div id="flex-parent" style="display:flex"><p id="flex-long">' + longFlex + '</p></div>' +
        '</body></html>'
      );
      return;
    }
    if (request.url && request.url.startsWith('/long.html')) {
      const longText = 'A long paragraph sentence with enough English words for the block translation path. '.repeat(12).trim();
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Long paragraph</title></head><body>' +
          '<h1>Long paragraph test</h1><p>Short intro paragraph for translation.</p>' +
          '<p id="long-paragraph">' + longText + '</p></body></html>'
      );
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const pageUrl = 'http://127.0.0.1:' + httpServer.address().port + '/test.html';
  const pageOrigin = new URL(pageUrl).origin;

  const cdpPort = await getFreePort();
  profileDir = await mkdtemp(join(tmpdir(), 'dsh-it-e2e-'));
  const chromeArgs = [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-breakpad',
    '--window-size=1000,700',
    '--enable-unsafe-extension-debugging',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + cdpPort,
    'about:blank'
  ];
  chromeProcess = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProcess.stderr.on('data', () => {});

  const version = await waitForCdp(cdpPort, 20000);
  if (!version || !version.webSocketDebuggerUrl) {
    console.log('SKIP: Chrome 未能在 20s 内启动 CDP，跳过 E2E。');
    return 0;
  }
  const base = 'http://127.0.0.1:' + cdpPort;

  /* 1) 加载扩展 */
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.connect();
  let extensionId = null;
  try {
    const loaded = await browser.send('Extensions.loadUnpacked', { path: ROOT });
    extensionId = loaded.id;
    check('扩展加载（manifest/CSP/commands 合法）', !!extensionId, extensionId);
  } catch (err) {
    const text = errorText(err);
    if (text.indexOf('wasn\'t found') !== -1 || text.indexOf('not found') !== -1 || text.indexOf('Unknown') !== -1) {
      console.log('SKIP: 当前 Chrome 不支持 CDP Extensions.loadUnpacked（需 Chrome ≥150）。');
      return 0;
    }
    check('扩展加载', false, text);
    return 1;
  }
  await wait(1200);

  const targets = (await browser.send('Target.getTargets')).targetInfos || [];
  const swTarget = targets.find((target) => target.type === 'service_worker' && String(target.url).endsWith('/background.js'));
  check('background service worker 启动（module）', !!swTarget, swTarget && swTarget.url);
  if (swTarget) extensionId = swTarget.url.split('/')[2];

  /* 2) 内容脚本注入 */
  const pages = await getJson(base + '/json/list');
  const pageTarget = pages.find((target) => target.type === 'page');
  if (!pageTarget) {
    check('page target', false, 'no page target');
    return 1;
  }
  const page = new CDP(pageTarget.webSocketDebuggerUrl);
  await page.connect();
  const pageErrors = [];
  page.on('Runtime.exceptionThrown', (params) => pageErrors.push(JSON.stringify(params.exceptionDetails).slice(0, 300)));
  page.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') pageErrors.push('console.error: ' + (params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
  });
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: pageUrl });
  await wait(2200);

  const injected = await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const shadow = host && host.shadowRoot;
    return {
      host: !!host,
      parent: host && host.parentElement.tagName,
      shadow: !!shadow,
      bubble: !!(shadow && shadow.querySelector('.dsh-bubble')),
      panel: !!(shadow && shadow.querySelector('.dsh-panel')),
      card: !!(shadow && shadow.querySelector('.dsh-card')),
      styleLen: shadow && shadow.querySelector('style') ? shadow.querySelector('style').textContent.length : 0,
      mode: host && host.getAttribute('data-dsh-it-mode')
    };
  })()`);
  check('content.js 注入：宿主/Shadow/UI 齐全', injected.host && injected.parent === 'HTML' && injected.shadow && injected.bubble && injected.panel && injected.card, JSON.stringify(injected));
  check('content.js 注入：Shadow 样式加载', injected.styleLen > 5000, injected.styleLen);
  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

  /* 3) 拦截 background 的 DSH 请求（mock） */
  const swList = await getJson(base + '/json/list');
  const swInfo = swList.find((target) => target.type === 'service_worker' && String(target.url).endsWith('/background.js'));
  if (!swInfo) {
    check('service worker 可连接', false, 'no service worker');
    return 1;
  }
  const sw = new CDP(swInfo.webSocketDebuggerUrl);
  await sw.connect();
  const apiCalls = [];
  sw.on('Fetch.requestPaused', async (params) => {
    try {
      const request = params.request;
      const path = new URL(request.url).pathname;
      apiCalls.push(request.method + ' ' + path);
      if (translateDelayMs > 0 && path.endsWith('/translate')) await wait(translateDelayMs);
      const payload = mockApiResponse(path, request);
      const body = Buffer.from(JSON.stringify(payload)).toString('base64');
      await sw.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body
      });
    } catch (err) {
      console.log('Fetch handler error: ' + errorText(err));
    }
  });
  await sw.send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:3080/dsh-immersive/api/*', requestStage: 'Request' }] });
  await sw.send('Runtime.enable');
  const menuApi = await evalOn(sw, `({
    api: !!chrome.contextMenus,
    clickListener: !!(chrome.contextMenus && chrome.contextMenus.onClicked && chrome.contextMenus.onClicked.hasListeners())
  })`);
  check('右键菜单：contextMenus API 与点击监听已注册', menuApi.api === true && menuApi.clickListener === true, JSON.stringify(menuApi));

  const swTabs = await evalOn(sw, `(async () => { const tabs = await chrome.tabs.query({}); return tabs.map((tab) => ({ id: tab.id })); })()`);
  const tab = swTabs.find((item) => typeof item.id === 'number');
  check('service worker 可查询页面 tab', !!tab, JSON.stringify(swTabs));
  if (!tab) return 1;
  const fireToggle = () =>
    evalOn(sw, `(async () => { await chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:toggle' }); return true; })()`);
  const countTranslateCalls = () => apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  const countTranslatedNodes = () =>
    evalOn(page, `document.querySelectorAll('[data-dsh-it="trans"]').length + document.querySelectorAll('[data-dsh-it="trans-inline"]').length`);
  const setStorage = async (patch) => {
    await evalOn(sw, `chrome.storage.local.set(${JSON.stringify(patch)})`);
    await wait(350);
  };
  const restorePage = async () => {
    for (let i = 0; i < 4; i += 1) {
      const count = await countTranslatedNodes();
      if (count === 0) return;
      await fireToggle();
      await wait(800);
    }
  };

  // Fetch mock 已启用：重新加载页面，确保 content 初始化时读取的是 mock /ball-sites
  await page.send('Page.navigate', { url: pageUrl });
  await wait(2200);

  /* 3.1) 点击工具栏图标只打开/收起浮窗，不触发翻译 */
  const translateCallsBeforeIcon = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:toggle-panel' })`);
  await wait(300);
  const iconPanelProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return {
      panelHidden: shadow.querySelector('.dsh-panel').hidden,
      trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
      inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length
    };
  })()`);
  const translateCallsAfterIcon = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  check(
    '工具栏图标：只打开浮窗，不触发翻译',
    iconPanelProbe.panelHidden === false && iconPanelProbe.trans + iconPanelProbe.inline === 0 &&
      translateCallsAfterIcon === translateCallsBeforeIcon,
    JSON.stringify({ panel: iconPanelProbe, calls: translateCallsBeforeIcon + '->' + translateCallsAfterIcon })
  );
  await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-panel-head .dsh-icon-btn').click()`);
  await wait(200);

  /* 3.15) 悬浮球左键：按当前模式快速翻译；再次点击还原；右键打开面板 */
  const quickCallsBefore = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  await evalOn(sw, `chrome.storage.local.set({ mode: 'only' })`);
  await wait(400);
  await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble').click()`);
  await wait(3000);
  const ballQuick = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return {
      mode: document.documentElement.getAttribute('data-dsh-it-mode'),
      trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
      inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length,
      panelHidden: shadow.querySelector('.dsh-panel').hidden
    };
  })()`);
  const quickCallsAfter = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  check(
    '悬浮球左键：直接按当前模式（仅译文）开始翻译，不弹出面板',
    ballQuick.mode === 'only' && ballQuick.trans + ballQuick.inline > 0 && ballQuick.panelHidden === true && quickCallsAfter > quickCallsBefore,
    JSON.stringify({ page: ballQuick, calls: quickCallsBefore + '->' + quickCallsAfter })
  );
  await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble').click()`);
  await wait(900);
  const ballRestored = await evalOn(page, `({
    trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
    inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length
  })`);
  check('悬浮球左键：已翻译后再次点击还原页面', ballRestored.trans + ballRestored.inline === 0, JSON.stringify(ballRestored));
  await evalOn(sw, `chrome.storage.local.set({ mode: 'bilingual' })`);
  await wait(400);
  const panelCallsBefore = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  await evalOn(page, `(() => { const bubble = document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble'); bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); })()`);
  await wait(300);
  const ballPanel = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { panelHidden: shadow.querySelector('.dsh-panel').hidden, trans: document.querySelectorAll('[data-dsh-it="trans"]').length };
  })()`);
  const panelCallsAfter = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  check(
    '悬浮球右键：打开功能面板且不触发翻译',
    ballPanel.panelHidden === false && ballPanel.trans === 0 && panelCallsAfter === panelCallsBefore,
    JSON.stringify({ panel: ballPanel, calls: panelCallsBefore + '->' + panelCallsAfter })
  );
  await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-panel-head .dsh-icon-btn').click()`);
  await wait(200);

  /* 3.2) 悬浮球：可拖动 + 可隐藏/恢复 */
  const dragProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const bubble = shadow.querySelector('.dsh-bubble');
    const panel = shadow.querySelector('.dsh-panel');
    const before = bubble.getBoundingClientRect();
    const fire = (type, x, y) => bubble.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, button: 0, pointerType: 'mouse'
    }));
    fire('pointerdown', before.left + 20, before.top + 20);
    fire('pointermove', before.left - 120, before.top - 90);
    fire('pointerup', before.left - 120, before.top - 90);
    const after = bubble.getBoundingClientRect();
    return {
      movedLeft: Math.round(after.left - before.left),
      movedTop: Math.round(after.top - before.top),
      panelHidden: panel.hidden,
      right: bubble.style.right,
      bottom: bubble.style.bottom
    };
  })()`);
  check(
    '悬浮球：可拖动，拖动不会打开面板',
    Math.abs(dragProbe.movedLeft) > 40 && Math.abs(dragProbe.movedTop) > 30 && dragProbe.panelHidden === true &&
      /px$/.test(dragProbe.right) && /px$/.test(dragProbe.bottom),
    JSON.stringify(dragProbe)
  );
  const ballPosStored = await evalOn(sw, `(async () => await chrome.storage.local.get('ballPosition'))()`);
  check(
    '悬浮球：拖动位置持久化到 storage',
    !!(ballPosStored && ballPosStored.ballPosition &&
      Number.isFinite(ballPosStored.ballPosition.right) && Number.isFinite(ballPosStored.ballPosition.bottom)),
    JSON.stringify(ballPosStored)
  );
  await wait(400);
  await evalOn(page, `(() => { const bubble = document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble'); bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); })()`);
  await wait(250);
  const hideBtnFound = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const btn = shadow.querySelector('[data-role="hide-ball"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(350);
  const hiddenBall = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return {
      bubbleHidden: shadow.querySelector('.dsh-bubble').hidden,
      panelHidden: shadow.querySelector('.dsh-panel').hidden,
      toast: (shadow.querySelector('.dsh-toast') || {}).textContent || ''
    };
  })()`);
  check(
    '悬浮球：可隐藏（面板同时收起并提示恢复方式）',
    hideBtnFound === true && hiddenBall.bubbleHidden === true && hiddenBall.panelHidden === true && hiddenBall.toast.indexOf('隐藏') !== -1,
    JSON.stringify(hiddenBall)
  );
  const hideStored = await evalOn(sw, `(async () => await chrome.storage.local.get('showFloatingBall'))()`);
  check('悬浮球：隐藏状态持久化', hideStored && hideStored.showFloatingBall === false, JSON.stringify(hideStored));
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:show-ball' })`);
  await wait(350);
  const shownBall = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden, toast: (shadow.querySelector('.dsh-toast') || {}).textContent || '' };
  })()`);
  const showStored = await evalOn(sw, `(async () => await chrome.storage.local.get('showFloatingBall'))()`);
  check(
    '悬浮球：可通过右键菜单「显示悬浮球」恢复',
    shownBall.bubbleHidden === false && !!showStored && showStored.showFloatingBall === true,
    JSON.stringify({ visible: shownBall, stored: showStored })
  );
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:hide-ball' })`);
  await wait(350);
  const hideMenuProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden, panelHidden: shadow.querySelector('.dsh-panel').hidden };
  })()`);
  const hideMenuStored = await evalOn(sw, `(async () => await chrome.storage.local.get('showFloatingBall'))()`);
  check(
    '悬浮球：右键菜单「隐藏悬浮球」可用',
    hideMenuProbe.bubbleHidden === true && hideMenuProbe.panelHidden === true && hideMenuStored.showFloatingBall === false,
    JSON.stringify({ probe: hideMenuProbe, stored: hideMenuStored })
  );
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:show-ball' })`);
  await wait(350);
  const showAgainProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden };
  })()`);
  check('悬浮球：右键菜单隐藏后可再次显示', showAgainProbe.bubbleHidden === false, JSON.stringify(showAgainProbe));

  /* 3.5) 语言一致：不翻译，悬浮球上方提示 */
  await evalOn(sw, `chrome.storage.local.set({ targetLanguage: 'en' })`);
  await wait(500);
  const callsBeforeSameLang = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  await fireToggle();
  await wait(900);
  const sameLangProbe = await evalOn(page, `(() => {
    const sh = document.getElementById('dsh-it-host').shadowRoot;
    const toast = sh.querySelector('.dsh-toast');
    return {
      toastHidden: !toast || toast.hidden,
      toastText: toast ? toast.textContent : '',
      panelHidden: sh.querySelector('.dsh-panel').hidden,
      bubble: !!sh.querySelector('.dsh-bubble')
    };
  })()`);
  const callsAfterSameLang = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  check(
    '语言一致：跳过翻译，不请求模型',
    sameLangProbe.bubble === true && callsAfterSameLang === callsBeforeSameLang,
    JSON.stringify({ calls: callsBeforeSameLang + '->' + callsAfterSameLang, probe: sameLangProbe })
  );
  check(
    '语言一致：悬浮球上方浮起提示',
    sameLangProbe.toastHidden === false && /一致|nothing to translate/.test(sameLangProbe.toastText),
    sameLangProbe.toastText
  );
  await evalOn(sw, `chrome.storage.local.set({ targetLanguage: 'zh-CN' })`);
  await wait(600);

  /* 4) 触发翻译（并检查悬浮球翻译中进度提示） */
  const usageBaseline = translateUsages.length;
  translateDelayMs = 900;
  await fireToggle();
  await wait(500);
  const bubbleBusyProbe = await evalOn(page, `(() => {
    const bubble = document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble');
    return {
      text: bubble.textContent,
      title: bubble.getAttribute('title') || '',
      busy: bubble.classList.contains('dsh-bubble-busy'),
      progress: bubble.style.getPropertyValue('--dsh-bubble-progress')
    };
  })()`);
  check(
    '悬浮球：翻译中显示进度/加载提示',
    bubbleBusyProbe.busy === true && /%|…/.test(bubbleBusyProbe.text) && bubbleBusyProbe.title.length > 0,
    JSON.stringify(bubbleBusyProbe)
  );
  translateDelayMs = 0;
  await wait(3800);
  const bubbleIdleProbe = await evalOn(page, `(() => {
    const bubble = document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble');
    return { text: bubble.textContent, busy: bubble.classList.contains('dsh-bubble-busy') };
  })()`);
  check(
    '悬浮球：翻译完成后恢复「译」',
    bubbleIdleProbe.busy === false && bubbleIdleProbe.text === '译',
    JSON.stringify(bubbleIdleProbe)
  );
  const translated = await evalOn(page, `(() => {
    const trans = Array.from(document.querySelectorAll('[data-dsh-it="trans"]'));
    return {
      count: trans.length,
      srcCount: document.querySelectorAll('[data-dsh-it="src"]').length,
      texts: trans.map((node) => node.textContent),
      tags: trans.map((node) => node.tagName),
      htmlMode: document.documentElement.getAttribute('data-dsh-it-mode'),
      hasStyle: !!document.getElementById('dsh-it-page-style'),
      status: document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-status').textContent,
      progress: document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-progress-num').textContent
    };
  })()`);
  check(
    '翻译：health/settings/translate 均经 background 出网',
    ['GET /dsh-immersive/api/health', 'GET /dsh-immersive/api/settings', 'POST /dsh-immersive/api/translate'].every((call) => apiCalls.includes(call)),
    apiCalls.join(', ')
  );
  check('翻译：注入译文节点', translated.count >= 2, 'count=' + translated.count + ' tags=' + translated.tags.join('/'));
  check('翻译：原文块标记 src', translated.srcCount === translated.count, 'src=' + translated.srcCount);
  check('翻译：译文为 mock 纯文本', translated.texts.every((text) => text.indexOf('【译文】') === 0), translated.texts[0]);
  const linkProbe = await evalOn(page, `(() => {
    const anchors = Array.from(document.querySelectorAll('[data-dsh-it="trans"] a'));
    const linkBlock = document.getElementById('link-block');
    const translation = linkBlock && linkBlock.nextElementSibling && linkBlock.nextElementSibling.getAttribute('data-dsh-it') === 'trans'
      ? linkBlock.nextElementSibling : null;
    return {
      anchors: anchors.map((anchor) => ({ href: anchor.getAttribute('href') || '', text: (anchor.textContent || '').trim() })),
      inBlock: translation ? Array.from(translation.querySelectorAll('a')).map((anchor) => ({ href: anchor.getAttribute('href') || '', text: (anchor.textContent || '').trim() })) : []
    };
  })()`);
  check(
    '超链接保留：块级译文按原文链接生成 <a>',
    linkProbe.inBlock.some((anchor) => /\/docs/.test(anchor.href) && anchor.text.length > 0),
    JSON.stringify(linkProbe)
  );
  const allUnitTexts = await evalOn(page, `Array.prototype.slice.call(document.querySelectorAll('[data-dsh-it="trans"],[data-dsh-it="trans-inline"]')).map((node) => node.textContent)`);
  check(
    '翻译：跳过 code/pre/可编辑区/纯数字（按钮文案现在会翻译）',
    !allUnitTexts.some((text) => /const x|Editable text/.test(text)) && !allUnitTexts.some((text) => /^【译文】?\s*12345$/.test(text)),
    allUnitTexts.filter((text) => /const x|Editable|12345/.test(text)).join(' | ')
  );
  const listItemProbe = await evalOn(page, `(() => {
    const li = document.querySelector('#content-li');
    const trans = li && li.querySelector('[data-dsh-it="trans"]');
    return {
      src: li ? li.getAttribute('data-dsh-it') : null,
      hasTrans: !!trans,
      insideLi: !!(trans && trans.parentElement === li),
      inlineFragments: li ? li.querySelectorAll('[data-dsh-it="trans-inline"]').length : -1,
      liCount: document.querySelectorAll('article ul li').length,
      text: li ? li.textContent.slice(0, 80) : null
    };
  })()`);
  check(
    '列表项：整项块级译文注入 li 内部，不新增条目/行内碎片',
    listItemProbe.src === 'src' &&
      listItemProbe.hasTrans === true &&
      listItemProbe.insideLi === true &&
      listItemProbe.inlineFragments === 0 &&
      listItemProbe.liCount === 1,
    JSON.stringify(listItemProbe)
  );

  const structuredCellProbe = await evalOn(page, `(() => {
    const cell = document.querySelector('#structured-toc-cell');
    if (!cell) return null;
    const blockTrans = cell.querySelector('[data-dsh-it="trans"]');
    return {
      srcMark: cell.getAttribute('data-dsh-it'),
      blockText: blockTrans ? blockTrans.textContent : '',
      inlineCount: cell.querySelectorAll('[data-dsh-it="trans-inline"]').length,
      anchors: Array.prototype.slice.call(cell.querySelectorAll('a')).map((link) => link.textContent)
    };
  })()`);
  check(
    '表格：结构化单元格不整格合并，内部链接逐条行内翻译',
    !!structuredCellProbe &&
      structuredCellProbe.srcMark === null &&
      structuredCellProbe.blockText === '' &&
      structuredCellProbe.inlineCount >= 2 &&
      structuredCellProbe.anchors[0].indexOf('【译文】') !== -1,
    JSON.stringify(structuredCellProbe)
  );

  const interleavedProbe = await evalOn(page, `(() => {
    const span = document.querySelector('#interleaved-inline');
    const wrap = span && span.querySelector('[data-dsh-it="src-inline"]');
    const trans = span && span.querySelector('[data-dsh-it="trans-inline"]');
    const link = span && span.querySelector('a');
    return {
      hasTrans: !!trans,
      afterWrap: !!(wrap && trans && wrap.nextElementSibling === trans),
      beforeLink: !!(trans && link && (trans.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)),
      text: trans ? trans.textContent.slice(0, 40) : null
    };
  })()`);
  check(
    '行内译文紧跟对应原文节点，不追加到容器末尾',
    interleavedProbe.hasTrans === true && interleavedProbe.afterWrap === true && interleavedProbe.beforeLink === true,
    JSON.stringify(interleavedProbe)
  );

  const sameSkipProbe = await evalOn(page, `(() => {
    const inline = document.querySelector('#same-trans');
    const block = document.querySelector('#same-block');
    const nextTrans = (el) => el && el.nextElementSibling && el.nextElementSibling.getAttribute('data-dsh-it') === 'trans' ? el.nextElementSibling : null;
    return {
      inlineText: inline ? inline.textContent : null,
      inlineTrans: inline ? inline.querySelectorAll('[data-dsh-it="trans-inline"]').length : -1,
      blockSrc: block ? block.getAttribute('data-dsh-it') : null,
      blockTrans: !!(block && nextTrans(block))
    };
  })()`);
  check(
    '相同译文去重：行内/块级都不重复注入',
    sameSkipProbe.inlineText === 'Patreon' &&
      sameSkipProbe.inlineTrans === 0 &&
      sameSkipProbe.blockSrc === null &&
      sameSkipProbe.blockTrans === false,
    JSON.stringify(sameSkipProbe)
  );

  const requestedTexts = translateBodies.reduce((all, body) => all.concat((body.texts || []).map((text) => String(text))), []);
  check(
    '段落归一：<br> 换行转空格，不粘连单词',
    requestedTexts.some((text) => text.indexOf('Broken line words') !== -1) && !requestedTexts.some((text) => text.indexOf('Brokenline') !== -1),
    requestedTexts.filter((text) => /Broken/.test(text)).join(' | ')
  );
  check(
    '段落归一：<br>/格式换行统一压平（可读性优先）',
    requestedTexts.every((text) => text.indexOf('\n') === -1 && text.indexOf('\r') === -1 && text.indexOf('\t') === -1 && !/ {2,}/.test(text)) &&
      requestedTexts.some((text) => text.indexOf('Roses are red Violets are blue') !== -1),
    requestedTexts.filter((text) => /[\n\r\t]| {2,}/.test(text)).join(' | ')
  );
  check(
    '段落归一：模型返回的段落译文不人为断行',
    translated.texts.every((text) => text.indexOf('\n') === -1),
    translated.texts.filter((text) => text.indexOf('\n') !== -1).join(' | ')
  );

  check('翻译：页面级模式样式注入', translated.hasStyle);
  check('翻译：html 模式属性 = bilingual', translated.htmlMode === 'bilingual', translated.htmlMode);
  check('翻译：面板状态/进度更新', /\d+ \/ \d+/.test(translated.progress || '') && !!translated.status, translated.progress + ' | ' + translated.status);

  /* 4.05) 请求元数据：translate POST body 带 client + 来源站点（Host 记账 / DSH 轨迹列） */
  const lastTranslateBody = translateBodies[translateBodies.length - 1];
  check(
    '元数据：translate 请求体带 client=extension + sourceUrl/sourceTitle',
    translateBodies.length > 0 &&
      translateBodies.every(
        (body) =>
          body.client === 'extension' &&
          typeof body.sourceUrl === 'string' &&
          body.sourceUrl.indexOf(pageOrigin + '/') === 0 &&
          body.sourceTitle === 'Extension E2E Test'
      ),
    JSON.stringify({
      count: translateBodies.length,
      client: lastTranslateBody && lastTranslateBody.client,
      sourceUrl: lastTranslateBody && lastTranslateBody.sourceUrl,
      sourceTitle: lastTranslateBody && lastTranslateBody.sourceTitle
    })
  );

  /* 4.15) 点击翻译后自动收起面板，只保留悬浮球 */
  const panelAfterTranslate = await evalOn(page, `(() => {
    const sh = document.getElementById('dsh-it-host').shadowRoot;
    return { hidden: sh.querySelector('.dsh-panel').hidden, bubble: !!sh.querySelector('.dsh-bubble'), status: sh.querySelector('.dsh-status').textContent };
  })()`);
  check(
    '悬浮窗：点击翻译后自动收起，仅保留悬浮球',
    panelAfterTranslate.hidden === true && panelAfterTranslate.bubble === true,
    JSON.stringify(panelAfterTranslate)
  );
  await evalOn(page, `(() => { const bubble = document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble'); bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); })()`);
  await wait(300);

  /* 4.1) Token 消耗：本页累加 / 今日累计 / 完成状态行 */
  const tokenProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const rowValue = (row) => {
      if (!row) return null;
      const value = row.querySelector('.dsh-tokens');
      return { text: value ? value.textContent : '', title: value ? value.title || '' : '', hidden: row.hidden };
    };
    return {
      panelOpen: !shadow.querySelector('.dsh-panel').hidden,
      page: rowValue(shadow.querySelector('[data-role="tokens-page"]')),
      today: rowValue(shadow.querySelector('[data-role="tokens-today"]')),
      status: shadow.querySelector('.dsh-status').textContent
    };
  })()`);
  const expectedPageUsage = translateUsages.slice(usageBaseline).reduce(
    (acc, usage) => ({ input: acc.input + usage.inputTokens, output: acc.output + usage.outputTokens }),
    { input: 0, output: 0 }
  );
  const parsedPageUsage = parseTokenLine(tokenProbe.page && tokenProbe.page.text);
  check(
    'Token：浮窗「本页消耗」= translate 响应 usage 累计（输入/输出）',
    tokenProbe.panelOpen === true &&
      !!parsedPageUsage &&
      parsedPageUsage.input === expectedPageUsage.input &&
      parsedPageUsage.output === expectedPageUsage.output &&
      expectedPageUsage.input > 0 &&
      /\d+/.test(tokenProbe.page.title),
    JSON.stringify({ panel: tokenProbe.page, expected: expectedPageUsage, responses: translateUsages.length - usageBaseline })
  );
  check(
    'Token：「今日累计」经 background GET /usage 并用 usage.today 渲染',
    apiCalls.includes('GET /dsh-immersive/api/usage') &&
      tokenProbe.today &&
      tokenProbe.today.hidden === false &&
      parseInteger(tokenProbe.today.text) === 3456 + 1234,
    JSON.stringify({ today: tokenProbe.today, usageCalls: apiCalls.filter((call) => call.endsWith('/usage')).length })
  );
  check(
    'Token：翻译完成状态行追加本页 token 摘要（statusDoneTokens）',
    /翻译完成/.test(tokenProbe.status) && /本页消耗/.test(tokenProbe.status) && /tokens/.test(tokenProbe.status),
    tokenProbe.status
  );

  /* 4.2) 悬浮面板 hover 按钮不应隐藏（bug 回归） */
  const btnProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const btn = shadow.querySelector('.dsh-actions .dsh-btn.primary');
    const r = btn.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: btn.textContent,
      opacity: getComputedStyle(btn).opacity,
      display: getComputedStyle(btn).display,
      visibility: getComputedStyle(btn).visibility,
      backgroundImage: getComputedStyle(btn).backgroundImage,
      color: getComputedStyle(btn).color,
      panelHidden: shadow.querySelector('.dsh-panel').hidden
    };
  })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btnProbe.x, y: btnProbe.y });
  await wait(250);
  const btnHover = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const btn = shadow.querySelector('.dsh-actions .dsh-btn.primary');
    const cs = getComputedStyle(btn);
    const panel = shadow.querySelector('.dsh-panel');
    return {
      text: btn.textContent,
      opacity: cs.opacity,
      display: cs.display,
      visibility: cs.visibility,
      color: cs.color,
      backgroundImage: cs.backgroundImage,
      panelHidden: panel.hidden,
      panelOpacity: getComputedStyle(panel).opacity
    };
  })()`);
  check(
    '悬浮窗：hover 按钮不隐藏、面板不消失',
    btnProbe.panelHidden === false && btnHover.panelHidden === false && btnHover.text === btnProbe.text &&
      btnHover.opacity === '1' && btnHover.display !== 'none' && btnHover.visibility !== 'hidden' &&
      // primary 按钮 hover 时仍保留渐变背景与白色文字（回归：白字白底看起来按钮消失）
      btnHover.backgroundImage.indexOf('linear-gradient') !== -1 && btnHover.color === 'rgb(255, 255, 255)',
    JSON.stringify({ before: btnProbe, after: btnHover })
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });

  /* 4.3) 右键菜单：dsh翻译 → 原文 / 译文 / 双语对照 */
  const contextModes = [];
  for (const mode of ['only', 'source', 'bilingual']) {
    await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:set-mode', mode: '${mode}' })`);
    await wait(350);
    contextModes.push(await evalOn(page, `document.documentElement.getAttribute('data-dsh-it-mode')`));
  }
  check(
    '右键菜单：原文 / 译文 / 双语对照 三模式可用',
    contextModes[0] === 'only' && contextModes[1] === 'source' && contextModes[2] === 'bilingual',
    JSON.stringify(contextModes)
  );

  /* 4.4) 居中排版：译文保持原文 text-align:center */
  const alignProbe = await evalOn(page, `(() => {
    const pick = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        textAlign: getComputedStyle(el).textAlign,
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        center: Math.round(rect.left + rect.width / 2)
      };
    };
    const nextTrans = (sel) => {
      const el = document.querySelector(sel);
      return el && el.nextElementSibling && el.nextElementSibling.getAttribute('data-dsh-it') === 'trans'
        ? el.nextElementSibling
        : null;
    };
    const h2 = document.querySelector('#center-h2');
    const h2Parts = h2
      ? Array.prototype.slice.call(h2.querySelectorAll('[data-dsh-it="src-inline"],[data-dsh-it="trans-inline"]'))
      : [];
    const h2Lines = h2Parts.map((el) => el.getBoundingClientRect());
    const h2Combined = h2Lines.length
      ? (() => {
          const left = Math.min.apply(null, h2Lines.map((r) => r.left));
          const right = Math.max.apply(null, h2Lines.map((r) => r.right));
          return { left: Math.round(left), right: Math.round(right), center: Math.round((left + right) / 2) };
        })()
      : null;
    return {
      p: pick(document.querySelector('#center-p')),
      pTrans: pick(nextTrans('#center-p')),
      narrow: pick(document.querySelector('#center-inline')),
      narrowTrans: pick(nextTrans('#center-inline')),
      h2: pick(h2),
      h2Trans: pick(h2 && h2.querySelector('[data-dsh-it="trans-inline"]')),
      h2Combined
    };
  })()`);
  check(
    '居中：正文译文保持原文 text-align:center',
    !!(alignProbe.p && alignProbe.pTrans && alignProbe.p.textAlign === 'center' && alignProbe.pTrans.textAlign === 'center'),
    JSON.stringify(alignProbe)
  );
  check(
    '居中：窄容器正文的译文盒子仍水平居中（margin auto）',
    !!(alignProbe.narrow && alignProbe.narrowTrans &&
      Math.abs(alignProbe.narrowTrans.center - alignProbe.narrow.center) <= 3 &&
      Math.abs(alignProbe.narrowTrans.width - alignProbe.narrow.width) <= 2),
    JSON.stringify({ src: alignProbe.narrow, trans: alignProbe.narrowTrans })
  );
  check(
    '居中：标题原文+译文整行仍居中',
    !!(alignProbe.h2 && alignProbe.h2Trans && alignProbe.h2.textAlign === 'center' &&
      alignProbe.h2Combined && Math.abs(alignProbe.h2Combined.center - alignProbe.h2.center) <= 4),
    JSON.stringify({ h2: alignProbe.h2, h2Trans: alignProbe.h2Trans, combined: alignProbe.h2Combined })
  );

  /* 4.5) 译文与原文同样式 + 标题并排 / 正文下方 */
  const typography = await evalOn(page, `(() => {
    const pick = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight, color: cs.color, display: cs.display,
        left: Math.round(rect.left), top: Math.round(rect.top),
        text: (el.textContent || '').slice(0, 120)
      };
    };
    const siblingTrans = (el) => (el && el.nextElementSibling && el.nextElementSibling.getAttribute('data-dsh-it') === 'trans' ? el.nextElementSibling : null);
    const h1 = document.querySelector('article h1');
    const h1t = h1 && h1.querySelector('[data-dsh-it="trans-inline"]');
    const h2 = document.querySelector('article h2');
    const h2t = h2 && h2.querySelector('[data-dsh-it="trans-inline"]');
    const p = document.querySelector('article p[data-dsh-it="src"]');
    const pt = siblingTrans(p);
    return {
      h1: pick(h1), h1t: pick(h1t), h2: pick(h2), h2t: pick(h2t), p: pick(p), pt: pick(pt),
      h1InlineParent: !!(h1t && h1t.parentElement === h1),
      h2InlineParent: !!(h2t && h2t.parentElement === h2),
      pLayout: p && p.getAttribute('data-dsh-it-layout'),
      ptLayout: pt && pt.getAttribute('data-dsh-it-layout')
    };
  })()`);
  const inlineProbe = await evalOn(page, `(() => {
    const inline = Array.from(document.querySelectorAll('[data-dsh-it="trans-inline"]'));
    const navLinks = Array.from(document.querySelectorAll('nav a'));
    const tagList = document.querySelector('ul.tags');
    const button = document.querySelector('button');
    return {
      count: inline.length,
      texts: inline.map((node) => node.textContent),
      navTexts: navLinks.map((link) => link.textContent),
      navItems: Array.prototype.slice.call(document.querySelectorAll('nav li')).map((item) => item.textContent),
      navTranslated: (document.querySelector('nav') || {}).textContent || '',
      tagLiCount: tagList ? tagList.querySelectorAll('li').length : 0,
      buttonText: button ? button.textContent : '',
      footerText: (document.querySelector('footer') || {}).textContent || '',
      srcInlineCount: document.querySelectorAll('[data-dsh-it="src-inline"]').length
    };
  })()`);
  check(
    '行内翻译：导航/标签/页脚/按钮文案均被翻译',
    inlineProbe.count > 0 &&
      inlineProbe.navTranslated.indexOf('【译文】Login') !== -1 &&
      inlineProbe.buttonText.indexOf('【译文】Button label') !== -1 &&
      inlineProbe.footerText.indexOf('【译文】Footer text') !== -1 &&
      inlineProbe.texts.join('|').indexOf('【译文】linux') !== -1,
    JSON.stringify({ count: inlineProbe.count, nav: inlineProbe.navTexts.slice(0, 2), button: inlineProbe.buttonText.slice(0, 60) })
  );
  check('行内翻译：不复制列表项（标签列表 li 数量保持 2）', inlineProbe.tagLiCount === 2, inlineProbe.tagLiCount);
  const dynamicColorProbe = await evalOn(page, `(() => {
    const button = document.querySelector('#dynamic-color');
    const trans = button && button.querySelector('[data-dsh-it="trans-inline"]');
    if (!trans) return null;
    button.style.color = 'rgb(255, 255, 255)';
    return { hostColor: getComputedStyle(button).color, transColor: getComputedStyle(trans).color };
  })()`);
  check(
    '行内译文颜色跟随宿主动态主题（黑底按钮变白字）',
    !!dynamicColorProbe && dynamicColorProbe.hostColor === dynamicColorProbe.transColor,
    JSON.stringify(dynamicColorProbe)
  );
  const labelStyle = await evalOn(page, `(() => {
    const styleOf = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily, color: cs.color, backgroundColor: cs.backgroundColor, borderRadius: cs.borderRadius };
    };
    const pick = (selector) => {
      const host = document.querySelector(selector);
      const trans = host && host.querySelector('[data-dsh-it="trans-inline"]');
      return { inside: !!(trans && trans.parentElement === host), host: styleOf(host), trans: styleOf(trans) };
    };
    return { tag: pick('ul.tags li a'), nav: pick('nav a'), button: pick('button'), tagLiCount: document.querySelectorAll('ul.tags li').length };
  })()`);
  const styleEqual = (pair) => {
    if (!pair || !pair.inside || !pair.host || !pair.trans) return false;
    return ['fontSize', 'fontWeight', 'fontFamily', 'color', 'backgroundColor'].every((key) => pair.host[key] === pair.trans[key]);
  };
  check(
    '行内翻译：译文位于 label/链接/按钮内部，字体/字号/颜色/背景与原文一致',
    styleEqual(labelStyle.tag) && styleEqual(labelStyle.nav) && styleEqual(labelStyle.button) && labelStyle.tagLiCount === 2,
    JSON.stringify(labelStyle)
  );
  check('行内翻译：原文文字被包裹以便「仅译文」隐藏', inlineProbe.srcInlineCount > 0, inlineProbe.srcInlineCount);

  check(
    '双语排版：标题译文与原文同字号/字重/字体/颜色/行高',
    !!(typography.h1 && typography.h1t &&
      typography.h1.fontSize === typography.h1t.fontSize &&
      typography.h1.fontWeight === typography.h1t.fontWeight &&
      typography.h1.fontFamily === typography.h1t.fontFamily &&
      typography.h1.lineHeight === typography.h1t.lineHeight &&
      typography.h1.color === typography.h1t.color),
    JSON.stringify({ src: typography.h1, trans: typography.h1t })
  );
  check(
    '双语排版：正文译文与原文同字号/颜色',
    !!(typography.p && typography.pt && typography.p.fontSize === typography.pt.fontSize && typography.p.color === typography.pt.color),
    JSON.stringify({ src: typography.p, trans: typography.pt })
  );
  check(
    '双语排版：标题译文紧跟原文（行内、可折行）',
    !!(typography.h1InlineParent && typography.h1 && typography.h1t &&
      typography.h1t.display === 'inline' && typography.h1.text.indexOf('【译文】') !== -1),
    JSON.stringify({ h1: typography.h1, h1t: typography.h1t, inside: typography.h1InlineParent })
  );
  check(
    '双语排版：标签/按钮等行内译文同样紧跟原文',
    !!(typography.h2InlineParent && typography.h2 && typography.h2.text.indexOf('【译文】') !== -1),
    JSON.stringify({ h2: typography.h2, h2t: typography.h2t, inside: typography.h2InlineParent })
  );
  check(
    '双语排版：正文译文仍在原文下方',
    !!(typography.pLayout === null && typography.ptLayout === 'below' && typography.pt && typography.p && typography.pt.top > typography.p.top),
    JSON.stringify({ p: typography.p, pt: typography.pt, layouts: [typography.pLayout, typography.ptLayout] })
  );

  /* 5) 三模式 */
  const translateCallsBefore = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  await evalOn(sw, `chrome.storage.local.set({ mode: 'only' })`);
  await wait(400);
  const onlyMode = await evalOn(page, `({
    html: document.documentElement.getAttribute('data-dsh-it-mode'),
    host: document.getElementById('dsh-it-host').getAttribute('data-dsh-it-mode'),
    srcVisible: (() => { const el = document.querySelector('[data-dsh-it="src"]'); return el ? getComputedStyle(el).display !== 'none' : null; })(),
    cellVisibility: (() => { const td = document.querySelector('td[data-dsh-it="src"]'); return td ? getComputedStyle(td).visibility : null; })(),
    transVisible: (() => { const el = document.querySelector('[data-dsh-it="trans"]'); return el ? getComputedStyle(el).display !== 'none' : null; })()
  })`);
  const onlyInline = await evalOn(page, `(() => {
    const src = document.querySelector('nav [data-dsh-it="src-inline"]');
    const trans = document.querySelector('nav [data-dsh-it="trans-inline"]');
    return {
      srcHidden: src ? getComputedStyle(src).display === 'none' : null,
      transVisible: trans ? getComputedStyle(trans).display !== 'none' : null
    };
  })()`);
  check(
    '模式「仅译文」：行内原文隐藏/行内译文可见（导航）',
    onlyInline.srcHidden === true && onlyInline.transVisible === true,
    JSON.stringify(onlyInline)
  );
  check(
    '模式「仅译文」：属性切换 + 原文隐藏/译文可见（含单元格）',
    onlyMode.html === 'only' && onlyMode.host === 'only' && onlyMode.srcVisible === false && onlyMode.transVisible === true && onlyMode.cellVisibility === 'hidden',
    JSON.stringify(onlyMode)
  );
  await evalOn(sw, `chrome.storage.local.set({ mode: 'source' })`);
  await wait(400);
  const sourceMode = await evalOn(page, `({
    html: document.documentElement.getAttribute('data-dsh-it-mode'),
    transVisible: (() => { const el = document.querySelector('[data-dsh-it="trans"]'); return el ? getComputedStyle(el).display !== 'none' : null; })(),
    srcVisible: (() => { const el = document.querySelector('[data-dsh-it="src"]'); return el ? getComputedStyle(el).display !== 'none' : null; })()
  })`);
  check('模式「原文」：译文隐藏/原文可见', sourceMode.html === 'source' && sourceMode.transVisible === false && sourceMode.srcVisible === true, JSON.stringify(sourceMode));
  await evalOn(sw, `chrome.storage.local.set({ mode: 'bilingual' })`);
  await wait(400);
  const translateCallsAfter = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  check('模式切换不重新请求翻译', translateCallsAfter === translateCallsBefore, translateCallsBefore + ' -> ' + translateCallsAfter);

  /* 5.9) 划词/双击/快捷键翻译：默认关闭 */
  const setTranslateFlags = (patch) => evalOn(sw, `chrome.storage.local.set(${JSON.stringify(patch)})`);
  const lookupCallCount = () => apiCalls.filter((call) => call === 'POST /dsh-immersive/api/lookup').length;
  const cardOpen = () => evalOn(page, `(() => {
    const card = document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-card');
    return !!(card && !card.hidden);
  })()`);
  const selectParagraphText = (withDoubleClick) => evalOn(page, `(() => {
    const p = document.querySelector('article p');
    const node = p && p.firstChild;
    if (!node || node.nodeType !== 3) return '';
    const index = node.nodeValue.indexOf('paragraph');
    if (index < 0) return '';
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 'paragraph'.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    ${withDoubleClick ? "p.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));" : ''}
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    return selection.toString();
  })()`);

  await setTranslateFlags({ selectionTranslate: false, doubleClickTranslate: false, shortcutTranslate: false });
  await wait(450);
  const defaultSelection = await selectParagraphText(false);
  await wait(800);
  check(
    '默认关闭：划词不弹翻译卡',
    defaultSelection === 'paragraph' && (await cardOpen()) === false,
    'selection=' + defaultSelection
  );
  await selectParagraphText(true);
  await wait(800);
  check('默认关闭：双击不弹翻译卡', (await cardOpen()) === false, 'double-click');
  await selectParagraphText(false);
  await wait(250);
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:shortcut-translate' })`);
  await wait(700);
  const shortcutOffProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const card = shadow.querySelector('.dsh-card');
    const toast = shadow.querySelector('.dsh-toast');
    return { open: !!(card && !card.hidden), toast: toast ? toast.textContent : '' };
  })()`);
  check(
    '默认关闭：快捷键翻译不生效并给出提示',
    shortcutOffProbe.open === false && shortcutOffProbe.toast.indexOf('未启用') !== -1,
    JSON.stringify(shortcutOffProbe)
  );
  await evalOn(page, `window.getSelection().removeAllRanges()`);
  await setTranslateFlags({ selectionTranslate: true });
  await wait(450);

  /* 6) 划词查词卡 + 加入单词本 */
  const selection = await evalOn(page, `(() => {
    const p = document.querySelector('article p');
    const node = p.firstChild;
    const index = node.nodeValue.indexOf('paragraph');
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 'paragraph'.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    return selection.toString();
  })()`);
  check('划词：选区文本 = paragraph', selection === 'paragraph', selection);
  await wait(900);
  const cardProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const card = shadow.querySelector('.dsh-card');
    const add = Array.from(shadow.querySelectorAll('.dsh-card .dsh-btn')).find((button) => (button.textContent || '').indexOf('加入') !== -1);
    return {
      open: card && !card.hidden,
      src: (shadow.querySelector('.dsh-card-src') || {}).textContent,
      trans: (shadow.querySelector('.dsh-card-trans') || {}).textContent,
      phon: (shadow.querySelector('.dsh-card-phon') || {}).textContent,
      dictionary: shadow.querySelectorAll('.dsh-dict-def').length,
      tokens: (shadow.querySelector('.dsh-card-tokens') || {}).textContent,
      tokensHidden: shadow.querySelector('.dsh-card-tokens') ? shadow.querySelector('.dsh-card-tokens').hidden : null,
      addLabel: add ? add.textContent : null,
      addDisabled: add ? add.disabled : null,
      left: card && card.style.left,
      top: card && card.style.top
    };
  })()`);
  check(
    '查词卡：弹出并显示原文/译文/音标/词典',
    cardProbe.open && cardProbe.src === 'paragraph' && cardProbe.trans === '段落' && cardProbe.phon === '/ˈpærəɡræf/' && cardProbe.dictionary >= 1,
    JSON.stringify(cardProbe)
  );
  const parsedCardUsage = parseTokenLine(cardProbe.tokens);
  check(
    '查词卡：显示「本次查询 输入 X · 输出 Y tokens」',
    cardProbe.tokensHidden === false &&
      !!parsedCardUsage &&
      parsedCardUsage.input === 21 &&
      parsedCardUsage.output === 8 &&
      String(cardProbe.tokens).indexOf('本次查询') !== -1,
    JSON.stringify({ tokens: cardProbe.tokens, hidden: cardProbe.tokensHidden, parsed: parsedCardUsage })
  );
  const lastLookupBody = lookupBodies[lookupBodies.length - 1];
  check(
    '元数据：lookup 请求体带 client=extension + sourceUrl/sourceTitle',
    lookupBodies.length > 0 &&
      lookupBodies.every(
        (body) =>
          body.client === 'extension' &&
          typeof body.sourceUrl === 'string' &&
          body.sourceUrl.indexOf(pageOrigin + '/') === 0 &&
          body.sourceTitle === 'Extension E2E Test'
      ),
    JSON.stringify({
      count: lookupBodies.length,
      client: lastLookupBody && lastLookupBody.client,
      sourceUrl: lastLookupBody && lastLookupBody.sourceUrl,
      sourceTitle: lastLookupBody && lastLookupBody.sourceTitle
    })
  );
  check('查词卡：单词可加入，按钮可用', cardProbe.addLabel === '加入单词本' && cardProbe.addDisabled === false, cardProbe.addLabel + '/' + cardProbe.addDisabled);
  const addResult = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const add = Array.from(shadow.querySelectorAll('.dsh-card .dsh-btn')).find((button) => (button.textContent || '').indexOf('加入') !== -1);
    if (!add) return 'no-button';
    add.click();
    return 'clicked';
  })()`);
  await wait(700);
  const addedLabel = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const add = Array.from(shadow.querySelectorAll('.dsh-card .dsh-btn')).find((button) => (button.textContent || '').indexOf('已加入') !== -1);
    return add ? add.textContent : null;
  })()`);
  check('加入单词本：按钮变「已加入」', addResult === 'clicked' && addedLabel === '已加入', addResult + '/' + addedLabel);
  check('加入单词本：经 background 调 wordbook/add', apiCalls.includes('POST /dsh-immersive/api/wordbook/add'));
  await evalOn(page, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(200);
  const cardClosed = await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-card').hidden`);
  check('查词卡：Esc 关闭', cardClosed === true);

  /* 6.5) 双击翻译 / 快捷键翻译开关 */
  const lookupBeforeDouble = lookupCallCount();
  await setTranslateFlags({ selectionTranslate: false, doubleClickTranslate: true });
  await wait(450);
  await selectParagraphText(true);
  await wait(900);
  check(
    '双击翻译：开启后双击弹出翻译卡',
    (await cardOpen()) === true && lookupCallCount() > lookupBeforeDouble,
    'lookup ' + lookupBeforeDouble + '->' + lookupCallCount()
  );
  await evalOn(page, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(250);

  const lookupBeforeShortcut = lookupCallCount();
  await setTranslateFlags({ doubleClickTranslate: false, shortcutTranslate: true });
  await wait(450);
  await selectParagraphText(false);
  await wait(250);
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:shortcut-translate' })`);
  await wait(900);
  const shortcutOnProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const card = shadow.querySelector('.dsh-card');
    return { open: !!(card && !card.hidden) };
  })()`);
  check(
    '快捷键翻译：开启后按快捷键翻译选中文本',
    shortcutOnProbe.open === true && lookupCallCount() > lookupBeforeShortcut,
    JSON.stringify({ probe: shortcutOnProbe, lookup: lookupBeforeShortcut + '->' + lookupCallCount() })
  );
  await evalOn(page, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await evalOn(page, `window.getSelection().removeAllRanges()`);
  await wait(250);

  const commands = await evalOn(sw, `(async () => await chrome.commands.getAll())()`);
  check(
    '自定义快捷键：shortcut-translate 命令已注册（可在 chrome://extensions/shortcuts 改键）',
    Array.isArray(commands) && commands.some((command) => command.name === 'shortcut-translate'),
    JSON.stringify(commands)
  );
  await setTranslateFlags({ selectionTranslate: true, doubleClickTranslate: false, shortcutTranslate: false });
  await wait(300);

  /* 7) 还原 */
  await fireToggle();
  await wait(900);
  const restored = await evalOn(page, `(() => ({
    trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
    src: document.querySelectorAll('[data-dsh-it="src"]').length,
    inlineTrans: document.querySelectorAll('[data-dsh-it="trans-inline"]').length,
    inlineSrc: document.querySelectorAll('[data-dsh-it="src-inline"]').length,
    navText: Array.prototype.slice.call(document.querySelectorAll('nav a')).map((link) => link.textContent).join('|'),
    style: !!document.getElementById('dsh-it-page-style'),
    htmlMode: document.documentElement.getAttribute('data-dsh-it-mode'),
    host: !!document.getElementById('dsh-it-host'),
    bubble: !!document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble'),
    pageTokens: (document.getElementById('dsh-it-host').shadowRoot.querySelector('[data-role="tokens-page"] .dsh-tokens') || {}).textContent,
    status: document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-status').textContent
  }))()`);
  check(
    '还原：译文/行内译文/标记/页面样式全部移除，导航原文恢复',
    restored.trans === 0 && restored.src === 0 && restored.inlineTrans === 0 && restored.inlineSrc === 0 &&
      restored.navText === 'Login|Help' && restored.style === false && restored.htmlMode === null,
    JSON.stringify(restored)
  );
  check('还原：「本页消耗」清零回到「—」', restored.pageTokens === '—', JSON.stringify({ pageTokens: restored.pageTokens }));
  check('还原：扩展 UI（悬浮球）保留', restored.host === true && restored.bubble === true && restored.status.indexOf('已还原') !== -1, restored.status);

  /* 7.5) 按屏调度（默认）：整屏（+preload 一屏）一次翻译；滚动停稳后补翻新屏幕 */
  await evalOn(page, `(() => {
    const article = document.querySelector('article') || document.body;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 60; i += 1) {
      const p = document.createElement('p');
      p.textContent = 'Lazy-loaded filler paragraph ' + i + ' with a medium length English sentence for viewport testing.';
      frag.appendChild(p);
    }
    article.appendChild(frag);
    window.scrollTo(0, 0);
    return document.querySelectorAll('article p').length;
  })()`);
  await wait(500);
  const callsBeforeLazy = countTranslateCalls();
  await fireToggle();
  await wait(2000);
  const lazyInitial = await evalOn(page, `(() => {
    const trans = Array.from(document.querySelectorAll('[data-dsh-it="trans"]'));
    const fillers = trans
      .map((node) => node.textContent)
      .filter((text) => /Lazy-loaded filler paragraph/.test(text))
      .map((text) => Number((text.match(/filler paragraph (\\d+)/) || [])[1]))
      .filter((value) => Number.isFinite(value));
    return {
      trans: trans.length,
      totalP: document.querySelectorAll('article p').length,
      maxFiller: fillers.length ? Math.max.apply(null, fillers) : -1,
      status: document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-status').textContent,
      progress: document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-progress-num').textContent
    };
  })()`);
  const callsAfterInitial = countTranslateCalls();
  const initialScreenCalls = callsAfterInitial - callsBeforeLazy;
  check(
    '按屏调度：首屏整屏（含 preload 一屏）一次翻译，不翻整页',
    lazyInitial.trans > 0 && lazyInitial.trans < lazyInitial.totalP,
    'trans=' + lazyInitial.trans + ' totalP=' + lazyInitial.totalP + ' calls=' + initialScreenCalls + ' progress=' + lazyInitial.progress
  );
  check(
    '按屏调度：首屏请求数小（≈ceil(段数/10)，不再 1~3 段一请求）',
    initialScreenCalls >= 1 && initialScreenCalls <= Math.ceil(lazyInitial.trans / 10) + 1 && lazyInitial.trans / initialScreenCalls >= 4,
    JSON.stringify({ trans: lazyInitial.trans, calls: initialScreenCalls })
  );
  check(
    '按屏调度：preload 一屏之外的远处段落不翻译',
    lazyInitial.maxFiller >= 0 && lazyInitial.maxFiller < 40,
    JSON.stringify({ maxFiller: lazyInitial.maxFiller, trans: lazyInitial.trans })
  );
  // 快速跳到底部：中间屏幕不翻译；停稳防抖 140ms 后只补当前屏幕
  const callsBeforeJump = countTranslateCalls();
  await evalOn(page, `window.scrollTo(0, document.documentElement.scrollHeight)`);
  await wait(1300);
  const lazyJumped = await evalOn(page, `(() => {
    const trans = Array.from(document.querySelectorAll('[data-dsh-it="trans"]'));
    const fillers = trans
      .map((node) => node.textContent)
      .filter((text) => /Lazy-loaded filler paragraph/.test(text))
      .map((text) => Number((text.match(/filler paragraph (\\d+)/) || [])[1]))
      .filter((value) => Number.isFinite(value));
    return {
      trans: trans.length,
      fillers: fillers,
      status: document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-status').textContent
    };
  })()`);
  const callsAfterScroll = countTranslateCalls();
  check(
    '按屏调度：滚动停稳后继续翻译新屏幕',
    lazyJumped.trans > lazyInitial.trans && callsAfterScroll > callsAfterInitial,
    'trans ' + lazyInitial.trans + ' -> ' + lazyJumped.trans + ', calls ' + initialScreenCalls + ' -> ' + (callsAfterScroll - callsBeforeLazy) + ', jumpCalls=' + (callsAfterScroll - callsBeforeJump)
  );
  check(
    '按屏调度：快速跳转不翻译中间屏幕（中间段落保持未翻译）',
    lazyJumped.fillers.length > 0 && !lazyJumped.fillers.some((index) => index >= 25 && index <= 45),
    JSON.stringify({ fillers: lazyJumped.fillers })
  );
  // 结束本次会话并还原页面，避免影响后续 phase
  await restorePage();

  /* 7.55) block 模式回归：按块懒加载 + 微批合并（省 token 模式） */
  await setStorage({ scheduleMode: 'block' });
  await evalOn(page, `window.scrollTo(0, 0)`);
  await wait(500);
  const blockCallsBefore = countTranslateCalls();
  await fireToggle(); // block 模式：首屏逐块入队，走 180ms 微批合并
  await wait(1800);
  const blockInitial = await evalOn(page, `({
    trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
    totalP: document.querySelectorAll('article p').length
  })`);
  const blockInitialCalls = countTranslateCalls() - blockCallsBefore;
  check(
    'block 模式回归：首屏只翻视口 + 预载（不整页），逐块入队',
    blockInitial.trans > 0 && blockInitial.trans < blockInitial.totalP,
    JSON.stringify({ trans: blockInitial.trans, totalP: blockInitial.totalP, calls: blockInitialCalls })
  );
  const burstStartCalls = countTranslateCalls();
  const burstStartTrans = await countTranslatedNodes();
  // 12 次小步滚动：每次只让少量块进入视口，制造“1~3 块就入队”的零散小批次
  for (let i = 0; i < 12; i += 1) {
    await evalOn(page, `window.scrollBy(0, 220)`);
    await wait(70);
  }
  await wait(1800); // 等最后一个合并窗口 + 在途批次完成
  const burstEndCalls = countTranslateCalls();
  const burstEndTrans = await countTranslatedNodes();
  const burstNewBlocks = burstEndTrans - burstStartTrans;
  const burstNewCalls = burstEndCalls - burstStartCalls;
  check(
    'block 模式微批合并：小步滚动确实翻译了新的零散段落',
    burstNewBlocks >= 4,
    JSON.stringify({ newBlocks: burstNewBlocks, newCalls: burstNewCalls })
  );
  check(
    'block 模式微批合并：零散小批次被合并（请求数 ≤ ceil(新译段数 / 2) + 2）',
    burstNewCalls >= 1 && burstNewCalls <= Math.ceil(burstNewBlocks / 2) + 2,
    JSON.stringify({
      newBlocks: burstNewBlocks,
      newCalls: burstNewCalls,
      avgSegmentsPerRequest: burstNewCalls ? (burstNewBlocks / burstNewCalls).toFixed(2) : '0'
    })
  );
  // 结束本次会话并还原，避免影响后续 phase
  await restorePage();
  const burstCallsAfterRestore = countTranslateCalls();
  await wait(700); // 若有未清理的合并定时器，这里会多出一次延迟发送的请求
  check(
    'block 模式微批合并：停止/还原后合并定时器已清理（无延迟批次再发出）',
    countTranslateCalls() === burstCallsAfterRestore,
    JSON.stringify({ calls: burstCallsAfterRestore + '->' + countTranslateCalls() })
  );

  /* 7.56) 按屏调度：preload none/half/one、快速滚动不翻中间屏、扫描定时器清理 */
  await setStorage({ scheduleMode: 'screen' });
  const preloadCounts = {};
  for (const preload of ['none', 'half', 'one']) {
    await setStorage({ preload });
    await evalOn(page, `window.scrollTo(0, 0)`);
    await wait(300);
    await fireToggle();
    await wait(1800);
    preloadCounts[preload] = await countTranslatedNodes();
    await restorePage();
  }
  check(
    '按屏调度：preload=none 只翻当前视口（有译文）',
    preloadCounts.none > 0,
    JSON.stringify(preloadCounts)
  );
  check(
    '按屏调度：preload 越多首屏翻译越多（none < half < one）',
    preloadCounts.none < preloadCounts.half && preloadCounts.half < preloadCounts.one,
    JSON.stringify(preloadCounts)
  );
  await setStorage({ preload: 'one' });
  await evalOn(page, `window.scrollTo(0, 0)`);
  await wait(400);

  // 快速连续滚动：滚动期间不发中间屏幕请求；停稳 140ms 后只补一屏
  await fireToggle();
  await wait(1800);
  const callsBeforeFast = countTranslateCalls();
  for (let i = 0; i < 8; i += 1) {
    await evalOn(page, `window.scrollBy(0, 320)`);
    await wait(60);
  }
  await wait(80); // 防抖 140ms 尚未触发
  const callsDuringFast = countTranslateCalls();
  check(
    '按屏调度：快速连续滚动期间不发中间屏幕请求',
    callsDuringFast === callsBeforeFast,
    JSON.stringify({ calls: callsBeforeFast + '->' + callsDuringFast })
  );
  await wait(1500); // 停稳 → 扫描 → 补翻新屏幕
  const callsAfterFast = countTranslateCalls();
  const transAfterFast = await countTranslatedNodes();
  check(
    '按屏调度：滚动停稳后补翻新屏幕（一次爆发，请求数少）',
    callsAfterFast > callsBeforeFast && callsAfterFast - callsBeforeFast <= 4 && transAfterFast > 0,
    JSON.stringify({ calls: callsBeforeFast + '->' + callsAfterFast, trans: transAfterFast })
  );
  await restorePage();

  // 停止/还原时清理按屏扫描定时器：定时器 pending 时立即还原，之后不应再有请求
  await fireToggle();
  await wait(1800);
  const callsBeforeTimer = countTranslateCalls();
  await evalOn(page, `window.scrollBy(0, 400)`);
  await wait(60); // 扫描防抖尚未触发
  await fireToggle(); // lazyActive 空闲 → 还原页面，清理定时器
  await wait(900);
  await restorePage();
  check(
    '按屏调度：停止/还原后扫描定时器已清理（无延迟请求）',
    countTranslateCalls() === callsBeforeTimer,
    JSON.stringify({ calls: callsBeforeTimer + '->' + countTranslateCalls() })
  );

  /* 7.6) 右键菜单：翻译选中文本 */
  const menuSelection = await evalOn(page, `(() => {
    const p = document.querySelector('article p');
    if (!p || !p.firstChild) return null;
    const node = p.firstChild;
    const index = node.nodeValue.indexOf('paragraph');
    if (index < 0) return null;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 'paragraph'.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 80 }));
    return selection.toString();
  })()`);
  const lookupBefore = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/lookup').length;
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:translate-selection' })`);
  await wait(1000);
  const menuCard = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const card = shadow.querySelector('.dsh-card');
    return {
      open: !!(card && !card.hidden),
      src: (shadow.querySelector('.dsh-card-src') || {}).textContent
    };
  })()`);
  const lookupAfter = apiCalls.filter((call) => call === 'POST /dsh-immersive/api/lookup').length;
  check(
    '右键菜单：翻译选中文本 → 弹出查词卡并发起 lookup',
    menuSelection === 'paragraph' && menuCard.open === true && menuCard.src === 'paragraph' && lookupAfter > lookupBefore,
    'selection=' + menuSelection + ' card=' + JSON.stringify(menuCard) + ' lookup=' + lookupBefore + '->' + lookupAfter
  );
  await evalOn(page, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

  /* 7.7) 轨迹（Turn）：一次翻译动作 = 一个 turnId，内部批次 = stepIndex 递增；查词 = 单步 Turn */
  const turnGroups = [];
  const turnGroupIndex = new Map();
  for (const body of translateBodies) {
    const turnId = String(body.turnId || '');
    if (!turnGroupIndex.has(turnId)) {
      turnGroupIndex.set(turnId, []);
      turnGroups.push(turnGroupIndex.get(turnId));
    }
    turnGroupIndex.get(turnId).push(body);
  }
  const isTurnStep = (value) => Number.isInteger(value) && value >= 0 && value <= 10000;
  check(
    '轨迹：translate 请求体带 tr_ turnId / stepIndex / mode',
    translateBodies.length > 0 &&
      translateBodies.every(
        (body) =>
          /^tr_/.test(String(body.turnId || '')) &&
          isTurnStep(body.stepIndex) &&
          ['source', 'bilingual', 'only'].indexOf(body.mode) !== -1
      ) &&
      turnGroups.every((group) => group.every((body, index) => body.stepIndex === index)),
    JSON.stringify({
      bodies: translateBodies.length,
      turns: turnGroups.length,
      steps: turnGroups.map((group) => group.map((body) => body.stepIndex)),
      first: translateBodies[0] && {
        turnId: translateBodies[0].turnId,
        stepIndex: translateBodies[0].stepIndex,
        mode: translateBodies[0].mode
      }
    })
  );
  // 懒加载会话（7.5）首批 + 滚动续译的批次必须共用同一个 turnId，stepIndex 从 0 严格递增
  const lazyTurnBodies = translateBodies.slice(callsBeforeLazy, callsAfterScroll);
  const lazyTurnId = lazyTurnBodies.length ? String(lazyTurnBodies[0].turnId || '') : '';
  check(
    '轨迹：同一次翻译 run 的懒加载批次共用 turnId、stepIndex 递增',
    lazyTurnBodies.length === callsAfterScroll - callsBeforeLazy &&
      lazyTurnBodies.length >= 2 &&
      /^tr_/.test(lazyTurnId) &&
      lazyTurnBodies.every((body, index) => String(body.turnId || '') === lazyTurnId && body.stepIndex === index) &&
      translateBodies.slice(0, callsBeforeLazy).every((body) => String(body.turnId || '') !== lazyTurnId),
    JSON.stringify({
      turnId: lazyTurnId,
      callsBeforeLazy,
      callsAfterScroll,
      stepIndexes: lazyTurnBodies.map((body) => body.stepIndex)
    })
  );
  const translateTurnIds = turnGroups.map((group) => String((group[0] || {}).turnId || ''));
  check(
    '轨迹：新的翻译动作生成新的 turnId（不同 run = 不同 Turn）',
    turnGroups.length >= 2 &&
      translateTurnIds.every((turnId) => /^tr_/.test(turnId)) &&
      new Set(translateTurnIds).size === translateTurnIds.length,
    JSON.stringify({ turns: turnGroups.length, sizes: turnGroups.map((group) => group.length), ids: translateTurnIds })
  );
  const lookupTurnIds = lookupBodies.map((body) => String(body.turnId || ''));
  check(
    '轨迹：lookup 请求体带 lk_ turnId、stepIndex=0（每次查词 = 单步 Turn）',
    lookupBodies.length > 0 &&
      lookupBodies.every((body) => /^lk_/.test(String(body.turnId || '')) && body.stepIndex === 0) &&
      new Set(lookupTurnIds).size === lookupTurnIds.length,
    JSON.stringify({
      count: lookupBodies.length,
      ids: lookupTurnIds,
      stepIndexes: lookupBodies.map((body) => body.stepIndex)
    })
  );

  /* 7.8) 跟随翻译：翻译 A 后打开 B 自动翻译；还原/关闭选项后不跟随 */
  const countFollowTranslateCalls = () => apiCalls.filter((call) => call === 'POST /dsh-immersive/api/translate').length;
  // 先在当前页 A 上翻译，开启跟随
  await fireToggle();
  await wait(3200);
  const beforeFollowCalls = countFollowTranslateCalls();
  const clickElement = async (selector) => {
    const point = await evalOn(page, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    if (!point) return false;
    await wait(250);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return true;
  };
  // 同标签链接：用 DOM click 避免翻译布局抖动导致坐标点偏
  const clickedSameTab = await evalOn(page, `(() => {
    const link = document.querySelector('#next-link');
    if (!link) return false;
    link.click();
    return true;
  })()`);
  let followedB = null;
  for (let i = 0; i < 25; i += 1) {
    await wait(400);
    followedB = await evalOn(page, `(() => {
      const host = document.getElementById('dsh-it-host');
      return {
        search: location.search,
        trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
        inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length,
        panelHidden: host && host.shadowRoot.querySelector('.dsh-panel') ? host.shadowRoot.querySelector('.dsh-panel').hidden : null
      };
    })()`);
    if (followedB.search.indexOf('follow=clicked') !== -1 && followedB.trans + followedB.inline > 0) break;
  }
  check(
    '跟随翻译：A 翻译后点击链接打开的同标签页自动翻译',
    clickedSameTab && followedB.search.indexOf('follow=clicked') !== -1 && followedB.trans + followedB.inline > 0 && countFollowTranslateCalls() > beforeFollowCalls,
    JSON.stringify({ page: followedB, calls: beforeFollowCalls + '->' + countFollowTranslateCalls(), clicked: clickedSameTab })
  );

  // 新标签：从已翻译页点击 target=_blank 链接，新标签也应自动翻译
  const clickedNewTab = await clickElement('#blank-link');
  let blankTarget = null;
  for (let i = 0; i < 20 && !blankTarget; i += 1) {
    await wait(300);
    const targets = await getJson(base + '/json/list');
    blankTarget = targets.find((target) => target.type === 'page' && String(target.url).indexOf('follow=blank') !== -1) || null;
  }
  check('跟随翻译：新标签页已打开', clickedNewTab && !!blankTarget, JSON.stringify({ clicked: clickedNewTab, target: blankTarget && blankTarget.url }));
  if (blankTarget) {
    const newTab = new CDP(blankTarget.webSocketDebuggerUrl);
    await newTab.connect();
    await newTab.send('Runtime.enable');
    await newTab.send('Page.enable');
    let newTabProbe = null;
    for (let i = 0; i < 12; i += 1) {
      await wait(500);
      newTabProbe = await evalOn(newTab, `({
        search: location.search,
        trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
        inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length
      })`);
      if (newTabProbe && newTabProbe.trans + newTabProbe.inline > 0) break;
    }
    check(
      '跟随翻译：从已翻译页打开的新标签自动翻译',
      !!(newTabProbe && newTabProbe.search.indexOf('follow=blank') !== -1 && newTabProbe.trans + newTabProbe.inline > 0),
      JSON.stringify(newTabProbe)
    );
    await browser.send('Target.closeTarget', { targetId: blankTarget.id });
    newTab.close();
    await wait(500);
  }
  await fireToggle();
  await wait(800);
  await page.send('Page.navigate', { url: pageUrl + '?follow=c' });
  await wait(4000);
  const followedC = await evalOn(page, `({
    search: location.search,
    trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
    inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length
  })`);
  check(
    '跟随翻译：还原页面后不再跟随',
    followedC.search.indexOf('follow=c') !== -1 && followedC.trans + followedC.inline === 0,
    JSON.stringify(followedC)
  );
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: false })`);
  await wait(400);
  await fireToggle();
  await wait(3200);
  const pageCTranslated = await evalOn(page, `document.querySelectorAll('[data-dsh-it="trans"]').length + document.querySelectorAll('[data-dsh-it="trans-inline"]').length`);
  await page.send('Page.navigate', { url: pageUrl + '?follow=d' });
  await wait(4000);
  const followedD = await evalOn(page, `({
    search: location.search,
    trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
    inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length
  })`);
  check(
    '跟随翻译：选项关闭后不自动跟随',
    pageCTranslated > 0 && followedD.search.indexOf('follow=d') !== -1 && followedD.trans + followedD.inline === 0,
    JSON.stringify({ manual: pageCTranslated, next: followedD })
  );
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: true })`);
  await wait(400);

  /* 7.8) 悬浮球域名隐藏：面板/右键入口 + 刷新后仍然隐藏 */
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:toggle-panel' })`);
  await wait(300);
  const domainToggleFound = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const button = shadow.querySelector('[data-role="domain-ball"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await wait(500);
  const domainHiddenProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const bubble = shadow.querySelector('.dsh-bubble');
    const panel = shadow.querySelector('.dsh-panel');
    const toast = shadow.querySelector('.dsh-toast');
    return { bubbleHidden: bubble.hidden, panelHidden: panel.hidden, toast: toast ? toast.textContent : '' };
  })()`);
  check(
    '悬浮球域名隐藏：功能页入口可隐藏当前域名悬浮球',
    domainToggleFound === true && domainHiddenProbe.bubbleHidden === true && ballSites.indexOf('127.0.0.1') !== -1,
    JSON.stringify({ probe: domainHiddenProbe, sites: ballSites.slice() })
  );
  await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('[data-role="domain-ball"]').click()`);
  await wait(500);
  const domainShownProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden };
  })()`);
  check(
    '悬浮球域名隐藏：再次点击可恢复当前域名悬浮球',
    domainShownProbe.bubbleHidden === false && ballSites.length === 0,
    JSON.stringify({ probe: domainShownProbe, sites: ballSites.slice() })
  );
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:hide-domain' })`);
  await wait(500);
  const menuDomainProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const bubble = shadow.querySelector('.dsh-bubble');
    const toast = shadow.querySelector('.dsh-toast');
    return { bubbleHidden: bubble.hidden, toast: toast ? toast.textContent : '' };
  })()`);
  check(
    '悬浮球域名隐藏：右键菜单「当前域名不展示悬浮球」生效',
    menuDomainProbe.bubbleHidden === true && ballSites.indexOf('127.0.0.1') !== -1,
    JSON.stringify({ probe: menuDomainProbe, sites: ballSites.slice() })
  );
  await page.send('Page.navigate', { url: pageUrl + '?domainhidden=1' });
  await wait(3500);
  const reloadedDomainProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden, host: location.hostname };
  })()`);
  check(
    '悬浮球域名隐藏：刷新/新页面加载后仍不展示',
    reloadedDomainProbe.bubbleHidden === true && reloadedDomainProbe.host === '127.0.0.1',
    JSON.stringify(reloadedDomainProbe)
  );
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:toggle-panel' })`);
  await wait(300);
  await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('[data-role="domain-ball"]').click()`);
  await wait(500);
  const restoredDomainProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden };
  })()`);
  check(
    '悬浮球域名隐藏：从 DSH 列表移除后恢复显示',
    restoredDomainProbe.bubbleHidden === false && ballSites.length === 0,
    JSON.stringify({ probe: restoredDomainProbe, sites: ballSites.slice() })
  );
  await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-panel-head .dsh-icon-btn').click()`);
  await wait(200);

  /* 7.9) 语言一致时隐藏悬浮球（默认开启，可关闭） */
  await evalOn(sw, `chrome.storage.local.set({ targetLanguage: 'en' })`);
  await wait(650);
  console.log('DEBUG same-lang:', JSON.stringify(await evalOn(sw, `(async()=>await chrome.storage.local.get(null))()`)), JSON.stringify(await evalOn(page, `({lang:document.documentElement.lang, title:document.title})`)));
  const sameLangHidden = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden, lang: document.documentElement.lang };
  })()`);
  check(
    '语言一致隐藏悬浮球：默认开启时页面语言=目标语言则不显示',
    sameLangHidden.bubbleHidden === true && sameLangHidden.lang === 'en',
    JSON.stringify(sameLangHidden)
  );
  await evalOn(sw, `chrome.storage.local.set({ hideBallSameLanguage: false })`);
  await wait(650);
  const sameLangShown = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden };
  })()`);
  check('语言一致隐藏悬浮球：关闭开关后恢复显示', sameLangShown.bubbleHidden === false, JSON.stringify(sameLangShown));
  await evalOn(sw, `chrome.storage.local.set({ hideBallSameLanguage: true, targetLanguage: 'zh-CN' })`);
  await wait(650);
  const sameLangReset = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    return { bubbleHidden: shadow.querySelector('.dsh-bubble').hidden };
  })()`);
  check('语言一致隐藏悬浮球：目标语言不同/重置后显示', sameLangReset.bubbleHidden === false, JSON.stringify(sameLangReset));

  // options 页检查默认值：先把三个默认关闭的功能重置为默认
  await evalOn(sw, `chrome.storage.local.set({ selectionTranslate: false, doubleClickTranslate: false, shortcutTranslate: false, followTranslation: true, showFloatingBall: true, hideBallSameLanguage: true, targetLanguage: 'zh-CN', scheduleMode: 'screen', preload: 'one' })`);
  await wait(350);

  /* 7.95) 长段落（>800 字符）：按块级翻译，而不是退化成行内碎片 */
  const longPageUrl = pageOrigin + '/long.html';
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: false, autoTranslate: false })`);
  await evalOn(sw, `chrome.storage.session.remove('dsh-it:follow:${tab.id}')`);
  await page.send('Page.navigate', { url: longPageUrl });
  await wait(1800);
  await fireToggle();
  await wait(2600);
  const longParagraphProbe = await evalOn(page, `(() => {
    const long = document.querySelector('#long-paragraph');
    const next = long && long.nextElementSibling;
    const host = document.getElementById('dsh-it-host');
    const shadow = host && host.shadowRoot;
    return {
      src: long ? long.getAttribute('data-dsh-it') : null,
      hasTrans: !!(next && next.getAttribute('data-dsh-it') === 'trans'),
      transLength: next ? next.textContent.length : 0,
      textLength: long ? long.textContent.length : 0,
      host: !!host,
      status: shadow ? shadow.querySelector('.dsh-status').textContent : null,
      transCount: document.querySelectorAll('[data-dsh-it="trans"]').length,
      inlineCount: document.querySelectorAll('[data-dsh-it="trans-inline"]').length
    };
  })()`);
  check(
    '长段落（>800 字符）按块级翻译而非行内碎片',
    longParagraphProbe.textLength > 800 &&
      longParagraphProbe.src === 'src' &&
      longParagraphProbe.hasTrans === true &&
      longParagraphProbe.transLength >= 10,
    JSON.stringify(longParagraphProbe)
  );
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: false })`);
  await evalOn(sw, `chrome.storage.session.remove('dsh-it:follow:${tab.id}')`);
  await page.send('Page.navigate', { url: pageOrigin + '/compact.html' });
  await wait(1600);
  await fireToggle();
  await wait(2200);
  const compactNavProbe = await evalOn(page, `(() => {
    const link = document.querySelector('#compact-nav-link');
    const trans = link && link.querySelector('[data-dsh-it="trans-inline"]');
    if (!trans) return null;
    const style = getComputedStyle(trans);
    return {
      compact: trans.hasAttribute('data-dsh-it-compact'),
      display: style.display,
      fontSize: style.fontSize,
      hostHeight: Math.round(link.getBoundingClientRect().height),
      scrollWidth: document.documentElement.scrollWidth
    };
  })()`);
  check(
    '紧凑导航：折行的行内译文改为小字块级译注',
    !!compactNavProbe && compactNavProbe.compact === true && compactNavProbe.display === 'block',
    JSON.stringify(compactNavProbe)
  );
  const compactTabProbe = await evalOn(page, `(() => {
    const tab = document.querySelector('#compact-tab');
    const trans = tab && tab.querySelector('[data-dsh-it="trans-inline"]');
    if (!trans) return null;
    return {
      compact: trans.hasAttribute('data-dsh-it-compact'),
      display: getComputedStyle(trans).display,
      hostHeight: Math.round(tab.getBoundingClientRect().height)
    };
  })()`);
  check(
    '紧凑 UI 控件：tab bar 标签折行时改为小字块级译注',
    !!compactTabProbe && compactTabProbe.compact === true && compactTabProbe.display === 'block',
    JSON.stringify(compactTabProbe)
  );
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: true })`);

  /* 7.96) SPA 路由变化：懒加载未完成也会提示重新翻译 */
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: false })`);
  await evalOn(sw, `chrome.storage.session.remove('dsh-it:follow:${tab.id}')`);
  await page.send('Page.navigate', { url: pageOrigin + '/test.html?spa=1' });
  await wait(1600);
  await fireToggle();
  await wait(1800);
  await evalOn(page, `history.pushState({}, '', '/test.html?spa=2')`);
  await wait(2200);
  const spaProbe = await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const shadow = host && host.shadowRoot;
    return {
      url: location.search,
      status: shadow ? shadow.querySelector('.dsh-status').textContent : null
    };
  })()`);
  check(
    'SPA 路由变化：懒加载未完成也会提示重新翻译',
    /页面已跳转|Page navigated/.test(spaProbe.status || ''),
    JSON.stringify(spaProbe)
  );
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: true })`);

  /* 7.97) iframe 翻译：默认关闭；开启后子框架翻译，且子框架无 UI */
  await evalOn(sw, `chrome.storage.local.set({ translateIframes: false, followTranslation: false, autoTranslate: false })`);
  await evalOn(sw, `chrome.storage.session.remove('dsh-it:follow:${tab.id}')`);
  await page.send('Page.navigate', { url: pageOrigin + '/iframe-parent.html' });
  await wait(1800);
  await fireToggle();
  await wait(1800);
  const iframeOffProbe = await evalOn(page, `(() => {
    const frame = document.getElementById('test-frame');
    const doc = frame && frame.contentDocument;
    return {
      frameLoaded: !!(doc && doc.body),
      host: !!(doc && doc.getElementById('dsh-it-host')),
      trans: doc ? doc.querySelectorAll('[data-dsh-it="trans"]').length : -1,
      inline: doc ? doc.querySelectorAll('[data-dsh-it="trans-inline"]').length : -1
    };
  })()`);
  check(
    'iframe 翻译：默认关闭时子框架不翻译、不注入 UI',
    iframeOffProbe.frameLoaded === true && iframeOffProbe.host === false && iframeOffProbe.trans === 0 && iframeOffProbe.inline === 0,
    JSON.stringify(iframeOffProbe)
  );
  await fireToggle();
  await wait(600);
  await evalOn(sw, `chrome.storage.local.set({ translateIframes: true })`);
  await wait(650);
  await fireToggle();
  await wait(3200);
  const iframeOnProbe = await evalOn(page, `(() => {
    const frame = document.getElementById('test-frame');
    const doc = frame && frame.contentDocument;
    return {
      frameLoaded: !!(doc && doc.body),
      host: !!(doc && doc.getElementById('dsh-it-host')),
      trans: doc ? doc.querySelectorAll('[data-dsh-it="trans"]').length : -1,
      inline: doc ? doc.querySelectorAll('[data-dsh-it="trans-inline"]').length : -1,
      text: doc && doc.body ? doc.body.textContent.slice(0, 80) : null
    };
  })()`);
  check(
    'iframe 翻译：开启后子框架内容被翻译且不显示悬浮球',
    iframeOnProbe.frameLoaded === true && iframeOnProbe.host === false && (iframeOnProbe.trans + iframeOnProbe.inline) > 0,
    JSON.stringify(iframeOnProbe)
  );
  await fireToggle();
  await wait(1200);
  const iframeRestoredProbe = await evalOn(page, `(() => {
    const frame = document.getElementById('test-frame');
    const doc = frame && frame.contentDocument;
    return {
      trans: doc ? doc.querySelectorAll('[data-dsh-it]').length : -1
    };
  })()`);
  check('iframe 翻译：还原时子框架译文一并清理', iframeRestoredProbe.trans === 0, JSON.stringify(iframeRestoredProbe));
  await evalOn(sw, `chrome.storage.local.set({ translateIframes: false, followTranslation: true })`);

  /* 7.98) 按站点自动翻译：命中站点后页面加载即自动翻译；面板可关闭 */
  await evalOn(sw, `chrome.storage.local.set({ autoTranslateSites: ['127.0.0.1'], autoTranslate: false, followTranslation: false })`);
  await evalOn(sw, `chrome.storage.session.remove('dsh-it:follow:${tab.id}')`);
  await page.send('Page.navigate', { url: pageOrigin + '/autosite.html' });
  await wait(3600);
  const autoSiteProbe = await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const shadow = host && host.shadowRoot;
    return {
      trans: document.querySelectorAll('[data-dsh-it="trans"]').length,
      inline: document.querySelectorAll('[data-dsh-it="trans-inline"]').length,
      panelHidden: shadow ? shadow.querySelector('.dsh-panel').hidden : null,
      autoButton: shadow ? (shadow.querySelector('[data-role="auto-site"]') || {}).textContent : null
    };
  })()`);
  check(
    '按站点自动翻译：站点命中后页面加载即自动翻译（面板不自动弹出）',
    (autoSiteProbe.trans + autoSiteProbe.inline) > 0 && autoSiteProbe.panelHidden === true,
    JSON.stringify(autoSiteProbe)
  );
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:toggle-panel' })`);
  await wait(400);
  const autoSitePanelProbe = await evalOn(page, `(() => {
    const shadow = document.getElementById('dsh-it-host').shadowRoot;
    const button = shadow.querySelector('[data-role="auto-site"]');
    return { text: button ? button.textContent : null, hidden: !!(button && button.hidden) };
  })()`);
  check(
    '按站点自动翻译：功能面板显示“取消本站自动翻译”',
    !!autoSitePanelProbe.text && /取消|Stop auto/.test(autoSitePanelProbe.text) && autoSitePanelProbe.hidden === false,
    JSON.stringify(autoSitePanelProbe)
  );
  await evalOn(page, `(() => { document.getElementById('dsh-it-host').shadowRoot.querySelector('[data-role="auto-site"]').click(); })()`);
  await wait(600);
  const autoSiteResetProbe = await evalOn(sw, `(async () => (await chrome.storage.local.get(['autoTranslateSites'])).autoTranslateSites || [])()`);
  check(
    '按站点自动翻译：面板可关闭并写回 storage',
    Array.isArray(autoSiteResetProbe) && autoSiteResetProbe.length === 0,
    JSON.stringify(autoSiteResetProbe)
  );
  await evalOn(sw, `chrome.storage.local.set({ autoTranslateSites: [], followTranslation: true, autoTranslate: false })`);

  /* 7.9) 网格/弹性父级中的长段落：旧扫描会整段跳过 */
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: false, autoTranslate: false })`);
  await evalOn(sw, `chrome.storage.session.remove('dsh-it:follow:${tab.id}')`);
  await page.send('Page.navigate', { url: pageOrigin + '/flow-parents.html' });
  await wait(1800);
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:toggle' })`);
  await wait(2500);
  await evalOn(page, `document.getElementById('grid-long').scrollIntoView({ block: 'center' })`);
  await wait(800);
  await evalOn(page, `document.getElementById('flex-long').scrollIntoView({ block: 'center' })`);
  await wait(1200);
  const flowParentProbe = await evalOn(page, `(() => {
    const probe = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      let next = el.nextElementSibling;
      let transNext = false;
      for (let k = 0; next && k < 4; k += 1, next = next.nextElementSibling) {
        if (next.getAttribute && next.getAttribute('data-dsh-it') === 'trans') { transNext = true; break; }
      }
      let transNode = null;
      let cursor = el.nextElementSibling;
      for (let k = 0; cursor && k < 4; k += 1, cursor = cursor.nextElementSibling) {
        if (cursor.getAttribute && cursor.getAttribute('data-dsh-it') === 'trans') { transNode = cursor; break; }
      }
      const after = document.getElementById('after-grid');
      const transRect = transNode ? transNode.getBoundingClientRect() : null;
      const afterRect = after ? after.getBoundingClientRect() : null;
      return {
        src: el.getAttribute('data-dsh-it'),
        transNext,
        transInside: !!el.querySelector('[data-dsh-it="trans"]'),
        display: getComputedStyle(el.parentElement).display,
        transMarginBottom: transNode ? getComputedStyle(transNode).marginBottom : '',
        srcMarginBottom: getComputedStyle(el).marginBottom,
        afterGap: transRect && afterRect ? Math.round(afterRect.top - transRect.bottom) : null
      };
    };
    return { grid: probe('grid-long'), flex: probe('flex-long') };
  })()`);
  check(
    '边界布局：grid 父级的长段落仍被翻译（不丢整段）',
    !!flowParentProbe.grid && flowParentProbe.grid.src === 'src' && flowParentProbe.grid.transNext === true,
    JSON.stringify(flowParentProbe.grid)
  );
  check(
    '边界布局：grid 译文与下一段原文保持段落间距',
    !!flowParentProbe.grid &&
      parseFloat(flowParentProbe.grid.transMarginBottom) > parseFloat(flowParentProbe.grid.srcMarginBottom) &&
      typeof flowParentProbe.grid.afterGap === 'number' &&
      flowParentProbe.grid.afterGap > parseFloat(flowParentProbe.grid.srcMarginBottom),
    JSON.stringify(flowParentProbe.grid)
  );
  check(
    '边界布局：flex 父级的长段落翻译注入到段落内部',
    !!flowParentProbe.flex && flowParentProbe.flex.src === 'src' &&
      (flowParentProbe.flex.transInside === true || flowParentProbe.flex.transNext === true),
    JSON.stringify(flowParentProbe.flex)
  );
  await evalOn(page, `window.scrollTo(0, 0)`); await wait(400);
  await evalOn(sw, `chrome.storage.local.set({ followTranslation: true })`);

  /* 8) options 页 */
  try {
    const created = await browser.send('Target.createTarget', { url: 'chrome-extension://' + extensionId + '/options.html' });
    await wait(1200);
    const list = await getJson(base + '/json/list');
    const optionsTarget = list.find((target) => target.id === created.targetId);
    const optionsPage = new CDP(optionsTarget.webSocketDebuggerUrl);
    await optionsPage.connect();
    const optionsProbe = await evalOn(optionsPage, `(() => ({
      title: document.title,
      baseUrl: (document.getElementById('baseUrl') || {}).value,
      langs: (document.getElementById('targetLanguage') || { options: [] }).options.length,
      langValues: Array.from((document.getElementById('targetLanguage') || { options: [] }).options).map((option) => option.value).join(','),
      mode: (document.getElementById('mode') || {}).value,
      scheduleMode: (document.getElementById('scheduleMode') || {}).value,
      scheduleOptions: Array.from((document.getElementById('scheduleMode') || { options: [] }).options).map((option) => option.value).join(','),
      preload: (document.getElementById('preload') || {}).value,
      preloadOptions: Array.from((document.getElementById('preload') || { options: [] }).options).map((option) => option.value).join(','),
      auto: (document.getElementById('autoTranslate') || {}).checked,
      selectionTranslate: (document.getElementById('selectionTranslate') || {}).checked,
      doubleClickTranslate: (document.getElementById('doubleClickTranslate') || {}).checked,
      shortcutTranslate: (document.getElementById('shortcutTranslate') || {}).checked,
      follow: (document.getElementById('followTranslation') || {}).checked,
      showBall: (document.getElementById('showFloatingBall') || {}).checked,
      hideSameLang: (document.getElementById('hideBallSameLanguage') || {}).checked,
      hasAutoSiteInput: !!document.getElementById('autoSiteInput'),
      translateIframes: (document.getElementById('translateIframes') || {}).checked,
      labels: document.querySelectorAll('[data-i18n]').length
    }))()`);
    check('options.html 加载：标题正确', String(optionsProbe.title).indexOf('dsh翻译') !== -1, optionsProbe.title);
    check('options.js 运行：12 个目标语言下拉（默认 zh-CN）', optionsProbe.langs === 12 && optionsProbe.langValues.split(',')[0] === 'zh-CN', optionsProbe.langs + ':' + optionsProbe.langValues);
    check('options.js 运行：DSH 地址默认 127.0.0.1:3080', optionsProbe.baseUrl === 'http://127.0.0.1:3080', optionsProbe.baseUrl);
    check('options.js 运行：默认模式 bilingual / 自动翻译 off', optionsProbe.mode === 'bilingual' && optionsProbe.auto === false, optionsProbe.mode + '/' + optionsProbe.auto);
    check(
      'options.js 运行：调度方式默认 screen（按屏触发）/ 预加载默认 one',
      optionsProbe.scheduleMode === 'screen' && optionsProbe.preload === 'one' &&
        optionsProbe.scheduleOptions === 'screen,block' && optionsProbe.preloadOptions === 'none,half,one',
      JSON.stringify({ scheduleMode: optionsProbe.scheduleMode, preload: optionsProbe.preload })
    );
    check(
      'options.js 运行：划词/双击/快捷键翻译默认关闭',
      optionsProbe.selectionTranslate === false && optionsProbe.doubleClickTranslate === false && optionsProbe.shortcutTranslate === false,
      JSON.stringify(optionsProbe)
    );
    check('options.js 运行：跟随翻译默认开启', optionsProbe.follow === true, String(optionsProbe.follow));
    check('options.js 运行：显示悬浮球默认开启', optionsProbe.showBall === true, String(optionsProbe.showBall));
    check('options.js 运行：语言一致隐藏悬浮球默认开启', optionsProbe.hideSameLang === true, String(optionsProbe.hideSameLang));
    check('options.js 运行：iframe 翻译默认关闭', optionsProbe.translateIframes === false, String(optionsProbe.translateIframes));
    check('options.html 运行：自动翻译站点输入存在', optionsProbe.hasAutoSiteInput === true, String(optionsProbe.hasAutoSiteInput));
    optionsPage.close();
  } catch (err) {
    check('options.html 加载', false, errorText(err));
  }

  check('全程页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

  const failed = results.filter((result) => !result.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' E2E checks passed');
  return failed.length ? 1 : 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error('E2E 运行失败: ' + errorText(err));
} finally {
  await cleanup();
}
if (exitCode === 0) console.log('\nE2E OK（headless Chrome + mock DSH API；未触发真实模型调用）');
process.exit(exitCode);
