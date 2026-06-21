/** Piper engine (TTS): self-contained bootstrap (Python + venv + binary) + voices. Reusable
 *  by the chat (synthesis) and by the engine manager (install/update/delete). */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as http from 'http';
import * as net from 'net';
import { downloadFile, sha256File } from '../download';
import { tr } from '../i18n';

// Release of the standalone Piper binary and asset name per platform/architecture.
const PIPER_RELEASE = '2023.11.14-2';
const PIPER_ASSET_SHA256: Record<string, string> = {
  'piper_macos_aarch64.tar.gz': '6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc',
  'piper_macos_x64.tar.gz': 'ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b',
  'piper_linux_x86_64.tar.gz': 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
  'piper_linux_aarch64.tar.gz': 'fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb',
};
// Pinned version of piper-tts (PyPI). Bump it deliberately when reviewing releases.
export const PIPER_TTS_VERSION = '1.4.2';

// Self-contained Python (astral-sh/python-build-standalone). Pinned checksums.
const PYTHON_STANDALONE_TAG = '20260610';
const PYTHON_STANDALONE_VERSION = '3.12.13';
const PYTHON_STANDALONE_SHA256: Record<string, string> = {
  'cpython-3.12.13+20260610-aarch64-apple-darwin-install_only.tar.gz': 'e18ddd4c1e8f4a1d6c4590b37f423d76aec734447edc20ed08e93983d95f2132',
  'cpython-3.12.13+20260610-x86_64-apple-darwin-install_only.tar.gz': 'ba02164e4db381af8c288c0bc1657584a835e9121a0fa2836b0f2e712ff8cdf5',
  'cpython-3.12.13+20260610-x86_64-unknown-linux-gnu-install_only.tar.gz': 'c218f50baeb2c06a30c2f03db5986b2bad6ab7c8a52faad2d5a59bda0677b93a',
  'cpython-3.12.13+20260610-aarch64-unknown-linux-gnu-install_only.tar.gz': 'bc74cf1bb517651868342b0619b21eaaf9f94a2022c9c61886dd980e16fb091b',
  'cpython-3.12.13+20260610-x86_64-pc-windows-msvc-install_only.tar.gz': 'f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316',
};
function pythonStandaloneAsset(platform: string, arch: string): string | null {
  const triples: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const triple = triples[`${platform}-${arch}`];
  return triple ? `cpython-${PYTHON_STANDALONE_VERSION}+${PYTHON_STANDALONE_TAG}-${triple}-install_only.tar.gz` : null;
}
function piperAsset(platform: string, arch: string): string | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'piper_macos_aarch64.tar.gz' : 'piper_macos_x64.tar.gz';
  if (platform === 'linux') return arch === 'arm64' ? 'piper_linux_aarch64.tar.gz' : 'piper_linux_x86_64.tar.gz';
  if (platform === 'win32') return 'piper_windows_amd64.zip';
  return null;
}

// Pinned SHA256 of the .onnx for each curated voice (from huggingface.co/rhasspy/piper-voices via lfs.oid).
const PIPER_VOICE_SHA256: Record<string, string> = {
  'es_MX-claude-high': '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0',
  'es_AR-daniela-high': '7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985',
  'es_ES-sharvard-medium': '40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1',
  'en_US-amy-medium': 'b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18',
  'en_US-hfc_female-medium': '914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7',
  'en_GB-jenny_dioco-medium': '469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01',
  'pt_BR-faber-medium': '858555e3a064209c57088fe6bd70c4c3dc54d03eaa00c45d5ecaf43a33f95aa7',
  'fr_FR-siwis-medium': '641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99',
  'de_DE-thorsten-medium': '7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819',
  'it_IT-paola-medium': '6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c',
};
/** Catalog of curated voices available for download (id + label + language). The ids MUST
 *  match the keys in PIPER_VOICE_SHA256 (fail-closed) and media/main.js. */
