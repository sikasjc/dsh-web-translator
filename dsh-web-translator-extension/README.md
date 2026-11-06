# dsh翻译（dsh-web-translator）— Chrome / Edge MV3 扩展

在任意真实网页上做**网页翻译**（原文 / 双语对照 / 仅译文；正文块级对照 + 导航/标签/页脚/按钮行内对照）、**右键翻译**、**划词 / 双击 / 自定义快捷键翻译（默认关闭）**、**加入单词本**、
以及发音播放，并在浮窗/查词卡上展示 **token 消耗**（本页实时累加 + 今日累计）。翻译由本机 **DSH**（DeepSeek Harness）插件 `@local/dsh-web-translator` 提供，
使用你在 DSH 中配置的模型（模型、推理强度、提示词都在 DSH 设置页里改），扩展本身**不直连模型、不保存密钥**。

> 本目录只包含浏览器扩展；DSH 插件在 `../dsh-web-translator/`，接口契约见该目录的 `DESIGN.md`（v2 §5 / §7 / §8）。

---

## 1. 目录与文件

```
dsh-web-translator-extension/
├── manifest.json        # MV3 清单：storage/activeTab/scripting/contextMenus + DSH 127.0.0.1:3080 host_permissions
├── background.js        # Service Worker（module）：唯一出网侧，RPC / 超时 / 错误标准化 / toggle / 打开选项页
├── content.js           # 页面内经典脚本：Shadow DOM UI、段落抽取、并发翻译、注入与三模式、划词卡
├── options.html / options.js  # 扩展选项页：DSH 地址、目标语言、默认模式、自动翻译、界面语言、测试连接、只读模型
├── icons/               # icon16/32/48/128.png（由 tools/make-icons.mjs 生成）
├── tools/make-icons.mjs # 零依赖图标生成器（node:zlib 手写 PNG，4x 超采样抗锯齿）
├── tools/verify.mjs     # 静态校验：语法/manifest/契约常量/禁止模式/文案 key/PNG 尺寸
├── tools/e2e-chrome.mjs # 可选 E2E：headless Chrome + mock DSH API 真实驱动翻译/模式/查词/还原
├── tools/debug-layout.mjs # 布局诊断：加载真实 URL，输出翻译前后布局指标与截图（排查站点排版问题）
└── README.md            # 本文件
```

扩展**不**申请 `webRequest` / `cookies` / `tabs` / `<all_urls>` host 权限；页面代码不注入远程脚本；
content ↔ background 之间只传文本 RPC；所有 HTTP 请求都由 `background.js` 发往本机 DSH。

---

## 2. 前置条件

1. DSH Web 正在运行：默认 `http://127.0.0.1:3080`（本扩展默认地址）。
2. DSH 中已安装并启用插件 **dsh翻译**（`@local/dsh-web-translator`），
   且至少配置好一个可用模型（当前 profile 默认为 `modelhub / deepseek-flash`）。
   插件安装后，本地 API 前缀为 `/dsh-immersive/api/`。
3. Chrome / Edge 较新版本（MV3、`chrome.storage`/`scripting` 的 Promise 版本均可，建议 Chrome 110+ / Edge 110+）。

验证 DSH 侧是否就绪（终端）：

```bash
curl -s http://127.0.0.1:3080/dsh-immersive/api/health
```

返回 `{"ok":true,...}` 即正常；404 说明 DSH 插件未安装/未启用。

---

## 3. 安装（加载已解压扩展）

### Chrome

1. 打开 `chrome://extensions`。
2. 右上角打开 **开发者模式 / Developer mode**。
3. 点击 **加载已解压的扩展程序 / Load unpacked**，选择本目录 `dsh-web-translator-extension/`（含 `manifest.json` 的那一层）。
4. 工具栏出现扩展图标（可固定）；打开/刷新任意网页后生效。

### Edge

1. 打开 `edge://extensions`。
2. 左侧/右下打开 **开发人员模式 / Developer mode**。
3. 点击 **加载解压缩的扩展 / Load unpacked**，选择同一目录。

> 修改扩展文件后，需要回到扩展管理页点该扩展卡片上的「刷新 ↻」（或删掉重装），然后**刷新目标网页**，
> 因为 content script 已注入旧实例不会自动更新。

### 重新生成图标（可选）

```bash
cd dsh-web-translator-extension
node tools/make-icons.mjs   # 生成 icons/icon{16,32,48,128}.png
```

---

## 4. 使用说明

### 4.1 打开面板

三种方式任选：

- 点击工具栏中的扩展图标：**只打开/收起面板，不会触发翻译**；
- 点击网页右下角的悬浮球「译」：**左键**直接按当前显示模式（仅译文/双语对照，原文模式视为双语）开始翻译，翻译中再点停止、已翻译再点还原；**右键**打开功能面板；
- 网页内按快捷键 **Alt+T**（可在 `chrome://extensions/shortcuts` 改键）：切换翻译（未翻译 → 开始；翻译中 → 停止；已有译文 → 还原）；
- 在页面任意位置**点鼠标右键** →「dsh翻译」→ **原文 / 译文 / 双语对照**（选择译文或双语对照时，未翻译会自动开始翻译）。

