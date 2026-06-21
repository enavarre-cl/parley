# Parley — Architecture

A VS Code extension that turns a `.chat` file into a full chat editor for LLMs, with
pluggable backends (LM Studio / OpenAI-compatible, Ollama, Google Gemini, Anthropic,
OpenRouter), local model & voice management (Ollama + Piper TTS), an agentic tool loop
(built-in filesystem tools + MCP servers), live spell-check, multi-language UI, and
neural text-to-speech.

> Conventions: **English is the source language** for code and these docs. User-facing
> strings are English keys translated via `package.nls.<lang>.json` bundles.

---

## 1. The big picture

Everything runs in two worlds that talk over `postMessage`:

- **Extension host** (Node.js, `src/**`): owns the document, the network, processes
  (Ollama, Piper, MCP), secrets, and the filesystem.
- **Webviews** (browser sandbox, `media/**`): render the chat UI and the model browser.
  They have **no** filesystem/network access of their own — they ask the host.

```mermaid
graph TB
  subgraph Host["Extension host — Node (src/**)"]
    EXT["extension.ts<br/>activate · ChatEditorProvider · commands"]
    PROV["providers/**<br/>LLM abstraction"]
    TOOLS["tools.ts + mcp.ts<br/>built-in tools · MCP client"]
    OLL["ollama/**<br/>managed server · downloads"]
    PIP["piper/manager.ts<br/>neural TTS"]
    DOC["chatDocument.ts<br/>.chat parse/serialize"]
    SEC["SecretStorage<br/>API keys"]
  end

  subgraph Web["Webviews — sandbox (media/**)"]
    MAIN["main.js + style.css<br/>chat editor UI"]
    MODELS["models.js<br/>HF model browser"]
    SPELL["spell.js + spell-engine.js<br/>nspell"]
    I18N["i18n.js<br/>UI translation"]
  end

  subgraph Ext["External"]
    LLM["LLM APIs<br/>OpenAI/Ollama/Gemini/Anthropic/OpenRouter"]
    HF["Hugging Face<br/>GGUF models · Piper voices"]
    MCPSRV["MCP servers<br/>(.mcp.json, stdio)"]
  end

  MAIN <-- postMessage --> EXT
  MODELS <-- postMessage --> EXT
  EXT --> DOC
  EXT --> PROV --> LLM
  EXT --> TOOLS --> MCPSRV
  EXT --> OLL --> HF
  EXT --> PIP --> HF
  EXT --> SEC
  MODELS -. "search/download via host" .-> EXT
```

---

## 2. Module map

```mermaid
graph LR
  subgraph entry["Entry / orchestration"]
    extension["extension.ts<br/>(1.9k LoC)"]
  end
  subgraph chat["Chat document"]
    chatDocument["chatDocument.ts"]
  end
  subgraph prov["providers/ — LLM strategy"]
    types["types.ts (interfaces)"]
    index["index.ts (factory)"]
    openai["openai.ts (+ OpenRouter)"]
    gemini["gemini.ts"]
    anthropic["anthropic.ts"]
    ollamaP["ollama.ts"]
    helpers["think.ts · stream.ts · multimodal.ts · httpError.ts"]
  end
  subgraph agent["Agentic tools"]
    toolsTs["tools.ts (built-ins)"]
    mcp["mcp.ts (MCP client)"]
  end
  subgraph ollamaSub["ollama/ — local models"]
    omanager["manager.ts (server lifecycle)"]
    oassets["assets.ts (pinned binary)"]
    oreg["registry.ts (/api)"]
    ocat["catalog.ts (HF search)"]
    odl["downloads.ts (queue)"]
    oparse["parse.ts (pure)"]
  end
  subgraph tts["TTS"]
    piper["piper/manager.ts"]
  end
  subgraph ui["Sidebar & panels"]
    views["modelsView.ts (TreeViews)"]
    mpanel["modelsPanel.ts (browser)"]
    vpanel["voicesPanel.ts"]
    dpanel["dictionaryPanel.ts"]
    compare["compareView.ts"]
  end
  subgraph infra["Cross-cutting"]
    i18nTs["i18n.ts"]
    httpTs["http.ts (proxy)"]
    spell["spellWords.ts"]
    utils["download.ts · net.ts · audio.ts"]
  end

  extension --> chatDocument
  extension --> index --> openai & gemini & anthropic & ollamaP
  index --> types
  extension --> toolsTs --> mcp
  extension --> omanager & odl & ocat
  extension --> piper
  extension --> views & mpanel & vpanel & dpanel & compare
  extension --> i18nTs & spell
  openai & gemini & ocat --> httpTs
```

**Pure, testable cores** (no VS Code / no network, unit-tested in `src/test/`):
`ollama/parse.ts`, `ollama/assets.ts`, `providers/multimodal.ts`, `net.ts`, `audio.ts`,
`download.ts`.

---

## 3. The chat document

A chat is a **`.chat` file** (JSON) opened by a `CustomTextEditorProvider`. The file is the
single source of truth; the webview is a projection of it.

