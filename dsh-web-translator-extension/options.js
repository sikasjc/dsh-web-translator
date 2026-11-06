/*!
 * dsh翻译 · DSH —— options 页逻辑
 *
 * 只通过 background 的 RPC 与 DSH 通信（选项页不直接 fetch）。
 * 保存到 chrome.storage.local：dshBaseUrl / targetLanguage / mode / autoTranslate / uiLang
 */
'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';

/** 与 Host / DSH 设置页对齐的 12 个目标语言 */
const TARGET_LANGUAGES = [
  { code: 'zh-CN', native: '简体中文' },
  { code: 'zh-TW', native: '繁體中文' },
  { code: 'en', native: 'English' },
  { code: 'ja', native: '日本語' },
  { code: 'ko', native: '한국어' },
  { code: 'fr', native: 'Français' },
  { code: 'de', native: 'Deutsch' },
  { code: 'es', native: 'Español' },
  { code: 'ru', native: 'Русский' },
  { code: 'pt', native: 'Português' },
  { code: 'it', native: 'Italiano' },
  { code: 'ar', native: 'العربية' }
];

const MODES = ['source', 'bilingual', 'only'];
const DEFAULT_SETTINGS = {
  dshBaseUrl: DEFAULT_BASE_URL,
  targetLanguage: 'zh-CN',
  mode: 'bilingual',
  scheduleMode: 'screen',
  preload: 'one',
  autoTranslate: false,
  selectionTranslate: false,
  doubleClickTranslate: false,
  shortcutTranslate: false,
  followTranslation: true,
  showFloatingBall: true,
  hideBallSameLanguage: true,
  translateIframes: false,
  uiLang: 'zh'
};
const RPC_TIMEOUT_MS = 120000;

