#!/usr/bin/env node
/**
 * QA-only Chrome/CDP helpers (Node built-ins only).
 *
 * Used by `qa/panel-shot.mjs` to drive a throwaway headless Chrome against the
 * live DSH web GUI. Contains three pieces:
 *
 *  1. headless Chrome launch with a temp profile + remote debugging port 0
 *     (the actual port is parsed from Chrome's stderr "DevTools listening"
 *     line; stderr is always drained so Chrome can never stall on a full pipe);
 *  2. a tiny CDP WebSocket client with evaluate / waitFor / screenshot helpers;
 *  3. DSH web-GUI browser authentication for QA: pass the launch-token URL
 *     printed by `dsh web` in `DSH_URL` (it contains `?token=...`), or supply
 *     an authenticated browser-session cookie via `DSH_COOKIE`. This helper
 *     never reads DSH credentials and never mints cookies itself.
 *
 * QA-only tooling: source files are read-only for QA; nothing here imports the
 * plugin itself (except in the separate verify harness).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Common Chrome/Edge/Chromium locations (macOS first). */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

/** Sleep helper. */
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Locate a Chrome-family executable. */
export function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Reserve a free TCP port. */
export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

/** GET a JSON endpoint (used for /json/version and /json/list). */
export async function getJson(url, method = 'GET') {
  const response = await fetch(url, { method });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text.length > 0 ? JSON.parse(text) : {};
}

/** Poll /json/version until Chrome's DevTools endpoint answers. */
export async function waitForCdp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await getJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await wait(200);
    }
  }
  return null;
}

