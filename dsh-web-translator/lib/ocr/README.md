# Vendored local OCR runtime

This directory contains the cross-platform OCR stack used by the optional
local-OCR image translation path. Nothing here is downloaded at runtime.

| Component | Version | License | Upstream |
|---|---|---|---|
| `tesseract-wasm` | 0.11.0 | BSD-2-Clause | https://github.com/robertknight/tesseract-wasm |
| `comlink` | 4.4.2 | Apache-2.0 | https://github.com/GoogleChromeLabs/comlink |
| `jpeg-js` | 0.4.4 | BSD-3-Clause | https://github.com/eugeneware/jpeg-js |
| `eng.traineddata` | tessdata_fast | Apache-2.0 | https://github.com/tesseract-ocr/tessdata_fast |
| `chi_sim.traineddata` | tessdata_fast | Apache-2.0 | https://github.com/tesseract-ocr/tessdata_fast |

License texts are in `vendor/*-LICENSE.*`. Tesseract/WASM and traineddata
licenses are included with the upstream distributions; keep this notice when
redistributing the plugin.

The runtime is used by `lib/local-ocr.js`. `JPEG` is the only input format on
this path because the extension always sends captured JPEG screenshots; the
visual-model fallback handles other formats.
