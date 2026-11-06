# CONVERSATION-QA — 翻译会话桥接 DSH 原生轨迹验收报告（DESIGN-CONVERSATIONS v4）

> 结论：**PASS** — 契约 §4 验收 4/4 项通过；独立 QA harness **103/103**（含 live 只读段）、live 端到端证据脚本 **42/42**、面板验收 **53/53**；host **216/216**、extension **138 static / 81 e2e**；未发现阻断性缺陷（1 项契约措辞偏差已在硬化中修复，见 §7）。
> QA：`qa-turns`（只写 `dsh-web-translator/qa/**`，未修改任何源码、未安装/重载插件）。现场：DSH Web GUI `http://127.0.0.1:3080`，plugin **1.5.0**，host+client 已由 Lead 重载。
> harness：[`qa/verify-conversations.mjs`](verify-conversations.mjs)、[`qa/conversation-shot.mjs`](conversation-shot.mjs)。
> **证据文件（截图/JSON）不入库**：可能包含真实浏览标题、会话名等个人信息；本地运行上述 harness 会重新生成到 `qa/live-conversations-evidence/`（已被 `qa/.gitignore` 忽略）。

---

## 1. 被测能力

一次翻译动作（`turnId`）→ 一条**真实 DSH Session**（插件自有 Agent；v1.6.0 起统一归入 workspace「dsh翻译记录」，此前为未分组；cwd=`$DSH_HOME/immersive-translate/conversations/`），会话内每个模型请求 = 一轮原生对话（`turn/start → step/start → user/message → assistant/message(usage+stream) → step/end → turn/end`）。
插件「轨迹」页改为**会话列表**（会话卡片 + 「打开 DSH 轨迹」按钮 → `uiWorkspace.openSession(sessionId)`），旧版（无 `sessionId`）请求折叠进「旧版请求（无 DSH 会话）」。

---

## 2. 契约 §4 验收清单（PASS/FAIL）

| # | 契约要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | host `node --test test/` 全绿（conversations 桥单测：文本组装/usage/事件序列/创建失败容错/LRU/空闲释放/sessionId 映射） | **PASS** | host **216/216**（含 `test/conversations.test.mjs` 17 项：文本组装/usage/事件序列/创建失败/LRU/idle/sessionId 映射，另 api/http/usage 测试扩展） |
| 2 | `node --check` 全文件；extension `tools/verify.mjs` / `e2e` 保持全绿（扩展不改） | **PASS** | verify-conversations 语法段全绿；extension **138/138 static**、e2e **81/81**（扩展正被并行工作流修改，计数变化已如实记录，未由 QA 修改扩展） |
| 3a | live：真实翻译 run（3+ 批次）→ `GET /conversations` 出现会话；`GET /usage/turns` 该 run 所有 turn 带同一 sessionId | **PASS** | `conversation-shot.mjs` 42/42：seed `tr_qa_conv_mw4h4og1` ×3 批次 → `/conversations` 1 行 `{sessionId:"translation-tr_qa_conv_mw4h4og1", title:"翻译 · QA conversation mw4h4og1", turns:3, live:true, input 397 / output 76}`；`/usage/turns` Turn + 3 Steps 全部带同一 sessionId；截图 `conversation-list.png` |
| 3b | live：插件「轨迹」页 → 会话卡片 →「打开 DSH 轨迹」→ 原生会话出现；轨迹 Tab 每轮 user/assistant 内容正确；原生「统计/底部 token」与账本该 run tokens 一致；截图归档 | **PASS** | 插件卡片（3 轮行 + live 徽标 + `打开 DSH 轨迹`，`plugin-conversation-card.json`）→ 点击后原生 tabs **对话/轨迹/统计**（`native-tabs.json`，无 sidebar fallback）；原生轨迹 `第 1/2/3 轮`、`用户/助手` 各 3 行且内容=seed 源文/译文（`conversation-trajectory.png`）；原生对话含译文与「已完成，用时 1 秒」（`conversation-chat.png`）；原生统计 3 行 token 表（`conversation-stats.png`）；底部 token pill **“473 tok”** == 账本 `397 in + 76 out = 473`（`gui-evidence.json`），活动 pill `3 轮 3 步` |
| 3c | live：失败请求 → 原生轨迹出现失败轮；旧版/无 sessionId 事件走内联回退 | **PASS（分层证据）** | 旧版回退：live UI 中「旧版请求（无 DSH 会话）」折叠组存在（page 快照计数 59–79 随分页变化），展开后内联 `.dsh-it-turn` 卡片 + steps + 样例可用（panel-shot 53/53）；失败轮：在 in-process 假 agents 环境逐事件断言 `turn/start→step/start→user/message→step/end→turn/end{reason:error}`（无 assistant message）且账本行 `ok:false` 带 sessionId/turn（见 `verify-conversations` 失败轮段）；**未在 live 注入失败**以免污染真实配置（按任务要求） |
| 3d | 无桥（agents 不可用）时翻译与账本不受影响 | **PASS** | in-process：agents 缺失 / `agents.create` 抛错 / `session.append` 抛错 三种场景 → `POST /translate` 仍 200 + `/usage` 账本行照记（无 sessionId）+ `/conversations` 空/仅历史；warn 只打一次 |
| 4 | 不破坏 v2/v3 功能（设置/单词本/浮窗 token/概览/旧轨迹回退） | **PASS** | `verify-token-stats` **164/164**；`verify-turn-trace` **184/184**（已更新 v4 会话 UI/版本断言）；`panel-shot` **53/53**（概览今日 tokens、设置、单词本、刷新/清空/筛选、Turn `/usage/turns`、conversations）；extension e2e **81/81** |

