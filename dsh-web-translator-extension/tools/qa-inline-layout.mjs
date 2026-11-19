#!/usr/bin/env node
/**
 * QA：并排（行内）译文换行回退。
 *
 * 背景：正文段落字号 >=20px 且文本 <=80 字符时，扩展按「展示型短块」把译文
 * 并排在原文右边。原文在宽屏正文里很容易占满整行，译文随之换行到下一行并带上
 * 0.75em 左缩进，同时原文段落外边距失效——看起来就是「译文上下没有空格、和下一段
 * 粘在一起」（20px 正文字号的站点上，普通短段落都会中招）。
 *
 * 本脚本用假 DSH（stub chrome.runtime）驱动真实 content.js，检查：
 *   1. 20px 短段落放不下时退回块级译文：layout=below、display:block、上下都有间距；
 *   2. 放得下时仍保持并排（不能把正常并排也退掉）；
 *   3. 标题不受影响（仍是标题内的行内译文）；
 *   4. 零外边距容器里的短段落同样退回块级并保留 `原文 + 译文` 的段间距；
 *   5. 在「原文」模式下发起的翻译（译文隐藏、量不到位置）切回双语对照后补判一次。
 *
 * 用法：node tools/qa-inline-layout.mjs
 */

import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CDP, evalOn, launchChrome, openPageTarget, screenshot, wait, waitFor } from '../../dsh-web-translator/qa/cdp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = '/tmp/dsh-it-debug';

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>inline layout qa</title>
<style>
  body { font: 20px/1.5 -apple-system, system-ui, sans-serif; color: #111; margin: 40px auto; max-width: 860px; }
  p { margin: 0 0 1.4em; }
  h2 { font-size: 32px; line-height: 1.25; margin: 1.4em 0 .6em; }
  .tight p { margin: 0; }
</style></head>
<body>
  <p id="short">Over the past few months, we've seen a resurgence of always-on agents.</p>
  <p id="long">Always-on agents are stateful and proactive, meaning they manage context across sessions and take actions without direct supervision. Underneath, they run on the same core loop as other agents.</p>
  <h2 id="title">Short heading</h2>
  <p id="fits">A short note.</p>
  <div class="tight"><p id="tight">A shorter paragraph, still body copy, in a zero-margin container.</p></div>
</body></html>`;

/** 假 DSH：translate 原样回显，带【译文】前缀，便于目测。 */
function stubSource(startMode) {
  return `(() => {
  const START_MODE = ${JSON.stringify(startMode)};
  function reply(message) {
    const payload = message.payload || {};
    if (message.method === 'translate') {
      return {
        translations: (payload.texts || []).map((text) => '【译文】' + text),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cached: false, provider: 'qa', model: 'fake'
      };
    }
    if (message.method === 'settings') return { settings: { targetLanguage: 'zh-CN' }, selected: { provider: 'qa', model: 'fake' } };
    if (message.method === 'health') return { version: 'qa', llm: { providers: 1, models: 1 } };
    if (message.method === 'ball-sites') return { sites: [] };
    if (message.method === 'usage') return { days: [] };
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
        get(keys, callback) {
          if (typeof callback === 'function') setTimeout(() => callback({ language: 'zh-CN', mode: START_MODE, autoTranslate: true }), 0);
        },
        set(items, callback) { if (typeof callback === 'function') setTimeout(callback, 0); }
      },
      onChanged: { addListener() {} }
    }
  });
})();`;
}

const PROBE = `(() => {
  const probe = (id) => {
    const src = document.getElementById(id);
    if (!src) return { id: id, missing: true };
    const trans = src.nextElementSibling && src.nextElementSibling.getAttribute('data-dsh-it') === 'trans'
      ? src.nextElementSibling : null;
    const srcRect = src.getBoundingClientRect();
    const transRect = trans ? trans.getBoundingClientRect() : null;
    const style = trans ? getComputedStyle(trans) : null;
    const next = trans && trans.nextElementSibling ? trans.nextElementSibling.getBoundingClientRect() : null;
    return {
      id: id,
      srcLayout: src.getAttribute('data-dsh-it-layout'),
      srcDisplay: getComputedStyle(src).display,
      trans: !!trans,
      layout: trans && trans.getAttribute('data-dsh-it-layout'),
      display: style && style.display,
      marginTop: style ? parseFloat(style.marginTop) : null,
      marginBottom: style ? parseFloat(style.marginBottom) : null,
      marginLeft: style ? parseFloat(style.marginLeft) : null,
      sameLine: !!(transRect && transRect.top < srcRect.bottom - 2),
      gapAbove: transRect ? Math.round(transRect.top - srcRect.bottom) : null,
      gapBelow: transRect && next ? Math.round(next.top - transRect.bottom) : null,
      headingInline: id === 'title' ? src.querySelectorAll('[data-dsh-it="trans-inline"]').length : null
    };
  };
  return { short: probe('short'), long: probe('long'), title: probe('title'), fits: probe('fits'), tight: probe('tight') };
})()`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `  [${String(JSON.stringify(detail)).slice(0, 400)}]`}`);
}