翻译只在面板点「翻译此页 / 重新翻译」、右键菜单明确选择译文/双语、或使用快捷键时触发；点击图标/悬浮球本身不会触发。点击「翻译此页 / 重新翻译」后**面板自动收起，只保留悬浮球**，点悬浮球可再次展开查看进度与状态。

### 4.2 面板功能

| 控件 | 说明 |
|---|---|
| 原文 / 双语对照 / 仅译文 | 显示模式。切换**只改页面属性、不会重新请求翻译**；也可用右键菜单「dsh翻译」切换 |
| 目标语言 | 12 种：简体中文（默认）、繁體中文、English、日本語、한국어、Français、Deutsch、Español、Русский、Português、Italiano、العربية；改动在**下一次翻译**生效 |
| 模型 | 只读，来自 DSH `GET /settings` 的当前生效模型（provider/model/推理强度） |
| 本页消耗 | 本次翻译会话累计的输入/输出 tokens（悬停显示请求数与缓存命中数）；每次 `translate` 响应实时累加，未开始翻译时显示「—」 |
| 今日累计 | 当天全站累计 tokens，来自 DSH 插件的 `GET /usage` → `usage.today`；打开面板时刷新（节流 60s）；旧版插件无该接口时整行隐藏 |
| 翻译此页 / 重新翻译 | 抽取页面段落 → 默认**按屏触发**：把当前屏幕（视口 + 预加载）一次性入队，滚动停稳后再补翻新屏幕 → 以 ≤10 段、≤1600 字符分组、并发 2 调 DSH `POST /translate` → 边到边注入译文；选项页可切换「按块懒加载（省 token）」 |
| 停止 | 中止未完成队列，**保留已译内容**（不再接受在途结果） |
| 还原 | 移除全部注入的译文节点、`data-dsh-it` 标记、页面级样式与 observer，恢复原始 DOM |
| 进度 | 已处理段落 / 全页候选段落；失败段落也会计入。滚动触发的新段落会继续累加已处理数 |
| 状态/错误行 | 所有 RPC 失败、超时、抽取为空、DSH 未启动等都会显示在这里，不会打断页面 |
| 设置 | 打开扩展选项页 |
| 隐私提示 | 明示「译文由你在 DSH 中配置的模型生成」及文本发送路径 |

翻译失败的段落会插入红色虚线的占位（`翻译失败：…（点击重试）`），点击即可单段重试。

**排版规则（V1.5，可读性优先、无需配置）**：

- **标题 / 标签 / 按钮 / 导航 / 页脚 / 元信息行**：译文**行内紧跟原文**显示（连续文本），随容器宽度自然折行；
- **正文**（`p` / `blockquote` / `figcaption` / 表格单元格等）：译文另起一行放在原文**下方**；
- 译文与原文**同样式**：复制 computed 字号/字重/字体/颜色/行高/对齐/背景色/圆角等（标题、标签 pill、链接按钮均与原文一致）；**窄容器 + `margin:auto` 居中的正文块**，译文盒子也保持同样宽度并水平居中；
- **正文列表项**（`li`，正文区域且文本 ≥24 字符）：整项译文作为块级译文注入 `li` **内部**，不新增条目、不复制编号/子弹，保留缩进；导航/页脚/标签云等短 `li`（chrome 区域或 <24 字符）继续行内译文；折叠的 `<details>` 内容在展开后重新翻译；**结构化表格单元格**（`TD/TH` 内含 `dl/ul/ol/p/div/table` 等）不整格合并翻译，交给内部段落/链接逐条翻译（如 go.dev 的 TOC）；
- **紧凑导航/控件**：header/nav 等 chrome 区域，以及 flex/grid 工具条、tab bar 里的短标签（GitHub 文件页的 Preview/Code 等），行内译文若被挤到换行，会自动改为宿主内的小字块级译注（0.8em，原文保持一行），避免拆词和横向溢出；React/异步布局在注入后才挤窄的，会在 150ms/600ms 复检后补上；未折行的短标签仍保持行内双语；
- **相同译文跳过**：译文与原文忽略大小写/空白/标点后相同（专有名词、缩写、用户名、文件名等）时不再注入译文，避免 `ARM ARM`、`Patreon Patreon` 这类重复；
- **长段落**：正文单段上限 **4000 字符**（原 800），长段落仍按块级翻译在下方，不再退化成行内碎片；超过 4000 字符的极端段落不按块级翻译。

**段落内换行（自动处理，无需配置）**：抽取时把 `<br>`/`<wbr>`、HTML 格式化换行、连续空白、NBSP 统一还原为空格再发给模型，让模型看到完整句子；模型返回的段落译文不人为断行，交给浏览器按容器宽度自然折行。

**按屏触发（默认，v1.14.0）**：不会一次性翻译整页。开始翻译时把当前**屏幕**（视口 + 预加载区）一次性入队并立即发送，整屏按 ≤10 段 / ≤1600 字符的批次并发翻译；滚动/缩放**停稳约 140ms 后**才扫描并补翻新屏幕，**快速连续滚动期间不翻译中间屏幕**（避免无效请求和重复的固定提示词）。滚动后新增/异步渲染的内容会在停稳扫描时补上；滚不到的段落不会产生模型请求，可随时「停止」保留已译内容。

