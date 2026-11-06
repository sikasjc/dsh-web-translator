#!/usr/bin/env node
/**
 * QA-only mock DSH dashboard server used to self-test qa/panel-shot.mjs
 * end-to-end before driving the real installed plugin. Serves:
 *   - a tiny "DSH shell" page with a sidebar panel row labelled dsh翻译 and a
 *     left-toolbar page with 概览/轨迹/设置/单词本 tabs (vanilla JS, no deps);
 *   - minimal /dsh-immersive/api/{usage,usage/events,settings,wordbook} JSON
 *     responses in the installed-plugin shape.
 *
 * Usage: node qa/mock-panel-server.mjs   (prints "# MOCK_URL http://127.0.0.1:<port>/?token=mock")
 * QA-only helper: writes nothing.
 */
import { createServer } from 'node:http';

const today = new Date();
const pad = (value) => String(value).padStart(2, '0');
const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

const state = {
  settings: {
    provider: 'modelhub',
    model: 'deepseek-flash',
    reasoningEffort: 'auto',
    targetLanguage: 'zh-CN',
    systemPrompt: 'QA mock system prompt for panel-shot self-test.',
    userTemplate: 'Source language: {{sourceLanguage}}\n{{segmentsJson}}',
    batchSegments: 10,
    batchChars: 1600,
    concurrency: 2,
  },
  selectedSource: 'default',
};

