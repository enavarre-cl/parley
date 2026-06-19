# Changelog

All notable changes to Lang Chat. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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