**按块懒加载（省 token，选项）**：选项页「调度方式」切到「按块懒加载」后恢复逐块模式——内容块一进入视口就入队，并由**微批合并**（约 180ms 静默窗口、最多等 400ms；达到约 3 段 / 400 字符或硬上限立即发送）合并成更少的请求，最省 token；preload 设置同样作用于 IntersectionObserver 的预载范围。

**预加载（选项，默认一屏）**：`预加载` 决定当前视口下方额外翻译多少 —— `不预加载 / 半屏 / 一屏（默认）`；两种调度模式都生效，选项在下一次翻译时生效。

**语言一致检测**：读取页面 `<html lang>` / `content-language` / `og:locale`，与目标语言一致时**不发起翻译请求**，在悬浮球上方浮出提示（如「页面语言（en）与目标语言（English）一致，未翻译」）；默认**同时隐藏悬浮球**（选项页「页面语言与目标语言一致时隐藏悬浮球」可关闭，默认开启）；`en` 与 `en-US` 视为一致，`zh-CN` 与 `zh-TW` 视为不一致。

**悬浮球**：右下角「译」可以**拖动**到任意位置（位置保存在 `chrome.storage.local.ballPosition`，窗口缩放时自动夹在视口内），拖动不会误触翻译/面板；左键快速翻译（按当前模式，再点停止/还原），**翻译中球内显示百分比、外圈环形进度（准备阶段显示 `…`），完成/停止后恢复「译」**；右键打开功能面板；面板底部有「**隐藏悬浮球**」，右键菜单「dsh翻译」里同时提供「**显示悬浮球 / 隐藏悬浮球**」两项，选项页也有「显示悬浮球」开关。

**按域名隐藏悬浮球**：面板底部和右键菜单都有「**当前域名不展示悬浮球**」；添加后该域名不再显示悬浮球（刷新后仍生效）。可在 **DSH → 设置 → dsh翻译 → 悬浮球** 里查看隐藏的域名列表并移除/手动添加。

**划词 / 双击 / 快捷键翻译**（三个开关均**默认关闭**，可在选项页开启）：

- **划词翻译**：选中 1~500 字符后弹出翻译卡（原文/译文/音标/词典/发音/加入单词本）；
- **双击翻译**：双击单词或短句弹出同一张翻译卡；
- **快捷键翻译**：默认快捷键 **Command+K**（Mac）/ **Ctrl+K**（其他平台），可在 `chrome://extensions/shortcuts` 自定义；有选区时翻译选区，无选区时等同 Alt+T 翻译/停止/还原整页。关闭开关时按快捷键只提示"未启用"，不会翻译。

**跟随翻译**（选项默认开启，可关闭）：在页面 A 上成功开始翻译后，点击链接打开的页面 B（同标签跳转或新标签）会自动开始翻译，无需再点；自动翻译时悬浮球上方会浮出「跟随翻译：本页已自动翻译」提示。点「还原」会结束当前标签的跟随；关闭选项页「跟随翻译」后，之后打开的页面不再自动翻译。

> 注意：更新/重载扩展后，**已经打开的页面仍运行旧 content script**，需要刷新页面后再翻译 A，跟随才会生效。

### 4.3 划词 / 双击 / 快捷键翻译（默认关闭）

- 先在选项页开启对应的「划词翻译」/「双击翻译」/「快捷键翻译」开关（默认都关闭）。
- 在页面中选中 **1~500 字符** 的文本，或在单词上**双击**；按 **Command+K / Ctrl+K**（可在浏览器快捷键页修改）翻译选区或整页。
- 弹出查词卡：原文、译文、音标、词典释义（英文单词查 `dictionaryapi.dev`，失败静默降级）、🔊 发音、加入单词本。
- 发音优先使用词典 `audio` URL，否则用浏览器 `speechSynthesis`（语言按文本脚本自动判定）。
- 「加入单词本」仅对**单个英文单词**或 **1~4 个汉字**可用；成功后按钮变为「已加入」。
  单词本数据只经本地 API 传给 DSH（`POST /wordbook/add`），不写 `chrome.storage`、不打日志。
- 点击卡片外部 / 按 Esc / 滚动页面会关闭卡片；卡片位置按视口坐标自动翻转、夹取边界。

### 4.4 选项页

右键扩展图标 →「选项」，或 DSH 未打开时从面板「设置」进入。可设置：

- **DSH 地址**（默认 `http://127.0.0.1:3080`；仅 `127.0.0.1:3080` / `localhost:3080` 在 host_permissions 内）；
- **目标语言**（12 项）、**默认显示模式**（原文 / 双语 / 仅译文）、**调度方式**（按屏触发（默认）/ 按块懒加载（省 token））、**预加载**（不预加载 / 半屏 / 一屏（默认））、**自动翻译**（默认关闭）、**划词翻译 / 双击翻译 / 快捷键翻译**（均默认关闭；快捷键在 `chrome://extensions/shortcuts` 自定义，默认 Command+K / Ctrl+K）、**跟随翻译**（默认开启）、**显示悬浮球**（默认开启；也可拖动/隐藏）、**语言一致时隐藏悬浮球**（默认开启）、**界面语言**（中文 / English）；
- **测试连接**：先保存再 `GET /health`，显示 DSH 版本、运行时长、模型数量；
- **读取当前模型**：`GET /settings` 只读回显 provider / model / 推理强度 / DSH 目标语言 / 配置来源；
  模型与提示词的编辑入口在 **DSH → 设置 → dsh翻译**（单一权威源，扩展不保存提示词）。

