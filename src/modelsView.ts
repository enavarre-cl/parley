/** Vista lateral (TreeView) de modelos: estado del servidor + modelos locales con acciones. */
import * as vscode from 'vscode';
import { OllamaManager } from './ollama/manager';
import { listLocal, LocalModel } from './ollama/registry';
import { DownloadManager, DownloadItem } from './ollama/downloads';
import { formatBytes } from './ollama/parse';
import { tr } from './i18n';

type Kind = 'server' | 'group-models' | 'model' | 'group-downloads' | 'download' | 'empty';

export class ModelsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: Kind,
    label: string,
    public readonly model?: LocalModel,
    public readonly download?: DownloadItem
  ) {
    super(label);
  }
}

export class ModelsTreeProvider implements vscode.TreeDataProvider<ModelsTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<ModelsTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly manager: OllamaManager, private readonly downloads: DownloadManager) {
    manager.onDidChangeStatus(() => this.refresh());
    // Solo cambios de ESTADO (no progreso): así el árbol NO se recrea en cada tick y los clics en
    // los botones inline (cancelar/reintentar) nunca se pierden. El % en vivo va en el panel.
    downloads.onDidChangeState(() => this.refresh());
  }

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(el: ModelsTreeItem): vscode.TreeItem { return el; }

  async getChildren(el?: ModelsTreeItem): Promise<ModelsTreeItem[]> {
    if (!el) {
      // Raíz: nodo de servidor + grupo de modelos.
      const st = this.manager.status;
      const labels: Record<string, string> = {
        stopped: tr('Server: stopped'), downloading: tr('Server: downloading…'),
        starting: tr('Server: starting…'), ready: tr('Server: ready'), error: tr('Server: error'),
      };
      const server = new ModelsTreeItem('server', labels[st] || `Server: ${st}`);
      server.contextValue = `ollamaServer.${st}`;
      server.tooltip = this.manager.detail || st;
      server.iconPath = new vscode.ThemeIcon(
        st === 'ready' ? 'pass-filled' : st === 'error' ? 'error'
          : st === 'stopped' ? 'circle-outline' : 'loading~spin'
      );
      const group = new ModelsTreeItem('group-models', tr('Local models'));
      group.contextValue = 'ollamaModels';
      group.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      group.iconPath = new vscode.ThemeIcon('layers');
      // Sección de descargas: siempre visible (gestor persistente, con historial reintentable).
      const pending = this.downloads.pending();
      const dl = new ModelsTreeItem('group-downloads', pending.length ? `${tr('Downloads')} (${pending.length})` : tr('Downloads'));
      dl.contextValue = 'ollamaDownloads';
      dl.collapsibleState = pending.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      dl.iconPath = new vscode.ThemeIcon('cloud-download');
      return [server, group, dl];
    }

    if (el.kind === 'group-downloads') {
      const pending = this.downloads.pending();
      if (!pending.length) {
        const empty = new ModelsTreeItem('empty', tr('No downloads'));
        empty.iconPath = new vscode.ThemeIcon('inbox');
        return [empty];
      }
      return pending.map((d) => {
        const it = new ModelsTreeItem('download', d.label, undefined, d);
        // Clic en la fila → abre ese modelo en el explorador. (Ya no roba los clics de los botones
        // inline porque el árbol dejó de recrearse en cada tick — refresco coalescido.)
        it.command = { command: 'langChat.models.openModelFromDownload', title: tr('Local models'), arguments: [it] };
        if (d.state === 'queued') {
          it.description = tr('queued');
          it.iconPath = new vscode.ThemeIcon('clock');
          it.contextValue = 'ollamaDownload.queued';
        } else if (d.state === 'downloading') {
          // Sin % en vivo aquí (el árbol no se refresca por progreso); el % detallado está en el panel.
          it.description = tr('downloading…');
          it.iconPath = new vscode.ThemeIcon('loading~spin');
          it.contextValue = 'ollamaDownload.downloading';
        } else if (d.state === 'cancelled') {
          it.description = tr('cancelled');
          it.iconPath = new vscode.ThemeIcon('circle-slash');
          it.contextValue = 'ollamaDownload.failed';
        } else if (d.state === 'interrupted') {
          const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
          it.description = `${tr('interrupted')} ${pct}% — ${tr('retry to resume')}`;
          it.iconPath = new vscode.ThemeIcon('debug-pause');
          it.contextValue = 'ollamaDownload.failed';
          it.tooltip = d.error;
        } else { // error
          it.description = `${tr('error: ')}${d.error || ''}`;
          it.iconPath = new vscode.ThemeIcon('error');
          it.contextValue = 'ollamaDownload.failed';
          it.tooltip = d.error;
        }
        return it;
      });
    }

    if (el.kind === 'group-models') {
      const baseUrl = this.manager.baseUrl();
      if (!baseUrl || this.manager.status !== 'ready') {
        const empty = new ModelsTreeItem('empty', tr('Start the server to see the models'));
        empty.iconPath = new vscode.ThemeIcon('info');
        return [empty];
      }
      let models: LocalModel[];
      try { models = await listLocal(baseUrl); } catch (e: any) {
        const err = new ModelsTreeItem('empty', `${tr('Error: ')}${e?.message || e}`);
        err.iconPath = new vscode.ThemeIcon('error');
        return [err];
      }
      if (!models.length) {
        const empty = new ModelsTreeItem('empty', tr('No models. Press "Add" to download.'));
        empty.iconPath = new vscode.ThemeIcon('cloud-download');
        return [empty];
      }
      return models.map((m) => {
        const it = new ModelsTreeItem('model', m.name, m);
        it.description = [m.parameterSize, m.quantization, formatBytes(m.size)].filter(Boolean).join(' · ');
        it.tooltip = `${m.name}\n${formatBytes(m.size)}${m.family ? '\n' + m.family : ''}`;
        it.contextValue = 'ollamaModel';
        it.iconPath = new vscode.ThemeIcon('database');
        it.command = { command: 'langChat.models.openLocalModel', title: tr('Local models'), arguments: [it] };
        return it;
      });
    }

    return [];
  }
}
