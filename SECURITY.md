# Security — Jotflow

This document describes the extension's threat model, the mitigations implemented, and the
accepted residual risks.

## Scope and trust

Jotflow is an LLM chat editor inside VS Code. It runs in the extension host (Node) and a
webview (browser sandbox). It processes:

- **`.chat` files** (JSON) and the ordered **`.md`** system-prompt layers they reference, from the workspace.
- **User configuration** (API keys, backend URLs).
- **Tools** (per-chat opt-in): the workspace filesystem, `web_fetch`, and **MCP** servers defined
  in `.mcp.json` / `.mcp/*.json` in the repo.
- **TTS models/binaries (Piper, Chatterbox)** and the **Ollama binary** downloaded from Hugging Face,
  GitHub and PyPI. Chatterbox builds a **reference voice** by trimming a short fragment of a **local
  audio/video file** the user picks (ffmpeg) — no network/URL fetch.

Trusted: VS Code, the user-configured LLM provider, and (with Workspace Trust) the workspace
content. **Not** trusted: remote content read by the model (web pages via `web_fetch`, untrusted
files) or repositories opened without trust.

## Threat model and mitigations

| Threat | Mitigation |
|---|---|
| **RCE when opening a malicious repo** (a `.mcp.json` that `spawn`s a command) | MCP servers **only start in a trusted Workspace** (`vscode.workspace.isTrusted`). `package.json` declares `capabilities.untrustedWorkspaces: limited`. |
| **SSRF** via `web_fetch` (hitting `localhost`, private IPs, `169.254.169.254`) | DNS is resolved and loopback/private/CGNAT/link-local/ULA addresses are **rejected** (IPv4 and IPv6). Redirects are **followed manually, validating each hop's host**. |
| **Dangerous write** (model writes to `.git/hooks`, `.vscode/` → execution) | The write tools (`fs_write`, `fs_edit`, `fs_delete`, `fs_move`) deny sensitive paths (`.git/`, `.vscode/`, `.mcp.json`, `.mcp/`), **require Workspace Trust**, and stay confined to the workspace (`realpath` symlink check); `fs_delete` also refuses a workspace root. |
| **Arbitrary code execution** (the `run_command` shell tool) | **On by default** (`jotflow.tools.shell`), but gated like a coding agent: it runs **only in a trusted Workspace**, and **each command requires an in-chat confirmation card** (`jotflow.tools.shellAutoApprove` opts out, with a documented warning); set `jotflow.tools.shell: false` to remove it entirely. Output is capped; the process is tree-killed on timeout (60 s) or Stop. |
| **Unexpected interpreter execution** (a `python`/`py` resolved via `PATH` for the Piper TTS bootstrap) | The SHA-pinned standalone Python is tried first; the **system-Python fallback runs only in a trusted Workspace** — spawning a PATH-resolved interpreter is command execution, so it follows the same Trust gate as the tools. |
| **API key over plaintext / malformed backend URL** | Every configured `baseUrl` is validated before use: malformed URLs and non-`http(s)` schemes (`file:`/`data:`/`javascript:`) are rejected, and attaching an API key over **plaintext `http` to a non-loopback host is refused** (key would travel in cleartext). Local `http` without a key (Ollama / LM Studio) stays allowed. |
| **Path traversal** in the system-prompt layers (reading an arbitrary file into the system prompt) | Each `systemPromptFiles` layer path is **confined to the workspace folders** (the `.chat`'s folder or any workspace root); `../`-style traversal outside the workspace is rejected **per layer**, both when assembling the prompt for the model (`readSystemPrompt`/`resolveSystemPrompt`) and when opening a layer (`openSysPrompt`). The **path/glob refresh** (`resolveSysPromptGlob`) resolves via `findFiles` (workspace-scoped) and **filters every match through the same allow-list** before it becomes a layer — and even a hand-edited out-of-bounds layer is still re-checked at send time. Out-of-workspace layers are **warned about at pick time** and **skipped** at send time; any missing/empty/skipped layer **warns visibly** instead of silently sending a degraded prompt. (The legacy single `systemPromptFile` is migrated into one layer on load.) |
| **Symlink escape** in the fs tools | `resolveInWorkspace` resolves the `realpath` of the existing ancestor and re-validates against the real root. |
| **Scratch dir escaping to the rest of the disk** (`temp_dir`) | The scratch dir is created with `mkdtempSync` (unique, unguessable name under the OS temp). The fs tools allow **only that one dir** plus the workspace folders — every path is still `realpath`-checked, so `..` can't reach the rest of `/tmp` or the system. Writing there still requires Workspace Trust; the dir is removed on dispose. |
| **XSS in the webview** | Strict CSP: `default-src 'none'; script-src 'nonce-…' 'strict-dynamic'` (no `unsafe-inline`/eval) blocks inline scripts and `javascript:`. Markdown escapes HTML and link `href`s use a scheme allowlist (`http`/`https`/`mailto`), with a leading-control-char guard so a prefixed `javascript:` can't slip through. `style-src` keeps `'unsafe-inline'` **only** for Mermaid's generated SVG (per-node `style=` attributes a nonce/hash can't authorize); the extension's own DOM no longer relies on it. Nonces use `crypto.randomBytes`. |
| **HTML injection in exported file** | The "Export to HTML/PDF" output escapes message content and attachment `mime`/`data`, so a hand-crafted `.attach` sidecar cannot inject markup into the exported file. |
| **API key leakage** | Keys go in **headers** (`Authorization`/`x-api-key`/`X-goog-api-key`), never in the URL, so they do not appear in errors or logs. Each key is bound to its provider's endpoint and the webview never receives them. A key is **never sent over plaintext `http` to a non-loopback host** (see the URL-validation row). Keys are stored **only** in **VS Code SecretStorage** (`Set API Key`) — the former plaintext `settings.json` path was removed (it would sync in the clear). |
| **Ollama Cloud API key** | Stored **only** in **SecretStorage** (`Set API Key` → *Ollama (cloud)*). It is passed **only** as the `OLLAMA_API_KEY` environment variable to the **loopback** managed `ollama serve` so the local server can proxy cloud models — the extension never sends it over the network itself and never exposes it to the webview. |
| **Supply chain (Piper models)** | **Pinned** SHA256 for each curated `.onnx`; verified after download (mismatch → delete + error). **Fails closed**: an asset without a pinned hash is rejected, not used. |
| **Supply chain (Piper standalone binary)** | **Pinned** SHA256 for each GitHub tarball; verified before extract/exec. **Fails closed**. |
| **Supply chain (self-contained Python)** | **Pinned** SHA256 for each `python-build-standalone` build; verified before extract. **Fails closed**. |
| **Supply chain (Ollama binary)** | **Pinned** SHA256 for each GitHub release asset (from the `digest` field); verified **before extract/exec**. **Fails closed** (asset without a hash → error). |
| **Managed Ollama server** | Listens **only on `127.0.0.1`** (ephemeral or configured port); child process is managed and killed on deactivation. The API is not exposed to the network. |
| **Model download (HF/Ollama)** | Search and `pull` go through `httpFetch` (inherited proxy + anti-SSRF). Size and free space are shown and **confirmation** is requested before downloading. |
| **Untrusted model-catalog content (ollama.com)** | The Ollama model explorer scrapes ollama.com (search / tags / model pages) over a **fixed host** with `encodeURIComponent`-encoded path & query (no user-controlled host → no SSRF), via `httpFetch` with a timeout. Scraped names/metadata are **HTML-escaped** before display; the README is **tag-stripped → re-rendered to a limited Markdown/HTML subset → a DOM-allowlist `sanitizeHtml`** (parsed in an inert `<template>`; only known-safe tags/attributes kept — not a regex denylist), with the panel's strict CSP (`script-src 'nonce-…'`, no `unsafe-inline`) as the backstop. |
| **Untrusted attachment bytes (images)** | Image attachments (base64 from a possibly hand-crafted `.attach`) are shown via a **`Blob` object URL** (`URL.createObjectURL`, revoked on load), **not** a `data:` URL built by concatenating the `mime`/`data` — so untrusted bytes never reach a URL string sink. The `mime` is validated as `image/…` and the payload as base64 (`setImageSrc`). |
| **Supply chain (pip package)** | `piper-tts` is installed at a **pinned version** (`==1.4.2`); pip verifies its hash against the PyPI index (immutable files). |
| **Voice-sample source** (Chatterbox) | The reference clip is a **local file the user picks** via the native dialog — there is **no URL fetch / network download** at all (so no SSRF surface). The host validates the time range (start<end, duration ≤ 30 s) and the safe voice id, and trims with ffmpeg spawned as an **argv array, never a shell**. The user's source file is never modified. |
| **RCE via ffmpeg / Python** (Chatterbox) | Spawning these interpreters is command execution → the bundled Python is tried first (SHA-pinned); the system-Python fallback and all engine spawns run **only in a trusted Workspace** (same gate as Piper and the tools). |
| **Supply chain (Chatterbox pip packages)** | The TTS lib is installed at a **pinned version** (`==`): `mlx-audio` on Apple Silicon (the fast MLX backend, no PyTorch), `chatterbox-tts` elsewhere. `imageio-ffmpeg` (bundles a static ffmpeg) is also pinned, so ffmpeg needs **no hand-pinned binary hash** — same posture as `piper-tts`. |
| **Chatterbox synthesis daemon** | Loads the model once and listens **only on `127.0.0.1`** (ephemeral port); the child process is managed and **killed on deactivate**. Not exposed to the network. (MLX's Metal stream is thread-local, so the daemon is single-threaded.) |
| **Model weights (Hugging Face)** | Downloaded into the extension's storage (`HF_HOME` pointed at globalStorage): a **4-bit multilingual MLX** model on Apple Silicon, the `chatterbox-tts` weights elsewhere. Reused offline after the first load (a marker gates a no-network start). See residual risks below. |

## Accepted residual risks

- **Prompt injection → tool abuse.** If the model processes untrusted content (a web page via
  `web_fetch`, a file) it can be steered into reading workspace files and exfiltrating them (e.g.
  `web_fetch` with data in the query) or writing files. This is **inherent to agentic tools**.
  Mitigations: tools are **per-chat opt-in**, `fs_write` has a denylist + Trust, and `web_fetch`
  cannot reach the internal network. The user must assume that enabling tools = the model can
  read/write the workspace and make outbound network requests.
- **Full pip dependency pinning (`--require-hashes`) NOT implemented.** It would cover PyPI
  serving bytes that differ from its index hash, or a transitive dep compromised in an
  already-published version — a marginal risk. The cost (a lockfile with SHA256 of every dep —
  onnxruntime, numpy… — per platform and Python version, regenerated by hand) is not worth it for
  this tool. The **pinned version** already covers the realistic vectors.
- **Uncurated Piper voices.** If the user points `jotflow.tts.piperModel` at their own `.onnx`,
  its checksum is not verified (it is the user's choice).
- **Uncurated Chatterbox reference clips.** A clip the user creates from a local file is not
  hash-verified — it is, by design, their own sample. The user is responsible for having the rights
  to clone the voice; the create-voice form warns about this.
- **Chatterbox model weights are not SHA-pinned.** The TTS lib (`mlx-audio` on Apple Silicon,
  `chatterbox-tts` elsewhere) resolves and downloads its own weights from Hugging Face via
  `huggingface_hub` — for MLX, a fixed 4-bit model repo. We pin the **package** version and confine
  the cache to globalStorage, but do not pin each weight file's hash — the same accepted trade-off as
  "full pip dependency pinning NOT implemented" above.
- **Neural watermark (PerTh).** Audio generated by Chatterbox carries Resemble AI's inaudible
  watermark by design; this is a property of the upstream model, noted for transparency.

## Static analysis (CodeQL)

The repository runs **GitHub CodeQL code scanning** on every push to `master`; its JS/TS security
queries are kept at **0 open alerts**. Recurring pitfalls it surfaced — and the patterns we use to
avoid them in new code — are codified as rules **U7–U12 / W7** in [BEST-PRACTICES.md](BEST-PRACTICES.md):

- **`js/incomplete-multi-character-sanitization`** → sanitize untrusted HTML with a **DOM allowlist**
  (inert `<template>` + safe tag/attr list), not a single-pass regex denylist.
- **`js/bad-tag-filter`** → tag-matching regexes tolerate whitespace/attributes in close tags (`</script[^>]*>`).
- **`js/xss-through-dom` / `js/client-side-unvalidated-url-redirection`** → untrusted bytes reach media
  via a **`Blob` object URL**, never a concatenated `data:` URL.
- **`js/double-escaping`** → decode `&amp;` **last**. **`js/identity-replacement`** → no `replace(X, X)`;
  escape to a literal (`'\\u2028'`). **`js/xss`** → `escapeHtml()` every value before `innerHTML`.

## How to report a vulnerability

Open a private issue / contact the maintainer (see `package.json` → `bugs`). Do not publish
exploitable details until a fix is available.
