# dsh-web-translator（dsh翻译）

[English](README.md) | **简体中文**

把 **DSH（DeepSeek Harness）配置的模型**变成一套本地沉浸式网页翻译：DSH 插件提供翻译后端、Token 统计与单词本，Chrome/Edge 扩展负责在网页上翻译与查词。
**不需要任何第三方翻译 API Key**，文本只在本机 DSH 与你在 DSH 中配置的模型服务之间流动（可选的英文单词词典查词除外，见「数据与隐私」）。

> 当前版本：**DSH 插件 1.12.5** · **浏览器扩展 1.17.8**。最近更新：网格/弹性父级中的长段落不再整段漏译，译文与下一段原文之间自动留出更清楚的间距；译文保留行内 `<code>` token（文件名/命令/标识符）；图片翻译覆盖层字号按 bbox 自适应、工具栏与关闭可用（扩展 1.17.5），信息量大的图片/图表不再因 4096 输出上限失败（插件 1.12.3）；图片翻译进行中保持常驻进度提示、不会 8 秒后消失；图片翻译改用跨平台 Tesseract WASM 本地 OCR + 现有文本翻译，视觉模型仅作兜底（插件 1.12.5 / 扩展 1.17.8）；图片快速模式可只返回译文；块级译文保留原文超链接（链接文字随译文翻译，链接地址不变）；右键图片翻译文字、译文原位覆盖、图片用完即删（插件 1.12.0 / 扩展 1.17.0）；英文单词查词可选第三方词典（dictionaryapi.dev / 英文 Wiktionary / 关闭）（插件 1.11.0）；翻译风格与页面上下文/术语保护（插件 1.10.0）；按站点自动翻译（扩展 1.16.0）、可选 iframe 翻译（扩展 1.15.0）；扩展打包、隐私政策与商店上架材料（扩展 1.15.0）；按屏翻译调度与块边界修复（扩展 1.14.x）；悬浮球左键快捷翻译、翻译进度环、按域名隐藏、页面语言一致检测（扩展 1.10–1.13）；翻译结果缓存持久化（插件 1.7.0）；翻译会话自动归入侧边栏「**dsh翻译记录**」分组（1.6.0）；每次翻译动作 = 一条真实 DSH 会话、每个模型请求 = 一轮对话，可直接查看 DSH 原生「对话 / 轨迹 / 统计」（1.5.0）。
> 说明：为避免包含真实浏览数据、会话标题等个人信息，仓库**不附带 UI 截图与 QA live 证据**；本地安装运行后即可直接查看界面，QA 截图可用 `dsh-web-translator/qa/*.mjs` 在本机重新生成（默认被 `qa/.gitignore` 忽略）。

---

## ⚠️ 本仓库包含两个组件，安装时两个都要装

| 组件 | 目录 | 作用 | 是否必需 |
|---|---|---|---|
| **DSH 插件** | [`dsh-web-translator/`](dsh-web-translator/) | 翻译 / 查词后端（调用 DSH 模型）、Token 账本与统计、翻译结果缓存、单词本持久化；DSH 左侧工具栏「dsh翻译」整页（概览 / 轨迹 / 设置 / 单词本） | ✅ 必需（扩展没有它无法工作） |
| **浏览器扩展** | [`dsh-web-translator-extension/`](dsh-web-translator-extension/) | 网页翻译（原文 / 双语对照 / 仅译文）、右键菜单、划词/双击查词、跟随翻译、悬浮球、浮窗 Token 消耗 | ✅ 必需（负责在网页上操作） |

> 只装插件 = 只有 DSH 里的统计/设置页面，网页不会被翻译；只装扩展 = 扩展连不上后端、无法翻译。
> **先装 DSH 插件，再装浏览器扩展。**

---

## 功能一览

