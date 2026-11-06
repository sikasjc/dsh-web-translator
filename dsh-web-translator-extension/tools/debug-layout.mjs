/*!
 * 调试：在 headless Chrome 中加载真实页面（默认 https://lobste.rs/），
 * 触发翻译前后对比布局指标并输出截图，用于定位注入译文导致的排版问题。
 *
 * 用法：node tools/debug-layout.mjs [url]
 * 输出：/tmp/dsh-it-debug/{before,after}.png 与逐节点注入报告
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET_URL = process.argv[2] || 'https://lobste.rs/';
const OUT_DIR = '/tmp/dsh-it-debug';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
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
      const data = await getJson('http://127.0.0.1:' + port + '/json/version');
      if (data && data.webSocketDebuggerUrl) return data;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  return null;
}

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
      this.ws.addEventListener('error', () => reject(new Error('WebSocket connect failed')), { once: true });
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
          } catch {
            /* ignore */
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
          reject(new Error('CDP timeout: ' + method));
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

function mockApiResponse(path, request) {
  if (path.endsWith('/health')) return { ok: true, version: 'mock', uptimeMs: 1, llm: { providers: 1, models: 1 } };
  if (path.endsWith('/settings')) {
    return {
      ok: true,
      settings: { provider: 'mock', model: 'mock-model', reasoningEffort: 'off', targetLanguage: 'zh-CN' },
      selected: { provider: 'mock', model: 'mock-model', reasoningEffort: 'off', source: 'settings' },
      modelInfo: { provider: 'mock', model: 'mock-model', reasoningEfforts: [], contextWindow: 0, maxTokens: 0 }
    };
  }
  if (path.endsWith('/translate')) {
    const body = request.postData ? JSON.parse(request.postData) : {};
    return {
      ok: true,
      translations: (body.texts || []).map((text) => '【译】' + text),
      provider: 'mock',
      model: 'mock-model',
      reasoningEffort: 'off',
      usage: { inputTokens: 1, outputTokens: 1 },
      cached: false
    };
  }
  return { ok: false, error: { code: 'NOT_FOUND', message: 'mock' } };
}

