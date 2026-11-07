# dsh翻译隐私政策 / Privacy Policy

最后更新：2026-11-07

## 中文

dsh翻译（Chrome/Edge 扩展，以下简称“本扩展”）是 DSH（DeepSeek Harness）的本地网页翻译前端。

- **处理的数据**：在你主动点击翻译、划词/双击查词或使用快捷键时，本扩展读取当前网页的可见文本，并附带页面 URL/标题等最小元数据。
- **发送目的地**：数据只发送到你自己电脑上的 DSH 插件 API（默认 `http://127.0.0.1:3080/dsh-immersive/api`）。DSH 插件随后使用**你在 DSH 中配置的模型提供方**完成翻译；具体第三方模型由你选择，其数据处理受该提供方政策约束。
- **不在开发者服务器收集**：开发者不运营任何接收页面内容、账号、浏览历史或遥测的服务器；本扩展不含统计/广告 SDK。
- **本地存储**：扩展使用 `chrome.storage.local` 保存设置（DSH 地址、目标语言、模式、悬浮球位置等）；单词本与翻译记录由你的本地 DSH 插件存储。
- **不出售/不共享**：不将数据出售、出租或用于与本扩展核心功能无关的用途。
- **你的控制**：可随时在扩展选项页关闭查词/快捷键/悬浮球，或在 DSH 插件页关闭翻译记录、清理记录；卸载扩展会删除扩展本地存储。

问题/联系：https://github.com/sikasjc/dsh-web-translator/issues

## English

dsh翻译 is a local front-end for web page translation backed by DSH (DeepSeek Harness).

- **What is processed**: when you explicitly translate a page, select/double-click a word, or use the shortcut, the extension reads the visible text of the current page plus minimal metadata (URL/title).
- **Where it goes**: data is sent only to the DSH plugin API running on your own computer (default `http://127.0.0.1:3080/dsh-immersive/api`). The DSH plugin then calls the model provider **you configured in DSH**; that provider's own policy applies.
- **No developer collection**: there is no developer-operated server receiving page content, accounts, browsing history or telemetry; the extension contains no analytics or advertising SDKs.
- **Local storage**: the extension stores settings (DSH URL, target language, mode, floating-ball position) in `chrome.storage.local`; the wordbook and translation records are stored by your local DSH plugin.
- **No sale/share**: data is not sold, rented, or used for purposes unrelated to the extension's core function.
- **Your controls**: disable selection lookup / shortcuts / the floating ball in extension options, or disable/clear translation records on the DSH plugin page; uninstalling the extension removes its local storage.

Contact: https://github.com/sikasjc/dsh-web-translator/issues
