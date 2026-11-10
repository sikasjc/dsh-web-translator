# Chrome Web Store / Edge Add-ons 发布材料

扩展版本：以 `manifest.json` 为准（当前 1.15.0）。上传包：`node tools/package-store.mjs` → `dist/dsh-translator-<version>.zip`（ZIP 根目录含 `manifest.json`）。

## 1. 账号与成本

| 商店 | 账号 | 费用 | 典型审核时间 |
|---|---|---|---|
| Chrome Web Store | Google 开发者账号 | US$5 一次性（以控制台当前金额为准） | 1–3 个工作日，可能更久 |
| Microsoft Edge Add-ons | Microsoft Partner Center | 免费 | 1–3 个工作日 |

账号需人工注册、付款/身份验证，这一步无法由代码完成。

## 2. 商店列表文案

**名称 / Name**: `dsh翻译`

**简短描述 / Summary**:
- zh: 用本机 DSH 模型翻译网页：双语对照、划词查词、单词本；文本只发往你的本机 DSH 和你配置的模型。
- en: Translate web pages with your local DSH models: bilingual view, word lookup and wordbook; text goes only to your local DSH and the model you configure.

**详细描述 / Description**:

zh:
```
dsh翻译是 DSH（DeepSeek Harness）的本地网页翻译前端。翻译由你自己电脑上的 DSH 模型完成，不经过开发者服务器。

功能：
• 原文 / 双语对照 / 仅译文三种模式，右键菜单可切换
• 划词翻译、双击查词、自定义快捷键（默认关闭，可在选项页开启）
• 单词本：查词后一键加入，在 DSH 插件页复习
• 悬浮球拖动/隐藏，按域名隐藏，页面语言与目标语言一致时自动隐藏
• 面板显示本页/今日 token 消耗；可选翻译 iframe 内内容

使用前提（重要）：
本扩展是 DSH 插件的浏览器前端，需要先在本机安装并运行 DSH，以及安装 dsh-web-translator 插件。扩展默认连接 http://127.0.0.1:3080/dsh-immersive/api。未检测到本地 DSH 时，扩展会提示连接失败，无法翻译网页。

数据：网页文本只发送到本机 DSH 地址，再由 DSH 使用你配置的模型提供方翻译；英文单词查词时可按 DSH 设置选择是否只把该单词发往公共词典（`dictionaryapi.dev` / Wiktionary / 关闭），默认 `dictionaryapi.dev`，可关闭；图片翻译仅在右键图片时触发，图片可见区域发往本机 DSH；DSH 默认先在本机做跨平台 OCR，图片不发给模型，只有 OCR 文本进入翻译；仅当本地 OCR 不可用/低置信度或用户显式选择图片模型时才回退视觉模型，Host 完成后立即删除临时图片；开发者不接收页面内容、浏览历史、图片或遥测。详见隐私政策。
项目地址：https://github.com/sikasjc/dsh-web-translator
```

en:
```
dsh翻译 is a local front-end for web page translation backed by DSH (DeepSeek Harness). Translation runs with the model you configured in your own local DSH; there is no developer-operated translation server.

Features:
• Source / bilingual / translation-only modes, switchable from the context menu
• Selection translation, double-click lookup and a configurable shortcut (off by default)
• Wordbook: add words while looking them up and review them on the DSH plugin page
• Draggable/hideable floating ball, per-domain hiding, auto-hide when the page language matches the target
• Token usage for the current page and today; optional iframe translation

Prerequisite (important):
This extension is the browser front-end of the dsh-web-translator DSH plugin. Install and run DSH locally and install the plugin first. The extension connects to http://127.0.0.1:3080/dsh-immersive/api by default; without the local DSH service it reports a connection error and cannot translate pages.

Data: page text is sent only to your local DSH endpoint, which then calls the model provider you configured. The developer receives no page content, browsing history or telemetry. See the privacy policy.
Project: https://github.com/sikasjc/dsh-web-translator
```

