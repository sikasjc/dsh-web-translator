# dsh-web-translator（dsh翻译）· 浏览器扩展 + DSH 模型后端 — 设计契约 v2

> 状态：设计已按用户 v2 需求收敛，**开始实现（仅工作区代码，未安装、未改 profile）**。
> 用户已确认：只做浏览器扩展（不做 DSH 内阅读器）；翻译使用 DSH 中配置的模型（模型可切换、提示词可调整）；
> 仅 Chrome/Edge；支持单词本，并在 DSH 内复习单词、练习发音；默认目标语言简体中文。
>
> **v3 增量（2026-11-06）**：token 消耗采集与统计、DSH 左侧工具栏整页、Chrome 浮窗 token 展示。
> **v4 增量（2026-11-06）**：复用 DSH 原生轨迹
> **v5 增量（2026-11-06）**：翻译结果缓存持久化（磁盘 LRU + TTL + `DELETE /cache`，见 [`DESIGN-CACHE.md`](./DESIGN-CACHE.md)）。 —— 翻译会话桥接（每次翻译动作 = 真实 DSH 会话，每个模型请求 = 一轮原生对话，见 [`DESIGN-CONVERSATIONS.md`](./DESIGN-CONVERSATIONS.md)）。
> 本文件未覆盖的部分以 [`DESIGN-TOKEN-USAGE.md`](./DESIGN-TOKEN-USAGE.md) 为准。

---

## 1. 范围

### 1.1 交付

1. **Chrome/Edge MV3 扩展**：在任意真实网页上做dsh翻译（原文 / 双语对照 / 仅译文）、划词/双击查词、加入单词本。
2. **DSH 插件**（`@local/dsh-web-translator`）：
   - Host 半：LLM 翻译/查词后端 + 单词本持久化 + 设置管理（模型、提示词、目标语言）。
   - Client 半：Settings 中的「dsh翻译」页面 —— 翻译设置（模型/提示词/测试）+ 单词本（复习、发音练习、管理）。
3. 共用本地 API：扩展只与 DSH 本地接口通信，不直连模型、不带密钥。

### 1.2 非目标

- 不做 DSH 内网页阅读器/页面翻译（v1 阅读器方案废弃）。
- 不做 Firefox/Safari；不做整页导出/Anki；不做语音识别云端评分（跟读评分用浏览器 Web Speech API，本地尽力而为）。
- 不修改 DSH 源码、不写 profile 文件（安装由 `plugin_manager` 完成）。

## 2. 布局

```
<repo>/
├── dsh-web-translator/            # DSH 插件（本地目录 bundle）
│   ├── package.json  cordis.patch.yml  index.js  client.js
│   ├── lib/          # Host 逻辑（只依赖 node: 内置模块）
│   ├── test/         # node --test
│   ├── locale/{en,zh}.json  icon.svg  README.md  DESIGN.md
└── dsh-web-translator-extension/      # 浏览器扩展（加载已解压）
    ├── manifest.json  background.js  content.js  options.html  options.js  icons/*.png  README.md
```

数据结构落盘：`$DSH_HOME/immersive-translate/settings.json`、`wordbook.json`（Host 半原子写；不写 profile）。

## 3. 架构

```
┌──────────────── Chrome/Edge ────────────────┐
│ content.js（页面内，Shadow DOM 隔离）         │
│  ├─ 悬浮球/面板：模式、语言、模型、进度、还原  │
│  ├─ 段落抽取 → 批量 → 注入译文 → 三模式切换   │
│  ├─ 划词/双击弹卡（译文/音标/发音/加入单词本） │
│  └─ background 消息 RPC（唯一出网侧）         │
│ background.js：fetch DSH 本地 API            │
└──────────────────▲───────────────────────────┘
                   │ HTTP (127.0.0.1:3080, Origin fence)
┌──────────────────┴──── DSH Host ─────────────┐
│ 插件 Host 半（index.js + lib）                │
│  ├─ /dsh-immersive/api/settings  GET/PUT      │
│  ├─ /dsh-immersive/api/models    GET          │
│  ├─ /dsh-immersive/api/models/resolve GET     │
│  ├─ /dsh-immersive/api/translate POST         │
│  ├─ /dsh-immersive/api/lookup    POST         │
│  ├─ /dsh-immersive/api/wordbook/*             │
│  └─ /dsh-immersive/api/health    GET          │
│  ctx.llm.stream(...) → 用户配置的模型服务      │
│  $DSH_HOME/immersive-translate/{settings,wordbook}.json │
└──────────────────▲───────────────────────────┘
                   │ 同源 fetch
┌──────────────────┴──── DSH Client ────────────┐
│ client.js → settings.section「dsh翻译」      │
│  ├─ 翻译设置：模型/推理强度/目标语言/提示词/测试 │
│  └─ 单词本：列表、搜索、复习（SRS）、发音/跟读   │
└───────────────────────────────────────────────┘
```

