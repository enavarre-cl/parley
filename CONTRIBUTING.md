# Contributing to Lang Chat

> New here? Read [ARCHITECTURE.md](ARCHITECTURE.md) first for a map of the codebase
> (extension host ↔ webviews, providers, the agentic loop, local engines, i18n, security).

## Develop & run

```bash
npm install
npm run compile        # tsc → out/
```

Open the folder in VS Code and press **F5** (the “Run Extension” launch config). An *Extension
Development Host* window opens with the extension loaded. Create a chat from the command palette
(`Cmd/Ctrl+Shift+P`) → **“Lang Chat: New chat”**, or open any file with the `.chat` extension.

> Reloading the dev host (**⌘R / Ctrl+R**) is required after changing `package.json` (commands,
> menus, views) or the extension host code.

## Validation (run after changes)

```bash
npm run compile           # tsc → out/
npm run lint              # eslint src (0 errors / 0 warnings)
node --check media/*.js   # webview JS syntax (not linted/compiled)
npm test                  # compile + node:test suite
```

For `package.json`: keep the `%nls%` placeholders in sync with `package.nls*.json`, and ensure
every menu command is declared in `contributes.commands`.

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
   - add a branch in **`buildProvider()`** (construct with the base URL + `resolveApiKey('foo')`);
   - add a branch in **`providerInfo()`** (`label`, `endpoint`, `needsKey`, `hasKey`).

3. **`src/extension.ts`** — if it needs an API key, add `{ id: 'foo', label: 'Foo' }` to
   **`KEY_PROVIDERS`** (SecretStorage entry + load), and add `<option value="foo">Foo</option>`
   to `#providerSelect` in the chat HTML.

4. **`package.json`** — add `foo` to the `langChat.provider` enum and the
   `langChat.foo.baseUrl` / `langChat.foo.apiKey` settings (with `%nls%` keys).

5. **`package.nls.json`** (+ `es/pt/fr/de/it`) — the new setting/enum descriptions.

6. **(Optional)** gate provider-specific sampling params via the `only:` arrays in the
   `media/main.js` settings schema.

Shared helpers worth reusing: `stream.ts` (NDJSON/SSE line reader), `think.ts` (reasoning
splitter), `multimodal.ts` (attachments + image-output), `httpError.ts` and `http.ts`
(proxy-aware `fetch`). See `ARCHITECTURE.md` §4.

## Spell‑check & language assets

Regenerate the bundled Hunspell dictionaries (`media/dict/<lang>.{aff,dic,LICENSE}` for
`en, es, pt, fr, de, it`) and the webview `nspell` engine (`media/spell-engine.js`) with:

```bash
npm run build:spell      # → scripts/build-spell.js
```

Dev deps: `nspell`, `dictionary-{en,es,pt,fr,de,it}`, `esbuild`. The `.aff/.dic` and each
`<lang>.LICENSE` are copied from the npm `dictionary-*` packages and **must** ship alongside the
dictionaries.

> UI translations live in `package.nls.<lang>.json` (English is the key). To add a language,
> add its bundle, extend the `langChat.language` enum, and `SPELL_LANGS` in `src/spellWords.ts`.

## Packaging a `.vsix`

```bash
npm install -g @vscode/vsce
vsce ls          # review what will be packaged (respects .vscodeignore)
vsce package     # produces lang-chat-<version>.vsix
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