export interface PiperVoiceInfo { id: string; label: string; lang: 'es' | 'en' | 'pt' | 'fr' | 'de' | 'it'; }
export const PIPER_VOICE_CATALOG: PiperVoiceInfo[] = [
  { id: 'es_MX-claude-high', label: 'Claude — Spanish 🇲🇽 (female)', lang: 'es' },
  { id: 'es_AR-daniela-high', label: 'Daniela — Spanish 🇦🇷 (female)', lang: 'es' },
  { id: 'es_ES-sharvard-medium', label: 'Sharvard — Spanish 🇪🇸', lang: 'es' },
  { id: 'en_US-amy-medium', label: 'Amy — English 🇺🇸 (female)', lang: 'en' },
  { id: 'en_US-hfc_female-medium', label: 'HFC — English 🇺🇸 (female)', lang: 'en' },
  { id: 'en_GB-jenny_dioco-medium', label: 'Jenny — English 🇬🇧 (female)', lang: 'en' },
  { id: 'pt_BR-faber-medium', label: 'Faber — Portuguese 🇧🇷 (male)', lang: 'pt' },
  { id: 'fr_FR-siwis-medium', label: 'Siwis — French 🇫🇷 (female)', lang: 'fr' },
  { id: 'de_DE-thorsten-medium', label: 'Thorsten — German 🇩🇪 (male)', lang: 'de' },
  { id: 'it_IT-paola-medium', label: 'Paola — Italian 🇮🇹 (female)', lang: 'it' },
];

