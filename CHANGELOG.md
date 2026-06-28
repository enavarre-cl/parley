# Changelog

All notable changes to Jotflow. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [2.6.8] - 2026-06-28

### Security
- **Cleared a CodeQL `js/incomplete-sanitization` (high) alert** in `media/panels/models.ts`.
  Inserting the accessibility `<title>` into a capability-badge SVG used `ICONS[…].replace('>', …)`,
  which CodeQL flags as incomplete sanitization (a string `.replace` hits only the first match). It
  was never sanitization — the `label` is already `escapeHtml`-escaped — but per **W7** the fix
  refactors to a pattern CodeQL accepts (explicit `indexOf('>')` + `slice` splice, no `.replace('>')`)
  rather than dismissing it. The alert surfaced in 2.6.5 when a no-op 3rd `.replace(…, 1)` argument
  was removed, exposing the 2-arg form to the query. Webview gate green, bundle valid, 127 tests pass.

## [2.6.7] - 2026-06-28

### Docs
- **Docs caught up with the webview TypeScript migration + build.** `CONTRIBUTING.md` now documents
  the webview build (a new **Webview build** section), uses `npm run dev` for develop-and-run, lists
  the real validation commands (`tsc -p media/jsconfig.json` + `npm run build:webview` instead of the
  obsolete `node --check media/*.js`), notes both `src/**` and `media/**` are `any`-free TypeScript,
  and fixes stale file paths (`media/main.js` → `media/panels/config.ts`, `build-spell.js` → `.ts`).
  `BEST-PRACTICES.md` corrects the now-false "webview sin build" claim and the `node --check`
  checklist step. `README.md` notes the migration in its changelog summary.

### Validation
- Pre-release checks all green: `tsc` (host) · `eslint src` 0/0 · `tsc -p media/jsconfig.json` 0 ·
  127 tests · `build:webview` valid · no file > 500 lines · `npm audit` 0 vulnerabilities. SECURITY
  threat model unchanged (the webview still loads nonce'd scripts under the strict CSP; the build adds
  no external input, and `tsx`/`jiti` are devDeps, not shipped).

## [2.6.6] - 2026-06-28

### Internal
- **Zero hand-written `.js` in the whole repo.** The last three were the Node build tooling, now
  TypeScript: `scripts/build-webview.ts`, `scripts/build-spell.ts` (run via `tsx`) and
  `eslint.config.ts` (loaded via `jiti`). Added `tsx` + `jiti` as devDeps; `npm run build:webview` /
  `build:spell` use `tsx`, eslint reads the `.ts` flat config. `build:webview`, `eslint src` and 127
  tests all pass. The only `.js` left are compiled output (`media/dist/*`, `dist/extension.js`) and
  vendored libs (`mermaid.min.js`, `spell-engine.js`) — generated/third-party, never source.

## [2.6.5] - 2026-06-28

### Internal
- **Typed the webview ambient globals (`media/globals.d.ts`), removing the `any`s.** `LangI18n`,
  `LangSpell` and the lazy-loaded `mermaid` global now have real interfaces (matching the methods the
  code actually calls); `SPELL_DICTS` is `Record<string, {aff, dic}>`; the VS Code webview state is a
  typed `WebviewState` (`zoom` + `tts`) instead of `any`; `ClipboardItem` comes from `lib.dom` (the
  hand-rolled `any` override is gone); `webkitAudioContext` is `typeof AudioContext`. Dropped the dead
  `PMd`/`PMermaid`/`PFind` legacy bridges. Typing surfaced (and documented) that the per-webview state
  holds both the chat zoom and the TTS prefs. Gate green, bundle valid, 127 tests pass.

## [2.6.4] - 2026-06-28

### Internal
- **Zero hand-written `.js` left in the webview.** The remaining 9 source files migrated `.js`→`.ts`:
  the classic globals (`i18n`, `spell`) and the standalone-panel webviews (`models`, `modelsFormat`,
  `voices`, `compare`, `dictionary`, `engines`). Each is now bundled by esbuild into `media/dist/*.js`
  (IIFE) and loaded from there; every panel's `<script src>` was rewired. `zoom.js` was **eliminated**
  — its pure math moved to `src/zoomMath.ts` (one source of truth shared by the host unit test and the
  webview, which imports it through the bundle), dropping the `window.LangZoom` global. Only the
  vendored libs (`mermaid.min.js`, `spell-engine.js`) and the generated `media/dist/*` bundles remain
  `.js`, by definition. `tsc` (host + `media/jsconfig.json`), eslint and 127 tests pass; all bundles
  valid.
- Still open (next pass): the standalone-panel `.ts` are bundled but not yet in the webview type gate
  (only the chat graph is), and `strict` is not yet flipped on. **Needs an F5 smoke test of the chat
  + each side panel before the next publish** (their script tags now load from `media/dist/`).

## [2.6.3] - 2026-06-28

### Internal
- **Entire chat-webview module graph migrated `.js`→`.ts`** (18 files: `app/ ui/ render/ features/
  chat/ panels/`), on top of `core/` from 2.6.2. Load-bearing JSDoc casts became `as`; a few helpers
  got trailing params marked optional; `iconButton`'s `onClick` typed. `tsc -p media/jsconfig.json`
  green (non-strict); esbuild bundle valid; 127 host tests pass; no behavior change. Still `.js`: the
  classic globals (`zoom/i18n/spell`) and the standalone-panel webviews (voices/models/compare/…).

## [2.6.2] - 2026-06-28

Start of the **webview TypeScript migration** (toward zero hand-written `.js` in the chat webview).
Foundational + first slice; no behavior change.

### Build
- **The chat webview is now bundled by esbuild** (`scripts/build-webview.js` → `media/dist/app.js`),
  wired into `npm run dev` and `vscode:prepublish`. esbuild resolves `.js` import specifiers to their
  `.ts` sources, so the module graph can migrate `.js`→`.ts` **file-by-file without touching a single
  import** and the bundle works on any mix. Vendored libs (mermaid, spell-engine) and the classic
  globals (zoom/i18n/spell) stay external `<script>` tags — not bundled. This deliberately reverses
  the prior "webview unbundled by design" stance to enable a `.ts` source tree with a real build.
  `media/dist/` is git-ignored (built on dev/prepublish).

### Internal
- **`core/` migrated to TypeScript** (`dom`, `i18n`, `icons`, `vscode`) — the first slice. Typing
  `core` surfaced two harmless latent issues, now fixed: a stray non-standard 3rd argument to
  `String.replace(…, 1)` in `models.js` (ignored at runtime — string replace already hits only the
  first match) and a `Blob`/`Uint8Array` lib-types cast in `setImageSrc`. `tsc -p media/jsconfig.json`
  stays green; the esbuild bundle is valid JS.

### Note
- The migration is staged: the rest of the graph (render/ui/features/chat/panels/app + the classic
  globals) follows in subsequent passes, with the type gate green at each step and `strict` flipped
  on at the end. **Needs an F5 smoke test before the next publish** — the bundle changes how the chat
  webview loads (one bundle vs. per-module).

## [2.6.1] - 2026-06-28

Integration-test pass over the two layers that previously only `tsc` + manual F5 covered — the
agentic turn and the webview↔host protocol. No behavior change for the user.

### Tests
- **`inference.test.ts` (8 cases): the agentic turn, driven by a scripted fake provider.** A new
  `buildProvider` seam in `InferenceDeps` (default = the real one) lets a test stand in a fake
  backend — no network, no host. Covers: streamed deltas accumulate into the answer (+ usage);
  reasoning routes to `streamReasoning`; the **tool loop** round-trips (call → result fed back →
  final answer) and **persists the exchange in order** with the call id linked; invalid tool-arg
  JSON is reported to the model, **not executed**; the loop is **bounded** at the iteration cap (no
  runaway); a provider error fails the turn while a **user Stop is not a failure**; and an empty
  completion surfaces the "no content" error.
- **`messageRouter.test.ts` (19 cases, landed with 2.6.0): the webview→host dispatch.** Asserts every
  message `type` reaches the right handler (via a recording `RouterCtx` mock) — the regression net
  for the "wiring" class where a renamed `case` label silently drops a message (the 1.5.2 bug). Plus
  the validation guards (integer-index checks, the busy lock, confirm-before-delete). Suite: **127
  tests, all passing**.

### Internal
- `runInference` gains an optional `buildProvider` dependency (a test seam); production wiring is
  unchanged — `extension.ts` doesn't pass it, so it defaults to the real `buildProvider`.