## 4. 模型接入（核心）

使用 Host `ctx.llm`（已通过 inspect 确认契约）：

- 目录：`llm.listProviders(): LlmProviderInfo[]`、`llm.listModels(provider): LlmModelInfo[]`、`llm.resolveModelInfo(provider, model): LlmResolvedModelInfo`（含 `context`、`defaultMaxTokens`、`reasoning.efforts`）。
- 默认模型：`ctx.get('agentDefaultModel')?.currentSelection()`（当前 profile：`modelhub / deepseek-flash / reasoningEffort:max`）。
- 推理强度：设置默认 `auto` → 优先 `off`，否则该模型 advertised 列表中的最小 effort；用户可显式指定。
- 调用：`ctx.llm.stream({ provider, model, reasoningEffort?, system, messages:[{role:'user', content:[{type:'text', text}]}], temperature, maxTokens, signal })`；收集 `text-delta`，直到 `finish`：
  - `finish.reason.kind === 'stop'` → 成功；
  - `error`/`aborted` → 映射错误码（`NO_ADAPTER`→`MODEL_UNAVAILABLE`、`MISSING_CREDENTIAL|AUTH|INVALID_CREDENTIAL`→`MODEL_AUTH`、`RATE_LIMIT`→`MODEL_RATE_LIMITED`、`CONTEXT_WINDOW_EXCEEDED`→`TEXT_LIMIT`、其它→`MODEL_FAILED`）；
  - `max-tokens` → `OUTPUT_TRUNCATED`。
- **不传 sessionId/purpose**：翻译是插件自己的辅助调用，不进入会话记录（模型可见输入不进 session log，属本插件的明确取舍，README 说明）。
- 默认温度 `0.2`；`maxTokens` 按批次估算并 clamp 到模型 `defaultMaxTokens`（默认 `min(8192, max(512, ceil(chars*1.5)))`）。
- 超时：单批默认 90s（`AbortSignal` 与客户端断开联动），无自动重试（解析失败的重试见 §4.3）。

### 4.1 提示词

设置项（Host 持久化，DSH 设置页/扩展选项页均可编辑）：

- `systemPrompt`（默认，`{{...}}` 由 Host 渲染）：
  ```
  You are a professional translator. Translate every source segment into {{targetLanguage}}.
  Preserve meaning, tone, formatting and order. Do not add explanations or commentary.
  If a segment is already in {{targetLanguage}}, return it unchanged.
  Output ONLY a JSON object exactly like {"translations":["...","..."]} containing
  {{segmentCount}} strings in input order. No markdown fences, no extra keys.
  ```
- `userTemplate`（默认）：
  ```
  Source language: {{sourceLanguage}}
  Target language: {{targetLanguage}}
  Segments (JSON array; translate each element, keep the same order):
  {{segmentsJson}}
  ```
- 占位符：`{{targetLanguage}}` `{{sourceLanguage}}` `{{segmentCount}}` `{{segmentsJson}}` `{{segments}}`（编号行）。
- 校验：`systemPrompt` ≤ 8000 字符、`userTemplate` ≤ 4000 字符；缺失/空则用默认；PUT 时未知占位符仅告警不阻断。
- 自定义提示词必须保持输出 JSON 契约，UI 有提示与「恢复默认」。

### 4.2 批量与并发

- 客户端按批调用（扩展侧按抽取顺序分组；Host 二次校验）：
  - 单请求 `texts` 1..50；每条 ≤ 8000 字符；
  - Host 再切批：默认每批 ≤ 10 段且总字符 ≤ 1600（`batchSegments` / `batchChars` 可配）；
  - 批并发 2；批内段数=1 时允许纯文本回退解析。
- 缓存：进程内 LRU（512 批，key=`provider|model|target|sha1(system|userTemplate|textsJson)`）——同页重复/模式切换不重复计费。

### 4.3 输出解析

1. 去掉 ``` 围栏；提取第一个 `{` 到最后一个 `}`（或 `[`..`]`）；
2. 接受 `{"translations":[...]}` 或裸数组；长度必须等于批段数；
3. 单段批：解析失败可接受纯文本（去引号/空白）；
4. 仍失败：追加一条 `user` 纠正消息（“Return only the required JSON.”）重试 1 次（temperature 0）；
5. 再失败 → `INVALID_MODEL_OUTPUT`（附前 200 字原始输出到服务端日志，不返回给客户端）。

## 5. Host API 契约

Base：`/dsh-immersive/api`。统一信封：成功 `{ok:true,...}`；失败 `{ok:false,error:{code,message}}` + 状态码。
方法：GET 用于 health/models/settings/wordbook 查询；POST/PUT 用于写操作。
Origin fence（不要用 `ctx.connection.requestRejection`，扩展 Origin 会被拒）：
- 无 `Origin`（curl/扩展后台）→ 允许；
- `chrome-extension://` / `moz-extension://` → 允许（配置 `extensionOrigins` 可收紧）；
- `Origin` 与 `req.headers.host` 同 host → 允许；
- 其余 → 403 `FORBIDDEN_ORIGIN`。
请求体上限 1 MiB；非 JSON → 400。

