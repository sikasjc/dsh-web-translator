# dsh翻译 · Token 消耗 / 轨迹统计 / 左侧工具栏页面 — 设计契约 v3

> 状态：2026-11-06 新需求（用户在本会话提出）。本文件是 **v3 增量的唯一契约**；v2 设计见 `DESIGN.md`，
> 未在本文件声明的部分继续遵守 `DESIGN.md`。
>
> 需求原文要点：
> 1. 在 DSH 插件页面和 Chrome 前端浮窗上都能看到 token 消耗；
> 2. DSH 插件页面放到左侧工具栏（sidebar panel list）里；
> 3. 用户可以在该页面设置提示词、查看 token 消耗、各种轨迹与统计；
> 4. 尽量复用 DSH 本身 / 插件已有能力（翻译本质也是一次大模型对话）。

---

## 0. 工作区与纪律（所有成员必读）

- 本次工作全部在 **git worktree** 内进行：
  `<repo>/.agents/worktrees/immersive-token-stats/`
- **禁止**写入/修改主工作区 `<repo>/dsh-web-translator/`、
  `<repo>/dsh-web-translator-extension/`（另一个 agent 正在修改），
  也禁止 `plugin_manager` 安装、禁止改 DSH profile、禁止重启 DSH。
- 只写自己任务声明的写入范围；跨范围改动先在共享任务里报告 Lead。
- 只用 Node 内置模块 + 浏览器原生 API + 平台 module table 暴露的 `react`；不新增依赖、不加构建步骤。
- 校验命令（各自范围）：
  - Host/共享：`node --check <file>`；`cd dsh-web-translator && node --test test/`
  - Client：`node --check client.js`
  - 扩展：`node --check content.js background.js options.js`；`node tools/verify.mjs`；`node tools/e2e-chrome.mjs`

---

## 1. 总体设计

翻译请求是插件直接调用 `ctx.llm.stream(...)` 的辅助调用（v2 明确不传 sessionId/purpose、
不进入 DSH 会话日志），因此 **token 账本由插件自己记**；但统计口径与 DSH 自己一致
（prompt 侧输入 / 缓存读 / 缓存写 / 输出 四桶 + 请求数 / 缓存命中 / 错误 / 时延），
展示层复用 DSH 的 `--dsw-alias-*` 主题 token 与 `main` + `sidebar.panellist` 槽位，
使插件页面与 DSH 原生页面视觉、交互一致。

```
┌────────────── Chrome/Edge ──────────────┐
│ content.js 悬浮面板                      │
│  ├─ 本页消耗：输入/输出/请求数（实时累加）│
│  ├─ 今日累计：GET /usage（打开面板时刷新）│
│  └─ 查词卡：本次查询 tokens（可选）      │
└───────────────▲─────────────────────────┘
                │ background RPC（usage:GET / translate POST）
┌───────────────┴──────── DSH Host ───────┐
│ translate/lookup 成功后：                │
│  lib/usage.js 记录一条 event + 聚合       │
│  $DSH_HOME/immersive-translate/usage.json│
│  GET /usage · GET /usage/events · DELETE │
└───────────────▲─────────────────────────┘
                │ 同源 fetch
┌───────────────┴────── DSH Client ───────┐
│ sidebar.panellist(id=immersive-translate)│
│ main(key=immersive-translate) 整页：      │
│  概览 / 轨迹 / 设置(提示词) / 单词本      │
└─────────────────────────────────────────┘
```

**空数据/旧版兼容**：扩展调用 `/usage` 若返回 404（旧版 Host），静默隐藏“今日累计”，其余功能不受影响。

---

## 2. Host：token 账本（`lib/usage.js`）

### 2.1 落盘

文件：`$DSH_HOME/immersive-translate/usage.json`（复用 `lib/store.js` 的 `createJsonStore`：原子写、串行、损坏回退默认值）。
上限：`LIMITS.usageEvents = 500` 条事件、`LIMITS.usageDays = 90` 天日聚合。

