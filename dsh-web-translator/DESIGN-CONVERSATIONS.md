# 翻译会话桥接 DSH 原生轨迹 — 设计契约 v4

> 状态：2026-11-06（v1.6.0 起会话归属改为「dsh翻译记录」workspace），用户确认方案 A：**复用 DSH 原生轨迹** —— 翻译本质上是大模型对话，
> 因此把每次翻译动作记录成一条**真实的 DSH 会话**（归入侧边栏「dsh翻译记录」分组；v1.6.0 前为未分组），会话内每个模型请求 = 一轮对话（Turn），
> 直接在 DSH 原生「对话 / 轨迹 / 统计」视图查看每轮内容与 Token。
> 本文件是增量契约；未提及部分继续遵守 `DESIGN.md` / `DESIGN-TOKEN-USAGE.md` / `DESIGN-TURN-TRACE.md`。

---

## 0. 已完成的可行性验证（POC，live 环境 2026-11-06 11:54）

- Host：`ctx.get('agents').create({ sessionId, meta:{cwd}, agentOptions })` 创建一个插件自有 Agent（会话由 agent 生命周期持久化）；
  随后直接 `agent.session.append(...)` 写入对话事件。
- 一次翻译 run（`turnId = tr_poc_native_1`，3 个 batch）→ 会话 `translation-tr_poc_native_1`：
  - `GET /conversations` → `{turnId, sessionId, title:"翻译 · PoC Native Trajectory", turns:3, live:true}`；
  - `GET /usage/turns` 的 Turn 带 `sessionId`。
- 客户端点「在 DSH 中查看轨迹」→ `uiWorkspace.openSession(sessionId)` → 原生会话打开：
  - 视图 Tab：**对话 / 轨迹 / 统计**；
  - 「对话」：3 轮 user→assistant 消息 + 每轮 "已完成，用时 1秒" + 底部 **3 轮 3 步 474 tok**（DSH 原生 token 统计）；
  - 「轨迹」：`第 1 轮 #1 用户… 助手…` / 第 2 轮 / 第 3 轮，工具栏 时长/轮次/调用/子调用/输入/模型/工具；
  - 侧边栏出现会话行（标题已 rename；v1.6.0 起统一归入「dsh翻译记录」分组）。
- 结论：方案可行，能力复用程度高（token 统计、轨迹、统计视图全部原生）。

---

## 1. 数据与语义

| 概念 | 映射 |
|---|---|
| 翻译会话（Conversation） | 一次翻译动作 = 一条 DSH Session：一次「翻译此页 / 重新翻译」的完整 run（含懒加载批次），或一次查词卡查询 |
| 一轮对话（Turn） | 该会话内的一次模型请求：`turn/start` → `step/start` → `user/message`（翻译提示/源文）→ `assistant/message`（译文 + usage + stream）→ `step/end` → `turn/end` |
| 会话标题 | `翻译 · <页面标题|站点>` / `翻译查词 · <页面标题|站点>`（`sessionTitle.rename` 固定） |
| 会话 id | `translation-<turnId 的路径安全形式>`，turnId 由扩展生成（同 run 内相同） |
| 会话归属 | 插件自有 Agent；统一归入插件自建的 DSH workspace **「dsh翻译记录」**（`workspaceRegistry.create(<dataDir>/conversations, 'dsh翻译记录')`，目录 `$DSH_HOME/immersive-translate/conversations/`）；每个会话通过 `Workspace.attachSession(sessionId)` 加入，历史会话在 workspace 首次创建时一次性回填；可从插件页或侧边栏直接打开 |
| 会话 cwd | `$DSH_HOME/immersive-translate/conversations/`（同时也是「dsh翻译记录」workspace 的目录，不污染用户工作区） |

- 扩展无需改动：`turnId / stepIndex / mode / client / sourceUrl / sourceTitle / targetLanguage` 已随请求发送。
- 无 `turnId` 的请求（DSH 设置页的测试翻译等）不创建会话，只记账本。
- 失败请求：仍写 `user/message` + `turn/end{reason:'error'}`（不写 assistant），轨迹里显示失败轮。
- 旧历史事件（无 `sessionId`）继续用插件页内联 Turn 列表展示，标注「旧版，无 DSH 会话」。

---

## 2. Host（`lib/conversations.js` + api 接线，已完成 POC 版本）

**桥接规则**
- 首次见到 `turnId` → `agents.create({sessionId, meta:{cwd}, agentOptions:{provider,model,reasoningEffort?}})`；
  `agent.inbox.clear()`；`sessionTitle.rename(session, title)`。
- 每次请求追加一轮事件（turn 序号 = 本会话第 N 轮，step=1）：
  - user 文本：`将以下内容翻译为 <lang>：\n1. …` / 单段；查词为 `查词（<lang>）：<text>\n上下文：…`；
  - assistant 文本：译文（多段编号）；查词为译文；
  - assistant 事件带 `usage`（四桶，cache 为 0 时省略）与 compact stream（一个 `text-chunks` run，供时间线/ttft 展示）。
- 任何桥接失败只 warn 一次并返回 null——**绝不允许翻译失败**。
- 生命周期：live 会话最多 24 条（LRU dispose，会话仍持久化）；空闲 15 分钟 dispose agent（再次打开时 DSH 冷 resume）；
  插件卸载时 dispose 全部。