### 5.1 `GET /health`
`{ ok:true, version, uptimeMs, llm:{ providers, models } }`（providers/models 为计数，失败不阻塞）。

### 5.2 `GET /models`
```json
{ "ok": true,
  "catalog": [{ "provider":"modelhub", "name":"modelhub",
                "models":[{"id":"deepseek-flash","name":"deepseek-flash","contextWindow":1048576,"maxTokens":393216}] }],
  "defaultSelection": { "provider":"modelhub", "model":"deepseek-flash", "reasoningEffort":"max" } }
```
- `listModels` 失败的路由跳过并附 `error` 字段；缓存 30s。

### 5.3 `GET /models/resolve?provider=..&model=..`
`{ ok:true, model:{ provider, model, name, contextWindow?, maxTokens?, reasoningEfforts:[{id,name,description?}], defaultEffort? } }`

### 5.4 `GET /settings`
```json
{ "ok": true,
  "settings": { "provider":"modelhub", "model":"deepseek-flash", "reasoningEffort":"auto",
                "targetLanguage":"zh-CN", "systemPrompt":"...", "userTemplate":"...",
                "batchSegments":10, "batchChars":1600, "concurrency":2 },
  "defaults": { "...": "同上默认值" },
  "selected": { "provider":"...", "model":"...", "reasoningEffort":"off", "source":"settings|default" },
  "modelInfo": { "provider":"...", "model":"...", "reasoningEfforts":[], "contextWindow":0, "maxTokens":0 } }
```
未保存过 provider/model 时使用 `agentDefaultModel.currentSelection()` + auto effort，`source:"default"`。

**目标语言白名单（固定 12 个，PUT 校验）**：`zh-CN`(默认) `zh-TW` `en` `ja` `ko` `fr` `de` `es` `ru` `pt` `it` `ar`。

**单词本列表**：`GET /wordbook` 的 `limit` 默认 200、上限 500；复习队列用 `filter=due&limit=50`。

### 5.5 `PUT /settings`
Body：settings 子集。校验：类型/范围（batchSegments 1..20、batchChars 200..4000、concurrency 1..4、targetLanguage 白名单）、provider/model 必须存在；非法 → 400 `INVALID_SETTINGS`。保存后返回同 GET /settings。
持久化 JSON：`{ version:1, settings:{...}, updatedAt }`。

### 5.6 `POST /translate`
请求：`{ "texts":["..."], "targetLanguage":"zh-CN"? , "sourceLanguage":"auto"? }`（targetLanguage 缺省用设置）。
响应：
```json
{ "ok": true, "translations":["..."], "provider":"modelhub", "model":"deepseek-flash",
  "reasoningEffort":"off", "usage": { "inputTokens":0, "outputTokens":0 },
  "cached": false }
```
错误：`TEXT_LIMIT`(413) `MODEL_UNAVAILABLE`(502) `MODEL_AUTH`(502) `MODEL_RATE_LIMITED`(429) `MODEL_FAILED`(502) `OUTPUT_TRUNCATED`(502) `INVALID_MODEL_OUTPUT`(502) `MODEL_TIMEOUT`(504)。

### 5.7 `POST /lookup`
请求：`{ "text":"immersive", "context":"...", "sourceUrl":"...", "targetLanguage":"zh-CN"? }`
响应：`{ ok:true, result:{ text, translation, provider, model, dictionary?:{word,phonetic?,audio?,meanings:[{partOfSpeech,definitions:[...]}]} } }`
词典：英文单词（`/^[A-Za-z][A-Za-z'-]{0,40}$/`）查 `dictionaryapi.dev`（5s 超时，失败静默降级）。

### 5.7.1 `GET /ball-sites` / `POST /ball-sites/add|remove`
悬浮球域名隐藏列表：GET 返回 `{sites, updatedAt}`；add/remove 请求 `{domain}`，域名统一小写、去掉协议/路径/端口/`www.` 前缀，去重且最多 200 个。

### 5.8 单词本

