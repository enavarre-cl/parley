import * as vscode from 'vscode';
import * as path from 'path';
import { setManagedOllamaBaseUrl } from './providers';
import { OllamaManager } from './ollama/manager';
import { DownloadManager } from './ollama/downloads';
import { ModelCardCache } from './ollama/cards';
import { ModelsTreeProvider, ModelsTreeItem, Section } from './modelsView';
import { ModelsPanel } from './modelsPanel';
import { remove as removeModel } from './ollama/registry';
import { openVoicesPanel } from './voicesPanel';
import { openEnginesPanel, EnginePanelEngine, EngineStatus } from './enginesPanel';
import { errMsg } from './chatHelpers';
import { ChatPatch } from './applyPatch';
import { removePiperVoice } from './piperVoices';
import { PiperManager, PIPER_TTS_VERSION } from './piper/manager';
import { ChatterboxManager } from './chatterbox/manager';
import { CHATTERBOX_TTS_VERSION, MLX_AUDIO_VERSION, CHATTERBOX_MLX_MODEL } from './chatterbox/assets';
import { removeChatterboxVoice } from './chatterboxVoices';
import { SpellWordsStore } from './spellWords';
import { parseProgressPct as progressPct } from './progress';
import { tr } from './i18n';

/** Extracts the HF repo id from a local Ollama model name (`hf.co/user/repo:quant` → `user/repo`). */
function localModelHfId(name?: string): string | undefined {
  if (!name || !/^hf\.co\//i.test(name)) return undefined;
  const id = name.replace(/^hf\.co\//i, '').replace(/:[^:/]+$/, '');
  return id || undefined;
}

export interface LocalModelsDeps {
  piper: PiperManager;
  chatterbox: ChatterboxManager;
  spellWords: SpellWordsStore;
  voicesChanged: vscode.EventEmitter<void>;
  getActiveApply: () => ((patch: ChatPatch) => Promise<void>) | undefined;
}

/** Local models (managed Ollama + explorer), TTS/engine commands, and their tree views. */
export function registerLocalModels(context: vscode.ExtensionContext, deps: LocalModelsDeps): void {
  const { piper, chatterbox, spellWords, voicesChanged, getActiveApply } = deps;
  // ---- Local models (managed Ollama + explorer) ----
  const ollama = new OllamaManager(context, (s) => {
    if (vscode.workspace.getConfiguration('jotflow').get<boolean>('tts.debug', false)) console.log(s);
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
    } catch (e) { vscode.window.showErrorMessage(`Ollama: ${errMsg(e)}`); return undefined; }
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
  const mkTree = (s: Section) => new ModelsTreeProvider(ollama, downloads, spellWords, piperVoicesDir, piper, chatterbox, s, voicesChanged.event);
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
      const apply = getActiveApply(); if (apply) { await apply({ provider: 'ollama', model: name }); return true; }
      return false;
    },
  };

  // Installs/updates an engine showing progress. (Ollama "update" = reinstalls the pinned version.)
  const runEngineTask = async (which: string): Promise<void> => {
    if (which !== 'ollama' && which !== 'piper' && which !== 'chatterbox') return;
    const name = which === 'ollama' ? 'Ollama' : which === 'piper' ? 'Piper' : 'Chatterbox';
    const title = tr('Installing engine…') + ` (${name})`;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (p) => {
        const notify = (m: string) => p.report({ message: m });
        if (which === 'ollama') await ollama.ensureBinary();
        else if (which === 'piper') await piper.install(notify);
        else await chatterbox.install(notify);
      });
    } catch (e) {
      vscode.window.showErrorMessage(`${name}: ${errMsg(e)}`);
    }
    refreshTrees();
  };

  // ---- Engines management panel (elegant install/progress/RAM, replaces the tree's tiny icons) ----
  const confirmDeleteEngine = async (name: string): Promise<boolean> => {
    const yes = tr('Delete');
    return (await vscode.window.showWarningMessage(tr('Delete this engine?') + ` (${name})`, { modal: true }, yes)) === yes;
  };
  const ollamaState = (): { status: EngineStatus; detail?: string } => {
    const st = ollama.status;
    if (st === 'ready') return { status: 'running', detail: ollama.detail };
    if (st === 'downloading' || st === 'starting') return { status: 'busy', detail: tr(st === 'downloading' ? 'downloading…' : 'starting…') };
    return ollama.isInstalled() ? { status: 'stopped' } : { status: 'notinstalled' };
  };
  const engineList: EnginePanelEngine[] = [
    {
      key: 'ollama', name: 'Ollama', kind: tr('LLM runtime'),
      sources: ['GitHub releases · pinned binary'],
      state: ollamaState, pid: () => ollama.serverPid(),
      install: async (report) => { await ollama.ensureBinary((r, t) => report(tr('Downloading the Ollama binary…'), t ? r / t : undefined)); refreshTrees(); },
      start: async (report) => { await ollama.start((r, t) => report(tr('Downloading the Ollama binary…'), t ? r / t : undefined)); refreshTrees(); },
      stop: () => { ollama.stop(); refreshTrees(); },
      remove: async () => { if (!(await confirmDeleteEngine('Ollama'))) return false; ollama.deleteBinary(); cards.clear(); refreshTrees(); return true; },
    },
    {
      key: 'piper', name: 'Piper', kind: tr('Neural TTS'),
      sources: [`PyPI · piper-tts==${PIPER_TTS_VERSION}`, 'Voices · Hugging Face (rhasspy/piper-voices)'],
      state: () => piper.isInstalled() ? { status: piper.isServerRunning() ? 'running' : 'stopped' } : { status: 'notinstalled' },
      pid: () => piper.serverPid(),
      install: async (report) => { await piper.install((m) => report(m, progressPct(m))); refreshTrees(); },
      start: async (report) => {
        const model = piper.firstVoiceModel();
        if (!model) throw new Error(tr('Download a voice first from the Voices section.'));
        await piper.ensureServer(model, (m) => report(m, progressPct(m))); refreshTrees();
      },
      stop: () => { piper.stopServer(); refreshTrees(); },
      remove: async () => { if (!(await confirmDeleteEngine('Piper'))) return false; piper.delete(); voicesChanged.fire(); refreshTrees(); return true; },
    },
    {
      key: 'chatterbox', name: 'Chatterbox', kind: tr('Neural TTS · voice cloning'),
      sources: (process.platform === 'darwin' && process.arch === 'arm64')
        ? [`PyPI · mlx-audio==${MLX_AUDIO_VERSION} (Apple Silicon, ~4× faster)`, `Weights · Hugging Face (${CHATTERBOX_MLX_MODEL}, 4-bit ~1 GB)`, 'ffmpeg (imageio-ffmpeg)']
        : [`PyPI · chatterbox-tts==${CHATTERBOX_TTS_VERSION} + PyTorch`, 'Weights · Hugging Face (ResembleAI/chatterbox, ~3 GB)', 'ffmpeg (imageio-ffmpeg)'],
      state: () => chatterbox.isInstalled() ? { status: chatterbox.isServerRunning() ? 'running' : 'stopped' } : { status: 'notinstalled' },
      pid: () => chatterbox.serverPid(),
      install: async (report) => { await chatterbox.install(report); refreshTrees(); }, // install emits stepped %
      start: async (report) => { await chatterbox.ensureServer((m) => report(m, progressPct(m))); refreshTrees(); },
      stop: () => { chatterbox.stopServer(); refreshTrees(); },
      remove: async () => { if (!(await confirmDeleteEngine('Chatterbox'))) return false; chatterbox.delete(); voicesChanged.fire(); refreshTrees(); return true; },
    },
  ];
  // Fires the panel a fresh snapshot whenever any engine's state changes.
  const enginesChanged = new vscode.EventEmitter<void>();
  ollama.onDidChangeStatus(() => enginesChanged.fire());
  piper.onDidChange(() => enginesChanged.fire());
  chatterbox.onDidChange(() => enginesChanged.fire());

  context.subscriptions.push(
    enginesChanged,
    vscode.commands.registerCommand('jotflow.engines.manage', () => openEnginesPanel(context, engineList, enginesChanged.event)),
    ollama,
    downloads,
    piper, // dispose() shuts down the HTTP daemon when the extension deactivates
    chatterbox, // dispose() shuts down its resident-model daemon too
    vscode.window.registerTreeDataProvider('jotflow.engines', treeEngines),
    vscode.window.registerTreeDataProvider('jotflow.models', treeModels),
    vscode.window.registerTreeDataProvider('jotflow.voices', treeVoices),
    vscode.window.registerTreeDataProvider('jotflow.dictionary', treeDict),
    vscode.commands.registerCommand('jotflow.models.add', () => ModelsPanel.show(context, ollama, downloads, cards, panelHooks)),
    vscode.commands.registerCommand('jotflow.models.openModelFromDownload', (item: ModelsTreeItem) => {
      const modelId = item?.download?.modelId;
      if (!modelId) return;
      ModelsPanel.show(context, ollama, downloads, cards, panelHooks);
      ModelsPanel.revealModel(modelId);
    }),
    vscode.commands.registerCommand('jotflow.models.cancelDownload', (item: ModelsTreeItem) => {
      if (item?.download) { cards.remove(item.download.modelId); downloads.cancel(item.download.id); }
    }),
    vscode.commands.registerCommand('jotflow.models.retryDownload', (item: ModelsTreeItem) => {
      if (item?.download?.id) downloads.retry(item.download.id);
    }),
    vscode.commands.registerCommand('jotflow.models.removeDownload', (item: ModelsTreeItem) => {
      if (item?.download) { cards.remove(item.download.modelId); downloads.remove(item.download.id); }
    }),
    vscode.commands.registerCommand('jotflow.models.clearDownloads', () => downloads.clearFinished()),
    vscode.commands.registerCommand('jotflow.models.refresh', () => refreshTrees()),
    vscode.commands.registerCommand('jotflow.tts.openVoices', () => {
      openVoicesPanel(context, piper, chatterbox, piperVoicesDir, () => { refreshTrees(); voicesChanged.fire(); });
    }),
    vscode.commands.registerCommand('jotflow.chatterbox.startServer', async () => {
      if (!chatterbox.isInstalled()) { vscode.window.showInformationMessage(tr('Install the Chatterbox engine first (Engines section).')); return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Starting the Chatterbox server…') },
          (p) => chatterbox.ensureServer((m) => p.report({ message: m }))
        );
      } catch (e) { vscode.window.showErrorMessage(`Chatterbox: ${errMsg(e)}`); }
      refreshTrees();
    }),
    vscode.commands.registerCommand('jotflow.chatterbox.stopServer', () => { chatterbox.stopServer(); refreshTrees(); }),
    vscode.commands.registerCommand('jotflow.chatterbox.removeVoice', async (item: ModelsTreeItem) => {
      const id = item?.word; // the voice node carries its id in `word`
      if (typeof id !== 'string') return;
      const yes = tr('Delete');
      if (await vscode.window.showWarningMessage(tr('Delete this voice?') + ` (${id})`, { modal: true }, yes) !== yes) return;
      removeChatterboxVoice(chatterbox.voicesDir(), id);
      refreshTrees();
      voicesChanged.fire();
    }),
    vscode.commands.registerCommand('jotflow.tts.startServer', async () => {
      const model = piper.firstVoiceModel();
      if (!model) { vscode.window.showInformationMessage(tr('Download a voice first from the Voices section.')); return; }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Starting the Piper server…') },
          (p) => piper.ensureServer(model, (m) => p.report({ message: m }))
        );
      } catch (e) { vscode.window.showErrorMessage(`Piper: ${errMsg(e)}`); }
    }),
    vscode.commands.registerCommand('jotflow.tts.stopServer', () => piper.stopServer()),
    vscode.commands.registerCommand('jotflow.tts.removeVoice', async (item: ModelsTreeItem) => {
      const id = item?.word; // the voice node carries its id in `word`
      if (typeof id !== 'string') return;
      const yes = tr('Delete');
      const pick = await vscode.window.showWarningMessage(tr('Delete this voice?') + ` (${id})`, { modal: true }, yes);
      if (pick !== yes) return;
      removePiperVoice(piperVoicesDir, id);
      refreshTrees();
      voicesChanged.fire();
    }),
    vscode.commands.registerCommand('jotflow.engine.install', (item: ModelsTreeItem) => { if (item?.word) return runEngineTask(item.word); }),
    vscode.commands.registerCommand('jotflow.engine.delete', async (item: ModelsTreeItem) => {
      const which = item?.word;
      if (which !== 'ollama' && which !== 'piper' && which !== 'chatterbox') return;
      const name = which === 'ollama' ? 'Ollama' : which === 'piper' ? 'Piper' : 'Chatterbox';
      const yes = tr('Delete');
      if (await vscode.window.showWarningMessage(tr('Delete this engine?') + ` (${name})`, { modal: true }, yes) !== yes) return;
      if (which === 'ollama') { ollama.deleteBinary(); cards.clear(); }
      else if (which === 'piper') { piper.delete(); voicesChanged.fire(); }
      else { chatterbox.delete(); voicesChanged.fire(); }
      refreshTrees();
    }),
    vscode.commands.registerCommand('jotflow.models.startServer', async () => { await needServer(); }),
    vscode.commands.registerCommand('jotflow.models.stopServer', () => { ollama.stop(); }),
    vscode.commands.registerCommand('jotflow.models.deleteModel', async (item: ModelsTreeItem) => {
      const name = item?.model?.name; const baseUrl = ollama.baseUrl();
      if (!name || !baseUrl) return;
      const ok = await vscode.window.showWarningMessage(`${tr('Delete the model')} ${name}?`, { modal: true }, tr('Delete'));
      if (ok !== tr('Delete')) return;
      try { await removeModel(baseUrl, name); refreshTrees(); }
      catch (e) { vscode.window.showErrorMessage(`${tr('Could not delete: ')}${errMsg(e)}`); }
    }),
    vscode.commands.registerCommand('jotflow.models.openLocalModel', (item: ModelsTreeItem) => {
      const id = localModelHfId(item?.model?.name);
      if (!id) { vscode.window.showInformationMessage(tr('This model is not from Hugging Face.')); return; }
      ModelsPanel.show(context, ollama, downloads, cards, panelHooks);
      ModelsPanel.revealModel(id);
    })
  );
}
