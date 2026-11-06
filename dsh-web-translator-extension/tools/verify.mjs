#!/usr/bin/env node
/**
 * 静态校验脚本（不启动浏览器）：`node tools/verify.mjs`
 *
 * 覆盖：
 *  1. node --check 所有扩展 JS
 *  2. manifest.json 可解析 + MV3 关键字段契约
 *  3. content.js 禁止模式（出网/日志/innerHTML/eval/cookie/localStorage）
 *  4. content.js 关键常量、候选/跳过标签、RPC 方法、12 目标语言
 *  5. background.js 白名单、超时、入口监听
 *  6. options.html 无内联脚本/事件；data-i18n 键在 options.js zh/en 都有
 *  7. content.js 中文案 key 在 en 字典中都有
 *  8. CSS 字符串括号配对
 *  9. icons/*.png 是真实 PNG 且尺寸为 16/32/48/128
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const passes = [];

function check(name, condition, extra) {
  if (condition) passes.push(name);
  else problems.push(name + (extra ? ' [' + extra + ']' : ''));
}

function read(file) {
  return readFileSync(join(ROOT, file), 'utf8');
}

/* 1. 语法检查 */
const JS_FILES = ['background.js', 'content.js', 'options.js', 'tools/make-icons.mjs', 'tools/verify.mjs', 'tools/e2e-chrome.mjs'];
for (const file of JS_FILES) {
  const result = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' });
  check('node --check ' + file, result.status === 0, (result.stderr || '').trim());
}

/* 2. manifest */
let manifest = null;
try {
  manifest = JSON.parse(read('manifest.json'));
  check('manifest.json 可解析', true);
} catch (err) {
  check('manifest.json 可解析', false, String(err));
}
if (manifest) {
  check('manifest: MV3', manifest.manifest_version === 3);
  check('manifest: version 1.14.8', manifest.version === '1.14.8', manifest.version);
  check(
    'manifest: permissions 仅 storage/activeTab/scripting/contextMenus',
    JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'activeTab', 'scripting', 'contextMenus']),
    JSON.stringify(manifest.permissions)
  );
  check(
    'manifest: host_permissions 仅 DSH 3080',
    JSON.stringify(manifest.host_permissions) ===
      JSON.stringify(['http://127.0.0.1:3080/*', 'http://localhost:3080/*']),
    JSON.stringify(manifest.host_permissions)
  );
  check(
    'manifest: module service worker',
    manifest.background && manifest.background.service_worker === 'background.js' && manifest.background.type === 'module'
  );
  check(
    'manifest: commands.toggle-translate = Alt+T',
    manifest.commands &&
      manifest.commands['toggle-translate'] &&
      manifest.commands['toggle-translate'].suggested_key &&
      manifest.commands['toggle-translate'].suggested_key.default === 'Alt+T'
  );
  check('manifest: options_page', manifest.options_page === 'options.html');
  check('manifest: action 存在', !!manifest.action);
  const cs = manifest.content_scripts && manifest.content_scripts[0];
  check(
    'manifest: content_scripts http/https + content.js @document_idle',
    !!cs &&
      JSON.stringify(cs.matches) === JSON.stringify(['http://*/*', 'https://*/*']) &&
      JSON.stringify(cs.js) === JSON.stringify(['content.js']) &&
      cs.run_at === 'document_idle'
  );
  const icons = manifest.icons || {};
  check('manifest: icons 16/32/48/128', ['16', '32', '48', '128'].every((s) => typeof icons[s] === 'string'));
}

/* 3/4. content.js */
const content = read('content.js');
for (const bad of ['fetch(', 'XMLHttpRequest', 'innerHTML', 'console.', 'eval(', 'new Function', 'document.cookie', 'localStorage']) {
  check('content.js 不含禁止内容: ' + bad, !content.includes(bad));
}