```json
{
  "version": 1,
  "updatedAt": 0,
  "totals": { "requests":0, "ok":0, "errors":0, "cached":0,
              "inputTokens":0, "outputTokens":0, "cacheReadTokens":0, "cacheWriteTokens":0,
              "latencySum":0, "latencyCount":0 },
  "days": { "2026-11-06": { "requests":0, "ok":0, "errors":0, "cached":0,
              "inputTokens":0, "outputTokens":0, "cacheReadTokens":0, "cacheWriteTokens":0,
              "latencySum":0, "latencyCount":0 } },
  "models": { "modelhub/deepseek-flash": { "provider":"modelhub", "model":"deepseek-flash",
              "requests":0, "inputTokens":0, "outputTokens":0, "cacheReadTokens":0,
              "cacheWriteTokens":0, "lastAt":0 } },
  "kinds": { "translate": {…同 buckets…}, "lookup": {…} },
  "events": [ Event, … ]            // 最新在前
}
```

> 2026-11-06 增补（Lead 裁决）：为支持「今日平均时延」精确统计，totals / days / kinds 三类 bucket
> 追加 `latencySum`、`latencyCount`（毫秒，单条 clamp 到 0..600000，非有限值记 0；cached/失败请求同样计入，
> 因为时延统计的是请求耗时而非 token）。`models` 不要求。`avgLatencyMs` 由这两个字段派生，不落盘。

`Event`（客户端可读；写盘前截断字符串，控制文件大小）：

```ts
{
  id: string,                 // "evt_" + 随机
  at: number,                 // epoch ms
  kind: 'translate' | 'lookup',
  ok: boolean,
  errorCode?: string,         // 失败时的 ApiError code
  provider: string, model: string, reasoningEffort?: string,
  targetLanguage?: string, sourceLanguage?: string,
  client?: string,            // 'extension' | 'dsh' | 其它（≤32 字符）
  site?: string,              // sourceUrl 的 host
  sourceUrl?: string,         // ≤2048，透传自请求 body
  sourceTitle?: string,       // ≤200
  segments: number,           // 请求段数
  chars: number,              // 请求字符数
  cached: boolean,            // 整请求命中 LRU（cached 请求 tokens 记 0）
  retries: number,            // 解析纠错重试次数（translate 提供时才写，0..）
  inputTokens: number, outputTokens: number,
  cacheReadTokens: number, cacheWriteTokens: number,
  latencyMs: number,
  sample?: string             // 第一段前 80 字符（本地诊断用）
}
```

### 2.2 模块 API（`createUsageService`）

```js
createUsageService({ store, now = Date.now, logger, maxEvents, maxDays }) => {
  async record(event)                 // 补 id/at、累加 totals/days/models/kinds、events 头插 + 截断 + prune days；写失败只 log
  async summary({ days = 14 })        // => { version, updatedAt, totals, today, days:[{date,…} 升序],
                                      //      byModel:[{provider,model,requests,inputTokens,outputTokens,
                                      //                cacheReadTokens,cacheWriteTokens,lastAt}],
                                      //      byKind:{translate,kinds.lookup}, recent:[最多 20 条] }
                                      // totals / today / days[] / byKind.* 均附派生字段 avgLatencyMs
                                      //（= latencyCount>0 ? round(latencySum/latencyCount) : 0，只读）
  async events({ limit = 50, kind, before }) // kind: undefined|'translate'|'lookup'|'error'
                                      // => { events, nextBefore: string|null, hasMore: boolean }
  async clear()                       // 重置为空账本
}
```

- `today` = 当前本地日期 `YYYY-MM-DD` 的 day bucket（不存在返回全 0）。
- `days` 参数 clamp 1..90；返回最近 N 天（含今天），无数据的日子也补 0，保证图表连续。
- `record` 必须完全容错：账本写失败/坏数据绝不能让翻译请求失败。
- `before`：按事件 id 定位，返回位于其**之后**（更旧）的下一页；找不到该 id 时从头返回。

### 2.3 采集点（`lib/api.js` + `lib/translate.js` + `lib/llm.js`）

