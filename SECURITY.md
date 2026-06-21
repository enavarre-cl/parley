# Security — Parley

This document describes the extension's threat model, the mitigations implemented, and the
accepted residual risks.

## Scope and trust

Parley is an LLM chat editor inside VS Code. It runs in the extension host (Node) and a
webview (browser sandbox). It processes:

- **`.chat` files** (JSON) and the **`.md`** system-prompt files they reference, from the workspace.
- **User configuration** (API keys, backend URLs).
- **Tools** (per-chat opt-in): the workspace filesystem, `web_fetch`, and **MCP** servers defined
  in `.mcp.json` / `.mcp/*.json` in the repo.
- **TTS models/binaries (Piper)** and the **Ollama binary** downloaded from Hugging Face and GitHub.

Trusted: VS Code, the user-configured LLM provider, and (with Workspace Trust) the workspace
content. **Not** trusted: remote content read by the model (web pages via `web_fetch`, untrusted
files) or repositories opened without trust.

## Threat model and mitigations

| Threat | Mitigation |
|---|---|
| **RCE when opening a malicious repo** (a `.mcp.json` that `spawn`s a command) | MCP servers **only start in a trusted Workspace** (`vscode.workspace.isTrusted`). `package.json` declares `capabilities.untrustedWorkspaces: limited`. |
| **SSRF** via `web_fetch` (hitting `localhost`, private IPs, `169.254.169.254`) | DNS is resolved and loopback/private/CGNAT/link-local/ULA addresses are **rejected** (IPv4 and IPv6). Redirects are **followed manually, validating each hop's host**. |
| **Dangerous write** (model writes to `.git/hooks`, `.vscode/` → execution) | `fs_write` denies sensitive paths (`.git/`, `.vscode/`) and **requires Workspace Trust**. |
| **Path traversal** in `systemPromptFile` (reading an arbitrary file into the system prompt) | The path is **confined to the workspace folders** (the `.chat`'s folder or any workspace root); `../`-style traversal outside the workspace is rejected, both when resolving it for the model (`resolveSystemPrompt`) and when opening it (`openSysPrompt`). A missing/empty/out-of-bounds reference **warns visibly** instead of silently using the inline prompt. |
| **Symlink escape** in the fs tools | `resolveInWorkspace` resolves the `realpath` of the existing ancestor and re-validates against the real root. |
| **XSS in the webview** | Strict CSP: `default-src 'none'; script-src 'nonce-…'` (no `unsafe-inline`) blocks inline scripts and `javascript:`. Markdown escapes HTML and link `href`s use a scheme allowlist (`http`/`https`/`mailto`). Nonces use `crypto.randomBytes`. |
| **HTML injection in exported file** | The "Export to HTML/PDF" output escapes message content and attachment `mime`/`data`, so a hand-crafted `.attach` sidecar cannot inject markup into the exported file. |
| **API key leakage** | Keys go in **headers** (`Authorization`/`x-api-key`/`X-goog-api-key`), never in the URL, so they do not appear in errors or logs. Each key is bound to its provider's endpoint and the webview never receives them. Keys can be stored in **VS Code SecretStorage** (`Set API Key (secure)`). |
| **Supply chain (Piper models)** | **Pinned** SHA256 for each curated `.onnx`; verified after download (mismatch → delete + error). **Fails closed**: an asset without a pinned hash is rejected, not used. |
| **Supply chain (Piper standalone binary)** | **Pinned** SHA256 for each GitHub tarball; verified before extract/exec. **Fails closed**. |
| **Supply chain (self-contained Python)** | **Pinned** SHA256 for each `python-build-standalone` build; verified before extract. **Fails closed**. |
| **Supply chain (Ollama binary)** | **Pinned** SHA256 for each GitHub release asset (from the `digest` field); verified **before extract/exec**. **Fails closed** (asset without a hash → error). |
| **Managed Ollama server** | Listens **only on `127.0.0.1`** (ephemeral or configured port); child process is managed and killed on deactivation. The API is not exposed to the network. |
| **Model download (HF/Ollama)** | Search and `pull` go through `httpFetch` (inherited proxy + anti-SSRF). Size and free space are shown and **confirmation** is requested before downloading. |
| **Supply chain (pip package)** | `piper-tts` is installed at a **pinned version** (`==1.4.2`); pip verifies its hash against the PyPI index (immutable files). |

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
- **Uncurated Piper voices.** If the user points `parley.tts.piperModel` at their own `.onnx`,
  its checksum is not verified (it is the user's choice).

## How to report a vulnerability

Open a private issue / contact the maintainer (see `package.json` → `bugs`). Do not publish
exploitable details until a fix is available.