保存写入 `chrome.storage.local`：`dshBaseUrl / targetLanguage / mode / scheduleMode / preload / autoTranslate / selectionTranslate / doubleClickTranslate / shortcutTranslate / followTranslation / showFloatingBall / hideBallSameLanguage / ballPosition / uiLang`。

### 4.5 自动翻译

选项页开启后，每个页面加载（`document_idle`）约 1.2s 后自动开始翻译首屏，不自动展开面板；
关闭（默认）时只显示悬浮球，手动触发。

### 4.6 SPA 页面

页面通过 `popstate` / 地址变化（含 `pushState` 轮询检测）跳转后，面板状态行提示
「页面已跳转，请重新点击翻译」，同时**清零「本页消耗」**。V1 不会自动翻译新路由；`scanAgain()` 已预留给后续 MutationObserver 增量扫描。

### 4.7 Token 消耗展示

浮窗在「模型」行下方新增两行，查词卡新增一行；全部由 DSH 插件自己记账（扩展不落盘、不打日志）：

- **本页消耗**：`输入 X · 输出 Y`。每次 `POST /translate` 成功后读取响应里的
  `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` 并累加（缺失/非法按 0）；
  每次请求计 1 次、`cached === true` 时缓存命中 +1；悬停显示 `请求数 N · 缓存命中 M`。
  **新任务开始（翻译此页/重新翻译）、「还原」、页面跳转时清零**；未开始翻译显示「—」。
- **今日累计**：`X tokens`（= `inputTokens + outputTokens`），来自 DSH token 账本
  `GET /dsh-immersive/api/usage?days=2` 的 `usage.today`；**打开面板时刷新、节流 60s**；
  接口 404（旧版 Host）或任意失败时**静默隐藏该行**，翻译/查词/状态行不受影响；悬停显示精确输入/输出/请求数。
- **翻译完成状态行**：有 usage 时用 `statusDoneTokens`（`翻译完成 · 本页消耗 N tokens。`），
  没有 usage 时回退原有 `statusDone`（`翻译完成。`）。
- **查词卡**：`POST /lookup` 响应含 `usage` 时，在操作按钮下方显示小字
  `本次查询 输入 X · 输出 Y tokens`（新 i18n key `cardTokens`）；无 `usage` 时不显示。
- **统计口径与 DSH 插件一致**（见 `../dsh-web-translator/DESIGN-TOKEN-USAGE.md` §2）：
  cached 请求 tokens 记 0 但计入请求数/缓存命中；错误请求不累加 tokens；`totalTokens = 输入 + 输出`（派生，不落盘）。
- **i18n**：新增 `tokensPage / tokensToday / tokensInput / tokensOutput / tokensRequests / tokensCache /
  tokensUnit / statusDoneTokens / cardTokens`，中英文字典齐全，切换界面语言立即生效。
- **版本**：token 展示自扩展 v1.3.1 起提供（当前版本以 `manifest.json` 为准）；协议层仅新增 `usage: 'GET'` 白名单路由。

### 4.8 轨迹（Turn）

发往本机 DSH 的每次模型请求都带 **Turn 身份**，供 DSH 插件把扁平事件聚合成 DSH 风格的「轨迹」视图——**一次用户动作 = 一个 Turn，内部批次 = Steps**：

- **一次翻译动作 = 一个 Turn**：点「翻译此页 / 重新翻译 / 自动翻译」后，本次 run 内所有批次（含滚动懒加载继续的批次）
  共用同一个 `turnId`（`tr_…`）；每个批次一个 `stepIndex`，从 0 起严格递增；`mode` 为该请求时的显示模式（`bilingual` / `only` / `source`）。
- **一次查词 = 一个单步 Turn**：每次划词 / 双击 / 右键「翻译选中文本」打开查词卡都会生成新的 `turnId`（`lk_…`），`stepIndex = 0`。
- **Turn 的结束**：完成、停止、还原、页面跳转都会结束当前 Turn（之后的单段重试视为新的 1 步 Turn，不会并进旧 Turn）。
- **兼容性**：`turnId`（≤64 字符）、`stepIndex`（0~10000）、`mode`（≤16 字符）都是可选新增字段；旧版 Host 忽略它们时翻译/查词照常工作。
  扩展侧只在内存中生成，不落盘、不打日志，也不改变任何既有请求字段。

---

## 5. 与 DSH 的接口（实际调用）

所有请求由 `background.js` 发出：
`base + /dsh-immersive/api/ + method`，`base` 读取 `chrome.storage.local.dshBaseUrl`（默认 `http://127.0.0.1:3080`），
超时 **120s**（`AbortController`），错误统一为 `{ code, message }`。