## [2.6.0] - 2026-06-28

### Removed
- **YouTube as a Chatterbox voice-cloning source — and `yt-dlp` entirely.** A reference voice is now
  cloned **only from a local audio/video file you pick** (ogg · mp4 · mp3 · wav) with a start/end
  trim, not from a YouTube URL. This drops the most fragile, externally-dependent and tangential
  branch of the app: no more yt-dlp (which YouTube routinely broke), no URL host-allowlist, no
  network fetch in the create-voice path. The Chatterbox engine venv no longer installs yt-dlp
  (ffmpeg via `imageio-ffmpeg` stays, for the trim). Existing cloned voices keep working unchanged.
- **Settings `jotflow.tts.youtubeMaxSeconds` and `jotflow.tts.youtubeAllowAnyUrl`** (and their nls
  keys) — obsolete with the URL path gone. The clip cap is the fixed `REF_CLIP_MAX_SECONDS` (30 s).

### Changed
- **Create-voice form is now file-first:** name + language + **Start/End in seconds** + **Add from
  file…** (native picker filtered to ogg/mp4/mp3/wav). The host trims the picked file to `[start,end]`
  with ffmpeg (`-ss`/`-t`) and normalizes to mono 24 kHz; the user's source file is never modified.
  The range is optional — empty takes the first 30 s.

### Security
- SECURITY.md updated: the "SSRF / arbitrary download via the voice-sample URL" threat row is gone
  (there is no URL fetch anymore), the RCE row is now "ffmpeg / Python" (no yt-dlp), and the residual
  risks lose the "YouTube ToS / copyright" and "yt-dlp installed unpinned" entries.

### Internal
- `chatterbox/assets.ts` drops `validateSourceUrl`/`UrlCheck`/the YouTube host allowlist,
  `formatSections` and `YT_DLP_SPEC`; `ChatterboxManager` drops `ytDlpBin`/`upgradeYtDlp` and the
  download branch of `createVoice`. `chatterbox.test.ts` drops the URL/format-token cases (the kept
  pure validators — timecode, range, voice-id — still tested).
- **Dev-loop fix (W1):** F5 runs `main` = `dist/extension.js` (the esbuild bundle), but the
  `preLaunchTask` only built `out/`, so host changes silently ran stale code. New `npm run dev`
  (compile + bundle); `launch.json` `preLaunchTask` → `npm: dev` and `outFiles` includes `dist`.

## [2.5.0] - 2026-06-28

### Added
- **The ⚙ settings are now collapsible sections, collapsed by default.** The long flat list of
  parameters is reorganised into intent-based, foldable groups — **System prompt** (open by default),
  **Response** (temperature · length · stop), **Context** (history · summarize), **Capabilities**
  (reasoning · tools), **Sampling** (the advanced samplers), **Engine · Ollama** (num_ctx · threads)
  and **Read aloud**. Each header shows a one-line hint of its contents while collapsed and a
  disclosure triangle that rotates open. The open/closed set is **persisted per conversation** in the
  `.chat` (`ui.configSections`; absent = the default of only the system prompt open, an explicit `[]`
  = everything collapsed). A section whose parameters don't apply to the active backend is hidden.
- **Chat zoom is remembered per conversation.** The `Alt`/`Option`+wheel (and the −/%/+ toolbar) zoom
  level now travels with the `.chat` (`ui.zoom`), so reopening a conversation restores its zoom
  instead of resetting to 100%. Persisted debounced through the same `setConfig` path as the panel
  state; `vscode.getState()` is kept as a fast local cache so the level is also restored instantly on
  a plain webview reload.

### Changed
- **The Settings panel header uses an SVG cog icon** (matching the Reasoning/Tools panels) instead of
  the thin, undersized `⚙` emoji, so all three panel headers share one icon size and weight.
- **The "Stop Strings" control now uses the standard `.cfg-row` (label-over-control) layout** like
  Engine/Voice, instead of a one-off `.param-head` structure — so its label↔control spacing and label
  style match the rest of the panel.

### Internal
- **CSS split to stay under the 500-line ceiling (M1):** the config-panel styles (system prompt,
  `.md` layers, the section accordion, group headers) moved out of `style.css` (503 → 354) into a new
  `media/config.css` (159), linked right after `style.css`.
- **Dead-code/safety:** the stop-strings editor dropped its `innerHTML` + `escapeHtml` label in favour
  of `textContent` (one fewer XSS-adjacent sink, U4/U12), and the now-unused `escapeHtml` import was
  removed from `config.js`.

### Tests
- `applyPatch.test.ts` gains coverage for the new `ui` fields: `configSections` (string-array
  validation, empty-array preserved as "all collapsed", non-string ids filtered) and `zoom`
  (finite-number validation), plus a `parseDoc`/`serializeDoc` round-trip. Suite: **103 tests, all
  passing**.

## [2.4.0] - 2026-06-28

### Added
- **The system prompt is now layered: an open inline base + any number of ordered `.md` files.**
  The ⚙ panel keeps the always-editable base prompt and, below it, a reorderable list of `.md`
  **layers**: **Add .md** appends one or more existing files (multi-select), **Save base as .md**
  externalises the current base into a new file and appends it, and each layer row has a **checkbox**
  (include/exclude without deleting), **↑ / ↓** to reorder, **Open** and **✕**. At inference time the
  base and every *enabled* layer are read and **concatenated in order** (`\n\n`-joined) into the
  single system prompt that is sent — so a shared persona/rules can live in reusable files, be
  reordered, and be toggled per chat. Stored as `systemPromptFiles: [{ path, enabled? }]` (a layer's
  `enabled` is persisted only when `false`, keeping the JSON clean).
- **Per-layer assembly is reflected in the context bar** — `sysPromptTokens` now counts the base
  plus all enabled layer contents, so the token budget doesn't undercount when layers are used.

### Changed
- **Migration: the legacy single `systemPromptFile` is converted into one layer on load.** Because
  that field *replaced* the inline prompt, migration moves it into `systemPromptFiles` and **empties
  the base** — preserving the exact prompt that was being sent (no doubling). The legacy key is no
  longer written.

### Security
- **Path confinement is enforced per layer.** Each `systemPromptFiles` entry is validated against the
  workspace allow-list (the `.chat`'s folder or any workspace root) both when assembling the prompt
  for the model (`readSystemPrompt`) and when opening a layer (`openSysPrompt`); out-of-workspace
  layers are warned about at pick time and skipped at send time. SECURITY.md's path-traversal row
  updated accordingly.

### Tests
- `applyPatch.test.ts` gains 3 cases: legacy `systemPromptFile` → single layer + emptied base (and
  the old key not re-emitted), `systemPromptFiles` validation (object + string shorthand, junk
  dropped, `enabled:false` kept), and a serialize round-trip (absent → no key). Suite: **102 tests,
  all passing**.

## [2.3.5] - 2026-06-27

### Fixed
- **A chat whose `.attach` sidecar was deleted no longer fails every turn with a provider `400` / `502`.**
  Images and documents are stored in the `.chat` as `{kind, name, mime, ref}` with their bytes in the
  `.attach` sidecar; deleting the sidecar orphans those refs, so they resolve to an attachment with
  **no `data`**. The extension still sent them as empty image/document parts
  (`data:…;base64,undefined`), which every provider rejects — and since the whole history replays each
  turn, the error stuck. Unresolved attachments are now **dropped before the request** (filtered in the
  shared `imageAttachments` / `documentAttachments` helpers, so all four providers are covered) and the
  model is told with an `[Attachment unavailable: <name>]` note instead of an empty image.

### Tests
- New `src/test/multimodal.test.ts` (4 cases): data-less / empty image & document attachments are
  excluded, and `dataUrl` / `parseDataUrl` round-trip. Suite: **99 tests, all passing**.

## [2.3.4] - 2026-06-27

### Fixed
- **Deleting a message that has an image no longer makes the scroll jump back several messages.** On a
  delete/merge re-render the view is re-anchored to the top-most visible message, but image
  attachments load asynchronously with no reserved height (`width:100%; height:auto`) — an image
  *above* the viewport growing after the re-anchor pushed everything down, so the view jumped to
  earlier messages. The anchor is now re-pinned as each image settles (load/error), until the user
  scrolls away.

### Internal
- **Webview type-check back to 0 errors.** `media/ui/notifications.js` hangs `_span`/`_fill` refs on
  the TTS-progress element; it is now cast to `any` at creation (same idiom as `message.js`), clearing
  two `checkJs` errors so `tsc -p media/jsconfig.json` is clean again (the 1.5.0 promise).

### CI
- **The release pipeline (re)creates the `v<version>` tag on the published commit**, right before the
  two deploy jobs: if the tag already exists it is deleted and re-pointed at the release commit, so it
  always tracks what was shipped. Scoped `contents: write` on that one `tag` job; top-level stays
  read-only.

## [2.3.3] - 2026-06-27

### Added
- **The Reasoning & Tools panels remember their open/closed state per conversation**, persisted in
  the `.chat`. Closing a panel now sticks: streaming reasoning or a tool call **no longer pops a panel
  back open** once you've closed it, and a panel you pinned open is restored when you reopen the chat.
  Stored as an optional `ui` object (`thinkOpen` / `toolsOpen`) — chats predating this stay untouched
  (absent = the previous behavior: closed, auto-opens while streaming). A close made **mid-stream** is
  applied to the in-memory doc and saved by the turn's own write (the `setConfig` busy-lock lets a
  ui-only patch through, since it touches nothing the in-flight request reads).

