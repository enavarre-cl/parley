/** Sidebar views (TreeView) for Jotflow. One view per section (Engines, Local models,
 *  Downloads, Voices, Dictionary): VS Code provides the native shaded heading. The same
 *  provider is instantiated per `section` and directly serves the items for that section. */
import * as vscode from 'vscode';
import { OllamaManager } from './ollama/manager';
import { listLocal, LocalModel } from './ollama/registry';
import { DownloadManager, DownloadItem } from './ollama/downloads';
import { formatBytes } from './ollama/parse';
import { SpellWordsStore, SPELL_LANGS, SPELL_LANG_NAMES } from './spellWords';
import { listPiperVoices } from './piperVoices';
import { PiperManager } from './piper/manager';
import { tr } from './i18n';
import { errMsg } from './chatHelpers';

export type Section = 'engines' | 'models' | 'voices' | 'dictionary';

type Kind = 'engine' | 'model' | 'download' | 'dict-lang' | 'voice' | 'empty'
  | 'group-models' | 'group-downloads';

export class ModelsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: Kind,
    label: string,
    public readonly model?: LocalModel,
    public readonly download?: DownloadItem,
    public readonly word?: string
  ) {
    super(label);
  }
}

export class ModelsTreeProvider implements vscode.TreeDataProvider<ModelsTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<ModelsTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private readonly manager: OllamaManager,
    private readonly downloads: DownloadManager,
    private readonly spell: SpellWordsStore,
    private readonly voicesDir: string,
    private readonly piper: PiperManager,
    private readonly section: Section,
    onVoicesChanged: vscode.Event<void>
  ) {
    // Each view refreshes on any relevant state change (cheap; no progress, so
    // clicks on inline buttons are never lost — live % goes in the panel).
    manager.onDidChangeStatus(() => this.refresh());
    downloads.onDidChangeState(() => this.refresh());
    spell.onDidChange(() => this.refresh());
    piper.onDidChange(() => this.refresh());
    onVoicesChanged(() => this.refresh());
  }

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(el: ModelsTreeItem): vscode.TreeItem { return el; }

  async getChildren(el?: ModelsTreeItem): Promise<ModelsTreeItem[]> {
    // "Models" view: tree with TWO groups (Local models + Downloads) under the same category.
    if (this.section === 'models') {
      if (!el) {
        const lm = new ModelsTreeItem('group-models', tr('Local models'));
        lm.contextValue = 'ollamaModels';
        lm.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        lm.iconPath = new vscode.ThemeIcon('layers');
        const pending = this.downloads.pending();
        const dl = new ModelsTreeItem('group-downloads', pending.length ? `${tr('Downloads')} (${pending.length})` : tr('Downloads'));
        dl.contextValue = 'ollamaDownloads';
        dl.collapsibleState = pending.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        dl.iconPath = new vscode.ThemeIcon('cloud-download');
        return [lm, dl];
      }
      if (el.kind === 'group-models') return this.modelItems();
      if (el.kind === 'group-downloads') return this.downloadItems();
      return [];
    }
    // Flat views: items go directly to the root (the view heading IS the section).
    if (el) return [];
    switch (this.section) {
      case 'engines': return [this.ollamaEngine(), this.piperEngine()];
      case 'voices': return this.voiceItems();
      case 'dictionary': return this.dictItems();
    }
    return [];
  }

  // ── Engines ──
  private ollamaEngine(): ModelsTreeItem {
    const st = this.manager.status;
    const it = new ModelsTreeItem('engine', 'Ollama', undefined, undefined, 'ollama');
    let state: string;
    let icon: string;
    if (st === 'ready') { state = 'running'; it.description = tr('running'); icon = 'pass-filled'; }
    else if (st === 'downloading' || st === 'starting') { state = 'busy'; it.description = tr(st === 'downloading' ? 'downloading…' : 'starting…'); icon = 'loading~spin'; }
    else if (this.manager.isInstalled()) { state = 'stopped'; it.description = tr('stopped'); icon = 'circle-outline'; }
    else { state = 'notinstalled'; it.description = tr('not installed'); icon = 'cloud-download'; }
    it.contextValue = `engine.ollama.${state}`;
    it.tooltip = this.manager.detail || state;
    it.iconPath = new vscode.ThemeIcon(icon);
    return it;
  }

  private piperEngine(): ModelsTreeItem {
    const it = new ModelsTreeItem('engine', 'Piper (TTS)', undefined, undefined, 'piper');
    let state: string;
    let icon: string;
    if (!this.piper.isInstalled()) { state = 'notinstalled'; it.description = tr('not installed'); icon = 'cloud-download'; }
    else if (this.piper.isServerRunning()) { state = 'running'; it.description = tr('running'); icon = 'pass-filled'; }
    else { state = 'stopped'; it.description = tr('stopped'); icon = 'circle-outline'; }
    it.contextValue = `engine.piper.${state}`;
    it.iconPath = new vscode.ThemeIcon(icon);
    return it;
  }

  // ── Local models ──
  private async modelItems(): Promise<ModelsTreeItem[]> {
    const baseUrl = this.manager.baseUrl();
    if (!baseUrl || this.manager.status !== 'ready') {
      const empty = new ModelsTreeItem('empty', tr('Start the server to see the models'));
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }
    let models: LocalModel[];
    try { models = await listLocal(baseUrl); } catch (e) {
      const err = new ModelsTreeItem('empty', `${tr('Error: ')}${errMsg(e)}`);
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
      it.command = { command: 'jotflow.models.openLocalModel', title: tr('Local models'), arguments: [it] };
      return it;
    });
  }

  // ── Downloads ──
  private downloadItems(): ModelsTreeItem[] {
    const pending = this.downloads.pending();
    if (!pending.length) {
      const empty = new ModelsTreeItem('empty', tr('No downloads'));
      empty.iconPath = new vscode.ThemeIcon('inbox');
      return [empty];
    }
    return pending.map((d) => {
      const it = new ModelsTreeItem('download', d.label, undefined, d);
      it.command = { command: 'jotflow.models.openModelFromDownload', title: tr('Local models'), arguments: [it] };
      if (d.state === 'queued') {
        it.description = tr('queued');
        it.iconPath = new vscode.ThemeIcon('clock');
        it.contextValue = 'ollamaDownload.queued';
      } else if (d.state === 'downloading') {
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

  // ── Voices ──
  private voiceItems(): ModelsTreeItem[] {
    const voices = listPiperVoices(this.voicesDir);
    if (!voices.length) {
      const empty = new ModelsTreeItem('empty', tr('No voices downloaded'));
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }
    return voices.map((v) => {
      const it = new ModelsTreeItem('voice', v.id, undefined, undefined, v.id);
      it.description = formatBytes(v.sizeBytes);
      it.contextValue = 'piperVoice';
      it.iconPath = new vscode.ThemeIcon('mic');
      return it;
    });
  }

  // ── Dictionary ──
  private async dictItems(): Promise<ModelsTreeItem[]> {
    const all = await this.spell.all();
    return [...SPELL_LANGS]
      .sort((a, b) => SPELL_LANG_NAMES[a].localeCompare(SPELL_LANG_NAMES[b]))
      .map((l) => this.dictLang(l, SPELL_LANG_NAMES[l], all[l].length));
  }

  private dictLang(lang: string, label: string, count: number): ModelsTreeItem {
    const it = new ModelsTreeItem('dict-lang', count ? `${label} (${count})` : label, undefined, undefined, lang);
    it.contextValue = 'spellDictLang';
    it.iconPath = new vscode.ThemeIcon('book');
    it.command = { command: 'jotflow.spell.openDictionary', title: tr('Dictionary'), arguments: [it] };
    return it;
  }
}