**浏览器扩展（Chrome / Edge，MV3）**
- 整页翻译：**原文 / 双语对照 / 仅译文** 三种显示模式，随时切换不重复请求（正文块级对照，导航/标签/页脚/按钮行内对照）；块级译文**保留原文超链接**（链接文字随译文翻译，链接地址不变）；
- **按屏翻译调度（默认）**：点翻译时把当前屏幕可见内容（+ 可配置预加载：无 / 半屏 / 一屏）一次性触发；滚动后等滚动停止再翻新一屏，快速滚过的中间屏不补翻（省 token）。可选 **逐块模式**：保留按视口懒加载 + 微批合并，最省 token；可随时「停止 / 还原」；
- **跟随翻译**（默认开启）：页面 A 翻译后，点链接打开的同站/新标签页面 B 自动开始翻译；
- 右键菜单「dsh翻译」：三种模式直达 + 翻译选中文本；
- **右键图片翻译**：右键图片 →「翻译图片文字」，只截取该图片当前可见区域；DSH 优先在本地用跨平台 Tesseract WASM OCR 识别，再把文字走常规翻译链路，图片本身不发给模型；仅当 OCR 不支持/置信度低/显式指定图片模型时回退视觉模型；译文**原位覆盖**在图片原文字位置（可切双语/仅译文、复制、关闭；模型无法给出坐标时回退为图片旁卡片）；页面翻译不会自动扫描图片；图片在请求完成后立即删除；
- **划词 / 双击 / 快捷键翻译**（三个开关默认关闭，选项页开启）：弹出翻译/查词卡（译文、音标、词典释义、发音、加入单词本）；
- **悬浮球**：**左键**按当前模式快速翻译（再点停止、再点还原），**右键**打开功能面板；可拖动、翻译中显示进度环与百分比；面板底部或右键菜单可「隐藏 / 显示悬浮球」；**按域名隐藏**（面板/右键菜单添加，在 DSH → 设置 → dsh翻译 → 悬浮球 里管理列表）；
- **页面语言一致检测**：页面语言与目标语言一致时不发起翻译请求，默认同时隐藏悬浮球（可关闭）；
- 翻译完成后面板自动收起，只保留悬浮球；工具栏图标只开关面板，不会误触发翻译；
- **浮窗实时显示 Token 消耗**：本页消耗（输入/输出，逐次累加）、今日累计（来自 DSH 账本）。

**DSH 插件（Web profile）**
- 使用 DSH 已配置的模型（provider/model、推理强度可选），**模型 / 提示词都可在 DSH 内调整**；**图片翻译后端**：接收扩展截图，优先本地跨平台 OCR（Tesseract WASM）后走文本翻译；本地 OCR 不可用/低置信度时才调用可选的图片模型（默认跟随当前翻译模型），返回带归一化坐标的块，翻译 Token 进入账本并生成一条 DSH 会话/轮次，随后立即删除临时图片附件；
- **Token 账本**：从模型返回的真实 usage 记录 输入 / 输出 / 缓存读 / 缓存写、时延，按日 / 按模型 / 按类型聚合；
- **翻译结果缓存（持久化）**：相同原文 / 提示词 / 模型再次翻译时直接复用译文（0 token 调用）；缓存写入本机 `cache.json`，保留 7 天、最多 1000 批，跨 DSH 重启仍有效；「概览」页可一键清空；
- **左侧工具栏「dsh翻译」页面**：
  - **概览**：今日请求数、Token、缓存命中、失败数、平均时延、近 14 天趋势、模型与类型分布、翻译结果缓存管理；
  - **轨迹**：以**翻译会话**为单位（对齐 DSH 的「会话 → 轨迹」层级）—— 每次「翻译此页 / 重新翻译 / 查词」= 一条真实的 DSH 会话，会话内每个模型请求 = **一轮对话（Turn：user → assistant）**；会话卡片显示标题 / 站点 / 模型 / 轮数 / Token / 状态，展开可看每轮摘要，点「**打开 DSH 轨迹**」直接进入 DSH 原生「对话 / 轨迹 / 统计」查看每轮的完整原文、译文与 Token；旧版请求（无 DSH 会话）保留内联分组；支持过滤、加载更早、清空统计；
  - **设置**：模型、推理强度、目标语言、翻译风格、system 提示词、user 模板、批次参数、**第三方词典来源**、**图片模型**、测试翻译；另有「**悬浮球**」页：查看/移除/手动添加「不展示悬浮球的域名」；
  - **可选第三方词典**：英文单词查词时可选择 `dictionaryapi.dev`（音标/释义/发音，默认）、英文 `Wiktionary`（英文释义，无发音）或**关闭**（仅模型翻译）；词典请求由 Host 内部完成，不写入 DSH 会话记录；
  - **单词本**：复习（SRS）、发音 / 跟读练习；
  - **侧边栏分组**：每个翻译动作/查词 = 一条真实 DSH 会话，自动归入「**dsh翻译记录**」分组（历史会话首次启动自动回填），点开即可看 DSH 原生「对话 / 轨迹 / 统计」。
