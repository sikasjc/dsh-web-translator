# dsh-web-translator (dsh翻译)

**English** | [简体中文](README_ZH.md)

Turn the **models configured in DSH (DeepSeek Harness)** into a local immersive web translator:
a DSH plugin provides the translation backend, token accounting and wordbook, while a Chrome/Edge
extension translates pages and looks words up in the browser.
**No third-party translation API key is required.** Text only travels between your local DSH and the
model service you configured in DSH — except the optional English-word dictionary lookup described
under [Data and privacy](#data-and-privacy).

> Current versions: **DSH plugin 1.12.1** · **browser extension 1.17.2**. Recent changes:
> grid/flex parent long paragraphs are translated instead of being skipped (extension 1.17.2); block
> translations now keep the source's inline hyperlinks (translated link text keeps its original target);
> right-click **image text translation** with in-place overlays and image deletion after each request
> (plugin 1.12.1 / extension 1.17.1); selectable third-party dictionary for English word lookups —
> dictionaryapi.dev / English Wiktionary / off (plugin 1.11.0); translation styles with page context and
> terminology protection (plugin 1.10.0);
> per-site auto translation (extension 1.16.0), optional iframe translation (extension 1.15.0); extension
> packaging, privacy policy and store-listing materials (extension 1.15.0); screen-based translation
> scheduling with block-lazy and preload options (extension 1.14.0) plus later block-boundary fixes;
> floating ball quick-translate, progress ring, per-domain hiding and page-language matching
> (extensions 1.10.0–1.13.0); persistent translation-result cache (plugin 1.7.0); translation
> conversations grouped under a **dsh翻译记录** workspace (1.6.0); each translation action is a real DSH
> session and each model request becomes one native turn, viewable in DSH's own Conversation /
> Trajectory / Stats views (1.5.0).
> Note: to avoid including personal information such as real browsing data or session titles, this
> repository **does not ship UI screenshots or live QA evidence**. Install and run it locally to see the
> UI; QA screenshots can be regenerated on your machine with `dsh-web-translator/qa/*.mjs` (ignored by
> `qa/.gitignore` by default).

---

## ⚠️ This repository contains two components — install both

| Component | Directory | Role | Required |
|---|---|---|---|
| **DSH plugin** | [`dsh-web-translator/`](dsh-web-translator/) | Translation / lookup backend (calls DSH models), token ledger and stats, translation-result cache, wordbook persistence; full "dsh翻译" page in the DSH left toolbar (Overview / Traces / Settings / Wordbook) | ✅ Required (the extension cannot work without it) |
| **Browser extension** | [`dsh-web-translator-extension/`](dsh-web-translator-extension/) | Page translation (original / bilingual / translation-only), context menu, selection/double-click lookup, follow-page translation, floating ball, token display in the popup | ✅ Required (does the work on web pages) |

> Plugin only = you get the DSH stats/settings pages, but pages are not translated. Extension only =
> it cannot reach the backend, so nothing is translated.
> **Install the DSH plugin first, then the browser extension.**

---

## Features

**Browser extension (Chrome / Edge, MV3)**
- Full-page translation in **original / bilingual / translation-only** modes, switchable at any time
  without new requests (block-level layout for body text, inline layout for navigation, labels, footers
  and buttons); **inline links inside translated blocks keep their original targets** (the model is
  asked to preserve link markers, and the extension rebuilds real `<a>` elements);
- **Screen-based scheduling (default)**: when translation starts, everything currently visible (plus a
  configurable preload: none / half / one screen) is translated in one burst; while scrolling, the new
  screen is translated once scrolling settles, and screens scrolled past quickly are intentionally
  skipped. An optional **block mode** keeps the per-block lazy scheduler plus micro-batching and is the
  most token-efficient choice; stop / restore at any time;
- **Follow-page translation** (on by default): after translating page A, same-site pages opened from its
  links are translated automatically;
- "dsh翻译" context menu: the three modes plus "translate selected text";
- **Selection / double-click / shortcut translation** (three opt-in toggles, default off): pop a
  translation/lookup card with translation, phonetics, dictionary definitions, pronunciation and
  "add to wordbook";
- **Right-click image text translation**: right-click an image → **Translate image text**; only that
  image's visible area is captured, sent through your local DSH to the selected vision model, and the
  translations are drawn **in place over the original text** (bilingual/translation-only toggle, copy,
  close; a card is used when the model cannot return boxes). Page translation never scans or translates
  images automatically, and the image is deleted right after the request;
- **Floating ball**: left-click starts translation with the current mode (click again to stop, then to
  restore), right-click opens the panel; drag it anywhere; it shows a progress ring and percentage while
  translating; hide/show it from the panel footer or the context menu; **hide per domain** (add from the
  panel or context menu, manage the list in DSH → Settings → dsh翻译 → Floating ball);
- **Page-language matching**: when the page language already equals the target language, no translation
  request is made and the floating ball is hidden by default (configurable);
- When translation finishes the panel collapses automatically, leaving only the floating ball; the
  toolbar icon only toggles the panel and never starts a translation by accident;
- **Live token display in the popup**: this page's usage (input/output, accumulated per request) and
  today's total (from the DSH ledger).

**DSH plugin (Web profile)**
- Uses models already configured in DSH (provider/model and reasoning effort selectable); **model and
  prompts are edited inside DSH**;
- **Token ledger**: records the real usage returned by the model service — input / output / cache-read /
  cache-write tokens and latency — aggregated by day, model and kind;
- **Persistent translation-result cache**: identical source text, prompts and model reuse the stored
  translation with **0-token model calls**; cached to local `cache.json`, kept for 7 days (max 1000
  batches) and survives DSH restarts; clear it from the Overview page;
- **Left-toolbar "dsh翻译" page**:
  - **Overview**: requests, tokens, cache hits, failures and average latency for today; 14-day trend,
    model and kind breakdowns, and translation-cache management;
  - **Traces**: organized by **translation conversation** (mirroring DSH's session → trajectory
    hierarchy). Each "translate this page / re-translate / lookup" is a real DSH session, and each model
    request inside it is one **native turn (user → assistant)**. Conversation cards show title / site /
    model / turn count / tokens / status; expand to see per-turn summaries; click **Open DSH trajectory**
    to open the session in DSH's own Conversation / Trajectory / Stats views with the full source text,
    translation and tokens per turn. Legacy requests without a DSH session stay in a collapsed inline
    group; filters, "load earlier" and "clear stats" are supported;
  - **Settings**: model, reasoning effort, target language, translation style, system prompt, user
    template, batching parameters, **third-party dictionary provider**, **image vision model** and test
    translation; a **Floating ball** page lists the domains that hide the ball and lets you remove or
    manually add them;
  - **Image translation backend**: captures one image, sends it to an image-capable model, returns
    OCR blocks with normalized bounding boxes, records image tokens in the ledger and one DSH turn per
    image, then deletes the temporary image attachment;
  - **Selectable third-party dictionary** for English single-word lookups: `dictionaryapi.dev`
    (phonetics / definitions / audio, default), English Wiktionary (definitions, no audio), or **off**
    (model translation only). The dictionary request is host-internal and is never written into DSH
    session records;
  - **Wordbook**: spaced-repetition review plus pronunciation/shadowing practice;
  - **Sidebar grouping**: every translation action / lookup is a real DSH session automatically grouped
    under **dsh翻译记录** (historical sessions are backfilled on first start); open one to see DSH's own
    Conversation / Trajectory / Stats views.
- Local HTTP API: `http://127.0.0.1:3080/dsh-immersive/api/*` (loopback only).

---

## Repository layout

```
dsh-web-translator/            # DSH plugin (local bundle installed into a DSH profile)
├── index.js / client.js       # Host half / Client half
├── lib/                       # Host logic: routing, model calls, token ledger, result cache, wordbook, storage
├── test/                      # node --test unit tests
├── locale/  icon.svg          # Localization and icon
├── cordis.patch.yml           # Bundle patch (plugin row dsh-web-translator)
├── DESIGN.md                  # Design contract v2 (API / UI / extension protocol / security)
├── DESIGN-TOKEN-USAGE.md      # v3 addendum: token ledger / left-toolbar page / popup tokens
├── DESIGN-TURN-TRACE.md       # v3.1 addendum: turn traces (each conversation turn)
├── DESIGN-CONVERSATIONS.md    # v4 addendum: translation conversations bridged into DSH native views
├── DESIGN-CACHE.md            # v5 addendum: persistent translation-result cache (disk + TTL + DELETE /cache)
├── DESIGN-IMAGE.md            # v6 addendum: right-click image translation, in-place overlays and image discard
└── qa/                        # Independent QA scripts and reports (screenshots / live evidence not committed)

dsh-web-translator-extension/  # Chrome / Edge MV3 extension (load unpacked)
├── manifest.json  background.js  content.js
├── options.html  options.js      # Options page
├── icons/                        # Icons
└── tools/                        # Icon generation / static checks / headless E2E
```

---

## Install 1/2: DSH plugin (do this first)

Prerequisites: DSH is installed and runnable on this machine (`dsh web`, `npx dsh web`, or the DSH
desktop app), using the default `web` profile at `http://127.0.0.1:3080`.

### Option A: let an Agent inside DSH install it (recommended)

First get the **absolute path** of this repository on your machine, for example:

```bash
git clone https://github.com/sikasjc/dsh-web-translator.git ~/workspace/dsh-web-translator-repo
# plugin directory = ~/workspace/dsh-web-translator-repo/dsh-web-translator
```

Then ask an Agent in **any DSH session** to run it (or use DSH's plugin management yourself):

```
plugin_manager  action: install_bundle  target: /absolute/path/dsh-web-translator-repo/dsh-web-translator
```

An `application: applied` result means the install succeeded.

### Option B: DSH Web GUI

DSH Web → left toolbar **Plugins** page → add/install plugin → pick or paste the **absolute path** of the
plugin directory `…/dsh-web-translator-repo/dsh-web-translator` → install and enable it.
(Wording differs slightly between DSH versions; the point is to install this local bundle directory into
the `web` profile.)

### Verify the install

1. A **dsh翻译** icon appears in the DSH left toolbar (below "插件市场"); clicking it shows
   Overview / Traces / Settings / Wordbook;
2. "dsh翻译" appears in the DSH Settings list;
3. Check the local API from a terminal:

```bash
curl http://127.0.0.1:3080/dsh-immersive/api/health
# {"ok":true,"version":"1.7.0","uptimeMs":…,"llm":{"providers":…,"models":…}}
```

### Update / reload the plugin

- After replacing files in the plugin directory, run install/reload again from DSH (or disable then
  enable the plugin row with `plugin_manager`) to apply the change;
- When DSH supports HMR, plugin file changes are reloaded on the next profile recompose.

### Uninstall the plugin

```
plugin_manager  action: remove_bundle  target: @local/dsh-web-translator
```

Data (settings / wordbook / token ledger / result cache) lives under `$DSH_HOME/immersive-translate/`;
deleting that directory removes it completely.

---

## Install 2/2: browser extension (Chrome / Edge)

> The extension is **loaded from a local directory** (it is not published on the Chrome Web Store), so
> you need to use "Load unpacked".

1. Make sure DSH Web is running at `http://127.0.0.1:3080` (the extension only connects to
   `127.0.0.1:3080` / `localhost:3080`);
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge);
3. Enable **Developer mode** in the top-right corner;
4. Click **Load unpacked** and select the **`dsh-web-translator-extension/`** directory of this repository
   (select the directory, not a single file);
5. **dsh翻译** now appears in the extension list; pin it to the toolbar if you like;
6. Open any web page (`http(s)://`) → click the floating ball in the bottom-right corner (or press `Alt+T`
   / click the toolbar icon) → click **Translate this page**.

### Extension options

Right-click the extension icon → **Options** (or use "Settings" in the panel when DSH is not
reachable): DSH address (default `http://127.0.0.1:3080`), target language, default display mode,
auto-translate, **translation scheduling** (screen / block), **preload** (none / half / one screen),
**follow-page translation**, **selection / double-click / shortcut translation toggles**, **show floating
ball**, **hide the ball when the page language matches the target language**, UI language, and **Test
connection**.
**Models and prompts are not edited in the extension** — change them in DSH → left toolbar
"dsh翻译" → Settings (single source of truth).

### Update the extension

After replacing files in `dsh-web-translator-extension/`, open `chrome://extensions`, click **Reload** on
the extension, then refresh the pages that are already open.

---

## Usage

- **Full-page translation**: floating ball / `Alt+T` / toolbar icon opens the panel → "Translate this page";
  with screen scheduling (default) the visible screen is translated in one burst; only the current screen
  plus preload is translated after scrolling, so quickly scrolled-past screens are skipped (press
  "Translate this page" / "Re-translate", or switch to block mode, if you want them translated);
- **Modes**: original / bilingual / translation-only, switchable at any time (no new requests);
- **Context menu**: "dsh翻译" → original / bilingual / translation-only / translate selected text;
- **Selection / double-click / shortcut translation** (off by default; enable in the extension options):
  select text or double-click a word → card with translation, phonetics, definitions, pronunciation and
  "add to wordbook"; the default shortcut is `Command+K` / `Ctrl+K`;
- **Follow-page translation** (on by default): pages opened from links after translating the current page
  are translated automatically;
- **Floating ball**: left-click starts translation with the current mode (again to stop, then to
  restore), right-click opens the panel; drag it anywhere; progress is shown on the ball; hide/show it
  from the panel footer or the context menu; hide it per domain from the panel/context menu;
- **Tokens**: the popup shows this page's usage and today's total; full stats live in DSH's left-toolbar
  "dsh翻译" page;
- **Wordbook**: add entries from the extension, review them in DSH → "dsh翻译" → Wordbook.

---

## Data and privacy

- Translation / lookup text is sent through your local DSH to **the model service you configured in DSH**
  (for example modelhub); it is not sent to other third-party translation services;
- **English single-word lookups** may additionally query a public dictionary, selected in DSH →
  dsh翻译 → Settings → Third-party dictionary: [`dictionaryapi.dev`](https://dictionaryapi.dev/)
  (phonetics, definitions, pronunciation audio; default), English Wiktionary (definitions, no audio),
  or **off** (no third-party dictionary request at all). Only that single word (not the page text) is
  sent to the selected dictionary, and failures degrade silently to "no dictionary". The request is
  host-internal and is **not written into DSH session/conversation records** (those only contain the
  model request and its translation);
- **Image translation** only happens when you right-click an image and choose it: the visible image
  area is sent through your local DSH to the model selected for images (default: the current translation
  model, e.g. DeepSeek), and the temporary image attachment is deleted immediately after the request.
  Only OCR text and translations are cached locally; the image is not written into DSH session records
  or extension storage;
- The extension only stores its own UI preferences (`chrome.storage.local`) and **does not store page
  content**; it never talks to models directly and stores no API keys;
- Plugin data is written only under `$DSH_HOME/immersive-translate/`:
  - `settings.json` (model / prompts / language settings)
  - `wordbook.json` (wordbook and review progress)
  - `usage.json` (token ledger and the latest 500 events; clearable from the Traces page)
  - `cache.json` (translation-result cache: source batches → translations, stored locally for 7 days /
    1000 batches; clearable from the Overview page)
  - `ball-sites.json` (domains where the floating ball is hidden, managed from DSH settings)
  - `conversations/` (storage directory for translation conversations; DSH session logs are managed by
    DSH itself)
- The local API listens on `127.0.0.1` only, with an origin allowlist; it has no filesystem or command
  execution capability;
- Every translation action creates a local DSH session titled "翻译 · page title / site", persisted by
  DSH's session store and grouped under the **dsh翻译记录** workspace in the DSH sidebar (historical
  sessions are backfilled on first start). After about 15 idle minutes the agent is released (the session
  stays persisted and can still be opened from the plugin's Traces page); click **Open DSH trajectory**
  to view DSH's own Conversation / Trajectory / Stats views. Page source text and translations are written
  to that **local** session log only, and the plugin does not send them anywhere else; session logs are
  managed by DSH and can be cleaned up separately. "Clear stats" clears only the plugin's token ledger and
  does not delete session logs.
- Note: "dsh翻译记录" is a real DSH workspace (directory
  `$DSH_HOME/immersive-translate/conversations/`). DSH uses the most recently active workspace as the
  default directory for new sessions, so while you translate frequently the workspace selector on the
  home "New session" composer may default to **dsh翻译记录**; switch it back in the workspace dropdown,
  and it returns to your usual workspace once translation is idle.

---

## Security notes

- The local API is loopback-only (`127.0.0.1` / `localhost`) and origin-fenced: same-host origins and
  browser-extension origins are accepted, other web origins are rejected. Requests without an `Origin`
  header (local CLI tooling such as `curl`) are allowed by design, and by default any browser-extension
  origin is accepted; narrow the plugin's `extensionOrigins` config if you want to pin a single
  extension ID.
- The API does not implement its own bearer token: it is a **local-trust boundary**. Do not expose port
  3080 beyond loopback, and treat other software running as your OS user as trusted.
- The extension requests only its configured DSH base URL (default `http://127.0.0.1:3080`), with
  `credentials: 'omit'`; it does not read cookies, network history, or page storage, and it injects
  model output into the page with `textContent` (no HTML injection).
- `qa/cdp.mjs` is a **local QA-only helper** for headless Chrome automation. It never reads DSH
  credentials or mints cookies: the operator must pass the launch-token URL printed by `dsh web` as
  `DSH_URL`, or supply an authenticated browser cookie via `DSH_COOKIE`. It is not part of the
  installable plugin package.
- Found a security or privacy problem? Please report it privately to the repository owner instead of
  opening a public issue.

## Development and tests

```bash
# DSH plugin (host + unit tests) — currently 282/282
cd dsh-web-translator
node --check index.js && node --check client.js
node --test test/

# Browser extension (static checks + headless Chrome E2E, no real model calls)
cd ../dsh-web-translator-extension
node tools/verify.mjs        # 210 static checks
node tools/e2e-chrome.mjs    # 135/135 headless E2E checks (mock DSH)
```

- Design contracts: [`DESIGN.md`](dsh-web-translator/DESIGN.md) / [`DESIGN-TOKEN-USAGE.md`](dsh-web-translator/DESIGN-TOKEN-USAGE.md) / [`DESIGN-TURN-TRACE.md`](dsh-web-translator/DESIGN-TURN-TRACE.md) / [`DESIGN-CONVERSATIONS.md`](dsh-web-translator/DESIGN-CONVERSATIONS.md) / [`DESIGN-CACHE.md`](dsh-web-translator/DESIGN-CACHE.md) / [`DESIGN-IMAGE.md`](dsh-web-translator/DESIGN-IMAGE.md)
- Independent QA reports: [`TOKEN-STATS-QA.md`](dsh-web-translator/qa/TOKEN-STATS-QA.md) / [`TURN-TRACE-QA.md`](dsh-web-translator/qa/TURN-TRACE-QA.md) / [`CONVERSATION-QA.md`](dsh-web-translator/qa/CONVERSATION-QA.md) (harness usage and assertion results)
- Live evidence: not committed (contains real pages/session information); run `node qa/conversation-shot.mjs` locally to generate it under `qa/live-conversations-evidence/`

---

## FAQ

| Symptom | What to do |
|---|---|
| No "dsh翻译" in the left toolbar | The plugin was not installed successfully, or the page was not refreshed: confirm the install result says `application: applied`, then hard-refresh the DSH page (`Cmd+Shift+R`) |
| Extension says it cannot connect to DSH | DSH Web is not running, the port is not 3080, or the address is wrong in the extension options; first verify the backend with `curl http://127.0.0.1:3080/dsh-immersive/api/health` |
| Extension installed but pages do nothing | Refresh the pages that were already open (the extension only injects into newly loaded pages); restricted pages such as `chrome://` cannot be translated |
| Part of the page is still untranslated after scrolling | In screen mode (default) only the current screen plus preload is translated once scrolling settles; screens scrolled past quickly are intentionally skipped. Press "Translate this page" / "Re-translate", or switch to block mode in the extension options |
| Page language equals the target language, nothing happens | The extension detects `<html lang>` / `content-language` / `og:locale`; when it matches the target language no request is made (and the ball is hidden by default). Change the target language or disable "hide the ball when page language matches" |
| Does re-translating the same page still cost tokens? | Identical source text / prompts / model hit the result cache and cost no tokens (`cached:true`, usage all zero); the cache persists across restarts for 7 days and can be cleared from the Overview page |
| No token row in the popup | The DSH plugin is too old (`/health` version < 1.1.0) or the API is not loaded; upgrade/reload the plugin and refresh the page |
| A new session defaults to the dsh翻译记录 workspace | DSH treats the most recently active workspace as the default directory for new sessions, which happens while translating frequently. Switch back in the workspace dropdown; it returns automatically once translation is idle. Existing sessions are unaffected |
| Translation fails with `MODEL_UNAVAILABLE` / `MODEL_AUTH` | No usable model or credentials are configured in DSH; check DSH's model settings |
| Translation fails after customizing prompts | Prompts must keep the JSON output contract (see the hint in DSH → "dsh翻译" → Settings); use "Restore defaults" if needed |

---

## Notes

- This repository is currently **private**; the owner can change its visibility if it should be public.
- DSH (DeepSeek Harness) is the runtime environment and its source code is not part of this repository.
  The plugin is installed as a local bundle; this repository does not modify DSH source code or profile
  files (installation is performed by DSH's plugin manager).

---

**English** | [简体中文](README_ZH.md)
