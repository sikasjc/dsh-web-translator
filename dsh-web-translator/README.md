# dsh-web-translator（dsh翻译）· DSH 插件 + 浏览器扩展

一套运行在本机的网页翻译方案：

- **浏览器扩展（Chrome/Edge MV3）**：在任意真实网页上做**原文 / 双语对照 / 仅译文**三种模式的网页翻译；右键菜单「dsh翻译」直达三种模式；划词、双击查词（可开关）；一键加入单词本；翻译后面板自动收起只留悬浮球；**浮窗内实时显示本页 / 今日 token 消耗**。
- **DSH 插件**：提供**翻译后端**（使用你在 DSH 中配置的模型，模型可切换、提示词可调整）、**页面上下文与翻译风格**（自动/通用/编程/科技/金融；技术页面保护 Rust `trait`/`crate`/`impl` 原文、`port`→端口）、**token 账本与轨迹统计**、**单词本持久化**、**翻译记录开关与一键清理**；在 DSH **左侧工具栏**提供「dsh翻译」整页（概览 / 轨迹 / 设置 / 单词本），并在 DSH「设置」中保留同名页面。插件页会检测当前浏览器是否安装扩展：未检测到时弹出安装引导（GitHub 安装步骤 + 重新检测）。

不需要任何第三方翻译 API key：翻译经由本机 DSH 的模型服务完成；扩展只与 `http://127.0.0.1:3080` 上的本地接口通信。

```
Chrome/Edge 扩展 ──HTTP──► DSH 插件 Host API ──► ctx.llm（你在 DSH 配置的模型）
      ▲                           │
      └── 单词本 / 翻译结果 ────────┘
DSH 左侧工具栏「dsh翻译」页 ──同源──► Token 统计、轨迹、模型/提示词设置、单词本复习
DSH 设置页「dsh翻译」──同源──► 同一实现的入口（单词本复习、发音练习、模型/提示词设置）
```

---

## 目录

