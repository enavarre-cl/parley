/** Ciclo de vida del servidor Ollama gestionado (descarga binario propio + serve). */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as cp from 'child_process';
import { httpFetch } from '../http';
import { downloadFile, sha256File } from '../download';
import { OLLAMA_ASSET_SHA256, ollamaAsset, ollamaAssetUrl, assetFormat, ollamaBinName } from './assets';

export type OllamaStatus = 'stopped' | 'downloading' | 'starting' | 'ready' | 'error';

/** Busca un puerto TCP libre en 127.0.0.1. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Extrae un archivo con `tar` (bsdtar en Win/mac, GNU tar en Linux maneja --zstd). */
function extract(archive: string, dir: string, format: ReturnType<typeof assetFormat>): Promise<void> {
  const args = format === 'gz' ? ['-xzf', archive, '-C', dir]
    : format === 'zst' ? ['--zstd', '-xf', archive, '-C', dir]
      : ['-xf', archive, '-C', dir]; // zip: bsdtar lo soporta en mac/Win10+
  return new Promise((resolve, reject) => {
    const p = cp.spawn('tar', args);
    let err = '';
    p.stderr?.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('tar: ' + (err.trim() || c)))));
  });
}

export class OllamaManager {
  private proc: cp.ChildProcess | null = null;
  private _baseUrl: string | undefined;
  private _status: OllamaStatus = 'stopped';
  private _detail = '';
  private startPromise: Promise<string> | null = null;
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this._onChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (s: string) => void = () => { }
  ) { }

  get status(): OllamaStatus { return this._status; }
  get detail(): string { return this._detail; }
  baseUrl(): string | undefined { return this._baseUrl; }

  private set(status: OllamaStatus, detail = ''): void {
    this._status = status; this._detail = detail;
    this.log(`[ollama] ${status} ${detail}`);
    this._onChange.fire();
  }

  private get binDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'ollama-bin');
  }

  /** Busca el ejecutable (BFS, el más superficial) dentro del directorio extraído. */
  private findBinary(dir: string, name: string): string | null {
    if (!fs.existsSync(dir)) return null;
    const queue = [dir];
    while (queue.length) {
      const d = queue.shift()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isFile() && e.name === name) return path.join(d, e.name);
      for (const e of entries) if (e.isDirectory()) queue.push(path.join(d, e.name));
    }
    return null;
  }

  /** Asegura el binario propio descargado (D1: nunca usa el del sistema). Devuelve su ruta. */
  async ensureBinary(onProgress?: (received: number, total: number) => void): Promise<string> {
    const asset = ollamaAsset(process.platform, process.arch);
    if (!asset) throw new Error(`Ollama no soportado en ${process.platform}/${process.arch}`);
    const binName = ollamaBinName(process.platform);
    const existing = this.findBinary(this.binDir, binName);
    if (existing) return existing;

    const expected = OLLAMA_ASSET_SHA256[asset];
    if (!expected) throw new Error(`Ollama sin SHA256 pineado: ${asset}`); // fail-closed
    fs.mkdirSync(this.binDir, { recursive: true });
    const archive = path.join(this.binDir, asset);
    this.set('downloading', asset);
    await downloadFile(ollamaAssetUrl(asset), archive, { onProgress });
    const got = sha256File(archive);
    if (got !== expected) {
      try { fs.unlinkSync(archive); } catch { /* nada */ }
      throw new Error(`integridad de Ollama fallida (sha256 ${got.slice(0, 12)}… ≠ esperado)`);
    }
    await extract(archive, this.binDir, assetFormat(asset));
    try { fs.unlinkSync(archive); } catch { /* nada */ }
    const bin = this.findBinary(this.binDir, binName);
    if (!bin) throw new Error('no se encontró el binario ollama tras extraer');
    if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch { /* nada */ } }
    return bin;
  }

  /** Espera a que el servidor responda /api/version (o lanza al agotar el tiempo). */
  private async waitHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await httpFetch(`${baseUrl}/api/version`);
        if (res.ok) return;
      } catch { /* aún no arranca */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('el servidor Ollama no respondió a tiempo');
  }

  /** Arranca el servidor gestionado (idempotente, con guard de concurrencia). Devuelve el baseUrl. */
  async start(onProgress?: (received: number, total: number) => void): Promise<string> {
    if (this._status === 'ready' && this._baseUrl) return this._baseUrl;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        const bin = await this.ensureBinary(onProgress);
        const cfg = vscode.workspace.getConfiguration('langChat');
        let port = cfg.get<number>('ollama.port', 0);
        if (!port || port <= 0) port = await freePort();
        const host = `127.0.0.1:${port}`;
        const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: host };
        const modelsPath = cfg.get<string>('ollama.modelsPath', '');
        if (modelsPath) env.OLLAMA_MODELS = modelsPath;
        this.set('starting', host);
        this.proc = cp.spawn(bin, ['serve'], { env, stdio: 'ignore', shell: process.platform === 'win32' });
        this.proc.on('exit', (code) => {
          this.proc = null; this._baseUrl = undefined;
          if (this._status !== 'stopped') this.set('error', `ollama serve salió (código ${code})`);
        });
        this.proc.on('error', (e) => this.set('error', String(e)));
        const baseUrl = `http://${host}`;
        await this.waitHealthy(baseUrl, 30000);
        this._baseUrl = baseUrl;
        this.set('ready', baseUrl);
        return baseUrl;
      } catch (e: any) {
        this.set('error', e?.message || String(e));
        throw e;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  /**
   * Importa un .gguf local como modelo de Ollama (`ollama create … -f Modelfile`).
   * Si se da `projectorPath` (mmproj), se añade como segundo FROM para habilitar la visión.
   */
  async create(name: string, ggufPath: string, projectorPath?: string): Promise<void> {
    const baseUrl = await this.start();
    const bin = await this.ensureBinary();
    const modelfile = ggufPath + '.Modelfile';
    const lines = [`FROM ${ggufPath}`];
    if (projectorPath) lines.push(`FROM ${projectorPath}`);
    fs.writeFileSync(modelfile, lines.join('\n') + '\n');
    try {
      await new Promise<void>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: baseUrl.replace(/^https?:\/\//, '') };
        const p = cp.spawn(bin, ['create', name, '-f', modelfile], { env, shell: process.platform === 'win32' });
        let err = '';
        p.stderr?.on('data', (d) => { err += d.toString(); });
        p.on('error', reject);
        p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ollama create: ' + (err.trim() || c)))));
      });
    } finally {
      try { fs.unlinkSync(modelfile); } catch { /* nada */ }
    }
  }

  /** Detiene el servidor (no borra el binario ni los modelos). */
  stop(): void {
    this.set('stopped');
    this._baseUrl = undefined;
    if (this.proc) { try { this.proc.kill(); } catch { /* nada */ } this.proc = null; }
  }

  dispose(): void {
    this.stop();
    this._onChange.dispose();
  }
}