const I18N = {
  zh: {
    pageTitle: 'dsh翻译 · DSH 扩展设置',
    appTitle: 'dsh翻译 · 扩展设置',
    appSubtitle: '调用本机 DSH 插件 API 做网页翻译；模型与提示词在 DSH 设置页中编辑。',
    secConnection: '连接',
    fieldBaseUrl: 'DSH 地址',
    hintBaseUrl:
      '默认 http://127.0.0.1:3080（DSH Web / 插件 API 所在地址）。manifest 的 host_permissions 仅覆盖 127.0.0.1:3080 与 localhost:3080，改端口需同步改 manifest 并重新加载扩展。',
    btnTest: '测试连接',
    btnReadModel: '读取当前模型',
    roProvider: 'Provider',
    roModel: '模型',
    roEffort: '推理强度',
    roTarget: 'DSH 设置的目标语言',
    roSource: '配置来源',
    hintReadonly: '只读回显。模型、推理强度、提示词请到 DSH → 设置 → dsh翻译 中修改（扩展不保存提示词）。',
    secTranslate: '翻译',
    fieldTarget: '目标语言',
    fieldMode: '默认显示模式',
    modeSource: '原文',
    modeBilingual: '双语对照',
    modeOnly: '仅译文',
    fieldSchedule: '调度方式',
    scheduleScreen: '按屏触发（默认，整屏一次翻译）',
    scheduleBlock: '按块懒加载（省 token）',
    fieldPreload: '预加载',
    preloadNone: '不预加载（仅当前视口）',
    preloadHalf: '半屏',
    preloadOne: '一屏（默认）',
    hintSchedule:
      '按屏触发：滚动停稳后整屏翻译（请求更少、译文更整齐）；按块懒加载：只翻进入视口的段落（最省 token）。预加载决定当前视口下方额外翻译多少，选项在新一次翻译时生效。',
    fieldAuto: '页面加载后自动翻译（默认关闭）',
    fieldSelection: '划词翻译（选中文本后弹出翻译卡，默认关闭）',
    fieldDoubleClick: '双击翻译（双击单词/短句弹出翻译卡，默认关闭）',
    fieldShortcut: '快捷键翻译（默认关闭；选中文本按快捷键翻译选区，无选中则翻译整页）',
    hintShortcut: '快捷键在浏览器扩展快捷键页自定义（建议 Command+K / Ctrl+K）：chrome://extensions/shortcuts',
    btnShortcut: '打开快捷键设置',
    shortcutOpenFail: '无法自动打开快捷键页，请手动访问 chrome://extensions/shortcuts',
    fieldFollow: '跟随翻译（翻译过的页面里点击链接，打开的新页面自动翻译）',
    fieldShowBall: '显示悬浮球（可拖动；隐藏后可用右键菜单「dsh翻译 → 显示悬浮球」恢复）',
    fieldHideSameLang: '页面语言与目标语言一致时隐藏悬浮球（默认开启）',
    fieldTranslateIframes: '翻译 iframe 内内容（默认关闭；Cookie 弹窗、嵌入评论等）',
    fieldUiLang: '界面语言',
    btnSave: '保存',
    btnOpenDsh: '打开 DSH 页面',
    secUsage: '使用与隐私',
    tip1: '在任意网页点击工具栏图标、按 Alt+T，或点击页面右下角悬浮球打开面板，点「翻译此页」。',
    tip2: '选中文本或双击单词会弹出查词卡，可发音、加入单词本（单词本在 DSH 设置页复习）。',
    tip3: '所有网络请求都由扩展后台发往本机 DSH；页面文本经 DSH 发送给你在 DSH 中配置的模型服务，扩展本身不保存页面内容。',
    tip4: '需要先安装并启用 DSH 插件「dsh翻译」，DSH Web 默认运行在 127.0.0.1:3080。',
    saved: '已保存。已打开的网页刷新或重新打开页面后生效（目标语言/模式即时生效）。',
    saveFail: '保存失败：{msg}',
    invalidUrl: 'DSH 地址需以 http:// 或 https:// 开头',
    testing: '正在连接 DSH…',
    testOk: '连接成功：DSH v{version}，已运行 {uptime}，模型 {models} 个',
    testFail: '连接失败：{msg}',
    reading: '正在读取 DSH 设置…',
    readFail: '读取失败：{msg}',
    sourceSettings: 'DSH 设置',
    sourceDefault: 'DSH 默认（未保存过）',
    opening: '已打开 DSH 页面：{url}',
    openFail: '打开失败：{msg}',
    seconds: '秒',
    unsupported: '扩展后台不可用，请在 chrome://extensions 重新加载扩展'
  },
  en: {
    pageTitle: 'dsh-web-translator · DSH Options',
    appTitle: 'dsh-web-translator · Options',
    appSubtitle:
      'Web page translation through the local DSH plugin API; models and prompts are edited in DSH settings.',
    secConnection: 'Connection',
    fieldBaseUrl: 'DSH base URL',
    hintBaseUrl:
      'Default http://127.0.0.1:3080 (where DSH Web / plugin API runs). host_permissions in manifest only cover 127.0.0.1:3080 and localhost:3080; changing the port requires editing manifest and reloading.',
    btnTest: 'Test connection',
    btnReadModel: 'Read current model',
    roProvider: 'Provider',
    roModel: 'Model',
    roEffort: 'Reasoning effort',
    roTarget: 'Target language in DSH',
    roSource: 'Config source',
    hintReadonly:
      'Read-only. Edit model, reasoning effort and prompts in DSH → Settings → dsh-web-translator. The extension never stores prompts.',
    secTranslate: 'Translation',
    fieldTarget: 'Target language',
    fieldMode: 'Default display mode',
    modeSource: 'Original only',
    modeBilingual: 'Bilingual',
    modeOnly: 'Translation only',
    fieldSchedule: 'Scheduling',
    scheduleScreen: 'Screen (default; translate the whole screen at once)',
    scheduleBlock: 'Block lazy (save tokens)',
    fieldPreload: 'Preload',
    preloadNone: 'None (current viewport only)',
    preloadHalf: 'Half screen',
    preloadOne: 'One screen (default)',
    hintSchedule:
      'Screen: after scrolling stops, translate the whole screen (fewer requests, more consistent translation). Block lazy: translate only blocks entering the viewport (saves the most tokens). Preload controls how much below the viewport is translated; changes apply to the next translation run.',
    fieldAuto: 'Auto-translate on page load (off by default)',
    fieldSelection: 'Translate selection (show a translation card after selecting text; off by default)',
    fieldDoubleClick: 'Double-click translation (double-click a word/phrase to translate; off by default)',
    fieldShortcut: 'Shortcut translation (off by default; with a selection translates it, otherwise translates the page)',
    hintShortcut: 'Customize the shortcut at chrome://extensions/shortcuts (suggested Command+K / Ctrl+K)',
    btnShortcut: 'Open shortcut settings',
    shortcutOpenFail: 'Could not open the shortcut page; visit chrome://extensions/shortcuts manually',
    fieldFollow: 'Follow translation (auto-translate pages opened from links on a translated page)',
    fieldShowBall: 'Show floating ball (draggable; restore via right-click → dsh翻译 → Show floating ball)',
    fieldHideSameLang: 'Hide the floating ball when the page language matches the target language (on by default)',
    fieldTranslateIframes: 'Translate content inside iframes (off by default; cookie dialogs, embedded comments)',
    fieldUiLang: 'UI language',
    btnSave: 'Save',
    btnOpenDsh: 'Open DSH page',
    secUsage: 'Usage & privacy',
    tip1: 'Click the toolbar icon, press Alt+T, or click the floating ball at the bottom-right of a page, then click "Translate this page".',
    tip2: 'Select text or double-click a word to open the lookup card: pronounce it or add it to the wordbook (review in DSH settings).',
    tip3:
      'All network requests go from the extension background to the local DSH; page text is sent via DSH to the model provider you configured. The extension does not persist page content.',
    tip4: 'Install and enable the DSH plugin "dsh-web-translator" first. DSH Web runs at 127.0.0.1:3080 by default.',
    saved: 'Saved. Reload open pages to apply all settings (target language / mode apply immediately).',
    saveFail: 'Save failed: {msg}',
    invalidUrl: 'DSH base URL must start with http:// or https://',
    testing: 'Connecting to DSH…',
    testOk: 'Connected: DSH v{version}, uptime {uptime}, {models} model(s)',
    testFail: 'Connection failed: {msg}',
    reading: 'Reading DSH settings…',
    readFail: 'Read failed: {msg}',
    sourceSettings: 'DSH settings',
    sourceDefault: 'DSH default (not saved yet)',
    opening: 'Opened DSH page: {url}',
    openFail: 'Open failed: {msg}',
    seconds: 's',
    unsupported: 'Extension background unavailable. Reload the extension in chrome://extensions'
  }
};

