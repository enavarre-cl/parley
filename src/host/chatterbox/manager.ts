/** Chatterbox engine (Resemble AI, neural TTS with zero-shot voice cloning). Self-contained:
 *  a pip venv (chatterbox-tts + imageio-ffmpeg), a resident HTTP daemon serving synthesis, and
 *  reference-voice creation by trimming a local audio/video file the user picks. Mirrors the shape
 *  of PiperManager; shares the Python bootstrap (pyenv) and daemon primitives (ttsDaemon).
 *
 *  Security: pip versions are pinned (pip verifies hashes vs the PyPI index, same as piper-tts). The
 *  voice source is a local file chosen via the native picker — no network/URL fetch — and ffmpeg is
 *  spawned with an argv array (never a shell). Spawning these interpreters is command execution,
 *  gated behind Workspace Trust by pyenv. The daemon binds to 127.0.0.1 only and is killed on
 *  deactivate. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as http from 'http';
import { killProcessTree } from '../procKill';
import { tr } from '../i18n';
import { PythonEnv, Notify } from '../pyenv';
import { freePort, waitForHttp } from '../ttsDaemon';
import { parseProgressPct as linePct } from '../progress';
import { errMsg } from '../chatHelpers';
import {
  CHATTERBOX_TTS_VERSION, IMAGEIO_FFMPEG_VERSION, MLX_AUDIO_VERSION, CHATTERBOX_MLX_MODEL,
  CHATTERBOX_DEFAULT_MODEL, CHATTERBOX_DEFAULT_DEVICE, REF_CLIP_MAX_SECONDS, isChatterboxModel,
  isChatterboxLanguage, validateRange, isSafeVoiceId,
} from './assets';
import { writeChatterboxVoiceMeta, chatterboxVoicePath } from '../chatterboxVoices';

const VENV = 'chatterbox-venv';
const MODELS_DIR = 'chatterbox-models';   // HF_HOME for the (large) weights
const VOICES_DIR = 'chatterbox-voices';   // reference clips

// Apple Silicon uses the fast MLX backend (mlx-audio, no PyTorch); everything else uses torch.
const IS_APPLE_SILICON = process.platform === 'darwin' && process.arch === 'arm64';

export interface CreateVoiceRequest { id: string; label: string; language?: string; start?: string; end?: string; filePath: string }

export class ChatterboxManager {
  private setupPromise: Promise<void> | null = null;
  private serverProc: cp.ChildProcess | null = null;
  private serverPort = 0;
  private serverStarting: Promise<string> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private ffmpegBin: string | null = null;
  private currentJob: cp.ChildProcess | null = null; // the ffmpeg trim in flight (to cancel)
  private synthOnLine: ((line: string) => void) | null = null; // routes the daemon's per-synthesis "Sampling …%" lines
  private static readonly SERVER_IDLE_MS = 10 * 60 * 1000;
  // The first start downloads the weights (~3 GB) inside the server process and only answers once
  // the model is loaded — so this must comfortably outlast a multi-GB download on a slow link. Live
  // progress is streamed to `notify`, so a stalled download is visible rather than a silent hang.
  private static readonly START_TIMEOUT_MS = 30 * 60 * 1000;
  private readonly py: PythonEnv;
  private readonly serverScript: string;
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.py = new PythonEnv(context.globalStorageUri);
    this.serverScript = vscode.Uri.joinPath(context.extensionUri, 'media', 'py', 'chatterbox_server.py').fsPath;
  }

  private dir(sub: string): string {
    return vscode.Uri.joinPath(this.context.globalStorageUri, sub).fsPath;
  }
  voicesDir(): string { return this.dir(VOICES_DIR); }
  private venvPython(): string { return this.py.venvPython(VENV); }

  /** Is a Python package present in the venv's site-packages (version-dir agnostic)? */
  private hasPkg(pkg: string): boolean {
    const lib = path.join(this.dir(VENV), 'lib');
    try {
      for (const d of fs.readdirSync(lib)) {       // e.g. python3.12
        if (fs.existsSync(path.join(lib, d, 'site-packages', pkg))) return true;
      }
    } catch { /* no lib dir yet */ }
    return fs.existsSync(path.join(this.dir(VENV), 'Lib', 'site-packages', pkg)); // Windows
  }

  /** Is the engine installed for the CURRENT backend (so an old torch venv re-installs mlx-audio)?
   *  Requires the TTS package + imageio-ffmpeg (used to trim the reference clip). */
  isInstalled(): boolean {
    return this.hasPkg(IS_APPLE_SILICON ? 'mlx_audio' : 'chatterbox') && this.hasPkg('imageio_ffmpeg');
  }
  /** Is the synthesis daemon alive? */
  isServerRunning(): boolean { return !!this.serverProc; }
  /** PID of the resident-model daemon (for RAM sampling), if running. */
  serverPid(): number | undefined { return this.serverProc?.pid; }

  // ───────────────────────── Engine bootstrap ─────────────────────────

  /** Ensures the venv (chatterbox-tts + imageio-ffmpeg). Concurrency-guarded.
   *  `onStep(label, index)` marks the venv-create (0) and package-install (1) phases. */
  async ensureEngine(notify?: Notify, onStep?: (label: string, index: number) => void): Promise<void> {
    if (this.isInstalled()) return;
    if (!this.setupPromise) {
      // Apple Silicon: mlx-audio (4-bit, no PyTorch — far lighter/faster). Else: chatterbox-tts +
      // `setuptools<81` (REQUIRED: its watermarker imports `pkg_resources`, dropped by setuptools ≥81).
      const ttsPkgs = IS_APPLE_SILICON
        ? [`mlx-audio==${MLX_AUDIO_VERSION}`]
        : [`chatterbox-tts==${CHATTERBOX_TTS_VERSION}`, 'setuptools<81'];
      this.setupPromise = this.py.ensureVenv(
        VENV,
        [...ttsPkgs, `imageio-ffmpeg==${IMAGEIO_FFMPEG_VERSION}`],
        { notify, setupMsg: tr('Setting up the Chatterbox engine (one-time)…'), isInstalled: () => this.isInstalled(), onStep },
      );
      const clear = (): void => { this.setupPromise = null; };
      this.setupPromise.then(clear, clear);
    }
    await this.setupPromise;
  }

  /** Installs the engine and warms the model (downloads the weights, ~1–2 GB) by starting the daemon.
   *  Reports an overall 0..1 across two weighted steps (1: venv + PyTorch, 2: weights + model load),
   *  with the within-step download fraction when a line carries one. */
  async install(progress?: (msg: string, pct?: number) => void): Promise<void> {
    // Three weighted steps so the bar makes visible jumps and fills smoothly within each:
    //   0: create the Python env · 1: install PyTorch + Chatterbox + tools · 2: weights + model load.
    const STEPS = 3;
    let cur = 0;
    const at = (step: number, msg: string, frac?: number): void =>
      progress?.(msg, Math.min(1, (step + (frac ?? 0)) / STEPS));
    at(0, tr('Setting up the Chatterbox engine…'), 0);
    await this.ensureEngine(
      (m) => at(cur, m, linePct(m)),                 // pip/HF lines → sub-% of the current step
      (label, idx) => { cur = idx; at(idx, label, 0); }, // step boundaries (0: env, 1: packages)
    );
    cur = 2;
    at(2, tr('Downloading the Chatterbox model (one-time, ~1–2 GB)…'), 0);
    await this.ensureServer((m) => at(2, m, linePct(m)));  // weights download + load → 66..100%
    at(3, tr('Ready.'));                                    // → 100%
  }

  /** Resolves the bundled ffmpeg (from imageio-ffmpeg) used to trim/normalize the reference clip. */
  private async ensureFfmpeg(notify?: Notify): Promise<string> {
    if (this.ffmpegBin && fs.existsSync(this.ffmpegBin)) return this.ffmpegBin;
    await this.ensureEngine(notify);
    const r = cp.spawnSync(this.venvPython(), ['-c', 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' });
    const p = (r.stdout || '').trim();
    if (r.status !== 0 || !p || !fs.existsSync(p)) throw new Error('ffmpeg not available: ' + ((r.stderr || '').trim() || 'unknown'));
    this.ffmpegBin = p;
    return p;
  }

  // ───────────────────────── Daemon (HTTP, resident model) ─────────────────────────

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopServer(), ChatterboxManager.SERVER_IDLE_MS);
  }

  /** Current model from settings (validated). */
  private currentModel(): string {
    const raw = vscode.workspace.getConfiguration('jotflow').get<string>('tts.chatterboxModel', CHATTERBOX_DEFAULT_MODEL);
    return isChatterboxModel(raw) ? raw : CHATTERBOX_DEFAULT_MODEL;
  }
  /** Marker written once a model has loaded successfully → next start can run offline (no network). */
  private markerPath(key: string): string { return path.join(this.dir(MODELS_DIR), `.ready-${key}`); }
  /** Cache key for the loaded model (MLX is always the one quantized multilingual model). */
  private markerKey(): string { return IS_APPLE_SILICON ? 'mlx' : this.currentModel(); }

  /** Ensures the daemon is running; returns its baseUrl. Throws if it cannot start. */
  async ensureServer(notify?: Notify): Promise<string> {
    if (this.serverProc && this.serverPort) { this.touchIdle(); return `http://127.0.0.1:${this.serverPort}`; }
    if (!this.serverStarting) {
      // Start offline (cache-only) if this model has loaded before — avoids HF network checks on
      // every launch. If that fails (cache missing / model switched), retry online to download.
      const offline = fs.existsSync(this.markerPath(this.markerKey()));
      this.serverStarting = this.startServer(notify, offline)
        .catch((e) => { if (offline) return this.startServer(notify, false); throw e; })
        .finally(() => { this.serverStarting = null; });
    }
    return this.serverStarting;
  }

  private async startServer(notify: Notify | undefined, offline: boolean): Promise<string> {
    await this.ensureEngine(notify);
    const cfg = vscode.workspace.getConfiguration('jotflow');
    fs.mkdirSync(this.dir(MODELS_DIR), { recursive: true });
    const python = this.venvPython();
    if (!fs.existsSync(python)) throw new Error('venv python not found');
    const port = await freePort();
    const args = [this.serverScript, '--host', '127.0.0.1', '--port', String(port), '--hf-home', this.dir(MODELS_DIR)];
    if (IS_APPLE_SILICON) {
      args.push('--backend', 'mlx', '--mlx-model', CHATTERBOX_MLX_MODEL);
    } else {
      const model = this.currentModel();
      const device = cfg.get<string>('tts.chatterboxDevice', CHATTERBOX_DEFAULT_DEVICE) || 'auto';
      args.push('--backend', 'torch', '--model', model, '--device', device);
    }
    if (offline) args.push('--offline');
    const proc = cp.spawn(python, args, { cwd: path.dirname(python) });
    let stderr = '';
    let ready = false;
    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk; if (stderr.length > 8000) stderr = stderr.slice(-8000);
      const seg = chunk.split(/[\r\n]+/).filter((s) => s.trim()).pop();
      if (!seg) return;
      if (!ready) {
        // Startup: forward HF download % / model-loading lines to the install progress UI.
        if (/download|loading|fetch|\bMB\b|\bGB\b|%|model/i.test(seg)) notify?.(seg.trim().slice(0, 140));
      } else if (this.synthOnLine && /sampling/i.test(seg)) {
        // Once ready, the same stderr carries per-synthesis "Sampling …%" — route it to the active
        // read-aloud request (set by synthViaServer), NOT the install UI.
        this.synthOnLine(seg);
      }
    });
    proc.on('exit', () => {
      if (this.serverProc === proc) { this.serverProc = null; this.serverPort = 0; this._onChange.fire(); }
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    });
    const spawnErr = new Promise<never>((_, rej) => proc.once('error', (e) => rej(e instanceof Error ? e : new Error(String(e)))));
    // If the process EXITS before it answers (e.g. crashes while loading the model), fail fast with
    // its stderr instead of polling a dead port until the long startup timeout — that looked "stuck".
    const exitErr = new Promise<never>((_, rej) => proc.once('exit', (code) => {
      if (!ready) rej(new Error((stderr.trim().split('\n').slice(-4).join(' ') || `chatterbox server exited (code ${code}) before becoming ready`)));
    }));
    try {
      await Promise.race([waitForHttp(port, ChatterboxManager.START_TIMEOUT_MS), spawnErr, exitErr]);
      ready = true;
    } catch (e) {
      killProcessTree(proc);
      throw new Error(stderr.trim().split('\n').slice(-3).join(' ') || errMsg(e) || 'chatterbox server did not respond');
    }
    this.serverProc = proc;
    this.serverPort = port;
    this.touchIdle();
    // Mark this model as fully loaded so the next launch can run offline (no HF network checks).
    try { fs.writeFileSync(this.markerPath(this.markerKey()), ''); } catch { /* best-effort */ }
    this._onChange.fire();
    return `http://127.0.0.1:${port}`;
  }

  /** Synthesizes via the daemon: POST /synthesize → WAV Buffer. `languageId` (e.g. 'es') is used by
   *  the multilingual model to speak the cloned voice in that language. */
  synthViaServer(baseUrl: string, text: string, refWav: string, exaggeration: number, cfgWeight: number, languageId?: string, onProgress?: (pct: number) => void): Promise<Buffer> {
    this.touchIdle();
    // Route the daemon's "Sampling …%" stderr (this request only) to the progress callback.
    this.synthOnLine = onProgress ? (line: string): void => { const p = linePct(line); if (p != null) onProgress(p); } : null;
    const done = (): void => { this.synthOnLine = null; };
    const body = JSON.stringify({ text, ref_wav: refWav || null, exaggeration, cfg_weight: cfgWeight, ...(languageId ? { language_id: languageId } : {}) });
    const u = new URL('/synthesize', baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { method: 'POST', host: u.hostname, port: Number(u.port), path: u.pathname,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d: Buffer) => chunks.push(d));
          res.on('end', () => {
            done();
            const buf = Buffer.concat(chunks);
            if (res.statusCode === 200 && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') resolve(buf);
            else reject(new Error(`chatterbox ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`));
          });
        }
      );
      req.on('error', (e) => { done(); reject(e); });
      // One sentence chunk can still take a while on CPU/MPS; bound it generously so the UI never
      // hangs forever, but high enough that a normal sentence never trips it.
      req.setTimeout(180000, () => req.destroy(new Error('chatterbox synthesis timed out')));
      req.write(body);
      req.end();
    });
  }

  /** Stops the daemon (if running). */
  stopServer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const was = !!this.serverProc;
    if (this.serverProc) { killProcessTree(this.serverProc); this.serverProc = null; }
    this.serverPort = 0;
    if (was) this._onChange.fire();
  }

  // ───────────────────────── Reference-voice creation ─────────────────────────

  /** Spawns ffmpeg with an argv array (never a shell) and a hard timeout. */
  private run(bin: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let proc: cp.ChildProcess;
      try { proc = cp.spawn(bin, args, { cwd: path.dirname(bin) }); }
      catch (e) { return reject(e instanceof Error ? e : new Error(String(e))); }
      this.currentJob = proc;
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } reject(new Error('timed out')); }, timeoutMs);
      proc.on('error', (e: Error) => { clearTimeout(timer); if (this.currentJob === proc) this.currentJob = null; reject(e); });
      proc.on('close', (code: number) => {
        clearTimeout(timer);
        if (this.currentJob === proc) this.currentJob = null;
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `exit ${code}`));
      });
    });
  }

  /** Cancels an in-flight voice-creation job (the ffmpeg trim). */
  cancelJob(): void { if (this.currentJob) { try { this.currentJob.kill(); } catch { /* noop */ } this.currentJob = null; } }

  /** Creates a reference voice from a local audio/video file, trimmed to the [start,end] the user
   *  gave (seconds or mm:ss) and normalized to a mono 24 kHz WAV. Validates everything on the host
   *  (file exists, range, safe id) regardless of any client-side checks. The user's source file is
   *  never modified or deleted. */
  async createVoice(req: CreateVoiceRequest, notify?: Notify): Promise<void> {
    const id = req.id;
    if (!isSafeVoiceId(id)) throw new Error('invalid voice id');
    if (!req.filePath || !fs.existsSync(req.filePath)) throw new Error('file not found');
    const voicesDir = this.voicesDir();
    fs.mkdirSync(voicesDir, { recursive: true });
    const finalWav = chatterboxVoicePath(voicesDir, id);
    const ffmpeg = await this.ensureFfmpeg(notify);

    // Optional [start,end]: if given, trim to it; otherwise take the first REF_CLIP_MAX_SECONDS.
    let seekStart = 0;
    let duration = REF_CLIP_MAX_SECONDS;
    if (req.start || req.end) {
      const range = validateRange(req.start || '', req.end || '', REF_CLIP_MAX_SECONDS);
      if (!range.ok || range.start === undefined || range.end === undefined) {
        throw new Error(tr('Invalid time range: ') + (range.error || ''));
      }
      seekStart = range.start;
      duration = range.end - range.start;
    }

    // Trim + normalize to a small mono 24 kHz clip (Chatterbox's reference rate). `-ss` before `-i`
    // seeks; `-t duration` caps the length. Output to a temp file, then atomically rename into place.
    notify?.(tr('Preparing the voice sample…'));
    const tmpOut = path.join(voicesDir, id + '.norm.wav');
    try { fs.unlinkSync(tmpOut); } catch { /* noop */ }
    await this.run(ffmpeg, ['-y', '-ss', String(seekStart), '-i', req.filePath, '-t', String(duration), '-ac', '1', '-ar', '24000', tmpOut], 60000);
    try { fs.renameSync(tmpOut, finalWav); } catch (e) { throw new Error('could not save clip: ' + errMsg(e)); }
    // Validate the language at the boundary (L4/U5): only store a supported code, else leave it unset.
    const language = req.language && isChatterboxLanguage(req.language) ? req.language : undefined;
    writeChatterboxVoiceMeta(voicesDir, id, { label: req.label || id, source: 'file', language });
  }

  // ───────────────────────── Lifecycle ─────────────────────────

  /** Deletes the engine (venv), the downloaded weights and the reference clips. The shared
   *  self-contained Python is left in place (PythonEnv owns it; other engines may use it). */
  delete(): void {
    this.stopServer();
    this.ffmpegBin = null;
    for (const d of [VENV, MODELS_DIR, VOICES_DIR]) {
      try { fs.rmSync(this.dir(d), { recursive: true, force: true }); } catch { /* noop */ }
    }
    this.setupPromise = null;
  }

  /** Shuts down the daemon when the extension deactivates. */
  dispose(): void { this.stopServer(); this._onChange.dispose(); }
}
