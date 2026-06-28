/**
 * Read-aloud (TTS): system Web Speech API + Piper (backend WAV via Web Audio).
 */
import { t } from '../core/i18n.js';
import { vscode } from '../core/vscode.js';
import { notice, hideTtsProgress } from '../ui/notifications.js';
import { ICONS } from '../core/icons.js';
import { render as renderMarkdown } from '../render/markdown.js';

// TTS debug trace (visible in the webview console and forwarded to the backend).
const ttsLog = (msg, data?) => {
  try { console.log('[TTS]', msg, data !== undefined ? data : ''); } catch { /* best-effort; ignore failures */ }
  try { vscode.postMessage({ type: 'ttsLog', message: msg, data: data === undefined ? null : data }); } catch { /* best-effort; ignore failures */ }
};

// Curated Piper voices (feminine EN/ES). Downloaded automatically on first use and cached.
  const PIPER_VOICES = [
    { id: 'es_MX-claude-high', label: 'Claude — Spanish 🇲🇽 (female)' },
    { id: 'es_AR-daniela-high', label: 'Daniela — Spanish 🇦🇷 (female)' },
    { id: 'es_ES-sharvard-medium', label: 'Sharvard — Spanish 🇪🇸' },
    { id: 'en_US-amy-medium', label: 'Amy — English 🇺🇸 (female)' },
    { id: 'en_US-hfc_female-medium', label: 'HFC — English 🇺🇸 (female)' },
    { id: 'en_GB-jenny_dioco-medium', label: 'Jenny — English 🇬🇧 (female)' },
    { id: 'pt_BR-faber-medium', label: 'Faber — Portuguese 🇧🇷 (male)' },
    { id: 'fr_FR-siwis-medium', label: 'Siwis — French 🇫🇷 (female)' },
    { id: 'de_DE-thorsten-medium', label: 'Thorsten — German 🇩🇪 (male)' },
    { id: 'it_IT-paola-medium', label: 'Paola — Italian 🇮🇹 (female)' },
    { id: 'custom', label: '⚙ ' },
  ];