const state = {
  settings: Object.assign({}, DEFAULT_SETTINGS),
  uiLang: 'zh',
  busy: false
};

const $ = (id) => document.getElementById(id);

function t(key, vars) {
  const dict = I18N[state.uiLang] || I18N.zh;
  let text = dict[key] != null ? dict[key] : I18N.zh[key] != null ? I18N.zh[key] : key;
  if (vars) {
    for (const name of Object.keys(vars)) {
      text = text.split('{' + name + '}').join(String(vars[name]));
    }
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* RPC（与 content.js 相同协议，经 background 出网）                    */
/* ------------------------------------------------------------------ */

let rpcSeq = 0;

function rpc(method, payload) {
  return new Promise((resolve, reject) => {
    const id = 'opt' + Date.now().toString(36) + '_' + ++rpcSeq;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject({ code: 'TIMEOUT', message: '请求超时' });
    }, RPC_TIMEOUT_MS);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    try {
      chrome.runtime.sendMessage({ type: 'dsh-it:rpc', id: id, method: method, payload: payload || {} }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          finish(reject, { code: 'EXTENSION_UNAVAILABLE', message: t('unsupported') });
          return;
        }
        if (!response || response.type !== 'dsh-it:result' || response.id !== id) {
          finish(reject, { code: 'EMPTY_RESPONSE', message: t('unsupported') });
          return;
        }
        if (response.ok !== true) {
          const error = response.error ? response.error : { code: 'EMPTY_RESPONSE', message: t('unsupported') };
          finish(reject, { code: error.code || 'ERROR', message: error.message || t('unsupported') });
          return;
        }
        finish(resolve, response.data);
      });
    } catch (err) {
      finish(reject, { code: 'EXTENSION_UNAVAILABLE', message: t('unsupported') });
    }
  });
}

function errorText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message || err.code || '未知错误';
}

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

function storageGet(keys) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish({}), 1500);
    try {
      chrome.storage.local.get(keys, (items) => {
        clearTimeout(timer);
        finish(items && typeof items === 'object' ? items : {});
      });
    } catch (err) {
      clearTimeout(timer);
      finish({});
    }
  });
}

