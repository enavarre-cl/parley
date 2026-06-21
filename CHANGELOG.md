# Changelog

All notable changes to Lang Chat. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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
- **`langChat.openrouter.customModels`** — add model ids the API doesn't list (e.g. new / preview
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
