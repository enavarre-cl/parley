import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { buildProvider, chatDefaults, providerInfo, isProviderId, setApiKeyOverride, setManagedOllamaBaseUrl, ChatMessage, ProviderId } from './providers';
import { OllamaManager } from './ollama/manager';
import { DownloadManager } from './ollama/downloads';
import { ModelCardCache } from './ollama/cards';
import { ModelsTreeProvider, Section } from './modelsView';
import { ModelsPanel } from './modelsPanel';
import { remove as removeModel } from './ollama/registry';
import {
  ChatDoc,
  ChatParams,
  parseDoc,
  serializeDoc,
  defaultDoc,
  resolveGenerationParams,
} from './chatDocument';
import { ToolHub } from './tools';
import { wavData, concatWavs, splitForTTS } from './audio';
import { initProxy } from './http';
import { tr, resolvedLang, activeBundle } from './i18n';
import { registerCompare } from './compareView';
import { SpellWordsStore, SpellLang, SPELL_LANGS } from './spellWords';
import { openDictionaryPanel } from './dictionaryPanel';
import { openVoicesPanel } from './voicesPanel';
import { removePiperVoice, listPiperVoices } from './piperVoices';
import { PiperManager } from './piper/manager';

// Tools hub (native filesystem + MCP servers), shared by all chats.
const toolHub = new ToolHub();

// Backends that use an API key (Ollama does not). The secret is stored as `parley.<id>.apiKey`.
const KEY_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'openai', label: 'LM Studio / OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openrouter', label: 'OpenRouter' },
];

/** Loads API keys from SecretStorage (encrypted) into the provider overrides. */
async function loadApiKeys(context: vscode.ExtensionContext): Promise<void> {
  for (const { id } of KEY_PROVIDERS) {
    const k = await context.secrets.get(`parley.${id}.apiKey`);
    setApiKeyOverride(id, k || undefined);
  }
}

/** Extracts the HF repo id from a local Ollama model name (`hf.co/user/repo:quant` → `user/repo`). */
function localModelHfId(name?: string): string | undefined {
  if (!name || !/^hf\.co\//i.test(name)) return undefined;
  const id = name.replace(/^hf\.co\//i, '').replace(/:[^:/]+$/, '');
  return id || undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const spellWords = new SpellWordsStore(context);
  context.subscriptions.push(spellWords);
  const piper = new PiperManager(context);
  // Notifies open chats when the set of downloaded voices changes (panel/tree) so that
  // the chat's voice selector only shows downloaded ones.
  const voicesChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(voicesChanged);
  // Notifies open chats when parley.language changes, so the UI re-translates live (no reload).
  const langChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(langChanged);
  const provider = new ChatEditorProvider(context, spellWords, piper, voicesChanged.event, langChanged.event);

  registerCompare(context); // version comparison command (Timeline / palette)

  initProxy(); // configures the proxy (http.proxy / env) for all requests
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('http')) initProxy();
      if (e.affectsConfiguration('parley.language')) langChanged.fire();
    })
  );
  void loadApiKeys(context); // populate overrides from SecretStorage on startup
  // If secrets change (another window, or the command), reload.
  context.secrets.onDidChange((e) => { if (e.key.startsWith('parley.') && e.key.endsWith('.apiKey')) void loadApiKeys(context); });

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ChatEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('parley.new', () => createNewChat()),
    vscode.commands.registerCommand('parley.spell.openDictionary', (item: any) => {
      const lang = item?.word === 'en' ? 'en' : 'es'; // the node carries the language in `word`
      openDictionaryPanel(context, spellWords, lang);
    }),
    vscode.commands.registerCommand('parley.setApiKey', async () => {
      const pick = await vscode.window.showQuickPick(
        KEY_PROVIDERS.map((p) => ({ label: p.label, id: p.id })),
        { placeHolder: tr('Backend for the API key') }
      );
      if (!pick) return;
      const key = await vscode.window.showInputBox({
        password: true,
        prompt: `${tr('API key for')} ${pick.label} ${tr('(empty = delete)')}`,
        placeHolder: '••••••••',
      });
      if (key === undefined) return; // cancelled
      const secretKey = `parley.${pick.id}.apiKey`;
      if (key) await context.secrets.store(secretKey, key);
      else await context.secrets.delete(secretKey);
      setApiKeyOverride(pick.id, key || undefined);
      vscode.window.showInformationMessage(`${tr('API key for')} ${pick.label} ${key ? tr('saved') : tr('deleted')} ${tr('(encrypted in SecretStorage).')}`);
    })
  );

  // ---- Local models (managed Ollama + explorer) ----
  const ollama = new OllamaManager(context, (s) => {
    if (vscode.workspace.getConfiguration('parley').get<boolean>('tts.debug', false)) console.log(s);
  });
  // Publishes the managed baseUrl so the Ollama provider can use it when ready.
  ollama.onDidChangeStatus(() => setManagedOllamaBaseUrl(ollama.status === 'ready' ? ollama.baseUrl() : undefined));
  const needServer = async (): Promise<string | undefined> => {
    try {
      // If ready, returns immediately; otherwise shows progress (first time downloads the binary).
      if (ollama.status === 'ready') return ollama.baseUrl();
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Ollama' },
        () => ollama.start((received, total) => { void received; void total; })
      );
    } catch (e: any) { vscode.window.showErrorMessage(`Ollama: ${e?.message || e}`); return undefined; }
  };
  // Persistent downloads (survive restarts) that auto-start the server on (re)attempt.
  const downloads = new DownloadManager(
    () => needServer(),
    (name, modelPaths, projPath) => ollama.create(name, modelPaths, projPath),
    () => refreshTrees(),
    context.globalState,
    path.join(context.globalStorageUri.fsPath, 'imports')
  );
  const piperVoicesDir = vscode.Uri.joinPath(context.globalStorageUri, 'piper-voices').fsPath;
  // One view (TreeProvider) per section → VS Code gives them the native shaded header.
  const mkTree = (s: Section) => new ModelsTreeProvider(ollama, downloads, spellWords, piperVoicesDir, piper, s, voicesChanged.event);
  const treeEngines = mkTree('engines');
  const treeModels = mkTree('models'); // includes Local models + Downloads (tree)
  const treeVoices = mkTree('voices');
  const treeDict = mkTree('dictionary');
  const refreshTrees = (): void => { treeEngines.refresh(); treeModels.refresh(); treeVoices.refresh(); treeDict.refresh(); };
  // Card cache (sidecar): view/queue saves HF info; cancel/remove clears it.
  const cards = new ModelCardCache(path.join(context.globalStorageUri.fsPath, 'model-cards'));
  const panelHooks = {
    onChanged: () => refreshTrees(),
    useModel: async (name: string) => {
      if (ChatEditorProvider.activeApply) { await ChatEditorProvider.activeApply({ provider: 'ollama', model: name }); return true; }
      return false;
    },
  };

  // Installs/updates an engine showing progress. (Ollama "update" = reinstalls the pinned version.)
  const runEngineTask = async (which: any): Promise<void> => {
    if (which !== 'ollama' && which !== 'piper') return;
    const name = which === 'ollama' ? 'Ollama' : 'Piper';
    const title = tr('Installing engine…') + ` (${name})`;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (p) => {
        const notify = (m: string) => p.report({ message: m });
        if (which === 'ollama') await ollama.ensureBinary();
        else await piper.install(notify);
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`${name}: ${e?.message ?? e}`);
    }
    refreshTrees();
  };

  context.subscriptions.push(
    ollama,
    downloads,
    piper, // dispose() shuts down the HTTP daemon when the extension deactivates
    vscode.window.registerTreeDataProvider('parley.engines', treeEngines),
    vscode.window.registerTreeDataProvider('parley.models', treeModels),
    vscode.window.registerTreeDataProvider('parley.voices', treeVoices),
    vscode.window.registerTreeDataProvider('parley.dictionary', treeDict),
    vscode.commands.registerCommand('parley.models.add', () => ModelsPanel.show(context, ollama, downloads, cards, panelHooks)),
    vscode.commands.registerCommand('parley.models.openModelFromDownload', (item: any) => {
      const modelId = item?.download?.modelId;
      if (!modelId) return;
      ModelsPanel.show(context, ollama, downloads, cards, panelHooks);
      ModelsPanel.revealModel(modelId);
    }),
    vscode.commands.registerCommand('parley.models.cancelDownload', (item: any) => {
      if (item?.download) { cards.remove(item.download.modelId); downloads.cancel(item.download.id); }
    }),
    vscode.commands.registerCommand('parley.models.retryDownload', (item: any) => {
      if (item?.download?.id) downloads.retry(item.download.id);
    }),
    vscode.commands.registerCommand('parley.models.removeDownload', (item: any) => {
      if (item?.download) { cards.remove(item.download.modelId); downloads.remove(item.download.id); }
    }),
    vscode.commands.registerCommand('parley.models.clearDownloads', () => downloads.clearFinished()),
    vscode.commands.registerCommand('parley.models.refresh', () => refreshTrees()),
    vscode.commands.registerCommand('parley.tts.openVoices', () => {
      openVoicesPanel(context, piper, piperVoicesDir, () => { refreshTrees(); voicesChanged.fire(); });
    }),
    vscode.commands.registerCommand('parley.tts.startServer', async () => {
      const model = piper.firstVoiceModel();
      if (!model) { vscode.window.showInformationMessage(tr('Download a voice first from the Voices section.')); return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Starting the Piper server…') },
          (p) => piper.ensureServer(model, (m) => p.report({ message: m }))
        );
      } catch (e: any) { vscode.window.showErrorMessage(`Piper: ${e?.message ?? e}`); }
    }),
    vscode.commands.registerCommand('parley.tts.stopServer', () => piper.stopServer()),
    vscode.commands.registerCommand('parley.tts.removeVoice', async (item: any) => {
      const id = item?.word; // the voice node carries its id in `word`
      if (typeof id !== 'string') return;
      const yes = tr('Delete');
      const pick = await vscode.window.showWarningMessage(tr('Delete this voice?') + ` (${id})`, { modal: true }, yes);
      if (pick !== yes) return;
      removePiperVoice(piperVoicesDir, id);
      refreshTrees();
      voicesChanged.fire();
    }),
    vscode.commands.registerCommand('parley.engine.install', (item: any) => runEngineTask(item?.word)),
    vscode.commands.registerCommand('parley.engine.delete', async (item: any) => {
      const which = item?.word;
      if (which !== 'ollama' && which !== 'piper') return;
      const name = which === 'ollama' ? 'Ollama' : 'Piper';
      const yes = tr('Delete');
      if (await vscode.window.showWarningMessage(tr('Delete this engine?') + ` (${name})`, { modal: true }, yes) !== yes) return;
      if (which === 'ollama') { ollama.deleteBinary(); cards.clear(); } else { piper.delete(); voicesChanged.fire(); }
      refreshTrees();
    }),
    vscode.commands.registerCommand('parley.models.startServer', async () => { await needServer(); }),
    vscode.commands.registerCommand('parley.models.stopServer', () => { ollama.stop(); }),
    vscode.commands.registerCommand('parley.models.deleteModel', async (item: any) => {
      const name = item?.model?.name; const baseUrl = ollama.baseUrl();
      if (!name || !baseUrl) return;
      const ok = await vscode.window.showWarningMessage(`${tr('Delete the model')} ${name}?`, { modal: true }, tr('Delete'));
      if (ok !== tr('Delete')) return;
      try { await removeModel(baseUrl, name); refreshTrees(); }
      catch (e: any) { vscode.window.showErrorMessage(`${tr('Could not delete: ')}${e?.message || e}`); }
    }),
    vscode.commands.registerCommand('parley.models.openLocalModel', (item: any) => {
      const id = localModelHfId(item?.model?.name);
      if (!id) { vscode.window.showInformationMessage(tr('This model is not from Hugging Face.')); return; }
      ModelsPanel.show(context, ollama, downloads, cards, panelHooks);
      ModelsPanel.revealModel(id);
    })
  );
}