export const tts = {
    supported: 'speechSynthesis' in window,
    triedVoices: false, // true once system-voice loading was attempted
    pollVoices: (() => {}) as () => void, // replaced with a real poller if system voices load slowly
    voices: [],
    piperVoices: PIPER_VOICES,
    // Chatterbox reference voices (cloned clips): [{id,label}], refreshed via the 'chatterboxVoices' message.
    chatterboxVoices: [],
    rateForPlayback: 1, // speed applied client-side for engines that don't bake it server-side (Chatterbox)
    // Set of downloaded voice ids: injected into the HTML (window.DOWNLOADED_VOICES) so it is
    // ready from the first render; the 'piperVoices' message updates it live.
    downloadedVoices: new Set(Array.isArray(window.DOWNLOADED_VOICES) ? window.DOWNLOADED_VOICES : []),
    customSet: !!window.PIPER_CUSTOM_SET, // is there a custom .onnx path configured in Settings?
    // Preferences persisted in the webview state. `exaggeration` is seeded from the
    // jotflow.tts.chatterboxExaggeration setting (injected as window.CHATTERBOX_EXAGGERATION);
    // once the panel slider is touched, the saved state below overrides it.
    prefs: Object.assign({ engine: 'system', voiceURI: '', rate: 1, piperVoice: 'es_MX-claude-high', chatterboxVoice: '', exaggeration: (typeof window.CHATTERBOX_EXAGGERATION === 'number' ? window.CHATTERBOX_EXAGGERATION : 0.5) }, (vscode.getState() && vscode.getState().tts) || {}),
    speakingBtn: null, // active 🔊 button (to toggle the icon)
    msgId: null,       // id of the message being read (to stop if deleted)
    ctx: null,         // AudioContext (Web Audio): unlocked on click
    source: null,      // AudioBufferSourceNode currently playing (Piper engine)
    awaiting: false,   // there is an active Piper request (waiting/playing)
    playing: false,    // audio is currently playing
    reqId: 0,          // id of the current Piper request (filters stale responses)
    save() {
      const s = vscode.getState() || {};
      s.tts = this.prefs;
      vscode.setState(s);
    },
    loadVoices() {
      if (!this.supported) return;
      this.voices = window.speechSynthesis.getVoices() || [];
      // If no voice is selected, try a known Spanish feminine voice, or the first 'es'.
      if (!this.prefs.voiceURI && this.voices.length) {
        const es = this.voices.filter((v) => /^es/i.test(v.lang));
        const fem = es.find((v) => /m[oó]nica|paulina|monica|female|mujer/i.test(v.name));
        const pick = fem || es[0] || this.voices[0];
        if (pick) this.prefs.voiceURI = pick.voiceURI;
      }
    },
    // Sorted voices: Spanish first, then the rest.
    sortedVoices() {
      return this.voices.slice().sort((a, b) => {
        const ae = /^es/i.test(a.lang) ? 0 : 1;
        const be = /^es/i.test(b.lang) ? 0 : 1;
        return ae - be || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
      });
    },
    // Converts markdown to plain text so symbols (#, *, etc.) are not read aloud.
    toPlain(md) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderMarkdown(md || '');
      return (tmp.textContent || '').replace(/\s+\n/g, '\n').trim();
    },
    // Creates/unlocks the AudioContext. MUST be called from a click gesture
    // to bypass the webview's autoplay policy.
    ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { this.ctx = new AC(); ttsLog('AudioContext created', { state: this.ctx.state, rate: this.ctx.sampleRate }); } catch (e) { this.ctx = null; ttsLog('AudioContext FAILED', { err: String(e) }); } }
        else ttsLog('AudioContext NOT supported');
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => ttsLog('AudioContext resume()->ok', { state: this.ctx.state }))
          .catch((e) => ttsLog('AudioContext resume()->error', { err: String(e) }));
      }
      return this.ctx;
    },
    busy() {
      return this.awaiting || this.playing
        || (this.supported && (window.speechSynthesis.speaking || window.speechSynthesis.pending));
    },
    stop() {
      const wasPiper = this.awaiting || this.playing;
      if (wasPiper) ttsLog('stop()', { reqId: this.reqId });
      this.awaiting = false;
      this.playing = false;
      if (this.supported) window.speechSynthesis.cancel();
      if (this.source) { try { this.source.onended = null; this.source.stop(); } catch { /* best-effort; ignore failures */ } this.source = null; }
      this.msgId = null;
      hideTtsProgress();
      if (wasPiper) vscode.postMessage({ type: 'ttsStop' }); // aborts any pending synthesis in the backend
      this.resetBtn();
    },
    resetBtn() {
      if (this.speakingBtn) { this.speakingBtn.innerHTML = ICONS.speaker; this.speakingBtn = null; }
    },
    speak(text, btn, msgId?) {
      // Click on the same button that is playing/loading → stop.
      const same = this.speakingBtn === btn && this.busy();
      this.stop();
      if (same) return;
      const plain = this.toPlain(text);
      if (!plain) return;
      this.msgId = msgId || null; // message being read (to stop if deleted)
      if (btn) { btn.innerHTML = ICONS.stopsq; this.speakingBtn = btn; }
      if ((this.prefs.engine || 'system') === 'piper') {
        const ctx = this.ensureCtx(); // unlock inside the click gesture!
        this.reqId++;
        this.awaiting = true;
        this.playing = false;
        this.rateForPlayback = 1; // Piper bakes the rate into the WAV server-side (length_scale)
        const voice = this.prefs.piperVoice && this.prefs.piperVoice !== 'custom' ? this.prefs.piperVoice : '';
        ttsLog('speak→piper', { reqId: this.reqId, voice, rate: this.prefs.rate || 1, chars: plain.length, ctxState: ctx && ctx.state });
        vscode.postMessage({ type: 'tts', text: plain, rate: this.prefs.rate || 1, voice, id: this.reqId });
        return;
      }
      if ((this.prefs.engine || 'system') === 'chatterbox') {
        const ctx = this.ensureCtx(); // unlock inside the click gesture!
        this.reqId++;
        this.awaiting = true;
        this.playing = false;
        // Chatterbox has no server-side speed control → apply the slider on playback.
        this.rateForPlayback = this.prefs.rate || 1;
        const voice = this.prefs.chatterboxVoice || '';
        const exaggeration = typeof this.prefs.exaggeration === 'number' ? this.prefs.exaggeration : 0.5;
        ttsLog('speak→chatterbox', { reqId: this.reqId, voice, exaggeration, chars: plain.length, ctxState: ctx && ctx.state });
        vscode.postMessage({ type: 'tts', engine: 'chatterbox', text: plain, voice, exaggeration, id: this.reqId });
        return;
      }
      // System engine (Web Speech API).
      if (!this.supported) { notice(t('Speech synthesis is not available in this environment.'), true); this.resetBtn(); return; }
      const u = new SpeechSynthesisUtterance(plain);
      const v = this.voices.find((x) => x.voiceURI === this.prefs.voiceURI);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = this.prefs.rate || 1;
      u.onend = () => this.resetBtn();
      u.onerror = () => this.resetBtn();
      window.speechSynthesis.speak(u);
    },
    // Decodes the WAV (base64) from the backend and plays it with Web Audio (no autoplay).
    async playWav(b64, id) {
      if (id !== this.reqId || !this.awaiting) { ttsLog('playWav: discarded (stale)', { id, current: this.reqId, awaiting: this.awaiting }); return; }
      const ctx = this.ensureCtx();
      if (!ctx) { this.awaiting = false; this.resetBtn(); notice(t('Audio playback is not available in this environment.'), true); return; }
      let bytes;
      try {
        const binStr = atob(b64);
        bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      } catch (e) { ttsLog('playWav: atob FAILED', { err: String(e) }); this.awaiting = false; this.resetBtn(); return; }
      ttsLog('playWav: decoding', { bytes: bytes.length, ctxState: ctx.state });
      let buf;
      try {
        buf = await ctx.decodeAudioData(bytes.buffer);
      } catch (e) {
        ttsLog('playWav: decodeAudioData FAILED', { err: String(e) });
        this.awaiting = false; this.resetBtn();
        notice(t('Could not decode the audio.'), true);
        return;
      }
      if (id !== this.reqId || !this.awaiting) { ttsLog('playWav: cancelled after decoding'); return; }
      ttsLog('playWav: decoded OK', { seconds: +buf.duration.toFixed(1), channels: buf.numberOfChannels, ctxState: ctx.state });
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (this.rateForPlayback && this.rateForPlayback !== 1) src.playbackRate.value = this.rateForPlayback;
      src.connect(ctx.destination);
      src.onended = () => {
        if (this.source === src) { ttsLog('playWav: onended (end)'); this.source = null; this.playing = false; this.awaiting = false; this.resetBtn(); }
      };
      this.source = src;
      this.playing = true;
      try { src.start(); ttsLog('playWav: start() OK — playing', { ctxState: ctx.state }); }
      catch (e) { ttsLog('playWav: start() FAILED', { err: String(e) }); this.source = null; this.playing = false; this.awaiting = false; this.resetBtn(); }
    },
  };

// Wires voice loading + live refresh. `refreshVoicesUI` is called when the system voice list
// becomes available (injected so this module stays decoupled from the config panel).
export function initTts(refreshVoicesUI) {
  tts.loadVoices();
  // Release the AudioContext when the webview is unloaded (avoids dangling contexts).
  window.addEventListener('pagehide', () => { if (tts.ctx) { try { tts.ctx.close(); } catch { /* best-effort; ignore failures */ } } });
  if (tts.supported) {
    window.speechSynthesis.onvoiceschanged = () => { tts.loadVoices(); refreshVoicesUI(); };
    // Fallback: in Electron/VS Code 'voiceschanged' sometimes never fires; poll
    // until getVoices() returns something (or give up after ~6s).
    tts.pollVoices = () => {
      tts.triedVoices = false;
      let polls = 0;
      const poll = setInterval(() => {
        polls++;
        const had = tts.voices.length;
        tts.loadVoices();
        if (tts.voices.length && !had) refreshVoicesUI();
        if (tts.voices.length || polls > 24) {
          clearInterval(poll);
          if (!tts.voices.length) { tts.triedVoices = true; refreshVoicesUI(); }
        }
      }, 250);
    };
    if (!tts.voices.length) tts.pollVoices();
  }
}
