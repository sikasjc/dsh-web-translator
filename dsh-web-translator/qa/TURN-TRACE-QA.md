# TURN-TRACE-QA — 独立 QA 报告（DESIGN-TURN-TRACE v3.1 增量）

> 注：本报告引用的截图 / 日志 / 结果 JSON 可能包含真实页面标题等个人信息，**未随仓库提交**（`qa/.gitignore` 已忽略）；按文中命令可在本地重新生成。

> 后继说明（v4，2026-11-06）：本报告之后新增「翻译会话桥接 DSH 原生轨迹」增量（DESIGN-CONVERSATIONS），「轨迹」页已从 Turn 卡片列表改为**会话列表**，本报告中的面板截图/选择器描述由 v4 的 `qa/CONVERSATION-QA.md` + 重新生成的 `panel-shot.result.json` 取代；Turn/Steps 聚合与 `/usage/turns` 契约本身未变，`verify-turn-trace.mjs` 已更新版本断言与会话 UI/旧版回退静态检查并保持全绿（184/184）。
>
> 状态：**全部完成 — PHASE 1（静态 / 进程内 / 套件）PASS，PHASE 2（已安装插件 live + 面板截图）PASS，DESIGN-TURN-TRACE §5 验收 4/4 项通过，未发现缺陷。**
> QA 角色：`qa-turns`（独立验证者，不写源码）。工作区：`<repo>/.agents/worktrees/turn-trace-view`
> 契约：`dsh-web-translator/DESIGN-TURN-TRACE.md` §2/§3/§4/§5；未提及部分继续按 `DESIGN.md`（v2）与 `DESIGN-TOKEN-USAGE.md`（v3）。
> 被测版本：plugin **1.4.0** / extension **1.7.0**；worktree 提交 `1f4f69f`，上线合并提交 `cdd786f`。
> 现场（phase 2）：DSH Web GUI `http://127.0.0.1:3080`，live Host `version 1.4.0`，`GET /usage/turns` 200。

---

## 1. 范围与方法

本轮把「轨迹」页从“扁平请求列表”改为 DSH 风格的 **Turn + Steps**：
- Host：事件新增 `turnId / stepIndex / mode / outputPreview`；`usageService.turns()` 聚合；`GET /usage/turns`；
- Client：`client.js`「轨迹」Tab 的 Turn 卡片 / Steps / 输入→译出样例 / 加载更早 / 旧 Host 回退；
- Extension：每次翻译动作一个 `turnId`、每批 `stepIndex++`、`mode`；查词卡独立 `lk_` Turn。

独立 QA 的方式（不依赖实现者自己的测试）：
1. **静态契约检查**（精确正则 + 真实模块导入）；
2. **进程内契约测试**：导入插件公共入口 `lib/routes.js` / `lib/usage.js`，在临时 `dataDir` + 假 LLM 上启动真实 HTTP handler，按契约逐项驱动 `POST /translate|/lookup` 与 `GET /usage/turns`；
3. **旧账本兼容测试**：手写不含 Turn 字段的历史 `usage.json`，验证优雅降级；
4. **客户端/扩展静态契约**（i18n 双语字典、CSS token、a11y、payload 组装、E2E 断言存在性）；
5. **全套件**：host `node --test test/`、extension `tools/verify.mjs`、`tools/e2e-chrome.mjs`；
6. **已安装插件 live**：真实 HTTP + 无头 Chrome 面板验收与截图。

---

## 2. QA Harness（均在 `dsh-web-translator/qa/`）

| 文件 | 用途 | 运行 |
|---|---|---|
| `qa/verify-turn-trace.mjs` | **本轮新增**：Turn 契约独立验证（静态 + 进程内 + HTTP + client/extension 静态；`--full` 跑三套件） | `node qa/verify-turn-trace.mjs [--full] [--quiet]` |
| `qa/verify-token-stats.mjs` | v3 token 统计回归（版本断言放宽为 >= 1.3.0 以吸收本轮 bump） | `node qa/verify-token-stats.mjs` |
| `qa/live-check.mjs` | 已安装插件 live 契约：baseline + 增量事件 + **3 批同 turnId 的合成 Turn** + lookup Turn + `/usage/turns` 分组/求和/过滤/分页 + **全量分页 Turn 汇总 == `/usage` totals** 不变量 | `node qa/live-check.mjs` |
| `qa/panel-shot.mjs` | 无头 Chrome 面板验收：概览/设置/单词本 + **轨迹 Turn 卡片、最新一轮默认展开、展开 steps、输入→译出样例、step 详情、加载更早、0 console error** + 截图 | `node qa/panel-shot.mjs [--settings-roundtrip]` |
| `qa/cdp.mjs` | QA 专用 Chrome/CDP + GUI 鉴权（只接受 `DSH_URL` 启动 token 或操作者提供的 `DSH_COOKIE`） | 被 panel-shot 复用 |