export function deactivate() {
  toolHub.dispose();
}

/** Creates a new `.chat` file (asking for a destination) and opens it with the chat editor. */
async function createNewChat(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = folder
    ? vscode.Uri.joinPath(folder, 'new.chat')
    : undefined;

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: tr('Create chat'),
    filters: { 'Parley': ['chat'] },
  });
  if (!target) return;

  const doc = defaultDoc(chatDefaults());
  await vscode.workspace.fs.writeFile(target, Buffer.from(serializeDoc(doc), 'utf8'));
  await vscode.commands.executeCommand('vscode.openWith', target, ChatEditorProvider.viewType);
}

class ChatEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'parley.editor';
  /** Applier for the focused chat: the models view uses it to "use this model". */
  static activeApply: ((patch: any) => Promise<void>) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly spellWords: SpellWordsStore,
    private readonly piper: PiperManager,
    private readonly onVoicesChanged: vscode.Event<void>,
    private readonly onLangChanged: vscode.Event<void>
  ) {}

  /** Downloaded Piper voice ids, so the chat only offers those in its selector. */
  private downloadedVoiceIds(): string[] {
    return listPiperVoices(vscode.Uri.joinPath(this.context.globalStorageUri, 'piper-voices').fsPath).map((v) => v.id);
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): void {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = this.html(webview);

    // Text we write ourselves: to distinguish our own edits from external ones.
    let lastWritten: string | null = null;
    let abort: AbortController | undefined;
    let busy = false; // an inference is in progress: reject new requests
    let ttsToken = 0; // identifies the current TTS request; when it changes, the chunk loop is cancelled
    let currentPiperProc: any = null; // piper process in flight, so we can kill it on cancel
    const killPiper = () => { if (currentPiperProc) { try { currentPiperProc.kill(); } catch { /* nothing */ } currentPiperProc = null; } };
    // TTS trace to file (for debugging without relying on the webview console).
    const tlog = (s: string) => {
      // Only traces if the user enables debug (off by default).
      if (!vscode.workspace.getConfiguration('parley').get<boolean>('tts.debug', false)) return;
      try { console.log('[TTS]', s); } catch { /* nothing */ }
      try { fs.appendFileSync(path.join(os.tmpdir(), 'parley-tts.log'), new Date().toISOString() + ' ' + s + '\n'); } catch { /* nothing */ }
    };
    let modelContexts: Record<string, number> = {}; // model id -> context tokens
    // Cache of document parsing by version: parseDoc validates/normalises on every call and
    // getDoc is invoked many times per operation. We return a clone to avoid corrupting the cache.
    let docCache: { version: number; doc: ChatDoc } | null = null;

    const getDoc = (): ChatDoc | null => {
      if (docCache && docCache.version === document.version) {
        return structuredClone(docCache.doc);
      }
      try {
        const doc = parseDoc(document.getText(), chatDefaults());
        docCache = { version: document.version, doc };
        return structuredClone(doc);
      } catch (err: any) {
        webview.postMessage({ type: 'error', message: tr('The .chat file has invalid JSON: ') + (err?.message ?? err) });
        return null;
      }
    };

    // `save`/`prune` can be disabled for intermediate writes (e.g. each iteration
    // of the tool-loop): they are applied once at the end of the turn, avoiding flushing to disk
    // and rewriting the attachment sidecar on every step (O(n) cost per iteration).
    const writeDoc = async (doc: ChatDoc, opts?: { save?: boolean; prune?: boolean }): Promise<void> => {
      const save = opts?.save !== false;
      const prune = opts?.prune !== false;
      // Stamps id + timestamp on every message that doesn't have them yet (single place for all).
      for (const m of doc.messages) {
        if (!m.id) m.id = `msg_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        if (!m.ts) m.ts = new Date().toISOString();
      }
      const text = serializeDoc(doc);
      if (text === document.getText()) return;
      lastWritten = text;
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      edit.replace(document.uri, fullRange, text);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        webview.postMessage({ type: 'error', message: tr('Could not write the .chat file.') });
        return;
      }
      // Persists to disk so configuration is not lost.
      if (save && !document.isUntitled) {
        await document.save();
      }
      // Cleans up orphan attachments from the sidecar after each persisted change.
      if (prune) await pruneAttach(doc);
    };

    const pushDoc = (): void => {
      const doc = getDoc();
      if (doc) webview.postMessage({ type: 'doc', doc: resolveDocForView(doc) });
    };

    // Workspace file list for @-mention autocomplete (cached briefly; respects files/search excludes).
    let fileCache: string[] | null = null;
    let fileCacheAt = 0;
    const workspaceFiles = async (): Promise<string[]> => {
      if (fileCache && Date.now() - fileCacheAt < 15000) return fileCache;
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,out,dist,.next,build,coverage,.vscode-test}/**',
        5000
      );
      fileCache = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort((a, b) => a.localeCompare(b));
      fileCacheAt = Date.now();
      return fileCache;
    };
    const searchFiles = async (q: string): Promise<string[]> => {
      const all = await workspaceFiles();
      const ql = q.toLowerCase();
      if (!ql) return all.slice(0, 10);
      const base = (p: string) => (p.split('/').pop() || p).toLowerCase();
      const starts = all.filter((p) => base(p).startsWith(ql));
      const incl = all.filter((p) => !base(p).startsWith(ql) && p.toLowerCase().includes(ql));
      return [...starts, ...incl].slice(0, 10);
    };

    // Sends the effective language + its translation bundle to the webview (so a live change to any
    // locale re-translates without a reload — the webview can't carry every language's bundle).
    const pushLang = (): void => {
      webview.postMessage({ type: 'lang', lang: resolvedLang(), bundle: activeBundle() });
    };

    // Neural TTS with Piper: splits the text into sentences and sends each chunk as base64 WAV.
    // This way the first fragment plays immediately and no giant WAVs are generated for long messages.
    // `voice` is a curated voice id (downloaded automatically); if empty, uses the path from settings.
    const synthPiper = async (text: string, rate: number, voice: string, reqId: number): Promise<void> => {
      const t = text.trim();
      if (!t) return;
      const myToken = ++ttsToken; // any later request/stop cancels this one
      const cancelled = () => myToken !== ttsToken;
      killPiper(); // kill any piper from a previous request still in flight
      tlog(`req#${reqId} received (engine=piper, rate=${rate}, voice=${voice || '(setting)'})`);
      // All TTS messages carry the request id so the webview can filter stale ones.
      const post = (m: any) => webview.postMessage({ ...m, id: reqId });
      const notice = (m: string) => webview.postMessage({ type: 'notice', message: m });
      const cfg = vscode.workspace.getConfiguration('parley');
      const speaker = cfg.get<number>('tts.piperSpeaker', -1);
      const isCurated = !!voice && /^[a-z]{2}_[A-Z]{2}-/.test(voice);
      // Via DAEMON (resident model, fast): curated voices only. Any failure falls through to
      // the per-chunk spawn below, so there is no regression if the server fails to start.
      if (isCurated) {
        try {
          const modelPath = await this.piper.ensureVoice(voice, notice);
          if (cancelled()) return;
          const baseUrl = await this.piper.ensureServer(modelPath, notice);
          if (cancelled()) return;
          const lscale = rate > 0 ? 1 / rate : 1;
          const wav = await this.piper.synthViaServer(baseUrl, t, voice, lscale, typeof speaker === 'number' ? speaker : -1);
          if (cancelled()) return;
          tlog(`req#${reqId} OK via daemon: WAV ${wav.length} bytes`);
          post({ type: 'ttsAudio', data: wav.toString('base64'), last: true });
          post({ type: 'ttsDone' });
          return;
        } catch (e: any) {
          tlog(`req#${reqId} daemon failed (${e?.message ?? e}); falling back to per-chunk spawn`);
        }
      }
      let bin: string;
      try {
        bin = await this.piper.resolveBin(cfg, notice);
      } catch (e: any) {
        post({ type: 'ttsError', message: tr('Could not set up Piper: ') + (e?.message ?? e) });
        return;
      }
      if (cancelled()) return;
      let model = '';
      if (voice && /^[a-z]{2}_[A-Z]{2}-/.test(voice)) {
        try {
          model = await this.piper.ensureVoice(voice, notice);
        } catch (e: any) {
          post({ type: 'ttsError', message: tr('Could not download voice: ') + (e?.message ?? e) });
          return;
        }
      } else {
        model = cfg.get<string>('tts.piperModel', '') || '';
      }
      if (!model) {
        post({ type: 'ttsError', message: tr('No voice available. Download one from the Parley panel (Voices ➕), or set a custom .onnx path in Settings (parley.tts.piperModel).') });
        return;
      }
      if (cancelled()) return;

      const lengthScale = rate > 0 ? (1 / rate).toFixed(3) : '1';
      const libDir = path.dirname(bin);
      const env: any = { ...process.env };
      if (process.platform === 'darwin') {
        env.DYLD_LIBRARY_PATH = libDir + (env.DYLD_LIBRARY_PATH ? ':' + env.DYLD_LIBRARY_PATH : '');
      } else if (process.platform === 'linux') {
        env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
      }

      // Synthesises a chunk and returns the WAV Buffer (or an error).
      const synthChunk = (chunk: string): Promise<{ ok: boolean; buf?: Buffer; err?: string }> =>
        new Promise((resolve) => {
          const out = path.join(os.tmpdir(), `parley-tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
          const args = ['--model', model, '--output_file', out, '--length_scale', lengthScale];
          if (typeof speaker === 'number' && speaker >= 0) args.push('--speaker', String(speaker));
          let proc: any;
          try {
            proc = cp.spawn(bin, args, { cwd: libDir, env });
          } catch (e: any) {
            return resolve({ ok: false, err: e?.message ?? String(e) });
          }
          currentPiperProc = proc; // so we can kill it if cancelled
          let stderr = '';
          proc.stderr?.on('data', (d: any) => { stderr += d.toString(); });
          proc.on('error', (e: any) => {
            if (currentPiperProc === proc) currentPiperProc = null;
            try { fs.unlinkSync(out); } catch { /* not created / already deleted */ }
            resolve({ ok: false, err: e?.message ?? String(e) });
          });
          proc.on('close', (code: number) => {
            if (currentPiperProc === proc) currentPiperProc = null;
            try {
              if (code === 0 && fs.existsSync(out)) resolve({ ok: true, buf: fs.readFileSync(out) });
              else resolve({ ok: false, err: stderr.trim() || `exit ${code}` });
            } finally {
              try { fs.unlinkSync(out); } catch { /* already deleted */ }
            }
          });
          proc.stdin?.write(chunk);
          proc.stdin?.end();
        });

      // Synthesises each sentence separately (fast) and concatenates them into a single WAV.
      const chunks = splitForTTS(t);
      tlog(`req#${reqId} bin=${bin.split('/').slice(-3).join('/')} chars=${t.length} chunks=${chunks.length}`);
      if (chunks.length > 1) webview.postMessage({ type: 'notice', message: tr('Generating audio…') });
      const bufs: Buffer[] = [];
      let lastErr = '';
      for (let i = 0; i < chunks.length; i++) {
        if (cancelled()) { tlog(`req#${reqId} cancelled at chunk ${i}`); return; }
        const r = await synthChunk(chunks[i]);
        if (cancelled()) { tlog(`req#${reqId} cancelled after chunk ${i}`); return; }
        if (r.ok && r.buf) bufs.push(r.buf);
        else { lastErr = r.err || ''; tlog(`req#${reqId} chunk ${i} FAILED: ${lastErr}`); }
      }
      if (cancelled()) return;
      if (!bufs.length) { tlog(`req#${reqId} no audio: ${lastErr}`); post({ type: 'ttsError', message: tr('Piper failed: ') + lastErr }); return; }
      const wav = concatWavs(bufs);
      tlog(`req#${reqId} OK: ${bufs.length} chunks → WAV ${wav.length} bytes (~${(wavData(wav).len / (22050 * 2)).toFixed(1)}s); sending`);
      // A single WAV → a single playback in the webview (no fragile chains).
      post({ type: 'ttsAudio', data: wav.toString('base64'), last: true });
      post({ type: 'ttsDone' });
    };

    // Roots a systemPromptFile may live in: the .chat's own folder + any workspace folder. Project
    // files are fine; a shared .chat still cannot pull arbitrary files (e.g. ../../etc/passwd) into
    // the prompt and exfiltrate them to the model.
    const sysPromptRoots = (): string[] => [
      path.dirname(document.uri.fsPath),
      ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    ];
    const sysPromptPathAllowed = (resolved: string): boolean =>
      sysPromptRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));

    let sysPromptWarned = ''; // debounce: warn once per broken file, not on every send

    // Reads the EFFECTIVE system prompt (file if usable, else inline). No side effects.
    // `fileFailed` = a systemPromptFile was set but is missing/empty/outside the workspace.
    const readSystemPrompt = (doc: ChatDoc): { text: string; fileFailed: boolean } => {
      if (doc.systemPromptFile) {
        const resolved = path.resolve(path.dirname(document.uri.fsPath), doc.systemPromptFile);
        if (sysPromptPathAllowed(resolved)) {
          try {
            const text = fs.readFileSync(resolved, 'utf8');
            if (text.trim()) return { text, fileFailed: false };
          } catch { /* missing/unreadable */ }
        }
        return { text: doc.systemPrompt || '', fileFailed: true };
      }
      return { text: doc.systemPrompt || '', fileFailed: false };
    };

    // Effective system prompt for sending; warns once (visibly) if a referenced file couldn't be
    // used, instead of silently using the inline prompt (which looks like the prompt is ignored).
    const resolveSystemPrompt = (doc: ChatDoc): string => {
      const { text, fileFailed } = readSystemPrompt(doc);
      if (fileFailed) {
        const file = doc.systemPromptFile || '';
        if (sysPromptWarned !== file) {
          sysPromptWarned = file;
          void vscode.window.showWarningMessage(
            `${tr('System prompt file not used (missing, empty, or outside the workspace); using the inline prompt instead:')} ${file}`
          );
        }
      } else {
        sysPromptWarned = '';
      }
      return text;
    };

    // ---- Attachment sidecar (.attach): blobs live here, the .chat only holds references ----
    const attachUri = (): vscode.Uri => {
      const stem = path.basename(document.uri.fsPath).replace(/\.chat$/i, '');
      return vscode.Uri.joinPath(document.uri, '..', stem + '.attach');
    };
    let attachCache: Record<string, any> | null = null;
    const loadAttach = (): Record<string, any> => {
      if (attachCache) return attachCache;
      try {
        attachCache = JSON.parse(fs.readFileSync(attachUri().fsPath, 'utf8'));
      } catch {
        attachCache = {};
      }
      return attachCache!;
    };
    const saveAttach = async (store: Record<string, any>): Promise<void> => {
      attachCache = store;
      await vscode.workspace.fs.writeFile(attachUri(), Buffer.from(JSON.stringify(store) + '\n', 'utf8'));
    };
    // Saves new blobs in the sidecar and returns attachments with only {kind,name,mime,ref}.
    const storeAttachments = async (atts: any[]): Promise<any[]> => {
      if (!atts.length) return [];
      const store = loadAttach();
      const refs: any[] = [];
      for (const a of atts) {
        const id = `att_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
        store[id] = { kind: a.kind, name: a.name, mime: a.mime, data: a.data };
        refs.push({ kind: a.kind, name: a.name, mime: a.mime, ref: id });
      }
      await saveAttach(store);
      return refs;
    };
    // Stores images returned by an image-output model as image attachments (sidecar refs).
    const storeGenImages = async (images: { mime: string; data: string }[]): Promise<any[]> => {
      const ext = (mime: string) => (/jpeg|jpg/i.test(mime) ? 'jpg' : /webp/i.test(mime) ? 'webp' : /gif/i.test(mime) ? 'gif' : 'png');
      return storeAttachments(images.map((im, i) => ({
        kind: 'image', name: `image-${i + 1}.${ext(im.mime)}`, mime: im.mime || 'image/png', data: im.data,
      })));
    };
    // Returns an attachment with `data` resolved (from the sidecar if a ref, or legacy inline).
    const resolveAtt = (a: any): any => {
      if (typeof a?.data === 'string') return a; // legacy inline
      if (a?.ref) {
        const e = loadAttach()[a.ref];
        if (e) return { kind: a.kind, name: a.name || e.name, mime: a.mime || e.mime, data: e.data };
      }
      return a;
    };
    // Removes from the sidecar entries no longer referenced by any message (on delete/merge/fork).
    const pruneAttach = async (doc: ChatDoc): Promise<void> => {
      if (!attachCache) return; // only if attachments have been/were loaded
      const used = new Set<string>();
      for (const m of doc.messages) {
        for (const a of (m.attachments ?? [])) if (a.ref) used.add(a.ref);
        for (const v of (m.variants ?? [])) for (const a of (v.attachments ?? [])) if (a.ref) used.add(a.ref);
      }
      let changed = false;
      for (const id of Object.keys(attachCache)) {
        if (!used.has(id)) { delete attachCache[id]; changed = true; }
      }
      if (!changed) return;
      if (Object.keys(attachCache).length === 0) {
        try { await vscode.workspace.fs.delete(attachUri()); } catch { /* no longer exists */ }
      } else {
        await vscode.workspace.fs.writeFile(attachUri(), Buffer.from(JSON.stringify(attachCache) + '\n', 'utf8'));
      }
    };

    // Copy of the doc with resolved attachments (for the webview), without touching the persisted doc.
    // `sysPromptTokens` = tokens of the EFFECTIVE system prompt (file content included): the webview
    // only has the inline `systemPrompt`, so without this its context bar undercounts when a file is used.
    const resolveDocForView = (doc: ChatDoc): ChatDoc & { sysPromptTokens: number } => ({
      ...doc,
      sysPromptTokens: estTokens(readSystemPrompt(doc).text),
      messages: doc.messages.map((m) =>
        m.attachments ? { ...m, attachments: m.attachments.map(resolveAtt) } : m
      ),
    });

    const sendStatus = (state: 'checking' | 'ok' | 'error', detail = ''): void => {
      const doc = getDoc();
      if (!doc) return;
      webview.postMessage({ type: 'status', info: providerInfo(doc.provider), state, detail });
    };

    const loadModels = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc) return;
      const info = providerInfo(doc.provider);
      sendStatus('checking');

      if (info.needsKey && !info.hasKey) {
        webview.postMessage({
          type: 'models',
          provider: doc.provider,
          models: [],
          current: '',
          error: `${tr('Missing the API key for')} ${info.label}. ${tr('Set it in the settings (🔧).')}`,
        });
        sendStatus('error', tr('missing API key'));
        return;
      }

      try {
        let models = await buildProvider(doc.provider).listModels();
        // Global OpenRouter vendor filter (prefix before '/').
        if (doc.provider === 'openrouter') {
          const cfg = vscode.workspace.getConfiguration('parley');
          const vendors = cfg.get<string[]>('openrouter.vendors', []);
          if (vendors.length) {
            models = models.filter((m) => vendors.includes(m.id.split('/')[0]));
          }
          // Custom model ids the API doesn't list (new/preview). Always included, before the vendor list.
          const custom = cfg.get<string[]>('openrouter.customModels', []).map((s) => (s || '').trim()).filter(Boolean);
          const present = new Set(models.map((m) => m.id));
          for (const id of [...custom].reverse()) {
            if (!present.has(id)) { models.unshift({ id }); present.add(id); }
          }
        }
        modelContexts = {};
        for (const m of models) if (m.contextLength) modelContexts[m.id] = m.contextLength;
        const ids = models.map((m) => m.id);
        let current = doc.model;
        if ((!current || !ids.includes(current)) && ids.length > 0) {
          current = ids[0];
          doc.model = current;
          await writeDoc(doc);
        }
        webview.postMessage({ type: 'models', provider: doc.provider, models, current });
        sendStatus('ok', `${models.length} ${tr(models.length === 1 ? 'model' : 'models')}`);
      } catch (err: any) {
        webview.postMessage({ type: 'models', provider: doc.provider, models: [], current: '', error: errMsg(err) });
        sendStatus('error', tr('no connection'));
      }
    };

    // Calls the model to summarise a block of messages (no streaming to the UI).
    const summarizeMessages = async (
      doc: ChatDoc,
      prevText: string,
      msgs: ChatMessage[]
    ): Promise<string> => {
      const convo = msgs
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      const instruction =
        (prevText
          ? `Previous summary of the conversation:\n${prevText}\n\nIntegrate the following new messages into a single updated summary.`
          : 'Summarize the following conversation.') +
        '\nKeep facts, decisions, data, names and pending tasks. Be concise. Reply with only the summary, in the same language as the conversation.\n\n--- Conversation ---\n' +
        convo;
      const wire: ChatMessage[] = [
        { role: 'system', content: 'You are an assistant that summarizes conversations to preserve context.' },
        { role: 'user', content: instruction },
      ];
      abort = new AbortController();
      let text = '';
      let reasoning = '';
      try {
        await buildProvider(doc.provider).chat(
          doc.model,
          wire,
          { temperature: 0.3, maxTokens: 1024 },
          {
            signal: abort.signal,
            onDelta: (d) => { text += d; },
            onReasoning: (d) => { reasoning += d; },
          }
        );
      } finally {
        abort = undefined;
      }
      // Some reasoning models return text only in the thinking channel.
      return (text.trim() || reasoning.trim());
    };

    // Ensures a summary covering messages[0..targetUpTo); extends it incrementally.
    const ensureSummary = async (
      doc: ChatDoc,
      history: ChatMessage[],
      targetUpTo: number
    ): Promise<string> => {
      const prev = doc.summary;
      if (prev && prev.upTo >= targetUpTo) return prev.text;
      const startFrom = prev ? prev.upTo : 0;
      const block = history.slice(startFrom, targetUpTo);
      if (!block.length) return prev?.text ?? '';
      // PERSISTENT indicator (with spinner) throughout the model call; removed on completion
      // or failure. (Previously it was a notice that auto-closed after 6 s, leaving a feedback gap.)
      webview.postMessage({ type: 'summarizing', active: true, message: tr('🗜️ Summarizing previous context…') });
      try {
        const text = await summarizeMessages(doc, prev?.text ?? '', block);
        if (text) {
          doc.summary = { text, upTo: targetUpTo };
          await writeDoc(doc);
        }
        return doc.summary?.text ?? '';
      } finally {
        webview.postMessage({ type: 'summarizing', active: false });
      }
    };

    // Runs a streaming inference over `context`. Returns the accumulated result.
    // With `allowTools`, runs the agentic loop (MCP tools / native filesystem).
    const runInference = async (
      doc: ChatDoc,
      context: ChatMessage[],
      allowTools = false
    ): Promise<{ answer: string; thinking: string; failed: boolean; usage?: any; images: { mime: string; data: string }[] }> => {
      let history = context;
      let summaryText = '';
      // Resolve ONCE: used both to budget the trimming below and as the system message sent. Must be
      // the effective prompt (file content included) or the budget under-counts and can overflow the window.
      const sysPrompt = resolveSystemPrompt(doc);

      const cmCfg = doc.params.contextMessages;
      const lastNActive = cmCfg.enabled && cmCfg.value > 0;
      if (lastNActive) {
        // PRIORITY: "last N messages" wins over the summary (which becomes stale as the chat advances).
        // The token budget (auto = 75% of the model window) also caps: the tighter cut wins
        // (to avoid blowing the window).
        const modelCtx = modelContexts[doc.model];
        const budget = modelCtx ? Math.floor(modelCtx * 0.75) : 16000;
        let acc = estTokens(sysPrompt);
        let start = history.length;
        for (let i = history.length - 1; i >= 0; i--) {
          if (history.length - i > cmCfg.value) break;            // cap: N messages
          const tk = msgTokens(history[i]);
          if (acc + tk > budget && start < history.length) break; // cap: token budget
          acc += tk;
          start = i;
        }
        history = history.slice(start);
      } else if (doc.params.autoSummary) {
        // TOKEN-based compaction against the real model window (auto = 75% of the window).
        const modelCtx = modelContexts[doc.model];
        const budget = modelCtx ? Math.floor(modelCtx * 0.75) : 16000;

        // Start from the existing summary: never resend what has already been summarised.
        let upTo = doc.summary ? doc.summary.upTo : 0;
        summaryText = doc.summary?.text ?? '';

        const fixed = estTokens(sysPrompt) + estTokens(summaryText);
        let total = fixed;
        for (let i = upTo; i < history.length; i++) total += msgTokens(history[i]);

        if (total > budget) {
          // Keeps recent messages that fit within ~half the budget.
          const keepBudget = Math.max(1, Math.floor(budget / 2));
          let acc = 0;
          let keepFrom = history.length;
          for (let i = history.length - 1; i >= upTo; i--) {
            const t = msgTokens(history[i]);
            if (acc + t > keepBudget && keepFrom < history.length) break;
            acc += t;
            keepFrom = i;
          }
          const targetUpTo = Math.max(upTo, keepFrom);
          if (targetUpTo > upTo) {
            try {
              summaryText = await ensureSummary(doc, history, targetUpTo);
              upTo = targetUpTo;
            } catch (err: any) {
              webview.postMessage({ type: 'notice', message: tr('⚠️ Could not summarize context: ') + errMsg(err) });
              summaryText = doc.summary?.text ?? '';
            }
          }
        }
        history = history.slice(upTo);
      }

      // After trimming, don't start with assistant/tool (would break function calling and Anthropic/Gemini).
      while (history.length && (history[0].role === 'assistant' || history[0].role === 'tool')) {
        history = history.slice(1);
      }

      const wire: ChatMessage[] = [];
      if (sysPrompt.trim()) wire.push({ role: 'system', content: sysPrompt });
      if (summaryText) {
        wire.push({ role: 'system', content: `Summary of the previous conversation (compacted context):\n${summaryText}` });
      }
      // Role/content/images are sent and, if present, tool fields. Thinking is OMITTED.
      wire.push(...history.map((m) => {
        let content = m.content;
        const resolved = (m.attachments ?? []).map(resolveAtt);
        const media = resolved.filter((a) => a.kind === 'image' || a.kind === 'document');
        for (const f of resolved.filter((a) => a.kind === 'text')) {
          content += `\n\n[Attached file: ${f.name}]\n${f.data ?? ''}`;
        }
        const wm: ChatMessage = { role: m.role, content };
        if (media.length) wm.attachments = media;
        if (m.toolCalls) wm.toolCalls = m.toolCalls;
        if (m.toolCallId) wm.toolCallId = m.toolCallId;
        if (m.toolName) wm.toolName = m.toolName;
        return wm;
      }));

      const params = resolveGenerationParams(doc.params);
      if (allowTools && doc.params.tools) {
        try {
          await toolHub.ensureStarted();
          const schemas = toolHub.schemas();
          if (schemas.length) params.tools = schemas;
          if (toolHub.mcpErrors().length) {
            webview.postMessage({ type: 'notice', message: tr('⚠️ Some MCP servers failed to start: ') + toolHub.mcpErrors().join('; ') });
          }
        } catch { /* no tools if it fails */ }
      }

      let answer = '';
      let thinking = '';
      let failed = false;
      let aborted = false;
      let usage: any = undefined;
      let images: { mime: string; data: string }[] = [];

      // Agentic loop: if the model requests tools, they are executed and fed back.
      // A single AbortController for the ENTIRE turn: so Stop also cuts between
      // iterations and before executing the next tool (not only during chat()).
      const ac = new AbortController();
      abort = ac;
      const MAX_ITERS = 8;
      for (let iter = 0; iter < MAX_ITERS; iter++) {
        if (ac.signal.aborted) { aborted = true; break; }
        const id = `m_${Date.now().toString(36)}_${iter}`;
        webview.postMessage({ type: 'streamStart', id });
        let res: { answer: string; thinking: string; toolCalls?: any[]; usage?: any; images?: { mime: string; data: string }[] } = { answer: '', thinking: '' };
        try {
          res = await buildProvider(doc.provider).chat(doc.model, wire, params, {
            signal: ac.signal,
            onDelta: (delta) => { webview.postMessage({ type: 'streamDelta', id, delta }); },
            onReasoning: (delta) => { webview.postMessage({ type: 'streamReasoning', id, delta }); },
          });
        } catch (err: any) {
          if (ac.signal.aborted) aborted = true;
          else { webview.postMessage({ type: 'error', message: errMsg(err) }); failed = true; }
        }
        webview.postMessage({ type: 'streamEnd', id });
        if (res.usage) usage = addUsage(usage, res.usage);
        if (res.images?.length) images = images.concat(res.images);
        answer = res.answer;
        thinking = res.thinking;

        if (failed || aborted || !res.toolCalls || !res.toolCalls.length) break;

        // The model requested tools: persist the call, execute, and feed back.
        const callMsg: ChatMessage = { role: 'assistant', content: res.answer, toolCalls: res.toolCalls };
        if (res.thinking) callMsg.thinking = res.thinking;
        wire.push(callMsg);
        const fresh = getDoc();
        fresh?.messages.push(callMsg);

        for (const tc of res.toolCalls) {
          if (ac.signal.aborted) { aborted = true; break; } // Stop before the next tool
          let out: string;
          let args: any = {};
          try { args = JSON.parse(tc.arguments || '{}'); } catch { /* empty args */ }
          webview.postMessage({ type: 'toolCall', name: tc.name, args: tc.arguments || '' });
          try {
            out = await toolHub.call(tc.name, args);
          } catch (e: any) {
            out = 'Error: ' + (e?.message ?? e);
          }
          webview.postMessage({ type: 'toolResult', name: tc.name, content: out });
          const toolMsg: ChatMessage = { role: 'tool', content: out, toolCallId: tc.id, toolName: tc.name };
          wire.push(toolMsg);
          fresh?.messages.push(toolMsg);
        }
        // Intermediate write in the tool-loop: no save() or prune (done once at the end of the turn).
        if (fresh) await writeDoc(fresh, { save: false, prune: false });
        sendHistory();
        if (aborted) break;
        // next iteration: the model sees the results
      }
      if (abort === ac) abort = undefined; // release the turn's controller

      if (!failed && !answer && !thinking && !images.length && !aborted) {
        webview.postMessage({
          type: 'error',
          message: tr('The model returned no content. Try another model; on OpenRouter, check the key\'s credits/limits.'),
        });
      }
      return { answer, thinking, failed, usage, images };
    };

    const handleSend = async (text: string, attachments?: any[]): Promise<void> => {
      text = (text ?? '').trim();
      const atts = sanitizeAttachments(attachments);
      if (!text && !atts.length) return;
      const doc = getDoc();
      if (!doc) return;
      if (!doc.model) {
        webview.postMessage({ type: 'error', message: tr('No model selected. Make sure the backend is active and press ⟳.') });
        return;
      }

      const userMsg: ChatMessage = { role: 'user', content: text };
      if (atts.length) userMsg.attachments = await storeAttachments(atts); // blobs → .attach, message holds only refs
      doc.messages.push(userMsg);
      const onlyUser = doc.messages.filter((m) => m.role === 'user').length === 1;
      if (onlyUser && (!doc.title || doc.title === 'New chat')) {
        const base = text || atts[0]?.name || 'Attachment';
        doc.title = base.length > 40 ? base.slice(0, 40) + '…' : base;
      }
      await writeDoc(doc);

      const { answer, thinking, failed, usage, images } = await runInference(doc, doc.messages, true);
      if (!failed && (answer || thinking || images.length)) {
        const fresh = getDoc();
        if (fresh) {
          const m: ChatMessage = { role: 'assistant', content: answer };
          if (thinking) m.thinking = thinking;
          if (usage) m.usage = usage;
          if (images.length) m.attachments = await storeGenImages(images);
          fresh.messages.push(m);
          await writeDoc(fresh);
        }
      }
      sendHistory();
    };

    // Generates a response when the conversation ends with a user message
    // (e.g. after an error, a cancellation, or having deleted the response).
    const handleGenerate = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc) return;
      if (!doc.model) {
        webview.postMessage({ type: 'error', message: tr('No model selected. Make sure the backend is active and press ⟳.') });
        return;
      }
      const last = doc.messages[doc.messages.length - 1];
      if (!last || last.role !== 'user') return;

      const { answer, thinking, failed, usage, images } = await runInference(doc, doc.messages, true);
      if (!failed && (answer || thinking || images.length)) {
        const fresh = getDoc();
        if (fresh) {
          const m: ChatMessage = { role: 'assistant', content: answer };
          if (thinking) m.thinking = thinking;
          if (usage) m.usage = usage;
          if (images.length) m.attachments = await storeGenImages(images);
          fresh.messages.push(m);
          await writeDoc(fresh);
        }
      }
      sendHistory();
    };

    // Fork: clones the conversation up to `index` (inclusive) into a new .chat and opens it.
    const handleFork = async (index: number, fromHere = false): Promise<void> => {
      const doc = getDoc();
      if (!doc) return;
      if (!Number.isInteger(index) || index < 0 || index >= doc.messages.length) return;

      // Normal: clones up to here (inclusive). ⌥/Alt: clones FROM here to the end.
      const sliced = fromHere ? doc.messages.slice(index) : doc.messages.slice(0, index + 1);
      const forked: ChatDoc = {
        ...doc,
        title: doc.title + ' (' + tr('fork') + ')',
        messages: sliced,
        // The summary references old indices; it remains valid in an "up to here" fork
        // only if it covers within the slice. In "from here" it is discarded (origin changes).
        summary: !fromHere && doc.summary && doc.summary.upTo <= sliced.length ? doc.summary : undefined,
        usage: undefined, // usage is derived from the present messages
      };

      // Available name next to the current file.
      const cur = document.uri;
      const dir = vscode.Uri.joinPath(cur, '..');
      const file = cur.path.slice(cur.path.lastIndexOf('/') + 1);
      const stem = file.replace(/\.chat$/i, '');
      let target = cur;
      for (let n = 1; ; n++) {
        const name = `${stem} (fork${n > 1 ? ' ' + n : ''}).chat`;
        target = vscode.Uri.joinPath(dir, name);
        try {
          await vscode.workspace.fs.stat(target); // exists → try next
        } catch {
          break; // free
        }
      }

      await vscode.workspace.fs.writeFile(target, Buffer.from(serializeDoc(forked), 'utf8'));

      // Copies referenced attachments to the fork's sidecar (same ids).
      const refIds = new Set<string>();
      for (const m of sliced) {
        for (const a of (m.attachments ?? [])) if (a.ref) refIds.add(a.ref);
        for (const v of (m.variants ?? [])) for (const a of (v.attachments ?? [])) if (a.ref) refIds.add(a.ref);
      }
      if (refIds.size) {
        const src = loadAttach();
        const dst: Record<string, any> = {};
        for (const id of refIds) if (src[id]) dst[id] = src[id];
        const forkStem = path.basename(target.fsPath).replace(/\.chat$/i, '');
        const forkAttach = vscode.Uri.joinPath(target, '..', forkStem + '.attach');
        await vscode.workspace.fs.writeFile(forkAttach, Buffer.from(JSON.stringify(dst) + '\n', 'utf8'));
      }

      await vscode.commands.executeCommand('vscode.openWith', target, ChatEditorProvider.viewType);
    };

    // Continues the last assistant response: appends the new generation.
    const handleContinue = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc || !doc.model) return;
      const lastIdx = doc.messages.length - 1;
      if (lastIdx < 0 || doc.messages[lastIdx].role !== 'assistant') return;

      // Context = full history + an ephemeral continue instruction (not saved).
      const ctx: ChatMessage[] = [
        ...doc.messages,
        { role: 'user', content: 'Continue exactly from where you left off, expanding your previous response. Do not repeat what you already wrote, do not greet or summarize; keep writing.' },
      ];

      const { answer, thinking, failed, usage } = await runInference(doc, ctx);
      if (failed || !answer) { sendHistory(); return; }

      const fresh = getDoc();
      const target = fresh?.messages[lastIdx];
      if (!fresh || !target || target.role !== 'assistant') { sendHistory(); return; }

      const sep = /\s$/.test(target.content) ? '' : ' ';
      target.content = target.content + sep + answer;
      if (thinking) target.thinking = (target.thinking ? target.thinking + '\n\n' : '') + thinking;
      // Continue is another call: accumulate its token usage.
      if (usage) target.usage = addUsage(target.usage, usage);
      // If the response has variants, append to the active one (content and usage).
      if (Array.isArray(target.variants) && typeof target.active === 'number' && target.variants[target.active]) {
        const av = target.variants[target.active];
        av.content = target.content;
        if (thinking) av.thinking = target.thinking;
        if (usage) av.usage = addUsage(av.usage, usage);
      }
      await writeDoc(fresh);
      sendHistory();
    };

    // Reprocesses the last instruction: regenerates the last assistant response,
    // saving it as a new variant (without losing previous ones).
    const handleRegenerate = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc || !doc.model) return;
      let idx = -1;
      for (let i = doc.messages.length - 1; i >= 0; i--) {
        if (doc.messages[i].role === 'assistant') { idx = i; break; }
      }
      if (idx < 0) return;

      const { answer, thinking, failed, usage, images } = await runInference(doc, doc.messages.slice(0, idx));
      if (failed || (!answer && !thinking && !images.length)) { sendHistory(); return; }

      const fresh = getDoc();
      const target = fresh?.messages[idx];
      if (!fresh || !target || target.role !== 'assistant') { sendHistory(); return; }

      if (!Array.isArray(target.variants) || target.variants.length === 0) {
        // The original response becomes variant 0 (preserving its usage and any images).
        target.variants = [{ content: target.content, thinking: target.thinking, usage: target.usage, attachments: target.attachments }];
      }
      const variant: any = { content: answer };
      if (thinking) variant.thinking = thinking;
      if (usage) variant.usage = usage;
      if (images.length) variant.attachments = await storeGenImages(images);
      target.variants.push(variant);
      target.active = target.variants.length - 1;
      target.content = answer;
      if (thinking) target.thinking = thinking; else delete target.thinking;
      if (usage) target.usage = usage; else delete target.usage;
      if (variant.attachments) target.attachments = variant.attachments; else delete target.attachments;
      await writeDoc(fresh);
      sendHistory();
    };

    // Changes the active variant of an assistant message.
    const setVariant = async (index: number, variant: number): Promise<void> => {
      const doc = getDoc();
      const t = doc?.messages[index];
      if (!doc || !t || !Array.isArray(t.variants)) return;
      if (variant < 0 || variant >= t.variants.length) return;
      t.active = variant;
      t.content = t.variants[variant].content;
      if (t.variants[variant].thinking) t.thinking = t.variants[variant].thinking; else delete t.thinking;
      if (t.variants[variant].usage) t.usage = t.variants[variant].usage; else delete t.usage;
      if (t.variants[variant].attachments) t.attachments = t.variants[variant].attachments; else delete t.attachments;
      await writeDoc(doc);
      sendHistory();
    };

    // Deletes a variant (only if more than one exists). When one remains, collapses to a simple response.
    const deleteVariant = async (index: number, variant: number): Promise<void> => {
      const doc = getDoc();
      const t = doc?.messages[index];
      if (!doc || !t || !Array.isArray(t.variants) || t.variants.length <= 1) return;
      if (variant < 0 || variant >= t.variants.length) return;
      t.variants.splice(variant, 1);
      if (t.variants.length <= 1) {
        const only = t.variants[0];
        t.content = only.content;
        if (only.thinking) t.thinking = only.thinking; else delete t.thinking;
        if (only.usage) t.usage = only.usage; else delete t.usage;
        if (only.attachments) t.attachments = only.attachments; else delete t.attachments;
        delete t.variants;
        delete t.active;
      } else {
        const a = Math.min(t.active ?? 0, t.variants.length - 1);
        t.active = a;
        t.content = t.variants[a].content;
        if (t.variants[a].thinking) t.thinking = t.variants[a].thinking; else delete t.thinking;
        if (t.variants[a].usage) t.usage = t.variants[a].usage; else delete t.usage;
        if (t.variants[a].attachments) t.attachments = t.variants[a].attachments; else delete t.attachments;
      }
      await writeDoc(doc);
      sendHistory();
    };

    const sendHistory = (): void => {
      const doc = getDoc();
      // Include `summary`: the summary is created during inference and, without this, the webview
      // would be left with a stale summary (context bar counting the full history + no markers).
      if (doc) webview.postMessage({ type: 'history', messages: resolveDocForView(doc).messages, usage: doc.usage, summary: doc.summary ?? null });
    };

    // Asks for modal confirmation before deleting, unless the webview signals to skip it (Shift).
    const confirmDelete = async (msg: any, text: string): Promise<boolean> => {
      if (msg && msg.confirm === false) return true; // Shift: delete immediately
      const yes = tr('Delete');
      const pick = await vscode.window.showWarningMessage(text, { modal: true }, yes);
      return pick === yes;
    };

    const onMsg = webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg?.type) {
        case 'ready':
          pushLang();
          pushDoc();
          webview.postMessage({ type: 'spellWords', words: await this.spellWords.all() });
          webview.postMessage({ type: 'piperVoices', ids: this.downloadedVoiceIds() });
          await loadModels();
          break;
        case 'spellAddWord':
          // Adds to the active spell-checker language list. The store fires onDidChange →
          // all webviews + the sidebar view are updated.
          if (typeof msg.word === 'string' && (SPELL_LANGS as string[]).includes(msg.lang)) {
            await this.spellWords.add(msg.lang as SpellLang, msg.word);
          }
          break;
        case 'summarizeUpTo': {
          // Summarises context up to message `index` (exclusive), same as the "up to here" fork.
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          if (!doc.params.autoSummary) {
            webview.postMessage({ type: 'notice', message: tr('Enable "Auto-summarize when context fills up" to use the summary.') });
            break;
          }
          const idx = msg.index;
          const currentUpTo = doc.summary ? doc.summary.upTo : 0;
          if (!Number.isInteger(idx) || idx <= currentUpTo || idx > doc.messages.length) {
            webview.postMessage({ type: 'notice', message: tr('Nothing new to summarize.') });
            break;
          }
          busy = true;
          try {
            await ensureSummary(doc, doc.messages, idx);
            pushDoc();
          } catch (err: any) {
            webview.postMessage({ type: 'notice', message: tr('⚠️ Could not summarize context: ') + errMsg(err) });
          } finally { busy = false; }
          break;
        }
        case 'setSummary': {
          // Manual editing of the summary text (does not change its `upTo`).
          if (busy) break;
          const doc = getDoc();
          if (!doc || !doc.summary || typeof msg.text !== 'string') break;
          doc.summary = { text: msg.text, upTo: doc.summary.upTo };
          await writeDoc(doc);
          pushDoc();
          break;
        }
        case 'clearSummary': {
          // Clears the summary: the full history is sent again (recalculated if needed).
          if (busy) break;
          const doc = getDoc();
          if (!doc || !doc.summary) break;
          doc.summary = undefined;
          await writeDoc(doc);
          pushDoc();
          break;
        }
        case 'send':
          if (busy) break;
          busy = true;
          try { await handleSend(msg.text, msg.attachments); } finally { busy = false; }
          break;
        case 'stop':
          abort?.abort();
          break;
        case 'tts':
          await synthPiper(String(msg.text ?? ''), Number(msg.rate) || 1, String(msg.voice ?? ''), Number(msg.id) || 0);
          break;
        case 'ttsStop':
          tlog('ttsStop (cancel)');
          ttsToken++; // cancels the current chunk loop
          killPiper(); // and kills the in-flight piper (avoid wasting CPU)
          break;
        case 'ttsLog':
          tlog('[webview] ' + msg.message + ' ' + (msg.data != null ? JSON.stringify(msg.data) : ''));
          break;
        case 'ttsUpdate':
          try {
            const voice = String(msg.voice ?? '');
            const notice = (m: string) => webview.postMessage({ type: 'notice', message: m });
            const isVoice = !!voice && /^[a-z]{2}_[A-Z]{2}-/.test(voice);
            if (isVoice) removePiperVoice(vscode.Uri.joinPath(this.context.globalStorageUri, 'piper-voices').fsPath, voice);
            await this.piper.update(notice);          // updates the engine (pip upgrade)
            if (isVoice) await this.piper.ensureVoice(voice, notice); // re-downloads the voice
          } catch (e: any) {
            webview.postMessage({ type: 'ttsError', message: tr('Could not set up Piper: ') + (e?.message ?? e) });
          }
          break;
        case 'setConfig': {
          if (busy) break; // do not mutate the doc while an inference is writing
          const doc = getDoc();
          if (!doc) break;
          const before = doc.provider;
          applyPatch(doc, msg.patch);
          await writeDoc(doc);
          if (doc.provider !== before) await loadModels();
          break;
        }
        case 'deleteMessage': {
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          const i = msg.index;
          if (Number.isInteger(i) && i >= 0 && i < doc.messages.length) {
            if (!(await confirmDelete(msg, tr('Delete this message?')))) break;
            // Also drags the adjacent HIDDEN tool chain (assistant with toolCalls + 'tool' results)
            // on BOTH sides: before (complete turn) and after (broken turn without a final response).
            // Otherwise they would remain orphaned in the JSON.
            let start = i;
            let end = i;
            while (start > 0 && isHiddenToolMsg(doc.messages[start - 1])) start--;
            while (end + 1 < doc.messages.length && isHiddenToolMsg(doc.messages[end + 1])) end++;
            doc.messages.splice(start, end - start + 1);
            // If only tool remnants remain (no displayable message), clear entirely.
            if (!doc.messages.some((m) => !isHiddenToolMsg(m))) doc.messages = [];
            doc.summary = undefined; // summary indices changed
            await writeDoc(doc);
            sendHistory();
          }
          break;
        }
        case 'deleteFrom': {
          // Deletes message `index` and all subsequent ones (⌥/Alt + trash).
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          const i = msg.index;
          if (Number.isInteger(i) && i >= 0 && i < doc.messages.length) {
            if (!(await confirmDelete(msg, tr('Delete this message and all below?')))) break;
            // Includes the hidden tool chain preceding the cut point.
            let start = i;
            while (start > 0 && isHiddenToolMsg(doc.messages[start - 1])) start--;
            doc.messages.splice(start); // removes from start to the end
            doc.summary = undefined;
            await writeDoc(doc);
            sendHistory();
          }
          break;
        }
        case 'mergeMessage': {
          // Merges message `index` with the previous one (same role) into a single message.
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          const i = msg.index;
          if (
            Number.isInteger(i) && i > 0 && i < doc.messages.length &&
            doc.messages[i].role === doc.messages[i - 1].role
          ) {
            const prev = doc.messages[i - 1];
            const cur = doc.messages[i];
            prev.content = `${prev.content}\n\n${cur.content}`.trim();
            const merged = [prev.thinking, cur.thinking].filter(Boolean).join('\n\n');
            if (merged) prev.thinking = merged;
            doc.messages.splice(i, 1);
            doc.summary = undefined; // summary indices changed
            await writeDoc(doc);
            sendHistory();
          }
          break;
        }
        case 'editMessage': {
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          const i = msg.index;
          if (Number.isInteger(i) && i >= 0 && i < doc.messages.length && typeof msg.content === 'string') {
            const m = doc.messages[i];
            m.content = msg.content;
            // If the message has variants, edit the active one.
            if (Array.isArray(m.variants) && typeof m.active === 'number' && m.variants[m.active]) {
              m.variants[m.active].content = msg.content;
            }
            doc.summary = undefined; // content changed: invalidate the summary
            await writeDoc(doc);
            sendHistory();
          }
          break;
        }
        case 'regenerate':
          if (busy) break;
          busy = true;
          try { await handleRegenerate(); } finally { busy = false; }
          break;
        case 'continue':
          if (busy) break;
          busy = true;
          try { await handleContinue(); } finally { busy = false; }
          break;
        case 'fork':
          if (busy) break;
          if (Number.isInteger(msg.index)) {
            busy = true;
            try { await handleFork(msg.index, msg.fromHere === true); } finally { busy = false; }
          }
          break;
        case 'regenerateFrom': {
          // Regenerates the response to a user message: discards everything after it
          // (old response, partial tool-calls…) and runs inference again.
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          const i = msg.index;
          if (!Number.isInteger(i) || i < 0 || i >= doc.messages.length || doc.messages[i].role !== 'user') break;
          busy = true; // blocks re-entrancy BEFORE mutating/writing
          try {
            if (i + 1 < doc.messages.length) {
              doc.messages.splice(i + 1); // leaves the prompt as the last message
              doc.summary = undefined;
              await writeDoc(doc);
              sendHistory();
            }
            await handleGenerate();
          } finally { busy = false; }
          break;
        }
        case 'setVariant':
          if (!busy && Number.isInteger(msg.index) && Number.isInteger(msg.variant)) {
            await setVariant(msg.index, msg.variant);
          }
          break;
        case 'deleteVariant':
          if (!busy && Number.isInteger(msg.index) && Number.isInteger(msg.variant)) {
            if (!(await confirmDelete(msg, tr('Delete this variant?')))) break;
            await deleteVariant(msg.index, msg.variant);
          }
          break;
        case 'refreshModels':
          await loadModels();
          break;
        case 'copy':
          if (typeof msg.text === 'string') await vscode.env.clipboard.writeText(msg.text);
          break;
        case 'atFiles': {
          // @-mention autocomplete: return workspace files matching the partial query.
          const files = await searchFiles(typeof msg.q === 'string' ? msg.q : '');
          webview.postMessage({ type: 'atFilesResult', q: msg.q, reqId: msg.reqId, files });
          break;
        }
        case 'saveImage': {
          // Saves a generated image of message `index` (the active variant) to disk via a native dialog.
          const doc = getDoc();
          const m = doc?.messages[msg.index];
          if (!m) break;
          const img = (m.attachments ?? []).map(resolveAtt).find((a) => a.kind === 'image' && a.data);
          if (!img) break;
          const ext = /jpe?g/i.test(img.mime) ? 'jpg' : /webp/i.test(img.mime) ? 'webp' : /gif/i.test(img.mime) ? 'gif' : 'png';
          // Default to the workspace folder (fall back to the .chat's folder, then home).
          const saveDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || path.dirname(document.uri.fsPath)
            || os.homedir();
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(saveDir, img.name || `image.${ext}`)),
            filters: { [tr('Image')]: [ext] },
          });
          if (!target) break;
          await vscode.workspace.fs.writeFile(target, Buffer.from(img.data, 'base64'));
          break;
        }
        case 'exportHtml': {
          // Writes a self-contained HTML file and opens it in the browser (which can print it → Save as PDF).
          const safe = String(msg.title || 'chat').replace(/[^\w\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 40);
          const file = vscode.Uri.file(path.join(os.tmpdir(), `parley-${safe}-${Date.now()}.html`));
          await vscode.workspace.fs.writeFile(file, Buffer.from(String(msg.html || ''), 'utf8'));
          await vscode.env.openExternal(file);
          // Deletes the temp file after giving the browser time to load it (otherwise they pile up in /tmp).
          setTimeout(() => { try { fs.unlinkSync(file.fsPath); } catch { /* nothing */ } }, 60000);
          break;
        }
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'parley');
          break;
        case 'createSysPrompt': {
          // Creates a .md file (with the current inline prompt) next to the .chat, references it and opens it.
          const doc = getDoc();
          if (!doc) break;
          const dir = vscode.Uri.joinPath(document.uri, '..');
          const stem = path.basename(document.uri.fsPath).replace(/\.chat$/i, '') || 'system';
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(dir, `${stem}.md`),
            filters: { 'System prompt': ['md', 'sysprompt', 'txt'] },
            saveLabel: tr('Create .md'),
          });
          if (!target) break;
          await vscode.workspace.fs.writeFile(target, Buffer.from(doc.systemPrompt || '', 'utf8'));
          doc.systemPromptFile = path.relative(dir.fsPath, target.fsPath);
          await writeDoc(doc);
          pushDoc();
          await vscode.commands.executeCommand('vscode.open', target);
          break;
        }
        case 'pickSysPrompt': {
          const doc = getDoc();
          if (!doc) break;
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'System prompt': ['md', 'sysprompt', 'txt'] },
            openLabel: tr('Use as system prompt'),
          });
          if (!picked || !picked[0]) break;
          const dir = vscode.Uri.joinPath(document.uri, '..');
          doc.systemPromptFile = path.relative(dir.fsPath, picked[0].fsPath);
          await writeDoc(doc);
          pushDoc();
          // Warn at pick time if it lives outside the workspace: it would be ignored at send time.
          if (!sysPromptPathAllowed(picked[0].fsPath)) {
            void vscode.window.showWarningMessage(
              tr('This file is outside the workspace, so it will not be used as the system prompt. Move it inside the project folder.')
            );
          }
          break;
        }
        case 'openSysPrompt': {
          const doc = getDoc();
          if (!doc || !doc.systemPromptFile) break;
          // Same allow-list as resolveSystemPrompt (.chat folder + workspace): a manually edited
          // systemPromptFile cannot open files outside (e.g. ../../etc/passwd).
          const resolved = path.resolve(path.dirname(document.uri.fsPath), doc.systemPromptFile);
          if (!sysPromptPathAllowed(resolved)) break;
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved));
          break;
        }
        case 'clearSysPrompt': {
          const doc = getDoc();
          if (!doc) break;
          doc.systemPromptFile = undefined;
          await writeDoc(doc);
          pushDoc();
          break;
        }
      }
    });

    // Syncs external document changes (manual JSON editing) without overwriting the in-progress
    // streaming (which we ourselves triggered).
    const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (document.getText() === lastWritten) return; // our own edit: already reflected in the webview
      // The .chat is a TextDocument, but the chat owns its history (delete/edit/regenerate/fork).
      // VS Code's text undo/redo steps through the many internal writes of a turn, erratically
      // reverting or duplicating messages. Neutralize it: snap the document back to the last state
      // we wrote. (The webview keeps native undo inside its own input fields via execCommand.)
      if (lastWritten !== null &&
          (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo)) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
          document.uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          lastWritten
        );
        void vscode.workspace.applyEdit(edit);
        return;
      }
      pushDoc();
    });

    // The models view can apply a provider+model to the currently focused chat.
    const applyConfig = async (patch: any): Promise<void> => {
      if (busy) return;
      const doc = getDoc();
      if (!doc) return;
      const before = doc.provider;
      applyPatch(doc, patch);
      await writeDoc(doc);
      if (doc.provider !== before) await loadModels();
      pushDoc();
    };
    // Points to the LAST active chat. We don't clear it on focus loss: if we did, focusing the
    // sidebar to "Use in chat" would lose the reference. It is only cleared on dispose.
    const setActive = (active: boolean): void => {
      if (active) ChatEditorProvider.activeApply = applyConfig;
    };
    setActive(panel.active);
    const onState = panel.onDidChangeViewState(() => setActive(panel.active));

    // Any change to the personal dictionary (panel, another chat) → refreshes this webview.
    const onSpell = this.spellWords.onDidChange(async () => webview.postMessage({ type: 'spellWords', words: await this.spellWords.all() }));
    // Change in downloaded voices (voices panel, tree) → re-filters the chat selector.
    const onVoices = this.onVoicesChanged(() => webview.postMessage({ type: 'piperVoices', ids: this.downloadedVoiceIds() }));
    // parley.language changed in settings → re-translate the UI live (no reload needed).
    const onLang = this.onLangChanged(() => pushLang());
    panel.onDidDispose(() => {
      abort?.abort();
      onMsg.dispose();
      onChange.dispose();
      onState.dispose();
      onSpell.dispose();
      onVoices.dispose();
      onLang.dispose();
      if (ChatEditorProvider.activeApply === applyConfig) ChatEditorProvider.activeApply = undefined;
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob:`,
      `media-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource}`, // fetch of spell-checker dictionaries
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="${resolvedLang()}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri('style.css')}" rel="stylesheet" />
  <title>Parley</title>
</head>
<body>
  <div id="app">
    <header id="topbar">
      <span id="statusDot" class="checking"></span>
      <span id="statusText">…</span>
      <span id="modelCaps"></span>
      <span id="usageChip" data-i18n-title="Tokens used in this chat" title="Tokens used in this chat"></span>
      <span id="spacer"></span>
      <span id="zoomGroup">
        <button id="zoomOutBtn" class="icon-btn" data-i18n-title="Zoom out (Alt/Option + wheel)" title="Zoom out (Alt/Option + wheel)">${UI.zoomOut}</button>
        <button id="zoomResetBtn" class="icon-btn" data-i18n-title="Reset zoom (Alt/Option + 0)" title="Reset zoom (Alt/Option + 0)">100%</button>
        <button id="zoomInBtn" class="icon-btn" data-i18n-title="Zoom in (Alt/Option + wheel)" title="Zoom in (Alt/Option + wheel)">${UI.zoomIn}</button>
      </span>
      <button id="exportBtn" class="icon-btn" data-i18n-title="Export to PDF (print)" title="Export to PDF (print)">${UI.printer}</button>
      <button id="thinkBtn" class="icon-btn" data-i18n-title="Reasoning panel" title="Reasoning panel">${UI.bulb}</button>
      <button id="toolsBtn" class="icon-btn" data-i18n-title="Tools panel" title="Tools panel">${UI.wrench}</button>
      <button id="configBtn" class="icon-btn" data-i18n-title="This chat's settings" title="This chat's settings">${UI.sliders}</button>
      <button id="settingsBtn" class="icon-btn" data-i18n-title="Connection settings (API keys / URLs)" title="Connection settings (API keys / URLs)">${UI.key}</button>
    </header>

    <div id="workspace">
      <div id="chat">
        <div id="findBar" class="hidden">
          <span class="find-ico">🔎</span>
          <input id="findInput" type="text" spellcheck="false" data-i18n-ph="Search in chat…" placeholder="Search in chat…" />
          <span id="findCount"></span>
          <button id="findPrev" class="icon-btn" data-i18n-title="Previous match (Shift+Enter)" title="Previous match (Shift+Enter)">▲</button>
          <button id="findNext" class="icon-btn" data-i18n-title="Next match (Enter)" title="Next match (Enter)">▼</button>
          <button id="findClose" class="icon-btn" data-i18n-title="Close (Esc)" title="Close (Esc)">×</button>
        </div>
        <main id="messages"></main>
        <footer id="composer">
          <div id="notices"></div>
          <div id="ctxBar" class="hidden" data-i18n-title="Context window usage" title="Context window usage">
            <div id="ctxTrack"><div id="ctxFill"></div></div>
            <span id="ctxLabel"></span>
          </div>
          <div id="inputBox">
            <div id="emojiPicker" class="hidden"></div>
            <div id="attachments" class="hidden"></div>
            <div id="inputWrap">
              <div id="inputBackdrop" aria-hidden="true"></div>
              <textarea id="input" rows="1" spellcheck="false" data-i18n-ph="Type a message…  (Enter to send · Shift+Enter for newline)" placeholder="Type a message…  (Enter to send · Shift+Enter for newline)"></textarea>
            </div>
            <div id="inputToolbar">
              <button id="attachBtn" class="icon-btn" data-i18n-title="Attach image or file" title="Attach image or file">${UI.clip}</button>
              <button id="emojiBtn" class="icon-btn" title="Emojis">${UI.smile}</button>
              <span class="grow"></span>
              <button id="stopBtn" class="hidden" data-i18n-title="Stop" title="Stop">■</button>
              <button id="sendBtn" data-i18n-title="Send" title="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
            </div>
          </div>
          <input id="fileInput" type="file" multiple accept="image/*,application/pdf,.pdf,.docx,.doc,.txt,.md,.json,.csv,.js,.ts,.tsx,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.html,.css,.xml,.yaml,.yml,.toml,.ini,.sh,.sql,.log" />
        </footer>
      </div>

      <div id="sidepanels" class="hidden">
        <section id="config" class="hidden">
          <div class="panel-head">
            <span>⚙ <span data-i18n="Settings">Settings</span></span>
            <button id="configClose" class="icon-btn" data-i18n-title="Hide" title="Hide">×</button>
          </div>
          <div id="configBody">
            <div class="cfg-row">
              <label>Backend</label>
              <select id="providerSelect" title="Backend">
                <option value="openai">LM Studio / OpenAI</option>
                <option value="ollama">Ollama</option>
                <option value="gemini">Google Gemini</option>
                <option value="anthropic">Anthropic Claude</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>
            <div class="cfg-row">
              <label data-i18n="Model">Model</label>
              <div id="modelRow">
                <select id="modelSelect" data-i18n-title="Model" title="Model"></select>
                <span id="modelCtx" data-i18n-title="Model context window" title="Model context window"></span>
                <button id="refreshBtn" class="icon-btn" data-i18n-title="Reload models" title="Reload models">${UI.refresh}</button>
              </div>
            </div>
            <div class="cfg-row">
              <label data-i18n="Spell-check">Spell-check</label>
              <select id="spellSelect" data-i18n-title="Spell-check language" title="Spell-check language">
                <option value="auto" data-i18n="Automatic (system)">Automatic (system)</option>
                <option value="off" data-i18n="Off">Off</option>
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="pt">Português</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="it">Italiano</option>
              </select>
            </div>
            <div id="configFields"></div>
          </div>
        </section>

        <aside id="thinking" class="hidden">
          <div class="panel-head">
            <span>${UI.bulb} <span data-i18n="Reasoning">Reasoning</span></span>
            <button id="thinkClose" class="icon-btn" data-i18n-title="Hide" title="Hide">×</button>
          </div>
          <div id="thinkContent" class="empty" data-i18n="The model's reasoning will appear here.">The model's reasoning will appear here.</div>
        </aside>

        <aside id="tools" class="hidden">
          <div class="panel-head">
            <span>${UI.wrench} <span data-i18n="Tools">Tools</span></span>
            <button id="toolsClose" class="icon-btn" data-i18n-title="Hide" title="Hide">×</button>
          </div>
          <div id="toolsContent" class="empty" data-i18n="Tool calls will appear here.">Tool calls will appear here.</div>
        </aside>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">window.SPELL_DICTS = {
    es: { aff: '${uri('dict/es.aff')}', dic: '${uri('dict/es.dic')}' },
    en: { aff: '${uri('dict/en.aff')}', dic: '${uri('dict/en.dic')}' },
    pt: { aff: '${uri('dict/pt.aff')}', dic: '${uri('dict/pt.dic')}' },
    fr: { aff: '${uri('dict/fr.aff')}', dic: '${uri('dict/fr.dic')}' },
    de: { aff: '${uri('dict/de.aff')}', dic: '${uri('dict/de.dic')}' },
    it: { aff: '${uri('dict/it.aff')}', dic: '${uri('dict/it.dic')}' }
  };
  window.DOWNLOADED_VOICES = ${JSON.stringify(this.downloadedVoiceIds())};
  window.PIPER_CUSTOM_SET = ${JSON.stringify(!!vscode.workspace.getConfiguration('parley').get<string>('tts.piperModel', ''))};
  window.I18N_LANG = ${JSON.stringify(resolvedLang())};
  window.I18N_BUNDLE = ${JSON.stringify(activeBundle())};</script>
  <script nonce="${nonce}" src="${uri('zoom.js')}"></script>
  <script nonce="${nonce}" src="${uri('i18n.js')}"></script>
  <script nonce="${nonce}" src="${uri('spell-engine.js')}"></script>
  <script nonce="${nonce}" src="${uri('spell.js')}"></script>
  <script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}

/** Adds two token-usage records together. */
function addUsage(a: any, b: any): any {
  if (!b) return a;
  if (!a) return { ...b };
  const out: any = {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
  };
  const cost = (a.cost || 0) + (b.cost || 0);
  if (cost) out.cost = cost;
  return out;
}

/** Rough token estimate (~4 characters per token). */
function estTokens(s?: string): number {
  return s ? Math.ceil(s.length / 4) : 0;
}
function msgTokens(m: ChatMessage): number {
  let t = estTokens(m.content) + 4;
  for (const a of m.attachments ?? []) t += a.kind === 'image' ? 1200 : estTokens(a.data);
  return t;
}

/** Is this an internal tool message (hidden in the UI)? An assistant with toolCalls or a 'tool' result. */
function isHiddenToolMsg(m: ChatMessage): boolean {
  return m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
}

/** Validates and limits the attachments arriving from the webview. */
function sanitizeAttachments(input: any): { kind: 'image' | 'text' | 'document'; name: string; mime: string; data: string }[] {
  if (!Array.isArray(input)) return [];
  const out: { kind: 'image' | 'text' | 'document'; name: string; mime: string; data: string }[] = [];
  for (const a of input.slice(0, 10)) {
    if (!a || (a.kind !== 'image' && a.kind !== 'text' && a.kind !== 'document')) continue;
    if (typeof a.data !== 'string' || !a.data) continue;
    out.push({
      kind: a.kind,
      name: typeof a.name === 'string' ? a.name : 'attachment',
      mime: typeof a.mime === 'string' ? a.mime : (a.kind === 'image' ? 'image/png' : 'text/plain'),
      data: a.data,
    });
  }
  return out;
}

const TOGGLE_KEYS: (keyof ChatParams)[] = [
  'maxTokens', 'contextMessages', 'contextLength', 'numThreads', 'topK', 'topP', 'minP', 'topA',
  'repeatPenalty', 'presencePenalty', 'frequencyPenalty', 'seed',
];

/** Applies to `doc` only the valid keys arriving from the webview (including nested config). */
function applyPatch(doc: ChatDoc, patch: any): void {
  if (!patch || typeof patch !== 'object') return;
  if (typeof patch.title === 'string') doc.title = patch.title;
  if (isProviderId(patch.provider)) {
    doc.provider = patch.provider;
  }
  if (typeof patch.model === 'string') doc.model = patch.model;
  if (typeof patch.systemPrompt === 'string') doc.systemPrompt = patch.systemPrompt;
  if (['auto', 'off', ...SPELL_LANGS].includes(patch.spellLang)) doc.spellLang = patch.spellLang;

  const p = patch.params;
  if (p && typeof p === 'object') {
    if (typeof p.temperature === 'number' && !Number.isNaN(p.temperature)) {
      doc.params.temperature = p.temperature;
    }
    if (Array.isArray(p.stop)) {
      doc.params.stop = p.stop.filter((s: any) => typeof s === 'string');
    }
    if (typeof p.thinking === 'boolean') {
      doc.params.thinking = p.thinking;
    }
    if (typeof p.autoSummary === 'boolean') {
      doc.params.autoSummary = p.autoSummary;
    }
    if (typeof p.tools === 'boolean') {
      doc.params.tools = p.tools;
    }
    for (const key of TOGGLE_KEYS) {
      const incoming = p[key];
      if (!incoming || typeof incoming !== 'object') continue;
      const current = doc.params[key] as { enabled: boolean; value: number };
      if (typeof incoming.enabled === 'boolean') current.enabled = incoming.enabled;
      if (typeof incoming.value === 'number' && !Number.isNaN(incoming.value)) {
        current.value = incoming.value;
      }
    }
  }
}

function errMsg(err: any): string {
  const m = err?.message ?? String(err);
  if (/fetch failed|ECONNREFUSED|Failed to fetch/i.test(m)) {
    return 'Could not connect to the backend. Is LM Studio / Ollama running? Check the URL in settings (🔧).';
  }
  return m;
}

// Line icons (monochrome, inherit currentColor) for the toolbar and headers.
const SVG = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const UI = {
  printer: SVG('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  bulb: SVG('<line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>'),
  wrench: SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  sliders: SVG('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  key: SVG('<circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.4 11.6 21 2"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  refresh: SVG('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  clip: SVG('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  smile: SVG('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>'),
  zoomIn: SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'),
  zoomOut: SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>'),
};

function makeNonce(): string {
  // Cryptographic randomness (not Math.random) for the CSP nonce.
  return crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