function storageSet(patch) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, value) => {
      if (done) return;
      done = true;
      if (ok) resolve(value);
      else reject(value);
    };
    const timer = setTimeout(() => finish(false, { code: 'TIMEOUT', message: '写入设置超时' }), 2000);
    try {
      chrome.storage.local.set(patch, () => {
        clearTimeout(timer);
        const lastError = chrome.runtime.lastError;
        if (lastError) finish(false, { code: 'STORAGE_ERROR', message: lastError.message });
        else finish(true, true);
      });
    } catch (err) {
      clearTimeout(timer);
      finish(false, { code: 'STORAGE_ERROR', message: String((err && err.message) || err) });
    }
  });
}

function normalizeSettings(raw) {
  const result = Object.assign({}, DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return result;
  if (typeof raw.dshBaseUrl === 'string' && raw.dshBaseUrl.trim()) {
    result.dshBaseUrl = sanitizeBaseUrl(raw.dshBaseUrl);
  }
  if (typeof raw.targetLanguage === 'string' && findLanguage(raw.targetLanguage)) {
    result.targetLanguage = raw.targetLanguage;
  }
  if (MODES.indexOf(raw.mode) !== -1) result.mode = raw.mode;
  if (raw.scheduleMode === 'screen' || raw.scheduleMode === 'block') result.scheduleMode = raw.scheduleMode;
  if (raw.preload === 'none' || raw.preload === 'half' || raw.preload === 'one') result.preload = raw.preload;
  if (typeof raw.autoTranslate === 'boolean') result.autoTranslate = raw.autoTranslate;
  if (typeof raw.selectionTranslate === 'boolean') result.selectionTranslate = raw.selectionTranslate;
  if (typeof raw.doubleClickTranslate === 'boolean') result.doubleClickTranslate = raw.doubleClickTranslate;
  if (typeof raw.shortcutTranslate === 'boolean') result.shortcutTranslate = raw.shortcutTranslate;
  if (typeof raw.followTranslation === 'boolean') result.followTranslation = raw.followTranslation;
  if (typeof raw.showFloatingBall === 'boolean') result.showFloatingBall = raw.showFloatingBall;
  if (typeof raw.hideBallSameLanguage === 'boolean') result.hideBallSameLanguage = raw.hideBallSameLanguage;
  if (typeof raw.translateIframes === 'boolean') result.translateIframes = raw.translateIframes;
  if (raw.uiLang === 'zh' || raw.uiLang === 'en') result.uiLang = raw.uiLang;
  return result;
}

function findLanguage(code) {
  return TARGET_LANGUAGES.find((lang) => lang.code === code) || null;
}

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
    return raw; // 交给保存校验报错
  }
}

