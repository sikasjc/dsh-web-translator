/*!
 * dsh翻译 · DSH —— content script（经典脚本，无 import）
 *
 * 职责：
 *  - 页面内 Shadow DOM UI：悬浮球 / 面板 / 划词查词卡
 *  - 段落抽取 → 分组 → 经 background 调本机 DSH API 翻译 → 边到边注入译文
 *  - 三种显示模式（原文 / 双语对照 / 仅译文）只改 DOM 属性，不重复请求
 *  - 划词/双击查词、发音、加入单词本
 *
 * 约束：
 *  - 本文件不做任何网络请求（全部经 background.js 的 dsh-it:rpc）
 *  - 不把页面内容写进 chrome.storage 或日志；不修改站点 <head>
 *  - 所有入口 try/catch，错误显示在面板状态行
 */
(function () {
  'use strict';

  if (window.__dshItContentLoaded) return;
  window.__dshItContentLoaded = true;

  /* ================================================================ */
  /* 常量                                                              */
  /* ================================================================ */

  /** 是否为 iframe 子框架：子框架只响应父页面广播，不创建悬浮球/面板 */
  var IS_SUBFRAME = false;
  try {
    IS_SUBFRAME = window.top !== window.self;
  } catch (err) {
    IS_SUBFRAME = true;
  }

  var EXT_VERSION = '1.17.7';
  // 供 DSH 插件页检测“当前浏览器是否安装了扩展”；不包含页面数据。
  if (!IS_SUBFRAME) {
    try {
      document.documentElement.setAttribute('data-dsh-it-extension', EXT_VERSION);
      window.__dshItExtensionVersion = EXT_VERSION;
    } catch (err) {
      /* ignore */
    }
  }
  var HOST_ID = 'dsh-it-host';
  var IMAGE_OVERLAY_ID = 'dsh-it-image-overlay';
  var HOST_STYLE =
    'position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;' +
    'overflow:visible!important;z-index:2147483647!important;pointer-events:none!important;' +
    'display:block!important;margin:0!important;padding:0!important;border:0!important;background:none!important;';
  var MODE_ATTR = 'data-dsh-it-mode';
  var MARK_ATTR = 'data-dsh-it';
  /** 双语对照布局标记：inline = 译文并排在原文右侧，below = 译文在原文下方 */
  var LAYOUT_ATTR = 'data-dsh-it-layout';
  /** 右键菜单触发“翻译选中文本”时，记录 contextmenu 时的选区与位置 */
  var lastContextSelection = null;
  /** 右键图片时记录元素，供“翻译图片文字”消息到达后定位（srcUrl 冲突时兜底） */
  var lastContextImage = null;
  /** 图片翻译进行中标记（同一时间只允许一张） */
  var imageTranslatePending = false;
  /** 当前图片翻译覆盖层（含 host / shadow / 原图信息） */
  var imageOverlay = null;
  var PAGE_STYLE_ID = 'dsh-it-page-style';

  var MODES = ['source', 'bilingual', 'only'];
  var MODE_KEYS = { source: 'modeSource', bilingual: 'modeBilingual', only: 'modeOnly' };

  var MAX_BLOCKS = 800;
  /** 行内文案（导航/标签/页脚/按钮等文字节点）单页上限 */
  var MAX_TEXT_UNITS = 600;
  /** 行内文案单条最大字符数 */
  var MAX_INLINE_TEXT = 240;
  var MIN_TEXT = 2;
  var INLINE_MIN_TEXT = 12; // 行内 DIV/SPAN 需 ≥12 字符才作为候选
  var MAX_TEXT = 4000;
  var BATCH_MAX_SEGMENTS = 10;
  var BATCH_MAX_CHARS = 1600;
  var CONCURRENCY = 2;
  /**
   * 微批合并（coalescing）：滚动/懒加载触发的零散块先在一个短窗口内攒着，
   * 攒够目标或窗口到点再发，避免每 1~3 段就发一次请求（重复的固定提示词很贵）。
   * 硬上限仍是 BATCH_MAX_SEGMENTS / BATCH_MAX_CHARS / CONCURRENCY。
   */
  var BATCH_COALESCE_MS = 180; // 静默窗口：最后一次入队后再等这么久（约 150~200ms）
  var BATCH_COALESCE_MIN_SEGMENTS = 3; // 队列达到该段数 → 立即发送
  var BATCH_COALESCE_MIN_CHARS = 400; // 队列达到该字符数 → 立即发送
  var BATCH_COALESCE_MAX_WAIT_MS = 400; // 从首个排队块起的最长等待（兜底延迟上限）
  /**
   * 按屏触发（screen scheduling，默认）：滚动/缩放停稳后统一扫描当前“屏幕窗口”并整屏发送，
   * 快速连续滚动期间不翻译中间屏幕（减少无效请求，译文按屏整齐出现）。
   */
  var SCREEN_SCAN_DEBOUNCE_MS = 140; // 滚动/缩放停稳后的防抖窗口（约 120~150ms）
  /** preload 设置 → 视口下方额外翻译的屏数系数 */
  var PRELOAD_FACTORS = { none: 0, half: 0.5, one: 1 };
  var MAX_SELECTION = 500;
  var RPC_TIMEOUT_MS = 125000;

  var DEFAULT_SETTINGS = {
    dshBaseUrl: 'http://127.0.0.1:3080',
    targetLanguage: 'zh-CN',
    mode: 'bilingual',
    scheduleMode: 'screen',
    preload: 'one',
    autoTranslate: false,
    autoTranslateSites: [],
    selectionTranslate: false,
    doubleClickTranslate: false,
    shortcutTranslate: false,
    followTranslation: true,
    hideBallSameLanguage: true,
    translateIframes: false,
    imageFastMode: false,
    showFloatingBall: true,
    ballPosition: { right: 16, bottom: 16 },
    uiLang: 'zh'
  };
  var STORAGE_KEYS = [
    'dshBaseUrl',
    'targetLanguage',
    'mode',
    'scheduleMode',
    'preload',
    'autoTranslate',
    'autoTranslateSites',
    'selectionTranslate',
    'doubleClickTranslate',
    'shortcutTranslate',
    'followTranslation',
    'hideBallSameLanguage',
    'translateIframes',
    'imageFastMode',
    'showFloatingBall',
    'ballPosition',
    'uiLang'
  ];

  /** 与 Host / DSH 设置页对齐的 12 个目标语言 */
  var LANGUAGES = [
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

  /**
   * 块级注入候选：正文类块。LI/DT/DD 不做块级注入（会向列表新增条目），
   * 其文字改为行内注入（见 collectTextUnits），导航/标签云同理。
   */
  /**
   * 块级译文候选（译文在原文下一行）：正文类块。
   * 标题（h1~h6）不在此列——标题/标签/按钮等走行内译文，紧跟原文、可自然折行。
   */
  var BLOCK_TAGS = new Set([
    'P', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'LI'
  ]);
  /**
   * 译文注入在元素内部（append）而不是插兄弟节点：
   * 表格单元格、caption 不便于插兄弟。
   */
  var INNER_TAGS = new Set(['TD', 'TH', 'CAPTION']);

  /** 整段子树跳过（不抽取、不算作文本） */
  var SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT',
    'OPTION', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'TEMPLATE', 'OBJECT',
    'EMBED', 'MATH'
  ]);

  /** 文本抽取时视为“段落边界”的标签（用于在拼接文本时补空格，避免粘连） */
  var BLOCK_BOUNDARY_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV',
    'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
    'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
  ]);

  /** 行内译文容器候选：导航项/标签/按钮/链接/元信息行等 */
  var INLINE_CONTAINER_TAGS = new Set([
    'A', 'BUTTON', 'LABEL', 'LI', 'DT', 'DD', 'SPAN', 'STRONG', 'EM', 'B', 'I',
    'SMALL', 'TIME', 'ABBR', 'CITE', 'Q', 'MARK', 'U', 'S', 'P', 'DIV', 'TD',
    'TH', 'FIGCAPTION', 'SUMMARY'
  ]);

  /** 行内文字节点不做翻译的祖先标签（代码/表单/媒体/脚本等） */
  var TEXT_SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA',
    'SELECT', 'OPTION', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME',
    'OBJECT', 'EMBED', 'MATH', 'TITLE'
  ]);

  var HAS_LETTER_RE = /\p{L}/u;

  /* ================================================================ */
  /* i18n                                                              */
  /* ================================================================ */

  var I18N = {
    zh: {
      appName: 'dsh翻译',
      bubbleTitle: 'dsh翻译',
      bubbleLoading: '正在准备翻译…',
      bubbleProgress: '翻译中 {done}/{total}（{percent}%）',
      toggleTitle: 'dsh翻译：左键快速翻译/停止/还原，右键打开面板',
      close: '关闭',
      modeSource: '原文',
      modeBilingual: '双语对照',
      modeOnly: '仅译文',
      targetLanguage: '目标语言',
      model: '模型',
      modelUnknown: '—',
      tokensPage: '本页消耗',
      tokensToday: '今日累计',
      tokensInput: '输入',
      tokensOutput: '输出',
      tokensRequests: '请求数 {count}',
      tokensCache: '缓存命中 {count}',
      tokensUnit: 'tokens',
      statusDoneTokens: '翻译完成 · 本页消耗 {tokens} tokens。',
      cardTokens: '本次查询 输入 {input} · 输出 {output} tokens',
      translate: '翻译此页',
      retranslate: '重新翻译',
      translating: '翻译中…',
      stop: '停止',
      restore: '还原',
      settings: '设置',
      progress: '{done} / {total}',
      privacy: '译文由你在 DSH 中配置的模型生成；页面文本会经本机 DSH 发送给该模型服务，请勿在敏感页面使用。',
      statusIdle: '就绪。点击「翻译此页」，或按 Alt+T。',
      statusChecking: '正在检查 DSH 连接…',
      statusUnreachable: '无法连接 DSH：{msg}',
      statusExtracting: '正在抽取页面段落…',
      statusTranslating: '正在翻译…',
      statusDone: '翻译完成。',
      statusLazyIdle: '当前可见内容已翻译；继续向下滚动会自动翻译更多段落。',
      statusNeedSelection: '请先选中要翻译的文本。',
      statusPartial: '翻译完成，其中 {failed} 段失败，可点击红色占位重试。',
      statusStopped: '已停止，保留已译内容。',
      statusRestored: '已还原页面。',
      statusNavigate: '页面已跳转，请重新点击翻译。',
      statusCapLimit: '页面段落过多，本次只翻译前 {max} 段。',
      statusNoBlocks: '未找到可翻译的段落（可能已是目标语言或无可译文本）。',
      sameLanguageHint: '页面语言（{page}）与目标语言（{target}）一致，未翻译。',
      statusFollowAuto: '跟随翻译：本页已自动翻译',
      shortcutDisabled: '快捷键翻译未启用：请在扩展选项页开启「快捷键翻译」',
      hideBall: '隐藏悬浮球',
      ballHidden: '悬浮球已隐藏；右键菜单「dsh翻译 → 显示悬浮球」可恢复',
      ballShown: '悬浮球已恢复',
      ballDomainHide: '当前域名不展示悬浮球',
      autoSiteEnable: '本站自动翻译',
      autoSiteDisable: '取消本站自动翻译',
      autoSiteEnabled: '已开启本站自动翻译',
      autoSiteDisabled: '已关闭本站自动翻译',
      ballDomainShow: '恢复当前域名悬浮球',
      ballDomainHidden: '已设置当前域名不展示悬浮球；可在 DSH → 设置 → dsh翻译 中管理',
      ballDomainShown: '已恢复当前域名显示悬浮球',
      ballDomainAlreadyHidden: '当前域名已在「不展示悬浮球」列表中；可在 DSH → 设置 → dsh翻译 中管理',
      ballDomainBlocked: '当前域名在「不展示悬浮球」列表中；请到 DSH → 设置 → dsh翻译 中移除',
      sameLanguageStatus: '语言一致：页面已是 {page} 内容，未翻译。',
      statusLangUpdated: '目标语言已更新，重新翻译后生效。',
      statusSettingsFail: '读取 DSH 设置失败：{msg}',
      statusModelOk: '已连接 DSH · {model}',
      statusAuto: '自动翻译已触发…',
      errUnknown: '未知错误',
      errTimeout: '请求超时',
      errEmptyTranslation: '模型返回了空译文',
      errInvalidOutput: '模型输出格式不符合要求',
      failPrefix: '翻译失败：',
      failSuffix: '（点击重试）',
      failInline: '【翻译失败·点击重试】',
      cardTitle: '查词',
      cardLoading: '查询中…',
      cardNoResult: '没有查询结果',
      cardPlay: '朗读',
      cardAdd: '加入单词本',
      cardAdding: '加入中…',
      cardAdded: '已加入',
      cardAddedExisted: '已在单词本',
      cardAddFail: '加入失败：{msg}',
      cardNeedTranslation: '没有译文，暂不能加入单词本',
      cardLookupFail: '查询失败：{msg}',
      cardAddHint: '仅单个英文单词或 1~4 个汉字可加入单词本',
      imageTranslating: '正在识别并翻译图片中的文字…（大图可能需要 20–30 秒，请勿重复点击）',
      imageDone: '图片翻译完成，译文已覆盖在原文字位置',
      imageNoText: '未在图片中识别到文字',
      imageNotFound: '未找到要翻译的图片，请直接右键图片重试',
      imageFailed: '图片翻译失败：{msg}',
      imageClose: '关闭',
      imageBilingual: '双语',
      imageOnly: '仅译文',
      imageCopy: '复制译文',
      imageCopied: '已复制译文',
      imageTitle: '图片翻译',
      imagePartial: '只翻译了图片当前可见的部分'
    },
    en: {
      appName: 'dsh-web-translator',
      bubbleTitle: 'dsh-web-translator',
      bubbleLoading: 'Preparing translation…',
      bubbleProgress: 'Translating {done}/{total} ({percent}%)',
      toggleTitle: 'dsh-web-translator: click to translate, right-click for panel',
      close: 'Close',
      modeSource: 'Original',
      modeBilingual: 'Bilingual',
      modeOnly: 'Translation',
      targetLanguage: 'Target language',
      model: 'Model',
      modelUnknown: '—',
      tokensPage: 'Page usage',
      tokensToday: 'Today',
      tokensInput: 'Input',
      tokensOutput: 'Output',
      tokensRequests: 'Requests: {count}',
      tokensCache: 'Cached: {count}',
      tokensUnit: 'tokens',
      statusDoneTokens: 'Translation complete · {tokens} tokens used on this page.',
      cardTokens: 'This lookup: input {input} · output {output} tokens',
      translate: 'Translate page',
      retranslate: 'Re-translate',
      translating: 'Translating…',
      stop: 'Stop',
      restore: 'Restore',
      settings: 'Settings',
      progress: '{done} / {total}',
      privacy: 'Translations are generated by the model configured in your DSH. Page text is sent through the local DSH to that model service; avoid sensitive pages.',
      statusIdle: 'Ready. Click "Translate page" or press Alt+T.',
      statusChecking: 'Checking DSH connection…',
      statusUnreachable: 'Cannot reach DSH: {msg}',
      statusExtracting: 'Extracting page segments…',
      statusTranslating: 'Translating…',
      statusDone: 'Translation complete.',
      statusLazyIdle: 'Visible content translated. Scroll down to translate more segments.',
      statusNeedSelection: 'Select some text first.',
      statusPartial: 'Translation complete; {failed} segment(s) failed. Click a red placeholder to retry.',
      statusStopped: 'Stopped. Translated content kept.',
      statusRestored: 'Page restored.',
      statusNavigate: 'Page navigated. Click translate again.',
      statusCapLimit: 'Too many segments; only the first {max} will be translated.',
      statusNoBlocks: 'No translatable segments found (already in the target language or no text).',
      sameLanguageHint: 'Page language ({page}) matches the target language ({target}); nothing to translate.',
      statusFollowAuto: 'Follow translation: this page was translated automatically',
      shortcutDisabled: 'Shortcut translation is off. Enable it in extension options.',
      hideBall: 'Hide floating ball',
      ballHidden: 'Floating ball hidden. Right-click → dsh翻译 → Show floating ball to restore.',
      ballShown: 'Floating ball restored.',
      ballDomainHide: 'Hide floating ball on this domain',
      autoSiteEnable: 'Always translate this site',
      autoSiteDisable: 'Stop auto-translating this site',
      autoSiteEnabled: 'Auto-translate enabled for this site',
      autoSiteDisabled: 'Auto-translate disabled for this site',
      ballDomainShow: 'Show floating ball on this domain',
      ballDomainHidden: 'Floating ball hidden on this domain; manage the list in DSH → Settings → dsh翻译.',
      ballDomainShown: 'Floating ball restored on this domain.',
      ballDomainAlreadyHidden: 'This domain is already in the hidden list; manage it in DSH → Settings → dsh翻译.',
      ballDomainBlocked: 'This domain is in the hidden list; remove it in DSH → Settings → dsh翻译.',
      sameLanguageStatus: 'Same language: this page is already in {page}; nothing translated.',
      statusLangUpdated: 'Target language updated; takes effect on next translation.',
      statusSettingsFail: 'Failed to read DSH settings: {msg}',
      statusModelOk: 'Connected to DSH · {model}',
      statusAuto: 'Auto translation started…',
      errUnknown: 'Unknown error',
      errTimeout: 'Request timed out',
      errEmptyTranslation: 'Model returned an empty translation',
      errInvalidOutput: 'Model output format is invalid',
      failPrefix: 'Translation failed: ',
      failSuffix: ' (click to retry)',
      failInline: '[translation failed - click to retry]',
      cardTitle: 'Lookup',
      cardLoading: 'Looking up…',
      cardNoResult: 'No result',
      cardPlay: 'Pronounce',
      cardAdd: 'Add to wordbook',
      cardAdding: 'Adding…',
      cardAdded: 'Added',
      cardAddedExisted: 'Already in wordbook',
      cardAddFail: 'Add failed: {msg}',
      cardNeedTranslation: 'No translation available to save',
      cardLookupFail: 'Lookup failed: {msg}',
      cardAddHint: 'Only a single English word or 1~4 CJK characters can be added',
      imageTranslating: 'Reading and translating the text in this image… (large images may take 20–30s; please do not click again)',
      imageDone: 'Image translated; the translation now covers the original text',
      imageNoText: 'No readable text was found in the image',
      imageNotFound: 'Could not locate the image; right-click the image and try again',
      imageFailed: 'Image translation failed: {msg}',
      imageClose: 'Close',
      imageBilingual: 'Bilingual',
      imageOnly: 'Translation only',
      imageCopy: 'Copy translation',
      imageCopied: 'Translation copied',
      imageTitle: 'Image translation',
      imagePartial: 'Only the visible part of the image was translated'
    }
  };

  /* ================================================================ */
  /* 状态                                                              */
  /* ================================================================ */

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    uiLang: 'zh',
    mode: 'bilingual',
    targetLanguage: 'zh-CN',
    effectiveTarget: 'zh-CN',
    remoteTarget: '',
    modelLabel: '',
    modelFetchedAt: 0,
    running: false,
    starting: false,
    stopFlag: false,
    sessionId: 0,
    /**
     * 轨迹（Turn）：一次用户翻译动作 = 一个 turn（runId），内部批次 = steps（runStep 递增）。
     * 本 run 的懒加载批次共用同一 runId；run 结束（完成/停止/还原/跳转）后清空。
     */
    runId: '',
    runStep: 0,
    units: [],
    /** 视口懒加载：仅翻译当前视口 + 预载一屏，滚动进入视口后继续 */
    lazyActive: false,
    lazy: null,
    io: null,
    blocksByEl: null,
    total: 0,
    done: 0,
    failed: 0,
    injectedNodes: new Set(),
    srcMarked: new Map(),
    pageStyleEl: null,
    host: null,
    shadow: null,
    root: null,
    ui: null,
    panelOpen: false,
    lastDoubleClickAt: 0,
    hiddenBallSites: [],
    cardState: null,
    cardToken: 0,
    /** 轨迹（Turn）：每次打开查词卡 = 一个单步 turn（lk_…），与翻译 run 的 turnId 互不影响 */
    cardTurnId: '',
    statusText: '',
    statusKind: '',
    lastUrl: '',
    urlWatchTimer: null,
    rpcSeq: 0,
    rpcPending: new Map(),
    /**
     * Token 消耗（浮窗展示）：
     *  - page: 本次翻译会话累计（新任务/还原/页面跳转时清零）
     *  - last: 最近一次 translate 响应的 usage（诊断用）
     *  - today: GET /usage 返回的今日日聚合（旧版 Host / 失败时为 null → 隐藏「今日累计」）
     */
    tokenStats: {
      page: { requests: 0, inputTokens: 0, outputTokens: 0, cached: 0 },
      last: null,
      today: null,
      todayFetchedAt: 0
    }
  };
  state.statusText = ''; // 初始化后由 setStatus 设置

  /* ================================================================ */
  /* 小工具                                                            */
  /* ================================================================ */

  function t(key, vars) {
    var dict = I18N[state.uiLang] || I18N.zh;
    var text = dict[key] != null ? dict[key] : I18N.zh[key] != null ? I18N.zh[key] : key;
    if (vars) {
      for (var name in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) {
          text = text.split('{' + name + '}').join(String(vars[name]));
        }
      }
    }
    return text;
  }

  function makeError(code, message) {
    return { code: code || 'UNKNOWN', message: message || t('errUnknown') };
  }

  function errorText(err) {
    if (!err) return t('errUnknown');
    if (typeof err === 'string') return err;
    if (err.code === 'TIMEOUT') return err.message || t('errTimeout');
    return err.message || err.code || t('errUnknown');
  }

  function tagOf(el) {
    try {
      return el && el.tagName ? String(el.tagName).toUpperCase() : '';
    } catch (err) {
      return '';
    }
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return value < min ? min : value > max ? max : value;
  }

  function safe(fn) {
    try {
      var result = fn();
      if (result && typeof result.then === 'function') {
        result.catch(function (err) {
          setStatus(errorText(err), 'error');
        });
      }
      return result;
    } catch (err) {
      setStatus(errorText(err), 'error');
      return null;
    }
  }

  function normalizeText(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    return raw.replace(/\s+/g, ' ').trim();
  }

  /**
   * 发送给模型前的段落文本归一化（可读性优先）：
   * 异常换行/HTML 排版换行/制表/NBSP 统一还原成单空格，让模型看到完整句子。
   */
  function normalizeRequestText(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    return raw
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/[\t\f\v]+/g, ' ')
      .replace(/ *\n */g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  /**
   * 模型返回的译文归一化（可读性优先）：
   * 段落译文不人为断行，异常换行压平成空格，交给浏览器按容器宽度自然换行。
   */
  function normalizeTranslationText(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    return raw
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/[ \t]*\n+[ \t]*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /** 忽略空白/标点/大小写后比较原文与译文，用于跳过“译了等于没译”的重复文本 */
  function normalizeForTranslationCompare(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[\s\u00a0.,;:!?，。；：！？'\"“”‘’()（）\[\]【】<>《》·\-—_\/\\|]+/g, '');
  }

  function isSameTranslation(source, translation) {
    var left = normalizeForTranslationCompare(source);
    var right = normalizeForTranslationCompare(translation);
    return left.length > 0 && left === right;
  }

  /** 把模型返回的译文值统一转成可注入文本 */
  function translationTextOf(value) {
    var raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
    return normalizeTranslationText(raw);
  }

  /** 跟随翻译：向 background 查询/设置当前标签页的跟随状态（session storage，按 tab 隔离） */
  function followAction(action) {
    if (IS_SUBFRAME) return;
    return new Promise(function (resolve) {
      try {
        if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) return resolve(null);
        chrome.runtime.sendMessage({ type: 'dsh-it:follow', action: action }, function (response) {
          try {
            void chrome.runtime.lastError;
          } catch (err) {
            /* ignore */
          }
          resolve(response || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  /** 页面语言检测：<html lang> / content-language / og:locale */
  function normalizeLangCode(raw) {
    if (typeof raw !== 'string') return '';
    var code = raw.trim().toLowerCase().replace(/_/g, '-');
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(code)) return '';
    return code;
  }

  function detectPageLanguage() {
    var candidates = [];
    try {
      candidates.push(document.documentElement && document.documentElement.getAttribute('lang'));
    } catch (err) {
      /* ignore */
    }
    try {
      var metas = document.querySelectorAll('meta[http-equiv],meta[property]');
      for (var i = 0; i < metas.length; i++) {
        var meta = metas[i];
        var key = (meta.getAttribute('http-equiv') || meta.getAttribute('property') || '').toLowerCase();
        if (key === 'content-language' || key === 'og:locale') candidates.push(meta.getAttribute('content'));
      }
    } catch (err) {
      /* ignore */
    }
    for (var j = 0; j < candidates.length; j++) {
      var code = normalizeLangCode(candidates[j]);
      if (code) return code;
    }
    return '';
  }

  /** 页面语言和目标语言是否一致（en 与 en-US 算一致；zh-CN 与 zh-TW 不一致） */
  function isSameLanguage(pageLang, targetLang) {
    var page = normalizeLangCode(pageLang);
    var target = normalizeLangCode(targetLang);
    if (!page || !target) return false;
    var parts = page.split('-');
    var targets = target.split('-');
    if (parts[0] !== targets[0]) return false;
    if (parts[0] !== 'zh') return true;
    var pageRegion = parts[1] || '';
    var targetRegion = targets[1] || '';
    if (pageRegion === 'hans') pageRegion = 'cn';
    if (pageRegion === 'hant') pageRegion = 'tw';
    if (targetRegion === 'hans') targetRegion = 'cn';
    if (targetRegion === 'hant') targetRegion = 'tw';
    if (!pageRegion || !targetRegion) return true;
    return pageRegion === targetRegion;
  }

  function findSameLanguageContext() {
    var target = state.effectiveTarget || state.settings.targetLanguage || '';
    if (!target) return null;
    var page = detectPageLanguage();
    if (!page || !isSameLanguage(page, target)) return null;
    var info = findLanguage(target);
    return { page: page, target: (info && info.native) || target };
  }

  function findLanguage(code) {
    for (var i = 0; i < LANGUAGES.length; i++) {
      if (LANGUAGES[i].code === code) return LANGUAGES[i];
    }
    return null;
  }

  /* ================================================================ */
  /* chrome.storage（只读写扩展设置，不写页面内容）                      */
  /* ================================================================ */

  function storageGet(keys) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (value) {
        if (done) return;
        done = true;
        resolve(value && typeof value === 'object' ? value : {});
      };
      var timer = setTimeout(function () {
        finish({});
      }, 1500);
      try {
        chrome.storage.local.get(keys, function (items) {
          clearTimeout(timer);
          finish(items);
        });
      } catch (err) {
        clearTimeout(timer);
        finish({});
      }
    });
  }

  function storageSet(patch) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (value) {
        if (done) return;
        done = true;
        resolve(value);
      };
      var timer = setTimeout(function () {
        finish(false);
      }, 2000);
      try {
        chrome.storage.local.set(patch, function () {
          clearTimeout(timer);
          finish(true);
        });
      } catch (err) {
        clearTimeout(timer);
        finish(false);
      }
    });
  }

  function normalizeSettings(raw) {
    var result = Object.assign({}, DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object') return result;
    if (typeof raw.dshBaseUrl === 'string' && raw.dshBaseUrl.trim()) {
      result.dshBaseUrl = raw.dshBaseUrl.trim();
    }
    if (typeof raw.targetLanguage === 'string' && findLanguage(raw.targetLanguage)) {
      result.targetLanguage = raw.targetLanguage;
    }
    if (MODES.indexOf(raw.mode) !== -1) result.mode = raw.mode;
    if (raw.scheduleMode === 'screen' || raw.scheduleMode === 'block') result.scheduleMode = raw.scheduleMode;
    if (raw.preload === 'none' || raw.preload === 'half' || raw.preload === 'one') result.preload = raw.preload;
    if (typeof raw.autoTranslate === 'boolean') result.autoTranslate = raw.autoTranslate;
    if (Array.isArray(raw.autoTranslateSites)) result.autoTranslateSites = normalizeSiteList(raw.autoTranslateSites);
    if (typeof raw.selectionTranslate === 'boolean') result.selectionTranslate = raw.selectionTranslate;
    if (typeof raw.doubleClickTranslate === 'boolean') result.doubleClickTranslate = raw.doubleClickTranslate;
    if (typeof raw.shortcutTranslate === 'boolean') result.shortcutTranslate = raw.shortcutTranslate;
    if (typeof raw.hideBallSameLanguage === 'boolean') result.hideBallSameLanguage = raw.hideBallSameLanguage;
    if (typeof raw.translateIframes === 'boolean') result.translateIframes = raw.translateIframes;
    if (typeof raw.imageFastMode === 'boolean') result.imageFastMode = raw.imageFastMode;
    if (typeof raw.followTranslation === 'boolean') result.followTranslation = raw.followTranslation;
    if (typeof raw.showFloatingBall === 'boolean') result.showFloatingBall = raw.showFloatingBall;
    if (raw.ballPosition && typeof raw.ballPosition === 'object') {
      var right = Number(raw.ballPosition.right);
      var bottom = Number(raw.ballPosition.bottom);
      if (isFinite(right) && isFinite(bottom)) result.ballPosition = { right: right, bottom: bottom };
    }
    if (raw.uiLang === 'zh' || raw.uiLang === 'en') result.uiLang = raw.uiLang;
    return result;
  }

  function applyStoredSettings(raw) {
    state.settings = normalizeSettings(raw);
    state.uiLang = state.settings.uiLang;
    state.mode = state.settings.mode;
    state.targetLanguage = state.settings.targetLanguage;
    state.effectiveTarget = state.targetLanguage || state.remoteTarget || 'zh-CN';
  }

  /* ================================================================ */
  /* RPC（唯一网络路径：content -> background -> DSH）                  */
  /* ================================================================ */

  function rpc(method, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'dsh' + Date.now().toString(36) + '_' + (++state.rpcSeq);
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        state.rpcPending.delete(id);
        reject(makeError('TIMEOUT', t('errTimeout')));
      }, RPC_TIMEOUT_MS);
      var entry = {
        resolve: resolve,
        reject: reject,
        timer: timer
      };
      state.rpcPending.set(id, entry);

      var finish = function (fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.rpcPending.delete(id);
        fn(value);
      };

      try {
        chrome.runtime.sendMessage(
          { type: 'dsh-it:rpc', id: id, method: method, payload: payload || {} },
          function (response) {
            var lastError = null;
            try {
              lastError = chrome.runtime.lastError;
            } catch (err) {
              lastError = null;
            }
            if (lastError) {
              finish(reject, makeError('EXTENSION_UNAVAILABLE', '扩展后台不可用，请刷新页面后重试'));
              return;
            }
            if (!response || response.type !== 'dsh-it:result' || response.id !== id) {
              finish(reject, makeError('EMPTY_RESPONSE', '扩展后台回包异常，请刷新页面后重试'));
              return;
            }
            if (response.ok !== true) {
              var apiError = response.error ? response.error : null;
              finish(
                reject,
                makeError(
                  apiError && apiError.code ? apiError.code : 'EMPTY_RESPONSE',
                  apiError && apiError.message ? apiError.message : '扩展后台未返回结果'
                )
              );
              return;
            }
            finish(resolve, response.data);
          }
        );
      } catch (err) {
        finish(reject, makeError('EXTENSION_UNAVAILABLE', '扩展后台不可用，请刷新页面后重试'));
      }
    });
  }

  /* ================================================================ */
  /* 语言/脚本判定（跳过已是目标语言的段落）                             */
  /* ================================================================ */

  function langBase(lang) {
    var value = String(lang || '').toLowerCase();
    var dash = value.indexOf('-');
    return dash > 0 ? value.slice(0, dash) : value;
  }

  function countScripts(text) {
    var counts = { han: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, latin: 0, other: 0 };
    for (var i = 0; i < text.length; i++) {
      var cp = text.codePointAt(i);
      if (cp > 0xffff) i++;
      if (
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0x20000 && cp <= 0x2fa1f)
      ) {
        counts.han++;
      } else if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) {
        counts.kana++;
      } else if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) {
        counts.hangul++;
      } else if (cp >= 0x0400 && cp <= 0x04ff) {
        counts.cyrillic++;
      } else if (cp >= 0x0600 && cp <= 0x06ff) {
        counts.arabic++;
      } else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x00c0 && cp <= 0x024f)) {
        counts.latin++;
      } else if (!/\s/.test(String.fromCodePoint(cp))) {
        counts.other++;
      }
    }
    counts.total =
      counts.han + counts.kana + counts.hangul + counts.cyrillic + counts.arabic + counts.latin + counts.other;
    return counts;
  }

  function looksLikeTargetLanguage(text, lang) {
    if (!text) return false;
    var base = langBase(lang);
    var counts = countScripts(text);
    if (!counts.total) return false;
    if (base === 'zh') return counts.han / counts.total > 0.55;
    if (base === 'en') {
      var nonLatin = counts.han + counts.kana + counts.hangul + counts.cyrillic + counts.arabic;
      return nonLatin === 0 && counts.latin / counts.total > 0.7;
    }
    if (base === 'ja') return counts.kana / counts.total > 0.1;
    if (base === 'ko') return counts.hangul / counts.total > 0.5;
    if (base === 'ru') return counts.cyrillic / counts.total > 0.7;
    if (base === 'ar') return counts.arabic / counts.total > 0.6;
    return false; // fr/de/es/pt/it 无法可靠区分，按“都翻译”处理
  }

  /* ================================================================ */
  /* 段落抽取                                                          */
  /* ================================================================ */

  /** 取元素内“可见正文”，跳过脚本/代码/表单/插件节点与已注入节点 */
  function textOf(el) {
    try {
      var parts = [];
      var walker = document.createTreeWalker(
        el,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            try {
              if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
              var tag = tagOf(node);
              // 行内 <code> 是正文的一部分（如文件名/命令 token），必须参与翻译；
              // 整块代码仍在 <pre> 里，由上面的 PRE 规则整棵跳过。
              if (tag && SKIP_TAGS.has(tag) && tag !== 'CODE') return NodeFilter.FILTER_REJECT;
              if (node === state.host || node.id === HOST_ID) return NodeFilter.FILTER_REJECT;
              if (node.hasAttribute && node.hasAttribute(MARK_ATTR)) return NodeFilter.FILTER_REJECT;
              if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
              // 折叠 <details> 的内容不参与文本抽取（可见文字只在展开后翻译）
              try {
                var closedDetails = node.closest ? node.closest('details') : null;
                if (closedDetails && !closedDetails.open && !(node.closest && node.closest('summary'))) {
                  return NodeFilter.FILTER_REJECT;
                }
              } catch (detailsErr) {
                /* ignore */
              }
              // 隐藏节点整棵子树不参与文本抽取（避免把折叠菜单/隐藏链接的文字翻出来）
              try {
                var view = node.ownerDocument && node.ownerDocument.defaultView;
                if (view) {
                  var style = view.getComputedStyle(node);
                  if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
                }
                if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
                  return NodeFilter.FILTER_REJECT;
                }
              } catch (styleErr) {
                /* 取不到 computed style 时继续 */
              }
              return NodeFilter.FILTER_ACCEPT;
            } catch (err) {
              return NodeFilter.FILTER_SKIP;
            }
          }
        },
        false
      );
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === 3) {
          parts.push(node.nodeValue || '');
          continue;
        }
        var tag = tagOf(node);
        // 段落内 <br> 属于排版换行：转空格，让模型看到完整句子（可读性优先）
        if (tag === 'BR' || tag === 'WBR') {
          parts.push(' ');
          continue;
        }
        // 块级子元素边界补空格，避免跨块文字粘连
        if (tag && BLOCK_BOUNDARY_TAGS.has(tag)) parts.push(' ');
      }
      return normalizeText(parts.join(''));
    } catch (err) {
      return '';
    }
  }

  /**
   * 支持超链接的块级正文抽取：把块内 <a> 的文字替换成 [[n]]...[[/n]] 标记，
   * 同时返回每个标记对应的 URL/样式。译后按标记把文字还原为 <a>，避免块级
   * 翻译把原文超链接拍平成一整段纯文本。
   * @param {Element} el - block element.
   * @returns {{text: string, links: object[]}}
   */
  function textOfWithLinks(el) {
    var links = [];
    var parts = [];
    var safeHref = function (anchor) {
      try {
        var href = String(anchor.href || '');
        if (!/^https?:|^mailto:|^tel:/i.test(href)) return '';
        return href;
      } catch (err) {
        return '';
      }
    };
    var walk = function (node) {
      try {
        if (!node) return;
        if (node.nodeType === 3) {
          parts.push(node.nodeValue || '');
          return;
        }
        if (node.nodeType !== 1) return;
        var tag = tagOf(node);
        if (!tag || (SKIP_TAGS.has(tag) && tag !== 'CODE')) return;
        if (node === state.host || node.id === HOST_ID || node.id === IMAGE_OVERLAY_ID) return;
        if (node.hasAttribute && node.hasAttribute(MARK_ATTR)) return;
        if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
        try {
          var closedDetails = node.closest ? node.closest('details') : null;
          if (closedDetails && !closedDetails.open && !(node.closest && node.closest('summary'))) return;
          var view = node.ownerDocument && node.ownerDocument.defaultView;
          if (view) {
            var style = view.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return;
          }
          if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return;
        } catch (styleErr) {
          /* 取不到可见性时继续 */
        }
        if (tag === 'BR' || tag === 'WBR') {
          parts.push(' ');
          return;
        }
        if (tag === 'CODE') {
          var codeText = normalizeText(node.textContent || '');
          if (codeText.length > 0) {
            var codeIndex = links.length + 1;
            var codeToken = { kind: 'code', text: codeText };
            try {
              var codeStyle = window.getComputedStyle(node);
              var codeStyleSnapshot = {};
              ['font-family', 'font-size', 'font-weight', 'line-height', 'background-color', 'color', 'padding', 'border', 'border-radius'].forEach(function (prop) {
                var value = codeStyle.getPropertyValue(prop);
                if (value) codeStyleSnapshot[prop] = value;
              });
              codeToken.style = codeStyleSnapshot;
            } catch (codeStyleErr) {
              /* ignore */
            }
            var codeClass = node.getAttribute ? node.getAttribute('class') : '';
            if (codeClass) codeToken.className = codeClass;
            links.push(codeToken);
            parts.push('[[' + codeIndex + ']]' + codeText + '[[/' + codeIndex + ']]');
            return;
          }
        }
        if (tag === 'A') {
          var href = safeHref(node);
          var linkText = normalizeText(node.textContent || '');
          if (href && linkText.length > 0) {
            var index = links.length + 1;
            var link = { kind: 'a', href: href, text: linkText };
            try {
              var computed = window.getComputedStyle(node);
              if (computed.color) link.color = computed.color;
              if (computed.textDecorationLine) link.textDecoration = computed.textDecorationLine;
            } catch (styleReadErr) {
              /* ignore */
            }
            var target = node.getAttribute ? node.getAttribute('target') : '';
            if (target) link.target = target;
            var rel = node.getAttribute ? node.getAttribute('rel') : '';
            if (rel) link.rel = rel;
            var title = node.getAttribute ? node.getAttribute('title') : '';
            if (title) link.title = title;
            links.push(link);
            parts.push('[[' + index + ']]' + linkText + '[[/' + index + ']]');
            return;
          }
        }
        if (BLOCK_BOUNDARY_TAGS.has(tag)) parts.push(' ');
        var children = node.childNodes || [];
        for (var ci = 0; ci < children.length; ci += 1) walk(children[ci]);
      } catch (err) {
        /* 单个节点异常不影响整体抽取 */
      }
    };
    walk(el);
    return { text: normalizeText(parts.join('')), links: links };
  }

  function isVisible(el) {
    try {
      if (!el || !el.isConnected) return false;
      if (el.hasAttribute('hidden')) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      }
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    } catch (err) {
      return false;
    }
  }

  function isEditableOrHidden(el) {
    try {
      if (el.isContentEditable) return true;
      if (el.closest && el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
      if (el.closest && el.closest('[aria-hidden="true"]')) return true;
      if (el.closest && el.closest('#' + HOST_ID)) return true;
      if (el.closest && el.closest('#' + IMAGE_OVERLAY_ID)) return true;
    } catch (err) {
      return true;
    }
    return false;
  }

  /**
   * 站点 chrome（导航/页眉/页脚/侧栏）内部不做“块级注入”，避免组件级块复制；
   * 但它们的文字节点会走行内注入（collectTextUnits），所以文案仍会被翻译。
   */
  function isChromeRegion(el) {
    try {
      if (el.closest && el.closest('nav, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"], [role="toolbar"], footer, aside')) return true;
      var header = el.closest ? el.closest('header') : null;
      if (header && !(header.closest && header.closest('article, main, [role="main"]'))) return true;
    } catch (err) {
      return true;
    }
    return false;
  }

  /**
   * 抽取候选块：
   *  - 块级标签（文本 2..800）+ 行内 DIV/SPAN（文本 12..800）
   *  - 文本归一化后 2..800，必须是自然语言（含字母/汉字）
   *  - 跳过脚本/代码/表单/隐藏/contenteditable/aria-hidden/插件节点
   *  - 已是目标语言跳过
   *  - 祖先也是候选时保留最内层（块内嵌套块取最内块；行内候选有块级祖先则丢弃）
   *  - 单页上限 800 段
   */
  function scanAgain() {
    var root = document.body || document.documentElement;
    var empty = { blocks: [], texts: [], truncated: false };
    if (!root) return empty;

    var found = [];
    var byEl = new Map();
    var target = state.effectiveTarget || 'zh-CN';

    var walker;
    try {
      walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: function (node) {
            try {
              var tag = tagOf(node);
              if (!tag) return NodeFilter.FILTER_SKIP;
              if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
              if (node.id === HOST_ID) return NodeFilter.FILTER_REJECT;
              if (node.hasAttribute && node.hasAttribute(MARK_ATTR)) return NodeFilter.FILTER_REJECT;
              if (BLOCK_TAGS.has(tag) || tag === 'DIV') return NodeFilter.FILTER_ACCEPT;
            } catch (err) {
              return NodeFilter.FILTER_SKIP;
            }
            return NodeFilter.FILTER_SKIP;
          }
        },
        false
      );
    } catch (err) {
      return empty;
    }

    var consider = function (el) {
      var tag = tagOf(el);
      var isDiv = tag === 'DIV';
      var isListItem = tag === 'LI';
      var isBlock = BLOCK_TAGS.has(tag) || isDiv;
      if (!isBlock) return;
      var innerTag = INNER_TAGS.has(tag) || isListItem;
      /**
       * 登记“跳过占位”：本身不翻译，但让祖先块在嵌套去重时被排除。
       * 否则被跳过的 chrome/行内组件外层包裹（如 wiki 布局列）会被当成叶子块翻译。
       */
      var registerPlaceholder = function () {
        var placeholder = {
          el: el,
          anchorEl: el,
          text: '',
          tag: tag,
          type: 'block',
          kind: 'block',
          inner: innerTag,
          drop: true,
          placeholderOnly: true,
          index: found.length,
          transNode: null,
          placeholder: null
        };
        found.push(placeholder);
        byEl.set(el, placeholder);
      };

      if (isEditableOrHidden(el) || isChromeRegion(el)) {
        registerPlaceholder();
        return;
      }

      // 结构化表格单元格：内部还有 dl/ul/ol/p/div/table 等块级结构时，整格合并翻译
      // 会把目录/多段落压成一大段（go.dev/doc/asm 的 TOC），交给内部元素各自翻译。
      if (innerTag) {
        try {
          var structural = el.querySelectorAll(
            'dl,ul,ol,p,div,table,figure,blockquote,section,article,nav,header,footer'
          );
          for (var si = 0; si < structural.length; si++) {
            var structuralEl = structural[si];
            if (!structuralEl || structuralEl === el) continue;
            var structuralTag = tagOf(structuralEl);
            if (!structuralTag || SKIP_TAGS.has(structuralTag)) continue;
            if (isEditableOrHidden(structuralEl)) continue;
            if (normalizeText(structuralEl.textContent || '').length < MIN_TEXT) continue;
            var structuralDisplay = '';
            try {
              structuralDisplay = window.getComputedStyle(structuralEl).display || '';
            } catch (displayErr) {
              structuralDisplay = '';
            }
            if (structuralDisplay.indexOf('inline') === 0) continue;
            registerPlaceholder();
            return;
          }
        } catch (structuralScanErr) {
          /* 结构探测失败时退回整格翻译 */
        }
      }

      // DIV 只在“纯文本容器 + 正常字号”时才做块级翻译；小字号 meta 行交给行内文字节点
      if (isDiv) {
        try {
          var divFontSize = parseFloat(window.getComputedStyle(el).fontSize) || 16;
          // 小字号 meta 行 & 大字号展示型标题都交给行内译文（紧跟原文、可折行）
          if (divFontSize < 16 || divFontSize >= 20) {
            registerPlaceholder();
            return;
          }
          var children = el.children || [];
          for (var ci = 0; ci < children.length; ci++) {
            var childTag = tagOf(children[ci]);
            if (!childTag) continue;
            if (SKIP_TAGS.has(childTag)) continue;
            var childDisplay = window.getComputedStyle(children[ci]).display || '';
            if (childDisplay.indexOf('inline') !== 0) {
              registerPlaceholder();
              return;
            }
          }
        } catch (err) {
          registerPlaceholder();
          return;
        }
      }

      if (isListItem) {
        // 含嵌套列表/段落等结构的 li：整项合并会把子项文字拼进来，交给内部元素处理
        try {
          var listNested = el.querySelectorAll(
            'ul,ol,dl,table,p,div,blockquote,figure,pre,section,article'
          );
          for (var li = 0; li < listNested.length; li++) {
            var nestedEl = listNested[li];
            if (!nestedEl || nestedEl === el) continue;
            var nestedTag = tagOf(nestedEl);
            if (!nestedTag || SKIP_TAGS.has(nestedTag)) continue;
            if (isEditableOrHidden(nestedEl)) continue;
            if (normalizeText(nestedEl.textContent || '').length < MIN_TEXT) continue;
            var nestedDisplay = '';
            try {
              nestedDisplay = window.getComputedStyle(nestedEl).display || '';
            } catch (nestedDisplayErr) {
              nestedDisplay = '';
            }
            if (nestedDisplay.indexOf('inline') === 0) continue;
            registerPlaceholder();
            return;
          }
        } catch (listNestedErr) {
          /* 结构探测失败时继续按整项处理 */
        }
        // 标签云/短标签等短 li 继续走行内译文，避免把紧凑列表变成多行
        if (normalizeText(el.textContent || '').length < 24) {
          registerPlaceholder();
          return;
        }
      }

      var rawLength = el.textContent ? el.textContent.length : 0;
      if (rawLength < MIN_TEXT) {
        registerPlaceholder();
        return;
      }

      var linkScan = el.querySelector && el.querySelector('a, code') ? textOfWithLinks(el) : null;
      var text = linkScan ? linkScan.text : textOf(el);
      var links = linkScan ? linkScan.links : [];
      var minLength = isDiv ? 60 : MIN_TEXT;
      if (isDiv && longestTextRun(el) < 40) {
        registerPlaceholder();
        return;
      }
      if (text.length < minLength || text.length > MAX_TEXT) {
        registerPlaceholder();
        return;
      }
      if (!HAS_LETTER_RE.test(text)) {
        registerPlaceholder();
        return;
      }
      if (looksLikeTargetLanguage(text, target)) {
        registerPlaceholder();
        return;
      }
      if (!isVisible(el)) {
        registerPlaceholder();
        return;
      }

      // —— 布局安全过滤 ——
      var isHeading = /^H[1-6]$/.test(tag);
      var display = '';
      try {
        display = window.getComputedStyle(el).display || '';
      } catch (err) {
        display = '';
      }
      // 自身是 flex/grid 容器：追加译文会新增/挤压 flex/grid 子项
      if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) {
        registerPlaceholder();
        return;
      }
      // 非标题的 inline/inline-block 组件：插块级兄弟会破坏行内布局（交给行内文字节点）
      if (!isHeading && display.indexOf('inline') === 0) {
        registerPlaceholder();
        return;
      }
      // 父级是 grid：译文作为新的 grid item 插入（相当于普通流里的「下一行」），
      // 并复制原文的 grid-column，避免落到错误的列。
      // 父级是 flex：新兄弟会变成横向 flex item，改为把译文 append 到原文内部。
      var parentEl = el.parentElement;
      var gridParent = false;
      var flexInner = false;
      if (parentEl) {
        var parentDisplay = '';
        try {
          parentDisplay = window.getComputedStyle(parentEl).display || '';
        } catch (err) {
          parentDisplay = '';
        }
        if (parentDisplay.indexOf('grid') !== -1 && !INNER_TAGS.has(tag) && tag !== 'LI') {
          gridParent = true;
        } else if (parentDisplay.indexOf('flex') !== -1 && !INNER_TAGS.has(tag) && tag !== 'LI') {
          flexInner = true;
        }
      }

      var entry = {
        el: el,
        anchorEl: el,
        text: text,
        tag: tag,
        type: 'block',
        kind: 'block',
        inner: innerTag || flexInner,
        gridParent: gridParent,
        flexInner: flexInner,
        drop: false,
        links: links,
        index: found.length,
        transNode: null,
        placeholder: null
      };
      found.push(entry);
      byEl.set(el, entry);
    };

    try {
      var node = walker.nextNode();
      var guard = 0;
      while (node) {
        guard++;
        if (guard > 80000) break; // 防御极端 DOM
        try {
          consider(node);
        } catch (err) {
          /* 单个节点异常不影响整体抽取 */
        }
        node = walker.nextNode();
      }
    } catch (err) {
      /* 遍历异常：使用已收集部分 */
    }

    // 嵌套去重：祖先也是候选时保留最内层
    for (var i = 0; i < found.length; i++) {
      var entry = found[i];
      var parent = entry.el.parentElement;
      var steps = 0;
      while (parent && steps < 300) {
        steps++;
        var ancestor = byEl.get(parent);
        if (ancestor) {
          if (entry.type === 'block') {
            ancestor.drop = true;
          } else if (ancestor.type === 'block') {
            entry.drop = true;
            break;
          } else {
            ancestor.drop = true;
          }
        }
        parent = parent.parentElement;
      }
    }

    var result = [];
    for (var j = 0; j < found.length; j++) {
      if (!found[j].drop && !found[j].placeholderOnly) result.push(found[j]);
    }
    var truncated = false;
    if (result.length > MAX_BLOCKS) {
      truncated = true;
      result = result.slice(0, MAX_BLOCKS);
    }
    for (var k = 0; k < result.length; k++) result[k].index = k;

    // 行内文案：导航/标签云/页脚/侧栏/按钮/链接等未被块级候选覆盖的文字节点
    var selected = new Set();
    for (var s = 0; s < result.length; s++) selected.add(result[s].el);
    var texts = collectTextUnits(root, selected, target, result.length);
    return { blocks: result, texts: texts, truncated: truncated };
  }

  /** 元素内最长的一段文字节点长度（用于区分“段落文本容器”与“标签/元信息行”） */
  function longestTextRun(el) {
    var max = 0;
    try {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      var node = walker.nextNode();
      var guard = 0;
      while (node && guard < 2000) {
        guard++;
        var text = normalizeText(node.nodeValue || '');
        if (text.length > max) max = text.length;
        node = walker.nextNode();
      }
    } catch (err) {
      /* ignore */
    }
    return max;
  }

  /** 折叠的 <details> 内容不翻译（用户展开后再由重新翻译覆盖） */
  function isInClosedDetails(el) {
    try {
      var details = el.closest ? el.closest('details') : null;
      if (!details) return false;
      if (details.open) return false;
      if (el.closest && el.closest('summary')) return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 判断元素是否落在不翻译的文字区域内（代码/表单/媒体/脚本等祖先） */
  function isInSkipTextTag(el) {
    var steps = 0;
    var current = el;
    while (current && steps < 40) {
      var tag = tagOf(current);
      if (tag && TEXT_SKIP_TAGS.has(tag)) return true;
      current = current.parentElement;
      steps++;
    }
    return false;
  }

  /** 元素是否位于已选中的块级译文单元内部（这些文字由块级译文覆盖，避免重复翻译） */
  function isInsideSelectedBlock(el, selected) {
    var steps = 0;
    var current = el;
    while (current && steps < 60) {
      if (selected.has(current)) return true;
      current = current.parentElement;
      steps++;
    }
    return false;
  }

  /**
   * 收集行内译文单元（按“文字节点父元素”分组）：
   * - 每个单元对应一个 label/link/button/li 等元素，译文直接放进该元素内部；
   * - 因此译文自然继承该元素的字体、字号、颜色、背景（如标签 pill、按钮、导航链接）；
   * - 不新增块级兄弟/列表项，不影响原站布局。
   */
  function collectTextUnits(root, selected, target, startIndex) {
    var units = [];
    var byParent = new Map();
    var walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    } catch (err) {
      return units;
    }
    var node = walker.nextNode();
    var guard = 0;
    while (node && units.length < MAX_TEXT_UNITS && guard < 80000) {
      guard++;
      try {
        var parent = node.parentElement;
        var text = normalizeText(node.nodeValue || '');
        if (parent && text.length >= 1 && HAS_LETTER_RE.test(text)) {
          if (
            !isEditableOrHidden(parent) &&
            !isInSkipTextTag(parent) &&
            !isInClosedDetails(parent) &&
            !isInsideSelectedBlock(parent, selected) &&
            !looksLikeTargetLanguage(text, target) &&
            isVisible(parent)
          ) {
            var group = byParent.get(parent);
            if (!group) {
              group = { el: parent, nodes: [], parts: [], text: '' };
              byParent.set(parent, group);
            }
            group.nodes.push(node);
            group.parts.push(text);
          }
        }
      } catch (err) {
        /* 单个文字节点异常不影响整体 */
      }
      node = walker.nextNode();
    }
    var index = startIndex;
    byParent.forEach(function (group) {
      if (units.length >= MAX_TEXT_UNITS) return;
      var combined = normalizeText(group.parts.join(' '));
      if (combined.length < 1 || combined.length > MAX_INLINE_TEXT) return;
      if (!HAS_LETTER_RE.test(combined)) return;
      units.push({
        el: group.el,
        anchorEl: group.el,
        nodes: group.nodes,
        text: combined,
        tag: tagOf(group.el),
        type: 'inline',
        kind: 'inline',
        inner: true,
        drop: false,
        index: index++,
        status: 'pending',
        transNode: null,
        srcWrap: null,
        srcWraps: null,
        placeholder: null
      });
    });
    return units;
  }

  /* ================================================================ */
  /* 注入译文 / 失败占位 / 标记原文                                     */
  /* ================================================================ */

  /**
   * 从原文元素复制排版属性，使译文与原文“同字号、同字重、同字体、同颜色、
   * 同行高、同对齐”。仅复制排版类属性，不复制 display/尺寸/背景等布局属性。
   */
  var TYPO_PROPS = [
    'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'line-height', 'letter-spacing', 'word-spacing', 'text-transform',
    'color', 'text-align'
  ];

  /** 复制到译文的行内排版属性（保证“看起来和原文一样”）
   *  color 不复制：译文 span 作为宿主子元素自然继承 color，
   *  这样站点异步换主题（如 OneTrust 深色按钮）时译文颜色会跟随，不会白字/黑字错配。
   */
  var INLINE_STYLE_PROPS = TYPO_PROPS.filter(function (prop) {
    return prop !== 'color';
  }).concat([
    'background-color', 'border-radius', 'text-decoration-color', 'text-shadow'
  ]);

  /** 把原文元素的 computed 样式复制到译文节点（可选属性子集） */
  function copyComputedStyle(source, node, props) {
    if (!source || !node) return;
    try {
      var computed = window.getComputedStyle(source);
      for (var i = 0; i < props.length; i++) {
        var value = computed.getPropertyValue(props[i]);
        if (value && value !== 'none' && value !== 'normal' && value !== 'auto') {
          node.style.setProperty(props[i], value);
        }
      }
    } catch (err) {
      /* 取不到 computed style 时使用继承样式兜底 */
    }
  }

  /** 标题/大字号短文本允许译文并排的最大原文长度（字符） */
  var INLINE_LAYOUT_MAX_TEXT = 80;
  /** 视为“标题类”大字号的下限（px） */
  var INLINE_LAYOUT_MAX_FONT_PX = 20;
  /** 译文过长时放弃并排、回退到原文下方（字符） */
  var INLINE_LAYOUT_MAX_TRANSLATION = 120;

  /** 正文（译文在原文下方） */
  var TRANS_STYLE_BLOCK =
    'display:block;' +
    'margin:0.25em 0 0 0;' +
    'padding:0;' +
    'border:0;' +
    'background:none;' +
    'white-space:pre-wrap;' +
    'word-break:break-word;' +
    'overflow-wrap:anywhere;' +
    'text-indent:0;' +
    'direction:inherit;' +
    'unicode-bidi:plaintext;';

  /** 标题/大字号：译文与原文并排在同一行（右侧），排版与原文一致 */
  var TRANS_STYLE_INLINE =
    'display:inline-block;' +
    'vertical-align:baseline;' +
    'margin:0 0 0 0.75em;' +
    'max-width:100%;' +
    'padding:0;' +
    'border:0;' +
    'background:none;' +
    'white-space:pre-wrap;' +
    'word-break:break-word;' +
    'overflow-wrap:anywhere;' +
    'text-indent:0;' +
    'direction:inherit;' +
    'unicode-bidi:plaintext;';

  var RETRY_STYLE =
    'display:block;' +
    'font:inherit;' +
    'line-height:1.5;' +
    'color:#b91c1c;' +
    'background:rgba(220,38,38,0.08);' +
    'border:1px dashed rgba(220,38,38,0.55);' +
    'border-radius:6px;' +
    'padding:4px 8px;' +
    'margin:0.35em 0 0 0;' +
    'cursor:pointer;' +
    'white-space:pre-wrap;' +
    'word-break:break-word;' +
    'overflow-wrap:anywhere;' +
    'text-indent:0;';

  function copySafeAttributes(source, target) {
    try {
      var className = source.getAttribute('class');
      if (className) target.setAttribute('class', className);
    } catch (err) {
      /* ignore */
    }
  }

  /** 复制原文的排版属性到译文节点，保证双语对照时两者样式一致 */
  function copyTypography(source, node) {
    if (!source || !node) return;
    try {
      var computed = window.getComputedStyle(source);
      for (var i = 0; i < TYPO_PROPS.length; i++) {
        var value = computed.getPropertyValue(TYPO_PROPS[i]);
        if (value) node.style.setProperty(TYPO_PROPS[i], value);
      }
    } catch (err) {
      /* 取不到 computed style 时使用继承样式兜底 */
    }
  }

  /**
   * 原文块若由「窄容器 + 左右 auto margin」实现水平居中（如居中诗歌/窄段落），
   * 译文块也要保持同样的居中盒子；否则只复制 text-align 会让译文盒靠左。
   */
  function copyHorizontalAlignment(source, node) {
    if (!source || !node) return;
    try {
      var style = window.getComputedStyle(source);
      var parent = source.parentElement;
      if (!parent) return;
      var rect = source.getBoundingClientRect();
      var parentRect = parent.getBoundingClientRect();
      var parentStyle = window.getComputedStyle(parent);
      var padLeft = parseFloat(parentStyle.paddingLeft) || 0;
      var padRight = parseFloat(parentStyle.paddingRight) || 0;
      var contentLeft = parentRect.left + padLeft;
      var contentRight = parentRect.right - padRight;
      var contentWidth = contentRight - contentLeft;
      if (contentWidth <= 0 || rect.width <= 0) return;
      var narrower = rect.width <= contentWidth - 2;
      var leftGap = rect.left - contentLeft;
      var rightGap = contentRight - rect.right;
      var centered = narrower && leftGap > 2 && Math.abs(leftGap - rightGap) <= Math.max(2, contentWidth * 0.02);
      if (!centered) return;
      node.style.setProperty('margin-left', 'auto', 'important');
      node.style.setProperty('margin-right', 'auto', 'important');
      var maxWidth = style.maxWidth;
      if (maxWidth && maxWidth !== 'none') node.style.setProperty('max-width', maxWidth);
      var width = style.width;
      if (width && width !== 'auto' && parseFloat(width) > 0) node.style.setProperty('width', width);
    } catch (err) {
      /* 判定失败时保持默认布局 */
    }
  }

  /** 判断该块是否适合“原文 + 译文”并排（标题类、大字号、短文本） */
  function decideTransLayout(block) {
    if (!block || block.inner) return 'below';
    try {
      // 父级是 flex/grid 时并排会打乱原有排布，保守回退到下方
      var parent = block.el.parentElement;
      if (parent) {
        var parentDisplay = window.getComputedStyle(parent).display || '';
        if (parentDisplay.indexOf('flex') !== -1 || parentDisplay.indexOf('grid') !== -1) return 'below';
      }
      if (/^H[1-6]$/.test(block.tag) && block.text.length <= INLINE_LAYOUT_MAX_TEXT) {
        return 'inline';
      }
      if (block.text.length > INLINE_LAYOUT_MAX_TEXT) return 'below';
      var size = parseFloat(window.getComputedStyle(block.el).fontSize) || 0;
      if (size >= INLINE_LAYOUT_MAX_FONT_PX) return 'inline';
    } catch (err) {
      /* 判定失败时回退到下方布局 */
    }
    return 'below';
  }

  /** 结合译文长度最终确定布局（译文过长则放弃并排） */
  function resolveTransLayout(block, translation) {
    var layout = decideTransLayout(block);
    if (layout === 'inline' && translation && translation.length > INLINE_LAYOUT_MAX_TRANSLATION) {
      return 'below';
    }
    return layout;
  }

  /** 标记原文块的布局（仅并排时需要，供页面级 CSS 使用；还原时移除） */
  function markSourceLayout(el, layout) {
    try {
      if (!el || !el.isConnected) return;
      if (layout === 'inline') el.setAttribute(LAYOUT_ATTR, 'inline');
      else el.removeAttribute(LAYOUT_ATTR);
    } catch (err) {
      /* ignore */
    }
  }

  /** 去掉模型输出里残留的链接标记（标记未成对时使用）。 */
  function stripLinkMarkers(text) {
    return String(text || '').replace(/\[\[\s*\/?\s*\d+\s*\]\]/g, '');
  }

  /**
   * 把带 [[n]]...[[/n]] 标记的译文还原为文本 + <a> 节点。
   * 标记缺失/不完整时退化为纯文本（不显示标记本身）。
   * @param {Element} node - translated node.
   * @param {string} text - translated text.
   * @param {object[]} links - source link descriptors (1-based marker index).
   */
  function fillTranslatedContent(node, text, links) {
    var value = String(text || '');
    node.textContent = '';
    if (!Array.isArray(links) || links.length === 0) {
      node.textContent = value;
      return;
    }
    var pattern = /\[\[\s*(\d+)\s*\]\]([\s\S]*?)\[\[\s*\/\s*\1\s*\]\]/g;
    var cursor = 0;
    var matched = false;
    var match;
    while ((match = pattern.exec(value)) !== null) {
      matched = true;
      if (match.index > cursor) node.appendChild(document.createTextNode(stripLinkMarkers(value.slice(cursor, match.index))));
      var index = parseInt(match[1], 10) - 1;
      var link = links[index];
      var inner = stripLinkMarkers(match[2]);
      if (link && link.kind === 'code') {
        var codeNode = document.createElement('code');
        if (link.className) codeNode.setAttribute('class', link.className);
        if (link.style) {
          Object.keys(link.style).forEach(function (prop) {
            try {
              codeNode.style.setProperty(prop, link.style[prop]);
            } catch (styleErr) {
              /* ignore */
            }
          });
        }
        // 代码/文件名 token 不随译文翻译，强制用原文。
        codeNode.textContent = link.text || inner;
        node.appendChild(codeNode);
      } else if (!link || !link.href) {
        node.appendChild(document.createTextNode(inner));
      } else {
        var anchor = document.createElement('a');
        anchor.setAttribute('href', link.href);
        if (link.target) anchor.setAttribute('target', link.target);
        if (link.title) anchor.setAttribute('title', link.title);
        anchor.setAttribute('rel', link.target === '_blank' ? 'noopener noreferrer' : (link.rel || 'noopener'));
        if (link.color) anchor.style.setProperty('color', link.color);
        if (link.textDecoration) anchor.style.setProperty('text-decoration', link.textDecoration);
        anchor.textContent = inner || link.text || '';
        node.appendChild(anchor);
      }
      cursor = match.index + match[0].length;
    }
    if (!matched) {
      node.textContent = stripLinkMarkers(value);
      return;
    }
    if (cursor < value.length) node.appendChild(document.createTextNode(stripLinkMarkers(value.slice(cursor))));
  }

  function createTransNode(block, text, layout) {
    var tag = block.inner ? 'div' : block.tag;
    var node;
    try {
      node = document.createElement(tag);
    } catch (err) {
      node = document.createElement('div');
    }
    if (!block.inner) copySafeAttributes(block.el, node);
    node.setAttribute(MARK_ATTR, 'trans');
    node.setAttribute(LAYOUT_ATTR, layout === 'inline' ? 'inline' : 'below');
    node.setAttribute('lang', state.effectiveTarget || '');
    node.setAttribute('dir', 'auto');
    fillTranslatedContent(node, text, block.links);
    node.style.cssText = layout === 'inline' ? TRANS_STYLE_INLINE : TRANS_STYLE_BLOCK;
    // 块级译文与下一段原文之间沿用原文段落的下外边距，避免译文贴住下一段；
    // 内嵌注入（li/td/flex 内部）不复制外层 margin，避免撑坏原容器。
    if (!block.inner && layout !== 'inline') {
      try {
        var sourceSpacing = window.getComputedStyle(block.el);
        var sourceMarginBottom = sourceSpacing.marginBottom;
        var numericMargin = parseFloat(sourceMarginBottom);
        if (!sourceMarginBottom || sourceMarginBottom === 'auto' || !isFinite(numericMargin) || numericMargin <= 0) {
          sourceMarginBottom = '0.75em';
        }
        // 原文和译文是一组；在原文段落外边距之外再留 0.75em，避免译文
        // 直接贴住下一段原文（长文双语阅读时尤其容易混淆段落边界）。
        node.style.setProperty('margin-bottom', 'calc(' + sourceMarginBottom + ' + 0.75em)');
      } catch (spacingErr) {
        /* ignore */
      }
    }
    // 与原文同样的排版：从原文元素（或表格单元格）复制 computed style
    copyTypography(block.el, node);
    if (!block.inner) copyHorizontalAlignment(block.el, node);
    if (block.gridParent) {
      try {
        var sourceGridColumn = window.getComputedStyle(block.el).gridColumn;
        if (sourceGridColumn && sourceGridColumn !== 'auto') node.style.setProperty('grid-column', sourceGridColumn);
      } catch (gridStyleErr) {
        /* ignore */
      }
    }
    // 块级元素的背景/圆角也跟随原文（如彩色标题条、提示卡片）
    try {
      var blockStyle = window.getComputedStyle(block.el);
      var blockBg = blockStyle.backgroundColor;
      if (blockBg && blockBg !== 'rgba(0, 0, 0, 0)' && blockBg !== 'transparent') {
        node.style.setProperty('background-color', blockBg);
        var blockRadius = blockStyle.borderRadius;
        if (blockRadius && blockRadius !== '0px') node.style.setProperty('border-radius', blockRadius);
      }
    } catch (err) {
      /* ignore */
    }
    return node;
  }

  function createRetryNode(block, err) {
    var tag = block.inner ? 'div' : block.tag;
    var node;
    try {
      node = document.createElement(tag);
    } catch (err) {
      node = document.createElement('div');
    }
    if (!block.inner) copySafeAttributes(block.el, node);
    node.setAttribute(MARK_ATTR, 'trans');
    node.setAttribute(LAYOUT_ATTR, 'below');
    node.setAttribute('class', (node.getAttribute('class') || '') + ' dsh-it-retry');
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('title', t('failSuffix'));
    node.textContent = t('failPrefix') + errorText(err) + t('failSuffix');
    node.style.cssText = RETRY_STYLE;
    // 失败占位保留原文的字号/行高，避免标题处占位过小
    try {
      var computed = window.getComputedStyle(block.el);
      if (computed.fontSize) node.style.fontSize = computed.fontSize;
      if (computed.lineHeight) node.style.lineHeight = computed.lineHeight;
    } catch (err) {
      /* ignore */
    }
    return node;
  }

  function markSrc(el) {
    try {
      if (!el || !el.isConnected) return;
      if (!state.srcMarked.has(el)) {
        state.srcMarked.set(el, el.hasAttribute(MARK_ATTR) ? el.getAttribute(MARK_ATTR) : null);
      }
      el.setAttribute(MARK_ATTR, 'src');
    } catch (err) {
      /* ignore */
    }
  }

  /** 让 html 上的 data-dsh-it-mode 与实际是否存在译文保持一致（页面级模式 CSS 依赖它） */
  function syncPageMode() {
    try {
      if (!document.documentElement) return;
      if (state.injectedNodes.size > 0) {
        document.documentElement.setAttribute(MODE_ATTR, state.mode);
      } else {
        document.documentElement.removeAttribute(MODE_ATTR);
      }
    } catch (err) {
      /* ignore */
    }
  }

  function insertBlockNode(block, node) {
    var el = block.el;
    if (!el || !el.isConnected) return false;
    try {
      if (block.inner) {
        el.appendChild(node);
      } else {
        if (!el.parentNode) return false;
        el.parentNode.insertBefore(node, el.nextSibling);
      }
      markSrc(el);
      state.injectedNodes.add(node);
      syncPageMode();
      return true;
    } catch (err) {
      return false;
    }
  }

  function injectTranslation(block, text) {
    if (!block || !block.el || !block.el.isConnected) return false;
    try {
      if (block.transNode && block.transNode.isConnected) {
        state.injectedNodes.delete(block.transNode);
        block.transNode.remove();
      }
      if (block.placeholder && block.placeholder.isConnected) {
        state.injectedNodes.delete(block.placeholder);
        block.placeholder.remove();
        block.placeholder = null;
      }
      var layout = resolveTransLayout(block, text);
      var node = createTransNode(block, text, layout);
      if (block.flexInner) {
        try {
          block.el.setAttribute('data-dsh-it-flex-inner', 'true');
        } catch (flexAttrErr) {
          /* ignore */
        }
      }
      if (!insertBlockNode(block, node)) return false;
      markSourceLayout(block.el, layout);
      block.transNode = node;
      return true;
    } catch (err) {
      return false;
    }
  }

  function failBlock(session, block, err) {
    if (!block || session !== state.sessionId) return;
    block.status = 'failed';
    state.done++;
    state.failed++;
    try {
      if (block.placeholder && block.placeholder.isConnected) {
        block.placeholder.textContent = t('failPrefix') + errorText(err) + t('failSuffix');
        block.placeholder.style.cursor = 'pointer';
      } else {
        var node = createRetryNode(block, err);
        if (insertBlockNode(block, node)) {
          block.placeholder = node;
          node.addEventListener('click', function () {
            retryBlock(block);
          });
          node.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              retryBlock(block);
            }
          });
        }
      }
    } catch (e) {
      /* 页面 DOM 异常不影响其他段落 */
    }
    updateProgressUi();
    refreshUi();
  }

  /**
   * 行内注入（label 内）：译文 span 直接放进原文元素内部（a/button/label/li…），
   * 从该元素复制字体、字号、字重、行高、颜色、背景等 computed 样式；
   * 原文文字节点包一层 src-inline，供「仅译文」模式隐藏。
   */
  /**
   * 紧凑导航/侧栏里的行内译文如果被挤到换行（如 MDN 顶栏 "Learn 学/习"），
   * 改为宿主内的小字块级译注：原文保持一行，译文另起一行，避免拆词/横向溢出。
   */
  /** 紧凑 UI 控件：flex/grid tab bar、工具条里的短标签（不限于 header/nav）
   *  兼容 GitHub 这类 button > span(flex) > div(text) 的分段控件结构。 */
  function isCompactUiHost(host, sourceText) {
    try {
      var text = String(sourceText == null ? host.textContent || '' : sourceText).replace(/\s+/g, ' ').trim();
      if (text.length < 1 || text.length > 48) return false;
      var control = host.closest
        ? host.closest('button, a, summary, [role="tab"], [role="button"], [role="menuitem"], [role="tablist"], [role="toolbar"], [role="menubar"], [role="menu"]')
        : null;
      if (!control) return false;
      if (control.matches && control.matches('button, summary, [role="tablist"], [role="toolbar"], [role="menubar"], [role="menu"]')) {
        return true;
      }
      // 普通链接/role 控件：只有处于 flex/grid 紧凑容器里才按控件处理，避免正文行内链接被块级化
      var el = host;
      for (var depth = 0; el && depth < 4; depth++) {
        var display = window.getComputedStyle(el).display || '';
        if (display.indexOf('flex') !== -1 || display.indexOf('grid') !== -1) return true;
        el = el.parentElement;
      }
      return false;
    } catch (err) {
      return false;
    }
  }

  function compactWrappedChromeInline(host, trans, sourceText) {
    try {
      if (!host || !trans || !host.isConnected || !trans.isConnected) return;
      var chromeHost = isChromeRegion(host);
      if (!chromeHost && !isCompactUiHost(host, sourceText)) return;
      var rect = trans.getBoundingClientRect();
      if (!rect.height) return;
      var hostStyle = window.getComputedStyle(host);
      var fontSize = parseFloat(hostStyle.fontSize) || 16;
      var lineHeight = parseFloat(hostStyle.lineHeight);
      if (!lineHeight || isNaN(lineHeight)) lineHeight = fontSize * 1.25;
      // 只处理确实发生折行的行内译文（未折行保持原样内联）
      if (rect.height <= lineHeight * 1.45) return;
      trans.setAttribute('data-dsh-it-compact', '');
      trans.style.setProperty('display', 'block');
      trans.style.setProperty('margin-left', '0');
      trans.style.setProperty('margin-top', '1px');
      trans.style.setProperty('font-size', '0.8em');
      trans.style.setProperty('line-height', '1.2');
      trans.style.setProperty('white-space', 'normal');
      trans.style.setProperty('word-break', 'keep-all');
      trans.style.setProperty('overflow-wrap', 'break-word');
    } catch (err) {
      /* 紧凑化失败时保留普通行内译文 */
    }
  }

  /** React/异步 CSS 可能在注入后改变宽度导致译文才折行；延迟复检一次 */
  function scheduleCompactRecheck(host, trans, sourceText) {
    try {
      if (!host || !trans) return;
      trans.__dshCompactScheduled = trans.__dshCompactScheduled || [];
      var delays = [150, 600];
      for (var i = 0; i < delays.length; i++) {
        (function (delay) {
          var timer = setTimeout(function () {
            try {
              if (!trans.isConnected || !host.isConnected) return;
              compactWrappedChromeInline(host, trans, sourceText);
            } catch (err) {
              /* ignore */
            }
          }, delay);
          trans.__dshCompactScheduled.push(timer);
        })(delays[i]);
      }
    } catch (err) {
      /* ignore */
    }
  }

  function injectInlineTranslation(unit, text) {
    var host = unit && unit.el;
    if (!host || !host.isConnected) return false;
    try {
      if (unit.transNode && unit.transNode.isConnected) {
        state.injectedNodes.delete(unit.transNode);
        unit.transNode.remove();
      }
      if (unit.srcWraps && unit.srcWraps.length) {
        for (var wi = unit.srcWraps.length - 1; wi >= 0; wi--) {
          var oldWrap = unit.srcWraps[wi];
          if (oldWrap && oldWrap.isConnected) {
            var oldParent = oldWrap.parentNode;
            if (oldParent) {
              while (oldWrap.firstChild) oldParent.insertBefore(oldWrap.firstChild, oldWrap);
            }
            oldWrap.remove();
          }
          state.injectedNodes.delete(oldWrap);
        }
      }
      var wraps = [];
      var nodes = unit.nodes || [];
      for (var i = 0; i < nodes.length; i++) {
        var target = nodes[i];
        if (!target || !target.isConnected || !target.parentNode) continue;
        var wrap = document.createElement('span');
        wrap.setAttribute(MARK_ATTR, 'src-inline');
        // 原文原本是 text node；包成 span 后可能被站点“button span”之类选择器命中，
        // 样式重置后保持继承宿主排版（仅译文模式仍可隐藏）。
        try {
          wrap.style.setProperty('all', 'unset');
          wrap.style.setProperty('color', 'inherit', 'important');
        } catch (resetErr) {
          /* ignore */
        }
        try {
          target.parentNode.insertBefore(wrap, target);
          wrap.appendChild(target);
          wraps.push(wrap);
          state.injectedNodes.add(wrap);
        } catch (err) {
          /* 单个文字节点包裹失败时跳过 */
        }
      }
      var trans = document.createElement('span');
      trans.setAttribute(MARK_ATTR, 'trans-inline');
      trans.textContent = text;
      // 复制 label/链接/按钮本身的排版与颜色 → 译文与原文同样式（背景随元素自然继承）
      copyComputedStyle(host, trans, INLINE_STYLE_PROPS);
      trans.style.setProperty('margin-left', '0.35em');
      trans.style.setProperty('white-space', 'pre-wrap');
      trans.style.setProperty('word-break', 'break-word');
      trans.style.setProperty('overflow-wrap', 'anywhere');
      try {
        trans.style.setProperty('color', 'inherit', 'important');
      } catch (colorErr) {
        /* ignore */
      }
      // 插在最后一个原文文字节点之后（而不是容器末尾），保证同一容器内
      // “文字 + 链接 + 文字”时译文仍紧跟对应的原文，不被后面的元素隔开。
      var insertAfter = wraps.length ? wraps[wraps.length - 1] : null;
      if (insertAfter && insertAfter.parentNode) {
        insertAfter.parentNode.insertBefore(trans, insertAfter.nextSibling);
      } else {
        host.appendChild(trans);
      }
      unit.transNode = trans;
      unit.srcWraps = wraps;
      state.injectedNodes.add(trans);
      compactWrappedChromeInline(host, trans, unit.text);
      if (!trans.hasAttribute('data-dsh-it-compact')) scheduleCompactRecheck(host, trans, unit.text);
      syncPageMode();
      return true;
    } catch (err) {
      return false;
    }
  }

  /** 行内译文失败占位：容器末尾的红色小标记，点击重试 */
  function failInlineUnit(session, unit, err) {
    if (!unit || session !== state.sessionId) return;
    unit.status = 'failed';
    state.done++;
    state.failed++;
    try {
      var host = unit.el;
      if (!host || !host.isConnected) return;
      if (unit.transNode && unit.transNode.isConnected) {
        state.injectedNodes.delete(unit.transNode);
        unit.transNode.remove();
      }
      var span = document.createElement('span');
      span.setAttribute(MARK_ATTR, 'trans-inline');
      span.setAttribute('class', 'dsh-it-inline-retry');
      span.textContent = t('failInline');
      span.title = t('failPrefix') + errorText(err) + t('failSuffix');
      span.style.cssText =
        'font:inherit;color:#b91c1c;margin-left:0.35em;cursor:pointer;white-space:pre-wrap;text-decoration:underline dotted;';
      host.appendChild(span);
      unit.placeholder = span;
      state.injectedNodes.add(span);
      span.addEventListener('click', function () {
        retryUnit(unit);
      });
    } catch (e) {
      /* 页面 DOM 异常不影响其他段落 */
    }
    updateProgressUi();
    refreshUi();
  }

  /** 行内译文单元重试 */
  function retryInlineUnit(unit) {
    if (!unit || state.running) return;
    var session = state.sessionId;
    // 轨迹（Turn）：run 已结束时的单段重试 = 新的单步 Turn（requestTranslations 会新建 runId，成功/失败后清空）
    var retryTurn = !state.runId;
    unit.status = 'translating';
    var placeholder = unit.placeholder;
    if (placeholder && placeholder.isConnected) {
      placeholder.textContent = t('translating');
      placeholder.style.cursor = 'default';
    }
    safe(function () {
      return requestTranslations([unit])
        .then(function (translations) {
          if (session !== state.sessionId) return;
          var value = translations[0];
          var text = translationTextOf(value);
          if (!text) throw makeError('EMPTY_TRANSLATION', t('errEmptyTranslation'));
          if (!isSameTranslation(unit.text, text)) injectInlineTranslation(unit, text);
          if (placeholder && placeholder.isConnected) {
            state.injectedNodes.delete(placeholder);
            placeholder.remove();
          }
          unit.placeholder = null;
          unit.status = 'done';
          state.failed = Math.max(0, state.failed - 1);
          updateProgressUi();
          refreshUi();
          if (state.lazyActive && state.lazy) {
            schedulePump(state.lazy.session, false);
            maybeFinishLazy(state.lazy.session);
          } else if (state.failed === 0) {
            setDoneStatus();
          } else {
            setStatus(t('statusPartial', { failed: state.failed }), 'warn');
          }
          // 独立重试 Turn 完成：清空 runId，下一次重试/翻译重新开 Turn
          if (retryTurn) endTurn();
        })
        .catch(function (err) {
          if (session !== state.sessionId) return;
          unit.status = 'failed';
          if (placeholder && placeholder.isConnected) {
            placeholder.textContent = t('failInline');
            placeholder.style.cursor = 'pointer';
          }
          setStatus(errorText(err), 'error');
          if (retryTurn) endTurn();
        });
    });
  }

  /** 按单元类型分发：块级 / 行内 */
  function injectUnit(unit, text) {
    if (!unit) return false;
    if (unit.kind === 'inline') return injectInlineTranslation(unit, text);
    return injectTranslation(unit, text);
  }

  function failUnit(session, unit, err) {
    if (unit && unit.kind === 'inline') {
      failInlineUnit(session, unit, err);
      return;
    }
    failBlock(session, unit, err);
  }

  function retryUnit(unit) {
    if (!unit) return;
    if (unit.kind === 'inline') {
      retryInlineUnit(unit);
    } else {
      retryBlock(unit);
    }
  }

  function removeAllTransNodes() {
    try {
      var selector = '[' + MARK_ATTR + '="trans"],[' + MARK_ATTR + '="trans-inline"]';
      var nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
      for (var i = 0; i < nodes.length; i++) {
        try {
          nodes[i].remove();
        } catch (err) {
          /* ignore */
        }
      }
    } catch (err) {
      /* ignore */
    }
  }

  function clearTranslations() {
    state.sessionId++;
    // 先把行内原文从包裹 span 中还原（必须在移除注入节点之前，否则会丢原文文字）
    try {
      var inlineWraps = Array.prototype.slice.call(document.querySelectorAll('[' + MARK_ATTR + '="src-inline"]'));
      for (var w = 0; w < inlineWraps.length; w++) {
        var wrapEl = inlineWraps[w];
        try {
          var wrapParent = wrapEl.parentNode;
          if (wrapParent) {
            while (wrapEl.firstChild) wrapParent.insertBefore(wrapEl.firstChild, wrapEl);
          }
          wrapEl.remove();
        } catch (err2) {
          /* ignore */
        }
      }
    } catch (err) {
      /* ignore */
    }
    try {
      state.injectedNodes.forEach(function (node) {
        try {
          if (node.isConnected) node.remove();
        } catch (err) {
          /* ignore */
        }
      });
    } catch (err) {
      /* ignore */
    }
    state.injectedNodes.clear();
    removeAllTransNodes();
    disconnectLazy();

    state.srcMarked.forEach(function (previous, el) {
      try {
        if (!el) return;
        if (previous === null || previous === undefined) el.removeAttribute(MARK_ATTR);
        else el.setAttribute(MARK_ATTR, previous);
      } catch (err) {
        /* ignore */
      }
    });
    state.srcMarked.clear();
    try {
      var leftovers = document.querySelectorAll('[' + MARK_ATTR + '="src"]');
      for (var i = 0; i < leftovers.length; i++) leftovers[i].removeAttribute(MARK_ATTR);
    } catch (err) {
      /* ignore */
    }
    // 清除并排布局标记（原文块可能被标记过 inline）
    try {
      var layoutMarks = document.querySelectorAll('[' + LAYOUT_ATTR + ']');
      for (var k = 0; k < layoutMarks.length; k++) layoutMarks[k].removeAttribute(LAYOUT_ATTR);
    } catch (err) {
      /* ignore */
    }
    try {
      var flexInners = document.querySelectorAll('[data-dsh-it-flex-inner]');
      for (var fi = 0; fi < flexInners.length; fi++) flexInners[fi].removeAttribute('data-dsh-it-flex-inner');
    } catch (flexCleanupErr) {
      /* ignore */
    }

    for (var j = 0; j < state.units.length; j++) {
      state.units[j].transNode = null;
      state.units[j].placeholder = null;
      state.units[j].srcWrap = null;
      state.units[j].srcWraps = null;
    }
    state.units = [];
    state.total = 0;
    state.done = 0;
    state.failed = 0;
    removePageStyle();
    try {
      document.documentElement.removeAttribute(MODE_ATTR);
    } catch (err) {
      /* ignore */
    }
    updateProgressUi();
  }

  /* ================================================================ */
  /* 页面级样式（仅控制三模式显示；挂 documentElement，不碰 <head>）     */
  /* ================================================================ */

  var PAGE_CSS = [
    'html[' + MODE_ATTR + '="source"] [data-dsh-it="trans"]{display:none!important;}',
    'html[' + MODE_ATTR + '="only"] [data-dsh-it="src"]:not(td):not(th):not(caption):not(summary):not(li):not([data-dsh-it-flex-inner="true"]){display:none!important;}',
    'html[' + MODE_ATTR + '="only"] [data-dsh-it="src"][data-dsh-it-flex-inner="true"]{visibility:hidden!important;}',
    'html[' + MODE_ATTR + '="only"] [data-dsh-it="src"][data-dsh-it-flex-inner="true"] [data-dsh-it="trans"]{visibility:visible!important;display:block!important;}',
    'html[' + MODE_ATTR + '="only"] td[data-dsh-it="src"],html[' + MODE_ATTR + '="only"] th[data-dsh-it="src"],' +
      'html[' + MODE_ATTR + '="only"] caption[data-dsh-it="src"],html[' + MODE_ATTR + '="only"] summary[data-dsh-it="src"],' +
      'html[' + MODE_ATTR + '="only"] li[data-dsh-it="src"]{visibility:hidden!important;}',
    'html[' + MODE_ATTR + '="only"] td[data-dsh-it="src"] [data-dsh-it="trans"],' +
      'html[' + MODE_ATTR + '="only"] th[data-dsh-it="src"] [data-dsh-it="trans"],' +
      'html[' + MODE_ATTR + '="only"] caption[data-dsh-it="src"] [data-dsh-it="trans"],' +
      'html[' + MODE_ATTR + '="only"] summary[data-dsh-it="src"] [data-dsh-it="trans"],' +
      'html[' + MODE_ATTR + '="only"] li[data-dsh-it="src"] [data-dsh-it="trans"]{visibility:visible!important;display:block!important;}',
    '[data-dsh-it="trans"]{unicode-bidi:plaintext;}',
    // 行内译文：只翻文字节点、不新增块级兄弟/列表项
    '[data-dsh-it="trans-inline"]{unicode-bidi:plaintext;}',
    'html[' + MODE_ATTR + '="source"] [data-dsh-it="trans-inline"]{display:none!important;}',
    'html[' + MODE_ATTR + '="only"] [data-dsh-it="src-inline"]{display:none!important;}',
    '[data-dsh-it="trans-inline"].dsh-it-inline-retry:hover{filter:brightness(0.9);}',
    // 并排布局：原文与译文同处一行；仅双语模式改变原文 display，原文/仅译文模式不受影响
    'html[' + MODE_ATTR + '="bilingual"] [data-dsh-it="src"]' + '[' + LAYOUT_ATTR + '="inline"]{' +
      'display:inline-block!important;vertical-align:baseline!important;max-width:100%;margin-block:0!important;}',
    // 仅译文模式下原文块被隐藏，译文不需要右侧缩进
    'html[' + MODE_ATTR + '="only"] [data-dsh-it="trans"][' + LAYOUT_ATTR + '="inline"]{margin-left:0!important;}',
    '[data-dsh-it="trans"].dsh-it-retry:hover{background:rgba(220,38,38,0.16)!important;}'
  ].join('\n');

  function ensurePageStyle() {
    try {
      if (state.pageStyleEl && state.pageStyleEl.isConnected) return;
      var existing = document.getElementById(PAGE_STYLE_ID);
      if (!existing) {
        existing = document.createElement('style');
        existing.id = PAGE_STYLE_ID;
        existing.textContent = PAGE_CSS;
        var parent = document.documentElement;
        if (!parent) return;
        parent.appendChild(existing);
      }
      state.pageStyleEl = existing;
    } catch (err) {
      /* 样式注入失败时双语模式仍可用 */
    }
  }

  function removePageStyle() {
    try {
      if (state.pageStyleEl && state.pageStyleEl.isConnected) state.pageStyleEl.remove();
    } catch (err) {
      /* ignore */
    }
    state.pageStyleEl = null;
    try {
      var leftovers = document.getElementById(PAGE_STYLE_ID);
      if (leftovers) leftovers.remove();
    } catch (err) {
      /* ignore */
    }
  }

  function applyMode(mode, persist) {
    var next = MODES.indexOf(mode) === -1 ? 'bilingual' : mode;
    state.mode = next;
    try {
      if (state.host) state.host.setAttribute(MODE_ATTR, next);
      syncPageMode();
    } catch (err) {
      /* ignore */
    }
    postToChildFrames({ __dshItFrame: true, action: 'mode', mode: next });
    updateModeButtons();
    if (persist) {
      if (state.settings.mode === next) {
        /* 值未变时不重复写 storage */
      } else {
        state.settings.mode = next;
        storageSet({ mode: next });
      }
    }
  }

  /* ================================================================ */
  /* Shadow DOM UI                                                     */
  /* ================================================================ */

  var CSS_TEXT =
    ':host{all:initial!important;position:fixed!important;top:0!important;left:0!important;' +
    'width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;' +
    'pointer-events:none!important;--dsh-bg:#ffffff;--dsh-bg2:#f6f7fb;--dsh-fg:#1f2430;--dsh-sub:#667085;' +
    '--dsh-border:rgba(15,23,42,0.12);--dsh-track:rgba(15,23,42,0.10);--dsh-accent:#4f46e5;--dsh-accent2:#0ea5e9;' +
    '--dsh-ok:#047857;--dsh-warn:#b45309;--dsh-err:#dc2626;' +
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif!important;' +
    'font-size:14px!important;line-height:1.5!important;color:var(--dsh-fg)!important;direction:ltr!important;' +
    '-webkit-font-smoothing:antialiased!important;text-align:left!important;}' +
    '@media (prefers-color-scheme: dark){:host{--dsh-bg:#1b2130;--dsh-bg2:#232b3d;--dsh-fg:#e5e9f2;--dsh-sub:#98a2b3;' +
    '--dsh-border:rgba(255,255,255,0.12);--dsh-track:rgba(255,255,255,0.12);--dsh-accent:#818cf8;--dsh-ok:#34d399;' +
    '--dsh-warn:#fbbf24;--dsh-err:#f87171;}}' +
    '.dsh-root,.dsh-root *{box-sizing:border-box;}' +
    '.dsh-root [hidden]{display:none!important;}' +
    '.dsh-root button{all:unset;box-sizing:border-box;cursor:pointer;font:inherit;color:inherit;text-align:center;}' +
    '.dsh-root button:disabled{cursor:default;}' +
    '.dsh-root button:hover,.dsh-root button:focus-visible{opacity:1!important;visibility:visible!important;pointer-events:auto!important;}' +
    '.dsh-panel:hover,.dsh-card:hover{opacity:1!important;visibility:visible!important;pointer-events:auto!important;}' +
    '.dsh-root button:focus-visible,.dsh-root select:focus-visible{outline:2px solid var(--dsh-accent);outline-offset:2px;}' +
    '.dsh-bubble{position:fixed!important;right:16px!important;bottom:16px!important;width:46px!important;height:46px!important;' +
    'border-radius:50%!important;display:flex!important;align-items:center!important;justify-content:center!important;' +
    'font-size:18px!important;font-weight:700!important;line-height:1!important;color:#fff!important;' +
    'background:linear-gradient(135deg,#4f46e5,#0ea5e9)!important;' +
    'box-shadow:0 4px 14px rgba(15,23,42,0.35),0 0 0 1px rgba(255,255,255,0.18) inset!important;' +
    'pointer-events:auto!important;user-select:none!important;transition:transform .15s ease!important;}' +
    '.dsh-bubble:hover{transform:translateY(-1px) scale(1.04)!important;}' +
    '.dsh-bubble{cursor:grab;touch-action:none!important;}' +
    '.dsh-bubble.dsh-bubble-dragging{cursor:grabbing!important;transform:scale(1.06)!important;transition:none!important;}' +
    '.dsh-bubble.dsh-bubble-busy{font-size:11px!important;letter-spacing:-0.2px!important;}' +
    '.dsh-bubble.dsh-bubble-busy::before{content:\'\'!important;position:absolute!important;inset:-4px!important;border-radius:50%!important;' +
    'background:conic-gradient(#0ea5e9 calc(var(--dsh-bubble-progress,0) * 1%),rgba(255,255,255,0.25) 0)!important;' +
    '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px))!important;' +
    'mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2px))!important;' +
    'animation:dsh-bubble-ring 1.2s ease-in-out infinite!important;}' +
    '@keyframes dsh-bubble-ring{0%,100%{transform:rotate(0)}50%{transform:rotate(180deg)}}' +
    '.dsh-bubble[data-active="true"]{box-shadow:0 0 0 3px rgba(14,165,233,0.45),0 4px 14px rgba(15,23,42,0.35)!important;}' +
    '.dsh-toast{position:fixed!important;right:16px!important;bottom:74px!important;max-width:300px!important;' +
    'padding:8px 12px!important;border-radius:10px!important;background:#1f2430!important;color:#fff!important;' +
    'font-size:12px!important;line-height:1.45!important;box-shadow:0 8px 24px rgba(15,23,42,0.30)!important;' +
    'pointer-events:none!important;z-index:3!important;}' +
    '.dsh-panel{position:fixed!important;right:16px!important;bottom:74px!important;width:324px!important;' +
    'max-width:calc(100vw - 32px)!important;max-height:calc(100vh - 110px)!important;overflow:auto!important;' +
    'display:flex!important;flex-direction:column!important;gap:10px!important;padding:14px!important;border-radius:14px!important;' +
    'background:var(--dsh-bg)!important;color:var(--dsh-fg)!important;' +
    'box-shadow:0 12px 40px rgba(15,23,42,0.28),0 0 0 1px var(--dsh-border)!important;' +
    'pointer-events:auto!important;font-size:13px!important;}' +
    '.dsh-panel-head{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important;}' +
    '.dsh-title{font-size:14px!important;font-weight:600!important;letter-spacing:0.2px!important;}' +
    '.dsh-icon-btn{width:26px!important;height:26px!important;border-radius:8px!important;display:flex!important;' +
    'align-items:center!important;justify-content:center!important;font-size:14px!important;line-height:1!important;' +
    'color:var(--dsh-sub)!important;}' +
    '.dsh-icon-btn:hover{background:var(--dsh-bg2)!important;color:var(--dsh-fg)!important;}' +
    '.dsh-seg{display:flex!important;border:1px solid var(--dsh-border)!important;border-radius:9px!important;overflow:hidden!important;}' +
    '.dsh-seg-btn{flex:1 1 0!important;padding:6px 4px!important;font-size:12px!important;color:var(--dsh-sub)!important;' +
    'border-right:1px solid var(--dsh-border)!important;}' +
    '.dsh-seg-btn:last-child{border-right:0!important;}' +
    '.dsh-seg-btn[aria-pressed="true"]{background:var(--dsh-accent)!important;color:#fff!important;}' +
    '.dsh-row{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;}' +
    '.dsh-label{color:var(--dsh-sub)!important;font-size:12px!important;flex:0 0 auto!important;}' +
    '.dsh-select{flex:1 1 auto!important;min-width:0!important;height:28px!important;padding:0 6px!important;border-radius:8px!important;' +
    'border:1px solid var(--dsh-border)!important;background:var(--dsh-bg2)!important;color:var(--dsh-fg)!important;' +
    'font:inherit!important;font-size:12px!important;cursor:pointer!important;}' +
    '.dsh-model{font-size:12px!important;color:var(--dsh-fg)!important;max-width:200px!important;overflow:hidden!important;' +
    'text-overflow:ellipsis!important;white-space:nowrap!important;text-align:right!important;font-variant-numeric:tabular-nums!important;}' +
    '.dsh-tokens{font-size:12px!important;color:var(--dsh-fg)!important;max-width:210px!important;overflow:hidden!important;' +
    'text-overflow:ellipsis!important;white-space:nowrap!important;text-align:right!important;font-variant-numeric:tabular-nums!important;}' +
    '.dsh-row[data-role="tokens-today"] .dsh-tokens{color:var(--dsh-sub)!important;}' +
    '.dsh-actions{display:grid!important;grid-template-columns:1fr auto auto!important;gap:8px!important;}' +
    '.dsh-btn{display:inline-flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;' +
    'height:30px!important;padding:0 10px!important;border-radius:8px!important;border:1px solid var(--dsh-border)!important;' +
    'background:transparent!important;color:var(--dsh-fg)!important;font-size:12px!important;font-weight:500!important;}' +
    '.dsh-btn:not(.primary):hover:not(:disabled){background:var(--dsh-bg2)!important;}' +
    '.dsh-btn:disabled{opacity:0.45!important;}' +
    '.dsh-btn.primary{background:linear-gradient(135deg,var(--dsh-accent),var(--dsh-accent2))!important;border-color:transparent!important;color:#fff!important;}' +
    // 修复：通用 hover 背景曾覆盖 primary 渐变，导致白字白底看起来按钮消失
    '.dsh-btn.primary:hover:not(:disabled){background:linear-gradient(135deg,var(--dsh-accent),var(--dsh-accent2))!important;color:#fff!important;filter:brightness(1.06)!important;}' +
    '.dsh-btn.warn{color:var(--dsh-err)!important;border-color:rgba(220,38,38,0.35)!important;}' +
    '.dsh-progress{display:flex!important;align-items:center!important;gap:8px!important;}' +
    '.dsh-bar{flex:1 1 auto!important;height:6px!important;border-radius:999px!important;background:var(--dsh-track)!important;overflow:hidden!important;}' +
    '.dsh-bar > i{display:block!important;height:100%!important;width:0;border-radius:999px!important;' +
    'background:linear-gradient(90deg,#4f46e5,#0ea5e9)!important;transition:width .2s ease!important;}' +
    '.dsh-progress-num{font-size:11px!important;color:var(--dsh-sub)!important;min-width:56px!important;text-align:right!important;' +
    'font-variant-numeric:tabular-nums!important;}' +
    '.dsh-status{font-size:12px!important;min-height:17px!important;color:var(--dsh-sub)!important;word-break:break-word!important;' +
    'overflow-wrap:anywhere!important;}' +
    '.dsh-status.is-error{color:var(--dsh-err)!important;}' +
    '.dsh-status.is-warn{color:var(--dsh-warn)!important;}' +
    '.dsh-status.is-ok{color:var(--dsh-ok)!important;}' +
    '.dsh-privacy{font-size:11px!important;color:var(--dsh-sub)!important;line-height:1.45!important;' +
    'border-top:1px dashed var(--dsh-border)!important;padding-top:8px!important;}' +
    '.dsh-foot{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;}' +
    '.dsh-foot-links{display:inline-flex!important;align-items:center!important;gap:10px!important;}' +
    '.dsh-domain-row{display:flex!important;align-items:center!important;justify-content:flex-start!important;}' +
    '.dsh-domain-row .dsh-link{font-size:11px!important;}' +
    '.dsh-link{font-size:12px!important;color:var(--dsh-accent)!important;text-decoration:underline!important;}' +
    '.dsh-ver{font-size:10px!important;color:var(--dsh-sub)!important;opacity:0.8!important;}' +
    '.dsh-card{position:fixed!important;left:0;top:0;width:330px!important;max-width:calc(100vw - 24px)!important;' +
    'max-height:60vh!important;overflow:auto!important;padding:12px 14px 12px!important;border-radius:12px!important;' +
    'background:var(--dsh-bg)!important;color:var(--dsh-fg)!important;' +
    'box-shadow:0 14px 44px rgba(15,23,42,0.30),0 0 0 1px var(--dsh-border)!important;' +
    'pointer-events:auto!important;font-size:13px!important;z-index:2!important;}' +
    '.dsh-card-close{position:absolute!important;right:6px!important;top:6px!important;}' +
    '.dsh-card-src{font-size:12px!important;color:var(--dsh-sub)!important;border-left:3px solid var(--dsh-accent)!important;' +
    'padding-left:8px!important;padding-right:20px!important;margin-bottom:8px!important;word-break:break-word!important;' +
    'overflow-wrap:anywhere!important;max-height:4.6em!important;overflow:auto!important;white-space:pre-wrap!important;unicode-bidi:plaintext!important;}' +
    '.dsh-card-loading{font-size:12px!important;color:var(--dsh-sub)!important;}' +
    '.dsh-card-trans{font-size:16px!important;font-weight:600!important;line-height:1.45!important;' +
    'word-break:break-word!important;overflow-wrap:anywhere!important;white-space:pre-wrap!important;unicode-bidi:plaintext!important;}' +
    '.dsh-card-phon{font-size:12px!important;color:var(--dsh-sub)!important;margin-top:2px!important;}' +
    '.dsh-card-dict{margin-top:8px!important;font-size:12px!important;color:var(--dsh-fg)!important;max-height:9em!important;overflow:auto!important;}' +
    '.dsh-dict-pos{color:var(--dsh-sub)!important;font-style:italic!important;margin-right:4px!important;}' +
    '.dsh-dict-def{margin:2px 0 4px 14px!important;padding:0!important;list-style:disc!important;}' +
    '.dsh-card-actions{display:flex!important;gap:8px!important;margin-top:10px!important;align-items:center!important;flex-wrap:wrap!important;}' +
    '.dsh-card-tokens{font-size:11px!important;color:var(--dsh-sub)!important;margin-top:6px!important;' +
    'font-variant-numeric:tabular-nums!important;overflow-wrap:anywhere!important;}' +
    '.dsh-card-status{font-size:11px!important;margin-top:6px!important;min-height:14px!important;word-break:break-word!important;color:var(--dsh-err)!important;}' +
    '.dsh-card-status.is-ok{color:var(--dsh-ok)!important;}' +
    '.dsh-card-status.is-sub{color:var(--dsh-sub)!important;}';

  function make(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var value = props[key];
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = String(value);
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'dataset' && typeof value === 'object') {
          for (var dataKey in value) {
            if (Object.prototype.hasOwnProperty.call(value, dataKey)) {
              node.dataset[dataKey] = String(value[dataKey]);
            }
          }
        } else if (key === 'on' && typeof value === 'object') {
          for (var eventName in value) {
            if (Object.prototype.hasOwnProperty.call(value, eventName)) {
              node.addEventListener(eventName, value[eventName]);
            }
          }
        } else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, value === true ? '' : String(value));
        }
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child === undefined || child === null || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return node;
  }

  function createUI() {
    if (state.host && state.host.isConnected) return;
    var parent = document.documentElement;
    if (!parent) return;
    var host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = HOST_STYLE;
    parent.appendChild(host);

    var shadow;
    try {
      shadow = host.attachShadow({ mode: 'open' });
    } catch (err) {
      host.remove();
      return;
    }
    var styleEl = document.createElement('style');
    styleEl.textContent = CSS_TEXT;
    shadow.appendChild(styleEl);
    var root = document.createElement('div');
    root.className = 'dsh-root';
    shadow.appendChild(root);

    state.host = host;
    state.shadow = shadow;
    state.root = root;

    state.ui = {
      bubble: null,
      panel: null,
      panelTitle: null,
      modeButtons: [],
      langSelect: null,
      model: null,
      tokensPage: null,
      tokensPageLabel: null,
      tokensPageRow: null,
      tokensToday: null,
      tokensTodayLabel: null,
      tokensTodayRow: null,
      translateBtn: null,
      stopBtn: null,
      restoreBtn: null,
      progressNum: null,
      bar: null,
      status: null,
      privacy: null,
      settingsBtn: null,
      version: null,
      card: null,
      cardSrc: null,
      cardLoading: null,
      cardBody: null,
      cardTrans: null,
      cardPhon: null,
      cardDict: null,
      cardStatus: null,
      cardTokens: null,
      cardPlay: null,
      cardAdd: null
    };

    buildBubble();
    buildPanel();
    buildCard();
    buildToast();
    updateUiText();
    applyMode(state.mode, false);
    setStatus(t('statusIdle'), '');
    refreshUi();
  }

  var BALL_SIZE = 46;
  var BALL_MARGIN = 8;
  var bubbleDrag = null;
  var suppressBubbleClick = false;

  function clampBallPosition(pos) {
    var viewportW = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var viewportH = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    var maxRight = Math.max(BALL_MARGIN, viewportW - BALL_SIZE - BALL_MARGIN);
    var maxBottom = Math.max(BALL_MARGIN, viewportH - BALL_SIZE - BALL_MARGIN);
    var right = pos && isFinite(Number(pos.right)) ? Number(pos.right) : 16;
    var bottom = pos && isFinite(Number(pos.bottom)) ? Number(pos.bottom) : 16;
    return {
      right: Math.min(maxRight, Math.max(BALL_MARGIN, Math.round(right))),
      bottom: Math.min(maxBottom, Math.max(BALL_MARGIN, Math.round(bottom)))
    };
  }

  function applyBallPosition(pos, persist) {
    var next = clampBallPosition(pos || (state.settings && state.settings.ballPosition));
    state.settings.ballPosition = next;
    var bubble = state.ui && state.ui.bubble;
    if (bubble) {
      bubble.style.setProperty('right', next.right + 'px', 'important');
      bubble.style.setProperty('bottom', next.bottom + 'px', 'important');
    }
    if (persist) storageSet({ ballPosition: next });
    return next;
  }

  function onBubblePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    var bubble = state.ui && state.ui.bubble;
    if (!bubble) return;
    try {
      bubble.setPointerCapture(event.pointerId);
    } catch (err) {
      /* 合成事件没有 pointer capture */
    }
    var rect = bubble.getBoundingClientRect();
    bubbleDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRight: (window.innerWidth || 0) - rect.right,
      startBottom: (window.innerHeight || 0) - rect.bottom,
      moved: false
    };
    try {
      event.preventDefault();
    } catch (err) {
      /* ignore */
    }
  }

  function onBubblePointerMove(event) {
    if (!bubbleDrag || event.pointerId !== bubbleDrag.pointerId) return;
    var dx = event.clientX - bubbleDrag.startX;
    var dy = event.clientY - bubbleDrag.startY;
    if (!bubbleDrag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    bubbleDrag.moved = true;
    var bubble = state.ui && state.ui.bubble;
    if (bubble) bubble.classList.add('dsh-bubble-dragging');
    applyBallPosition({ right: bubbleDrag.startRight - dx, bottom: bubbleDrag.startBottom - dy }, false);
    try {
      event.preventDefault();
    } catch (err) {
      /* ignore */
    }
  }

  function finishBubbleDrag() {
    if (!bubbleDrag) return;
    var moved = bubbleDrag.moved;
    var pointerId = bubbleDrag.pointerId;
    var bubble = state.ui && state.ui.bubble;
    try {
      if (bubble && bubble.releasePointerCapture) bubble.releasePointerCapture(pointerId);
    } catch (err) {
      /* ignore */
    }
    if (bubble) bubble.classList.remove('dsh-bubble-dragging');
    bubbleDrag = null;
    if (moved) {
      suppressBubbleClick = true;
      setTimeout(function () {
        suppressBubbleClick = false;
      }, 350);
      applyBallPosition(state.settings.ballPosition, true);
    }
  }

  function setFloatingBallVisible(visible, opts) {
    var show = visible !== false;
    var previous = state.settings.showFloatingBall;
    state.settings.showFloatingBall = show;
    if (previous !== show) storageSet({ showFloatingBall: show });
    applyBallSiteVisibility();
    if (show) applyBallPosition(state.settings.ballPosition, false);
    else {
      closePanel();
      closeCard();
    }
    if (opts && opts.toast) {
      if (show && isCurrentDomainHidden()) showToast(t('ballDomainBlocked'), 4200);
      else showToast(t(show ? 'ballShown' : 'ballHidden'), show ? 1800 : 4200);
    }
  }

  function hideFloatingBall() {
    setFloatingBallVisible(false, { toast: true });
  }

  function showFloatingBall() {
    setFloatingBallVisible(true, { toast: true });
  }

  /** 悬浮球左键：按当前模式（仅译文/双语对照，source 视为双语）快速翻译；翻译中/已译时切换停止/还原 */
  function quickTranslateFromBall() {
    if (state.running) {
      stopTranslate();
      return;
    }
    if (state.lazyActive || hasTranslations()) {
      restoreAll();
      return;
    }
    var mode = state.mode === 'only' ? 'only' : 'bilingual';
    if (state.mode !== mode) applyMode(mode, true);
    startTranslate({ silent: true });
  }

  function normalizeSiteHost(value) {
    if (typeof value !== 'string') return '';
    var raw = value.trim().toLowerCase();
    if (!raw) return '';
    try {
      if (raw.indexOf('://') !== -1) raw = new URL(raw).hostname;
      else raw = raw.split('/')[0].split('?')[0].split('#')[0].replace(/:\d+$/, '');
    } catch (err) {
      return '';
    }
    return raw.replace(/\.$/, '').replace(/^www\./, '');
  }

  function currentSiteHost() {
    try {
      return normalizeSiteHost(location.hostname);
    } catch (err) {
      return '';
    }
  }

  function normalizeHiddenSites(list) {
    var result = [];
    if (!Array.isArray(list)) return result;
    for (var i = 0; i < list.length; i++) {
      var site = normalizeSiteHost(list[i]);
      if (site && result.indexOf(site) === -1) result.push(site);
    }
    return result;
  }

  function isCurrentDomainHidden() {
    var host = currentSiteHost();
    return !!host && state.hiddenBallSites.indexOf(host) !== -1;
  }

  function isCurrentSiteAutoTranslate() {
    var host = currentSiteHost();
    return !!host && normalizeSiteList(state.settings.autoTranslateSites).indexOf(host) !== -1;
  }

  /** 规范化自动翻译站点列表（去重、去协议/路径/端口/www）。 */
  function normalizeSiteList(list) {
    var result = [];
    if (!Array.isArray(list)) return result;
    for (var i = 0; i < list.length && result.length < 200; i++) {
      var site = normalizeSiteHost(list[i]);
      if (site && result.indexOf(site) === -1) result.push(site);
    }
    return result;
  }

  function updateAutoSiteButton() {
    var button = state.ui && state.ui.autoSiteBtn;
    if (!button) return;
    var host = currentSiteHost();
    button.hidden = !host;
    if (!host) return;
    button.textContent = isCurrentSiteAutoTranslate() ? t('autoSiteDisable') : t('autoSiteEnable');
  }

  function setAutoSiteSites(sites) {
    state.settings.autoTranslateSites = normalizeSiteList(sites);
    updateAutoSiteButton();
    return storageSet({ autoTranslateSites: state.settings.autoTranslateSites });
  }

  function toggleCurrentSiteAutoTranslate() {
    var host = currentSiteHost();
    if (!host) return Promise.resolve();
    var enabled = isCurrentSiteAutoTranslate();
    var next = normalizeSiteList(state.settings.autoTranslateSites).filter(function (item) {
      return item !== host;
    });
    if (!enabled) next.push(host);
    return setAutoSiteSites(next)
      .then(function () {
        showToast(t(enabled ? 'autoSiteDisabled' : 'autoSiteEnabled'), 4200);
        if (!enabled && !state.running && !state.lazyActive && !hasTranslations()) {
          return startTranslate({ silent: true });
        }
        return null;
      })
      .catch(function (err) {
        showToast(errorText(err), 4200);
      });
  }

  function isCurrentLanguageSame() {
    var page = detectPageLanguage();
    var target = state.effectiveTarget || state.settings.targetLanguage || '';
    return !!page && !!target && isSameLanguage(page, target);
  }

  function loadBallSites() {
    return rpc('ball-sites')
      .then(function (data) {
        state.hiddenBallSites = normalizeHiddenSites(data && data.sites);
      })
      .catch(function () {
        state.hiddenBallSites = [];
      });
  }

  function applyBallSiteVisibility() {
    var bubble = state.ui && state.ui.bubble;
    if (!bubble) return;
    bubble.hidden =
      state.settings.showFloatingBall === false ||
      isCurrentDomainHidden() ||
      (state.settings.hideBallSameLanguage !== false && isCurrentLanguageSame());
  }

  function updateDomainBallButton() {
    var button = state.ui && state.ui.domainBallBtn;
    if (!button) return;
    var host = currentSiteHost();
    button.hidden = !host;
    if (!host) return;
    button.textContent = isCurrentDomainHidden() ? t('ballDomainShow') : t('ballDomainHide');
  }

  function toggleCurrentDomainBall() {
    var host = currentSiteHost();
    if (!host) return Promise.resolve();
    var hidden = isCurrentDomainHidden();
    var method = hidden ? 'ball-sites/remove' : 'ball-sites/add';
    return rpc(method, { domain: host }).then(function (data) {
      state.hiddenBallSites = normalizeHiddenSites(data && data.sites);
      applyBallSiteVisibility();
      updateDomainBallButton();
      showToast(t(hidden ? 'ballDomainShown' : 'ballDomainHidden'), 4200);
    }).catch(function (err) {
      showToast(errorText(err), 4200);
    });
  }

  function hideCurrentDomainBall() {
    var host = currentSiteHost();
    if (!host) return;
    if (isCurrentDomainHidden()) {
      showToast(t('ballDomainAlreadyHidden'), 4200);
      return;
    }
    rpc('ball-sites/add', { domain: host }).then(function (data) {
      state.hiddenBallSites = normalizeHiddenSites(data && data.sites);
      applyBallSiteVisibility();
      updateDomainBallButton();
      showToast(t('ballDomainHidden'), 4200);
    }).catch(function (err) {
      showToast(errorText(err), 4200);
    });
  }

  function buildBubble() {
    var bubble = make('button', {
      type: 'button',
      class: 'dsh-bubble',
      'aria-label': t('bubbleTitle'),
      title: t('toggleTitle'),
      onClick: function () {
        if (suppressBubbleClick) {
          suppressBubbleClick = false;
          return;
        }
        safe(quickTranslateFromBall);
      },
      onContextmenu: function (event) {
        try {
          event.preventDefault();
          event.stopPropagation();
        } catch (err) {
          /* ignore */
        }
        safe(openPanel);
      },
      onPointerdown: onBubblePointerDown,
      onPointermove: onBubblePointerMove,
      onPointerup: finishBubbleDrag,
      onPointercancel: finishBubbleDrag
    });
    bubble.textContent = '译';
    state.root.appendChild(bubble);
    state.ui.bubble = bubble;
    applyBallPosition(state.settings.ballPosition, false);
    applyBallSiteVisibility();
  }

  function buildToast() {
    var toast = make('div', { class: 'dsh-toast', role: 'status', 'aria-live': 'polite' });
    toast.hidden = true;
    state.root.appendChild(toast);
    state.ui.toast = toast;
  }

  var toastTimer = null;
  function showToast(text, timeoutMs) {
    try {
      var toast = state.ui && state.ui.toast;
      if (!toast) return;
      toast.textContent = text;
      toast.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        try {
          if (state.ui && state.ui.toast) state.ui.toast.hidden = true;
        } catch (err) {
          /* ignore */
        }
      }, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 3200);
    } catch (err) {
      /* ignore */
    }
  }

  function buildPanel() {
    var ui = state.ui;
    var panel = make('div', {
      class: 'dsh-panel',
      role: 'dialog',
      'aria-label': t('appName')
    });
    panel.hidden = true;

    var title = make('span', { class: 'dsh-title', text: t('appName') });
    var closeBtn = make('button', {
      type: 'button',
      class: 'dsh-icon-btn',
      'aria-label': t('close'),
      title: t('close'),
      text: '✕',
      onClick: function () {
        safe(closePanel);
      }
    });
    panel.appendChild(make('div', { class: 'dsh-panel-head' }, [title, closeBtn]));

    // 模式三按钮
    var modeButtons = [];
    var seg = make('div', { class: 'dsh-seg', role: 'group', 'aria-label': 'mode' });
    for (var i = 0; i < MODES.length; i++) {
      (function (mode) {
        var button = make('button', {
          type: 'button',
          class: 'dsh-seg-btn',
          'data-mode': mode,
          'aria-pressed': 'false',
          onClick: function () {
            safe(function () {
              applyMode(mode, true);
              refreshUi();
            });
          }
        });
        button.textContent = t(MODE_KEYS[mode]);
        modeButtons.push(button);
        seg.appendChild(button);
      })(MODES[i]);
    }
    panel.appendChild(seg);

    // 目标语言
    var langSelect = make('select', { class: 'dsh-select', 'aria-label': t('targetLanguage') });
    for (var j = 0; j < LANGUAGES.length; j++) {
      var option = document.createElement('option');
      option.value = LANGUAGES[j].code;
      option.textContent = LANGUAGES[j].native;
      langSelect.appendChild(option);
    }
    langSelect.value = state.targetLanguage;
    langSelect.addEventListener('change', function () {
      safe(function () {
        var code = findLanguage(langSelect.value) ? langSelect.value : 'zh-CN';
        state.targetLanguage = code;
        state.effectiveTarget = code;
        state.settings.targetLanguage = code;
        storageSet({ targetLanguage: code });
        setStatus(t('statusLangUpdated'), '');
        refreshUi();
      });
    });
    panel.appendChild(make('div', { class: 'dsh-row' }, [
      make('span', { class: 'dsh-label', text: t('targetLanguage') }),
      langSelect
    ]));

    // 当前模型（只读）
    var model = make('span', { class: 'dsh-model', text: t('modelUnknown') });
    panel.appendChild(make('div', { class: 'dsh-row' }, [
      make('span', { class: 'dsh-label', text: t('model') }),
      model
    ]));

    // Token 消耗：本页（实时累加） / 今日（GET /usage，旧版 Host 缺失时隐藏该行）
    var tokensPageLabel = make('span', { class: 'dsh-label', text: t('tokensPage') });
    var tokensPage = make('span', { class: 'dsh-tokens', text: t('modelUnknown') });
    var tokensPageRow = make('div', { class: 'dsh-row', 'data-role': 'tokens-page' }, [tokensPageLabel, tokensPage]);
    panel.appendChild(tokensPageRow);

    var tokensTodayLabel = make('span', { class: 'dsh-label', text: t('tokensToday') });
    var tokensToday = make('span', { class: 'dsh-tokens' });
    var tokensTodayRow = make('div', {
      class: 'dsh-row',
      'data-role': 'tokens-today',
      hidden: true
    }, [tokensTodayLabel, tokensToday]);
    panel.appendChild(tokensTodayRow);

    // 操作按钮
    var translateBtn = make('button', {
      type: 'button',
      class: 'dsh-btn primary',
      text: t('translate'),
      onClick: function () {
        safe(function () {
          return startTranslate({});
        });
      }
    });
    var stopBtn = make('button', {
      type: 'button',
      class: 'dsh-btn',
      text: t('stop'),
      disabled: 'disabled',
      onClick: function () {
        safe(stopTranslate);
      }
    });
    var restoreBtn = make('button', {
      type: 'button',
      class: 'dsh-btn warn',
      text: t('restore'),
      disabled: 'disabled',
      onClick: function () {
        safe(restoreAll);
      }
    });
    panel.appendChild(make('div', { class: 'dsh-actions' }, [translateBtn, stopBtn, restoreBtn]));

    // 进度
    var barFill = make('i');
    var progressNum = make('span', { class: 'dsh-progress-num', text: '0 / 0' });
    panel.appendChild(make('div', { class: 'dsh-progress' }, [
      make('div', { class: 'dsh-bar' }, [barFill]),
      progressNum
    ]));

    // 状态 / 错误行
    var status = make('div', { class: 'dsh-status', role: 'status', 'aria-live': 'polite' });
    panel.appendChild(status);

    // 本站自动翻译 + 当前域名悬浮球开关
    var autoSiteBtn = make('button', {
      type: 'button',
      class: 'dsh-link',
      'data-role': 'auto-site',
      text: t('autoSiteEnable'),
      onClick: function () {
        safe(toggleCurrentSiteAutoTranslate);
      }
    });
    var domainBallBtn = make('button', {
      type: 'button',
      class: 'dsh-link',
      'data-role': 'domain-ball',
      text: t('ballDomainHide'),
      onClick: function () {
        safe(toggleCurrentDomainBall);
      }
    });
    panel.appendChild(make('div', { class: 'dsh-domain-row' }, [autoSiteBtn, domainBallBtn]));

    // 隐私提示
    var privacy = make('div', { class: 'dsh-privacy', text: t('privacy') });
    panel.appendChild(privacy);

    // 底部：设置 + 版本
    var settingsBtn = make('button', {
      type: 'button',
      class: 'dsh-link',
      text: t('settings'),
      onClick: function () {
        safe(openOptionsPage);
      }
    });
    var hideBallBtn = make('button', {
      type: 'button',
      class: 'dsh-link',
      'data-role': 'hide-ball',
      text: t('hideBall'),
      onClick: function () {
        safe(hideFloatingBall);
      }
    });
    var version = make('span', { class: 'dsh-ver', text: 'v' + EXT_VERSION });
    panel.appendChild(
      make('div', { class: 'dsh-foot' }, [
        make('span', { class: 'dsh-foot-links' }, [settingsBtn, hideBallBtn]),
        version
      ])
    );

    state.root.appendChild(panel);

    ui.panel = panel;
    ui.autoSiteBtn = autoSiteBtn;
    ui.domainBallBtn = domainBallBtn;
    updateAutoSiteButton();
    updateDomainBallButton();
    ui.panelTitle = title;
    ui.modeButtons = modeButtons;
    ui.langSelect = langSelect;
    ui.model = model;
    ui.tokensPage = tokensPage;
    ui.tokensPageLabel = tokensPageLabel;
    ui.tokensPageRow = tokensPageRow;
    ui.tokensToday = tokensToday;
    ui.tokensTodayLabel = tokensTodayLabel;
    ui.tokensTodayRow = tokensTodayRow;
    ui.translateBtn = translateBtn;
    ui.stopBtn = stopBtn;
    ui.restoreBtn = restoreBtn;
    ui.progressNum = progressNum;
    ui.bar = barFill;
    ui.status = status;
    ui.privacy = privacy;
    ui.settingsBtn = settingsBtn;
    ui.version = version;
  }

  function buildCard() {
    var ui = state.ui;
    var card = make('div', {
      class: 'dsh-card',
      role: 'dialog',
      'aria-label': t('cardTitle')
    });
    card.hidden = true;

    var closeBtn = make('button', {
      type: 'button',
      class: 'dsh-icon-btn dsh-card-close',
      'aria-label': t('close'),
      title: t('close'),
      text: '✕',
      onClick: function () {
        closeCard();
      }
    });
    var src = make('div', { class: 'dsh-card-src' });
    var loading = make('div', { class: 'dsh-card-loading', text: t('cardLoading') });
    var trans = make('div', { class: 'dsh-card-trans' });
    var phon = make('div', { class: 'dsh-card-phon' });
    var dict = make('div', { class: 'dsh-card-dict' });
    var playBtn = make('button', {
      type: 'button',
      class: 'dsh-btn',
      title: t('cardPlay'),
      'aria-label': t('cardPlay'),
      text: '🔊',
      onClick: function () {
        safe(playCardAudio);
      }
    });
    var addBtn = make('button', {
      type: 'button',
      class: 'dsh-btn primary',
      text: t('cardAdd'),
      onClick: function () {
        safe(addCardToWordbook);
      }
    });
    var cardStatus = make('div', { class: 'dsh-card-status' });
    var cardTokens = make('div', { class: 'dsh-card-tokens', hidden: true });
    var body = make('div', { class: 'dsh-card-body' }, [
      trans,
      phon,
      dict,
      make('div', { class: 'dsh-card-actions' }, [playBtn, addBtn]),
      cardTokens,
      cardStatus
    ]);
    body.hidden = true;

    card.appendChild(closeBtn);
    card.appendChild(src);
    card.appendChild(loading);
    card.appendChild(body);
    state.root.appendChild(card);

    ui.card = card;
    ui.cardSrc = src;
    ui.cardLoading = loading;
    ui.cardBody = body;
    ui.cardTrans = trans;
    ui.cardPhon = phon;
    ui.cardDict = dict;
    ui.cardStatus = cardStatus;
    ui.cardTokens = cardTokens;
    ui.cardPlay = playBtn;
    ui.cardAdd = addBtn;
  }

  function updateUiText() {
    var ui = state.ui;
    if (!ui) return;
    try {
      if (ui.bubble) {
        ui.bubble.setAttribute('aria-label', t('bubbleTitle'));
        ui.bubble.setAttribute('title', t('toggleTitle'));
        updateDomainBallButton();
      }
      if (ui.panelTitle) ui.panelTitle.textContent = t('appName');
      for (var i = 0; i < ui.modeButtons.length; i++) {
        var mode = ui.modeButtons[i].getAttribute('data-mode');
        ui.modeButtons[i].textContent = t(MODE_KEYS[mode] || 'modeBilingual');
      }
      if (ui.privacy) ui.privacy.textContent = t('privacy');
      if (ui.settingsBtn) ui.settingsBtn.textContent = t('settings');
      if (ui.tokensPageLabel) ui.tokensPageLabel.textContent = t('tokensPage');
      if (ui.tokensTodayLabel) ui.tokensTodayLabel.textContent = t('tokensToday');
      if (ui.langSelect) ui.langSelect.setAttribute('aria-label', t('targetLanguage'));
      if (ui.panel) ui.panel.setAttribute('aria-label', t('appName'));
      if (ui.card) ui.card.setAttribute('aria-label', t('cardTitle'));
      if (ui.cardLoading) ui.cardLoading.textContent = t('cardLoading');
      if (ui.cardTokens && state.cardState && state.cardState.usage) setCardTokens(state.cardState.usage);
      var play = ui.cardPlay;
      if (play) {
        play.setAttribute('title', t('cardPlay'));
        play.setAttribute('aria-label', t('cardPlay'));
      }
    } catch (err) {
      /* UI 文案更新失败不影响主流程 */
    }
  }

  function updateModeButtons() {
    var ui = state.ui;
    if (!ui || !ui.modeButtons) return;
    for (var i = 0; i < ui.modeButtons.length; i++) {
      var mode = ui.modeButtons[i].getAttribute('data-mode');
      var active = mode === state.mode;
      ui.modeButtons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function updateProgressUi() {
    var ui = state.ui;
    if (!ui) return;
    try {
      if (ui.progressNum) ui.progressNum.textContent = t('progress', { done: state.done, total: state.total });
      if (ui.bar) {
        var percent = state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
        ui.bar.style.width = percent + '%';
      }
      if (ui.bubble) {
        var busy = state.running || state.starting === true;
        var progress = state.total > 0 ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
        if (busy) {
          ui.bubble.classList.add('dsh-bubble-busy');
          ui.bubble.style.setProperty('--dsh-bubble-progress', String(progress));
          if (state.total > 0) {
            ui.bubble.textContent = progress + '%';
            ui.bubble.setAttribute('aria-label', t('bubbleProgress', { done: state.done, total: state.total, percent: progress }));
            ui.bubble.setAttribute('title', t('bubbleProgress', { done: state.done, total: state.total, percent: progress }));
          } else {
            ui.bubble.textContent = '…';
            ui.bubble.setAttribute('aria-label', t('bubbleLoading'));
            ui.bubble.setAttribute('title', t('bubbleLoading'));
          }
        } else {
          ui.bubble.classList.remove('dsh-bubble-busy');
          ui.bubble.style.removeProperty('--dsh-bubble-progress');
          ui.bubble.textContent = '译';
          ui.bubble.setAttribute('aria-label', t('bubbleTitle'));
          ui.bubble.setAttribute('title', t('toggleTitle'));
        }
      }
    } catch (err) {
      /* ignore */
    }
  }

  function setStatus(text, kind) {
    state.statusText = typeof text === 'string' ? text : '';
    state.statusKind = kind || '';
    var el = state.ui && state.ui.status;
    if (el) {
      el.textContent = state.statusText;
      el.className = 'dsh-status' + (state.statusKind ? ' is-' + state.statusKind : '');
    }
  }

  function hasTranslations() {
    return state.injectedNodes.size > 0;
  }

  function refreshUi() {
    var ui = state.ui;
    if (!ui) return;
    try {
      updateModeButtons();
      if (ui.model) ui.model.textContent = state.modelLabel || t('modelUnknown');
      updateTokenRows();
      if (ui.langSelect && findLanguage(state.targetLanguage) && ui.langSelect.value !== state.targetLanguage) {
        ui.langSelect.value = state.targetLanguage;
      }
      if (ui.translateBtn) {
        ui.translateBtn.disabled = state.running;
        ui.translateBtn.textContent = state.running
          ? t('translating')
          : hasTranslations()
            ? t('retranslate')
            : t('translate');
      }
      if (ui.stopBtn) ui.stopBtn.disabled = !(state.running || state.lazyActive);
      if (ui.restoreBtn) ui.restoreBtn.disabled = !(state.running || state.lazyActive || hasTranslations());
      if (ui.bubble) {
        ui.bubble.setAttribute('data-active', state.running || state.lazyActive || hasTranslations() ? 'true' : 'false');
      }
      updateProgressUi();
      applyBallSiteVisibility();
      if (ui.status) {
        ui.status.textContent = state.statusText;
        ui.status.className = 'dsh-status' + (state.statusKind ? ' is-' + state.statusKind : '');
      }
    } catch (err) {
      /* ignore */
    }
  }

  function openPanel() {
    if (!state.ui || !state.ui.panel) return;
    state.ui.panel.hidden = false;
    state.panelOpen = true;
    maybeRefreshModel();
    refreshTodayUsage();
  }

  function closePanel() {
    if (!state.ui || !state.ui.panel) return;
    state.ui.panel.hidden = true;
    state.panelOpen = false;
  }

  function togglePanel() {
    if (state.panelOpen) closePanel();
    else openPanel();
  }

  /* ================================================================ */
  /* DSH 设置（当前模型只读展示）                                        */
  /* ================================================================ */

  function applyRemoteSettings(data) {
    if (!data || typeof data !== 'object') return;
    var settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
    var selected = data.selected && typeof data.selected === 'object' ? data.selected : {};
    var modelInfo = data.modelInfo && typeof data.modelInfo === 'object' ? data.modelInfo : {};

    var provider = selected.provider || modelInfo.provider || settings.provider || '';
    var model = selected.model || modelInfo.model || settings.model || '';
    var effort = selected.reasoningEffort || settings.reasoningEffort || '';

    if (provider && model) state.modelLabel = provider + '/' + model + (effort ? ' · ' + effort : '');
    else if (model) state.modelLabel = model;
    else state.modelLabel = '';

    if (settings.targetLanguage) {
      state.remoteTarget = settings.targetLanguage;
      if (!findLanguage(state.targetLanguage) || !state.targetLanguage) {
        state.effectiveTarget = state.remoteTarget;
      }
    }
    state.modelFetchedAt = Date.now();
    refreshUi();
  }

  function refreshDshSettings(showStatus) {
    return rpc('settings', {}).then(
      function (data) {
        applyRemoteSettings(data);
        if (showStatus) {
          setStatus(state.modelLabel ? t('statusModelOk', { model: state.modelLabel }) : t('statusIdle'), 'ok');
        }
        refreshUi();
      },
      function (err) {
        state.modelLabel = '';
        state.modelFetchedAt = Date.now();
        if (showStatus) setStatus(t('statusSettingsFail', { msg: errorText(err) }), 'error');
        refreshUi();
      }
    );
  }

  function maybeRefreshModel() {
    if (state.running) return;
    if (state.modelFetchedAt && Date.now() - state.modelFetchedAt < 30000) return;
    safe(function () {
      return refreshDshSettings(false);
    });
  }

  /* ================================================================ */
  /* Token 消耗（本页 / 今日，供浮窗展示）                               */
  /* ================================================================ */

  var USAGE_REFRESH_MS = 60000;

  function emptyPageUsage() {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cached: 0 };
  }

  function numberOrZero(value) {
    var num = typeof value === 'number' ? value : Number(value);
    if (!isFinite(num) || num <= 0) return 0;
    return Math.round(num);
  }

  /** 归一化 Host 返回的 usage 四字段（缺失 / 非法 → 0） */
  function normalizeUsage(usage) {
    var src = usage && typeof usage === 'object' ? usage : {};
    return {
      inputTokens: numberOrZero(src.inputTokens),
      outputTokens: numberOrZero(src.outputTokens),
      cacheReadTokens: numberOrZero(src.cacheReadTokens),
      cacheWriteTokens: numberOrZero(src.cacheWriteTokens)
    };
  }

  function formatTokens(value) {
    var num = numberOrZero(value);
    try {
      return num.toLocaleString();
    } catch (err) {
      return String(num);
    }
  }

  function resetPageTokenStats() {
    state.tokenStats.page = emptyPageUsage();
    state.tokenStats.last = null;
  }

  /** 一次成功的 translate 响应：累计本页 token / 请求数 / 缓存命中 */
  function accumulatePageUsage(usage, cached) {
    var stats = state.tokenStats;
    var normalized = normalizeUsage(usage);
    stats.page.requests += 1;
    if (cached === true) stats.page.cached += 1;
    stats.page.inputTokens += normalized.inputTokens;
    stats.page.outputTokens += normalized.outputTokens;
    stats.last = {
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cacheReadTokens: normalized.cacheReadTokens,
      cacheWriteTokens: normalized.cacheWriteTokens,
      cached: cached === true,
      at: Date.now()
    };
  }

  function pageTokenTotal() {
    return state.tokenStats.page.inputTokens + state.tokenStats.page.outputTokens;
  }

  function pageTokensText() {
    var page = state.tokenStats.page;
    return (
      t('tokensInput') +
      ' ' +
      formatTokens(page.inputTokens) +
      ' · ' +
      t('tokensOutput') +
      ' ' +
      formatTokens(page.outputTokens)
    );
  }

  function pageTokensTitle() {
    var page = state.tokenStats.page;
    return t('tokensRequests', { count: page.requests }) + ' · ' + t('tokensCache', { count: page.cached });
  }

  /** 翻译完成状态行：有 usage 时追加本页 token 摘要，否则回退到 statusDone */
  function setDoneStatus() {
    var total = pageTokenTotal();
    if (state.tokenStats.page.requests > 0 && total > 0) {
      setStatus(t('statusDoneTokens', { tokens: formatTokens(total) }), 'ok');
    } else {
      setStatus(t('statusDone'), 'ok');
    }
  }

  function todayTokenTotal() {
    var today = state.tokenStats.today;
    if (!today) return 0;
    return numberOrZero(today.inputTokens) + numberOrZero(today.outputTokens);
  }

  function todayTokensTitle() {
    var today = state.tokenStats.today;
    if (!today) return '';
    return (
      t('tokensInput') +
      ' ' +
      formatTokens(today.inputTokens) +
      ' · ' +
      t('tokensOutput') +
      ' ' +
      formatTokens(today.outputTokens) +
      ' · ' +
      t('tokensRequests', { count: today.requests })
    );
  }

  /** 刷新「今日累计」：打开面板时触发，节流 60s；404 / 任何失败静默隐藏该行 */
  function refreshTodayUsage() {
    var stats = state.tokenStats;
    var now = Date.now();
    if (stats.todayFetchedAt && now - stats.todayFetchedAt < USAGE_REFRESH_MS) return;
    stats.todayFetchedAt = now;
    rpc('usage', { days: 2 }).then(
      function (data) {
        var usage = data && typeof data === 'object' ? data.usage : null;
        var today = usage && usage.today && typeof usage.today === 'object' ? usage.today : null;
        stats.today = today
          ? {
              requests: numberOrZero(today.requests),
              inputTokens: numberOrZero(today.inputTokens),
              outputTokens: numberOrZero(today.outputTokens),
              cached: numberOrZero(today.cached)
            }
          : null;
        refreshUi();
      },
      function () {
        /* 旧版 Host / 接口异常：隐藏「今日累计」，不打断翻译与状态行 */
        stats.today = null;
        refreshUi();
      }
    );
  }

  /** 刷新浮窗中的「本页消耗 / 今日累计」两行 */
  function updateTokenRows() {
    var ui = state.ui;
    if (!ui) return;
    try {
      var page = state.tokenStats.page;
      if (ui.tokensPage) {
        if (page.requests > 0) {
          ui.tokensPage.textContent = pageTokensText();
          ui.tokensPage.setAttribute('title', pageTokensTitle());
        } else {
          ui.tokensPage.textContent = t('modelUnknown');
          ui.tokensPage.removeAttribute('title');
        }
      }
      if (ui.tokensTodayRow) {
        var today = state.tokenStats.today;
        ui.tokensTodayRow.hidden = !today;
        if (ui.tokensToday) {
          if (today) {
            ui.tokensToday.textContent = formatTokens(todayTokenTotal()) + ' ' + t('tokensUnit');
            ui.tokensToday.setAttribute('title', todayTokensTitle());
          } else {
            ui.tokensToday.textContent = '';
            ui.tokensToday.removeAttribute('title');
          }
        }
      }
    } catch (err) {
      /* Token 行渲染失败不影响面板其它功能 */
    }
  }

  /** 查词卡「本次查询 输入 X · 输出 Y tokens」 */
  function setCardTokens(usage) {
    var ui = state.ui;
    if (!ui || !ui.cardTokens) return;
    if (!usage || typeof usage !== 'object') {
      ui.cardTokens.hidden = true;
      ui.cardTokens.textContent = '';
      return;
    }
    var normalized = normalizeUsage(usage);
    ui.cardTokens.hidden = false;
    ui.cardTokens.textContent = t('cardTokens', {
      input: formatTokens(normalized.inputTokens),
      output: formatTokens(normalized.outputTokens)
    });
  }

  /* ================================================================ */
  /* 翻译流水线                                                        */
  /* ================================================================ */

  /* ---------------------------------------------------------------- */
  /* 调度配置：按屏触发（默认） / 按块懒加载（省 token）                  */
  /* ---------------------------------------------------------------- */

  /** preload 系数：none=0 / half=0.5 / one=1（默认 one = 视口下方一屏） */
  function getPreloadFactor() {
    var preload = state.settings && state.settings.preload;
    return PRELOAD_FACTORS[preload] != null ? PRELOAD_FACTORS[preload] : 1;
  }

  /** 调度模式：screen（默认，按屏触发） / block（按块懒加载 + 微批合并） */
  function isScreenScheduleMode() {
    return !(state.settings && state.settings.scheduleMode === 'block');
  }

  /** IntersectionObserver 的底部预载 margin（按 preload 设置；block 模式逐块入队用） */
  function preloadRootMargin() {
    var factor = getPreloadFactor();
    if (factor >= 1) return '0px 0px 100% 0px';
    if (factor >= 0.5) return '0px 0px 50% 0px';
    return '0px 0px 0px 0px';
  }

  /** 断开观察器并清理调度状态（含微批合并/按屏扫描定时器与 scroll/resize 监听） */
  function disconnectLazy() {
    try {
      if (state.io && typeof state.io.disconnect === 'function') state.io.disconnect();
    } catch (err) {
      /* ignore */
    }
    detachScreenListeners(state.lazy);
    clearCoalesceTimer(state.lazy);
    clearScreenScanTimer(state.lazy);
    state.io = null;
    state.lazy = null;
    state.blocksByEl = null;
    state.lazyActive = false;
  }

  /**
   * 当前“屏幕窗口”内的 pending 单元：视口 + preload（none/half/one 屏）。
   * 按文档顺序返回；两种调度模式共用。
   */
  function collectScreenUnits() {
    var vh = window.innerHeight || 800;
    var bottomLimit = vh * (1 + getPreloadFactor());
    var hits = [];
    for (var i = 0; i < state.units.length; i++) {
      var unit = state.units[i];
      if (unit.status !== 'pending') continue;
      if (!unit.anchorEl || !unit.anchorEl.isConnected) continue;
      var rect;
      try {
        rect = unit.anchorEl.getBoundingClientRect();
      } catch (err) {
        continue;
      }
      if (rect.bottom > 0 && rect.top < bottomLimit) hits.push(unit);
    }
    hits.sort(function (a, b) { return a.index - b.index; });
    return hits;
  }

  /** 单元入队（幂等：只有 pending 才入队；不负责调度） */
  function queueUnit(lazy, unit) {
    if (!lazy || !unit || unit.status !== 'pending') return false;
    if (!unit.anchorEl || !unit.anchorEl.isConnected) return false;
    unit.status = 'queued';
    lazy.queue.push(unit);
    return true;
  }

  /** block 模式首屏：当前视口 + preload 逐块入队（走微批合并调度，保持旧行为） */
  function enqueueVisibleWindow(session) {
    var hits = collectScreenUnits();
    for (var i = 0; i < hits.length; i++) enqueueBlock(session, hits[i]);
  }

  /** screen 模式：把当前屏幕窗口内所有 pending 单元一次入队（调用方随后立即 pump） */
  function enqueueScreenWindow(session) {
    var lazy = state.lazy;
    if (!lazy || lazy.session !== session || state.stopFlag) return 0;
    var hits = collectScreenUnits();
    var queued = 0;
    for (var i = 0; i < hits.length; i++) {
      if (queueUnit(lazy, hits[i])) queued++;
    }
    return queued;
  }

  /** 清理微批合并定时器（停止/还原/会话重置/页面跳转时必须调用） */
  function clearCoalesceTimer(lazy) {
    if (!lazy) return;
    if (lazy.timer) {
      try {
        clearTimeout(lazy.timer);
      } catch (err) {
        /* ignore */
      }
      lazy.timer = null;
    }
    lazy.coalesceFirstAt = 0;
  }

  /** 清理按屏扫描（滚动停稳防抖）定时器 */
  function clearScreenScanTimer(lazy) {
    if (!lazy) return;
    if (lazy.scanTimer) {
      try {
        clearTimeout(lazy.scanTimer);
      } catch (err) {
        /* ignore */
      }
      lazy.scanTimer = null;
    }
  }

  /** 按屏模式：挂 scroll/resize 监听（会话结束时 detach） */
  function attachScreenListeners(lazy) {
    if (!lazy) return;
    lazy.onScreenScroll = function () {
      scheduleScreenScan();
    };
    lazy.onScreenResize = function () {
      scheduleScreenScan();
    };
    try {
      window.addEventListener('scroll', lazy.onScreenScroll, { passive: true });
      window.addEventListener('resize', lazy.onScreenResize, { passive: true });
    } catch (err) {
      lazy.onScreenScroll = null;
      lazy.onScreenResize = null;
    }
  }

  /** 移除按屏模式的 scroll/resize 监听 */
  function detachScreenListeners(lazy) {
    if (!lazy) return;
    try {
      if (lazy.onScreenScroll) window.removeEventListener('scroll', lazy.onScreenScroll);
      if (lazy.onScreenResize) window.removeEventListener('resize', lazy.onScreenResize);
    } catch (err) {
      /* ignore */
    }
    lazy.onScreenScroll = null;
    lazy.onScreenResize = null;
  }

  /**
   * 按屏模式：滚动/缩放/observer 失效后，等停稳（防抖 ~140ms）再扫描整屏。
   * 快速连续滚动期间定时器不断被重置，因此不会翻译中间屏幕。
   */
  function scheduleScreenScan() {
    var lazy = state.lazy;
    if (!lazy || !state.lazyActive || state.stopFlag) return;
    if (!isScreenScheduleMode()) return;
    var session = lazy.session;
    clearScreenScanTimer(lazy);
    lazy.scanTimer = setTimeout(function () {
      lazy.scanTimer = null;
      // 会话/页面已重置（停止、还原、重新翻译、跳转）后不再触发
      if (!state.lazy || state.lazy !== lazy || lazy.session !== session || state.stopFlag) return;
      flushScreenWindow(session, true);
    }, SCREEN_SCAN_DEBOUNCE_MS);
  }

  /** 按屏模式：扫描当前屏 + 立即发送（首屏不等待；滚动停稳后只补当前屏） */
  function flushScreenWindow(session, allowMerge) {
    var lazy = state.lazy;
    if (!lazy || lazy.session !== session || state.stopFlag) return;
    if (allowMerge) mergeNewUnits(session);
    enqueueScreenWindow(session);
    clearCoalesceTimer(lazy);
    pumpLazy(session);
  }

  /**
   * 按屏模式：重新扫描 DOM，把运行时新增（无限滚动 / 动态渲染）的单元追加到 state.units。
   * 已登记、已注入、已标记的单元不会重复加入（不会重复翻译）。
   */
  function mergeNewUnits(session) {
    var lazy = state.lazy;
    if (!lazy || lazy.session !== session || state.stopFlag) return 0;
    var scanned;
    try {
      scanned = scanAgain();
    } catch (err) {
      return 0;
    }
    var fresh = (scanned.blocks || []).concat(scanned.texts || []);
    if (!fresh.length) return 0;
    var knownAnchors = new Set();
    for (var i = 0; i < state.units.length; i++) {
      var known = state.units[i];
      if (known.anchorEl) knownAnchors.add(known.anchorEl);
      if (known.el) knownAnchors.add(known.el);
    }
    var added = 0;
    for (var j = 0; j < fresh.length; j++) {
      var unit = fresh[j];
      var anchor = unit.anchorEl;
      if (!anchor || !anchor.isConnected) continue;
      if (knownAnchors.has(anchor)) continue;
      try {
        if (anchor.closest && anchor.closest('[' + MARK_ATTR + ']')) continue;
      } catch (err) {
        continue;
      }
      knownAnchors.add(anchor);
      unit.status = 'pending';
      unit.index = state.units.length;
      state.units.push(unit);
      if (state.blocksByEl && anchor) {
        if (!state.blocksByEl.has(anchor)) state.blocksByEl.set(anchor, []);
        state.blocksByEl.get(anchor).push(unit);
      }
      if (state.io) {
        try {
          state.io.observe(anchor);
        } catch (err) {
          /* ignore */
        }
      }
      added++;
    }
    if (added > 0) {
      state.total = state.units.length;
      updateProgressUi();
      refreshUi();
    }
    return added;
  }

  /** 当前队列中仍然有效的待发块数 / 字符数 */
  function queueStats(lazy) {
    var stats = { segments: 0, chars: 0 };
    if (!lazy || !lazy.queue) return stats;
    for (var i = 0; i < lazy.queue.length; i++) {
      var queued = lazy.queue[i];
      if (!queued || queued.status !== 'queued') continue;
      stats.segments++;
      stats.chars += queued.text ? queued.text.length : 0;
    }
    return stats;
  }

  /**
   * 调度入口（替代直接 pumpLazy）：
   *  - screen 模式：队列就是当前屏幕，达到/未达目标都立即发送（不做合并等待）；
   *  - block 模式：达到 ≈3 段 / ≈400 字符（或硬上限）→ 立即 pump，小队列等静默窗口
   *    BATCH_COALESCE_MS（每次新入队重置，但从首个块起最多等 BATCH_COALESCE_MAX_WAIT_MS）；
   *  - 没有空闲并发位时不空转定时器（批 settle 后会再次调度）。
   */
  function schedulePump(session, touched) {
    var lazy = state.lazy;
    if (!lazy || lazy.session !== session || state.stopFlag) return;
    var stats = queueStats(lazy);
    if (!stats.segments) {
      // 队列已空：清掉可能残留的定时器，交给 maybeFinishLazy 判断是否结束会话
      clearCoalesceTimer(lazy);
      maybeFinishLazy(session);
      return;
    }
    if (lazy.active >= CONCURRENCY) {
      // 两个并发位都在途：等 settle 后重新调度，避免空转定时器
      clearCoalesceTimer(lazy);
      return;
    }
    if (isScreenScheduleMode()) {
      // 按屏模式：整屏入队后立即发送，不等待微批合并窗口
      clearCoalesceTimer(lazy);
      pumpLazy(session);
      return;
    }
    var full = stats.segments >= BATCH_MAX_SEGMENTS || stats.chars >= BATCH_MAX_CHARS;
    var reachedMin =
      stats.segments >= BATCH_COALESCE_MIN_SEGMENTS || stats.chars >= BATCH_COALESCE_MIN_CHARS;
    if (full || reachedMin) {
      clearCoalesceTimer(lazy);
      pumpLazy(session);
      return;
    }
    var now = Date.now();
    if (!lazy.coalesceFirstAt) lazy.coalesceFirstAt = now;
    var deadline = lazy.coalesceFirstAt + BATCH_COALESCE_MAX_WAIT_MS;
    if (now >= deadline) {
      clearCoalesceTimer(lazy);
      pumpLazy(session);
      return;
    }
    if (lazy.timer && !touched) return; // 已有待触发的窗口，保持原计划
    if (lazy.timer) {
      try {
        clearTimeout(lazy.timer);
      } catch (err) {
        /* ignore */
      }
      lazy.timer = null;
    }
    var delay = Math.min(BATCH_COALESCE_MS, deadline - now);
    lazy.timer = setTimeout(function () {
      lazy.timer = null;
      lazy.coalesceFirstAt = 0;
      // 会话/队列已重置（停止、还原、重新翻译、页面跳转）后不再触发
      if (!state.lazy || state.lazy !== lazy || lazy.session !== session || state.stopFlag) return;
      if (lazy.active >= CONCURRENCY) return; // settle 会重新调度
      pumpLazy(session);
    }, delay);
  }

  /** 将单个翻译单元加入队列（幂等：只有 pending 才入队；block 模式走合并调度） */
  function enqueueBlock(session, unit) {
    var lazy = state.lazy;
    if (!lazy || lazy.session !== session || state.stopFlag) return;
    if (!queueUnit(lazy, unit)) return;
    schedulePump(session, true);
  }

  /** 从队列取出一批（段数/字符预算内），并标记为 translating */
  function takeBatch() {
    var lazy = state.lazy;
    var batch = [];
    var chars = 0;
    while (lazy.queue.length) {
      var block = lazy.queue.shift();
      if (!block || block.status !== 'queued') continue;
      if (batch.length && (batch.length >= BATCH_MAX_SEGMENTS || chars + block.text.length > BATCH_MAX_CHARS)) {
        lazy.queue.unshift(block);
        break;
      }
      block.status = 'translating';
      batch.push(block);
      chars += block.text.length;
    }
    return batch;
  }

  /** 调度器：保持最多 CONCURRENCY 个批次在途；队列空了等待滚动再触发 */
  function pumpLazy(session) {
    var lazy = state.lazy;
    if (!lazy || lazy.session !== session || state.stopFlag) return;
    while (lazy.active < CONCURRENCY && lazy.queue.length > 0) {
      var batch = takeBatch();
      if (!batch.length) break;
      if (!state.running) {
        state.running = true;
        setStatus(t('statusTranslating'), '');
        refreshUi();
      }
      lazy.active++;
      (function (taken) {
        var settle = function () {
          if (!state.lazy || state.lazy !== lazy) return;
          lazy.active--;
          updateProgressUi();
          refreshUi();
          // 队列里可能已有滚动/懒加载新入队的批次：按当前模式规则继续调度
          schedulePump(session, false);
          maybeFinishLazy(session);
        };
        processGroup(session, taken).then(settle, settle);
      })(batch);
    }
    maybeFinishLazy(session);
  }

  /** 队列空闲时：还有未进入视口的块 → 等待滚动；全部处理完 → 结束会话 */
  function maybeFinishLazy(session) {
    var lazy = state.lazy;
    if (!lazy || lazy.session !== session || state.stopFlag) return;
    // 还有待触发的合并窗口 / 按屏扫描：小批次即将发出，不能在此结束/停住会话
    if (lazy.timer || lazy.scanTimer) return;
    if (lazy.active > 0 || lazy.queue.length > 0) return;
    var pending = 0;
    for (var i = 0; i < state.units.length; i++) {
      if (state.units[i].status === 'pending') pending++;
    }
    if (pending > 0) {
      if (state.running) {
        state.running = false;
        refreshUi();
      }
      setStatus(t('statusLazyIdle'), '');
      return;
    }
    state.running = false;
    disconnectLazy();
    // 轨迹（Turn）：本次翻译 run 完成 → 结束当前 Turn（之后的单段重试会开启新 Turn）
    endTurn();
    if (state.failed > 0) setStatus(t('statusPartial', { failed: state.failed }), 'warn');
    else if (state.done > 0) setDoneStatus();
    refreshUi();
    startUrlWatch();
  }

  /** 文档顺序比较（块用 el，行内用 anchorEl） */
  function compareUnits(a, b) {
    if (a.anchorEl === b.anchorEl) return 0;
    try {
      var position = a.anchorEl.compareDocumentPosition(b.anchorEl);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    } catch (err) {
      /* ignore */
    }
    return 0;
  }

  /** 合并块级 + 行内单元并按文档顺序排序 */
  function buildUnits(scanned) {
    var units = (scanned.blocks || []).concat(scanned.texts || []);
    units.sort(compareUnits);
    for (var i = 0; i < units.length; i++) units[i].index = i;
    return units;
  }

  /**
   * 启动翻译会话：
   *  - screen（默认）：首屏整屏（+preload）一次入队立即发送；滚动/缩放停稳后重扫当前屏；
   *  - block：逐块入队 + 微批合并（旧行为），preload 同时作用于 observer rootMargin 与首屏窗口。
   */
  function startLazy(session) {
    // 上一次会话可能还有 pending 的合并窗口/扫描定时器（重新翻译/再次开始）：先清掉
    clearCoalesceTimer(state.lazy);
    clearScreenScanTimer(state.lazy);
    detachScreenListeners(state.lazy);
    var screenMode = isScreenScheduleMode();
    state.lazyActive = true;
    state.lazy = {
      session: session,
      queue: [],
      active: 0,
      timer: null,
      coalesceFirstAt: 0,
      scanTimer: null,
      onScreenScroll: null,
      onScreenResize: null
    };
    state.blocksByEl = new Map();
    for (var i = 0; i < state.units.length; i++) {
      var unit = state.units[i];
      unit.status = 'pending';
      if (unit.anchorEl) {
        if (!state.blocksByEl.has(unit.anchorEl)) state.blocksByEl.set(unit.anchorEl, []);
        state.blocksByEl.get(unit.anchorEl).push(unit);
      }
    }

    if (typeof IntersectionObserver === 'function') {
      try {
        state.io = new IntersectionObserver(function (entries) {
          if (!state.lazy || state.lazy.session !== session || state.stopFlag) return;
          if (screenMode) {
            // 按屏模式：observer 只做“失效通知”，等停稳防抖后再整屏重扫
            for (var k = 0; k < entries.length; k++) {
              if (entries[k].isIntersecting) {
                scheduleScreenScan();
                return;
              }
            }
            return;
          }
          var hits = [];
          for (var ki = 0; ki < entries.length; ki++) {
            var entry = entries[ki];
            if (!entry.isIntersecting) continue;
            var list = state.blocksByEl ? state.blocksByEl.get(entry.target) : null;
            if (!list) continue;
            for (var li = 0; li < list.length; li++) {
              if (list[li].status === 'pending') hits.push(list[li]);
            }
          }
          hits.sort(function (a, b) { return a.index - b.index; });
          for (var m = 0; m < hits.length; m++) enqueueBlock(session, hits[m]);
        }, { root: null, rootMargin: preloadRootMargin(), threshold: 0 });
        var observed = new Set();
        for (var j = 0; j < state.units.length; j++) {
          var anchor = state.units[j].anchorEl;
          if (!anchor || observed.has(anchor)) continue;
          observed.add(anchor);
          state.io.observe(anchor);
        }
      } catch (err) {
        state.io = null;
      }
    }

    if (screenMode) {
      // 首屏：整屏（+preload）一次入队并立即发送，不等待 coalescing 窗口
      flushScreenWindow(session, false);
      attachScreenListeners(state.lazy);
      return;
    }

    if (!state.io) {
      // 浏览器不支持 IntersectionObserver：退回“全部排队”（旧行为）
      for (var n = 0; n < state.units.length; n++) enqueueBlock(session, state.units[n]);
    } else {
      enqueueVisibleWindow(session);
    }
    // 首屏 burst 已在 enqueueBlock 内按合并规则处理；这里补一次调度，保证残留小批次也能发出
    schedulePump(session, false);
  }

  /**
   * translate / lookup 请求体的可选元数据：DSH 轨迹需要 client 与来源站点
   * （Host 侧校验见 DESIGN-TOKEN-USAGE §2.3.4：sourceUrl 为 http(s) 且 ≤2048 字符）。
   */
  function requestMeta() {
    var meta = { client: 'extension' };
    try {
      var href = String(location.href || '');
      // 超长 URL 直接省略 sourceUrl，避免 Host 校验失败导致整次翻译/查词被拒
      if (href && href.length <= 2048) meta.sourceUrl = href;
      meta.sourceTitle = String(document.title || '').slice(0, 200);
    } catch (err) {
      /* 取不到页面信息时只发 client */
    }
    return meta;
  }

  /**
   * 轨迹（Turn）：生成 Turn id（'tr' = 一次翻译动作，'lk' = 一次查词）。
   * 同一次翻译 run 内所有批次共用，Host 侧按 turnId 聚合成 DSH 风格的 Turn + Steps。
   */
  function makeTurnId(prefix) {
    var rand = Math.random().toString(36).slice(2, 8);
    return (prefix || 'tr') + '_' + Date.now().toString(36) + '_' + (rand || '0');
  }

  /** 结束当前翻译 Turn：清空 run 身份，之后的新请求会开启新的 Turn（单段重试 = 1 步 Turn） */
  function endTurn() {
    state.runId = '';
    state.runStep = 0;
  }

  function requestTranslations(group) {
    var texts = [];
    for (var i = 0; i < group.length; i++) texts.push(normalizeRequestText(group[i].text));
    // run 结束后（如红色占位单段重试）没有 runId：新建一个 tr_ Turn 并从 0 开始，让重试成为独立 Turn
    if (!state.runId) {
      state.runId = makeTurnId('tr');
      state.runStep = 0;
    }
    var payload = Object.assign({ texts: texts }, requestMeta(), {
      turnId: state.runId,
      stepIndex: state.runStep++,
      mode: state.mode
    });
    if (state.effectiveTarget) payload.targetLanguage = state.effectiveTarget;
    return rpc('translate', payload).then(function (data) {
      if (data && data.provider) {
        var label = data.provider + '/' + (data.model || '');
        if (!state.modelLabel) {
          state.modelLabel = label;
        }
      }
      // token 消耗累计（Host 记账口径：cached 请求 tokens 记 0；缺失字段按 0）
      if (data && typeof data === 'object') {
        accumulatePageUsage(data.usage, data.cached === true);
      }
      refreshUi();
      var translations = data && Array.isArray(data.translations) ? data.translations : null;
      if (!translations || translations.length !== group.length) {
        throw makeError('INVALID_MODEL_OUTPUT', t('errInvalidOutput'));
      }
      return translations;
    });
  }

  function processGroup(session, group) {
    if (state.stopFlag || session !== state.sessionId) return Promise.resolve();
    var failure = null;
    return requestTranslations(group).then(
      function (translations) {
        if (state.stopFlag || session !== state.sessionId) return;
        for (var i = 0; i < group.length; i++) {
          var block = group[i];
          var value = translations[i];
          var text = translationTextOf(value);
          if (!text) {
            failUnit(session, block, makeError('EMPTY_TRANSLATION', t('errEmptyTranslation')));
            continue;
          }
          if (isSameTranslation(block.text, text)) {
            // 专有名词/缩写等译名与原文相同：不再重复注入，避免 “ARM ARM”“Patreon Patreon”
            block.status = 'done';
            state.done++;
            continue;
          }
          try {
            if (injectUnit(block, text)) {
              block.status = 'done';
              state.done++;
            } else {
              block.status = 'failed';
              failUnit(session, block, makeError('INJECT_FAILED', t('errUnknown')));
            }
          } catch (err) {
            block.status = 'failed';
            failUnit(session, block, err);
          }
        }
        updateProgressUi();
        refreshUi();
      },
      function (err) {
        failure = err;
        if (state.stopFlag || session !== state.sessionId) return;
        if (group.length > 1) {
          // 失败组拆半重试，直到单段
          var mid = Math.ceil(group.length / 2);
          return processGroup(session, group.slice(0, mid)).then(function () {
            return processGroup(session, group.slice(mid));
          });
        }
        failUnit(session, group[0], failure);
      }
    );
  }

  /* 旧的全量流水线已由 startLazy / pumpLazy 的视口懒加载替代（buildGroups + runPipeline 移除） */
  function startTranslate(options) {
    var opts = options || {};
    if (state.running || state.starting) return Promise.resolve();
    state.starting = true;
    if (!opts.silent) openPanel();
    setStatus(t('statusChecking'), '');
    refreshUi();

    return rpc('health', {})
      .then(function () {
        // 读取 DSH 生效设置：模型只读展示 + 目标语言兜底
        return refreshDshSettings(false);
      })
      .then(function () {
        if (state.running) {
          state.starting = false;
          return null;
        }
        var sameLanguage = findSameLanguageContext();
        if (sameLanguage) {
          state.starting = false;
          setStatus(t('sameLanguageStatus', { page: sameLanguage.page, target: sameLanguage.target }), 'warn');
          refreshUi();
          showToast(t('sameLanguageHint', { page: sameLanguage.page, target: sameLanguage.target }), 3600);
          followAction('disable');
          if (!opts.silent) closePanel();
          return null;
        }
        clearTranslations();
        resetPageTokenStats();
        state.sessionId++;
        var session = state.sessionId;
        // 轨迹（Turn）：新的一次翻译动作 = 新 Turn；本 run 的懒加载批次共用这个 turnId
        state.runId = makeTurnId('tr');
        state.runStep = 0;
        state.running = true;
        state.stopFlag = false;
        state.done = 0;
        state.failed = 0;
        state.total = 0;
        setStatus(t('statusExtracting'), '');
        refreshUi();

        var scanned;
        try {
          scanned = scanAgain();
        } catch (err) {
          scanned = { blocks: [], texts: [], truncated: false };
        }
        if (session !== state.sessionId) return null;
        if (!scanned.blocks.length && !(scanned.texts && scanned.texts.length)) {
          state.running = false;
          endTurn();
          setStatus(t('statusNoBlocks'), 'warn');
          refreshUi();
          followAction('disable');
          return null;
        }
        state.units = buildUnits(scanned);
        state.total = state.units.length;
        for (var i = 0; i < state.units.length; i++) state.units[i].status = 'pending';
        ensurePageStyle();
        applyMode(state.mode, false);
        setStatus(
          scanned.truncated ? t('statusCapLimit', { max: MAX_BLOCKS }) : t('statusTranslating'),
          scanned.truncated ? 'warn' : ''
        );
        updateProgressUi();
        refreshUi();
        state.starting = false;
        // 懒加载未完成时也要监听 URL 变化（SPA 路由切换），否则状态会停在旧文案
        if (!IS_SUBFRAME) startUrlWatch();
        // 视口懒加载：只翻译当前视口 + 预载一屏，滚动时继续；不再一次性翻译整页
        startLazy(session);
        broadcastFrameTranslate(0);
        // 跟随翻译：当前页翻译成功后，后续经由链接打开/跳转的页面自动翻译
        followAction('enable');
        // 点击翻译后自动收起面板，只保留悬浮球（进度/状态可再次点开查看）
        if (!opts.silent) closePanel();
        return Promise.resolve();
      })
      .catch(function (err) {
        state.starting = false;
        if (state.running) {
          state.running = false;
          state.stopFlag = false;
        }
        var code = err && err.code;
        if (code === 'DSH_UNREACHABLE' || code === 'TIMEOUT') {
          setStatus(t('statusUnreachable', { msg: errorText(err) }), 'error');
        } else {
          setStatus(errorText(err), 'error');
        }
        refreshUi();
      });
  }

  function stopTranslate() {
    if (state.starting) {
      state.starting = false;
      state.sessionId++;
      setStatus(t('statusStopped'), '');
      refreshUi();
      return;
    }
    if (!state.running && !state.lazyActive) return;
    state.stopFlag = true;
    state.sessionId++; // 丢弃在途结果，但保留已注入译文
    disconnectLazy();
    state.running = false;
    // 轨迹（Turn）：停止 = 结束当前 Turn
    endTurn();
    setStatus(t('statusStopped'), 'warn');
    refreshUi();
  }

  function retryBlock(block) {
    if (!block || state.running) return;
    var session = state.sessionId;
    // 轨迹（Turn）：run 已结束时的单段重试 = 新的单步 Turn（requestTranslations 会新建 runId，成功/失败后清空）
    var retryTurn = !state.runId;
    block.status = 'translating';
    var placeholder = block.placeholder;
    if (placeholder && placeholder.isConnected) {
      placeholder.textContent = t('translating');
      placeholder.style.cursor = 'default';
    }
    safe(function () {
      return requestTranslations([block])
        .then(function (translations) {
          if (session !== state.sessionId) return;
          var value = translations[0];
          var text = translationTextOf(value);
          if (!text) throw makeError('EMPTY_TRANSLATION', t('errEmptyTranslation'));
          if (!isSameTranslation(block.text, text)) injectTranslation(block, text);
          if (placeholder && placeholder.isConnected) {
            state.injectedNodes.delete(placeholder);
            placeholder.remove();
          }
          block.placeholder = null;
          block.status = 'done';
          state.failed = Math.max(0, state.failed - 1);
          updateProgressUi();
          refreshUi();
          if (state.lazyActive && state.lazy) {
            schedulePump(state.lazy.session, false);
            maybeFinishLazy(state.lazy.session);
          } else if (state.failed === 0) {
            setDoneStatus();
          } else {
            setStatus(t('statusPartial', { failed: state.failed }), 'warn');
          }
          // 独立重试 Turn 完成：清空 runId，下一次重试/翻译重新开 Turn
          if (retryTurn) endTurn();
        })
        .catch(function (err) {
          if (session !== state.sessionId) return;
          block.status = 'failed';
          if (placeholder && placeholder.isConnected) {
            placeholder.textContent = t('failPrefix') + errorText(err) + t('failSuffix');
            placeholder.style.cursor = 'pointer';
          }
          setStatus(errorText(err), 'error');
          if (retryTurn) endTurn();
        });
    });
  }

  function restoreAll() {
    state.stopFlag = true;
    state.running = false;
    state.starting = false;
    state.sessionId++;
    // 轨迹（Turn）：还原 = 结束当前 Turn
    endTurn();
    stopUrlWatch();
    closeCard();
    removeImageTranslation();
    clearTranslations();
    postToChildFrames({ __dshItFrame: true, action: 'restore' });
    resetPageTokenStats();
    try {
      document.documentElement.removeAttribute(MODE_ATTR);
    } catch (err) {
      /* ignore */
    }
    setStatus(t('statusRestored'), 'ok');
    followAction('disable');
    refreshUi();
  }

  /**
   * 右键菜单：dsh翻译 → 原文 / 译文 / 双语对照。
   * 原文只切显示；译文/双语对照在未翻译时自动开始翻译。
   */
  function applyContextMode(mode) {
    if (MODES.indexOf(mode) === -1) return;
    applyMode(mode, true);
    refreshUi();
    if (mode === 'source') {
      if (state.running) stopTranslate();
      return;
    }
    if (state.running || state.lazyActive || hasTranslations()) return;
    startTranslate({});
  }

  /** 自定义快捷键：选中文本时翻译选区，无选中时按 Alt+T 同义切换整页 */
  function handleShortcutTranslate() {
    if (state.settings.shortcutTranslate !== true) {
      showToast(t('shortcutDisabled'), 3600);
      return;
    }
    try {
      var selection = window.getSelection();
      var text = selection && !selection.isCollapsed ? normalizeText(selection.toString()) : '';
      if (text && text.length <= MAX_SELECTION) {
        handleSelectionEvent(true);
        return;
      }
    } catch (err) {
      /* 选区异常时回退整页翻译 */
    }
    toggleTranslate();
  }

  function toggleTranslate() {
    if (state.running) {
      stopTranslate();
      return;
    }
    if (state.lazyActive || hasTranslations()) {
      restoreAll();
      return;
    }
    startTranslate({});
  }

  function openOptionsPage() {
    try {
      chrome.runtime.sendMessage({ type: 'dsh-it:open-options' }, function () {
        try {
          void chrome.runtime.lastError;
        } catch (err) {
          /* ignore */
        }
      });
    } catch (err) {
      setStatus(errorText(err), 'error');
    }
  }

  /* ================================================================ */
  /* 划词/双击查词卡                                                    */
  /* ================================================================ */

  function speechLangFor(text) {
    var counts = countScripts(text || '');
    if (!counts.total) return 'en-US';
    if (counts.han / counts.total > 0.4 && counts.kana / counts.total < 0.1) return 'zh-CN';
    if (counts.kana / counts.total > 0.1) return 'ja-JP';
    if (counts.hangul / counts.total > 0.3) return 'ko-KR';
    if (counts.cyrillic / counts.total > 0.4) return 'ru-RU';
    if (counts.arabic / counts.total > 0.4) return 'ar-SA';
    return 'en-US';
  }

  function speakSynth(text) {
    try {
      if (!text) return;
      var synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') return;
      synth.cancel();
      var utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = speechLangFor(text);
      utterance.rate = 0.95;
      synth.speak(utterance);
    } catch (err) {
      /* 语音不可用时静默 */
    }
  }

  function speak(text, audioUrl) {
    if (audioUrl) {
      try {
        var AudioCtor = window.Audio;
        if (typeof AudioCtor !== 'function') throw new Error('Audio unavailable');
        var audio = new AudioCtor(audioUrl);
        var played = audio.play();
        if (played && typeof played.catch === 'function') {
          played.catch(function () {
            speakSynth(text);
          });
        }
        return;
      } catch (err) {
        /* fallthrough to speechSynthesis */
      }
    }
    speakSynth(text);
  }

  function addableWord(text) {
    var value = String(text || '').trim();
    if (/^[A-Za-z][A-Za-z'’-]{0,40}$/.test(value)) return value;
    if (/^[\u4e00-\u9fff]{1,4}$/.test(value)) return value;
    return '';
  }

  function getSelectionContext() {
    try {
      var selection = window.getSelection();
      if (!selection || !selection.rangeCount) return '';
      var container = selection.getRangeAt(0).startContainer;
      var el = container && container.nodeType === 1 ? container : container ? container.parentElement : null;
      var steps = 0;
      while (el && steps < 10) {
        var tag = tagOf(el);
        if (BLOCK_TAGS.has(tag)) {
          var text = textOf(el);
          return text.length > 300 ? text.slice(0, 300) : text;
        }
        el = el.parentElement;
        steps++;
      }
      var fallback = normalizeText(selection.toString());
      return fallback.length > 300 ? fallback.slice(0, 300) : fallback;
    } catch (err) {
      return '';
    }
  }

  function setCardStatus(text, kind) {
    var ui = state.ui;
    if (!ui || !ui.cardStatus) return;
    ui.cardStatus.textContent = text || '';
    ui.cardStatus.className = 'dsh-card-status' + (kind ? ' is-' + kind : '');
  }

  function updateCardActions() {
    var ui = state.ui;
    var st = state.cardState;
    if (!ui || !st) return;
    var word = addableWord(st.text);
    if (ui.cardAdd) {
      if (st.added) {
        ui.cardAdd.disabled = true;
        ui.cardAdd.textContent = t('cardAdded');
        ui.cardAdd.classList.remove('primary');
      } else if (st.adding) {
        ui.cardAdd.disabled = true;
        ui.cardAdd.textContent = t('cardAdding');
      } else {
        ui.cardAdd.disabled = !word || !st.translation;
        ui.cardAdd.textContent = t('cardAdd');
        if (!st.translation) ui.cardAdd.setAttribute('title', t('cardNeedTranslation'));
        else if (!word) ui.cardAdd.setAttribute('title', t('cardAddHint'));
        else ui.cardAdd.removeAttribute('title');
        ui.cardAdd.classList.add('primary');
      }
    }
    if (ui.cardPlay) {
      ui.cardPlay.disabled = !(st.text || st.translation);
      ui.cardPlay.textContent = '🔊';
    }
  }

  function renderCardDictionary(dictionary) {
    var ui = state.ui;
    if (!ui || !ui.cardDict) return;
    ui.cardDict.textContent = '';
    if (!dictionary || !Array.isArray(dictionary.meanings)) return;
    var shown = 0;
    for (var i = 0; i < dictionary.meanings.length && shown < 3; i++) {
      var meaning = dictionary.meanings[i];
      if (!meaning) continue;
      if (meaning.partOfSpeech) {
        ui.cardDict.appendChild(make('span', { class: 'dsh-dict-pos', text: '[' + meaning.partOfSpeech + ']' }));
      }
      var definitions = Array.isArray(meaning.definitions) ? meaning.definitions : [];
      var list = make('ul', { class: 'dsh-dict-def' });
      for (var j = 0; j < definitions.length && j < 2; j++) {
        var def = definitions[j];
        var text = typeof def === 'string' ? def : def && def.definition ? String(def.definition) : '';
        if (!text) continue;
        list.appendChild(make('li', { text: text }));
        shown++;
      }
      if (list.firstChild) ui.cardDict.appendChild(list);
    }
  }

  function positionCard(anchorRect) {
    var ui = state.ui;
    if (!ui || !ui.card) return;
    var card = ui.card;
    var margin = 8;
    var viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    var viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    card.hidden = false;
    card.style.visibility = 'hidden';
    card.style.left = '0px';
    card.style.top = '0px';
    var rect = card.getBoundingClientRect();
    var width = rect.width || 330;
    var height = rect.height || 160;
    var left;
    var top;
    if (anchorRect) {
      left = anchorRect.left + anchorRect.width / 2 - width / 2;
      top = anchorRect.bottom + margin;
      if (top + height > viewportHeight - margin) top = anchorRect.top - height - margin;
      if (top < margin) top = Math.min(anchorRect.bottom + margin, viewportHeight - height - margin);
    } else {
      left = viewportWidth / 2 - width / 2;
      top = viewportHeight / 2 - height / 2;
    }
    left = clamp(left, margin, Math.max(margin, viewportWidth - width - margin));
    top = clamp(top, margin, Math.max(margin, viewportHeight - height - margin));
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
    card.style.visibility = '';
  }

  function closeCard() {
    state.cardToken++;
    state.cardState = null;
    var ui = state.ui;
    if (ui && ui.card) ui.card.hidden = true;
  }

  function showCardError(err) {
    var ui = state.ui;
    if (!ui) return;
    ui.cardLoading.hidden = true;
    ui.cardBody.hidden = true;
    setCardStatus(t('cardLookupFail', { msg: errorText(err) }), '');
  }

  function renderLookup(data) {
    var ui = state.ui;
    var st = state.cardState;
    if (!ui || !st) return;
    var result = data && data.result ? data.result : data || {};
    st.translation = typeof result.translation === 'string' ? result.translation : '';
    st.dictionary = result.dictionary && typeof result.dictionary === 'object' ? result.dictionary : null;
    st.phonetic = (st.dictionary && st.dictionary.phonetic) || result.phonetic || '';
    st.audioUrl = (st.dictionary && st.dictionary.audio) || result.audioUrl || '';
    st.usage = data && data.usage && typeof data.usage === 'object' ? data.usage : null;

    ui.cardLoading.hidden = true;
    ui.cardBody.hidden = false;
    ui.cardTrans.textContent = st.translation || t('cardNoResult');
    ui.cardPhon.textContent = st.phonetic || '';
    renderCardDictionary(st.dictionary);
    setCardTokens(st.usage);
    setCardStatus('', '');
    updateCardActions();
    positionCard(st.rect);
  }

  function openCard(text, rect) {
    var ui = state.ui;
    if (!ui || !ui.card) return;
    // 轨迹（Turn）：每次打开查词卡 = 一个单步 Turn（lk_…，stepIndex = 0）
    state.cardTurnId = makeTurnId('lk');
    state.cardState = {
      text: text,
      rect: rect,
      translation: '',
      phonetic: '',
      audioUrl: '',
      dictionary: null,
      usage: null,
      context: getSelectionContext(),
      added: false,
      adding: false
    };
    var token = ++state.cardToken;
    ui.cardSrc.textContent = text;
    ui.cardLoading.hidden = false;
    ui.cardLoading.textContent = t('cardLoading');
    ui.cardBody.hidden = true;
    setCardTokens(null);
    setCardStatus('', '');
    positionCard(rect);
    updateCardActions();

    var payload = Object.assign(
      {
        text: text,
        context: state.cardState.context,
        targetLanguage: state.effectiveTarget,
        turnId: state.cardTurnId,
        stepIndex: 0
      },
      requestMeta()
    );
    rpc('lookup', payload).then(
      function (data) {
        if (token !== state.cardToken) return;
        renderLookup(data);
      },
      function (err) {
        if (token !== state.cardToken) return;
        showCardError(err);
        positionCard(rect);
      }
    );
  }

  function playCardAudio() {
    var st = state.cardState;
    if (!st) return;
    speak(st.translation || st.text, st.audioUrl);
  }

  function addCardToWordbook() {
    var st = state.cardState;
    if (!st || st.adding || st.added) return;
    var word = addableWord(st.text);
    if (!word) {
      setCardStatus(t('cardAddHint'), '');
      return;
    }
    if (!st.translation) {
      setCardStatus(t('cardNeedTranslation'), '');
      return;
    }
    st.adding = true;
    setCardStatus('', '');
    updateCardActions();

    var payload = {
      word: word,
      translation: st.translation,
      targetLanguage: state.effectiveTarget,
      sourceUrl: location.href,
      sourceTitle: document.title || ''
    };
    if (st.phonetic) payload.phonetic = st.phonetic;
    if (st.audioUrl) payload.audioUrl = st.audioUrl;
    if (st.context) payload.context = st.context;
    if (st.dictionary) payload.dictionary = st.dictionary;

    rpc('wordbook/add', payload).then(
      function (data) {
        st.added = true;
        st.adding = false;
        setCardStatus(data && data.existed ? t('cardAddedExisted') : t('cardAdded'), 'ok');
        updateCardActions();
      },
      function (err) {
        st.adding = false;
        setCardStatus(t('cardAddFail', { msg: errorText(err) }), '');
        updateCardActions();
      }
    );
  }

  /* ================================================================ */
  /* SPA 监听（V1：提示重新翻译；scanAgain 预留给 MutationObserver）     */
  /* ================================================================ */

  function startUrlWatch() {
    if (state.urlWatchTimer) return;
    state.lastUrl = location.href;
    state.urlWatchTimer = setInterval(function () {
      try {
        if (location.href !== state.lastUrl) {
          state.lastUrl = location.href;
          onUrlChanged();
        }
      } catch (err) {
        /* ignore */
      }
    }, 1500);
  }

  function stopUrlWatch() {
    if (!state.urlWatchTimer) return;
    clearInterval(state.urlWatchTimer);
    state.urlWatchTimer = null;
  }

  function onUrlChanged() {
    // 轨迹（Turn）：页面跳转结束当前 Turn（停止在途批次，避免旧页面内容继续翻译）
    if (state.running || state.lazyActive) stopTranslate();
    endTurn();
    closeCard();
    removeImageTranslation();
    resetPageTokenStats();
    setStatus(t('statusNavigate'), 'warn');
    refreshUi();
  }

  /* ================================================================ */
  /* 事件绑定                                                          */
  /* ================================================================ */

  function isFromOurUi(event) {
    try {
      if (!state.host && !imageOverlay) return false;
      if (event.composedPath) {
        var path = event.composedPath();
        for (var i = 0; i < path.length; i++) {
          if (path[i] === state.host) return true;
          if (imageOverlay && path[i] === imageOverlay.host) return true;
        }
      }
      if (event.target === state.host) return true;
      return !!(imageOverlay && event.target === imageOverlay.host);
    } catch (err) {
      return false;
    }
  }

  function handleSelectionEvent(force) {
    try {
      var fromDoubleClick = Date.now() - (state.lastDoubleClickAt || 0) < 600;
      if (!force) {
        if (fromDoubleClick) {
          state.lastDoubleClickAt = 0;
          if (state.settings.doubleClickTranslate !== true) return;
        } else if (state.settings.selectionTranslate !== true) {
          return;
        }
      }
      var selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        if (state.cardState) closeCard();
        return;
      }
      var text = normalizeText(selection.toString());
      if (!text || text.length > MAX_SELECTION) {
        if (text.length > MAX_SELECTION && state.cardState) closeCard();
        return;
      }

      var range = selection.getRangeAt(0);
      var anchorEl =
        selection.anchorNode && selection.anchorNode.nodeType === 1
          ? selection.anchorNode
          : selection.anchorNode
            ? selection.anchorNode.parentElement
            : null;

      if (anchorEl) {
        if (anchorEl.getRootNode && anchorEl.getRootNode() === state.shadow) return;
        if (anchorEl.closest && anchorEl.closest('#' + HOST_ID)) return;
        if (anchorEl.isContentEditable) return;
        if (anchorEl.closest && anchorEl.closest('[contenteditable]:not([contenteditable="false"])')) return;
      }

      var rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
      }
      openCard(text, rect);
    } catch (err) {
      /* 选区异常时静默 */
    }
  }

  /** 右键菜单打开前记录选区，供“翻译选中文本”使用（菜单点击后选区可能已变化） */
  function onDocumentContextMenu(event) {
    if (isFromOurUi(event)) return;
    try {
      var target = event && event.target ? event.target : null;
      if (target && typeof target.closest === 'function') {
        var candidate = target.closest('img');
        lastContextImage = candidate && candidate.tagName === 'IMG' ? candidate : null;
      } else {
        lastContextImage = null;
      }
    } catch (err) {
      lastContextImage = null;
    }
    try {
      var selection = window.getSelection();
      var text = selection && !selection.isCollapsed ? normalizeText(selection.toString()) : '';
      var rect = null;
      if (text && selection.rangeCount) {
        var rangeRect = selection.getRangeAt(0).getBoundingClientRect();
        if (rangeRect && (rangeRect.width || rangeRect.height)) rect = rangeRect;
      }
      if (!rect && event) {
        rect = {
          left: event.clientX,
          top: event.clientY,
          width: 0,
          height: 0,
          right: event.clientX,
          bottom: event.clientY
        };
      }
      lastContextSelection = text ? { text: text, rect: rect } : null;
    } catch (err) {
      lastContextSelection = null;
    }
  }

  /** 右键菜单「翻译选中文本」：优先当前选区，其次 contextmenu 时记录的选区 */
  function translateContextSelection(fallbackText) {
    var saved = lastContextSelection;
    lastContextSelection = null;
    var text = '';
    var rect = null;
    try {
      var selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        text = normalizeText(selection.toString());
        if (text && selection.rangeCount) {
          var rangeRect = selection.getRangeAt(0).getBoundingClientRect();
          if (rangeRect && (rangeRect.width || rangeRect.height)) rect = rangeRect;
        }
      }
    } catch (err) {
      /* ignore */
    }
    if (!text && saved && saved.text) {
      text = saved.text;
      rect = saved.rect;
    }
    if (!text && typeof fallbackText === 'string') text = normalizeText(fallbackText);
    if (!text) {
      openPanel();
      setStatus(t('statusNeedSelection'), 'warn');
      refreshUi();
      return;
    }
    if (text.length > MAX_SELECTION) text = text.slice(0, MAX_SELECTION);
    if (!rect) {
      rect = {
        left: Math.max(8, Math.floor(window.innerWidth / 2) - 40),
        top: 80,
        width: 80,
        height: 20,
        right: Math.max(8, Math.floor(window.innerWidth / 2)) + 40,
        bottom: 100
      };
    }
    openCard(text, rect);
  }

  function onDocumentMouseUp(event) {
    if (isFromOurUi(event)) return;
    setTimeout(function () {
      safe(handleSelectionEvent);
    }, 220);
  }

  function onDocumentDoubleClick(event) {
    if (isFromOurUi(event)) return;
    state.lastDoubleClickAt = Date.now();
  }

  function onDocumentMouseDown(event) {
    if (imageOverlay) {
      if (isFromOurUi(event)) return;
      removeImageTranslation();
      return;
    }
    if (!state.cardState) return;
    if (isFromOurUi(event)) return;
    closeCard();
  }

  function onDocumentKeyDown(event) {
    if (event.key !== 'Escape') return;
    if (imageOverlay) {
      removeImageTranslation();
      return;
    }
    if (state.cardState) {
      closeCard();
      return;
    }
    if (state.panelOpen) closePanel();
  }

  function onWindowScroll(event) {
    if (!state.cardState) return;
    if (isFromOurUi(event)) return;
    closeCard();
  }

  function onWindowResize() {
    if (state.cardState) closeCard();
    applyBallPosition(state.settings.ballPosition, true);
  }

  function bindEvents() {
    try {
      document.addEventListener('mouseup', onDocumentMouseUp, true);
      document.addEventListener('mousedown', onDocumentMouseDown, true);
      document.addEventListener('dblclick', onDocumentDoubleClick, true);
      document.addEventListener('contextmenu', onDocumentContextMenu, true);
      document.addEventListener('keydown', onDocumentKeyDown, true);
      window.addEventListener('scroll', onWindowScroll, true);
      window.addEventListener('resize', onWindowResize, true);
      window.addEventListener('popstate', function () {
        safe(function () {
          if (state.lastUrl !== location.href) {
            state.lastUrl = location.href;
            if (hasTranslations()) safe(onUrlChanged);
          }
        });
      });
      window.addEventListener('hashchange', function () {
        safe(function () {
          state.lastUrl = location.href;
        });
      });
    } catch (err) {
      /* ignore */
    }
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !changes) return;
    try {
      var next = Object.assign({}, state.settings);
      var changed = false;
      if (changes.dshBaseUrl) {
        next.dshBaseUrl = changes.dshBaseUrl.newValue;
        changed = true;
      }
      if (changes.targetLanguage) {
        next.targetLanguage = changes.targetLanguage.newValue;
        changed = true;
      }
      if (changes.mode) {
        next.mode = changes.mode.newValue;
        changed = true;
      }
      if (changes.scheduleMode) {
        next.scheduleMode = changes.scheduleMode.newValue;
        changed = true;
      }
      if (changes.preload) {
        next.preload = changes.preload.newValue;
        changed = true;
      }
      if (changes.autoTranslate) {
        next.autoTranslate = changes.autoTranslate.newValue;
        changed = true;
      }
      if (changes.selectionTranslate) {
        next.selectionTranslate = changes.selectionTranslate.newValue;
        changed = true;
      }
      if (changes.doubleClickTranslate) {
        next.doubleClickTranslate = changes.doubleClickTranslate.newValue;
        changed = true;
      }
      if (changes.shortcutTranslate) {
        next.shortcutTranslate = changes.shortcutTranslate.newValue;
        changed = true;
      }
      if (changes.hideBallSameLanguage) {
        next.hideBallSameLanguage = changes.hideBallSameLanguage.newValue;
        changed = true;
      }
      if (changes.autoTranslateSites) {
        next.autoTranslateSites = normalizeSiteList(changes.autoTranslateSites.newValue);
        changed = true;
      }
      if (changes.translateIframes) {
        next.translateIframes = changes.translateIframes.newValue === true;
        changed = true;
      }
      if (changes.followTranslation) {
        next.followTranslation = changes.followTranslation.newValue;
        changed = true;
        if (changes.followTranslation.newValue === false) followAction('disable');
      }
      if (changes.showFloatingBall) {
        next.showFloatingBall = changes.showFloatingBall.newValue !== false;
        changed = true;
      }
      if (changes.ballPosition) {
        next.ballPosition = changes.ballPosition.newValue;
        changed = true;
      }
      if (changes.uiLang) {
        next.uiLang = changes.uiLang.newValue;
        changed = true;
      }
      if (!changed) return;

      var previousUiLang = state.uiLang;
      state.settings = normalizeSettings(next);
      state.uiLang = state.settings.uiLang;
      state.targetLanguage = state.settings.targetLanguage;
      state.effectiveTarget = state.targetLanguage || state.remoteTarget || state.effectiveTarget || 'zh-CN';

      if (previousUiLang !== state.uiLang) updateUiText();
      if (changes.mode && state.settings.mode !== state.mode) applyMode(state.settings.mode, false);
      else updateModeButtons();
      if (changes.showFloatingBall && state.ui && state.ui.bubble) {
        state.ui.bubble.hidden = state.settings.showFloatingBall === false;
        if (state.settings.showFloatingBall === false) {
          closePanel();
          closeCard();
        }
      }
      if (changes.ballPosition) applyBallPosition(state.settings.ballPosition, false);
      updateAutoSiteButton();
      applyBallSiteVisibility();
      refreshUi();
    } catch (err) {
      /* ignore */
    }
  }

  function onRuntimeMessage(message) {
    try {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'dsh-it:toggle') {
        safe(toggleTranslate);
        return;
      }
      if (message.type === 'dsh-it:translate-selection') {
        safe(function () {
          translateContextSelection(message.text);
        });
        return;
      }
      if (message.type === 'dsh-it:set-mode') {
        safe(function () {
          return applyContextMode(message.mode);
        });
        return;
      }
      if (message.type === 'dsh-it:show-ball') {
        safe(showFloatingBall);
        return;
      }
      if (message.type === 'dsh-it:hide-ball') {
        safe(hideFloatingBall);
        return;
      }
      if (message.type === 'dsh-it:hide-domain') {
        safe(hideCurrentDomainBall);
        return;
      }
      if (message.type === 'dsh-it:toggle-auto-site') {
        safe(toggleCurrentSiteAutoTranslate);
        return;
      }
      if (message.type === 'dsh-it:toggle-panel') {
        safe(function () {
          if (state.settings.showFloatingBall === false) setFloatingBallVisible(true);
          togglePanel();
        });
        return;
      }
      if (message.type === 'dsh-it:shortcut-translate') {
        safe(handleShortcutTranslate);
        return;
      }
      if (message.type === 'dsh-it:translate-image') {
        safe(function () {
          startImageTranslation(message.srcUrl);
        });
        return;
      }
    } catch (err) {
      /* ignore */
    }
  }

  /* ================================================================ */
  /* 图片文字翻译：右键图片 → 截图 → 视觉模型 → 原位覆盖                */
  /* ================================================================ */

  var IMAGE_OVERLAY_CSS = [
    '.dsh-img-layer{position:absolute;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}',
    '.dsh-img-block{position:absolute;box-sizing:border-box;overflow:hidden;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;border-radius:2px;padding:1px 3px;cursor:pointer;pointer-events:auto;line-height:1.18;word-break:break-word;white-space:pre-wrap;}',
    '.dsh-img-block .dsh-img-orig{display:none;font-size:.76em;opacity:.72;margin-bottom:1px;}',
    '.dsh-img-layer.dsh-img-bilingual .dsh-img-block .dsh-img-orig{display:block;}',
    '.dsh-img-toolbar{position:absolute;right:2px;top:2px;display:flex;gap:3px;pointer-events:auto;z-index:3;}',
    '.dsh-img-btn{appearance:none;border:0;border-radius:4px;padding:2px 6px;font:inherit;font-size:11px;line-height:1.4;cursor:pointer;color:#fff;background:rgba(28,30,34,.86);white-space:nowrap;}',
    '.dsh-img-btn:hover{background:rgba(28,30,34,1);}',
    '.dsh-img-card{position:absolute;left:0;top:0;box-sizing:border-box;max-height:70vh;overflow:auto;padding:10px 12px;border-radius:8px;background:#fff;color:#1f2328;box-shadow:0 8px 28px rgba(0,0,0,.22);pointer-events:auto;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;}',
    '.dsh-img-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-weight:600;}',
    '.dsh-img-card-row{margin:6px 0;padding:6px 0;border-top:1px solid rgba(0,0,0,.08);}',
    '.dsh-img-card-orig{display:block;font-size:11px;color:#6a737d;margin-bottom:2px;white-space:pre-wrap;}',
    '.dsh-img-card-trans{display:block;white-space:pre-wrap;}',
    '.dsh-img-card-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:8px;}',
    '.dsh-img-hint{position:absolute;left:2px;bottom:2px;font-size:10px;color:rgba(255,255,255,.9);background:rgba(0,0,0,.5);border-radius:3px;padding:1px 4px;pointer-events:none;}'
  ].join('');

  function imageTextColor(background) {
    var hex = String(background || '#ffffff').replace('#', '');
    if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    var r = parseInt(hex.slice(0, 2), 16) || 255;
    var g = parseInt(hex.slice(2, 4), 16) || 255;
    var b = parseInt(hex.slice(4, 6), 16) || 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111111' : '#ffffff';
  }

  function findImageBySrc(srcUrl) {
    try {
      var last = lastContextImage;
      if (last && last.tagName === 'IMG' && last.isConnected) {
        if (!srcUrl || last.currentSrc === srcUrl || last.src === srcUrl) return last;
      }
      var images = document.querySelectorAll('img');
      for (var i = 0; i < images.length; i += 1) {
        var img = images[i];
        if (img.currentSrc === srcUrl || img.src === srcUrl) return img;
      }
      if (last && last.tagName === 'IMG' && last.isConnected) return last;
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  function waitForImageReady(img, callback) {
    if (img.complete) {
      callback();
      return;
    }
    var settled = false;
    var finish = function () {
      if (settled) return;
      settled = true;
      img.removeEventListener('load', finish);
      img.removeEventListener('error', finish);
      callback();
    };
    img.addEventListener('load', finish);
    img.addEventListener('error', finish);
    setTimeout(finish, 3000);
  }

  function removeImageTranslation() {
    if (!imageOverlay) return;
    try {
      if (imageOverlay.host && imageOverlay.host.parentNode) imageOverlay.host.parentNode.removeChild(imageOverlay.host);
    } catch (err) {
      /* ignore */
    }
    imageOverlay = null;
  }

  function copyImageText(text) {
    var value = String(text || '');
    if (!value) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () {
          showToast(t('imageCopied'), 1800);
        }, function () {
          showToast(t('imageFailed', { msg: 'clipboard unavailable' }), 2200);
        });
        return;
      }
    } catch (err) {
      /* fall through */
    }
    try {
      var textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      showToast(t('imageCopied'), 1800);
    } catch (err) {
      showToast(t('imageFailed', { msg: 'clipboard unavailable' }), 2200);
    }
  }

  function imageOverlayText(blocks) {
    var parts = [];
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i] && typeof blocks[i].translation === 'string' && blocks[i].translation) parts.push(blocks[i].translation);
    }
    return parts.join('\n\n');
  }

  /**
   * 把图片译文缩到 bbox 内：先用原文/译文长度和 bbox 面积估算一个接近原图的字号，
   * 再从该字号往下缩，直到 scrollHeight/scrollWidth 不再溢出。
   * @param {HTMLElement} element - .dsh-img-block.
   */
  function fitImageBlock(element) {
    if (!element) return;
    try {
      var current = parseFloat(element.style.fontSize);
      if (!isFinite(current) || current <= 0) current = 12;
      var minSize = 8;
      var guard = 0;
      while (current > minSize && guard < 80) {
        if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) break;
        current = Math.max(minSize, Math.round((current - 0.5) * 10) / 10);
        element.style.fontSize = current + 'px';
        guard += 1;
      }
      // 极窄/极高的 bbox 仍放不下时，压一点行高做最后兜底。
      if (element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2) {
        element.style.lineHeight = '1.05';
      }
    } catch (err) {
      /* ignore */
    }
  }

  function fitImageBlocks(elements) {
    for (var i = 0; i < elements.length; i += 1) fitImageBlock(elements[i]);
  }

  function guardImageOverlayHost(host) {
    // 必须用冒泡阶段：capture 阶段 stopPropagation 会拦截 shadow DOM 内
    // 工具栏按钮自己的 click，导致「双语/复制/关闭」全部失效。
    var stop = function (event) { event.stopPropagation(); };
    ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'].forEach(function (type) {
      host.addEventListener(type, stop);
    });
  }

  function renderImageCard(result, pageRect) {
    var blocks = Array.isArray(result.blocks) ? result.blocks : [];
    var host = document.createElement('div');
    host.id = IMAGE_OVERLAY_ID;
    host.setAttribute('data-dsh-it-ui', 'image-card');
    host.style.cssText = 'position:absolute;z-index:2147483645;pointer-events:none;left:' + pageRect.left + 'px;top:' + pageRect.top + 'px;width:' + Math.max(240, Math.min(440, pageRect.width || 320)) + 'px;';
    var shadow;
    try {
      shadow = host.attachShadow({ mode: 'open' });
    } catch (err) {
      showToast(t('imageFailed', { msg: 'shadow dom unavailable' }), 2600);
      return;
    }
    var style = document.createElement('style');
    style.textContent = IMAGE_OVERLAY_CSS;
    shadow.appendChild(style);
    var card = document.createElement('div');
    card.className = 'dsh-img-card';
    card.style.pointerEvents = 'auto';
    var head = document.createElement('div');
    head.className = 'dsh-img-card-head';
    var title = document.createElement('span');
    title.textContent = t('imageTitle');
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'dsh-img-btn';
    close.textContent = t('imageClose');
    close.addEventListener('click', function (event) {
      event.stopPropagation();
      removeImageTranslation();
    });
    head.appendChild(title);
    head.appendChild(close);
    card.appendChild(head);
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i] || {};
      var row = document.createElement('div');
      row.className = 'dsh-img-card-row';
      if (block.text) {
        var orig = document.createElement('span');
        orig.className = 'dsh-img-card-orig';
        orig.textContent = block.text;
        row.appendChild(orig);
      }
      var trans = document.createElement('span');
      trans.className = 'dsh-img-card-trans';
      trans.textContent = block.translation || '';
      row.appendChild(trans);
      card.appendChild(row);
    }
    var actions = document.createElement('div');
    actions.className = 'dsh-img-card-actions';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'dsh-img-btn';
    copy.textContent = t('imageCopy');
    copy.addEventListener('click', function (event) {
      event.stopPropagation();
      copyImageText(imageOverlayText(blocks));
    });
    actions.appendChild(copy);
    card.appendChild(actions);
    shadow.appendChild(card);
    guardImageOverlayHost(host);
    document.body.appendChild(host);
    imageOverlay = { host: host, shadow: shadow, kind: 'card' };
  }

  function renderImageTranslation(responseData, pageRect) {
    removeImageTranslation();
    var data = responseData && typeof responseData === 'object' ? responseData : {};
    var result = data.result && typeof data.result === 'object' ? data.result : {};
    var blocks = Array.isArray(result.blocks) ? result.blocks : [];
    var colors = Array.isArray(result.colors) ? result.colors : [];
    var withBoxes = [];
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      if (!block || !Array.isArray(block.bbox) || block.bbox.length !== 4) continue;
      var box = block.bbox.map(Number);
      if (box.some(function (value) { return !isFinite(value); })) continue;
      if (box[2] - box[0] < 0.002 || box[3] - box[1] < 0.002) continue;
      withBoxes.push({ block: block, index: i, bbox: box });
    }
    if (withBoxes.length === 0) {
      if (blocks.length === 0) {
        showToast(t('imageNoText'), 2800);
        return;
      }
      renderImageCard(result, pageRect);
      return;
    }

    var host = document.createElement('div');
    host.id = IMAGE_OVERLAY_ID;
    host.setAttribute('data-dsh-it-ui', 'image-overlay');
    host.style.cssText = 'position:absolute;z-index:2147483645;pointer-events:none;left:' + pageRect.left + 'px;top:' + pageRect.top + 'px;width:' + pageRect.width + 'px;height:' + pageRect.height + 'px;';
    var shadow;
    try {
      shadow = host.attachShadow({ mode: 'open' });
    } catch (err) {
      showToast(t('imageFailed', { msg: 'shadow dom unavailable' }), 2600);
      return;
    }
    var style = document.createElement('style');
    style.textContent = IMAGE_OVERLAY_CSS;
    shadow.appendChild(style);
    var layer = document.createElement('div');
    layer.className = 'dsh-img-layer';
    layer.style.width = '100%';
    layer.style.height = '100%';
    shadow.appendChild(layer);
    var fitElements = [];

    for (var j = 0; j < withBoxes.length; j += 1) {
      var item = withBoxes[j];
      var box = item.bbox;
      var block = item.block;
      var boxWidth = Math.max(1, (box[2] - box[0]) * pageRect.width);
      var boxHeight = Math.max(1, (box[3] - box[1]) * pageRect.height);
      var background = typeof colors[item.index] === 'string' ? colors[item.index] : '#ffffff';
      var element = document.createElement('div');
      element.className = 'dsh-img-block';
      element.style.left = (box[0] * 100) + '%';
      element.style.top = (box[1] * 100) + '%';
      element.style.width = Math.max(1, (box[2] - box[0]) * 100) + '%';
      element.style.height = Math.max(1, (box[3] - box[1]) * 100) + '%';
      element.style.background = background;
      element.style.color = imageTextColor(background);
      var sizingText = String(block.text || block.translation || '');
      var estimatedFont = Math.sqrt((boxWidth * boxHeight) / Math.max(1, sizingText.length)) * 1.05;
      // 正文类长块封顶 16px（常见网页正文字号），短标签/标题允许到 20px；
      // 再交给 fitImageBlock() 依据真实渲染结果继续缩小，避免整块溢出错位。
      var fontCap = sizingText.length > 24 ? 16 : 20;
      element.style.fontSize = Math.max(8, Math.min(fontCap, Math.round(estimatedFont))) + 'px';
      fitElements.push(element);
      if (block.text) {
        var orig = document.createElement('span');
        orig.className = 'dsh-img-orig';
        orig.textContent = block.text;
        element.appendChild(orig);
      }
      var trans = document.createElement('span');
      trans.className = 'dsh-img-trans';
      trans.textContent = block.translation || '';
      element.appendChild(trans);
      element.title = block.text ? block.text : (block.translation || '');
      layer.appendChild(element);
    }

    var toolbar = document.createElement('div');
    toolbar.className = 'dsh-img-toolbar';
    var hasOriginalText = false;
    for (var bi = 0; bi < blocks.length; bi += 1) {
      if (blocks[bi] && typeof blocks[bi].text === 'string' && blocks[bi].text.trim().length > 0) {
        hasOriginalText = true;
        break;
      }
    }
    var bilingual = document.createElement('button');
    bilingual.type = 'button';
    bilingual.className = 'dsh-img-btn';
    bilingual.textContent = t('imageBilingual');
    bilingual.addEventListener('click', function (event) {
      event.stopPropagation();
      var next = !layer.classList.contains('dsh-img-bilingual');
      if (next) layer.classList.add('dsh-img-bilingual');
      else layer.classList.remove('dsh-img-bilingual');
      bilingual.textContent = next ? t('imageOnly') : t('imageBilingual');
      if (imageOverlay && imageOverlay.fitAll) imageOverlay.fitAll();
    });
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'dsh-img-btn';
    copy.textContent = t('imageCopy');
    copy.addEventListener('click', function (event) {
      event.stopPropagation();
      copyImageText(imageOverlayText(blocks));
    });
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'dsh-img-btn';
    close.textContent = t('imageClose');
    close.addEventListener('click', function (event) {
      event.stopPropagation();
      removeImageTranslation();
    });
    // 快速模式只返回译文；没有原文时隐藏「双语」按钮，避免点了没反应。
    if (hasOriginalText) toolbar.appendChild(bilingual);
    toolbar.appendChild(copy);
    toolbar.appendChild(close);
    layer.appendChild(toolbar);

    var capture = data.capture && typeof data.capture === 'object' ? data.capture : {};
    var elementRect = capture.elementRect && typeof capture.elementRect === 'object' ? capture.elementRect : null;
    if (elementRect && (elementRect.width > pageRect.width + 2 || elementRect.height > pageRect.height + 2)) {
      var hint = document.createElement('div');
      hint.className = 'dsh-img-hint';
      hint.textContent = t('imagePartial');
      layer.appendChild(hint);
    }

    guardImageOverlayHost(host);
    document.body.appendChild(host);
    var fitAll = function () { fitImageBlocks(fitElements); };
    imageOverlay = { host: host, shadow: shadow, kind: 'overlay', fitAll: fitAll };
    requestAnimationFrame(fitAll);
    setTimeout(fitAll, 80);
    showToast(t('imageDone'), 2200);
  }

  function startImageTranslation(srcUrl) {
    if (imageTranslatePending) {
      // 保持长驻进度提示：重试点击时不能把仍在进行中的长请求提示缩成 1.8s，
      // 否则用户会误以为任务已经结束。
      showToast(t('imageTranslating'), 120000);
      return;
    }
    var img = findImageBySrc(srcUrl);
    if (!img) {
      showToast(t('imageNotFound'), 3200);
      return;
    }
    imageTranslatePending = true;
    showToast(t('imageTranslating'), 120000);
    var finish = function (message) {
      imageTranslatePending = false;
      // 错误信息也要留足时间；大图请求可能 20–30 秒，用户往往不会盯着 toast。
      if (message) showToast(message, 8000);
    };
    waitForImageReady(img, function () {
      safe(function () {
        var initial = img.getBoundingClientRect();
        var needScroll = initial.top < 0 || initial.bottom > window.innerHeight || initial.left < 0 || initial.right > window.innerWidth;
        if (needScroll) {
          try {
            img.scrollIntoView({ block: 'center', inline: 'center' });
          } catch (err) {
            try { img.scrollIntoView(); } catch (e) { /* ignore */ }
          }
        }
        setTimeout(function () {
          safe(function () {
            var rect = img.getBoundingClientRect();
            var vw = window.innerWidth || document.documentElement.clientWidth || 0;
            var vh = window.innerHeight || document.documentElement.clientHeight || 0;
            var left = Math.max(0, rect.left);
            var top = Math.max(0, rect.top);
            var right = Math.min(vw, rect.right);
            var bottom = Math.min(vh, rect.bottom);
            var width = right - left;
            var height = bottom - top;
            if (width < 8 || height < 8) {
              finish(t('imageNotFound'));
              return;
            }
            var pageRect = {
              left: left + (window.scrollX || window.pageXOffset || 0),
              top: top + (window.scrollY || window.pageYOffset || 0),
              width: width,
              height: height
            };
            try {
              chrome.runtime.sendMessage({
                type: 'dsh-it:image-translate',
                srcUrl: srcUrl,
                rect: { left: left, top: top, width: width, height: height },
                elementRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                viewportWidth: vw,
                viewportHeight: vh,
                sourceUrl: location.href,
                sourceTitle: document.title,
                compact: state.settings.imageFastMode === true
              }, function (response) {
                var lastError = null;
                try {
                  lastError = chrome.runtime.lastError;
                } catch (err) {
                  lastError = null;
                }
                if (lastError) {
                  finish(t('imageFailed', { msg: '扩展后台不可用，请刷新页面' }));
                  return;
                }
                if (!response || response.ok !== true) {
                  var message = response && response.error && response.error.message ? response.error.message : '未知错误';
                  finish(t('imageFailed', { msg: message }));
                  return;
                }
                finish('');
                safe(function () {
                  renderImageTranslation(response.data, pageRect);
                });
              });
            } catch (err) {
              finish(t('imageFailed', { msg: err && err.message ? err.message : String(err) }));
            }
          });
        }, needScroll ? 180 : 40);
      });
    });
  }

  /* ================================================================ */
  /* 初始化                                                            */
  /* ================================================================ */

  /** 跟随翻译：上一个页面翻译过 → 本页加载后自动开始（无需打开面板） */
  function maybeFollowTranslate() {
    var attempts = 0;
    function check(attempt) {
      followAction('check').then(function (result) {
        if (state.settings.followTranslation === false) return;
        if (result && result.following) {
          showToast(t('statusFollowAuto'), 2600);
          setTimeout(function () {
            safe(function () {
              return startTranslate({ silent: true });
            });
          }, 600);
          return;
        }
        // 新标签可能比 background 的 opener 继承更早初始化：短暂重试几次
        if (attempt < 3) {
          setTimeout(function () {
            check(attempt + 1);
          }, 400);
        }
      }).catch(function () {
        /* 跟随状态查询失败不影响正常使用 */
      });
    }
    check(0);
  }

  /** 子框架：只响应父页面广播，不创建悬浮球/面板 */
  function initSubframeMode() {
    try {
      window.addEventListener('message', onSubframeMessage, false);
    } catch (err) {
      /* ignore */
    }
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __dshItFrame: true, action: 'ready' }, '*');
      }
    } catch (err) {
      /* ignore */
    }
  }

  function onSubframeMessage(event) {
    try {
      if (!event || event.source !== window.parent) return;
      var data = event.data;
      if (!data || data.__dshItFrame !== true) return;
      if (data.action === 'translate') {
        if (state.running || state.lazyActive || hasTranslations()) return;
        safe(function () {
          return startTranslate({ silent: true });
        });
      } else if (data.action === 'restore') {
        safe(restoreAll);
      } else if (data.action === 'mode' && MODES.indexOf(data.mode) !== -1) {
        safe(function () {
          applyMode(data.mode, false);
        });
      }
    } catch (err) {
      /* ignore */
    }
  }

  /** 顶层页面：向直接子 iframe 广播翻译指令（跨域也只需 postMessage） */
  function postToChildFrames(payload) {
    if (IS_SUBFRAME) return;
    try {
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        var frameWin = frames[i].contentWindow;
        if (!frameWin) continue;
        try {
          frameWin.postMessage(payload, '*');
        } catch (err) {
          /* 单个 iframe 异常不影响其它 */
        }
      }
    } catch (err) {
      /* ignore */
    }
  }

  function broadcastFrameTranslate(attempt) {
    try {
      if (IS_SUBFRAME || state.settings.translateIframes !== true) return;
      if (attempt === 0) postToChildFrames({ __dshItFrame: true, action: 'restore' });
      postToChildFrames({ __dshItFrame: true, action: 'translate' });
      if (attempt < 3) {
        setTimeout(function () {
          broadcastFrameTranslate(attempt + 1);
        }, 700);
      }
    } catch (err) {
      /* ignore */
    }
  }

  function init() {
    storageGet(STORAGE_KEYS)
      .then(function (raw) {
        applyStoredSettings(raw);
        if (IS_SUBFRAME) return null;
        return loadBallSites();
      })
      .then(function () {
        if (IS_SUBFRAME) {
          initSubframeMode();
          return;
        }
        createUI();
        bindEvents();
        setStatus(t('statusIdle'), '');
        refreshUi();
        try {
          if (chrome && chrome.storage && chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(onStorageChanged);
          }
        } catch (err) {
          /* ignore */
        }
        try {
          if (chrome && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener(onRuntimeMessage);
          }
        } catch (err) {
          /* ignore */
        }
        if (state.settings.followTranslation !== false) {
          maybeFollowTranslate();
        }
        if (state.settings.autoTranslate || isCurrentSiteAutoTranslate()) {
          setTimeout(function () {
            safe(function () {
              return startTranslate({ silent: true });
            });
          }, 1200);
        }
      })
      .catch(function (err) {
        setStatus(errorText(err), 'error');
      });
  }

  // 暴露给后续版本（MutationObserver 增量扫描）；目前主要供内部/调试使用
  window.__dshItScanAgain = function () {
    try {
      return scanAgain();
    } catch (err) {
      return { blocks: [], truncated: false };
    }
  };

  init();
})();