1. `lib/llm.js#collectStream`：usage 保留全部字段
   `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`（`totalTokens` 可忽略）；
   `callModel` 原样返回。translate 的 `addUsage` 同步扩展四个字段。lookup 也返回 usage。
2. `lib/translate.js`：`translate()` 返回值新增（或已含）：`usage`（四字段聚合）、`cached`、`retries`（解析纠错重试次数，0 或 1）。
   `lookup()` 返回 `{ result, usage, retries: 0 }`；`result` 结构不变（扩展兼容）。
3. `lib/api.js`：
   - `GET /usage?days=` → `{ usage: summary }`
   - `GET /usage/events?limit=&kind=&before=` → `{ events, nextBefore, hasMore }`
   - `DELETE /usage` → `{ cleared: true, usage: summary }`
   - `translate` / `lookup` 包装：开始计时 → 调用 service →
     成功记录 `{ok:true, …}`；抛错记录 `{ok:false, errorCode: err.code, …}` 后**原样再抛**。
     企业失败也记录（provider/model 尽力而为：成功时取结果，失败时取 `trySelection()` 已解析值或空串）。
   - 记录请求参数：`targetLanguage`、`segments`、`chars`、`sourceUrl`、`sourceTitle`、`client`、`sample`。
4. 请求体新增可选元数据（`POST /translate`、`POST /lookup` 都接受）：
   - `sourceUrl`? 用 `normalizeHttpUrl` 校验（http/https，≤2048）
   - `sourceTitle`? 可选字符串，trim 后 ≤200
   - `client`? 可选字符串，trim 后 ≤32（默认 `'dsh'`）
   校验失败按既有错误码 `INVALID_URL_OR_TEXT` / `BAD_REQUEST` 处理；不改变响应主体结构。
5. `lib/constants.js`：新增 `USAGE_VERSION = 1`，`LIMITS.usageEvents = 500`、`LIMITS.usageDays = 90`、
   `LIMITS.sourceTitleChars = 200`、`LIMITS.clientChars = 32`、`LIMITS.eventSampleChars = 80`。
6. `lib/http.js`：ROUTES 增加 `/usage` GET+DELETE、`/usage/events` GET；`dispatchGet`/`dispatchWrite` 接线。
7. `index.js` 不变（路由仍由 `webServer` prefix 挂载）。

**统计口径**：`cached` 请求 tokens 记 0 但计入 `requests`/`cached`；错误请求 tokens 记 0，计入 `requests`/`errors`。
`totalTokens` 一律派生为 `inputTokens + outputTokens`（不落盘）。

---

## 3. DSH Client：左侧工具栏页面（`client.js`）

### 3.1 槽位注册（照 dsh-market 的既有模式）

```js
const PANEL_ID = 'immersive-translate';
// apply(ctx) 中新增（保留现有 settings.section 注册）：
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: PANEL_ID, label: () => translate('panel.title') },
  ImmersiveTranslatePage,
));
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: () => translate('panel.title') },
  (owner) => h(SidebarPanelIcon, { size: (owner && owner.size) || 16, active: !!(owner && owner.active) }),
));
```

- `main` 是 keyed 槽位：key = `immersive-translate`；`sidebar.panellist` 的 list id 与 main key 相同，
  点击左侧图标即选中该面板（DSH sidebar 自己处理选中）。
- 图标：内联 SVG（16px 线框，`currentColor`，active 时用 `--dsw-alias-brand-primary`），不引入图片依赖。
- 可选：apply 中 `ctx.inject(['layout'], (scoped) => { layout = scoped.layout; })`，
  用于设置页“打开统计面板”按钮 `layout.selectPanel(PANEL_ID)`；layout 不可用时按钮不渲染（不得报错）。

### 3.2 页面结构（`ImmersiveTranslatePage`）

- 头部：标题「dsh翻译」+ 副标题「浏览器扩展翻译后端 · Token 统计」；
  右侧状态：当前模型 `provider/model` chip、今日 tokens chip、刷新按钮。
