(function () {
  const vscode = acquireVsCodeApi();
  const t = (s) => window.LangI18n.t(s); // traducción (inglés es la clave)
  // Traza de depuración del TTS (visible en la consola del webview y reenviada al backend).
  const ttsLog = (msg, data) => {
    try { console.log('[TTS]', msg, data !== undefined ? data : ''); } catch (e) {}
    try { vscode.postMessage({ type: 'ttsLog', message: msg, data: data === undefined ? null : data }); } catch (e) {}
  };

  let doc = null; // ChatDoc actual
  let streamingEl = null;
  let streamingText = '';
  let thinkingText = ''; // razonamiento del turno en curso

  // Render de streaming coalescido con requestAnimationFrame: en vez de re-parsear todo
  // el markdown en CADA token (O(n²) + reflow), se renderiza como mucho una vez por frame.
  let rafQueued = false;
  let pendingBody = false;
  let pendingThink = false;
  function flushStreamRender() {
    rafQueued = false;
    if (pendingBody && streamingEl) {
      pendingBody = false;
      streamingEl.querySelector('.body').innerHTML = renderMarkdownImpl(streamingText);
      scrollDown();
    }
    if (pendingThink) {
      pendingThink = false;
      showThinking(thinkingText);
    }
  }
  function queueStreamRender() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(flushStreamRender);
  }

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const inputBackdrop = $('inputBackdrop');
  const spellSelect = $('spellSelect');
  const sendBtn = $('sendBtn');
  const stopBtn = $('stopBtn');
  const modelSelect = $('modelSelect');
  const providerSelect = $('providerSelect');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const configPanel = $('config');
  const configFields = $('configFields');
  const thinkPanel = $('thinking');
  const thinkContent = $('thinkContent');
  const toolsPanel = $('tools');
  const toolsContent = $('toolsContent');
  const sidepanels = $('sidepanels');
  let toolsLive = []; // actividad de tools del turno en curso
  const attachBtn = $('attachBtn');
  const fileInput = $('fileInput');
  const attachmentsEl = $('attachments');
  const ctxBar = $('ctxBar');
  const ctxFill = $('ctxFill');
  const ctxLabel = $('ctxLabel');
  const noticesEl = $('notices');
  const modelCtxEl = $('modelCtx');
  const modelCapsEl = $('modelCaps');
  const usageChipEl = $('usageChip');
  let modelContext = {}; // id de modelo -> tokens de contexto
  let modelCaps = {}; // id de modelo -> capacidades

  let pending = []; // adjuntos pendientes de enviar: {kind,name,mime,data}

  // Esquema del panel de configuración. `only` limita el parámetro a ciertos backends.
  const SCHEMA = [
    { group: 'General', items: [
      { key: 'temperature', label: 'Temperature', kind: 'slider', min: 0, max: 2, step: 0.01, toggle: false },
      { key: 'maxTokens', label: 'Limit response length', kind: 'int', min: 1, max: 131072, step: 1, toggle: true },
      { key: 'contextMessages', label: 'History to send: last N messages', kind: 'int', min: 1, max: 500, step: 1, toggle: true },
      { key: 'autoSummary', label: 'Auto-summarize when context fills up', kind: 'bool' },
      { key: 'contextBudget', label: 'Summary token budget (auto = 75% of model)', kind: 'int', min: 1000, max: 1000000, step: 1000, toggle: true },
      { key: 'contextLength', label: 'Model window: num_ctx (tokens)', kind: 'int', min: 256, max: 131072, step: 256, toggle: true, only: ['ollama'] },
      { key: 'numThreads', label: 'CPU Threads', kind: 'slider', min: 1, max: 32, step: 1, toggle: true, only: ['ollama'] },
      { key: 'thinking', label: 'Reasoning / thinking', kind: 'bool', only: ['gemini', 'anthropic', 'openrouter', 'ollama'] },
      { key: 'tools', label: 'Tools: workspace filesystem + MCP servers (.mcp)', kind: 'bool', only: ['openai', 'openrouter', 'gemini', 'anthropic', 'ollama'] },
      { key: 'stop', label: 'Stop Strings', kind: 'tags' },
    ] },
    { group: 'Sampling', items: [
      { key: 'topK', label: 'Top K Sampling', kind: 'int', min: 0, max: 500, step: 1, toggle: true },
      { key: 'topP', label: 'Top P Sampling', kind: 'slider', min: 0, max: 1, step: 0.01, toggle: true },
      { key: 'minP', label: 'Min P Sampling', kind: 'slider', min: 0, max: 1, step: 0.01, toggle: true, only: ['openai', 'ollama', 'openrouter'] },
      { key: 'topA', label: 'Top A Sampling', kind: 'slider', min: 0, max: 1, step: 0.01, toggle: true, only: ['openrouter'] },
      { key: 'repeatPenalty', label: 'Repeat / Repetition Penalty', kind: 'number', min: 0, max: 2, step: 0.01, toggle: true, only: ['openai', 'ollama', 'openrouter'] },
      { key: 'presencePenalty', label: 'Presence Penalty', kind: 'number', min: -2, max: 2, step: 0.01, toggle: true, only: ['openai', 'ollama', 'openrouter', 'gemini'] },
      { key: 'frequencyPenalty', label: 'Frequency Penalty', kind: 'number', min: -2, max: 2, step: 0.01, toggle: true, only: ['openai', 'ollama', 'openrouter', 'gemini'] },
      { key: 'seed', label: 'Seed', kind: 'int', min: 0, max: 2147483647, step: 1, toggle: true, only: ['openai', 'ollama', 'openrouter', 'gemini'] },
    ] },
  ];

  // ---- Render de mensajes ----
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Formato inline: escapa HTML y aplica código, enlaces, negrita, cursiva, tachado.
  // LaTeX inline → Unicode (los modelos sueltan $\rightarrow$, \alpha, etc. en el razonamiento).
  const LATEX = {
    rightarrow: '→', to: '→', longrightarrow: '→', Rightarrow: '⇒', implies: '⇒', iff: '⇔',
    leftarrow: '←', gets: '←', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔',
    uparrow: '↑', downarrow: '↓', mapsto: '↦',
    times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', cong: '≅',
    ll: '≪', gg: '≫', propto: '∝', infty: '∞', partial: '∂', nabla: '∇', sqrt: '√', angle: '∠',
    sum: '∑', prod: '∏', int: '∫', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', oplus: '⊕',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅',
    ldots: '…', dots: '…', cdots: '⋯', prime: '′', therefore: '∴', because: '∵',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
    Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  };
  function deLatex(t) {
    // Quita los delimitadores $…$ SOLO si envuelven un \comando (no toca monedas tipo $5).
    t = t.replace(/\$\$?([^$\n]*?\\[a-zA-Z][^$\n]*?)\$\$?/g, '$1');
    t = t.replace(/\\\\/g, ' ');                  // salto de línea LaTeX
    t = t.replace(/\\[()[\]]/g, ' ');             // \( \) \[ \]
    t = t.replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, ''); // tamaños de delimitadores
    t = t.replace(/\\[,;:! ]/g, ' ');             // espaciado fino
    t = t.replace(/\\([a-zA-Z]+)/g, (m, c) => (LATEX[c] !== undefined ? LATEX[c] : m)); // símbolos conocidos
    return t;
  }

  function inlineMd(text) {
    let t = escapeHtml(text);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    t = deLatex(t); // LaTeX inline → Unicode (los code-spans ya están protegidos arriba)
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      // Allowlist de esquema: bloquea javascript:/data:/vbscript:… (defensa en profundidad además de la CSP).
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
      const href = scheme && !/^(https?|mailto)$/i.test(scheme[1]) ? '#' : url; // el url ya viene escapado
      return '<a href="' + href + '">' + label + '</a>';
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
    return t;
  }

  function splitRow(line) {
    return line.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|').map((c) => c.trim());
  }

  // Renderer de Markdown por bloques (encabezados, listas, citas, tablas, código…).
  // Memo de renderMarkdown: es función pura, y renderConversation re-renderiza todos los
  // mensajes (casi todos idénticos) en cada cambio. El streaming usa renderMarkdownImpl (raw).
  const mdCache = new Map();
  const MD_CACHE_MAX = 400;
  function renderMarkdown(src) {
    const key = String(src);
    const hit = mdCache.get(key);
    if (hit !== undefined) { mdCache.delete(key); mdCache.set(key, hit); return hit; } // refresca LRU
    const html = renderMarkdownImpl(key);
    mdCache.set(key, html);
    if (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value); // evict más antiguo
    return html;
  }
  function renderMarkdownImpl(src) {
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const isSpecial = (l) =>
      /^```/.test(l) || /^\s*$/.test(l) || /^#{1,6}\s/.test(l) ||
      /^\s*>\s?/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+\.\s+/.test(l) ||
      /^\s*([-*_])\1\1+\s*$/.test(l);

    while (i < lines.length) {
      const line = lines[i];

      // Bloque de código ```
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }
      // Línea en blanco
      if (/^\s*$/.test(line)) { i++; continue; }
      // Encabezado
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
      // Regla horizontal
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
      // Tabla: cabecera con | y línea separadora |---|
      if (line.includes('|') && i + 1 < lines.length &&
          /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        let html = '<table><thead><tr>' + header.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>';
        for (const r of rows) html += '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>';
        out.push(html + '</tbody></table>');
        continue;
      }
      // Cita
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + renderMarkdownImpl(buf.join('\n')) + '</blockquote>');
        continue;
      }
      // Lista no ordenada
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(inlineMd(lines[i].replace(/^\s*[-*+]\s+/, ''))); i++; }
        out.push('<ul>' + items.map((t) => `<li>${t}</li>`).join('') + '</ul>');
        continue;
      }
      // Lista ordenada
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(inlineMd(lines[i].replace(/^\s*\d+\.\s+/, ''))); i++; }
        out.push('<ol>' + items.map((t) => `<li>${t}</li>`).join('') + '</ol>');
        continue;
      }
      // Párrafo
      const para = [];
      while (i < lines.length && !isSpecial(lines[i])) { para.push(lines[i]); i++; }
      out.push('<p>' + inlineMd(para.join('\n')).replace(/\n/g, '<br/>') + '</p>');
    }
    return out.join('');
  }

  // Iconos SVG monocromos (heredan currentColor → buen contraste en cualquier fondo).
  const SVG = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  const ICONS = {
    edit: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    retry: SVG('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
    forward: SVG('<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>'),
    mergeUp: SVG('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
    branch: SVG('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
    copy: SVG('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    check: SVG('<polyline points="20 6 9 17 4 12"/>'),
    trash: SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
    eye: SVG('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    tool: SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    spark: SVG('<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/>'),
    file: SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
    audio: SVG('<path d="M3 10v4h4l5 5V5L7 10z"/><path d="M16 8a4 4 0 0 1 0 8"/>'),
    speaker: SVG('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>'),
    stopsq: SVG('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  };
  function iconButton(svg, title, onClick) {
    const b = document.createElement('button');
    b.className = 'icon-act';
    b.title = title;
    b.innerHTML = svg;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ---- Lectura en voz alta (Web Speech API; local, sin censura) ----
  // Voces Piper curadas (femeninas EN/ES). Se descargan solas la 1ª vez y quedan cacheadas.
  const PIPER_VOICES = [
    { id: 'es_MX-claude-high', label: 'Claude — Español 🇲🇽 (femenina)' },
    { id: 'es_AR-daniela-high', label: 'Daniela — Español 🇦🇷 (femenina)' },
    { id: 'es_ES-sharvard-medium', label: 'Sharvard — Español 🇪🇸' },
    { id: 'en_US-amy-medium', label: 'Amy — English 🇺🇸 (female)' },
    { id: 'en_US-hfc_female-medium', label: 'HFC — English 🇺🇸 (female)' },
    { id: 'en_GB-jenny_dioco-medium', label: 'Jenny — English 🇬🇧 (female)' },
    { id: 'custom', label: '⚙ ' },
  ];

  const tts = {
    supported: 'speechSynthesis' in window,
    voices: [],
    piperVoices: PIPER_VOICES,
    // Set de ids de voces descargadas: inyectado en el HTML (window.DOWNLOADED_VOICES) para que
    // esté listo desde el primer render; el mensaje 'piperVoices' lo actualiza en vivo.
    downloadedVoices: new Set(Array.isArray(window.DOWNLOADED_VOICES) ? window.DOWNLOADED_VOICES : []),
    customSet: !!window.PIPER_CUSTOM_SET, // ¿hay una ruta .onnx custom configurada en Ajustes?
    // Preferencias persistidas en el estado del webview.
    prefs: Object.assign({ engine: 'system', voiceURI: '', rate: 1, piperVoice: 'es_MX-claude-high' }, (vscode.getState() && vscode.getState().tts) || {}),
    speakingBtn: null, // botón 🔊 activo (para alternar icono)
    msgId: null,       // id del mensaje que se está leyendo (para parar si lo borran)
    ctx: null,         // AudioContext (Web Audio): se desbloquea con el clic
    source: null,      // AudioBufferSourceNode en reproducción (motor Piper)
    awaiting: false,   // hay una petición Piper activa (esperando/reproduciendo)
    playing: false,    // hay audio sonando
    reqId: 0,          // id de la petición Piper actual (filtra respuestas obsoletas)
    save() {
      const s = vscode.getState() || {};
      s.tts = this.prefs;
      vscode.setState(s);
    },
    loadVoices() {
      if (!this.supported) return;
      this.voices = window.speechSynthesis.getVoices() || [];
      // Si no hay voz elegida, intenta una española femenina conocida, o la primera 'es'.
      if (!this.prefs.voiceURI && this.voices.length) {
        const es = this.voices.filter((v) => /^es/i.test(v.lang));
        const fem = es.find((v) => /m[oó]nica|paulina|monica|female|mujer/i.test(v.name));
        const pick = fem || es[0] || this.voices[0];
        if (pick) this.prefs.voiceURI = pick.voiceURI;
      }
    },
    // Voces ordenadas: español primero, luego el resto.
    sortedVoices() {
      return this.voices.slice().sort((a, b) => {
        const ae = /^es/i.test(a.lang) ? 0 : 1;
        const be = /^es/i.test(b.lang) ? 0 : 1;
        return ae - be || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
      });
    },
    // Convierte markdown a texto plano para que no lea símbolos (#, *, etc.).
    toPlain(md) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderMarkdown(md || '');
      return (tmp.textContent || '').replace(/\s+\n/g, '\n').trim();
    },
    // Crea/desbloquea el AudioContext. DEBE llamarse desde el gesto del clic
    // para esquivar la política de autoplay del webview.
    ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) { try { this.ctx = new AC(); ttsLog('AudioContext creado', { state: this.ctx.state, rate: this.ctx.sampleRate }); } catch (e) { this.ctx = null; ttsLog('AudioContext FALLÓ', { err: String(e) }); } }
        else ttsLog('AudioContext NO soportado');
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => ttsLog('AudioContext resume()->ok', { state: this.ctx.state }))
          .catch((e) => ttsLog('AudioContext resume()->ERROR', { err: String(e) }));
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
      if (this.source) { try { this.source.onended = null; this.source.stop(); } catch (e) {} this.source = null; }
      this.msgId = null;
      if (wasPiper) vscode.postMessage({ type: 'ttsStop' }); // aborta la síntesis pendiente en el backend
      this.resetBtn();
    },
    resetBtn() {
      if (this.speakingBtn) { this.speakingBtn.innerHTML = ICONS.speaker; this.speakingBtn = null; }
    },
    speak(text, btn, msgId) {
      // Click sobre el mismo botón que está sonando/cargando → parar.
      const same = this.speakingBtn === btn && this.busy();
      this.stop();
      if (same) return;
      const plain = this.toPlain(text);
      if (!plain) return;
      this.msgId = msgId || null; // mensaje que se lee (para parar si lo borran)
      if (btn) { btn.innerHTML = ICONS.stopsq; this.speakingBtn = btn; }
      if ((this.prefs.engine || 'system') === 'piper') {
        const ctx = this.ensureCtx(); // ¡desbloqueo dentro del gesto del clic!
        this.reqId++;
        this.awaiting = true;
        this.playing = false;
        const voice = this.prefs.piperVoice && this.prefs.piperVoice !== 'custom' ? this.prefs.piperVoice : '';
        ttsLog('speak→piper', { reqId: this.reqId, voice, rate: this.prefs.rate || 1, chars: plain.length, ctxState: ctx && ctx.state });
        vscode.postMessage({ type: 'tts', text: plain, rate: this.prefs.rate || 1, voice, id: this.reqId });
        return;
      }
      // Motor del sistema (Web Speech API).
      if (!this.supported) { notice(t('Speech synthesis is not available in this environment.'), true); this.resetBtn(); return; }
      const u = new SpeechSynthesisUtterance(plain);
      const v = this.voices.find((x) => x.voiceURI === this.prefs.voiceURI);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = this.prefs.rate || 1;
      u.onend = () => this.resetBtn();
      u.onerror = () => this.resetBtn();
      window.speechSynthesis.speak(u);
    },
    // Decodifica el WAV (base64) del backend y lo reproduce con Web Audio (sin autoplay).
    async playWav(b64, id) {
      if (id !== this.reqId || !this.awaiting) { ttsLog('playWav: descartado (obsoleto)', { id, current: this.reqId, awaiting: this.awaiting }); return; }
      const ctx = this.ensureCtx();
      if (!ctx) { this.awaiting = false; this.resetBtn(); notice(t('Audio playback is not available in this environment.'), true); return; }
      let bytes;
      try {
        const binStr = atob(b64);
        bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      } catch (e) { ttsLog('playWav: atob FALLÓ', { err: String(e) }); this.awaiting = false; this.resetBtn(); return; }
      ttsLog('playWav: decodificando', { bytes: bytes.length, ctxState: ctx.state });
      let buf;
      try {
        buf = await ctx.decodeAudioData(bytes.buffer);
      } catch (e) {
        ttsLog('playWav: decodeAudioData FALLÓ', { err: String(e) });
        this.awaiting = false; this.resetBtn();
        notice(t('Could not decode the audio.'), true);
        return;
      }
      if (id !== this.reqId || !this.awaiting) { ttsLog('playWav: cancelado tras decodificar'); return; }
      ttsLog('playWav: decodificado OK', { segundos: +buf.duration.toFixed(1), canales: buf.numberOfChannels, ctxState: ctx.state });
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => {
        if (this.source === src) { ttsLog('playWav: onended (fin)'); this.source = null; this.playing = false; this.awaiting = false; this.resetBtn(); }
      };
      this.source = src;
      this.playing = true;
      try { src.start(); ttsLog('playWav: start() OK — sonando', { ctxState: ctx.state }); }
      catch (e) { ttsLog('playWav: start() FALLÓ', { err: String(e) }); this.source = null; this.playing = false; this.awaiting = false; this.resetBtn(); }
    },
  };
  tts.loadVoices();
  // Libera el AudioContext al descargar el webview (evita contextos colgados).
  window.addEventListener('pagehide', () => { if (tts.ctx) { try { tts.ctx.close(); } catch (e) {} } });
  if (tts.supported) {
    const refreshVoicesUI = () => {
      // Si el panel de config está abierto, refresca el selector de voces.
      if (doc && !configPanel.classList.contains('hidden')) renderConfig();
    };
    window.speechSynthesis.onvoiceschanged = () => { tts.loadVoices(); refreshVoicesUI(); };
    // Fallback: en Electron/VS Code 'voiceschanged' a veces no se dispara; sondea
    // hasta que getVoices() devuelva algo (o nos rindamos tras ~6s).
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

  function addMessage(role, content, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'msg ' + role;

    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    const name = document.createElement('span');
    name.textContent = role === 'user' ? t('You') : t('Assistant');
    roleEl.appendChild(name);

    if (role === 'assistant') {
      const badge = document.createElement('button');
      badge.className = 'think-badge';
      badge.textContent = t('reasoning');
      badge.addEventListener('click', () => {
        openThink();
        showThinking(el._thinking || '');
      });
      roleEl.appendChild(badge);

      const tbadge = document.createElement('button');
      tbadge.className = 'tool-badge';
      tbadge.textContent = t('tools');
      tbadge.addEventListener('click', () => { openTools(); showTools(el._toolActivity || []); });
      roleEl.appendChild(tbadge);
    }

    // Navegador de variantes de reproceso (‹ i/n › 🗑) cuando hay más de una.
    if (opts.variantCount > 1) {
      const nav = document.createElement('span');
      nav.className = 'variant-nav';
      const active = opts.variantActive || 0;
      const mkBtn = (label, title, handler, disabled) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        if (disabled) b.disabled = true;
        else b.addEventListener('click', handler);
        return b;
      };
      nav.appendChild(mkBtn('‹', t('Previous variant'),
        () => vscode.postMessage({ type: 'setVariant', index: opts.index, variant: active - 1 }), active <= 0));
      const counter = document.createElement('span');
      counter.className = 'variant-count';
      counter.textContent = (active + 1) + '/' + opts.variantCount;
      nav.appendChild(counter);
      nav.appendChild(mkBtn('›', t('Next variant'),
        () => vscode.postMessage({ type: 'setVariant', index: opts.index, variant: active + 1 }), active >= opts.variantCount - 1));
      roleEl.appendChild(nav);
    }

    // Acciones por mensaje (solo en mensajes persistidos, con índice conocido).
    if (Number.isInteger(opts.index)) {
      const actions = document.createElement('span');
      actions.className = 'msg-actions';
      const copyBtn = iconButton(ICONS.copy, t('Copy'), () => {
        vscode.postMessage({ type: 'copy', text: content });
        copyBtn.innerHTML = ICONS.check;
        setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 1200);
      });
      actions.appendChild(copyBtn);
      const readBtn = iconButton(ICONS.speaker, t('Read aloud'), () => tts.speak(content, readBtn, opts.id));
      actions.appendChild(readBtn);
      actions.appendChild(iconButton(ICONS.edit, t('Edit message'), () => startEditInline(el, opts.index)));
      if (opts.canRegenerate) {
        actions.appendChild(iconButton(ICONS.retry, t('Reprocess (regenerate as a new variant)'), () => {
          clearNotices();
          const last = messagesEl.querySelector('.msg.assistant:last-child');
          if (last) last.remove();
          vscode.postMessage({ type: 'regenerate' });
        }));
        actions.appendChild(iconButton(ICONS.forward, t('Continue / keep developing this response'),
          () => { clearNotices(); vscode.postMessage({ type: 'continue' }); }));
      }
      if (opts.canGenerate) {
        // Regenera la respuesta a este prompt: trunca lo que cuelgue tras él (tool-calls a medias, etc.) y vuelve a inferir.
        actions.appendChild(iconButton(ICONS.retry, t('Generate a response to this message'),
          () => { clearNotices(); vscode.postMessage({ type: 'regenerateFrom', index: opts.index }); }));
      }
      if (opts.canRegenFromPrompt) {
        // Re-rolla la respuesta a este prompt (variante del asistente), sin borrar nada.
        actions.appendChild(iconButton(ICONS.retry, t('Regenerate the response to this message'),
          () => {
            clearNotices();
            const last = messagesEl.querySelector('.msg.assistant:last-child');
            if (last) last.remove();
            vscode.postMessage({ type: 'regenerate' });
          }));
      }
      if (opts.canMerge) {
        actions.appendChild(iconButton(ICONS.mergeUp, t('Merge with previous message'),
          () => vscode.postMessage({ type: 'mergeMessage', index: opts.index })));
      }
      actions.appendChild(iconButton(ICONS.branch,
        t('Fork: clone the conversation up to here into a new .chat') + ` · ${t('⌥/Alt: fork from here to the end')}`,
        (e) => vscode.postMessage({ type: 'fork', index: opts.index, fromHere: !!(e && e.altKey) })));
      const hasVariants = opts.variantCount > 1;
      const delTitle = (hasVariants
        ? `${t('Delete this variant')} (${(opts.variantActive || 0) + 1}/${opts.variantCount})`
        : t('Delete message')) + ` · ${t('⌥/Alt: delete this and all below')} · ${t('⇧/Shift: skip confirmation')}`;
      actions.appendChild(iconButton(ICONS.trash, delTitle, (e) => {
        const confirm = !(e && e.shiftKey); // Shift salta la confirmación
        if (e && e.altKey && Number.isInteger(opts.index)) {
          vscode.postMessage({ type: 'deleteFrom', index: opts.index, confirm }); // borra este y todos los de abajo
        } else if (hasVariants) {
          vscode.postMessage({ type: 'deleteVariant', index: opts.index, variant: opts.variantActive || 0, confirm });
        } else {
          vscode.postMessage({ type: 'deleteMessage', index: opts.index, confirm });
        }
      }));
      roleEl.appendChild(actions);
    }

    el.appendChild(roleEl);
    const body = document.createElement('div');
    body.className = 'body';
    if (role === 'assistant' && !opts.cursor && !(content && content.trim())) {
      // Respuesta vacía (algunos modelos vuelcan todo al razonamiento): nota clara en vez de globo en blanco.
      body.innerHTML = opts.thinking
        ? '<span class="empty-note">' + escapeHtml(t('The model put the whole response in its reasoning 🧠 — turn off «Reasoning / thinking» in ⚙ to see it here.')) + '</span>'
        : '<span class="empty-note">' + escapeHtml(t('(empty response)')) + '</span>';
    } else {
      body.innerHTML = renderMarkdown(content);
    }
    if (opts.cursor) body.classList.add('cursor');
    el.appendChild(body);
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      const att = document.createElement('div');
      att.className = 'msg-attachments';
      for (const a of opts.attachments) {
        if (a.kind === 'image') {
          const img = document.createElement('img');
          img.src = 'data:' + a.mime + ';base64,' + a.data;
          att.appendChild(img);
        } else {
          const c = document.createElement('span');
          c.className = 'file-chip';
          c.textContent = '📄 ' + a.name;
          att.appendChild(c);
        }
      }
      el.appendChild(att);
    }
    if (role === 'assistant') {
      bindThinking(el, opts.thinking || '');
      el._toolActivity = opts.toolActivity || null;
      el.classList.toggle('has-tools', !!(opts.toolActivity && opts.toolActivity.length));
    }
    messagesEl.appendChild(el);
    scrollDown();
    return el;
  }

  function bindThinking(el, text) {
    el._thinking = text || '';
    el.classList.toggle('has-think', !!text);
  }

  // Edición inline del contenido de un mensaje.
  function startEditInline(el, index) {
    if (el.querySelector('.edit-wrap')) return; // ya editando
    const m = doc && doc.messages[index];
    if (!m) return;
    el.classList.add('editing');
    const body = el.querySelector('.body');
    body.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'edit-wrap';
    const ta = document.createElement('textarea');
    ta.className = 'edit-area';
    ta.spellcheck = true;
    ta.lang = 'es';
    ta.value = m.content;
    const bar = document.createElement('div');
    bar.className = 'edit-bar';
    const cancel = document.createElement('button');
    cancel.textContent = t('Cancel');
    cancel.className = 'btn-secondary';
    const save = document.createElement('button');
    save.textContent = t('Save');
    save.className = 'btn-primary';
    bar.appendChild(cancel); // izquierda
    bar.appendChild(save);   // derecha
    wrap.appendChild(ta);
    wrap.appendChild(bar);
    body.after(wrap);

    const commit = () => vscode.postMessage({ type: 'editMessage', index, content: ta.value });
    const close = () => { body.style.display = ''; wrap.remove(); el.classList.remove('editing'); };
    save.addEventListener('click', commit);
    cancel.addEventListener('click', close);
    ta.addEventListener('keydown', (e) => {
      if (handleSuggestKeydown(e)) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    setupEmojiAutocomplete(ta); // autocompletado :nombre también al editar

    // Alinea el borde inferior de la burbuja en edición al final del área visible.
    const alignBottom = () => {
      const cr = messagesEl.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      messagesEl.scrollTop += (er.bottom - cr.bottom) + 8;
    };
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.5) + 'px'; };
    ta.addEventListener('input', autosize);
    ta.focus({ preventScroll: true });
    autosize();
    requestAnimationFrame(alignBottom);
  }

  // ---- Paneles laterales ----
  function updateSide() {
    const open = !configPanel.classList.contains('hidden')
      || !thinkPanel.classList.contains('hidden')
      || !toolsPanel.classList.contains('hidden');
    sidepanels.classList.toggle('hidden', !open);
  }
  function openThink() { thinkPanel.classList.remove('hidden'); updateSide(); }
  function openTools() { toolsPanel.classList.remove('hidden'); updateSide(); }

  // Renderiza una lista de actividad de tools en el panel.
  function showTools(activity) {
    toolsContent.innerHTML = '';
    if (!activity || !activity.length) {
      toolsContent.classList.add('empty');
      toolsContent.textContent = t('No tool activity.');
      return;
    }
    toolsContent.classList.remove('empty');
    for (const a of activity) {
      const item = document.createElement('div');
      item.className = 'tool-item';
      const head = document.createElement('div');
      head.className = 'tool-item-head';
      head.innerHTML = ICONS.tool + '<span>' + escapeHtml(a.name) + '</span>';
      item.appendChild(head);
      if (a.args && a.args !== '{}') {
        const args = document.createElement('div');
        args.className = 'tool-args';
        args.textContent = a.args;
        item.appendChild(args);
      }
      if (a.result !== undefined) {
        const pre = document.createElement('pre');
        pre.textContent = a.result;
        item.appendChild(pre);
      }
      toolsContent.appendChild(item);
    }
    toolsContent.scrollTop = toolsContent.scrollHeight;
  }
  function showThinking(text) {
    if (text) {
      thinkContent.innerHTML = renderMarkdownImpl(text); // se llama por frame al razonar: sin caché
      thinkContent.classList.remove('empty');
    } else {
      thinkContent.textContent = t('This message has no reasoning.');
      thinkContent.classList.add('empty');
    }
    thinkContent.scrollTop = thinkContent.scrollHeight;
  }

  function banner(text, isError) {
    const el = document.createElement('div');
    el.className = 'banner' + (isError ? ' error' : '');
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollDown();
  }

  let suppressScroll = false; // evita auto-scroll durante un re-render masivo
  let stickToBottom = true;   // seguir el fondo mientras llega texto; se desactiva si el usuario sube
  function scrollDown() {
    if (suppressScroll || !stickToBottom) return; // si el usuario subió, no lo arrastramos al final
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  // El usuario manda: cerca del fondo → seguimos pegados; si sube a leer → paramos el auto-scroll.
  messagesEl.addEventListener('scroll', () => {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  });

  // Avisos persistentes (errores, resúmenes): NO se borran al re-renderizar el historial.
  function notice(text, isError) {
    const el = document.createElement('div');
    el.className = 'banner' + (isError ? ' error' : '');
    const span = document.createElement('span');
    span.className = 'banner-text';
    span.textContent = text;
    const x = document.createElement('button');
    x.className = 'banner-x';
    x.textContent = '×';
    x.title = t('Dismiss');
    x.addEventListener('click', () => el.remove());
    el.appendChild(span);
    el.appendChild(x);
    noticesEl.appendChild(el);
    if (!isError) setTimeout(() => el.remove(), 6000); // los avisos informativos se autocierran
    return el;
  }
  function clearNotices() { noticesEl.innerHTML = ''; toolsLive = []; }

  function renderConversation() {
    // Si se está leyendo un mensaje que ya no existe (lo borraron), detén el audio.
    if (tts.busy() && tts.msgId && doc && !(doc.messages || []).some((m) => m.id === tts.msgId)) {
      tts.stop();
    }
    // Conserva la posición de scroll del usuario (salvo que estuviera al final).
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
    const prevTop = messagesEl.scrollTop;
    messagesEl.innerHTML = '';
    if (!doc) return;
    suppressScroll = true;
    const visible = doc.messages.filter((m) => m.role !== 'system');
    if (visible.length === 0) {
      banner('Chat vacío. Escribe abajo para empezar. Modelo: ' + (doc.model || '—'));
    }
    // Mensajes ocultos (assistant intermedio con tool_calls, y los 'tool') no cuentan como
    // "último": el último mostrable es el que recibe los botones de regenerar/generar.
    const displayable = (mm) => !((mm.role === 'assistant' && Array.isArray(mm.toolCalls) && mm.toolCalls.length) || mm.role === 'tool');
    let lastDisplayable = -1;
    for (let k = visible.length - 1; k >= 0; k--) { if (displayable(visible[k])) { lastDisplayable = k; break; } }
    let lastThinking = '';
    let pendingTools = []; // actividad de tools acumulada hasta el mensaje final del turno
    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      // Mensajes internos de tools: NO se muestran como burbuja; van al panel.
      if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        for (const tc of m.toolCalls) pendingTools.push({ name: tc.name, args: tc.arguments });
        continue;
      }
      if (m.role === 'tool') {
        const slot = pendingTools.find((t) => t.name === m.toolName && t.result === undefined);
        if (slot) slot.result = m.content;
        else pendingTools.push({ name: m.toolName, result: m.content });
        continue;
      }
      // Mensaje normal (user o respuesta final del asistente).
      const canMerge = i > 0 && visible[i - 1].role === m.role;
      const isLast = i === lastDisplayable; // último MOSTRABLE (ignora tool-calls/tool colgando)
      const canRegenerate = m.role === 'assistant' && isLast;
      // Último mensaje de usuario mostrable → regenerar respuesta (trunca lo que cuelgue tras él).
      const canGenerate = m.role === 'user' && isLast;
      // Mensaje de usuario cuya respuesta (el asistente que le sigue) es la última mostrable:
      // permite re-rollar desde el prompt sin tener que borrar el asistente.
      const canRegenFromPrompt = m.role === 'user' && visible[i + 1] && visible[i + 1].role === 'assistant' && (i + 1) === lastDisplayable;
      const activity = (m.role === 'assistant' && pendingTools.length) ? pendingTools.slice() : null;
      addMessage(m.role, m.content, {
        thinking: m.thinking,
        attachments: m.attachments,
        toolActivity: activity,
        index: i,
        id: m.id,
        canMerge,
        canRegenerate,
        canGenerate,
        canRegenFromPrompt,
        variantCount: Array.isArray(m.variants) ? m.variants.length : 1,
        variantActive: m.active || 0,
      });
      if (m.role === 'assistant') lastThinking = m.thinking || '';
      pendingTools = [];
    }
    // Restaura el scroll: al final si ya estabas abajo; si no, donde estabas.
    suppressScroll = false;
    if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    else messagesEl.scrollTop = prevTop;
    // Si el buscador está abierto, re-resalta sobre el DOM recién reconstruido.
    if (typeof refreshFind === 'function') refreshFind();
    // Muestra el razonamiento del último mensaje en el panel.
    showThinking(lastThinking);
  }

  // ---- Exportar a PDF (HTML autocontenido + auto-impresión) ----
  const EXPORT_CSS = `
    *{box-sizing:border-box;}
    body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:760px;margin:0 auto;padding:36px 22px 48px;color:#1a1a1a;background:#fff;line-height:1.6;}
    h1.title{font-size:22px;font-weight:700;margin:0 0 2px;}
    .sub{color:#8a8a8a;font-size:12.5px;margin:0 0 26px;border-bottom:1px solid #ececec;padding-bottom:16px;}
    .m{margin:16px 0;display:flex;flex-direction:column;page-break-inside:avoid;}
    .m.user{align-items:flex-end;}
    .who{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#a0a0a0;margin:0 8px 4px;}
    .bubble{max-width:80%;padding:10px 15px;border-radius:16px;overflow-wrap:anywhere;}
    .m.assistant .bubble{background:#f3f4f6;border-bottom-left-radius:5px;}
    .m.user .bubble{background:#2563eb;color:#fff;border-bottom-right-radius:5px;}
    .bubble p{margin:.45em 0;} .bubble p:first-child{margin-top:0;} .bubble p:last-child{margin-bottom:0;}
    .bubble h1,.bubble h2,.bubble h3{margin:.5em 0 .3em;line-height:1.25;}
    .bubble ul,.bubble ol{margin:.3em 0;padding-left:1.4em;}
    .bubble pre{background:#0d1117;color:#e6edf3;padding:11px 13px;border-radius:9px;overflow:auto;font-size:12.5px;margin:.5em 0;}
    .m.user .bubble pre{background:#16336e;}
    .bubble code{background:rgba(130,130,130,.18);padding:1px 5px;border-radius:5px;font-size:.9em;}
    .m.user .bubble code{background:rgba(255,255,255,.22);}
    .bubble pre code{background:none;padding:0;}
    .bubble img{max-width:100%;border-radius:10px;margin-top:8px;}
    .bubble a{color:inherit;}
    .bubble table{border-collapse:collapse;margin:.5em 0;font-size:.95em;} .bubble th,.bubble td{border:1px solid #d6d6d6;padding:4px 9px;}
    .bubble blockquote{border-left:3px solid #ccc;margin:.5em 0;padding-left:10px;opacity:.85;}
  `;
  function buildExportHtml() {
    const msgs = (doc && doc.messages) || [];
    const visible = msgs.filter((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return false; // fuera 'tool'
      if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) return false; // intermedio de tools
      const hasImg = (m.attachments || []).some((a) => a.kind === 'image');
      return (m.content && m.content.trim()) || hasImg; // fuera vacíos
    });
    let body = '';
    for (const m of visible) {
      const who = m.role === 'user' ? t('You') : t('Assistant');
      let imgs = '';
      for (const a of (m.attachments || [])) {
        // Escapa mime y data: un sidecar .attach manipulado a mano podría inyectar markup
        // en el HTML exportado (se abre en el navegador externo).
        if (a.kind === 'image') imgs += `<img src="data:${escapeHtml(a.mime)};base64,${escapeHtml(a.data)}"/>`;
      }
      const inner = (m.content ? renderMarkdown(m.content) : '') + imgs;
      body += `<div class="m ${m.role}"><div class="who">${who}</div><div class="bubble">${inner}</div></div>`;
    }
    const title = (doc && doc.title) || 'Chat';
    const sub = `${(doc && doc.provider) || ''}${doc && doc.model ? ' · ' + doc.model : ''} · ${visible.length} ${t('messages')}`;
    return '<!DOCTYPE html><html lang="' + window.LangI18n.get() + '"><head><meta charset="utf-8"/><title>' + escapeHtml(title) +
      '</title><style>' + EXPORT_CSS + '</style></head><body>' +
      '<h1 class="title">' + escapeHtml(title) + '</h1><div class="sub">' + escapeHtml(sub) + '</div>' + body +
      '<script>window.onload=function(){setTimeout(function(){window.print()},300)}</scr' + 'ipt></body></html>';
  }

  // ---- Patch de configuración ----
  function patchConfig(patch) {
    if (doc) {
      if (patch.params) {
        doc.params = doc.params || {};
        for (const k of Object.keys(patch.params)) doc.params[k] = patch.params[k];
      }
      for (const k of Object.keys(patch)) if (k !== 'params') doc[k] = patch[k];
    }
    vscode.postMessage({ type: 'setConfig', patch });
    updateContextBar();
  }
  const patchParam = (key, value) => patchConfig({ params: { [key]: value } });

  // ---- Render del panel de configuración ----
  function renderConfig() {
    if (!doc) return;
    // Backend y modelo son estáticos en el HTML; aquí solo system prompt + parámetros.
    configFields.innerHTML = '';

    // System prompt: referencia a un archivo .md, o inline.
    if (doc.systemPromptFile) {
      const ref = document.createElement('div');
      ref.className = 'sysref';
      const name = document.createElement('span');
      name.className = 'sysref-name';
      name.textContent = '📄 ' + doc.systemPromptFile;
      const open = document.createElement('button');
      open.textContent = t('Open'); open.title = t('Open the .md file');
      open.addEventListener('click', () => vscode.postMessage({ type: 'openSysPrompt' }));
      const clear = document.createElement('button');
      clear.textContent = t('Remove'); clear.title = t('Back to inline system prompt');
      clear.addEventListener('click', () => vscode.postMessage({ type: 'clearSysPrompt' }));
      ref.appendChild(name); ref.appendChild(open); ref.appendChild(clear);
      configFields.appendChild(fieldRow(t('System prompt (file)'), ref));
    } else {
      const sys = document.createElement('textarea');
      sys.className = 'sys-area';
      sys.spellcheck = true; sys.lang = window.LangI18n.get();
      sys.rows = 2; sys.value = doc.systemPrompt; sys.placeholder = t('System instructions…');
      const sysAutosize = () => { sys.style.height = 'auto'; sys.style.height = Math.min(sys.scrollHeight, 320) + 'px'; };
      sys.addEventListener('input', sysAutosize);
      sys.addEventListener('change', () => patchConfig({ systemPrompt: sys.value }));
      requestAnimationFrame(sysAutosize);
      const actions = document.createElement('div');
      actions.className = 'sysref-actions';
      const create = document.createElement('button');
      create.textContent = t('Save');
      create.title = t('Save the prompt to a .md file and reference it');
      create.addEventListener('click', () => vscode.postMessage({ type: 'createSysPrompt' }));
      const pick = document.createElement('button');
      pick.textContent = t('Load');
      pick.title = t('Use an existing .md file');
      pick.addEventListener('click', () => vscode.postMessage({ type: 'pickSysPrompt' }));
      actions.appendChild(create); actions.appendChild(pick);
      const wrap = document.createElement('div');
      wrap.appendChild(sys); wrap.appendChild(actions);
      configFields.appendChild(fieldRow('System prompt', wrap));
    }

    // Grupos de parámetros, filtrados por el backend activo (oculta grupos vacíos).
    const provider = doc.provider;
    for (const section of SCHEMA) {
      const items = section.items.filter((it) => !it.only || it.only.includes(provider));
      if (!items.length) continue;
      const h = document.createElement('div');
      h.className = 'group-head';
      h.textContent = t(section.group);
      configFields.appendChild(h);
      for (const item of items) configFields.appendChild(paramRow(item));
    }

    // Lectura en voz alta (motor del sistema o Piper neural).
    renderTtsConfig();
  }

  // Sección de configuración de la lectura en voz alta.
  function renderTtsConfig() {
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = t('Read aloud');
    configFields.appendChild(h);

    const engine = tts.prefs.engine || 'system';

    // Selector de motor: voces del sistema vs Piper neural.
    const eng = document.createElement('select');
    [['system', t('System (Web Speech)')], ['piper', t('Piper (neural, better quality)')]].forEach(([val, label]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if (val === engine) o.selected = true;
      eng.appendChild(o);
    });
    eng.addEventListener('change', () => { tts.prefs.engine = eng.value; tts.save(); tts.stop(); renderConfig(); });
    configFields.appendChild(fieldRow(t('Engine'), eng));

    if (engine === 'system') {
      if (!tts.voices.length) {
        const note = document.createElement('div');
        note.className = 'cfg-note';
        note.textContent = tts.triedVoices ? t("Couldn't load system voices.") : t('Loading system voices…');
        configFields.appendChild(note);
        if (tts.triedVoices) {
          const retry = document.createElement('button');
          retry.className = 'btn-secondary';
          retry.textContent = t('Retry');
          retry.addEventListener('click', () => { tts.loadVoices(); if (!tts.voices.length && tts.pollVoices) tts.pollVoices(); renderConfig(); });
          const row = document.createElement('div');
          row.className = 'sysref-actions';
          row.appendChild(retry);
          configFields.appendChild(row);
        }
        return;
      }
      // Selector de voz (español primero).
      const sel = document.createElement('select');
      for (const v of tts.sortedVoices()) {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = `${v.name} (${v.lang})`;
        if (v.voiceURI === tts.prefs.voiceURI) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { tts.prefs.voiceURI = sel.value; tts.save(); });
      configFields.appendChild(fieldRow(t('Voice'), sel));
    } else {
      // Piper: el selector ofrece SOLO las voces DESCARGADAS. La opción Custom solo aparece si hay
      // una ruta .onnx configurada en Ajustes (o si es la selección actual) — para un usuario
      // normal sin path custom, el combo muestra exclusivamente lo descargado.
      const dl = tts.downloadedVoices;
      const showCustom = tts.customSet || tts.prefs.piperVoice === 'custom';
      const available = tts.piperVoices.filter((v) =>
        v.id === 'custom' ? showCustom : dl.has(v.id)
      );
      const realVoices = available.filter((v) => v.id !== 'custom');
      // Si la voz seleccionada ya no está descargada, reasigna a una válida (1ª real, o Custom).
      if (tts.prefs.piperVoice !== 'custom' && !dl.has(tts.prefs.piperVoice)) {
        tts.prefs.piperVoice = realVoices.length ? realVoices[0].id : 'custom';
        tts.save();
      }
      const sel = document.createElement('select');
      for (const v of available) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.id === 'custom' ? v.label + t('Custom (path in Settings)') : v.label;
        if (v.id === tts.prefs.piperVoice) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { tts.prefs.piperVoice = sel.value; tts.save(); tts.stop(); renderConfig(); });
      configFields.appendChild(fieldRow(t('Voice'), sel));

      const note = document.createElement('div');
      note.className = 'cfg-note';
      note.textContent = tts.prefs.piperVoice === 'custom'
        ? t('Set the .onnx model path in Settings (langChat.tts.piperModel).')
        : !realVoices.length
          ? t('No voices downloaded. Add one from the Lang Chat panel (Voices ➕).')
          : t('Downloaded voices work offline. Add more from the Lang Chat panel (Voices ➕).');
      configFields.appendChild(note);
    }

    // Velocidad (común a ambos motores).
    const rateWrap = document.createElement('div');
    rateWrap.className = 'tts-rate';
    const rate = document.createElement('input');
    rate.type = 'range'; rate.min = '0.5'; rate.max = '2'; rate.step = '0.05';
    rate.value = String(tts.prefs.rate || 1);
    const rateVal = document.createElement('span');
    rateVal.className = 'tts-rate-val';
    rateVal.textContent = (tts.prefs.rate || 1).toFixed(2) + '×';
    rate.addEventListener('input', () => { rateVal.textContent = Number(rate.value).toFixed(2) + '×'; });
    rate.addEventListener('change', () => { tts.prefs.rate = Number(rate.value); tts.save(); });
    rateWrap.appendChild(rate); rateWrap.appendChild(rateVal);
    configFields.appendChild(fieldRow(t('Speed'), rateWrap));

    // Botones: probar y (solo Piper con voz curada) actualizar.
    const testRow = document.createElement('div');
    testRow.className = 'sysref-actions';
    const test = document.createElement('button');
    test.className = 'btn-secondary';
    test.textContent = '🔊 ' + t('Test voice');
    test.addEventListener('click', () => tts.speak(t('Hello, this is a voice test.'), null));
    testRow.appendChild(test);
    if (engine === 'piper' && tts.prefs.piperVoice && tts.prefs.piperVoice !== 'custom') {
      const upd = document.createElement('button');
      upd.className = 'btn-secondary';
      upd.textContent = '↻ ' + t('Update');
      upd.title = t('Re-download the Piper engine and voice (e.g. if updated upstream).');
      upd.addEventListener('click', () => {
        tts.stop();
        vscode.postMessage({ type: 'ttsUpdate', voice: tts.prefs.piperVoice });
      });
      testRow.appendChild(upd);
    }
    configFields.appendChild(testRow);
  }

  function fieldRow(label, control) {
    const row = document.createElement('div');
    row.className = 'cfg-row';
    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);
    row.appendChild(control);
    return row;
  }

  function paramRow(item) {
    const p = doc.params || {};
    const row = document.createElement('div');
    row.className = 'cfg-row param';

    if (item.kind === 'tags') {
      row.appendChild(tagsControl(item, p));
      return row;
    }

    if (item.kind === 'bool') {
      const head = document.createElement('div');
      head.className = 'param-head';
      const left = document.createElement('div');
      left.className = 'param-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!p[item.key];
      row.classList.toggle('disabled', !cb.checked); // atenuar cuando está apagado
      cb.addEventListener('change', () => {
        row.classList.toggle('disabled', !cb.checked);
        patchParam(item.key, cb.checked);
      });
      const lab = document.createElement('span');
      lab.textContent = t(item.label);
      left.appendChild(cb);
      left.appendChild(lab);
      head.appendChild(left);
      row.appendChild(head);
      return row;
    }

    const val = p[item.key];
    const enabled = item.toggle ? !!(val && val.enabled) : true;
    const numValue = item.toggle ? (val ? val.value : item.min) : (typeof val === 'number' ? val : item.min);

    // Cabecera: [checkbox] etiqueta ............ [caja numérica]
    const head = document.createElement('div');
    head.className = 'param-head';

    const left = document.createElement('div');
    left.className = 'param-label';
    let check = null;
    if (item.toggle) {
      check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = enabled;
      left.appendChild(check);
    }
    const lab = document.createElement('span');
    lab.textContent = t(item.label);
    left.appendChild(lab);
    head.appendChild(left);

    const numBox = document.createElement('input');
    numBox.type = 'number';
    numBox.className = 'param-num';
    numBox.min = item.min; numBox.max = item.max; numBox.step = item.step;
    numBox.value = String(numValue);
    head.appendChild(numBox);
    row.appendChild(head);

    let slider = null;
    if (item.kind === 'slider') {
      slider = document.createElement('input');
      slider.type = 'range';
      slider.min = item.min; slider.max = item.max; slider.step = item.step;
      slider.value = String(numValue);
      row.appendChild(slider);
    }

    const setDisabled = (off) => {
      numBox.disabled = off;
      if (slider) slider.disabled = off;
      row.classList.toggle('disabled', off);
    };
    setDisabled(item.toggle && !enabled);

    const commit = () => {
      const v = clamp(parseFloat(numBox.value), item);
      numBox.value = String(v);
      if (slider) slider.value = String(v);
      if (item.toggle) patchParam(item.key, { enabled: check.checked, value: v });
      else patchParam(item.key, v);
    };

    if (slider) {
      slider.addEventListener('input', () => { numBox.value = slider.value; });
      slider.addEventListener('change', commit);
    }
    numBox.addEventListener('input', () => { if (slider) slider.value = numBox.value; });
    numBox.addEventListener('change', commit);
    if (check) {
      check.addEventListener('change', () => {
        setDisabled(!check.checked);
        patchParam(item.key, { enabled: check.checked, value: clamp(parseFloat(numBox.value), item) });
      });
    }

    return row;
  }

  function clamp(v, item) {
    if (Number.isNaN(v)) v = item.min;
    if (item.step >= 1) v = Math.round(v);
    return Math.min(item.max, Math.max(item.min, v));
  }

  function tagsControl(item, p) {
    const wrap = document.createElement('div');
    wrap.className = 'param-head';
    const lab = document.createElement('div');
    lab.className = 'param-label';
    lab.innerHTML = '<span>' + escapeHtml(t(item.label)) + '</span>';
    wrap.appendChild(lab);

    const box = document.createElement('div');
    box.className = 'tags';
    const stops = Array.isArray(p.stop) ? p.stop.slice() : [];

    function commit() { patchParam('stop', stops.slice()); render(); }
    function render() {
      box.innerHTML = '';
      stops.forEach((s, i) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = s;
        const x = document.createElement('button');
        x.textContent = '×'; x.title = t('Remove');
        x.addEventListener('click', () => { stops.splice(i, 1); commit(); });
        tag.appendChild(x);
        box.appendChild(tag);
      });
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = t('Type and press ⏎');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          stops.push(input.value.trim());
          commit();
        }
      });
      box.appendChild(input);
    }
    render();

    const outer = document.createElement('div');
    outer.appendChild(wrap);
    outer.appendChild(box);
    return outer;
  }

  // ---- Estado de conexión ----
  let statusInfo = null, statusState = 'checking', statusDetail = '';
  function renderStatus(info, state, detail) {
    statusInfo = info; statusState = state; statusDetail = detail || '';
    paintStatus();
  }
  // Compone el estado: proveedor · modelo activo (o el detalle si no hay modelo).
  function paintStatus() {
    if (!statusInfo) return;
    statusDot.className = statusState;
    const model = modelSelect.value;
    let txt = statusInfo.label;
    if (model) txt += ' · ' + model;
    else if (statusDetail) txt += ' · ' + statusDetail;
    statusText.textContent = txt;
    statusText.title = statusInfo.label + ' — ' + statusInfo.endpoint + (statusDetail ? ' (' + statusDetail + ')' : '');
  }

  // ---- Modelos ----
  function fmtTokens(n) {
    if (!n) return '';
    if (n >= 1e6) return (n % 1e6 ? (n / 1e6).toFixed(1) : n / 1e6) + 'M';
    if (n >= 1e3) return Math.round(n / 1000) + 'K';
    return String(n);
  }
  function updateModelCtx() {
    const n = modelContext[modelSelect.value];
    modelCtxEl.textContent = n ? fmtTokens(n) : '';
    modelCtxEl.title = n ? n.toLocaleString() + ' ' + t('model context tokens') : '';
    updateModelCaps();
    paintStatus();
  }
  function updateModelCaps() {
    const c = modelCaps[modelSelect.value] || {};
    const caps = [];
    if (c.reasoning) caps.push(['spark', t('Reasoning / thinking')]);
    if (c.vision) caps.push(['eye', t('Vision (images)')]);
    if (c.audio) caps.push(['audio', t('Audio')]);
    if (c.files) caps.push(['file', t('Files / documents')]);
    if (c.tools) caps.push(['tool', t('Tools / function calling')]);
    // Tooltip tanto en el span (title) como dentro del SVG (<title>), para máxima compatibilidad.
    modelCapsEl.innerHTML = caps.map((c) => {
      const svg = ICONS[c[0]].replace('>', '><title>' + c[1] + '</title>', 1);
      return '<span class="cap" title="' + c[1] + '">' + svg + '</span>';
    }).join('');
  }

  function renderModels(models, current, error) {
    modelSelect.innerHTML = '';
    modelContext = {};
    modelCaps = {};
    if (error || models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = error ? t('No connection') : t('No models');
      modelSelect.appendChild(opt);
      updateModelCtx();
      return;
    }
    for (const info of models) {
      if (info.contextLength) modelContext[info.id] = info.contextLength;
      modelCaps[info.id] = {
        vision: info.vision, files: info.files, audio: info.audio,
        tools: info.tools, reasoning: info.reasoning,
      };
    }

    // Agrupa por proveedor (el prefijo antes de '/', p. ej. openai/gpt-4o-mini).
    const groups = new Map();
    for (const info of models) {
      const m = info.id;
      const slash = m.indexOf('/');
      const vendor = slash > 0 ? m.slice(0, slash) : '';
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(m);
    }

    const named = [...groups.keys()].filter((v) => v).sort((a, b) => a.localeCompare(b));
    const order = groups.has('') ? [...named, ''] : named; // sin proveedor, al final

    const addOption = (parent, m, label) => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = label;
      if (m === current) opt.selected = true;
      parent.appendChild(opt);
    };

    for (const vendor of order) {
      const list = groups.get(vendor).sort((a, b) => a.localeCompare(b));
      if (vendor) {
        const og = document.createElement('optgroup');
        og.label = vendor;
        // Dentro del grupo basta con el nombre del modelo (sin el prefijo del vendor).
        for (const m of list) addOption(og, m, m.slice(vendor.length + 1));
        modelSelect.appendChild(og);
      } else {
        for (const m of list) addOption(modelSelect, m, m);
      }
    }
    updateModelCtx();
    if (doc) doc.model = current;
  }

  let isStreaming = false;
  function setStreaming(on) {
    isStreaming = on;
    sendBtn.classList.toggle('hidden', on);
    stopBtn.classList.toggle('hidden', !on);
  }

  // ---- Adjuntos ----
  const IMG_RE = /^image\//;
  const TEXT_EXT = /\.(txt|md|json|csv|js|ts|tsx|jsx|py|java|c|cpp|h|go|rs|rb|php|html|css|scss|xml|yaml|yml|toml|ini|sh|sql|log|env)$/i;
  function isTextLike(file) {
    if (/^text\//.test(file.type)) return true;
    if (/(json|xml|javascript|yaml|csv|markdown|x-sh|x-python)/i.test(file.type)) return true;
    if (!file.type) return TEXT_EXT.test(file.name || ''); // mime desconocido: por extensión
    return false;
  }
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(',') + 1)); };
      reader.onerror = () => reject(reader.error || new Error('read error'));
      reader.readAsDataURL(file);
    });
  }
  async function fileToAttachment(file) {
    if (IMG_RE.test(file.type)) {
      return { kind: 'image', name: file.name || 'imagen.png', mime: file.type || 'image/png', data: await readBase64(file) };
    }
    if (isTextLike(file)) {
      const text = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result));
        rd.onerror = () => reject(rd.error || new Error('read error'));
        rd.readAsText(file);
      });
      return { kind: 'text', name: file.name || 'archivo.txt', mime: file.type || 'text/plain', data: text };
    }
    // PDF, docx, binarios… → documento en base64
    return { kind: 'document', name: file.name || 'documento', mime: file.type || 'application/octet-stream', data: await readBase64(file) };
  }

  async function addFiles(files) {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) { notice(t('Attachment too large (max 20 MB): ') + file.name, true); continue; }
      try {
        pending.push(await fileToAttachment(file));
      } catch (e) {
        notice(t('Could not read the file: ') + (file.name || ''), true);
      }
    }
    renderPending();
  }

  function renderPending() {
    attachmentsEl.innerHTML = '';
    attachmentsEl.classList.toggle('hidden', pending.length === 0);
    pending.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      if (a.kind === 'image') {
        const img = document.createElement('img');
        img.src = 'data:' + a.mime + ';base64,' + a.data;
        chip.appendChild(img);
      } else {
        chip.appendChild(document.createTextNode('📄 ' + a.name));
      }
      const x = document.createElement('button');
      x.textContent = '×'; x.title = t('Remove');
      x.addEventListener('click', () => { pending.splice(i, 1); renderPending(); });
      chip.appendChild(x);
      attachmentsEl.appendChild(chip);
    });
  }

  // ---- Barra de uso de contexto (por tokens) ----
  function estTokens(s) { return s ? Math.ceil(s.length / 4) : 0; }
  function msgTokens(m) {
    let t = estTokens(m.content) + 4;
    for (const a of (m.attachments || [])) t += a.kind === 'image' ? 1200 : estTokens(a.data);
    return t;
  }
  function updateUsage() {
    // Se calcula sumando el uso de los mensajes presentes (no un acumulador fijo).
    let pt = 0, ct = 0, tt = 0, cost = 0, has = false;
    const add = (u) => { if (u) { has = true; pt += u.promptTokens || 0; ct += u.completionTokens || 0; tt += u.totalTokens || 0; if (u.cost) cost += u.cost; } };
    for (const m of (doc && doc.messages) || []) {
      // Si hay variantes (retries), suma TODAS (cada una fue una llamada pagada).
      if (Array.isArray(m.variants) && m.variants.length) {
        for (const v of m.variants) add(v.usage);
      } else {
        add(m.usage);
      }
    }
    if (!has || !tt) { usageChipEl.textContent = ''; return; }
    usageChipEl.textContent = fmtTokens(tt) + ' tok' + (cost ? ' · $' + cost.toFixed(cost < 0.01 ? 4 : 2) : '');
    usageChipEl.title = `${t('Tokens (current messages)')} — ${t('input')}: ${pt.toLocaleString()} · ${t('output')}: ${ct.toLocaleString()} · ${t('total')}: ${tt.toLocaleString()}`
      + (cost ? `\n${t('Cost')}: $${cost.toFixed(6)}` : '');
  }

  function updateContextBar() {
    // Solo aplica con resumen automático (compactación por tokens).
    if (!doc || !doc.params || !doc.params.autoSummary) { ctxBar.classList.add('hidden'); return; }
    const modelCtx = modelContext[modelSelect.value];
    const cb = doc.params.contextBudget;
    const budget = (cb && cb.enabled && cb.value > 0) ? cb.value : (modelCtx ? Math.floor(modelCtx * 0.75) : 16000);
    const upTo = doc.summary ? doc.summary.upTo : 0;
    let total = estTokens(doc.systemPrompt) + estTokens(doc.summary ? doc.summary.text : '');
    const msgs = doc.messages || [];
    for (let i = upTo; i < msgs.length; i++) total += msgTokens(msgs[i]);
    const pct = Math.min(100, Math.round((total / budget) * 100));
    ctxBar.classList.remove('hidden');
    ctxFill.style.width = pct + '%';
    ctxFill.className = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
    ctxLabel.textContent = `${t('Context')} ${fmtTokens(total)}/${fmtTokens(budget)} (${pct}%)`;
  }

  // ---- Enviar ----
  function send() {
    if (isStreaming) return; // ignora Enter/click mientras se genera una respuesta
    const text = inputEl.value.trim();
    if (!text && pending.length === 0) return;
    clearNotices();
    stickToBottom = true; // al enviar, vuelve a pegarse al fondo
    const attachments = pending.slice();
    addMessage('user', text, { attachments });
    if (doc) doc.messages.push({ role: 'user', content: text, attachments });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    renderSpell(); // limpia el subrayado del overlay
    pending = [];
    renderPending();
    setStreaming(true); // bloquea reenvíos hasta streamEnd/error
    vscode.postMessage({ type: 'send', text, attachments });
  }

  // ---- Eventos UI ----
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  inputEl.addEventListener('keydown', (e) => {
    if (handleSuggestKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.4) + 'px';
    scheduleSpell();
  });
  inputEl.addEventListener('scroll', () => { if (inputBackdrop) inputBackdrop.scrollTop = inputEl.scrollTop; });

  // ---- Corrector ortográfico (subrayado en vivo vía overlay; motor nspell en spell.js) ----
  const WORD_RE = /[\p{L}\p{M}]+/gu; // palabras (letras + marcas/diacríticos); ignora números/símbolos
  let spellTimer = null;

  // Idioma efectivo del corrector según el selector per-chat: 'auto' → idioma del sistema.
  function spellEffective() {
    const pref = spellSelect ? spellSelect.value : 'auto';
    if (pref === 'off') return null;
    if (pref === 'es' || pref === 'en') return pref;
    const sys = (navigator.language || '').toLowerCase();
    return sys.startsWith('es') ? 'es' : sys.startsWith('en') ? 'en' : null; // otros idiomas: sin corrector
  }

  function applySpellLang() {
    if (window.LangSpell) window.LangSpell.setLang(spellEffective());
    renderSpell();
  }

  // Reconstruye la capa de fondo con las palabras mal escritas subrayadas.
  function renderSpell() {
    if (!inputBackdrop) return;
    const text = inputEl.value;
    if (!window.LangSpell || !window.LangSpell.ready()) { inputBackdrop.textContent = ''; return; }
    let html = '', last = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      const w = m[0];
      html += escapeHtml(text.slice(last, m.index));
      html += window.LangSpell.correct(w) ? escapeHtml(w) : '<span class="sp-err">' + escapeHtml(w) + '</span>';
      last = m.index + w.length;
    }
    html += escapeHtml(text.slice(last));
    inputBackdrop.innerHTML = html;
    inputBackdrop.scrollTop = inputEl.scrollTop;
  }

  function scheduleSpell() {
    if (spellTimer) clearTimeout(spellTimer);
    spellTimer = setTimeout(renderSpell, 250);
  }

  if (window.LangSpell) window.LangSpell.onReady(renderSpell);
  if (spellSelect) {
    spellSelect.addEventListener('change', () => {
      patchConfig({ spellLang: spellSelect.value });
      applySpellLang();
    });
  }

  // Palabra (rango) que contiene/toca el offset `pos` en `text`.
  function wordAt(text, pos) {
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) {
      if (pos >= m.index && pos <= m.index + m[0].length) return { text: m[0], start: m.index, end: m.index + m[0].length };
      if (m.index > pos) break;
    }
    return null;
  }

  // Menú flotante de sugerencias.
  let spellMenu = null;
  function closeSpellMenu() { if (spellMenu) { spellMenu.remove(); spellMenu = null; } }
  function showSpellMenu(x, y, word, suggestions) {
    closeSpellMenu();
    spellMenu = document.createElement('div');
    spellMenu.id = 'spellMenu';
    if (suggestions.length) {
      for (const s of suggestions) {
        const it = document.createElement('div');
        it.className = 'sp-item';
        it.textContent = s;
        it.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          const v = inputEl.value;
          inputEl.value = v.slice(0, word.start) + s + v.slice(word.end);
          const caret = word.start + s.length;
          inputEl.setSelectionRange(caret, caret);
          inputEl.dispatchEvent(new Event('input'));
          inputEl.focus();
          closeSpellMenu();
        });
        spellMenu.appendChild(it);
      }
    } else {
      const none = document.createElement('div');
      none.className = 'sp-none';
      none.textContent = t('No suggestions');
      spellMenu.appendChild(none);
    }
    const sep = document.createElement('div');
    sep.className = 'sp-sep';
    spellMenu.appendChild(sep);
    const add = document.createElement('div');
    add.className = 'sp-item';
    add.textContent = '➕ ' + t('Add to dictionary');
    add.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const lang = window.LangSpell ? window.LangSpell.lang() : null; // idioma activo del corrector
      if (window.LangSpell) window.LangSpell.add(word.text);   // efecto inmediato
      vscode.postMessage({ type: 'spellAddWord', word: word.text, lang }); // persiste por idioma
      renderSpell();
      closeSpellMenu();
      inputEl.focus();
    });
    spellMenu.appendChild(add);
    document.body.appendChild(spellMenu);
    // Encaja en pantalla.
    const r = spellMenu.getBoundingClientRect();
    spellMenu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    spellMenu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }

  inputEl.addEventListener('contextmenu', (e) => {
    if (!window.LangSpell || !window.LangSpell.ready()) return; // sin corrector: menú nativo
    const word = wordAt(inputEl.value, inputEl.selectionStart);
    if (!word || window.LangSpell.correct(word.text)) { closeSpellMenu(); return; }
    e.preventDefault();
    showSpellMenu(e.clientX, e.clientY, word, window.LangSpell.suggest(word.text));
  });
  document.addEventListener('mousedown', (e) => { if (spellMenu && !spellMenu.contains(e.target)) closeSpellMenu(); });
  window.addEventListener('blur', closeSpellMenu);
  // Pegar imágenes (Ctrl+V) directamente en el chat.
  inputEl.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  // ---- Selector de emojis ----
  const emojiBtn = $('emojiBtn');
  const emojiPicker = $('emojiPicker');
  const EMOJI_CATS = [
    { icon: '😀', emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾' },
    { icon: '👍', emojis: '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 👃 🧠 🫀 🫁 🦷 🦴 👀 👁️ 👅 👄 🫦 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🙇 🤦 🤷 👮 🕵️ 💂 👷 🤴 👸 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💆 💇 🚶 🏃 💃 🕺 👯 🧖 🧗 🏇 ⛷️ 🏂 🏌️ 🏄 🚣 🏊 🤽 🤾 🤹' },
    { icon: '🐶', emojis: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🦗 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦏 🐪 🐫 🦒 🐃 🐄 🐎 🐖 🐏 🐑 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🕊️ 🐇 🦝 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🍃 🌷 🌹 🌺 🌸 🌼 🌻 🌙 ⭐ 🌟 ✨ ⚡ 💥 🔥 🌈 ☀️ ⛅ ☁️ ❄️ ⛄ 💧 🌊' },
    { icon: '🍕', emojis: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾' },
    { icon: '⚽', emojis: '⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🥅 ⛳ 🪁 🎣 🤿 🎽 🎿 🛷 🥌 🎯 🎮 🕹️ 🎰 🎲 🧩 ♟️ 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🏍️ 🛵 🚲 🛴 🚀 ✈️ 🚁 🚂 🚆 🚊 ⛵ 🚤 🛳️ ⚓ 🚦 🗺️ 🗽 🗼 🏰 🏯 🎡 🎢 🎠 ⛲ 🏖️ 🏝️ 🏔️ ⛰️ 🌋 🏕️ ⛺ 🏠 🏡 🏢 🏬 🏥 🏦 🏨 🏪 🏫 🏛️' },
    { icon: '💡', emojis: '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🧭 ⏰ 🕰️ ⌛ ⏳ 🔋 🔌 💡 🔦 🕯️ 🧯 💸 💵 💴 💶 💷 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⛏️ 🛠️ 🗡️ ⚔️ 🔫 🛡️ 🔩 ⚙️ 🧲 🔬 🔭 📡 💉 🩸 💊 🩹 🩺 🚪 🛏️ 🛋️ 🚽 🚿 🛁 🧴 🧷 🧹 🧺 🧻 🧼 🧽 🔑 🗝️ 📦 📫 📮 📜 📄 📑 📊 📈 📉 📅 📆 📋 📌 📎 📏 📐 ✂️ 🖊️ 🖍️ 📝 ✏️ 🔍 🔎 🔒 🔓 🔐 🔔 🔕 📢 📣 💬 💭 🗯️' },
    { icon: '❤️', emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ ☯️ ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⚛️ ☢️ ☣️ ✴️ 🆚 🅰️ 🅱️ 🆎 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 🚫 💯 💢 ♨️ 🔞 ❗ ❓ ❕ ❔ ‼️ ⁉️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ ❎ ✔️ 💲 💱 ©️ ®️ ™️ 🔟 #️⃣ ▶️ ⏸️ ⏹️ ⏭️ ⏮️ ⏩ ⏪ 🔼 🔽 ➡️ ⬅️ ⬆️ ⬇️ 🔀 🔁 🔂 🔄 ➕ ➖ ➗ ✖️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✨ ⭐ 🌟 💫' },
  ];
  let emojiBuilt = false;
  function insertAtCursor(text) {
    const s = inputEl.selectionStart, e = inputEl.selectionEnd, v = inputEl.value;
    inputEl.value = v.slice(0, s) + text + v.slice(e);
    inputEl.selectionStart = inputEl.selectionEnd = s + text.length;
    inputEl.focus();
    inputEl.dispatchEvent(new Event('input'));
  }
  function buildEmojiPicker() {
    if (emojiBuilt) return;
    emojiBuilt = true;
    const tabs = document.createElement('div'); tabs.id = 'emojiTabs';
    const grid = document.createElement('div'); grid.id = 'emojiGrid';
    emojiPicker.appendChild(tabs);
    emojiPicker.appendChild(grid);
    const showCat = (cat) => {
      grid.innerHTML = '';
      for (const em of cat.emojis.split(' ').filter(Boolean)) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = em;
        const tip = emojiTitle(em); // atajos :nombre asociados, si los hay
        if (tip) b.title = tip;
        b.addEventListener('click', () => insertAtCursor(em));
        grid.appendChild(b);
      }
      grid.scrollTop = 0;
    };
    EMOJI_CATS.forEach((cat, i) => {
      const t = document.createElement('button');
      t.type = 'button'; t.textContent = cat.icon;
      t.addEventListener('click', () => {
        [...tabs.children].forEach((c) => c.classList.remove('active'));
        t.classList.add('active');
        showCat(cat);
      });
      if (i === 0) t.classList.add('active');
      tabs.appendChild(t);
    });
    showCat(EMOJI_CATS[0]);
  }
  emojiBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    buildEmojiPicker();
    emojiPicker.classList.toggle('hidden');
  });
  document.addEventListener('click', (ev) => {
    if (!emojiPicker.classList.contains('hidden') && !emojiPicker.contains(ev.target) && ev.target !== emojiBtn && !emojiBtn.contains(ev.target)) {
      emojiPicker.classList.add('hidden');
    }
  });

  // ---- Autocompletado de emojis al escribir :nombre (estilo WhatsApp/Slack) ----
  const EMOJI_SHORTCODES = {
    smile: '😄', smiley: '😃', grin: '😁', laughing: '😆', joy: '😂', risa: '😂', rofl: '🤣',
    blush: '😊', innocent: '😇', wink: '😉', heart_eyes: '😍', enamorado: '😍', kiss: '😘', beso: '😘',
    yum: '😋', sunglasses: '😎', cool: '😎', star_struck: '🤩', party: '🥳', fiesta: '🥳',
    smirk: '😏', unamused: '😒', pensive: '😔', triste: '😔', confused: '😕', cry: '😢',
    sob: '😭', llorar: '😭', angry: '😠', enojado: '😠', rage: '😡', triumph: '😤',
    thinking: '🤔', pensando: '🤔', shush: '🤫', flushed: '😳', hot: '🥵', cold: '🥶', frio: '🥶',
    scream: '😱', fearful: '😨', sleepy: '😴', dormir: '😴', drool: '🤤', dizzy_face: '😵',
    sick: '🤢', vomit: '🤮', sneeze: '🤧', mask: '😷', money_mouth: '🤑', cowboy: '🤠',
    clown: '🤡', payaso: '🤡', poop: '💩', caca: '💩', ghost: '👻', fantasma: '👻', skull: '💀',
    calavera: '💀', alien: '👽', robot: '🤖', wave: '👋', hola: '👋', raised_hand: '✋', ok_hand: '👌',
    ok: '👌', v: '✌️', peace: '✌️', crossed_fingers: '🤞', rock: '🤘', call_me: '🤙',
    point_right: '👉', point_left: '👈', point_up: '☝️', point_down: '👇', thumbsup: '👍', like: '👍',
    thumbsdown: '👎', fist: '✊', punch: '👊', clap: '👏', aplauso: '👏', raised_hands: '🙌',
    pray: '🙏', rezar: '🙏', gracias: '🙏', handshake: '🤝', muscle: '💪', fuerza: '💪',
    selfie: '🤳', brain: '🧠', cerebro: '🧠', eyes: '👀', ojos: '👀', tongue: '👅', lips: '👄',
    heart: '❤️', corazon: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
    blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍', broken_heart: '💔',
    two_hearts: '💕', sparkling_heart: '💖', cupid: '💘', fire: '🔥', fuego: '🔥', sparkles: '✨',
    star: '⭐', estrella: '⭐', star2: '🌟', dizzy: '💫', zap: '⚡', rayo: '⚡', boom: '💥',
    hundred: '💯', cien: '💯', tada: '🎉', party_popper: '🎉', confetti: '🎊', balloon: '🎈',
    globo: '🎈', gift: '🎁', regalo: '🎁', check: '✅', x: '❌', warning: '⚠️', cuidado: '⚠️',
    question: '❓', pregunta: '❓', exclamation: '❗', bulb: '💡', idea: '💡', rocket: '🚀',
    cohete: '🚀', computer: '💻', laptop: '💻', phone: '📱', movil: '📱', email: '📧',
    calendar: '📅', clock: '⏰', reloj: '⏰', money: '💰', dinero: '💰', gem: '💎', diamante: '💎',
    tool: '🔧', wrench: '🔧', hammer: '🔨', gear: '⚙️', lock: '🔒', key: '🔑', llave: '🔑',
    dog: '🐶', perro: '🐶', cat: '🐱', gato: '🐱', fox: '🦊', zorro: '🦊', bear: '🐻', oso: '🐻',
    panda: '🐼', tiger: '🐯', lion: '🦁', leon: '🦁', pig: '🐷', cerdo: '🐷', frog: '🐸', rana: '🐸',
    monkey: '🐵', mono: '🐵', chicken: '🐔', penguin: '🐧', pinguino: '🐧', bee: '🐝', abeja: '🐝',
    bug: '🐛', butterfly: '🦋', mariposa: '🦋', turtle: '🐢', tortuga: '🐢', snake: '🐍',
    dragon: '🐉', octopus: '🐙', pulpo: '🐙', fish: '🐟', pez: '🐟', whale: '🐋', ballena: '🐋',
    shark: '🦈', tiburon: '🦈', unicorn: '🦄', unicornio: '🦄', horse: '🐴', caballo: '🐴',
    flower: '🌸', flor: '🌸', rose: '🌹', rosa: '🌹', sunflower: '🌻', tree: '🌳', arbol: '🌳',
    cactus: '🌵', clover: '🍀', trebol: '🍀', sun: '☀️', sol: '☀️', moon: '🌙', luna: '🌙',
    rainbow: '🌈', arcoiris: '🌈', snowflake: '❄️', nieve: '❄️', snowman: '⛄', wave_water: '🌊',
    ola: '🌊', apple: '🍎', manzana: '🍎', banana: '🍌', platano: '🍌', grapes: '🍇', uvas: '🍇',
    strawberry: '🍓', fresa: '🍓', watermelon: '🍉', sandia: '🍉', peach: '🍑', lemon: '🍋',
    limon: '🍋', avocado: '🥑', aguacate: '🥑', bread: '🍞', pan: '🍞', cheese: '🧀', queso: '🧀',
    egg: '🥚', huevo: '🥚', meat: '🍖', carne: '🍖', hotdog: '🌭', hamburger: '🍔', hamburguesa: '🍔',
    fries: '🍟', papas: '🍟', pizza: '🍕', taco: '🌮', burrito: '🌯', salad: '🥗', ensalada: '🥗',
    spaghetti: '🍝', pasta: '🍝', ramen: '🍜', sushi: '🍣', rice: '🍚', arroz: '🍚', cake: '🍰',
    pastel: '🍰', birthday: '🎂', cumple: '🎂', cookie: '🍪', galleta: '🍪', chocolate: '🍫',
    candy: '🍬', dulce: '🍬', lollipop: '🍭', icecream: '🍨', helado: '🍦', popcorn: '🍿',
    coffee: '☕', cafe: '☕', tea: '🍵', beer: '🍺', cerveza: '🍺', beers: '🍻', wine: '🍷',
    vino: '🍷', cocktail: '🍸', champagne: '🍾', cheers: '🥂', salud: '🥂', soccer: '⚽',
    futbol: '⚽', basketball: '🏀', football: '🏈', baseball: '⚾', tennis: '🎾', tenis: '🎾',
    game: '🎮', juego: '🎮', dice: '🎲', dado: '🎲', dart: '🎯', diana: '🎯', music: '🎵',
    musica: '🎵', guitar: '🎸', guitarra: '🎸', mic: '🎤', microfono: '🎤', headphones: '🎧',
    art: '🎨', arte: '🎨', movie: '🎬', pelicula: '🎬', camera: '📷', camara: '📷', car: '🚗',
    coche: '🚗', auto: '🚗', bus: '🚌', bike: '🚲', bici: '🚲', plane: '✈️', avion: '✈️',
    ship: '🚢', barco: '🚢', train: '🚆', tren: '🚆', house: '🏠', casa: '🏠', building: '🏢',
    hospital: '🏥', school: '🏫', escuela: '🏫', earth: '🌍', tierra: '🌍', world: '🌍',
  };
  const SHORTCODE_ENTRIES = Object.entries(EMOJI_SHORTCODES);
  // Mapa inverso emoji -> nombres (para tooltips en la rejilla).
  const EMOJI_TO_NAMES = {};
  for (const [name, em] of SHORTCODE_ENTRIES) (EMOJI_TO_NAMES[em] = EMOJI_TO_NAMES[em] || []).push(name);
  const emojiTitle = (em) => (EMOJI_TO_NAMES[em] ? EMOJI_TO_NAMES[em].slice(0, 4).map((n) => ':' + n).join('  ') : '');

  // Popup de autocompletado, compartido y posicionado sobre el textarea activo.
  const emojiSuggest = document.createElement('div');
  emojiSuggest.id = 'emojiSuggest';
  emojiSuggest.className = 'hidden';
  document.body.appendChild(emojiSuggest);
  let suggestItems = [];
  let suggestActive = 0;
  let suggestTa = null; // textarea en uso
  const suggestOpen = () => !emojiSuggest.classList.contains('hidden');

  function colonQuery(ta) {
    const pos = ta.selectionStart;
    const m = ta.value.slice(0, pos).match(/(?:^|\s):([a-z0-9_+\-]{1,})$/i);
    return m ? { q: m[1].toLowerCase(), start: pos - m[1].length - 1 } : null;
  }
  function hideSuggest() { emojiSuggest.classList.add('hidden'); suggestItems = []; }
  function renderSuggest() {
    emojiSuggest.innerHTML = '';
    suggestItems.forEach(([name, em], i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sug-row' + (i === suggestActive ? ' active' : '');
      row.innerHTML = '<span class="sug-em">' + em + '</span><span class="sug-name">:' + escapeHtml(name) + '</span>';
      row.addEventListener('mousedown', (e) => { e.preventDefault(); acceptSuggest(em); });
      emojiSuggest.appendChild(row);
    });
  }
  function positionSuggest(ta) {
    const r = ta.getBoundingClientRect();
    emojiSuggest.style.left = Math.round(r.left) + 'px';
    emojiSuggest.style.bottom = Math.round(window.innerHeight - r.top + 4) + 'px';
  }
  function updateSuggest(ta) {
    suggestTa = ta;
    const c = colonQuery(ta);
    if (!c || c.q.length < 1) { hideSuggest(); return; }
    const starts = [], incl = [], seen = new Set();
    for (const [name, em] of SHORTCODE_ENTRIES) {
      if (name.startsWith(c.q) && !seen.has(em)) { seen.add(em); starts.push([name, em]); }
    }
    for (const [name, em] of SHORTCODE_ENTRIES) {
      if (!name.startsWith(c.q) && name.includes(c.q) && !seen.has(em)) { seen.add(em); incl.push([name, em]); }
    }
    suggestItems = starts.concat(incl).slice(0, 8);
    if (!suggestItems.length) { hideSuggest(); return; }
    suggestActive = 0;
    renderSuggest();
    positionSuggest(ta);
    emojiSuggest.classList.remove('hidden');
  }
  function moveSuggest(d) {
    suggestActive = (suggestActive + d + suggestItems.length) % suggestItems.length;
    renderSuggest();
  }
  function acceptSuggest(em) {
    const ta = suggestTa;
    if (!ta) { hideSuggest(); return; }
    const c = colonQuery(ta);
    if (!c) { hideSuggest(); return; }
    const pos = ta.selectionStart, v = ta.value;
    ta.value = v.slice(0, c.start) + em + ' ' + v.slice(pos);
    ta.selectionStart = ta.selectionEnd = c.start + em.length + 1;
    hideSuggest();
    ta.focus();
    ta.dispatchEvent(new Event('input'));
  }
  // true si la tecla fue consumida por el popup (navegación/aceptar/cerrar).
  function handleSuggestKeydown(e) {
    if (!suggestOpen()) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSuggest(suggestItems[suggestActive][1]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return true; }
    return false;
  }
  // Conecta autocompletado a cualquier textarea.
  function setupEmojiAutocomplete(ta) {
    ta.addEventListener('input', () => updateSuggest(ta));
    ta.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  }
  setupEmojiAutocomplete(inputEl);

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  // Arrastrar y soltar archivos en cualquier parte del chat.
  const inputBox = $('inputBox');
  // Resaltado de drag con contador: dragenter/leave se disparan al cruzar elementos hijos,
  // así que un solo flag se queda pegado. El contador refleja si el puntero sigue dentro.
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; inputBox.classList.add('dragover'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; inputBox.classList.remove('dragover'); } });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    inputBox.classList.remove('dragover');
    const f = e.dataTransfer && e.dataTransfer.files;
    if (f && f.length) addFiles([...f]);
  });

  // ---- Zoom propio del chat (independiente del zoom global de VS Code) ----
  let zoom = LangZoom.clampZoom((vscode.getState() && vscode.getState().zoom) || 1);
  function applyZoom() {
    // Zoom SOLO al historial (que tiene su propio scroll), no a todo el body: zoomear el body
    // escalaba el layout 100vh y desbordaba/recortaba el composer (la barra de escribir).
    document.body.style.zoom = '';                // limpia un zoom previo en body (estado antiguo)
    if (messagesEl) messagesEl.style.zoom = String(zoom);
    const lbl = $('zoomResetBtn');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
    const s = vscode.getState() || {};
    s.zoom = zoom;
    vscode.setState(s);
  }
  function setZoom(z) { zoom = LangZoom.clampZoom(z); applyZoom(); }
  applyZoom();
  // Alt/Option + rueda → zoom (mismo modificador que el borrado en cascada; no choca con el +/- nativo de VS Code).
  window.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    zoom = LangZoom.stepZoom(zoom, e.deltaY);
    applyZoom();
  }, { passive: false });
  // Alt/Option + 0 → resetear.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === '0')) { e.preventDefault(); setZoom(1); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(); }
    if (e.key === 'Escape' && findBar && !findBar.classList.contains('hidden')) { e.preventDefault(); closeFind(); }
    // Ctrl/Cmd+Z (y redo): el .chat es un editor de texto, así que el undo del documento
    // revierte/borra mensajes sin querer. Lo bloqueamos SIEMPRE; dentro de un campo editable
    // mantenemos su propio undo con execCommand (no toca el documento).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      const editable = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
      if (editable) {
        const redo = (e.key === 'y' || e.key === 'Y') || e.shiftKey;
        try { document.execCommand(redo ? 'redo' : 'undo'); } catch (_) { /* sin undo nativo */ }
      }
    }
  });
  // Controles de la barra: −, %, + (el % reestablece a 100%).
  $('zoomInBtn').addEventListener('click', () => setZoom(LangZoom.stepZoom(zoom, -1)));
  $('zoomOutBtn').addEventListener('click', () => setZoom(LangZoom.stepZoom(zoom, 1)));
  $('zoomResetBtn').addEventListener('click', () => setZoom(1));
  providerSelect.addEventListener('change', () => {
    // Limpia el modelo de inmediato para no mostrar modelos del backend anterior.
    modelSelect.innerHTML = '<option>' + escapeHtml(t('Loading…')) + '</option>';
    patchConfig({ provider: providerSelect.value });
    renderConfig(); // re-filtra los parámetros según el nuevo backend
  });
  modelSelect.addEventListener('change', () => { updateModelCtx(); patchConfig({ model: modelSelect.value }); });
  $('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
  $('settingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
  $('configBtn').addEventListener('click', () => { configPanel.classList.toggle('hidden'); updateSide(); });
  $('configClose').addEventListener('click', () => { configPanel.classList.add('hidden'); updateSide(); });
  $('exportBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportHtml', title: (doc && doc.title) || 'Chat', html: buildExportHtml() });
  });
  $('thinkBtn').addEventListener('click', () => { thinkPanel.classList.toggle('hidden'); updateSide(); });
  $('thinkClose').addEventListener('click', () => { thinkPanel.classList.add('hidden'); updateSide(); });
  $('toolsBtn').addEventListener('click', () => { if (toolsPanel.classList.contains('hidden')) showTools(toolsLive); toolsPanel.classList.toggle('hidden'); updateSide(); });
  $('toolsClose').addEventListener('click', () => { toolsPanel.classList.add('hidden'); updateSide(); });

  // ---- Buscador dentro del chat (Ctrl/Cmd+F) ----
  const findBar = $('findBar');
  const findInput = $('findInput');
  const findCount = $('findCount');
  let findHits = [];   // <mark> resaltados, en orden de documento
  let findIdx = -1;    // índice del hit "actual"

  // Quita todos los <mark> y reconstruye los nodos de texto originales.
  function clearFindMarks() {
    const marks = messagesEl.querySelectorAll('mark.find-hit');
    marks.forEach((mk) => {
      const p = mk.parentNode;
      if (!p) return;
      p.replaceChild(document.createTextNode(mk.textContent), mk);
      p.normalize(); // fusiona nodos de texto adyacentes
    });
    findHits = [];
    findIdx = -1;
  }

  // Envuelve cada coincidencia de `ql` (minúsculas) dentro de un nodo de texto en <mark>.
  function highlightInNode(node, ql) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    if (!lower.includes(ql)) return;
    const frag = document.createDocumentFragment();
    let i = 0, idx;
    while ((idx = lower.indexOf(ql, i)) !== -1) {
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
      const mk = document.createElement('mark');
      mk.className = 'find-hit';
      mk.textContent = text.slice(idx, idx + ql.length);
      frag.appendChild(mk);
      i = idx + ql.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag, node);
  }

  function updateFindCount() {
    if (!findInput.value.trim()) { findCount.textContent = ''; return; }
    findCount.textContent = findHits.length ? (findIdx + 1) + '/' + findHits.length : '0/0';
  }

  function setCurrentHit(scroll) {
    findHits.forEach((h, k) => h.classList.toggle('current', k === findIdx));
    if (scroll && findIdx >= 0 && findHits[findIdx]) {
      findHits[findIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // Busca `query` en las burbujas. opts.keepPos preserva el hit actual y no hace scroll
  // (se usa al re-renderizar mientras la barra está abierta, p. ej. tras un mensaje nuevo).
  function runFind(query, opts) {
    opts = opts || {};
    const prevIdx = findIdx;
    clearFindMarks();
    const q = (query || '').trim();
    if (!q) { updateFindCount(); return; }
    const ql = q.toLowerCase();
    const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
        return node.nodeValue.toLowerCase().includes(ql) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const node of targets) highlightInNode(node, ql);
    findHits = Array.prototype.slice.call(messagesEl.querySelectorAll('mark.find-hit'));
    if (opts.keepPos) findIdx = findHits.length ? Math.min(Math.max(prevIdx, 0), findHits.length - 1) : -1;
    else findIdx = findHits.length ? 0 : -1;
    setCurrentHit(!opts.keepPos);
    updateFindCount();
  }

  function findNav(dir) {
    if (!findHits.length) return;
    findIdx = (findIdx + dir + findHits.length) % findHits.length;
    setCurrentHit(true);
    updateFindCount();
  }

  function openFind() {
    findBar.classList.remove('hidden');
    findInput.focus();
    findInput.select();
    if (findInput.value.trim()) runFind(findInput.value);
  }

  function closeFind() {
    findBar.classList.add('hidden');
    clearFindMarks();
    updateFindCount();
  }

  // Re-aplica el resaltado tras un re-render si la barra sigue abierta (el innerHTML se rehace).
  function refreshFind() {
    if (findBar && !findBar.classList.contains('hidden') && findInput.value.trim()) {
      runFind(findInput.value, { keepPos: true });
    }
  }

  findInput.addEventListener('input', () => runFind(findInput.value));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findNav(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('findPrev').addEventListener('click', () => findNav(-1));
  $('findNext').addEventListener('click', () => findNav(1));
  $('findClose').addEventListener('click', () => closeFind());

  // Aplica un idioma: traduce el HTML estático y re-renderiza lo dinámico.
  function applyLanguage(lang, pref) {
    window.LangI18n.set(lang);
    window.LangI18n.applyStatic(document);
    document.documentElement.lang = lang;
    if (doc) { renderConfig(); renderConversation(); updateUsage(); updateContextBar(); }
    updateModelCtx(); // refresca tooltips de capacidades/contexto + estado
  }

  // ---- Mensajes desde la extensión ----
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'lang':
        applyLanguage(msg.lang, msg.pref);
        break;
      case 'spellWords':
        if (window.LangSpell) window.LangSpell.setWords(msg.words || []);
        break;
      case 'piperVoices':
        // Voces Piper descargadas: el selector del chat solo ofrece estas (+ Custom).
        tts.downloadedVoices = new Set(msg.ids || []);
        if (doc && !configPanel.classList.contains('hidden')) renderConfig();
        break;
      case 'doc':
        doc = msg.doc;
        providerSelect.value = doc.provider;
        if (spellSelect) spellSelect.value = doc.spellLang || 'auto'; // idioma del corrector per-chat
        applySpellLang();
        renderConfig();
        renderConversation();
        updateContextBar();
        updateUsage();
        break;
      case 'status':
        renderStatus(msg.info, msg.state, msg.detail);
        break;
      case 'models':
        // Ignora respuestas de un backend que ya no es el activo.
        if (msg.provider && doc && msg.provider !== doc.provider) break;
        renderModels(msg.models, msg.current, msg.error);
        break;
      case 'streamStart':
        streamingText = '';
        thinkingText = '';
        streamingEl = addMessage('assistant', '', { cursor: true });
        setStreaming(true);
        break;
      case 'streamReasoning':
        thinkingText += msg.delta;
        openThink();
        pendingThink = true;
        queueStreamRender();
        break;
      case 'toolCall':
        toolsLive.push({ name: msg.name, args: msg.args });
        openTools();
        showTools(toolsLive);
        break;
      case 'toolResult':
        for (let k = toolsLive.length - 1; k >= 0; k--) {
          if (toolsLive[k].name === msg.name && toolsLive[k].result === undefined) { toolsLive[k].result = msg.content; break; }
        }
        showTools(toolsLive);
        break;
      case 'streamDelta':
        streamingText += msg.delta;
        pendingBody = true;
        queueStreamRender();
        break;
      case 'streamEnd':
        // Render final síncrono: garantiza que los últimos tokens (que pudieran no haber
        // alcanzado a pintarse en el último frame) queden reflejados.
        pendingBody = false;
        pendingThink = false;
        rafQueued = false;
        if (streamingEl) {
          const body = streamingEl.querySelector('.body');
          body.innerHTML = renderMarkdownImpl(streamingText);
          body.classList.remove('cursor');
          bindThinking(streamingEl, thinkingText);
          scrollDown();
        }
        streamingEl = null;
        setStreaming(false);
        break;
      case 'history':
        // Historial autoritativo tras enviar/borrar/fusionar: re-renderiza con índices y acciones.
        if (doc) doc.messages = msg.messages; // doc.usage no se usa: updateUsage() recalcula de los mensajes
        renderConversation();
        updateContextBar();
        updateUsage();
        break;
      case 'notice':
        notice(msg.message, false);
        break;
      case 'error':
        notice(msg.message, true);
        // Cierra el turno en streaming a medias: quita el cursor y suelta la referencia,
        // para que un delta tardío no escriba en la burbuja vieja.
        pendingBody = false;
        pendingThink = false;
        rafQueued = false; // cancela cualquier render coalescido pendiente
        if (streamingEl) {
          const b = streamingEl.querySelector('.body');
          if (streamingText) b.innerHTML = renderMarkdownImpl(streamingText);
          b.classList.remove('cursor');
          bindThinking(streamingEl, thinkingText); // conserva el badge de razonamiento parcial
          streamingEl = null;
        }
        setStreaming(false);
        break;
      case 'ttsAudio':
        ttsLog('recv ttsAudio', { id: msg.id, b64Len: (msg.data || '').length });
        tts.playWav(msg.data, msg.id);
        break;
      case 'ttsDone':
        ttsLog('recv ttsDone', { id: msg.id });
        break;
      case 'ttsError':
        ttsLog('recv ttsError', { id: msg.id, current: tts.reqId, message: msg.message });
        if (msg.id === undefined || msg.id === tts.reqId) { // ignora errores de peticiones obsoletas
          tts.stop();
          notice(msg.message, true);
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