- [安装](#安装)
- [使用](#使用)
- [左侧工具栏页面（Token 统计 / 轨迹）](#左侧工具栏页面token-统计--轨迹)
- [设置](#设置)
- [单词本与复习](#单词本与复习)
- [本地 API](#本地-api)
- [数据与隐私](#数据与隐私)
- [卸载](#卸载)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)

## 安装

### 1. DSH 插件

插件以本地 bundle 形式安装进当前 profile（`web`）：

1. 确认插件包目录存在：`<workspace>/dsh-web-translator/`；
2. 在 DSH 会话中安装（由安装者执行）：
   ```
   plugin_manager  action: install_bundle  target: <绝对路径>/dsh-web-translator
   ```
3. 安装结果 `application: applied` 后，DSH 侧边栏底部的设置里会出现「**dsh翻译**」页面；
4. 本地接口前缀：`http://127.0.0.1:3080/dsh-immersive/api`。

> 插件不写 profile 文件、不修改 DSH 源码；数据只写入 `$DSH_HOME/immersive-translate/`。

### 2. 浏览器扩展（Chrome / Edge）

1. 打开 `chrome://extensions`（Edge：`edge://extensions`）；
2. 打开右上角「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择 `<workspace>/dsh-web-translator-extension/`；
4. 在扩展详情中确认已启用；建议把「dsh翻译」固定到工具栏。

## 使用

### 整页翻译

1. 打开任意网页（`http(s)://`）；
2. 点击右下角悬浮球（或按 `Alt+T` / 点击工具栏图标）打开面板；
3. 点击「**翻译此页**」，插件按段落流式翻译并显示进度；
4. 三种模式随时切换（**不重新请求**）：
   - **双语对照**：原文下方显示译文；
   - **仅译文**：隐藏原文，仅显示译文；
   - **原文**：隐藏译文；
5. 「停止」中止未完成的翻译；「还原」移除全部注入内容，恢复原始页面。

### 左侧工具栏页面（Token 统计 / 轨迹）

安装插件后，DSH 左侧工具栏会出现「**dsh翻译**」图标。点击进入整页：

| Tab | 内容 |
|---|---|
| **概览** | 今日请求数 / 输入 tokens / 输出 tokens / 缓存读 tokens / 失败数 / 平均时延；近 14 天消耗柱状图；按模型与按类型（翻译/查词）的分布 |
| **轨迹** | 以**翻译会话**为单位（对齐 DSH 的「会话 → 轨迹」层级）：每次「翻译此页 / 重新翻译 / 查词」= 一条真实的 DSH 会话，会话内每个模型请求 = **一轮对话（Turn）**；会话卡片显示标题 / 站点 / 模型 / 轮数 / 输入输出 tokens / 状态，展开可看每轮摘要，点「**打开 DSH 轨迹**」直接进入 DSH 原生「对话 / 轨迹 / 统计」查看每轮完整原文、译文与 Token；旧版请求（无 DSH 会话）保留内联分组；支持 全部/翻译/查词/仅失败 过滤、「加载更早」分页、清空统计（二次确认） |
| **设置** | 模型、推理强度、目标语言、**翻译风格（自动/通用/编程/科技/金融）**、system 提示词、user 模板、批次参数、测试翻译（与设置页同源实现）；**翻译记录**：关闭记录开关（默认记录）+ 清理所有记录（清空 token/轨迹并归档隐藏 DSH「dsh翻译记录」会话） |
| **单词本** | 单词列表、复习、发音练习（与设置页同源实现） |
| **悬浮球** | 不展示悬浮球的域名列表：查看、移除、手动添加（扩展在面板/右键菜单添加，Host 持久化到 `ball-sites.json`） |

> **翻译结果缓存（v1.7.0 起持久化）**：相同原文 / 提示词 / 模型再次翻译时直接复用译文（0 token）；缓存写本机 `<dataDir>/cache.json`，保留 7 天、最多 1000 批，跨 DSH 重启有效；「概览」页底部可「清空翻译结果缓存」；缓存损坏/读写失败只告警，不影响翻译。
> Token 统计来自模型服务返回的真实 usage（输入 / 输出 / 缓存读 / 缓存写四项），按本地日期聚合、保留最近 90 天与最近 500 条事件；缓存命中的请求 tokens 记 0 但仍计数。插件账本与 DSH 原生统计口径一致。
> **复用 DSH 原生轨迹**：扩展为每次翻译动作/查词生成 `turnId`，Host 用它在本地创建一条 DSH 会话（标题「翻译 · 页面标题 / 站点」，会话 id 形如 `translation-<turnId>`），每个模型请求写成该会话的一轮原生对话（`user/message` + `assistant/message`，含 usage）。轨迹页的「打开 DSH 轨迹」按钮通过 `uiWorkspace.openSession(sessionId)` 打开该会话，即可使用 DSH 原生「对话 / 轨迹 / 统计」。会话统一归入插件自建的 DSH workspace **「dsh翻译记录」**（目录 `$DSH_HOME/immersive-translate/conversations/`，历史会话首次启动时自动回填；侧边栏直接可见）；空闲 15 分钟后释放 agent，再次打开会自动从持久化恢复。页面原文/译文只写入**本机** DSH 会话日志，不会被额外发送。

> 为避免真实浏览数据/个人信息入库，README 不附带截图；本地运行即可查看页面，QA 截图可用 `qa/*.mjs` 在本机重新生成。
> 会话在侧边栏的 **「dsh翻译记录」** 分组下可见（空闲约 15 分钟后 agent 释放，会话仍持久化；仍可从「轨迹」页打开）；插件页「轨迹」入口由账本最近 500 条事件保留。

### 划词 / 查词

- 选中文本或双击单词 → 弹出卡片：译文、音标、词典释义、发音（🔊）；
- 卡片中可「**加入单词本**」（单词级），之后在 DSH 设置页复习；
- 点击卡片外、按 `Esc` 或滚动页面关闭。

### 已知限制

- V1 只翻译主文档，不翻译跨域 `iframe` 内部（后续版本支持）；
- SPA 页面跳转后需要重新点击「翻译此页」（后续版本自动跟踪）；
- 页面翻译使用 LLM，长页面会产生相应的模型调用耗时与费用；
- 仅支持 Chromium 内核浏览器（Chrome / Edge）。
- 每次「翻译此页 / 重新翻译 / 查词」会在本机创建一条 DSH 会话用于原生轨迹；会话日志由 DSH 管理，"清空统计" 只清 Token 账本，不删除会话日志。
- 翻译会话归入的「dsh翻译记录」是一个真实的 DSH workspace（目录 `$DSH_HOME/immersive-translate/conversations/`）。DSH 会把「最近活跃的 workspace」作为新会话的默认目录，因此翻译频繁时首页「新会话」的工作区可能默认显示「dsh翻译记录」，可在工作区下拉中切回；翻译空闲后会自动回到你常用的工作区。
- 插件页「轨迹」只列出账本覆盖范围（最近 500 条事件）内的会话；更早的 DSH 会话仍可在侧边栏「dsh翻译记录」分组或 DSH 会话存储中找到。

## 设置

### 翻译设置（DSH → 左侧工具栏「dsh翻译」→ 设置，或 DSH → 设置 → dsh翻译 → 翻译设置）

| 项 | 说明 |
|---|---|
| 模型 | 从当前 DSH 已配置的模型（provider/model 目录）中选择；默认跟随 DSH 当前默认模型 |
| 推理强度 | `auto`（优先 off）/ 模型支持的其它强度；翻译建议低强度以降低延迟与成本 |
| 目标语言 | 默认简体中文，可切换繁体中文、English、日本語、한국어、Français、Deutsch、Español、Русский 等 |
| 系统提示词 | 模型角色与输出契约（`{{targetLanguage}}`、`{{segmentCount}}` 等占位符） |
| 用户消息模板 | 待翻译段落的组织方式（`{{segmentsJson}}`、`{{sourceLanguage}}` 等占位符） |
| 测试翻译 | 输入几句话直接验证当前模型/提示词效果（结果同时显示本次 tokens） |

> 左侧工具栏页面与设置页读取/保存同一份 `settings.json`；在任一处修改都会在另一处生效（刷新后可见）。

> 自定义提示词必须保持「返回 JSON 对象 `{"translations":[...]}`」的输出契约，否则会解析失败并提示；可随时「恢复默认」。

### 扩展选项页

扩展的「选项」页可设置：DSH 地址（默认 `http://127.0.0.1:3080`）、默认目标语言、默认模式、自动翻译、界面语言，并可「测试连接」。模型与提示词的编辑在 DSH 设置页进行（单一权威来源）。

## 单词本与复习

- 扩展查词时点击「加入单词本」；同一单词 + 目标语言自动去重（保留复习进度）；
- DSH → 设置 → dsh翻译 → **单词本**：
  - 列表：搜索、待复习/全部/已掌握过滤、发音、备注、标记掌握、删除；
  - 复习：按间隔重复（简单三级：**不认识 / 模糊 / 认识**）排期，卡片流式复习；
  - 发音练习：播放标准发音（词典音频或浏览器 TTS）；支持 Chrome/Edge 的语音识别「跟读评分」（需要麦克风授权，失败时自动降级）。

## 本地 API

统一前缀：`http://127.0.0.1:3080/dsh-immersive/api`。成功 `{ok:true,...}`，失败 `{ok:false,error:{code,message}}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/models` | 已配置的模型目录 |
| GET | `/models/resolve?provider=&model=` | 单模型能力（上下文/输出上限/推理强度） |
| GET | `/settings` | 生效设置 + 默认值 + 选中模型信息 |
| PUT | `/settings` | 更新设置（模型/提示词/语言/批量参数/`recordHistory`） |
| DELETE | `/records` | 清理所有翻译记录：清空 usage 账本 + 归档隐藏「dsh翻译记录」会话 |
| POST | `/translate` | 批量翻译 `{texts, targetLanguage?, sourceUrl?, sourceTitle?, client?, turnId?, stepIndex?, mode?}`，响应含 `usage` 四字段与 `cached` |
| POST | `/lookup` | 查词/查句 + 英文词典信息，响应含 `usage`；接受相同可选元数据 |
| GET | `/usage/turns?limit=&kind=&status=&before=` | **Turn 聚合**分页（`kind`: `translate`/`lookup`/`error`；`before` 为上一页 turn id；返回 turns + steps） |
| GET | `/ball-sites` | 不展示悬浮球的域名列表 `{sites, updatedAt}` |
| POST | `/ball-sites/add` `{domain}` | 添加域名（去重、最多 200 个） |
| POST | `/ball-sites/remove` `{domain}` | 移除域名 |
| DELETE | `/cache` | 清空翻译结果缓存（磁盘 + 内存），返回 `{cleared:true, entries:0}` |
| GET | `/conversations` | **翻译会话**列表（live + 账本推导）：`sessionId` / `title` / `requests` / tokens / `status` / `live`，供轨迹页「打开 DSH 轨迹」 |
| GET | `/usage?days=14` | token 账本汇总：totals / today / 按日 / 按模型 / 按类型 / 最近事件 |
| GET | `/usage/events?limit=&kind=&before=` | 轨迹分页（`kind`: `translate`/`lookup`/`error`；`before` 为上一页事件 id） |
| DELETE | `/usage` | 清空 token 账本（不可恢复） |
| GET | `/wordbook` | 单词本列表/统计（`query`、`filter`、`limit`） |
| POST | `/wordbook/add` | 加入单词本（去重） |
| POST | `/wordbook/update` | 备注/译文/掌握状态 |
| POST | `/wordbook/review` | 提交复习评分（again/hard/good） |
| POST | `/wordbook/remove` | 删除单词 |

安全：接口监听本机回环，Origin 白名单（同源 / 浏览器扩展 / 无 Origin 的本地工具），其余 403；无文件系统、无命令执行能力。

## 数据与隐私

- 翻译与查词文本会发送到**你在 DSH 中配置的模型服务**（例如 modelhub），不会发送到其它第三方翻译服务；
- 英文单词会额外查询 `dictionaryapi.dev` 获取音标/释义/音频；
  该请求由 Host 内部完成，不会写入 DSH 会话/对话记录；
- 插件数据仅保存在 `$DSH_HOME/immersive-translate/`：
  - `settings.json`：模型、提示词、语言等设置；
  - `wordbook.json`：单词本与复习进度；
- 扩展只保存自己的 UI 偏好（`chrome.storage.local`），不保存页面内容；
- 页面文本不写入 DSH 会话日志；Host 侧仅进程内 LRU 缓存（重启即清）。

## 卸载

1. 浏览器：`chrome://extensions` → 移除「dsh翻译」；
2. DSH 插件：`plugin_manager action: remove_bundle`（或禁用对应插件行）；
3. 如需清除数据：删除 `$DSH_HOME/immersive-translate/` 目录。

## 故障排查

| 现象 | 处理 |
|---|---|
| 扩展提示「无法连接 DSH」 | 确认 DSH 正在运行、地址为 `http://127.0.0.1:3080`；扩展选项页「测试连接」 |
| 翻译失败 `MODEL_UNAVAILABLE` | DSH 中未配置可用模型或 provider 路由不可用；检查 DSH 的模型设置 |
| 翻译失败 `MODEL_AUTH` | 模型 provider 缺少凭据；在 DSH 模型设置中补全 |
| `INVALID_MODEL_OUTPUT` | 自定义提示词未遵守 JSON 输出契约；恢复默认或按提示修改 |
| 单词本不显示扩展加入的词 | 扩展 DSH 地址与 DSH 实际地址不一致 |
| 发音无声音 | 系统/浏览器静音；跟读需要麦克风权限（仅 Chrome/Edge） |

## 开发与测试

- 设计契约：[DESIGN.md](./DESIGN.md)（v2：接口、UI、SRS、扩展消息协议）、[DESIGN-TOKEN-USAGE.md](./DESIGN-TOKEN-USAGE.md)（v3：token 账本 / 左侧工具栏页面 / 浮窗 token 展示）
- 插件 Host 单测：`cd dsh-web-translator && node --test test/`
- 静态检查：`node --check index.js && node --check client.js`
- 扩展：`node --check background.js content.js options.js` + `manifest.json` JSON 校验
- DSH 版本事实：`llm` 服务 `stream/listProviders/listModels/resolveModelInfo`；Client slot `settings.section`、`main`、`sidebar.panellist`；本地 webServer 前缀路由。