- `GET /wordbook?query=&filter=due|all|mastered&limit=` → `{ ok, items:[...], stats:{total,due,todayDue,mastered,newCount} }`
- `POST /wordbook/add` `{ word, translation, phonetic?, audioUrl?, context?, sourceUrl?, sourceTitle?, targetLanguage, dictionary? }` → `{ ok, item, existed }`（按 `word + targetLanguage` 去重；已存在则更新 context/音标，保留 SRS）
- `POST /wordbook/update` `{ id, patch:{ note?, translation?, mastered?, suspended? } }` → `{ ok, item }`
- `POST /wordbook/review` `{ id, grade: "again"|"hard"|"good" }` → `{ ok, item }`
- `POST /wordbook/remove` `{ id }` → `{ ok }`
- 单词条目：
```json
{ "id":"wb_...", "word":"immersive", "translation":"沉浸式的", "phonetic":"/.. /", "audioUrl":"https://..",
  "context":"..", "sourceUrl":"..", "sourceTitle":"..", "targetLanguage":"zh-CN",
  "dictionary":{"meanings":[{"partOfSpeech":"adjective","definitions":["..."]}]},
  "note":"", "createdAt":0, "updatedAt":0, "reviews":0, "lapses":0,
  "level":0, "dueAt":0, "mastered":false, "suspended":false }
```
- SRS：间隔天数 `[10min,1,2,4,7,15,30,60,120]`（level 0..8）：
  - `again`：level=0，lapses++，dueAt=now+10min；
  - `hard`：level=max(0, level-1)，dueAt=now+intervals[level] 天（level 0 为 10min）；
  - `good`：level=min(8, level+1)，dueAt=now+intervals[level] 天；
  - `mastered` 由 level≥8 或手动标记；更新后立即落盘。
- 文件上限 5000 条；原子写（tmp+rename）；写串行队列。

### 5.9 错误码总表

| code | HTTP | 场景 |
|---|---|---|
| `BAD_REQUEST` / `INVALID_SETTINGS` / `INVALID_URL_OR_TEXT` | 400 | 参数校验 |
| `FORBIDDEN_ORIGIN` | 403 | Origin fence |
| `NOT_FOUND` | 404 | 未知子路径 |
| `METHOD_NOT_ALLOWED` | 405 | 方法错误 |
| `TEXT_LIMIT` | 413 | 文本/条数超限 |
| `MODEL_RATE_LIMITED` | 429 | 模型限流 |
| `MODEL_TIMEOUT` | 504 | 模型超时 |
| `MODEL_UNAVAILABLE` / `MODEL_AUTH` / `MODEL_FAILED` / `OUTPUT_TRUNCATED` / `INVALID_MODEL_OUTPUT` / `WORD_NOT_FOUND` | 502/404 | 模型与数据错误 |
| `INTERNAL` | 500 | 未预期异常 |

## 6. DSH Client（设置页）规范

- 注册：`settings.section` `{ id:'immersive-translate', order:35, label: () => t('title') }`；插件 meta 走 `locale/{en,zh}.json`。
- 页面结构：标题「dsh翻译」+ Tab「翻译设置 / 单词本」（Tab 本地状态）。
- **翻译设置**：
  - 模型：按 provider 分组的 select（数据来自 GET /settings.catalog）；切换后调 GET /models/resolve 刷新推理强度选项；
  - 推理强度：auto/各 effort；目标语言 select；「保存」按钮（PUT /settings），脏状态提示；
  - 提示词：systemPrompt textarea（≥6 行）+ userTemplate textarea + 「恢复默认」；侧注说明 JSON 输出要求；
  - 测试：文本框 + 「测试翻译」→ POST /translate，显示结果/耗时/模型/错误；空文本禁用。
- **单词本**：
  - 顶部统计（总数/待复习/已掌握）+ 搜索框 + 过滤 tab（待复习/全部/已掌握）；
  - 列表：单词、音标、译文、下次复习、发音按钮（🔊）、编辑备注、标记掌握、删除；
  - 「开始复习」：进入复习卡片流（due 队列，最多 50）：
    - 正面：单词 + 音标 + 🔊 发音（`speechSynthesis`，优先 dictionary audio URL）+ 上下文句；
    - 空格/点击显示答案：译文 + 词典释义；
    - 操作：不认识 / 模糊 / 认识（1/2/3 键）→ POST /wordbook/review → 下一张；进度 x/y；结束显示统计；
    - 发音练习：「🎤 跟读」按钮 → `webkitSpeechRecognition`（lang 按单词语言：ASCII→en-US，CJK→zh-CN；不支持则按钮禁用并提示）；识别结果与单词做编辑距离相似度，≥0.8 通过、否则「再试一次」，展示识别文本；麦克风权限被拒 → 提示 + 隐藏。
