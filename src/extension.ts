import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { chatDefaults, providerInfo, ChatMessage } from './providers';
import {
  ChatDoc,
  parseDoc,
  serializeDoc,
  defaultDoc,
} from './chatDocument';
import { renderWebviewHtml } from './webviewHtml';
import { AttachmentStore } from './attachmentStore';
import { applyPatch, ChatPatch } from './applyPatch';
import { runInference as runInferenceImpl } from './inference';
import { routeMessage, WebviewMessage } from './messageRouter';
import { makeChatOps } from './chatOps';
import { makeTtsBackend } from './ttsBackend';
import { makeSystemPrompt } from './systemPrompt';
import { makeLoadModels } from './loadModels';
import { makeSummary } from './summary';
import { registerLocalModels } from './localModels';
import { estTokens } from './chatHelpers';
import { ToolHub } from './tools';
import { initProxy } from './http';
import { tr, resolvedLang, activeBundle } from './i18n';
import { registerCompare } from './compareView';
import { SpellWordsStore } from './spellWords';
import { openDictionaryPanel } from './dictionaryPanel';
import { listPiperVoices } from './piperVoices';
import { PiperManager } from './piper/manager';
import { errMsg } from './chatHelpers';
import { registerApiKeys } from './apiKeys';

// Tools hub (native filesystem + MCP servers), shared by all chats.
const toolHub = new ToolHub();

export function activate(context: vscode.ExtensionContext) {
  const spellWords = new SpellWordsStore(context);
  context.subscriptions.push(spellWords);
  const piper = new PiperManager(context);
  // Notifies open chats when the set of downloaded voices changes (panel/tree) so that
  // the chat's voice selector only shows downloaded ones.
  const voicesChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(voicesChanged);
  // Notifies open chats when jotflow.language changes, so the UI re-translates live (no reload).
  const langChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(langChanged);
  const provider = new ChatEditorProvider(context, spellWords, piper, voicesChanged.event, langChanged.event);

  registerCompare(context); // version comparison command (Timeline / palette)

  initProxy(); // configures the proxy (http.proxy / env) for all requests
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('http')) initProxy();
      if (e.affectsConfiguration('jotflow.language')) langChanged.fire();
    })
  );
  registerApiKeys(context); // SecretStorage ⇄ overrides + the setApiKey command (apiKeys.ts)

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ChatEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('jotflow.new', () => createNewChat()),
    vscode.commands.registerCommand('jotflow.spell.openDictionary', (item: { word?: string } | undefined) => {
      const lang = item?.word === 'en' ? 'en' : 'es'; // the node carries the language in `word`
      openDictionaryPanel(context, spellWords, lang);
    })
  );

  registerLocalModels(context, { piper, spellWords, voicesChanged, getActiveApply: () => ChatEditorProvider.activeApply() });
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
    filters: { 'Jotflow': ['chat'] },
  });
  if (!target) return;

  const doc = defaultDoc(chatDefaults());
  await vscode.workspace.fs.writeFile(target, Buffer.from(serializeDoc(doc), 'utf8'));
  await vscode.commands.executeCommand('vscode.openWith', target, ChatEditorProvider.viewType);
}

class ChatEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'jotflow.editor';
  // Registry of open chat editors with their config-apply fn, ordered by focus recency (most recent
  // last). The models view's "use this model" targets the focused editor, or the most-recently
  // focused still-open one — so closing a chat that was opened on top of another restores the latter
  // as the target. Replaces the single mutable `activeApply` static (H3/F4 global-state smell).
  private static readonly editors: { apply: (patch: ChatPatch) => Promise<void>; active: boolean }[] = [];
  /** Apply fn of the chat the models view should act on (focused, else most recently focused). */
  static activeApply(): ((patch: ChatPatch) => Promise<void>) | undefined {
    const list = ChatEditorProvider.editors;
    return (list.find((e) => e.active) ?? list[list.length - 1])?.apply;
  }

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
    const abortRef: { current: AbortController | undefined } = { current: undefined };
    const busyRef = { value: false };
    const ttsTokenRef = { value: 0 };
    const { synthPiper, killPiper, tlog } = makeTtsBackend({ webview, piper: this.piper, ttsTokenRef });
    const modelContextsRef = { value: {} as Record<string, number> };
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
      } catch (err) {
        webview.postMessage({ type: 'error', message: tr('The .chat file has invalid JSON: ') + (errMsg(err)) });
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
        if (!m.id) m.id = `msg_${crypto.randomUUID()}`; // collision-free (Date.now()+random collided in a sync loop)
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
      if (prune) await attachStore.prune(doc);
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

    // Roots a systemPromptFile may live in: the .chat's own folder + any workspace folder. Project
    // files are fine; a shared .chat still cannot pull arbitrary files (e.g. ../../etc/passwd) into
    // the prompt and exfiltrate them to the model.
    const { resolveSystemPrompt, readSystemPrompt, sysPromptPathAllowed } = makeSystemPrompt(document);

    // ---- Attachment sidecar (.attach): blobs live here, the .chat only holds references ----
    const attachStore = new AttachmentStore(document.uri);

    // Copy of the doc with resolved attachments (for the webview), without touching the persisted doc.
    // `sysPromptTokens` = tokens of the EFFECTIVE system prompt (file content included): the webview
    // only has the inline `systemPrompt`, so without this its context bar undercounts when a file is used.
    const resolveDocForView = (doc: ChatDoc): ChatDoc & { sysPromptTokens: number } => ({
      ...doc,
      sysPromptTokens: estTokens(readSystemPrompt(doc).text),
      messages: doc.messages.map((m) =>
        m.attachments ? { ...m, attachments: m.attachments.map(attachStore.resolve) } : m
      ),
    });

    const sendStatus = (state: 'checking' | 'ok' | 'error', detail = ''): void => {
      const doc = getDoc();
      if (!doc) return;
      webview.postMessage({ type: 'status', info: providerInfo(doc.provider), state, detail });
    };

    const loadModels = makeLoadModels({ webview, getDoc, writeDoc, sendStatus, modelContextsRef });

    const { ensureSummary } = makeSummary({ webview, writeDoc, abortRef });


    // Runs a streaming inference over `context`. Returns the accumulated result.
    // With `allowTools`, runs the agentic loop (MCP tools / native filesystem).
    const runInference = (doc: ChatDoc, context: ChatMessage[], allowTools = false) =>
      runInferenceImpl(doc, context, allowTools, {
        webview, toolHub, modelContexts: modelContextsRef.value, resolveSystemPrompt, ensureSummary,
        resolveAttachment: attachStore.resolve, getDoc, writeDoc, sendHistory, abortRef,
      });

    const { handleSend, handleGenerate, handleFork, handleContinue, handleRegenerate, setVariant, deleteVariant } =
      makeChatOps({ webview, document, getDoc, writeDoc, sendHistory: () => sendHistory(), runInference, attachStore, viewType: ChatEditorProvider.viewType });
    const sendHistory = (): void => {
      const doc = getDoc();
      // Include `summary`: the summary is created during inference and, without this, the webview
      // would be left with a stale summary (context bar counting the full history + no markers).
      if (doc) webview.postMessage({ type: 'history', messages: resolveDocForView(doc).messages, usage: doc.usage, summary: doc.summary ?? null });
    };

    // Asks for modal confirmation before deleting, unless the webview signals to skip it (Shift).
    const confirmDelete = async (msg: WebviewMessage, text: string): Promise<boolean> => {
      if (msg && msg.confirm === false) return true; // Shift: delete immediately
      const yes = tr('Delete');
      const pick = await vscode.window.showWarningMessage(text, { modal: true }, yes);
      return pick === yes;
    };

    const onMsg = webview.onDidReceiveMessage((msg: WebviewMessage) => void routeMessage(msg, {
      webview, getDoc, writeDoc, pushDoc, pushLang, sendHistory, loadModels,
      handleSend, handleGenerate, handleFork, handleContinue, handleRegenerate, setVariant, deleteVariant,
      ensureSummary, synthPiper, killPiper, resolveSystemPrompt, tlog, applyPatch,
      abortRef, busyRef, ttsTokenRef,
      spellWords: this.spellWords, downloadedVoiceIds: () => this.downloadedVoiceIds(), piper: this.piper,
      globalStorageUri: this.context.globalStorageUri,
      document, searchFiles, sysPromptPathAllowed, confirmDelete, resolveAttachment: attachStore.resolve,
    }).catch((err) => {
      // A throwing handler would otherwise be an unhandled rejection: no log, and the UI left
      // hanging (e.g. a busy state never cleared). Log it and surface it to the webview.
      console.error('[jotflow] message handler failed:', err);
      webview.postMessage({ type: 'error', message: tr('Something went wrong handling that action.') + ' ' + ((err && err.message) || String(err)) });
    }));

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
      if (busyRef.value) return; // don't reconcile/re-render mid-turn — it would disrupt the streaming bubble
      pushDoc();
    });

    // The models view can apply a provider+model to the currently focused chat.
    const applyConfig = async (patch: ChatPatch): Promise<void> => {
      if (busyRef.value) return;
      const doc = getDoc();
      if (!doc) return;
      const before = doc.provider;
      applyPatch(doc, patch);
      await writeDoc(doc);
      if (doc.provider !== before) await loadModels();
      pushDoc();
    };
    // Register this editor; on focus, move it to the end so it becomes the "use in chat" target and
    // the most-recent fallback when focus moves to the sidebar. Removed from the registry on dispose.
    const entry = { apply: applyConfig, active: panel.active };
    ChatEditorProvider.editors.push(entry);
    const onState = panel.onDidChangeViewState(() => {
      entry.active = panel.active;
      if (panel.active) {
        const list = ChatEditorProvider.editors;
        const i = list.indexOf(entry);
        if (i >= 0 && i !== list.length - 1) { list.splice(i, 1); list.push(entry); }
      }
    });

    // Any change to the personal dictionary (panel, another chat) → refreshes this webview.
    const onSpell = this.spellWords.onDidChange(async () => webview.postMessage({ type: 'spellWords', words: await this.spellWords.all() }));
    // Change in downloaded voices (voices panel, tree) → re-filters the chat selector.
    const onVoices = this.onVoicesChanged(() => webview.postMessage({ type: 'piperVoices', ids: this.downloadedVoiceIds() }));
    // jotflow.language changed in settings → re-translate the UI live (no reload needed).
    const onLang = this.onLangChanged(() => pushLang());
    panel.onDidDispose(() => {
      abortRef.current?.abort();
      onMsg.dispose();
      onChange.dispose();
      onState.dispose();
      onSpell.dispose();
      onVoices.dispose();
      onLang.dispose();
      const i = ChatEditorProvider.editors.indexOf(entry);
      if (i >= 0) ChatEditorProvider.editors.splice(i, 1);
    });
  }

  private html(webview: vscode.Webview): string {
    return renderWebviewHtml(webview, {
      extensionUri: this.context.extensionUri,
      lang: resolvedLang(),
      bundle: activeBundle(),
      downloadedVoices: this.downloadedVoiceIds(),
      piperCustomSet: !!vscode.workspace.getConfiguration("jotflow").get<string>("tts.piperModel", ""),
    });
  }
}


