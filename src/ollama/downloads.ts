/** Model download manager: observable and PERSISTENT queue, with progress, cancel and retry. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { pull } from './registry';
import { hfFileUrl, projectorFile } from './catalog';
import { downloadFile } from '../download';
import { tr } from '../i18n';
import { errMsg } from '../chatHelpers';

export type DownloadState = 'queued' | 'downloading' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface DownloadItem {
  id: string;
  ref: string;        // hf.co/user/repo:quant (pull) or model name (import)
  label: string;      // human-readable text (id:quant)
  modelId: string;    // HF repo id (to map progress to the model in the explorer)
  quant: string;
  size: number;       // expected bytes (from HF)
  state: DownloadState;
  status: string;     // status text sent by Ollama
  received: number;
  total: number;
  error?: string;
  // 'pull' = native Ollama pull; 'import' = download the .gguf(s) and `ollama create`. A 'pull' item
  // also carries import* data: the runtime fallback flips it to 'import' if the pull fails with a 400
  // (HF serves a broken manifest descriptor for some quants). The mmproj projector is resolved at
  // import time from modelId, so it is not stored here.
  mode: 'pull' | 'import';
  importPaths?: string[]; // repo-relative .gguf path(s); >1 means a split/sharded model
  name?: string;          // Ollama model name for `ollama create`
}

export interface StartOpts {
  ref: string; label: string; size: number; modelId: string; quant: string;
  mode: 'pull' | 'import'; importPaths?: string[]; name?: string;
}

const STORAGE_KEY = 'jotflow.downloads';

export class DownloadManager {
  private items = new Map<string, DownloadItem>();
  private aborts = new Map<string, AbortController>();
  private seq = 0;
  private lastPersist = 0;
  // Progress + state: consumed by the panel (smooth progress per tick).
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onChange.event;
  // STATE changes ONLY (not progress): consumed by the tree, to avoid recreating rows on every
  // tick (which caused lost clicks on inline cancel/retry buttons).
  private readonly _onState = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this._onState.event;

  /**
   * @param ensureServer starts (if needed) the managed Ollama and returns its baseUrl.
   * @param createModel  imports a local .gguf with `ollama create` (import mode).
   * @param onComplete   called when a download finishes (to refresh the local model list).
   * @param storage      persistent storage (context.globalState) to survive restarts.
   * @param importDir    temporary folder for downloading .gguf files in import mode.
   */
  constructor(
    private readonly ensureServer: () => Promise<string | undefined>,
    private readonly createModel: (name: string, modelPaths: string[], projPath?: string) => Promise<void>,
    private readonly onComplete: () => void,
    private readonly storage: vscode.Memento,
    private readonly importDir: string
  ) {
    // Restores downloads from previous sessions. Those that were "in progress" are marked as
    // interrupted (the process died when VS Code was closed) → the user can retry (Ollama resumes).
    for (const it of this.storage.get<DownloadItem[]>(STORAGE_KEY, [])) {
      if (!it.mode) {
        // Migrate items persisted before the pull/import refactor (had a single `importModel` URL).
        const legacy = (it as { importModel?: string }).importModel;
        it.mode = legacy ? 'import' : 'pull';
        if (legacy && !it.importPaths) {
          const m = legacy.match(/\/resolve\/main\/(.+)$/);
          it.importPaths = m ? [decodeURIComponent(m[1])] : [];
        }
      }
      if (it.state === 'downloading') { it.state = 'interrupted'; it.error = tr('interrupted (VS Code was closed)'); }
      else if (it.state === 'queued') { it.state = 'cancelled'; } // were queued but never started
      this.items.set(it.id, it);
      const n = parseInt(it.id.replace(/^dl/, ''), 10);
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
    }
  }

  list(): DownloadItem[] { return [...this.items.values()]; }
  /** Unfinished downloads (in progress, interrupted, errored, or cancelled) — shown in the manager. */
  pending(): DownloadItem[] { return this.list().filter((i) => i.state !== 'done'); }
  active(): DownloadItem[] { return this.list().filter((i) => i.state === 'downloading'); }
  get(id: string): DownloadItem | undefined { return this.items.get(id); }

  private persist(): void { void this.storage.update(STORAGE_KEY, this.list()); }
  private maybePersist(): void {
    const now = Date.now();
    if (now - this.lastPersist > 3000) { this.lastPersist = now; this.persist(); }
  }
  /** STATE change: persists and notifies both (tree + panel). */
  private fireState(): void { this.persist(); this._onState.fire(); this._onChange.fire(); }

  /** Enqueues a download (pull or import). Returns the id. Reuses the entry if that ref already exists. */
  start(opts: StartOpts): string {
    const existing = this.list().find((i) => i.ref === opts.ref && i.state !== 'done');
    if (existing) {
      if (existing.state !== 'downloading' && existing.state !== 'queued') this.enqueue(existing);
      return existing.id;
    }
    const id = `dl${++this.seq}`;
    const item: DownloadItem = {
      id, ref: opts.ref, label: opts.label, modelId: opts.modelId, quant: opts.quant, size: opts.size,
      state: 'queued', status: '', received: 0, total: opts.size,
      mode: opts.mode, importPaths: opts.importPaths, name: opts.name,
    };
    this.items.set(id, item);
    this.fireState();
    this.processNext();
    return id;
  }

  private enqueue(item: DownloadItem): void {
    item.state = 'queued'; item.error = undefined;
    this.fireState();
    this.processNext();
  }

  /** Starts as many queued items as the concurrency limit allows (several in parallel). */
  private processNext(): void {
    const max = Math.max(1, vscode.workspace.getConfiguration('jotflow').get<number>('ollama.maxConcurrentDownloads', 2));
    while (this.active().length < max) {
      const next = this.list().find((i) => i.state === 'queued');
      if (!next) break;
      void this.run(next); // marks the item as 'downloading' synchronously before the first await
    }
  }

  private async run(item: DownloadItem): Promise<void> {
    item.state = 'downloading'; item.error = undefined; item.status = ''; this.fireState();
    const ac = new AbortController();
    this.aborts.set(item.id, ac);
    try {
      if (item.mode === 'import') {
        await this.doImport(item, ac.signal);
      } else {
        try {
          await this.doPull(item, ac.signal);
        } catch (e) {
          // HF serves a broken manifest descriptor for some quants → the pull dies with "400:" after
          // downloading the layers. Fall back to a direct .gguf import (which we have the paths for).
          if (ac.signal.aborted || !this.isTagError(e) || !item.importPaths?.length) throw e;
          item.mode = 'import'; item.received = 0; item.total = item.size;
          item.status = tr('Ollama pull failed; importing the .gguf directly…');
          this.fireState();
          await this.doImport(item, ac.signal);
        }
      }
      // `reader.cancel()`/abort can complete without throwing: detect the abort here too.
      if (ac.signal.aborted) item.state = 'cancelled';
      else { item.state = 'done'; this.onComplete(); }
    } catch (e) {
      if (ac.signal.aborted) item.state = 'cancelled';
      else { item.state = 'error'; item.error = errMsg(e); }
    } finally {
      this.aborts.delete(item.id);
      this.fireState();
      this.processNext(); // starts the next item in the queue
    }
  }

  /** Does this error look like an HF tag/manifest 400 (so an import fallback is worth trying)? */
  private isTagError(e: unknown): boolean {
    const m = String(errMsg(e));
    return /(?:^|\D)400(?:\D|$)/.test(m) || /tag .*not .*available/i.test(m);
  }

  /** Pull mode: downloads via Ollama (native resume). */
  private async doPull(item: DownloadItem, signal: AbortSignal): Promise<void> {
    const baseUrl = await this.ensureServer();
    if (!baseUrl) throw new Error(tr('could not start the Ollama server'));
    await pull(baseUrl, item.ref, (p) => {
      item.status = p.status || '';
      item.received = p.completed || 0;
      if (p.total) item.total = p.total;
      this.maybePersist();
      this._onChange.fire();
    }, signal);
  }

  /**
   * Import mode: downloads the .gguf (every shard) plus the mmproj, and imports with `ollama create`
   * (all shards referenced in the Modelfile, since Ollama will not auto-find them). No resume.
   */
  private async doImport(item: DownloadItem, signal: AbortSignal): Promise<void> {
    await this.ensureServer(); // required for `ollama create`
    // Per-item subfolder: two concurrent imports whose shards share a basename (e.g. both
    // `model-00001-of-00002.gguf`) would otherwise write to the same path and corrupt each other.
    const itemDir = path.join(this.importDir, String(item.id).replace(/[^a-z0-9._-]/gi, '_'));
    fs.mkdirSync(itemDir, { recursive: true });
    const paths = item.importPaths || [];
    if (!paths.length) throw new Error('no .gguf to import');
    const tmpFiles: string[] = [];   // everything to clean up
    const modelParts: string[] = []; // the model shards, in order → one FROM line each
    try {
      // A split model needs ALL parts present and ALL referenced in the Modelfile: pointing Ollama at
      // only part 1 fails with "has 1 shards, expected N". The sanitiser keeps the shard suffix intact.
      let done = 0;
      for (let i = 0; i < paths.length; i++) {
        const base = (paths[i].split('/').pop() || `model${i}.gguf`).replace(/[^a-z0-9._-]/gi, '_');
        const dest = path.join(itemDir, base);
        tmpFiles.push(dest); modelParts.push(dest);
        item.status = paths.length > 1
          ? `${tr('downloading model')} (${i + 1}/${paths.length})`
          : tr('downloading model');
        this._onChange.fire();
        let last = 0;
        await downloadFile(hfFileUrl(item.modelId, paths[i]), dest, {
          signal,
          onProgress: (r, t) => { last = r; item.received = done + r; item.total = item.size || t; this.maybePersist(); this._onChange.fire(); },
        });
        done += last;
      }
      // Vision projector (mmproj), if the repo has one → final FROM in the Modelfile enables vision.
      let projTmp: string | undefined;
      const proj = await projectorFile(item.modelId, signal).catch(() => undefined);
      if (proj) {
        projTmp = path.join(itemDir, ((item.name || 'model').replace(/[^a-z0-9._-]/gi, '_')) + '.mmproj.gguf');
        item.status = tr('downloading projector (vision)'); this._onChange.fire();
        await downloadFile(hfFileUrl(item.modelId, proj), projTmp, { signal });
        tmpFiles.push(projTmp);
      }
      item.status = tr('registering in Ollama'); this._onChange.fire();
      await this.createModel(item.name || item.ref, modelParts, projTmp);
    } finally {
      for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      try { fs.rmdirSync(itemDir); } catch { /* not empty / already gone */ }
    }
  }

  cancel(id: string): void {
    const it = this.items.get(id);
    if (!it) return;
    if (it.state === 'queued') { it.state = 'cancelled'; this.fireState(); return; }
    this.aborts.get(id)?.abort();
  }
  retry(id: string): void { const it = this.items.get(id); if (it && it.state !== 'downloading') this.enqueue(it); }
  remove(id: string): void { this.cancel(id); this.items.delete(id); this.fireState(); }
  /** Clears finished/cancelled/errored/interrupted entries (leaves active ones). */
  clearFinished(): void {
    for (const [id, it] of this.items) if (it.state !== 'downloading') this.items.delete(id);
    this.fireState();
  }

  dispose(): void {
    for (const ac of this.aborts.values()) { try { ac.abort(); } catch { /* ignore */ } }
    this._onChange.dispose();
    this._onState.dispose();
  }
}