- 数据全部走本地 API（同源 fetch，路径用 `document.baseURI` 解析，兼容反代前缀）。
- 主题：仅用 `--dsw-alias-*` token；组件内 `<style>` React 元素；按钮/输入框自绘，匹配 DSH 观感；a11y：`aria-label`、`role="tablist"`、键盘焦点环。
- i18n：注册 ns `dshImmersiveTranslate` 的 zh/en 字典，`locale.bind`；locale 不可用时内置字典兜底。
- 错误一律页面内展示（不抛到 slot 外）；加载态骨架；空态文案。

## 7. 浏览器扩展规范

### 7.1 manifest（MV3）
- `permissions: ["storage","activeTab","scripting","contextMenus"]`；`host_permissions: ["http://127.0.0.1:3080/*","http://localhost:3080/*"]`
- `content_scripts: [{matches:["http://*/*","https://*/*"], js:["content.js"], run_at:"document_idle"}]`
- `background.service_worker: background.js`（module）；`action` 点击 → 发 toggle；`commands.toggle-translate` 默认 `Alt+T`；`options_page: options.html`；icons 16/32/48/128。

### 7.2 content.js
- 页面注入 UI 宿主：`<div id="dsh-it-host">` 挂 `document.documentElement`，内用 `attachShadow({mode:'open'})` 承载全部 UI 样式（隔离站点 CSS）；z-index 最大。
- 悬浮球（右下）：点击展开面板。
- 面板：模式三按钮（原文/双语/仅译文）、目标语言、当前模型名（只读，来自 /settings）、「翻译此页/停止/还原」、进度条（已译/总数）、设置按钮（openOptionsPage）、状态/错误行、隐私提示。
- 抽取算法（与设计 v1 §5.4 相同语义）：候选块标签 + 行内 DIV/SPAN + 长度 2..4000 + 跳过脚本/代码/表单/隐藏/插件节点 + 目标语言跳过 + 单页上限 800 块（超出提示只译前 800）。
- **视口懒加载（省 token，V1.1）**：开始翻译时只把「当前视口 + 下方一屏预载」的块入队；`IntersectionObserver`（`rootMargin: 0 0 100% 0`）在滚动时把新进入视口的块继续入队；队列调度保持 ≤2 批在途，空闲时等待滚动，**不再一次性翻译整页**；滚不到的段落不产生模型请求。
- 翻译流水线：队列内按 ≤10 段、≤1600 字符切批 → 并发 2 调 background `translate` → 边到边注入；失败组拆半重试至单段；单段失败标红可点击重试；「停止」中止队列并保留已译。
- **段落文本归一化（V1.5，可读性优先、无需配置）**：扩展抽取时把 `<br>`/`<wbr>`、HTML 格式化换行、连续空白、NBSP 还原为空格；Host 的 `normalizeSegmentText` 再归一一次，让模型看到完整句子；模型返回的段落译文异常换行压平为空格，不人为断行（由浏览器按容器宽度自然折行）。不提供换行相关配置，也不做按行数/长度的机械判断。
- **列表项块级译文（V1.14.3）**：`LI` 加入块候选；含嵌套 `ul/ol/dl/p/div…` 的 `li` 与 chrome 区域（nav/header/footer/aside）的 `li` 登记占位，短文本（<24 字符）标签云仍走行内；其余正文 `li` 以 `inner:true` 把译文块 append 进 `li` 内部。仅译文模式对 `li[data-dsh-it="src"]` 使用 visibility 隐藏原文、显示内部译文（与 td/th/caption 相同），避免连译文一起隐藏。
- **相同译文跳过（V1.14.2）**：`isSameTranslation()` 忽略大小写/空白/标点比较原文与译文，相同则不注入（行内与块级、重试路径统一处理），避免专有名词/缩写/用户名产生 `ARM ARM`、`Patreon Patreon` 这类重复；「仅译文」模式下原文保留。
- **长段落按块翻译（V1.14.2）**：`MAX_TEXT` 800 → 4000，长正文段落（如 danluu.com 的文章）不再因超限退化为逐文字节点的行内碎片；超过 4000 字符的极端段落仍跳过块级候选。
- **结构化表格单元格（V1.14.1）**：`TD/TH/CAPTION` 若内部含带文字的 `dl/ul/ol/p/div/table/figure/blockquote/section/article/nav/header/footer` 等块级结构，则登记占位、不再整格合并翻译；内部段落/链接按各自粒度翻译（go.dev/doc/asm 的目录曾因整格 `textOf` 拼接成一大段，且内部链接被跳过）。
- **排版规则（V1.5，可读性优先）**：
  1. **标题/标签/按钮/导航/页脚/元信息行**：行内译文**紧跟原文**（同一文本流，随容器自然折行）；译文 span 放进原 label/链接/按钮/标签元素内部，并从该元素复制 computed 排版/颜色/背景/圆角（`font-family/font-size/font-weight/line-height/letter-spacing/color/background-color/border-radius` 等），原文文字节点包 `data-dsh-it="src-inline"` 供「仅译文」隐藏。
  2. **正文**：`p`/`blockquote`/`figcaption`/表格单元格等 → 块级译文另起一行放在原文下方，复制排版与背景色/圆角；**正文列表项 `li`**（非 chrome 区域且文本 ≥24 字符）→ 整项译文作为块级节点 append 到该 `li` 内部（不新增条目、不复制编号/子弹，保留缩进）；`dt`/`dd`、导航/标签云短 `li` 保持行内；`h1~h6` 与字号 ≥20px 的展示型短块按行内处理。
  3. **布局保护**：`flex`/`grid` 容器本身与父级为 flex/grid 的非内嵌块不插块级兄弟（交给行内）；折叠 `<details>` 内容暂不翻译；被跳过的块级候选登记“占位”参与嵌套去重，防止其外层包裹被误当叶子块翻译。
