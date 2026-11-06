#!/usr/bin/env node
/**
 * QA helper: keep an authenticated headless DSH page open so that
 * `cordis_inspect_query` (platform=client) has a connected Client to answer
 * Slot/Builtin/Theme inspect queries.
 *
 * Usage: node qa/hold-page.mjs [--seconds 180]
 * Env:   DSH_URL / DSH_WEB_URL (default http://127.0.0.1:3080; may carry ?token=)
 * Prints "# READY" once the dashboard booted, then holds the page open until
 * the timeout/first SIGINT. Writes no files. QA-only.
 */
import { CDP, evalOn, authenticateDshPage, launchChrome, openPageTarget, wait, waitFor } from './cdp.mjs';

const DSH_URL = (process.env.DSH_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').trim();
const secondsArg = process.argv.indexOf('--seconds');
const HOLD_SECONDS = Math.max(10, Number(secondsArg !== -1 ? process.argv[secondsArg + 1] : 180) || 180);

async function main() {
  const chrome = await launchChrome({ label: 'dsh-qa-hold', windowSize: '1440,960' });
  let page = null;
  let done = false;
  const shutdown = async () => {
    if (done) return;
    done = true;
    if (page) page.close();
    await chrome.close();
    process.exitCode = 0;
  };
  process.on('SIGINT', () => {
    shutdown().then(() => process.exit(0));
  });
  try {
    const target = await openPageTarget(`http://127.0.0.1:${chrome.port}`, 'about:blank');
    page = new CDP(target.webSocketDebuggerUrl);
    await page.connect();
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await authenticateDshPage(page, DSH_URL);
    await page.send('Page.navigate', { url: DSH_URL });
    const boot = await waitFor(page, `document.readyState === 'complete' && !!document.querySelector('[data-sidebar-toggle], [data-sidebar-opener], [data-platform]')`, { timeoutMs: 45_000, intervalMs: 300 });
    if (!boot.ok) {
      console.error('# FAIL: dashboard did not boot');
      await shutdown();
      process.exitCode = 2;
      return;
    }
    // Click the plugin panel so the panel's client Slots are mounted/active.
    await evalOn(page, `(() => {
      const wanted = /dsh翻译|Immersive\\s*Translate/i;
      const button = Array.from(document.querySelectorAll('button')).find((el) => wanted.test(el.getAttribute('aria-label') || '') || wanted.test((el.textContent || '').trim()));
      if (button) { button.click(); return true; }
      return false;
    })()`);
    console.log(`# READY ${new Date().toISOString()} (holding ${HOLD_SECONDS}s) — ${DSH_URL}`);
    console.log('# client page connected; run cordis_inspect_query against it now');
    await wait(HOLD_SECONDS * 1000);
    console.log('# hold finished');
  } finally {
    await shutdown();
  }
}

main().catch((error) => {
  console.error(`hold-page error: ${error && error.stack ? error.stack : String(error)}`);
  process.exitCode = 2;
});
