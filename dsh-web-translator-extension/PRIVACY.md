# dsh翻译隐私政策 / Privacy Policy

最后更新：2026-11-08

## 中文

dsh翻译（Chrome/Edge 扩展，以下简称“本扩展”）是 DSH（DeepSeek Harness）的本地网页翻译前端。

- **处理的数据**：在你主动点击翻译、划词/双击查词或使用快捷键时，本扩展读取当前网页的可见文本，并附带页面 URL/标题等最小元数据。
- **发送目的地**：页面数据只发送到你自己电脑上的 DSH 插件 API（默认 `http://127.0.0.1:3080/dsh-immersive/api`）。DSH 插件随后使用**你在 DSH 中配置的模型提供方**完成翻译；具体第三方模型由你选择，其数据处理受该提供方政策约束。
- **可选第三方词典**：仅当你查词的文本是英文单词时，DSH 插件会按你在 DSH 设置页「第三方词典」中选择的来源（`dictionaryapi.dev` / 英文 `Wiktionary` / 关闭）决定是否把**该单词**（不含页面正文）发送给对应公共词典；默认 `dictionaryapi.dev`，选择「关闭」后不会发起任何第三方词典请求。该请求由本机 DSH 插件发出，不经过开发者服务器。
- **可选图片翻译**：仅当你在图片上右键选择「翻译图片文字」时，本扩展才截取该图片当前可见区域并发送到本机 DSH；DSH 优先在本机用跨平台 OCR 识别文字，只有 OCR 文本会走翻译模型；仅当本地 OCR 不可用、置信度低或你显式指定图片模型时，临时图片才会发送给所选视觉模型。请求结束后删除临时图片；扩展不保存图片、不上传浏览历史。
- **不在开发者服务器收集**：开发者不运营任何接收页面内容、账号、浏览历史或遥测的服务器；本扩展不含统计/广告 SDK。
- **本地存储**：扩展使用 `chrome.storage.local` 保存设置（DSH 地址、目标语言、模式、悬浮球位置等）；单词本与翻译记录由你的本地 DSH 插件存储。
- **不出售/不共享**：不将数据出售、出租或用于与本扩展核心功能无关的用途。
- **你的控制**：可随时在扩展选项页关闭查词/快捷键/悬浮球，或在 DSH 插件页关闭翻译记录、清理记录、把第三方词典设为「关闭」；卸载扩展会删除扩展本地存储。

问题/联系：https://github.com/sikasjc/dsh-web-translator/issues

## English

dsh翻译 is a local front-end for web page translation backed by DSH (DeepSeek Harness).

- **What is processed**: when you explicitly translate a page, select/double-click a word, or use the shortcut, the extension reads the visible text of the current page plus minimal metadata (URL/title).
- **Where it goes**: page data is sent only to the DSH plugin API running on your own computer (default `http://127.0.0.1:3080/dsh-immersive/api`). The DSH plugin then calls the model provider **you configured in DSH**; that provider's own policy applies.
- **Optional third-party dictionary**: only for English single-word lookups, the DSH plugin may send **that word** (never the page text) to the public dictionary selected in DSH → Settings → Third-party dictionary (`dictionaryapi.dev` / English Wiktionary / off). The default is `dictionaryapi.dev`; choosing **off** disables all third-party dictionary requests. The request is made by your local DSH plugin and never goes through a developer server.
- **Optional image translation**: only when you right-click an image and choose “Translate image text” does the extension capture that image's visible area and send it to your local DSH. DSH first runs cross-platform local OCR; only the extracted text goes through the translation model. The selected vision model is used only when local OCR is unavailable, has low confidence, or is explicitly selected by you. The temporary image is deleted after the request; the extension stores no images and sends no browsing history.
- **No developer collection**: there is no developer-operated server receiving page content, accounts, browsing history or telemetry; the extension contains no analytics or advertising SDKs.
- **Local storage**: the extension stores settings (DSH URL, target language, mode, floating-ball position) in `chrome.storage.local`; the wordbook and translation records are stored by your local DSH plugin.
- **No sale/share**: data is not sold, rented, or used for purposes unrelated to the extension's core function.
- **Your controls**: disable selection lookup / shortcuts / the floating ball in extension options; disable/clear translation records or set the third-party dictionary to **off** on the DSH plugin page; uninstalling the extension removes its local storage.

Contact: https://github.com/sikasjc/dsh-web-translator/issues