- 本地 HTTP API：`http://127.0.0.1:3080/dsh-immersive/api/*`（只监听本机回环）。

---

## 目录结构

```
dsh-web-translator/            # DSH 插件（本地 bundle，可安装到 DSH profile）
├── index.js / client.js       # Host 半 / Client 半
├── lib/                       # Host 逻辑：路由、模型调用、Token 账本、结果缓存、单词本、持久化
├── test/                      # node --test 单测
├── locale/  icon.svg          # 本地化与图标
├── cordis.patch.yml           # bundle patch（插件行 dsh-web-translator）
├── DESIGN.md                  # 设计契约 v2（接口 / UI / 扩展协议 / 安全）
├── DESIGN-TOKEN-USAGE.md      # v3 增量：Token 账本 / 左侧工具栏页面 / 浮窗 Token
├── DESIGN-TURN-TRACE.md       # v3.1 增量：Turn 轨迹（会话内每轮对话）
├── DESIGN-CONVERSATIONS.md    # v4 增量：翻译会话桥接 DSH 原生轨迹 +「dsh翻译记录」分组
├── DESIGN-CACHE.md            # v5 增量：翻译结果缓存持久化（磁盘 + TTL + DELETE /cache）
├── DESIGN-IMAGE.md            # v6 增量：右键图片翻译、原位覆盖与图片即用即删
└── qa/                        # 独立 QA 脚本与报告（截图 / live 证据不入库）

dsh-web-translator-extension/  # Chrome / Edge MV3 扩展（加载已解压）
├── manifest.json  background.js  content.js
├── options.html  options.js      # 选项页
├── icons/                        # 图标
└── tools/                        # 图标生成 / 静态校验 / headless E2E
```

---

## 安装 1/2：DSH 插件（先装这个）

前置：本机已安装并可运行 DSH（任意一种：`dsh web` / `npx dsh web` / DSH 桌面端），默认 profile 为 `web`，Web 地址 `http://127.0.0.1:3080`。

### 方法 A：让 DSH 里的 Agent 安装（推荐）

先取得本仓库在本机的**绝对路径**，例如：

```bash
git clone https://github.com/sikasjc/dsh-web-translator.git ~/workspace/dsh-web-translator-repo
# 插件目录 = ~/workspace/dsh-web-translator-repo/dsh-web-translator
```

然后在**任意 DSH 会话**里让 Agent 执行（或你自己用 DSH 的插件管理能力执行）：

```
plugin_manager  action: install_bundle  target: /绝对路径/dsh-web-translator-repo/dsh-web-translator
```

看到结果里 `application: applied` 即安装成功。

### 方法 B：DSH Web GUI

DSH Web → 左侧工具栏「**插件**」页 → 添加/安装插件 → 选择/输入本机插件目录的**绝对路径** `…/dsh-web-translator-repo/dsh-web-translator` → 安装并启用。
（不同 DSH 版本的插件页文案略有差异；核心是把这个本地 bundle 目录装进 `web` profile。）

### 安装成功的验证

1. DSH 左侧工具栏出现「**dsh翻译**」图标（在「插件市场」下方），点击能看到 概览 / 轨迹 / 设置 / 单词本；
2. DSH「设置」列表里出现「dsh翻译」；
3. 终端验证本地 API：

```bash
curl http://127.0.0.1:3080/dsh-immersive/api/health
# {"ok":true,"version":"1.7.0","uptimeMs":…,"llm":{"providers":…,"models":…}}
```