**分类 / Category**: Productivity（生产工具）
**语言 / Language**: 中文（简体）、English
**官网 / Homepage**: https://github.com/sikasjc/dsh-web-translator
**隐私政策 / Privacy policy URL**: 将 `PRIVACY.md` 发布为公开 URL（GitHub Pages/仓库 raw；建议 GitHub Pages）。

## 3. 权限说明（Chrome 隐私 practices 表）

| 权限 | 说明（可直接使用） |
|---|---|
| `storage` | 保存扩展设置（DSH 地址、目标语言、模式、悬浮球位置、各功能开关）。 |
| `activeTab` | 用户点击工具栏/快捷键/右键菜单时，对当前标签页执行翻译或查词。 |
| `scripting` | 对已经打开、但尚未注入内容脚本的标签页补注入翻译 UI；用户主动触发时才执行。 |
| `contextMenus` | 提供“dsh翻译 → 原文 / 译文 / 双语对照”等右键菜单。 |
| `http://127.0.0.1:3080/*`、`http://localhost:3080/*` | 访问用户本机的 DSH 插件 API；不连接任何远程开发者服务器。 |
| `content_scripts` 匹配 `http(s)://*/*` | 翻译/查词需要读取用户当前打开的网页文本；只在用户主动触发翻译或查词时读取可见文本并发送到本机 DSH。 |

**单一用途 / Single purpose**: 使用用户本机运行的 DSH 模型翻译网页，并在网页上显示译文/查询结果。

**远程代码**: 无。所有 JavaScript 都在扩展包内，不使用 eval 或远程脚本加载。
**数据用途**: 网页内容仅用于翻译/查词；不用于广告、画像、出售或与核心功能无关的用途。

## 4. 审核风险与准备

1. **依赖本机 DSH**：商店审核环境没有你的 DSH 服务，扩展会显示连接失败。必须在列表描述和 reviewer notes 中明确前置条件，并提供安装说明；否则有“无法正常使用”被拒风险。
2. **全站 content script**：需要说明翻译工具必须读取用户主动翻译的页面文本；不能用过宽描述；权限说明要具体。
3. **隐私政策**：因为会读取网页内容并发送到本机/用户配置的模型，必须披露数据流向；建议使用 GitHub Pages 的公开 URL。
4. **截图**：至少 1 张 1280×800 或 640×400 的真实截图（建议 3–5 张：双语网页、查词卡、设置页），不能只放 logo。
5. **商店更新**：每次上传必须递增 `manifest.json` 的 `version`；包根必须有 `manifest.json`。

## 5. 上传步骤

1. `node tools/package-store.mjs` 生成 ZIP；
2. Chrome Web Store Developer Dashboard → New item → 上传 ZIP；
3. 填写列表文案/截图/隐私 practices/权限理由；
4. 提交审核；通过后用商店链接替换 README 中的安装说明；
5. Edge Partner Center → 上传同一个 ZIP、复用文案；
6. 在扩展选项页/README/DSH 插件引导页放商店链接。

## 6. 待补素材

- [x] 商店截图（`store-assets/screenshots/`，1280×800，4 张）
- [x] 图标 128×128（manifest 已有，商店列表沿用）
- [ ] 公开隐私政策 URL（可用 `PRIVACY.md` 的 GitHub Pages/raw 地址）
- [ ] Reviewer notes（前置依赖说明 + 安装步骤，见下）


## 7. Reviewer notes 建议

```
This extension is the browser front-end of the open-source dsh-web-translator DSH plugin.
It requires the DSH app and that plugin to be running locally at http://127.0.0.1:3080.
Setup: https://github.com/sikasjc/dsh-web-translator
Without the local service the extension shows a connection error and does not translate —
that is expected. Reproduction of the translation UI requires a local DSH instance; the
extension performs no network requests to developer servers, reads page text only after an
explicit user action, and sends it only to 127.0.0.1.
```
