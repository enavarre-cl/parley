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
import { ChatterboxManager } from './chatterbox/manager';
import { listChatterboxVoices } from './chatterboxVoices';
import { tr } from './i18n';
import { errMsg } from './chatHelpers';

export type Section = 'engines' | 'models' | 'voices' | 'dictionary';

type Kind = 'engine' | 'model' | 'download' | 'dict-lang' | 'voice' | 'empty'
  | 'group-models' | 'group-downloads' | 'voice-engine' | 'voice-lang';

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
    private readonly chatterbox: ChatterboxManager,
    private readonly section: Section,
    onVoicesChanged: vscode.Event<void>
  ) {
    // Each view refreshes on any relevant state change (cheap; no progress, so
    // clicks on inline buttons are never lost — live % goes in the panel).
    manager.onDidChangeStatus(() => this.refresh());
    downloads.onDidChangeState(() => this.refresh());
    spell.onDidChange(() => this.refresh());
    piper.onDidChange(() => this.refresh());
    chatterbox.onDidChange(() => this.refresh());
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
    // "Voices" view: 3 levels — engine › language › voice.
    if (this.section === 'voices') {
      if (!el) return this.voiceEngineGroups();
      if (el.kind === 'voice-engine') return this.voiceLangGroups(el.word || '');
      if (el.kind === 'voice-lang') { const [eng, lang] = (el.word || '').split(':'); return this.voicesForEngineLang(eng, lang); }
      return [];
    }
    // Flat views: items go directly to the root (the view heading IS the section).
    if (el) return [];
    switch (this.section) {
      case 'engines': return [this.ollamaEngine(), this.piperEngine(), this.chatterboxEngine()];
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
    it.command = { command: 'jotflow.engines.manage', title: tr('Engines') };
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
    it.command = { command: 'jotflow.engines.manage', title: tr('Engines') };
    return it;
  }

  private chatterboxEngine(): ModelsTreeItem {
    const it = new ModelsTreeItem('engine', 'Chatterbox (TTS)', undefined, undefined, 'chatterbox');
    let state: string;
    let icon: string;
    if (!this.chatterbox.isInstalled()) { state = 'notinstalled'; it.description = tr('not installed'); icon = 'cloud-download'; }
    else if (this.chatterbox.isServerRunning()) { state = 'running'; it.description = tr('running'); icon = 'pass-filled'; }
    else { state = 'stopped'; it.description = tr('stopped'); icon = 'circle-outline'; }
    it.contextValue = `engine.chatterbox.${state}`;
    it.iconPath = new vscode.ThemeIcon(icon);
    it.command = { command: 'jotflow.engines.manage', title: tr('Engines') };
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

  // ── Voices: engine › language › voice ──
  /** All downloaded voices flattened, each tagged with its engine and language. */
  private allVoices(): { id: string; label: string; sizeBytes: number; lang: string; engine: 'piper' | 'chatterbox'; source?: string }[] {
    const out: { id: string; label: string; sizeBytes: number; lang: string; engine: 'piper' | 'chatterbox'; source?: string }[] = [];
    for (const v of listPiperVoices(this.voicesDir)) {
      out.push({ id: v.id, label: v.id, sizeBytes: v.sizeBytes, lang: v.id.split('_')[0] || '?', engine: 'piper' });
    }
    for (const v of listChatterboxVoices(this.chatterbox.voicesDir())) {
      out.push({ id: v.id, label: v.label, sizeBytes: v.sizeBytes, lang: v.language || '?', engine: 'chatterbox', source: v.source });
    }
    return out;
  }
  /** Level 1: an engine node per engine that has voices. */
  private voiceEngineGroups(): ModelsTreeItem[] {
    const all = this.allVoices();
    if (!all.length) {
      const empty = new ModelsTreeItem('empty', tr('No voices downloaded'));
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }
    const engines: ('piper' | 'chatterbox')[] = ['piper', 'chatterbox'];
    return engines.filter((e) => all.some((v) => v.engine === e)).map((e) => {
      const it = new ModelsTreeItem('voice-engine', e === 'piper' ? 'Piper' : 'Chatterbox', undefined, undefined, e);
      it.description = String(all.filter((v) => v.engine === e).length);
      it.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      it.iconPath = new vscode.ThemeIcon('layers');
      return it;
    });
  }
  /** Level 2: a language node per language present for that engine. */
  private voiceLangGroups(engine: string): ModelsTreeItem[] {
    const all = this.allVoices().filter((v) => v.engine === engine);
    return [...new Set(all.map((v) => v.lang))].sort().map((lang) => {
      const name = (SPELL_LANG_NAMES as Record<string, string>)[lang] || lang;
      const it = new ModelsTreeItem('voice-lang', name, undefined, undefined, `${engine}:${lang}`);
      it.description = String(all.filter((v) => v.lang === lang).length);
      it.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      it.iconPath = new vscode.ThemeIcon('globe');
      return it;
    });
  }
  /** Level 3: the voices for an engine+language. */
  private voicesForEngineLang(engine: string, lang: string): ModelsTreeItem[] {
    return this.allVoices().filter((v) => v.engine === engine && v.lang === lang).map((v) => {
      const it = new ModelsTreeItem('voice', v.label, undefined, undefined, v.id);
      it.description = formatBytes(v.sizeBytes);
      it.tooltip = v.source ? `${v.label}\n${v.source}` : v.label;
      it.contextValue = v.engine === 'piper' ? 'piperVoice' : 'chatterboxVoice';
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
