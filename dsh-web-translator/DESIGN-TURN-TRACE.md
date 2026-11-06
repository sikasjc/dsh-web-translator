# 轨迹 Turn 化改造 — 设计契约 v3.1（增量）

> 状态：2026-11-06。用户反馈：**当前「轨迹」页是扁平请求列表，没有像 DSH 那样按 Turn 展示**。
> 本文件是增量契约；未提及部分继续遵守 `DESIGN.md`（v2）与 `DESIGN-TOKEN-USAGE.md`（v3）。

---

## 1. 目标（对齐 DSH 的轨迹/统计视图）

DSH 会话的「统计 / 轨迹」视图以 **Turn（一轮用户动作）** 为单位：
- 每个 Turn 一行汇总：耗时、Token、缓存、步数、模型、状态；
- 展开后是 **Steps**（每步一行）：每步的模型调用、Token、耗时、工具/内容；
- 最新在前，可加载更早。

当前插件「轨迹」页是**每次 `/translate` / `/lookup` 一条的扁平列表**，看不出「一次翻译动作里跑了几批、每批多少 token、有没有重试」。本轮把它改成 **Turn + Steps 结构，视觉/信息层级对齐 DSH**。

### Turn 的定义（翻译场景映射）

| DSH 概念 | 本插件映射 |
|---|---|
| Turn（一轮） | **一次用户翻译动作**：点「翻译此页 / 重新翻译」后该次 run 的全部模型请求（含懒加载继续的批次）；或一次查词卡查询 |
| Step（一步） | 该 Turn 内的**一次模型调用**（一个批次的 `/translate`，或一次 `/lookup`），含解析纠错重试 |
| 会话 | 页面的翻译"会话"由 `sourceUrl` 标识，同一 Turn 内共享 |

- 停止 / 还原 / 页面跳转结束当前 Turn；
- 单段重试（红色占位点击重试）如果发生在 run 结束后，视为**新的 Turn**（1 步）；
- 查词（划词/双击/右键翻译选中文本）每次打开查词卡 = 1 个 Turn（kind=lookup，1 步）；
- **兼容旧数据**：没有 `turnId` 的历史事件，每个事件单独作为一个 Turn（steps=1）。

---

## 2. Host 账本与聚合

### 2.1 Event 新增可选字段（向后兼容）

```ts
{
  turnId?: string;        // ≤64，如 "tr_…" / "lk_…"；缺省时按单步 Turn 处理
  stepIndex?: number;     // 0..10000，Turn 内递增
  mode?: string;          // ≤16，显示模式：bilingual | only | source
  outputPreview?: string  // ≤200，成功时首个译文截断（lookup 为译文）
}
```

- `sample`（已有，≤80）作为 **inputPreview** 展示；
- 旧账本/旧事件读取时缺省这些字段不报错；`normalizeEvent` 保留并截断。

### 2.2 `usageService.turns(options)`

```js
turns({ limit = 20, kind, status, before }) => Promise<{
  turns: Turn[], nextBefore: string | null, hasMore: boolean
}>
```

`Turn`：

```ts
{
  id: string,                    // turnId 或 "evt:<eventId>"
  kind: 'translate' | 'lookup' | 'mixed',
  mode?: string,                 // 取该 turn 内首个非空
  client?: string, site?: string, sourceUrl?: string, sourceTitle?: string,
  provider?: string, model?: string,   // 首个非空
  targetLanguage?: string, sourceLanguage?: string,
  startedAt: number, endedAt: number, durationMs: number,  // endedAt-startedAt（单步取 latencyMs）
  requests: number, ok: number, errors: number, cached: number,
  segments: number, chars: number,
  inputTokens: number, outputTokens: number,
  cacheReadTokens: number, cacheWriteTokens: number,
  avgLatencyMs: number,          // round(sum(latencyMs)/steps)
  status: 'ok' | 'partial' | 'error',  // errors===0→ok；errors>0&&ok>0→partial；否则 error
  steps: Step[]                  // 按 stepIndex 升序（缺省按 at 升序）
}
```

`Step`：`{ stepIndex, id, at, kind, provider, model, segments, chars, cached, retries, ok, errorCode?, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, latencyMs, sample?, outputPreview? }`

- 聚合：events 按 `turnId || 'evt:'+id` 分组；`startedAt=min(at)`、`endedAt=max(at)`；token/计数求和；
- 排序：Turn 按 `startedAt` 降序（最新在前）；
- 过滤：`kind=translate|lookup|error`（error = status !== 'ok'），`status=ok|partial|error`（可选）；
- 分页：`before` = 上一页最后一个 turn.id；找不到则从头；`limit` clamp 1..100，默认 20；
- `/usage/events` 保持不变（兼容旧 client）；`summary()` 保持不变。

### 2.3 Host API

- `POST /translate`、`POST /lookup` 接受可选：`turnId`（trim ≤64）、`stepIndex`（整数 0..10000）、`mode`（trim ≤16）；非法 → `400 BAD_REQUEST`。
- `GET /usage/turns?limit=&kind=&status=&before=` → `{ok:true, turns, nextBefore, hasMore}`。
- `lib/http.js` ROUTES + dispatch；`lib/constants.js` 新增
  `LIMITS.turnIdChars=64`、`modeChars=16`、`stepIndexMax=10000`、`outputPreviewChars=200`、
  `usageTurnsDefault=20`、`usageTurnsMax=100`。
- 成功事件记录 `outputPreview`（translate: 首个译文；lookup: 译文）。
- 版本：plugin `1.3.0 → 1.4.0`（`package.json` + `lib/version.js`，Lead 已改）。

