# Lang Chat

**Chat with local (and remote) LLMs right inside VS Code — LM Studio style.** Bring your own
models and keys, keep every conversation as a versionable file, and use tools, embedded model
management and neural text‑to‑speech without leaving the editor.

![Lang Chat in action](https://raw.githubusercontent.com/enavarre-cl/langchat/master/media/vid1.gif)

## Why Lang Chat

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
| ![Lang Chat sidebar](https://raw.githubusercontent.com/enavarre-cl/langchat/master/media/img3.png) | ![Reasoning and Tools panels](https://raw.githubusercontent.com/enavarre-cl/langchat/master/media/img2.png) |
| **Per‑conversation settings (⚙)** — backend, model, sampling, read‑aloud | **Lang Chat settings** in VS Code |
| ![Per-conversation settings panel](https://raw.githubusercontent.com/enavarre-cl/langchat/master/media/img1.png) | ![Lang Chat settings in VS Code](https://raw.githubusercontent.com/enavarre-cl/langchat/master/media/img4.png) |

- 💬 **Streaming** responses, token by token, with a **Stop** button and auto‑save after each turn.
- 🧠 **Reasoning / thinking** panel for models that expose it.
- 🦙 **Embedded Ollama** + **Hugging Face GGUF explorer**: capability badges, quantization options
  and **downloads with progress** (shows size and free disk space first; retry/cancel).
- 🔧 **Tools (function calling)**: native **workspace filesystem** + **MCP servers** — agentic loop.
- 🗣️ **Read aloud (TTS)**: system voices (Web Speech) or neural **Piper** (local, managed daemon).
- 🔎 **Search in chat** (`Ctrl/Cmd+F`), 🔍 **zoom** (`Alt`/`Option` + wheel), 🌳 **fork**,
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

1. Install **Lang Chat** from the Marketplace.
2. Command palette (`Cmd/Ctrl+Shift+P`) → **“Lang Chat: New chat”** → choose where to save the
   `.chat` file.
3. Pick a backend in the ⚙ panel and start chatting.

> Have **LM Studio** (local server enabled) or **Ollama** running first — or use a hosted backend
> (OpenRouter / Gemini / Anthropic) with an API key.
>
> API keys are best stored securely: run **“Lang Chat: Set API Key (secure)”** to keep them in VS
> Code SecretStorage instead of plain settings.

## Local models (embedded Ollama)

Lang Chat can manage its **own Ollama server** without you installing anything:

- The **Lang Chat** sidebar groups everything into sections: **Engines** (Ollama / Piper, with
  run/stop/install), **Models** (local models + downloads), **Voices** and **Dictionary**.
- The **＋** button opens an **LM Studio‑style explorer**: searches **GGUF** models on Hugging
  Face, shows capability badges and quantization options, and **downloads with progress**.
- On first use it downloads the Ollama binary (SHA256‑verified, fail‑closed) into your global
  storage; the server runs only on `127.0.0.1`. Configure under *Settings → Lang Chat → Ollama*.

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

> MCP servers and `fs_write` only run in a **trusted workspace**.

## Privacy

- Your **API keys** can be stored in VS Code **SecretStorage** (not plain settings).
- The managed Ollama server and the Piper TTS daemon bind to **`127.0.0.1`** only.
- **No telemetry** — Lang Chat does not phone home. Network traffic goes only to the LLM backend
  you configure and, on demand, to Hugging Face / PyPI to download models and the TTS engine.

## Configuration

Settings under `Settings → Lang Chat`:

| Setting | Default | Description |
| --- | --- | --- |
| `langChat.provider` | `openai` | Default backend: `openai`, `ollama`, `openrouter`, `gemini` or `anthropic` |
| `langChat.language` | `auto` | UI language: `auto`, `en`, `es`, `pt`, `fr`, `de`, `it` |
| `langChat.openai.baseUrl` | `http://localhost:1234/v1` | OpenAI‑compatible endpoint |
| `langChat.openai.apiKey` | _(empty)_ | Optional API key |
| `langChat.ollama.baseUrl` | `http://localhost:11434` | Ollama server URL (used when `managed` is off) |
| `langChat.ollama.managed` | `true` | Use the extension's own downloaded Ollama server |
| `langChat.ollama.port` | `0` | Managed server port (`0` = pick a free one) |
| `langChat.ollama.modelsPath` | _(empty)_ | Optional `OLLAMA_MODELS` path |
| `langChat.ollama.maxConcurrentDownloads` | `2` | Parallel model downloads |
| `langChat.openrouter.baseUrl` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `langChat.openrouter.apiKey` | _(empty)_ | OpenRouter API key |
| `langChat.openrouter.vendors` | _(empty)_ | Filter OpenRouter models by vendor (prefix before `/`) |
| `langChat.openrouter.customModels` | _(empty)_ | Extra model ids to add even if the API doesn't list them |
| `langChat.openrouter.sort` | _(default)_ | Provider routing preference (`throughput` / `latency` / `price`) |
| `langChat.gemini.apiKey` | _(empty)_ | Google Gemini API key (Google AI Studio) |
| `langChat.gemini.baseUrl` | `https://generativelanguage.googleapis.com/v1beta` | Generative Language API endpoint |
| `langChat.anthropic.apiKey` | _(empty)_ | Anthropic Claude API key (console.anthropic.com) |
| `langChat.anthropic.baseUrl` | `https://api.anthropic.com/v1` | Anthropic Messages API endpoint |
| `langChat.temperature` | `0.7` | Sampling temperature |
| `langChat.maxTokens` | `2048` | Max tokens (`-1` = unlimited) |

## Third‑party components & licenses

Lang Chat is **MIT** licensed. It bundles or downloads third‑party components under their own terms:

| Component | When | License |
| --- | --- | --- |
| Hunspell dictionaries (`media/dict/{en,es,pt,fr,de,it}.*`) | bundled | each under its own license (see the matching `media/dict/<lang>.LICENSE`) |
| [`nspell`](https://github.com/wooorm/nspell) | bundled (spell engine) | MIT |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`) | **downloaded at runtime** for neural TTS | **GPL** |
| [Ollama](https://ollama.com) | **downloaded at runtime** (managed server) | MIT |
| Python (astral‑sh build‑standalone) | downloaded at runtime (for Piper) | PSF / per upstream |

> The neural TTS engine (Piper) is GPL and is fetched on demand from PyPI; it is **not** shipped
> inside the extension package.

## Contributing

See [ARCHITECTURE.md](ARCHITECTURE.md) for a tour of the codebase (extension host ↔ webviews,
providers, the agentic loop, local engines, i18n and security) with diagrams.

## License

Released under the MIT License.
