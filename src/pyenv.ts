/** Shared Python bootstrap for the TTS engines (Piper, Chatterbox): a SHA-pinned self-contained
 *  Python downloaded once and reused across engines, plus per-engine venvs with pinned pip
 *  packages. Extracted from PiperManager so both engines share one implementation (no duplication).
 *
 *  Security: the self-contained Python is verified against a pinned SHA256 (fail-closed). Falling
 *  back to a PATH-resolved interpreter is command execution, so it is gated behind Workspace Trust
 *  — same posture as the filesystem tools and MCP servers. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { downloadFile, sha256File } from './download';
import { tr } from './i18n';

export type Notify = (msg: string) => void;

// Self-contained Python (astral-sh/python-build-standalone). Pinned checksums (fail-closed).
export const PYTHON_STANDALONE_TAG = '20260610';
const PYTHON_STANDALONE_VERSION = '3.12.13';
export const PYTHON_STANDALONE_SHA256: Record<string, string> = {
  'cpython-3.12.13+20260610-aarch64-apple-darwin-install_only.tar.gz': 'e18ddd4c1e8f4a1d6c4590b37f423d76aec734447edc20ed08e93983d95f2132',
  'cpython-3.12.13+20260610-x86_64-apple-darwin-install_only.tar.gz': 'ba02164e4db381af8c288c0bc1657584a835e9121a0fa2836b0f2e712ff8cdf5',
  'cpython-3.12.13+20260610-x86_64-unknown-linux-gnu-install_only.tar.gz': 'c218f50baeb2c06a30c2f03db5986b2bad6ab7c8a52faad2d5a59bda0677b93a',
  'cpython-3.12.13+20260610-aarch64-unknown-linux-gnu-install_only.tar.gz': 'bc74cf1bb517651868342b0619b21eaaf9f94a2022c9c61886dd980e16fb091b',
  'cpython-3.12.13+20260610-x86_64-pc-windows-msvc-install_only.tar.gz': 'f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316',
};
export function pythonStandaloneAsset(platform: string, arch: string): string | null {
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

/** Bootstraps a self-contained Python and per-engine venvs. The standalone interpreter lives in a
 *  shared `python/` dir so several engines reuse one ~100 MB download. */
export class PythonEnv {
  constructor(private readonly globalStorageUri: vscode.Uri) {}

  private dir(sub: string): string {
    return vscode.Uri.joinPath(this.globalStorageUri, sub).fsPath;
  }

  /** Path to `python` inside a named venv. */
  venvPython(venvSub: string): string {
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
    return path.join(this.dir(venvSub), bin, process.platform === 'win32' ? 'python.exe' : 'python');
  }
  /** Path to an executable installed by a venv's packages (e.g. `piper`, `yt-dlp`). */
  venvBin(venvSub: string, name: string): string {
    const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
    return path.join(this.dir(venvSub), bin, process.platform === 'win32' ? name + '.exe' : name);
  }

  /** Spawns a command and resolves on exit 0 (rejects with stderr otherwise). `onLine` receives the
   *  last non-empty segment of each output chunk (pip/HF progress uses '\r') for live feedback. */
  runCmd(cmd: string, args: string[], onLine?: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = cp.spawn(cmd, args);
      let err = '';
      const feed = (d: Buffer): void => {
        if (!onLine) return;
        const seg = d.toString().split(/[\r\n]+/).filter((s) => s.trim()).pop();
        if (seg) onLine(seg.trim());
      };
      p.stdout?.on('data', feed);
      p.stderr?.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); feed(d); });
      p.on('error', reject);
      p.on('close', (c: number) => (c === 0 ? resolve() : reject(new Error(err.trim() || `exit ${c}`))));
    });
  }

  // Looks for a Python compatible with the TTS engines (3.10–3.13).
  private findCompatiblePython(): string | null {
    const cands = [
      'python3.13', 'python3.12', 'python3.11', 'python3.10',
      '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3.11',
      '/usr/local/bin/python3.13', '/usr/local/bin/python3.12', '/usr/bin/python3', 'python3',
      'py', 'python',
    ];
    for (const c of cands) {
      try {
        const r = cp.spawnSync(c, ['-c', 'import sys;print(sys.version_info[1])'], { encoding: 'utf8' });
        if (r.status === 0) {
          const minor = parseInt((r.stdout || '').trim(), 10);
          if (minor >= 10 && minor <= 13) return c;
        }
      } catch { /* next */ }
    }
    return null;
  }

  // Downloads (if missing) the shared self-contained Python; returns its executable.
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

  /** Resolves a Python interpreter: the SHA-pinned standalone first, else a trusted system one. */
  private async resolvePython(notify?: Notify): Promise<string> {
    try {
      return await this.ensureStandalonePython(notify);
    } catch (e) {
      // Spawning a PATH-resolved interpreter is command execution → gate behind Workspace Trust
      // (same posture as the filesystem tools and MCP servers). The SHA-pinned standalone above is
      // always tried first; this only blocks the fallback in an untrusted workspace.
      if (!vscode.workspace.isTrusted) {
        throw new Error(tr('Could not set up the bundled Python and the system-Python fallback is disabled in an untrusted workspace. Trust this workspace (Workspace Trust) to enable neural TTS.'));
      }
      const sys = this.findCompatiblePython();
      if (!sys) throw e;
      return sys;
    }
  }

  /** Ensures a venv at `venvSub` with `pkgs` installed. `isInstalled` is the engine's own
   *  "fully installed" probe (e.g. its entry-point binary exists) so a half-built venv is rebuilt.
   *  `onStep(label, index)` marks the two internal phases (0: create env, 1: install packages) so a
   *  caller can render stepped progress. */
  async ensureVenv(venvSub: string, pkgs: string[], opts: { notify?: Notify; setupMsg: string; isInstalled: () => boolean; onStep?: (label: string, index: number) => void }): Promise<void> {
    if (opts.isInstalled()) return;
    const venvDir = this.dir(venvSub);
    const py = await this.resolvePython(opts.notify);
    const venvPy = this.venvPython(venvSub);
    opts.notify?.(opts.setupMsg);
    fs.mkdirSync(this.globalStorageUri.fsPath, { recursive: true });
    opts.onStep?.(tr('Creating the Python environment…'), 0);
    if (!fs.existsSync(venvPy)) await this.runCmd(py, ['-m', 'venv', venvDir]);
    // Forward pip's live progress (Downloading torch …, %, MB/MB) so the long wheel downloads show
    // movement and a percentage instead of a frozen "Setting up…".
    const onLine = (line: string): void => {
      if (/downloading|collecting|installing|building|\d+\s*%|\bMB\b|\bGB\b/i.test(line)) opts.notify?.(line.slice(0, 140));
    };
    // `python -m pip` (not the `pip` script): on Windows upgrading pip.exe while it runs fails with
    // WinError 5, and the standalone/venv pip can be too old to install the wheels below.
    await this.runCmd(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], onLine);
    opts.onStep?.(tr('Downloading and installing packages…'), 1);
    await this.runCmd(venvPy, ['-m', 'pip', 'install', ...pkgs], onLine);
    if (!opts.isInstalled()) throw new Error('package not found after install');
  }

  /** Deletes the shared standalone Python (only when no engine needs it anymore). */
  deleteStandalone(): void {
    try { fs.rmSync(this.dir('python'), { recursive: true, force: true }); } catch { /* noop */ }
  }
}