- **`<name>.chat`** — JSON: provider, model, params, system prompt (inline or a referenced
  file), messages (role/content/thinking/variants/attachments-as-refs), and the context
  summary. Parsed/serialized by `chatDocument.ts`.
- **`<name>.attach`** — sidecar holding attachment **blobs** (base64 images/docs) keyed by id.
  Messages store only `{kind,name,mime,ref}`; blobs are resolved for the webview and pruned
  when no longer referenced (incl. inside variants).

```mermaid
graph LR
  CHAT["foo.chat (JSON)<br/>messages → attachment refs"] -- "ref id" --> ATTACH["foo.attach (sidecar)<br/>id → base64 blob"]
  DOC["ChatDoc (in memory)"] -- "serializeDoc" --> CHAT
  CHAT -- "parseDoc" --> DOC
  DOC -- "resolveDocForView<br/>(resolve refs)" --> WV["webview history"]
```

Edits go through a `WorkspaceEdit` that replaces the whole text (`writeDoc`). VS Code's
text **undo/redo is neutralized** for `.chat` (it would step through the many internal
writes of a turn) — the chat owns its own history via delete/edit/regenerate/fork.

Persistent state outside the document lives in **globalStorage**: the Ollama binary,
downloaded Piper voices, `spell-words.json`, the download queue, and local-model cards.

---

## 4. Providers — the LLM abstraction

All backends implement one interface; `buildProvider()` is the factory. Each provider maps
the generic `ChatMessage[]` to its wire format, streams the response, and returns a
normalized `ChatResult` (`answer`, `thinking`, `toolCalls`, `usage`, `images`).

```mermaid
classDiagram
  class LLMProvider {
    <<interface>>
    +listModels() ModelInfo[]
    +chat(model, messages, params, cb) ChatResult
  }
  class StreamCallbacks {
    +onDelta(text)
    +onReasoning(text)
    +signal: AbortSignal
  }
  LLMProvider ..> StreamCallbacks
  LLMProvider <|.. OpenAIProvider
  LLMProvider <|.. GeminiProvider
  LLMProvider <|.. AnthropicProvider
  LLMProvider <|.. OllamaProvider
  note for OpenAIProvider "also serves OpenRouter (reasoning, top_a, provider sort, modalities)"
```

- **OpenAIProvider** — OpenAI-compatible (LM Studio, llama.cpp, vLLM…) **and** OpenRouter.
  Handles `<think>` splitting, `reasoning`/`reasoning_details`, tool-call accumulation, and
  image-output (`modalities`).
- **GeminiProvider** — Generative Language API; system → `systemInstruction`, image output
  via `responseModalities`.
- **AnthropicProvider** — Messages API; system extracted to the top-level `system`.
- **OllamaProvider** — native `/api/chat`.

Shared helpers: `think.ts` (reasoning splitter), `stream.ts` (NDJSON/SSE line reader with a
runaway-line cap), `multimodal.ts` (attachment + image-output detection), `httpError.ts`
(human error messages), `http.ts` (proxy-aware `fetch`).

---

## 5. Inference flow (the agentic loop)

```mermaid
sequenceDiagram
  participant W as Webview (main.js)
  participant H as handleSend (extension.ts)
  participant R as runInference
  participant P as Provider
  participant T as ToolHub
  participant LLM as LLM API

  W->>H: postMessage 'send' (text, attachments)
  H->>H: store attachments → .attach, push user msg, writeDoc
  H->>R: runInference(doc, messages, allowTools)
  R->>R: trim context (last-N / auto-summary)
  R->>R: resolveSystemPrompt (file or inline)
  R->>R: build wire = [system, summary?, history]
  loop agentic loop (≤ 8 iters, one AbortController)
    R->>P: chat(model, wire, params, callbacks)
    P->>LLM: stream request
    LLM-->>P: deltas (content / reasoning / tool_calls / images)
    P-->>W: streamDelta / streamReasoning
    P-->>R: ChatResult
    alt model requested tools
      R->>T: call(tool, args)
      T-->>R: result (fed back into wire)
    else done
      R->>R: break
    end
  end
  R-->>H: {answer, thinking, usage, images}
  H->>H: save assistant msg (+ image attachments), writeDoc
  H-->>W: history update
```

Context management before sending: **"last N messages"** (token-budget capped) **or**
**auto-summary** (compacts older turns into a running summary against the model window).

---

## 6. Tools & MCP

`ToolHub` aggregates **built-in tools** and **MCP server tools** into one schema list for the
provider's function-calling.

- **Built-in** (`tools.ts`): `fs_list`, `fs_read`, `fs_write`, `fs_glob`, `fs_search`,
  `get_datetime`, `web_fetch`, `editor_context`. File tools are **confined to the workspace**
  (resolved path must stay under a workspace folder, with `realpath` to defeat symlink
  escape). `fs_write` additionally requires a **trusted** workspace.
