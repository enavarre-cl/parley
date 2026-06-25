/** Model browser (WebviewPanel) in the style of LM Studio: search on HF and download to Ollama. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { OllamaManager } from './ollama/manager';
import { searchHF, modelFiles, readme, modelInfo, fetchModel, ollamaPullViable, OFFICIAL_ORG_NAMES, CatalogModel, SortMode } from './ollama/catalog';
import { searchOllama, ollamaModelTags, ollamaModelCard, OllamaSort } from './ollama/library';
import { hfPullRef, formatBytes } from './ollama/parse';
import { resolveApiKey } from './providers';

/** Where the model browser searches/downloads from. `ollama` is the default. */
type ModelSource = 'ollama' | 'huggingface';

/** Maps the browser's HF-style sort options onto the two orders ollama.com/search supports. */
function toOllamaSort(sort: SortMode): OllamaSort {
  return sort === 'modified' ? 'newest' : 'popular';
}
import { DownloadManager } from './ollama/downloads';
import { ModelCardCache, ModelCard } from './ollama/cards';
import { tr, resolvedLang, activeBundle } from './i18n';
import { makeNonce, errMsg } from './chatHelpers';

export interface ModelsPanelHooks {
  /** Refreshes the sidebar after a download. */
  onChanged: () => void;
  /** Applies the model to the focused chat; returns true if it was applied. */
  useModel: (name: string) => Promise<boolean>;
}

/** Free space (bytes) on the volume containing `p`, or 0 if it cannot be determined. */
function freeSpace(p: string): number {
  try {
    // fs.statfsSync exists at runtime (Node ≥18) but may be absent from the @types/node in use.
    const statfsSync = (fs as { statfsSync?: (p: string) => { bavail?: number; bsize?: number } }).statfsSync;
    const st = statfsSync?.(p);
    if (st && typeof st.bavail === 'number' && typeof st.bsize === 'number') return st.bavail * st.bsize;
  } catch { /* not available */ }
  return 0;
}

/** A message sent from the models-panel webview to the host (all payload fields re-validated). */
interface ModelsPanelMessage {
  type: string;
  limit?: number;
  query?: string;
  author?: string;
  sort?: SortMode;
  id?: string;
  model?: CatalogModel;
  quant?: string;
  size?: number;
  pullable?: boolean;
  path?: string;
  shards?: string[];
  name?: string;
}

export class ModelsPanel {
  private static current: ModelsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private searchAbort: AbortController | undefined;

