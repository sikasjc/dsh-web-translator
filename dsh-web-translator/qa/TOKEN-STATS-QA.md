# dsh翻译 · Token 消耗统计 / 轨迹 / 左侧工具栏页面 — 独立 QA 验证报告

> 注：本报告引用的截图 / 日志 / 结果 JSON 可能包含真实页面标题等个人信息，**未随仓库提交**（`qa/.gitignore` 已忽略）；按文中命令可在本地重新生成。

> 验证者：**qa-verify**（独立 QA；源码只读，只写 `dsh-web-translator/qa/**`）
> 契约：[`DESIGN-TOKEN-USAGE.md`](./DESIGN-TOKEN-USAGE.md)（v3，§5 为验收标准）+ [`DESIGN.md`](./DESIGN.md)（v2 既有行为）
> 被测代码：git worktree `.agents/worktrees/immersive-token-stats`，commit **ef65966**（merge 前的已验证版本；sha256 见 `qa/evidence/final-state.txt`）
> 合并后主工作区：HEAD **099ad05**（`feat: configurable paragraph line-break mode (ext 1.4.0, plugin 1.2.0)`），扩展 working tree 为 **1.4.x（manifest 当前值 1.4.1，2026-11-06 01:06 读取；另一 agent 仍在编辑，版本可能继续变化）**；其在 token 相关 host 文件上与 ef65966 逐字节一致，`translate.js` 另有后续换行归一化改动（见 §5-2）
> Live 环境：DSH Web GUI `http://127.0.0.1:3080`，安装后插件版本 `1.2.0`
> 报告中时间：2026-11-06（Asia/Shanghai）

---

## 0. 结论摘要（TL;DR）

**结论：PASS** — DESIGN-TOKEN-USAGE §5 的 5 项验收标准全部通过；未发现阻塞缺陷。
另记录了 7 条非阻塞观察/已知限制（§5），均不影响本轮交付。

