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
import { ModelsTreeProvider } from './modelsView';
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
import { tr, resolvedLang } from './i18n';
import { registerCompare } from './compareView';
import { SpellWordsStore, SpellLang } from './spellWords';
import { openDictionaryPanel } from './dictionaryPanel';
import { openVoicesPanel } from './voicesPanel';
import { removePiperVoice, listPiperVoices } from './piperVoices';
import { PiperManager } from './piper/manager';

// Hub de tools (filesystem nativo + servidores MCP), compartido por todos los chats.
const toolHub = new ToolHub();

// Backends que usan API key (Ollama no). El secret se guarda como `langChat.<id>.apiKey`.
const KEY_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'openai', label: 'LM Studio / OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openrouter', label: 'OpenRouter' },
];

/** Carga las API keys de SecretStorage (cifradas) a los overrides del provider. */
async function loadApiKeys(context: vscode.ExtensionContext): Promise<void> {
  for (const { id } of KEY_PROVIDERS) {
    const k = await context.secrets.get(`langChat.${id}.apiKey`);
    setApiKeyOverride(id, k || undefined);
  }
}

/** Extrae el id de repo HF de un nombre de modelo local de Ollama (`hf.co/user/repo:quant` → `user/repo`). */
function localModelHfId(name?: string): string | undefined {
  if (!name || !/^hf\.co\//i.test(name)) return undefined;
  const id = name.replace(/^hf\.co\//i, '').replace(/:[^:/]+$/, '');
  return id || undefined;
}

export function activate(context: vscode.ExtensionContext) {
  const spellWords = new SpellWordsStore(context);
  context.subscriptions.push(spellWords);
  const piper = new PiperManager(context);
  // Avisa a los chats abiertos cuando cambia el set de voces descargadas (panel/árbol) para
  // que el selector de voz del chat solo muestre las descargadas.
  const voicesChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(voicesChanged);
  const provider = new ChatEditorProvider(context, spellWords, piper, voicesChanged.event);

  registerCompare(context); // comando de comparación de versiones (Timeline / paleta)

  initProxy(); // configura el proxy (http.proxy / env) para todas las peticiones
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('http')) initProxy(); })
  );
  void loadApiKeys(context); // poblar overrides desde SecretStorage al arrancar
  // Si los secrets cambian (otra ventana, o el comando), recarga.
  context.secrets.onDidChange((e) => { if (e.key.startsWith('langChat.') && e.key.endsWith('.apiKey')) void loadApiKeys(context); });

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(ChatEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('langChat.new', () => createNewChat()),
    vscode.commands.registerCommand('langChat.spell.openDictionary', (item: any) => {
      const lang = item?.word === 'en' ? 'en' : 'es'; // el nodo lleva el idioma en `word`
      openDictionaryPanel(context, spellWords, lang);
    }),
    vscode.commands.registerCommand('langChat.setApiKey', async () => {
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
      if (key === undefined) return; // cancelado
      const secretKey = `langChat.${pick.id}.apiKey`;
      if (key) await context.secrets.store(secretKey, key);
      else await context.secrets.delete(secretKey);
      setApiKeyOverride(pick.id, key || undefined);
      vscode.window.showInformationMessage(`${tr('API key for')} ${pick.label} ${key ? tr('saved') : tr('deleted')} ${tr('(encrypted in SecretStorage).')}`);
    })
  );

  // ---- Modelos locales (Ollama gestionado + explorador) ----
  const ollama = new OllamaManager(context, (s) => {
    if (vscode.workspace.getConfiguration('langChat').get<boolean>('tts.debug', false)) console.log(s);
  });
  // Publica el baseUrl gestionado para que el provider Ollama lo use cuando esté listo.
  ollama.onDidChangeStatus(() => setManagedOllamaBaseUrl(ollama.status === 'ready' ? ollama.baseUrl() : undefined));
  const needServer = async (): Promise<string | undefined> => {
    try {
      // Si está listo, vuelve al instante; si no, muestra progreso (la 1ª vez baja el binario).
      if (ollama.status === 'ready') return ollama.baseUrl();
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Ollama' },
        () => ollama.start((received, total) => { void received; void total; })
      );
    } catch (e: any) { vscode.window.showErrorMessage(`Ollama: ${e?.message || e}`); return undefined; }
  };
  // Descargas persistentes (sobreviven a reinicios) que auto-arrancan el servidor al (re)intentar.
  const downloads = new DownloadManager(
    () => needServer(),
    (name, modelPath, projPath) => ollama.create(name, modelPath, projPath),
    () => modelsTree.refresh(),
    context.globalState,
    path.join(context.globalStorageUri.fsPath, 'imports')
  );
  const piperVoicesDir = vscode.Uri.joinPath(context.globalStorageUri, 'piper-voices').fsPath;
  const modelsTree = new ModelsTreeProvider(ollama, downloads, spellWords, piperVoicesDir, piper);
  // Caché de fichas (sidecar): ver/encolar guarda la info de HF; cancelar/eliminar la borra.
  const cards = new ModelCardCache(path.join(context.globalStorageUri.fsPath, 'model-cards'));
  const panelHooks = {
    onChanged: () => modelsTree.refresh(),
    useModel: async (name: string) => {
      if (ChatEditorProvider.activeApply) { await ChatEditorProvider.activeApply({ provider: 'ollama', model: name }); return true; }
      return false;
    },
  };

  // Instala/actualiza un motor mostrando progreso. (Ollama "update" = reinstala la versión pineada.)
  const runEngineTask = async (which: any, action: 'install' | 'update'): Promise<void> => {
    if (which !== 'ollama' && which !== 'piper') return;
    const name = which === 'ollama' ? 'Ollama' : 'Piper';
    const title = (action === 'install' ? tr('Installing engine…') : tr('Updating engine…')) + ` (${name})`;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (p) => {
        const notify = (m: string) => p.report({ message: m });
        if (which === 'ollama') {
          if (action === 'update') ollama.deleteBinary();
          await ollama.ensureBinary();
        } else if (action === 'update') {
          await piper.update(notify);
        } else {
          await piper.install(notify);
        }
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`${name}: ${e?.message ?? e}`);
    }
    modelsTree.refresh();
  };

  context.subscriptions.push(
    ollama,
    downloads,
    piper, // dispose() apaga el daemon HTTP al desactivar la extensión
    vscode.window.registerTreeDataProvider('langChat.models', modelsTree),
    vscode.commands.registerCommand('langChat.models.add', () => ModelsPanel.show(context, ollama, downloads, cards, panelHooks)),
    vscode.commands.registerCommand('langChat.models.openModelFromDownload', (item: any) => {
      const modelId = item?.download?.modelId;
      if (!modelId) return;
      ModelsPanel.show(context, ollama, downloads, cards, panelHooks);
      ModelsPanel.revealModel(modelId);
    }),
    vscode.commands.registerCommand('langChat.models.cancelDownload', (item: any) => {
      if (item?.download) { cards.remove(item.download.modelId); downloads.cancel(item.download.id); }
    }),
    vscode.commands.registerCommand('langChat.models.retryDownload', (item: any) => {
      if (item?.download?.id) downloads.retry(item.download.id);
    }),
    vscode.commands.registerCommand('langChat.models.removeDownload', (item: any) => {
      if (item?.download) { cards.remove(item.download.modelId); downloads.remove(item.download.id); }
    }),
    vscode.commands.registerCommand('langChat.models.clearDownloads', () => downloads.clearFinished()),
    vscode.commands.registerCommand('langChat.models.refresh', () => modelsTree.refresh()),
    vscode.commands.registerCommand('langChat.tts.openVoices', () => {
      openVoicesPanel(context, piper, piperVoicesDir, () => { modelsTree.refresh(); voicesChanged.fire(); });
    }),
    vscode.commands.registerCommand('langChat.tts.removeVoice', async (item: any) => {
      const id = item?.word; // el nodo de voz lleva el id en `word`
      if (typeof id !== 'string') return;
      const yes = tr('Delete');
      const pick = await vscode.window.showWarningMessage(tr('Delete this voice?') + ` (${id})`, { modal: true }, yes);
      if (pick !== yes) return;
      removePiperVoice(piperVoicesDir, id);
      modelsTree.refresh();
      voicesChanged.fire();
    }),
    vscode.commands.registerCommand('langChat.engine.install', (item: any) => runEngineTask(item?.word, 'install')),
    vscode.commands.registerCommand('langChat.engine.update', (item: any) => runEngineTask(item?.word, 'update')),
    vscode.commands.registerCommand('langChat.engine.delete', async (item: any) => {
      const which = item?.word;
      if (which !== 'ollama' && which !== 'piper') return;
      const name = which === 'ollama' ? 'Ollama' : 'Piper';
      const yes = tr('Delete');
      if (await vscode.window.showWarningMessage(tr('Delete this engine?') + ` (${name})`, { modal: true }, yes) !== yes) return;
      if (which === 'ollama') { ollama.deleteBinary(); cards.clear(); } else { piper.delete(); voicesChanged.fire(); }
      modelsTree.refresh();
    }),
    vscode.commands.registerCommand('langChat.models.startServer', async () => { await needServer(); }),
    vscode.commands.registerCommand('langChat.models.stopServer', () => { ollama.stop(); }),
    vscode.commands.registerCommand('langChat.models.deleteModel', async (item: any) => {
      const name = item?.model?.name; const baseUrl = ollama.baseUrl();
      if (!name || !baseUrl) return;
      const ok = await vscode.window.showWarningMessage(`${tr('Delete the model')} ${name}?`, { modal: true }, tr('Delete'));
      if (ok !== tr('Delete')) return;
      try { await removeModel(baseUrl, name); modelsTree.refresh(); }
      catch (e: any) { vscode.window.showErrorMessage(`${tr('Could not delete: ')}${e?.message || e}`); }
    }),
    vscode.commands.registerCommand('langChat.models.openLocalModel', (item: any) => {
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

/** Crea un nuevo archivo `.chat` (pidiendo destino) y lo abre con el editor de chat. */
async function createNewChat(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = folder
    ? vscode.Uri.joinPath(folder, 'nuevo.chat')
    : undefined;

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: tr('Create chat'),
    filters: { 'Lang Chat': ['chat'] },
  });
  if (!target) return;

  const doc = defaultDoc(chatDefaults());
  await vscode.workspace.fs.writeFile(target, Buffer.from(serializeDoc(doc), 'utf8'));
  await vscode.commands.executeCommand('vscode.openWith', target, ChatEditorProvider.viewType);
}

class ChatEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'langChat.editor';
  /** Applier del chat enfocado: la vista de modelos lo usa para "usar este modelo". */
  static activeApply: ((patch: any) => Promise<void>) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly spellWords: SpellWordsStore,
    private readonly piper: PiperManager,
    private readonly onVoicesChanged: vscode.Event<void>
  ) {}

  /** Voces Piper descargadas (ids), para que el chat solo ofrezca esas en su selector. */
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

    // Texto que escribimos nosotros: para distinguir nuestras ediciones de las externas.
    let lastWritten: string | null = null;
    let abort: AbortController | undefined;
    let busy = false; // hay una inferencia en curso: rechaza solicitudes nuevas
    let ttsToken = 0; // identifica la petición TTS actual; al cambiar, se cancela el bucle de trozos
    let currentPiperProc: any = null; // proceso piper en curso, para poder matarlo al cancelar
    const killPiper = () => { if (currentPiperProc) { try { currentPiperProc.kill(); } catch { /* nada */ } currentPiperProc = null; } };
    // Traza de TTS a archivo (para depurar sin depender de la consola del webview).
    const tlog = (s: string) => {
      // Solo traza si el usuario activa el debug (por defecto off).
      if (!vscode.workspace.getConfiguration('langChat').get<boolean>('tts.debug', false)) return;
      try { console.log('[TTS]', s); } catch { /* nada */ }
      try { fs.appendFileSync(path.join(os.tmpdir(), 'langchat-tts.log'), new Date().toISOString() + ' ' + s + '\n'); } catch { /* nada */ }
    };
    let modelContexts: Record<string, number> = {}; // id de modelo -> tokens de contexto
    // Caché del parseo del documento por versión: parseDoc valida/normaliza en cada llamada y
    // getDoc se invoca muchas veces por operación. Devolvemos un clon para no corromper la caché.
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

    // `save`/`prune` se pueden desactivar para escrituras intermedias (p. ej. cada iteración
    // del tool-loop): se aplican una sola vez al final del turno y se evita re-volcar a disco
    // y re-escribir el sidecar de adjuntos en cada paso (coste O(n) por iteración).
    const writeDoc = async (doc: ChatDoc, opts?: { save?: boolean; prune?: boolean }): Promise<void> => {
      const save = opts?.save !== false;
      const prune = opts?.prune !== false;
      // Sella id + timestamp en cada mensaje que aún no los tenga (un solo punto para todos).
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
      // Persiste a disco para que la configuración no se pierda.
      if (save && !document.isUntitled) {
        await document.save();
      }
      // Limpia adjuntos huérfanos del sidecar tras cada cambio persistido.
      if (prune) await pruneAttach(doc);
    };

    const pushDoc = (): void => {
      const doc = getDoc();
      if (doc) webview.postMessage({ type: 'doc', doc: resolveDocForView(doc) });
    };

    // Envía el idioma efectivo + la preferencia cruda al webview.
    const pushLang = (): void => {
      const pref = vscode.workspace.getConfiguration('langChat').get<string>('language', 'auto');
      webview.postMessage({ type: 'lang', lang: resolvedLang(), pref });
    };

    // TTS neural con Piper: parte el texto en frases y envía cada trozo como WAV en base64.
    // Así suena el primer fragmento enseguida y no se generan WAV gigantes en mensajes largos.
    // `voice` es un id de voz curada (se descarga solo); si está vacío usa la ruta de los ajustes.
    const synthPiper = async (text: string, rate: number, voice: string, reqId: number): Promise<void> => {
      const t = text.trim();
      if (!t) return;
      const myToken = ++ttsToken; // cualquier petición/stop posterior cancela ésta
      const cancelled = () => myToken !== ttsToken;
      killPiper(); // mata cualquier piper de una petición anterior aún en vuelo
      tlog(`req#${reqId} recibido (engine=piper, rate=${rate}, voice=${voice || '(setting)'})`);
      // Todos los mensajes TTS llevan el id de petición para que el webview filtre los obsoletos.
      const post = (m: any) => webview.postMessage({ ...m, id: reqId });
      const notice = (m: string) => webview.postMessage({ type: 'notice', message: m });
      const cfg = vscode.workspace.getConfiguration('langChat');
      const speaker = cfg.get<number>('tts.piperSpeaker', -1);
      const isCurated = !!voice && /^[a-z]{2}_[A-Z]{2}-/.test(voice);
      // Vía DAEMON (modelo residente, rápido): solo voces curadas. Cualquier fallo cae al
      // spawn-por-trozo de abajo, así que no hay regresión si el server no arranca.
      if (isCurated) {
        try {
          const modelPath = await this.piper.ensureVoice(voice, notice);
          if (cancelled()) return;
          const baseUrl = await this.piper.ensureServer(modelPath, notice);
          if (cancelled()) return;
          const lscale = rate > 0 ? 1 / rate : 1;
          const wav = await this.piper.synthViaServer(baseUrl, t, voice, lscale, typeof speaker === 'number' ? speaker : -1);
          if (cancelled()) return;
          tlog(`req#${reqId} OK vía daemon: WAV ${wav.length} bytes`);
          post({ type: 'ttsAudio', data: wav.toString('base64'), last: true });
          post({ type: 'ttsDone' });
          return;
        } catch (e: any) {
          tlog(`req#${reqId} daemon falló (${e?.message ?? e}); fallback a spawn-por-trozo`);
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
        post({ type: 'ttsError', message: tr('No voice available. Download one from the Lang Chat panel (Voices ➕), or set a custom .onnx path in Settings (langChat.tts.piperModel).') });
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

      // Sintetiza un trozo y devuelve el Buffer del WAV (o un error).
      const synthChunk = (chunk: string): Promise<{ ok: boolean; buf?: Buffer; err?: string }> =>
        new Promise((resolve) => {
          const out = path.join(os.tmpdir(), `langchat-tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
          const args = ['--model', model, '--output_file', out, '--length_scale', lengthScale];
          if (typeof speaker === 'number' && speaker >= 0) args.push('--speaker', String(speaker));
          let proc: any;
          try {
            proc = cp.spawn(bin, args, { cwd: libDir, env });
          } catch (e: any) {
            return resolve({ ok: false, err: e?.message ?? String(e) });
          }
          currentPiperProc = proc; // para poder matarlo si se cancela
          let stderr = '';
          proc.stderr?.on('data', (d: any) => { stderr += d.toString(); });
          proc.on('error', (e: any) => {
            if (currentPiperProc === proc) currentPiperProc = null;
            try { fs.unlinkSync(out); } catch { /* no creado / ya borrado */ }
            resolve({ ok: false, err: e?.message ?? String(e) });
          });
          proc.on('close', (code: number) => {
            if (currentPiperProc === proc) currentPiperProc = null;
            try {
              if (code === 0 && fs.existsSync(out)) resolve({ ok: true, buf: fs.readFileSync(out) });
              else resolve({ ok: false, err: stderr.trim() || `exit ${code}` });
            } finally {
              try { fs.unlinkSync(out); } catch { /* ya borrado */ }
            }
          });
          proc.stdin?.write(chunk);
          proc.stdin?.end();
        });

      // Sintetiza cada frase por separado (rápido) y las concatena en UN solo WAV.
      const chunks = splitForTTS(t);
      tlog(`req#${reqId} bin=${bin.split('/').slice(-3).join('/')} chars=${t.length} trozos=${chunks.length}`);
      if (chunks.length > 1) webview.postMessage({ type: 'notice', message: tr('Generating audio…') });
      const bufs: Buffer[] = [];
      let lastErr = '';
      for (let i = 0; i < chunks.length; i++) {
        if (cancelled()) { tlog(`req#${reqId} cancelado en trozo ${i}`); return; }
        const r = await synthChunk(chunks[i]);
        if (cancelled()) { tlog(`req#${reqId} cancelado tras trozo ${i}`); return; }
        if (r.ok && r.buf) bufs.push(r.buf);
        else { lastErr = r.err || ''; tlog(`req#${reqId} trozo ${i} FALLÓ: ${lastErr}`); }
      }
      if (cancelled()) return;
      if (!bufs.length) { tlog(`req#${reqId} sin audio: ${lastErr}`); post({ type: 'ttsError', message: tr('Piper failed: ') + lastErr }); return; }
      const wav = concatWavs(bufs);
      tlog(`req#${reqId} OK: ${bufs.length} trozos → WAV ${wav.length} bytes (~${(wavData(wav).len / (22050 * 2)).toFixed(1)}s); enviando`);
      // Un único WAV → una sola reproducción en el webview (sin cadenas frágiles).
      post({ type: 'ttsAudio', data: wav.toString('base64'), last: true });
      post({ type: 'ttsDone' });
    };

    // System prompt efectivo: el del archivo .md referenciado, si existe; si no, el inline.
    const resolveSystemPrompt = (doc: ChatDoc): string => {
      if (doc.systemPromptFile) {
        try {
          const dir = path.dirname(document.uri.fsPath);
          const resolved = path.resolve(dir, doc.systemPromptFile);
          // Confina al directorio del .chat: el archivo no puede apuntar fuera (p. ej. ../../etc/passwd).
          if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
            throw new Error('systemPromptFile fuera del directorio del .chat');
          }
          const text = fs.readFileSync(resolved, 'utf8');
          if (text.trim()) return text;
        } catch {
          /* ausente o fuera de límites: cae al inline */
        }
      }
      return doc.systemPrompt || '';
    };

    // ---- Sidecar de adjuntos (.attach): los blobs viven aquí, el .chat solo referencia ----
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
    // Guarda los blobs nuevos en el sidecar y devuelve adjuntos con solo {kind,name,mime,ref}.
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
    // Devuelve un adjunto con `data` resuelto (desde el sidecar si es ref, o inline antiguo).
    const resolveAtt = (a: any): any => {
      if (typeof a?.data === 'string') return a; // inline antiguo
      if (a?.ref) {
        const e = loadAttach()[a.ref];
        if (e) return { kind: a.kind, name: a.name || e.name, mime: a.mime || e.mime, data: e.data };
      }
      return a;
    };
    // Quita del sidecar las entradas que ya no referencia ningún mensaje (al borrar/fusionar/bifurcar).
    const pruneAttach = async (doc: ChatDoc): Promise<void> => {
      if (!attachCache) return; // solo si hay/hubo adjuntos cargados
      const used = new Set<string>();
      for (const m of doc.messages) for (const a of (m.attachments ?? [])) if (a.ref) used.add(a.ref);
      let changed = false;
      for (const id of Object.keys(attachCache)) {
        if (!used.has(id)) { delete attachCache[id]; changed = true; }
      }
      if (!changed) return;
      if (Object.keys(attachCache).length === 0) {
        try { await vscode.workspace.fs.delete(attachUri()); } catch { /* ya no existe */ }
      } else {
        await vscode.workspace.fs.writeFile(attachUri(), Buffer.from(JSON.stringify(attachCache) + '\n', 'utf8'));
      }
    };

    // Copia del doc con los adjuntos resueltos (para webview), sin tocar el doc que se persiste.
    const resolveDocForView = (doc: ChatDoc): ChatDoc => ({
      ...doc,
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
        // Filtro global de vendors de OpenRouter (prefijo antes de '/').
        if (doc.provider === 'openrouter') {
          const vendors = vscode.workspace
            .getConfiguration('langChat')
            .get<string[]>('openrouter.vendors', []);
          if (vendors.length) {
            models = models.filter((m) => vendors.includes(m.id.split('/')[0]));
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

    // Llama al modelo para resumir un bloque de mensajes (sin streaming a la UI).
    const summarizeMessages = async (
      doc: ChatDoc,
      prevText: string,
      msgs: ChatMessage[]
    ): Promise<string> => {
      const convo = msgs
        .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
        .join('\n\n');
      const instruction =
        (prevText
          ? `Resumen previo de la conversación:\n${prevText}\n\nIntegra los siguientes mensajes nuevos en un único resumen actualizado.`
          : 'Resume la siguiente conversación.') +
        '\nConserva hechos, decisiones, datos, nombres y tareas pendientes. Sé conciso. Devuelve solo el resumen, en español.\n\n--- Conversación ---\n' +
        convo;
      const wire: ChatMessage[] = [
        { role: 'system', content: 'Eres un asistente que resume conversaciones para preservar el contexto.' },
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
      // Algunos modelos de razonamiento devuelven el texto solo en el canal de thinking.
      return (text.trim() || reasoning.trim());
    };

    // Garantiza un resumen que cubra messages[0..targetUpTo); lo extiende de forma incremental.
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
      webview.postMessage({ type: 'notice', message: tr('🗜️ Summarizing previous context…') });
      const text = await summarizeMessages(doc, prev?.text ?? '', block);
      if (text) {
        doc.summary = { text, upTo: targetUpTo };
        await writeDoc(doc);
      }
      return doc.summary?.text ?? '';
    };

    // Ejecuta una inferencia en streaming sobre `context`. Devuelve lo acumulado.
    // Con `allowTools`, ejecuta el bucle agéntico (tools MCP / filesystem nativo).
    const runInference = async (
      doc: ChatDoc,
      context: ChatMessage[],
      allowTools = false
    ): Promise<{ answer: string; thinking: string; failed: boolean; usage?: any }> => {
      let history = context;
      let summaryText = '';

      if (doc.params.autoSummary) {
        // Compactación por TOKENS contra la ventana real del modelo.
        const modelCtx = modelContexts[doc.model];
        const budget = doc.params.contextBudget.enabled && doc.params.contextBudget.value > 0
          ? doc.params.contextBudget.value
          : (modelCtx ? Math.floor(modelCtx * 0.75) : 16000);

        // Parte del resumen ya existente: nunca reenviamos lo ya resumido.
        let upTo = doc.summary ? doc.summary.upTo : 0;
        summaryText = doc.summary?.text ?? '';

        const fixed = estTokens(doc.systemPrompt) + estTokens(summaryText);
        let total = fixed;
        for (let i = upTo; i < history.length; i++) total += msgTokens(history[i]);

        if (total > budget) {
          // Conserva los mensajes recientes que quepan en ~la mitad del presupuesto.
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
      } else {
        // Sin resumen: ventana simple por nº de mensajes (si está activada).
        const cm = doc.params.contextMessages;
        if (cm.enabled && cm.value > 0 && history.length > cm.value) {
          history = history.slice(history.length - cm.value);
        }
      }

      // Tras recortar, no empieces por assistant/tool (rompería function calling y Anthropic/Gemini).
      while (history.length && (history[0].role === 'assistant' || history[0].role === 'tool')) {
        history = history.slice(1);
      }

      const wire: ChatMessage[] = [];
      const sysPrompt = resolveSystemPrompt(doc);
      if (sysPrompt.trim()) wire.push({ role: 'system', content: sysPrompt });
      if (summaryText) {
        wire.push({ role: 'system', content: `Resumen de la conversación previa (contexto compactado):\n${summaryText}` });
      }
      // Se envían rol/contenido/imágenes y, si los hay, los campos de tools. El thinking se OMITE.
      wire.push(...history.map((m) => {
        let content = m.content;
        const resolved = (m.attachments ?? []).map(resolveAtt);
        const media = resolved.filter((a) => a.kind === 'image' || a.kind === 'document');
        for (const f of resolved.filter((a) => a.kind === 'text')) {
          content += `\n\n[Archivo adjunto: ${f.name}]\n${f.data ?? ''}`;
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
        } catch { /* sin tools si falla */ }
      }

      let answer = '';
      let thinking = '';
      let failed = false;
      let aborted = false;
      let usage: any = undefined;

      // Bucle agéntico: si el modelo pide tools, se ejecutan y se realimentan.
      // Un único AbortController para TODO el turno: así Stop corta también entre
      // iteraciones y antes de ejecutar la siguiente tool (no solo durante el chat()).
      const ac = new AbortController();
      abort = ac;
      const MAX_ITERS = 8;
      for (let iter = 0; iter < MAX_ITERS; iter++) {
        if (ac.signal.aborted) { aborted = true; break; }
        const id = `m_${Date.now().toString(36)}_${iter}`;
        webview.postMessage({ type: 'streamStart', id });
        let res: { answer: string; thinking: string; toolCalls?: any[]; usage?: any } = { answer: '', thinking: '' };
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
        answer = res.answer;
        thinking = res.thinking;

        if (failed || aborted || !res.toolCalls || !res.toolCalls.length) break;

        // El modelo pidió tools: persiste la llamada, ejecuta y realimenta.
        const callMsg: ChatMessage = { role: 'assistant', content: res.answer, toolCalls: res.toolCalls };
        if (res.thinking) callMsg.thinking = res.thinking;
        wire.push(callMsg);
        const fresh = getDoc();
        fresh?.messages.push(callMsg);

        for (const tc of res.toolCalls) {
          if (ac.signal.aborted) { aborted = true; break; } // Stop antes de la siguiente tool
          let out: string;
          let args: any = {};
          try { args = JSON.parse(tc.arguments || '{}'); } catch { /* args vacíos */ }
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
        // Escritura intermedia del tool-loop: sin save() ni prune (se hacen una vez al final del turno).
        if (fresh) await writeDoc(fresh, { save: false, prune: false });
        sendHistory();
        if (aborted) break;
        // siguiente iteración: el modelo ve los resultados
      }
      if (abort === ac) abort = undefined; // libera el controller del turno

      if (!failed && !answer && !thinking && !aborted) {
        webview.postMessage({
          type: 'error',
          message: tr('The model returned no content. Try another model; on OpenRouter, check the key\'s credits/limits.'),
        });
      }
      return { answer, thinking, failed, usage };
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
      if (atts.length) userMsg.attachments = await storeAttachments(atts); // blobs → .attach, mensaje solo refs
      doc.messages.push(userMsg);
      const onlyUser = doc.messages.filter((m) => m.role === 'user').length === 1;
      if (onlyUser && (!doc.title || doc.title === 'Nuevo chat')) {
        const base = text || atts[0]?.name || 'Adjunto';
        doc.title = base.length > 40 ? base.slice(0, 40) + '…' : base;
      }
      await writeDoc(doc);

      const { answer, thinking, failed, usage } = await runInference(doc, doc.messages, true);
      if (!failed && (answer || thinking)) {
        const fresh = getDoc();
        if (fresh) {
          const m: ChatMessage = { role: 'assistant', content: answer };
          if (thinking) m.thinking = thinking;
          if (usage) m.usage = usage;
          fresh.messages.push(m);
          await writeDoc(fresh);
        }
      }
      sendHistory();
    };

    // Genera una respuesta cuando la conversación termina en un mensaje del usuario
    // (p. ej. tras un error, una cancelación o haber borrado la respuesta).
    const handleGenerate = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc) return;
      if (!doc.model) {
        webview.postMessage({ type: 'error', message: tr('No model selected. Make sure the backend is active and press ⟳.') });
        return;
      }
      const last = doc.messages[doc.messages.length - 1];
      if (!last || last.role !== 'user') return;

      const { answer, thinking, failed, usage } = await runInference(doc, doc.messages, true);
      if (!failed && (answer || thinking)) {
        const fresh = getDoc();
        if (fresh) {
          const m: ChatMessage = { role: 'assistant', content: answer };
          if (thinking) m.thinking = thinking;
          if (usage) m.usage = usage;
          fresh.messages.push(m);
          await writeDoc(fresh);
        }
      }
      sendHistory();
    };

    // Bifurca: clona la conversación hasta `index` (incluido) en un nuevo .chat y lo abre.
    const handleFork = async (index: number, fromHere = false): Promise<void> => {
      const doc = getDoc();
      if (!doc) return;
      if (!Number.isInteger(index) || index < 0 || index >= doc.messages.length) return;

      // Normal: clona hasta aquí (incluido). ⌥/Alt: clona DESDE aquí hasta el final.
      const sliced = fromHere ? doc.messages.slice(index) : doc.messages.slice(0, index + 1);
      const forked: ChatDoc = {
        ...doc,
        title: doc.title + ' (' + tr('fork') + ')',
        messages: sliced,
        // El resumen referencia índices viejos; solo sigue válido en el fork "hasta aquí"
        // si cubre dentro del recorte. En "desde aquí" se descarta (cambia el origen).
        summary: !fromHere && doc.summary && doc.summary.upTo <= sliced.length ? doc.summary : undefined,
        usage: undefined, // el uso se deriva de los mensajes presentes
      };

      // Nombre disponible junto al archivo actual.
      const cur = document.uri;
      const dir = vscode.Uri.joinPath(cur, '..');
      const file = cur.path.slice(cur.path.lastIndexOf('/') + 1);
      const stem = file.replace(/\.chat$/i, '');
      let target = cur;
      for (let n = 1; ; n++) {
        const name = `${stem} (bifurcación${n > 1 ? ' ' + n : ''}).chat`;
        target = vscode.Uri.joinPath(dir, name);
        try {
          await vscode.workspace.fs.stat(target); // existe → probar siguiente
        } catch {
          break; // libre
        }
      }

      await vscode.workspace.fs.writeFile(target, Buffer.from(serializeDoc(forked), 'utf8'));

      // Copia los adjuntos referenciados al sidecar del fork (mismos ids).
      const refIds = new Set<string>();
      for (const m of sliced) for (const a of (m.attachments ?? [])) if (a.ref) refIds.add(a.ref);
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

    // Continúa la última respuesta del asistente: anexa la nueva generación.
    const handleContinue = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc || !doc.model) return;
      const lastIdx = doc.messages.length - 1;
      if (lastIdx < 0 || doc.messages[lastIdx].role !== 'assistant') return;

      // Contexto = historial completo + una instrucción efímera de continuar (no se guarda).
      const ctx: ChatMessage[] = [
        ...doc.messages,
        { role: 'user', content: 'Continúa exactamente desde donde lo dejaste, ampliando tu respuesta anterior. No repitas lo ya escrito, no saludes ni hagas resúmenes; sigue redactando.' },
      ];

      const { answer, thinking, failed, usage } = await runInference(doc, ctx);
      if (failed || !answer) { sendHistory(); return; }

      const fresh = getDoc();
      const target = fresh?.messages[lastIdx];
      if (!fresh || !target || target.role !== 'assistant') { sendHistory(); return; }

      const sep = /\s$/.test(target.content) ? '' : ' ';
      target.content = target.content + sep + answer;
      if (thinking) target.thinking = (target.thinking ? target.thinking + '\n\n' : '') + thinking;
      // Continuar es otra llamada: acumula su uso de tokens.
      if (usage) target.usage = addUsage(target.usage, usage);
      // Si la respuesta tiene variantes, anexa a la activa (contenido y uso).
      if (Array.isArray(target.variants) && typeof target.active === 'number' && target.variants[target.active]) {
        const av = target.variants[target.active];
        av.content = target.content;
        if (thinking) av.thinking = target.thinking;
        if (usage) av.usage = addUsage(av.usage, usage);
      }
      await writeDoc(fresh);
      sendHistory();
    };

    // Reprocesa la última instrucción: regenera la última respuesta del asistente,
    // guardándola como una nueva variante (sin perder las anteriores).
    const handleRegenerate = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc || !doc.model) return;
      let idx = -1;
      for (let i = doc.messages.length - 1; i >= 0; i--) {
        if (doc.messages[i].role === 'assistant') { idx = i; break; }
      }
      if (idx < 0) return;

      const { answer, thinking, failed, usage } = await runInference(doc, doc.messages.slice(0, idx));
      if (failed || (!answer && !thinking)) { sendHistory(); return; }

      const fresh = getDoc();
      const target = fresh?.messages[idx];
      if (!fresh || !target || target.role !== 'assistant') { sendHistory(); return; }

      if (!Array.isArray(target.variants) || target.variants.length === 0) {
        // La respuesta original pasa a ser la variante 0 (conserva su uso de tokens).
        target.variants = [{ content: target.content, thinking: target.thinking, usage: target.usage }];
      }
      const variant: any = { content: answer };
      if (thinking) variant.thinking = thinking;
      if (usage) variant.usage = usage;
      target.variants.push(variant);
      target.active = target.variants.length - 1;
      target.content = answer;
      if (thinking) target.thinking = thinking; else delete target.thinking;
      if (usage) target.usage = usage; else delete target.usage;
      await writeDoc(fresh);
      sendHistory();
    };

    // Cambia la variante activa de un mensaje del asistente.
    const setVariant = async (index: number, variant: number): Promise<void> => {
      const doc = getDoc();
      const t = doc?.messages[index];
      if (!doc || !t || !Array.isArray(t.variants)) return;
      if (variant < 0 || variant >= t.variants.length) return;
      t.active = variant;
      t.content = t.variants[variant].content;
      if (t.variants[variant].thinking) t.thinking = t.variants[variant].thinking; else delete t.thinking;
      if (t.variants[variant].usage) t.usage = t.variants[variant].usage; else delete t.usage;
      await writeDoc(doc);
      sendHistory();
    };

    // Borra una variante (solo si hay más de una). Al quedar una, colapsa a respuesta simple.
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
        delete t.variants;
        delete t.active;
      } else {
        const a = Math.min(t.active ?? 0, t.variants.length - 1);
        t.active = a;
        t.content = t.variants[a].content;
        if (t.variants[a].thinking) t.thinking = t.variants[a].thinking; else delete t.thinking;
        if (t.variants[a].usage) t.usage = t.variants[a].usage; else delete t.usage;
      }
      await writeDoc(doc);
      sendHistory();
    };

    const sendHistory = (): void => {
      const doc = getDoc();
      if (doc) webview.postMessage({ type: 'history', messages: resolveDocForView(doc).messages, usage: doc.usage });
    };

    // Pide confirmación modal antes de borrar, salvo que el webview indique saltarla (Shift).
    const confirmDelete = async (msg: any, text: string): Promise<boolean> => {
      if (msg && msg.confirm === false) return true; // Shift: borra directo
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
          // Agrega a la lista del idioma activo del corrector. El store dispara onDidChange →
          // todos los webviews + la vista lateral se actualizan.
          if (typeof msg.word === 'string' && (msg.lang === 'es' || msg.lang === 'en')) {
            await this.spellWords.add(msg.lang as SpellLang, msg.word);
          }
          break;
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
          ttsToken++; // cancela el bucle de trozos en curso
          killPiper(); // y mata el piper en vuelo (no malgastar CPU)
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
            await this.piper.update(notice);          // actualiza el motor (pip upgrade)
            if (isVoice) await this.piper.ensureVoice(voice, notice); // re-descarga la voz
          } catch (e: any) {
            webview.postMessage({ type: 'ttsError', message: tr('Could not set up Piper: ') + (e?.message ?? e) });
          }
          break;
        case 'setConfig': {
          if (busy) break; // no mutar el doc mientras hay una inferencia escribiendo
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
            // Arrastra la cadena de tools OCULTA adyacente (assistant con toolCalls + resultados
            // 'tool') en AMBOS lados: antes (turno completo) y después (turno roto sin respuesta
            // final). Si no, quedarían huérfanas en el JSON.
            let start = i;
            let end = i;
            while (start > 0 && isHiddenToolMsg(doc.messages[start - 1])) start--;
            while (end + 1 < doc.messages.length && isHiddenToolMsg(doc.messages[end + 1])) end++;
            doc.messages.splice(start, end - start + 1);
            // Si solo quedan restos de tools (ningún mensaje mostrable), limpia del todo.
            if (!doc.messages.some((m) => !isHiddenToolMsg(m))) doc.messages = [];
            doc.summary = undefined; // los índices del resumen cambiaron
            await writeDoc(doc);
            sendHistory();
          }
          break;
        }
        case 'deleteFrom': {
          // Borra el mensaje `index` y todos los posteriores (⌥/Alt + papelera).
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          const i = msg.index;
          if (Number.isInteger(i) && i >= 0 && i < doc.messages.length) {
            if (!(await confirmDelete(msg, tr('Delete this message and all below?')))) break;
            // Incluye la cadena de tools oculta que precede al punto de corte.
            let start = i;
            while (start > 0 && isHiddenToolMsg(doc.messages[start - 1])) start--;
            doc.messages.splice(start); // quita desde start hasta el final
            doc.summary = undefined;
            await writeDoc(doc);
            sendHistory();
          }
          break;
        }
        case 'mergeMessage': {
          // Fusiona el mensaje `index` con el anterior (mismo rol) en uno solo.
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
            doc.summary = undefined; // los índices del resumen cambiaron
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
            // Si el mensaje tiene variantes, edita la activa.
            if (Array.isArray(m.variants) && typeof m.active === 'number' && m.variants[m.active]) {
              m.variants[m.active].content = msg.content;
            }
            doc.summary = undefined; // contenido cambiado: invalida el resumen
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
          // Regenera la respuesta a un mensaje de usuario: descarta todo lo posterior
          // (respuesta vieja, tool-calls a medias…) y vuelve a inferir.
          if (busy) break;
          const doc = getDoc();
          if (!doc) break;
          const i = msg.index;
          if (!Number.isInteger(i) || i < 0 || i >= doc.messages.length || doc.messages[i].role !== 'user') break;
          busy = true; // bloquea reentradas ANTES de mutar/escribir
          try {
            if (i + 1 < doc.messages.length) {
              doc.messages.splice(i + 1); // deja el prompt como último mensaje
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
        case 'exportHtml': {
          // Escribe un HTML autocontenido y lo abre en el navegador (que se imprime solo → Guardar como PDF).
          const safe = String(msg.title || 'chat').replace(/[^\w\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 40);
          const file = vscode.Uri.file(path.join(os.tmpdir(), `langchat-${safe}-${Date.now()}.html`));
          await vscode.workspace.fs.writeFile(file, Buffer.from(String(msg.html || ''), 'utf8'));
          await vscode.env.openExternal(file);
          // Borra el temporal tras dar tiempo a que el navegador lo cargue (si no, se acumulan en /tmp).
          setTimeout(() => { try { fs.unlinkSync(file.fsPath); } catch { /* nada */ } }, 60000);
          break;
        }
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'langChat');
          break;
        case 'createSysPrompt': {
          // Crea un .md (con el prompt inline actual) junto al .chat, lo referencia y lo abre.
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
          break;
        }
        case 'openSysPrompt': {
          const doc = getDoc();
          if (!doc || !doc.systemPromptFile) break;
          // Confina al directorio del .chat (mismo guard que resolveSystemPrompt): un
          // systemPromptFile editado a mano no puede abrir archivos fuera (../../etc/passwd).
          const dir = path.dirname(document.uri.fsPath);
          const resolved = path.resolve(dir, doc.systemPromptFile);
          if (resolved !== dir && !resolved.startsWith(dir + path.sep)) break;
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

    // Sincroniza cambios externos del documento (edición manual del JSON, undo/redo)
    // sin pisar el streaming en curso (que nosotros mismos provocamos).
    const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (document.getText() === lastWritten) return; // edición nuestra: ya reflejada en el webview
      pushDoc();
    });

    // La vista de modelos puede aplicar provider+modelo al chat actualmente enfocado.
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
    // Apunta al ÚLTIMO chat activo. No lo limpiamos al perder foco: si lo hiciéramos, al enfocar la
    // barra lateral para "Usar en el chat" se perdería la referencia. Solo se limpia en dispose.
    const setActive = (active: boolean): void => {
      if (active) ChatEditorProvider.activeApply = applyConfig;
    };
    setActive(panel.active);
    const onState = panel.onDidChangeViewState(() => setActive(panel.active));

    // Cualquier cambio en el diccionario personal (panel, otro chat) → refresca este webview.
    const onSpell = this.spellWords.onDidChange(async () => webview.postMessage({ type: 'spellWords', words: await this.spellWords.all() }));
    // Cambio en las voces descargadas (panel de voces, árbol) → re-filtra el selector del chat.
    const onVoices = this.onVoicesChanged(() => webview.postMessage({ type: 'piperVoices', ids: this.downloadedVoiceIds() }));
    panel.onDidDispose(() => {
      abort?.abort();
      onMsg.dispose();
      onChange.dispose();
      onState.dispose();
      onSpell.dispose();
      onVoices.dispose();
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
      `connect-src ${webview.cspSource}`, // fetch de los diccionarios del corrector
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri('style.css')}" rel="stylesheet" />
  <title>Lang Chat</title>
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
    en: { aff: '${uri('dict/en.aff')}', dic: '${uri('dict/en.dic')}' }
  };
  window.DOWNLOADED_VOICES = ${JSON.stringify(this.downloadedVoiceIds())};
  window.PIPER_CUSTOM_SET = ${JSON.stringify(!!vscode.workspace.getConfiguration('langChat').get<string>('tts.piperModel', ''))};</script>
  <script nonce="${nonce}" src="${uri('zoom.js')}"></script>
  <script nonce="${nonce}" src="${uri('i18n.js')}"></script>
  <script nonce="${nonce}" src="${uri('spell-engine.js')}"></script>
  <script nonce="${nonce}" src="${uri('spell.js')}"></script>
  <script nonce="${nonce}" src="${uri('main.js')}"></script>
</body>
</html>`;
  }
}

/** Suma dos registros de uso de tokens. */
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

/** Estimación aproximada de tokens (~4 caracteres por token). */
function estTokens(s?: string): number {
  return s ? Math.ceil(s.length / 4) : 0;
}
function msgTokens(m: ChatMessage): number {
  let t = estTokens(m.content) + 4;
  for (const a of m.attachments ?? []) t += a.kind === 'image' ? 1200 : estTokens(a.data);
  return t;
}

/** ¿Mensaje interno de tools (oculto en la UI)? El assistant con toolCalls o un resultado 'tool'. */
function isHiddenToolMsg(m: ChatMessage): boolean {
  return m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
}

/** Valida y limita los adjuntos que llegan del webview. */
function sanitizeAttachments(input: any): { kind: 'image' | 'text' | 'document'; name: string; mime: string; data: string }[] {
  if (!Array.isArray(input)) return [];
  const out: { kind: 'image' | 'text' | 'document'; name: string; mime: string; data: string }[] = [];
  for (const a of input.slice(0, 10)) {
    if (!a || (a.kind !== 'image' && a.kind !== 'text' && a.kind !== 'document')) continue;
    if (typeof a.data !== 'string' || !a.data) continue;
    out.push({
      kind: a.kind,
      name: typeof a.name === 'string' ? a.name : 'adjunto',
      mime: typeof a.mime === 'string' ? a.mime : (a.kind === 'image' ? 'image/png' : 'text/plain'),
      data: a.data,
    });
  }
  return out;
}

const TOGGLE_KEYS: (keyof ChatParams)[] = [
  'maxTokens', 'contextMessages', 'contextBudget', 'contextLength', 'numThreads', 'topK', 'topP', 'minP', 'topA',
  'repeatPenalty', 'presencePenalty', 'frequencyPenalty', 'seed',
];

/** Aplica sobre `doc` solo las claves válidas que llegan del webview (incluida la config anidada). */
function applyPatch(doc: ChatDoc, patch: any): void {
  if (!patch || typeof patch !== 'object') return;
  if (typeof patch.title === 'string') doc.title = patch.title;
  if (isProviderId(patch.provider)) {
    doc.provider = patch.provider;
  }
  if (typeof patch.model === 'string') doc.model = patch.model;
  if (typeof patch.systemPrompt === 'string') doc.systemPrompt = patch.systemPrompt;
  if (['auto', 'off', 'es', 'en'].includes(patch.spellLang)) doc.spellLang = patch.spellLang;

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
    return 'No se pudo conectar con el backend. ¿Está LM Studio / Ollama en ejecución? Revisa la URL en los ajustes (🔧).';
  }
  return m;
}

// Iconos de línea (monocromos, heredan currentColor) para la barra y cabeceras.
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
  // Aleatoriedad criptográfica (no Math.random) para el nonce del CSP.
  return crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
