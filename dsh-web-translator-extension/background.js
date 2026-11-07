/*!
 * dsh翻译 · DSH —— background service worker（MV3）
 *
 * 唯一出网侧：content script / options 页只做文本 RPC，所有 HTTP 请求都在这里发出。
 * 协议：
 *   content -> background  { type:'dsh-it:rpc', id, method, payload }
 *   background -> content  { type:'dsh-it:result', id, ok:true, data }
 *                          { type:'dsh-it:result', id, ok:false, error:{ code, message } }
 *
 * 本文件不读写页面 DOM，不注入远程代码，不申请额外权限。
 */
'use strict';

/** DSH Web 默认地址（与 manifest.host_permissions 对应，改端口需同时改 manifest 并重新加载扩展） */
const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
const API_PREFIX = '/dsh-immersive/api/';
const REQUEST_TIMEOUT_MS = 120000;

/** 右键菜单：dsh翻译 → 原文 / 译文 / 双语对照 */
const MENU_ROOT = 'dsh-it:root';
const MENU_MODE_SOURCE = 'dsh-it:mode-source';
const MENU_MODE_ONLY = 'dsh-it:mode-only';
const MENU_MODE_BILINGUAL = 'dsh-it:mode-bilingual';
const MENU_SHOW_BALL = 'dsh-it:show-ball';
const MENU_HIDE_BALL = 'dsh-it:hide-ball';
const MENU_HIDE_DOMAIN = 'dsh-it:hide-domain';
const MENU_TOGGLE_AUTO_SITE = 'dsh-it:toggle-auto-site';
const MENU_MODE_MAP = {
  [MENU_MODE_SOURCE]: 'source',
  [MENU_MODE_ONLY]: 'only',
  [MENU_MODE_BILINGUAL]: 'bilingual'
};

/** 跟随翻译：按 tab 记录“该 tab 的上一页翻译过”，用于新页面自动翻译（session storage + 内存兜底） */
const FOLLOW_PREFIX = 'dsh-it:follow:';
const followMemory = new Set();

function followKey(tabId) {
  return FOLLOW_PREFIX + tabId;
}

async function followGet(tabId) {
  if (typeof tabId !== 'number') return false;
  if (followMemory.has(tabId)) return true;
  try {
    if (chrome.storage && chrome.storage.session) {
      const key = followKey(tabId);
      const data = await chrome.storage.session.get(key);
      return !!data && data[key] === true;
    }
  } catch (err) {
    /* session storage 不可用时只用内存 */
  }
  return false;
}

async function followGetWithInherit(tabId) {
  if (await followGet(tabId)) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && typeof tab.openerTabId === 'number' && (await followGet(tab.openerTabId))) {
      await followSet(tabId, true);
      return true;
    }
  } catch (err) {
    /* 无 opener 信息时按未跟随处理 */
  }
  return false;
}

async function followSet(tabId, value) {
  if (typeof tabId !== 'number') return false;
  if (value) followMemory.add(tabId);
  else followMemory.delete(tabId);
  try {
    if (chrome.storage && chrome.storage.session) {
      const key = followKey(tabId);
      if (value) await chrome.storage.session.set({ [key]: true });
      else await chrome.storage.session.remove(key);
    }
  } catch (err) {
    /* 内存状态仍可用 */
  }
  return !!value;
}

/** 允许调用的 Host API 方法白名单（method -> HTTP 动词），避免被利用做任意路径请求 */
const ALLOWED_ROUTES = Object.freeze({
  health: 'GET',
  models: 'GET',
  'models/resolve': 'GET',
  settings: 'GET',
  usage: 'GET',
  wordbook: 'GET',
  'ball-sites': 'GET',
  'ball-sites/add': 'POST',
  'ball-sites/remove': 'POST',
  translate: 'POST',
  lookup: 'POST',
  'wordbook/add': 'POST'
});

/* ------------------------------------------------------------------ */
/* 错误标准化                                                          */
/* ------------------------------------------------------------------ */

function makeError(code, message) {
  return {
    code: typeof code === 'string' && code ? code : 'UNKNOWN',
    message: typeof message === 'string' && message ? message : '未知错误'
  };
}

function fail(code, message) {
  return { ok: false, error: makeError(code, message) };
}

function normalizeError(err) {
  if (!err) return makeError('UNKNOWN', '未知错误');
  if (typeof err === 'string') return makeError('UNKNOWN', err);
  if (err.code || err.message) {
    return makeError(err.code || 'UNKNOWN', err.message || String(err.code || '未知错误'));
  }
  return makeError('UNKNOWN', String(err));
}