### Fixed
- **`jotflow.tts.chatterboxExaggeration` was a dead setting** — declared in Settings but never read,
  so changing it did nothing (the value came only from the in-panel slider's webview state). It is now
  wired the same way as `tts.piperModel`: read on the host and injected into the webview, where it
  **seeds the Expressiveness slider** (the saved per-chat value still overrides once you move it).

### Changed
- **Images in chat bubbles now fill the view width at proportional height**, instead of a 220 px
  click-to-enlarge thumbnail (512 px for generated images). The click-to-zoom toggle was removed.

### Internal
- **Dead-code sweep** (M6): removed an unused `i18n` re-export (`core/i18n.js`), a never-subscribed
  pub/sub mechanism in the doc store (`ui/store.js`), the now-orphan `Click to enlarge` localization
  key from all six `package.nls.*`, and trimmed six functions that were exported but only used inside
  their own module (`send`/`addFiles`/`renderPending`, `copyImageToClipboard`, `insertAtCursor`,
  `applyLanguage`). `tsc`, `eslint src` and `node --check media/*.js` clean.
- **Tests (V3/V5):** `applyPatch.test.ts` gains coverage for the new `ui` patch (boolean validation,
  partial updates) and a `parseDoc`/`serializeDoc` `ui` round-trip (absent → no key; corrupt value
  dropped). Suite: **95 tests, all passing**.

## [2.3.2] - 2026-06-27

### Changed
- **Removed the "Update" button from the engines panel/tree** (Piper · Chatterbox). Engine versions
  are **pinned by the extension**, so "Update" only re-installed the same pin — a no-op that implied a
  non-existent "check for a newer version". Engines now update when the extension itself updates.
- **`yt-dlp` now self-heals**: instead of a manual update button, a failed YouTube extraction
  **auto-upgrades yt-dlp to the latest and retries once** (YouTube routinely breaks older releases) —
  fixing the one thing that genuinely needed updating, exactly when it bites.

## [2.3.1] - 2026-06-27

### Fixed
- **`@file` mentions now work when editing a message.** Inline message editing wired the popup
  keydown navigation (`handleFileKeydown`) but never `setupFileAutocomplete`, so typing `@` opened
  nothing. It now matches the composer — workspace files are resolved by the host and inserted on pick.

### Docs
- **README updated** for the Chatterbox voice‑cloning engine (incl. the Apple‑Silicon MLX fast path),
  the engines management panel, the Voices tree grouping, the new `jotflow.tts.chatterbox*` /
  `…youtube*` settings, and the third‑party components (chatterbox‑tts / mlx‑audio / yt‑dlp / ffmpeg).

## [2.3.0] - 2026-06-27

### Added
- **Chatterbox (Resemble AI) — a third "read aloud" engine** with **zero-shot voice cloning**,
  alongside System voices and Piper (opt-in; Piper stays the default). It installs a self-contained
  pip env reusing the shared SHA-pinned Python and runs a resident-model daemon on `127.0.0.1`.
  **On Apple Silicon** it uses a **4-bit multilingual** model via `mlx-audio` (Apple's MLX):
  **~4× faster** (≈0.8× real-time — faster than real-time) and far lighter (no PyTorch; ~0.5 GB venv
  + ~1 GB weights). **Other platforms** use the `chatterbox-tts` (PyTorch) backend on MPS/CUDA/CPU.
  Settings: `jotflow.tts.chatterboxModel` / `…chatterboxDevice` / `…chatterboxExaggeration`.
- **Create a cloned voice from a YouTube fragment** — paste a YouTube URL and an `mm:ss` time range;
  only that section is downloaded (yt-dlp) and trimmed (ffmpeg) to a mono reference clip used for
  cloning. Also **"Add from file…"** for a local audio sample. Each voice stores its **language**
  (picked at creation) and the multilingual model speaks the clone in that language automatically —
  no chat-level config. URL is host-allowlisted (`jotflow.tts.youtubeAllowAnyUrl` off by default),
  the range capped (`jotflow.tts.youtubeMaxSeconds`, 30 s), with a rights-reminder in the form.
- **Engines management panel** (the gear in the Engines view, or click an engine): install / start /
  stop / update / delete each engine with buttons, the download sources & versions, a **live
  progress bar**, and the **RAM** each running engine uses — replacing the cramped tree icons + toast.
- **Read-aloud progress bar** for the slow neural path (model loading + per-sentence `Sampling …%`),
  plus **auto-restart + retry** if the synthesis daemon dies mid-request (idle-kill / crash).

### Changed
- **Voices panel & sidebar reworked**: Piper voices are now a **language combo + Download button +
  downloaded list** (like Chatterbox); the **Voices tree groups by engine › language › voice**.
- **Shared TTS internals**: the Python bootstrap (`src/pyenv.ts`), the HTTP-daemon primitives
  (`src/ttsDaemon.ts`) and the progress-percent parser (`src/progress.ts`) are shared across engines,
  so the self-contained Python is downloaded once. Piper's uninstall leaves the shared interpreter in
  place; the daemon starts **offline** (no HF network checks) once a model has loaded before.

### Security
- Threat-model + residual-risk entries for the Chatterbox path (host-side URL allowlist anti-SSRF,
  argv-array spawns with no shell, Workspace-Trust gating, pinned pip packages, single-threaded
  loopback daemon, offline cache marker; accepted residuals: YouTube ToS, uncurated clips,
  non-hash-pinned HF weights, PerTh watermark) — see SECURITY.md.
- **Bumped `undici`** (the sole production dependency) to **6.27.0**, clearing a high-severity
  advisory — `npm audit` reports **0 vulnerabilities**.

## [2.1.2] - 2026-06-25

### Build
- **Bundle the extension host with esbuild** (T12) into a single minified `dist/extension.js`
  (`undici` inlined, `vscode` external). The packaged `.vsix` drops from **270 files (188 JS) to
  74 (33 JS)** — clearing the vsce "should bundle your extension" warning; `node_modules`/`out` are
  no longer shipped. `tsc` still emits `out/` for type-checking and `node:test`. The webview
  (`media/**`) stays **unbundled by design** (served per-module via `asWebviewUri`).

## [2.1.1] - 2026-06-25

### Security
- **Resolved all GitHub CodeQL code-scanning alerts** (7 distinct queries) found on the 2.1.0 code,
  with real fixes (no dismissals):
  - **Model-browser README sanitizer is now a DOM allowlist** (parses into an inert `<template>`,
    keeps only known-safe tags/attributes) instead of a regex denylist
    (`js/incomplete-multi-character-sanitization`); the strict CSP remains the backstop.
  - **Attachment images render via a `Blob` object URL** (`URL.createObjectURL`, revoked on load),
    not a `data:` URL concatenated from the `mime`/base64, so untrusted bytes never reach a URL sink
    (`js/xss-through-dom`, `js/client-side-unvalidated-url-redirection`); `mime` validated as `image/…`.
  - `web_fetch` HTML→text: decode `&amp;` **last** (`js/double-escaping`) and match `</script>` /
    `</style>` with trailing junk (`js/bad-tag-filter`).
  - Escape capability labels before `innerHTML` (`js/xss`); actually escape U+2028/U+2029 in the
    inline-script JSON (was a no-op `replace` — `js/identity-replacement`).
- **Documented the findings as forward guidance**: BEST-PRACTICES.md rules **U7–U12 / W7** (DOM
  allowlist, Blob URLs, entity-decode order, no identity replaces, escape-before-innerHTML, CodeQL
  as a gate) and a new **"Static analysis (CodeQL)"** section in SECURITY.md.

## [2.1.0] - 2026-06-25

### Added
- **Model explorer source is now configurable** (`jotflow.models.source`). The default is the
  **Ollama library** (ollama.com) — searched and downloaded natively via `ollama pull name:tag`.
  Set it to `huggingface` to keep browsing Hugging Face GGUF repos as before. Ollama has no public
  search API, so the library is read from ollama.com's first-party HTML (stable `x-test-*` markup);
  downloading never depends on that. New module `src/ollama/library.ts` with unit-tested pure parsers.
  - **Cloud variants** are surfaced explicitly. A model's detail lists its real cloud tags (e.g.
    `gemma4:cloud`, `gemma4:31b-cloud`) in a selector with a **Register** action that pulls the chosen
    `name:tag` stub (no weights) so it appears in your list / chat selector; inference runs on Ollama
    Cloud. Models with **both** local downloads and cloud variants (e.g. `gemma4`) now show *both* the
    download picker and the cloud selector, instead of one hiding the other. Cloud-only models keep
    just the cloud selector; ☁ Cloud badge in the list and detail header.
  - **Ollama Cloud API key**: new `jotflow.ollama.apiKey` setting (and an *Ollama (cloud)* entry in
    the **Set API Key** command → SecretStorage). It is passed as `OLLAMA_API_KEY` to the managed
    server so it can proxy cloud models (`model:cloud`). Restart the Ollama server to apply.
  - **Richer detail pages**: the model's overview, headline metadata (**Context window**, parameter
    **Size**) and full README are scraped from its library page and the README is converted to
    Markdown — so headings, bullet lists and the **benchmarks table** render properly (previously a
    one-line blurb, then a flattened wall of text). New `src/ollama/htmlMarkdown.ts` (pure, tested).

