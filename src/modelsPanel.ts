/** Explorador de modelos (WebviewPanel) tipo LM Studio: buscar en HF y descargar a Ollama. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { OllamaManager } from './ollama/manager';
import { searchHF, modelFiles, readme, modelInfo, fetchModel, hfFileUrl, projectorFile, OFFICIAL_ORG_NAMES } from './ollama/catalog';
import { hfPullRef, formatBytes } from './ollama/parse';
import { DownloadManager } from './ollama/downloads';
import { ModelCardCache } from './ollama/cards';
import { tr } from './i18n';

export interface ModelsPanelHooks {
  /** Refresca la vista lateral tras una descarga. */
  onChanged: () => void;
  /** Aplica el modelo al chat enfocado; devuelve true si se aplicó. */
  useModel: (name: string) => Promise<boolean>;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Espacio libre (bytes) del volumen que contiene `p`, o 0 si no se puede determinar. */
function freeSpace(p: string): number {
  try {
    const st: any = (fs as any).statfsSync?.(p);
    if (st && typeof st.bavail === 'number' && typeof st.bsize === 'number') return st.bavail * st.bsize;
  } catch { /* no disponible */ }
  return 0;
}

export class ModelsPanel {
  private static current: ModelsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private searchAbort: AbortController | undefined;

  static show(context: vscode.ExtensionContext, manager: OllamaManager, downloads: DownloadManager, cards: ModelCardCache, hooks: ModelsPanelHooks): void {
    if (ModelsPanel.current) { ModelsPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(
      'langChat.models.browser', tr('Explore models'), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    ModelsPanel.current = new ModelsPanel(panel, context, manager, downloads, cards, hooks);
  }

  /** Abre el explorador en un modelo concreto (lo llama el clic en una descarga de la barra lateral). */
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
    // Difunde el estado de TODAS las descargas; el webview lo mapea a cada modelo.
    this.disposables.push(downloads.onDidChange(() => this.postDownloads()));
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private post(msg: any): void { void this.panel.webview.postMessage(msg); }

  /** Abre un modelo en su ficha SIN alterar la búsqueda: usa el sidecar si está, si no lo arma de HF. */
  revealModelImpl(modelId: string): void {
    const card = this.cards.load(modelId);
    if (card?.model) { this.post({ type: 'showCachedModel', card }); return; }
    void this.buildCardFromHF(modelId);
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
    } catch (e: any) {
      this.post({ type: 'error', message: `No se pudo cargar la ficha: ${e?.message || e}` });
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

  private async onMessage(msg: any): Promise<void> {
    try {
      switch (msg?.type) {
        case 'search': {
          this.searchAbort?.abort();
          this.searchAbort = new AbortController();
          const limit = Math.min(Math.max(Number(msg.limit) || 30, 30), 240);
          const models = await searchHF(msg.query || '', limit, this.searchAbort.signal, msg.author || '', msg.sort || 'relevance');
          this.post({ type: 'searchResults', models, limit, officialOrgs: OFFICIAL_ORG_NAMES });
          break;
        }
        case 'detail': {
          const [files, md, info] = await Promise.all([
            modelFiles(msg.id).catch(() => []),
            readme(msg.id).catch(() => ''),
            modelInfo(msg.id).catch(() => ({ arch: '', params: '' })),
          ]);
          let payload: any = { files, readme: md, info };
          if (!files.length && !md && !info.arch) {
            // HF no respondió → usa la ficha cacheada localmente (sidecar offline), si existe.
            const cached = this.cards.load(msg.id);
            if (cached) payload = cached;
          } else {
            // Guarda la ficha COMPLETA (con la cabecera del modelo) para no re-consultar HF.
            this.cards.save(msg.id, { model: msg.model, files, readme: md, info });
          }
          this.post({ type: 'detail', id: msg.id, ...payload });
          break;
        }
        case 'pull': await this.doPull(msg.id, msg.quant, msg.size || 0, msg.pullable !== false, msg.path || ''); break;
        case 'cancelDownload': if (msg.id) { const d = this.downloads.get(msg.id); if (d) this.cards.remove(d.modelId); this.downloads.cancel(msg.id); } break;
        case 'retryDownload': if (msg.id) this.downloads.retry(msg.id); break;
        case 'useModel': await this.useModel(msg.name); break;
      }
    } catch (e: any) {
      this.post({ type: 'error', message: e?.message || String(e) });
    }
  }

  private async doPull(id: string, quant: string, size: number, pullable: boolean, filePath: string): Promise<void> {
    // D4: solo modal si el espacio libre es claramente insuficiente (el tamaño ya se ve en la UI).
    const free = freeSpace(this.context.globalStorageUri.fsPath);
    if (free && size && free < size * 1.1) {
      const go = await vscode.window.showWarningMessage(
        `${tr('Not enough space for')} ${id} (${quant}, ${formatBytes(size)}). ${tr('Free:')} ${formatBytes(free)}. ${tr('Download anyway?')}`,
        { modal: true }, tr('Download anyway')
      );
      if (go !== tr('Download anyway')) return;
    }
    if (!pullable && filePath) {
      // Repo no estándar: Ollama no resuelve el tag → descargar el .gguf e importar con `ollama create`.
      // Va por el MISMO gestor de Descargas (misma barra/cancelar/reintentar que el pull).
      const name = `${(id.split('/').pop() || id)}:${quant}`.toLowerCase().replace(/[^a-z0-9._:-]/g, '-');
      const projPath = await projectorFile(id).catch(() => undefined);
      this.downloads.start({
        ref: name, label: `${id}:${quant}`, size, modelId: id, quant, name,
        importModel: hfFileUrl(id, filePath),
        importProj: projPath ? hfFileUrl(id, projPath) : undefined,
      });
      return;
    }
    // Repo estándar: pull nativo de Ollama (cola serializada; arranca el servidor si hace falta).
    this.downloads.start({ ref: hfPullRef(id, quant), label: `${id}:${quant}`, size, modelId: id, quant });
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
    while (this.disposables.length) { try { this.disposables.pop()?.dispose(); } catch { /* nada */ } }
  }

  private html(webview: vscode.Webview): string {
    const n = nonce();
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${n}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob: https:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="es">
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
      <input id="mb-search" type="text" placeholder="${tr('Search GGUF models on Hugging Face…')}" spellcheck="false" />
      <div id="mb-filters"></div>
      <div id="mb-list"></div>
    </div>
    <div id="mb-right">
      <div id="mb-detail" class="empty">Busca y selecciona un modelo.</div>
    </div>
  </div>
  <script nonce="${n}" src="${uri('i18n.js')}"></script>
  <script nonce="${n}" src="${uri('models.js')}"></script>
</body>
</html>`;
  }
}
