# Contributing to Jotflow

> New here? Read [ARCHITECTURE.md](ARCHITECTURE.md) first for a map of the codebase
> (extension host ↔ webviews, providers, the agentic loop, local engines, i18n, security).

## Develop & run

```bash
npm install
npm run dev            # host: tsc → out/ + esbuild → dist/extension.js  ·  webview: esbuild → media/dist/
```

Open the folder in VS Code and press **F5** (the “Run Extension” launch config). Its `preLaunchTask`
runs `npm run dev`, so F5 rebuilds **both** the host bundle (`dist/extension.js`, what VS Code loads)
and the webview bundles (`media/dist/*.js`). An *Extension Development Host* window opens with the
extension loaded. Create a chat from the command palette (`Cmd/Ctrl+Shift+P`) → **“Jotflow: New
chat”**, or open any file with the `.chat` extension.

> Reloading the dev host (**⌘R / Ctrl+R**) is required after changing `package.json` (commands,
> menus, views), the extension **host** code (`src/**`), or the **webview** module graph
> (`media/{app,core,render,ui,features,chat,panels}/**`) — anything that needs a rebuild. CSS and the
> standalone-panel scripts are served live, so a plain reload suffices for those.

## Webview build

The webview is **TypeScript** (`media/**/*.ts`), bundled by esbuild before it can run in the browser
sandbox (the browser runs JS, not TS):

- `scripts/build-webview.ts` (run via `tsx`, wired into `npm run dev` and `vscode:prepublish`) emits
  `media/dist/app.js` — the chat module graph — plus one IIFE bundle per classic global / standalone
  panel (`i18n`, `spell`, `models`, `modelsFormat`, `voices`, `compare`, `dictionary`, `engines`).
  esbuild resolves `.js` import specifiers to their `.ts` sources, so imports never need touching.
- The panels' HTML loads from `media/dist/`, which also holds `spell-engine.js` (the `nspell` engine
  bundled from npm). `media/dist/` is **git-ignored** (built on dev/publish).
- Type-checking is a **separate gate**: `tsc -p media/jsconfig.json` (the chat module graph). The only
  committed `.js` is the vendored `mermaid.min.js`; everything in `media/dist/` is generated output —
  none of it is source.

## Validation (run after changes)

```bash
npm run compile              # host: tsc → out/   (0 errors)
npm run lint                 # eslint src         (0 errors / 0 warnings)
tsc -p media/jsconfig.json   # webview: type-check the .ts module graph (0 errors)
npm run build:webview        # webview: esbuild → media/dist/*.js (valid bundle)
npm test                     # compile + node:test suite
```

For `package.json`: keep the `%nls%` placeholders in sync with `package.nls*.json`, and ensure
every menu command is declared in `contributes.commands`.

> **Typing convention:** both `src/` (host) and `media/**` (webview) are TypeScript and `any`-free.
> At a real boundary (a `JSON.parse` of external/file input, a VS Code command argument, an LLM API
> response, a `window.*` global injected by a classic script) type the value as `unknown` and narrow
> it, or give it a named interface (`Raw*` for parsed `.chat` data, a per-provider response shape, the
> ambient globals in `media/globals.d.ts`) — not `any`. Outbound objects the code *builds* must be
> fully typed.

## Adding a backend (provider)

Every backend implements one interface (`src/providers/types.ts`) and is wired through a small
factory. To add a provider `foo`:

1. **`src/providers/foo.ts`** — implement `LLMProvider`:
   ```ts
   class FooProvider implements LLMProvider {
     readonly id = 'foo';
     async listModels(): Promise<ModelInfo[]> { /* GET its /models */ }
     async chat(model, messages, params, cb): Promise<ChatResult> {
       // map ChatMessage[] → the API's format; stream the response calling
       // cb.onDelta(text) / cb.onReasoning(text); honour cb.signal (AbortSignal);
       // return { answer, thinking, toolCalls?, usage?, images? }.
     }
   }
   ```
   > If the API is **OpenAI-compatible**, skip the new file and reuse `OpenAIProvider`
   > (as OpenRouter does in `buildProvider`).

2. **`src/providers/index.ts`** — register it:
   - add `'foo'` to **`PROVIDER_IDS`** (this drives `ProviderId` + `isProviderId`);
   - add a branch in **`buildProvider()`**: wrap the configured base URL in
     **`validateBaseUrl(url, { hasKey })`** (rejects malformed/non-`http(s)` URLs and an API key over
     plaintext `http`) and construct with `resolveApiKey('foo')`;
   - add a branch in **`providerInfo()`** (`label`, `endpoint`, `needsKey`, `hasKey`).

3. **`src/extension.ts`** — if it needs an API key, add `{ id: 'foo', label: 'Foo' }` to
   **`KEY_PROVIDERS`** (SecretStorage entry + load), and add `<option value="foo">Foo</option>`
   to `#providerSelect` in the chat HTML.

4. **`package.json`** — add `foo` to the `jotflow.provider` enum and the
   `jotflow.foo.baseUrl` / `jotflow.foo.apiKey` settings (with `%nls%` keys).

5. **`package.nls.json`** (+ `es/pt/fr/de/it`) — the new setting/enum descriptions.

6. **(Optional)** gate provider-specific sampling params via the `only:` arrays in the settings
   schema in `media/panels/config.ts`.

Shared helpers worth reusing: `stream.ts` (NDJSON/SSE line reader), `think.ts` (reasoning
splitter), `multimodal.ts` (attachments + image-output), `httpError.ts` and `http.ts`
(proxy-aware `fetch`). See `ARCHITECTURE.md` §4.

## Spell‑check & language assets

Refresh the Hunspell dictionary **data** (`media/dict/<lang>.{aff,dic,LICENSE}` for
`en, es, pt, fr, de, it`) from the npm `dictionary-*` packages with:

```bash
npm run build:spell      # → tsx scripts/build-spell.ts   (copies the .aff/.dic/.LICENSE only)
```

The `nspell` **engine** itself is a generated bundle (`media/dist/spell-engine.js`) built by
`build:webview`, not here — so it's git-ignored like the other webview bundles. Dev deps: `nspell`,
`dictionary-{en,es,pt,fr,de,it}`, `esbuild`. The `.aff/.dic` and each `<lang>.LICENSE` are licensed
data copied from the npm packages and **must** ship alongside the dictionaries.

> UI translations live in `package.nls.<lang>.json` (English is the key). To add a language,
> add its bundle, extend the `jotflow.language` enum, and `SPELL_LANGS` in `src/spellWords.ts`.

## Packaging a `.vsix`

```bash
npm install -g @vscode/vsce
vsce ls          # review what will be packaged (respects .vscodeignore)
vsce package     # produces jotflow-<version>.vsix
```

Install it via **Extensions → Install from VSIX…**. CI (GitHub Actions,
`.github/workflows/release.yml`) also builds the `.vsix` as a workflow artifact (and, when
approved, publishes it — see **Publishing**).

## Publishing

Publishing is **manual**, via GitHub Actions: open the **Release** workflow
(`.github/workflows/release.yml`) → **Run workflow** on `master`. It runs compile → test →
package, then the **publish** job pauses for approval (the `marketplace` environment) before
pushing to the VS Code Marketplace.

- The published version is `package.json`'s `version` — **bump it before running**. Publishing is
  **idempotent**: re-running with an already-published version is a no-op.
- Auth: a `VSCE_PAT` (Azure DevOps token with *Marketplace → Manage*) is stored as a repo secret.