- Tabs（`role=tablist`，左右方向键切换）：**概览** / **轨迹** / **设置** / **单词本**。
- **概览**：
  - 今日统计卡：请求数、输入 tokens、输出 tokens、缓存命中 tokens、失败数、平均时延
  （优先用 `summary.today.avgLatencyMs`；旧 Host 无该字段时回退到 recent 事件均值）。
  - 近 14 天柱状图：CSS 柱（不引图表库），hover title 显示当日输入/输出/请求数；空数据显示占位文案。
  - 模型分布表：provider/model、请求数、输入、输出、缓存读、最近使用时间。
  - 类型分布：翻译 / 查词 的请求与 tokens。
- **轨迹**（v4 起以**翻译会话**为单位，见 [`DESIGN-CONVERSATIONS.md`](./DESIGN-CONVERSATIONS.md)；会话内每轮即 v3.1 的 Turn，历史内联视图保留在 [`DESIGN-TURN-TRACE.md`](./DESIGN-TURN-TRACE.md)）：
  - 按 Turn 分组：Turn 汇总行（kind/mode/站点/模型/耗时/步数/tokens/缓存/状态）+ 可展开 Steps；
  - 过滤：全部 / 翻译 / 查词 / 仅失败；刷新按钮；「加载更早」分页；「清空统计」（二次确认，`DELETE /usage`）。
  - 数据源 `GET /usage/turns`；旧 Host（404）回退 `GET /usage/events` 扁平行并提示。
  - 空态/加载态/错误态齐备。
- **设置**：直接复用现有 `TranslationSettings` 组件（模型/推理强度/目标语言/systemPrompt/userTemplate/批次/测试翻译）。
  **不复制实现**，只在不同容器中渲染同一个组件。
- **单词本**：复用现有 `WordbookPage`（`active` 控制复习轮询）。
- 数据刷新：页面挂载时拉 `GET /usage?days=14` 与 `GET /usage/turns?limit=20`；
  可见时每 5s 轮询 `/usage`（`document.visibilityState === 'visible'`），切到轨迹 tab 时刷新 turns；
  卸载/隐藏时清理 timer。错误在页面内显示（`InlineAlert`），不抛出槽外。
- 兼容：服务端无 `/usage`（404）时页面显示「Host 版本过旧」提示，设置/单词本仍可用。

### 3.3 设置页（现有 `settings.section`）增量

在现有「dsh翻译」设置页顶部加一条提示行：
「完整统计与提示词编辑也可在左侧工具栏的dsh翻译页面中完成」+「打开统计面板」按钮
（有 layout 才显示）。其余内容保持不变，减少回归面。

### 3.4 视觉与 i18n

- 只用 `--dsw-alias-*` token（沿用现有 CSS 变量与 `dsh-it-*` 前缀，新增 `dsh-it-usage-*`、`dsh-it-bars-*` 等）。
- 字号/间距与现有设置页一致（14/22 正文、12/18 次要、18/26 标题）。
- 所有文案走 `translate(key)`；在 client.js 顶部 zh/en 字典补齐新 key（前缀 `panel.`、`usage.`、`trace.`）。
- 数字格式：`1.2k` / `3.4M` 紧凑格式 + `title` 显示精确值；tokens 使用 `toLocaleString` 分组。
- a11y：tabs 用 `role=tab`/`aria-selected`/`aria-controls`，柱状图 `role=img` + `aria-label`；
  刷新态用 `aria-busy`，状态变化用 `role=status aria-live=polite`。

---

## 4. Chrome 扩展：浮窗 token 展示

### 4.1 协议（`background.js`）

- `ALLOWED_ROUTES` 增加 `usage: 'GET'`（→ `GET /dsh-immersive/api/usage`，query 透传）。
- 其他协议不变。`rpc('usage', { days: 2 })` 由 content 调用。

### 4.2 content.js 状态与累加

- `state.tokenStats = { page: {requests,inputTokens,outputTokens,cached}, last: null,
  today: {inputTokens,outputTokens,requests} | null, todayFetchedAt: 0 }`。
- `requestTranslations` 成功时：读取 `data.usage`（4 字段，缺省 0），累加到 `page`（每次请求 +1 requests；
  `data.cached` 为真时 +1 cached），更新 `last`；`refreshUi()` 刷新浮窗。
