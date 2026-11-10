# DESIGN-IMAGE — 右键图片文字翻译（v7，跨平台本地 OCR）

> 增量设计：在既有「扩展 → 本机 DSH → 模型」链路上增加**图片文字识别 + 原位译文覆盖**。
> 触发方式只有一种：**右键图片 →「翻译图片文字」**；页面翻译/自动翻译**不扫描、不预处理图片**。

## 1. 链路

```
右键图片
  → content.js 记录 img、滚动到可见区域、计算可见 rect
  → background.js chrome.tabs.captureVisibleTab()（右键菜单的 activeTab 授权）
  → OffscreenCanvas 按 rect 裁剪（长边 ≤1600，JPEG q0.92）
  → POST /dsh-immersive/api/image-translate
      { image:{mediaType,data(base64)}, targetLanguage?, sourceLanguage,
        sourceUrl, sourceTitle, client:'extension', turnId:'img_…', stepIndex:0, mode:'image' }
  → Host:
      1. 校验图片（PNG/JPEG/WebP/GIF、canonical base64、≤3 MiB）
      2. 本地 OCR 优先（V1.12.5，跨平台 Tesseract WASM）：
         - 内置 eng / chi_sim traineddata，按 sourceLanguage 选择；
         - 词级 bbox → 行/列/段落聚合 → 代码/JSON 区域过滤；
         - OCR 文本走现有 translateService 批量翻译（文本缓存生效）；
         - 图片不写 attachment、不发给模型；
      3. OCR 不可用/不支持的脚本/非 JPEG/置信度 <0.55/翻译失败：
         回退视觉模型：settings.imageModel（auto 跟随当前翻译模型；显式指定则直接走视觉模型）
           ctx.attachments.saveImage() → ImageAttachmentRef
           一次视觉模型调用：文本指令 + ImageBlock
           prompt 要求严格 JSON：{"blocks":[{"text","translation","bbox":[x0,y0,x1,y1]}]}
      4. 解析/裁剪 blocks；视觉路径写本地结果缓存（key=sha256(image)+model+targetLang+style+promptVersion）
      5. finally：视觉路径删除本次新建的图片附件与 request-image 变体缓存（图片用完即删）
      6. usage kind=image + 一条 DSH 会话 / 一个 Turn（kind=image）；provider/model 取实际翻译模型
  → background 按 bbox 采样背景色 → content 渲染原位覆盖层
```

## 2. 扩展覆盖层

- 覆盖层 host 挂在 `document.body`，`position:absolute` + 页面坐标，z-index 高于页面；内部 Shadow DOM 隔离站点样式；
- 每个 block：`left/top/width/height` 由归一化 bbox × 截图裁剪区域换算；背景色取裁剪图 bbox 边缘像素平均色，文字颜色按亮度自动黑/白；
- 覆盖层默认**仅译文**；工具栏可切「双语」（每块上方显示原文小字）、复制译文、关闭；
- **字号自适应（V1.17.5）**：初始字号按 bbox 面积/原文字符数估算并限制在 8–20px，再用 `scrollHeight/scrollWidth` 逐级缩到 bbox 内；双语切换后重新适配，极窄 bbox 压行高兜底，避免译文溢出；
- **本地 OCR（V1.12.5）**：跨平台 Tesseract WASM 在 Host 内运行，图片不离开本机进程；只支持 JPEG + `eng`/`chi_sim` 源语言，其他脚本自动回退视觉模型；OCR 结果按 bbox 分组、代码/JSON 区域不翻译；本地 OCR 结果不写 image 结果缓存（文本翻译缓存仍生效），重复图片仍需 OCR。
- **图片快速模式（V1.17.7，扩展选项默认关闭）**：`imageFastMode` 发送 `compact:true`，Host prompt 只要求 `{"blocks":[{"translation","bbox"}]}`，不再输出 OCR 原文，实测 dense figure 约 20s vs 25s（具体取决于模型与图片内容）；缓存 key 增加 compact 段，快速结果不会喂给双语请求；覆盖层检测不到原文时隐藏「双语」按钮。
- **进度提示（V1.17.6）**：「正在翻译图片」toast 保持最长 120s，重试点击不会把它缩成 1.8s；成功/失败后再显示 2.2s/8s 结果提示，避免大图 20–30 秒请求期间用户误以为任务结束。
- **关闭行为（V1.17.5）**：工具栏的 mousedown/mouseup/click/dblclick/contextmenu 守卫改到冒泡阶段，避免 capture 阶段 `stopPropagation` 拦截 Shadow DOM 内按钮自己的 click（之前会导致「双语/复制/关闭」全部点不动）；点击覆盖层外部、按 Esc、页面 URL 变化也会移除覆盖层；
- 模型没给 bbox / JSON 解析失败 → 图片旁回退卡片（原文 + 译文列表）；
- 打开新图片覆盖层/按 Esc/页面还原时移除；不修改原图、不替换 `<img>`、不写页面存储；
- 只翻译图片当前可见部分；如果图片大于视口，可在工具栏提示“只翻译了可见部分”。

