/**
 * @local/dsh-web-translator — browser client half.
 *
 * Static client plugin: no build step, no JSX, no ESM syntax. The Host serves
 * this file as a dynamic client bundle, so it registers its factory on
 * window.__ModuleLoader__ and requires only React from the platform module
 * table. Everything else uses plain browser APIs plus same-origin fetch
 * against the Host's /dsh-immersive/api routes.
 *
 * Module face: { inject: ['slots'], apply }.
 * apply() registers the "dsh-web-translator" settings.section (translation
 * settings, wordbook review, pronunciation practice), the left-toolbar page
 * (`main` key + `sidebar.panellist` row: token usage overview, request traces,
 * prompts, wordbook), and the per-locale dictionaries; all visible copy goes
 * through the translate function returned by ctx.locale.bind (built-in zh/en
 * dictionaries are the fallback).
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-web-translator',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useMemo = React.useMemo;

    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'dshImmersiveTranslate';
    /** Relative API base; resolved against document.baseURI so reverse-proxy prefixes keep working. */
    const API_BASE = 'dsh-immersive/api/';
    /** Position inside the Settings navigation. */
    const SECTION_ORDER = 35;
    /** Left-toolbar panel id shared by the `main` slot key and the sidebar list entry. */
    const PANEL_ID = 'immersive-translate';
    /** Order of this plugin's row in the left sidebar panel list. */
    const PANEL_ORDER = 2;
    /** Ambient refresh cadence for the token summary while the page is visible. */
    const USAGE_POLL_MS = 5000;
    /** Fallback chart window when the Host returns no day buckets. */
    const USAGE_CHART_DAYS = 14;
    /** Page size for GET /usage/turns, grouped client-side into DSH-like conversations. */
    const TRACE_TURN_PAGE_SIZE = 100;
    /** Page size for the legacy GET /usage/events fallback list. */
    const TRACE_EVENT_PAGE_SIZE = 50;

    /** Target-language choices offered by the settings page (Host validates a whitelist). */
    const TARGET_LANGUAGES = [
      { id: 'zh-CN', key: 'lang.zhCN' },
      { id: 'zh-TW', key: 'lang.zhTW' },
      { id: 'en', key: 'lang.en' },
      { id: 'ja', key: 'lang.ja' },
      { id: 'ko', key: 'lang.ko' },
      { id: 'fr', key: 'lang.fr' },
      { id: 'de', key: 'lang.de' },
      { id: 'es', key: 'lang.es' },
      { id: 'ru', key: 'lang.ru' },
      { id: 'pt', key: 'lang.pt' },
      { id: 'it', key: 'lang.it' },
      { id: 'ar', key: 'lang.ar' },
    ];

    /** Prompt placeholders rendered beside the prompt editors. */
    const PROMPT_PLACEHOLDERS = [
      '{{targetLanguage}}',
      '{{sourceLanguage}}',
      '{{segmentCount}}',
      '{{segmentsJson}}',
      '{{segments}}',
    ];

    /** Wordbook filter tabs. */
    const WORD_FILTERS = [
      { id: 'due', key: 'wordbook.filter.due' },
      { id: 'all', key: 'wordbook.filter.all' },
      { id: 'mastered', key: 'wordbook.filter.mastered' },
    ];

    /** Wordbook statistics cards. */
    const WORD_STATS = [
      { id: 'total', key: 'wordbook.stats.total' },
      { id: 'due', key: 'wordbook.stats.due' },
      { id: 'todayDue', key: 'wordbook.stats.todayDue' },
      { id: 'mastered', key: 'wordbook.stats.mastered' },
      { id: 'newCount', key: 'wordbook.stats.newCount' },
    ];

    /** Three-level SRS grades. */
    const GRADES = [
      { id: 'again', key: 'review.grade.again', shortcut: '1' },
      { id: 'hard', key: 'review.grade.hard', shortcut: '2' },
      { id: 'good', key: 'review.grade.good', shortcut: '3' },
    ];

    /** Speech-recognition failure reason to dictionary key. */
    const SHADOWING_REASONS = {
      unsupported: 'shadowing.unsupported',
      denied: 'shadowing.denied',
      noSpeech: 'shadowing.noSpeech',
      failed: 'shadowing.failed',
    };

    /** System prompt and user template character limits enforced by the Host. */
    const SYSTEM_PROMPT_MAX = 8000;
    const USER_TEMPLATE_MAX = 4000;

    // #region zh-dictionary
    const ZH = {
      'title': 'dsh翻译',
      'subtitle': '为浏览器扩展提供翻译后端；在这里切换模型、调整提示词、测试翻译，并复习单词本。',
      'tabs.label': 'dsh翻译页面',
      'tabs.settings': '翻译设置',
      'tabs.wordbook': '单词本',
      'tabs.ball': '悬浮球',
      'ball.title': '悬浮球不展示域名',
      'ball.hint': '以下域名不会显示悬浮球。可在网页右键菜单「dsh翻译 → 当前域名不展示悬浮球」或浮窗底部添加；这里可以移除或手动添加。',
      'ball.placeholder': 'example.com',
      'ball.add': '添加域名',
      'ball.remove': '移除',
      'ball.empty': '还没有隐藏悬浮球的域名',
      'ball.emptyHint': '在网页上通过右键菜单或浮窗添加后，会出现在这里。',
      'ball.count': '共 {count} 个',
      'ball.added': '已添加 {domain}',
      'ball.removed': '已移除 {domain}',
      'ball.invalid': '请输入有效域名（如 example.com）',
      'ball.loadFailed': '无法加载悬浮球域名列表',
      'common.loading': '加载中…',
      'common.retry': '重试',
      'common.save': '保存',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.refresh': '刷新',
      'settings.modelSection': '翻译模型',
      'settings.model': '模型',
      'settings.modelHint': '模型来自 DSH 已配置的提供方；切换模型后会自动刷新可用的推理强度。',
      'settings.modelEmpty': '暂无可用模型',
      'settings.effort': '推理强度',
      'settings.effortAuto': '自动（推荐）',
      'settings.effortAutoResolved': '自动：当前生效 {effort}',
      'settings.effortUnsupported': '该模型未声明可调推理强度，将使用自动。',
      'settings.effortLoading': '正在读取推理强度…',
      'settings.targetLanguage': '目标语言',
      'settings.prompts': '提示词',
      'settings.systemPrompt': '系统提示词',
      'settings.userTemplate': '用户模板',
      'settings.restoreDefaults': '恢复默认',
      'settings.promptRestored': '已恢复默认提示词，保存后生效',
      'settings.promptContract': '自定义提示词必须保持 JSON 输出契约：返回 {"translations":[...]}，否则翻译会失败。',
      'settings.placeholdersHint': '可用占位符：',
      'settings.chars': '{current}/{max} 字符',
      'settings.dirty': '有未保存的修改',
      'settings.save': '保存设置',
      'settings.saving': '保存中…',
      'settings.saved': '设置已保存',
      'settings.noChanges': '当前没有待保存的修改',
      'settings.saveFailed': '保存失败',
      'settings.privacy': '翻译文本会发送给 DSH 中配置的模型提供方；辅助翻译调用不会写入会话记录。',
      'settings.records': '翻译记录',
      'settings.recordsHint': '关闭后不再记录新的 token 统计、轨迹和 DSH「dsh翻译记录」会话；已有记录可用下方按钮清理。',
      'settings.disableRecord': '关闭翻译记录',
      'settings.disableRecordHint': '默认开启记录（此开关默认关闭）。开启后新的翻译/查词不会写入任何记录。',
      'settings.clearRecords': '清理所有记录',
      'settings.clearRecordsConfirmText': '将清空全部 token 统计/轨迹，并把「dsh翻译记录」分组中的 DSH 会话归档隐藏（DSH 不提供删除会话 API）。此操作不可恢复。',
      'settings.clearRecordsConfirm': '确认清理',
      'settings.clearRecordsDone': '翻译记录已清理',
      'settings.clearRecordsFailed': '清理记录失败',
      'extension.title': '未检测到浏览器扩展',
      'extension.desc': 'DSH 插件只提供翻译后端。要翻译网页和使用划词/双击查词，还需要在浏览器中安装 dsh翻译 Chrome/Edge 扩展。',
      'extension.step1': '打开 GitHub 仓库，下载或克隆项目，找到 dsh-web-translator-extension 目录。',
      'extension.step2': 'Chrome 打开 chrome://extensions，Edge 打开 edge://extensions；开启「开发者模式」，点「加载已解压的扩展程序」，选择该目录。',
      'extension.step3': '安装后刷新本页；检测到扩展后本提示会自动消失。',
      'extension.openRepo': '打开安装说明',
      'extension.recheck': '重新检测',
      'extension.later': '稍后再说',
      'extension.recheckFailed': '仍未检测到扩展，请确认扩展已启用且允许访问本页，然后刷新页面。',
      'settings.test': '测试翻译',
      'settings.testHint': '测试使用已保存的设置；修改后请先保存。',
      'settings.testText': '测试文本',
      'settings.testPlaceholder': '输入要翻译的文本，例如：The quick brown fox jumps over the lazy dog.',
      'settings.testRun': '测试翻译',
      'settings.testing': '翻译中…',
      'settings.testResult': '翻译结果',
      'settings.testEmptyResult': '（模型返回了空译文）',
      'settings.testMeta': '模型 {model} · 推理强度 {effort} · 耗时 {ms} ms',
      'settings.testCached': '命中缓存',
      'settings.loadFailed': '无法加载翻译设置',
      'wordbook.stats.total': '总数',
      'wordbook.stats.due': '待复习',
      'wordbook.stats.todayDue': '今日到期',
      'wordbook.stats.mastered': '已掌握',
      'wordbook.stats.newCount': '新词',
      'wordbook.search': '搜索',
      'wordbook.searchPlaceholder': '搜索单词、译文或备注…',
      'wordbook.filterLabel': '单词筛选',
      'wordbook.filter.due': '待复习',
      'wordbook.filter.all': '全部',
      'wordbook.filter.mastered': '已掌握',
      'wordbook.startReview': '开始复习',
      'wordbook.reviewLimit': '单次最多复习 50 个到期单词',
      'wordbook.loadFailed': '无法加载单词本',
      'wordbook.empty': '单词本还是空的',
      'wordbook.emptyHint': '在网页中划词或双击单词，选择「加入单词本」后就会出现在这里。',
      'wordbook.emptyFiltered': '没有符合条件的单词',
      'wordbook.emptyFilteredHint': '换一个筛选条件或清空搜索再试试。',
      'wordbook.item.due': '下次复习：{when}',
      'wordbook.item.reviews': '已复习 {count} 次',
      'wordbook.item.mastered': '已掌握',
      'wordbook.item.noteLabel': '备注：',
      'wordbook.item.editNote': '编辑备注',
      'wordbook.item.notePlaceholder': '添加备注…',
      'wordbook.item.master': '标记掌握',
      'wordbook.item.unmaster': '取消掌握',
      'wordbook.item.delete': '删除',
      'wordbook.item.confirmDelete': '确认删除',
      'wordbook.notice.noteSaved': '备注已保存',
      'wordbook.notice.mastered': '已标记为掌握',
      'wordbook.notice.unmastered': '已取消掌握',
      'wordbook.notice.removed': '已删除单词',
      'wordbook.dueNow': '现在',
      'wordbook.dueMinutes': '{minutes} 分钟后',
      'wordbook.dueHours': '{hours} 小时后',
      'wordbook.dueDays': '{days} 天后',
      'wordbook.dueNone': '未安排',
      'review.title': '复习单词',
      'review.progress': '第 {current} / {total} 个',
      'review.revealHint': '按空格或点击卡片显示答案',
      'review.revealed': '已显示答案',
      'review.answerTitle': '答案',
      'review.translation': '译文',
      'review.meanings': '词典释义',
      'review.context': '上下文',
      'review.note': '备注',
      'review.grade.again': '不认识',
      'review.grade.hard': '模糊',
      'review.grade.good': '认识',
      'review.gradeHint': '快捷键 1 / 2 / 3',
      'review.gradeError': '评分提交失败，请重试',
      'review.exit': '返回单词本',
      'review.loading': '正在准备复习队列…',
      'review.emptyTitle': '没有到期的单词',
      'review.emptyHint': '稍后再来复习，或继续从网页添加新单词。',
      'review.loadFailed': '无法加载复习队列',
      'review.doneTitle': '本轮复习完成',
      'review.doneSummary': '共复习 {count} 个：不认识 {again}，模糊 {hard}，认识 {good}',
      'review.doneBack': '完成',
      'review.shadowing': '发音练习',
      'pronounce.play': '播放发音',
      'pronounce.playOf': '播放「{word}」的发音',
      'shadowing.start': '🎤 跟读',
      'shadowing.listening': '正在聆听…',
      'shadowing.hint': '请清晰地朗读这个单词',
      'shadowing.unsupported': '当前浏览器不支持语音识别，跟读不可用（请使用 Chrome 或 Edge）。',
      'shadowing.denied': '麦克风权限被拒绝或被占用，跟读不可用。',
      'shadowing.noSpeech': '没有听到声音，请再试一次。',
      'shadowing.failed': '识别失败，请再试一次。',
      'shadowing.youSaid': '识别为：「{text}」',
      'shadowing.pass': '跟读通过',
      'shadowing.fail': '相似度 {percent}%，再试一次',
      'shadowing.retry': '再试一次',
      'shadowing.idle': '跟读评分在本地浏览器完成，不会上传音频。',
      'error.unknown': '发生未知错误',
      'error.withMessage': '请求失败：{message}',
      'error.detail': '（{message}）',
      'error.NETWORK_ERROR': '无法连接 DSH 本地服务，请确认 DSH 正在运行后重试。',
      'error.NETWORK_TIMEOUT': '请求超时，请稍后重试。',
      'error.MODEL_TIMEOUT': '模型响应超时，请稍后重试。',
      'error.TEXT_LIMIT': '文本太长或段数太多，请缩短后重试。',
      'error.MODEL_UNAVAILABLE': '当前模型不可用，请更换模型后再试。',
      'error.MODEL_AUTH': '模型服务鉴权失败，请检查该提供方的配置。',
      'error.MODEL_RATE_LIMITED': '模型服务限流，请稍后重试。',
      'error.MODEL_FAILED': '模型调用失败',
      'error.OUTPUT_TRUNCATED': '模型输出被截断，请缩短文本后重试。',
      'error.INVALID_MODEL_OUTPUT': '模型返回的格式无法解析，请重试或调整提示词。',
      'error.INVALID_SETTINGS': '设置不合法',
      'error.BAD_REQUEST': '请求参数不合法',
      'error.INVALID_URL_OR_TEXT': '文本或链接不合法',
      'error.WORD_NOT_FOUND': '没有找到该单词',
      'error.FORBIDDEN_ORIGIN': '请求来源不被允许',
      'error.NOT_FOUND': '接口不存在，请确认插件 Host 半已启用。',
      'error.METHOD_NOT_ALLOWED': '请求方法不被允许',
      'error.INTERNAL': '服务内部错误',
      'error.BAD_RESPONSE': '服务返回了无法识别的数据',
      'error.HTTP': '请求失败（HTTP {status}）',
      'lang.zhCN': '简体中文',
      'lang.zhTW': '繁體中文',
      'lang.en': 'English',
      'lang.ja': '日本語',
      'lang.ko': '한국어',
      'lang.fr': 'Français',
      'lang.de': 'Deutsch',
      'lang.es': 'Español',
      'lang.ru': 'Русский',
      'lang.pt': 'Português',
      'lang.it': 'Italiano',
      'lang.ar': 'العربية',
      // v3: left-toolbar token stats page (panel./usage./trace. prefixes).
      'panel.title': 'dsh翻译',
      'panel.subtitle': '浏览器扩展翻译后端 · Token 统计',
      'panel.tabsLabel': 'dsh翻译面板',
      'panel.tab.overview': '概览',
      'panel.tab.traces': '轨迹',
      'panel.tab.settings': '设置',
      'panel.tab.wordbook': '单词本',
      'panel.modelChip': '模型 {model}',
      'panel.modelEmpty': '未选择模型',
      'panel.modelChipTitle': '当前翻译模型（可在设置中修改）',
      'panel.todayTokens': '今日 {tokens} tokens',
      'panel.todayTokensTitle': '今日：输入 {input} · 输出 {output} tokens',
      'panel.refreshing': '正在刷新…',
      'panel.refreshed': '已刷新',
      'panel.refreshFailed': '刷新失败',
      'panel.hostOutdated': 'Host 版本过旧',
      'panel.hostOutdatedHint': '当前 Host 未提供 /usage 接口，token 统计暂不可用；设置与单词本仍可正常使用。',
      'panel.hint': '完整统计与提示词编辑也可在左侧工具栏的dsh翻译页面中完成。',
      'panel.openPanel': '打开统计面板',
      'panel.updatedAt': '更新于 {time}',
      'usage.todayTitle': '今日统计',
      'usage.stat.requests': '请求数',
      'usage.stat.input': '输入 tokens',
      'usage.stat.output': '输出 tokens',
      'usage.stat.cacheRead': '缓存命中 tokens',
      'usage.stat.errors': '失败数',
      'usage.stat.avgLatency': '平均时延',
      'usage.chartTitle': '近 14 天',
      'usage.chartAria': '近 14 天每日 token 消耗柱状图',
      'usage.chartBar': '请求 {requests} · 输入 {input} · 输出 {output}',
      'usage.chartEmpty': '暂无数据',
      'usage.legendInput': '输入',
      'usage.legendOutput': '输出',
      'usage.modelTitle': '模型分布',
      'usage.modelEmpty': '暂无模型数据',
      'usage.col.providerModel': '提供方 / 模型',
      'usage.col.requests': '请求',
      'usage.col.input': '输入',
      'usage.col.output': '输出',
      'usage.col.cacheRead': '缓存读',
      'usage.col.lastUsed': '最近使用',
      'usage.kindTitle': '类型分布',
      'usage.kind.translate': '翻译',
      'usage.kind.lookup': '查词',
      'usage.kindRequests': '{count} 次请求',
      'usage.kindTokens': '输入 {input} · 输出 {output}',
      'usage.empty': '暂无统计数据',
      'usage.emptyHint': '浏览器扩展发起翻译或查词后，这里会显示 token 消耗与轨迹。',
      'usage.loadFailed': '无法加载统计',
      'usage.noValue': '—',
      'usage.durationMs': '{value} ms',
      'usage.durationS': '{value} s',
      'usage.footer': '累计 {requests} 次请求 · {tokens} tokens',
      'trace.listTitle': '请求轨迹',
      'trace.filterLabel': '筛选轨迹',
      'trace.filter.all': '全部',
      'trace.filter.translate': '翻译',
      'trace.filter.lookup': '查词',
      'trace.filter.error': '仅失败',
      'cache.title': '翻译结果缓存',
      'cache.desc': '相同原文 / 提示词 / 模型再次翻译时直接复用译文，0 token 调用。缓存持久化到本机，保留 7 天、最多 1000 批。',
      'cache.clear': '清空翻译结果缓存',
      'cache.clearConfirm': '确认清空缓存',
      'cache.cancel': '取消',
      'cache.clearing': '正在清空…',
      'cache.cleared': '翻译结果缓存已清空',
      'cache.clearFailed': '清空缓存失败',
      'cache.notSupported': 'Host 版本过旧，暂不支持缓存接口',
      'trace.clear': '清空统计',
      'trace.clearConfirmText': '清空全部 token 统计？此操作不可恢复。',
      'trace.clearConfirm': '确认清空',
      'trace.clearDone': '统计已清空',
      'trace.clearFailed': '清空失败',
      'trace.loadFailed': '无法加载轨迹',
      'trace.empty': '暂无轨迹',
      'trace.emptyHint': '翻译或查词请求完成后会记录在这里。',
      'trace.openConversation': '打开 DSH 轨迹',
      'trace.openConversationAria': '在 DSH 原生轨迹中打开该翻译会话',
      'trace.conversationHint': '该轮已记录为 DSH 会话，可在 DSH 原生「轨迹 / 统计」中查看每一轮对话。',
      'trace.conversation.titleFallback': '翻译会话',
      'trace.conversation.listLabel': '翻译会话列表',
      'trace.conversation.turns': '{count} 轮',
      'trace.conversation.live': '进行中',
      'trace.conversation.groupAria': '{title}：{turns}，{status}',
      'trace.conversation.openUnavailable': '当前 Host 未提供 DSH 工作区服务，无法打开原生轨迹',
      'trace.conversation.nativeHint': '每轮完整内容与 Token 详见 DSH 原生轨迹 / 统计',
      'trace.conversation.legacyTitle': '旧版请求（无 DSH 会话）',
      'trace.conversation.legacyHint': '这些请求没有对应的 DSH 会话，仅显示插件内联轨迹。',
      'trace.conversation.emptyTurns': '该会话暂无轮次数据',
      'trace.emptyFiltered': '没有符合条件的轨迹',
      'trace.emptyFilteredHint': '换一个筛选条件再试试。',
      'trace.ok': '成功',
      'trace.error': '失败',
      'trace.expand': '展开详情',
      'trace.collapse': '收起详情',
      'trace.rowLabel': '轨迹：{time}，{kind}，模型 {model}，{status}',
      'trace.rowTokens': '↑ {input} ↓ {output}',
      'trace.siteUnknown': '无来源',
      'trace.modelUnknown': '模型未知',
      'trace.segmentsChars': '{segments} 段 · {chars} 字符',
      'trace.detail.time': '时间',
      'trace.detail.kind': '类型',
      'trace.detail.model': '模型',
      'trace.detail.site': '站点',
      'trace.detail.sourceTitle': '来源标题',
      'trace.detail.sourceUrl': '来源链接',
      'trace.detail.sample': '样例',
      'trace.detail.cached': '缓存命中',
      'trace.detail.yes': '是',
      'trace.detail.no': '否',
      'trace.detail.retries': '重试次数',
      'trace.detail.errorCode': '错误码',
      'trace.detail.client': '客户端',
      'trace.detail.latency': '时延',
      'trace.detail.tokens': '输入 / 输出 tokens',
      'trace.detail.cacheTokens': '缓存读 / 写 tokens',
      'trace.detail.segments': '段数 / 字符数',
      'trace.detail.languages': '源语言 → 目标语言',
      'trace.turnLabel': '第 {index} 轮',
      'trace.turnAria': '{turn}：{kind}，{steps}，{status}',
      'trace.kind.translate': '翻译',
      'trace.kind.lookup': '查词',
      'trace.kind.mixed': '混合',
      'trace.mode.bilingual': '双语对照',
      'trace.mode.only': '仅译文',
      'trace.mode.source': '原文',
      'trace.status.ok': '成功',
      'trace.status.partial': '部分失败',
      'trace.status.error': '失败',
      'trace.steps': '{count} 步',
      'trace.stepsEmpty': '这一次没有步骤数据',
      'trace.cacheRead': '缓存读',
      'trace.loadMore': '加载更早',
      'trace.loadingMore': '正在加载更早的轨迹…',
      'trace.loadMoreFailed': '无法加载更早的轨迹',
      'trace.legacy': 'Host 版本过旧，仅显示请求级轨迹',
      'trace.inputSample': '输入样例',
      'trace.outputSample': '译出样例',
      'trace.stepLabel': '步 {index}',
      'trace.stepAria': '{step}：{segments}，{tokens}，{status}',
      'trace.turnMeta.startTime': '开始时间',
      'trace.turnMeta.sourceUrl': '来源链接',
      'trace.turnMeta.targetLanguage': '目标语言',
      'trace.turnMeta.client': '客户端',
      'trace.turnMeta.segments': '段数 / 字符数',
      'trace.turnMeta.cacheTokens': '缓存读 / 写 tokens',
      'trace.turnMeta.avgLatency': '平均时延',
      'trace.turnMeta.requests': '请求数 / 缓存命中',
      'trace.step.tokens': '输入 / 输出 tokens',
      'trace.step.cacheTokens': '缓存读 / 写 tokens',
      'trace.step.languages': '源语言 → 目标语言',
    };
    // #endregion

    // #region en-dictionary
    const EN = {
      'title': 'dsh-web-translator',
      'subtitle': 'Translation backend for the browser extension. Switch models, tune prompts, test translation, and review your wordbook here.',
      'tabs.label': 'dsh-web-translator sections',
      'tabs.settings': 'Translation',
      'tabs.wordbook': 'Wordbook',
      'tabs.ball': 'Floating ball',
      'ball.title': 'Domains without floating ball',
      'ball.hint': 'The floating ball is hidden on these domains. Add one from the page right-click menu (“dsh翻译 → 当前域名不展示悬浮球”) or the floating panel; remove or add manually here.',
      'ball.placeholder': 'example.com',
      'ball.add': 'Add domain',
      'ball.remove': 'Remove',
      'ball.empty': 'No domains hidden yet',
      'ball.emptyHint': 'Domains added from the page right-click menu or floating panel will appear here.',
      'ball.count': '{count} total',
      'ball.added': 'Added {domain}',
      'ball.removed': 'Removed {domain}',
      'ball.invalid': 'Enter a valid domain (e.g. example.com)',
      'ball.loadFailed': 'Could not load the hidden-domain list',
      'common.loading': 'Loading…',
      'common.retry': 'Retry',
      'common.save': 'Save',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.refresh': 'Refresh',
      'settings.modelSection': 'Translation model',
      'settings.model': 'Model',
      'settings.modelHint': 'Models come from providers configured in DSH; switching a model refreshes the available reasoning efforts.',
      'settings.modelEmpty': 'No models available',
      'settings.effort': 'Reasoning effort',
      'settings.effortAuto': 'Auto (recommended)',
      'settings.effortAutoResolved': 'Auto: currently {effort}',
      'settings.effortUnsupported': 'This model declares no reasoning efforts; auto is used.',
      'settings.effortLoading': 'Loading reasoning efforts…',
      'settings.targetLanguage': 'Target language',
      'settings.prompts': 'Prompts',
      'settings.systemPrompt': 'System prompt',
      'settings.userTemplate': 'User template',
      'settings.restoreDefaults': 'Restore defaults',
      'settings.promptRestored': 'Default prompts restored; save to apply',
      'settings.promptContract': 'Custom prompts must keep the JSON output contract: return {"translations":[...]}, otherwise translation fails.',
      'settings.placeholdersHint': 'Available placeholders: ',
      'settings.chars': '{current}/{max} characters',
      'settings.dirty': 'Unsaved changes',
      'settings.save': 'Save settings',
      'settings.saving': 'Saving…',
      'settings.saved': 'Settings saved',
      'settings.noChanges': 'No pending changes',
      'settings.saveFailed': 'Save failed',
      'settings.privacy': 'Translated text is sent to the model provider configured in DSH; these auxiliary calls are not written to session logs.',
      'settings.records': 'Translation records',
      'settings.recordsHint': 'When disabled, new token stats, traces and「dsh翻译记录」DSH conversations are not recorded. Existing records can be cleared below.',
      'settings.disableRecord': 'Disable translation recording',
      'settings.disableRecordHint': 'Recording is on by default (this switch is off by default). When enabled, new translations/lookups write no records.',
      'settings.clearRecords': 'Clear all records',
      'settings.clearRecordsConfirmText': 'Clears all token stats/traces and archives the translation conversations out of the「dsh翻译记录」group (DSH has no session-delete API). This cannot be undone.',
      'settings.clearRecordsConfirm': 'Clear records',
      'settings.clearRecordsDone': 'Translation records cleared',
      'settings.clearRecordsFailed': 'Could not clear records',
      'extension.title': 'Browser extension not detected',
      'extension.desc': 'The DSH plugin only provides the translation backend. To translate pages and look up words in the browser, install the dsh翻译 Chrome/Edge extension.',
      'extension.step1': 'Open the GitHub repository, download or clone it and locate the dsh-web-translator-extension directory.',
      'extension.step2': 'Open chrome://extensions (Chrome) or edge://extensions (Edge), enable Developer mode, click “Load unpacked” and select that directory.',
      'extension.step3': 'Reload this page after installing; this reminder disappears once the extension is detected.',
      'extension.openRepo': 'Open install guide',
      'extension.recheck': 'Check again',
      'extension.later': 'Later',
      'extension.recheckFailed': 'Extension still not detected. Make sure it is enabled and allowed on this page, then reload.',
      'settings.test': 'Test translation',
      'settings.testHint': 'The test uses the saved settings; save your changes first.',
      'settings.testText': 'Test text',
      'settings.testPlaceholder': 'Enter text to translate, e.g. The quick brown fox jumps over the lazy dog.',
      'settings.testRun': 'Translate',
      'settings.testing': 'Translating…',
      'settings.testResult': 'Result',
      'settings.testEmptyResult': '(the model returned an empty translation)',
      'settings.testMeta': 'Model {model} · effort {effort} · {ms} ms',
      'settings.testCached': 'cached',
      'settings.loadFailed': 'Could not load translation settings',
      'wordbook.stats.total': 'Total',
      'wordbook.stats.due': 'Due',
      'wordbook.stats.todayDue': 'Due today',
      'wordbook.stats.mastered': 'Mastered',
      'wordbook.stats.newCount': 'New',
      'wordbook.search': 'Search',
      'wordbook.searchPlaceholder': 'Search word, translation, or note…',
      'wordbook.filterLabel': 'Wordbook filter',
      'wordbook.filter.due': 'Due',
      'wordbook.filter.all': 'All',
      'wordbook.filter.mastered': 'Mastered',
      'wordbook.startReview': 'Start review',
      'wordbook.reviewLimit': 'Up to 50 due words per session',
      'wordbook.loadFailed': 'Could not load the wordbook',
      'wordbook.empty': 'Your wordbook is empty',
      'wordbook.emptyHint': 'Select a word on a web page, then choose “Add to wordbook” to see it here.',
      'wordbook.emptyFiltered': 'No matching words',
      'wordbook.emptyFilteredHint': 'Try another filter or clear the search.',
      'wordbook.item.due': 'Next review: {when}',
      'wordbook.item.reviews': '{count} reviews',
      'wordbook.item.mastered': 'Mastered',
      'wordbook.item.noteLabel': 'Note: ',
      'wordbook.item.editNote': 'Edit note',
      'wordbook.item.notePlaceholder': 'Add a note…',
      'wordbook.item.master': 'Mark mastered',
      'wordbook.item.unmaster': 'Unmark mastered',
      'wordbook.item.delete': 'Delete',
      'wordbook.item.confirmDelete': 'Confirm delete',
      'wordbook.notice.noteSaved': 'Note saved',
      'wordbook.notice.mastered': 'Marked as mastered',
      'wordbook.notice.unmastered': 'Mastered mark removed',
      'wordbook.notice.removed': 'Word deleted',
      'wordbook.dueNow': 'now',
      'wordbook.dueMinutes': 'in {minutes} min',
      'wordbook.dueHours': 'in {hours} h',
      'wordbook.dueDays': 'in {days} d',
      'wordbook.dueNone': 'not scheduled',
      'review.title': 'Review',
      'review.progress': '{current} / {total}',
      'review.revealHint': 'Press Space or click the card to reveal the answer',
      'review.revealed': 'Answer shown',
      'review.answerTitle': 'Answer',
      'review.translation': 'Translation',
      'review.meanings': 'Dictionary',
      'review.context': 'Context',
      'review.note': 'Note',
      'review.grade.again': 'Forgot',
      'review.grade.hard': 'Hard',
      'review.grade.good': 'Good',
      'review.gradeHint': 'Shortcuts 1 / 2 / 3',
      'review.gradeError': 'Could not save the grade; try again',
      'review.exit': 'Back to wordbook',
      'review.loading': 'Preparing the review queue…',
      'review.emptyTitle': 'No words due',
      'review.emptyHint': 'Come back later, or keep adding words from web pages.',
      'review.loadFailed': 'Could not load the review queue',
      'review.doneTitle': 'Session complete',
      'review.doneSummary': '{count} reviewed: forgot {again}, hard {hard}, good {good}',
      'review.doneBack': 'Done',
      'review.shadowing': 'Pronunciation practice',
      'pronounce.play': 'Play pronunciation',
      'pronounce.playOf': 'Play pronunciation of “{word}”',
      'shadowing.start': '🎤 Shadow',
      'shadowing.listening': 'Listening…',
      'shadowing.hint': 'Read the word aloud clearly',
      'shadowing.unsupported': 'Speech recognition is unavailable in this browser (use Chrome or Edge).',
      'shadowing.denied': 'Microphone permission was denied or is busy; follow-along is unavailable.',
      'shadowing.noSpeech': 'No speech detected; try again.',
      'shadowing.failed': 'Recognition failed; try again.',
      'shadowing.youSaid': 'Heard: “{text}”',
      'shadowing.pass': 'Nice, that matches',
      'shadowing.fail': '{percent}% match; try again',
      'shadowing.retry': 'Try again',
      'shadowing.idle': 'Scoring runs locally in your browser; audio is not uploaded.',
      'error.unknown': 'Something went wrong',
      'error.withMessage': 'Request failed: {message}',
      'error.detail': '({message})',
      'error.NETWORK_ERROR': 'Cannot reach the local DSH service; make sure DSH is running, then retry.',
      'error.NETWORK_TIMEOUT': 'The request timed out; try again later.',
      'error.MODEL_TIMEOUT': 'The model timed out; try again later.',
      'error.TEXT_LIMIT': 'The text is too long; shorten it and retry.',
      'error.MODEL_UNAVAILABLE': 'The selected model is unavailable; choose another model.',
      'error.MODEL_AUTH': 'Model authentication failed; check the provider configuration.',
      'error.MODEL_RATE_LIMITED': 'The model provider is rate limiting; try again later.',
      'error.MODEL_FAILED': 'The model call failed',
      'error.OUTPUT_TRUNCATED': 'The model output was truncated; shorten the text and retry.',
      'error.INVALID_MODEL_OUTPUT': 'The model returned unparseable output; retry or adjust the prompts.',
      'error.INVALID_SETTINGS': 'Invalid settings',
      'error.BAD_REQUEST': 'Invalid request parameters',
      'error.INVALID_URL_OR_TEXT': 'Invalid text or link',
      'error.WORD_NOT_FOUND': 'Word not found',
      'error.FORBIDDEN_ORIGIN': 'The request origin is not allowed',
      'error.NOT_FOUND': 'Endpoint not found; check that the plugin host half is enabled.',
      'error.METHOD_NOT_ALLOWED': 'Request method not allowed',
      'error.INTERNAL': 'Internal service error',
      'error.BAD_RESPONSE': 'The service returned unexpected data',
      'error.HTTP': 'Request failed (HTTP {status})',
      'lang.zhCN': '简体中文',
      'lang.zhTW': '繁體中文',
      'lang.en': 'English',
      'lang.ja': '日本語',
      'lang.ko': '한국어',
      'lang.fr': 'Français',
      'lang.de': 'Deutsch',
      'lang.es': 'Español',
      'lang.ru': 'Русский',
      'lang.pt': 'Português',
      'lang.it': 'Italiano',
      'lang.ar': 'العربية',
      // v3: left-toolbar token stats page (panel./usage./trace. prefixes).
      'panel.title': 'dsh-web-translator',
      'panel.subtitle': 'Browser extension translation backend · token stats',
      'panel.tabsLabel': 'dsh-web-translator panels',
      'panel.tab.overview': 'Overview',
      'panel.tab.traces': 'Traces',
      'panel.tab.settings': 'Settings',
      'panel.tab.wordbook': 'Wordbook',
      'panel.modelChip': 'Model {model}',
      'panel.modelEmpty': 'No model selected',
      'panel.modelChipTitle': 'Current translation model (change it in Settings)',
      'panel.todayTokens': 'Today {tokens} tokens',
      'panel.todayTokensTitle': 'Today: {input} input · {output} output tokens',
      'panel.refreshing': 'Refreshing…',
      'panel.refreshed': 'Refreshed',
      'panel.refreshFailed': 'Refresh failed',
      'panel.hostOutdated': 'Host version is too old',
      'panel.hostOutdatedHint': 'This Host does not expose /usage, so token stats are unavailable. Settings and the wordbook still work.',
      'panel.hint': 'Full stats and prompt editing are also available on the dsh-web-translator page in the left toolbar.',
      'panel.openPanel': 'Open stats panel',
      'panel.updatedAt': 'Updated at {time}',
      'usage.todayTitle': 'Today',
      'usage.stat.requests': 'Requests',
      'usage.stat.input': 'Input tokens',
      'usage.stat.output': 'Output tokens',
      'usage.stat.cacheRead': 'Cache-read tokens',
      'usage.stat.errors': 'Errors',
      'usage.stat.avgLatency': 'Avg latency',
      'usage.chartTitle': 'Last 14 days',
      'usage.chartAria': 'Daily token usage over the last 14 days',
      'usage.chartBar': '{requests} requests · {input} input · {output} output',
      'usage.chartEmpty': 'No data yet',
      'usage.legendInput': 'Input',
      'usage.legendOutput': 'Output',
      'usage.modelTitle': 'By model',
      'usage.modelEmpty': 'No model data yet',
      'usage.col.providerModel': 'Provider / model',
      'usage.col.requests': 'Requests',
      'usage.col.input': 'Input',
      'usage.col.output': 'Output',
      'usage.col.cacheRead': 'Cache read',
      'usage.col.lastUsed': 'Last used',
      'usage.kindTitle': 'By kind',
      'usage.kind.translate': 'Translate',
      'usage.kind.lookup': 'Lookup',
      'usage.kindRequests': '{count} requests',
      'usage.kindTokens': 'Input {input} · output {output}',
      'usage.empty': 'No stats yet',
      'usage.emptyHint': 'Translate or look up a word from the browser extension and token usage will show up here.',
      'usage.loadFailed': 'Could not load stats',
      'usage.noValue': '—',
      'usage.durationMs': '{value} ms',
      'usage.durationS': '{value} s',
      'usage.footer': '{requests} requests · {tokens} tokens in total',
      'trace.listTitle': 'Request traces',
      'trace.filterLabel': 'Filter traces',
      'trace.filter.all': 'All',
      'trace.filter.translate': 'Translate',
      'trace.filter.lookup': 'Lookup',
      'trace.filter.error': 'Failures only',
      'cache.title': 'Translation result cache',
      'cache.desc': 'Reuses translations for identical source text, prompts and model (0-token calls). Persisted on this machine, kept for 7 days (max 1000 batches).',
      'cache.clear': 'Clear result cache',
      'cache.clearConfirm': 'Confirm clear',
      'cache.cancel': 'Cancel',
      'cache.clearing': 'Clearing…',
      'cache.cleared': 'Result cache cleared',
      'cache.clearFailed': 'Could not clear cache',
      'cache.notSupported': 'Host is too old for the cache API',
      'trace.clear': 'Clear stats',
      'trace.clearConfirmText': 'Clear all token stats? This cannot be undone.',
      'trace.clearConfirm': 'Clear',
      'trace.clearDone': 'Stats cleared',
      'trace.clearFailed': 'Could not clear stats',
      'trace.loadFailed': 'Could not load traces',
      'trace.empty': 'No traces yet',
      'trace.emptyHint': 'Traces appear here after translation or lookup requests complete.',
      'trace.openConversation': 'Open DSH trajectory',
      'trace.openConversationAria': 'Open this translation conversation in the DSH native trajectory',
      'trace.conversationHint': 'This turn is recorded as a DSH conversation; see its turns in the native DSH Trajectory / Stats views.',
      'trace.conversation.titleFallback': 'Translation conversation',
      'trace.conversation.listLabel': 'Translation conversations',
      'trace.conversation.turns': '{count} turns',
      'trace.conversation.live': 'Live',
      'trace.conversation.groupAria': '{title}: {turns}, {status}',
      'trace.conversation.openUnavailable': 'The Host does not expose the DSH workspace service, so the native trajectory cannot be opened.',
      'trace.conversation.nativeHint': 'See the native DSH Trajectory / Stats views for each turn\'s full content and tokens.',
      'trace.conversation.legacyTitle': 'Legacy requests (no DSH conversation)',
      'trace.conversation.legacyHint': 'These requests have no DSH conversation; only the inline plugin trace is available.',
      'trace.conversation.emptyTurns': 'No turns recorded for this conversation yet.',
      'trace.emptyFiltered': 'No matching traces',
      'trace.emptyFilteredHint': 'Try another filter.',
      'trace.ok': 'OK',
      'trace.error': 'Error',
      'trace.expand': 'Show details',
      'trace.collapse': 'Hide details',
      'trace.rowLabel': 'Trace: {time}, {kind}, model {model}, {status}',
      'trace.rowTokens': '↑ {input} ↓ {output}',
      'trace.siteUnknown': 'No source',
      'trace.modelUnknown': 'Unknown model',
      'trace.segmentsChars': '{segments} seg · {chars} chars',
      'trace.detail.time': 'Time',
      'trace.detail.kind': 'Kind',
      'trace.detail.model': 'Model',
      'trace.detail.site': 'Site',
      'trace.detail.sourceTitle': 'Source title',
      'trace.detail.sourceUrl': 'Source URL',
      'trace.detail.sample': 'Sample',
      'trace.detail.cached': 'Cached',
      'trace.detail.yes': 'Yes',
      'trace.detail.no': 'No',
      'trace.detail.retries': 'Retries',
      'trace.detail.errorCode': 'Error code',
      'trace.detail.client': 'Client',
      'trace.detail.latency': 'Latency',
      'trace.detail.tokens': 'Input / output tokens',
      'trace.detail.cacheTokens': 'Cache read / write tokens',
      'trace.detail.segments': 'Segments / characters',
      'trace.detail.languages': 'Source → target language',
      'trace.turnLabel': 'Turn {index}',
      'trace.turnAria': '{turn}: {kind}, {steps}, {status}',
      'trace.kind.translate': 'Translate',
      'trace.kind.lookup': 'Lookup',
      'trace.kind.mixed': 'Mixed',
      'trace.mode.bilingual': 'Bilingual',
      'trace.mode.only': 'Translation only',
      'trace.mode.source': 'Source only',
      'trace.status.ok': 'OK',
      'trace.status.partial': 'Partial',
      'trace.status.error': 'Failed',
      'trace.steps': '{count} steps',
      'trace.stepsEmpty': 'No step data for this turn',
      'trace.cacheRead': 'Cache read',
      'trace.loadMore': 'Load earlier',
      'trace.loadingMore': 'Loading earlier traces…',
      'trace.loadMoreFailed': 'Could not load earlier traces',
      'trace.legacy': 'Host is outdated; showing request-level traces only',
      'trace.inputSample': 'Input sample',
      'trace.outputSample': 'Output sample',
      'trace.stepLabel': 'Step {index}',
      'trace.stepAria': '{step}: {segments}, {tokens}, {status}',
      'trace.turnMeta.startTime': 'Started',
      'trace.turnMeta.sourceUrl': 'Source URL',
      'trace.turnMeta.targetLanguage': 'Target language',
      'trace.turnMeta.client': 'Client',
      'trace.turnMeta.segments': 'Segments / characters',
      'trace.turnMeta.cacheTokens': 'Cache read / write tokens',
      'trace.turnMeta.avgLatency': 'Avg latency',
      'trace.turnMeta.requests': 'Requests / cache hits',
      'trace.step.tokens': 'Input / output tokens',
      'trace.step.cacheTokens': 'Cache read / write tokens',
      'trace.step.languages': 'Source → target language',
    };
    // #endregion

    // #region locale-bridge
    /** Built-in dictionaries kept as the fallback when the locale service is missing. */
    const FALLBACK_DICT = ZH;

    /** Shared locale state: bound translate function plus render listeners. */
    const localeBridge = {
      bound: null,
      listeners: new Set(),
      version: 0,
    };

    /** Late-attach state for the optional locale service. */
    const localeRuntime = {
      ctx: null,
      connected: false,
      disposers: [],
    };

    /** Replace {name} placeholders in a dictionary template. */
    function interpolate(template, params) {
      if (params === null || params === undefined) return template;
      return String(template).replace(/\{(\w+)\}/g, (match, name) => {
        const value = params[name];
        return value === null || value === undefined ? match : String(value);
      });
    }
    /** Translate one namespace key, falling back to the built-in dictionary. */
    function translate(key, params) {
      const bound = localeBridge.bound;
      if (typeof bound === 'function') {
        try {
          const text = bound(key, params);
          if (typeof text === 'string') return text;
        } catch (error) {
          /* fall through to the built-in dictionary */
        }
      }
      const template = FALLBACK_DICT[key];
      return typeof template === 'string' ? interpolate(template, params) : key;
    }
    /** Notify mounted components that the active locale or dictionaries changed. */
    function notifyLocale() {
      localeBridge.version += 1;
      const listeners = Array.from(localeBridge.listeners);
      for (let index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index](localeBridge.version);
        } catch (error) {
          /* a broken listener must not break the others */
        }
      }
    }
    /**
     * Attach to the locale service: register the zh/en dictionaries, bind the
     * translator, and subscribe for re-renders. Called from apply and retried
     * when the Settings section mounts, so a locale service that appears after
     * this plugin applies is still picked up.
     */
    function connectLocale() {
      if (localeRuntime.connected) return true;
      const ctx = localeRuntime.ctx;
      if (!ctx || typeof ctx.get !== 'function') return false;
      let service = null;
      try {
        service = ctx.get('locale');
      } catch (error) {
        service = null;
      }
      if (!service || typeof service.register !== 'function') return false;
      localeRuntime.connected = true;
      try {
        localeRuntime.disposers.push(service.register(NS, 'zh', ZH));
      } catch (error) {
        /* keep the built-in fallback dictionary */
      }
      try {
        localeRuntime.disposers.push(service.register(NS, 'en', EN));
      } catch (error) {
        /* keep the built-in fallback dictionary */
      }
      if (typeof service.bind === 'function') {
        try {
          localeBridge.bound = service.bind(NS);
        } catch (error) {
          localeBridge.bound = null;
        }
      }
      if (typeof service.subscribe === 'function') {
        try {
          localeRuntime.disposers.push(service.subscribe(() => notifyLocale()));
        } catch (error) {
          /* locale switches fall back to the next mount */
        }
      }
      notifyLocale();
      return true;
    }

    /** Release the locale dictionaries, bound translator, and subscription. */
    function disconnectLocale() {
      localeRuntime.connected = false;
      localeBridge.bound = null;
      const disposers = localeRuntime.disposers.splice(0, localeRuntime.disposers.length);
      for (let index = 0; index < disposers.length; index += 1) {
        try {
          disposers[index]();
        } catch (error) {
          /* ignore */
        }
      }
    }

    /** Hook: re-render the calling component whenever the locale changes. */
    function useT() {
      const state = React.useReducer((value) => value + 1, 0);
      const force = state[1];
      useEffect(() => {
        const listener = () => force();
        localeBridge.listeners.add(listener);
        return () => {
          localeBridge.listeners.delete(listener);
        };
      }, []);
      return translate;
    }
    // #endregion

    // #region layout-bridge
    /**
     * Optional layout service (ctx.inject(['layout'])) used only by the Settings
     * hint row to jump to the left-toolbar page. Hosts without the layout service
     * keep the plain settings page; nothing here may throw.
     */
    const layoutBridge = {
      service: null,
      listeners: new Set(),
    };

    /** Notify mounted components that the optional layout service appeared. */
    function notifyLayoutService() {
      const listeners = Array.from(layoutBridge.listeners);
      for (let index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index]();
        } catch (error) {
          /* a broken listener must not break the others */
        }
      }
    }

    /** Hook: current layout service (null when unavailable) plus re-render on attach. */
    function useLayoutService() {
      const state = React.useReducer((value) => value + 1, 0);
      const force = state[1];
      useEffect(() => {
        layoutBridge.listeners.add(force);
        return () => {
          layoutBridge.listeners.delete(force);
        };
      }, []);
      return layoutBridge.service;
    }

    /** Select this plugin's main panel when the layout service is available. */
    function openStatsPanel() {
      const service = layoutBridge.service;
      if (!service || typeof service.selectPanel !== 'function') return;
      try {
        service.selectPanel(PANEL_ID);
      } catch (error) {
        /* the main panel is not registered (older Host) — keep the settings page */
      }
    }
    /**
     * Optional workspace/navigation service (`ctx.inject(['uiWorkspace'])`).
     * Used by the 轨迹 tab to open the native DSH conversation (Trajectory view)
     * for a translation turn. Hosts without it keep the inline turn view.
     */
    const workspaceBridge = {
      service: null,
      listeners: new Set(),
    };

    /** Notify mounted components that the optional uiWorkspace service appeared. */
    function notifyWorkspaceService() {
      const listeners = Array.from(workspaceBridge.listeners);
      for (let index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index]();
        } catch (error) {
          /* a broken listener must not break the others */
        }
      }
    }

    /** Hook: current uiWorkspace service (null when unavailable) plus re-render on attach. */
    function useWorkspaceService() {
      const state = React.useReducer((value) => value + 1, 0);
      const force = state[1];
      useEffect(() => {
        workspaceBridge.listeners.add(force);
        return () => {
          workspaceBridge.listeners.delete(force);
        };
      }, []);
      return workspaceBridge.service;
    }

    /**
     * Open one translation conversation in the native DSH main panel, where the
     * conversation's own 对话 / 轨迹 / 统计 views become available.
     * @param {string|undefined} sessionId - conversation session id.
     * @returns {boolean} whether a navigation was attempted.
     */
    function openConversation(sessionId) {
      const service = workspaceBridge.service;
      if (!service || typeof service.openSession !== 'function') return false;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
      try {
        service.openSession(sessionId);
        return true;
      } catch (error) {
        return false;
      }
    }
    // #endregion

    // #region api
    /** Error carrying the Host error envelope code plus an HTTP status. */
    class ApiError extends Error {
      constructor(code, message, status) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
      }
    }
    /** Build a directory base URL from the document base, dropping query/hash. */
    function dirBase() {
      const base = document.baseURI;
      const url = new URL(base, 'http://dsh.internal/');
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url;
    }
    /** Absolute API URL for one endpoint, resolved against the document base. */
    function apiUrl(name, query) {
      const url = new URL(API_BASE + name, dirBase());
      if (query !== null && query !== undefined) {
        const keys = Object.keys(query);
        for (let index = 0; index < keys.length; index += 1) {
          const value = query[keys[index]];
          if (value !== null && value !== undefined && value !== '') url.searchParams.set(keys[index], String(value));
        }
      }
      return url.toString();
    }
    /** Same-origin JSON request with a timeout and envelope-aware errors. */
    async function request(name, options) {
      const config = options || {};
      const method = config.method || 'GET';
      const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 30000;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer = null;
      if (controller && timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            controller.abort();
          } catch (error) {
            /* ignore */
          }
        }, timeoutMs);
      }
      const fetchOptions = {
        method: method,
        credentials: 'same-origin',
        cache: 'no-store',
      };
      if (controller) fetchOptions.signal = controller.signal;
      if (config.body !== undefined) {
        fetchOptions.headers = { 'content-type': 'application/json' };
        fetchOptions.body = JSON.stringify(config.body);
      }
      let response = null;
      try {
        response = await fetch(apiUrl(name, config.query), fetchOptions);
      } catch (error) {
        if (error && (error.name === 'AbortError' || error.code === 20)) {
          throw new ApiError('NETWORK_TIMEOUT', 'Request timed out', 0);
        }
        throw new ApiError('NETWORK_ERROR', error && error.message ? String(error.message) : 'Network error', 0);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      let raw = '';
      try {
        raw = await response.text();
      } catch (error) {
        raw = '';
      }
      let payload = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          payload = null;
        }
      }
      if (!response.ok || (payload && payload.ok === false)) {
        const info = payload && payload.error ? payload.error : null;
        const code = info && typeof info.code === 'string' && info.code ? info.code : 'HTTP';
        const message = info && typeof info.message === 'string' && info.message ? info.message : 'HTTP ' + response.status;
        throw new ApiError(code, message, response.status);
      }
      if (!payload || typeof payload !== 'object' || payload.ok !== true) {
        throw new ApiError('BAD_RESPONSE', 'Unexpected response', response.status);
      }
      return payload;
    }
    /** Thin typed helpers over request(). */
    const api = {
      get(name, query, options) {
        return request(name, Object.assign({ method: 'GET', query: query }, options));
      },
      post(name, body, options) {
        return request(name, Object.assign({ method: 'POST', body: body }, options));
      },
      put(name, body, options) {
        return request(name, Object.assign({ method: 'PUT', body: body }, options));
      },
    };
    /** Error codes whose friendly text is improved by the Host raw message. */
    const DETAILED_ERROR_CODES = {
      INVALID_SETTINGS: true,
      BAD_REQUEST: true,
      INTERNAL: true,
      MODEL_FAILED: true,
    };
    /** Human readable message for one thrown error. */
    function describeError(error, t) {
      if (!error) return t('error.unknown');
      const code = error.code ? String(error.code) : '';
      if (code) {
        const key = 'error.' + code;
        const friendly = t(key);
        if (friendly && friendly !== key) {
          if (DETAILED_ERROR_CODES[code] && error.message) return friendly + ' ' + t('error.detail', { message: String(error.message) });
          return friendly;
        }
      }
      if (error.message) return t('error.withMessage', { message: String(error.message) });
      return t('error.unknown');
    }
    // #endregion

    // #region utilities
    /** Normalize the wordbook stats envelope so the UI never renders undefined. */
    function normalizeStats(stats) {
      const source = stats && typeof stats === 'object' ? stats : {};
      const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
      return {
        total: number(source.total),
        due: number(source.due),
        todayDue: number(source.todayDue),
        mastered: number(source.mastered),
        newCount: number(source.newCount),
      };
    }
    /** Relative "next review" label (server timestamps are epoch milliseconds). */
    function formatDueAt(value, t) {
      const dueAt = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (dueAt <= 0) return t('wordbook.dueNone');
      const diff = dueAt - Date.now();
      if (diff <= 0) return t('wordbook.dueNow');
      const minutes = Math.round(diff / 60000);
      if (minutes < 60) return t('wordbook.dueMinutes', { minutes: Math.max(1, minutes) });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t('wordbook.dueHours', { hours: hours });
      return t('wordbook.dueDays', { days: Math.round(hours / 24) });
    }
    /** Pick a Web Speech recognition/synthesis language from the word script. */
    function detectSpeechLang(value) {
      const text = String(value || '');
      return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text) ? 'zh-CN' : 'en-US';
    }
    /** Normalize text for fuzzy comparison (letters, digits, CJK only). */
    function normalizeSpoken(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u00c0-\u024f\u3400-\u9fff]+/g, '');
    }
    /** Classic Levenshtein edit distance. */
    function levenshtein(left, right) {
      if (left === right) return 0;
      const leftLength = left.length;
      const rightLength = right.length;
      if (leftLength === 0) return rightLength;
      if (rightLength === 0) return leftLength;
      let previous = new Array(rightLength + 1);
      let current = new Array(rightLength + 1);
      for (let column = 0; column <= rightLength; column += 1) previous[column] = column;
      for (let row = 1; row <= leftLength; row += 1) {
        current[0] = row;
        for (let column = 1; column <= rightLength; column += 1) {
          const cost = left.charAt(row - 1) === right.charAt(column - 1) ? 0 : 1;
          const deletion = previous[column] + 1;
          const insertion = current[column - 1] + 1;
          const substitution = previous[column - 1] + cost;
          current[column] = Math.min(deletion, insertion, substitution);
        }
        const swap = previous;
        previous = current;
        current = swap;
      }
      return previous[rightLength];
    }
    /** 0..1 similarity between a recognition transcript and the target word. */
    function similarityScore(spoken, target) {
      const left = normalizeSpoken(spoken);
      const right = normalizeSpoken(target);
      if (!left || !right) return 0;
      if (left === right) return 1;
      return Math.max(0, 1 - levenshtein(left, right) / Math.max(left.length, right.length));
    }
    /** Repeatable speech player used by pronunciation buttons. */
    function createPronouncer() {
      let audio = null;
      function stop() {
        if (audio) {
          try {
            audio.pause();
            audio.currentTime = 0;
          } catch (error) {
            /* ignore */
          }
          audio = null;
        }
        const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
        if (synth) {
          try {
            synth.cancel();
          } catch (error) {
            /* ignore */
          }
        }
      }
      function speakSynthesized(word, lang) {
        const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
        const Utterance = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null;
        if (!synth || typeof Utterance !== 'function') return false;
        try {
          const utterance = new Utterance(String(word || ''));
          utterance.lang = lang || detectSpeechLang(word);
          utterance.rate = 0.9;
          synth.cancel();
          synth.speak(utterance);
          return true;
        } catch (error) {
          return false;
        }
      }
      function speak(word, audioUrl, lang) {
        stop();
        const AudioConstructor = typeof window !== 'undefined' ? window.Audio : null;
        if (audioUrl && typeof AudioConstructor === 'function') {
          try {
            const element = new AudioConstructor(String(audioUrl));
            audio = element;
            const promise = element.play();
            if (promise && typeof promise.catch === 'function') {
              promise.catch(() => {
                if (audio === element) audio = null;
                speakSynthesized(word, lang);
              });
            }
            if (typeof element.addEventListener === 'function') {
              element.addEventListener('ended', () => {
                if (audio === element) audio = null;
              }, { once: true });
            }
            return;
          } catch (error) {
            audio = null;
          }
        }
        speakSynthesized(word, lang);
      }
      return { speak: speak, stop: stop };
    }
    // #endregion

    // #region shared components
    /** In-page alert with an optional action button. */
    function InlineAlert(props) {
      const kind = props.kind || 'error';
      return h(
        'div',
        { className: 'dsh-it-alert dsh-it-alert-' + kind, role: kind === 'error' ? 'alert' : 'status' },
        h(
          'div',
          { className: 'dsh-it-alert-body' },
          props.title ? h('span', { className: 'dsh-it-alert-title' }, props.title) : null,
          props.children ? h('span', null, props.children) : null,
        ),
        props.action || null,
      );
    }
    /** Loading skeleton rows. */
    function LoadingSkeleton(props) {
      return h(
        'div',
        { className: 'dsh-it-skeleton-stack', 'aria-busy': 'true', 'aria-label': props.label || translate('common.loading') },
        h('div', { className: 'dsh-it-skeleton', style: { width: '38%' } }),
        h('div', { className: 'dsh-it-skeleton', style: { width: '100%', height: '68px' } }),
        h('div', { className: 'dsh-it-skeleton', style: { width: '72%' } }),
        h('div', { className: 'dsh-it-skeleton', style: { width: '100%', height: '120px' } }),
      );
    }
    /** Centered empty-state block. */
    function EmptyState(props) {
      return h(
        'div',
        { className: 'dsh-it-empty' },
        h('div', { className: 'dsh-it-empty-title' }, props.title),
        props.children ? h('div', { className: 'dsh-it-hint' }, props.children) : null,
        props.action || null,
      );
    }
    /** Pronunciation button preferring the dictionary audio URL. */
    function PronounceButton(props) {
      const t = useT();
      const pronouncerRef = useRef(null);
      if (!pronouncerRef.current) pronouncerRef.current = createPronouncer();
      useEffect(
        () => () => {
          if (pronouncerRef.current) pronouncerRef.current.stop();
        },
        [],
      );
      const onClick = (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        if (pronouncerRef.current) pronouncerRef.current.speak(props.word, props.audioUrl, detectSpeechLang(props.word));
      };
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-it-icon-btn',
          title: t('pronounce.play'),
          'aria-label': t('pronounce.playOf', { word: props.word || '' }),
          onClick: onClick,
        },
        '🔊',
      );
    }
    /** Render dictionary meanings for a wordbook entry. */
    function renderMeanings(item, t) {
      const dictionary = item.dictionary && typeof item.dictionary === 'object' ? item.dictionary : null;
      const meanings = dictionary && Array.isArray(dictionary.meanings) ? dictionary.meanings : [];
      if (meanings.length === 0) return null;
      return h(
        'div',
        { className: 'dsh-it-meanings' },
        h('div', { className: 'dsh-it-meaning-pos' }, t('review.meanings')),
        meanings.slice(0, 4).map((meaning, meaningIndex) => {
          const definitions = meaning && Array.isArray(meaning.definitions) ? meaning.definitions : [];
          return h(
            'div',
            { key: 'meaning-' + meaningIndex, className: 'dsh-it-meanings' },
            meaning && meaning.partOfSpeech ? h('span', { className: 'dsh-it-meaning-pos' }, String(meaning.partOfSpeech)) : null,
            definitions.slice(0, 3).map((definition, definitionIndex) =>
              h('div', { key: 'definition-' + definitionIndex, className: 'dsh-it-meaning-def' }, String(definition)),
            ),
          );
        }),
      );
    }
    // #endregion

    // #region translation settings
    /** Build the editable form values from a GET/PUT /settings payload. */
    function formFromSettings(settingsData, selectedData) {
      const settings = settingsData && typeof settingsData === 'object' ? settingsData : {};
      const selected = selectedData && typeof selectedData === 'object' ? selectedData : {};
      const provider = typeof settings.provider === 'string' && settings.provider ? settings.provider : typeof selected.provider === 'string' ? selected.provider : '';
      const model = typeof settings.model === 'string' && settings.model ? settings.model : typeof selected.model === 'string' ? selected.model : '';
      return {
        provider: provider,
        model: model,
        reasoningEffort: typeof settings.reasoningEffort === 'string' && settings.reasoningEffort ? settings.reasoningEffort : 'auto',
        targetLanguage: typeof settings.targetLanguage === 'string' && settings.targetLanguage ? settings.targetLanguage : 'zh-CN',
        systemPrompt: typeof settings.systemPrompt === 'string' ? settings.systemPrompt : '',
        userTemplate: typeof settings.userTemplate === 'string' ? settings.userTemplate : '',
        recordHistory: settings.recordHistory !== false,
      };
    }
    /** Group the /models catalog by provider and keep the current selection visible. */
    function normalizeCatalog(catalog, fallbackProvider, fallbackModel) {
      const groups = [];
      const seen = new Set();
      if (Array.isArray(catalog)) {
        for (let index = 0; index < catalog.length; index += 1) {
          const provider = catalog[index];
          if (!provider || typeof provider.provider !== 'string' || !provider.provider) continue;
          const sourceModels = Array.isArray(provider.models) ? provider.models : [];
          const models = [];
          for (let modelIndex = 0; modelIndex < sourceModels.length; modelIndex += 1) {
            const model = sourceModels[modelIndex];
            if (!model || typeof model.id !== 'string' || !model.id) continue;
            models.push({
              id: model.id,
              name: typeof model.name === 'string' && model.name ? model.name : model.id,
            });
            seen.add(provider.provider + '::' + model.id);
          }
          if (models.length === 0) continue;
          groups.push({
            provider: provider.provider,
            name: typeof provider.name === 'string' && provider.name ? provider.name : provider.provider,
            models: models,
          });
        }
      }
      if (fallbackProvider && fallbackModel && !seen.has(fallbackProvider + '::' + fallbackModel)) {
        const entry = { id: fallbackModel, name: fallbackModel };
        let group = null;
        for (let index = 0; index < groups.length; index += 1) {
          if (groups[index].provider === fallbackProvider) {
            group = groups[index];
            break;
          }
        }
        if (group) group.models.unshift(entry);
        else groups.unshift({ provider: fallbackProvider, name: fallbackProvider, models: [entry] });
      }
      return groups;
    }
    /** Language option label from the active dictionary. */
    function languageLabel(t, id) {
      for (let index = 0; index < TARGET_LANGUAGES.length; index += 1) {
        if (TARGET_LANGUAGES[index].id === id) return t(TARGET_LANGUAGES[index].key);
      }
      return id;
    }
    /** Translation settings tab: model, reasoning effort, language, prompts, save, test. */
    function TranslationSettings() {
      const t = useT();
      const [phase, setPhase] = useState('loading');
      const [loadError, setLoadError] = useState(null);
      const [reloadToken, setReloadToken] = useState(0);
      const [defaults, setDefaults] = useState(null);
      const [selected, setSelected] = useState(null);
      const [groups, setGroups] = useState([]);
      const [languages, setLanguages] = useState(TARGET_LANGUAGES.map((language) => language.id));
      const [form, setForm] = useState(null);
      const [baseline, setBaseline] = useState(null);
      const [efforts, setEfforts] = useState([]);
      const [effortsLoading, setEffortsLoading] = useState(false);
      const effortsModelRef = useRef('');
      const [saving, setSaving] = useState(false);
      const [saveError, setSaveError] = useState(null);
      const [saveNotice, setSaveNotice] = useState('');
      const [testText, setTestText] = useState('');
      const [testing, setTesting] = useState(false);
      const [testResult, setTestResult] = useState(null);
      const [testError, setTestError] = useState(null);
      const [clearRecordsConfirm, setClearRecordsConfirm] = useState(false);
      const [clearingRecords, setClearingRecords] = useState(false);
      const [recordsNotice, setRecordsNotice] = useState(null);
      const mountedRef = useRef(true);
      const resolveTicketRef = useRef(0);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      useEffect(() => {
        let cancelled = false;
        setPhase('loading');
        setLoadError(null);
        api
          .get('settings')
          .then((settingsData) => {
            if (cancelled || !mountedRef.current) return;
            if (settingsData && Array.isArray(settingsData.catalog)) {
              applyLoaded(settingsData, { catalog: settingsData.catalog });
              return;
            }
            // Older Hosts expose the same catalog only through GET /models; that call is optional here.
            api
              .get('models')
              .catch(() => null)
              .then((modelsData) => {
                if (cancelled || !mountedRef.current) return;
                applyLoaded(settingsData, modelsData || { catalog: [] });
              });
          })
          .catch((error) => {
            if (cancelled || !mountedRef.current) return;
            setPhase('error');
            setLoadError(error);
          });
        return () => {
          cancelled = true;
        };
      }, [reloadToken]);

      /** Seed every state from the GET /settings + GET /models payloads. */
      function applyLoaded(settingsData, modelsData) {
        const nextSettings = settingsData && settingsData.settings ? settingsData.settings : {};
        const nextDefaults = settingsData && settingsData.defaults ? settingsData.defaults : null;
        const nextSelected = settingsData && settingsData.selected ? settingsData.selected : null;
        const initialForm = formFromSettings(nextSettings, nextSelected);
        setDefaults(nextDefaults);
        setSelected(nextSelected);
        const serverLanguages = settingsData && Array.isArray(settingsData.targetLanguages) ? settingsData.targetLanguages.filter((id) => typeof id === 'string' && id) : [];
        setLanguages(serverLanguages.length > 0 ? serverLanguages : TARGET_LANGUAGES.map((language) => language.id));
        const catalog = settingsData && Array.isArray(settingsData.catalog) ? settingsData.catalog : modelsData && modelsData.catalog;
        setGroups(normalizeCatalog(catalog, initialForm.provider, initialForm.model));
        setForm(initialForm);
        setBaseline(initialForm);
        const modelInfo = settingsData && settingsData.modelInfo ? settingsData.modelInfo : null;
        setEfforts(modelInfo && Array.isArray(modelInfo.reasoningEfforts) ? modelInfo.reasoningEfforts.filter((effort) => effort && typeof effort.id === 'string') : []);
        effortsModelRef.current = modelInfo && typeof modelInfo.provider === 'string' && typeof modelInfo.model === 'string' ? modelInfo.provider + '::' + modelInfo.model : '';
        setPhase('ready');
        resolveEfforts(initialForm.provider, initialForm.model);
      }

      /** Refresh the reasoning-effort options for one model. */
      function resolveEfforts(provider, model) {
        if (!provider || !model) {
          effortsModelRef.current = '';
          setEfforts([]);
          return;
        }
        const modelKey = provider + '::' + model;
        resolveTicketRef.current += 1;
        const ticket = resolveTicketRef.current;
        setEffortsLoading(true);
        api
          .get('models/resolve', { provider: provider, model: model })
          .then((data) => {
            if (!mountedRef.current || resolveTicketRef.current !== ticket) return;
            const list = data && data.model && Array.isArray(data.model.reasoningEfforts) ? data.model.reasoningEfforts.filter((effort) => effort && typeof effort.id === 'string') : [];
            effortsModelRef.current = modelKey;
            setEfforts(list);
            setForm((current) => {
              if (!current || current.provider !== provider || current.model !== model) return current;
              if (current.reasoningEffort !== 'auto' && list.length > 0 && !list.some((effort) => effort.id === current.reasoningEffort)) {
                return Object.assign({}, current, { reasoningEffort: 'auto' });
              }
              return current;
            });
          })
          .catch(() => {
            if (!mountedRef.current || resolveTicketRef.current !== ticket) return;
            // Keep the settings.modelInfo efforts when the resolve call failed for the same model.
            if (effortsModelRef.current !== modelKey) {
              effortsModelRef.current = '';
              setEfforts([]);
            }
          })
          .finally(() => {
            if (mountedRef.current && resolveTicketRef.current === ticket) setEffortsLoading(false);
          });
      }

      /** Patch one form field and clear transient notices. */
      function updateForm(patch) {
        setSaveNotice('');
        setForm((current) => (current ? Object.assign({}, current, patch) : current));
      }

      /** Seed the prompt textareas with the Host defaults. */
      function restorePrompts() {
        if (!defaults) return;
        updateForm({
          systemPrompt: typeof defaults.systemPrompt === 'string' ? defaults.systemPrompt : '',
          userTemplate: typeof defaults.userTemplate === 'string' ? defaults.userTemplate : '',
        });
        setSaveNotice(t('settings.promptRestored'));
      }

      /** Model select change: refresh efforts for the new model. */
      function onModelChange(event) {
        const value = event.target.value;
        const separator = value.indexOf('::');
        if (separator < 0) return;
        const provider = value.slice(0, separator);
        const model = value.slice(separator + 2);
        updateForm({ provider: provider, model: model });
        resolveEfforts(provider, model);
      }

      /** PUT the editable settings subset and re-seed from the response. */
      async function onSave() {
        if (!form || saving) return;
        setSaving(true);
        setSaveError(null);
        setSaveNotice('');
        const body = {
          provider: form.provider,
          model: form.model,
          reasoningEffort: form.reasoningEffort,
          targetLanguage: form.targetLanguage,
          systemPrompt: form.systemPrompt,
          userTemplate: form.userTemplate,
          recordHistory: form.recordHistory,
        };
        try {
          const data = await api.put('settings', body);
          if (!mountedRef.current) return;
          if (data.defaults) setDefaults(data.defaults);
          if (data.selected) setSelected(data.selected);
          if (data.modelInfo && Array.isArray(data.modelInfo.reasoningEfforts)) {
            setEfforts(data.modelInfo.reasoningEfforts.filter((effort) => effort && typeof effort.id === 'string'));
          }
          const nextForm = formFromSettings(data.settings, data.selected);
          setForm(nextForm);
          setBaseline(nextForm);
          setSaveNotice(t('settings.saved'));
        } catch (error) {
          if (!mountedRef.current) return;
          setSaveError(error);
        } finally {
          if (mountedRef.current) setSaving(false);
        }
      }

      /** POST /translate for the test box and record the round-trip time. */
      async function onTest() {
        const text = String(testText || '').trim();
        if (!text || testing) return;
        setTesting(true);
        setTestError(null);
        setTestResult(null);
        const clock = typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();
        const startedAt = clock();
        try {
          const data = await api.post('translate', { texts: [text] }, { timeoutMs: 180000 });
          if (!mountedRef.current) return;
          const translations = Array.isArray(data.translations) ? data.translations : [];
          setTestResult({
            translation: translations.length > 0 ? String(translations[0]) : '',
            provider: typeof data.provider === 'string' ? data.provider : '',
            model: typeof data.model === 'string' ? data.model : '',
            reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : '',
            cached: data.cached === true,
            elapsed: Math.max(0, Math.round(clock() - startedAt)),
          });
        } catch (error) {
          if (!mountedRef.current) return;
          setTestError(error);
        } finally {
          if (mountedRef.current) setTesting(false);
        }
      }

      /** 打开/取消清理确认。 */
      function requestClearRecords() {
        if (!clearingRecords) setClearRecordsConfirm(true);
      }

      function cancelClearRecords() {
        if (!clearingRecords) setClearRecordsConfirm(false);
      }

      /** DELETE /records：清空账本并把翻译会话从 DSH 分组归档隐藏。 */
      function confirmClearRecords() {
        if (clearingRecords) return;
        setClearingRecords(true);
        setRecordsNotice(null);
        request('records', { method: 'DELETE' })
          .then(() => {
            if (!mountedRef.current) return;
            setClearRecordsConfirm(false);
            setRecordsNotice({ kind: 'ok', text: t('settings.clearRecordsDone') });
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            setRecordsNotice({ kind: 'error', text: describeError(error, t) });
          })
          .finally(() => {
            if (mountedRef.current) setClearingRecords(false);
          });
      }

      if (phase === 'loading') return h('div', { className: 'dsh-it-panel' }, h(LoadingSkeleton, { label: t('common.loading') }));
      if (phase === 'error') {
        return h(
          'div',
          { className: 'dsh-it-panel' },
          h(
            InlineAlert,
            {
              kind: 'error',
              title: t('settings.loadFailed'),
              action: h(
                'button',
                { type: 'button', className: 'dsh-it-btn', onClick: () => setReloadToken((token) => token + 1) },
                t('common.retry'),
              ),
            },
            describeError(loadError, t),
          ),
        );
      }
      if (!form) return null;

      const dirty =
        !!form &&
        !!baseline &&
        (form.provider !== baseline.provider ||
          form.model !== baseline.model ||
          form.reasoningEffort !== baseline.reasoningEffort ||
          form.targetLanguage !== baseline.targetLanguage ||
          form.systemPrompt !== baseline.systemPrompt ||
          form.userTemplate !== baseline.userTemplate ||
          form.recordHistory !== baseline.recordHistory);

      const modelValue = form.provider && form.model ? form.provider + '::' + form.model : '';
      const effortIds = efforts.map((effort) => effort.id);
      const rawEffort = form.reasoningEffort !== 'auto' && effortIds.indexOf(form.reasoningEffort) < 0 ? form.reasoningEffort : '';
      const sameSelectionAsSaved = !!selected && selected.provider === form.provider && selected.model === form.model;
      let effortHint = '';
      if (effortsLoading) effortHint = t('settings.effortLoading');
      else if (efforts.length === 0) effortHint = t('settings.effortUnsupported');
      else if (form.reasoningEffort === 'auto' && sameSelectionAsSaved && selected.reasoningEffort) {
        effortHint = t('settings.effortAutoResolved', { effort: String(selected.reasoningEffort) });
      }
      const languageOptions = languages.indexOf(form.targetLanguage) < 0 ? [form.targetLanguage].concat(languages) : languages.slice();

      return h(
        'div',
        { className: 'dsh-it-panel' },
        h(
          'section',
          { className: 'dsh-it-card', 'aria-labelledby': 'dsh-it-model-heading' },
          h(
            'div',
            { className: 'dsh-it-card-header' },
            h('h3', { className: 'dsh-it-card-title', id: 'dsh-it-model-heading' }, t('settings.modelSection')),
            dirty ? h('span', { className: 'dsh-it-chip dsh-it-chip-dirty' }, t('settings.dirty')) : null,
          ),
          h(
            'div',
            { className: 'dsh-it-grid' },
            h(
              'label',
              { className: 'dsh-it-field' },
              h('span', { className: 'dsh-it-label' }, t('settings.model')),
              h(
                'select',
                {
                  className: 'dsh-it-select',
                  value: modelValue,
                  disabled: groups.length === 0,
                  'aria-label': t('settings.model'),
                  onChange: onModelChange,
                },
                groups.length === 0 ? h('option', { value: '' }, t('settings.modelEmpty')) : null,
                groups.map((group) =>
                  h(
                    'optgroup',
                    { key: 'provider-' + group.provider, label: group.name },
                    group.models.map((model) =>
                      h('option', { key: 'model-' + group.provider + '::' + model.id, value: group.provider + '::' + model.id }, model.name),
                    ),
                  ),
                ),
              ),
            ),
            h(
              'label',
              { className: 'dsh-it-field' },
              h('span', { className: 'dsh-it-label' }, t('settings.effort')),
              h(
                'select',
                {
                  className: 'dsh-it-select',
                  value: form.reasoningEffort,
                  disabled: efforts.length === 0 && form.reasoningEffort === 'auto',
                  'aria-label': t('settings.effort'),
                  onChange: (event) => updateForm({ reasoningEffort: event.target.value }),
                },
                h('option', { value: 'auto' }, t('settings.effortAuto')),
                efforts.map((effort) => h('option', { key: 'effort-' + effort.id, value: effort.id }, effort.name || effort.id)),
                rawEffort ? h('option', { key: 'effort-raw', value: rawEffort }, rawEffort) : null,
              ),
            ),
            h(
              'label',
              { className: 'dsh-it-field' },
              h('span', { className: 'dsh-it-label' }, t('settings.targetLanguage')),
              h(
                'select',
                {
                  className: 'dsh-it-select',
                  value: form.targetLanguage,
                  'aria-label': t('settings.targetLanguage'),
                  onChange: (event) => updateForm({ targetLanguage: event.target.value }),
                },
                languageOptions.map((id) => h('option', { key: 'lang-' + id, value: id }, languageLabel(t, id))),
              ),
            ),
          ),
          h('p', { className: 'dsh-it-hint' }, t('settings.modelHint')),
          effortHint ? h('p', { className: 'dsh-it-hint' }, effortHint) : null,
        ),
        h(
          'section',
          { className: 'dsh-it-card', 'aria-labelledby': 'dsh-it-prompts-heading' },
          h(
            'div',
            { className: 'dsh-it-card-header' },
            h('h3', { className: 'dsh-it-card-title', id: 'dsh-it-prompts-heading' }, t('settings.prompts')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-it-btn dsh-it-btn-ghost',
                disabled: !defaults,
                title: t('settings.restoreDefaults'),
                onClick: restorePrompts,
              },
              t('settings.restoreDefaults'),
            ),
          ),
          h(
            'label',
            { className: 'dsh-it-field' },
            h('span', { className: 'dsh-it-label' }, t('settings.systemPrompt')),
            h('textarea', {
              className: 'dsh-it-textarea',
              rows: 8,
              maxLength: SYSTEM_PROMPT_MAX,
              value: form.systemPrompt,
              placeholder: t('settings.systemPrompt'),
              'aria-label': t('settings.systemPrompt'),
              onChange: (event) => updateForm({ systemPrompt: event.target.value }),
            }),
            h('span', { className: 'dsh-it-hint' }, t('settings.chars', { current: form.systemPrompt.length, max: SYSTEM_PROMPT_MAX })),
          ),
          h(
            'label',
            { className: 'dsh-it-field' },
            h('span', { className: 'dsh-it-label' }, t('settings.userTemplate')),
            h('textarea', {
              className: 'dsh-it-textarea',
              rows: 6,
              maxLength: USER_TEMPLATE_MAX,
              value: form.userTemplate,
              placeholder: t('settings.userTemplate'),
              'aria-label': t('settings.userTemplate'),
              onChange: (event) => updateForm({ userTemplate: event.target.value }),
            }),
            h('span', { className: 'dsh-it-hint' }, t('settings.chars', { current: form.userTemplate.length, max: USER_TEMPLATE_MAX })),
          ),
          h('p', { className: 'dsh-it-hint dsh-it-hint-strong' }, t('settings.promptContract')),
          h(
            'p',
            { className: 'dsh-it-hint' },
            t('settings.placeholdersHint'),
            PROMPT_PLACEHOLDERS.map((placeholder) => h('code', { key: 'placeholder-' + placeholder, className: 'dsh-it-code' }, placeholder)),
          ),
        ),
        h(
          'section',
          { className: 'dsh-it-card', 'aria-labelledby': 'dsh-it-records-heading' },
          h(
            'div',
            { className: 'dsh-it-card-header' },
            h('h3', { className: 'dsh-it-card-title', id: 'dsh-it-records-heading' }, t('settings.records')),
            form.recordHistory === false ? h('span', { className: 'dsh-it-chip dsh-it-chip-dirty' }, t('settings.disableRecord')) : null,
          ),
          h(
            'label',
            { className: 'dsh-it-check-row' },
            h('input', {
              type: 'checkbox',
              checked: form.recordHistory === false,
              onChange: (event) => updateForm({ recordHistory: !event.target.checked }),
            }),
            h('span', null, t('settings.disableRecord')),
          ),
          h('p', { className: 'dsh-it-hint' }, t('settings.disableRecordHint')),
          h('p', { className: 'dsh-it-hint' }, t('settings.recordsHint')),
          h(
            'div',
            { className: 'dsh-it-row' },
            h(
              'button',
              { type: 'button', className: 'dsh-it-btn dsh-it-btn-danger', disabled: clearingRecords, onClick: requestClearRecords },
              clearingRecords ? t('common.loading') : t('settings.clearRecords'),
            ),
            clearRecordsConfirm
              ? h(
                  'button',
                  { type: 'button', className: 'dsh-it-btn dsh-it-btn-danger', disabled: clearingRecords, onClick: confirmClearRecords },
                  t('settings.clearRecordsConfirm'),
                )
              : null,
            clearRecordsConfirm
              ? h('button', { type: 'button', className: 'dsh-it-btn', disabled: clearingRecords, onClick: cancelClearRecords }, t('common.cancel'))
              : null,
          ),
          clearRecordsConfirm ? h('p', { className: 'dsh-it-hint dsh-it-hint-error' }, t('settings.clearRecordsConfirmText')) : null,
          recordsNotice
            ? h(InlineAlert, { kind: recordsNotice.kind === 'ok' ? 'ok' : 'error' }, recordsNotice.text)
            : null,
        ),
        h(
          'div',
          { className: 'dsh-it-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-btn dsh-it-btn-primary',
              disabled: !dirty || saving,
              title: t('settings.save'),
              onClick: onSave,
            },
            saving ? t('settings.saving') : t('settings.save'),
          ),
          dirty ? h('span', { className: 'dsh-it-chip dsh-it-chip-dirty' }, t('settings.dirty')) : null,
          saveNotice ? h('span', { className: 'dsh-it-chip dsh-it-chip-ok' }, saveNotice) : null,
          !dirty && !saveNotice ? h('span', { className: 'dsh-it-hint' }, t('settings.noChanges')) : null,
        ),
        saveError
          ? h(InlineAlert, { kind: 'error', title: t('settings.saveFailed') }, describeError(saveError, t))
          : null,
        h('p', { className: 'dsh-it-hint' }, t('settings.privacy')),
        h(
          'section',
          { className: 'dsh-it-card', 'aria-labelledby': 'dsh-it-test-heading' },
          h(
            'div',
            { className: 'dsh-it-card-header' },
            h('h3', { className: 'dsh-it-card-title', id: 'dsh-it-test-heading' }, t('settings.test')),
            h('span', { className: 'dsh-it-hint' }, t('settings.testHint')),
          ),
          h(
            'label',
            { className: 'dsh-it-field' },
            h('span', { className: 'dsh-it-label' }, t('settings.testText')),
            h('textarea', {
              className: 'dsh-it-textarea',
              rows: 3,
              maxLength: 8000,
              value: testText,
              placeholder: t('settings.testPlaceholder'),
              'aria-label': t('settings.testText'),
              onChange: (event) => setTestText(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dsh-it-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-it-btn dsh-it-btn-primary',
                disabled: !String(testText || '').trim() || testing,
                title: t('settings.testRun'),
                onClick: onTest,
              },
              testing ? t('settings.testing') : t('settings.testRun'),
            ),
          ),
          testError
            ? h(InlineAlert, { kind: 'error', title: t('settings.test') }, describeError(testError, t))
            : null,
          testResult
            ? h(
                'div',
                { className: 'dsh-it-test-result' },
                h('div', { className: 'dsh-it-hint' }, t('settings.testResult')),
                h('div', { className: 'dsh-it-test-text' }, testResult.translation || t('settings.testEmptyResult')),
                h('div', { className: 'dsh-it-hint' }, t('settings.testMeta', {
                  model: testResult.provider && testResult.model ? testResult.provider + ' / ' + testResult.model : testResult.model || testResult.provider || '—',
                  effort: testResult.reasoningEffort || 'auto',
                  ms: testResult.elapsed,
                })),
                testResult.cached ? h('span', { className: 'dsh-it-chip' }, t('settings.testCached')) : null,
              )
            : null,
        ),
      );
    }
    // #endregion

    // #region shadowing practice
    /** Follow-along pronunciation practice using the browser speech recognizer. */
    function ShadowingPractice(props) {
      const t = useT();
      const word = typeof props.word === 'string' ? props.word : '';
      const SpeechRecognitionConstructor = useMemo(() => {
        if (typeof window === 'undefined') return null;
        const Constructor = window.SpeechRecognition || window.webkitSpeechRecognition;
        return typeof Constructor === 'function' ? Constructor : null;
      }, []);
      const [blocked, setBlocked] = useState(SpeechRecognitionConstructor ? '' : 'unsupported');
      const [status, setStatus] = useState('idle');
      const [transcript, setTranscript] = useState('');
      const [score, setScore] = useState(null);
      const [reason, setReason] = useState('');
      const mountedRef = useRef(true);
      const recognitionRef = useRef(null);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          const recognition = recognitionRef.current;
          recognitionRef.current = null;
          if (recognition) {
            try {
              recognition.abort();
            } catch (error) {
              /* ignore */
            }
          }
        };
      }, []);

      /** Move to a terminal error state; permission and support failures disable the button. */
      function failWith(nextReason) {
        recognitionRef.current = null;
        if (!mountedRef.current) return;
        setStatus('error');
        setReason(nextReason);
        if (nextReason === 'denied' || nextReason === 'unsupported') setBlocked(nextReason);
      }

      /** Start one recognition attempt for the current word. */
      function start() {
        if (blocked || !SpeechRecognitionConstructor || status === 'listening') return;
        let recognition = null;
        try {
          recognition = new SpeechRecognitionConstructor();
        } catch (error) {
          setBlocked('unsupported');
          return;
        }
        recognitionRef.current = recognition;
        setTranscript('');
        setScore(null);
        setReason('');
        setStatus('listening');
        try {
          recognition.lang = detectSpeechLang(word);
          recognition.interimResults = false;
          recognition.maxAlternatives = 1;
          recognition.continuous = false;
        } catch (error) {
          /* some implementations reject unknown options; defaults are fine */
        }
        recognition.onresult = (event) => {
          if (!mountedRef.current) return;
          let spoken = '';
          try {
            spoken = event.results[0][0].transcript || '';
          } catch (error) {
            spoken = '';
          }
          const nextScore = similarityScore(spoken, word);
          recognitionRef.current = null;
          setTranscript(String(spoken));
          setScore(nextScore);
          setStatus('result');
        };
        recognition.onerror = (event) => {
          const code = event && event.error ? String(event.error) : '';
          if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') failWith('denied');
          else if (code === 'no-speech') failWith('noSpeech');
          else if (code === 'aborted') {
            recognitionRef.current = null;
            if (mountedRef.current) setStatus('idle');
          } else failWith('failed');
        };
        recognition.onend = () => {
          const stillListening = recognitionRef.current === recognition;
          recognitionRef.current = null;
          if (!mountedRef.current || !stillListening) return;
          setStatus('error');
          setReason('noSpeech');
        };
        try {
          recognition.start();
        } catch (error) {
          failWith('failed');
        }
      }

      const passed = score !== null && score >= 0.8;
      return h(
        'div',
        { className: 'dsh-it-shadowing' },
        h(
          'div',
          { className: 'dsh-it-shadowing-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-btn',
              disabled: !!blocked || status === 'listening',
              title: blocked ? t(SHADOWING_REASONS[blocked] || 'shadowing.unsupported') : t('shadowing.start'),
              onClick: start,
            },
            status === 'listening' ? t('shadowing.listening') : t('shadowing.start'),
          ),
          status === 'result'
            ? h(
                'button',
                { type: 'button', className: 'dsh-it-btn dsh-it-btn-ghost', title: t('shadowing.retry'), onClick: start },
                t('shadowing.retry'),
              )
            : null,
        ),
        blocked
          ? h('p', { className: 'dsh-it-hint' }, t(SHADOWING_REASONS[blocked] || 'shadowing.unsupported'))
          : h('p', { className: 'dsh-it-hint' }, t('shadowing.idle')),
        status === 'listening' ? h('p', { className: 'dsh-it-hint', role: 'status' }, t('shadowing.hint')) : null,
        status === 'result'
          ? h(
              'div',
              null,
              h('p', { className: 'dsh-it-shadowing-transcript' }, t('shadowing.youSaid', { text: transcript || '—' })),
              h(
                'p',
                {
                  className: 'dsh-it-shadowing-' + (passed ? 'pass' : 'fail'),
                  role: 'status',
                },
                passed ? t('shadowing.pass') : t('shadowing.fail', { percent: Math.round((score || 0) * 100) }),
              ),
            )
          : null,
        status === 'error' ? h('p', { className: 'dsh-it-hint', role: 'status' }, t(SHADOWING_REASONS[reason] || 'shadowing.failed')) : null,
      );
    }
    // #endregion

    // #region wordbook review
    /** Wordbook review card flow (due queue, max 50 cards, keyboard grading). */
    function ReviewSession(props) {
      const t = useT();
      const queue = useMemo(() => (Array.isArray(props.queue) ? props.queue.filter((item) => item && typeof item.id === 'string').slice(0, 50) : []), [props.queue]);
      const total = queue.length;
      const [index, setIndex] = useState(0);
      const [revealed, setRevealed] = useState(false);
      const [results, setResults] = useState({ again: 0, hard: 0, good: 0 });
      const [done, setDone] = useState(total === 0);
      const [busy, setBusy] = useState(false);
      const [gradeError, setGradeError] = useState(null);
      const mountedRef = useRef(true);
      const current = index < total ? queue[index] : null;

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      /** POST one grade and advance to the next card. */
      async function submitGrade(grade) {
        if (!current || busy || !revealed || done) return;
        setBusy(true);
        setGradeError(null);
        try {
          await api.post('wordbook/review', { id: current.id, grade: grade });
          if (!mountedRef.current) return;
          setResults((previous) => {
            const next = Object.assign({}, previous);
            next[grade] = (next[grade] || 0) + 1;
            return next;
          });
          if (index + 1 >= total) setDone(true);
          else {
            setIndex(index + 1);
            setRevealed(false);
          }
        } catch (error) {
          if (!mountedRef.current) return;
          setGradeError(error);
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }

      useEffect(() => {
        if (props.active === false) return undefined;
        function onKeyDown(event) {
          const target = event.target;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            props.onExit();
            return;
          }
          if (done) return;
          if (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') {
            event.preventDefault();
            if (!revealed) setRevealed(true);
            return;
          }
          if (!revealed || busy) return;
          if (event.key === '1') {
            event.preventDefault();
            submitGrade('again');
          } else if (event.key === '2') {
            event.preventDefault();
            submitGrade('hard');
          } else if (event.key === '3') {
            event.preventDefault();
            submitGrade('good');
          }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      });

      if (total === 0) {
        return h(
          'div',
          { className: 'dsh-it-panel' },
          h(
            EmptyState,
            {
              title: t('review.emptyTitle'),
              action: h('button', { type: 'button', className: 'dsh-it-btn', onClick: props.onExit }, t('review.exit')),
            },
            t('review.emptyHint'),
          ),
        );
      }

      const reviewedCount = results.again + results.hard + results.good;
      const ordinal = Math.min(index + 1, total);
      const progressPercent = total > 0 ? (ordinal / total) * 100 : 0;

      return h(
        'div',
        { className: 'dsh-it-panel dsh-it-review' },
        h(
          'div',
          { className: 'dsh-it-review-bar' },
          h('button', { type: 'button', className: 'dsh-it-btn dsh-it-btn-ghost', title: t('review.exit'), onClick: props.onExit }, '← ' + t('review.exit')),
          h(
            'div',
            {
              className: 'dsh-it-progress',
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': total,
              'aria-valuenow': ordinal,
              'aria-label': t('review.progress', { current: ordinal, total: total }),
            },
            h('div', { className: 'dsh-it-progress-fill', style: { width: progressPercent.toFixed(1) + '%' } }),
          ),
          h('span', { className: 'dsh-it-hint' }, t('review.progress', { current: ordinal, total: total })),
        ),
        gradeError ? h(InlineAlert, { kind: 'error', title: t('review.gradeError') }, describeError(gradeError, t)) : null,
        done
          ? h(
              'div',
              { className: 'dsh-it-card' },
              h('h3', { className: 'dsh-it-card-title' }, t('review.doneTitle')),
              h('p', { className: 'dsh-it-hint' }, t('review.doneSummary', { count: reviewedCount, again: results.again, hard: results.hard, good: results.good })),
              h(
                'div',
                { className: 'dsh-it-row' },
                h('button', { type: 'button', className: 'dsh-it-btn dsh-it-btn-primary', onClick: props.onExit }, t('review.doneBack')),
              ),
            )
          : current
            ? h(
                'div',
                { className: 'dsh-it-card' },
                h(
                  'div',
                  {
                    className: 'dsh-it-card-face',
                    onClick: () => {
                      if (!revealed) setRevealed(true);
                    },
                  },
                  h('div', { className: 'dsh-it-review-word' }, String(current.word || '')),
                  current.phonetic ? h('div', { className: 'dsh-it-review-phonetic' }, String(current.phonetic)) : null,
                  h('div', { className: 'dsh-it-row', style: { justifyContent: 'center' } }, h(PronounceButton, { word: current.word, audioUrl: current.audioUrl })),
                  current.context ? h('div', { className: 'dsh-it-review-context' }, String(current.context)) : null,
                  h(ShadowingPractice, { word: current.word }),
                  revealed
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-it-btn dsh-it-btn-primary',
                          title: t('review.revealHint'),
                          onClick: (event) => {
                            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                            setRevealed(true);
                          },
                        },
                        t('review.revealHint'),
                      ),
                ),
                revealed
                  ? h(
                      'div',
                      { className: 'dsh-it-review-answer' },
                      h('div', { className: 'dsh-it-review-translation' }, String(current.translation || '')),
                      renderMeanings(current, t),
                      current.note ? h('div', { className: 'dsh-it-note' }, t('review.note') + ': ' + String(current.note)) : null,
                    )
                  : null,
              )
            : null,
        done
          ? null
          : h(
              'div',
              { className: 'dsh-it-grades' },
              GRADES.map((grade) =>
                h(
                  'button',
                  {
                    key: 'grade-' + grade.id,
                    type: 'button',
                    className: 'dsh-it-grade',
                    disabled: !revealed || busy,
                    title: t(grade.key) + ' (' + grade.shortcut + ')',
                    onClick: () => submitGrade(grade.id),
                  },
                  h('span', { className: 'dsh-it-grade-label' }, t(grade.key)),
                  h('span', { className: 'dsh-it-grade-key' }, grade.shortcut),
                ),
              ),
            ),
        done ? null : h('p', { className: 'dsh-it-hint', style: { textAlign: 'center' } }, t('review.gradeHint')),
      );
    }

    /** One wordbook list row with note editing, mastery toggle, deletion, and pronunciation. */
    function WordbookRow(props) {
      const t = useT();
      const item = props.item;
      const editing = props.editing;
      const confirming = props.confirming;
      return h(
        'div',
        { className: 'dsh-it-item' },
        h(
          'div',
          { className: 'dsh-it-item-main' },
          h('span', { className: 'dsh-it-word' }, String(item.word || '')),
          item.phonetic ? h('span', { className: 'dsh-it-phonetic' }, String(item.phonetic)) : null,
          h('span', { className: 'dsh-it-translation' }, String(item.translation || '')),
          h(PronounceButton, { word: item.word, audioUrl: item.audioUrl }),
        ),
        h(
          'div',
          { className: 'dsh-it-item-meta' },
          h('span', null, t('wordbook.item.due', { when: formatDueAt(item.dueAt, t) })),
          typeof item.reviews === 'number' && item.reviews > 0 ? h('span', null, t('wordbook.item.reviews', { count: item.reviews })) : null,
          item.mastered ? h('span', { className: 'dsh-it-chip dsh-it-chip-ok' }, t('wordbook.item.mastered')) : null,
          item.note && !editing ? h('span', { className: 'dsh-it-note' }, t('wordbook.item.noteLabel') + String(item.note)) : null,
        ),
        editing
          ? h(
              'div',
              { className: 'dsh-it-note-form' },
              h('textarea', {
                className: 'dsh-it-textarea',
                rows: 2,
                value: props.noteDraft,
                placeholder: t('wordbook.item.notePlaceholder'),
                'aria-label': t('wordbook.item.editNote'),
                onChange: (event) => props.onNoteChange(event.target.value),
              }),
              h(
                'div',
                { className: 'dsh-it-row' },
                h(
                  'button',
                  { type: 'button', className: 'dsh-it-btn dsh-it-btn-primary', disabled: props.busy, onClick: props.onSaveNote },
                  t('common.save'),
                ),
                h('button', { type: 'button', className: 'dsh-it-btn', disabled: props.busy, onClick: props.onCancelNote }, t('common.cancel')),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dsh-it-item-actions' },
          h(
            'button',
            { type: 'button', className: 'dsh-it-btn dsh-it-btn-ghost', disabled: props.busy, title: t('wordbook.item.editNote'), onClick: props.onEditNote },
            t('wordbook.item.editNote'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-btn dsh-it-btn-ghost',
              disabled: props.busy,
              title: item.mastered ? t('wordbook.item.unmaster') : t('wordbook.item.master'),
              onClick: props.onToggleMastered,
            },
            item.mastered ? t('wordbook.item.unmaster') : t('wordbook.item.master'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-btn dsh-it-btn-ghost' + (confirming ? ' dsh-it-btn-danger' : ''),
              disabled: props.busy,
              title: confirming ? t('wordbook.item.confirmDelete') : t('wordbook.item.delete'),
              onClick: props.onDelete,
            },
            confirming ? t('wordbook.item.confirmDelete') : t('wordbook.item.delete'),
          ),
        ),
      );
    }

    /** Wordbook tab: stats, search, filters, list management, and review entry. */
    function WordbookPage(props) {
      const t = useT();
      const [phase, setPhase] = useState('loading');
      const [loadError, setLoadError] = useState(null);
      const [items, setItems] = useState([]);
      const [stats, setStats] = useState(null);
      const [filter, setFilter] = useState('due');
      const [queryInput, setQueryInput] = useState('');
      const [query, setQuery] = useState('');
      const [reloadToken, setReloadToken] = useState(0);
      const [review, setReview] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busyId, setBusyId] = useState('');
      const [editingId, setEditingId] = useState('');
      const [noteDraft, setNoteDraft] = useState('');
      const [confirmingId, setConfirmingId] = useState('');
      const mountedRef = useRef(true);
      const wasActiveRef = useRef(props.active !== false);
      const silentReloadRef = useRef(false);
      const noticeTimerRef = useRef(null);
      const confirmTimerRef = useRef(null);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
          if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        };
      }, []);

      useEffect(() => {
        const timer = setTimeout(() => setQuery(String(queryInput || '').trim()), 300);
        return () => clearTimeout(timer);
      }, [queryInput]);

      // Refresh silently when the user comes back to the wordbook tab.
      useEffect(() => {
        const active = props.active !== false;
        if (active && !wasActiveRef.current) reloadSilently();
        wasActiveRef.current = active;
      }, [props.active]);

      useEffect(() => {
        let cancelled = false;
        const silent = silentReloadRef.current;
        silentReloadRef.current = false;
        if (!silent) {
          setPhase('loading');
          setLoadError(null);
        }
        api
          .get('wordbook', { query: query, filter: filter, limit: 200 })
          .then((data) => {
            if (cancelled || !mountedRef.current) return;
            const list = Array.isArray(data.items) ? data.items.filter((item) => item && typeof item.id === 'string') : [];
            setItems(list);
            setStats(normalizeStats(data.stats));
            setPhase('ready');
            setLoadError(null);
          })
          .catch((error) => {
            if (cancelled || !mountedRef.current) return;
            if (silent) showNotice('error', describeError(error, t));
            else {
              setPhase('error');
              setLoadError(error);
            }
          });
        return () => {
          cancelled = true;
        };
      }, [query, filter, reloadToken]);

      /** Transient inline notice with auto-dismiss. */
      function showNotice(kind, text) {
        if (!mountedRef.current) return;
        setNotice({ kind: kind, text: text });
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setNotice(null);
        }, 4000);
      }

      /** Schedule a silent refresh (keeps the current list visible). */
      function reloadSilently() {
        silentReloadRef.current = true;
        setReloadToken((token) => token + 1);
      }

      /** Reset the two-step delete confirmation after a short window. */
      function scheduleConfirmReset() {
        if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setConfirmingId('');
        }, 4000);
      }

      /** Save the inline note editor through /wordbook/update. */
      async function saveNote(item) {
        if (busyId) return;
        setBusyId(item.id);
        try {
          const data = await api.post('wordbook/update', { id: item.id, patch: { note: String(noteDraft || '') } });
          if (!mountedRef.current) return;
          const updated = data && data.item ? data.item : null;
          setItems((current) =>
            current.map((entry) => (entry.id === item.id ? Object.assign({}, entry, updated || { note: String(noteDraft || '') }) : entry)),
          );
          setEditingId('');
          setNoteDraft('');
          showNotice('ok', t('wordbook.notice.noteSaved'));
        } catch (error) {
          showNotice('error', describeError(error, t));
        } finally {
          if (mountedRef.current) setBusyId('');
        }
      }

      /** Toggle mastered through /wordbook/update, keeping SRS state server-side. */
      async function toggleMastered(item) {
        if (busyId) return;
        setBusyId(item.id);
        try {
          const data = await api.post('wordbook/update', { id: item.id, patch: { mastered: !item.mastered } });
          if (!mountedRef.current) return;
          const updated = data && data.item ? data.item : null;
          if (updated) setItems((current) => current.map((entry) => (entry.id === item.id ? updated : entry)));
          showNotice('ok', item.mastered ? t('wordbook.notice.unmastered') : t('wordbook.notice.mastered'));
          reloadSilently();
        } catch (error) {
          showNotice('error', describeError(error, t));
        } finally {
          if (mountedRef.current) setBusyId('');
        }
      }

      /** Two-step delete through /wordbook/remove. */
      async function removeItem(item) {
        if (busyId) return;
        if (confirmingId !== item.id) {
          setConfirmingId(item.id);
          scheduleConfirmReset();
          return;
        }
        setBusyId(item.id);
        try {
          await api.post('wordbook/remove', { id: item.id });
          if (!mountedRef.current) return;
          setConfirmingId('');
          setItems((current) => current.filter((entry) => entry.id !== item.id));
          showNotice('ok', t('wordbook.notice.removed'));
          reloadSilently();
        } catch (error) {
          showNotice('error', describeError(error, t));
        } finally {
          if (mountedRef.current) setBusyId('');
        }
      }

      /** Fetch the due queue (max 50) and enter the review flow. */
      function loadReviewQueue() {
        setReview({ phase: 'loading', items: [], error: null });
        api
          .get('wordbook', { filter: 'due', limit: 50 })
          .then((data) => {
            if (!mountedRef.current) return;
            const list = Array.isArray(data.items) ? data.items.filter((item) => item && typeof item.id === 'string').slice(0, 50) : [];
            if (data.stats) setStats(normalizeStats(data.stats));
            setReview({ phase: 'active', items: list, error: null });
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            setReview({ phase: 'error', items: [], error: error });
          });
      }

      /** Leave the review flow and refresh the wordbook. */
      function exitReview() {
        setReview(null);
        reloadSilently();
      }

      if (review) {
        return h(
          'div',
          { className: 'dsh-it-panel' },
          review.phase === 'loading'
            ? h(LoadingSkeleton, { label: t('review.loading') })
            : review.phase === 'error'
              ? h(
                  InlineAlert,
                  {
                    kind: 'error',
                    title: t('review.loadFailed'),
                    action: h(
                      'div',
                      { className: 'dsh-it-row' },
                      h('button', { type: 'button', className: 'dsh-it-btn', onClick: loadReviewQueue }, t('common.retry')),
                      h('button', { type: 'button', className: 'dsh-it-btn dsh-it-btn-ghost', onClick: exitReview }, t('review.exit')),
                    ),
                  },
                  describeError(review.error, t),
                )
              : h(ReviewSession, { queue: review.items, onExit: exitReview, active: props.active !== false }),
        );
      }

      const statsCards = stats
        ? WORD_STATS.map((stat) =>
            h(
              'div',
              { className: 'dsh-it-stat', key: 'stat-' + stat.id },
              h('span', { className: 'dsh-it-stat-value' }, String(stats[stat.id] || 0)),
              h('span', { className: 'dsh-it-stat-label' }, t(stat.key)),
            ),
          )
        : [];
      const startDisabled = !stats || stats.due === 0;

      return h(
        'div',
        { className: 'dsh-it-panel' },
        h('div', { className: 'dsh-it-stats' }, statsCards),
        h(
          'div',
          { className: 'dsh-it-row' },
          h(
            'div',
            { className: 'dsh-it-field', style: { flex: '1 1 220px' } },
            h('label', { className: 'dsh-it-label', htmlFor: 'dsh-it-wordbook-search' }, t('wordbook.search')),
            h('input', {
              id: 'dsh-it-wordbook-search',
              type: 'search',
              className: 'dsh-it-input',
              value: queryInput,
              placeholder: t('wordbook.searchPlaceholder'),
              'aria-label': t('wordbook.search'),
              onChange: (event) => setQueryInput(event.target.value),
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-btn dsh-it-btn-primary',
              disabled: startDisabled,
              title: startDisabled ? t('review.emptyTitle') : t('wordbook.startReview'),
              onClick: loadReviewQueue,
            },
            t('wordbook.startReview'),
          ),
          h('span', { className: 'dsh-it-hint' }, t('wordbook.reviewLimit')),
        ),
        h(
          'div',
          { className: 'dsh-it-tabbar', role: 'tablist', 'aria-label': t('wordbook.filterLabel') },
          WORD_FILTERS.map((entry) =>
            h(
              'button',
              {
                key: 'filter-' + entry.id,
                type: 'button',
                role: 'tab',
                id: 'dsh-it-filter-' + entry.id,
                'aria-selected': filter === entry.id ? 'true' : 'false',
                'aria-controls': 'dsh-it-wordbook-results',
                tabIndex: filter === entry.id ? 0 : -1,
                className: 'dsh-it-tab',
                onClick: () => {
                  setFilter(entry.id);
                  setEditingId('');
                  setConfirmingId('');
                },
              },
              t(entry.key),
            ),
          ),
        ),
        notice ? h(InlineAlert, { kind: notice.kind === 'ok' ? 'ok' : 'error' }, notice.text) : null,
        h(
          'div',
          { id: 'dsh-it-wordbook-results', role: 'tabpanel', 'aria-labelledby': 'dsh-it-filter-' + filter },
          phase === 'loading'
            ? h(LoadingSkeleton, { label: t('common.loading') })
            : phase === 'error'
              ? h(
                  InlineAlert,
                  {
                    kind: 'error',
                    title: t('wordbook.loadFailed'),
                    action: h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-it-btn',
                        onClick: () => {
                          silentReloadRef.current = false;
                          setReloadToken((token) => token + 1);
                        },
                      },
                      t('common.retry'),
                    ),
                  },
                  describeError(loadError, t),
                )
              : items.length === 0
                ? stats && stats.total === 0
                  ? h(EmptyState, { title: t('wordbook.empty') }, t('wordbook.emptyHint'))
                  : h(EmptyState, { title: t('wordbook.emptyFiltered') }, t('wordbook.emptyFilteredHint'))
                : h(
                    'div',
                    { className: 'dsh-it-list' },
                    items.map((item) =>
                      h(WordbookRow, {
                        key: 'word-' + item.id,
                        item: item,
                        busy: busyId === item.id,
                        editing: editingId === item.id,
                        confirming: confirmingId === item.id,
                        noteDraft: editingId === item.id ? noteDraft : '',
                        onEditNote: () => {
                          setEditingId(item.id);
                          setNoteDraft(typeof item.note === 'string' ? item.note : '');
                          setConfirmingId('');
                        },
                        onCancelNote: () => {
                          setEditingId('');
                          setNoteDraft('');
                        },
                        onNoteChange: (value) => setNoteDraft(value),
                        onSaveNote: () => saveNote(item),
                        onToggleMastered: () => toggleMastered(item),
                        onDelete: () => removeItem(item),
                      }),
                    ),
                  ),
        ),
      );
    }
    // #endregion

    // #region token usage helpers
    /** Coerce anything to a finite number (0 when unusable). */
    function toFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }
    /** First finite positive number among the arguments, else 0. */
    function firstPositiveNumber() {
      for (let index = 0; index < arguments.length; index += 1) {
        const value = arguments[index];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
      }
      return 0;
    }
    /** First non-empty trimmed string among the arguments, else ''. */
    function firstNonEmptyString() {
      for (let index = 0; index < arguments.length; index += 1) {
        const value = arguments[index];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    }
    /** Compact token count: 999 / 1.2k / 3.4M (exact value goes in the title attribute). */
    function formatCompactNumber(value) {
      const number = toFiniteNumber(value);
      const abs = Math.abs(number);
      if (abs < 1000) return String(Math.round(number));
      const units = [
        { limit: 1000000000, suffix: 'B' },
        { limit: 1000000, suffix: 'M' },
        { limit: 1000, suffix: 'k' },
      ];
      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index];
        if (abs < unit.limit) continue;
        const scaled = number / unit.limit;
        const digits = Math.abs(scaled) >= 100 ? 0 : 1;
        let text = scaled.toFixed(digits);
        if (text.length > 2 && text.slice(-2) === '.0') text = text.slice(0, -2);
        return text + unit.suffix;
      }
      return String(Math.round(number));
    }
    /** Exact grouped number, used for tooltips and table cells. */
    function formatExactNumber(value) {
      const number = toFiniteNumber(value);
      try {
        return number.toLocaleString();
      } catch (error) {
        return String(number);
      }
    }
    /** Latency label: milliseconds below one second, seconds above. */
    function formatDuration(value, t) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return t('usage.noValue');
      if (value >= 1000) {
        const seconds = value / 1000;
        const text = seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1).replace(/\.0$/, '');
        return t('usage.durationS', { value: text });
      }
      return t('usage.durationMs', { value: String(Math.round(value)) });
    }
    /** Local YYYY-MM-DD key for one date. */
    function formatDateKey(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return year + '-' + month + '-' + day;
    }
    /** Parse a YYYY-MM-DD day key as a local date (null when malformed). */
    function parseDateKey(key) {
      const text = typeof key === 'string' ? key : '';
      const parts = text.split('-');
      if (parts.length !== 3) return null;
      const year = Number(parts[0]);
      const month = Number(parts[1]);
      const day = Number(parts[2]);
      if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
      const date = new Date(year, month - 1, day);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    /** Short chart label for one day key (M/D). */
    function formatDayLabel(key) {
      const date = parseDateKey(key);
      if (!date) return String(key || '');
      return String(date.getMonth() + 1) + '/' + String(date.getDate());
    }
    /** Locale clock time for a timestamp (date prefix when not today). */
    function formatEventTime(value) {
      const at = toFiniteNumber(value);
      if (at <= 0) return '';
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return '';
      try {
        const now = new Date();
        const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
        if (sameDay) return date.toLocaleTimeString();
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
      } catch (error) {
        return date.toISOString();
      }
    }
    /** Full locale date and time for the expanded trace detail. */
    function formatFullTime(value) {
      const at = toFiniteNumber(value);
      if (at <= 0) return '';
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return '';
      try {
        return date.toLocaleString();
      } catch (error) {
        return date.toISOString();
      }
    }
    /** Only http(s) links become anchors in the trace detail. */
    function safeHttpUrl(value) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) return '';
      try {
        const parsed = new URL(text);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? text : '';
      } catch (error) {
        return '';
      }
    }
    /** Empty usage bucket with every counter present. */
    function emptyUsageBucket() {
      return {
        requests: 0,
        ok: 0,
        errors: 0,
        cached: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        avgLatencyMs: 0,
      };
    }
    /** Normalize one Host usage bucket (totals/today/kind/model). */
    function normalizeUsageBucket(source) {
      const raw = source && typeof source === 'object' ? source : {};
      const bucket = emptyUsageBucket();
      const keys = Object.keys(bucket);
      for (let index = 0; index < keys.length; index += 1) {
        bucket[keys[index]] = toFiniteNumber(raw[keys[index]]);
      }
      return bucket;
    }
    /** Empty summary whose chart still keeps a continuous day range. */
    function createEmptyUsageSummary(dayCount) {
      const count = typeof dayCount === 'number' && Number.isFinite(dayCount) && dayCount > 0 ? Math.floor(dayCount) : USAGE_CHART_DAYS;
      const today = new Date();
      const days = [];
      for (let offset = count - 1; offset >= 0; offset -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
        days.push(Object.assign(normalizeUsageBucket(null), { date: formatDateKey(date) }));
      }
      return {
        version: 0,
        updatedAt: 0,
        totals: normalizeUsageBucket(null),
        today: normalizeUsageBucket(null),
        days: days,
        byModel: [],
        byKind: { translate: normalizeUsageBucket(null), lookup: normalizeUsageBucket(null) },
        recent: [],
        avgLatencyMs: 0,
      };
    }
    /** Normalize one Host event into a UI-safe trace entry. */
    function normalizeUsageEvent(source, index) {
      const raw = source && typeof source === 'object' ? source : {};
      const at = toFiniteNumber(raw.at);
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : 'evt-fallback-' + String(index || 0) + '-' + String(at),
        at: at,
        kind: raw.kind === 'lookup' ? 'lookup' : 'translate',
        ok: raw.ok !== false,
        errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : '',
        provider: typeof raw.provider === 'string' ? raw.provider : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : '',
        targetLanguage: typeof raw.targetLanguage === 'string' ? raw.targetLanguage : '',
        sourceLanguage: typeof raw.sourceLanguage === 'string' ? raw.sourceLanguage : '',
        client: typeof raw.client === 'string' ? raw.client : '',
        site: typeof raw.site === 'string' ? raw.site : '',
        sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
        sourceTitle: typeof raw.sourceTitle === 'string' ? raw.sourceTitle : '',
        segments: toFiniteNumber(raw.segments),
        chars: toFiniteNumber(raw.chars),
        cached: raw.cached === true,
        retries: toFiniteNumber(raw.retries),
        inputTokens: toFiniteNumber(raw.inputTokens),
        outputTokens: toFiniteNumber(raw.outputTokens),
        cacheReadTokens: toFiniteNumber(raw.cacheReadTokens),
        cacheWriteTokens: toFiniteNumber(raw.cacheWriteTokens),
        latencyMs: toFiniteNumber(raw.latencyMs),
        sample: typeof raw.sample === 'string' ? raw.sample : '',
      };
    }
    /** Normalize the GET /usage summary envelope into a UI-safe structure. */
    function normalizeUsageSummary(source) {
      const raw = source && typeof source === 'object' ? source : {};
      const days = [];
      const sourceDays = Array.isArray(raw.days) ? raw.days : [];
      for (let index = 0; index < sourceDays.length; index += 1) {
        const day = sourceDays[index];
        if (!day || typeof day.date !== 'string' || !day.date) continue;
        days.push(Object.assign(normalizeUsageBucket(day), { date: day.date }));
      }
      const byModel = [];
      const sourceModels = Array.isArray(raw.byModel) ? raw.byModel : [];
      for (let index = 0; index < sourceModels.length; index += 1) {
        const model = sourceModels[index];
        if (!model || typeof model !== 'object') continue;
        byModel.push({
          provider: typeof model.provider === 'string' ? model.provider : '',
          model: typeof model.model === 'string' ? model.model : '',
          requests: toFiniteNumber(model.requests),
          inputTokens: toFiniteNumber(model.inputTokens),
          outputTokens: toFiniteNumber(model.outputTokens),
          cacheReadTokens: toFiniteNumber(model.cacheReadTokens),
          cacheWriteTokens: toFiniteNumber(model.cacheWriteTokens),
          lastAt: toFiniteNumber(model.lastAt),
        });
      }
      const kindSource = raw.byKind && typeof raw.byKind === 'object' ? raw.byKind : raw.kinds && typeof raw.kinds === 'object' ? raw.kinds : {};
      const recent = [];
      const sourceRecent = Array.isArray(raw.recent) ? raw.recent : [];
      for (let index = 0; index < sourceRecent.length; index += 1) {
        recent.push(normalizeUsageEvent(sourceRecent[index], index));
      }
      const totals = normalizeUsageBucket(raw.totals);
      let today = normalizeUsageBucket(raw.today);
      if (!raw.today) {
        const todayKey = formatDateKey(new Date());
        for (let index = 0; index < days.length; index += 1) {
          if (days[index].date === todayKey) {
            today = days[index];
            break;
          }
        }
      }
      const fallback = createEmptyUsageSummary(days.length > 0 ? days.length : USAGE_CHART_DAYS);
      return {
        version: toFiniteNumber(raw.version),
        updatedAt: toFiniteNumber(raw.updatedAt),
        totals: totals,
        today: today,
        days: days.length > 0 ? days : fallback.days,
        byModel: byModel,
        byKind: {
          translate: normalizeUsageBucket(kindSource.translate),
          lookup: normalizeUsageBucket(kindSource.lookup),
        },
        recent: recent,
        avgLatencyMs: firstPositiveNumber(raw.avgLatencyMs, raw.today && raw.today.avgLatencyMs, totals.avgLatencyMs),
      };
    }
    /** Extract the summary out of a GET/PUT/DELETE /usage envelope. */
    function extractUsageSummary(payload) {
      if (!payload || typeof payload !== 'object') return null;
      const source = payload.usage && typeof payload.usage === 'object' ? payload.usage : payload.summary && typeof payload.summary === 'object' ? payload.summary : null;
      return source ? normalizeUsageSummary(source) : null;
    }
    /** Extract normalized events out of a GET /usage/events envelope, newest first. */
    function extractUsageEvents(payload) {
      const raw = payload && typeof payload === 'object' && Array.isArray(payload.events) ? payload.events : [];
      const events = [];
      for (let index = 0; index < raw.length; index += 1) events.push(normalizeUsageEvent(raw[index], index));
      events.sort((left, right) => right.at - left.at);
      return events;
    }
    /** DOM-id-safe token derived from a turn/step id (ids are opaque and may contain ':'). */
    function traceSafeId(value) {
      const text = value === null || value === undefined ? '' : String(value);
      return text.replace(/[^a-zA-Z0-9_-]+/g, '-');
    }
    /** Normalize one Turn step from GET /usage/turns (missing fields become safe defaults). */
    function normalizeUsageStep(source, fallbackIndex) {
      const raw = source && typeof source === 'object' ? source : {};
      const explicitIndex = typeof raw.stepIndex === 'number' && Number.isFinite(raw.stepIndex) && raw.stepIndex >= 0;
      return {
        stepIndex: explicitIndex ? Math.floor(raw.stepIndex) : fallbackIndex,
        id: typeof raw.id === 'string' ? raw.id : '',
        at: toFiniteNumber(raw.at),
        kind: raw.kind === 'lookup' ? 'lookup' : 'translate',
        provider: typeof raw.provider === 'string' ? raw.provider : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        segments: toFiniteNumber(raw.segments),
        chars: toFiniteNumber(raw.chars),
        cached: raw.cached === true,
        retries: toFiniteNumber(raw.retries),
        ok: raw.ok !== false,
        errorCode: typeof raw.errorCode === 'string' ? raw.errorCode : '',
        inputTokens: toFiniteNumber(raw.inputTokens),
        outputTokens: toFiniteNumber(raw.outputTokens),
        cacheReadTokens: toFiniteNumber(raw.cacheReadTokens),
        cacheWriteTokens: toFiniteNumber(raw.cacheWriteTokens),
        latencyMs: toFiniteNumber(raw.latencyMs),
        sourceLanguage: typeof raw.sourceLanguage === 'string' ? raw.sourceLanguage : '',
        targetLanguage: typeof raw.targetLanguage === 'string' ? raw.targetLanguage : '',
        sample: typeof raw.sample === 'string' ? raw.sample : '',
        outputPreview: typeof raw.outputPreview === 'string' ? raw.outputPreview : '',
      };
    }
    /** Step order inside a Turn: stepIndex first, then timestamp (ties keep array order). */
    function compareUsageSteps(left, right) {
      if (left.stepIndex !== right.stepIndex) return left.stepIndex - right.stepIndex;
      return left.at - right.at;
    }
    /** Normalize one Turn from GET /usage/turns (tolerates missing aggregates). */
    function normalizeUsageTurn(source, index) {
      const raw = source && typeof source === 'object' ? source : {};
      const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
      const steps = [];
      const sums = {
        segments: 0,
        chars: 0,
        errors: 0,
        cached: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        latencySum: 0,
        latencyCount: 0,
      };
      let firstAt = 0;
      let lastAt = 0;
      for (let stepOrder = 0; stepOrder < rawSteps.length; stepOrder += 1) {
        const step = normalizeUsageStep(rawSteps[stepOrder], stepOrder);
        steps.push(step);
        sums.segments += step.segments;
        sums.chars += step.chars;
        sums.errors += step.ok ? 0 : 1;
        sums.cached += step.cached ? 1 : 0;
        sums.inputTokens += step.inputTokens;
        sums.outputTokens += step.outputTokens;
        sums.cacheReadTokens += step.cacheReadTokens;
        sums.cacheWriteTokens += step.cacheWriteTokens;
        if (step.latencyMs > 0) {
          sums.latencySum += step.latencyMs;
          sums.latencyCount += 1;
        }
        if (step.at > 0) {
          if (firstAt === 0 || step.at < firstAt) firstAt = step.at;
          if (step.at > lastAt) lastAt = step.at;
        }
      }
      steps.sort(compareUsageSteps);
      const firstStep = steps.length > 0 ? steps[0] : null;
      const has = (key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]);
      const numberOrSum = (key, sum) => (has(key) ? raw[key] : sum);
      let startedAt = toFiniteNumber(raw.startedAt);
      if (startedAt <= 0) startedAt = firstAt;
      let endedAt = toFiniteNumber(raw.endedAt);
      if (endedAt <= 0) endedAt = lastAt;
      let durationMs = toFiniteNumber(raw.durationMs);
      if (durationMs <= 0) {
        if (steps.length === 1 && firstStep && firstStep.latencyMs > 0) durationMs = firstStep.latencyMs;
        else if (startedAt > 0 && endedAt > startedAt) durationMs = endedAt - startedAt;
      }
      const avgLatencyMs = has('avgLatencyMs') ? raw.avgLatencyMs : sums.latencyCount > 0 ? Math.round(sums.latencySum / sums.latencyCount) : 0;
      const errors = numberOrSum('errors', sums.errors);
      const okCount = numberOrSum('ok', steps.length - sums.errors);
      const validStatus = raw.status === 'ok' || raw.status === 'partial' || raw.status === 'error';
      const status = validStatus ? raw.status : errors === 0 ? 'ok' : okCount > 0 ? 'partial' : 'error';
      let kind = 'translate';
      if (raw.kind === 'lookup' || raw.kind === 'mixed' || raw.kind === 'translate') {
        kind = raw.kind;
      } else if (steps.length > 0) {
        const lookupSteps = steps.filter((step) => step.kind === 'lookup').length;
        kind = lookupSteps === steps.length ? 'lookup' : lookupSteps > 0 ? 'mixed' : 'translate';
      }
      return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : 'turn-fallback-' + String(index || 0) + '-' + String(startedAt),
        kind: kind,
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
        mode: typeof raw.mode === 'string' ? raw.mode : '',
        client: typeof raw.client === 'string' ? raw.client : '',
        site: typeof raw.site === 'string' ? raw.site : '',
        sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
        sourceTitle: typeof raw.sourceTitle === 'string' ? raw.sourceTitle : '',
        provider: firstNonEmptyString(raw.provider, firstStep ? firstStep.provider : ''),
        model: firstNonEmptyString(raw.model, firstStep ? firstStep.model : ''),
        targetLanguage: firstNonEmptyString(raw.targetLanguage, firstStep ? firstStep.targetLanguage : ''),
        sourceLanguage: firstNonEmptyString(raw.sourceLanguage, firstStep ? firstStep.sourceLanguage : ''),
        startedAt: startedAt,
        endedAt: endedAt,
        durationMs: durationMs,
        requests: numberOrSum('requests', steps.length),
        ok: okCount,
        errors: errors,
        cached: typeof raw.cached === 'boolean' ? (raw.cached ? 1 : 0) : numberOrSum('cached', sums.cached),
        segments: numberOrSum('segments', sums.segments),
        chars: numberOrSum('chars', sums.chars),
        inputTokens: numberOrSum('inputTokens', sums.inputTokens),
        outputTokens: numberOrSum('outputTokens', sums.outputTokens),
        cacheReadTokens: numberOrSum('cacheReadTokens', sums.cacheReadTokens),
        cacheWriteTokens: numberOrSum('cacheWriteTokens', sums.cacheWriteTokens),
        avgLatencyMs: avgLatencyMs,
        status: status,
        steps: steps,
      };
    }
    /** Locate the turns array inside a GET /usage/turns envelope (tolerates wrappers). */
    function readUsageTurnsPage(payload) {
      const root = payload && typeof payload === 'object' ? payload : {};
      const candidates = [root, root.data, root.result, root.usage];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (candidate && typeof candidate === 'object' && Array.isArray(candidate.turns)) return candidate;
      }
      return null;
    }
    /** Extract normalized turns out of a GET /usage/turns envelope, newest first. */
    function extractUsageTurns(payload) {
      const source = readUsageTurnsPage(payload);
      const raw = source && Array.isArray(source.turns) ? source.turns : [];
      const turns = [];
      for (let index = 0; index < raw.length; index += 1) turns.push(normalizeUsageTurn(raw[index], index));
      turns.sort((left, right) => right.startedAt - left.startedAt);
      const last = turns.length > 0 ? turns[turns.length - 1] : null;
      const rawNext = source && typeof source.nextBefore === 'string' ? source.nextBefore : '';
      const nextBefore = rawNext || (last ? last.id : '');
      const hasMore = source && source.hasMore === true ? true : source && source.hasMore === undefined ? !!rawNext : false;
      return { turns: turns, nextBefore: nextBefore, hasMore: hasMore };
    }
    /** Normalize the GET /conversations envelope into a sessionId-keyed index (tolerant). */
    function extractConversationIndex(payload) {
      const root = payload && typeof payload === 'object' ? payload : {};
      const candidates = [root, root.data, root.result];
      let list = null;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (candidate && typeof candidate === 'object' && Array.isArray(candidate.conversations)) {
          list = candidate.conversations;
          break;
        }
      }
      const index = {};
      if (!list) return index;
      for (let item = 0; item < list.length; item += 1) {
        const source = list[item];
        if (!source || typeof source !== 'object') continue;
        const sessionId = typeof source.sessionId === 'string' ? source.sessionId : '';
        if (!sessionId) continue;
        index[sessionId] = {
          sessionId: sessionId,
          turnId: typeof source.turnId === 'string' ? source.turnId : '',
          title: typeof source.title === 'string' ? source.title : '',
          turns: toFiniteNumber(source.turns),
          createdAt: toFiniteNumber(source.createdAt),
          lastAt: toFiniteNumber(source.lastAt),
          live: source.live === true,
        };
      }
      return index;
    }
    /** True when the Host does not expose the /usage routes (older Host). */
    function isOutdatedUsageError(error) {
      if (!error) return false;
      if (toFiniteNumber(error.status) === 404) return true;
      return error.code === 'NOT_FOUND';
    }
    /** provider/model from a GET /settings payload (null when unknown). */
    function readModelFromSettings(payload) {
      const data = payload && typeof payload === 'object' ? payload : {};
      const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
      const selected = data.selected && typeof data.selected === 'object' ? data.selected : {};
      const info = data.modelInfo && typeof data.modelInfo === 'object' ? data.modelInfo : {};
      const provider = firstNonEmptyString(info.provider, settings.provider, selected.provider);
      const model = firstNonEmptyString(info.model, settings.model, selected.model);
      if (!provider && !model) return null;
      return { provider: provider, model: model };
    }
    /** Display label for a provider/model pair. */
    function formatModelLabel(provider, model) {
      const providerText = firstNonEmptyString(provider);
      const modelText = firstNonEmptyString(model);
      if (providerText && modelText) return providerText + '/' + modelText;
      if (modelText) return modelText;
      if (providerText) return providerText;
      return translate('trace.modelUnknown');
    }
    /** inputTokens + outputTokens (the Host derives totalTokens the same way). */
    function usageTokenTotal(bucket) {
      return toFiniteNumber(bucket && bucket.inputTokens) + toFiniteNumber(bucket && bucket.outputTokens);
    }
    /** Average latency from the summary, falling back to the recent events. */
    function usageAverageLatency(summary) {
      if (!summary) return 0;
      const bucketLatency = firstPositiveNumber(summary.avgLatencyMs, summary.today && summary.today.avgLatencyMs, summary.totals && summary.totals.avgLatencyMs);
      if (bucketLatency > 0) return bucketLatency;
      const recent = Array.isArray(summary.recent) ? summary.recent : [];
      let total = 0;
      let count = 0;
      for (let index = 0; index < recent.length; index += 1) {
        const latency = toFiniteNumber(recent[index] && recent[index].latencyMs);
        if (latency > 0) {
          total += latency;
          count += 1;
        }
      }
      return count > 0 ? total / count : 0;
    }
    /** Keep the chart continuous even when the Host returned fewer days. */
    function chartDaysFromSummary(summary) {
      const days = summary && Array.isArray(summary.days) ? summary.days : [];
      return days.length > 0 ? days : createEmptyUsageSummary(USAGE_CHART_DAYS).days;
    }
    // #endregion

    // #region token usage page
    /** Inline SVG language/translate glyph shown in the sidebar panel list. */
    function SidebarPanelIcon(props) {
      const requestedSize = props && typeof props.size === 'number' && Number.isFinite(props.size) && props.size > 0 ? props.size : 16;
      const active = !!(props && props.active);
      return h(
        'svg',
        {
          width: requestedSize,
          height: requestedSize,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          role: 'img',
          'aria-hidden': 'true',
          focusable: 'false',
          style: active ? { color: 'var(--dsw-alias-brand-primary)' } : undefined,
        },
        h('path', { key: 'panel-icon-1', d: 'M2 5h12' }),
        h('path', { key: 'panel-icon-2', d: 'M7 2h1' }),
        h('path', { key: 'panel-icon-3', d: 'm5 8 6 6' }),
        h('path', { key: 'panel-icon-4', d: 'm4 14 6-6 2-3' }),
        h('path', { key: 'panel-icon-5', d: 'm22 22-5-10-5 10' }),
        h('path', { key: 'panel-icon-6', d: 'M14 18h6' }),
      );
    }

    /** Left-toolbar page: token overview, request traces, prompts, wordbook. */
    function ImmersiveTranslatePage() {
      const t = useT();
      const workspaceService = useWorkspaceService();
      const [tab, setTab] = useState('overview');
      const [mountedTabs, setMountedTabs] = useState({ overview: true, traces: false, settings: false, wordbook: false });
      const [usage, setUsage] = useState(null);
      const [usagePhase, setUsagePhase] = useState('loading');
      const [usageError, setUsageError] = useState(null);
      const [events, setEvents] = useState([]);
      const [eventsPhase, setEventsPhase] = useState('idle');
      const [eventsError, setEventsError] = useState(null);
      const [turns, setTurns] = useState([]);
      const [turnsPhase, setTurnsPhase] = useState('idle');
      const [turnsError, setTurnsError] = useState(null);
      const [turnsHasMore, setTurnsHasMore] = useState(false);
      const [nextBefore, setNextBefore] = useState('');
      const [loadingMore, setLoadingMore] = useState(false);
      const [loadMoreError, setLoadMoreError] = useState(null);
      const [legacyTraces, setLegacyTraces] = useState(false);
      const [expandedTurns, setExpandedTurns] = useState({});
      const [expandedSteps, setExpandedSteps] = useState({});
      const [conversationMeta, setConversationMeta] = useState({});
      const [expandedConversations, setExpandedConversations] = useState({});
      const [legacyGroupExpanded, setLegacyGroupExpanded] = useState(false);
      const [traceFilter, setTraceFilter] = useState('all');
      const [expandedId, setExpandedId] = useState('');
      const [model, setModel] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [clearing, setClearing] = useState(false);
      const [confirmClear, setConfirmClear] = useState(false);
      const [cacheClearing, setCacheClearing] = useState(false);
      const [confirmCacheClear, setConfirmCacheClear] = useState(false);
      const [cacheNotice, setCacheNotice] = useState(null);
      const [liveMessage, setLiveMessage] = useState('');
      const [clearNotice, setClearNotice] = useState(null);
      const mountedRef = useRef(true);
      const usageRef = useRef(null);
      const eventsRef = useRef([]);
      const turnsRef = useRef([]);
      const nextBeforeRef = useRef('');
      const traceSeqRef = useRef(0);
      const legacyTracesRef = useRef(false);
      const conversationSeqRef = useRef(0);
      const newestConversationRef = useRef('');
      const traceFilterRef = useRef(traceFilter);
      const outdatedRef = useRef(false);
      const firstUsageTabRef = useRef(true);
      const firstTraceEffectRef = useRef(true);
      const clearTimerRef = useRef(null);
      const noticeTimerRef = useRef(null);

      /** Apply one normalized summary (also used by the DELETE response). */
      function applyUsage(summary) {
        if (!summary) return;
        usageRef.current = summary;
        setUsage(summary);
        setUsagePhase('ready');
        setUsageError(null);
      }

      /** Load GET /usage; resolves true/false and never rejects. */
      function loadUsage(options) {
        const config = options || {};
        if (config.initial) {
          setUsagePhase('loading');
          setUsageError(null);
        }
        return request('usage', { query: { days: USAGE_CHART_DAYS } })
          .then((payload) => {
            if (!mountedRef.current) return false;
            applyUsage(extractUsageSummary(payload) || createEmptyUsageSummary(USAGE_CHART_DAYS));
            return true;
          })
          .catch((error) => {
            if (!mountedRef.current) return false;
            if (isOutdatedUsageError(error)) {
              outdatedRef.current = true;
              setUsagePhase('outdated');
              setUsageError(error);
            } else if (config.initial || !usageRef.current) {
              setUsagePhase('error');
              setUsageError(error);
            }
            return false;
          });
      }

      /** Load GET /usage/events (legacy flat traces); resolves true/false and never rejects. */
      function loadEvents(options) {
        const config = options || {};
        const query = { limit: TRACE_EVENT_PAGE_SIZE };
        if (traceFilter !== 'all') query.kind = traceFilter;
        if (!config.silent) {
          setEventsPhase('loading');
          setEventsError(null);
        }
        return request('usage/events', { query: query })
          .then((payload) => {
            if (!mountedRef.current) return false;
            const list = extractUsageEvents(payload);
            eventsRef.current = list;
            setEvents(list);
            setEventsPhase('ready');
            setEventsError(null);
            return true;
          })
          .catch((error) => {
            if (!mountedRef.current) return false;
            if (isOutdatedUsageError(error)) {
              outdatedRef.current = true;
              setUsagePhase('outdated');
              setUsageError(error);
              setEventsPhase('idle');
            } else if (config.silent && eventsRef.current.length > 0) {
              /* keep the visible list when a background refresh fails */
            } else {
              setEventsPhase('error');
              setEventsError(error);
            }
            return false;
          });
      }

      /** Tolerant GET /conversations metadata load (missing route / failures are ignored). */
      function loadConversations() {
        const seq = conversationSeqRef.current + 1;
        conversationSeqRef.current = seq;
        return request('conversations')
          .then((payload) => {
            if (!mountedRef.current || seq !== conversationSeqRef.current) return false;
            setConversationMeta(extractConversationIndex(payload));
            return true;
          })
          .catch(() => {
            // /conversations is optional metadata (old Hosts); the ledger view stays usable.
            return false;
          });
      }

      /** Drop the Turn list so a filter change shows the skeleton instead of stale rows. */
      function resetTurnsForFilter() {
        turnsRef.current = [];
        nextBeforeRef.current = '';
        setTurns([]);
        setNextBefore('');
        setTurnsHasMore(false);
        setLoadMoreError(null);
        setExpandedSteps({});
      }

      /** Load the newest page of GET /usage/turns; falls back to events on old Hosts. */
      function loadTurns(options) {
        const config = options || {};
        const seq = traceSeqRef.current + 1;
        traceSeqRef.current = seq;
        if (!config.silent) {
          setTurnsPhase('loading');
          setTurnsError(null);
        }
        setLoadMoreError(null);
        const query = { limit: TRACE_TURN_PAGE_SIZE };
        if (traceFilter !== 'all') query.kind = traceFilter;
        return request('usage/turns', { query: query })
          .then((payload) => {
            if (!mountedRef.current || seq !== traceSeqRef.current) return false;
            const page = extractUsageTurns(payload);
            turnsRef.current = page.turns;
            nextBeforeRef.current = page.nextBefore;
            setTurns(page.turns);
            setNextBefore(page.nextBefore);
            setTurnsHasMore(page.hasMore);
            setTurnsPhase('ready');
            setTurnsError(null);
            // DSH-like default: the newest conversation is expanded. A background
            // refresh only adds the new one, so user-expanded cards stay open.
            let newestSessionId = '';
            for (let index = 0; index < page.turns.length; index += 1) {
              if (page.turns[index].sessionId) {
                newestSessionId = page.turns[index].sessionId;
                break;
              }
            }
            if (newestSessionId && newestSessionId !== newestConversationRef.current) {
              newestConversationRef.current = newestSessionId;
              setExpandedConversations((current) => {
                const next = Object.assign({}, current);
                next[newestSessionId] = true;
                return next;
              });
            }
            return true;
          })
          .catch((error) => {
            if (!mountedRef.current || seq !== traceSeqRef.current) return false;
            if (isOutdatedUsageError(error)) {
              legacyTracesRef.current = true;
              setLegacyTraces(true);
              turnsRef.current = [];
              setTurns([]);
              setTurnsPhase('idle');
              setTurnsError(null);
              return loadEvents({ silent: false });
            }
            if (config.silent && turnsRef.current.length > 0) {
              setTurnsPhase('ready');
              return false;
            }
            setTurnsPhase('error');
            setTurnsError(error);
            return false;
          });
      }

      /** Load the trace list (Turn cards grouped into conversations) plus optional metadata. */
      function reloadTraces(options) {
        if (legacyTracesRef.current) return loadEvents(options);
        return Promise.all([loadTurns(options), loadConversations()]).then((results) => results[0]);
      }

      /** Append the next older page of turns (GET /usage/turns?before=<last turn id>). */
      function loadMoreTurns() {
        if (loadingMore) return;
        const before = nextBeforeRef.current || (turnsRef.current.length > 0 ? turnsRef.current[turnsRef.current.length - 1].id : '');
        if (!before) {
          setTurnsHasMore(false);
          return;
        }
        const seq = traceSeqRef.current + 1;
        traceSeqRef.current = seq;
        setLoadingMore(true);
        setLoadMoreError(null);
        const query = { limit: TRACE_TURN_PAGE_SIZE, before: before };
        if (traceFilter !== 'all') query.kind = traceFilter;
        return request('usage/turns', { query: query })
          .then((payload) => {
            if (!mountedRef.current || seq !== traceSeqRef.current) return false;
            const page = extractUsageTurns(payload);
            const merged = turnsRef.current.slice();
            const seen = {};
            for (let index = 0; index < merged.length; index += 1) seen[merged[index].id] = true;
            for (let index = 0; index < page.turns.length; index += 1) {
              if (!seen[page.turns[index].id]) {
                seen[page.turns[index].id] = true;
                merged.push(page.turns[index]);
              }
            }
            merged.sort((left, right) => right.startedAt - left.startedAt);
            turnsRef.current = merged;
            nextBeforeRef.current = page.nextBefore;
            setTurns(merged);
            setNextBefore(page.nextBefore);
            setTurnsHasMore(page.hasMore && page.turns.length > 0);
            setLoadingMore(false);
            return true;
          })
          .catch((error) => {
            if (!mountedRef.current || seq !== traceSeqRef.current) return false;
            setLoadingMore(false);
            if (isOutdatedUsageError(error)) {
              legacyTracesRef.current = true;
              setLegacyTraces(true);
              setTurnsPhase('idle');
              return loadEvents({ silent: false });
            }
            setLoadMoreError(error);
            return false;
          });
      }

      // First mount: connect the optional locale (late attach) and load the summary.
      useEffect(() => {
        mountedRef.current = true;
        if (!localeRuntime.connected) connectLocale();
        loadUsage({ initial: true });
        return () => {
          mountedRef.current = false;
          if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
          if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        };
      }, []);

      // Ambient refresh: GET /usage every 5s while the document is visible.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const tick = () => {
          if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
          if (outdatedRef.current) return;
          loadUsage({ silent: true });
        };
        const timer = setInterval(tick, USAGE_POLL_MS);
        document.addEventListener('visibilitychange', tick);
        return () => {
          clearInterval(timer);
          document.removeEventListener('visibilitychange', tick);
        };
      }, []);

      // Tab switches refresh the summary; the trace tab reloads its own list below.
      useEffect(() => {
        if (firstUsageTabRef.current) {
          firstUsageTabRef.current = false;
          return;
        }
        if (tab === 'settings' || tab === 'wordbook') return;
        if (!outdatedRef.current) loadUsage({ silent: true });
      }, [tab]);

      // Traces load on mount, then whenever the trace tab or the filter changes.
      useEffect(() => {
        if (firstTraceEffectRef.current) {
          firstTraceEffectRef.current = false;
          reloadTraces({ silent: false });
          return;
        }
        if (traceFilterRef.current !== traceFilter) {
          traceFilterRef.current = traceFilter;
          newestConversationRef.current = '';
          setExpandedConversations({});
          setLegacyGroupExpanded(false);
          setExpandedSteps({});
          if (!legacyTracesRef.current) resetTurnsForFilter();
        }
        if (tab !== 'traces') return;
        reloadTraces({ silent: legacyTracesRef.current ? eventsRef.current.length > 0 : turnsRef.current.length > 0 });
      }, [tab, traceFilter]);

      // Header model chip mirrors the model saved in Settings.
      useEffect(() => {
        let cancelled = false;
        api
          .get('settings')
          .then((payload) => {
            if (cancelled || !mountedRef.current) return;
            setModel(readModelFromSettings(payload));
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [tab]);

      /** Manual refresh with a polite live-region status. */
      function refreshNow() {
        if (refreshing) return;
        setRefreshing(true);
        setLiveMessage(t('panel.refreshing'));
        const tasks = [loadUsage({ silent: true })];
        if (tab === 'traces') tasks.push(reloadTraces({ silent: legacyTracesRef.current ? eventsRef.current.length > 0 : turnsRef.current.length > 0 }));
        Promise.all(tasks)
          .then((results) => {
            if (!mountedRef.current) return;
            setRefreshing(false);
            const failed = results.some((value) => value === false);
            setLiveMessage(failed ? t('panel.refreshFailed') : t('panel.refreshed'));
          })
          .catch(() => {
            if (!mountedRef.current) return;
            setRefreshing(false);
            setLiveMessage(t('panel.refreshFailed'));
          });
      }

      /** Show the inline clear confirmation, auto-cancelling after a few seconds. */
      function requestClear() {
        if (clearing) return;
        setConfirmClear(true);
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setConfirmClear(false);
        }, 5000);
      }

      /** Hide the inline clear confirmation. */
      function cancelClear() {
        setConfirmClear(false);
        if (clearTimerRef.current) {
          clearTimeout(clearTimerRef.current);
          clearTimerRef.current = null;
        }
      }

      /** Transient notice below the trace toolbar. */
      function showClearNotice(kind, text) {
        setClearNotice({ kind: kind, text: text });
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setClearNotice(null);
        }, 4000);
      }

      /** DELETE /usage, then reset the local aggregates and list. */
      function clearUsage() {
        if (clearing) return;
        setClearing(true);
        setConfirmClear(false);
        request('usage', { method: 'DELETE' })
          .then((payload) => {
            if (!mountedRef.current) return;
            const summary = extractUsageSummary(payload);
            if (summary) applyUsage(summary);
            else loadUsage({ silent: true });
            eventsRef.current = [];
            setEvents([]);
            turnsRef.current = [];
            nextBeforeRef.current = '';
            setTurns([]);
            setNextBefore('');
            setTurnsHasMore(false);
            setLoadMoreError(null);
            setExpandedTurns({});
            setExpandedSteps({});
            setExpandedConversations({});
            setLegacyGroupExpanded(false);
            newestConversationRef.current = '';
            setExpandedId('');
            setEventsPhase('ready');
            setTurnsPhase('ready');
            showClearNotice('ok', t('trace.clearDone'));
            setLiveMessage(t('trace.clearDone'));
            if (tab === 'traces') reloadTraces({ silent: true });
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            if (isOutdatedUsageError(error)) {
              outdatedRef.current = true;
              setUsagePhase('outdated');
              setUsageError(error);
            } else {
              showClearNotice('error', describeError(error, t));
            }
          })
          .finally(() => {
            if (mountedRef.current) setClearing(false);
          });
      }

      /** DELETE /cache: drop the persisted translation result cache. */
      function clearResultCache() {
        if (cacheClearing) return;
        setCacheClearing(true);
        setConfirmCacheClear(false);
        setCacheNotice(null);
        request('cache', { method: 'DELETE' })
          .then(() => {
            if (!mountedRef.current) return;
            setCacheNotice({ kind: 'ok', text: t('cache.cleared') });
          })
          .catch((error) => {
            if (!mountedRef.current) return;
            const text = isOutdatedUsageError(error) ? t('cache.notSupported') : describeError(error, t);
            setCacheNotice({ kind: 'error', text: text });
          })
          .finally(() => {
            if (mountedRef.current) setCacheClearing(false);
          });
      }

      /** Select one tab, mounting its panel on first visit. */
      function selectTab(nextTab) {
        setTab(nextTab);
        setExpandedId('');
        setMountedTabs((current) => {
          if (current[nextTab]) return current;
          const next = Object.assign({}, current);
          next[nextTab] = true;
          return next;
        });
      }

      /** Left/right/Home/End move between the four tabs. */
      function onTabKeyDown(event) {
        const ids = ['overview', 'traces', 'settings', 'wordbook'];
        const index = ids.indexOf(tab);
        let nextIndex = -1;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % ids.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + ids.length) % ids.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = ids.length - 1;
        if (nextIndex < 0) return;
        event.preventDefault();
        const nextTab = ids[nextIndex];
        selectTab(nextTab);
        if (typeof document !== 'undefined') {
          const node = document.getElementById('dsh-it-usage-tab-' + nextTab);
          if (node && typeof node.focus === 'function') node.focus();
        }
      }

      /** Toggle one trace row's expanded detail. */
      function toggleExpanded(id) {
        setExpandedId((current) => (current === id ? '' : id));
      }

      /** Toggle one conversation card (state is keyed by the stable sessionId). */
      function toggleConversation(sessionId) {
        setExpandedConversations((current) => {
          const next = Object.assign({}, current);
          if (next[sessionId]) delete next[sessionId];
          else next[sessionId] = true;
          return next;
        });
      }

      /** Toggle the collapsed "legacy requests" group. */
      function toggleLegacyGroup() {
        setLegacyGroupExpanded((current) => !current);
      }

      /** Toggle one inline Turn card (state is keyed by the stable turn.id). */
      function toggleTurn(id) {
        setExpandedTurns((current) => {
          const next = Object.assign({}, current);
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
      }

      /** Toggle one step's expanded detail grid. */
      function toggleStep(key) {
        setExpandedSteps((current) => {
          const next = Object.assign({}, current);
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      }

      /** Retry button shared by the inline error alerts. */
      function retryButton(onClick) {
        return h('button', { type: 'button', className: 'dsh-it-btn', onClick: onClick }, t('common.retry'));
      }

      /** Alert shown when the Host does not expose the /usage routes. */
      function renderOutdated() {
        return h(InlineAlert, { kind: 'warn', title: t('panel.hostOutdated') }, t('panel.hostOutdatedHint'));
      }

      /** Today's stat cards. */
      function renderTodayStats(summary) {
        const today = summary.today;
        const averageLatency = usageAverageLatency(summary);
        const latencyText = averageLatency > 0 ? formatDuration(averageLatency, t) : t('usage.noValue');
        const cards = [
          { id: 'requests', label: t('usage.stat.requests'), value: formatCompactNumber(today.requests), exact: formatExactNumber(today.requests) },
          { id: 'input', label: t('usage.stat.input'), value: formatCompactNumber(today.inputTokens), exact: formatExactNumber(today.inputTokens) },
          { id: 'output', label: t('usage.stat.output'), value: formatCompactNumber(today.outputTokens), exact: formatExactNumber(today.outputTokens) },
          { id: 'cacheRead', label: t('usage.stat.cacheRead'), value: formatCompactNumber(today.cacheReadTokens), exact: formatExactNumber(today.cacheReadTokens) },
          { id: 'errors', label: t('usage.stat.errors'), value: formatCompactNumber(today.errors), exact: formatExactNumber(today.errors) },
          { id: 'latency', label: t('usage.stat.avgLatency'), value: latencyText, exact: latencyText },
        ];
        return h(
          'div',
          { className: 'dsh-it-usage-stats' },
          cards.map((card) =>
            h(
              'div',
              { key: 'usage-stat-' + card.id, className: 'dsh-it-usage-stat' },
              h('span', { className: 'dsh-it-usage-stat-value', title: card.exact }, card.value),
              h('span', { className: 'dsh-it-usage-stat-label' }, card.label),
            ),
          ),
        );
      }

      /** CSS bar chart of the recent days (no chart library). */
      function renderChart(summary) {
        const days = chartDaysFromSummary(summary);
        let max = 0;
        for (let index = 0; index < days.length; index += 1) {
          const total = usageTokenTotal(days[index]);
          if (total > max) max = total;
        }
        const legend = h(
          'div',
          { className: 'dsh-it-bars-legend' },
          h('span', null, h('span', { className: 'dsh-it-bars-dot dsh-it-bars-dot-input' }), t('usage.legendInput')),
          h('span', null, h('span', { className: 'dsh-it-bars-dot dsh-it-bars-dot-output' }), t('usage.legendOutput')),
        );
        let body = null;
        if (max > 0) {
          body = h(
            'div',
            { className: 'dsh-it-bars', role: 'img', 'aria-label': t('usage.chartAria') },
            days.map((day) => {
              const inputTokens = toFiniteNumber(day.inputTokens);
              const outputTokens = toFiniteNumber(day.outputTokens);
              const total = inputTokens + outputTokens;
              let inputHeight = total > 0 ? Math.round((inputTokens / max) * 100) : 0;
              let outputHeight = total > 0 ? Math.round((outputTokens / max) * 100) : 0;
              if (total > 0 && inputHeight + outputHeight === 0) {
                if (inputTokens >= outputTokens) inputHeight = 2;
                else outputHeight = 2;
              }
              return h(
                'div',
                {
                  key: 'usage-bar-' + day.date,
                  className: 'dsh-it-bars-col',
                  title:
                    formatDayLabel(day.date) +
                    ' · ' +
                    t('usage.chartBar', {
                      requests: formatExactNumber(day.requests),
                      input: formatExactNumber(inputTokens),
                      output: formatExactNumber(outputTokens),
                    }),
                },
                h(
                  'div',
                  { className: 'dsh-it-bars-track' },
                  outputHeight > 0 ? h('div', { className: 'dsh-it-bars-seg dsh-it-bars-seg-output', style: { height: outputHeight + 'px' } }) : null,
                  inputHeight > 0 ? h('div', { className: 'dsh-it-bars-seg dsh-it-bars-seg-input', style: { height: inputHeight + 'px' } }) : null,
                ),
                h('span', { className: 'dsh-it-bars-label' }, formatDayLabel(day.date)),
              );
            }),
          );
        } else {
          body = h('p', { className: 'dsh-it-usage-empty-inline' }, t('usage.chartEmpty'));
        }
        return h(
          'div',
          { className: 'dsh-it-card' },
          h('div', { className: 'dsh-it-card-header' }, h('h3', { className: 'dsh-it-card-title' }, t('usage.chartTitle')), legend),
          body,
        );
      }

      /** Per-model breakdown table. */
      function renderModelTable(summary) {
        const models = summary.byModel;
        let table = null;
        if (models.length === 0) {
          table = h('p', { className: 'dsh-it-usage-empty-inline' }, t('usage.modelEmpty'));
        } else {
          table = h(
            'div',
            { className: 'dsh-it-table-wrap' },
            h(
              'table',
              { className: 'dsh-it-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { scope: 'col' }, t('usage.col.providerModel')),
                  h('th', { scope: 'col', className: 'dsh-it-table-num' }, t('usage.col.requests')),
                  h('th', { scope: 'col', className: 'dsh-it-table-num' }, t('usage.col.input')),
                  h('th', { scope: 'col', className: 'dsh-it-table-num' }, t('usage.col.output')),
                  h('th', { scope: 'col', className: 'dsh-it-table-num' }, t('usage.col.cacheRead')),
                  h('th', { scope: 'col' }, t('usage.col.lastUsed')),
                ),
              ),
              h(
                'tbody',
                null,
                models.map((entry, index) =>
                  h(
                    'tr',
                    { key: 'usage-model-' + index },
                    h(
                      'td',
                      null,
                      h('div', { className: 'dsh-it-table-model' }, entry.model || t('trace.modelUnknown')),
                      entry.provider ? h('div', { className: 'dsh-it-table-provider' }, entry.provider) : null,
                    ),
                    h('td', { className: 'dsh-it-table-num', title: formatExactNumber(entry.requests) }, formatCompactNumber(entry.requests)),
                    h('td', { className: 'dsh-it-table-num', title: formatExactNumber(entry.inputTokens) }, formatCompactNumber(entry.inputTokens)),
                    h('td', { className: 'dsh-it-table-num', title: formatExactNumber(entry.outputTokens) }, formatCompactNumber(entry.outputTokens)),
                    h('td', { className: 'dsh-it-table-num', title: formatExactNumber(entry.cacheReadTokens) }, formatCompactNumber(entry.cacheReadTokens)),
                    h(
                      'td',
                      { title: entry.lastAt > 0 ? formatFullTime(entry.lastAt) : '' },
                      entry.lastAt > 0 ? formatEventTime(entry.lastAt) : t('usage.noValue'),
                    ),
                  ),
                ),
              ),
            ),
          );
        }
        return h(
          'div',
          { className: 'dsh-it-card' },
          h('div', { className: 'dsh-it-card-header' }, h('h3', { className: 'dsh-it-card-title' }, t('usage.modelTitle'))),
          table,
        );
      }

      /** Translate / lookup kind breakdown. */
      function renderKindBreakdown(summary) {
        const kinds = [
          { id: 'translate', key: 'usage.kind.translate', bucket: summary.byKind.translate },
          { id: 'lookup', key: 'usage.kind.lookup', bucket: summary.byKind.lookup },
        ];
        return h(
          'div',
          { className: 'dsh-it-card' },
          h('div', { className: 'dsh-it-card-header' }, h('h3', { className: 'dsh-it-card-title' }, t('usage.kindTitle'))),
          h(
            'div',
            { className: 'dsh-it-usage-kinds' },
            kinds.map((entry) =>
              h(
                'div',
                { key: 'usage-kind-' + entry.id, className: 'dsh-it-usage-kind' },
                h(
                  'div',
                  { className: 'dsh-it-usage-kind-head' },
                  h('span', { className: 'dsh-it-usage-badge dsh-it-usage-badge-' + entry.id }, t(entry.key)),
                  h('span', { className: 'dsh-it-hint' }, t('usage.kindRequests', { count: formatExactNumber(entry.bucket.requests) })),
                ),
                h(
                  'div',
                  { className: 'dsh-it-usage-kind-meta' },
                  t('usage.kindTokens', {
                    input: formatCompactNumber(entry.bucket.inputTokens),
                    output: formatCompactNumber(entry.bucket.outputTokens),
                  }) +
                    ' · ' +
                    t('usage.col.cacheRead') +
                    ' ' +
                    formatCompactNumber(entry.bucket.cacheReadTokens),
                ),
              ),
            ),
          ),
        );
      }

      /** Overview tab content. */
      /** 概览页底部的翻译结果缓存卡片（清空入口 + 隐私/位置说明）。 */
      function renderCacheCard() {
        const notice = cacheNotice;
        return h(
          'section',
          { className: 'dsh-it-cache-card', 'aria-label': t('cache.title') },
          h(
            'div',
            { className: 'dsh-it-cache-main' },
            h('h3', { className: 'dsh-it-cache-title' }, t('cache.title')),
            h('p', { className: 'dsh-it-cache-desc' }, t('cache.desc')),
          ),
          h(
            'div',
            { className: 'dsh-it-cache-actions' },
            notice
              ? h(
                  'span',
                  {
                    className: 'dsh-it-cache-notice' + (notice.kind === 'ok' ? '' : ' dsh-it-cache-notice-error'),
                    role: 'status',
                  },
                  notice.text,
                )
              : null,
            confirmCacheClear
              ? h(
                  React.Fragment,
                  null,
                  h('button', { type: 'button', className: 'dsh-it-btn', disabled: cacheClearing, onClick: clearResultCache }, cacheClearing ? t('cache.clearing') : t('cache.clearConfirm')),
                  h('button', { type: 'button', className: 'dsh-it-btn', onClick: () => setConfirmCacheClear(false) }, t('cache.cancel')),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-it-btn',
                    disabled: cacheClearing,
                    onClick: () => setConfirmCacheClear(true),
                  },
                  cacheClearing ? t('cache.clearing') : t('cache.clear'),
                ),
          ),
        );
      }

      function renderOverview() {
        if (usagePhase === 'outdated') return renderOutdated();
        if (usagePhase === 'loading' && !usage) return h(LoadingSkeleton, { label: t('common.loading') });
        if (usagePhase === 'error' && !usage) {
          return h(
            InlineAlert,
            { kind: 'error', title: t('usage.loadFailed'), action: retryButton(() => loadUsage({ initial: true })) },
            describeError(usageError, t),
          );
        }
        const summary = usage || createEmptyUsageSummary(USAGE_CHART_DAYS);
        const totals = summary.totals;
        return h(
          React.Fragment,
          null,
          renderTodayStats(summary),
          renderChart(summary),
          renderModelTable(summary),
          renderKindBreakdown(summary),
          renderCacheCard(),
          h(
            'p',
            { className: 'dsh-it-usage-summary' },
            t('usage.footer', { requests: formatExactNumber(totals.requests), tokens: formatCompactNumber(usageTokenTotal(totals)) }) +
              (summary.updatedAt > 0 ? ' · ' + t('panel.updatedAt', { time: formatEventTime(summary.updatedAt) }) : ''),
          ),
        );
      }

      /** Expanded trace detail grid. */
      function renderEventDetail(item) {
        const kindKey = item.kind === 'lookup' ? 'usage.kind.lookup' : 'usage.kind.translate';
        const modelLabel = formatModelLabel(item.provider, item.model);
        const entries = [];
        entries.push({ label: t('trace.detail.time'), value: formatFullTime(item.at) || t('usage.noValue') });
        entries.push({ label: t('trace.detail.kind'), value: t(kindKey) });
        entries.push({ label: t('trace.detail.model'), value: modelLabel, mono: true });
        entries.push({ label: t('trace.detail.client'), value: item.client || t('usage.noValue'), mono: true });
        entries.push({ label: t('trace.detail.site'), value: item.site || t('usage.noValue') });
        if (item.reasoningEffort) entries.push({ label: t('settings.effort'), value: item.reasoningEffort, mono: true });
        if (item.sourceLanguage || item.targetLanguage) {
          entries.push({ label: t('trace.detail.languages'), value: (item.sourceLanguage || '?') + ' → ' + (item.targetLanguage || '?') });
        }
        entries.push({ label: t('trace.detail.segments'), value: formatExactNumber(item.segments) + ' / ' + formatExactNumber(item.chars) });
        entries.push({ label: t('trace.detail.tokens'), value: formatExactNumber(item.inputTokens) + ' / ' + formatExactNumber(item.outputTokens) });
        entries.push({ label: t('trace.detail.cacheTokens'), value: formatExactNumber(item.cacheReadTokens) + ' / ' + formatExactNumber(item.cacheWriteTokens) });
        entries.push({ label: t('trace.detail.cached'), value: item.cached ? t('trace.detail.yes') : t('trace.detail.no') });
        entries.push({ label: t('trace.detail.retries'), value: formatExactNumber(item.retries) });
        entries.push({ label: t('trace.detail.latency'), value: formatDuration(item.latencyMs, t) });
        if (item.sourceTitle) entries.push({ label: t('trace.detail.sourceTitle'), value: item.sourceTitle });
        if (item.errorCode) entries.push({ label: t('trace.detail.errorCode'), value: item.errorCode, mono: true });
        const nodes = entries.map((entry, index) =>
          h(
            'div',
            { key: 'trace-detail-' + index, className: 'dsh-it-usage-detail-item' },
            h('span', { className: 'dsh-it-usage-detail-label' }, entry.label),
            h('span', { className: 'dsh-it-usage-detail-value' + (entry.mono ? ' dsh-it-usage-detail-value-mono' : '') }, entry.value),
          ),
        );
        const url = safeHttpUrl(item.sourceUrl);
        if (url) {
          nodes.push(
            h(
              'div',
              { key: 'trace-detail-url', className: 'dsh-it-usage-detail-item' },
              h('span', { className: 'dsh-it-usage-detail-label' }, t('trace.detail.sourceUrl')),
              h('a', { className: 'dsh-it-usage-detail-link', href: url, target: '_blank', rel: 'noreferrer noopener' }, url),
            ),
          );
        }
        if (item.sample) {
          nodes.push(
            h(
              'div',
              { key: 'trace-detail-sample', className: 'dsh-it-usage-detail-item dsh-it-usage-detail-full' },
              h('span', { className: 'dsh-it-usage-detail-label' }, t('trace.detail.sample')),
              h('pre', { className: 'dsh-it-usage-sample' }, item.sample),
            ),
          );
        }
        return h('div', { className: 'dsh-it-usage-row-detail' }, nodes);
      }

      /** One trace row plus its expandable detail. */
      function renderEventRow(item) {
        const kindKey = item.kind === 'lookup' ? 'usage.kind.lookup' : 'usage.kind.translate';
        const expanded = expandedId === item.id;
        const modelLabel = formatModelLabel(item.provider, item.model);
        const siteLabel = item.sourceTitle || item.site || t('trace.siteUnknown');
        const statusLabel = item.ok ? t('trace.ok') : item.errorCode || t('trace.error');
        const timeLabel = formatEventTime(item.at);
        const rowLabel =
          t('trace.rowLabel', { time: timeLabel, kind: t(kindKey), model: modelLabel, status: statusLabel }) +
          ' · ' +
          (expanded ? t('trace.collapse') : t('trace.expand'));
        return h(
          'div',
          { key: 'usage-event-' + item.id, className: 'dsh-it-usage-row-item' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-usage-row',
              'aria-expanded': expanded ? 'true' : 'false',
              'aria-label': rowLabel,
              title: expanded ? t('trace.collapse') : t('trace.expand'),
              onClick: () => toggleExpanded(item.id),
            },
            h('span', { className: 'dsh-it-usage-row-time' }, timeLabel),
            h('span', { className: 'dsh-it-usage-badge dsh-it-usage-badge-' + item.kind }, t(kindKey)),
            h('span', { className: 'dsh-it-usage-row-model', title: modelLabel }, modelLabel),
            h('span', { className: 'dsh-it-usage-row-site', title: siteLabel }, siteLabel),
            h(
              'span',
              { className: 'dsh-it-usage-row-meta' },
              t('trace.segmentsChars', { segments: formatExactNumber(item.segments), chars: formatExactNumber(item.chars) }),
            ),
            h(
              'span',
              {
                className: 'dsh-it-usage-row-tokens',
                title: t('trace.detail.tokens') + ': ' + formatExactNumber(item.inputTokens) + ' / ' + formatExactNumber(item.outputTokens),
              },
              t('trace.rowTokens', { input: formatCompactNumber(item.inputTokens), output: formatCompactNumber(item.outputTokens) }),
            ),
            h('span', { className: 'dsh-it-usage-row-latency', title: t('trace.detail.latency') }, formatDuration(item.latencyMs, t)),
            h(
              'span',
              { className: 'dsh-it-usage-row-status ' + (item.ok ? 'dsh-it-usage-row-status-ok' : 'dsh-it-usage-row-status-error') },
              statusLabel,
            ),
          ),
          expanded ? renderEventDetail(item) : null,
        );
      }

      /** i18n key for one Turn kind badge. */
      function turnKindKey(kind) {
        if (kind === 'lookup') return 'trace.kind.lookup';
        if (kind === 'mixed') return 'trace.kind.mixed';
        return 'trace.kind.translate';
      }

      /** i18n key for one Turn status badge. */
      function turnStatusKey(status) {
        if (status === 'partial') return 'trace.status.partial';
        if (status === 'error') return 'trace.status.error';
        return 'trace.status.ok';
      }

      /** i18n key for one display-mode badge ('' when the Host reported no mode). */
      function turnModeKey(mode) {
        if (mode === 'bilingual') return 'trace.mode.bilingual';
        if (mode === 'only') return 'trace.mode.only';
        if (mode === 'source') return 'trace.mode.source';
        return '';
      }

      /** Rounded badge shared by Turn headers and step rows. */
      function renderTraceBadge(className, text) {
        return h('span', { className: 'dsh-it-trace-badge' + (className ? ' ' + className : '') }, text);
      }

      /** Expanded Turn meta grid: time, model, languages, client, counts, cache, latency, URL. */
      function renderTurnMeta(turn) {
        const items = [
          { id: 'started', label: t('trace.turnMeta.startTime'), value: formatFullTime(turn.startedAt) || t('usage.noValue') },
          { id: 'model', label: t('trace.detail.model'), value: formatModelLabel(turn.provider, turn.model), mono: true },
          { id: 'target', label: t('trace.turnMeta.targetLanguage'), value: turn.targetLanguage || t('usage.noValue') },
          { id: 'client', label: t('trace.turnMeta.client'), value: turn.client || t('usage.noValue'), mono: true },
          { id: 'segments', label: t('trace.turnMeta.segments'), value: formatExactNumber(turn.segments) + ' / ' + formatExactNumber(turn.chars) },
          { id: 'tokens', label: t('trace.detail.tokens'), value: formatExactNumber(turn.inputTokens) + ' / ' + formatExactNumber(turn.outputTokens) },
          { id: 'cache', label: t('trace.turnMeta.cacheTokens'), value: formatExactNumber(turn.cacheReadTokens) + ' / ' + formatExactNumber(turn.cacheWriteTokens) },
          { id: 'latency', label: t('trace.turnMeta.avgLatency'), value: turn.avgLatencyMs > 0 ? formatDuration(turn.avgLatencyMs, t) : t('usage.noValue') },
          { id: 'requests', label: t('trace.turnMeta.requests'), value: formatExactNumber(turn.requests) + ' / ' + formatExactNumber(turn.cached) },
        ];
        const url = safeHttpUrl(turn.sourceUrl);
        if (url) items.push({ id: 'url', label: t('trace.turnMeta.sourceUrl'), value: url, link: url, full: true });
        return h(
          'div',
          { className: 'dsh-it-turn-meta' },
          items.map((item) =>
            h(
              'div',
              { key: 'turn-meta-' + item.id, className: 'dsh-it-turn-meta-item' + (item.full ? ' dsh-it-turn-meta-full' : '') },
              h('span', { className: 'dsh-it-turn-meta-label' }, item.label),
              item.link
                ? h('a', { className: 'dsh-it-turn-meta-link', href: item.link, target: '_blank', rel: 'noreferrer noopener' }, item.value)
                : h('span', { className: 'dsh-it-turn-meta-value' + (item.mono ? ' dsh-it-turn-meta-mono' : ''), title: item.value }, item.value),
            ),
          ),
        );
      }

      /** Expanded step detail grid: model, four token buckets, languages, retries. */
      function renderStepDetail(step, detailId, turn) {
        const items = [
          { id: 'model', label: t('trace.detail.model'), value: formatModelLabel(step.provider, step.model), mono: true },
          { id: 'kind', label: t('trace.detail.kind'), value: t(turnKindKey(step.kind)) },
          { id: 'tokens', label: t('trace.step.tokens'), value: formatExactNumber(step.inputTokens) + ' / ' + formatExactNumber(step.outputTokens) },
          { id: 'cache', label: t('trace.step.cacheTokens'), value: formatExactNumber(step.cacheReadTokens) + ' / ' + formatExactNumber(step.cacheWriteTokens) },
          { id: 'cached', label: t('trace.detail.cached'), value: step.cached ? t('trace.detail.yes') : t('trace.detail.no') },
          { id: 'retries', label: t('trace.detail.retries'), value: formatExactNumber(step.retries) },
          { id: 'latency', label: t('trace.detail.latency'), value: formatDuration(step.latencyMs, t) },
          { id: 'time', label: t('trace.detail.time'), value: formatFullTime(step.at) || t('usage.noValue') },
        ];
        const sourceLanguage = step.sourceLanguage || (turn ? turn.sourceLanguage : '');
        const targetLanguage = step.targetLanguage || (turn ? turn.targetLanguage : '');
        if (sourceLanguage || targetLanguage) {
          items.push({ id: 'languages', label: t('trace.step.languages'), value: (sourceLanguage || '?') + ' → ' + (targetLanguage || '?') });
        }
        if (step.errorCode) items.push({ id: 'error', label: t('trace.detail.errorCode'), value: step.errorCode, mono: true });
        return h(
          'div',
          { id: detailId, className: 'dsh-it-steps-detail' },
          items.map((item) =>
            h(
              'div',
              { key: 'step-detail-' + item.id, className: 'dsh-it-steps-detail-item' },
              h('span', { className: 'dsh-it-steps-detail-label' }, item.label),
              h('span', { className: 'dsh-it-steps-detail-value' + (item.mono ? ' dsh-it-steps-detail-mono' : ''), title: item.value }, item.value),
            ),
          ),
        );
      }

      /** Input → output sample preview shown below one step row. */
      function renderStepPreview(step) {
        if (!step.sample && !step.outputPreview) return null;
        const parts = [];
        if (step.sample) {
          parts.push(
            h(
              'span',
              { key: 'step-preview-input', className: 'dsh-it-steps-preview-part' },
              h('span', { className: 'dsh-it-steps-preview-label' }, t('trace.inputSample')),
              h('span', { className: 'dsh-it-steps-preview-text', title: step.sample }, step.sample),
            ),
          );
        }
        if (step.sample && step.outputPreview) {
          parts.push(h('span', { key: 'step-preview-arrow', className: 'dsh-it-steps-preview-arrow', 'aria-hidden': 'true' }, '→'));
        }
        if (step.outputPreview) {
          parts.push(
            h(
              'span',
              { key: 'step-preview-output', className: 'dsh-it-steps-preview-part' },
              h('span', { className: 'dsh-it-steps-preview-label' }, t('trace.outputSample')),
              h('span', { className: 'dsh-it-steps-preview-text', title: step.outputPreview }, step.outputPreview),
            ),
          );
        }
        return h('div', { className: 'dsh-it-steps-preview' }, parts);
      }

      /** One step row: summary button, sample preview, and optional expanded details. */
      function renderTurnStep(turn, step, index) {
        const stepNumber = step.stepIndex + 1;
        const stepKey = turn.id + '::' + String(step.stepIndex) + '::' + (step.id || String(index));
        const expanded = !!expandedSteps[stepKey];
        const detailId = 'dsh-it-step-detail-' + traceSafeId(turn.id) + '-' + String(step.stepIndex);
        const segmentsText = t('trace.segmentsChars', { segments: formatExactNumber(step.segments), chars: formatExactNumber(step.chars) });
        const tokensText = t('trace.rowTokens', { input: formatCompactNumber(step.inputTokens), output: formatCompactNumber(step.outputTokens) });
        const statusLabel = step.ok ? t('trace.status.ok') : step.errorCode || t('trace.status.error');
        const timeLabel = formatEventTime(step.at) || t('usage.noValue');
        const rowLabel =
          t('trace.stepAria', { step: t('trace.stepLabel', { index: stepNumber }), segments: segmentsText, tokens: tokensText, status: statusLabel }) +
          ' · ' +
          (expanded ? t('trace.collapse') : t('trace.expand'));
        return h(
          'li',
          { key: 'turn-step-' + stepKey, className: 'dsh-it-steps-item' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-steps-row',
              'aria-expanded': expanded ? 'true' : 'false',
              'aria-controls': detailId,
              'aria-label': rowLabel,
              onClick: () => toggleStep(stepKey),
            },
            h('span', { className: 'dsh-it-steps-seq' }, t('trace.stepLabel', { index: stepNumber })),
            h('span', { className: 'dsh-it-steps-time' }, timeLabel),
            renderTraceBadge('dsh-it-trace-badge-' + step.kind, t(turnKindKey(step.kind))),
            h('span', { className: 'dsh-it-steps-seg' }, segmentsText),
            h('span', { className: 'dsh-it-steps-tokens', title: t('trace.step.tokens') + ': ' + formatExactNumber(step.inputTokens) + ' / ' + formatExactNumber(step.outputTokens) }, tokensText),
            h('span', { className: 'dsh-it-steps-cache', title: t('trace.step.cacheTokens') }, t('trace.cacheRead') + ' ' + formatCompactNumber(step.cacheReadTokens)),
            h('span', { className: 'dsh-it-steps-latency', title: t('trace.detail.latency') }, formatDuration(step.latencyMs, t)),
            step.retries > 0 ? h('span', { className: 'dsh-it-steps-retries', title: t('trace.detail.retries') }, t('trace.detail.retries') + ' ' + formatExactNumber(step.retries)) : null,
            h('span', { className: 'dsh-it-steps-status ' + (step.ok ? 'dsh-it-steps-status-ok' : 'dsh-it-steps-status-error') }, statusLabel),
            h('span', { className: 'dsh-it-steps-chevron', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
          ),
          renderStepPreview(step),
          expanded ? renderStepDetail(step, detailId, turn) : null,
        );
      }

      /** One inline Turn card (legacy requests): summary header plus meta grid and steps. */
      function renderTurnCard(turn, index, total) {
        const expanded = !!expandedTurns[turn.id];
        const detailId = 'dsh-it-turn-detail-' + traceSafeId(turn.id);
        const totalTurns = typeof total === 'number' && total > 0 ? total : turns.length;
        const turnNumber = totalTurns - index;
        const stepsCount = turn.steps.length > 0 ? turn.steps.length : toFiniteNumber(turn.requests);
        const kindKey = turnKindKey(turn.kind);
        const modeKey = turnModeKey(turn.mode);
        const statusKey = turnStatusKey(turn.status);
        const modelLabel = formatModelLabel(turn.provider, turn.model);
        const siteLabel = turn.sourceTitle || turn.site || t('trace.siteUnknown');
        const durationLabel = turn.durationMs > 0 ? formatDuration(turn.durationMs, t) : t('usage.noValue');
        const stepsLabel = t('trace.steps', { count: formatExactNumber(stepsCount) });
        const tokensLabel = t('trace.rowTokens', { input: formatCompactNumber(turn.inputTokens), output: formatCompactNumber(turn.outputTokens) });
        const rowLabel =
          t('trace.turnAria', {
            turn: t('trace.turnLabel', { index: turnNumber }),
            kind: t(kindKey),
            steps: stepsLabel,
            status: t(statusKey),
          }) +
          ' · ' +
          (expanded ? t('trace.collapse') : t('trace.expand'));
        const cardClass = 'dsh-it-turn' + (turn.status === 'error' ? ' dsh-it-turn-error' : turn.status === 'partial' ? ' dsh-it-turn-partial' : '');
        return h(
          'div',
          { key: 'turn-' + turn.id, className: cardClass },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-turn-head',
              'aria-expanded': expanded ? 'true' : 'false',
              'aria-controls': detailId,
              'aria-label': rowLabel,
              onClick: () => toggleTurn(turn.id),
            },
            h(
              'span',
              { className: 'dsh-it-turn-head-main' },
              h('span', { className: 'dsh-it-turn-seq' }, t('trace.turnLabel', { index: turnNumber })),
              h('span', { className: 'dsh-it-turn-time', title: formatFullTime(turn.startedAt) }, formatEventTime(turn.startedAt) || t('usage.noValue')),
              renderTraceBadge('dsh-it-trace-badge-' + turn.kind, t(kindKey)),
              modeKey ? renderTraceBadge('dsh-it-trace-badge-mode', t(modeKey)) : null,
              h('span', { className: 'dsh-it-turn-site', title: siteLabel }, siteLabel),
            ),
            h(
              'span',
              { className: 'dsh-it-turn-head-meta' },
              h('span', { className: 'dsh-it-turn-model', title: modelLabel }, modelLabel),
              h('span', { className: 'dsh-it-turn-duration', title: t('trace.detail.latency') }, durationLabel),
              h('span', { className: 'dsh-it-turn-steps' }, stepsLabel),
              h(
                'span',
                { className: 'dsh-it-turn-tokens', title: t('trace.step.tokens') + ': ' + formatExactNumber(turn.inputTokens) + ' / ' + formatExactNumber(turn.outputTokens) },
                tokensLabel,
              ),
              turn.cacheReadTokens > 0
                ? h('span', { className: 'dsh-it-turn-cache', title: t('trace.turnMeta.cacheTokens') }, t('trace.cacheRead') + ' ' + formatCompactNumber(turn.cacheReadTokens))
                : null,
              renderTraceBadge('dsh-it-trace-badge-status-' + turn.status, t(statusKey)),
              h('span', { className: 'dsh-it-turn-chevron', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
            ),
          ),
          expanded
            ? h(
                'div',
                { id: detailId, className: 'dsh-it-turn-body' },
                renderTurnMeta(turn),
                turn.sessionId
                  ? h(
                      'div',
                      { className: 'dsh-it-turn-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-it-btn dsh-it-btn-primary',
                          'aria-label': t('trace.openConversationAria'),
                          onClick: () => openConversation(turn.sessionId),
                        },
                        t('trace.openConversation'),
                      ),
                      h('span', { className: 'dsh-it-turn-conversation-hint' }, t('trace.conversationHint')),
                    )
                  : null,
                turn.steps.length > 0
                  ? h('ol', { className: 'dsh-it-steps' }, turn.steps.map((step, stepOrder) => renderTurnStep(turn, step, stepOrder)))
                  : h('p', { className: 'dsh-it-hint' }, t('trace.stepsEmpty')),
              )
            : null,
        );
      }

      /** Group normalized turns into DSH-like conversation rows (keyed by sessionId). */
      function buildConversationRows(turnList) {
        const metaIndex = conversationMeta || {};
        const rows = [];
        const bySession = new Map();
        for (let index = 0; index < turnList.length; index += 1) {
          const turn = turnList[index];
          if (!turn.sessionId) continue;
          let row = bySession.get(turn.sessionId);
          if (!row) {
            row = {
              sessionId: turn.sessionId,
              turns: [],
              entries: [],
              title: '',
              live: false,
              provider: '',
              model: '',
              kind: 'translate',
              status: 'ok',
              firstAt: 0,
              lastAt: 0,
              okCount: 0,
              errorCount: 0,
              inputTokens: 0,
              outputTokens: 0,
            };
            bySession.set(turn.sessionId, row);
            rows.push(row);
          }
          row.turns.push(turn);
        }
        for (let index = 0; index < rows.length; index += 1) {
          const row = rows[index];
          row.turns.sort((left, right) => left.startedAt - right.startedAt);
          const kinds = {};
          let turnNumber = 0;
          for (let turnIndex = 0; turnIndex < row.turns.length; turnIndex += 1) {
            const turn = row.turns[turnIndex];
            row.provider = row.provider || turn.provider;
            row.model = row.model || turn.model;
            row.okCount += toFiniteNumber(turn.ok);
            row.errorCount += toFiniteNumber(turn.errors);
            row.inputTokens += toFiniteNumber(turn.inputTokens);
            row.outputTokens += toFiniteNumber(turn.outputTokens);
            if (turn.startedAt > 0 && (row.firstAt === 0 || turn.startedAt < row.firstAt)) row.firstAt = turn.startedAt;
            const turnEnd = toFiniteNumber(turn.endedAt) || turn.startedAt;
            if (turnEnd > row.lastAt) row.lastAt = turnEnd;
            kinds[turn.kind] = true;
            if (turn.steps.length > 0) {
              for (let stepIndex = 0; stepIndex < turn.steps.length; stepIndex += 1) {
                const step = turn.steps[stepIndex];
                turnNumber += 1;
                row.entries.push({
                  number: turnNumber,
                  at: step.at,
                  kind: step.kind,
                  inputTokens: step.inputTokens,
                  outputTokens: step.outputTokens,
                  latencyMs: step.latencyMs,
                  ok: step.ok,
                  errorCode: step.errorCode,
                });
              }
            } else {
              turnNumber += 1;
              row.entries.push({
                number: turnNumber,
                at: turn.startedAt,
                kind: turn.kind,
                inputTokens: turn.inputTokens,
                outputTokens: turn.outputTokens,
                latencyMs: turn.avgLatencyMs,
                ok: turn.errors === 0,
                errorCode: '',
              });
            }
          }
          row.kind = kinds.mixed || (kinds.lookup && kinds.translate) ? 'mixed' : kinds.lookup ? 'lookup' : 'translate';
          row.status = row.errorCount === 0 ? 'ok' : row.okCount > 0 ? 'partial' : 'error';
          const meta = metaIndex[row.sessionId];
          row.live = !!(meta && meta.live);
          const firstTurn = row.turns[0];
          row.title = (meta && meta.title) || (firstTurn && (firstTurn.sourceTitle || firstTurn.site)) || t('trace.conversation.titleFallback');
        }
        rows.sort((left, right) => right.lastAt - left.lastAt || right.firstAt - left.firstAt);
        return rows;
      }

      /** One conversation card: header with the native-trajectory action plus compact turn rows. */
      function renderConversationCard(row) {
        const expanded = !!expandedConversations[row.sessionId];
        const detailId = 'dsh-it-conversation-body-' + traceSafeId(row.sessionId);
        const statusKey = turnStatusKey(row.status);
        const kindKey = turnKindKey(row.kind);
        const modelLabel = formatModelLabel(row.provider, row.model);
        const firstTime = formatEventTime(row.firstAt) || t('usage.noValue');
        const turnsLabel = t('trace.conversation.turns', { count: formatExactNumber(row.entries.length) });
        const tokensLabel = t('trace.rowTokens', { input: formatCompactNumber(row.inputTokens), output: formatCompactNumber(row.outputTokens) });
        const tokensTitle = t('trace.step.tokens') + ': ' + formatExactNumber(row.inputTokens) + ' / ' + formatExactNumber(row.outputTokens);
        const canOpen = !!workspaceService && typeof workspaceService.openSession === 'function';
        const rowLabel =
          t('trace.conversation.groupAria', { title: row.title, turns: turnsLabel, status: t(statusKey) }) +
          (row.live ? ' · ' + t('trace.conversation.live') : '') +
          ' · ' +
          (expanded ? t('trace.collapse') : t('trace.expand'));
        const cardClass = 'dsh-it-conv' + (row.status === 'error' ? ' dsh-it-conv-error' : row.status === 'partial' ? ' dsh-it-conv-partial' : '');
        return h(
          'div',
          { className: cardClass },
          h(
            'div',
            { className: 'dsh-it-conv-head' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-it-conv-toggle',
                'aria-expanded': expanded ? 'true' : 'false',
                'aria-controls': detailId,
                'aria-label': rowLabel,
                onClick: () => toggleConversation(row.sessionId),
              },
              h(
                'span',
                { className: 'dsh-it-conv-head-main' },
                h('span', { className: 'dsh-it-conv-title', title: row.title }, row.title),
                renderTraceBadge('dsh-it-trace-badge-' + row.kind, t(kindKey)),
                row.live
                  ? h(
                      'span',
                      { className: 'dsh-it-conv-live', title: t('trace.conversation.live') },
                      h('span', { className: 'dsh-it-conv-live-dot', 'aria-hidden': 'true' }),
                      h('span', { className: 'dsh-it-conv-live-text' }, t('trace.conversation.live')),
                    )
                  : null,
                h('span', { className: 'dsh-it-conv-time', title: formatFullTime(row.firstAt) }, firstTime),
                h('span', { className: 'dsh-it-conv-model', title: modelLabel }, modelLabel),
                h('span', { className: 'dsh-it-conv-turns' }, turnsLabel),
                h('span', { className: 'dsh-it-conv-tokens', title: tokensTitle }, tokensLabel),
                renderTraceBadge('dsh-it-trace-badge-status-' + row.status, t(statusKey)),
                h('span', { className: 'dsh-it-conv-chevron', 'aria-hidden': 'true' }, expanded ? '▾' : '▸'),
              ),
            ),
            h(
              'div',
              { className: 'dsh-it-conv-actions' },
              canOpen
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-it-btn dsh-it-btn-primary dsh-it-conv-open',
                      'aria-label': t('trace.openConversationAria') + ' · ' + row.title,
                      onClick: () => openConversation(row.sessionId),
                    },
                    t('trace.openConversation'),
                  )
                : h('span', { className: 'dsh-it-conv-open-hint' }, t('trace.conversation.openUnavailable')),
            ),
          ),
          expanded
            ? h(
                'div',
                { id: detailId, className: 'dsh-it-conv-body' },
                row.entries.length > 0
                  ? h(
                      'ol',
                      { className: 'dsh-it-conv-turns' },
                      row.entries.map((entry) =>
                        h(
                          'li',
                          { key: 'conversation-turn-' + entry.number, className: 'dsh-it-conv-turn-item' },
                          h('span', { className: 'dsh-it-conv-turn-seq' }, t('trace.turnLabel', { index: entry.number })),
                          h('span', { className: 'dsh-it-conv-turn-time', title: formatFullTime(entry.at) }, formatEventTime(entry.at) || t('usage.noValue')),
                          renderTraceBadge('dsh-it-trace-badge-' + entry.kind, t(turnKindKey(entry.kind))),
                          h(
                            'span',
                            {
                              className: 'dsh-it-conv-turn-tokens',
                              title: t('trace.step.tokens') + ': ' + formatExactNumber(entry.inputTokens) + ' / ' + formatExactNumber(entry.outputTokens),
                            },
                            t('trace.rowTokens', { input: formatCompactNumber(entry.inputTokens), output: formatCompactNumber(entry.outputTokens) }),
                          ),
                          h('span', { className: 'dsh-it-conv-turn-latency', title: t('trace.detail.latency') }, formatDuration(entry.latencyMs, t)),
                          renderTraceBadge(
                            'dsh-it-trace-badge-status-' + (entry.ok ? 'ok' : 'error'),
                            entry.ok ? t('trace.status.ok') : entry.errorCode || t('trace.status.error'),
                          ),
                        ),
                      ),
                    )
                  : h('p', { className: 'dsh-it-hint' }, t('trace.conversation.emptyTurns')),
                h('p', { className: 'dsh-it-conv-native-hint' }, t('trace.conversation.nativeHint')),
              )
            : null,
        );
      }

      /** Collapsible group for requests without a DSH session (old ledger rows). */
      function renderLegacyGroup(legacyTurns) {
        if (legacyTurns.length === 0) return null;
        const bodyId = 'dsh-it-conv-legacy-body';
        return h(
          'div',
          { className: 'dsh-it-conv-legacy' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-it-conv-legacy-toggle',
              'aria-expanded': legacyGroupExpanded ? 'true' : 'false',
              'aria-controls': bodyId,
              onClick: toggleLegacyGroup,
            },
            h('span', { className: 'dsh-it-conv-legacy-title' }, t('trace.conversation.legacyTitle')),
            h('span', { className: 'dsh-it-conv-legacy-count' }, formatExactNumber(legacyTurns.length)),
            h('span', { className: 'dsh-it-conv-chevron', 'aria-hidden': 'true' }, legacyGroupExpanded ? '▾' : '▸'),
          ),
          legacyGroupExpanded
            ? h(
                'div',
                { id: bodyId, className: 'dsh-it-conv-legacy-body' },
                h('p', { className: 'dsh-it-hint' }, t('trace.conversation.legacyHint')),
                h('div', { className: 'dsh-it-turns-list' }, legacyTurns.map((turn, index) => renderTurnCard(turn, index, legacyTurns.length))),
              )
            : null,
        );
      }

      /** Conversation list with paging / empty / error states, then the legacy turn group. */
      function renderConversationTraces() {
        if (turnsPhase === 'error' && turns.length === 0) {
          return h(
            InlineAlert,
            { kind: 'error', title: t('trace.loadFailed'), action: retryButton(() => reloadTraces({ silent: false })) },
            describeError(turnsError, t),
          );
        }
        if (turnsPhase === 'loading' && turns.length === 0) return h(LoadingSkeleton, { label: t('common.loading') });
        if (turns.length === 0) {
          const baseEmpty = traceFilter === 'all';
          return h(
            EmptyState,
            { title: baseEmpty ? t('trace.empty') : t('trace.emptyFiltered') },
            baseEmpty ? t('trace.emptyHint') : t('trace.emptyFilteredHint'),
          );
        }
        const rows = buildConversationRows(turns);
        const legacyTurns = turns.filter((turn) => !turn.sessionId);
        return h(
          'div',
          { className: 'dsh-it-convs' },
          turnsPhase === 'error'
            ? h(
                InlineAlert,
                { kind: 'error', title: t('trace.loadFailed'), action: retryButton(() => reloadTraces({ silent: true })) },
                describeError(turnsError, t),
              )
            : null,
          rows.length > 0
            ? h(
                'ul',
                { className: 'dsh-it-conv-list', 'aria-label': t('trace.conversation.listLabel') },
                rows.map((row) => h('li', { key: 'conversation-' + row.sessionId, className: 'dsh-it-conv-item' }, renderConversationCard(row))),
              )
            : null,
          renderLegacyGroup(legacyTurns),
          loadMoreError
            ? h(
                InlineAlert,
                { kind: 'error', title: t('trace.loadMoreFailed'), action: retryButton(loadMoreTurns) },
                describeError(loadMoreError, t),
              )
            : null,
          turnsHasMore || loadingMore
            ? h(
                'div',
                { className: 'dsh-it-turn-loadmore' },
                h(
                  'button',
                  { type: 'button', className: 'dsh-it-btn dsh-it-turn-loadmore-btn', disabled: loadingMore, onClick: loadMoreTurns },
                  loadingMore ? t('trace.loadingMore') : t('trace.loadMore'),
                ),
              )
            : null,
        );
      }

      /** Legacy flat request list (Host with /usage but without GET /usage/turns). */
      function renderLegacyTraces() {
        const visibleEvents = events.filter((item) => {
          if (traceFilter === 'all') return true;
          if (traceFilter === 'error') return item.ok === false;
          return item.kind === traceFilter;
        });
        if (eventsPhase === 'error' && visibleEvents.length === 0) {
          return h(
            InlineAlert,
            { kind: 'error', title: t('trace.loadFailed'), action: retryButton(() => loadEvents({ silent: false })) },
            describeError(eventsError, t),
          );
        }
        if (eventsPhase === 'loading' && visibleEvents.length === 0) return h(LoadingSkeleton, { label: t('common.loading') });
        if (visibleEvents.length === 0) {
          const baseEmpty = events.length === 0;
          return h(
            EmptyState,
            { title: baseEmpty ? t('trace.empty') : t('trace.emptyFiltered') },
            baseEmpty ? t('trace.emptyHint') : t('trace.emptyFilteredHint'),
          );
        }
        return h(
          React.Fragment,
          null,
          eventsPhase === 'error'
            ? h(
                InlineAlert,
                { kind: 'error', title: t('trace.loadFailed'), action: retryButton(() => loadEvents({ silent: true })) },
                describeError(eventsError, t),
              )
            : null,
          h('div', { className: 'dsh-it-usage-list' }, visibleEvents.map((item) => renderEventRow(item))),
        );
      }

      /** Traces tab content: DSH-like Turn cards, legacy flat rows on old Hosts. */
      function renderTraces() {
        if (usagePhase === 'outdated') return renderOutdated();
        const filterOptions = ['all', 'translate', 'lookup', 'error'];
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dsh-it-usage-toolbar' },
            h(
              'div',
              { className: 'dsh-it-usage-filter-wrap' },
              h('label', { className: 'dsh-it-usage-toolbar-label', htmlFor: 'dsh-it-usage-trace-filter' }, t('trace.filterLabel')),
              h(
                'select',
                {
                  id: 'dsh-it-usage-trace-filter',
                  className: 'dsh-it-select dsh-it-usage-filter',
                  value: traceFilter,
                  disabled: clearing,
                  onChange: (event) => setTraceFilter(event && event.target && event.target.value ? event.target.value : 'all'),
                },
                filterOptions.map((id) => h('option', { key: 'trace-filter-' + id, value: id }, t('trace.filter.' + id))),
              ),
            ),
            h('span', { className: 'dsh-it-usage-toolbar-spacer' }),
            h('button', { type: 'button', className: 'dsh-it-btn', disabled: refreshing || clearing, onClick: refreshNow }, t('common.refresh')),
            h(
              'button',
              { type: 'button', className: 'dsh-it-btn dsh-it-btn-danger', disabled: clearing, onClick: requestClear },
              clearing ? t('common.loading') : t('trace.clear'),
            ),
          ),
          confirmClear
            ? h(
                'div',
                { className: 'dsh-it-usage-confirm' },
                h('p', { className: 'dsh-it-usage-confirm-text' }, t('trace.clearConfirmText')),
                h('button', { type: 'button', className: 'dsh-it-btn dsh-it-btn-danger', disabled: clearing, onClick: clearUsage }, clearing ? t('common.loading') : t('trace.clearConfirm')),
                h('button', { type: 'button', className: 'dsh-it-btn', disabled: clearing, onClick: cancelClear }, t('common.cancel')),
              )
            : null,
          clearNotice ? h(InlineAlert, { kind: clearNotice.kind === 'ok' ? 'ok' : 'error' }, clearNotice.text) : null,
          legacyTraces ? h(InlineAlert, { kind: 'warn' }, t('trace.legacy')) : null,
          legacyTraces ? renderLegacyTraces() : renderConversationTraces(),
        );
      }

      const tabs = [
        { id: 'overview', key: 'panel.tab.overview' },
        { id: 'traces', key: 'panel.tab.traces' },
        { id: 'settings', key: 'panel.tab.settings' },
        { id: 'wordbook', key: 'panel.tab.wordbook' },
      ];
      const todayChip = usage
        ? h(
            'span',
            {
              className: 'dsh-it-chip dsh-it-usage-today-chip',
              title: t('panel.todayTokensTitle', {
                input: formatExactNumber(usage.today.inputTokens),
                output: formatExactNumber(usage.today.outputTokens),
              }),
            },
            t('panel.todayTokens', { tokens: formatCompactNumber(usageTokenTotal(usage.today)) }),
          )
        : null;

      return h(
        'div',
        { className: 'dsh-it-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS_TEXT } }),
        h(ExtensionReminder),
        h(
          'div',
          { className: 'dsh-it-page-scroll' },
          h(
            'div',
            { className: 'dsh-it-root dsh-it-page-content' },
            h(
              'div',
              { className: 'dsh-it-page-heading' },
              h(
                'div',
                { className: 'dsh-it-page-heading-main' },
                h('h2', { className: 'dsh-it-title' }, t('panel.title')),
                h('p', { className: 'dsh-it-subtitle' }, t('panel.subtitle')),
              ),
              h(
                'div',
                { className: 'dsh-it-page-heading-actions' },
                h(
                  'span',
                  { className: 'dsh-it-chip dsh-it-usage-model-chip', title: t('panel.modelChipTitle') },
                  t('panel.modelChip', { model: model ? formatModelLabel(model.provider, model.model) : t('panel.modelEmpty') }),
                ),
                todayChip,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-it-btn dsh-it-usage-refresh',
                    'data-busy': refreshing ? 'true' : 'false',
                    'aria-label': t('common.refresh'),
                    disabled: refreshing,
                    onClick: refreshNow,
                  },
                  h('span', { className: 'dsh-it-usage-refresh-icon', 'aria-hidden': 'true' }, '↻'),
                  t('common.refresh'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dsh-it-tabbar', role: 'tablist', 'aria-label': t('panel.tabsLabel'), onKeyDown: onTabKeyDown },
              tabs.map((entry) =>
                h(
                  'button',
                  {
                    key: 'usage-tab-' + entry.id,
                    type: 'button',
                    role: 'tab',
                    id: 'dsh-it-usage-tab-' + entry.id,
                    'aria-selected': tab === entry.id ? 'true' : 'false',
                    'aria-controls': 'dsh-it-usage-panel-' + entry.id,
                    tabIndex: tab === entry.id ? 0 : -1,
                    className: 'dsh-it-tab',
                    onClick: () => selectTab(entry.id),
                  },
                  t(entry.key),
                ),
              ),
            ),
            h('span', { className: 'dsh-it-sr-only', role: 'status', 'aria-live': 'polite' }, liveMessage),
            h(
              'div',
              {
                id: 'dsh-it-usage-panel-overview',
                role: 'tabpanel',
                'aria-labelledby': 'dsh-it-usage-tab-overview',
                className: 'dsh-it-panel',
                hidden: tab !== 'overview',
                'aria-busy': refreshing || usagePhase === 'loading' ? 'true' : 'false',
              },
              renderOverview(),
            ),
            h(
              'div',
              {
                id: 'dsh-it-usage-panel-traces',
                role: 'tabpanel',
                'aria-labelledby': 'dsh-it-usage-tab-traces',
                className: 'dsh-it-panel',
                hidden: tab !== 'traces',
                'aria-busy': refreshing || eventsPhase === 'loading' || turnsPhase === 'loading' || loadingMore ? 'true' : 'false',
              },
              renderTraces(),
            ),
            h(
              'div',
              {
                id: 'dsh-it-usage-panel-settings',
                role: 'tabpanel',
                'aria-labelledby': 'dsh-it-usage-tab-settings',
                className: 'dsh-it-panel',
                hidden: tab !== 'settings',
              },
              mountedTabs.settings ? h(TranslationSettings) : null,
            ),
            h(
              'div',
              {
                id: 'dsh-it-usage-panel-wordbook',
                role: 'tabpanel',
                'aria-labelledby': 'dsh-it-usage-tab-wordbook',
                className: 'dsh-it-panel',
                hidden: tab !== 'wordbook',
              },
              mountedTabs.wordbook ? h(WordbookPage, { active: tab === 'wordbook' }) : null,
            ),
          ),
        ),
      );
    }
    // #endregion

    // #region section shell
    /** The settings.section entry point: title, tab bar, and both lazy tabs. */
    /** 悬浮球不展示域名：GET/POST /ball-sites 的查看、添加与移除。 */
    function BallSitesPage() {
      const t = useT();
      const [phase, setPhase] = useState('loading');
      const [loadError, setLoadError] = useState(null);
      const [reloadToken, setReloadToken] = useState(0);
      const [sites, setSites] = useState([]);
      const [domain, setDomain] = useState('');
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState(null);
      const mountedRef = useRef(true);
      const noticeTimerRef = useRef(null);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        };
      }, []);

      useEffect(() => {
        let cancelled = false;
        setPhase('loading');
        setLoadError(null);
        api
          .get('ball-sites')
          .then((data) => {
            if (cancelled || !mountedRef.current) return;
            setSites(normalizeSites(data && data.sites));
            setPhase('ready');
          })
          .catch((error) => {
            if (cancelled || !mountedRef.current) return;
            setPhase('error');
            setLoadError(error);
          });
        return () => {
          cancelled = true;
        };
      }, [reloadToken]);

      /** Unique normalized domain strings from an untrusted response. */
      function normalizeSites(list) {
        const result = [];
        if (!Array.isArray(list)) return result;
        for (let index = 0; index < list.length; index += 1) {
          const value = typeof list[index] === 'string' ? list[index].trim().toLowerCase() : '';
          if (value && result.indexOf(value) < 0) result.push(value);
        }
        return result;
      }

      /** Transient success/error notice. */
      function showNotice(kind, text) {
        if (!mountedRef.current) return;
        setNotice({ kind: kind, text: text });
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setNotice(null);
        }, 4000);
      }

      async function addDomain() {
        if (busy) return;
        const value = domain.trim();
        if (!value) {
          showNotice('error', t('ball.invalid'));
          return;
        }
        setBusy(true);
        try {
          const data = await api.post('ball-sites/add', { domain: value });
          if (!mountedRef.current) return;
          setSites(normalizeSites(data && data.sites));
          setDomain('');
          showNotice('ok', t('ball.added', { domain: value }));
        } catch (error) {
          if (mountedRef.current) showNotice('error', describeError(error, t));
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }

      async function removeDomain(site) {
        if (busy) return;
        setBusy(true);
        try {
          const data = await api.post('ball-sites/remove', { domain: site });
          if (!mountedRef.current) return;
          setSites(normalizeSites(data && data.sites));
          showNotice('ok', t('ball.removed', { domain: site }));
        } catch (error) {
          if (mountedRef.current) showNotice('error', describeError(error, t));
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      }

      if (phase === 'loading') {
        return h('div', { className: 'dsh-it-panel' }, h('section', { className: 'dsh-it-card' }, h(LoadingSkeleton, { label: t('common.loading') })));
      }
      if (phase === 'error') {
        return h(
          'div',
          { className: 'dsh-it-panel' },
          h(InlineAlert, {
            kind: 'error',
            title: t('ball.loadFailed'),
            action: h(
              'button',
              { type: 'button', className: 'dsh-it-btn', onClick: () => setReloadToken((token) => token + 1) },
              t('common.retry'),
            ),
          }, describeError(loadError, t)),
        );
      }

      return h(
        'div',
        { className: 'dsh-it-panel' },
        h(
          'section',
          { className: 'dsh-it-card', 'aria-labelledby': 'dsh-it-ball-heading' },
          h(
            'div',
            { className: 'dsh-it-card-header' },
            h('h3', { className: 'dsh-it-card-title', id: 'dsh-it-ball-heading' }, t('ball.title')),
            h('span', { className: 'dsh-it-chip' }, t('ball.count', { count: sites.length })),
          ),
          h('p', { className: 'dsh-it-hint' }, t('ball.hint')),
          h(
            'div',
            { className: 'dsh-it-domain-add' },
            h('input', {
              className: 'dsh-it-input',
              type: 'text',
              value: domain,
              placeholder: t('ball.placeholder'),
              'aria-label': t('ball.placeholder'),
              spellCheck: false,
              onChange: (event) => setDomain(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addDomain();
                }
              },
            }),
            h(
              'button',
              { type: 'button', className: 'dsh-it-btn dsh-it-btn-primary', disabled: busy, onClick: () => void addDomain() },
              t('ball.add'),
            ),
          ),
          notice ? h('p', { className: 'dsh-it-hint ' + (notice.kind === 'ok' ? 'dsh-it-hint-ok' : 'dsh-it-hint-error') }, notice.text) : null,
          sites.length === 0
            ? h(EmptyState, { title: t('ball.empty') }, t('ball.emptyHint'))
            : h(
                'ul',
                { className: 'dsh-it-domain-list' },
                sites.map((site) =>
                  h(
                    'li',
                    { key: 'ball-site-' + site, className: 'dsh-it-domain-item' },
                    h('span', { className: 'dsh-it-domain-name' }, site),
                    h(
                      'button',
                      { type: 'button', className: 'dsh-it-btn dsh-it-btn-ghost', disabled: busy, onClick: () => void removeDomain(site) },
                      t('ball.remove'),
                    ),
                  ),
                ),
              ),
        ),
      );
    }

    /** DSH 插件页扩展检测：未安装/未启用时弹出安装引导。 */
    function ExtensionReminder() {
      const t = useT();
      const [phase, setPhase] = useState('checking');
      const [version, setVersion] = useState('');
      const [notice, setNotice] = useState('');

      const EXTENSION_MODAL_CSS =
        '.dsh-it-ext-mask{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.5)}' +
        '.dsh-it-ext-modal{width:min(560px,100%);max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:14px;padding:20px;border-radius:14px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 18px 48px rgba(15,23,42,.28)}' +
        '.dsh-it-ext-title{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}' +
        '.dsh-it-ext-desc{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}' +
        '.dsh-it-ext-steps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}' +
        '.dsh-it-ext-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
        '.dsh-it-ext-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}';

      function detect() {
        try {
          const value = document.documentElement.getAttribute('data-dsh-it-extension');
          if (typeof value === 'string' && value.length > 0) return value;
          if (typeof window.__dshItExtensionVersion === 'string' && window.__dshItExtensionVersion.length > 0) return window.__dshItExtensionVersion;
        } catch (err) {
          /* ignore */
        }
        return '';
      }

      useEffect(() => {
        let cancelled = false;
        const initial = detect();
        if (initial) {
          setVersion(initial);
          setPhase('installed');
          return undefined;
        }
        const poll = setInterval(() => {
          const value = detect();
          if (value) {
            clearInterval(poll);
            if (!cancelled) {
              setVersion(value);
              setPhase('installed');
            }
          }
        }, 250);
        const timeout = setTimeout(() => {
          if (!cancelled) setPhase((current) => (current === 'checking' ? 'missing' : current));
        }, 1600);
        return () => {
          cancelled = true;
          clearInterval(poll);
          clearTimeout(timeout);
        };
      }, []);

      function recheck() {
        const value = detect();
        if (value) {
          setVersion(value);
          setNotice('');
          setPhase('installed');
        } else {
          setNotice(t('extension.recheckFailed'));
        }
      }

      if (phase !== 'missing') return null;
      return h(
        React.Fragment,
        null,
        h('style', { dangerouslySetInnerHTML: { __html: EXTENSION_MODAL_CSS } }),
        h(
          'div',
          { className: 'dsh-it-ext-mask', role: 'presentation' },
          h(
            'div',
            { className: 'dsh-it-ext-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsh-it-ext-title' },
            h('h3', { className: 'dsh-it-ext-title', id: 'dsh-it-ext-title' }, t('extension.title')),
            h('p', { className: 'dsh-it-ext-desc' }, t('extension.desc')),
            h(
              'ol',
              { className: 'dsh-it-ext-steps' },
              h('li', null, t('extension.step1')),
              h('li', null, t('extension.step2')),
              h('li', null, t('extension.step3')),
            ),
            notice ? h('p', { className: 'dsh-it-ext-notice', role: 'status' }, notice) : null,
            h(
              'div',
              { className: 'dsh-it-ext-actions' },
              h(
                'a',
                {
                  className: 'dsh-it-btn dsh-it-btn-primary',
                  href: 'https://github.com/sikasjc/dsh-web-translator/blob/main/dsh-web-translator-extension/README.md',
                  target: '_blank',
                  rel: 'noreferrer',
                },
                t('extension.openRepo'),
              ),
              h('button', { type: 'button', className: 'dsh-it-btn', onClick: recheck }, t('extension.recheck')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-it-btn dsh-it-btn-ghost',
                  onClick: () => setPhase('dismissed'),
                },
                t('extension.later'),
              ),
            ),
          ),
        ),
      );
    }

    function SettingsSection() {
      const t = useT();
      const layoutService = useLayoutService();
      const [tab, setTab] = useState('settings');
      const [wordbookMounted, setWordbookMounted] = useState(false);
      const [ballMounted, setBallMounted] = useState(false);

      // Retry the optional locale connection when the page is opened: this
      // covers a locale service that registered after this plugin applied.
      useEffect(() => {
        if (!localeRuntime.connected) connectLocale();
      }, []);

      /** Select one tab, mounting the wordbook on first visit. */
      function selectTab(nextTab) {
        setTab(nextTab);
        if (nextTab === 'wordbook') setWordbookMounted(true);
        if (nextTab === 'ball') setBallMounted(true);
      }

      /** Left/right arrows move between tabs. */
      function onTabKeyDown(event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const order = ['settings', 'wordbook', 'ball'];
        const index = order.indexOf(tab);
        const step = event.key === 'ArrowRight' ? 1 : order.length - 1;
        const nextTab = order[(index + step) % order.length];
        selectTab(nextTab);
        if (typeof document !== 'undefined') {
          const node = document.getElementById('dsh-it-tab-' + nextTab);
          if (node && typeof node.focus === 'function') node.focus();
        }
      }

      const tabs = [
        { id: 'settings', key: 'tabs.settings' },
        { id: 'wordbook', key: 'tabs.wordbook' },
        { id: 'ball', key: 'tabs.ball' },
      ];

      return h(
        'div',
        { className: 'dsh-it-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS_TEXT } }),
        h(ExtensionReminder),
        h(
          'div',
          { className: 'dsh-it-usage-hint-row' },
          h('span', { className: 'dsh-it-hint dsh-it-hint-strong' }, t('panel.hint')),
          layoutService && typeof layoutService.selectPanel === 'function'
            ? h('button', { type: 'button', className: 'dsh-it-btn', onClick: () => openStatsPanel() }, t('panel.openPanel'))
            : null,
        ),
        h(
          'div',
          { className: 'dsh-it-header' },
          h('h2', { className: 'dsh-it-title' }, t('title')),
          h('p', { className: 'dsh-it-subtitle' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'dsh-it-tabbar', role: 'tablist', 'aria-label': t('tabs.label'), onKeyDown: onTabKeyDown },
          tabs.map((entry) =>
            h(
              'button',
              {
                key: 'tab-' + entry.id,
                type: 'button',
                role: 'tab',
                id: 'dsh-it-tab-' + entry.id,
                'aria-selected': tab === entry.id ? 'true' : 'false',
                'aria-controls': 'dsh-it-panel-' + entry.id,
                tabIndex: tab === entry.id ? 0 : -1,
                className: 'dsh-it-tab',
                onClick: () => selectTab(entry.id),
              },
              t(entry.key),
            ),
          ),
        ),
        h(
          'div',
          {
            id: 'dsh-it-panel-settings',
            role: 'tabpanel',
            'aria-labelledby': 'dsh-it-tab-settings',
            className: 'dsh-it-panel',
            hidden: tab !== 'settings',
          },
          h(TranslationSettings),
        ),
        wordbookMounted
          ? h(
              'div',
              {
                id: 'dsh-it-panel-wordbook',
                role: 'tabpanel',
                'aria-labelledby': 'dsh-it-tab-wordbook',
                className: 'dsh-it-panel',
                hidden: tab !== 'wordbook',
              },
              h(WordbookPage, { active: tab === 'wordbook' }),
            )
          : null,
        ballMounted
          ? h(
              'div',
              {
                id: 'dsh-it-panel-ball',
                role: 'tabpanel',
                'aria-labelledby': 'dsh-it-tab-ball',
                className: 'dsh-it-panel',
                hidden: tab !== 'ball',
              },
              h(BallSitesPage),
            )
          : null,
      );
    }
    // #endregion

    // #region styles
    /** All component styles; colors come only from --dsw-alias-* theme tokens. */
    const CSS_TEXT = `
.dsh-it-root{display:flex;flex-direction:column;gap:18px;min-height:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsh-it-header{display:flex;flex-direction:column;gap:4px}
.dsh-it-title{margin:0;font-size:18px;line-height:26px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-it-subtitle{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-it-tabbar{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dsh-it-tab{appearance:none;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:22px;font-weight:500;padding:8px 14px;cursor:pointer;border-radius:8px 8px 0 0;transition:color .15s ease,background-color .15s ease}
.dsh-it-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dsh-it-tab[aria-selected="true"]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.dsh-it-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-it-panel{display:flex;flex-direction:column;gap:16px;min-width:0}
.dsh-it-panel[hidden]{display:none}
.dsh-it-card{display:flex;flex-direction:column;gap:12px;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px}
.dsh-it-domain-add{display:flex;align-items:center;gap:8px}
.dsh-it-domain-add .dsh-it-input{flex:1 1 auto}
.dsh-it-domain-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dsh-it-domain-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dsh-it-domain-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;overflow-wrap:anywhere}
.dsh-it-hint-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-it-hint-error{color:var(--dsw-alias-state-error-primary)}
.dsh-it-card-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsh-it-card-title{margin:0;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-it-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-hint-strong{color:var(--dsw-alias-label-primary)}
.dsh-it-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.dsh-it-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-it-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsh-it-input,.dsh-it-select,.dsh-it-textarea{box-sizing:border-box;width:100%;min-width:0;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px}
.dsh-it-select{cursor:pointer}
.dsh-it-textarea{resize:vertical;min-height:72px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:20px}
.dsh-it-input::placeholder,.dsh-it-textarea::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-it-input:focus-visible,.dsh-it-select:focus-visible,.dsh-it-textarea:focus-visible,.dsh-it-btn:focus-visible,.dsh-it-icon-btn:focus-visible,.dsh-it-tab:focus-visible,.dsh-it-grade:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-it-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-it-check-row{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-it-check-row input{width:15px;height:15px;margin:0;cursor:pointer}
.dsh-it-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:13px;line-height:20px;font-weight:500;border-radius:8px;padding:6px 14px;cursor:pointer;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsh-it-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-it-btn:disabled{opacity:.5;cursor:not-allowed}
.dsh-it-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dsh-it-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9}
.dsh-it-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:6px 8px}
.dsh-it-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-it-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-it-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:none;font-size:15px;line-height:1;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;padding:0}
.dsh-it-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.dsh-it-chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:18px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);white-space:nowrap}
.dsh-it-chip-dirty{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dsh-it-chip-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsh-it-alert{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0}
.dsh-it-alert-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-it-alert-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsh-it-alert-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsh-it-alert-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-it-alert-title{font-weight:600}
.dsh-it-skeleton{height:12px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);animation:dsh-it-pulse 1.2s ease-in-out infinite}
@keyframes dsh-it-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.dsh-it-skeleton-stack{display:flex;flex-direction:column;gap:10px;padding:8px 0}
.dsh-it-empty{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:36px 16px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px;color:var(--dsw-alias-label-secondary)}
.dsh-it-empty-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-it-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px}
.dsh-it-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-it-stat-value{font-size:18px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-it-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-list{display:flex;flex-direction:column;gap:8px}
.dsh-it-item{display:flex;flex-direction:column;gap:6px;min-width:0;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-it-item-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-it-word{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-it-phonetic{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-translation{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);flex:1 1 160px;min-width:0;overflow-wrap:anywhere}
.dsh-it-item-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-item-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dsh-it-note-form{display:flex;flex-direction:column;gap:8px}
.dsh-it-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-it-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;padding:1px 5px;margin:0 6px 0 0;border-radius:5px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsh-it-test-result{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);min-width:0}
.dsh-it-test-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-it-review{display:flex;flex-direction:column;gap:14px}
.dsh-it-review-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.dsh-it-progress{position:relative;flex:1 1 120px;min-width:120px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dsh-it-progress-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .2s ease}
.dsh-it-card-face{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:24px 16px;min-height:180px;cursor:pointer;user-select:none;box-sizing:border-box;border-radius:8px}
.dsh-it-card-face:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-review-word{font-size:30px;line-height:40px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-it-review-phonetic{font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dsh-it-review-context{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);max-width:520px;overflow-wrap:anywhere}
.dsh-it-review-answer{display:flex;flex-direction:column;gap:8px;width:100%;max-width:560px;margin:0 auto;text-align:left;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);box-sizing:border-box}
.dsh-it-review-translation{font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-it-meanings{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-it-meaning-pos{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-it-meaning-def{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-it-grades{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.dsh-it-grade{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:96px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dsh-it-grade:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-it-grade:disabled{opacity:.5;cursor:not-allowed}
.dsh-it-grade-label{font-size:13px;line-height:20px;font-weight:600}
.dsh-it-grade-key{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-it-shadowing{display:flex;flex-direction:column;gap:6px;align-items:center;width:100%;min-width:0}
.dsh-it-shadowing-row{display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap}
.dsh-it-shadowing-transcript{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;text-align:center;margin:0}
.dsh-it-shadowing-pass{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);font-weight:600;margin:0}
.dsh-it-shadowing-fail{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);font-weight:600;margin:0}
@media (prefers-reduced-motion:reduce){.dsh-it-skeleton{animation:none}.dsh-it-progress-fill{transition:none}}
/* ---- v3: left-toolbar token stats page ---- */
.dsh-it-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dsh-it-page{width:100%;min-width:0;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dsh-it-page-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.dsh-it-page-content{width:100%;max-width:1080px;margin:0 auto;box-sizing:border-box;padding:0 clamp(20px,4vw,48px) 48px}
.dsh-it-page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 20px;flex-wrap:wrap;padding-top:28px}
[data-platform=darwin] .dsh-it-page-heading{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.dsh-it-page-heading-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-it-page-heading-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-it-usage-model-chip{max-width:min(360px,100%);overflow:hidden;text-overflow:ellipsis}
.dsh-it-usage-today-chip{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dsh-it-usage-refresh{display:inline-flex;align-items:center;gap:6px}
.dsh-it-usage-refresh-icon{display:inline-block;line-height:1;transition:transform .2s ease}
.dsh-it-usage-refresh[data-busy="true"] .dsh-it-usage-refresh-icon{animation:dsh-it-spin .9s linear infinite}
@keyframes dsh-it-spin{to{transform:rotate(360deg)}}
.dsh-it-usage-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-it-usage-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px}
.dsh-it-usage-stat{display:flex;flex-direction:column;gap:2px;min-width:0;padding:12px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-it-usage-stat-value{font-size:18px;line-height:26px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dsh-it-usage-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-usage-empty-inline{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-bars{display:flex;align-items:flex-end;gap:6px;height:132px;padding-top:8px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.dsh-it-bars-col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px}
.dsh-it-bars-track{flex:1;width:100%;max-width:34px;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch;min-height:0}
.dsh-it-bars-seg{width:100%;flex:none}
.dsh-it-bars-seg-input{background:var(--dsw-alias-brand-primary)}
.dsh-it-bars-seg-output{background:var(--dsw-alias-state-success-primary)}
.dsh-it-bars-label{font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-bars-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-bars-dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:1px}
.dsh-it-bars-dot-input{background:var(--dsw-alias-brand-primary)}
.dsh-it-bars-dot-output{background:var(--dsw-alias-state-success-primary)}
.dsh-it-table-wrap{width:100%;min-width:0;overflow-x:auto}
.dsh-it-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px;min-width:560px}
.dsh-it-table th{text-align:left;font-weight:600;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsh-it-table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);vertical-align:top;overflow-wrap:anywhere}
.dsh-it-table tr:last-child td{border-bottom:none}
.dsh-it-table-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-it-table-model{font-weight:500;overflow-wrap:anywhere}
.dsh-it-table-provider{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-it-usage-kinds{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.dsh-it-usage-kind{display:flex;flex-direction:column;gap:4px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-it-usage-kind-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-it-usage-kind-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-it-usage-badge{display:inline-flex;align-items:center;font-size:11px;line-height:16px;font-weight:600;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-it-usage-badge-translate{color:var(--dsw-alias-brand-primary)}
.dsh-it-usage-badge-lookup{color:var(--dsw-alias-state-success-primary)}
.dsh-it-usage-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-it-usage-toolbar-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsh-it-usage-filter-wrap{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dsh-it-usage-filter{width:auto;min-width:132px}
.dsh-it-usage-toolbar-spacer{flex:1 1 auto}
.dsh-it-usage-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-base)}
.dsh-it-usage-confirm-text{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dsh-it-usage-list{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-it-usage-row-item{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-it-usage-row{display:flex;align-items:center;gap:10px;width:100%;min-width:0;flex-wrap:wrap;text-align:left;font:inherit;color:inherit;background:transparent;border:none;padding:10px 12px;cursor:pointer}
.dsh-it-usage-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-usage-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-it-usage-row[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-usage-row-time{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-it-usage-row-model{flex:0 1 auto;max-width:220px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-it-usage-row-site{flex:1 1 140px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-it-usage-row-meta{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-it-usage-row-tokens{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-it-usage-row-latency{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-it-usage-row-status{flex:none;font-size:11px;line-height:16px;font-weight:600;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsh-it-usage-row-status-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsh-it-usage-row-status-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-it-usage-row-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 16px;min-width:0;padding:12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-it-usage-detail-item{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-it-usage-detail-label{font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-it-usage-detail-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;min-width:0}
.dsh-it-usage-detail-value-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:18px}
.dsh-it-usage-detail-full{grid-column:1/-1}
.dsh-it-usage-detail-link{color:var(--dsw-alias-brand-primary);word-break:break-all}
.dsh-it-usage-sample{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-primary)}
/* ---- v4: DSH-like Turn / Steps trace view ---- */
.dsh-it-turns{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-it-turns-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-it-turn{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-it-turn-partial{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-it-turn-error{border-color:var(--dsw-alias-state-error-primary)}
.dsh-it-turn-head{display:flex;align-items:center;justify-content:space-between;gap:6px 14px;flex-wrap:wrap;width:100%;min-width:0;text-align:left;font:inherit;color:inherit;background:transparent;border:none;padding:10px 12px;cursor:pointer}
.dsh-it-turn-head:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-turn-head[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-turn-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-it-turn-head-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;flex:1 1 320px}
.dsh-it-turn-head-meta{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;min-width:0;justify-content:flex-end}
.dsh-it-turn-seq{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-turn-time{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-turn-site{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(360px,100%);min-width:0}
.dsh-it-turn-model{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.dsh-it-turn-duration,.dsh-it-turn-steps,.dsh-it-turn-cache{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-turn-tokens{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-turn-chevron{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-cache-card{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin-top:14px;padding:12px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-it-cache-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 360px}
.dsh-it-cache-title{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-it-cache-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-it-cache-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsh-it-cache-notice{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);overflow-wrap:anywhere}
.dsh-it-cache-notice-error{color:var(--dsw-alias-state-error-primary)}
@media (max-width:767px){.dsh-it-cache-actions{width:100%;justify-content:flex-start}}
.dsh-it-turn-body{display:flex;flex-direction:column;gap:14px;min-width:0;padding:12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-it-turn-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dsh-it-turn-conversation-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0;overflow-wrap:anywhere}
.dsh-it-turn-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px;min-width:0}
.dsh-it-turn-meta-item{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-it-turn-meta-full{grid-column:1/-1}
.dsh-it-turn-meta-label{font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-it-turn-meta-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;min-width:0}
.dsh-it-turn-meta-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:18px}
.dsh-it-turn-meta-link{font-size:12px;line-height:18px;color:var(--dsw-alias-brand-primary);word-break:break-all}
.dsh-it-trace-badge{display:inline-flex;align-items:center;font-size:11px;line-height:16px;font-weight:600;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-it-trace-badge-translate{color:var(--dsw-alias-brand-primary)}
.dsh-it-trace-badge-lookup{color:var(--dsw-alias-state-success-primary)}
.dsh-it-trace-badge-mixed{color:var(--dsw-alias-state-warn-primary)}
.dsh-it-trace-badge-mode{color:var(--dsw-alias-label-secondary)}
.dsh-it-trace-badge-status-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-it-trace-badge-status-partial{color:var(--dsw-alias-state-warn-primary)}
.dsh-it-trace-badge-status-error{color:var(--dsw-alias-state-error-primary)}
.dsh-it-steps{display:flex;flex-direction:column;gap:6px;min-width:0;margin:0;padding:0;list-style:none}
.dsh-it-steps-item{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-it-steps-row{display:flex;align-items:center;gap:10px;width:100%;min-width:0;flex-wrap:wrap;text-align:left;font:inherit;color:inherit;background:transparent;border:none;padding:8px 10px;cursor:pointer}
.dsh-it-steps-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-steps-row[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-steps-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-it-steps-seq{flex:none;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-steps-time{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-steps-seg{flex:1 1 120px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-it-steps-tokens{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-steps-cache,.dsh-it-steps-latency,.dsh-it-steps-retries{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-steps-status{flex:none;font-size:11px;line-height:16px;font-weight:600;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsh-it-steps-status-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsh-it-steps-status-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-it-steps-chevron{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-it-steps-preview{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-width:0;padding:0 10px 8px}
.dsh-it-steps-preview-part{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1 1 0}
.dsh-it-steps-preview-label{flex:none;font-size:10px;line-height:14px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-it-steps-preview-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsh-it-steps-preview-arrow{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsh-it-steps-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px 16px;min-width:0;padding:10px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-it-steps-detail-item{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-it-steps-detail-label{font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-it-steps-detail-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;min-width:0}
.dsh-it-steps-detail-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:18px}
.dsh-it-turn-loadmore{display:flex;justify-content:center;padding:4px 0 2px}
.dsh-it-turn-loadmore-btn{min-width:160px}
@media (max-width:767px){.dsh-it-turn-head-meta{justify-content:flex-start}.dsh-it-turn-model{max-width:150px}.dsh-it-turn-body{padding:10px}.dsh-it-steps-preview{flex-wrap:wrap;gap:4px}.dsh-it-steps-preview-part{flex-basis:100%}.dsh-it-steps-preview-arrow{display:none}}
/* ---- v5: conversation list (DSH session -> native trajectory) ---- */
.dsh-it-convs{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-it-conv-list{display:flex;flex-direction:column;gap:8px;min-width:0;margin:0;padding:0;list-style:none}
.dsh-it-conv-item{min-width:0}
.dsh-it-conv{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-it-conv-partial{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-it-conv-error{border-color:var(--dsw-alias-state-error-primary)}
.dsh-it-conv-head{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;min-width:0;padding:10px 12px}
.dsh-it-conv-toggle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 340px;min-width:0;text-align:left;font:inherit;color:inherit;background:transparent;border:none;padding:0;cursor:pointer}
.dsh-it-conv-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}
.dsh-it-conv-toggle:hover .dsh-it-conv-title{color:var(--dsw-alias-brand-primary)}
.dsh-it-conv-head-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-it-conv-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(420px,100%);min-width:0}
.dsh-it-conv-time,.dsh-it-conv-model,.dsh-it-conv-turns,.dsh-it-conv-tokens{font-size:12px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-conv-time{color:var(--dsw-alias-label-secondary)}
.dsh-it-conv-model{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;max-width:240px}
.dsh-it-conv-turns{color:var(--dsw-alias-label-secondary)}
.dsh-it-conv-tokens{color:var(--dsw-alias-label-primary)}
.dsh-it-conv-live{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-state-success-primary);white-space:nowrap}
.dsh-it-conv-live-dot{display:inline-block;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-success-primary);flex:none}
.dsh-it-conv-chevron{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-it-conv-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;min-width:0}
.dsh-it-conv-open{white-space:nowrap}
.dsh-it-conv-open-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);max-width:300px;overflow-wrap:anywhere}
.dsh-it-conv-body{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsh-it-conv-turns{display:flex;flex-direction:column;gap:4px;min-width:0;margin:0;padding:0;list-style:none}
.dsh-it-conv-turn-item{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-it-conv-turn-seq{flex:none;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-conv-turn-time{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-conv-turn-tokens{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-conv-turn-latency{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-it-conv-native-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-it-conv-legacy{display:flex;flex-direction:column;min-width:0;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsh-it-conv-legacy-toggle{display:flex;align-items:center;gap:8px;width:100%;min-width:0;text-align:left;font:inherit;color:inherit;background:transparent;border:none;padding:10px 12px;cursor:pointer}
.dsh-it-conv-legacy-toggle:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-it-conv-legacy-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-it-conv-legacy-title{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-it-conv-legacy-count{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsh-it-conv-legacy-body{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
@media (max-width:767px){.dsh-it-conv-title{max-width:100%}.dsh-it-conv-model{max-width:150px}.dsh-it-conv-actions{width:100%;justify-content:flex-start}.dsh-it-conv-open-hint{max-width:none}}
.dsh-it-usage-hint-row{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;padding:10px 12px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsh-it-usage-hint-row .dsh-it-hint{flex:1 1 220px;min-width:0}
@media (max-width:767px){.dsh-it-page-content{padding-left:20px;padding-right:20px}.dsh-it-usage-row-model{max-width:120px}.dsh-it-usage-row-site{flex-basis:100%;order:2}.dsh-it-bars{gap:4px}.dsh-it-bars-label{font-size:9px}}
@media (prefers-reduced-motion:reduce){.dsh-it-usage-refresh-icon{transition:none}.dsh-it-usage-refresh[data-busy="true"] .dsh-it-usage-refresh-icon{animation:none}}
`;
    // #endregion

    // #region registration
    /** Required services (cordis fiber inject). */
    const inject = ['slots'];

    /**
     * Register the locale dictionaries, the Settings section, and the
     * left-toolbar page (`main` key + `sidebar.panellist` row).
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      localeRuntime.ctx = ctx;
      connectLocale();
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => disconnectLocale, 'dsh-web-translator: locale dictionaries');
      }
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'immersive-translate',
            order: SECTION_ORDER,
            label: () => translate('title'),
          },
          SettingsSection,
        ),
      );

      // Optional uiWorkspace service: the 轨迹 tab opens native DSH conversation
      // trajectories for translation turns; without it the inline view stays.
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['uiWorkspace'], (scoped) => {
            workspaceBridge.service = scoped && scoped.uiWorkspace ? scoped.uiWorkspace : null;
            notifyWorkspaceService();
          });
        } catch (error) {
          workspaceBridge.service = null;
        }
      }

      // Optional layout service: only the Settings hint row uses it, so a Host
      // without ctx.layout keeps the plain settings page.
      if (typeof ctx.inject === 'function') {
        try {
          ctx.inject(['layout'], (scoped) => {
            layoutBridge.service = scoped && scoped.layout ? scoped.layout : null;
            notifyLayoutService();
          });
        } catch (error) {
          layoutBridge.service = null;
        }
      }

      // Left-toolbar page: `main` occupant keyed by PANEL_ID and the matching
      // sidebar.panellist row (same id, so the sidebar selects this panel).
      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              label: () => translate('panel.title'),
            },
            ImmersiveTranslatePage,
          ),
        );
      } catch (error) {
        /* older Host without the main slot: keep the settings section working */
      }
      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => translate('panel.title'),
            },
            (owner) =>
              h(SidebarPanelIcon, {
                size: (owner && owner.size) || 16,
                active: !!(owner && owner.active),
              }),
          ),
        );
      } catch (error) {
        /* older Host without the panel list: keep the settings section working */
      }
    }
    // #endregion

    return { inject: inject, apply: apply };
  },
});
