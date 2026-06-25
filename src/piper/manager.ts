/** Piper engine (TTS): self-contained bootstrap (Python + venv + binary) + voices. Reusable
 *  by the chat (synthesis) and by the engine manager (install/update/delete). */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as http from 'http';
import * as net from 'net';
import { downloadFile, sha256File } from '../download';
import { killProcessTree } from '../procKill';
import { tr } from '../i18n';

import {
  PIPER_RELEASE, PIPER_ASSET_SHA256, PIPER_TTS_VERSION, PYTHON_STANDALONE_SHA256, PYTHON_STANDALONE_TAG,
  pythonStandaloneAsset, piperAsset, PIPER_VOICE_SHA256, piperVoiceUrls, PIPER_VOICE_CATALOG,
} from './assets';
import type { Notify, PiperVoiceInfo } from './assets';
import { errMsg } from '../chatHelpers';

// Re-exported so existing importers (voicesPanel) keep their path.
export { PIPER_TTS_VERSION, PIPER_VOICE_CATALOG };
export type { Notify, PiperVoiceInfo };

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
    // The .onnx.json (phoneme map / config consumed by the native binary) has no pinned hash, so
    // validate it structurally: a truncated download or an HF HTML error page saved as .json would
    // otherwise be trusted forever (the old `if (!existsSync) download` skipped re-fetching it).
    const jsonValid = (): boolean => {
      try {
        const cfg = JSON.parse(fs.readFileSync(json, 'utf8'));
        return !!cfg && typeof cfg === 'object' && !Array.isArray(cfg)
          && !!cfg.phoneme_id_map && typeof cfg.phoneme_id_map === 'object';
      } catch { return false; }
    };
    if (fs.existsSync(onnx) && fs.existsSync(json) && jsonValid()) return onnx;
    const urls = piperVoiceUrls(id);
    notify?.(tr('Downloading voice: ') + id + ' …');
    if (!fs.existsSync(json) || !jsonValid()) {
      try { fs.unlinkSync(json); } catch { /* may not exist */ }
      await downloadFile(urls.json, json);
      if (!jsonValid()) { try { fs.unlinkSync(json); } catch { /* noop */ } throw new Error(`voice config invalid/corrupt: ${id}`); }
    }
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
      p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
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
      p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
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
      // Fallback to a Python resolved via PATH (python3/py/python). Spawning a PATH-resolved
      // interpreter is command execution, so gate it behind Workspace Trust — same posture as the
      // filesystem tools and MCP servers (L7). The SHA-pinned standalone above is always tried first
      // and is unaffected; this only blocks the fallback in an untrusted workspace.
      if (!vscode.workspace.isTrusted) {
        throw new Error(tr('Could not set up the bundled Python and the system-Python fallback is disabled in an untrusted workspace. Trust this workspace (Workspace Trust) to enable Piper TTS.'));
      }
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
      p.stderr?.on('data', (d: Buffer) => { err += d.toString(); });
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
    await this.resolveBin(vscode.workspace.getConfiguration('jotflow'), notify);
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
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', () => {
      if (this.serverProc === proc) { this.serverProc = null; this.serverPort = 0; this._onChange.fire(); }
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    });
    // Fail fast on a spawn error (e.g. python deleted between the check and spawn → ENOENT) instead
    // of waiting out the full 20s waitForServer timeout.
    const spawnErr = new Promise<never>((_, rej) => proc.once('error', (e) => rej(e instanceof Error ? e : new Error(String(e)))));
    try {
      await Promise.race([this.waitForServer(port, 20000), spawnErr]);
    } catch (e) {
      killProcessTree(proc);
      throw new Error((stderr.trim().split('\n').slice(-3).join(' ') || errMsg(e)) ?? 'piper http_server did not respond');
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
      // Don't hang the TTS UI forever if the daemon stops responding mid-request (K6).
      req.setTimeout(30000, () => req.destroy(new Error('piper http_server timed out')));
      req.write(body);
      req.end();
    });
  }

  /** Stops the daemon (if running). */
  stopServer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const was = !!this.serverProc;
    if (this.serverProc) { killProcessTree(this.serverProc); this.serverProc = null; } // tree-kill + SIGKILL escalation
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