| # | 验收项（§5） | 结果 | 主要证据 |
|---|---|---|---|
| 1 | `node --test test/` 全绿 | ✅ PASS | 176/176（`qa/evidence/host-tests.log`） |
| 2 | `node --check` 全部文件通过 | ✅ PASS | qa harness 内置 node --check：全部 lib/*.js、index.js、client.js、扩展 3 个 JS + tools/*.mjs |
| 3 | 扩展 `tools/verify.mjs` + `tools/e2e-chrome.mjs` 全绿（含 token 断言） | ✅ PASS | worktree(契约 1.3.0)：verify 119/119、e2e 46/46（`qa/evidence/ext-verify.log`、`ext-e2e.log`）；合并后主工作区（ext 1.4.x，01:06）：verify 120/120、e2e 54/54（`qa/evidence/main-workspace-*.log`） |
| 4 | live：curl `/usage` 账本增长；Client Slots 可见 main+sidebar occupant；浏览器面板 4 tab 且数据与 curl 一致；headless Chrome 扩展浮窗 token | ✅ PASS（4a/4b/4c/4d 全部直接验证；4b 由 Lead 会话复核成功） | live-check 39/39、panel-shot 44/44、Client Slots occupant 见 §6.5、截图 7 张与 JSON 证据见 §6 |
| 5 | 不破坏 v2 既有行为（设置页、单词本、扩展翻译/查词/还原） | ✅ PASS | host 176 单测含全部 v2 用例；扩展 e2e 46/46 含既有翻译/模式/查词/单词本/还原/懒加载断言；live 设置/单词本 tab 回归通过 |

独立 QA 总检查量：静态/契约 harness **163/163**（worktree ef65966，含 in-process HTTP/账本集成）、host 单测 **176/176**、扩展静态 **119/119**、扩展 E2E **46/46**、live 检查 **39/39（含 DELETE 流程）**、浏览器面板检查 **44/44**。
合并后主工作区（HEAD 099ad05 + ext working tree 1.4.x，2026-11-06 01:06 复跑）：host **186/186**、扩展静态 **120/120**、扩展 E2E **54/54**（同一时刻文件 sha256 记录在 `qa/evidence/main-workspace-revision.txt`；该扩展仍被另一 agent 编辑，计数/版本可能继续变化）。

---

## 1. 验证环境与版本指纹

| 项目 | 值 |
|---|---|
| worktree | `<repo>/.agents/worktrees/immersive-token-stats` |
| 被测 commit | `ef65966`（feat: token usage ledger + usage APIs + DSH left-toolbar page + extension float token display） |
| host 文件指纹 | `dsh-web-translator/{index.js,client.js,lib/*.js,package.json}` sha256 收录于 `qa/evidence/final-state.txt` |
| 合并校验 | 主工作区 host 的 **token 相关文件**（usage.js/api.js/http.js/llm.js/constants.js/client.js/index.js）sha256 与 ef65966 **逐字节一致**；`translate.js`/`package.json`/`version.js` 因后续换行归一化功能另有改动（不影响 token 采集，见 §5-2） |
| 合并后主工作区复跑 | HEAD `099ad05` + 扩展 working tree **1.4.x（manifest 当前值 1.4.1）**，2026-11-06 **01:06**：host `node --test test/` **186/186**、扩展 `tools/verify.mjs` **120/120**、扩展 `tools/e2e-chrome.mjs` **54/54**；文件 sha256 与时间戳记录于 `qa/evidence/main-workspace-revision.txt`、日志 `qa/evidence/main-workspace-*.log`（该扩展仍被另一 agent 编辑，版本/计数可能继续变化；Lead 在 ext 1.4.0 时测得 55/55） |
| Live host | DSH web 3080，插件 `/health` = **`1.2.0`**；`GET /dsh-immersive/api/usage` HTTP **200** |
| 浏览器 | Headless Chrome（`--headless=new`，临时 profile，CDP）；GUI 认证使用 `DSH_URL` 中的启动 token 链接，或由操作者提供 `DSH_COOKIE`（QA 脚本不读取 DSH 凭据、不派生 cookie） |
| 数据目录 | `$DSH_HOME/immersive-translate/{settings,wordbook,usage}.json` |

> 安全说明：DSH Web GUI 需要启动 token（`dsh web` 打印的 `?token=...` URL）或已认证的浏览器 cookie。QA 只通过 `DSH_URL`/`DSH_COOKIE` 环境变量接收凭据，不读取 DSH 凭据文件、不派生 cookie；本报告与仓库中**不存在**任何 secret 或具体 cookie 值。

---

## 2. §5 验收标准矩阵（逐项）

### §5.1 Host 单测 `cd dsh-web-translator && node --test test/`

**结果：✅ PASS — tests 176 / pass 176 / fail 0**（`qa/evidence/host-tests.log`）

覆盖（新增部分）：`test/usage.test.mjs`（空账本、成功/失败/缓存事件、日聚合、模型/类型聚合、事件上限与顺序、分页+过滤、clear、90 天裁剪、坏文件恢复、并发串行、坏 store 容错、字符串截断）、`test/api.test.mjs`（新端点 + translate/lookup 成功/失败采集 + 元数据校验）、`test/http.test.mjs`（路由表含 DELETE、方法 405、Origin fence 回归）、`test/llm.test.mjs`（四桶 usage 透传）。

### §5.2 `node --check`（lib/*.js、index.js、client.js、content.js、background.js、options.js）

**结果：✅ PASS** — `qa/verify-token-stats.mjs` 使用 `node --check` 逐文件执行：lib/ 全部 19 个 JS、`index.js`、`client.js`、扩展 `content.js`/`background.js`/`options.js`、扩展 `tools/*.mjs`、qa 自身脚本，全部 exit 0。

### §5.3 扩展 `node tools/verify.mjs` + `node tools/e2e-chrome.mjs`

**结果：✅ PASS**
- `node tools/verify.mjs` → **ALL 119 STATIC CHECKS PASSED**（含 manifest 1.3.0、EXT_VERSION 1.3.0、`ALLOWED_ROUTES.usage`、i18n keys、CSP/权限/图标等）。`qa/evidence/ext-verify.log`
- `node tools/e2e-chrome.mjs` → **46/46 E2E checks passed**，Headless Chrome + mock DSH API（未触发真实模型调用）。新增 token 断言全部通过：
  - `Token：浮窗「本页消耗」= translate 响应 usage 累计（输入/输出）` — 实测 输入 363 · 输出 183（3 次响应累计）；
  - `Token：「今日累计」经 background GET /usage 并用 usage.today 渲染` — 4,690 tokens（输入 3,456 · 输出 1,234 · 请求数 7）；
  - `Token：翻译完成状态行追加本页 token 摘要（statusDoneTokens）`；
  - `查词卡：显示「本次查询 输入 X · 输出 Y tokens」` — 输入 21 · 输出 8；
  - `还原：「本页消耗」清零回到「—」`；
  - `元数据：translate/lookup 请求体带 client=extension + sourceUrl/sourceTitle`。
  - 既有断言（注入/三模式/懒加载/查词/单词本/还原/options）全部保持通过。`qa/evidence/ext-e2e.log`

### §5.4 Live（安装后）

**结果：✅ PASS（4a / 4b / 4c / 4d 全部直接验证）**

前置确认：`GET /health` → `{"ok":true,"version":"1.2.0","uptimeMs":…,"llm":{"providers":5,"models":89}}`（主工作区 HEAD `099ad05`，含已合并的 token-stats 功能 + 另一 agent 的换行归一化后续提交）；`GET /usage` HTTP **200**。

- **4a curl 账本增长**：`GET /usage` 基线（当日已有真实流量）→ 一次 `POST /translate` + 一次 `POST /lookup` 后，按 delta 校验 `totals.requests` 各 +1、`ok` +1、事件按 `sourceTitle` 唯一 tag 可定位；`totals == sum(days) == sum(byModel) == sum(byKind)`；事件 newest-first；四桶 token/时延非负；cached ⇒ tokens 记 0。**live-check 39/39 PASS**（见 §6.1）。
- **4b Client Slots inspect**：QA 会话 4 次 10s 超时后，**Lead 在自身会话复核成功**（2026-11-06 01:08，live 插件 1.2.0）：
  - `root="main"` → `selected.occupants` 含 `{registrant:"tk", key:"immersive-translate", priority:0, active:true}`；
  - `root="sidebar.panellist"` → `selected.occupants` 含 `{registrant:"tk", id:"immersive-translate", order:2, priority:0, active:true}`（在 plugins(0)/dsh-market(1) 之后、schedules(10) 之前）。
  - 完整响应摘录见 §6.5。等价 DOM/动态 apply 证据仍作为补充保留（§5-1）。
- **4c 浏览器面板**：headless Chrome 点击左侧工具栏图标 → 主面板切换为「dsh翻译」页，4 tab（概览/轨迹/设置/单词本）全渲染；概览今日 chip/卡片与**同刻** `GET /usage` 逐项一致（3,696 输入 / 1,078 输出 / 32 请求 / 128 缓存读 / 0 失败，首次采样即匹配）；轨迹 32 行、展开详情含客户端 `extension`、站点 `example.com`、来源链接/样例；设置/单词本 tab 可用；深色主题截图成功；**0 console error / 0 warning / 0 uncaught exception / 0 失败资源**。**panel-shot 44/44 PASS**（截图见 §7）。
- **4d headless Chrome 扩展浮窗 token**：按 Lead 指示**不驱动真实扩展**（另一 agent 正在用自己的真实扩展测试）。扩展侧以 worktree 交付版（契约 1.3.0）的 `tools/e2e-chrome.mjs` Headless Chrome + mock DSH 验证：浮窗「本页消耗/今日累计/状态行/查词卡 token」全部通过（46/46，见 §5.3）；同时 live 账本中已记录另一 agent 真实扩展的真实事件（`client=extension`、站点/标题/段数/字符/四桶 token/时延齐全，newest-first），证明 Host↔扩展协议在真实链路生效。主工作区扩展已随后续提交演进到 **1.4.x（manifest 当前值 1.4.1，01:06 读取）**：QA 在 main HEAD 099ad05 + 该 working tree 上复跑 `verify.mjs` 120/120、`e2e-chrome.mjs` 54/54（同一时刻 sha256 记录于 `qa/evidence/main-workspace-revision.txt`；Lead 在 ext 1.4.0 时测得 55/55，该扩展仍被另一 agent 编辑）。

### §5.5 不破坏 v2 既有行为

**结果：✅ PASS**
- Host：176 单测中 v2 用例（settings/api/http/wordbook/srs/parse/store/llm/origin/index/dictionary/prompts）全部通过；`GET /health`、`GET/PUT /settings`、`/wordbook/*` 行为不变。
- Client：`settings.section` 注册保留（动态 apply() 校验），设置页与单词本页复用同一组件、无复制实现（静态检查 `h(TranslationSettings)`/`h(WordbookPage)` 各 ≥2 处 + live 设置/单词本 tab 渲染通过）。
- 扩展：e2e 46/46 全部既有翻译/查词/模式/懒加载/还原断言通过（见 §5.3）。
- 旧版 Host 兼容（契约 §1/§3.2）：已用「新 client + 旧 host」真实 GUI 验证 —— 面板正常注册并显示 4 tab，`Host 版本过旧` 告警出现，设置/单词本 tab 仍可用，页面无异常；截图与结果存于 `qa/evidence/outdated-host/`（`token-stats-panel.png`、`panel-shot.result.json`）。

---

## 3. Lead 追加检查项

Lead 在安装 ping 中追加了 5 项检查，逐项结果：

- **(a) 概览 今日/累计 token 数与同刻 `GET /usage` 一致** —— ✅ PASS。panel-shot 在截图后立即从 Node 侧读取 `GET /usage` 与 `GET /settings` 并比对：今日 chip `title="今日：输入 3,696 · 输出 1,078 tokens"` = `usage.today.inputTokens/outputTokens`；概览 5 张今日卡（请求数 32、输入 3,696、输出 1,078、缓存读 128、失败 0）与 `usage.today` 完全一致；模型 chip `模型 modelhub/deepseek-flash` = `settings.selected`。因另一 agent 的真实扩展同时在写入，脚本内置最多 4 次重采样——本次第 1 次采样即精确匹配（attempt=1）。证据：`qa/panel-shot.result.json` → `crossChecks.usage`。
- **(b) 点击左侧工具栏图标切换主面板 + 激活态** —— ✅ PASS。点击前主区为会话列表/欢迎内容；点击后主区文本切换为「dsh翻译 … 概览/轨迹/设置/单词本」；侧边栏按钮 `aria-current="page"` 为 `true`。
- **(c) 设置 tab 保存提示词 + 单词本回归（改后恢复）** —— ✅ PASS（单词本部分见限制 §5-7）。
  - 保存：在设置 tab 的系统提示词 textarea 写入 `[qa-roundtrip] ` 前缀 → 点「保存设置」→ 页面出现「设置已保存」→ `GET /settings` 确认持久化（长度 400→415）；截图 `token-stats-settings-saved.png`。
  - 恢复：脚本 finally 中通过 `PUT /settings` 把原提示词逐字节写回 —— 复核 `GET /settings`：长度 400、无 `[qa-roundtrip]` 残留，`provider/model/targetLanguage/reasoningEffort/userTemplate` 均未变。副作用：`selected.source` 由 `default` 变为 `settings`（内容等价，见 §5-6）。
- **(d) DSH 页面 console errors/warnings** —— ✅ PASS（干净）。panel-shot 全程记录：boot + 4 tab 切换 + 轨迹展开 + 设置保存 + 深色切换 = **0 console error、0 console warning、0 uncaught exception、0 失败网络资源**；`/dsh-immersive/api/*` 全部 2xx。
- **(e) 轨迹页显示 extension 来源事件的 site/client** —— ✅ PASS。按指示不驱动真实扩展，改为 synthetic `POST /translate {sourceUrl, sourceTitle, client:"extension"}`（同文本命中缓存 → 0 token 成本）：轨迹 tab 显示 32 行；展开该事件详情含「客户端 extension」「站点 example.com」「来源标题 QA extension-origin event …」「来源链接 https://example.com/article/qa-extension-…」「样例 Hello world」「输入/输出 tokens 0/0（缓存命中 是）」。截图 `token-stats-traces-detail.png`；真实扩展事件同样出现在列表中（client=extension）。

---

## 4. 命令与结果（可复现）

在 worktree 根目录执行：

```bash
# 1) 独立 QA 静态 + 契约 harness（163 项，含 in-process HTTP/账本集成）
cd dsh-web-translator && node qa/verify-token-stats.mjs
# => 163/163 checks PASS（结果 JSON：qa/verify-token-stats.result.json）

# 2) Host 单测
cd dsh-web-translator && node --test test/
# => tests 176 / pass 176 / fail 0（qa/evidence/host-tests.log）

# 3) 扩展静态校验
cd dsh-web-translator-extension && node tools/verify.mjs
# => ALL 119 STATIC CHECKS PASSED（qa/evidence/ext-verify.log）

# 4) 扩展 E2E（Headless Chrome + mock DSH API）
cd dsh-web-translator-extension && node tools/e2e-chrome.mjs
# => 46/46 E2E checks passed（qa/evidence/ext-e2e.log）

# 5) live API 契约检查（安装新插件后；--delete-usage 有备份地验证 DELETE + 复填）
cd dsh-web-translator && node qa/live-check.mjs
cd dsh-web-translator && node qa/live-check.mjs --delete-usage
# => 39/39 checks PASS（含 DELETE /usage 全流程；qa/live-check.result.json、qa/evidence/live-check-delete-run.log）

# 6) Live 浏览器面板验收（截图 + 数据交叉核对 + 设置提示词保存/还原）
cd dsh-web-translator && node qa/panel-shot.mjs --settings-roundtrip
# => 44/44 checks PASS（qa/panel-shot.result.json、qa/evidence/panel-shot-live.log）

# 7) Client Slots 检查（cordis_inspect_query，root=main / sidebar.panellist）
# => QA 会话 10s 超时；Lead 会话复核成功，见 §6.5（main occupant key=immersive-translate active=true；
#    sidebar.panellist occupant id=immersive-translate order=2 active=true）

# 8) 合并后主工作区复跑（2026-11-06 01:06，HEAD 099ad05，ext working tree 1.4.1）
cd <repo>/dsh-web-translator && node --test test/
# => tests 186 / pass 186 / fail 0（qa/evidence/main-workspace-host-tests.log）
cd <repo>/dsh-web-translator-extension && node tools/verify.mjs
# => ALL 120 STATIC CHECKS PASSED（qa/evidence/main-workspace-ext-verify.log）
cd <repo>/dsh-web-translator-extension && node tools/e2e-chrome.mjs
# => 54/54 E2E checks passed（qa/evidence/main-workspace-ext-e2e.log；文件 sha256 记录于 main-workspace-revision.txt）
```

辅助脚本（均在 `qa/`）：
- `verify-token-stats.mjs` — 独立静态/契约 harness（不引用实现方测试 helpers；in-process 启动真实 HTTP handler + 临时 dataDir + fake LLM，验证账本语义与全部端点）。
- `panel-shot.mjs` + `cdp.mjs` — Headless Chrome/CDP 面板验收（含 4 tab 截图、与 curl 同刻数据交叉核对、轨迹详情、设置提示词 UI 保存+HTTP 还原、单词本交叉核对、深浅色、console 错误/告警采集）。
- `live-check.mjs` — Live HTTP 契约检查（前后对比、`--delete-usage` 先备份后清空并复填）。
- `hold-page.mjs` — 保持一个已认证 headless 页面连接，供 `cordis_inspect_query` 使用。
- `mock-panel-server.mjs` — 自测用 mock DSH 面板页（panel-shot 44/44 自检通过）。

---

## 5. 缺陷、观察与已知限制

本功能未发现阻塞缺陷。以下是 7 条非阻塞观察/限制，不影响本轮验收：

1. **Client Slots inspect：QA 会话超时、Lead 会话复核成功**（非缺陷）。QA 会话内 `cordis_inspect_query` platform=client `Slots.listSubTree` 4 次 10s 超时（旧/新插件、有/无已认证 headless 页面连接都试过），host 侧 inspect 正常；**Lead 在其会话对 live 插件（1.2.0）复核成功**：`main` occupant `key=immersive-translate, active=true`，`sidebar.panellist` occupant `id=immersive-translate, order=2, active=true`（§6.5）。等价 DOM/动态 apply 证据保留作为补充。
2. **安装版本 1.2.0 ≠ 本报告验证版本 1.1.0**：主工作区在合并 token-stats 后又由另一 agent 提交两个「段落换行归一化」功能（`e54e046`、`099ad05`）。token 相关 host 文件（`usage.js/api.js/http.js/llm.js/constants.js/client.js`）sha256 与已验证的 worktree 版本**逐字节一致**（`qa/evidence/installed-live-state.txt`）；`translate.js` 多出的 `normalizeSegmentText` 属非 token 改动，live 验证不受影响。扩展主工作区副本为 1.4.x（manifest 当前值 1.4.1，01:06 读取；当时复跑 verify 120/120、e2e 54/54；Lead 在 1.4.0 测得 55/55；另一 agent 仍在编辑，版本/计数可能继续变化），本 QA 扩展证据对应契约要求的 worktree 1.3.0（46/46）。
3. **`avgLatencyMs` 为额外派生字段**：`totals/today/byKind` 中除契约 §2.1 的 8 桶外还有 `avgLatencyMs`（UI 平均时延卡使用）。属 additive 扩展，不破坏契约；建议下版契约文档同步补记。
4. **并发真实流量下的验证方法**：phase 2 期间另一 agent 的真实 Chrome 扩展持续向 3080 写入事件（`client=extension`），所有 live 断言均采用 **delta + 唯一 tag 事件定位**；面板交叉核对内置 4 次重采样（本次 attempt=1 命中）。证据文件里他人站点元数据已脱敏为 `[redacted live traffic]`。
5. **live DELETE 的副作用**：按 Lead 指示最后执行，先备份 `$DSH_HOME/immersive-translate/usage.json` 到 `/tmp/dsh-qa-usage-backup-*.json`（未入库），DELETE 会同时清掉他人测试产生的事件（Lead 已授权）；随后立即用一次 translate 复填（缓存命中，0 token）。备份文件含删除前 35 条请求的完整账本，如需保留请自行迁移。
6. **设置 roundtrip 的 `selected.source` 副作用**：原设置为 `default`（继承 DSH 默认模型/提示词）；恢复时按 Lead 指示 `PUT` 回原 systemPrompt，内容逐字节恢复但配置来源变为 `settings`。当前效果与 `default` 等价（模型/目标语言/提示词相同），仅未来 DSH 默认提示词变更时不再自动继承。
7. **单词本 live 为空（0 条）**：`GET /wordbook` 返回 `items: []`，单词本 tab 正确渲染空状态（「单词本还是空的」）且无报错；因无既有词条，无法交叉验证「列出已有词条」。若需覆盖，可在有词条的 profile 上重跑同一截图脚本。

另：所有截图中右侧卡通形象是你安装的其他 DSH 插件装饰（与本功能无关），个别位置轻微遮挡按钮/字段；对应 DOM 断言均另行校验通过。

---

## 6. Live 证据摘要

以下均为 2026-11-06 01:00–01:01（Asia/Shanghai）实机采集，完整 JSON 在 `qa/live-evidence/`，整套测试输出在 `qa/evidence/`。

### 6.1 Live host 与账本增长（live-check，39/39 PASS）

```
GET /health  → {"ok":true,"version":"1.2.0","uptimeMs":…,"llm":{"providers":5,"models":89}}
GET /usage   → 200 {"ok":true,"usage":{"version":1,"updatedAt":1793898106165,
                 "totals":{"requests":35,"ok":35,"errors":0,"cached":8,
                           "inputTokens":3789,"outputTokens":1081,
                           "cacheReadTokens":128,"cacheWriteTokens":0,"avgLatencyMs":716}}}
```
（删除前账本：35 请求 / 35 成功 / 0 失败 / 8 缓存命中 / 输入 3,789 / 输出 1,081 / 缓存读 128；其中含 QA 与另一 agent 真实扩展的事件。）

单次 translate 响应（未命中缓存时，来自 additive 轮）：`{"ok":true,"translations":["你好，世界"],"provider":"modelhub","model":"deepseek-flash","reasoningEffort":"off","usage":{"inputTokens":116,"outputTokens":10,"cacheReadTokens":0,"cacheWriteTokens":0},"cached":false,"retries":0}`，对应事件含 `client=qa, site=example.com, segments=1, chars=11, sample="Hello world", latencyMs=825`。

单次 lookup 响应（`qa/live-evidence/lookup-response.json`）：
```
{"ok":true,"result":{"text":"hello world","translation":"你好，世界",
 "provider":"modelhub","model":"deepseek-flash"},
 "usage":{"inputTokens":93,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0},"retries":0}
```
lookup 事件：`kind=lookup, ok=true, retries=0, client=qa, provider=modelhub, model=deepseek-flash, inputTokens=93, outputTokens=3, latencyMs=945`。

事件与聚合不变式（全部 PASS）：`totals == sum(days) == sum(byModel) == sum(byKind)`；事件 newest-first（`at: …106165, …106155, …105204, …034112, …034104`）；`today == days[today]`；`recent` 上限 20；所有桶非负整数；`cached` 请求 tokens=0 且计入 requests/cached。

### 6.2 DELETE /usage（最后执行，有备份）

```
DELETE /usage → 200 {"ok":true,"cleared":true,"usage":{"version":1,"totals":{...全 0...}}}
备份：/tmp/dsh-qa-usage-backup-1793898106172.json（删除前 35 条请求完整账本，未入库）
删除后 GET /usage → totals.requests=0，无本 run 的 tag 事件残留
复填：POST /translate → {"cached":true,...}；删除复填后即刻 GET /usage → totals requests=1（缓存命中，0 token；此前记录快照时间 01:01）
落盘：$DSH_HOME/immersive-translate/usage.json（version=1, days=1, events=1）
```

### 6.3 浏览器面板数据同刻交叉核对（panel-shot，44/44 PASS）

```
面板今日 chip: "今日 4.8k tokens" (title="今日：输入 3,696 · 输出 1,078 tokens")
GET /usage.today: {"requests":32,"ok":32,"errors":0,
                   "inputTokens":3696,"outputTokens":1078,"cacheReadTokens":128,"cacheWriteTokens":0}
概览今日卡: 请求数 32 / 输入 3,696 / 输出 1,078 / 缓存命中 128 / 失败 0 / 平均时延 754 ms
模型 chip: "模型 modelhub/deepseek-flash"；GET /settings.selected: {"provider":"modelhub","model":"deepseek-flash"}
轨迹行数: 32；展开详情: 客户端 extension · 站点 example.com ·
 来源链接 https://example.com/article/qa-extension-… · 样例 Hello world · 缓存命中 是
console: 0 error / 0 warning / 0 exception；/dsh-immersive/api 全部 200；深色主题 body bg 255,255,255 → 21,21,23
```

### 6.4 设置提示词 UI 保存 + HTTP 恢复

```
GET /settings (before): source=default, systemPrompt len=400
UI 编辑 → [qa-roundtrip] 前缀, 点击「保存设置」→ 页面「设置已保存」
GET /settings (after save): source=settings, len=415, startsWith("[qa-roundtrip] ")=true
PUT /settings {systemPrompt: 原始 prompt} → 200
GET /settings (restored): len=400, 无 marker, provider/model/targetLanguage/userTemplate 未变
```

### 6.5 Client Slots inspect（Lead 复核成功）

QA 会话内 4 次 10s 超时（可能因为 client inspect 只应答「当前所视 agent 会话」的转发），但 **Lead 会话复核成功**（2026-11-06 01:08，live 插件 1.2.0）：

`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={root:"main"})` →
```json
"selected": { "type": "slot", "name": "main", "kind": "keyed", "scope": "root",
  "occupants": [
    { "registrant": "tk", "key": "immersive-translate", "priority": 0, "active": true },
    { "registrant": "tk", "key": "plugins", "priority": 0, "active": true },
    { "registrant": "tk", "key": "conversation", "priority": 0, "active": true },
    { "registrant": "tk", "key": "schedules", "priority": 0, "active": true },
    { "registrant": "dsh-market", "key": "dsh-market", "priority": 0, "active": true }
  ] }
```

`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={root:"sidebar.panellist"})` →
```json
"selected": { "type": "slot", "name": "sidebar.panellist", "kind": "list", "scope": "root",
  "occupants": [
    { "registrant": "tk", "id": "plugins", "order": 0, "priority": 0, "active": true },
    { "registrant": "dsh-market", "id": "dsh-market", "order": 1, "priority": 0, "active": true },
    { "registrant": "tk", "id": "immersive-translate", "order": 2, "priority": 0, "active": true },
    { "registrant": "tk", "id": "schedules", "order": 10, "priority": 0, "active": true }
  ] }
```

结论：`main` 与 `sidebar.panellist` 两个槽位的 occupant 均存在且 `active: true`，id/key 一致（同一 id 使侧边栏按钮选中对应主面板），位置符合契约（order=2）。

---

## 7. 截图清单

| 文件 | 内容 |
|---|---|
| `qa/token-stats-panel.png` | 左侧工具栏「dsh翻译」页面 — 概览（今日卡、14 天柱状图、模型/类型分布），浅色 |
| `qa/token-stats-traces.png` | 轨迹 tab（过滤/刷新/清空 + 事件行） |
| `qa/token-stats-traces-detail.png` | 轨迹事件展开详情（含客户端/sourceUrl/样本） |
| `qa/token-stats-settings.png` | 设置 tab（复用 TranslationSettings：模型/提示词/测试） |
| `qa/token-stats-settings-saved.png` | 设置提示词保存成功态（roundtrip 证据） |
| `qa/token-stats-wordbook.png` | 单词本 tab |
| `qa/token-stats-panel-dark.png` | 深色主题（best-effort） |
| `qa/evidence/outdated-host/*.png` | 旧版 Host 兼容态（`Host 版本过旧` 告警 + 设置/单词本仍可用） |

---

## 8. QA 工件清单与保密处理

| 工件 | 说明 |
|---|---|
| `qa/verify-token-stats.mjs` / `.result.json` | 独立静态+契约 harness / 机器可读结果（含被测 commit 状态） |
| `qa/panel-shot.mjs` / `panel-shot.result.json` | Live 浏览器面板验收 / 逐项结果（截图、console、API 状态、交叉核对） |
| `qa/live-check.mjs` / `live-check.result.json` | Live HTTP 契约检查 / 逐项结果 |
| `qa/cdp.mjs` | CDP/Chrome + GUI 认证辅助（只接受 `DSH_URL` 启动 token 或 `DSH_COOKIE`，不读取凭据） |
| `qa/hold-page.mjs` | 供 cordis_inspect_query 的连接保活页 |
| `qa/TOKEN-STATS-QA.md` | 本报告（§5 验收矩阵 + Lead 追加项 + live 证据 + 已知限制） |
| `qa/mock-panel-server.mjs` | panel-shot 自测用 mock DSH 页面（44/44 自检通过） |
| `qa/evidence/final-state.txt` | 被测 worktree 版本 git status/diff 与全部源码 sha256 |
| `qa/evidence/installed-live-state.txt` | 安装后主工作区 host 文件 sha256（与 token 相关文件一致性核对） |
| `qa/evidence/main-workspace-revision.txt` | 合并后主工作区复跑时的 HEAD / 扩展版本 / 文件 sha256 / 时间戳 |
| `qa/evidence/*.log` | worktree host/extension 三套 + 合并后主工作区三套测试原样输出 |
| `qa/live-evidence/` | live 检查、DELETE、面板交叉核对、设置恢复的原始 JSON（并发真实流量元数据已脱敏） |
| `qa/evidence/outdated-host/` | 旧 Host 兼容性证据（新 client 已生效、Host 未升级时） |

保密处理：报告与仓库不含任何凭据/secret/具体 cookie 值；live DELETE 前把 `$DSH_HOME/immersive-translate/usage.json` 备份到 `/tmp`（报告记录路径，不复制到仓库）。
