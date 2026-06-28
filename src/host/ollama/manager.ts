/** Lifecycle of the managed Ollama server (downloads its own binary + serve). */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as cp from 'child_process';
import { httpFetch } from '../http';
import { downloadFile, sha256File } from '../download';
import { OLLAMA_ASSET_SHA256, ollamaAsset, ollamaAssetUrl, assetFormat, ollamaBinName } from './assets';
import { killProcessTree } from '../procKill';
import { errMsg } from '../chatHelpers';
import { resolveApiKey } from '../providers';

export type OllamaStatus = 'stopped' | 'downloading' | 'starting' | 'ready' | 'error';

/** Finds a free TCP port on 127.0.0.1. */
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

/** Extracts an archive with `tar` (bsdtar on Win/mac, GNU tar on Linux handles --zstd). */
function extract(archive: string, dir: string, format: ReturnType<typeof assetFormat>): Promise<void> {
  const args = format === 'gz' ? ['-xzf', archive, '-C', dir]
    : format === 'zst' ? ['--zstd', '-xf', archive, '-C', dir]
      : ['-xf', archive, '-C', dir]; // zip: bsdtar supports this on mac/Win10+
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
  /** PID of the managed `ollama serve` process (for RAM sampling), if running. */
  serverPid(): number | undefined { return this.proc?.pid; }

  private set(status: OllamaStatus, detail = ''): void {
    this._status = status; this._detail = detail;
    this.log(`[ollama] ${status} ${detail}`);
    this._onChange.fire();
  }

  private get binDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'ollama-bin');
  }

  /** Finds the executable (BFS, shallowest first) within the extracted directory. */
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

  /** Ensures the downloaded private binary is present (D1: never uses the system one). Returns its path. */
  async ensureBinary(onProgress?: (received: number, total: number) => void): Promise<string> {
    const asset = ollamaAsset(process.platform, process.arch);
    if (!asset) throw new Error(`Ollama not supported on ${process.platform}/${process.arch}`);
    const binName = ollamaBinName(process.platform);
    const existing = this.findBinary(this.binDir, binName);
    if (existing) return existing;

    const expected = OLLAMA_ASSET_SHA256[asset];
    if (!expected) throw new Error(`Ollama without pinned SHA256: ${asset}`); // fail-closed
    fs.mkdirSync(this.binDir, { recursive: true });
    const archive = path.join(this.binDir, asset);
    this.set('downloading', asset);
    try {
      await downloadFile(ollamaAssetUrl(asset), archive, { onProgress });
      const got = sha256File(archive);
      if (got !== expected) {
        try { fs.unlinkSync(archive); } catch { /* ignore */ }
        throw new Error(`Ollama integrity check failed (sha256 ${got.slice(0, 12)}… ≠ expected)`);
      }
      await extract(archive, this.binDir, assetFormat(asset));
      try { fs.unlinkSync(archive); } catch { /* ignore */ }
      const bin = this.findBinary(this.binDir, binName);
      if (!bin) throw new Error('ollama binary not found after extracting');
      if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ } }
      return bin;
    } finally {
      // Don't leave the status stuck at 'downloading' when installing outside of start()
      // (start() sets 'starting'/'ready' right after and overwrites it).
      if (this._status === 'downloading') this.set(this.proc ? 'ready' : 'stopped');
    }
  }

  /** Waits until the server responds at /api/version (or throws on timeout). */
  private async waitHealthy(baseUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await httpFetch(`${baseUrl}/api/version`);
        if (res.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('the Ollama server did not respond in time');
  }

  /** Starts the managed server (idempotent, with concurrency guard). Returns the baseUrl. */
  async start(onProgress?: (received: number, total: number) => void): Promise<string> {
    if (this._status === 'ready' && this._baseUrl) return this._baseUrl;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        const bin = await this.ensureBinary(onProgress);
        const cfg = vscode.workspace.getConfiguration('jotflow');
        let port = cfg.get<number>('ollama.port', 0);
        if (!port || port <= 0) port = await freePort();
        const host = `127.0.0.1:${port}`;
        const env: NodeJS.ProcessEnv = { ...process.env, OLLAMA_HOST: host };
        const modelsPath = cfg.get<string>('ollama.modelsPath', '');
        if (modelsPath) env.OLLAMA_MODELS = modelsPath;
        // Authenticate the server with ollama.com so it can proxy cloud models (`model:cloud`).
        const apiKey = resolveApiKey('ollama');
        if (apiKey) env.OLLAMA_API_KEY = apiKey;
        this.set('starting', host);
        this.proc = cp.spawn(bin, ['serve'], { env, stdio: 'ignore', shell: process.platform === 'win32' });
        this.proc.on('exit', (code) => {
          this.proc = null; this._baseUrl = undefined;
          if (this._status !== 'stopped') this.set('error', `ollama serve exited (code ${code})`);
        });
        this.proc.on('error', (e) => this.set('error', String(e)));
        const baseUrl = `http://${host}`;
        await this.waitHealthy(baseUrl, 30000);
        this._baseUrl = baseUrl;
        this.set('ready', baseUrl);
        return baseUrl;
      } catch (e) {
        this.set('error', errMsg(e));
        throw e;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  /**
   * Imports local .gguf file(s) as an Ollama model (`ollama create … -f Modelfile`).
   * A split model is passed as several `ggufPaths` (one FROM line each — Ollama merges them; pointing
   * at only part 1 fails with "has 1 shards, expected N"). If `projectorPath` (mmproj) is provided,
   * it is added as a final FROM to enable vision.
   */
  async create(name: string, ggufPaths: string[], projectorPath?: string): Promise<void> {
    const baseUrl = await this.start();
    const bin = await this.ensureBinary();
    const modelfile = ggufPaths[0] + '.Modelfile';
    const lines = ggufPaths.map((p) => `FROM ${p}`);
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
      try { fs.unlinkSync(modelfile); } catch { /* ignore */ }
    }
  }

  /** Stops the server (does not delete the binary or models). */
  stop(): void {
    this.set('stopped');
    this._baseUrl = undefined;
    if (this.proc) { killProcessTree(this.proc); this.proc = null; } // tree-kill: shell:true on Windows wraps cmd.exe
  }

  /** Is the private binary downloaded? */
  isInstalled(): boolean {
    return !!this.findBinary(this.binDir, ollamaBinName(process.platform));
  }

  /** Stops the server and deletes the downloaded binary (re-downloaded on next start). */
  deleteBinary(): void {
    this.stop();
    try { fs.rmSync(this.binDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this._onChange.fire();
  }

  dispose(): void {
    this.stop();
    this._onChange.dispose();
  }
}