| 方法 | HTTP | 用途 |
|---|---|---|
| `health` | GET | 翻译前预检 DSH 是否在线 |
| `settings` | GET | 面板「当前模型」只读展示；目标语言兜底 |
| `usage` | GET | `{days}` → `{usage:{today, totals, days, …}}`；浮窗「今日累计」。旧版插件返回 404 时扩展静默隐藏该行 |
| `translate` | POST | `{texts, targetLanguage, client:'extension', sourceUrl, sourceTitle, turnId, stepIndex, mode}` → `{translations, provider, model, usage, …}` |
| `lookup` | POST | `{text, context, targetLanguage, client:'extension', sourceUrl, sourceTitle, turnId, stepIndex}` → `{result:{translation, dictionary?, …}, usage?}` |
| `wordbook/add` | POST | 加入单词本（word/translation/phonetic/audioUrl/context/sourceUrl/sourceTitle/targetLanguage/dictionary） |

content → background 协议：

```js
{ type: 'dsh-it:rpc', id, method, payload }            // content/options → background
{ type: 'dsh-it:result', id, ok: true, data }          // background → content/options
{ type: 'dsh-it:result', id, ok: false, error: {code, message} }
{ type: 'dsh-it:open-options' }                        // content → background
{ type: 'dsh-it:toggle' }                              // background → content
```

`background.js` 对 `method` 使用**白名单**（上表 + `models`/`models/resolve`/`wordbook` GET），不会成为任意路径代理。
v1.3.1 起白名单新增 `usage: 'GET'`（唯一新增出网路径，仍只发往本机 DSH）。
`translate` / `lookup` 请求体额外附带可选元数据 `client:'extension'`、`sourceUrl`（当前页地址，超长时省略）、
`sourceTitle`（页面标题，截断到 200 字符），供 DSH 插件记账本并在轨迹页展示「站点 / 客户端」。
v1.7.0 起两者再附带轨迹身份 `turnId` / `stepIndex`（`translate` 另带 `mode`），Host 侧按 `turnId` 聚合成
「一次翻译动作 = 一个 Turn、内部批次 = Steps」（见 §4.8）；字段可选，旧版 Host 忽略即可。

---

## 6. 隐私与安全

1. **只与本机 DSH 通信**：`host_permissions` 仅 `http://127.0.0.1:3080/*`、`http://localhost:3080/*`；
   扩展不直连模型服务、不保存 API Key。
2. **页面文本的去向**：译文由你在 DSH 中配置的模型生成。页面文本经本机 DSH 发往该模型服务
   （由你在 DSH 中自行配置的 provider，如 modelhub）；扩展本身不落盘、不打日志。
   token 统计只从本机 DSH 的账本读取（`GET /usage`）或在内存中累加并展示，不上传任何地方、不写入扩展存储。
   `translate` / `lookup` 请求会附带当前页 `sourceUrl`（≤2048 字符，超长省略）与 `sourceTitle`（≤200 字符），
   只发往本机 DSH，用于 token 账本与轨迹页展示来源站点。
3. **不注入远程代码**：所有 JS 都打包在扩展内；页面内无 `eval` / `new Function` / 远程 `<script>`。
4. **content 不写页面内容**：`chrome.storage` 只存 5 个设置项；content 无 `console.*`、无 `fetch`、无 cookie 读取。
5. **页面样式隔离**：全部 UI 位于 `#dsh-it-host` 的 Shadow DOM（`attachShadow({mode:'open'})`，z-index 最高）；
   注入的译文节点用**行内样式**（`font:inherit` 等）避免站点 CSS 破坏；只在 `document.documentElement` 上
   临时挂一个 `<style>`（控制三模式显示，还原时移除），**不修改站点 `<head>`**。
6. **译文以纯文本注入**（`textContent`），不解析 HTML。
7. **防御性编程**：所有 RPC 失败/超时/抽取异常都收敛到面板状态行，`try/catch` 覆盖所有事件入口，
   不会抛到页面 `window.onerror`。

---

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 状态行「无法连接本机 DSH（…）」 | DSH Web 未启动，或地址不对。先 `curl http://127.0.0.1:3080/dsh-immersive/api/health`；再检查选项页 DSH 地址 |
| 返回 `404` / 提示「接口不存在」 | DSH 插件「dsh翻译」未安装/未启用（`plugin_manager` 安装后需 `application: applied`） |
| 返回 `403 FORBIDDEN_ORIGIN` | DSH 侧 Origin fence 拒绝；扩展后台请求带 `chrome-extension://` Origin，正常应被放行，确认插件版本与 `extensionOrigins` 配置 |
| 翻译全部失败，提示 `MODEL_*` / `MODEL_UNAVAILABLE` / `MODEL_AUTH` | DSH 中没有可用模型或凭据失效：到 DSH → 设置 → dsh翻译 里切换/检查模型，或先在该页「测试翻译」 |
| 提示 `MODEL_RATE_LIMITED` / `MODEL_TIMEOUT` | 模型限流或超时；稍后重试，或换更快的模型；单批超时上限 DSH 侧 90s、扩展侧 120s |
| 提示「未找到可翻译的段落」 | 页面已是目标语言、纯图片/视频、或全是代码/表单；也可能段落文本超过 4000 字符被跳过（见已知限制） |
| 目标语言/模式改了但页面没变 | 目标语言只影响下一次翻译；模式应立即生效。若页面是 SPA 且已跳转，需重新点翻译 |
| 装了扩展但网页右下角没有悬浮球 | 页面未刷新（扩展安装/重载前打开的页面需刷新）；`chrome://`、`edge://`、扩展商店等受限页面无法注入，属浏览器限制 |
| Alt+T 无效 | 快捷键被其他扩展/系统占用：到 `chrome://extensions/shortcuts` 改为其他组合，或直接用悬浮球 |
| 图标显示为默认拼图 | 图标未生成或路径错误：执行 `node tools/make-icons.mjs` 后重新加载扩展 |
| 改端口（非 3080） | manifest 的 `host_permissions` 固定为 3080，需要同时修改 `manifest.json` 里的两条 host_permissions 并重新加载扩展；DSH 侧监听地址也要对应 |
| 发音没声音 | 词典无 `audio` 时用 `speechSynthesis`，取决于系统语音包；静音/自动播放策略也可能阻止 |