## 3. Host 图片丢弃

- 图片仅通过 `ctx.attachments.saveImage()` 存在一次请求生命周期内；**不把 ImageBlock 写入 DSH 会话事件**；
- 请求结束（成功或失败）后 `cleanupImageAttachment()`（仅视觉模型回退路径；本地 OCR 路径从不创建图片附件）：
  - `imageHostPath(ref)` 存在且 mtime 属于本次请求 → `unlink`（mtime 早于本次请求的既有对象不动，避免误删复用对象）；
  - `$DSH_HOME/cache/attachments/request-images/` 下本次新建的 request variant → 删除；
- 失败只 debug 日志，不改变翻译结果；若删除失败，图片仅为本机未引用的残留对象（不写入会话/缓存/扩展）；
- 本地结果缓存只存 OCR 文本与译文（JSON 字符串），不存图片；`DELETE /cache` 同时清理。

## 4. 模型选择与错误

- `settings.imageModel`：`auto`（默认；优先本地 OCR；图像回退时跟随当前翻译模型，若当前模型不接受图片则回退到目录第一个图片模型）或 `provider::model`（显式指定则跳过本地 OCR、直接使用该视觉模型）；
- 显式配置的模型必须声明 `inputModalities` 包含 `image`，否则 `PUT /settings` 返回 `INVALID_SETTINGS`；
- 运行期无图片模型 → `MODEL_NO_VISION`(502)；图片校验失败 → `IMAGE_INVALID`(400) / `IMAGE_TOO_LARGE`(413) / `IMAGE_UNSUPPORTED`(415)；
- 图片请求超时 120s；模型失败/超时沿用既有错误映射；
- 视觉输出上限 **16384 tokens**（V1.12.3 起）：信息量大的截图/图表（如整页对话表）在 4096 下会被截断并返回 `OUTPUT_TRUNCATED`，扩展端表现为“右键翻译没有译文”；单张普通图片实际输出远低于该上限。

## 5. Token / 账本 / 会话

- usage kind=`image`：segments=OCR 块数、chars=OCR 字符数、sample=首块原文、outputPreview=首块译文、input/output/cache tokens 来自实际翻译模型；
- 每次图片动作 = 一条 DSH 会话（标题 `图片翻译 · 页面标题 / 站点`），单次模型请求 = 一个 Turn；图片本身不写入会话；
- 本地 OCR 路径没有图片附件，provider/model 为文本翻译模型（OCR 本身不计 token）；视觉回退路径沿用原有缓存语义（命中 0 token、不保存图片、记录 cached 事件与 Turn）。

## 6. 隐私

- 只有用户右键图片才发送；只截取该图片可见区域，不截整页；
- 默认路径下图片只在本地 Host 进程内做 Tesseract OCR，**不会发给模型提供方**；只有本地 OCR 不可用/低置信度或用户显式指定图片模型时，图片才会发给所选视觉模型；
- 不经过开发者服务器、不使用外部 OCR/翻译 API；本地 OCR/traineddata 随插件分发，无网络下载；
- 扩展不保存图片、不写 console；Host 请求后尽力删除临时图片；本地只缓存 OCR 文本/译文；
- 相关披露同步在 README、PRIVACY.md、STORE-LISTING.md 与设置页提示中。