const CONTENT_TOKENS = [
  ["宿主 id", "HOST_ID = 'dsh-it-host'"],
  ['Shadow DOM open', "attachShadow({ mode: 'open' })"],
  ['RPC 请求类型', "type: 'dsh-it:rpc'"],
  ['RPC 回包类型', "'dsh-it:result'"],
  ['toggle 消息', 'dsh-it:toggle'],
  ['译文标记', 'data-dsh-it="trans"'],
  ['原文标记', 'data-dsh-it="src"'],
  ['模式属性', 'data-dsh-it-mode'],
  ['设置键', "'dshBaseUrl',\n    'targetLanguage',\n    'mode',\n    'scheduleMode',\n    'preload',\n    'autoTranslate',\n    'selectionTranslate',\n    'doubleClickTranslate',\n    'shortcutTranslate',\n    'followTranslation',\n    'hideBallSameLanguage',\n    'showFloatingBall',\n    'ballPosition',\n    'uiLang'"],
  ['单页上限 800', 'MAX_BLOCKS = 800'],
  ['文本下限 2', 'MIN_TEXT = 2'],
  ['行内候选下限 12', 'INLINE_MIN_TEXT = 12'],
  ['文本上限 4000', 'MAX_TEXT = 4000'],
  ['分组段数 10', 'BATCH_MAX_SEGMENTS = 10'],
  ['分组字符 1600', 'BATCH_MAX_CHARS = 1600'],
  ['并发 2', 'CONCURRENCY = 2'],
  ['微批合并静默窗口', 'BATCH_COALESCE_MS = 180'],
  ['微批合并最小段数', 'BATCH_COALESCE_MIN_SEGMENTS = 3'],
  ['微批合并最小字符', 'BATCH_COALESCE_MIN_CHARS = 400'],
  ['微批合并最长等待', 'BATCH_COALESCE_MAX_WAIT_MS = 400'],
  ['微批合并调度入口', 'function schedulePump(session, touched)'],
  ['微批合并定时器清理', 'function clearCoalesceTimer(lazy)'],
  ['微批合并就绪检查', 'function queueStats(lazy)'],
  ['微批合并入队调度', 'schedulePump(session, true)'],
  ['微批合并窗口保持', 'if (lazy.timer && !touched) return;'],
  ['微批合并断开清理', 'clearCoalesceTimer(state.lazy);'],
  ['调度模式默认 screen', "scheduleMode: 'screen'"],
  ['预加载默认 one', "preload: 'one'"],
  ['按屏扫描防抖', 'SCREEN_SCAN_DEBOUNCE_MS = 140'],
  ['预加载系数表', 'var PRELOAD_FACTORS = { none: 0, half: 0.5, one: 1 }'],
  ['预加载系数', 'function getPreloadFactor()'],
  ['调度模式判断', 'function isScreenScheduleMode()'],
  ['预加载 rootMargin', 'function preloadRootMargin()'],
  ['按屏窗口扫描', 'function collectScreenUnits()'],
  ['按屏整屏入队', 'function enqueueScreenWindow(session)'],
  ['按屏立即发送', 'function flushScreenWindow(session, allowMerge)'],
  ['按屏扫描调度', 'function scheduleScreenScan()'],
  ['按屏扫描定时器清理', 'function clearScreenScanTimer(lazy)'],
  ['按屏 scroll 监听', "window.addEventListener('scroll', lazy.onScreenScroll"],
  ['按屏 resize 监听', "window.addEventListener('resize', lazy.onScreenResize"],
  ['按屏监听清理', 'function detachScreenListeners(lazy)'],
  ['按屏动态内容合并', 'function mergeNewUnits(session)'],
  ['按屏 observer 失效通知', 'scheduleScreenScan();'],
  ['按屏模式立即 pump', 'if (isScreenScheduleMode()) {'],
  ['按屏扫描结束保护', 'if (lazy.timer || lazy.scanTimer) return;'],
  ['选区上限 500', 'MAX_SELECTION = 500'],
  ['health', "rpc('health'"],
  ['settings', "rpc('settings'"],
  ['usage', "rpc('usage'"],
  ['translate', "rpc('translate'"],
  ['lookup', "rpc('lookup'"],
  ['wordbook/add', "rpc('wordbook/add'"],
  ['EXT 版本 1.14.8', "EXT_VERSION = '1.14.8'"],
  ['Turn id 生成', 'function makeTurnId(prefix)'],
  ['翻译 run 起始 Turn', "state.runId = makeTurnId('tr')"],
  ['translate Turn 身份', 'turnId: state.runId'],
  ['translate stepIndex 递增', 'stepIndex: state.runStep++'],
  ['translate 显示模式', 'mode: state.mode'],
  ['lookup Turn 身份', 'turnId: state.cardTurnId'],
  ['Turn 结束清空', "state.runId = ''"],
  ['tokenStats 状态', 'tokenStats:'],
  ['本页消耗 i18n', "tokensPage: '"],
  ['今日累计 i18n', "tokensToday: '"],
  ['输入/输出 i18n', "tokensInput: '"],
  ['翻译完成 token 状态', "statusDoneTokens: '"],
  ['查词卡 token 行', "cardTokens: '"],
  ['token 累计', 'accumulatePageUsage'],
  ['token 重置', 'resetPageTokenStats'],
  ['storage.onChanged', 'chrome.storage.onChanged'],
  ['scanAgain', 'function scanAgain()'],
  ['隐私提示', '译文由你在 DSH 中配置的模型生成'],
  ['语音合成', 'speechSynthesis'],
  ['自动翻译', 'autoTranslate'],
  ['SPA 提示', 'statusNavigate']
];
for (const [name, needle] of CONTENT_TOKENS) check('content.js 契约: ' + name, content.includes(needle));

