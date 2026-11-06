# dsh翻译 · 翻译结果缓存持久化 — 设计契约 v5

> 状态：2026-11-06。用户要求：把「插件进程内结果缓存」升级为**持久化缓存**，让同一页面/段落在
> DSH 重启、插件重载、页面「还原」后重新翻译时直接命中，**零模型调用 / 零 token**。
> 本文件是增量契约；未提及部分继续遵守 `DESIGN.md` / `DESIGN-TOKEN-USAGE.md` / `DESIGN-CONVERSATIONS.md`。

---

## 1. 现状与目标

- 现状（v1.6.0）：`lib/cache.js` 的 `createLruCache` 仅进程内 LRU（512 批），命中时账本记 `cached: true`、0 token；
  DSH 重启 / 插件重载后缓存清空，重复翻译同页会再次产生完整模型调用。
- 目标：内存 LRU（快路径，同步 `get/set`，不改变 `translate.js` 接口）+ 磁盘文件（持久化），
  跨进程/重启恢复；7 天 TTL；容量上限；可一键清空；任何持久化失败都**不影响翻译主流程**。

## 2. 数据与文件

- 文件：`$DSH_HOME/immersive-translate/cache.json`（由 `lib/store.js` 的 JSON store 原子写、串行化）。
- 格式（紧凑，v1）：
  ```json
  {"v":1,"savedAt":1793945000000,"entries":{"<cacheKey>":[1793940000000,["译文1","译文2"]]}}
  ```
  - key 沿用 `createBatchCacheKey()`：`provider|model|target|sha1(system|userTemplate|sourceLanguage|textsJson)`；
    提示词 / 模型 / 目标语言 / 原文任一变化 → key 变化（自然失效）。
  - value = `[写入时间 at, translations[]]`；`at + ttlMs < now` 视为过期，读取时忽略并在下次写入时清理。
- 上限：**1000 条**（超过按最近使用/最旧淘汰）；序列化 > 4 MB 时再丢弃最旧条目后写入。
- TTL：**7 天**（常量；设计上先不做 UI 配置，后续可加）。
- 隐私：缓存内容为**原文批次对应的译文**，只写本机；文件随 `$DSH_HOME` 在本机保存，可
  `DELETE /cache` 或删除文件清空。它与 DSH 会话日志相互独立（会话日志仍由 DSH 管理）。

## 3. Host 实现

- `lib/cache.js` 新增 `createPersistentBatchCache({ store, max=1000, ttlMs, now, logger })`：
  - `get(key)` 同步（未过期则返回 translations，并刷新 LRU）；`set(key, translations)` 同步更新内存 + 标记 dirty；
  - 持久化：debounce ~300ms 后 `store.mutate` 写盘；失败 warn 一次并保留内存缓存；`flush()` 强制写；
  - `hydrate()`：读取 store、校验 envelope、丢过期/非法项、按上限保留最新，填充内存；缺失/损坏文件 → 空缓存（warn 一次）；
  - `clear()`：清空内存 + 写空文件；`stats()`：`{entries, max, ttlMs,...}`；`whenReady()` 供测试等待 hydrate。
- `lib/api.js`：`createJsonStore({file: <dataDir>/cache.json, version:1})` → `createPersistentBatchCache` →
  传给 `createTranslateService({ cache })`；启动时非阻塞 `hydrate()`；`ctx.effect` 卸载时 best-effort `flush()`；
  新增 `clearCache()` facade。
- `lib/http.js`：新增 `DELETE /cache` → `{ok:true, cleared:true, entries:0}`（与 `DELETE /usage` 同一写分发）。
- 命中语义：`translate` 响应的 `cached: true`、`usage` 四桶为 0（与现状一致）；账本照常记一条 `cached:true` 事件，
  仍属真实请求记录（不产生模型调用、不计 token）。
- 失败策略：缓存读写/持久化任何异常只 warn，**绝不影响翻译**；损坏的 cache.json 视为空缓存。

## 4. Client

- 「概览」页底部数据区域增加「**清空翻译结果缓存**」按钮（二次确认）→ `DELETE /cache`，
  成功/失败 toast/inline 状态；并提示缓存位置与 TTL。
- 其它页面行为不变（`cached` 事件仍显示「缓存命中 是」）。

## 5. 验收

1. host `node --test test/` 全绿（新增：TTL/上限/hydrate/损坏容错/flush/clear/失败容错；跨实例命中断言）。
2. `node --check lib/*.js index.js`；`DELETE /cache` 路由与 405 行为正确。
3. live：同一文本连续两次 `POST /translate` → 第二次 `cached:true`、usage 全 0、无模型调用；
   插件重载（进程内缓存清空）后再发同一文本 → **仍 cached**（从磁盘恢复）；`DELETE /cache` 后再发 → 真实调用。
4. 现有 v2/v3/v4 功能不回归（概览/轨迹/会话/单词本/浮窗 token）。
