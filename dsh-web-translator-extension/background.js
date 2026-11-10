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
  'image-translate': 'POST',
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

async function requestHost(method, payload, options) {
  const verb = Object.prototype.hasOwnProperty.call(ALLOWED_ROUTES, method)
    ? ALLOWED_ROUTES[method]
    : null;
  if (!verb) {
    return fail('UNKNOWN_METHOD', '不支持的 API 方法：' + (method || '(空)'));
  }
  const timeoutMs = options && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : REQUEST_TIMEOUT_MS;
  const bodyPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

  const base = await getBaseUrl();
  let url = base + API_PREFIX + method;
  const init = {
    method: verb,
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    credentials: 'omit'
  };

  if (verb === 'GET') {
    const query = buildQuery(bodyPayload);
    if (query) url += '?' + query;
  } else {
    try {
      init.body = JSON.stringify(bodyPayload);
    } catch (err) {
      return fail('BAD_REQUEST', '请求参数无法序列化');
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(function () {
    try {
      controller.abort();
    } catch (err) {
      /* ignore */
    }
  }, timeoutMs);

  let response;
  try {
    response = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (err) {
    clearTimeout(timer);
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return fail('TIMEOUT', '请求 DSH 超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
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

async function handleRpc(message) {
  const method = typeof message.method === 'string' ? message.method.trim() : '';
  const payload =
    message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
      ? message.payload
      : {};
  return requestHost(method, payload);
}

/* ------------------------------------------------------------------ */
/* 图片文字翻译：右键图片 → 截图裁剪 → Host OCR/翻译 → 覆盖层          */
/* ------------------------------------------------------------------ */

/** 右键「翻译图片文字」菜单 id */
const MENU_TRANSLATE_IMAGE = 'dsh-it:translate-image';
/** 截图长边上限（像素）；只影响发送给模型的图片，不影响页面 */
const IMAGE_MAX_SIDE = 1600;
/** 图片翻译请求超时（Host 侧视觉模型 120s + 网络余量） */
const IMAGE_REQUEST_TIMEOUT_MS = 200000;
/** 同一时间只处理一张图片，避免多个截图请求互相覆盖 */
let imageTranslatePending = false;

/** Blob -> base64（不带 data URL 前缀）。 */
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** data URL -> Blob（手动 base64 解码，避免 service worker 对 data: fetch 的差异）。 */
function dataUrlToBlob(dataUrl) {
  const text = typeof dataUrl === 'string' ? dataUrl : '';
  const comma = text.indexOf(',');
  if (comma < 0) throw new Error('截图数据格式异常');
  const header = text.slice(5, comma);
  const mimeMatch = /^([^;]+)/.exec(header);
  const mime = mimeMatch && mimeMatch[1] ? mimeMatch[1] : 'image/jpeg';
  const binary = atob(text.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return new Blob([bytes], { type: mime });
}

/** 从裁剪后的画布上按 bbox 采样背景色，返回每块的 #rrggbb。 */
function sampleImageColors(context, width, height, blocks) {
  const colors = [];
  let pixels;
  try {
    pixels = context.getImageData(0, 0, width, height).data;
  } catch (err) {
    pixels = null;
  }
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const bbox = Array.isArray(block && block.bbox) ? block.bbox : null;
    if (!pixels || !bbox) {
      colors.push('#ffffff');
      continue;
    }
    const x0 = Math.max(0, Math.round(bbox[0] * width));
    const y0 = Math.max(0, Math.round(bbox[1] * height));
    const x1 = Math.min(width, Math.round(bbox[2] * width));
    const y1 = Math.min(height, Math.round(bbox[3] * height));
    const inset = Math.max(1, Math.round(Math.min(x1 - x0, y1 - y0) * 0.08));
    const samples = [];
    for (let step = 0; step <= 8; step += 1) {
      const ratio = step / 8;
      const points = [
        [x0 + Math.round((x1 - x0) * ratio), Math.min(y1 - 1, y0 + inset)],
        [x0 + Math.round((x1 - x0) * ratio), Math.max(y0, y1 - inset - 1)],
        [Math.min(x1 - 1, x0 + inset), y0 + Math.round((y1 - y0) * ratio)],
        [Math.max(x0, x1 - inset - 1), y0 + Math.round((y1 - y0) * ratio)]
      ];
      for (const point of points) {
        const px = Math.min(width - 1, Math.max(0, point[0]));
        const py = Math.min(height - 1, Math.max(0, point[1]));
        const offset = (py * width + px) * 4;
        samples.push([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
      }
    }
    const sum = [0, 0, 0];
    for (const sample of samples) {
      sum[0] += sample[0];
      sum[1] += sample[1];
      sum[2] += sample[2];
    }
    const count = Math.max(1, samples.length);
    const hex = [0, 1, 2].map(function (index) {
      return Math.round(sum[index] / count).toString(16).padStart(2, '0');
    }).join('');
    colors.push('#' + hex);
  }
  return colors;
}

/** 抓取并裁剪当前视口中的图片区域，返回画布与 base64。 */
async function captureImageRegion(message, tab) {
  const viewportWidth = Math.max(1, Number(message.viewportWidth) || 1);
  const viewportHeight = Math.max(1, Number(message.viewportHeight) || 1);
  const rect = message.rect && typeof message.rect === 'object' ? message.rect : {};
  const left = Math.max(0, Number(rect.left) || 0);
  const top = Math.max(0, Number(rect.top) || 0);
  const rectWidth = Math.max(1, Number(rect.width) || 1);
  const rectHeight = Math.max(1, Number(rect.height) || 1);

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 });
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const scaleX = bitmap.width / viewportWidth;
  const scaleY = bitmap.height / viewportHeight;
  let sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(left * scaleX)));
  let sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(top * scaleY)));
  let sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rectWidth * scaleX)));
  let sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rectHeight * scaleY)));
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建图片画布');
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
  const cropped = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const base64 = await blobToBase64(cropped);
  return { canvas, context, width, height, base64, bytes: cropped.size };
}