function isValidBaseUrl(value) {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 界面                                                                */
/* ------------------------------------------------------------------ */

function setStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function applyLang() {
  document.documentElement.lang = state.uiLang === 'en' ? 'en' : 'zh-CN';
  document.title = t('pageTitle');
  const nodes = document.querySelectorAll('[data-i18n]');
  for (const node of nodes) {
    const key = node.getAttribute('data-i18n');
    if (!key) continue;
    node.textContent = t(key);
  }
  fillLanguageSelect();
}

function fillLanguageSelect() {
  const select = $('targetLanguage');
  if (!select) return;
  while (select.firstChild) select.removeChild(select.firstChild);
  for (const lang of TARGET_LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.native;
    select.appendChild(option);
  }
  select.value = findLanguage(state.settings.targetLanguage)
    ? state.settings.targetLanguage
    : DEFAULT_SETTINGS.targetLanguage;
}

function fillForm() {
  $('baseUrl').value = state.settings.dshBaseUrl;
  fillLanguageSelect();
  $('mode').value = MODES.indexOf(state.settings.mode) !== -1 ? state.settings.mode : DEFAULT_SETTINGS.mode;
  $('scheduleMode').value = state.settings.scheduleMode === 'block' ? 'block' : 'screen';
  $('preload').value = ['none', 'half', 'one'].indexOf(state.settings.preload) !== -1 ? state.settings.preload : DEFAULT_SETTINGS.preload;
  $('autoTranslate').checked = !!state.settings.autoTranslate;
  $('selectionTranslate').checked = state.settings.selectionTranslate === true;
  $('doubleClickTranslate').checked = state.settings.doubleClickTranslate === true;
  $('shortcutTranslate').checked = state.settings.shortcutTranslate === true;
  $('followTranslation').checked = state.settings.followTranslation !== false;
  $('showFloatingBall').checked = state.settings.showFloatingBall !== false;
  $('hideBallSameLanguage').checked = state.settings.hideBallSameLanguage !== false;
  $('translateIframes').checked = state.settings.translateIframes === true;
  $('uiLang').value = state.settings.uiLang;
}

function readForm() {
  const baseUrlRaw = $('baseUrl').value.trim();
  const baseUrl = sanitizeBaseUrl(baseUrlRaw);
  if (!isValidBaseUrl(baseUrl)) throw { code: 'INVALID_URL', message: t('invalidUrl') };

  const targetLanguage = $('targetLanguage').value;
  const mode = $('mode').value;
  const scheduleMode = $('scheduleMode').value === 'block' ? 'block' : 'screen';
  const preload = ['none', 'half', 'one'].indexOf($('preload').value) !== -1 ? $('preload').value : DEFAULT_SETTINGS.preload;
  const autoTranslate = !!$('autoTranslate').checked;
  const selectionTranslate = !!$('selectionTranslate').checked;
  const doubleClickTranslate = !!$('doubleClickTranslate').checked;
  const shortcutTranslate = !!$('shortcutTranslate').checked;
  const followTranslation = !!$('followTranslation').checked;
  const showFloatingBall = !!$('showFloatingBall').checked;
  const hideBallSameLanguage = !!$('hideBallSameLanguage').checked;
  const translateIframes = !!$('translateIframes').checked;
  const uiLang = $('uiLang').value === 'en' ? 'en' : 'zh';

  return {
    dshBaseUrl: baseUrl,
    targetLanguage: findLanguage(targetLanguage) ? targetLanguage : DEFAULT_SETTINGS.targetLanguage,
    mode: MODES.indexOf(mode) !== -1 ? mode : DEFAULT_SETTINGS.mode,
    scheduleMode: scheduleMode,
    preload: preload,
    autoTranslate: autoTranslate,
    selectionTranslate: selectionTranslate,
    doubleClickTranslate: doubleClickTranslate,
    shortcutTranslate: shortcutTranslate,
    followTranslation: followTranslation,
    showFloatingBall: showFloatingBall,
    hideBallSameLanguage: hideBallSameLanguage,
    translateIframes: translateIframes,
    uiLang: uiLang
  };
}

async function save(options) {
  const opts = options || {};
  const saveStatus = $('saveStatus');
  let values;
  try {
    values = readForm();
  } catch (err) {
    setStatus(saveStatus, err.message || t('saveFail', { msg: errorText(err) }), 'err');
    return false;
  }

  try {
    await storageSet(values);
    state.settings = normalizeSettings(values);
    // 同步当前界面语言
    if (state.uiLang !== state.settings.uiLang) {
      state.uiLang = state.settings.uiLang;
      applyLang();
      fillForm();
    } else {
      $('baseUrl').value = state.settings.dshBaseUrl;
    }
    if (!opts.silent) setStatus(saveStatus, t('saved'), 'ok');
    else setStatus(saveStatus, '', '');
    return true;
  } catch (err) {
    setStatus(saveStatus, t('saveFail', { msg: errorText(err) }), 'err');
    return false;
  }
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ['testBtn', 'modelBtn', 'saveBtn', 'openDshBtn', 'baseUrl', 'targetLanguage', 'mode', 'scheduleMode', 'preload', 'autoTranslate', 'selectionTranslate', 'doubleClickTranslate', 'shortcutTranslate', 'followTranslation', 'showFloatingBall', 'hideBallSameLanguage', 'translateIframes', 'uiLang']) {
    const el = $(id);
    if (el) el.disabled = busy;
  }
}