/** 统一回包信封：{ type:'dsh-it:result', id, ok:true, data } | { ..., ok:false, error:{code,message} } */
function withEnvelope(id, result) {
  const envelope = {
    type: 'dsh-it:result',
    id: typeof id === 'string' ? id : '',
    ok: !!(result && result.ok === true)
  };
  if (envelope.ok) envelope.data = result.data;
  else envelope.error = (result && result.error) || makeError('UNKNOWN', '未知错误');
  return envelope;
}

function httpStatusMessage(status) {
  const map = {
    400: '请求参数不合法',
    403: 'DSH 拒绝了该来源的请求（Origin fence）',
    404: '接口不存在（请确认已安装并启用「dsh翻译」DSH 插件）',
    405: '请求方法不被支持',
    413: '文本过长',
    429: '模型限流，请稍后再试',
    500: 'DSH 内部错误',
    502: '模型服务错误（请检查 DSH 中的模型配置）',
    504: '模型请求超时'
  };
  return map[status] || ('DSH 返回 HTTP ' + status);
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 读取扩展设置里的 DSH 地址，默认 http://127.0.0.1:3080 */
async function getBaseUrl() {
  let raw = DEFAULT_BASE_URL;
  try {
    const stored = await chrome.storage.local.get(['dshBaseUrl']);
    if (stored && typeof stored.dshBaseUrl === 'string' && stored.dshBaseUrl.trim()) {
      raw = stored.dshBaseUrl.trim();
    }
  } catch (err) {
    /* 读不到设置就用默认值 */
  }
  return sanitizeBaseUrl(raw);
}

/** 规范化地址：补 http://、去尾部斜杠，只允许 http/https 且不带账号密码 */
function sanitizeBaseUrl(raw) {
  let value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_BASE_URL;
    if (url.username || url.password) return DEFAULT_BASE_URL;
    const path = url.pathname.replace(/\/+$/, '');
    return url.origin + path;
  } catch (err) {
    return DEFAULT_BASE_URL;
  }
}

/** GET payload -> query string */
function buildQuery(payload) {
  const params = new URLSearchParams();
  if (payload && typeof payload === 'object') {
    for (const key of Object.keys(payload)) {
      const value = payload[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && value === '') continue;
      params.set(key, String(value));
    }
  }
  return params.toString();
}

/* ------------------------------------------------------------------ */
/* RPC 主流程                                                          */
/* ------------------------------------------------------------------ */

async function handleRpc(message) {
  const method = typeof message.method === 'string' ? message.method.trim() : '';
  const verb = Object.prototype.hasOwnProperty.call(ALLOWED_ROUTES, method)
    ? ALLOWED_ROUTES[method]
    : null;
  if (!verb) {
    return fail('UNKNOWN_METHOD', '不支持的 API 方法：' + (method || '(空)'));
  }

  const payload =
    message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
      ? message.payload
      : {};

  const base = await getBaseUrl();
  let url = base + API_PREFIX + method;
  const init = {
    method: verb,
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    credentials: 'omit'
  };

  if (verb === 'GET') {
    const query = buildQuery(payload);
    if (query) url += '?' + query;
  } else {
    try {
      init.body = JSON.stringify(payload);
    } catch (err) {
      return fail('BAD_REQUEST', '请求参数无法序列化');
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (err) {
      /* ignore */
    }
  }, REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (err) {
    clearTimeout(timer);
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return fail('TIMEOUT', '请求 DSH 超时（' + Math.round(REQUEST_TIMEOUT_MS / 1000) + ' 秒）');
    }
    return fail(
      'DSH_UNREACHABLE',
      '无法连接本机 DSH（' + base + '）。请确认 DSH 已启动、扩展选项页中的地址正确。'
    );
  }
  clearTimeout(timer);

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    return fail('BAD_RESPONSE', '读取 DSH 响应失败');
  }

  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = null;
    }
  }

  if (body && body.ok === false) {
    const apiError = body.error && typeof body.error === 'object' ? body.error : {};
    return fail(
      typeof apiError.code === 'string' && apiError.code ? apiError.code : 'API_ERROR',
      typeof apiError.message === 'string' && apiError.message
        ? apiError.message
        : httpStatusMessage(response.status)
    );
  }

  if (!response.ok) {
    return fail('HTTP_' + response.status, httpStatusMessage(response.status));
  }

  if (body === null) {
    return fail('BAD_RESPONSE', 'DSH 返回了无法解析的响应（期望 JSON）');
  }

  return { ok: true, data: body };
}