/** 处理 content 的图片翻译请求；返回 true 表示异步 sendResponse。 */
async function handleImageTranslate(message, sender, sendResponse) {
  if (imageTranslatePending) {
    sendResponse(fail('IMAGE_BUSY', '正在翻译上一张图片，请稍候'));
    return;
  }
  imageTranslatePending = true;
  try {
    const tab = sender && sender.tab;
    if (!tab || typeof tab.id !== 'number') {
      sendResponse(fail('IMAGE_FAILED', '找不到当前标签页'));
      return;
    }
    if (!chrome.tabs || typeof chrome.tabs.captureVisibleTab !== 'function') {
      sendResponse(fail('IMAGE_FAILED', '当前浏览器不支持截图翻译'));
      return;
    }
    const capture = await captureImageRegion(message, tab);
    const turnId = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const payload = {
      image: { mediaType: 'image/jpeg', data: capture.base64 },
      sourceUrl: typeof message.sourceUrl === 'string' ? message.sourceUrl : '',
      sourceTitle: typeof message.sourceTitle === 'string' ? message.sourceTitle : '',
      client: 'extension',
      turnId: turnId,
      stepIndex: 0,
      mode: 'image',
      compact: message.compact === true
    };
    const response = await requestHost('image-translate', payload, { timeoutMs: IMAGE_REQUEST_TIMEOUT_MS });
    if (!response || response.ok !== true) {
      sendResponse(response || fail('IMAGE_FAILED', '图片翻译失败'));
      return;
    }
    const data = response.data && typeof response.data === 'object' ? response.data : {};
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    const blocks = Array.isArray(result.blocks) ? result.blocks : [];
    const colors = sampleImageColors(capture.context, capture.width, capture.height, blocks);
    sendResponse({
      ok: true,
      data: {
        result: Object.assign({}, result, { blocks: blocks, colors: colors }),
        usage: data.usage || {},
        capture: {
          rect: message.rect,
          elementRect: message.elementRect,
          viewportWidth: message.viewportWidth,
          viewportHeight: message.viewportHeight
        }
      }
    });
  } catch (err) {
    const normalized = normalizeError(err);
    const code = normalized.code === 'UNKNOWN' ? 'IMAGE_FAILED' : normalized.code;
    const hint = code === 'IMAGE_FAILED' ? '无法截图或翻译图片：' + normalized.message : normalized.message;
    sendResponse(fail(code, hint));
  } finally {
    imageTranslatePending = false;
  }
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
          id: MENU_TRANSLATE_IMAGE,
          title: '翻译图片文字',
          contexts: ['image']
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
      if (info.menuItemId === MENU_TRANSLATE_IMAGE) {
        if (typeof info.srcUrl === 'string' && info.srcUrl) {
          chrome.tabs.sendMessage(
            tab.id,
            { type: 'dsh-it:translate-image', srcUrl: info.srcUrl },
            { frameId: 0 }
          ).catch(function () {});
        }
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

    if (message.type === 'dsh-it:image-translate') {
      handleImageTranslate(message, sender, sendResponse).catch(function (err) {
        try {
          sendResponse(fail('IMAGE_FAILED', normalizeError(err).message));
        } catch (e) {
          /* page closed */
        }
      });
      return true;
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