- 同时把 `sessionId`、`turn` 写进记账本事件（供插件页列出会话/定位）；`turn` 为数字。

**Workspace 分组（v1.6.0）**
- 首次翻译（或启动时账本中已有 `sessionId` 历史）→ `workspaceRegistry.create(cwd, 'dsh翻译记录')`（幂等；用户重命名后不会被覆盖，`create` 对已存在 canonical path 只返回现有 entity）。
- 新建会话创建后 `Workspace.attachSession(sessionId)` 加入分组；`sessionPersistence.list()` 中 cwd 指向该目录的历史会话一次性回填（按 createdAt 升序 attach，保证侧边栏最新在前）。
- `workspaceRegistry` / `sessionPersistence` 缺失或报错时：只 warn 一次，**绝不影响**翻译与账本记录；工作区分组能力降级为无分组。
- 该 workspace 目录不存放业务文件，仅用于 DSH 的 cwd 分组（会话日志由 DSH 的会话存储管理）。
- 顺序：新创建的 workspace `insertBefore(id)` 追加到工作区列表末尾，避免抢占 DSH「第一个/最近活跃 workspace」的默认新会话目录；若检测到它已位于首位（历史版本创建），启动时迁移到末尾。
- 副作用（DSH 语义）：`recentWorkspace()` 按会话最近活动选择默认工作区，翻译活跃时首页「新会话」默认工作区会显示「dsh翻译记录」；翻译空闲后自动回到用户常用工作区。用户可用工作区下拉切换。

**API**
- `GET /conversations` → `{ok:true, conversations:[{sessionId, title, turns/requests, status, kinds, firstAt/lastAt, 4 token 桶, live, turnId?, sourceTitle?, site?, model?}]}`（**live + 账本历史**超集：live 行来自会话桥，历史行由记账本 `sessionId` 聚合；字段为附加式，客户端容错）。
- 现有 `GET /usage/turns` 的 Turn/Step 自带 `sessionId`（无会话的历史事件为空）。
- 版本：plugin `1.4.0 → 1.5.0`（Lead 已 bump）。

---

## 3. Client（`client.js`「轨迹」Tab 重构）

**布局（以会话为单位，对齐 DSH 的会话 → 轨迹层级）**
- 顶部工具条保留：筛选（全部/翻译/查词/仅失败）、刷新、清空统计。
- **翻译会话卡片**（最新在前）：
  - 头：会话标题（sourceTitle 或站点）· 时间（首轮）· 模型 · `N 轮` · `↑↓ tokens` · 状态徽标（成功/部分失败/失败）；
  - 头右侧/操作区：**「打开 DSH 轨迹」**按钮（`uiWorkspace.openSession(sessionId)`；sessionId 来自 `/usage/turns` 的 turn.sessionId 或 `/conversations`）；
  - 展开：该会话的轮次列表（第 N 轮 · 时间 · tokens · 时延 · 状态）；下方提示「每轮完整内容与 Token 详见 DSH 原生轨迹/统计」；
  - 无法打开（无 uiWorkspace / 无 sessionId）时按钮隐藏并显示原因提示。
- **旧版请求**（无 sessionId 的 turns）：折叠分组「旧版请求（无 DSH 会话）」，沿用现有内联 Turn 卡片。
- 分页：「加载更早」按 turn 分页继续加载并合并到对应会话（按 sessionId 去重/合并轮次）；会话跨页时允许先出现部分轮次。
- 数据：先 `GET /usage/turns?limit=100`（+kind/status 过滤），必要时 `GET /conversations` 补 title/live；
  404 → 旧 Host 回退现有内联 Turn 视图 + 提示。
- 空态/加载态/错误态；a11y；i18n 新增 `trace.conversation.*` 系列（zh+en）；仅用 `--dsw-alias-*`。

---

## 4. 验收

1. host `node --test test/` 全绿（新增 conversations 桥单测：文本组装/usage/事件序列/创建失败容错/LRU/空闲释放/sessionId 映射）。
2. `node --check` 全文件；扩展 `tools/verify.mjs`/`e2e` 保持全绿（扩展不改）。
3. live：
   - 真实翻译 run（3+ 批次）→ `GET /conversations` 出现会话；`GET /usage/turns` 该 run 所有 turn 带同一 sessionId；
   - 插件「轨迹」页 → 会话卡片 →「打开 DSH 轨迹」→ 原生会话出现，**轨迹 Tab 每轮 user/assistant 内容正确**，
     原生「统计/底部 token」与账本该 run 的 tokens 一致；截图归档；
   - 失败请求 → 原生轨迹出现失败轮；旧版/无 sessionId 事件走内联回退；
   - 无桥（agents 不可用）时翻译与账本不受影响。
4. 不破坏 v2/v3 功能（设置/单词本/浮窗 token/概览/旧轨迹回退）。

---

## 5. 写入范围

| 成员 | 范围 |
|---|---|
| Lead | 契约、版本号、最终接线/live 验证/文档/合并推送 |
| conv-host | `dsh-web-translator/lib/conversations.js`、`test/conversations.test.mjs`（+必要的 api 测试，不动已接线代码结构） |
| conv-ui | `dsh-web-translator/client.js` |
| qa-convo | `dsh-web-translator/qa/**` |