check(
  'content.js 按屏模式：observer 只做失效通知（不逐块入队）',
  content.includes('if (screenMode) {') &&
    content.includes('scheduleScreenScan();') &&
    content.includes('flushScreenWindow(session, false);') &&
    content.includes('if (isScreenScheduleMode()) {')
);

const BLOCK_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DT', 'DD', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'SUMMARY'];
const SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME'];
check(
  'content.js 候选标签齐全',
  BLOCK_TAGS.every((tag) => content.includes("'" + tag + "'")),
  BLOCK_TAGS.filter((tag) => !content.includes("'" + tag + "'")).join(',')
);
check(
  'content.js 跳过标签齐全',
  SKIP_TAGS.every((tag) => content.includes("'" + tag + "'")),
  SKIP_TAGS.filter((tag) => !content.includes("'" + tag + "'")).join(',')
);

const LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar'];
check('content.js 12 目标语言', LANGS.every((code) => content.includes("code: '" + code + "'")));
check(
  'content.js 可读性排版规则：正文块级 / 标题行内（无换行配置）',
  !/var BLOCK_TAGS = new Set\(\[\s*'H1'/.test(content) &&
    content.includes("'P', 'BLOCKQUOTE', 'FIGCAPTION'") &&
    !content.includes('lineBreakMode') &&
    !content.includes('decidePreserveLineBreaks')
);
check(
  'content.js 右键选中文本翻译（contextmenu 捕获 + 消息处理）',
  content.includes('onDocumentContextMenu') && content.includes("'dsh-it:translate-selection'") && content.includes('translateContextSelection')
);
check(
  'content.js 划词/双击/快捷键翻译开关（默认关闭）',
  content.includes('selectionTranslate') && content.includes('doubleClickTranslate') && content.includes('shortcutTranslate') &&
    content.includes('handleShortcutTranslate') && content.includes('shortcutDisabled')
);
check('content.js 翻译后自动收起面板', content.includes('closePanel();'));
check(
  'content.js 语言一致隐藏悬浮球（默认开启）',
  content.includes('hideBallSameLanguage') && content.includes('isCurrentLanguageSame') && content.includes('detectPageLanguage')
);
check(
  'content.js 行内包裹 span 样式重置（避免站点 button span 命中）',
  content.includes("wrap.style.setProperty('all', 'unset')") && content.includes("trans.style.setProperty('color', 'inherit', 'important')")
);
check(
  'content.js 行内译文颜色继承宿主（跟随动态主题）',
  content.includes("INLINE_STYLE_PROPS = TYPO_PROPS.filter") && content.includes("prop !== 'color'")
);
check(
  'content.js 行内译文紧跟对应原文节点（不追加到容器末尾）',
  content.includes('insertAfter.parentNode.insertBefore(trans, insertAfter.nextSibling)')
);
check(
  'content.js 紧凑导航折行译注（chrome 区域内小字块级）',
  content.includes('compactWrappedChromeInline') && content.includes('data-dsh-it-compact') && content.includes("'0.8em'")
);
check(
  'content.js 列表项块级译文（li 内部注入，不新增条目）',
  content.includes("isListItem") && content.includes('li[data-dsh-it="src"]') && content.includes("'P', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'LI'")
);
check(
  'content.js 相同译文去重 + 长段落块级支持',
  content.includes('isSameTranslation') && content.includes('MAX_TEXT = 4000')
);
check(
  'content.js 悬浮球翻译进度/加载状态',
  content.includes('dsh-bubble-busy') && content.includes('bubbleProgress') && content.includes('bubbleLoading') && content.includes('--dsh-bubble-progress')
);
check(
  'content.js 域名悬浮球隐藏（ball-sites）',
  content.includes('hiddenBallSites') && content.includes('isCurrentDomainHidden') && content.includes('toggleCurrentDomainBall') && content.includes('domain-ball')
);
check(
  'content.js 语言一致：跳过翻译 + 悬浮球 toast 提示',
  content.includes('findSameLanguageContext') && content.includes('showToast(') && content.includes('sameLanguageHint') && content.includes('dsh-toast')
);
check(
  'content.js primary hover 保留渐变背景/白字（修复按钮消失）',
  content.includes('.dsh-btn.primary:hover:not(:disabled){background:linear-gradient') && content.includes('.dsh-btn:not(.primary):hover')
);
check(
  'content.js 居中块译文保持水平居中（auto margin + 宽度）',
  content.includes('copyHorizontalAlignment') && content.includes("setProperty('margin-left', 'auto'")
);
check(
  'background.js 右键菜单 dsh翻译 三模式',
  read('background.js').includes("'dsh-it:mode-source'") &&
    read('background.js').includes("'dsh-it:mode-only'") &&
    read('background.js').includes("'dsh-it:mode-bilingual'") &&
    read('background.js').includes("title: 'dsh翻译'")
);
const optionsJs = read('options.js');
check('options.js 12 目标语言（与 content 一致）', LANGS.every((code) => optionsJs.includes("code: '" + code + "'")));

/* 5. background.js */
const bg = read('background.js');
const BG_TOKENS = [
  ['默认地址', "DEFAULT_BASE_URL = 'http://127.0.0.1:3080'"],
  ['API 前缀', "API_PREFIX = '/dsh-immersive/api/'"],
  ['超时 120s', 'REQUEST_TIMEOUT_MS = 120000'],
  ['AbortController', 'new AbortController()'],
  ['白名单 health', "health: 'GET'"],
  ['白名单 settings', "settings: 'GET'"],
  ['白名单 usage GET', "usage: 'GET'"],
  ['白名单 translate POST', "translate: 'POST'"],
  ['白名单 lookup POST', "lookup: 'POST'"],
  ['白名单 wordbook/add POST', "'wordbook/add': 'POST'"],
  ['action.onClicked', 'chrome.action.onClicked.addListener'],
  ['commands.onCommand', 'chrome.commands.onCommand.addListener'],
  ['open-options', "message.type === 'dsh-it:open-options'"],
  ['结果回包', 'sendResponse'],
  ['自动补注入 content.js', "files: ['content.js']"],
  ['右键菜单监听', 'chrome.contextMenus.onClicked.addListener'],
  ['follow 状态消息', "'dsh-it:follow'"],
  ['显示悬浮球菜单', "'dsh-it:show-ball'"],
  ['隐藏悬浮球菜单', "'dsh-it:hide-ball'"],
  ['域名隐藏悬浮球菜单', "'dsh-it:hide-domain'"],
  ['ball-sites 路由', "'ball-sites': 'GET'"],
  ['快捷键翻译命令', "'shortcut-translate'"],
  ['工具栏点击只开面板', "'dsh-it:toggle-panel'"],
  ['跟随新 tab 继承', 'chrome.tabs.onCreated.addListener'],
  ['关闭 tab 清理', 'chrome.tabs.onRemoved.addListener'],
  ['右键菜单-父菜单', "'dsh-it:root'"],
  ['右键菜单-原文', "'dsh-it:mode-source'"],
  ['右键菜单-译文', "'dsh-it:mode-only'"],
  ['右键菜单-双语对照', "'dsh-it:mode-bilingual'"]
];
for (const [name, needle] of BG_TOKENS) check('background.js 契约: ' + name, bg.includes(needle));

/* 6. options.html */
const optionsHtml = read('options.html');
check('options.html 无内联 <script>', !/<script(?![^>]*src=)/i.test(optionsHtml));
check('options.html 引用 options.js', optionsHtml.includes('<script src="options.js"></script>'));
check('options.html 无内联事件属性', !/\bon(?:click|change|input|submit)=/i.test(optionsHtml));
const i18nKeys = [...new Set([...optionsHtml.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))];
const optionsZh = optionsJs.slice(optionsJs.indexOf('zh: {'), optionsJs.indexOf('en: {'));
const optionsEn = optionsJs.slice(optionsJs.indexOf('en: {'));
check(
  'options.js zh/en 覆盖所有 data-i18n 键',
  i18nKeys.every((key) => optionsZh.includes(key + ':') && optionsEn.includes(key + ':'))
);

/* 6.1) 调度方式 / 预加载设置（options UI + 默认值） */
check(
  'options.html 含调度方式/预加载下拉',
  optionsHtml.includes('id="scheduleMode"') && optionsHtml.includes('id="preload"') && optionsHtml.includes('data-i18n="fieldSchedule"')
);
check(
  'options.js 默认 scheduleMode=screen / preload=one',
  optionsJs.includes("scheduleMode: 'screen'") && optionsJs.includes("preload: 'one'")
);
check(
  'options.js 读/写调度方式与预加载',
  optionsJs.includes("$('scheduleMode').value") && optionsJs.includes("$('preload').value") &&
    optionsJs.includes('scheduleMode: scheduleMode') && optionsJs.includes('preload: preload')
);
check(
  'content.js 读取/归一化调度方式与预加载',
  content.includes("changes.scheduleMode") && content.includes("changes.preload") &&
    content.includes("raw.scheduleMode === 'screen' || raw.scheduleMode === 'block'") &&
    content.includes("raw.preload === 'none' || raw.preload === 'half' || raw.preload === 'one'")
);

/* 7. content 文案 key（粗略：t('x' 的使用处必须在 zh/en 字典中） */
const usedKeys = [...new Set([...content.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))];
const contentZh = content.slice(content.indexOf('zh: {'), content.indexOf('en: {'));
const contentEn = content.slice(content.indexOf('en: {'), content.indexOf('\n  };', content.indexOf('en: {')));
check(
  'content.js zh 字典覆盖所有 t() key',
  usedKeys.every((key) => contentZh.includes(key + ':'))
);
check(
  'content.js en 字典覆盖所有 t() key',
  usedKeys.every((key) => contentEn.includes(key + ':'))
);

/* 8. CSS 括号配对（取字符串字面量拼接后的稳定部分即可） */
function cssLiteral(prefix) {
  const start = content.indexOf(prefix);
  const end = content.indexOf('\n  function ', start);
  const chunk = content.slice(start, end);
  return [...chunk.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('');
}
const shadowCss = cssLiteral('var CSS_TEXT =');
const pageCss = cssLiteral('var PAGE_CSS =');
for (const [name, css] of [['shadow', shadowCss], ['page', pageCss]]) {
  const braces = (css.match(/{/g) || []).length === (css.match(/}/g) || []).length;
  const parens = (css.match(/\(/g) || []).length === (css.match(/\)/g) || []).length;
  check(name + ' CSS 花括号配对', braces && css.length > 100);
  check(name + ' CSS 圆括号配对', parens);
}
check('page CSS 含三模式规则', pageCss.includes('="source"') && pageCss.includes('="only"') && pageCss.includes('[data-dsh-it="trans"]'));

/* 9. 文件与 PNG */
const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'options.html',
  'options.js',
  'README.md',
  'tools/make-icons.mjs',
  'tools/verify.mjs',
  'tools/e2e-chrome.mjs',
  'tools/debug-layout.mjs',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png'
];
for (const file of FILES) check('文件存在: ' + file, existsSync(join(ROOT, file)));
for (const size of [16, 32, 48, 128]) {
  const file = join(ROOT, 'icons/icon' + size + '.png');
  if (!existsSync(file)) continue;
  const buf = readFileSync(file);
  const signature = buf.subarray(0, 8).toString('hex');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  check('icon' + size + '.png 是真实 PNG', signature === '89504e470d0a1a0a');
  check('icon' + size + '.png 尺寸 = ' + size + 'x' + size, width === size && height === size);
}

/* 汇总 */
for (const name of passes) console.log('PASS ' + name);
if (problems.length) {
  console.log('\nFAIL 共 ' + problems.length + ' 项:');
  for (const problem of problems) console.log(' - ' + problem);
  process.exit(1);
}
console.log('\nALL ' + passes.length + ' STATIC CHECKS PASSED');