- **注入样式**：块级译文节点从原文 `getComputedStyle` 复制排版属性；若原文是「窄容器 + 左右 auto margin」的水平居中块，`copyHorizontalAlignment` 会把译文盒也设为 `margin-left/right:auto` 并复制 `width/max-width`，避免只复制 `text-align:center` 导致译文盒靠左；行内译文从宿主元素复制排版/颜色/背景等 computed 样式；模式切换只改 `data-dsh-it-mode`，不重新请求。
- 还原：移除全部注入节点/属性/observer/UI，恢复原 DOM。
- 右键菜单（`contextMenus`）：父菜单「dsh翻译」（contexts=page）→ 子项「原文 / 译文 / 双语对照」；点击后 background 发 `dsh-it:set-mode`，content 切换模式（译文/双语在未翻译时自动开始翻译）。
- 划词翻译 / 双击翻译（V1.9，默认关闭，选项 `selectionTranslate` / `doubleClickTranslate`）：开启后 selection 长度 1..500 → 弹卡（Shadow DOM 定位 fixed）：原文、加载、译文、音标/词义、🔊（speechSynthesis / audioUrl）、「加入单词本」；`handleSelectionEvent` 按来源门控：双击来源需 `doubleClickTranslate`，拖选来源需 `selectionTranslate`，关闭时对应操作不弹卡；点击外部/Esc/滚动关闭。
- 快捷键翻译（V1.9，默认关闭，选项 `shortcutTranslate`）：manifest `commands.shortcut-translate`（建议 `Command+K` / `Ctrl+K`，在 `chrome://extensions/shortcuts` 自定义）；background 收到 `commands.onCommand` 后向当前 tab 发 `dsh-it:shortcut-translate`，content 校验开关后：有选区 → `handleSelectionEvent(true)` 翻译选区，无选区 → `toggleTranslate()` 整页；开关关闭时只 toast 提示未启用。
- 面板行为：点击「翻译此页/重新翻译」并成功启动后自动 `closePanel()`，只保留悬浮球；进度/状态在下次展开时可见。
- 工具栏图标：`chrome.action.onClicked` 只发 `dsh-it:toggle-panel` 打开/收起面板，**不触发翻译**。
- 悬浮球（V1.10）：左键 `quickTranslateFromBall()` —— 未翻译时按当前模式（`only` 保留仅译文，其余按 `bilingual`）静默开始翻译，翻译中再点停止，已翻译再点还原；右键 `contextmenu` 阻止默认菜单并打开功能面板；拖动（≥5px）不触发翻译/面板。
- 悬浮球进度（V1.12）：`updateProgressUi()` 在 `state.running || state.starting` 时给球加 `.dsh-bubble-busy`，球内显示当前百分比（`total===0` 时显示 `…`），`--dsh-bubble-progress` 驱动伪元素 conic-gradient 环形进度并旋转；`title/aria-label` 同步「翻译中 done/total（percent%）」；完成/停止后移除 busy 并恢复「译」。
- 域名隐藏悬浮球（V1.11）：Host 新增 `ball-sites.json` 与 `GET /ball-sites` / `POST /ball-sites/add|remove`（域名归一化、去重、上限 200）；content `init()` 在创建 UI 前拉取列表，命中 `location.hostname` 时 `bubble.hidden=true`；面板底部「当前域名不展示悬浮球」与右键菜单「`dsh-it:hide-domain`」写 Host，刷新后仍隐藏；DSH 设置页新增「悬浮球」Tab（`BallSitesPage`）查看/移除/手动添加。
- 语言一致检测：`detectPageLanguage()` 读 `<html lang>` / `content-language` / `og:locale`，与 `effectiveTarget` 一致时跳过翻译（不发 translate 请求），在悬浮球上方显示 `.dsh-toast` 提示并收起面板；`en≈en-US`，`zh-CN` 与 `zh-TW` 视为不同。
- 语言一致隐藏悬浮球（V1.13，默认开启，选项 `hideBallSameLanguage`）：`applyBallSiteVisibility()` 在「显示悬浮球」开关、域名隐藏列表之外再判断 `isCurrentLanguageSame()`；命中则隐藏悬浮球（工具栏图标/右键菜单仍可打开面板），关闭选项后恢复。`refreshUi()` 与 `onStorageChanged` 都会重新计算，目标语言变化即时生效。
- 跟随翻译（V1.7，默认开启，选项 `followTranslation` 可关闭）：background 用 `chrome.storage.session` 按 tab 记录 `dsh-it:follow:<tabId>`，`startTranslate` 成功后 `follow:enable`；同标签跳转/新标签页面加载时 content 询问 `follow:check`，命中则 600ms 后 `startTranslate({silent:true})`；`tabs.onCreated` 从 openerTabId 继承；content 的 `follow:check` 在查不到时还会通过 `chrome.tabs.get(tabId).openerTabId` 兜底继承（解决新标签 content 早于 onCreated 初始化）并重试最多 3 次；`tabs.onRemoved` 清理；`restoreAll`/语言一致/无可译文本/关闭选项时 `follow:disable`；自动跟随启动时用 toast 提示「跟随翻译：本页已自动翻译」。
- 按钮 hover 修复：`.dsh-btn:not(.primary):hover` 才使用通用浅色背景；`.dsh-btn.primary:hover` 显式恢复渐变背景与白色文字，避免白字白底导致按钮"消失"。
- 悬浮球交互（V1.8）：`buildBubble()` 支持 pointer 拖拽（移动超过 5px 判定为拖动，拖动后抑制一次 click 防误开面板），位置以 `{right,bottom}` 写入 `chrome.storage.local.ballPosition`，`clampBallPosition` 按 46px 球体 + 8px 边距限制在视口内，`resize` 时重新夹取并持久化；面板底部「隐藏悬浮球」写 `showFloatingBall=false` 并收起面板/卡片，右键菜单「dsh翻译 → 显示悬浮球 / 隐藏悬浮球」分别发 `dsh-it:show-ball` / `dsh-it:hide-ball`（同时写回 storage），选项页也有「显示悬浮球」开关。
- SPA：V1 监听 `popstate`/`pushState` 后提示「页面跳转，请重新点击翻译」；`scanAgain()` 预留 MutationObserver 接管。
- 与后台协议：
```js
// content → background
{ type:'dsh-it:rpc', id, method:'translate'|'lookup'|'settings'|'wordbook/add'|'health', payload }
// background → content
{ type:'dsh-it:result', id, ok:true, data } | { type:'dsh-it:result', id, ok:false, error:{code,message} }
```
- 设置调整（`chrome.storage.onChanged`）：目标语言/模式/自动翻译立即生效；自动翻译开启时页面加载后自动执行（默认关）。