## [2.0.2] - 2026-06-25

### Fixed
- **Critical: the managed Ollama would not start** ("Ollama: Invalid IP address: undefined"). The
  SSRF-hardened DNS `lookup` (used to download the Ollama binary and by `web_fetch`) ignored Node's
  `all` flag and always returned a single address. On Node 20+ (VS Code's runtime, with
  `autoSelectFamily`/happy-eyeballs) Node calls the custom `lookup` with `all:true` and expects an
  **array** — handing it a bare string made Node read `.address` off it and throw
  `ERR_INVALID_IP_ADDRESS`, aborting the binary download so the server never came up. The lookup now
  returns the shape Node asked for via a new pure, unit-tested `safeLookupResult` (`net.ts`), which
  keeps the **strict** anti-SSRF/anti-rebinding policy: the host is refused if any resolved address
  is private/internal/metadata.

## [2.0.1] - 2026-06-24

### Changed
- New extension icon (`media/icon.png`). No code or behavior changes.

## [2.0.0] - 2026-06-24

Rebranding from **Parley** to **Jotflow**, prompted by a brand collision with the existing
**Parley.io**. There are **no functional changes** in this release — the code, features and
behavior are identical to 1.6.2. Everything user-facing and internal that carried the old name
was renamed: extension `displayName`/`name`, command and view IDs (`jotflow.*`), the custom
editor `viewType` (`jotflow.editor`), configuration keys (`jotflow.*`), localized strings across
all 7 `package.nls.*.json` files, the TTS nonce/log identifiers, documentation and CI artifacts.

The **major** version bump reflects the new identity rather than any breaking code change: the
package `name` changes to `jotflow`, which changes the extension ID to `enavarre.jotflow`. On the
Marketplace this is effectively a **new extension** — existing Parley users will not receive this
as an update and must install Jotflow separately.

## [1.6.2] - 2026-06-23

Best-practices conformance pass over **every** `.ts`, `.js` and `.css` file against
[BEST-PRACTICES.md](BEST-PRACTICES.md). No behavior change for the user — internal structure,
linting and test coverage only.

### Internal
- **Module size (M1/M2): the large files were split, keeping cohesion.**
  `extension.ts` 419 → 380 (API-key storage + the `setApiKey` command extracted to `apiKeys.ts`),
  `messageRouter.ts` 427 → 316 (delete/merge/edit/replace handlers extracted to `messageRouterEdit.ts`),
  `providers/openai.ts` 260 → 230 (`openAIContent`/`openAIMessage` extracted to `providers/openaiFormat.ts`).
- **CSS (R1/R5): all 8 stylesheets reformatted to one declaration per line.** The reformat pushed
  `composer.css` over the 500-line ceiling, so it was split by feature into `composer.css` (361) +
  the new `conversation.css` (280, tool calls · PDF/print · context summary). `td.x` selectors in
  `dictionary.css`/`voices.css` de-qualified to `.x` (P3).
- **Tooling (W1):** ESLint `@typescript-eslint/no-unused-vars` raised from `warn` to `error`.
- **Naming (A7):** named the remaining webview magic numbers (`SPELL_DEBOUNCE_MS`, `PAN_STEP`,
  `MAX_SUGGESTIONS`, `CTX_BUDGET_RATIO`, `SLIDER_STEP`).
- **Functions (E1/M3):** `panels/config.js#paramRow` split into `paramRowBool`/`paramRowNumeric`/
  `paramRowTags`; `chatOps.handleFork` extracted a `copyForkAttachments` helper.
- **Errors (L2/K6):** JSON-repair `catch` blocks in `stream.ts`/`anthropic.ts`/`inference.ts` now carry
  a justifying comment; documented in `summary.ts` that the request timeout is owned by the provider
  via `AbortSignal`.
- Documented the generated-bundle exception (M1) in the header of `media/spell-engine.js`.

### Tests
- Added `src/test/applyPatch.test.ts` (7 cases) covering the previously untested pure `applyPatch`
  logic (V5), with a test-only `vscode` module stub. Suite: **63 tests, all passing**.

## [1.6.1] - 2026-06-22

Second audit pass: the remaining `AUDIT.md` items closed (now **74 fixed / 0 open**). Mostly type
safety and security hardening — no behavior change for the user.