本轮对既有 harness 的改动都只落在 `qa/**`；所有源码文件对 QA 只读，未安装/未重载插件、未调用 `plugin_manager`（安装与 DSH 重启由 Lead 完成）。

---

## 3. PHASE 1 结果（worktree 最终状态，提交 `1f4f69f`）

### 3.1 `qa/verify-turn-trace.mjs --full` — **181/181 PASS**（静态/进程内 178 + 3 套件）

| 分组 | 通过/总数 | 覆盖点 |
|---|---|---|
| syntax (`node --check`) | 37/37 | 全部 lib/*.js、index.js、client.js、package.json、qa 脚本、扩展 js + tools |
| host static contract | 28/28 | `LIMITS.turnIdChars=64 / modeChars=16 / stepIndexMax=10000 / outputPreviewChars=200 / usageTurnsDefault=20 / usageTurnsMax=100`；`usage.js` `turns()` + 新字段 normalize；`api.js` 校验/`outputPreview`/列表方法；`http.js` ROUTES `/usage/turns` GET + dispatch 的 limit/kind/status/before；版本 1.4.0；host test 覆盖 |
| usageService.turns()（确定性时钟） | 24/24 | turnId 分组；stepIndex 乱序写入→升序输出；requests/ok/errors/cached/token 求和；`ok/partial/error` 状态；mixed kind；单步 `durationMs=latencyMs`、多步 `endedAt-startedAt`；`avgLatencyMs`；legacy `evt:<id>` 单步 Turn；turnId/mode/outputPreview 截断 64/16/200；limit clamp 1..100；`before` 分页/未知 before 回退；kind/status 过滤 |
| host HTTP contract | 60/60 | 真实 handler：空页形状；4 个 Turn（3 步部分失败 / lookup / mixed / legacy）+ 乱序 stepIndex 0,1,2；`GET /usage/turns` 页形状/排序/过滤/分页（limit=2、before、limit=0、limit=100000）；`sum(turn counters)==/usage totals`；turn 内 token==sum(steps)；`/usage/events` 兼容且暴露新字段；持久化；边界值（turnId=64、stepIndex=0/10000、mode=16）通过；非法 turnId/stepIndex/mode → **400 BAD_REQUEST**（8 类 + lookup）；trim `turnId`/`mode`；`outputPreview` 截断 200；legacy 账本（旧事件缺字段）→ 1 事件 = 1 Turn、同 turnId 分组、截断不报错；`/usage` summary 兼容 |
| client.js 轨迹 Tab 静态契约 | 15/15 | `GET /usage/turns` + `before/nextBefore` 加载更早；404 → `/usage/events` 回退 + `trace.legacy` 提示；kind/status 过滤；5s 轮询保留；Turn/Steps i18n keys 在 zh **与** en 两套字典；`.dsh-it-turn*` / `.dsh-it-steps*` CSS；`aria-expanded` + button a11y；sample/outputPreview 渲染；最新一轮默认展开；概览/设置/单词本无回归 |
| Chrome extension Turn tagging 静态契约 | 14/14 | `makeTurnId('tr')`/`('lk')`；`runId/runStep/cardTurnId`；translate payload `turnId/stepIndex++/mode`；lookup payload `turnId + stepIndex 0`；run 结束清空 runId；`manifest/EXT_VERSION=1.7.0`；e2e 断言 turnId/stepIndex（5 处）；扩展 README 记录 |

### 3.2 全套件（phase 2 现场重跑，worktree 最终状态）

| 套件 | 结果 |
|---|---|
| host `node --test test/` | **193/193 pass, 0 fail** |
| extension `node tools/verify.mjs`（worktree） | **ALL 134 STATIC CHECKS PASSED** |
| extension `node tools/e2e-chrome.mjs`（worktree） | **69/69 E2E checks passed**（含 4 条新「轨迹」断言：同 run turnId 相同 + stepIndex 递增、新翻译动作新 turnId、lookup 带 lk_ turnId/stepIndex=0） |
| `qa/verify-token-stats.mjs`（v2/v3 回归） | **163/163 PASS** |

> 注：上线合并提交 `cdd786f` 同时带入了 main 分支既有的扩展「跟随翻译」增量，因此**合并树**的扩展套件为 verify 137 / e2e 73。QA 把合并后的 `<repo>/dsh-web-translator-extension` 复制到 `/tmp` 独立重跑确认：**137 static PASS、73/73 e2e PASS**；host 部分合并树与 worktree 源码/测试逐字节一致（`diff -rq` 无差异），193/193 同样适用。

### 3.3 Phase 1 结论

- 契约 §2（Host 账本/聚合/API）、§3（Client Turn UI 静态接线）、§4（扩展 tagging）在源码与进程内行为层面全部符合，未发现契约偏差。
- 说明（非缺陷）：`GET /usage/turns?kind=translate|lookup` 会包含 `kind=mixed` 的 Turn（同时含两类请求），与契约“按 Turn 类型过滤”的自然读法一致；QA 以“不包含纯另一类 Turn”作为断言口径。

---

## 4. PHASE 2 — 已安装插件 live 验收（DESIGN-TURN-TRACE §5）

现场：Lead 已安装/重载 plugin 1.4.0（`/health` 200 `version:1.4.0`，`/usage/turns` 200）。QA 未安装、未重启，只做只读验证与 live 探测。

### §5.1 Host 单测 — **PASS**
`node --test test/` **193/193 pass**（新增 turns 聚合/分页/过滤/旧数据兼容/HTTP 路由测试全绿）。

### §5.2 语法 / 扩展套件 — **PASS**
`node --check` 全部文件（37/37 syntax 检查）；extension `tools/verify.mjs` **134/134 PASS**（worktree）/ **137/137 PASS**（合并树独立重跑）；`tools/e2e-chrome.mjs` **69/69 PASS**（worktree）/ **73/73 PASS**（合并树独立重跑）。

### §5.3 live — **PASS（3/3 子项）**

**a) 3 批同 turnId → 1 个 Turn、steps=3、tokens 汇总正确** — **PASS**
- `qa/live-check.mjs`：**59/59 PASS**（4.4s）。
- 合成 3 批：`turnId=tr_qa_<tag>`、stepIndex 0/1/2、mode=bilingual、3 段不同文本（无缓存命中）→ `GET /usage/turns` 返回 **1 个 Turn、requests=3、steps=3、stepIndex 顺序 [0,1,2]、kind=translate、mode=bilingual、status=ok**；turn 的 input/output/cacheRead/cacheWrite tokens **== 其 3 个 steps 之和 == 对应 3 条 events 之和**；每步 `outputPreview` 存在；`sourceUrl/sourceTitle/client/site/targetLanguage` 正确；`startedAt/endedAt/durationMs/avgLatencyMs` 满足契约推导。
- 查词 Turn：`turnId=lk_qa_<tag>`、stepIndex=0 → 1 个 `kind=lookup`、steps=1、status=ok、outputPreview 存在。
- 过滤：`kind=translate` 含合成翻译 Turn 且不含 lookup Turn；`kind=lookup` 反之；`kind=error` 仅返回非 ok Turn。
- 分页：`?limit=1` 返回 1 个 Turn + `hasMore/nextBefore`；`?before=<id>` 返回下一条更旧 Turn 且无重叠；`?limit=0` clamp 为 1；未知 before 回退到首屏。
- **全量不变量**：翻页取完所有 Turn（**218 个 Turn**）后，turn 计数/token 桶汇总 **精确等于** `GET /usage` 的 `totals`（239 requests / 238 ok / 1 error / 25 cached / 33076 input / 11067 output …，before/after 快照范围内无并发漂移）；218 个 Turn id 无重复、整体按 `startedAt` 降序。
- Lead 预置的真实 Turn `tr_lead_turnverify_1` 复核（`qa/live-evidence/turn-lead-verify.json`）：3 steps、stepIndex [0,1,2]、369 input / 53 output tokens == steps 之和、samples 与 outputPreviews 均在、`sourceTitle="Turn Verify"`。

**b) 面板「dsh翻译 → 轨迹」：列出 Turn、展开见 steps 与输入/输出样例、加载更早可用** — **PASS**
`qa/panel-shot.mjs`：**48/48 PASS**（10.8s，headless Chrome + 真实 DSH GUI）：
- 4 个 Tab（概览/轨迹/设置/单词本）；「轨迹」渲染 **20 张 Turn 卡片**（`.dsh-it-turn`），与 `GET /usage/turns?limit=20` 页大小一致（±2 并发容差内）；
- 旧 Host 的「Host 版本过旧」回退提示**未出现**（`/usage/turns` 200，无 404 回退）；
- **最新一轮默认展开**：第 1 张卡 `aria-expanded=true`、有 body、3 个 step、3 个样例预览；
- 合成 3 批 Turn **合并为 1 张卡、3 个 step**，自动展开并显示 `输入样例 QA trace step 0 … → 译出样例 QA 跟踪步骤 0 …`；
- 点击另一张 Turn 头可展开 steps（body 2、step rows 4）；点击 step 行可展开 tokens/时延明细（detail 面板出现）；
- **「加载更早」** 按钮存在，点击后 Turn 卡片 **20 → 40**（追加更旧一页成功）；
- `/usage/turns` 由页面发起且全部 200；**console errors = 0、page exceptions = 0**。
- 截图归档：`qa/token-stats-traces-turns.png`（Turn 列表 + 最新一轮展开 + steps + 输入→译出样例）、`qa/token-stats-traces-turn-expanded.png`（再展开第 19 轮，两张卡同时展开 steps）——本地生成。

**c) 不破坏既有功能 / 不变量** — **PASS**
- `GET /usage` 200：`totals == sum(days)`、`totals == sum(byModel)`（requests+tokens）、`totals == sum(byKind)`、`today == days[today]` 均成立（`qa/live-check.mjs`）；
- `GET /usage/events` 200 且仍 newest-first、字段齐全（旧客户端兼容），新事件额外携带 `turnId/stepIndex/mode/outputPreview`（additive，不破坏旧 shape）；
- 概览「今日」统计与同刻 `GET /usage.today` **逐项相等**（chip：输入 32,112 / 输出 10,921；stat cards：requests/input/output/cacheRead/errors 全部一致）→ 今日 token 统计未被本功能改变；模型 chip == `GET /settings` selected provider/model；
- 设置 / 单词本 Tab 正常渲染并可与 `GET /settings` / `GET /wordbook` 交叉核对；`/dsh-immersive/api/*` 无 4xx/5xx；
- 演示/截图中的悬浮猫形象来自另一个插件 `dsh-pet`（与本功能无关，浮在面板右上角遮挡少量像素，不影响 Turn 内容可读性）。

### §5.4 不破坏 v2/v3 既有功能 — **PASS**
概览 / 设置 / 单词本 / 扩展翻译与查词 / `/usage` / `/usage/events` 均保持工作（见 §3.2、§4 c）。扩展 e2e（合并树 73/73）覆盖既有翻译/查词/还原/右键/选项页流程全绿。

---

## 5. 证据文件

| 类别 | 文件 |
|---|---|
| 独立静态/进程内 harness | `qa/verify-turn-trace.result.json`（181/181，full=true）、`qa/verify-token-stats.result.json`（163/163） |
| Live 契约 | `qa/live-check.result.json`（59/59）、`qa/live-evidence/`：`health.json`、`usage-before/after-translate/after-lookup/final.json`、`turn-steps.json`、`turn-created.json`、`turns-page.json`、`turns-filter-translate/lookup/error.json`、`turns-pagination.json`、`turns-all-pages.json`、`turn-lookup.json`、`turn-lead-verify.json`、`translate*/lookup*/extension-event.json` |
| 面板验收 | `qa/panel-shot.result.json`（48/48，含 `crossChecks.turns/turnAutoExpand/turnExpand/stepExpand/loadMore/usage`） |
| 截图 | `qa/token-stats-traces-turns.png`、`qa/token-stats-traces-turn-expanded.png`（本轮新增/更新）；`qa/token-stats-panel.png`、`qa/token-stats-settings.png`、`qa/token-stats-wordbook.png`、`qa/token-stats-panel-dark.png`（回归截图，已由本次现场运行刷新） |

---

## 6. 已知限制 / 注意事项

- **Live 账本并发**：另一个活跃 Chrome 扩展会持续写入真实事件；live 断言用唯一 `turnId`/`sourceTitle`/`tag` 定位自己的数据，并以“before/after 快照区间”校验全量 Turn 汇总，不依赖绝对条数；面板卡片数与 API 页大小比较带 ±2 容差。
- **旧数据兼容**：安装前的历史事件没有 turn 字段，面板中各自成为 1 步 Turn（`id=evt:<eventId>`）；因此「加载更早」在有历史账本时必然出现（>20 Turn）。
- **缓存命中**：同文本重复请求可能命中 Host 翻译 LRU（tokens=0、cached=1），live 断言不依赖单步 tokens 非零，改用“turn 汇总 == steps 汇总 == 事件汇总”。
- **kind=mixed 过滤**：`kind=translate|lookup` 同时返回 mixed Turn（见 §3.3），非缺陷。
- **`/usage/turns` 聚合来源**：基于账本保留的事件列表（`LIMITS.usageEvents=500` 上限）内存聚合，不是持久化 Turn 表；超过 500 条的最旧事件不参与聚合（契约 §2.2 实现口径；当前 live 账本 242 requests 远小于上限）。
- **浏览器缓存**：Lead 已重载 DSH；普通浏览器中的 DSH 页面如仍显示旧 UI，需硬刷新以加载新 `client.js`（headless 验收用全新 profile，无此问题）。
- **panel-shot 退出**：headless Chrome/CDP 的 WebSocket 可能在报告写完后保持 Node event loop，已加 300ms 强制退出 + 8 分钟 watchdog，避免 QA 卡住。

---

## 7. 缺陷记录

| # | 严重度 | 现象 | 状态 |
|---|---|---|---|
| — | — | phase 1 / phase 2 均未发现契约缺陷或回归 | — |

**结论：DESIGN-TURN-TRACE §5 验收 4/4 项 PASS；本轮可交付。**