const summary = {
  version: 1,
  updatedAt: Date.now(),
  totals: { requests: 7, ok: 5, errors: 2, cached: 1, inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89, cacheWriteTokens: 0 },
  today: { requests: 7, ok: 5, errors: 2, cached: 1, inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89, cacheWriteTokens: 0 },
  days: Array.from({ length: 14 }, (_, index) => ({
    date: index === 13 ? todayKey : `2026-10-${pad(24 + index)}`,
    requests: index === 13 ? 7 : index % 3,
    ok: index === 13 ? 5 : index % 3,
    errors: index === 13 ? 2 : 0,
    cached: index === 13 ? 1 : 0,
    inputTokens: index === 13 ? 1234 : index * 10,
    outputTokens: index === 13 ? 567 : index * 5,
    cacheReadTokens: index === 13 ? 89 : 0,
    cacheWriteTokens: 0,
  })),
  byModel: [{ provider: 'modelhub', model: 'deepseek-flash', requests: 7, inputTokens: 1234, outputTokens: 567, cacheReadTokens: 89, cacheWriteTokens: 0, lastAt: Date.now() }],
  byKind: {
    translate: { requests: 6, ok: 4, errors: 2, cached: 1, inputTokens: 1200, outputTokens: 550, cacheReadTokens: 89, cacheWriteTokens: 0 },
    lookup: { requests: 1, ok: 1, errors: 0, cached: 0, inputTokens: 34, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
  recent: [],
};

const events = [
  {
    id: 'evt_mock_newest',
    at: Date.now(),
    kind: 'translate',
    ok: true,
    provider: 'modelhub',
    model: 'deepseek-flash',
    client: 'extension',
    site: 'example.com',
    sourceUrl: 'https://example.com/article/qa-extension',
    sourceTitle: 'QA extension-origin event',
    segments: 1,
    chars: 11,
    cached: false,
    retries: 0,
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 30,
    cacheWriteTokens: 7,
    latencyMs: 1234,
    sample: 'Hello world',
  },
  {
    id: 'evt_mock_older',
    at: Date.now() - 60_000,
    kind: 'lookup',
    ok: false,
    errorCode: 'MODEL_RATE_LIMITED',
    provider: 'modelhub',
    model: 'deepseek-flash',
    client: 'qa',
    segments: 1,
    chars: 5,
    cached: false,
    retries: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 50,
  },
];

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Mock DSH · dsh翻译</title>
<style>
  body{margin:0;font:14px/22px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;background:#fff;color:#1a1a1a}
  .shell{display:flex;min-height:100vh}
  .sidebar{width:240px;border-right:1px solid #e5e5e5;padding:10px;box-sizing:border-box;background:#fafafa}
  .sidebar button{display:block;width:100%;text-align:left;padding:8px;border:0;background:transparent;border-radius:6px;font:inherit;cursor:pointer;color:inherit}
  .sidebar button[aria-current="page"]{background:#e8f0fe}
  .main{flex:1;padding:20px 28px;min-width:0}
  .hidden{display:none!important}
  .dsh-it-page-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
  .dsh-it-title{margin:0;font-size:18px;line-height:26px}
  .dsh-it-subtitle{margin:2px 0 0;font-size:12px;line-height:18px;color:#666}
  .dsh-it-chip{display:inline-block;border:1px solid #d0d0d0;border-radius:999px;padding:2px 10px;margin-left:8px;font-size:12px}
  .dsh-it-usage-today-chip{color:#1a73e8;border-color:#1a73e8}
  .dsh-it-tabbar{display:flex;gap:4px;border-bottom:1px solid #e5e5e5;margin:16px 0 12px}
  .dsh-it-tab{border:0;background:transparent;padding:8px 14px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
  .dsh-it-tab[aria-selected="true"]{border-bottom-color:#1a73e8;color:#1a73e8;font-weight:600}
  .dsh-it-usage-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
  .dsh-it-usage-stat{border:1px solid #e5e5e5;border-radius:8px;padding:10px}
  .dsh-it-usage-stat-value{display:block;font-size:18px;font-weight:600}
  .dsh-it-usage-stat-label{display:block;font-size:12px;color:#666}
  .dsh-it-bars{display:flex;gap:4px;align-items:flex-end;height:80px;margin-top:16px}
  .dsh-it-bars-col{flex:1;background:#1a73e8}
  .dsh-it-bars-col:nth-child(odd){background:#8ab4f8}
  .dsh-it-usage-row,.dsh-it-btn{display:block;border:1px solid #e5e5e5;border-radius:6px;background:#fff;padding:8px;margin:4px 0;font:inherit;cursor:pointer;text-align:left}
  .dsh-it-usage-detail{border:1px dashed #1a73e8;border-radius:6px;padding:8px;margin:4px 0;font-size:12px}
  .dsh-it-field{display:block;margin:10px 0}
  .dsh-it-label{display:block;font-size:12px;color:#666;margin-bottom:4px}
  select,textarea,input{font:inherit;padding:4px;width:100%;box-sizing:border-box}
  @media (prefers-color-scheme: dark){body{background:#151517;color:#eee}.sidebar{background:#1e1e20;border-color:#333}}
</style></head>
<body>
<div class="shell">
  <div class="sidebar" data-platform="web">
    <button type="button" data-sidebar-toggle aria-label="收起侧边栏">≡</button>
    <button type="button" aria-label="插件">插件</button>
    <button type="button" id="panel-button" aria-label="dsh翻译">dsh翻译</button>
    <button type="button" aria-label="更多">更多</button>
  </div>
  <div class="main">
    <div id="chat-view"><h2>Mock DSH chat</h2><p>欢迎使用模拟 DSH。</p></div>
    <div id="panel-view" class="hidden">
      <div class="dsh-it-page-heading">
        <div><h2 class="dsh-it-title">dsh翻译</h2><p class="dsh-it-subtitle">浏览器扩展翻译后端 · Token 统计</p></div>
        <div>
          <span class="dsh-it-chip dsh-it-usage-model-chip" title="当前模型">模型 modelhub/deepseek-flash</span>
          <span class="dsh-it-chip dsh-it-usage-today-chip" title="今日：输入 1,234 · 输出 567 tokens">今日 1.8k tokens</span>
          <button type="button" class="dsh-it-btn">↻ 刷新</button>
        </div>
      </div>
      <div class="dsh-it-tabbar" role="tablist" aria-label="统计页面">
        <button type="button" role="tab" aria-selected="true" aria-controls="p-overview" data-tab="overview">概览</button>
        <button type="button" role="tab" aria-selected="false" aria-controls="p-traces" data-tab="traces">轨迹</button>
        <button type="button" role="tab" aria-selected="false" aria-controls="p-settings" data-tab="settings">设置</button>
        <button type="button" role="tab" aria-selected="false" aria-controls="p-wordbook" data-tab="wordbook">单词本</button>
      </div>
      <div role="tabpanel" id="p-overview" data-panel="overview">
        <div class="dsh-it-usage-stats">
          <div class="dsh-it-usage-stat"><span class="dsh-it-usage-stat-value" title="7">7</span><span class="dsh-it-usage-stat-label">请求数</span></div>
          <div class="dsh-it-usage-stat"><span class="dsh-it-usage-stat-value" title="1,234">1.2k</span><span class="dsh-it-usage-stat-label">输入 tokens</span></div>
          <div class="dsh-it-usage-stat"><span class="dsh-it-usage-stat-value" title="567">567</span><span class="dsh-it-usage-stat-label">输出 tokens</span></div>
          <div class="dsh-it-usage-stat"><span class="dsh-it-usage-stat-value" title="89">89</span><span class="dsh-it-usage-stat-label">缓存命中 tokens</span></div>
          <div class="dsh-it-usage-stat"><span class="dsh-it-usage-stat-value" title="2">2</span><span class="dsh-it-usage-stat-label">失败数</span></div>
          <div class="dsh-it-usage-stat"><span class="dsh-it-usage-stat-value" title="1.2s">1.2s</span><span class="dsh-it-usage-stat-label">平均时延</span></div>
        </div>
        <div class="dsh-it-bars" role="img" aria-label="近 14 天 token 消耗柱状图"></div>
      </div>
      <div role="tabpanel" id="p-traces" data-panel="traces" class="hidden">
        <button type="button" class="dsh-it-btn">全部</button>
        <button type="button" class="dsh-it-btn">翻译</button>
        <button type="button" class="dsh-it-btn">查词</button>
        <button type="button" class="dsh-it-btn">仅失败</button>
        <button type="button" class="dsh-it-btn">清空统计</button>
        <button type="button" class="dsh-it-usage-row" id="trace-row">translate · modelhub/deepseek-flash · QA extension-origin event · 1 段 / 11 字符 · 120 / 45 · 1.2s</button>
        <div id="trace-detail"></div>
      </div>
      <div role="tabpanel" id="p-settings" data-panel="settings" class="hidden">
        <label class="dsh-it-field"><span class="dsh-it-label">模型</span><select aria-label="模型"><option>deepseek-flash</option></select></label>
        <label class="dsh-it-field"><span class="dsh-it-label">目标语言</span><select aria-label="目标语言"><option>简体中文</option></select></label>
        <label class="dsh-it-field"><span class="dsh-it-label">推理强度</span><select aria-label="推理强度"><option>自动（推荐）</option></select></label>
        <label class="dsh-it-field"><span class="dsh-it-label">系统提示词</span><textarea aria-label="系统提示词" rows="5">QA mock system prompt for panel-shot self-test.</textarea></label>
        <label class="dsh-it-field"><span class="dsh-it-label">用户模板</span><textarea aria-label="用户模板" rows="3">Source language: {{sourceLanguage}}</textarea></label>
        <label class="dsh-it-field"><span class="dsh-it-label">测试文本</span><textarea aria-label="测试文本" rows="2"></textarea></label>
        <button type="button" class="dsh-it-btn" id="save-settings">保存设置</button>
        <p id="save-notice" role="status" aria-live="polite"></p>
      </div>
      <div role="tabpanel" id="p-wordbook" data-panel="wordbook" class="hidden">
        <p class="dsh-it-label">单词本</p>
        <div id="wordbook-list">paragraph</div>
      </div>
    </div>
  </div>
</div>
<script>
  const panelButton = document.getElementById('panel-button');
  const chatView = document.getElementById('chat-view');
  const panelView = document.getElementById('panel-view');
  panelButton.addEventListener('click', () => {
    chatView.classList.add('hidden');
    panelView.classList.remove('hidden');
    panelButton.setAttribute('aria-current', 'page');
    document.title = 'Mock DSH · dsh翻译';
    fetch('/dsh-immersive/api/usage?days=14').catch(() => {});
    fetch('/dsh-immersive/api/usage/events?limit=50').catch(() => {});
    fetch('/dsh-immersive/api/settings').catch(() => {});
    fetch('/dsh-immersive/api/wordbook?limit=200').catch(() => {});
  });
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((entry) => entry.setAttribute('aria-selected', entry === tab ? 'true' : 'false'));
    document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.getAttribute('data-panel') !== tab.getAttribute('data-tab')));
  }));
  document.getElementById('trace-row').addEventListener('click', () => {
    document.getElementById('trace-detail').innerHTML = '<div class="dsh-it-usage-detail">客户端 extension · https://example.com/article/qa-extension · QA extension-origin event · 缓存 否 · 重试 0</div>';
  });
  document.getElementById('save-settings').addEventListener('click', async () => {
    const systemPrompt = document.querySelector('textarea[aria-label="系统提示词"]').value;
    const note = document.getElementById('save-notice');
    try {
      const response = await fetch('/dsh-immersive/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemPrompt }) });
      note.textContent = response.ok ? '设置已保存' : '保存失败';
    } catch (error) { note.textContent = '保存失败'; }
  });
</script>
</body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const sendJson = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  };
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
    return;
  }
  if (url.pathname === '/dsh-immersive/api/usage' && request.method === 'GET') {
    sendJson(200, { ok: true, usage: summary });
    return;
  }
  if (url.pathname === '/dsh-immersive/api/usage/events' && request.method === 'GET') {
    sendJson(200, { ok: true, events, nextBefore: null, hasMore: false });
    return;
  }
  if (url.pathname === '/dsh-immersive/api/settings' && request.method === 'GET') {
    sendJson(200, {
      ok: true,
      settings: state.settings,
      defaults: {},
      selected: { provider: state.settings.provider, model: state.settings.model, reasoningEffort: 'auto', source: state.selectedSource },
      modelInfo: { provider: state.settings.provider, model: state.settings.model, reasoningEfforts: [], contextWindow: 0, maxTokens: 0 },
      targetLanguages: ['zh-CN', 'en'],
    });
    return;
  }
  if (url.pathname === '/dsh-immersive/api/settings' && request.method === 'PUT') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        if (typeof patch.systemPrompt === 'string') state.settings = { ...state.settings, systemPrompt: patch.systemPrompt };
        state.selectedSource = 'settings';
        sendJson(200, { ok: true, settings: state.settings, selected: { provider: state.settings.provider, model: state.settings.model, source: 'settings' } });
      } catch {
        sendJson(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'invalid json' } });
      }
    });
    return;
  }
  if (url.pathname === '/dsh-immersive/api/wordbook' && request.method === 'GET') {
    sendJson(200, { ok: true, items: [{ id: 'wb_mock', word: 'paragraph', translation: '段落', targetLanguage: 'zh-CN' }], stats: { total: 1, due: 1, todayDue: 0, mastered: 0, newCount: 1 } });
    return;
  }
  sendJson(404, { ok: false, error: { code: 'NOT_FOUND', message: 'mock: no route for ' + request.method + ' ' + url.pathname } });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`# MOCK_URL http://127.0.0.1:${port}/?token=mock`);
  console.log('# mock panel server ready; stop with Ctrl-C');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