---

## 8. 卸载

1. **浏览器扩展**：`chrome://extensions`（或 `edge://extensions`）→ 找到「dsh翻译 · DSH」→ 移除。
   移除后页面中已注入的译文/UI 随页面刷新消失；扩展不会残留 chrome.storage 之外的数据。
2. **DSH 插件**（如需彻底移除后端）：在 DSH 中用 `plugin_manager` 执行 `remove_bundle`（目标
   `@local/dsh-web-translator`），随后该插件 API 返回 404、DSH 设置页中的「dsh翻译」入口消失。
3. 本地数据文件在 `$DSH_HOME/immersive-translate/`（`settings.json`、`wordbook.json`），
   卸载插件不会自动删除；可自行备份或删除。
4. 可选清理：`chrome://extensions` 移除后扩展的 `chrome.storage.local` 数据随之清除。

---

## 9. 本地校验（不打开浏览器即可执行）

```bash
cd dsh-web-translator-extension

# 0) 一键静态校验（等于下面 1~3 的集合 + 契约/文案/PNG 检查，推荐）
node tools/verify.mjs

# 1) JS 语法
node --check background.js
node --check content.js
node --check options.js
node --check tools/make-icons.mjs

# 2) manifest JSON 合法
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"

# 3) 生成并校验图标是真实 PNG
node tools/make-icons.mjs
file icons/*.png

# 4) 可选：真实页面布局诊断（输出 /tmp/dsh-it-debug/{before,after}.png 与 report.json）
node tools/debug-layout.mjs https://lobste.rs/

# 5) 可选：headless Chrome E2E（需本机 Chrome ≥150；由 CDP 加载扩展并 mock DSH API，不发真实模型请求）
node tools/e2e-chrome.mjs
```

预期：`node tools/verify.mjs` 输出 `ALL 181 STATIC CHECKS PASSED`；
`file` 输出 4 个 `PNG image data, 16 x 16 / 32 x 32 / 48 x 48 / 128 x 128, 8-bit/color RGBA`；
`node tools/e2e-chrome.mjs` 输出 `115/115 E2E checks passed` 与 `E2E OK`（Chrome <150 会打印 SKIP 并退出 0）。
E2E 覆盖：扩展加载（manifest/CSP/commands 合法性）、content 注入、翻译流水线报文、
请求元数据（translate/lookup POST body 的 `client` / `sourceUrl` / `sourceTitle`）、
轨迹身份（translate 的 `turnId`/`stepIndex`/`mode`、同一 run 懒加载批次共用 turnId、lookup 单步 turn）、
按屏调度（首屏整屏一次翻译、preload none/half/one 递增、快速滚动不翻中间屏、停稳后补翻一屏、扫描定时器清理）、
block 模式回归与微批合并（小步滚动产生的零散小批次请求数 ≤ ceil(新译段数/2)+2、定时器清理）、
token 展示（本页消耗累计 / GET usage 的今日累计 / 完成状态行 / 查词卡 token 行）、
三模式切换（含计算样式）、划词查词卡、加入单词本、还原、options 页；**DSH 响应为 mock，不校验真实模型输出**。

---

## 10. 浏览器内手测清单（无法在无浏览器环境自动化）

> 前置：DSH Web 已启动、DSH「dsh翻译」插件已安装且模型可用；扩展已加载并刷新目标网页。