---

## 3. Client「轨迹」Tab 重构（`client.js`）

### 3.1 数据

- 改用 `GET /usage/turns?limit=20`（筛选时带 `kind`/`status`）；
- 「加载更早」用 `before=<最后一条 turn.id>`；
- 若 `/usage/turns` 返回 404（旧 Host）：回退 `GET /usage/events` 沿用现有扁平行渲染，并显示提示「Host 版本过旧，仅显示请求级轨迹」；
- 保留清空统计、筛选（全部/翻译/查词/仅失败）、刷新、5s 概览轮询。

### 3.2 Turn 列表（视觉对齐 DSH 统计视图）

**Turn 头（可点击展开，默认折叠，最新一轮默认展开）**：

```
┌ 第 3 轮 · [翻译] [双语对照]  example.com/…      modelhub/deepseek-flash
│  2.3s · 3 步 · ↑ 1.2k ↓ 300 · 缓存读 128 · 成功        ▸
```

- 左侧：Turn 序号（当前页内倒序编 `#N` 或相对时间）、kind 徽标、mode 徽标（双语/仅译文/原文）、站点/标题；
- 右侧：模型、duration、steps 数、tokens（↑输入 ↓输出）、缓存读、状态徽标（成功/部分失败/失败）；
- 失败 Turn 用错误色边框/徽标强调。

**展开内容**：

1. **Turn 元信息网格**：开始时间、来源 URL（可复制/换行）、目标语言、客户端、段数/字符、缓存读/写、平均时延；
2. **Steps 表格/列表**（每步一行，参照 DSH per-step rows）：
   `步 1` · 时间 · 段数/字符 · ↑↓ tokens · 缓存读 · 时延 · 重试 · 状态/错误码；
   有 `sample`/`outputPreview` 时，行下方显示 **输入样例 → 译出样例**（等宽小字、截断、可选展开全文？只读截断即可）；
3. 点击 step 行可展开/收起该步的详细字段（同 step 内 tokens 四桶、source/target language 等）。

### 3.3 分页与状态

- 底部「加载更早」按钮（DSH 风格，按钮即可）；加载中禁用、失败可重试；
- 空态：无轨迹 / 筛选后为空 两类文案；
- 加载态：骨架；错误态：InlineAlert + 重试；
- Turn id 稳定，展开状态按 turn.id 记忆。

### 3.4 i18n / CSS

- 新增 zh/en keys（前缀 `trace.`）：`trace.turnLabel`、`trace.mode.*`、`trace.status.*`、`trace.steps`、`trace.stepLabel`、`trace.loadMore`、`trace.loadingMore`、`trace.legacy`、`trace.inputSample`、`trace.outputSample`、`trace.turnMeta.*`、`trace.step.tokens` 等；
- 只用 `--dsw-alias-*`；新增 `.dsh-it-turn*`、`.dsh-it-steps*` 样式；窄屏横向滚动；
- a11y：Turn 头 `role="button"`/`aria-expanded`，steps 使用表格语义或列表 + 键盘可达。

---

## 4. 扩展（`dsh-web-translator-extension/content.js`）

- `state.runId = ''`、`state.runStep = 0`；`makeTurnId(prefix)` 生成 `prefix + '_' + Date.now().toString(36) + '_' + rand`。
- `startTranslate`（非 silent 重置逻辑处）：`state.runId = makeTurnId('tr'); state.runStep = 0;`（同一次 run 内懒加载批次共用）。
- `requestTranslations` 的 payload 增加：`turnId: state.runId`、`stepIndex: state.runStep++`、`mode: state.mode`；
- run 结束后（完成/停止/还原）清空 `state.runId`；之后的单段重试调用前若 `runId` 为空则新建 `tr_` run 并从 0 开始；
- `openCard` 每次生成 `state.cardTurnId = makeTurnId('lk')`，lookup payload 增加 `turnId`、`stepIndex: 0`；
- 版本 `1.6.2 → 1.7.0`（manifest + content.js EXT_VERSION，Lead 已改）。
- `tools/e2e-chrome.mjs`：断言 translate 请求同一 run 内 turnId 相同、stepIndex 递增；lookup 请求带 turnId；既有 55/55 断言保持通过。
- 新增扩展 README「轨迹（Turn）」说明。

---

## 5. 验收

1. host `node --test test/` 全绿（新增 turns 聚合/分页/过滤/旧数据兼容/HTTP 路由测试）。
2. `node --check` 全部文件；extension `tools/verify.mjs`、`tools/e2e-chrome.mjs` 全绿。
3. live：
   - 扩展发起一次真实页面翻译（或 curl 模拟带 turnId 的 3 个 batch）→ `GET /usage/turns` 返回 1 个 Turn、steps=3、tokens 汇总正确；
   - DSH 左侧「dsh翻译 → 轨迹」页：列出 Turn；展开可见 steps 与输入/输出样例；加载更早可用；无 console 错误；截图归档。
4. 不破坏 v2/v3 既有功能：概览、设置、单词本、扩展翻译/查词/还原、`/usage`、`/usage/events` 均保持工作。

---

## 6. 写入范围

| 成员 | 范围 |
|---|---|
| Lead | 契约/版本号/文档/合并/安装/最终推送 |
| host-turns | `dsh-web-translator/lib/{usage,api,http,constants}.js`、`test/**` |
| trace-ui | `dsh-web-translator/client.js` |
| ext-turns | `dsh-web-translator-extension/**` |
| qa-turns | `dsh-web-translator/qa/**`（只读源码） |