const contentSource = await readFile(join(ROOT, 'content.js'), 'utf8');
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE_HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const chrome = await launchChrome({ label: 'dsh-inline-layout-qa' });

/** 打开页面 → 注入假 DSH + content.js → 可选自动触发翻译，返回页面句柄。 */
async function boot(startMode, { clickBall }) {
  const target = await openPageTarget(`http://127.0.0.1:${chrome.port}`, pageUrl);
  const page = await new CDP(target.webSocketDebuggerUrl).connect();
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: pageUrl });
  await waitFor(page, 'document.readyState === "complete"', { timeoutMs: 15000 });
  await evalOn(page, stubSource(startMode));
  await evalOn(page, contentSource);
  await waitFor(page, `!!document.getElementById('dsh-it-host')`, { timeoutMs: 15000 });
  if (clickBall) {
    await evalOn(page, `document.getElementById('dsh-it-host').shadowRoot.querySelector('.dsh-bubble').click()`);
  } else {
    // 不点悬浮球：靠 autoTranslate 在「原文」模式下发起翻译（译文隐藏）
    await waitFor(page, `document.querySelectorAll('[data-dsh-it="trans"]').length >= 3`, { timeoutMs: 25000 });
  }
  return page;
}

try {
  /* 1) 双语对照：并排译文换行 → 退回块级 */
  const page = await boot('bilingual', { clickBall: true });
  const translated = await waitFor(page, `document.querySelectorAll('[data-dsh-it="trans"]').length >= 3`, { timeoutMs: 20000 });
  check('双语对照：页面完成翻译', translated.ok, translated.error);
  await wait(300);
  const state = await evalOn(page, PROBE);
  check(
    '20px 正文短段落放不下时退回块级译文（有段间距）',
    !!state.short.trans && state.short.layout === 'below' && state.short.display === 'block' &&
      state.short.srcLayout === null && state.short.srcDisplay === 'block' &&
      state.short.marginTop > 0 && state.short.gapAbove > 0 && state.short.gapBelow > 0 && !state.short.sameLine,
    state.short
  );
  check(
    '放得下时仍保持并排（不和原文换行、无额外段间距）',
    state.fits.trans && state.fits.layout === 'inline' && state.fits.sameLine === true,
    state.fits
  );
  check('标题仍是标题内的行内译文（不受影响）', state.title.headingInline > 0, state.title);
  check(
    '零外边距容器里的短段落同样退回块级并保留间距',
    !!state.tight.trans && state.tight.layout === 'below' && state.tight.marginTop > 0 && state.tight.marginBottom > 0,
    state.tight
  );
  check('长段落仍是块级译文（原行为不变）', !state.long.trans || state.long.layout === 'below', state.long);
  await mkdir(OUT_DIR, { recursive: true });
  await screenshot(page, join(OUT_DIR, 'inline-layout-qa.png'));

  /* 2) 「原文」模式：译文隐藏时量不到位置，切回双语对照后补判 */
  const hiddenPage = await boot('source', { clickBall: false });
  const hidden = await evalOn(hiddenPage, `({ mode: document.documentElement.getAttribute('data-dsh-it-mode') })`);
  check('原文模式：翻译在译文隐藏状态下进行', hidden.mode === 'source', hidden);
  const beforeSwitch = await evalOn(hiddenPage, PROBE);
  check(
    '原文模式：隐藏期间不误判（保持并排、不动 DOM 间距）',
    !beforeSwitch.short.trans || beforeSwitch.short.layout === 'inline',
    beforeSwitch.short
  );
  await evalOn(hiddenPage, `document.getElementById('dsh-it-host').shadowRoot.querySelector('[data-mode="bilingual"]').click()`);
  await wait(300);
  const afterSwitch = await evalOn(hiddenPage, PROBE);
  check(
    '切回双语对照后补判：换行的并排译文退回块级',
    !!afterSwitch.short.trans && afterSwitch.short.layout === 'below' && afterSwitch.short.layout !== 'inline' &&
      afterSwitch.short.srcLayout === null && afterSwitch.short.gapAbove > 0,
    afterSwitch.short
  );
  check(
    '切回双语对照后补判：放得下的仍保持并排',
    afterSwitch.fits.trans && afterSwitch.fits.layout === 'inline' && afterSwitch.fits.sameLine === true,
    afterSwitch.fits
  );

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} QA checks passed`);
  if (failed.length) {
    console.log('FAILED: ' + failed.map((item) => item.name).join(' | '));
    process.exitCode = 1;
  } else {
    console.log('INLINE LAYOUT QA OK');
  }
} finally {
  await chrome.close();
  server.close();
}