### 7.3 background.js
- 唯一网络出口：读 `chrome.storage.local.dshBaseUrl`（默认 `http://127.0.0.1:3080`）→ `fetch(base + '/dsh-immersive/api/' + method)`；超时 120s（AbortController）；错误标准化为 `{code,message}`；对 content 按 `id` 回包。
- `chrome.action.onClicked` → 查询当前 tab → `chrome.tabs.sendMessage({type:'dsh-it:toggle'})`；`commands.onCommand` 同理；`chrome.contextMenus`（安装/更新/浏览器启动时创建，`removeAll` 后重建）两项：「翻译此页 / 停止 / 还原」调 `sendToggleToTab`、「翻译选中文本」发 `dsh-it:translate-selection`；`chrome.runtime.onMessage` 处理 `dsh-it:open-options`。
- 不把模型密钥/提示词内容写进 content 页面；只透传文本与结果。

### 7.4 options.html / options.js
- 字段：DSH 地址（默认 127.0.0.1:3080）、目标语言、模式默认、自动翻译、界面语言；「测试连接」（GET /health）、「打开 DSH 设置」（提示在 DSH → 设置 → dsh翻译 中改模型/提示词/复习）。
- 模型与提示词编辑放在 DSH 设置页（单一权威源）；扩展选项页提供「获取当前模型/语言」只读回显（GET /settings）与目标语言快捷覆盖（存 chrome.storage，请求时覆盖）。
- 保存至 `chrome.storage.local`；保存成功提示。

## 8. 安全与隐私