- 查词：`renderLookup(data)` 若 `data.usage` 存在，在查词卡底部显示小字「本次查询 输入 X · 输出 Y tokens」。
- 新任务开始（`startTranslate`）重置 `page` 计数；还原/页面跳转时也重置。
- 浮窗新增两行（放在“模型”行下方）：
  - `本页消耗`：`输入 X · 输出 Y`（+ 请求数/缓存命中 tooltip），未开始翻译显示「—」；
  - `今日累计`：`X tokens`（来自 `GET /usage` 的 `usage.today`；打开面板时刷新，节流 60s；
    API 404/失败静默隐藏该行）。
- 翻译完成状态行追加 token 摘要：`statusDoneTokens`（例：`翻译完成 · 本页消耗 1,234 tokens。`），
  保留原 `statusDone` 供无 usage 时回退。
- i18n：zh/en 字典补 `tokensPage`、`tokensToday`、`tokensInput`、`tokensOutput`、`tokensRequests`、
  `tokensCache`、`statusDoneTokens`、`cardTokens` 等 key。
- 不得改变现有抽取/注入/模式/懒加载逻辑；不得引入网络请求（仍全部经 background）。

### 4.3 版本与文档

- `manifest.json` 与 `content.js` 的 `EXT_VERSION` → `1.3.0`。
- 扩展 README 增加“Token 消耗展示”一节与手测项。

### 4.4 E2E

`tools/e2e-chrome.mjs`：
- mock `translate` 响应增加 `usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }`；
- mock `usage` 路由返回 `{ ok:true, usage:{ today:{…}, totals:{…} } }`；
- 新增断言：翻译后浮窗「本页消耗」出现数字；`/usage` 请求发生且今日累计出现；查词卡 token 行；
- 既有断言全部保持通过。

---

## 5. 验收标准

1. `cd dsh-web-translator && node --test test/` 全绿（原有 + 新增 usage/api/http/llm 测试）。
2. `node --check`：`lib/*.js`、`index.js`、`client.js`、`content.js`、`background.js`、`options.js` 全部通过。
3. 扩展：`node tools/verify.mjs` 与 `node tools/e2e-chrome.mjs` 全绿（含新增 token 断言）。
4. live（Lead 安装/合并后执行，成员不要安装）：
   - `curl /dsh-immersive/api/usage` 返回账本；一次 translate/lookup 后 totals/events 增长；
   - `cordis_inspect_query` Client `Slots.listSubTree` 可见 `main` occupant `immersive-translate` 与
     `sidebar.panellist` occupant `immersive-translate`；
   - 浏览器里点左侧工具栏图标 → 页面显示概览/轨迹/设置(提示词)/单词本，数据与 curl 一致；
   - headless Chrome 加载扩展 → 浮窗显示本页/今日 token。
5. 不破坏 v2 既有行为：设置页、单词本、扩展翻译/查词/还原全部回归通过。

---

## 6. 写入范围（互不重叠）

| 成员 | 写入范围 | 交付 |
|---|---|---|
| lead | `dsh-web-translator/{DESIGN-TOKEN-USAGE.md,README.md,package.json,index.js}`, 合并/安装/最终验证 | 契约、集成、live 验证 |
| host-api | `dsh-web-translator/lib/**`、`dsh-web-translator/test/**` | 账本、采集、路由、单测 |
| dsh-ui | `dsh-web-translator/client.js` | 左侧工具栏页面 + 统计/轨迹 UI + 提示词入口 |
| extension | `dsh-web-translator-extension/**` | 浮窗 token 展示、协议、E2E |
| qa-verify | `dsh-web-translator/qa/**` | 只读验证、截图、报告 |

---

## 7. 待定/后续（不在本轮）

- 扩展内查看完整轨迹（目前只在 DSH 页面）。
- Token 成本（货币）换算：DSH 未暴露统一价格表，暂不实现。
- 把翻译请求写入 DSH 会话日志以便复用原生 Trajectory：v2 明确不做（隐私/污染会话），继续自记账本。
