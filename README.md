# Jotflow

**Chat with local (and remote) LLMs right inside VS Code — LM Studio style.** Bring your own
models and keys, keep every conversation as a versionable file, and use tools, embedded model
management and neural text‑to‑speech without leaving the editor.

![Jotflow in action](https://raw.githubusercontent.com/enavarre-cl/jotflow/master/media/vid1.gif)

## Why Jotflow

- 🔒 **Local‑first & private** — runs against your own LLM (LM Studio, Ollama…), your keys live in
  VS Code SecretStorage, the managed server binds to `127.0.0.1`, and there is **no telemetry**.
- 🧩 **Five backends, one UI** — OpenAI‑compatible, Ollama, OpenRouter, Google Gemini and
  Anthropic Claude, switchable per conversation.
- 📄 **Conversations as files** — each chat is a human‑readable `.chat` (config + history) you can
  diff, version and share.
- 🦙 **Models, batteries included** — manage an embedded Ollama and browse/download GGUF models
  from Hugging Face without installing anything.
- 🔧 **Agentic tools** — workspace filesystem + MCP servers (function calling) on every backend.
- 🗣️ **Read aloud** — system voices or self‑contained neural **Piper** TTS.

## Features

| Sidebar — Engines · Models · Voices · Dictionary, with a `.chat` open | Chat with the **Reasoning** & **Tools** panels |
|:---:|:---:|
| ![Jotflow sidebar](https://raw.githubusercontent.com/enavarre-cl/jotflow/master/media/img3.png) | ![Reasoning and Tools panels](https://raw.githubusercontent.com/enavarre-cl/jotflow/master/media/img2.png) |
| **Per‑conversation settings (⚙)** — backend, model, sampling, read‑aloud | **Jotflow settings** in VS Code |
| ![Per-conversation settings panel](https://raw.githubusercontent.com/enavarre-cl/jotflow/master/media/img1.png) | ![Jotflow settings in VS Code](https://raw.githubusercontent.com/enavarre-cl/jotflow/master/media/img4.png) |

- 💬 **Streaming** responses, token by token, with a **Stop** button and auto‑save after each turn.
- 🧠 **Reasoning / thinking** panel for models that expose it.
- 📊 **Markdown + Mermaid** in chat bubbles: ` ```mermaid ` blocks render as diagrams with a
  GitHub‑style viewer — pan pad, zoom (pinch / `Ctrl`·`⌘`+wheel), **fullscreen** and **copy‑as‑image**.
  The library is lazy‑loaded only when a chat contains a diagram.
- 🦙 **Embedded Ollama** + **Hugging Face GGUF explorer**: capability badges, quantization options
  and **downloads with progress** (shows size and free disk space first; retry/cancel).
- 🔧 **Tools (function calling)**: native **workspace filesystem** + **MCP servers** — agentic loop.
- 🗣️ **Read aloud (TTS)**: system voices (Web Speech) or neural **Piper** (local, managed daemon).
- 🔎 **Find & replace in chat** (`Ctrl/Cmd+F` find · `Ctrl/Cmd+H` replace), 🔍 **zoom** (`Alt`/`Option` + wheel), 🌳 **fork**,
  🕓 **compare versions**, ♻️ **regenerate / continue / merge / edit / delete** messages.
- 🖼️ **Attachments** (images & documents) and **image generation** — image‑output models like
  Gemini *flash‑image* ("nano‑banana") render their images inline (copy / save to disk).
- 📎 **`@file` mentions** in the composer: type `@`, pick a workspace file, insert its full path.
- 🧾 **Export** to standalone HTML / PDF.
- 🧮 **Context management**: auto‑summarize when context fills up, or send only the last *N*
  messages — both shown visually in the chat.
- 🌍 **6 languages** (UI, spell‑check and TTS): English, Spanish, Portuguese, French, German,
  Italian — switchable live, with a personal spell‑check dictionary per language.

## Backends

Configure any of these per conversation (in the ⚙ panel) or as the default in Settings:

| Backend | Endpoint / notes |
| --- | --- |
| **OpenAI‑compatible** | LM Studio, llama.cpp server, vLLM, LocalAI… (default `http://localhost:1234/v1`) |
| **Ollama** | A local Ollama server (`http://localhost:11434`) **or the extension's own managed server** |
| **OpenRouter** | Hosted models via `https://openrouter.ai/api/v1` |
| **Google Gemini** | Generative Language API |
| **Anthropic Claude** | Messages API |

## Quick start

1. Install **Jotflow** from the Marketplace.
2. Command palette (`Cmd/Ctrl+Shift+P`) → **“Jotflow: New chat”** → choose where to save the
   `.chat` file.
3. Pick a backend in the ⚙ panel and start chatting.

> Have **LM Studio** (local server enabled) or **Ollama** running first — or use a hosted backend
> (OpenRouter / Gemini / Anthropic) with an API key.
>
> API keys are best stored securely: run **“Jotflow: Set API Key (secure)”** to keep them in VS
> Code SecretStorage instead of plain settings.

## Local models (embedded Ollama)

Jotflow can manage its **own Ollama server** without you installing anything:

- The **Jotflow** sidebar groups everything into sections: **Engines** (Ollama / Piper, with
  run/stop/install), **Models** (local models + downloads), **Voices** and **Dictionary**.
- The **＋** button opens an **LM Studio‑style explorer**: searches **GGUF** models on Hugging
  Face, shows capability badges and quantization options, and **downloads with progress**.
- On first use it downloads the Ollama binary (SHA256‑verified, fail‑closed) into your global
  storage; the server runs only on `127.0.0.1`. Configure under *Settings → Jotflow → Ollama*.

## `.chat` files

Each conversation is a **`.chat`** file (human‑readable JSON) storing the **inference config + full
history**. Opening it shows the chat UI; everything is persisted in the file, so it is
git‑versionable. A `.chat` may reference its system prompt from an external **`.md`** file
(`systemPromptFile`, confined to the `.chat`'s directory).

## Tools (function calling)

With **Tools** on (⚙, available on every backend), the model can call tools in an agentic loop:

- **Workspace filesystem & helpers** (native, no setup): `fs_list`, `fs_read`, `fs_write`,
  `fs_glob`, `fs_search`, plus `editor_context`, `web_fetch` and `get_datetime`. File tools are
  **confined to the workspace folder** (resolved + `realpath`‑checked against symlink escape).
- **MCP servers**: define them in a **`.mcp/`** folder (one `*.json` per server) or a **`.mcp.json`**
  at the workspace root. Each server's tools are exposed as `server__tool`.

The loop runs up to `jotflow.tools.maxIterations` rounds per turn (default **8**; **`0` = unlimited**,
ending only when the model stops requesting tools or you press Stop).

> MCP servers and `fs_write` only run in a **trusted workspace**. Enabling **Tools** (⚙) in an
> untrusted folder prompts you to **Manage Trust** up front, so tools don't fail mid-turn.

## Privacy

- Your **API keys** can be stored in VS Code **SecretStorage** (not plain settings).
- The managed Ollama server and the Piper TTS daemon bind to **`127.0.0.1`** only.
- **No telemetry** — Jotflow does not phone home. Network traffic goes only to the LLM backend
  you configure and, on demand, to Hugging Face / PyPI to download models and the TTS engine.

## Configuration

Settings under `Settings → Jotflow`:

| Setting | Default | Description |
| --- | --- | --- |
| `jotflow.provider` | `openai` | Default backend: `openai`, `ollama`, `openrouter`, `gemini` or `anthropic` |
| `jotflow.language` | `auto` | UI language: `auto`, `en`, `es`, `pt`, `fr`, `de`, `it` |
| `jotflow.openai.baseUrl` | `http://localhost:1234/v1` | OpenAI‑compatible endpoint |
| `jotflow.openai.apiKey` | _(empty)_ | Optional API key |
| `jotflow.ollama.baseUrl` | `http://localhost:11434` | Ollama server URL (used when `managed` is off) |
| `jotflow.ollama.managed` | `true` | Use the extension's own downloaded Ollama server |
| `jotflow.ollama.port` | `0` | Managed server port (`0` = pick a free one) |
| `jotflow.ollama.modelsPath` | _(empty)_ | Optional `OLLAMA_MODELS` path |
| `jotflow.ollama.maxConcurrentDownloads` | `2` | Parallel model downloads |
| `jotflow.openrouter.baseUrl` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `jotflow.openrouter.apiKey` | _(empty)_ | OpenRouter API key |
| `jotflow.openrouter.vendors` | _(empty)_ | Filter OpenRouter models by vendor (prefix before `/`) |
| `jotflow.openrouter.customModels` | _(empty)_ | Extra model ids to add even if the API doesn't list them |
| `jotflow.openrouter.sort` | _(default)_ | Provider routing preference (`throughput` / `latency` / `price`) |
| `jotflow.gemini.apiKey` | _(empty)_ | Google Gemini API key (Google AI Studio) |
| `jotflow.gemini.baseUrl` | `https://generativelanguage.googleapis.com/v1beta` | Generative Language API endpoint |
| `jotflow.anthropic.apiKey` | _(empty)_ | Anthropic Claude API key (console.anthropic.com) |
| `jotflow.anthropic.baseUrl` | `https://api.anthropic.com/v1` | Anthropic Messages API endpoint |
| `jotflow.temperature` | `0.7` | Sampling temperature |
| `jotflow.maxTokens` | `2048` | Max tokens (`-1` = unlimited) |
| `jotflow.tools.maxIterations` | `8` | Max agentic tool-loop rounds per turn (`0` = unlimited) |
| `jotflow.tools.maxReadBytes` | `100000` | Max bytes returned by the native `fs_read` tool (`0` = unlimited) |

## Third‑party components & licenses

Jotflow is **MIT** licensed. It bundles or downloads third‑party components under their own terms:

| Component | When | License |
| --- | --- | --- |
| Hunspell dictionaries (`media/dict/{en,es,pt,fr,de,it}.*`) | bundled | each under its own license (see the matching `media/dict/<lang>.LICENSE`) |
| [`nspell`](https://github.com/wooorm/nspell) | bundled (spell engine) | MIT |
| [Mermaid](https://github.com/mermaid-js/mermaid) (`media/mermaid.min.js`) | bundled (diagram rendering, lazy‑loaded) | MIT |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`) | **downloaded at runtime** for neural TTS | **GPL** |
| [Ollama](https://ollama.com) | **downloaded at runtime** (managed server) | MIT |
| Python (astral‑sh build‑standalone) | downloaded at runtime (for Piper) | PSF / per upstream |

> The neural TTS engine (Piper) is GPL and is fetched on demand from PyPI; it is **not** shipped
> inside the extension package.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the release history. **2.0.0** is the rebrand from Parley to
Jotflow (no functional change; the major bump reflects the new identity and extension ID). The
preceding quality passes against [BEST-PRACTICES.md](BEST-PRACTICES.md) still apply: **1.6.0 / 1.6.1**
closed a security + reliability audit, and **1.6.2** is a best-practices conformance pass over every
source file (module sizes, linting, test coverage) with no behavior change.

## Contributing

See [ARCHITECTURE.md](ARCHITECTURE.md) for a tour of the codebase (extension host ↔ webviews,
providers, the agentic loop, local engines, i18n and security) with diagrams.
Development conventions are in [BEST-PRACTICES.md](BEST-PRACTICES.md).

## License

Released under the MIT License.
