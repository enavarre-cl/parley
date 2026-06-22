# Changelog

All notable changes to Parley. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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
- **`parley.tools.maxReadBytes`** now accepts **`0` = unlimited** (no truncation of `fs_read` /
  `web_fetch` output); its minimum dropped from 1000 to 0. Default unchanged (100000). Localized in
  all six languages.

## [1.2.1] - 2026-06-21

### Added
- **`parley.tools.maxIterations`** — configurable cap on the agentic tool-loop (the model calls
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
- **`parley.openrouter.customModels`** — add model ids the API doesn't list (e.g. new / preview
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