- **MCP** (`mcp.ts`): a minimal stdio JSON-RPC 2.0 client. Servers are declared in
  `.mcp.json` / `.mcp/*.json` and spawned **only in trusted workspaces** (a malicious repo's
  config would otherwise be RCE). Tools are namespaced `server__tool`.

```mermaid
graph TD
  LLMc["LLM function calling"] --> HUB["ToolHub.schemas() / call()"]
  HUB --> BUILTIN["Built-in tools<br/>fs_* (workspace-confined) · web_fetch · …"]
  HUB --> MCPMGR["McpManager"]
  MCPMGR -. "isTrusted? else disabled" .-> GATE{Workspace Trust}
  GATE -- trusted --> SPAWN["spawn .mcp servers (stdio)"]
  GATE -- untrusted --> OFF["MCP disabled"]
```

---

## 7. Local engines

### Ollama (managed local models)

`ollama/manager.ts` can run a **self-contained Ollama**: it downloads the pinned binary
(`assets.ts`, SHA-256 verified) into globalStorage and runs `serve` on a free port —
independent of any system install. `registry.ts` talks to `/api/*`; `catalog.ts` searches
Hugging Face for GGUF models; `downloads.ts` is a persistent, observable download queue.

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> downloading
  downloading --> done
  downloading --> error
  downloading --> cancelled
  downloading --> interrupted: VS Code closed
  error --> queued: retry
  interrupted --> queued: retry
```

Downloads run as a native `ollama pull` (with resume) or, when Hugging Face can't resolve the
`:quant` tag / the model is **split** into shards, fall back to downloading the `.gguf`(s) and
`ollama create` (import mode). A pre-flight probe and a runtime "400" backstop route broken
manifests to import automatically.

### Piper (neural TTS)

`piper/manager.ts` bootstraps a self-contained Python (or system Python), a venv with
`piper-tts[http]`, and runs an **HTTP daemon** so the model stays resident. Curated voices
(per language, SHA-256 pinned) download on demand into globalStorage. The chat streams
sentence chunks and plays the returned WAV.

---

## 8. Webviews

| Webview | Script | Role |
|---|---|---|
| Chat editor | `main.js` (+ `style.css`) | messages, composer, `@file` & emoji autocomplete, spell overlay, TTS, tooltips, two-step delete |
| Model browser | `models.js` (+ `models.css`) | search HF, pick quant, download |
| Voices / Dictionary / Compare | `voices.js` · `dictionary.js` · `compare.js` | small panels |
| Shared | `i18n.js` · `spell.js` + `spell-engine.js` · `zoom.js` | translation · nspell spell-check · zoom |

Spell-check runs **in the webview** (`nspell` + bundled hunspell dictionaries in `media/dict`),
drawing a wavy underline on a mirror "backdrop" behind the textarea. The model browser does the
HF search **through the host** (it has no network).

---

## 9. Internationalization

English is the key. Each language ships a `package.nls.<lang>.json` bundle (also VS Code's
manifest bundle). The **active** bundle is injected into webviews as `window.I18N_BUNDLE`; a
live language change re-pushes a fresh bundle so the UI re-translates without reload.
Supported: `en, es, pt, fr, de, it` (UI, spell-check, and Piper voices).

```mermaid
graph LR
  KEY["English string (key in code/HTML)"] --> TR["tr() / LangI18n.t()"]
  BUNDLE["package.nls.&lt;lang&gt;.json<br/>(active bundle)"] --> TR
  TR --> OUT["translated text"]
  SET["parley.language change"] -- "langChanged event → pushLang" --> BUNDLE
```

---

## 10. Security

- **Workspace Trust** is the gate for code execution: MCP servers and `fs_write` are disabled
  in untrusted workspaces (`untrustedWorkspaces: limited`).
- **Path confinement**: filesystem tools resolve and `realpath`-check every path against the
  workspace roots (blocks `../` and symlink escape).
- **API keys** live in **SecretStorage** (encrypted), entered via a masked input command, not
  in plaintext settings.
- **Network** goes through `http.ts` (respects `http.proxy` / env proxy). Binaries (Ollama,
  Piper, voices, GGUFs) are **SHA-256 verified** before use (fail-closed).

---

## 11. Build & packaging

- TypeScript (`src/**` → `out/**`) via `tsc`; ESLint; tests via `node:test` (`src/test/`).
- Webview assets (`media/**`) ship as-is.
- Packaged with `@vscode/vsce`; published from `master` by a **manual** GitHub Actions
  workflow (`.github/workflows/release.yml`) gated by a `marketplace` environment approval.
  The published version is `package.json`'s `version` (idempotent — re-publishing an existing
  version is a no-op).

---

## Where to start reading

1. `src/extension.ts` — `activate()`, the `ChatEditorProvider`, and `runInference` (the loop).
2. `src/providers/types.ts` + `index.ts` — the LLM abstraction.
3. `src/chatDocument.ts` — the `.chat` data model.
4. `media/main.js` — the chat webview.