async function testConnection() {
  if (state.busy) return;
  const connStatus = $('connStatus');
  setStatus(connStatus, t('testing'), '');
  setBusy(true);
  try {
    const saved = await save({ silent: true });
    if (!saved) {
      setStatus(connStatus, '', '');
      return;
    }
    const data = await rpc('health', {});
    const llm = data && data.llm ? data.llm : {};
    const providers = typeof llm.providers === 'number' ? llm.providers : 0;
    const models = typeof llm.models === 'number' ? llm.models : 0;
    const uptimeMs = typeof data.uptimeMs === 'number' ? data.uptimeMs : 0;
    const uptime = uptimeMs > 0 ? Math.round(uptimeMs / 1000) + t('seconds') : '—';
    setStatus(
      connStatus,
      t('testOk', {
        version: (data && data.version) || '—',
        uptime: uptime,
        models: models
      }) + (providers ? '（provider ' + providers + '）' : ''),
      'ok'
    );
  } catch (err) {
    setStatus(connStatus, t('testFail', { msg: errorText(err) }), 'err');
  } finally {
    setBusy(false);
  }
}

async function readModel() {
  if (state.busy) return;
  const connStatus = $('connStatus');
  setStatus(connStatus, t('reading'), '');
  setBusy(true);
  try {
    const saved = await save({ silent: true });
    if (!saved) {
      setStatus(connStatus, '', '');
      return;
    }
    const data = await rpc('settings', {});
    const settings = data && data.settings ? data.settings : {};
    const selected = data && data.selected ? data.selected : {};
    const modelInfo = data && data.modelInfo ? data.modelInfo : {};

    const provider = selected.provider || modelInfo.provider || settings.provider || '—';
    const model = selected.model || modelInfo.model || settings.model || '—';
    const effort = selected.reasoningEffort || settings.reasoningEffort || '—';
    const target =
      (findLanguage(settings.targetLanguage) && findLanguage(settings.targetLanguage).native) ||
      settings.targetLanguage ||
      '—';
    const source = selected.source === 'settings' ? t('sourceSettings') : t('sourceDefault');

    $('roProvider').textContent = provider;
    $('roModel').textContent = model;
    $('roEffort').textContent = effort;
    $('roTarget').textContent = target;
    $('roSource').textContent = source;
    $('modelInfo').hidden = false;
    setStatus(connStatus, '', '');
  } catch (err) {
    $('modelInfo').hidden = true;
    setStatus(connStatus, t('readFail', { msg: errorText(err) }), 'err');
  } finally {
    setBusy(false);
  }
}

async function openDshPage() {
  if (state.busy) return;
  let values;
  try {
    values = readForm();
  } catch (err) {
    setStatus($('saveStatus'), err.message || t('saveFail', { msg: errorText(err) }), 'err');
    return;
  }
  try {
    await chrome.tabs.create({ url: values.dshBaseUrl });
    setStatus($('saveStatus'), t('opening', { url: values.dshBaseUrl }), 'ok');
  } catch (err) {
    setStatus($('saveStatus'), t('openFail', { msg: errorText(err) }), 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  try {
    const raw = await storageGet(['dshBaseUrl', 'targetLanguage', 'mode', 'scheduleMode', 'preload', 'autoTranslate', 'selectionTranslate', 'doubleClickTranslate', 'shortcutTranslate', 'followTranslation', 'showFloatingBall', 'hideBallSameLanguage', 'uiLang']);
    state.settings = normalizeSettings(raw);
    state.uiLang = state.settings.uiLang;
    applyLang();
    fillForm();
    setStatus($('saveStatus'), '', '');
  } catch (err) {
    setStatus($('saveStatus'), t('saveFail', { msg: errorText(err) }), 'err');
  }

  $('testBtn').addEventListener('click', () => {
    testConnection().catch(() => {});
  });
  $('modelBtn').addEventListener('click', () => {
    readModel().catch(() => {});
  });
  $('saveBtn').addEventListener('click', () => {
    save().catch(() => {});
  });
  $('openDshBtn').addEventListener('click', () => {
    openDshPage().catch(() => {});
  });
  $('shortcutBtn').addEventListener('click', () => {
    try {
      Promise.resolve(chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })).catch(() => {
        setStatus($('saveStatus'), t('shortcutOpenFail'), 'err');
      });
    } catch (err) {
      setStatus($('saveStatus'), t('shortcutOpenFail'), 'err');
    }
  });
  $('uiLang').addEventListener('change', () => {
    state.uiLang = $('uiLang').value === 'en' ? 'en' : 'zh';
    applyLang();
    fillForm();
    $('uiLang').value = state.uiLang;
  });
  $('baseUrl').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save().catch(() => {});
  });
}

init().catch(() => {
  /* 极端情况下也不抛出到未知处；页面保留默认表单 */
});