/** Minimal CDP client over WebSocket (Node >= 22 has a global WebSocket). */
export class CDP {
  constructor(wsUrl, { commandTimeoutMs = 30_000 } = {}) {
    this.wsUrl = wsUrl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`CDP WebSocket failed: ${this.wsUrl}`)), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} ${JSON.stringify(message.error.data ?? '')}`));
        else resolve(message.result);
      } else if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) {
          try {
            handler(message.params);
          } catch {
            /* individual listener failures must not kill the client */
          }
        }
      }
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
    return this;
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, this.commandTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
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

/** Evaluate an expression in the page and return its by-value result. */
export async function evalOn(cdp, expression) {
  const out = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (out.exceptionDetails) {
    const detail = JSON.stringify(out.exceptionDetails).slice(0, 800);
    throw new Error(`page evaluation failed: ${detail}`);
  }
  return out.result && out.result.value;
}

/**
 * Poll a page expression until it returns truthy (returns the truthy value).
 * @returns {Promise<{ok: boolean, value?: unknown, waitedMs: number}>}
 */
export async function waitFor(cdp, expression, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await evalOn(cdp, expression);
      if (value) return { ok: true, value, waitedMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  return { ok: false, error: lastError ? String(lastError.message ?? lastError) : undefined, waitedMs: Date.now() - startedAt };
}

/** Capture a PNG screenshot of the current viewport. */
export async function screenshot(cdp, filePath) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(filePath, Buffer.from(shot.data, 'base64'));
  return filePath;
}

/**
 * Launch headless Chrome with a throwaway profile.
 * @param {{label?: string, windowSize?: string, extraArgs?: string[], chromePath?: string}} [options]
 * @returns {Promise<{process: import('node:child_process').ChildProcess, port: number,
 *   browserWsUrl: string, profileDir: string, stderrTail: () => string, close: () => Promise<void>}>}
 */
export async function launchChrome({ label = 'dsh-qa', windowSize = '1440,960', extraArgs = [], chromePath } = {}) {
  const executable = chromePath ?? findChrome();
  if (!executable) throw new Error('no Chrome/Chromium executable found (set CHROME_BIN)');
  const profileDir = await mkdtemp(join(tmpdir(), `${label}-`));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-background-networking',
    '--disable-component-update',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${windowSize}`,
    '--lang=zh-CN',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=0',
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderrLines = [];
  let stderrBuffer = '';
  let browserWsUrl = null;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not report a DevTools endpoint in time\n${stderrLines.slice(-20).join('\n')}`)), 25_000);
    child.stderr.on('data', (chunk) => {
      // Always consume stderr: an unread pipe can stall Chrome under headless load.
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      stderrBuffer += text;
      let index = stderrBuffer.indexOf('\n');
      while (index !== -1) {
        const line = stderrBuffer.slice(0, index);
        stderrBuffer = stderrBuffer.slice(index + 1);
        stderrLines.push(line);
        if (stderrLines.length > 200) stderrLines.shift();
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(line);
        if (match && browserWsUrl === null) {
          browserWsUrl = match[1];
          clearTimeout(timer);
          resolve();
        }
        index = stderrBuffer.indexOf('\n');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (browserWsUrl === null) {
        clearTimeout(timer);
        reject(new Error(`Chrome exited early (code ${code})\n${stderrLines.slice(-20).join('\n')}`));
      }
    });
  });
  try {
    await ready;
  } catch (error) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const port = Number(new URL(browserWsUrl.replace(/^ws:\/\//, 'http://')).port);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await wait(150);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  };
  return {
    process: child,
    port,
    browserWsUrl,
    profileDir,
    stderrTail: () => stderrLines.slice(-20).join('\n'),
    close,
  };
}

/**
 * Create (or reuse) a page target and return its CDP WebSocket URL.
 * Newer Chrome requires PUT /json/new; GET is kept as a fallback.
 */
export async function openPageTarget(baseHttpUrl, url = 'about:blank') {
  const listUrl = `${baseHttpUrl}/json/list`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const targets = await getJson(listUrl);
      const pages = (Array.isArray(targets) ? targets : []).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (pages.length > 0) return pages[0];
      try {
        const created = await getJson(`${baseHttpUrl}/json/new?${encodeURIComponent(url)}`, 'PUT');
        if (created && created.webSocketDebuggerUrl) return created;
      } catch {
        try {
          const created = await getJson(`${baseHttpUrl}/json/new?${encodeURIComponent(url)}`, 'GET');
          if (created && created.webSocketDebuggerUrl) return created;
        } catch {
          /* retry below */
        }
      }
    } catch {
      /* Chrome not ready yet */
    }
    await wait(250);
  }
  throw new Error(`no page target available from ${baseHttpUrl}`);
}

/* ------------------------------------------------------------------ */
/* DSH web GUI authentication (QA-only)                                */
/* ------------------------------------------------------------------ */

/** Cookie name prefix minted by the DSH web server for browser sessions. */
const DSH_AUTH_COOKIE_PREFIX = 'dsh-auth-';

/**
 * Parse a cookie source (a `Cookie:` header or bare `name=value[; ...]`).
 * @param {string} raw - cookie text supplied by the operator.
 * @returns {{name: string, value: string}[]}
 */
function parseCookiePairs(raw) {
  const pairs = [];
  for (const part of String(raw).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0 && value.length > 0) pairs.push({ name, value });
  }
  return pairs;
}

/**
 * Authenticate a page-target CDP session against the DSH web GUI.
 *
 * Auth sources, in order:
 *  1. a launch-token URL (`DSH_URL` containing `?token=...`), which `dsh web`
 *     prints/opens on startup — Chrome exchanges it for a signed cookie;
 *  2. `DSH_COOKIE`, an authenticated browser-session cookie supplied by the
 *     operator (for example `dsh-auth-...=v1...`, or a full `Cookie:` header).
 *
 * This helper deliberately never reads DSH credentials and never mints
 * cookies: QA automation must be handed a credential explicitly.
 * @param {CDP} page - page-target CDP session (before navigation).
 * @param {string} dshUrl - GUI URL.
 * @returns {Promise<{mode: 'token'|'cookie'}>}
 */
export async function authenticateDshPage(page, dshUrl) {
  const url = new URL(dshUrl);
  if (url.searchParams.has('token')) return { mode: 'token' };
  const rawCookie = (process.env.DSH_COOKIE || '').trim();
  if (rawCookie.length === 0) {
    throw new Error('DSH GUI authentication is required: set DSH_URL to the launch-token URL printed by `dsh web` (it contains ?token=...), or set DSH_COOKIE to an authenticated browser-session cookie');
  }
  const pairs = parseCookiePairs(rawCookie);
  const authPairs = pairs.filter((pair) => pair.name.startsWith(DSH_AUTH_COOKIE_PREFIX));
  const toSet = authPairs.length > 0 ? authPairs : pairs.slice(0, 1);
  if (toSet.length === 0) throw new Error('DSH_COOKIE does not contain a name=value cookie pair');
  for (const cookie of toSet) {
    await page.send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      url: `${url.protocol}//${url.host}/`,
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    });
  }
  return { mode: 'cookie' };
}
