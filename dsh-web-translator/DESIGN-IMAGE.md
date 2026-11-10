# DESIGN-IMAGE — 右键图片文字翻译（v6）

> 增量设计：在既有「扩展 → 本机 DSH → 模型」链路上增加**图片文字识别 + 原位译文覆盖**。
> 触发方式只有一种：**右键图片 →「翻译图片文字」**；页面翻译/自动翻译**不扫描、不预处理图片**。

## 1. 链路

```
右键图片
  → content.js 记录 img、滚动到可见区域、计算可见 rect
  → background.js chrome.tabs.captureVisibleTab()（右键菜单的 activeTab 授权）
  → OffscreenCanvas 按 rect 裁剪（长边 ≤1600，JPEG q0.92）
  → POST /dsh-immersive/api/image-translate
      { image:{mediaType,data(base64)}, targetLanguage?, sourceUrl, sourceTitle,
        client:'extension', turnId:'img_…', stepIndex:0, mode:'image' }
  → Host:
      1. 校验图片（PNG/JPEG/WebP/GIF、canonical base64、≤3 MiB）
      2. 解析图片模型：settings.imageModel（默认 auto 跟随当前翻译模型；只接受 inputModalities 含 image）
      3. ctx.attachments.saveImage() → ImageAttachmentRef
      4. 一次视觉模型调用：文本指令 + ImageBlock
         prompt 要求严格 JSON：{"blocks":[{"text","translation","bbox":[x0,y0,x1,y1]}]}
      5. 解析/裁剪 blocks；写本地结果缓存（key=sha256(image)+model+targetLang+style+promptVersion）
      6. finally：删除本次新建的图片附件与 request-image 变体缓存（图片用完即删）
      7. usage kind=image + 一条 DSH 会话 / 一个 Turn（kind=image）
  → background 按 bbox 采样背景色 → content 渲染原位覆盖层
```

## 2. 扩展覆盖层

- 覆盖层 host 挂在 `document.body`，`position:absolute` + 页面坐标，z-index 高于页面；内部 Shadow DOM 隔离站点样式；
- 每个 block：`left/top/width/height` 由归一化 bbox × 截图裁剪区域换算；背景色取裁剪图 bbox 边缘像素平均色，文字颜色按亮度自动黑/白；
- 覆盖层默认**仅译文**；工具栏可切「双语」（每块上方显示原文小字）、复制译文、关闭；
- **字号自适应（V1.17.5）**：初始字号按 bbox 面积/原文字符数估算并限制在 8–20px，再用 `scrollHeight/scrollWidth` 逐级缩到 bbox 内；双语切换后重新适配，极窄 bbox 压行高兜底，避免译文溢出；
- **关闭行为（V1.17.5）**：工具栏的 mousedown/mouseup/click/dblclick/contextmenu 守卫改到冒泡阶段，避免 capture 阶段 `stopPropagation` 拦截 Shadow DOM 内按钮自己的 click（之前会导致「双语/复制/关闭」全部点不动）；点击覆盖层外部、按 Esc、页面 URL 变化也会移除覆盖层；
- 模型没给 bbox / JSON 解析失败 → 图片旁回退卡片（原文 + 译文列表）；
- 打开新图片覆盖层/按 Esc/页面还原时移除；不修改原图、不替换 `<img>`、不写页面存储；
- 只翻译图片当前可见部分；如果图片大于视口，可在工具栏提示“只翻译了可见部分”。

## 3. Host 图片丢弃

- 图片仅通过 `ctx.attachments.saveImage()` 存在一次请求生命周期内；**不把 ImageBlock 写入 DSH 会话事件**；
- 请求结束（成功或失败）后 `cleanupImageAttachment()`：
  - `imageHostPath(ref)` 存在且 mtime 属于本次请求 → `unlink`（mtime 早于本次请求的既有对象不动，避免误删复用对象）；
  - `$DSH_HOME/cache/attachments/request-images/` 下本次新建的 request variant → 删除；
- 失败只 debug 日志，不改变翻译结果；若删除失败，图片仅为本机未引用的残留对象（不写入会话/缓存/扩展）；
- 本地结果缓存只存 OCR 文本与译文（JSON 字符串），不存图片；`DELETE /cache` 同时清理。

## 4. 模型选择与错误

- `settings.imageModel`：`auto`（默认；跟随当前翻译模型，若当前模型不接受图片则回退到目录第一个图片模型）或 `provider::model`；
- 显式配置的模型必须声明 `inputModalities` 包含 `image`，否则 `PUT /settings` 返回 `INVALID_SETTINGS`；
- 运行期无图片模型 → `MODEL_NO_VISION`(502)；图片校验失败 → `IMAGE_INVALID`(400) / `IMAGE_TOO_LARGE`(413) / `IMAGE_UNSUPPORTED`(415)；
- 图片请求超时 120s；模型失败/超时沿用既有错误映射；
- 视觉输出上限 **16384 tokens**（V1.12.3 起）：信息量大的截图/图表（如整页对话表）在 4096 下会被截断并返回 `OUTPUT_TRUNCATED`，扩展端表现为“右键翻译没有译文”；单张普通图片实际输出远低于该上限。

## 5. Token / 账本 / 会话

- usage kind=`image`：segments=OCR 块数、chars=OCR 字符数、sample=首块原文、outputPreview=首块译文、input/output/cache tokens 来自模型返回；
- 每次图片动作 = 一条 DSH 会话（标题 `图片翻译 · 页面标题 / 站点`），单次模型请求 = 一个 Turn；图片本身不写入会话；
- 缓存命中：0 token、不保存图片、仍记录 cached 事件与 Turn（与文本翻译缓存语义一致）。

## 6. 隐私

- 只有用户右键图片才发送；只截取该图片可见区域，不截整页；
- 图片发给 DSH 中选择的模型提供方（默认 DeepSeek 模型），不经过开发者服务器、不使用外部 OCR/翻译 API；
- 扩展不保存图片、不写 console；Host 请求后尽力删除临时图片；本地只缓存 OCR 文本/译文；
- 相关披露同步在 README、PRIVACY.md、STORE-LISTING.md 与设置页提示中。