1. 模型调用只发生在 DSH Host：使用用户在 DSH 配置的 provider（如 modelhub），不新增密钥；翻译文本会发送给该 provider（用户自行配置），README/UI 明示。
2. 扩展不注入远程代码、不读 cookie、不申请无关权限；content↔background 仅文本 RPC。
3. 本地 API Origin fence（§5）；只读/写单词本与设置，无文件系统/命令能力；DSH Web 默认回环监听。
4. 单词本/设置落在 `$DSH_HOME/immersive-translate/`，用户可自行备份/删除；不写 profile。
5. 译文以纯文本注入，不解析 HTML；页面内容不写入 DSH 会话日志（仅内存 LRU）。

## 9. 验证计划

### 9.1 静态/单测（不安装）
- `node --check`：index.js / lib/*.js / client.js / 三个扩展 JS；
- `node --test test/`：常量与校验、settings 合并、JSON 解析与失败重试、批处理切分、缓存、SRS 计算、词典裁剪、Origin fence、错误映射、wordbook 去重/持久化（临时目录）；
- manifest.json 校验；图标 PNG 校验（尺寸/字节）。

### 9.2 安装后 live
1. `plugin_manager install_bundle`（单独征得用户同意）→ `application: applied`；
2. Config 目录出现插件行；`Slots.listSubTree` 中 `settings.section` occupant 出现且 active；
3. curl：health、models、settings GET/PUT、translate（中英混合/单段/50 段）、lookup（英文词/句子）、wordbook add/list/review/remove、错误路径（坏 Origin、超限、坏模型）；
4. 确认落盘文件在 `$DSH_HOME/immersive-translate/` 且重启后仍在；
5. 用户/QA 在 DSH 设置页检查：模型切换、提示词保存、测试翻译、复习卡、发音按钮；无浏览器控制时报告视觉验证受限；
6. 卸载验证：`remove_bundle` 后 API 404、slot 消失。

### 9.3 扩展手测（需用户加载）
- 英文文章页 → 翻译 → 三模式切换；划词弹卡 → 加入单词本 → 在 DSH 设置页看到并可复习；
- 模型切换后译文风格/速度变化；改提示词生效；停止/还原/DOM 无残留；
- DSH 未启动时错误提示；登录页/SPA 页面可翻译首屏。

## 10. 分工与写入范围

| 角色 | 写入范围 | 交付 |
|---|---|---|
| Lead | package.json / cordis.patch.yml / index.js / locale / icon / README / DESIGN / 安装与集成 | 可安装 bundle、最终报告 |
| host-api | `lib/**`、`test/**` | Host 全部逻辑 + 单测 |
| dsh-ui | `client.js` | 设置页（翻译设置 + 单词本复习/发音） |
| extension | `dsh-web-translator-extension/**` | MV3 扩展 + 安装说明 |
| qa-verify | `qa/**` | 静态/契约/live 验证报告 |

纪律：只读 DESIGN.md；不跨范围写文件；改动契约先报 Lead；不安装、不改 profile；完成后报告文件清单 + 测试命令结果。

## 11. 待用户确认（默认值已写入实现）

| # | 决策 | 默认 |
|---|---|---|
| 1 | 默认模型 | 跟随 DSH 当前默认模型（modelhub/deepseek-flash），Auto 推理强度取 off |
| 2 | 提示词编辑位置 | DSH 设置页（权威），扩展选项页只读回显 + 目标语言快捷设置 |
| 3 | 发音练习 | 标准发音播放 + 跟读评分（Web Speech API，失败降级为「自我评估」） |
| 4 | 复习算法 | 简单三级 SRS（不认识/模糊/认识） |
| 5 | 页面翻译范围 | 整页顺序翻译（进度/停止/失败重试），默认手动触发 |

## 12. 附录：已验证事实（2026-11-05）

- `ctx.llm` 契约（inspect）：`listProviders` / `listModels` / `resolveModelInfo` / `stream` / `prepareCall`；`GenerateOptions = { provider, model, reasoningEffort?, messages, system?, temperature?, maxTokens?, signal? }`；chunks：`text-delta` … 终态 `finish{reason}`。
- 当前 profile：`llm-pi-ai` 已配置 `modelhub`（`deepseek-flash` 等）、`modelhub-completion`、`modelhub-anthropic`；`agent-default-model = modelhub/deepseek-flash/reasoningEffort:max`。
- Settings slot：`settings.section` 可注册（id/order/label，ownerProps.close）；当前已有 general/models/plugins/agent-presets/skills-manager/pet/market/better-sidebar。
- 旧版探测（已不用于实现）：Bing Edge 匿名端点可用（批量/长文本/自动检测省略 from）；`dictionaryapi.dev` 可用（英文单词音标/释义）；Google 端点被拦。
- Node v26.13.0（原生 fetch）；DSH Web 地址 `http://127.0.0.1:3080`；profile `web`。
