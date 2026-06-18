/** Motor Piper (TTS): bootstrap autocontenido (Python + venv + binario) + voces. Reutilizable
 *  por el chat (síntesis) y por el gestor de engines (instalar/actualizar/borrar). */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { downloadFile, sha256File } from '../download';
import { tr } from '../i18n';

// Release del binario Piper standalone y nombre del asset por plataforma/arquitectura.
const PIPER_RELEASE = '2023.11.14-2';
const PIPER_ASSET_SHA256: Record<string, string> = {
  'piper_macos_aarch64.tar.gz': '6b1eb03b3735946cb35216e063e7eebcc33a6bbf5dd96ec0217959bf1cdcb0cc',
  'piper_macos_x64.tar.gz': 'ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b',
  'piper_linux_x86_64.tar.gz': 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992',
  'piper_linux_aarch64.tar.gz': 'fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb',
};
// Versión pineada de piper-tts (PyPI). Súbela a conciencia al revisar releases.
export const PIPER_TTS_VERSION = '1.4.2';

// Python autocontenido (astral-sh/python-build-standalone). Checksums pineados.
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

// SHA256 pineado del .onnx de cada voz curada (de huggingface.co/rhasspy/piper-voices vía lfs.oid).
const PIPER_VOICE_SHA256: Record<string, string> = {
  'es_MX-claude-high': '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0',
  'es_AR-daniela-high': '7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985',
  'es_ES-sharvard-medium': '40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1',
  'en_US-amy-medium': 'b3a6e47b57b8c7fbe6a0ce2518161a50f59a9cdd8a50835c02cb02bdd6206c18',
  'en_US-hfc_female-medium': '914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7',
  'en_GB-jenny_dioco-medium': '469c630d209e139dd392a66bf4abde4ab86390a0269c1e47b4e5d7ce81526b01',
};
/** Catálogo de voces curadas para descargar (id + etiqueta + idioma). Los ids DEBEN
 *  coincidir con las claves de PIPER_VOICE_SHA256 (fail-closed) y con media/main.js. */
export interface PiperVoiceInfo { id: string; label: string; lang: 'es' | 'en'; }
export const PIPER_VOICE_CATALOG: PiperVoiceInfo[] = [
  { id: 'es_MX-claude-high', label: 'Claude — Español 🇲🇽 (femenina)', lang: 'es' },
  { id: 'es_AR-daniela-high', label: 'Daniela — Español 🇦🇷 (femenina)', lang: 'es' },
  { id: 'es_ES-sharvard-medium', label: 'Sharvard — Español 🇪🇸', lang: 'es' },
  { id: 'en_US-amy-medium', label: 'Amy — English 🇺🇸 (female)', lang: 'en' },
  { id: 'en_US-hfc_female-medium', label: 'HFC — English 🇺🇸 (female)', lang: 'en' },
  { id: 'en_GB-jenny_dioco-medium', label: 'Jenny — English 🇬🇧 (female)', lang: 'en' },
];