**额外验收（Lead 要求）**
- 冷恢复：历史（`live:false`）会话卡片 `翻译 · QA conversation mw4gjj02`（不在 live `/conversations`）→ 点击「打开 DSH 轨迹」→ 原生会话 **冷 resume** 成功，轨迹渲染 **3 轮 用户/助手**（`conversation-cold-resume.png`、`cold-resume.json`；无需重载插件）。
- Lead 预置 run `tr_final_verify_1` 现场复核：`/conversations` 行 `turns:3`、`399 in / 78 out`、`live:true`，与 Lead 所述一致（`conversations.json` 同刻快照）。

---

## 3. Harness 与结果（全部针对当前已安装代码）

| Harness | 结果 | 说明 |
|---|---|---|
| `qa/verify-conversations.mjs --live` | **103/103 PASS** | 新增独立 harness（node:assert）：静态契约（conversations.js/api/http/usage/constants/版本 1.5.0）；in-process 假 agents+假 LLM 全桥接契约（会话创建/事件序列/usage/标题 rename/`/conversations` shape/`/usage/turns`+`/usage/events` sessionId·turn/lookup 会话/失败轮/无 turnId 只记账本/持久化/405/卸载 dispose/LRU 24/空闲常量/helper units/客户端静态 UI）；三类无桥回退；旧 harness 回归；`--live` 只读段（health/version、`/conversations` shape、turns sessionId 关联、sessionId 命名、`/usage`+`/usage/events` 兼容、旧 turn 无 sessionId 允许）。**不 POST live** |
| `qa/conversation-shot.mjs` | **42/42 PASS** | live 端到端：3 批同 turnId seed → JSON 捕获 → headless GUI：插件会话卡片 → 打开 DSH 轨迹 → 原生 对话/轨迹/统计 断言 + footer token 等值 + 冷恢复。`conversation-shot.result.json` |
| `qa/panel-shot.mjs` | **53/53 PASS** | 会话列表（`.dsh-it-conv` 41 张 == `/usage/turns?limit=100` 去重 session 数）、最新会话默认展开、单 run 合并为 1 卡 3 轮、`打开 DSH 轨迹` 按钮、旧版折叠组展开内联 Turn（步骤/样例/step 详情）、加载更早（turn 行 65→165）、`/conversations`+`/usage/turns` 均 200、0 console error；截图 `token-stats-traces-turns.png` / `token-stats-traces-turn-expanded.png` 已刷新为会话 UI |
| `qa/verify-token-stats.mjs` | **164/164 PASS** | v2/v3 回归；`verify-token-stats.result.json` 已用当前代码重生成 |
| `qa/verify-turn-trace.mjs` | **184/184 PASS** | 已按 v4 更新：版本断言放宽为 `>=1.4.0`/`>=1.7.0`，客户端静态段改为「会话列表 + 旧版内联 Turn 回退」；`verify-turn-trace.result.json` 已重生成 |
| host `node --test test/` | **216/216 PASS** | 含 conversations 桥单元测试 |
| extension `tools/verify.mjs` / `tools/e2e-chrome.mjs` | **138 static PASS / 81/81 PASS** | 扩展源码由并行工作流修改，QA 未改动扩展，仅记录当前输出（较上一轮 137/73 增加，为并行改动所致） |

---

## 4. Live 关键证据（本地生成，未入库）

