/** Gestor de descargas de modelos: cola observable y PERSISTENTE, con progreso, cancelar y reintentar. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { pull } from './registry';
import { downloadFile } from '../download';
import { tr } from '../i18n';

export type DownloadState = 'queued' | 'downloading' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface DownloadItem {
  id: string;
  ref: string;        // hf.co/usuario/repo:quant (pull) o nombre del modelo (import)
  label: string;      // texto legible (id:quant)
  modelId: string;    // id del repo HF (para mapear el progreso al modelo en el explorador)
  quant: string;
  size: number;       // bytes esperados (de HF)
  state: DownloadState;
  status: string;     // texto de estado que manda Ollama
  received: number;
  total: number;
  error?: string;
  // Modo "import" (repos que el pull no resuelve): descarga el .gguf e importa con `ollama create`.
  importModel?: string; // URL del .gguf a descargar
  importProj?: string;  // URL del mmproj (visión), opcional
  name?: string;        // nombre del modelo Ollama para `ollama create`
}

export interface StartOpts {
  ref: string; label: string; size: number; modelId: string; quant: string;
  importModel?: string; importProj?: string; name?: string;
}

const STORAGE_KEY = 'langChat.downloads';

export class DownloadManager {
  private items = new Map<string, DownloadItem>();
  private aborts = new Map<string, AbortController>();
  private seq = 0;
  private lastPersist = 0;
  // Progreso + estado: lo consume el panel (progreso fluido por tick).
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onChange.event;
  // SOLO cambios de estado (no progreso): lo consume el árbol, para no recrear las filas en cada
  // tick (eso hacía perder los clics en los botones inline cancelar/reintentar).
  private readonly _onState = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this._onState.event;

  /**
   * @param ensureServer arranca (si hace falta) el Ollama gestionado y devuelve su baseUrl.
   * @param createModel  importa un .gguf local con `ollama create` (modo import).
   * @param onComplete   se llama al terminar una descarga (para refrescar la lista de modelos locales).
   * @param storage      almacenamiento persistente (context.globalState) para sobrevivir reinicios.
   * @param importDir    carpeta temporal para descargar los .gguf del modo import.
   */
  constructor(
    private readonly ensureServer: () => Promise<string | undefined>,
    private readonly createModel: (name: string, modelPath: string, projPath?: string) => Promise<void>,
    private readonly onComplete: () => void,
    private readonly storage: vscode.Memento,
    private readonly importDir: string
  ) {
    // Restaura descargas de sesiones anteriores. Las que quedaron "en curso" se marcan como
    // interrumpidas (el proceso murió al cerrar VS Code) → el usuario puede reintentar (Ollama reanuda).
    for (const it of this.storage.get<DownloadItem[]>(STORAGE_KEY, [])) {
      if (it.state === 'downloading') { it.state = 'interrupted'; it.error = tr('interrupted (VS Code was closed)'); }
      else if (it.state === 'queued') { it.state = 'cancelled'; } // estaban en cola sin empezar
      this.items.set(it.id, it);
      const n = parseInt(it.id.replace(/^dl/, ''), 10);
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
    }
  }

  list(): DownloadItem[] { return [...this.items.values()]; }
  /** Descargas no terminadas (en curso, interrumpidas, con error o canceladas) — las que muestra el gestor. */
  pending(): DownloadItem[] { return this.list().filter((i) => i.state !== 'done'); }
  active(): DownloadItem[] { return this.list().filter((i) => i.state === 'downloading'); }
  get(id: string): DownloadItem | undefined { return this.items.get(id); }

  private persist(): void { void this.storage.update(STORAGE_KEY, this.list()); }
  private maybePersist(): void {
    const now = Date.now();
    if (now - this.lastPersist > 3000) { this.lastPersist = now; this.persist(); }
  }
  /** Cambio de ESTADO: persiste y notifica a ambos (árbol + panel). */
  private fireState(): void { this.persist(); this._onState.fire(); this._onChange.fire(); }

  /** Encola una descarga (pull o import). Devuelve el id. Reusa la entrada si ya existe ese ref. */
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
      importModel: opts.importModel, importProj: opts.importProj, name: opts.name,
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

  /** Arranca tantas en cola como permita el límite de concurrencia (varias en paralelo). */
  private processNext(): void {
    const max = Math.max(1, vscode.workspace.getConfiguration('langChat').get<number>('ollama.maxConcurrentDownloads', 2));
    while (this.active().length < max) {
      const next = this.list().find((i) => i.state === 'queued');
      if (!next) break;
      void this.run(next); // marca el item como 'downloading' de forma síncrona antes del primer await
    }
  }

  private async run(item: DownloadItem): Promise<void> {
    item.state = 'downloading'; item.error = undefined; item.status = ''; this.fireState();
    const ac = new AbortController();
    this.aborts.set(item.id, ac);
    try {
      if (item.importModel) await this.doImport(item, ac.signal);
      else await this.doPull(item, ac.signal);
      // `reader.cancel()`/abort pueden terminar sin lanzar: detecta el abort también aquí.
      if (ac.signal.aborted) item.state = 'cancelled';
      else { item.state = 'done'; this.onComplete(); }
    } catch (e: any) {
      if (ac.signal.aborted) item.state = 'cancelled';
      else { item.state = 'error'; item.error = e?.message || String(e); }
    } finally {
      this.aborts.delete(item.id);
      this.fireState();
      this.processNext(); // arranca la siguiente de la cola
    }
  }

  /** Modo pull: descarga vía Ollama (resume nativo). */
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

  /** Modo import: descarga el .gguf (y mmproj) e importa con `ollama create`. Sin resume. */
  private async doImport(item: DownloadItem, signal: AbortSignal): Promise<void> {
    await this.ensureServer(); // necesario para `ollama create`
    fs.mkdirSync(this.importDir, { recursive: true });
    const safe = (item.name || item.ref).replace(/[^a-z0-9._-]/gi, '_');
    const modelTmp = path.join(this.importDir, safe + '.gguf');
    const projTmp = path.join(this.importDir, safe + '.mmproj.gguf');
    try {
      item.status = tr('downloading model'); this._onChange.fire();
      await downloadFile(item.importModel!, modelTmp, {
        signal,
        onProgress: (r, t) => { item.received = r; item.total = t || item.size; this.maybePersist(); this._onChange.fire(); },
      });
      if (item.importProj) {
        item.status = tr('downloading projector (vision)'); this._onChange.fire();
        await downloadFile(item.importProj, projTmp, { signal });
      }
      item.status = tr('registering in Ollama'); this._onChange.fire();
      await this.createModel(item.name || item.ref, modelTmp, item.importProj ? projTmp : undefined);
    } finally {
      try { fs.unlinkSync(modelTmp); } catch { /* nada */ }
      try { fs.unlinkSync(projTmp); } catch { /* nada */ }
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
  /** Limpia las entradas terminadas/canceladas/erróneas/interrumpidas (deja las activas). */
  clearFinished(): void {
    for (const [id, it] of this.items) if (it.state !== 'downloading') this.items.delete(id);
    this.fireState();
  }

  dispose(): void {
    for (const ac of this.aborts.values()) { try { ac.abort(); } catch { /* nada */ } }
    this._onChange.dispose();
    this._onState.dispose();
  }
}