### 更新插件 / 重载

- 替换插件目录里的代码后，在 DSH 里重新执行一次安装/重载（或 `plugin_manager` 先禁用再启用该插件行）即可生效；
- DSH 支持 HMR 时，插件文件变化会在下一次 profile recompose 时自动重载。

### 卸载插件

```
plugin_manager  action: remove_bundle  target: @local/dsh-web-translator
```

数据（设置 / 单词本 / Token 账本 / 结果缓存）保存在 `$DSH_HOME/immersive-translate/`，删除目录即彻底清除。

---

## 安装 2/2：浏览器扩展（Chrome / Edge）

> 扩展是从**本地目录加载**的（未上架 Chrome 商店），所以需要手动「加载已解压的扩展程序」。

1. 确认 DSH Web 正在运行：`http://127.0.0.1:3080`（扩展固定只连 `127.0.0.1:3080` / `localhost:3080`）；
2. Chrome 打开 `chrome://extensions`（Edge 打开 `edge://extensions`）；
3. 打开右上角「**开发者模式**」；
4. 点击「**加载已解压的扩展程序**」，选择本仓库的 **`dsh-web-translator-extension/`** 目录（注意是选目录，不是单个文件）；
5. 扩展列表中出现「**dsh翻译**」即安装成功，建议点扩展图标旁的「固定」把它放到工具栏；
6. 打开任意网页（`http(s)://`）→ 点右下角悬浮球（或按 `Alt+T` / 点工具栏图标）→ 点「翻译此页」。

### 扩展设置

扩展图标右键 →「选项」（或 DSH 未开时从面板「设置」进入）：
DSH 地址（默认 `http://127.0.0.1:3080`）、目标语言、默认显示模式、自动翻译、**翻译调度（按屏 / 逐块）**、**预加载（无 / 半屏 / 一屏）**、**跟随翻译**、**划词 / 双击 / 快捷键翻译开关**、**显示悬浮球**、**页面语言一致时隐藏悬浮球**、界面语言、「测试连接」。
**模型与提示词不在扩展里改**，统一在 DSH 左侧「dsh翻译」→「设置」页修改（单一数据源）。

### 更新扩展

替换 `dsh-web-translator-extension/` 目录里的文件后，到 `chrome://extensions` 点该扩展的「**重新加载**」，再刷新已打开的网页。

---

## 使用

- **整页翻译**：悬浮球 / `Alt+T` / 工具栏图标打开面板 →「翻译此页」；默认按屏调度会一次翻完当前屏；滚动后只翻新一屏（+预加载），快速滚过的屏不补翻——需要时点「翻译此页 / 重新翻译」或切换逐块模式；
- **模式**：原文 / 双语对照 / 仅译文随时切换（不产生新请求）；
- **右键菜单**：「dsh翻译」→ 原文 / 双语对照 / 仅译文 / 翻译选中文本；
- **划词 / 双击 / 快捷键翻译**（默认关闭，先在扩展选项页开启）：选中文本或双击单词 → 卡片（译文、音标、释义、发音、「加入单词本」）；快捷键默认 `Command+K` / `Ctrl+K`；
- **跟随翻译**（默认开启）：翻译页面后点链接打开的新页面自动翻译；
- **悬浮球**：左键按当前模式快速翻译（再点停止/还原），右键打开面板；可拖动、翻译中显示进度；面板底部/右键菜单可隐藏/显示；面板或右键菜单可「当前域名不展示悬浮球」；
- **Token 消耗**：浮窗显示「本页消耗 / 今日累计」；完整统计在 DSH 左侧「dsh翻译」页；
- **单词本**：扩展里加入，DSH「dsh翻译 → 单词本」里复习。

---

## 数据与隐私