  static show(context: vscode.ExtensionContext, manager: OllamaManager, downloads: DownloadManager, cards: ModelCardCache, hooks: ModelsPanelHooks): void {
    if (ModelsPanel.current) { ModelsPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
      'jotflow.models.browser', tr('Explore models'), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    ModelsPanel.current = new ModelsPanel(panel, context, manager, downloads, cards, hooks);
  }

  /** Opens the browser on a specific model (called by clicking a download in the sidebar). */
  static revealModel(modelId: string): void {
    ModelsPanel.current?.revealModelImpl(modelId);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly manager: OllamaManager,
    private readonly downloads: DownloadManager,
    private readonly cards: ModelCardCache,
    private readonly hooks: ModelsPanelHooks
  ) {
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
    this.disposables.push(panel.webview.onDidReceiveMessage((m) => this.onMessage(m)));
    // Broadcasts the state of ALL downloads; the webview maps it to each model.
    this.disposables.push(downloads.onDidChange(() => this.postDownloads()));
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private post(msg: Record<string, unknown>): void { void this.panel.webview.postMessage(msg); }

  /** Current catalog source, read live so a settings change takes effect without reopening. */
  private source(): ModelSource {
    return vscode.workspace.getConfiguration('jotflow').get<string>('models.source', 'ollama') === 'huggingface'
      ? 'huggingface' : 'ollama';
  }

  /** Whether an Ollama API key is configured (so the webview can drop the "set a key" hint). */
  private hasOllamaKey(): boolean {
    return !!resolveApiKey('ollama');
  }

  /** Opens a model card WITHOUT changing the search: uses the sidecar if present, otherwise fetches from HF. */
  revealModelImpl(modelId: string): void {
    const card = this.cards.load(modelId);
    if (card?.model) { this.post({ type: 'showCachedModel', card, hasKey: this.hasOllamaKey() }); return; }
    void (this.source() === 'ollama' ? this.buildCardFromOllama(modelId) : this.buildCardFromHF(modelId));
  }

  private async buildCardFromOllama(modelId: string): Promise<void> {
    this.post({ type: 'showCachedLoading' });
    try {
      const { files, cloudTags } = await ollamaModelTags(modelId);
      const model: CatalogModel = {
        id: modelId, author: '', downloads: 0, likes: 0, updated: '', tags: [],
        pipeline: '', params: '', domain: 'LLM', official: true,
        capabilities: { vision: false, tools: false, reasoning: false },
      };
      const card = { model, files, cloudTags, readme: '', info: { arch: '', params: '' } };
      this.cards.save(modelId, card);
      this.post({ type: 'showCachedModel', card, hasKey: this.hasOllamaKey() });
    } catch (e) {
      this.post({ type: 'error', message: `Could not load model card: ${errMsg(e)}` });
    }
  }

  private async buildCardFromHF(modelId: string): Promise<void> {
    this.post({ type: 'showCachedLoading' });
    try {
      const [model, files, md, info] = await Promise.all([
        fetchModel(modelId),
        modelFiles(modelId).catch(() => []),
        readme(modelId).catch(() => ''),
        modelInfo(modelId).catch(() => ({ arch: '', params: '' })),
      ]);
      const card = { model, files, readme: md, info };
      this.cards.save(modelId, card);
      this.post({ type: 'showCachedModel', card });
    } catch (e) {
      this.post({ type: 'error', message: `Could not load model card: ${errMsg(e)}` });
    }
  }

  private postDownloads(): void {
    this.post({
      type: 'downloads',
      items: this.downloads.list().map((d) => ({
        id: d.id, modelId: d.modelId, quant: d.quant, ref: d.ref, state: d.state,
        status: d.status, received: d.received, total: d.total, error: d.error,
        pct: d.total ? Math.round((d.received / d.total) * 100) : null,
      })),
    });
  }

  private async onMessage(msg: ModelsPanelMessage): Promise<void> {
    try {
      switch (msg?.type) {
        case 'search': {
          this.searchAbort?.abort();
          this.searchAbort = new AbortController();
          const limit = Math.min(Math.max(Number(msg.limit) || 30, 30), 240);
          const sort = msg.sort || 'relevance';
          const { signal } = this.searchAbort;
          if (this.source() === 'ollama') {
            const models = await searchOllama(msg.query || '', limit, signal, toOllamaSort(sort));
            this.post({ type: 'searchResults', models, limit, officialOrgs: [], source: 'ollama' });
            break;
          }
          const models = await searchHF(msg.query || '', limit, signal, msg.author || '', sort);
          this.post({ type: 'searchResults', models, limit, officialOrgs: OFFICIAL_ORG_NAMES, source: 'huggingface' });
          break;
        }
        case 'detail': {
          const detailId = msg.id ?? '';
          if (this.source() === 'ollama') {
            const [tags, overview] = await Promise.all([
              ollamaModelTags(detailId).catch(() => ({ files: [], cloudTags: [] })),
              ollamaModelCard(detailId).catch(() => ({ description: '', readme: '', params: '', context: '' })),
            ]);
            const readme = overview.readme || overview.description || msg.model?.description || '';
            const info = { arch: '', params: overview.params, context: overview.context };
            const card: ModelCard = { model: msg.model, files: tags.files, cloudTags: tags.cloudTags, readme, info };
            this.cards.save(detailId, card);
            this.post({ type: 'detail', id: msg.id, ...card, hasKey: this.hasOllamaKey() });
            break;
          }
          const [files, md, info] = await Promise.all([
            modelFiles(detailId).catch(() => []),
            readme(detailId).catch(() => ''),
            modelInfo(detailId).catch(() => ({ arch: '', params: '' })),
          ]);
          let payload: ModelCard = { files, readme: md, info };
          if (!files.length && !md && !info.arch) {
            // HF did not respond → use the locally cached card (offline sidecar), if present.
            const cached = this.cards.load(msg.id ?? '');
            if (cached) payload = cached;
          } else {
            // Save the FULL card (with the model header) to avoid re-querying HF.
            this.cards.save(msg.id ?? '', { model: msg.model, files, readme: md, info });
          }
          this.post({ type: 'detail', id: msg.id, ...payload });
          break;
        }
        case 'pull': await this.doPull(msg.id ?? '', msg.quant ?? '', msg.size || 0, msg.pullable !== false, msg.path || '', Array.isArray(msg.shards) ? msg.shards : []); break;
        case 'cancelDownload': if (msg.id) { const d = this.downloads.get(msg.id); if (d) this.cards.remove(d.modelId); this.downloads.cancel(msg.id); } break;
        case 'retryDownload': if (msg.id) this.downloads.retry(msg.id); break;
        case 'useModel': await this.useModel(msg.name ?? ''); break;
      }
    } catch (e) {
      this.post({ type: 'error', message: errMsg(e) });
    }
  }

  private async doPull(id: string, quant: string, size: number, pullable: boolean, filePath: string, shards: string[]): Promise<void> {
    // Frontier validation (L4): import paths are repo-relative HF paths. Reject absolute paths or
    // any `..` segment from the webview message so they can't reach outside the intended download.
    const unsafe = (p: string): boolean => !!p && (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.split(/[\\/]/).includes('..'));
    if (unsafe(filePath) || shards.some(unsafe)) { this.post({ type: 'error', message: 'Invalid model path.' }); return; }
    // D4: show modal only when free space is clearly insufficient (the size is already visible in the UI).
    const free = freeSpace(this.context.globalStorageUri.fsPath);
    if (free && size && free < size * 1.1) {
      const go = await vscode.window.showWarningMessage(
        `${tr('Not enough space for')} ${id} (${quant}, ${formatBytes(size)}). ${tr('Free:')} ${formatBytes(free)}. ${tr('Download anyway?')}`,
        { modal: true }, tr('Download anyway')
      );
      if (go !== tr('Download anyway')) return;
    }
    // Ollama library: a native `name:tag` pull. No manifest probe / import fallback — those exist
    // only because HF serves Ollama-style manifests on the fly, which can be broken per quant.
    if (this.source() === 'ollama') {
      const ref = `${id}:${quant}`;
      this.downloads.start({ mode: 'pull', ref, label: ref, size, modelId: id, quant, name: ref });
      return;
    }
    const importPaths = shards.length ? shards : (filePath ? [filePath] : []);
    const name = `${(id.split('/').pop() || id)}:${quant}`.toLowerCase().replace(/[^a-z0-9._:-]/g, '-');
    const label = `${id}:${quant}`;
    // Import the .gguf(s) directly instead of letting Ollama pull when EITHER:
    //  1. Non-standard filename: Ollama cannot resolve `:{quant}` (the `pullable` heuristic), OR
    //  2. Standard name but HF serves a broken manifest descriptor for this quant → the pull would
    //     die with "400:" after downloading the layers. We anticipate it (probe the descriptor).
    const importInstead = importPaths.length > 0 && (!pullable || !(await ollamaPullViable(id, quant)));
    if (importInstead) {
      this.downloads.start({ mode: 'import', ref: name, label, size, modelId: id, quant, name, importPaths });
      return;
    }
    // Native Ollama pull, but carry the import paths so the manager can fall back to a direct import
    // if the pull still fails with a 400 mid-stream (backstop for what the pre-flight probe missed).
    this.downloads.start({ mode: 'pull', ref: hfPullRef(id, quant), label, size, modelId: id, quant, name, importPaths });
  }

  private async useModel(name: string): Promise<void> {
    await this.manager.start().catch(() => undefined);
    const applied = await this.hooks.useModel(name);
    vscode.window.showInformationMessage(
      applied ? `${tr('Using')} ${name}` : `${tr('Open a chat and select the Ollama provider to use')} ${name}.`
    );
  }

  private dispose(): void {
    ModelsPanel.current = undefined;
    this.searchAbort?.abort();
    while (this.disposables.length) { try { this.disposables.pop()?.dispose(); } catch { /* nothing */ } }
  }

  private html(webview: vscode.Webview): string {
    const n = makeNonce();
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${n}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob: https:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${resolvedLang()}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${uri('style.css')}" />
  <link rel="stylesheet" href="${uri('models.css')}" />
</head>
<body class="models-browser">
  <div id="mb">
    <div id="mb-left">
      <input id="mb-search" type="text" placeholder="${this.source() === 'ollama' ? tr('Search models on Ollama…') : tr('Search GGUF models on Hugging Face…')}" spellcheck="false" />
      <div id="mb-filters"></div>
      <div id="mb-list"></div>
    </div>
    <div id="mb-right">
      <div id="mb-detail" class="empty">${tr('Search and select a model.')}</div>
    </div>
  </div>
  <script nonce="${n}">window.I18N_LANG = ${JSON.stringify(resolvedLang())}; window.I18N_BUNDLE = ${JSON.stringify(activeBundle())};</script>
  <script nonce="${n}" src="${uri('i18n.js')}"></script>
  <script nonce="${n}" src="${uri('modelsFormat.js')}"></script>
  <script nonce="${n}" src="${uri('models.js')}"></script>
</body>
</html>`;
  }
}
