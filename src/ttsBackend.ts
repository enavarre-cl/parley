import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tr } from './i18n';
import { wavData, concatWavs, splitForTTS } from './audio';
import { PiperManager } from './piper/manager';
import { ChatterboxManager } from './chatterbox/manager';
import { chatterboxVoicePath, chatterboxVoiceLanguage } from './chatterboxVoices';
import { isSafeVoiceId, isChatterboxLanguage, isChatterboxModel, CHATTERBOX_DEFAULT_MODEL } from './chatterbox/assets';
import { errMsg } from './chatHelpers';

export interface TtsBackendDeps {
  webview: vscode.Webview;
  piper: PiperManager;
  chatterbox: ChatterboxManager;
  ttsTokenRef: { value: number };
}

/** Neural TTS synthesis backends (Piper + Chatterbox). Cohesive; deps explicit. */
export function makeTtsBackend(deps: TtsBackendDeps) {
  const { webview, piper, chatterbox, ttsTokenRef } = deps;
    let currentPiperProc: cp.ChildProcess | null = null; // piper process in flight, so we can kill it on cancel
    const killPiper = () => { if (currentPiperProc) { try { currentPiperProc.kill(); } catch { /* nothing */ } currentPiperProc = null; } };
    // TTS trace to file (for debugging without relying on the webview console).
    const tlog = (s: string) => {
      // Only traces if the user enables debug (off by default).
      if (!vscode.workspace.getConfiguration('jotflow').get<boolean>('tts.debug', false)) return;
      try { console.log('[TTS]', s); } catch { /* nothing */ }
      try { fs.appendFileSync(path.join(os.tmpdir(), 'jotflow-tts.log'), new Date().toISOString() + ' ' + s + '\n'); } catch { /* nothing */ }
    };
    const synthPiper = async (text: string, rate: number, voice: string, reqId: number): Promise<void> => {
      const t = text.trim();
      if (!t) return;
      const myToken = ++ttsTokenRef.value; // any later request/stop cancels this one
      const cancelled = () => myToken !== ttsTokenRef.value;
      killPiper(); // kill any piper from a previous request still in flight
      tlog(`req#${reqId} received (engine=piper, rate=${rate}, voice=${voice || '(setting)'})`);
      // All TTS messages carry the request id so the webview can filter stale ones.
      const post = (m: Record<string, unknown>) => webview.postMessage({ ...m, id: reqId });
      const notice = (m: string) => webview.postMessage({ type: 'notice', message: m });
      const cfg = vscode.workspace.getConfiguration('jotflow');
      const speaker = cfg.get<number>('tts.piperSpeaker', -1);
      const isCurated = !!voice && /^[a-z]{2}_[A-Z]{2}-/.test(voice);
      // Via DAEMON (resident model, fast): curated voices only. Any failure falls through to
      // the per-chunk spawn below, so there is no regression if the server fails to start.
      if (isCurated) {
        try {
          const modelPath = await piper.ensureVoice(voice, notice);
          if (cancelled()) return;
          const baseUrl = await piper.ensureServer(modelPath, notice);
          if (cancelled()) return;
          const lscale = rate > 0 ? 1 / rate : 1;
          const wav = await piper.synthViaServer(baseUrl, t, voice, lscale, typeof speaker === 'number' ? speaker : -1);
          if (cancelled()) return;
          tlog(`req#${reqId} OK via daemon: WAV ${wav.length} bytes`);
          post({ type: 'ttsAudio', data: wav.toString('base64'), last: true });
          post({ type: 'ttsDone' });
          return;
        } catch (e) {
          tlog(`req#${reqId} daemon failed (${errMsg(e)}); falling back to per-chunk spawn`);
        }
      }
      let bin: string;
      try {
        bin = await piper.resolveBin(cfg, notice);
      } catch (e) {
        post({ type: 'ttsError', message: tr('Could not set up Piper: ') + (errMsg(e)) });
        return;
      }
      if (cancelled()) return;
      let model = '';
      if (voice && /^[a-z]{2}_[A-Z]{2}-/.test(voice)) {
        try {
          model = await piper.ensureVoice(voice, notice);
        } catch (e) {
          post({ type: 'ttsError', message: tr('Could not download voice: ') + (errMsg(e)) });
          return;
        }
      } else {
        model = cfg.get<string>('tts.piperModel', '') || '';
      }
      if (!model) {
        post({ type: 'ttsError', message: tr('No voice available. Download one from the Jotflow panel (Voices ➕), or set a custom .onnx path in Settings (jotflow.tts.piperModel).') });
        return;
      }
      if (cancelled()) return;

      const lengthScale = rate > 0 ? (1 / rate).toFixed(3) : '1';
      const libDir = path.dirname(bin);
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (process.platform === 'darwin') {
        env.DYLD_LIBRARY_PATH = libDir + (env.DYLD_LIBRARY_PATH ? ':' + env.DYLD_LIBRARY_PATH : '');
      } else if (process.platform === 'linux') {
        env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
      }

      // Synthesises a chunk and returns the WAV Buffer (or an error).
      const synthChunk = (chunk: string): Promise<{ ok: boolean; buf?: Buffer; err?: string }> =>
        new Promise((resolve) => {
          const out = path.join(os.tmpdir(), `jotflow-tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
          const args = ['--model', model, '--output_file', out, '--length_scale', lengthScale];
          if (typeof speaker === 'number' && speaker >= 0) args.push('--speaker', String(speaker));
          let proc: cp.ChildProcess;
          try {
            proc = cp.spawn(bin, args, { cwd: libDir, env });
          } catch (e) {
            return resolve({ ok: false, err: errMsg(e) });
          }
          currentPiperProc = proc; // so we can kill it if cancelled
          let stderr = '';
          proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
          proc.on('error', (e: Error) => {
            if (currentPiperProc === proc) currentPiperProc = null;
            try { fs.unlinkSync(out); } catch { /* not created / already deleted */ }
            resolve({ ok: false, err: errMsg(e) });
          });
          proc.on('close', (code: number) => {
            if (currentPiperProc === proc) currentPiperProc = null;
            try {
              if (code === 0 && fs.existsSync(out)) resolve({ ok: true, buf: fs.readFileSync(out) });
              else resolve({ ok: false, err: stderr.trim() || `exit ${code}` });
            } finally {
              try { fs.unlinkSync(out); } catch { /* already deleted */ }
            }
          });
          proc.stdin?.write(chunk);
          proc.stdin?.end();
        });

      // Synthesises each sentence separately (fast) and concatenates them into a single WAV.
      const chunks = splitForTTS(t);
      tlog(`req#${reqId} bin=${bin.split('/').slice(-3).join('/')} chars=${t.length} chunks=${chunks.length}`);
      if (chunks.length > 1) webview.postMessage({ type: 'notice', message: tr('Generating audio…') });
      const bufs: Buffer[] = [];
      let lastErr = '';
      for (let i = 0; i < chunks.length; i++) {
        if (cancelled()) { tlog(`req#${reqId} cancelled at chunk ${i}`); return; }
        const r = await synthChunk(chunks[i]);
        if (cancelled()) { tlog(`req#${reqId} cancelled after chunk ${i}`); return; }
        if (r.ok && r.buf) bufs.push(r.buf);
        else { lastErr = r.err || ''; tlog(`req#${reqId} chunk ${i} FAILED: ${lastErr}`); }
      }
      if (cancelled()) return;
      if (!bufs.length) { tlog(`req#${reqId} no audio: ${lastErr}`); post({ type: 'ttsError', message: tr('Piper failed: ') + lastErr }); return; }
      const wav = concatWavs(bufs);
      tlog(`req#${reqId} OK: ${bufs.length} chunks → WAV ${wav.length} bytes (~${(wavData(wav).len / (22050 * 2)).toFixed(1)}s); sending`);
      // A single WAV → a single playback in the webview (no fragile chains).
      post({ type: 'ttsAudio', data: wav.toString('base64'), last: true });
      post({ type: 'ttsDone' });
    };

    // Chatterbox: one resident model in the daemon, voice cloned from a reference clip. The whole
    // message is synthesised in one shot (the model is slower than Piper; chunking gives no early
    // playback benefit and would reload phrasing per chunk). Cancellation via the shared token.
    const synthChatterbox = async (text: string, voice: string, exaggeration: number, reqId: number): Promise<void> => {
      const t = text.trim();
      if (!t) return;
      const myToken = ++ttsTokenRef.value;
      const cancelled = (): boolean => myToken !== ttsTokenRef.value;
      const post = (m: Record<string, unknown>): Thenable<boolean> => webview.postMessage({ ...m, id: reqId });
      const progress = (pct: number, text: string): void => { post({ type: 'ttsProgress', pct, text }); };
      if (!voice || !isSafeVoiceId(voice)) {
        post({ type: 'ttsError', message: tr('No Chatterbox voice selected. Create one from the Voices panel (from a local audio/video file).') });
        return;
      }
      const refWav = chatterboxVoicePath(chatterbox.voicesDir(), voice);
      if (!fs.existsSync(refWav)) {
        post({ type: 'ttsError', message: tr('That voice is missing. Re-create it from the Voices panel.') });
        return;
      }
      tlog(`req#${reqId} received (engine=chatterbox, voice=${voice}, exaggeration=${exaggeration})`);
      // A dropped connection (idle-timeout, OS killed, crash) → the daemon died. Restart and retry once.
      const isConnLost = (e: unknown): boolean => /ECONNREFUSED|ECONNRESET|socket hang up|timed out|did not respond/i.test(errMsg(e));
      try {
        progress(0, '🔊 ' + tr('Preparing the voice…'));
        let baseUrl = await chatterbox.ensureServer((m) => progress(0, '🔊 ' + m));
        if (cancelled()) return;
        // The voice carries its own language (set when it was created) — the multilingual model speaks
        // the clone in that language. No chat-level language config. The English-only model ignores it.
        const cfg = vscode.workspace.getConfiguration('jotflow');
        const modelRaw = cfg.get<string>('tts.chatterboxModel', CHATTERBOX_DEFAULT_MODEL);
        const isMultilingual = (isChatterboxModel(modelRaw) ? modelRaw : CHATTERBOX_DEFAULT_MODEL) === 'multilingual';
        const voiceLang = chatterboxVoiceLanguage(chatterbox.voicesDir(), voice);
        const languageId = isMultilingual ? (voiceLang && isChatterboxLanguage(voiceLang) ? voiceLang : 'en') : undefined;
        // Chatterbox is slow (~real-time on GPU, several× slower on CPU/MPS) and the model caps how
        // much it generates per call. Synthesise sentence-by-sentence (short chunks) so no single
        // request times out, then concatenate. Smaller chunks than Piper, since each is much slower.
        const chunks = splitForTTS(t, 180);
        const bufs: Buffer[] = [];
        for (let i = 0; i < chunks.length; i++) {
          if (cancelled()) return;
          const label = '🔊 ' + tr('Generating audio…') + (chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '');
          const onChunkPct = (p: number): void => { if (!cancelled()) progress((i + p) / chunks.length, label); };
          onChunkPct(0);
          let wav: Buffer;
          try {
            wav = await chatterbox.synthViaServer(baseUrl, chunks[i], refWav, exaggeration, 0.5, languageId, onChunkPct);
          } catch (e) {
            if (!isConnLost(e) || cancelled()) throw e;
            tlog(`req#${reqId} daemon lost (${errMsg(e)}); restarting and retrying chunk ${i}`);
            progress((i) / chunks.length, '🔊 ' + tr('Restarting the engine…'));
            baseUrl = await chatterbox.ensureServer((m) => progress((i) / chunks.length, '🔊 ' + m));
            if (cancelled()) return;
            wav = await chatterbox.synthViaServer(baseUrl, chunks[i], refWav, exaggeration, 0.5, languageId, onChunkPct);
          }
          if (cancelled()) return;
          bufs.push(wav);
        }
        if (!bufs.length) { post({ type: 'ttsError', message: tr('Chatterbox produced no audio.') }); return; }
        const wav = concatWavs(bufs);
        tlog(`req#${reqId} OK via chatterbox: ${bufs.length} chunk(s) → WAV ${wav.length} bytes`);
        post({ type: 'ttsAudio', data: wav.toString('base64'), last: true });
        post({ type: 'ttsDone' });
      } catch (e) {
        if (cancelled()) return;
        tlog(`req#${reqId} chatterbox failed: ${errMsg(e)}`);
        post({ type: 'ttsError', message: tr('Chatterbox failed: ') + errMsg(e) });
      }
    };
  return { synthPiper, synthChatterbox, killPiper, tlog };
}