- 翻译 / 查词文本会经本机 DSH 发送到**你在 DSH 中配置的模型服务**（例如 modelhub），不发送到其它第三方翻译服务；
- **英文单词查词**可按 DSH → dsh翻译 → 设置 → 第三方词典 中选择的来源请求公共词典：[`dictionaryapi.dev`](https://dictionaryapi.dev/)（音标/释义/发音，默认）、英文 Wiktionary（英文释义，无发音）或**关闭**（完全不发起第三方词典请求）；只发送该单词（不含页面正文），失败静默降级为「无词典」。该词典请求由 Host 内部完成，**不会写入 DSH 会话/对话记录**（会话记录只含模型请求与译文）；
- **图片翻译**只在右键图片并选择「翻译图片文字」时发生：图片先在本机 DSH 内做跨平台 OCR，只有 OCR 文本会走翻译模型；只有本地 OCR 不可用/低置信度或显式指定图片模型时才把临时图片发给所选视觉模型，请求完成后**立即删除**；本地只缓存 OCR 文本与译文，图片不写入 DSH 会话记录、也不写入扩展存储；
- 扩展只保存自己的 UI 偏好（`chrome.storage.local`），**不保存页面内容**；扩展不直连模型、不保存任何密钥；
- 插件数据只写入 `$DSH_HOME/immersive-translate/`：
  - `settings.json`（模型 / 提示词 / 语言等设置）
  - `wordbook.json`（单词本与复习进度）
  - `usage.json`（Token 账本与最近 500 条事件，可在「轨迹」页清空）
  - `cache.json`（翻译结果缓存：原文批次 → 译文，本机保存，7 天 / 1000 批；可在「概览」页清空）
  - `ball-sites.json`（不展示悬浮球的域名列表，可在 DSH 设置页管理）
  - `conversations/`（翻译会话的存储目录；DSH 会话日志由 DSH 自身管理）
- 本地 API 只监听 `127.0.0.1`，带 Origin 白名单；无文件系统 / 命令执行能力；
- 每次翻译动作会在本机创建一条 DSH 会话（标题「翻译 · 页面标题 / 站点」，由 DSH 的会话存储持久化；翻译会话统一归入 DSH 侧边栏的「**dsh翻译记录**」分组（历史会话首次启动自动回填）；空闲约 15 分钟后 agent 释放（会话仍持久化，仍可从插件「轨迹」页打开）；点「打开 DSH 轨迹」查看 DSH 原生「对话 / 轨迹 / 统计」）。页面原文与译文会写入该**本地**会话日志，仅本机可用，本插件不会把它们额外发送给模型或第三方；会话日志由 DSH 管理，可自行清理；「清空统计」只清空插件的 Token 账本，不删除会话日志。
- 说明：「dsh翻译记录」是一个真实的 DSH workspace（目录 `$DSH_HOME/immersive-translate/conversations/`）。DSH 以「最近活跃 workspace」作为新会话默认目录，因此翻译频繁时首页「新会话」的工作区可能默认显示「dsh翻译记录」，可在工作区下拉中切回；翻译空闲后会自动回到常用工作区。

---

## 安全说明

- 本地 API 只监听回环地址（`127.0.0.1` / `localhost`），并带 Origin 围栏：同主机 Origin 与浏览器扩展 Origin 放行，其它网页 Origin 拒绝。无 `Origin` 头的请求（例如本机 `curl`）按设计放行；默认接受任意浏览器扩展 Origin，如需只允许自己的扩展，可在插件配置里收窄 `extensionOrigins`。
- API 没有独立的 bearer token，属于**本机信任边界**：不要把 3080 端口暴露到回环之外，并把以你 OS 用户身份运行的其他软件视为可信。
- 扩展只请求自己配置的 DSH 地址（默认 `http://127.0.0.1:3080`），使用 `credentials: 'omit'`；不读取 cookie、不上报浏览历史、不读取页面存储，且把模型输出以 `textContent` 写回页面（无 HTML 注入）。
- `qa/cdp.mjs` 是**仅用于本机 QA** 的 headless Chrome 辅助脚本：它**不读取 DSH 凭据、不派生 cookie**；操作者需把 `dsh web` 打印的启动 token 链接作为 `DSH_URL` 传入，或通过 `DSH_COOKIE` 提供已认证的浏览器 cookie。它不包含在可安装的插件包内。
- 发现安全或隐私问题？请私下联系仓库所有者，不要开公开 issue。

## 开发与测试

```bash
# DSH 插件（Host + 单测）— 当前 287/287
cd dsh-web-translator
node --check index.js && node --check client.js
node --test test/

# 浏览器扩展（静态校验 + headless Chrome E2E，不触发真实模型调用）
cd ../dsh-web-translator-extension
node tools/verify.mjs        # 217 项静态检查
node tools/e2e-chrome.mjs    # 138/138 E2E 检查（mock DSH）
```

- 设计契约：[`DESIGN.md`](dsh-web-translator/DESIGN.md) / [`DESIGN-TOKEN-USAGE.md`](dsh-web-translator/DESIGN-TOKEN-USAGE.md) / [`DESIGN-TURN-TRACE.md`](dsh-web-translator/DESIGN-TURN-TRACE.md) / [`DESIGN-CONVERSATIONS.md`](dsh-web-translator/DESIGN-CONVERSATIONS.md) / [`DESIGN-CACHE.md`](dsh-web-translator/DESIGN-CACHE.md) / [`DESIGN-IMAGE.md`](dsh-web-translator/DESIGN-IMAGE.md)
- 独立 QA 报告：[`TOKEN-STATS-QA.md`](dsh-web-translator/qa/TOKEN-STATS-QA.md) / [`TURN-TRACE-QA.md`](dsh-web-translator/qa/TURN-TRACE-QA.md) / [`CONVERSATION-QA.md`](dsh-web-translator/qa/CONVERSATION-QA.md)（含 harness 使用方式与断言结论）
- Live 证据：不入库（含真实页面/会话信息）；本地运行 `node qa/conversation-shot.mjs` 生成到 `qa/live-conversations-evidence/`

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 左侧工具栏没有「dsh翻译」 | 插件未安装成功 / 安装后页面未刷新：确认 install 结果 `application: applied`，然后强刷 DSH 页面（`Cmd+Shift+R`） |
| 扩展提示「无法连接 DSH」 | DSH Web 未运行、端口不是 3080，或地址在扩展选项页里写错；先 `curl http://127.0.0.1:3080/dsh-immersive/api/health` 验证后端 |
| 扩展装了但网页无反应 | 需要刷新已打开的网页（扩展只注入新加载的页面）；`chrome://` 等受限页面无法翻译 |
| 滚动后有些段落没翻译 | 默认按屏调度：滚动停止后只翻新一屏（+预加载），快速滚过的中间屏不补翻；点「翻译此页 / 重新翻译」，或在扩展选项页切换为「逐块」模式即可 |
| 页面已经和目标语言一致，没反应 | 扩展会读取 `<html lang>` / `content-language` / `og:locale`，与目标语言一致时不发起翻译请求（默认还隐藏悬浮球）；改目标语言或关闭「页面语言一致时隐藏悬浮球」 |
| 重复翻译同一页面还花 token 吗？ | 相同原文/提示词/模型命中结果缓存时不花 token（响应 `cached:true`、usage 全 0）；缓存跨重启保留 7 天，可在「概览」页清空 |
| 浮窗没有 Token 行 | DSH 插件版本过旧（`/health` 版本 < 1.1.0）或接口未加载；升级/重载插件后刷新页面 |
| 新会话默认工作区变成「dsh翻译记录」 | DSH 把最近活跃 workspace 作为新会话默认目录；翻译频繁时会出现。在工作区下拉切回 `workspace` 即可，翻译空闲后会自动恢复；不影响已有会话 |
| 翻译报 `MODEL_UNAVAILABLE` / `MODEL_AUTH` | DSH 侧未配置可用模型或凭据，去 DSH 模型设置检查 |
| 自定义提示词后翻译失败 | 提示词必须保留 JSON 输出契约（见 DSH「dsh翻译 → 设置」页提示）；可「恢复默认」 |

---

## 说明

- 本仓库当前为**私有仓库**；如需公开请由仓库所有者调整可见性。
- DSH（DeepSeek Harness）为运行环境，本仓库不包含其源码；插件以本地 bundle 形式安装，不修改 DSH 源码或 profile 文件（安装动作由 DSH 插件管理器完成）。

---

[English](README.md) | **简体中文**