| 证据 | 内容 |
|---|---|
| `seeded-run.json` | seed 3 批请求体/响应（同 `turnId=tr_qa_conv_mw4h4og1`，stepIndex 0/1/2，mode=bilingual） |
| `conversations.json` | 同刻 `GET /conversations` 全量（含本 run 与 lead 的 `tr_final_verify_1`） |
| `usage-turns.json` | 同刻 `GET /usage/turns?limit=100`（Turn + 3 Steps 同 sessionId、tokens） |
| `seeded-turn.json` | 断言口径：`expectedTokens=473`（397 in / 76 out），conversation sessionId 等 |
| `plugin-conversation-card.json` | 插件会话卡片：标题/展开/3 轮行/live/`打开 DSH 轨迹` 按钮与 aria |
| `native-tabs.json` | 原生视图 tabs（对话/轨迹/统计），`fallbackUsed:false`（走 openSession 正常路径） |
| `gui-evidence.json` | 对话/轨迹/统计断言、token pill（`473 tok` vs 账本 473）、活动 pill（3 轮 3 步）、console 记录（0 error/0 exception） |
| `cold-resume.json` | 冷恢复候选（live:false 卡片）、原生 tabs、3 轮 用户/助手 渲染 |
| `assertions.json` / `conversation-shot.result.json` | 42/42 全量逐项断言与结果 |
| 截图（本地生成） | `conversation-list.png`（插件会话列表）、`conversation-trajectory.png`（原生轨迹 第 1..3 轮 + 用户/助手 + footer 473 tok）、`conversation-chat.png`（原生对话）、`conversation-stats.png`（原生统计）、`conversation-cold-resume.png`（冷恢复 3 轮）、`conversation-cold-resume-card.png`、`conversation-plugin-card.png` |

---

## 5. 已知限制（非缺陷）

- **会话归属**：v1.6.0 起插件会话统一归入插件自建 workspace「**dsh翻译记录**」（`workspaceRegistry.create` + `Workspace.attachSession`，历史会话回填；此前版本为未分组），原生侧边栏可直接打开；从插件页/侧边栏打开均正常。
- **空闲释放**：live 会话空闲 15 分钟 dispose agent（会话仍持久化）；再次「打开 DSH 轨迹」触发 DSH 冷 resume（本次已在 live 验证冷恢复路径，无需重载插件）。
- **账本上限**：`/usage/turns` 与 `/conversations` 的历史行均从账本保留的 `LIMITS.usageEvents=500` 事件推导；超出窗口的更旧事件不参与聚合（Turn/会话历史减少是预期行为）。
- **`/conversations` 为 live+历史超集**：契约 §2 原文写「仅 live 会话；历史会话由记账本 sessionId 推导」；当前实现同时返回 `live:false` 的历史行（附加 `requests/status/tokens/firstAt/lastAt/kinds/title` 等字段），客户端容忍额外字段。属**兼容性超集**，非缺陷，但已在报告注明。
- **旧版回退**：无 sessionId 的历史事件（本轮 live 约 59–87 条，随分页变化）只出现在「旧版请求（无 DSH 会话）」折叠组，走 v3 内联 Turn UI——符合契约 §1/§3。
- **失败轮**：live 未注入失败请求（避免污染真实配置）；失败路径以 in-process 假 agents + 假 LLM 的事件序列/账本断言覆盖（`verify-conversations`）。
- **token 展示精度**：原生底部 token 在 ≥1000 时按紧凑格式（如 `7.1K`）显示；本次 run 为 `473 tok` 精确值，harness 对紧凑格式按显示精度容差比较。
- **截图遮挡**：原生截图右上角悬浮猫形象来自另一插件 `dsh-pet`，与本功能无关，遮挡少量像素。
- **扩展版本**：扩展正被并行工作流修改（当前 1.7.1，138 static/81 e2e），QA 未改动扩展；DESIGN-CONVERSATIONS §1 声明扩展无需改动，本轮功能未依赖扩展变更。

---

## 6. 复现命令

```bash
cd <repo>/dsh-web-translator

# 独立 harness（in-process 桥接契约 + 旧 harness 回归；--live 追加只读 live 检查）
node qa/verify-conversations.mjs --live

# live 端到端证据（3 批真实翻译 → headless GUI → 原生轨迹截图，写 qa/live-conversations-evidence/，该目录不入库）
node qa/conversation-shot.mjs

# 回归
node qa/verify-token-stats.mjs
node qa/verify-turn-trace.mjs
node qa/panel-shot.mjs
node --test test/
cd ../dsh-web-translator-extension && node tools/verify.mjs && node tools/e2e-chrome.mjs
```

---

## 7. 缺陷记录

| # | 严重度 | 现象 | 状态 |
|---|---|---|---|
| 1 | 低（契约措辞） | DESIGN-CONVERSATIONS §2 写「`/usage/turns` 的 **Turn/Step** 自带 `sessionId`」，硬化前 Step 未暴露 `sessionId` | **已修复**：当前 `lib/usage.js` 的 `stepOfEvent` 已写入 `step.sessionId`，harness 断言通过 |
| — | — | 其余未发现缺陷 | — |

**结论：DESIGN-CONVERSATIONS §4 验收 4/4 项 PASS；host/client/扩展现有套件全绿；live 会话桥接、原生轨迹/对话/统计、token 等值、冷恢复均有截图 + JSON 证据，可交付。**