### Security
- Validate the configured backend `baseUrl` before use: reject malformed URLs and non-`http(s)`
  schemes (`file:`/`data:`/`javascript:`), and **refuse to send an API key over plaintext `http` to a
  non-loopback host** (P11). ([`f23152e`](https://github.com/enavarre-cl/jotflow/commit/f23152e))
- Gate the Piper system-Python fallback (`python3`/`py`/`python` resolved via `PATH`) behind
  **Workspace Trust** — same posture as the filesystem tools and MCP servers (L7). The SHA-pinned
  standalone Python is tried first and is unaffected. ([`2f4b1ae`](https://github.com/enavarre-cl/jotflow/commit/2f4b1ae))
- CSP: the extension's own DOM no longer relies on `style-src 'unsafe-inline'` (the download progress
  bar sets its width via the CSSOM); it is now attributable **only** to Mermaid's generated SVG, with
  the bounded residual documented (H9). ([`9c11653`](https://github.com/enavarre-cl/jotflow/commit/9c11653))

### Internal
- **Type safety: every `any`-as-a-type removed from `src/` (182 → 0).** Real interfaces and generics
  instead of `any` — `JsonRpcRequest/Response` + `request<T>()` (MCP), a `Raw*` family for `.chat`
  parsing, per-provider response/stream shapes, `WebviewMessage`/`ModelsPanelMessage`, `ChatPatch`,
  `ModelCard`, `ModelsTreeItem`, `TokenUsage`/`ChatResult`/`Attachment`, and typed `fetch`/`dns`/
  `undici` signatures. `unknown`+narrowing is used **only** at true JSON/VS Code boundaries (X1).
  ([`d39586b`](https://github.com/enavarre-cl/jotflow/commit/d39586b), [`6a3b5ca`](https://github.com/enavarre-cl/jotflow/commit/6a3b5ca), [`a7a6b01`](https://github.com/enavarre-cl/jotflow/commit/a7a6b01), [`eb2c2f5`](https://github.com/enavarre-cl/jotflow/commit/eb2c2f5), [`0dc39d4`](https://github.com/enavarre-cl/jotflow/commit/0dc39d4), [`b0015c7`](https://github.com/enavarre-cl/jotflow/commit/b0015c7), [`91495a1`](https://github.com/enavarre-cl/jotflow/commit/91495a1), [`e0cf976`](https://github.com/enavarre-cl/jotflow/commit/e0cf976))
- Replace the `activeApply` global (state smell) with a focus-ordered registry of open chat editors,
  so the models view's "use this model" targets the focused editor — or the most-recently-focused
  still-open one when a chat opened on top of another is closed (H3). ([`ac930ca`](https://github.com/enavarre-cl/jotflow/commit/ac930ca))
- Remove leftover local files (`.webview-backup/`, `plan-*.md`) and the stale `.gitignore` line (X4).
  ([`8bf18c2`](https://github.com/enavarre-cl/jotflow/commit/8bf18c2))

### Fixed
- Find & Replace no longer replaces the wrong occurrence when the term appears inside a Markdown
  link/URL or autolink: the host now skips source matches that fall inside hidden link/image URL
  ranges, matching what the webview highlights (B4, the 1.6.0 known issue). ([`dda6e4d`](https://github.com/enavarre-cl/jotflow/commit/dda6e4d))

## [1.6.0] - 2026-06-22

Security + reliability pass from a full code audit (([`bd6a71d`](https://github.com/enavarre-cl/jotflow/commit/bd6a71d)) inventory). 55 findings fixed
across 39 commits; see `AUDIT.md` for per-finding detail and `BEST-PRACTICES.md` for the standard.

### Security
- Block a `javascript:` link XSS in rendered Markdown — a leading control char bypassed the scheme allowlist. ([`99ce763`](https://github.com/enavarre-cl/jotflow/commit/99ce763))
- Stop `fs_write` from overwriting `.mcp.json` / `.mcp/` (deferred RCE via spawned MCP servers). ([`1449043`](https://github.com/enavarre-cl/jotflow/commit/1449043))
- Stop `fs_search`/`fs_glob` from leaking files outside the workspace via an in-workspace symlink. ([`0533234`](https://github.com/enavarre-cl/jotflow/commit/0533234))
- Escape values interpolated into the inline webview `<script>` (`</script>` breakout). ([`8d6852c`](https://github.com/enavarre-cl/jotflow/commit/8d6852c))
- Validate IPs in `downloadFile` (block SSRF to private hosts / cloud metadata, incl. redirects). ([`1c36358`](https://github.com/enavarre-cl/jotflow/commit/1c36358))
- Anchor the TTS voice-id validation to block path traversal. ([`182a51e`](https://github.com/enavarre-cl/jotflow/commit/182a51e))
- Use a strong fixed-length `crypto` CSP nonce everywhere. ([`1860e16`](https://github.com/enavarre-cl/jotflow/commit/1860e16))
- Strict CSP + nonce on the HTML export. ([`dc9c0e8`](https://github.com/enavarre-cl/jotflow/commit/dc9c0e8))
- Reject absolute/`..` model-import paths from the webview. ([`c951136`](https://github.com/enavarre-cl/jotflow/commit/c951136))

### Fixed
- Streaming kept multi-line blocks intact (tables/lists/blockquotes no longer fragment into one-line paragraphs until the stream ends). ([`fbd617f`](https://github.com/enavarre-cl/jotflow/commit/fbd617f))
- Bold spans can contain a lone `*`/`_` (e.g. `**2 * 3 = 6**`) instead of corrupting into a spurious `<em>`. ([`82faf65`](https://github.com/enavarre-cl/jotflow/commit/82faf65))
- Table cells respect an escaped `\|` and a `|` inside a code span. ([`82faf65`](https://github.com/enavarre-cl/jotflow/commit/82faf65))
- Deleting a chat-response variant no longer jumps to a different variant when an earlier one is removed. ([`ab4cefc`](https://github.com/enavarre-cl/jotflow/commit/ab4cefc))
- A turn that used tools but returned no closing text now persists a closing assistant (no dangling tool chain lost next turn). ([`aafab77`](https://github.com/enavarre-cl/jotflow/commit/aafab77))
- Streaming clipped the first letter of a block ("Jenny" → "enny") until the stream ended. ([`05fb7d4`](https://github.com/enavarre-cl/jotflow/commit/05fb7d4))
- Numbers in prose rendered as `<code>undefined</code>` ("entre 0 y 1") — code-span placeholder collision. ([`8e79369`](https://github.com/enavarre-cl/jotflow/commit/8e79369))
- Show the regenerate button on the prompt even when the answer used tools. ([`af08fd3`](https://github.com/enavarre-cl/jotflow/commit/af08fd3))
- Don't wipe an accumulated answer on a failed/aborted turn. ([`97a2397`](https://github.com/enavarre-cl/jotflow/commit/97a2397))
- Nested Markdown lists keep their nesting; `escapeHtml` coerces non-strings; drop deprecated `unescape`. ([`59bd569`](https://github.com/enavarre-cl/jotflow/commit/59bd569))
- Mermaid diagrams no longer "disappear" when a re-render detaches the node mid-render. ([`6974e0a`](https://github.com/enavarre-cl/jotflow/commit/6974e0a))
- Stream: flush the final chunk so Ollama token usage isn't lost. ([`728a44b`](https://github.com/enavarre-cl/jotflow/commit/728a44b))
- Stream: always release the reader (leak/abort). ([`ce91371`](https://github.com/enavarre-cl/jotflow/commit/ce91371))
- Stream: honor the `AbortSignal` inside the read loop. ([`84f3f14`](https://github.com/enavarre-cl/jotflow/commit/84f3f14))
- Providers: network timeouts so a silent backend can't hang the UI. ([`15336a9`](https://github.com/enavarre-cl/jotflow/commit/15336a9))
- Providers: tool-call id collisions, image-model detection, Anthropic thinking temp, line-buffer cap. ([`b205696`](https://github.com/enavarre-cl/jotflow/commit/b205696))
- Gemini: default the function-response name to avoid a 400. ([`d9d0042`](https://github.com/enavarre-cl/jotflow/commit/d9d0042))
- Agentic loop: run a turn's tool calls concurrently. ([`b01f9cc`](https://github.com/enavarre-cl/jotflow/commit/b01f9cc))
- Agentic loop: repair a dangling tool chain before persisting on abort. ([`f51edd8`](https://github.com/enavarre-cl/jotflow/commit/f51edd8))
- Agentic loop: report invalid tool-arg JSON + hard iteration backstop. ([`21ff371`](https://github.com/enavarre-cl/jotflow/commit/21ff371))
- `fs_search` file I/O is async so it doesn't freeze the editor. ([`ec16a15`](https://github.com/enavarre-cl/jotflow/commit/ec16a15))
- MCP: honor `isError`, fail fast on a dead server, keep stderr, bound the stdio buffer, tree-kill. ([`2ee7f9c`](https://github.com/enavarre-cl/jotflow/commit/2ee7f9c))
- Tree-kill Ollama/Piper (no zombies; fixes Windows `shell:true`). ([`37eaf83`](https://github.com/enavarre-cl/jotflow/commit/37eaf83))
- Downloads: per-item import dir, Piper spawn-error handling, abort-listener cleanup. ([`e4027a3`](https://github.com/enavarre-cl/jotflow/commit/e4027a3))
- Piper: validate/re-fetch the voice `.onnx.json`. ([`aa163de`](https://github.com/enavarre-cl/jotflow/commit/aa163de))
- Piper: time out the TTS synth request. ([`4e00fb8`](https://github.com/enavarre-cl/jotflow/commit/4e00fb8))
- `.chat`: don't crash on a `null`/non-object file; preserve unknown fields round-trip. ([`d78d0b6`](https://github.com/enavarre-cl/jotflow/commit/d78d0b6))
- `.chat`: clamp `summary.upTo` to a valid range. ([`0471988`](https://github.com/enavarre-cl/jotflow/commit/0471988))
- Attachments: unique temp file + mtime cache invalidation. ([`4971a52`](https://github.com/enavarre-cl/jotflow/commit/4971a52))
- Use `crypto.randomUUID()` for message/attachment ids. ([`c5558f2`](https://github.com/enavarre-cl/jotflow/commit/c5558f2))
- Host: register the SecretStorage listener as a disposable. ([`d9939f8`](https://github.com/enavarre-cl/jotflow/commit/d9939f8))
- Host: surface/log errors from the webview message router. ([`2859d3c`](https://github.com/enavarre-cl/jotflow/commit/2859d3c))
- Router: hold the busy lock across `setConfig`. ([`40bea77`](https://github.com/enavarre-cl/jotflow/commit/40bea77))

### Changed
- i18n: translate 24 UI strings into es/pt/fr/de/it, fix British spelling, drop unused keys. ([`d420d11`](https://github.com/enavarre-cl/jotflow/commit/d420d11))
- CSS: theme-token status colors, keyboard focus ring, deduplicated badges. ([`e18686d`](https://github.com/enavarre-cl/jotflow/commit/e18686d))
- Comment best-effort empty catches. ([`3c715b6`](https://github.com/enavarre-cl/jotflow/commit/3c715b6))


### Known issues
- Find & Replace can replace the wrong occurrence when the search term appears inside a URL or
  Markdown syntax (the webview counts visible matches, the host counts raw-source occurrences; they
  diverge when a source occurrence renders no visible mark). Tracked in `AUDIT.md` (B4).
  **→ Resolved in 1.6.1.**

### Added
- `BEST-PRACTICES.md` (dev standard) and `AUDIT.md` (full audit). ([`99ce763`](https://github.com/enavarre-cl/jotflow/commit/99ce763))

## [1.5.6] - 2026-06-22

### Fixed
- **Tools panel no longer shows the previous turn's activity.** Starting a new turn
  (send / continue / regenerate / summarize) now resets the live tool activity, not only the
  notices — closing a behavior gap from the webview modularization.
- **`fs_read` hardening:** rejects directories with a clear error (instead of a raw `EISDIR`),
  rejects binary files (NUL bytes) instead of returning mojibake, and decodes via `StringDecoder`
  so a byte-limit truncation can't append a stray replacement glyph from a split multibyte char.

## [1.5.5] - 2026-06-22

### Fixed
- **Mermaid scales proportionally to the bubble width.** The mounted SVG was stretched
  horizontally (squished vertically): now its intrinsic size is taken from the `viewBox` (or the
  `width`/`height` attributes), the conflicting `width`/`height` attributes + inline styles are
  dropped, `preserveAspectRatio="xMidYMid meet"` and an explicit `style.aspectRatio` are pinned,
  so CSS `width:100%` + `height:auto` can never distort it. Added `min-height:150px` to the
  viewport so a very wide/short diagram still leaves room for the overlay controls (zoom pad).

## [1.5.4] - 2026-06-22

### Fixed
- **Replace advances to the next match again.** `renderConversation` still called the removed
  `window.PFind.refresh()` bridge (undefined now that find is an ES module), so after a replace
  the matches were never re-highlighted and Replace stuck on the same hit. Calls the imported
  `refreshFind()` instead.

## [1.5.3] - 2026-06-22

### Fixed
- **Find & Replace no longer destroys the context summary.** The replace handler wiped
  `doc.summary` on any change; a content replacement leaves the summary's coverage valid, so the
  summary is kept. Replace All now also rewrites the summary text for consistency with the bubble.

## [1.5.2] - 2026-06-22

### Fixed
- **Restored variant switching / deletion.** The `messageRouter` extraction's `ctx.`-prefixing
  pass also rewrote the matching case-label strings, so `case 'setVariant'` / `'deleteVariant'`
  became `'ctx.…'` and never matched the webview messages. Verified every webview message type
  maps to a router case.

## [1.5.1] - 2026-06-22

### Fixed
- First pass at the Mermaid vertical-squish: normalize the SVG `viewBox`/attributes so
  `width:100%` + `height:auto` stay proportional (completed in 1.5.5 with an explicit
  `aspect-ratio` and a control-height floor).

## [1.5.0] - 2026-06-22

### Internal
- **Webview modularized into ES modules — no file > 500 lines.** The 2373-line `media/main.js`
  IIFE (and the `markdown`/`mermaid`/`find` `window.P*` bridges) were split into 19 cohesive
  modules with explicit `import`/`export`, loaded via a single `<script type="module">` entry
  (`app/main.js`): `core/` (vscode, icons, i18n, dom) · `render/` (markdown, mermaid) · `ui/`
  (store, notifications) · `features/` (tts, find, autocomplete, spell) · `chat/` (message,
  conversation, composer) · `panels/` (config, models) · `app/` (protocol, main). State has
  single owners (`store`=doc, `conversation`=streaming/tools, `composer`=send-state); the protocol
  dispatches by calling feature functions, not by mutating shared globals.
- **CSP gains `'strict-dynamic'`** so the nonce'd module entry can import the graph; classic
  globals (`zoom`/`i18n`/`spell`) load first, then the deferred modules.
- **Webview type-checking safety net:** `media/jsconfig.json` + `globals.d.ts` (`checkJs`) validate
  the whole module graph (0 errors); the refactor was validated line-by-line against a backup.

## [1.4.0] - 2026-06-22

### Internal
- **Host god-file modularized — `extension.ts` 1923 → 440 lines, no file > 500.** Extracted, with
  explicit dependencies (no global bridges): `attachmentStore.ts` (the `.attach` sidecar class),
  `inference.ts` (the agentic loop), `messageRouter.ts` (the ~50-case webview→host dispatch),
  `chatOps.ts` (send/fork/regenerate/variants), `webviewHtml.ts`, `systemPrompt.ts`, `summary.ts`
  (rolling summarization), `loadModels.ts`, `ttsBackend.ts`, `localModels.ts` (managed Ollama +
  trees + TTS/engine commands). `tsc` is the completeness net; 48 tests still pass.

## [1.3.9] - 2026-06-22

### Internal
- Extracted `chatOps.ts` (chat-turn operations) from `extension.ts` (→ under 1000 lines).

## [1.3.8] - 2026-06-22

### Internal
- Extracted `messageRouter.ts` — the large `onDidReceiveMessage` switch — behind a typed context.

## [1.3.7] - 2026-06-22

### Internal
- Extracted the `AttachmentStore` class and the `runInference` module from `extension.ts`.

## [1.3.6] - 2026-06-22

### Internal
- Extracted the webview HTML/CSP builder into `webviewHtml.ts`.

## [1.3.5] - 2026-06-22

### Internal
- Split the monolithic `media/style.css` by concern into four files (≤500 lines each):
  `style.css`, `find.css`, `messages.css`, `composer.css`, linked in order.

## [1.3.4] - 2026-06-22

### Fixed
- Regressions from the 1.3.3 webview extraction: Find's replace-advance and the Mermaid diagram
  height. Removed a stale Mermaid SVG cache (always render fresh) and fixed the find refresh call.

## [1.3.3] - 2026-06-22

### Internal
- **Webview modularization (toward ≤500 lines/file).** Extracted two more self-contained subsystems
  from `main.js` into their own nonce-loaded scripts: the **Mermaid viewer** (`media/mermaid-view.js`,
  `window.PMermaid`) and **find & replace** (`media/find.js`, `window.PFind`, vscode API injected via
  `setApi`). `main.js` 2985 → 2373; new files 281 / 216 lines. Behavior unchanged.

## [1.3.2] - 2026-06-22

### Internal
- **God-file slimming (start of §3.2/§3.7).** Two safe, behavior-preserving extractions:
  - Host: the pure chat/message helpers (`addUsage`, `estTokens`, `msgTokens`, `applyVariantToMessage`,
    `isHiddenToolMsg`, `sanitizeAttachments`, `errMsg`, `makeNonce`) moved out of `extension.ts` into
    a VS Code-free `src/chatHelpers.ts` **with unit tests** (48 tests total). `extension.ts` 1989 → 1918.
  - Webview: the self-contained Markdown renderer moved to `media/markdown.js` (loaded before
    `main.js`, exposed as `window.PMd`; entry points aliased). `main.js` 2985 → 2840.
  - Behavior is unchanged; the deeper extractions (`runInference`, the message router, the attachment
    store, webview find/autocomplete) remain as follow-ups.

## [1.3.1] - 2026-06-22

### Internal
- **Provider HTTP shell deduplicated.** The identical "POST stream → check `res.ok`/body → throw a
  formatted error → return the reader" block in all four providers (OpenAI, Anthropic, Gemini,
  Ollama) is now a single `postStream()` helper (`src/providers/request.ts`). Ollama keeps its crash
  hint via an optional `hint` callback; per-provider message mapping is unchanged.

## [1.3.0] - 2026-06-22

### Performance
- **Streaming no longer re-parses the whole message every frame.** Completed Markdown blocks (up to
  the last blank line outside a code fence) are parsed once and frozen in the DOM; only the small
  open tail is re-rendered per frame — removes the O(n²) re-parse + full `innerHTML` rebuild on long
  answers.
- **Mermaid diagrams are cached by source.** History rebuilds (new message, edit, variant switch,
  find/replace…) reuse the rendered SVG instead of re-running `mermaid.render()` for every diagram.

### Security
- **`web_fetch` is hardened against DNS-rebinding (SSRF TOCTOU).** When no proxy is configured it
  routes through an undici dispatcher that validates the resolved IP **at connect time** and
  connects to that exact IP, so the address that is checked is the address that is used (the
  per-hop host check remains as defense in depth).
- **Workspace `fs_read` honors the actual bytes read** (`readSync` return value) and decodes only
  those — no zero-padding / truncated-UTF-8 tail.

### Fixed
- **Stop now cancels an in-flight tool.** The turn's abort signal is threaded into `web_fetch` and
  MCP `tools/call`, so pressing Stop interrupts a long fetch/MCP request instead of waiting out its
  own timeout.
- **Attachment sidecar (`.attach`) writes are atomic** (temp file + rename) and serialized, and a
  sidecar that exists but can't be parsed is never overwritten/pruned — closes a window where a
  half-written read reset it to `{}` and a later save/prune persisted that, losing every blob.
- **Crash-recovery: a trailing unfinished tool exchange is dropped before replay.** Reopening a
  `.chat` that ended mid agentic loop (an assistant `tool_call` with no tool reply) no longer makes
  the backend 400 — the wire is repaired at send time (the stored doc is untouched mid-loop).
- **Token budgeting counts attachment size.** Ref-only attachments (blobs live in the sidecar) now
  carry their byte size, so large attached files are no longer budgeted as 0 and can't silently
  overflow the model context window.
- The `onChange` reconciliation no longer re-renders mid-turn (could disrupt the streaming bubble).

### Internal
- Variant→message field-mirroring (content/thinking/usage/attachments), previously hand-written in
  4 places, is now a single `applyVariantToMessage()` helper.
- Find/replace pure helpers (`buildFindRegex`, `replaceInString`, `applyCase`, `expandRefs`) moved
  to a VS Code-free `src/findReplace.ts` module **with unit tests** (case/whole-word/regex/`$1`
  groups/preserve-case/no-trim).

## [1.2.5] - 2026-06-21

### Fixed
- **Scroll jumped on saving an edit.** Editing a message (especially the penultimate one) made the
  view jump several messages up on save: the open textarea inflated the bubble, and the re-render
  restored a now-stale absolute `scrollTop`. Scroll restoration is now **anchored to the top-most
  visible message** (re-pinned to the same on-screen offset), so a height change in the rebuild no
  longer moves the view — this also steadies the scroll on delete/merge re-renders.

## [1.2.4] - 2026-06-21

### Fixed
- **Scroll “tug of war” during streaming.** Scrolling up to read while a response streamed in kept
  yanking you back to the bottom on every token. A wheel/trackpad scroll-up now detaches from the
  bottom **immediately and synchronously** (beating the per-token auto-scroll), and following only
  re-engages once you return to the very bottom — no more dead-zone fight.

## [1.2.3] - 2026-06-21

### Added
- **Proactive Workspace Trust prompt.** Turning **Tools** on (⚙) in an untrusted workspace now shows
  a warning with a **Manage Trust** button (opens VS Code's `workbench.trust.manage`), so the
  filesystem tools / MCP servers don't fail mid-turn. Fired only on the off→on edge; trust is still
  granted exclusively through VS Code's own UI. Localized in all six languages.

## [1.2.2] - 2026-06-21

### Changed
- **`jotflow.tools.maxReadBytes`** now accepts **`0` = unlimited** (no truncation of `fs_read` /
  `web_fetch` output); its minimum dropped from 1000 to 0. Default unchanged (100000). Localized in
  all six languages.

## [1.2.1] - 2026-06-21

### Added
- **`jotflow.tools.maxIterations`** — configurable cap on the agentic tool-loop (the model calls
  tools, sees results, continues). Default **8**; **`0` = unlimited** (the loop still ends when the
  model stops requesting tools or you press Stop). Localized in all six languages.

## [1.2.0] - 2026-06-21

### Added
- **Find & replace in chat, VS Code-style.** The find bar now matches VS Code's widget:
  - **`Ctrl/Cmd+F`** opens find collapsed (search only); **`Ctrl/Cmd+H`** opens with the replace row
    expanded (toggle chevron on the left to switch).
  - A **replace** row with **Replace** (Enter) and **Replace All** (`Ctrl/Cmd+Enter`). Replace edits
    the raw message source, persists to the `.chat` and re-renders; single replace targets exactly
    the current match, then **advances and scrolls to the next** — even when the replacement still
    matches (e.g. expanding `approx` → `approximately`).
  - Search-option toggles inside the fields: **`Aa`** match case, **`ab`** whole word, **`.*`** regular
    expression (with `$1` group refs in the replacement), and **`AB`** preserve case. Invalid regex
    shows a red field; the counter reads "*n* of *m*" / "No results".
  - The query is now used **verbatim — no trimming**, so you can search/replace text with leading or
    trailing spaces (e.g. `" ab "`).

## [1.1.4] - 2026-06-21

### Added
- **Copy a Mermaid diagram as an image** — a "copy" button (top-right of each diagram) rasterizes
  the SVG to a **PNG** (at 2×, on the current theme background) and writes it to the clipboard.

### Changed
- **Mermaid controls reworked to GitHub's layout**: a directional **pan pad** (arrows around a
  centre **reset/centre** button) with a **zoom +/−** column bottom-right, and **fullscreen** +
  **copy-as-image** top-right — all monochrome stroke icons, shown on hover.
- **Diagrams now fill the bubble width** at their natural proportional height (was a tiny,
  illegible thumbnail), and stay **crisp at any zoom** (dropped the cached-layer that blurred the
  scaled SVG).

### Fixed
- **Trackpad scroll no longer hijacked**: a plain two-finger scroll over a diagram scrolls the chat
  history as expected; zooming is **pinch / Ctrl·⌘+wheel** (or the buttons). Previously any wheel
  event over a diagram zoomed it.
- **Fullscreen fits and centres** the whole diagram on open, instead of showing it zoomed in and
  anchored top-left.
- Removed the fixed height cap that clipped tall diagrams into an unreadable horizontal strip.

## [1.1.3] - 2026-06-21

### Added
- **Mermaid diagrams in chat bubbles** — ` ```mermaid ` blocks render as diagrams on top of the
  existing Markdown. The library (`media/mermaid.min.js`) is **lazy-loaded** only when a chat
  actually contains a diagram, so webviews without one pay nothing at startup. Rendered with
  `securityLevel: 'strict'` and the VS Code light/dark theme. Diagrams render at settled points
  (final message / `streamEnd` / history), never mid-stream — a half-written block reads as a code
  block until it completes, and a syntax error degrades to the code plus a discreet note.
- **Pan/zoom viewer** for each diagram: wheel-to-zoom (toward the cursor), drag-to-pan,
  double-click to reset, a hover toolbar and a fullscreen lightbox (Esc / click-outside to close).

### Security
- Webview CSP `style-src` now allows `'unsafe-inline'` (required for the `<style>` Mermaid embeds
  inside its SVG). Scripts stay nonce-locked; the lazy Mermaid `<script>` carries the page nonce.

## [1.1.2] - 2026-06-20

### Docs
- **`ARCHITECTURE.md`** — codebase tour (extension host ↔ webviews, providers, the agentic loop,
  local engines, i18n, security) with Mermaid diagrams.
- README / SECURITY / CONTRIBUTING updated: 6 languages, image generation, the full built-in tool
  list, GitHub Actions publishing, an **"adding a backend (provider)"** guide.

### Build
- `npm run build:spell` regenerates **all six** dictionaries + the `nspell` engine
  (`scripts/build-spell.js`).
- **Release workflow also publishes to Open VSX** (VSCodium / Cursor / Gitpod / Windsurf…) as a
  separate, parallel job behind its own approval gate; both publishes are idempotent.

## [1.1.1] - 2026-06-20

### Added
- **`@file` mentions** in the composer: type `@`, pick a workspace file, insert its full path.
- **`jotflow.openrouter.customModels`** — add model ids the API doesn't list (e.g. new / preview
  models like `sourceful/riverflow-v2.5-fast`); merged into the model list.

### Changed
- **Full-width message bubbles** — differentiated only by background colour + the role title.
- **Two-step delete** — the first click arms the trash (turns red), the second confirms; clicking
  away / Escape / a re-render cancels it. **Shift** still deletes immediately, **Alt** = this and all
  below. The confirmation modal is gone.
- **Floating tooltips** on every control (topbar + bubble actions) — the native `title` does not
  render reliably in webviews; the delete tip documents the click + modifier combos.

## [1.1.0] - 2026-06-20

### Added
- **Multi-language support — 6 languages** (English, Spanish, Portuguese, French, German, Italian)
  across the **UI**, **spell-check** (bundled hunspell dictionaries) and **Piper TTS** voices,
  switchable **live** without reloading.
- **Image generation**: image-output models such as Gemini *flash-image* ("nano-banana") on Gemini
  and OpenRouter render their images **inline** — copy to clipboard or save to disk; click to zoom.

### Changed
- The context bar and the trim budget now count the **effective** system prompt (the referenced
  file's content included, not just the inline text).
- A **`systemPromptFile`** may live anywhere in the **workspace** (not only the `.chat`'s folder);
  a missing / out-of-bounds reference **warns visibly** instead of silently using the inline prompt.
- **Regenerate** lives only on the user bubble now (it was duplicated on the assistant bubble).

### Fixed
- **Erratic `Cmd/Ctrl+Z`** that reverted or duplicated messages — document undo/redo is now
  neutralized for `.chat` (the chat owns its own delete/edit/regenerate/fork history).
- **OpenRouter reasoning** is parsed from `reasoning_details` too, so Gemini "thinking" now shows.
- The **global language change applies live** (no reload was needed but nothing reacted before).
- Spell-check underline stays **aligned** with the textarea on every line (line-height fix).

## [1.0.8] - 2026-06-19

### Added
- **Split / sharded GGUF** support: multi-part models (`…-00001-of-000NN.gguf`) are grouped into a
  single entry and imported with **all** shards referenced.

### Changed
- Bundled **Ollama** updated to **v0.30.10** (newer `llama.cpp`: broader model support, offload fixes).
- A **friendly hint** when Ollama's `llama-server` crashes (model didn't fit in GPU/RAM → try a
  smaller quant or force CPU) instead of a raw stacktrace.

### Fixed
- **Piper bootstrap**: pip is upgraded via `python -m pip` (not the `pip` script), so the venv setup
  no longer fails (Windows `WinError 5`, or an outdated bundled pip).
- HF's **broken manifest descriptor** for some quants made an Ollama pull die with `400:` after
  downloading the layers — a pre-flight probe + a runtime fallback now route those to a direct
  `.gguf` import automatically.

### Build
- CI migrated to **GitHub Actions** (`.github/workflows/release.yml`): compile → test → package →
  **manual-approval publish**. `azure-pipelines.yml` removed; `package.json` is the single source of
  the published version (idempotent re-publish).

## [1.0.0] - 2026-06-18

### Added
- **Voices manager**: download/remove neural Piper voices from a panel (**＋** in the sidebar),
  verified against a pinned checksum. The chat voice picker lists only downloaded voices.
- **Context management, visualized**: when auto-summarize compacts the history it shows a summary
  divider + an expandable bubble (view / copy / edit / play / fork / delete); each message has a
  **"summarize up to here"**; and the **"last N messages"** window is drawn with its cut-off marker.
- **Spell-checker** with a per-language personal dictionary and a dictionary manager.
- **Sidebar split into sections** with native headers — **Engines** (Ollama & Piper with
  run/stop/install/delete), **Models** (local models + downloads), **Voices**, **Dictionary**.
- **Local models (embedded Ollama + LM Studio-style explorer)**:
  - **Managed Ollama server**: downloads its own binary (pinned SHA256, fail-closed) and runs it
    on `127.0.0.1` (independent of any system Ollama).
  - **Sidebar view** with server status and local models (use in chat, show info, delete).
  - **Explorer** (panel) that searches GGUF models on **Hugging Face**, shows capability badges
    (estimated from tags; ground truth from `/api/show` after download) and **downloads with
    progress**, showing size and free disk space **beforehand**. Download manager with retry/cancel.
  - The chat automatically uses the managed server when it is ready.
- **Hosted backends**: **OpenRouter** and **Anthropic Claude** (Messages API), alongside the
  existing OpenAI-compatible, Ollama and Gemini backends.
- **Search in chat** (`Ctrl/Cmd+F`): floating bar that highlights matches, navigates with
  Enter / Shift+Enter, and re-highlights across re-renders.
- **Chat zoom** (`Alt/Option` + wheel, `Alt/Option+0` reset) with toolbar controls (−, %, +).
- **Compare versions**: render two versions of a `.chat` side by side, triggered from the
  Timeline (Local History), the editor title bar, or the command palette.
- **Fork from here**: ⌥/Alt + the fork icon clones a conversation from a message to the end
  (normal click still clones up to the message).
- **Read aloud (TTS)** with neural **Piper** (local, self-contained) in addition to the system
  engine (Web Speech): female ES/EN voice picker, rate, test button and per-message playback.
- **Self-contained Python**: if no (or a broken) system Python is found, the extension downloads
  its own CPython (pinned checksum) to run Piper. Zero requirements.
- **Internationalization** (English / Spanish) for the webview UI and the marketplace settings,
  with a selector and auto-detection.
- System prompt file defaults to **`.md`**.
- **Regenerate** button on user messages, message **variants**, **continue**, **merge**, **edit**,
  and cascade delete (**⌥/Alt** = this and below).
- `SECURITY.md` with the threat model.

### Changed
- **Piper TTS runs as a persistent HTTP daemon** (model stays resident) instead of one process per
  sentence — near-instant after the first synthesis; the daemon auto-stops on inactivity.
- The **model explorer** respects the UI language (no more hardcoded strings).
- **Delete now asks for confirmation** (modal); hold **Shift** to skip it.
- Reasoning panel renders LaTeX escape sequences (e.g. `\rightarrow`) as Unicode.
- While streaming, the view sticks to the bottom only if you have not scrolled up.

### Fixed
- **Context bar counted the whole history** after an automatic summary — the summary is now synced
  to the chat view, so the bar reflects only what is actually sent.
- **Tool calls no longer break the conversation**: malformed/truncated tool-call arguments are
  repaired (`safeToolArgs`) both when received and when re-sent, fixing a perpetual `400` that
  locked the chat. Unknown tool names now return a clear "Unknown tool" error so the model can
  self-correct, instead of an empty MCP error.
- **Ctrl/Cmd+Z no longer deletes messages**: the `.chat` is a text document, so document-level
  undo could revert/remove messages — it is now blocked, while a text field keeps its own undo.
- **Cascade delete** drags adjacent hidden tool messages on **both** sides, so deleting no longer
  leaves orphaned `tool` / `assistant+toolCalls` entries in the JSON.
- **Chat zoom** is applied only to the message history, so zooming no longer pushed the composer
  (the input bar) off-screen.
- OpenRouter error messages now surface the real upstream cause instead of a generic string.

### Removed
- **"Summary token budget"** setting — the token budget is now always automatic (75% of the
  model's context window).
- **"Update engine"** button — the engine version is pinned, so it was effectively a no-op.

### Security
- **Workspace Trust**: MCP and `fs_write` only run in trusted workspaces.
- **Anti-SSRF** in `web_fetch` (blocks loopback/private/metadata addresses; validates redirects).
- Path confinement (traversal/symlink) in the fs tools, `systemPromptFile`, and `openSysPrompt`.
- Pinned integrity (SHA256) for Piper models/binaries and the self-contained Python; `piper-tts`
  pinned to a fixed version.
- **Ollama** binary verified by SHA256 **fail-closed** before extract/exec; server bound to
  `127.0.0.1` only.
- Model search/download (HF/Ollama) goes through `httpFetch` (inherited proxy + anti-SSRF).
- Exported HTML escapes attachment `mime`/`data`; CSP nonces use `crypto.randomBytes`.

### Performance
- `.chat` parse cache; coalesced streaming render (rAF); markdown memoization.

### Build
- CI migrated to **Azure DevOps** (`azure-pipelines.yml`): `npm ci` → lint → compile → test →
  `vsce package` (publishes the `.vsix` artifact). Uses `UseNode@1` (the deprecated `NodeTool@0`
  was replaced).