/** HuggingFace URLs for a Piper voice given its id (lang_REGION-name-quality). */
function piperVoiceUrls(id: string): { onnx: string; json: string } {
  const [region, name, quality] = id.split('-');
  const lang = region.split('_')[0];
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${region}/${name}/${quality}/${id}`;
  return { onnx: base + '.onnx', json: base + '.onnx.json' };
}

export type Notify = (msg: string) => void;

export class PiperManager {
  private setupPromise: Promise<string> | null = null; // concurrency guard for setup
  // HTTP daemon (resident model): started on first TTS and auto-shuts down on idle.
  private serverProc: cp.ChildProcess | null = null;
  private serverPort = 0;
  private serverStarting: Promise<string> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private httpDepsOk = false; // flask verified/installed in this venv
  private static readonly SERVER_IDLE_MS = 5 * 60 * 1000;
  // Notifies daemon state changes (start/stop) to refresh the tree.
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private dir(sub: string): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, sub).fsPath;
  }
  /** Path to the `piper` binary in the pip venv. */
  venvBinPath(): string {
    return path.join(this.dir('piper-venv'), process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'piper.exe' : 'piper');
  }
  private standaloneBinPath(): string {
    return path.join(this.dir('piper-bin'), 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
  }

  /** Is the engine installed (pip venv or standalone binary present)? */
  isInstalled(): boolean {
    return fs.existsSync(this.venvBinPath()) || fs.existsSync(this.standaloneBinPath());
  }

  /** Ensures a voice model is downloaded (to globalStorage); returns the .onnx path. */
  async ensureVoice(id: string, notify?: Notify): Promise<string> {
    const dir = this.dir('piper-voices');
    fs.mkdirSync(dir, { recursive: true });
    const onnx = path.join(dir, id + '.onnx');
    const json = path.join(dir, id + '.onnx.json');
    if (fs.existsSync(onnx) && fs.existsSync(json)) return onnx;
    const urls = piperVoiceUrls(id);
    notify?.(tr('Downloading voice: ') + id + ' …');
    if (!fs.existsSync(json)) await downloadFile(urls.json, json);
    if (!fs.existsSync(onnx)) await downloadFile(urls.onnx, onnx);
    // Verify integrity against the pinned SHA256. Fail-closed: no hash, not used.
    const expected = PIPER_VOICE_SHA256[id];
    if (!expected) { try { fs.unlinkSync(onnx); } catch { /* noop */ } throw new Error(`voice has no pinned SHA256: ${id}`); }
    const got = sha256File(onnx);
    if (got !== expected) {
      try { fs.unlinkSync(onnx); } catch { /* noop */ }
      throw new Error(`model integrity check failed (sha256 ${got.slice(0, 12)}… ≠ expected)`);
    }
    return onnx;
  }

  private runCmd(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = cp.spawn(cmd, args);
      let err = '';
      p.stderr?.on('data', (d: any) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (c: number) => (c === 0 ? resolve() : reject(new Error(err.trim() || `exit ${c}`))));
    });
  }

  // Looks for a Python compatible with piper-tts (3.9–3.13).
  private findCompatiblePython(): string | null {
    const cands = [
      'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9',
      '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3.11',
      '/usr/local/bin/python3.13', '/usr/local/bin/python3.12', '/usr/bin/python3', 'python3',
      'py', 'python',
    ];
    for (const c of cands) {
      try {
        const r = cp.spawnSync(c, ['-c', 'import sys;print(sys.version_info[1])'], { encoding: 'utf8' });
        if (r.status === 0) {
          const minor = parseInt((r.stdout || '').trim(), 10);
          if (minor >= 9 && minor <= 13) return c;
        }
      } catch { /* next */ }
    }
    return null;
  }

  // Downloads (if missing) a self-contained Python; returns its executable.
  private async ensureStandalonePython(notify?: Notify): Promise<string> {
    const dir = this.dir('python');
    const exe = process.platform === 'win32'
      ? path.join(dir, 'python', 'python.exe')
      : path.join(dir, 'python', 'bin', 'python3');
    if (fs.existsSync(exe)) return exe;
    const asset = pythonStandaloneAsset(process.platform, process.arch);
    if (!asset) throw new Error(`no self-contained Python for ${process.platform}/${process.arch}`);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, asset);
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${asset}`;
    notify?.(tr('Downloading a self-contained Python (one-time)…'));
    await downloadFile(url, archive);
    const expected = PYTHON_STANDALONE_SHA256[asset];
    if (!expected) { try { fs.unlinkSync(archive); } catch { /* noop */ } throw new Error(`self-contained Python has no pinned SHA256: ${asset}`); }
    const got = sha256File(archive);
    if (got !== expected) { try { fs.unlinkSync(archive); } catch { /* noop */ } throw new Error('Python integrity check failed'); }
    await new Promise<void>((resolve, reject) => {
      const p = cp.spawn('tar', ['-xzf', archive, '-C', dir]);
      let err = '';
      p.stderr?.on('data', (d: any) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (c: number) => (c === 0 ? resolve() : reject(new Error('tar: ' + (err.trim() || c)))));
    });
    try { fs.unlinkSync(archive); } catch { /* noop */ }
    if (!fs.existsSync(exe)) throw new Error('python not found after extracting');
    return exe;
  }

  // Creates (if missing) a venv with piper-tts and returns the path to its `piper` executable.
  private async ensurePiperVenv(notify?: Notify): Promise<string> {
    const venvDir = this.dir('piper-venv');
    const piperBin = this.venvBinPath();
    if (fs.existsSync(piperBin)) return piperBin;
    let py: string;
    try {
      py = await this.ensureStandalonePython(notify);
    } catch (e) {
      const sys = this.findCompatiblePython();
      if (!sys) throw e;
      py = sys;
    }
    const venvPy = this.venvPython();
    notify?.(tr('Setting up the Piper engine (one-time, ~1–2 min)…'));
    fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
    await this.runCmd(py, ['-m', 'venv', venvDir]);
    // `python -m pip` (not the `pip` script): on Windows upgrading pip.exe while it runs fails
    // with WinError 5, and the standalone/venv pip can be too old to install the wheels below.
    await this.runCmd(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    // [http] includes flask for the HTTP daemon (synthesis without reloading the model each time).
    await this.runCmd(venvPy, ['-m', 'pip', 'install', `piper-tts[http]==${PIPER_TTS_VERSION}`]);
    if (!fs.existsSync(piperBin)) throw new Error('piper not found after install');
    return piperBin;
  }

  // Ensures the standalone `piper` binary (reliable only on Linux); returns its path.
  private async ensurePiperBinary(notify?: Notify): Promise<string> {
    const dir = this.dir('piper-bin');
    const exe = process.platform === 'win32' ? 'piper.exe' : 'piper';
    const binPath = path.join(dir, 'piper', exe);
    if (fs.existsSync(binPath)) return binPath;
    const asset = piperAsset(process.platform, process.arch);
    if (!asset) throw new Error(`no prebuilt Piper for ${process.platform}/${process.arch}`);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, asset);
    const url = `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/${asset}`;
    notify?.(tr('Downloading the Piper engine (first time only)…'));
    await downloadFile(url, archive);
    const expected = PIPER_ASSET_SHA256[asset];
    if (!expected) { try { fs.unlinkSync(archive); } catch { /* noop */ } throw new Error(`Piper binary has no pinned SHA256: ${asset}`); }
    const got = sha256File(archive);
    if (got !== expected) {
      try { fs.unlinkSync(archive); } catch { /* noop */ }
      throw new Error(`Piper binary integrity check failed (sha256 ${got.slice(0, 12)}… ≠ expected)`);
    }
    await new Promise<void>((resolve, reject) => {
      const p = cp.spawn('tar', ['-xzf', archive, '-C', dir]);
      let err = '';
      p.stderr?.on('data', (d: any) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (c: number) => (c === 0 ? resolve() : reject(new Error('tar: ' + (err.trim() || c)))));
    });
    try { fs.unlinkSync(archive); } catch { /* noop */ }
    try { fs.chmodSync(binPath, 0o755); } catch { /* noop */ }
    if (!fs.existsSync(binPath)) throw new Error('piper binary not found after extract');
    return binPath;
  }

  /** Resolves the binary to use: explicit path > pip venv > standalone (Linux). */
  async resolveBin(cfg: vscode.WorkspaceConfiguration, notify?: Notify): Promise<string> {
    const setting = cfg.get<string>('tts.piperPath', 'piper') || 'piper';
    if (setting && setting !== 'piper' && fs.existsSync(setting)) return setting;
    if (fs.existsSync(this.venvBinPath())) return this.venvBinPath();
    if (!this.setupPromise) {
      this.setupPromise = (async () => {
        try {
          return await this.ensurePiperVenv(notify);
        } catch (e) {
          if (process.platform === 'linux') return this.ensurePiperBinary(notify);
          throw e;
        }
      })();
      const clear = () => { this.setupPromise = null; };
      this.setupPromise.then(clear, clear);
    }
    return this.setupPromise;
  }

  /** Installs the engine (if missing). */
  async install(notify?: Notify): Promise<void> {
    await this.resolveBin(vscode.workspace.getConfiguration('parley'), notify);
  }

  // ───────────────────────── Daemon HTTP (piper.http_server) ─────────────────────────

  /** Is the daemon alive? */
  isServerRunning(): boolean { return !!this.serverProc; }

  /** Path to `python` in the venv. */
  private venvPython(): string {
    return path.join(this.dir('piper-venv'), process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  }

  /** Asks the OS for a free TCP port on 127.0.0.1. */
  private freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
      });
    });
  }

  /** Resets the idle timer: after SERVER_IDLE_MS without activity, shuts down the daemon. */
  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopServer(), PiperManager.SERVER_IDLE_MS);
  }

  /** Ensures the HTTP daemon is started (pointing to the voices folder). Returns baseUrl.
   *  `defaultModel` is an .onnx path required by the server (-m); other voices are
   *  loaded on-demand via the `voice` field of the request. Throws if it cannot start. */
  async ensureServer(defaultModel: string, notify?: Notify): Promise<string> {
    if (this.serverProc && this.serverPort) { this.touchIdle(); return `http://127.0.0.1:${this.serverPort}`; }
    if (!this.serverStarting) {
      this.serverStarting = this.startServer(defaultModel, notify).finally(() => { this.serverStarting = null; });
    }
    return this.serverStarting;
  }

  private async startServer(defaultModel: string, notify?: Notify): Promise<string> {
    await this.ensurePiperVenv(notify);       // ensures venv (with [http]→flask for new installs)
    const python = this.venvPython();
    if (!fs.existsSync(python)) throw new Error('venv python not found');
    await this.ensureHttpDeps(python, notify); // old installs: adds flask on-demand
    const voicesDir = this.dir('piper-voices');
    const port = await this.freePort();
    const args = ['-m', 'piper.http_server', '-m', defaultModel, '--data-dir', voicesDir, '--host', '127.0.0.1', '--port', String(port)];
    const proc = cp.spawn(python, args, { cwd: path.dirname(python) });
    let stderr = '';
    proc.stderr?.on('data', (d: any) => { stderr += d.toString(); });
    proc.on('exit', () => {
      if (this.serverProc === proc) { this.serverProc = null; this.serverPort = 0; this._onChange.fire(); }
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    });
    try {
      await this.waitForServer(port, 20000);
    } catch (e: any) {
      try { proc.kill(); } catch { /* noop */ }
      throw new Error((stderr.trim().split('\n').slice(-3).join(' ') || e?.message) ?? 'piper http_server did not respond');
    }
    this.serverProc = proc;
    this.serverPort = port;
    this.touchIdle();
    this._onChange.fire();
    return `http://127.0.0.1:${port}`;
  }

  /** Ensures flask (the [http] extra) is in the venv; older installs don't include it. */
  private async ensureHttpDeps(python: string, notify?: Notify): Promise<void> {
    if (this.httpDepsOk) return;
    const check = cp.spawnSync(python, ['-c', 'import flask']);
    if (check.status === 0) { this.httpDepsOk = true; return; }
    notify?.(tr('Setting up the Piper engine (one-time, ~1–2 min)…'));
    await this.runCmd(python, ['-m', 'pip', 'install', `piper-tts[http]==${PIPER_TTS_VERSION}`]);
    this.httpDepsOk = true;
  }

  /** Polls GET / until the server responds (or times out). */
  private waitForServer(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = (): Promise<void> => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    const loop = async (): Promise<void> => {
      for (;;) {
        try { await tryOnce(); return; }
        catch {
          if (Date.now() > deadline) throw new Error('timeout waiting for piper http_server');
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    };
    return loop();
  }

  /** Synthesizes via the daemon: POST /synthesize → WAV Buffer. `voice` = curated voice id. */
  synthViaServer(baseUrl: string, text: string, voice: string, lengthScale: number, speakerId: number): Promise<Buffer> {
    this.touchIdle();
    const body = JSON.stringify({
      text,
      voice,
      length_scale: lengthScale,
      ...(speakerId >= 0 ? { speaker_id: speakerId } : {}),
    });
    const u = new URL('/synthesize', baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { method: 'POST', host: u.hostname, port: Number(u.port), path: u.pathname,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode === 200 && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') resolve(buf);
            else reject(new Error(`http_server ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Stops the daemon (if running). */
  stopServer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const was = !!this.serverProc;
    if (this.serverProc) { try { this.serverProc.kill(); } catch { /* noop */ } this.serverProc = null; }
    this.serverPort = 0;
    if (was) this._onChange.fire();
  }

  /** Updates the engine: pip venv → upgrade; standalone → re-download. */
  async update(notify?: Notify): Promise<void> {
    this.stopServer(); // releases the venv before reinstalling
    this.httpDepsOk = false;
    const venvPy = this.venvPython();
    if (fs.existsSync(venvPy)) {
      await this.runCmd(venvPy, ['-m', 'pip', 'install', '--upgrade', `piper-tts[http]==${PIPER_TTS_VERSION}`]);
    } else {
      try { fs.rmSync(this.dir('piper-bin'), { recursive: true, force: true }); } catch { /* noop */ }
    }
    notify?.(tr('Piper updated.'));
  }

  /** Deletes the ENTIRE engine (venv + self-contained Python + standalone binary) and its downloaded voices. */
  delete(): void {
    this.stopServer();
    this.httpDepsOk = false;
    for (const d of ['piper-venv', 'piper-bin', 'python', 'piper-voices']) {
      try { fs.rmSync(this.dir(d), { recursive: true, force: true }); } catch { /* noop */ }
    }
    this.setupPromise = null;
  }

  /** Shuts down the daemon when the extension deactivates (avoids leaving an orphan process). */
  dispose(): void { this.stopServer(); this._onChange.dispose(); }

  /** .onnx path of the first downloaded voice (to start the daemon manually). */
  firstVoiceModel(): string | undefined {
    const dir = this.dir('piper-voices');
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return undefined; }
    const onnx = files.filter((f) => f.endsWith('.onnx')).sort()[0];
    return onnx ? path.join(dir, onnx) : undefined;
  }
}