/* ------------------------------------------------------------------ */
/* 标签页交互：action 点击 / 快捷键 / 打开选项页                        */
/* ------------------------------------------------------------------ */

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return Array.isArray(tabs) && tabs.length ? tabs[0] : null;
  } catch (err) {
    return null;
  }
}

/** 向 tab 发 toggle；内容脚本不在（扩展刚装/页面未刷新）时补注入一次再试 */
async function sendToggleToTab(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return false;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'dsh-it:toggle' });
    return true;
  } catch (err) {
    /* 内容脚本可能尚未注入，尝试用 scripting 补注入（需要 activeTab/scripting + 页面权限） */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'dsh-it:toggle' });
    return true;
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 右键菜单：dsh翻译 → 原文 / 译文 / 双语对照                          */
/* ------------------------------------------------------------------ */

/** 创建右键菜单（安装、更新、浏览器启动时调用；重复调用先清空再建） */
function createContextMenus() {
  try {
    if (!chrome.contextMenus) return;
    chrome.contextMenus.removeAll(function () {
      try {
        chrome.contextMenus.create({
          id: MENU_ROOT,
          title: 'dsh翻译',
          contexts: ['page']
        });
        chrome.contextMenus.create({
          id: MENU_MODE_SOURCE,
          parentId: MENU_ROOT,
          title: '原文',
          contexts: ['page']
        });
        chrome.contextMenus.create({
          id: MENU_MODE_ONLY,
          parentId: MENU_ROOT,
          title: '译文',
          contexts: ['page']
        });
        chrome.contextMenus.create({
          id: MENU_MODE_BILINGUAL,
          parentId: MENU_ROOT,
          title: '双语对照',
          contexts: ['page']
        });
        chrome.contextMenus.create({
          id: MENU_SHOW_BALL,
          parentId: MENU_ROOT,
          title: '显示悬浮球',
          contexts: ['page']
        });
        chrome.contextMenus.create({
          id: MENU_HIDE_BALL,
          parentId: MENU_ROOT,
          title: '隐藏悬浮球',
          contexts: ['page']
        });
        chrome.contextMenus.create({
          id: MENU_HIDE_DOMAIN,
          parentId: MENU_ROOT,
          title: '当前域名不展示悬浮球',
          contexts: ['page']
        });
        chrome.contextMenus.create({
          id: MENU_TOGGLE_AUTO_SITE,
          parentId: MENU_ROOT,
          title: '当前域名自动翻译（开/关）',
          contexts: ['page']
        });
      } catch (err) {
        /* 创建失败不影响其他功能 */
      }
    });
  } catch (err) {
    /* ignore */
  }
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(function (info, tab) {
    try {
      if (!info || !tab || typeof tab.id !== 'number') return;
      if (info.menuItemId === MENU_SHOW_BALL) {
        chrome.tabs.sendMessage(tab.id, { type: 'dsh-it:show-ball' }).catch(function () {});
        return;
      }
      if (info.menuItemId === MENU_HIDE_BALL) {
        chrome.tabs.sendMessage(tab.id, { type: 'dsh-it:hide-ball' }).catch(function () {});
        return;
      }
      if (info.menuItemId === MENU_HIDE_DOMAIN) {
        chrome.tabs.sendMessage(tab.id, { type: 'dsh-it:hide-domain' }).catch(function () {});
        return;
      }
      if (info.menuItemId === MENU_TOGGLE_AUTO_SITE) {
        chrome.tabs.sendMessage(tab.id, { type: 'dsh-it:toggle-auto-site' }).catch(function () {});
        return;
      }
      const mode = MENU_MODE_MAP[info.menuItemId];
      if (!mode) return;
      chrome.tabs.sendMessage(tab.id, { type: 'dsh-it:set-mode', mode: mode }).catch(function () {});
    } catch (err) {
      /* ignore */
    }
  });
}

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function () {
    createContextMenus();
  });
}

chrome.action.onClicked.addListener(function (tab) {
  try {
    if (!tab || typeof tab.id !== 'number') return;
    // 只打开/收起浮窗，不在点击图标时触发翻译
    chrome.tabs.sendMessage(tab.id, { type: 'dsh-it:toggle-panel' }).catch(function () {});
  } catch (err) {
    /* 不允许把异常抛到 service worker 顶层 */
  }
});