/** URLs de HuggingFace de una voz Piper a partir de su id (lang_REGION-name-quality). */
function piperVoiceUrls(id: string): { onnx: string; json: string } {
  const [region, name, quality] = id.split('-');
  const lang = region.split('_')[0];
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${region}/${name}/${quality}/${id}`;
  return { onnx: base + '.onnx', json: base + '.onnx.json' };
}

export type Notify = (msg: string) => void;

export class PiperManager {
  private setupPromise: Promise<string> | null = null; // guard de concurrencia del setup

  constructor(private readonly context: vscode.ExtensionContext) {}

  private dir(sub: string): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, sub).fsPath;
  }
  /** Ruta del `piper` del venv pip. */
  venvBinPath(): string {
    return path.join(this.dir('piper-venv'), process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'piper.exe' : 'piper');
  }
  private standaloneBinPath(): string {
    return path.join(this.dir('piper-bin'), 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
  }

  /** ¿El motor está instalado (venv pip o binario standalone presente)? */
  isInstalled(): boolean {
    return fs.existsSync(this.venvBinPath()) || fs.existsSync(this.standaloneBinPath());
  }

  /** Asegura un modelo de voz descargado (a globalStorage); devuelve la ruta .onnx. */
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
    // Verifica integridad contra el SHA256 pineado. Falla cerrado: sin hash, no se usa.
    const expected = PIPER_VOICE_SHA256[id];
    if (!expected) { try { fs.unlinkSync(onnx); } catch { /* nada */ } throw new Error(`voz sin SHA256 pineado: ${id}`); }
    const got = sha256File(onnx);
    if (got !== expected) {
      try { fs.unlinkSync(onnx); } catch { /* nada */ }
      throw new Error(`integridad del modelo fallida (sha256 ${got.slice(0, 12)}… ≠ esperado)`);
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

  // Busca un Python compatible con piper-tts (3.9–3.13).
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
      } catch { /* siguiente */ }
    }
    return null;
  }

  // Descarga (si falta) un Python autocontenido; devuelve su ejecutable.
  private async ensureStandalonePython(notify?: Notify): Promise<string> {
    const dir = this.dir('python');
    const exe = process.platform === 'win32'
      ? path.join(dir, 'python', 'python.exe')
      : path.join(dir, 'python', 'bin', 'python3');
    if (fs.existsSync(exe)) return exe;
    const asset = pythonStandaloneAsset(process.platform, process.arch);
    if (!asset) throw new Error(`no hay Python autocontenido para ${process.platform}/${process.arch}`);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, asset);
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${asset}`;
    notify?.(tr('Downloading a self-contained Python (one-time)…'));
    await downloadFile(url, archive);
    const expected = PYTHON_STANDALONE_SHA256[asset];
    if (!expected) { try { fs.unlinkSync(archive); } catch { /* nada */ } throw new Error(`Python autocontenido sin SHA256 pineado: ${asset}`); }
    const got = sha256File(archive);
    if (got !== expected) { try { fs.unlinkSync(archive); } catch { /* nada */ } throw new Error('integridad de Python fallida'); }
    await new Promise<void>((resolve, reject) => {
      const p = cp.spawn('tar', ['-xzf', archive, '-C', dir]);
      let err = '';
      p.stderr?.on('data', (d: any) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (c: number) => (c === 0 ? resolve() : reject(new Error('tar: ' + (err.trim() || c)))));
    });
    try { fs.unlinkSync(archive); } catch { /* nada */ }
    if (!fs.existsSync(exe)) throw new Error('python no encontrado tras extraer');
    return exe;
  }

  // Crea (si falta) un venv con piper-tts y devuelve la ruta a su ejecutable `piper`.
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
    const pip = path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
    notify?.(tr('Setting up the Piper engine (one-time, ~1–2 min)…'));
    fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });
    await this.runCmd(py, ['-m', 'venv', venvDir]);
    await this.runCmd(pip, ['install', '--upgrade', 'pip']);
    await this.runCmd(pip, ['install', `piper-tts==${PIPER_TTS_VERSION}`]);
    if (!fs.existsSync(piperBin)) throw new Error('piper not found after install');
    return piperBin;
  }

  // Asegura el binario `piper` standalone (solo Linux es fiable); devuelve su ruta.
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
    if (!expected) { try { fs.unlinkSync(archive); } catch { /* nada */ } throw new Error(`binario Piper sin SHA256 pineado: ${asset}`); }
    const got = sha256File(archive);
    if (got !== expected) {
      try { fs.unlinkSync(archive); } catch { /* nada */ }
      throw new Error(`integridad del binario Piper fallida (sha256 ${got.slice(0, 12)}… ≠ esperado)`);
    }
    await new Promise<void>((resolve, reject) => {
      const p = cp.spawn('tar', ['-xzf', archive, '-C', dir]);
      let err = '';
      p.stderr?.on('data', (d: any) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (c: number) => (c === 0 ? resolve() : reject(new Error('tar: ' + (err.trim() || c)))));
    });
    try { fs.unlinkSync(archive); } catch { /* nada */ }
    try { fs.chmodSync(binPath, 0o755); } catch { /* nada */ }
    if (!fs.existsSync(binPath)) throw new Error('piper binary not found after extract');
    return binPath;
  }

  /** Resuelve el binario a usar: ruta explícita > venv pip > standalone (Linux). */
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

  /** Instala el motor (si falta). */
  async install(notify?: Notify): Promise<void> {
    await this.resolveBin(vscode.workspace.getConfiguration('langChat'), notify);
  }

  /** Actualiza el motor: venv pip → upgrade; standalone → re-descarga. */
  async update(notify?: Notify): Promise<void> {
    const pip = path.join(this.dir('piper-venv'), process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'pip.exe' : 'pip');
    if (fs.existsSync(pip)) {
      await this.runCmd(pip, ['install', '--upgrade', `piper-tts==${PIPER_TTS_VERSION}`]);
    } else {
      try { fs.rmSync(this.dir('piper-bin'), { recursive: true, force: true }); } catch { /* nada */ }
    }
    notify?.(tr('Piper updated.'));
  }

  /** Borra TODO el motor (venv + Python autocontenido + binario standalone) y sus voces descargadas. */
  delete(): void {
    for (const d of ['piper-venv', 'piper-bin', 'python', 'piper-voices']) {
      try { fs.rmSync(this.dir(d), { recursive: true, force: true }); } catch { /* nada */ }
    }
    this.setupPromise = null;
  }
}