- [ ] 打开一个英文文章页（如维基百科英文条目），点悬浮球 →「翻译此页」：首屏出现译文；**向下滚动会继续翻译新段落**（不会一次性翻整页）。
- [ ] 按屏触发（默认）：滚动停稳后新一屏几乎同时出现译文（约 140ms 防抖）；快速连续滚动时中间经过的屏幕不会发请求，只有停下后的当前屏被翻译；Network/DSH 请求日志中每屏约 `ceil(段数/10)` 次请求。
- [ ] 预加载：选项页分别设「不预加载 / 半屏 / 一屏」→ 重新翻译，首屏翻译范围依次变大（一屏默认最多）；选项在下一次翻译生效。
- [ ] 按块懒加载（选项）：切到「按块懒加载」后，滚动时新段落陆续翻译；缓慢滚动时对照请求日志，每次请求通常包含多段（约 3~5 段）而不是 1~3 段一请求（微批合并生效）。
- [ ] 排版：标题/标签/按钮译文紧跟原文（可自然折行、样式一致）；正文译文在原文下方；`<br>` 等段落内换行不会把单词粘连或让译文异常断行。
- [ ] 导航/标签云/页脚/按钮/短链接也有译文（行内追加），且列表项数量、导航布局不发生复制或错位。
- [ ] 三模式切换：原文（只剩原文）→ 双语对照（原文+译文）→ 仅译文（原文隐藏）；切换瞬时完成，**Network/DSH 侧无新翻译请求**。
- [ ] 目标语言切到「日本語」→「重新翻译」：译文变为日文；切回简体中文再翻译。
- [ ] 「停止」：翻译中途点击，未完成队列停止，已译内容保留，状态行提示已停止。
- [ ] 「还原」：所有译文与 `data-dsh-it` 标记消失，页面结构与初始一致；DevTools 中无 `#dsh-it-host` 之外的残留（悬浮球 UI 保留属预期）。
- [ ] 打开/关闭 Alt+T 与工具栏图标：未翻译→翻译中→已翻译→还原 的切换符合预期。
- [ ] 右键菜单：页面空白处右键 →「dsh翻译」→ 原文 / 译文 / 双语对照 三项可用，选择译文/双语会自动开始翻译。
- [ ] 点击「翻译此页/重新翻译」后面板自动收起，只保留右下角悬浮球；再点悬浮球可展开查看进度。
- [ ] 跟随翻译：在 A 页翻译后点击站内链接打开 B，B 自动翻译；点「还原」后再打开 C，C 不自动翻译；关闭选项页「跟随翻译」后同样不自动。
- [ ] 域名隐藏悬浮球：面板底部/右键菜单「当前域名不展示悬浮球」→ 悬浮球消失；刷新仍隐藏；到 DSH 设置页 dsh翻译 → 悬浮球 Tab 可见该域名并移除后恢复。
- [ ] 划词翻译（默认关闭）：选项页开启后，选中一个句子 → 弹卡显示原文/译文；🔊 有声音；点外部/Esc/滚动可关闭；卡片贴近视口边缘时自动翻转不溢出。
- [ ] 双击翻译 / 快捷键翻译（默认关闭）：选项页开启后，双击单词弹卡；选中文本按 Command+K / Ctrl+K 弹卡，无选中时翻译整页；关闭时快捷键只提示「未启用」。
- [ ] 语言一致隐藏悬浮球（默认开启）：目标语言设成页面语言（如英文页选 English）→ 悬浮球不显示；关闭该开关或换回中文目标语言后恢复。
- [ ] 双击英文单词 → 弹卡显示音标/词义；点「加入单词本」→ 变「已加入」；到 DSH → 设置 → dsh翻译 → 单词本能看到该词并可复习。
- [ ] 选项页关闭「双击查词」后，双击不再弹卡，但拖选文本仍会弹卡。
- [ ] 表格/列表页面：单元格与列表项有译文，切换「仅译文」时布局不明显错乱。
- [ ] Token 浮窗（本页）：翻译过程中「本页消耗」的输入/输出数字随批次递增；悬停显示「请求数 N · 缓存命中 M」；「重新翻译」后从 0 重新累计；「还原」后回到「—」。
- [ ] Token 今日累计：打开面板后「今日累计」出现数字，与 `curl http://127.0.0.1:3080/dsh-immersive/api/usage?days=2` 的 `usage.today`（输入+输出）一致；60s 内重复开合面板不重复请求。
- [ ] Token 状态行：一屏内容全部翻译完成后，状态行为「翻译完成 · 本页消耗 N tokens。」（懒加载未完成时显示「当前可见内容已翻译…」属预期）。
- [ ] Token 查词卡：划词/双击查词后，卡片操作按钮下方出现「本次查询 输入 X · 输出 Y tokens」。
- [ ] 旧版 Host 兼容：若 DSH 插件没有 `/usage` 接口（404），面板只隐藏「今日累计」行，翻译/查词/状态行/整体 UI 不受影响、控制台无报错。
- [ ] 轨迹：DSH「dsh翻译 → 轨迹」中一次翻译动作显示为 1 个 Turn；滚动后继续翻译的批次计入同一 Turn 的多个 steps（step 数 = 批次数，stepIndex 从 0 递增）；每次查词各是 1 个单步 Turn。
- [ ] 选项页：测试连接成功显示版本/模型数；读取当前模型显示 provider/model；改模式/目标语言/界面语言并保存，刷新网页后生效。
- [ ] 隐私/健壮性：停掉 DSH 后点翻译 → 面板状态行显示「无法连接 DSH」而非页面报错；整个页面交互、滚动、控制台无未捕获异常。
- [ ] 代码块/按钮/输入框不被翻译（`pre/code/button/input` 等跳过）。
- [ ] SPA：在单页应用内路由跳转后，面板提示「页面已跳转，请重新点击翻译」。
- [ ] 自动翻译（选项页开启）：刷新页面约 1.2s 后自动出现译文，无需点击。

---

## 11. 已知限制