chrome.commands.onCommand.addListener(function (command) {
  try {
    if (command === 'toggle-translate') {
      getActiveTab()
        .then(function (tab) {
          if (tab && typeof tab.id === 'number') return sendToggleToTab(tab.id);
          return false;
        })
        .catch(function () {});
      return;
    }
    if (command === 'shortcut-translate') {
      getActiveTab()
        .then(function (tab) {
          if (tab && typeof tab.id === 'number') {
            return chrome.tabs.sendMessage(tab.id, { type: 'dsh-it:shortcut-translate' });
          }
          return false;
        })
        .catch(function () {});
    }
  } catch (err) {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  try {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'dsh-it:follow') {
      const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
      const action = message.action;
      if (action === 'check') {
        followGetWithInherit(tabId).then(function (following) {
          try {
            sendResponse({ ok: true, following: !!following });
          } catch (err) {
            /* 页面已关闭 */
          }
        });
        return true;
      }
      if (action === 'enable' || action === 'disable') {
        followSet(tabId, action === 'enable').then(function (following) {
          try {
            sendResponse({ ok: true, following: !!following });
          } catch (err) {
            /* 页面已关闭 */
          }
        });
        return true;
      }
      return false;
    }

    if (message.type === 'dsh-it:rpc') {
      handleRpc(message).then(
        function (result) {
          try {
            sendResponse(withEnvelope(message.id, result));
          } catch (err) {
            /* 页面已关闭 */
          }
        },
        function (err) {
          try {
            sendResponse(withEnvelope(message.id, { ok: false, error: normalizeError(err) }));
          } catch (e) {
            /* ignore */
          }
        }
      );
      return true;
    }

    if (message.type === 'dsh-it:open-options') {
      chrome.runtime.openOptionsPage().then(
        function () {
          try {
            sendResponse(withEnvelope(message.id, { ok: true, data: {} }));
          } catch (err) {
            /* ignore */
          }
        },
        function (err) {
          try {
            sendResponse(withEnvelope(message.id, { ok: false, error: normalizeError(err) }));
          } catch (e) {
            /* ignore */
          }
        }
      );
      return true;
    }
  } catch (err) {
    try {
      sendResponse({ ok: false, error: normalizeError(err) });
    } catch (e) {
      /* ignore */
    }
    return false;
  }
  return false;
});

/* ------------------------------------------------------------------ */
/* 跟随翻译：新 tab 从 opener 继承跟随状态；关闭 tab 清理状态           */
/* ------------------------------------------------------------------ */

if (chrome.tabs && chrome.tabs.onCreated) {
  chrome.tabs.onCreated.addListener(function (tab) {
    try {
      if (!tab || typeof tab.id !== 'number') return;
      if (typeof tab.openerTabId !== 'number') return;
      followGet(tab.openerTabId).then(function (following) {
        if (following) followSet(tab.id, true);
      });
    } catch (err) {
      /* ignore */
    }
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    try {
      followSet(tabId, false);
    } catch (err) {
      /* ignore */
    }
  });
}

/* ------------------------------------------------------------------ */
/* 安装/更新：写入默认设置                                             */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(function () {
  createContextMenus();
  (async function () {
    try {
      const stored = await chrome.storage.local.get([
        'dshBaseUrl',
        'targetLanguage',
        'mode',
        'autoTranslate',
        'autoTranslateSites',
        'doubleClickLookup',
        'followTranslation',
        'uiLang'
      ]);
      const patch = {};
      if (!stored || typeof stored.dshBaseUrl !== 'string' || !stored.dshBaseUrl) {
        patch.dshBaseUrl = DEFAULT_BASE_URL;
      }
      if (!stored || typeof stored.targetLanguage !== 'string') patch.targetLanguage = 'zh-CN';
      if (!stored || ['source', 'bilingual', 'only'].indexOf(stored.mode) === -1) {
        patch.mode = 'bilingual';
      }
      if (!stored || typeof stored.autoTranslate !== 'boolean') patch.autoTranslate = false;
      if (!stored || !Array.isArray(stored.autoTranslateSites)) patch.autoTranslateSites = [];
      if (!stored || typeof stored.doubleClickLookup !== 'boolean') patch.doubleClickLookup = true;
      if (!stored || typeof stored.followTranslation !== 'boolean') patch.followTranslation = true;
      if (!stored || typeof stored.hideBallSameLanguage !== 'boolean') patch.hideBallSameLanguage = true;
      if (!stored || typeof stored.translateIframes !== 'boolean') patch.translateIframes = false;
      if (!stored || (stored.uiLang !== 'zh' && stored.uiLang !== 'en')) patch.uiLang = 'zh';
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    } catch (err) {
      /* 安装期写入失败不应影响扩展运行 */
    }
  })();
});