let chromeProcess = null;
let profileDir = null;

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
  if (profileDir) {
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const BEFORE_EXPR = `(() => {
  const stories = Array.from(document.querySelectorAll('ol.stories > li'));
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    storyCount: stories.length,
    stories: stories.slice(0, 8).map((li) => {
      const h2 = li.querySelector('h2.link');
      const details = li.querySelector('div.details');
      const r = li.getBoundingClientRect();
      return {
        li: { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width), display: getComputedStyle(li).display },
        h2: h2 ? { top: Math.round(h2.getBoundingClientRect().top), height: Math.round(h2.getBoundingClientRect().height), display: getComputedStyle(h2).display, fontSize: getComputedStyle(h2).fontSize, width: Math.round(h2.getBoundingClientRect().width) } : null,
        details: details ? { display: getComputedStyle(details).display, height: Math.round(details.getBoundingClientRect().height) } : null
      };
    }),
    candidates: (() => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          const tag = node.tagName;
          if (['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','DT','DD','FIGCAPTION','TD','TH','CAPTION','SUMMARY','DIV','SPAN'].includes(tag)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      }, false);
      let n = walker.nextNode();
      while (n && out.length < 4000) {
        const text = (n.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text.length >= 2 && text.length <= 800) out.push(n.tagName + (n.className && typeof n.className === 'string' ? '.' + n.className.split(/\\s+/).slice(0, 2).join('.') : ''));
        n = walker.nextNode();
      }
      return out.length;
    })()
  };
})()`;

const AFTER_EXPR = `(() => {
  const trans = Array.from(document.querySelectorAll('[data-dsh-it="trans"]'));
  const srcs = Array.from(document.querySelectorAll('[data-dsh-it="src"]'));
  const parents = new Map();
  const rows = trans.map((node) => {
    const parent = node.parentElement;
    const key = parent ? parent.tagName + '|' + (typeof parent.className === 'string' ? parent.className : '') : 'none';
    parents.set(key, (parents.get(key) || 0) + 1);
    const r = node.getBoundingClientRect();
    return {
      tag: node.tagName,
      cls: typeof node.className === 'string' ? node.className : '',
      layout: node.getAttribute('data-dsh-it-layout'),
      display: getComputedStyle(node).display,
      width: Math.round(r.width),
      height: Math.round(r.height),
      parent: parent ? { tag: parent.tagName, cls: typeof parent.className === 'string' ? parent.className : '', display: getComputedStyle(parent).display } : null
    };
  });
  return {
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    transCount: trans.length,
    srcCount: srcs.length,
    inlineCount: document.querySelectorAll('[data-dsh-it="trans-inline"]').length,
    inlineSamples: Array.prototype.slice.call(document.querySelectorAll('[data-dsh-it="trans-inline"]')).slice(0, 8).map((node) => node.textContent),
    tagLiCount: document.querySelectorAll('ul.tags li').length,
    navLinkCount: document.querySelectorAll('nav a, header a').length,
    inlineStyleChecks: (() => {
      const styleOf = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
          color: cs.color, backgroundColor: cs.backgroundColor, borderRadius: cs.borderRadius,
          parentTag: el.parentElement ? el.parentElement.tagName : null
        };
      };
      const pick = (selector) => {
        const host = document.querySelector(selector);
        if (!host) return null;
        const trans = host.querySelector('[data-dsh-it="trans-inline"]');
        return { selector, host: styleOf(host), trans: styleOf(trans), insideHost: !!(trans && trans.parentElement === host) };
      };
      return ['ul.tags li a', 'nav a', 'button'].map(pick).filter(Boolean);
    })(),
    bylineInfo: Array.prototype.slice.call(document.querySelectorAll('div.byline')).slice(0, 3).map((b) => ({
      textLen: (b.textContent || '').replace(/\s+/g, ' ').trim().length,
      text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      children: Array.prototype.slice.call(b.children).map((child) => ({ tag: child.tagName, display: getComputedStyle(child).display })),
      hasTrans: !!b.nextElementSibling && b.nextElementSibling.getAttribute('data-dsh-it') === 'trans'
    })),
    sampleFonts: (() => {
      const pick = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { selector, fontSize: cs.fontSize, fontFamily: cs.fontFamily, tag: el.tagName, text: (el.textContent || '').slice(0, 40) };
      };
      return ['div.byline', 'div.details', 'ul.tags', 'ol.stories', 'div.story_liner', 'a.u-url'].map(pick).filter(Boolean);
    })(),
    parents: Array.from(parents.entries()),
    rows: rows.slice(0, 40),
    srcRows: srcs.slice(0, 12).map((node) => ({
      tag: node.tagName,
      cls: typeof node.className === 'string' ? node.className : '',
      display: getComputedStyle(node).display,
      width: Math.round(node.getBoundingClientRect().width),
      height: Math.round(node.getBoundingClientRect().height),
      layout: node.getAttribute('data-dsh-it-layout')
    })),
    status: (() => {
      const host = document.getElementById('dsh-it-host');
      return host && host.shadowRoot ? host.shadowRoot.querySelector('.dsh-status').textContent : '';
    })(),
    firstStories: Array.from(document.querySelectorAll('ol.stories > li')).slice(0, 8).map((li) => {
      const r = li.getBoundingClientRect();
      const h2 = li.querySelector('h2.link');
      return {
        top: Math.round(r.top),
        height: Math.round(r.height),
        width: Math.round(r.width),
        h2Display: h2 ? getComputedStyle(h2).display : null,
        h2Height: h2 ? Math.round(h2.getBoundingClientRect().height) : null
      };
    })
  };
})()`;

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('no chrome');
    return 1;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const cdpPort = await getFreePort();
  profileDir = await mkdtemp(join(tmpdir(), 'dsh-it-debug-'));
  chromeProcess = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-breakpad',
    '--window-size=1280,900', '--enable-unsafe-extension-debugging',
    '--user-data-dir=' + profileDir, '--remote-debugging-port=' + cdpPort, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProcess.stderr.on('data', () => {});
  const version = await waitForCdp(cdpPort, 20000);
  if (!version) { console.log('no cdp'); return 1; }
  const base = 'http://127.0.0.1:' + cdpPort;
  const browser = new CDP(version.webSocketDebuggerUrl);
  await browser.connect();
  const loaded = await browser.send('Extensions.loadUnpacked', { path: ROOT });
  console.log('extension:', loaded.id);
  await sleep(1200);

  const pages = await getJson(base + '/json/list');
  const pageTarget = pages.find((target) => target.type === 'page');
  const page = new CDP(pageTarget.webSocketDebuggerUrl);
  await page.connect();
  const pageErrors = [];
  page.on('Runtime.exceptionThrown', (params) => pageErrors.push(JSON.stringify(params.exceptionDetails).slice(0, 200)));
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  if (process.env.DARK) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  }
  await page.send('Page.navigate', { url: TARGET_URL });
  await sleep(6000);
  const before = await evalOn(page, BEFORE_EXPR);
  const beforeShot = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT_DIR, 'before.png'), Buffer.from(beforeShot.data, 'base64'));
  console.log('\n=== BEFORE ===');
  console.log(JSON.stringify({ url: before.url, title: before.title, scrollHeight: before.scrollHeight, scrollWidth: before.scrollWidth, storyCount: before.storyCount }, null, 2));
  console.log('stories:', JSON.stringify(before.stories, null, 2));

  const swList = await getJson(base + '/json/list');
  const swInfo = swList.find((target) => target.type === 'service_worker' && String(target.url).endsWith('/background.js'));
  const sw = new CDP(swInfo.webSocketDebuggerUrl);
  await sw.connect();
  if (!process.env.NO_MOCK) sw.on('Fetch.requestPaused', async (params) => {
    try {
      const request = params.request;
      const path = new URL(request.url).pathname;
      const body = Buffer.from(JSON.stringify(mockApiResponse(path, request))).toString('base64');
      await sw.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body
      });
    } catch {
      /* ignore */
    }
  });
  if (!process.env.NO_MOCK) await sw.send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:3080/dsh-immersive/api/*', requestStage: 'Request' }] });
  await sw.send('Runtime.enable');
  const tabs = await evalOn(sw, `(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id, url: tab.url })))()`);
  const tab = tabs.find((item) => item.url && item.url.indexOf('lobste.rs') !== -1) || tabs[0];
  console.log('\ntab:', JSON.stringify(tabs));
  await evalOn(sw, `chrome.tabs.sendMessage(${tab.id}, { type: 'dsh-it:toggle' })`);
  await sleep(9000);
  // 悬浮面板 hover 探测：鼠标移到主按钮上，检查按钮/面板是否被隐藏
  const hoverBefore = await evalOn(page, `(() => {
    const sh = document.getElementById('dsh-it-host').shadowRoot;
    const btn = sh.querySelector('.dsh-actions .dsh-btn.primary');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      text: btn.textContent, opacity: getComputedStyle(btn).opacity, display: getComputedStyle(btn).display,
      visibility: getComputedStyle(btn).visibility, panelHidden: sh.querySelector('.dsh-panel').hidden
    };
  })()`);
  if (hoverBefore) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverBefore.x, y: hoverBefore.y });
    await sleep(350);
    const hoverAfter = await evalOn(page, `(() => {
      const sh = document.getElementById('dsh-it-host').shadowRoot;
      const btn = sh.querySelector('.dsh-actions .dsh-btn.primary');
      const cs = btn && getComputedStyle(btn);
      const panel = sh.querySelector('.dsh-panel');
      return {
        text: btn ? btn.textContent : null, opacity: cs ? cs.opacity : null, display: cs ? cs.display : null,
        visibility: cs ? cs.visibility : null, color: cs ? cs.color : null,
        panelHidden: panel.hidden, panelOpacity: getComputedStyle(panel).opacity,
        activeElement: document.activeElement && document.activeElement.tagName
      };
    })()`);
    console.log('panel hover:', JSON.stringify({ before: hoverBefore, after: hoverAfter }, null, 2));
  }

  if (process.env.PROBE_EXPR) {
    try {
      const probeResult = await evalOn(page, process.env.PROBE_EXPR);
      console.log('\nPROBE:', JSON.stringify(probeResult, null, 2));
    } catch (err) {
      console.log('\nPROBE ERROR:', String(err));
    }
  }

  // 关闭扩展面板，截图里只保留页面本身的翻译效果，便于前后对比
  await evalOn(page, `(() => {
    const host = document.getElementById('dsh-it-host');
    const shadow = host && host.shadowRoot;
    const closeBtn = shadow && shadow.querySelector('.dsh-panel-head .dsh-icon-btn');
    if (closeBtn) closeBtn.click();
    return true;
  })()`);
  await sleep(300);
  const after = await evalOn(page, AFTER_EXPR);
  const afterShot = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT_DIR, 'after.png'), Buffer.from(afterShot.data, 'base64'));
  console.log('\n=== AFTER ===');
  console.log(JSON.stringify({
    scrollHeight: after.scrollHeight,
    scrollWidth: after.scrollWidth,
    transCount: after.transCount,
    srcCount: after.srcCount,
    inlineCount: after.inlineCount,
    inlineSamples: after.inlineSamples,
    tagLiCount: after.tagLiCount,
    navLinkCount: after.navLinkCount,
    bylineInfo: after.bylineInfo,
    inlineStyleChecks: after.inlineStyleChecks,
    sampleFonts: after.sampleFonts,
    status: after.status,
    parents: after.parents,
    srcRows: after.srcRows,
    firstStories: after.firstStories,
    pageErrors
  }, null, 2));
  console.log('\ntrans rows:', JSON.stringify(after.rows, null, 2));

  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ target: TARGET_URL, before, after }, null, 2));
  console.log('\nscreenshots:', OUT_DIR + '/before.png', OUT_DIR + '/after.png');
  page.close();
  sw.close();
  browser.close();
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('debug failed:', err && err.stack ? err.stack : String(err));
} finally {
  await cleanup();
}
process.exit(code);