1. **按屏/按块懒加载**：只翻译进入屏幕窗口（视口 + 预加载）的段落；滚不到的段落不翻译、不消耗 token，进度可能停在中间（状态行会提示继续滚动）。
1.1 **按屏触发有停稳延迟**：滚动/缩放停止后约 140ms 才发起新屏幕的翻译；快速连续滚动期间不翻译中间屏幕（这是设计目标：省 token、避免译文闪烁），因此快速滚过很多屏再停下时，只会补翻当前屏及 preload 范围，之前跳过的屏幕不会补译（可用「重新翻译」重新扫当前屏）。
1.2 **按块懒加载的合并等待**：微批合并最多等 400ms 才发送零散小批次，个别段落的首个译文可能比之前晚约 0.2~0.4s；按屏模式没有这个等待（整屏立即发送），但每屏请求数受每批 10 段硬上限约束。
2. **单页上限 800 段**、**单段文本 2~4000 字符**：超过 4000 字符的极端段落不按块级翻译（可能退化为行内片段）；超过 800 段只翻译前 800 段并提示。
   这是与 DSH Host 批处理契约（每批 ≤10 段 / ≤1600 字符）对齐的保守值。
3. **批内失败拆半重试**：失败组会二分重试到单段；若模型本身不可用，会产生较多失败占位（每个可点击重试）。
4. **SPA 不自动续译**：地址变化（包括懒加载未完成时）会检测并提示「页面已跳转，请重新点击翻译」（V1.14.11）；不会自动重译，旧页面共享布局里的行内译文可能保留，新页面主体需手动重新翻译。
5. **表格「仅译文」模式**用 `visibility` 技巧隐藏单元格原文，单元格背景/边框随之不可见，视觉上可能与原文略有差异。
6. **语言跳过判定**：简体/繁体中文、英文、日文、韩文、俄文、阿拉伯文有脚本判定；`fr/de/es/pt/it` 与英文同为拉丁字母，
   无法可靠判定「已是目标语言」，会照常翻译（不影响正确性，只是可能多一次模型调用）。
7. **目标语言以扩展设置为准**：面板/选项页的 12 语言选择会作为 `targetLanguage` 随请求发送，覆盖 DSH 设置里的目标语言；
   模型、提示词仍以 DSH 设置为准。
8. **DSH 地址端口固定 3080**：`host_permissions` 只覆盖 `127.0.0.1:3080` 与 `localhost:3080`，改端口需改 manifest 并重载。
9. **发音**：优先词典 `audio`（`dictionaryapi.dev`，英文单词），否则依赖系统 `speechSynthesis` 语音包；无语音包时无声。
10. **单词本列表/复习不在扩展内**：扩展只做「加入单词本」，列表、SRS 复习、跟读评分在 DSH 设置页完成。
11. **不支持** Firefox/Safari；受限页面（`chrome://`、扩展商店、PDF 查看器内部等）无法注入。
12. `tools/e2e-chrome.mjs` 用 mock DSH API 验证扩展行为，**不覆盖**真实 DSH/模型；真实链路仍需按上面手测清单在本机 DSH 上验证。
13. **标题行内译文会随文本自然折行**（标题可能占两行）；正文译文固定在原文下方。不同站点 CSS 极端情况下可用「原文/仅译文」快速对照。
14. **行内对照的取舍**：导航/标签/页脚等采用行内译文；窄导航槽里行内译文折行时会自动改成小字块级译注（V1.14.4），避免拆词/横向溢出；行内译文插在对应原文文字节点之后，不会被同一容器里后面的按钮/链接隔开（V1.14.5）；行内译文颜色继承宿主，站点异步切换深色主题/`button span` 样式时不会黑底黑字（V1.14.8）；「仅译文」模式隐藏原文文字但保留部分元素占位（如链接图标）；`<details>` 折叠内容展开后需重新点翻译。
15. **iframe 翻译是可选功能（默认关闭）**：开启「翻译 iframe 内内容」后，顶层页面会向直接子 iframe 广播翻译/还原/模式指令，子框架只做翻译、不显示悬浮球/面板；嵌套 iframe 暂不处理。默认关闭是因为 iframe 可能包含 Cookie 同意、广告、第三方评论等跨域内容，启用后这些文本也会发送给你在 DSH 中配置的模型。顶层页面的右键菜单/查词仍只作用于主文档。
16. **Token 统计以 DSH 插件账本为准**：本页消耗是浮窗生命周期内的实时累计（iframe 内的划词/翻译不影响主文档计数）；今日累计是最近一次成功刷新（打开面板时，节流 60s）的快照，其它标签页/DSH 页面新增的消耗最多延迟 60s 反映。旧版插件没有 `/usage` 接口时只显示本页消耗。
17. **微批合并有最长等待**：滚动触发的零散小批次最多等 `BATCH_COALESCE_MAX_WAIT_MS`（400ms）就会发送；因此「每次只滚一点点」时个别段落的首个译文可能比之前晚约 0.2~0.4s 出现，但整页请求数（=重复固定提示词）明显减少。首屏可见区域达到合并目标（约 3 段 / 400 字符）即立即发送，不额外等待。
18. **RTL/竖排文字暂不专门适配**：阿拉伯语、希伯来语等从右向左排版页面暂不纳入质量范围（目前按普通 LTR 规则注入）。

---

## 12. 设计依据

- DSH 插件契约：`../dsh-web-translator/DESIGN.md`（v2 §5 Host API、§7 浏览器扩展规范、§8 安全与隐私）。
- Token 统计增量契约：`../dsh-web-translator/DESIGN-TOKEN-USAGE.md`（v3 §0 纪律、§4 扩展浮窗、§5 验收、§6 写入范围）。
- 翻译只走本机插件 API，扩展不实现提示词/模型管理；模型与提示词编辑入口在 DSH 设置页（单一权威源）。
