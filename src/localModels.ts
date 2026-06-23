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
import { errMsg } from './chatHelpers';
import { ChatPatch } from './applyPatch';
import { removePiperVoice } from './piperVoices';
import { PiperManager } from './piper/manager';
import { SpellWordsStore } from './spellWords';
import { tr } from './i18n';

/** Extracts the HF repo id from a local Ollama model name (`hf.co/user/repo:quant` → `user/repo`). */
function localModelHfId(name?: string): string | undefined {
  if (!name || !/^hf\.co\//i.test(name)) return undefined;
  const id = name.replace(/^hf\.co\//i, '').replace(/:[^:/]+$/, '');
  return id || undefined;
}

export interface LocalModelsDeps {
  piper: PiperManager;
  spellWords: SpellWordsStore;
  voicesChanged: vscode.EventEmitter<void>;
  getActiveApply: () => ((patch: ChatPatch) => Promise<void>) | undefined;
}

/** Local models (managed Ollama + explorer), TTS/engine commands, and their tree views. */
export function registerLocalModels(context: vscode.ExtensionContext, deps: LocalModelsDeps): void {
  const { piper, spellWords, voicesChanged, getActiveApply } = deps;
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
      const apply = getActiveApply(); if (apply) { await apply({ provider: 'ollama', model: name }); return true; }
      return false;
    },
  };

  // Installs/updates an engine showing progress. (Ollama "update" = reinstalls the pinned version.)
  const runEngineTask = async (which: string): Promise<void> => {
    if (which !== 'ollama' && which !== 'piper') return;
    const name = which === 'ollama' ? 'Ollama' : 'Piper';
    const title = tr('Installing engine…') + ` (${name})`;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async (p) => {
        const notify = (m: string) => p.report({ message: m });
        if (which === 'ollama') await ollama.ensureBinary();
        else await piper.install(notify);
      });
    } catch (e) {
      vscode.window.showErrorMessage(`${name}: ${errMsg(e)}`);
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
    vscode.commands.registerCommand('parley.models.openModelFromDownload', (item: ModelsTreeItem) => {
      const modelId = item?.download?.modelId;
      if (!modelId) return;
      ModelsPanel.show(context, ollama, downloads, cards, panelHooks);
      ModelsPanel.revealModel(modelId);
    }),
    vscode.commands.registerCommand('parley.models.cancelDownload', (item: ModelsTreeItem) => {
      if (item?.download) { cards.remove(item.download.modelId); downloads.cancel(item.download.id); }
    }),
    vscode.commands.registerCommand('parley.models.retryDownload', (item: ModelsTreeItem) => {
      if (item?.download?.id) downloads.retry(item.download.id);
    }),
    vscode.commands.registerCommand('parley.models.removeDownload', (item: ModelsTreeItem) => {
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
      } catch (e) { vscode.window.showErrorMessage(`Piper: ${errMsg(e)}`); }
    }),
    vscode.commands.registerCommand('parley.tts.stopServer', () => piper.stopServer()),
    vscode.commands.registerCommand('parley.tts.removeVoice', async (item: ModelsTreeItem) => {
      const id = item?.word; // the voice node carries its id in `word`
      if (typeof id !== 'string') return;
      const yes = tr('Delete');
      const pick = await vscode.window.showWarningMessage(tr('Delete this voice?') + ` (${id})`, { modal: true }, yes);
      if (pick !== yes) return;
      removePiperVoice(piperVoicesDir, id);
      refreshTrees();
      voicesChanged.fire();
    }),
    vscode.commands.registerCommand('parley.engine.install', (item: ModelsTreeItem) => { if (item?.word) return runEngineTask(item.word); }),
    vscode.commands.registerCommand('parley.engine.delete', async (item: ModelsTreeItem) => {
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
    vscode.commands.registerCommand('parley.models.deleteModel', async (item: ModelsTreeItem) => {
      const name = item?.model?.name; const baseUrl = ollama.baseUrl();
      if (!name || !baseUrl) return;
      const ok = await vscode.window.showWarningMessage(`${tr('Delete the model')} ${name}?`, { modal: true }, tr('Delete'));
      if (ok !== tr('Delete')) return;
      try { await removeModel(baseUrl, name); refreshTrees(); }
      catch (e) { vscode.window.showErrorMessage(`${tr('Could not delete: ')}${errMsg(e)}`); }
    }),
    vscode.commands.registerCommand('parley.models.openLocalModel', (item: ModelsTreeItem) => {
      const id = localModelHfId(item?.model?.name);
      if (!id) { vscode.window.showInformationMessage(tr('This model is not from Hugging Face.')); return; }
      ModelsPanel.show(context, ollama, downloads, cards, panelHooks);
      ModelsPanel.revealModel(id);
    })
  );
}
