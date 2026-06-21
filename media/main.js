(function () {
  const vscode = acquireVsCodeApi();
  const t = (s) => window.LangI18n.t(s); // translation (English is the key)
  // TTS debug trace (visible in the webview console and forwarded to the backend).
  const ttsLog = (msg, data) => {
    try { console.log('[TTS]', msg, data !== undefined ? data : ''); } catch (e) {}
    try { vscode.postMessage({ type: 'ttsLog', message: msg, data: data === undefined ? null : data }); } catch (e) {}
  };

  let doc = null; // current ChatDoc
  let streamingEl = null;
  // Two-step message delete: the trash button currently "armed" (red), awaiting a confirming click.
  let armedDelBtn = null;
  function disarmDelete() { if (armedDelBtn) { armedDelBtn.classList.remove('armed'); armedDelBtn = null; } }
  // Any click outside the armed trash, or pressing Escape, cancels the pending delete.
  document.addEventListener('click', (e) => { if (armedDelBtn && !armedDelBtn.contains(e.target)) disarmDelete(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarmDelete(); });

  // ---- Floating tooltip for any [data-tip] element (native `title` doesn't render reliably in webviews) ----
  const tipEl = document.createElement('div');
  tipEl.id = 'tip';
  tipEl.className = 'hidden';
  document.body.appendChild(tipEl);
  let tipTarget = null;
  function showTip(el) {
    const text = el.getAttribute('data-tip');
    if (!text) { hideTip(); return; }
    tipTarget = el;
    tipEl.textContent = text;
    tipEl.style.visibility = 'hidden';
    tipEl.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 4) top = r.top - th - 6; // flip above if no room below
    let left = Math.max(4, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 4));
    tipEl.style.top = Math.round(top) + 'px';
    tipEl.style.left = Math.round(left) + 'px';
    tipEl.style.visibility = 'visible';
  }
  function hideTip() { tipEl.classList.add('hidden'); tipTarget = null; }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el && el !== tipTarget) showTip(el);
  });
  document.addEventListener('mouseout', (e) => {
    if (!tipTarget) return;
    const el = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (el === tipTarget && !(e.relatedTarget && tipTarget.contains(e.relatedTarget))) hideTip();
  });
  document.addEventListener('scroll', hideTip, true); // never let it stick while scrolling
  window.addEventListener('blur', hideTip);
  let streamingText = '';
  let thinkingText = ''; // reasoning for the current turn

  // Coalesced streaming render with requestAnimationFrame: instead of re-parsing all
  // markdown on EVERY token (O(n²) + reflow), renders at most once per frame.
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
  let toolsLive = []; // tool activity for the current turn
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
  let modelContext = {}; // model id -> context tokens
  let modelCaps = {}; // model id -> capabilities

  let pending = []; // pending attachments to send: {kind,name,mime,data}

  // Configuration panel schema. `only` restricts a parameter to certain backends.
  const SCHEMA = [
    { group: 'General', items: [
      { key: 'temperature', label: 'Temperature', kind: 'slider', min: 0, max: 2, step: 0.01, toggle: false },
      { key: 'maxTokens', label: 'Limit response length', kind: 'int', min: 1, max: 131072, step: 1, toggle: true },
      { key: 'contextMessages', label: 'History to send: last N messages', kind: 'int', min: 1, max: 500, step: 1, toggle: true },
      { key: 'autoSummary', label: 'Auto-summarize when context fills up', kind: 'bool' },
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

  // ---- Message rendering ----
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Inline formatting: escapes HTML and applies code, links, bold, italic, strikethrough.
  // Inline LaTeX → Unicode (models emit $\rightarrow$, \alpha, etc. in reasoning).
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
    // Remove $…$ delimiters ONLY when they wrap a \command (does not touch currency like $5).
    t = t.replace(/\$\$?([^$\n]*?\\[a-zA-Z][^$\n]*?)\$\$?/g, '$1');
    t = t.replace(/\\\\/g, ' ');                  // LaTeX line break
    t = t.replace(/\\[()[\]]/g, ' ');             // \( \) \[ \]
    t = t.replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, ''); // delimiter size commands
    t = t.replace(/\\[,;:! ]/g, ' ');             // thin spacing
    t = t.replace(/\\([a-zA-Z]+)/g, (m, c) => (LATEX[c] !== undefined ? LATEX[c] : m)); // known symbols
    return t;
  }

  function inlineMd(text) {
    let t = escapeHtml(text);
    const codes = [];
    t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    t = deLatex(t); // Inline LaTeX → Unicode (code-spans are already protected above)
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      // Scheme allowlist: blocks javascript:/data:/vbscript:… (defense-in-depth on top of CSP).
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
      const href = scheme && !/^(https?|mailto)$/i.test(scheme[1]) ? '#' : url; // url is already escaped
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

  // Block-level Markdown renderer (headings, lists, blockquotes, tables, code…).
  // renderMarkdown is memoized: it is a pure function, and renderConversation re-renders all
  // messages (almost all identical) on every change. Streaming uses renderMarkdownImpl (raw).
  const mdCache = new Map();
  const MD_CACHE_MAX = 400;
  function renderMarkdown(src) {
    const key = String(src);
    const hit = mdCache.get(key);
    if (hit !== undefined) { mdCache.delete(key); mdCache.set(key, hit); return hit; } // refresh LRU
    const html = renderMarkdownImpl(key);
    mdCache.set(key, html);
    if (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value); // evict oldest
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

      // Code block ```
      if (/^```/.test(line)) {
        const lang = line.replace(/^`+/, '').trim().toLowerCase();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        const code = buf.join('\n');
        // Mermaid: emit a pending placeholder that LOOKS like a code block (so a half-written
        // diagram reads sensibly mid-stream), upgraded to an SVG by processMermaid() once settled.
        if (lang === 'mermaid') {
          out.push('<div class="mermaid-diagram" data-mermaid-pending="1"><pre class="mermaid-pre"><code class="mermaid-src">' + escapeHtml(code) + '</code></pre></div>');
        } else {
          out.push('<pre><code>' + escapeHtml(code) + '</code></pre>');
        }
        continue;
      }
      // Blank line
      if (/^\s*$/.test(line)) { i++; continue; }
      // Heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
      // Horizontal rule
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
      // Table: header with | and separator line |---|
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
      // Blockquote
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + renderMarkdownImpl(buf.join('\n')) + '</blockquote>');
        continue;
      }
      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(inlineMd(lines[i].replace(/^\s*[-*+]\s+/, ''))); i++; }
        out.push('<ul>' + items.map((t) => `<li>${t}</li>`).join('') + '</ul>');
        continue;
      }
      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(inlineMd(lines[i].replace(/^\s*\d+\.\s+/, ''))); i++; }
        out.push('<ol>' + items.map((t) => `<li>${t}</li>`).join('') + '</ol>');
        continue;
      }
      // Paragraph
      const para = [];
      while (i < lines.length && !isSpecial(lines[i])) { para.push(lines[i]); i++; }
      out.push('<p>' + inlineMd(para.join('\n')).replace(/\n/g, '<br/>') + '</p>');
    }
    return out.join('');
  }

  // ── Mermaid diagrams ───────────────────────────────────────────────────────
  // The library (~3MB) is loaded lazily the first time a chat actually contains a
  // ```mermaid block, so webviews without diagrams pay nothing.
  let _mermaidPromise = null;
  let _mermaidSeq = 0;
  function ensureMermaid() {
    if (_mermaidPromise) return _mermaidPromise;
    _mermaidPromise = new Promise((resolve) => {
      const init = () => {
        try {
          // VS Code adds vscode-light / vscode-dark / vscode-high-contrast to <body>.
          const theme = document.body.classList.contains('vscode-light') ? 'default' : 'dark';
          window.mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict', // sanitizes input; no script/click execution from diagrams
            theme,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
          });
          resolve(window.mermaid);
        } catch (e) { resolve(null); }
      };
      if (window.mermaid) { init(); return; }
      const src = window.MERMAID_SRC;
      if (!src) { resolve(null); return; }
      const s = document.createElement('script');
      s.src = src;
      if (window.PARLEY_NONCE) s.setAttribute('nonce', window.PARLEY_NONCE); // pass the CSP
      s.onload = init;
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return _mermaidPromise;
  }

  // Upgrade any pending ```mermaid placeholders inside `root` into rendered SVG. Called only at
  // settled points (final message render / streamEnd), never per streaming frame.
  async function processMermaid(root) {
    if (!root) return;
    const blocks = root.querySelectorAll('.mermaid-diagram[data-mermaid-pending]');
    if (!blocks.length) return;
    const mermaid = await ensureMermaid();
    for (const el of blocks) {
      el.removeAttribute('data-mermaid-pending'); // claim it: never re-process the same node
      const srcEl = el.querySelector('.mermaid-src');
      const code = (srcEl ? srcEl.textContent : el.textContent) || '';
      if (!mermaid) { el.classList.add('error'); continue; } // load failed → leave the code block
      try {
        const { svg } = await mermaid.render('mmd-' + (_mermaidSeq++), code);
        mountMermaid(el, svg);
      } catch (e) {
        // Keep the source visible and append a discreet error note.
        el.classList.add('error');
        const note = document.createElement('div');
        note.className = 'mermaid-error';
        note.textContent = t('Could not render this Mermaid diagram') + ': ' + ((e && e.message) || e);
        el.appendChild(note);
      }
    }
  }

  // GitHub-style controls: a directional pad (pan arrows) with a centre recenter button and a
  // zoom +/− column bottom-right, plus fit + fullscreen top-right. Stroke icons, monochrome.
  const MM_SVG = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  const MM_ICON = {
    up: MM_SVG('<polyline points="6 15 12 9 18 15"/>'),
    down: MM_SVG('<polyline points="6 9 12 15 18 9"/>'),
    left: MM_SVG('<polyline points="15 18 9 12 15 6"/>'),
    right: MM_SVG('<polyline points="9 18 15 12 9 6"/>'),
    zoomIn: MM_SVG('<circle cx="11" cy="11" r="7"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'),
    zoomOut: MM_SVG('<circle cx="11" cy="11" r="7"/><line x1="8" y1="11" x2="14" y2="11"/>'),
    recenter: MM_SVG('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
    full: MM_SVG('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    copy: MM_SVG('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    check: MM_SVG('<polyline points="20 6 9 17 4 12"/>'),
    close: MM_SVG('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  };
  function mmBtn(icon, title, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mermaid-btn';
    b.innerHTML = icon;
    b.title = title;
    b.dataset.tip = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }
  // 3×3 directional pad: ·/up/zoom-in · left/recenter/right · ·/down/zoom-out (empties keep the cross).
  function mmPad(pz) {
    const pad = document.createElement('div');
    pad.className = 'mermaid-tools mermaid-pad';
    const STEP = 80;
    const gap = () => { const s = document.createElement('span'); s.className = 'mermaid-pad-gap'; return s; };
    pad.appendChild(gap());
    pad.appendChild(mmBtn(MM_ICON.up, t('Pan up'), () => pz.panBy(0, STEP)));
    pad.appendChild(mmBtn(MM_ICON.zoomIn, t('Zoom in'), pz.zoomIn));
    pad.appendChild(mmBtn(MM_ICON.left, t('Pan left'), () => pz.panBy(STEP, 0)));
    pad.appendChild(mmBtn(MM_ICON.recenter, t('Reset / centre'), pz.fit));
    pad.appendChild(mmBtn(MM_ICON.right, t('Pan right'), () => pz.panBy(-STEP, 0)));
    pad.appendChild(gap());
    pad.appendChild(mmBtn(MM_ICON.down, t('Pan down'), () => pz.panBy(0, -STEP)));
    pad.appendChild(mmBtn(MM_ICON.zoomOut, t('Zoom out'), pz.zoomOut));
    return pad;
  }

  function mountMermaid(el, svg) {
    el.classList.add('rendered');
    el.innerHTML = '';
    const viewport = document.createElement('div');
    viewport.className = 'mermaid-viewport';
    const canvas = document.createElement('div');
    canvas.className = 'mermaid-canvas';
    canvas.innerHTML = svg;
    viewport.appendChild(canvas);
    const pz = makePanZoom(viewport, canvas);
    const top = document.createElement('div');
    top.className = 'mermaid-tools mermaid-tools-top';
    top.appendChild(mmBtn(MM_ICON.full, t('Fullscreen'), () => openMermaidFullscreen(svg)));
    const copyBtn = mmBtn(MM_ICON.copy, t('Copy as image'), () => copyMermaidImage(svg, copyBtn));
    top.appendChild(copyBtn);
    el.appendChild(top);
    el.appendChild(mmPad(pz));
    el.appendChild(viewport);
  }

  // Rasterize the diagram's SVG to a PNG and put it on the clipboard (like GitHub's "copy").
  function copyMermaidImage(svg, btn) {
    svgToPngBlob(svg).then((blob) => {
      if (!blob || !navigator.clipboard || !window.ClipboardItem) return;
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => {
        const prev = btn.innerHTML;
        btn.innerHTML = MM_ICON.check; // brief ✓ confirmation
        setTimeout(() => { btn.innerHTML = prev; }, 1200);
      });
    }).catch(() => {});
  }
  function svgToPngBlob(svg) {
    return new Promise((resolve, reject) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = svg;
      const el = wrap.querySelector('svg');
      if (!el) { resolve(null); return; }
      let w = 0, h = 0;
      const vb = el.getAttribute('viewBox');
      if (vb) { const p = vb.split(/[\s,]+/).map(Number); w = p[2]; h = p[3]; }
      if (!w || !h) { w = parseFloat(el.getAttribute('width')) || 800; h = parseFloat(el.getAttribute('height')) || 600; }
      el.setAttribute('width', w); el.setAttribute('height', h); el.style.maxWidth = 'none';
      const xml = new XMLSerializer().serializeToString(el);
      const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
      const img = new Image();
      img.onload = () => {
        const SCALE = 2; // crisp on HiDPI
        const cv = document.createElement('canvas');
        cv.width = Math.ceil(w * SCALE); cv.height = Math.ceil(h * SCALE);
        const ctx = cv.getContext('2d');
        // Match the on-screen background so dark-theme (light-text) diagrams stay legible.
        let bg = getComputedStyle(document.body).backgroundColor;
        if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') bg = '#1e1e1e';
        ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob((b) => resolve(b), 'image/png');
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // Pan/zoom controller over `canvas` (CSS transform) inside the clipped `viewport`.
  // opts.wheelZoomAlways: zoom on any wheel (fullscreen). Default: only pinch / Ctrl/⌘+wheel, so a
  // plain two-finger trackpad scroll keeps scrolling the chat history instead of zooming.
  function makePanZoom(viewport, canvas, opts) {
    let scale = 1, tx = 0, ty = 0;
    const MIN = 0.2, MAX = 8;
    const clamp = (v) => Math.min(MAX, Math.max(MIN, v));
    const apply = () => { canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
    function zoomAt(cx, cy, factor) {
      const ns = clamp(scale * factor);
      const k = ns / scale;
      tx = cx - (cx - tx) * k; // keep the point under the cursor fixed
      ty = cy - (cy - ty) * k;
      scale = ns;
      apply();
    }
    const zoomCenter = (factor) => {
      const r = viewport.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, factor);
    };
    viewport.addEventListener('wheel', (e) => {
      // Plain wheel (incl. Mac two-finger scroll) must scroll the chat, not zoom: only intercept
      // for pinch / Ctrl/⌘+wheel (macOS sends ctrlKey for the pinch gesture).
      const wantZoom = (opts && opts.wheelZoomAlways) || e.ctrlKey || e.metaKey;
      if (!wantZoom) return; // let it bubble → the history scrolls
      e.preventDefault(); e.stopPropagation();
      const r = viewport.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    let dragging = false, sx = 0, sy = 0;
    viewport.addEventListener('pointerdown', (e) => {
      dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
      try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
      viewport.classList.add('grabbing');
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      tx = e.clientX - sx; ty = e.clientY - sy; apply();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false; viewport.classList.remove('grabbing');
      try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dblclick', (e) => { e.preventDefault(); fit(); });
    // Fit: scale the diagram to fit inside the viewport (never upscaling past full width) and centre
    // it. Inline, the viewport already hugs the diagram so this just centres; in the big fullscreen
    // viewport it scales the whole diagram down to fit — so opening fullscreen shows it all, centred.
    function fit() {
      const cw = canvas.offsetWidth, ch = canvas.offsetHeight; // untransformed layout size
      const vw = viewport.clientWidth, vh = viewport.clientHeight;
      if (!cw || !ch) return;
      scale = clamp(Math.min(1, vw / cw, vh / ch));
      tx = (vw - cw * scale) / 2;
      ty = (vh - ch * scale) / 2;
      apply();
    }
    const panBy = (dx, dy) => { tx += dx; ty += dy; apply(); };
    apply(); // initial inline view: top-left, full width
    return { zoomIn: () => zoomCenter(1.25), zoomOut: () => zoomCenter(1 / 1.25), fit, panBy };
  }

  // Fullscreen lightbox with its own pan/zoom. Esc or click-outside closes it.
  function openMermaidFullscreen(svg) {
    const overlay = document.createElement('div');
    overlay.className = 'mermaid-modal';
    const inner = document.createElement('div');
    inner.className = 'mermaid-modal-inner';
    const viewport = document.createElement('div');
    viewport.className = 'mermaid-viewport';
    const canvas = document.createElement('div');
    canvas.className = 'mermaid-canvas';
    canvas.innerHTML = svg;
    viewport.appendChild(canvas);
    const pz = makePanZoom(viewport, canvas, { wheelZoomAlways: true }); // no history behind it
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const top = document.createElement('div');
    top.className = 'mermaid-tools mermaid-tools-top';
    const copyBtn = mmBtn(MM_ICON.copy, t('Copy as image'), () => copyMermaidImage(svg, copyBtn));
    top.appendChild(copyBtn);
    top.appendChild(mmBtn(MM_ICON.close, t('Close'), close));
    inner.appendChild(top);
    inner.appendChild(mmPad(pz));
    inner.appendChild(viewport);
    overlay.appendChild(inner);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => pz.fit()); // once laid out: fit the whole diagram, centred
  }

  // Monochrome SVG icons (inherit currentColor → good contrast on any background).
  const SVG = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  const ICONS = {
    edit: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    retry: SVG('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
    forward: SVG('<polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/>'),
    mergeUp: SVG('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
    branch: SVG('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
    copy: SVG('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    check: SVG('<polyline points="20 6 9 17 4 12"/>'),
    download: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    trash: SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>'),
    eye: SVG('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    tool: SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
    spark: SVG('<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/>'),
    file: SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
    audio: SVG('<path d="M3 10v4h4l5 5V5L7 10z"/><path d="M16 8a4 4 0 0 1 0 8"/>'),
    speaker: SVG('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>'),
    stopsq: SVG('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
    summarize: SVG('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  };
  function iconButton(svg, title, onClick) {
    const b = document.createElement('button');
    b.className = 'icon-act';
    // Custom tooltip (data-tip → CSS) instead of the slow/unreliable native `title`; aria-label for a11y.
    b.dataset.tip = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // Copies an image attachment to the system clipboard. base64 → Blob directly (no fetch: the CSP
  // blocks data: URLs). Returns false if the browser/Electron clipboard can't take an image.
  async function copyImageToClipboard(a) {
    if (!navigator.clipboard || !window.ClipboardItem || !a || !a.data) return false;
    const bin = atob(a.data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: a.mime || 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  }

  // ---- Read aloud (Web Speech API; local, uncensored) ----
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

  const tts = {
    supported: 'speechSynthesis' in window,
    voices: [],
    piperVoices: PIPER_VOICES,
    // Set of downloaded voice ids: injected into the HTML (window.DOWNLOADED_VOICES) so it is
    // ready from the first render; the 'piperVoices' message updates it live.
    downloadedVoices: new Set(Array.isArray(window.DOWNLOADED_VOICES) ? window.DOWNLOADED_VOICES : []),
    customSet: !!window.PIPER_CUSTOM_SET, // is there a custom .onnx path configured in Settings?
    // Preferences persisted in the webview state.
    prefs: Object.assign({ engine: 'system', voiceURI: '', rate: 1, piperVoice: 'es_MX-claude-high' }, (vscode.getState() && vscode.getState().tts) || {}),
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
      if (this.source) { try { this.source.onended = null; this.source.stop(); } catch (e) {} this.source = null; }
      this.msgId = null;
      if (wasPiper) vscode.postMessage({ type: 'ttsStop' }); // aborts any pending synthesis in the backend
      this.resetBtn();
    },
    resetBtn() {
      if (this.speakingBtn) { this.speakingBtn.innerHTML = ICONS.speaker; this.speakingBtn = null; }
    },
    speak(text, btn, msgId) {
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
        const voice = this.prefs.piperVoice && this.prefs.piperVoice !== 'custom' ? this.prefs.piperVoice : '';
        ttsLog('speak→piper', { reqId: this.reqId, voice, rate: this.prefs.rate || 1, chars: plain.length, ctxState: ctx && ctx.state });
        vscode.postMessage({ type: 'tts', text: plain, rate: this.prefs.rate || 1, voice, id: this.reqId });
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
  tts.loadVoices();
  // Release the AudioContext when the webview is unloaded (avoids dangling contexts).
  window.addEventListener('pagehide', () => { if (tts.ctx) { try { tts.ctx.close(); } catch (e) {} } });
  if (tts.supported) {
    const refreshVoicesUI = () => {
      // If the config panel is open, refresh the voice selector.
      if (doc && !configPanel.classList.contains('hidden')) renderConfig();
    };
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

  function addMessage(role, content, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'msg ' + role + (opts.preSummary ? ' pre-summary' : '') + (opts.dropped ? ' dropped' : '');
    if (Number.isInteger(opts.index)) el.dataset.msgIndex = opts.index; // lets find/replace map a hit → message

    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    const name = document.createElement('span');
    name.textContent = role === 'user' ? t('You') : t('Assistant');
    roleEl.appendChild(name);
    if (opts.preSummary) {
      const mark = document.createElement('span');
      mark.className = 'pre-summary-mark';
      mark.textContent = '🗜️';
      mark.title = t('This message is compacted into the context summary.');
      roleEl.appendChild(mark);
    }
    if (opts.dropped) {
      const mark = document.createElement('span');
      mark.className = 'pre-summary-mark';
      mark.textContent = '✂️';
      mark.title = t('This message is outside the «last N» window — not sent.');
      roleEl.appendChild(mark);
    }

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

    // Variant navigator (‹ i/n › 🗑) shown when there is more than one variant.
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

    // Per-message actions (only for persisted messages with a known index).
    if (Number.isInteger(opts.index)) {
      const actions = document.createElement('span');
      actions.className = 'msg-actions';
      const imgAtt = (opts.attachments || []).find((a) => a.kind === 'image');
      const copyBtn = iconButton(ICONS.copy, imgAtt ? t('Copy image') : t('Copy'), async () => {
        // Image responses (nano-banana): copy the image to the clipboard; otherwise copy the text.
        let ok = false;
        if (imgAtt) ok = await copyImageToClipboard(imgAtt).catch(() => false);
        if (!ok) vscode.postMessage({ type: 'copy', text: content });
        copyBtn.innerHTML = ICONS.check;
        setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 1200);
      });
      actions.appendChild(copyBtn);
      if (imgAtt) {
        // Save the generated image to disk (native save dialog handled by the extension host).
        actions.appendChild(iconButton(ICONS.download, t('Save image'),
          () => vscode.postMessage({ type: 'saveImage', index: opts.index })));
      }
      const readBtn = iconButton(ICONS.speaker, t('Read aloud'), () => tts.speak(content, readBtn, opts.id));
      actions.appendChild(readBtn);
      actions.appendChild(iconButton(ICONS.edit, t('Edit message'), () => startEditInline(el, opts.index)));
      if (opts.canRegenerate) {
        // Regenerate lives on the USER bubble ("regenerate the response to this message"): it re-rolls
        // the answer to a prompt, so it belongs with the prompt — not duplicated here. Continue stays.
        actions.appendChild(iconButton(ICONS.forward, t('Continue / keep developing this response'),
          () => { clearNotices(); vscode.postMessage({ type: 'continue' }); }));
      }
      if (opts.canGenerate) {
        // Regenerates the response to this prompt: truncates anything dangling after it (partial tool-calls, etc.) and re-infers.
        actions.appendChild(iconButton(ICONS.retry, t('Generate a response to this message'),
          () => { clearNotices(); vscode.postMessage({ type: 'regenerateFrom', index: opts.index }); }));
      }
      if (opts.canRegenFromPrompt) {
        // Re-rolls the response to this prompt (assistant variant) without deleting anything.
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
      // Summarize the context up to here (same limit as the "up to here" fork). Only with auto-summary.
      if (doc && doc.params && doc.params.autoSummary && !opts.preSummary && opts.index > 0) {
        actions.appendChild(iconButton(ICONS.summarize, t('Summarize the conversation up to here'),
          () => { clearNotices(); vscode.postMessage({ type: 'summarizeUpTo', index: opts.index }); }));
      }
      actions.appendChild(iconButton(ICONS.branch,
        t('Fork: clone the conversation up to here into a new .chat') + ` · ${t('⌥/Alt: fork from here to the end')}`,
        (e) => vscode.postMessage({ type: 'fork', index: opts.index, fromHere: !!(e && e.altKey) })));
      const hasVariants = opts.variantCount > 1;
      const delTitle = (hasVariants
        ? `${t('Delete this variant')} (${(opts.variantActive || 0) + 1}/${opts.variantCount})`
        : t('Delete message'))
        + `\n${t('Click again to confirm')}`
        + `\n${t('⌥/Alt: delete this and all below')}`
        + `\n${t('⇧/Shift: skip confirmation')}`;
      // Two-step delete: 1st click arms (turns red), 2nd click on the armed trash confirms. Any other
      // event (click elsewhere, re-render from inference/history) disarms it. Shift = delete now.
      const trashBtn = iconButton(ICONS.trash, delTitle, (e) => {
        e.stopPropagation(); // keep trash clicks from reaching the document-level disarm handler
        const performDelete = () => {
          disarmDelete();
          if (e.altKey && Number.isInteger(opts.index)) {
            vscode.postMessage({ type: 'deleteFrom', index: opts.index, confirm: false }); // this + all below
          } else if (hasVariants) {
            vscode.postMessage({ type: 'deleteVariant', index: opts.index, variant: opts.variantActive || 0, confirm: false });
          } else {
            vscode.postMessage({ type: 'deleteMessage', index: opts.index, confirm: false });
          }
        };
        if (e.shiftKey) { performDelete(); return; }              // Shift = delete immediately (as before)
        if (armedDelBtn === trashBtn) { performDelete(); return; } // 2nd click on the red trash = confirm
        disarmDelete();                                            // arm this one (only one at a time)
        armedDelBtn = trashBtn;
        trashBtn.classList.add('armed');
      });
      actions.appendChild(trashBtn);
      roleEl.appendChild(actions);
    }

    el.appendChild(roleEl);
    const body = document.createElement('div');
    body.className = 'body';
    const hasImage = Array.isArray(opts.attachments) && opts.attachments.some((a) => a.kind === 'image');
    if (role === 'assistant' && !opts.cursor && !(content && content.trim()) && !hasImage) {
      // Empty response (some models put everything into reasoning): clear note instead of a blank bubble.
      // Skipped when the response is an image (nano-banana): the image below IS the content.
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
          img.title = t('Click to enlarge');
          img.addEventListener('click', () => img.classList.toggle('zoomed'));
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
    processMermaid(body); // upgrade any ```mermaid blocks to SVG (no-op if there are none)
    scrollDown();
    return el;
  }

  function bindThinking(el, text) {
    el._thinking = text || '';
    el.classList.toggle('has-think', !!text);
  }

  // Inline editing of a message's content.
  function startEditInline(el, index) {
    if (el.querySelector('.edit-wrap')) return; // already editing
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
    ta.lang = window.LangI18n.get();
    ta.value = m.content;
    const bar = document.createElement('div');
    bar.className = 'edit-bar';
    const cancel = document.createElement('button');
    cancel.textContent = t('Cancel');
    cancel.className = 'btn-secondary';
    const save = document.createElement('button');
    save.textContent = t('Save');
    save.className = 'btn-primary';
    bar.appendChild(cancel); // left
    bar.appendChild(save);   // right
    wrap.appendChild(ta);
    wrap.appendChild(bar);
    body.after(wrap);

    const commit = () => vscode.postMessage({ type: 'editMessage', index, content: ta.value });
    const close = () => { body.style.display = ''; wrap.remove(); el.classList.remove('editing'); };
    save.addEventListener('click', commit);
    cancel.addEventListener('click', close);
    ta.addEventListener('keydown', (e) => {
      if (handleFileKeydown(e)) return;
      if (handleSuggestKeydown(e)) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    setupEmojiAutocomplete(ta); // :name autocomplete also works when editing

    // Aligns the bottom edge of the editing bubble to the end of the visible area.
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

  // ---- Side panels ----
  function updateSide() {
    const open = !configPanel.classList.contains('hidden')
      || !thinkPanel.classList.contains('hidden')
      || !toolsPanel.classList.contains('hidden');
    sidepanels.classList.toggle('hidden', !open);
  }
  function openThink() { thinkPanel.classList.remove('hidden'); updateSide(); }
  function openTools() { toolsPanel.classList.remove('hidden'); updateSide(); }

  // Renders a list of tool activity in the panel.
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
      thinkContent.innerHTML = renderMarkdownImpl(text); // called per-frame during reasoning: no cache
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

  let suppressScroll = false; // prevents auto-scroll during a bulk re-render
  let stickToBottom = true;   // follow the bottom while text arrives; disabled when the user scrolls up
  function scrollDown() {
    if (suppressScroll || !stickToBottom) return; // if the user scrolled up, don't drag them to the bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  // The user is in control. A wheel/trackpad scroll-up detaches IMMEDIATELY and synchronously — this
  // beats the per-token auto-scroll, so an arriving character can't yank you back down. (The old code
  // only recomputed on the 'scroll' event with an 80px band, which lost this race → the "tug of war".)
  messagesEl.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) stickToBottom = false; // scrolling up to read → stop following the stream
  }, { passive: true });
  // Re-attach only once scrolled (back) to the very bottom. The tiny threshold means any scroll-up
  // stays detached instead of fighting inside a dead-zone band.
  messagesEl.addEventListener('scroll', () => {
    stickToBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 4;
  });

  // Persistent notices (errors, summaries): NOT cleared when the history is re-rendered.
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
    if (!isError) setTimeout(() => el.remove(), 6000); // informational notices auto-dismiss
    return el;
  }
  function clearNotices() { noticesEl.innerHTML = ''; toolsLive = []; summarizingEl = null; }

  // Persistent "summarizing…" indicator (with spinner); lasts the whole operation, no auto-dismiss.
  let summarizingEl = null;
  function showSummarizing(text) {
    if (summarizingEl && summarizingEl.isConnected) return;
    const el = document.createElement('div');
    el.className = 'banner summarizing';
    const spin = document.createElement('span');
    spin.className = 'banner-spin';
    const span = document.createElement('span');
    span.className = 'banner-text';
    span.textContent = text || ('🗜️ ' + t('Context summarized up to here'));
    el.appendChild(spin);
    el.appendChild(span);
    noticesEl.appendChild(el);
    summarizingEl = el;
  }
  function hideSummarizing() { if (summarizingEl) { summarizingEl.remove(); summarizingEl = null; } }

  let summaryOpen = false; // is the summary bubble expanded?
  function renderConversation() {
    disarmDelete(); // the trash buttons are about to be recreated → cancel any pending two-step delete
    // If a message that no longer exists (was deleted) is being read, stop the audio.
    if (tts.busy() && tts.msgId && doc && !(doc.messages || []).some((m) => m.id === tts.msgId)) {
      tts.stop();
    }
    // Preserve the user's scroll position (unless they were at the bottom).
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
    const prevTop = messagesEl.scrollTop;
    messagesEl.innerHTML = '';
    if (!doc) return;
    suppressScroll = true;
    const visible = doc.messages.filter((m) => m.role !== 'system');
    if (visible.length === 0) {
      banner(t('Empty chat. Type below to start.') + '  ·  ' + t('Model:') + ' ' + (doc.model || '—'));
    }
    // Hidden messages (intermediate assistant with tool_calls, and 'tool' messages) do not count
    // as "last": the last displayable one is the one that receives the regenerate/generate buttons.
    const displayable = (mm) => !((mm.role === 'assistant' && Array.isArray(mm.toolCalls) && mm.toolCalls.length) || mm.role === 'tool');
    let lastDisplayable = -1;
    for (let k = visible.length - 1; k >= 0; k--) { if (displayable(visible[k])) { lastDisplayable = k; break; } }
    let lastThinking = '';
    let pendingTools = []; // tool activity accumulated up to the final message of the turn
    // Summary: messages [0..upTo) are compacted (not resent). We mark the boundary with a
    // divider (bubble = summary text) and dim the preceding messages.
    const upTo = doc.summary ? doc.summary.upTo : 0;
    const summaryText = doc.summary ? doc.summary.text : '';
    let summaryShown = false;
    // "Last N messages": if active, WINS over the summary (the old summary is not sent).
    const cmP = (doc.params && doc.params.contextMessages) || {};
    const lastN = (cmP.enabled && cmP.value > 0) ? cmP.value : 0; // 0 = inactive
    const cut = lastN ? lastNStart(visible, lastN) : 0;   // effective start (nearest cut wins)
    let lastNShown = false;
    // Inline editor for the summary (same pattern as startEditInline but saves to doc.summary).
    const startEditSummary = (el) => {
      if (el.querySelector('.edit-wrap')) return;
      el.classList.add('editing');
      const body = el.querySelector('.body');
      body.style.display = 'none';
      const wrap = document.createElement('div');
      wrap.className = 'edit-wrap';
      const ta = document.createElement('textarea');
      ta.className = 'edit-area';
      ta.spellcheck = true; ta.lang = window.LangI18n.get();
      ta.value = summaryText;
      const bar = document.createElement('div');
      bar.className = 'edit-bar';
      const cancel = document.createElement('button');
      cancel.textContent = t('Cancel'); cancel.className = 'btn-secondary';
      const save = document.createElement('button');
      save.textContent = t('Save'); save.className = 'btn-primary';
      bar.appendChild(cancel); bar.appendChild(save);
      wrap.appendChild(ta); wrap.appendChild(bar);
      body.after(wrap);
      const commit = () => vscode.postMessage({ type: 'setSummary', text: ta.value });
      const close = () => { body.style.display = ''; wrap.remove(); el.classList.remove('editing'); };
      save.addEventListener('click', commit);
      cancel.addEventListener('click', close);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.5) + 'px'; };
      ta.addEventListener('input', autosize);
      ta.focus({ preventScroll: true }); autosize();
    };
    // Centered bubble with the rendered summary (markdown) + actions.
    const summaryBubble = () => {
      const el = document.createElement('div');
      el.className = 'msg summary-msg';
      const roleEl = document.createElement('div');
      roleEl.className = 'role';
      const nm = document.createElement('span');
      nm.textContent = '🗜️ ' + t('Context summary');
      roleEl.appendChild(nm);
      const actions = document.createElement('span');
      actions.className = 'msg-actions';
      const copyBtn = iconButton(ICONS.copy, t('Copy'), () => {
        vscode.postMessage({ type: 'copy', text: summaryText });
        copyBtn.innerHTML = ICONS.check; setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 1200);
      });
      actions.appendChild(copyBtn);
      const readBtn = iconButton(ICONS.speaker, t('Read aloud'), () => tts.speak(summaryText, readBtn)); // no msgId: not a history message
      actions.appendChild(readBtn);
      actions.appendChild(iconButton(ICONS.edit, t('Edit summary'), () => startEditSummary(el)));
      actions.appendChild(iconButton(ICONS.branch,
        t('Fork: clone the conversation up to here into a new .chat') + ` · ${t('⌥/Alt: fork from here to the end')}`,
        (e) => vscode.postMessage({ type: 'fork', index: upTo, fromHere: !!(e && e.altKey) })));
      actions.appendChild(iconButton(ICONS.trash, t('Delete summary (uncompact the history)'),
        () => vscode.postMessage({ type: 'clearSummary' })));
      roleEl.appendChild(actions);
      el.appendChild(roleEl);
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = renderMarkdown(summaryText);
      el.appendChild(body);
      return el;
    };
    const summaryDivider = () => {
      const d = document.createElement('div');
      d.className = 'summary-divider' + (summaryOpen ? ' open' : '');
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'summary-divider-label';
      s.textContent = '🗜️ ' + t('Context summarized up to here') + (summaryOpen ? ' ▾' : ' ▸');
      s.title = t('Click to view the summary');
      s.addEventListener('click', () => { summaryOpen = !summaryOpen; renderConversation(); });
      d.appendChild(s);
      messagesEl.appendChild(d);
      if (summaryOpen) messagesEl.appendChild(summaryBubble());
    };
    // "Last N" divider: from here onward is the only content sent.
    const lastNDivider = () => {
      const d = document.createElement('div');
      d.className = 'lastn-divider';
      const s = document.createElement('span');
      s.className = 'lastn-divider-label';
      s.textContent = '✂️ ' + t('From here: only the last {n} messages are sent').replace('{n}', String(lastN));
      d.appendChild(s);
      messagesEl.appendChild(d);
    };
    // With "last N" active, the saved summary is NOT sent (it is stale): shown dimmed as an indicator.
    if (lastN && summaryText) {
      const d = document.createElement('div');
      d.className = 'summary-divider excluded';
      const s = document.createElement('span');
      s.className = 'summary-divider-label';
      s.textContent = '🗜️ ' + t('Saved summary — not sent while «last N» is active');
      s.title = summaryText;
      d.appendChild(s);
      messagesEl.appendChild(d);
    }
    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      // Internal tool messages: NOT shown as a bubble; they go to the panel.
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
      // Normal message (user or final assistant response).
      const canMerge = i > 0 && visible[i - 1].role === m.role;
      const isLast = i === lastDisplayable; // last DISPLAYABLE (ignores dangling tool-calls/tool)
      const canRegenerate = m.role === 'assistant' && isLast;
      // Last displayable user message → regenerate response (truncates anything dangling after it).
      const canGenerate = m.role === 'user' && isLast;
      // User message whose response (the following assistant) is the last displayable:
      // allows re-rolling from the prompt without having to delete the assistant message.
      const canRegenFromPrompt = m.role === 'user' && visible[i + 1] && visible[i + 1].role === 'assistant' && (i + 1) === lastDisplayable;
      const activity = (m.role === 'assistant' && pendingTools.length) ? pendingTools.slice() : null;
      // Divider before the first message at/after the boundary (last-N wins over the summary).
      if (lastN) {
        if (!lastNShown && i >= cut) { if (cut > 0) lastNDivider(); lastNShown = true; }
      } else if (upTo > 0 && !summaryShown && i >= upTo) {
        summaryDivider(); summaryShown = true;
      }
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
        preSummary: !lastN && upTo > 0 && i < upTo, // compacted into the summary
        dropped: lastN > 0 && i < cut,              // outside the "last N" window
        variantCount: Array.isArray(m.variants) ? m.variants.length : 1,
        variantActive: m.active || 0,
      });
      if (m.role === 'assistant') lastThinking = m.thinking || '';
      pendingTools = [];
    }
    // The entire history was summarized (no recent messages): divider at the end.
    if (!lastN && upTo > 0 && !summaryShown) summaryDivider();
    // Restore scroll: to the bottom if already there; otherwise to where it was.
    suppressScroll = false;
    if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
    else messagesEl.scrollTop = prevTop;
    // If the search bar is open, re-highlight over the freshly rebuilt DOM.
    if (typeof refreshFind === 'function') refreshFind();
    // Show the reasoning of the last message in the panel.
    showThinking(lastThinking);
  }

  // ---- Export to PDF (self-contained HTML + auto-print) ----
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
      if (m.role !== 'user' && m.role !== 'assistant') return false; // exclude 'tool'
      if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) return false; // tool intermediate
      const hasImg = (m.attachments || []).some((a) => a.kind === 'image');
      return (m.content && m.content.trim()) || hasImg; // exclude empty
    });
    let body = '';
    for (const m of visible) {
      const who = m.role === 'user' ? t('You') : t('Assistant');
      let imgs = '';
      for (const a of (m.attachments || [])) {
        // Escape mime and data: a hand-crafted .attach sidecar could inject markup
        // into the exported HTML (opened in the external browser).
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

  // ---- Configuration patch ----
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
    // If something that shifts the context dividers changed (last N / summary / budget),
    // re-render the conversation so the ✂️/🗜️ markers and dimming reflect the new state.
    if (patch.params && ('contextMessages' in patch.params || 'autoSummary' in patch.params)) {
      renderConversation();
    }
  }
  const patchParam = (key, value) => patchConfig({ params: { [key]: value } });

  // ---- Configuration panel rendering ----
  function renderConfig() {
    if (!doc) return;
    // Backend and model are static in the HTML; here only system prompt + parameters.
    configFields.innerHTML = '';

    // System prompt: reference to a .md file, or inline.
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

    // Parameter groups, filtered by the active backend (hides empty groups).
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

    // Read aloud (system engine or neural Piper).
    renderTtsConfig();
  }

  // Read aloud configuration section.
  function renderTtsConfig() {
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = t('Read aloud');
    configFields.appendChild(h);

    const engine = tts.prefs.engine || 'system';

    // Engine selector: system voices vs neural Piper.
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
      // Voice selector (Spanish first).
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
      // Piper: the selector offers ONLY DOWNLOADED voices. The Custom option appears only if there
      // is a .onnx path configured in Settings (or if it is the current selection) — for a
      // normal user without a custom path, the dropdown shows exclusively downloaded voices.
      const dl = tts.downloadedVoices;
      const showCustom = tts.customSet || tts.prefs.piperVoice === 'custom';
      const available = tts.piperVoices.filter((v) =>
        v.id === 'custom' ? showCustom : dl.has(v.id)
      );
      const realVoices = available.filter((v) => v.id !== 'custom');
      // If the selected voice is no longer downloaded, reassign to a valid one (1st real, or Custom).
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
        ? t('Set the .onnx model path in Settings (parley.tts.piperModel).')
        : !realVoices.length
          ? t('No voices downloaded. Add one from the Parley panel (Voices ➕).')
          : t('Downloaded voices work offline. Add more from the Parley panel (Voices ➕).');
      configFields.appendChild(note);
    }

    // Speed (shared by both engines).
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

    // Buttons: test and (Piper with curated voice only) update.
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
      row.classList.toggle('disabled', !cb.checked); // dim when off
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

    // Header: [checkbox] label ............ [numeric box]
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

  // ---- Connection status ----
  let statusInfo = null, statusState = 'checking', statusDetail = '';
  function renderStatus(info, state, detail) {
    statusInfo = info; statusState = state; statusDetail = detail || '';
    paintStatus();
  }
  // Composes the status: provider · active model (or the detail if no model).
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

  // ---- Models ----
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
    // Tooltip on both the span (title) and inside the SVG (<title>), for maximum compatibility.
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

    // Group by provider (the prefix before '/', e.g. openai/gpt-4o-mini).
    const groups = new Map();
    for (const info of models) {
      const m = info.id;
      const slash = m.indexOf('/');
      const vendor = slash > 0 ? m.slice(0, slash) : '';
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(m);
    }

    const named = [...groups.keys()].filter((v) => v).sort((a, b) => a.localeCompare(b));
    const order = groups.has('') ? [...named, ''] : named; // no provider prefix, goes last

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
        // Inside the group, just the model name is enough (without the vendor prefix).
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

  // While summarizing the context: block sending and disable the composer.
  let isSummarizing = false;
  function setSummarizing(on) {
    isSummarizing = on;
    if (inputEl) inputEl.disabled = on;
    if (sendBtn) sendBtn.disabled = on;
    if (inputBox) inputBox.classList.toggle('busy', on);
  }

  // ---- Attachments ----
  const IMG_RE = /^image\//;
  const TEXT_EXT = /\.(txt|md|json|csv|js|ts|tsx|jsx|py|java|c|cpp|h|go|rs|rb|php|html|css|scss|xml|yaml|yml|toml|ini|sh|sql|log|env)$/i;
  function isTextLike(file) {
    if (/^text\//.test(file.type)) return true;
    if (/(json|xml|javascript|yaml|csv|markdown|x-sh|x-python)/i.test(file.type)) return true;
    if (!file.type) return TEXT_EXT.test(file.name || ''); // unknown mime: fall back to extension
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
      return { kind: 'image', name: file.name || 'image.png', mime: file.type || 'image/png', data: await readBase64(file) };
    }
    if (isTextLike(file)) {
      const text = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result));
        rd.onerror = () => reject(rd.error || new Error('read error'));
        rd.readAsText(file);
      });
      return { kind: 'text', name: file.name || 'file.txt', mime: file.type || 'text/plain', data: text };
    }
    // PDF, docx, binaries… → base64 document
    return { kind: 'document', name: file.name || 'document', mime: file.type || 'application/octet-stream', data: await readBase64(file) };
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

  // ---- Context usage bar (by tokens) ----
  function estTokens(s) { return s ? Math.ceil(s.length / 4) : 0; }
  function msgTokens(m) {
    let t = estTokens(m.content) + 4;
    for (const a of (m.attachments || [])) t += a.kind === 'image' ? 1200 : estTokens(a.data);
    return t;
  }
  // Effective token budget: auto = 75% of the model window.
  function ctxBudget() {
    const modelCtx = modelContext[modelSelect.value];
    return modelCtx ? Math.floor(modelCtx * 0.75) : 16000;
  }
  // Tokens of the EFFECTIVE system prompt. The backend sends sysPromptTokens (file content included);
  // fall back to estimating the inline prompt if it's an older payload without that field.
  function sysPromptTokens() {
    if (!doc) return 0;
    return typeof doc.sysPromptTokens === 'number' ? doc.sysPromptTokens : estTokens(doc.systemPrompt || '');
  }
  // Effective start index for "last N": the NEAREST cut wins (N messages vs token budget).
  // Exact replica of the backend's trimming so the divider matches what is actually sent.
  function lastNStart(msgs, n) {
    const budget = ctxBudget();
    let acc = sysPromptTokens();
    let start = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs.length - i > n) break;                       // cap: N messages
      const tk = msgTokens(msgs[i]);
      if (acc + tk > budget && start < msgs.length) break;  // cap: token budget
      acc += tk;
      start = i;
    }
    return start;
  }
  function updateUsage() {
    // Calculated by summing the usage of the current messages (not a fixed accumulator).
    let pt = 0, ct = 0, tt = 0, cost = 0, has = false;
    const add = (u) => { if (u) { has = true; pt += u.promptTokens || 0; ct += u.completionTokens || 0; tt += u.totalTokens || 0; if (u.cost) cost += u.cost; } };
    for (const m of (doc && doc.messages) || []) {
      // If there are variants (retries), sum ALL of them (each was a paid call).
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
    // Applies with auto-summary OR "last N" (both trim what is sent).
    if (!doc || !doc.params) { ctxBar.classList.add('hidden'); return; }
    const cm = doc.params.contextMessages;
    const lastN = (cm && cm.enabled && cm.value > 0) ? cm.value : 0; // wins over the summary
    if (!lastN && !doc.params.autoSummary) { ctxBar.classList.add('hidden'); return; }
    const budget = ctxBudget();
    const msgs = doc.messages || [];
    let total = sysPromptTokens();
    if (lastN) {
      // Only the effective "last N" window (bounded by the budget; no summary).
      for (let i = lastNStart(msgs, lastN); i < msgs.length; i++) total += msgTokens(msgs[i]);
    } else {
      const upTo = doc.summary ? doc.summary.upTo : 0;
      total += estTokens(doc.summary ? doc.summary.text : '');
      for (let i = upTo; i < msgs.length; i++) total += msgTokens(msgs[i]);
    }
    const pct = Math.min(100, Math.round((total / budget) * 100));
    ctxBar.classList.remove('hidden');
    ctxFill.style.width = pct + '%';
    ctxFill.className = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
    ctxLabel.textContent = `${t('Context')} ${fmtTokens(total)}/${fmtTokens(budget)} (${pct}%)`;
  }

  // ---- Send ----
  function send() {
    if (isStreaming || isSummarizing) return; // ignore sends while generating or summarizing
    const text = inputEl.value.trim();
    if (!text && pending.length === 0) return;
    clearNotices();
    stickToBottom = true; // on send, stick to the bottom again
    const attachments = pending.slice();
    addMessage('user', text, { attachments });
    if (doc) doc.messages.push({ role: 'user', content: text, attachments });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    renderSpell(); // clear the overlay underline
    pending = [];
    renderPending();
    setStreaming(true); // block resends until streamEnd/error
    vscode.postMessage({ type: 'send', text, attachments });
  }

  // ---- UI events ----
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  inputEl.addEventListener('keydown', (e) => {
    if (handleFileKeydown(e)) return;
    if (handleSuggestKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.4) + 'px';
    scheduleSpell();
  });
  inputEl.addEventListener('scroll', () => { if (inputBackdrop) inputBackdrop.scrollTop = inputEl.scrollTop; });

  // ---- Spell checker (live underline via overlay; nspell engine in spell.js) ----
  const WORD_RE = /[\p{L}\p{M}]+/gu; // words (letters + marks/diacritics); ignores numbers/symbols
  let spellTimer = null;

  // Effective spell-check language based on the per-chat selector: 'auto' → system language.
  // Any language with a bundled dictionary (window.SPELL_DICTS) is valid; others → no spell checker.
  function spellEffective() {
    const pref = spellSelect ? spellSelect.value : 'auto';
    if (pref === 'off') return null;
    const dicts = window.SPELL_DICTS || {};
    if (pref !== 'auto' && dicts[pref]) return pref;
    const sys = (navigator.language || '').toLowerCase().slice(0, 2);
    return dicts[sys] ? sys : null;
  }

  function applySpellLang() {
    if (window.LangSpell) window.LangSpell.setLang(spellEffective());
    renderSpell();
  }

  // Rebuilds the background layer with misspelled words underlined.
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

  // Word (range) that contains/touches offset `pos` in `text`.
  function wordAt(text, pos) {
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) {
      if (pos >= m.index && pos <= m.index + m[0].length) return { text: m[0], start: m.index, end: m.index + m[0].length };
      if (m.index > pos) break;
    }
    return null;
  }

  // Floating suggestions menu.
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
      const lang = window.LangSpell ? window.LangSpell.lang() : null; // active spell-checker language
      if (window.LangSpell) window.LangSpell.add(word.text);   // immediate effect
      vscode.postMessage({ type: 'spellAddWord', word: word.text, lang }); // persisted per language
      renderSpell();
      closeSpellMenu();
      inputEl.focus();
    });
    spellMenu.appendChild(add);
    document.body.appendChild(spellMenu);
    // Fit within the screen.
    const r = spellMenu.getBoundingClientRect();
    spellMenu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    spellMenu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }

  inputEl.addEventListener('contextmenu', (e) => {
    if (!window.LangSpell || !window.LangSpell.ready()) return; // no spell checker: native menu
    const word = wordAt(inputEl.value, inputEl.selectionStart);
    if (!word || window.LangSpell.correct(word.text)) { closeSpellMenu(); return; }
    e.preventDefault();
    showSpellMenu(e.clientX, e.clientY, word, window.LangSpell.suggest(word.text));
  });
  document.addEventListener('mousedown', (e) => { if (spellMenu && !spellMenu.contains(e.target)) closeSpellMenu(); });
  window.addEventListener('blur', closeSpellMenu);
  // Paste images (Ctrl+V) directly into the chat.
  inputEl.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  // ---- Emoji picker ----
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
        const tip = emojiTitle(em); // associated :name shortcuts, if any
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

  // ---- Emoji autocomplete when typing :name (WhatsApp/Slack style) ----
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
  // Inverse map emoji -> names (for tooltips in the grid).
  const EMOJI_TO_NAMES = {};
  for (const [name, em] of SHORTCODE_ENTRIES) (EMOJI_TO_NAMES[em] = EMOJI_TO_NAMES[em] || []).push(name);
  const emojiTitle = (em) => (EMOJI_TO_NAMES[em] ? EMOJI_TO_NAMES[em].slice(0, 4).map((n) => ':' + n).join('  ') : '');

  // Autocomplete popup, shared and positioned above the active textarea.
  const emojiSuggest = document.createElement('div');
  emojiSuggest.id = 'emojiSuggest';
  emojiSuggest.className = 'hidden';
  document.body.appendChild(emojiSuggest);
  let suggestItems = [];
  let suggestActive = 0;
  let suggestTa = null; // textarea in use
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
  // true if the key was consumed by the popup (navigation/accept/close).
  function handleSuggestKeydown(e) {
    if (!suggestOpen()) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSuggest(suggestItems[suggestActive][1]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return true; }
    return false;
  }
  // Connects autocomplete to any textarea.
  function setupEmojiAutocomplete(ta) {
    ta.addEventListener('input', () => updateSuggest(ta));
    ta.addEventListener('blur', () => setTimeout(hideSuggest, 150));
  }
  setupEmojiAutocomplete(inputEl);

  // ---- @file mention autocomplete (workspace files resolved by the extension; inserts the FULL path) ----
  const fileSuggest = document.createElement('div');
  fileSuggest.id = 'fileSuggest';
  fileSuggest.className = 'hidden';
  document.body.appendChild(fileSuggest);
  let fileItems = [];   // relative paths
  let fileActive = 0;
  let fileTa = null;
  let fileReq = 0;      // matches async results to the latest query
  const fileOpen = () => !fileSuggest.classList.contains('hidden');

  // `@` followed by a partial path (no spaces) at the caret.
  function atQuery(ta) {
    const pos = ta.selectionStart;
    const m = ta.value.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/);
    return m ? { q: m[1], start: pos - m[1].length - 1 } : null;
  }
  function hideFiles() { fileSuggest.classList.add('hidden'); fileItems = []; }
  function renderFiles() {
    fileSuggest.innerHTML = '';
    fileItems.forEach((path, i) => {
      const name = path.split('/').pop();
      const dir = path.slice(0, path.length - name.length);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sug-row file' + (i === fileActive ? ' active' : '');
      row.title = path;
      row.innerHTML = '<span class="sug-file">' + escapeHtml(name) + '</span>'
        + (dir ? '<span class="sug-path">' + escapeHtml(dir) + '</span>' : '');
      row.addEventListener('mousedown', (e) => { e.preventDefault(); acceptFile(path); });
      fileSuggest.appendChild(row);
    });
  }
  function positionFiles(ta) {
    const r = ta.getBoundingClientRect();
    fileSuggest.style.left = Math.round(r.left) + 'px';
    fileSuggest.style.bottom = Math.round(window.innerHeight - r.top + 4) + 'px';
  }
  function updateFiles(ta) {
    fileTa = ta;
    const c = atQuery(ta);
    if (!c) { hideFiles(); return; }
    vscode.postMessage({ type: 'atFiles', q: c.q, reqId: ++fileReq }); // resolved async by the extension
  }
  // Called when the extension returns matches.
  function onFileResults(q, files, reqId) {
    if (reqId !== fileReq || !fileTa) return;       // stale response
    const c = atQuery(fileTa);
    if (!c || c.q !== q) return;                    // query moved on
    fileItems = (files || []).slice(0, 10);
    if (!fileItems.length) { hideFiles(); return; }
    fileActive = 0;
    renderFiles();
    positionFiles(fileTa);
    fileSuggest.classList.remove('hidden');
  }
  function moveFiles(d) { fileActive = (fileActive + d + fileItems.length) % fileItems.length; renderFiles(); }
  function acceptFile(path) {
    const ta = fileTa;
    const c = ta && atQuery(ta);
    if (!ta || !c) { hideFiles(); return; }
    const pos = ta.selectionStart, v = ta.value;
    const insert = '@' + path + ' ';
    ta.value = v.slice(0, c.start) + insert + v.slice(pos);
    ta.selectionStart = ta.selectionEnd = c.start + insert.length;
    hideFiles();
    ta.focus();
    ta.dispatchEvent(new Event('input'));
  }
  function handleFileKeydown(e) {
    if (!fileOpen()) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveFiles(1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveFiles(-1); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptFile(fileItems[fileActive]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideFiles(); return true; }
    return false;
  }
  function setupFileAutocomplete(ta) {
    ta.addEventListener('input', () => updateFiles(ta));
    ta.addEventListener('blur', () => setTimeout(hideFiles, 150));
  }
  setupFileAutocomplete(inputEl);

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  // Drag and drop files anywhere in the chat.
  const inputBox = $('inputBox');
  // Drag highlight with a counter: dragenter/leave fire when crossing child elements,
  // so a single flag would get stuck. The counter reflects whether the pointer is still inside.
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

  // ---- Chat-local zoom (independent of VS Code's global zoom) ----
  let zoom = LangZoom.clampZoom((vscode.getState() && vscode.getState().zoom) || 1);
  function applyZoom() {
    // Zoom ONLY the history (which has its own scroll), not the whole body: zooming the body
    // scaled the 100vh layout and overflowed/clipped the composer (the input bar).
    document.body.style.zoom = '';                // clear any previous zoom on body (legacy state)
    if (messagesEl) messagesEl.style.zoom = String(zoom);
    const lbl = $('zoomResetBtn');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
    const s = vscode.getState() || {};
    s.zoom = zoom;
    vscode.setState(s);
  }
  function setZoom(z) { zoom = LangZoom.clampZoom(z); applyZoom(); }
  applyZoom();
  // Alt/Option + wheel → zoom (same modifier as cascading delete; does not conflict with VS Code's native +/-).
  window.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    zoom = LangZoom.stepZoom(zoom, e.deltaY);
    applyZoom();
  }, { passive: false });
  // Alt/Option + 0 → reset.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === '0')) { e.preventDefault(); setZoom(1); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); setReplaceVisible(false); openFind(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); setReplaceVisible(true); openFind(); replaceInput.focus(); }
    if (e.key === 'Escape' && findBar && !findBar.classList.contains('hidden')) { e.preventDefault(); closeFind(); }
    // Ctrl/Cmd+Z (and redo): the .chat is a text editor, so document undo would inadvertently
    // revert/delete messages. Block it ALWAYS; inside an editable field we keep its own
    // undo via execCommand (does not touch the document).
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.target;
      const editable = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
      if (editable) {
        const redo = (e.key === 'y' || e.key === 'Y') || e.shiftKey;
        try { document.execCommand(redo ? 'redo' : 'undo'); } catch (_) { /* no native undo */ }
      }
    }
  });
  // Toolbar controls: −, %, + (% resets to 100%).
  $('zoomInBtn').addEventListener('click', () => setZoom(LangZoom.stepZoom(zoom, -1)));
  $('zoomOutBtn').addEventListener('click', () => setZoom(LangZoom.stepZoom(zoom, 1)));
  $('zoomResetBtn').addEventListener('click', () => setZoom(1));
  providerSelect.addEventListener('change', () => {
    // Clear the model immediately to avoid showing models from the previous backend.
    modelSelect.innerHTML = '<option>' + escapeHtml(t('Loading…')) + '</option>';
    patchConfig({ provider: providerSelect.value });
    renderConfig(); // re-filter parameters for the new backend
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

  // ---- In-chat search (Ctrl/Cmd+F) ----
  const findBar = $('findBar');
  const findInput = $('findInput');
  const findCount = $('findCount');
  let findHits = [];   // <mark> highlights, in document order
  let findIdx = -1;    // index of the "current" hit
  // VS Code-style search options. NOTE: the query is used verbatim (NOT trimmed) so you can search
  // for text with surrounding spaces (e.g. " ab ") to replace it everywhere.
  const findOpts = { matchCase: false, wholeWord: false, regex: false, preserveCase: false };
  function buildFindRegex(query) {
    if (query === '') return null;
    let pattern = findOpts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (findOpts.wholeWord) pattern = '\\b' + pattern + '\\b';
    try { return new RegExp(pattern, 'g' + (findOpts.matchCase ? '' : 'i')); } catch (e) { return null; }
  }

  // Removes all <mark> elements and reconstructs the original text nodes.
  function clearFindMarks() {
    const marks = messagesEl.querySelectorAll('mark.find-hit');
    marks.forEach((mk) => {
      const p = mk.parentNode;
      if (!p) return;
      p.replaceChild(document.createTextNode(mk.textContent), mk);
      p.normalize(); // merge adjacent text nodes
    });
    findHits = [];
    findIdx = -1;
  }

  // Wraps each match of the regex `re` (global) inside a text node in <mark>.
  function highlightInNode(node, re) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    let m, last = 0, any = false;
    const frag = document.createDocumentFragment();
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // guard zero-width matches
      any = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mk = document.createElement('mark');
      mk.className = 'find-hit';
      mk.textContent = m[0];
      frag.appendChild(mk);
      last = m.index + m[0].length;
    }
    if (!any) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function updateFindCount() {
    if (findInput.value === '') { findCount.textContent = ''; return; }
    findCount.textContent = findHits.length ? (findIdx + 1) + ' ' + t('of') + ' ' + findHits.length : t('No results');
  }

  function setCurrentHit(scroll) {
    findHits.forEach((h, k) => h.classList.toggle('current', k === findIdx));
    if (scroll && findIdx >= 0 && findHits[findIdx]) {
      findHits[findIdx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // Searches for `query` in the message bubbles. opts.keepPos preserves the current hit and skips scroll
  // (used when re-rendering while the bar is open, e.g. after a new message arrives).
  function runFind(query, opts) {
    opts = opts || {};
    const prevIdx = findIdx;
    clearFindMarks();
    const q = query || ''; // verbatim — no trim, so leading/trailing spaces are searchable
    const re = buildFindRegex(q);
    findInput.classList.toggle('invalid', findOpts.regex && q !== '' && !re); // red border on bad regex
    if (!re) { updateFindCount(); return; }
    const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
        re.lastIndex = 0;
        return re.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const node of targets) highlightInNode(node, re);
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
    if (findInput.value !== '') runFind(findInput.value);
  }

  function closeFind() {
    findBar.classList.add('hidden');
    clearFindMarks();
    updateFindCount();
  }

  // Re-applies highlighting after a re-render if the bar is still open (innerHTML is rebuilt).
  let replaceAdvance = false; // set by replaceCurrent: scroll to (and step past) the next match
  function refreshFind() {
    if (findBar && !findBar.classList.contains('hidden') && findInput.value !== '') {
      const before = findHits.length;
      const wasIdx = findIdx;
      runFind(findInput.value, { keepPos: true });
      if (replaceAdvance) {
        replaceAdvance = false;
        // If the replacement still matches (count didn't drop — e.g. "approx" → "approximately"),
        // step past it so we don't get stuck re-selecting the same spot.
        if (findHits.length && findHits.length >= before) findIdx = (wasIdx + 1) % findHits.length;
        setCurrentHit(true); // scroll to the next match (VS Code-like)
        updateFindCount();
      }
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

  // Search option toggles (Aa match-case · ab whole-word · .* regex · AB preserve-case), VS Code-style.
  function bindFindOpt(id, key, rerun) {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      findOpts[key] = !findOpts[key];
      btn.setAttribute('aria-pressed', findOpts[key] ? 'true' : 'false');
      btn.classList.toggle('active', findOpts[key]);
      if (rerun) runFind(findInput.value, { keepPos: true });
    });
  }
  bindFindOpt('optMatchCase', 'matchCase', true);
  bindFindOpt('optWholeWord', 'wholeWord', true);
  bindFindOpt('optRegex', 'regex', true);
  bindFindOpt('optPreserveCase', 'preserveCase', false);

  // ---- Replace (find's second row; like VS Code) ----
  const replaceInput = $('replaceInput');
  const findReplaceRow = $('findReplaceRow');
  const findToggleReplace = $('findToggleReplace');
  function setReplaceVisible(v) {
    findReplaceRow.classList.toggle('hidden', !v);
    findToggleReplace.setAttribute('aria-expanded', v ? 'true' : 'false');
  }
  findToggleReplace.addEventListener('click', () => {
    const show = findReplaceRow.classList.contains('hidden');
    setReplaceVisible(show);
    if (show) replaceInput.focus();
  });

  // Map the current find hit back to {message index, occurrence # within that message} so the host
  // can replace the right occurrence in the raw source. Within one message rendered-match order
  // matches source-occurrence order, so counting same-message hits up to the current one gives the
  // ordinal. Returns null for hits not inside an editable message bubble (e.g. the summary).
  function currentHitLocation() {
    if (findIdx < 0 || !findHits[findIdx]) return null;
    const msgEl = findHits[findIdx].closest('.msg');
    if (!msgEl || msgEl.dataset.msgIndex == null) return null;
    const index = parseInt(msgEl.dataset.msgIndex, 10);
    if (!Number.isInteger(index)) return null;
    let ordinal = 0;
    for (let k = 0; k <= findIdx; k++) if (findHits[k].closest('.msg') === msgEl) ordinal++;
    return { index, ordinal };
  }
  function replaceCurrent() {
    const q = findInput.value;
    if (q === '' || !findHits.length) return;
    const loc = currentHitLocation();
    if (!loc) { findNav(1); return; } // hit isn't in an editable message: just advance
    replaceAdvance = true; // after the host re-renders, scroll to / advance to the next match
    vscode.postMessage({ type: 'replaceOne', index: loc.index, ordinal: loc.ordinal, query: q, replacement: replaceInput.value, opts: findOpts });
    // The host persists + re-sends history; refreshFind re-highlights (keepPos lands on the next match).
  }
  function replaceAll() {
    const q = findInput.value;
    if (q === '') return;
    vscode.postMessage({ type: 'replaceAll', query: q, replacement: replaceInput.value, opts: findOpts });
  }
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey || e.metaKey || e.altKey) replaceAll(); else replaceCurrent(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('replaceOne').addEventListener('click', replaceCurrent);
  $('replaceAll').addEventListener('click', replaceAll);

  // Applies a language: translates static HTML and re-renders dynamic content. `bundle` is the
  // active language's translations (sent fresh on a live change so any locale works, not just es).
  function applyLanguage(lang, bundle) {
    window.LangI18n.set(lang);
    if (bundle) window.LangI18n.setBundle(bundle);
    window.LangI18n.applyStatic(document);
    document.documentElement.lang = lang;
    if (doc) { renderConfig(); renderConversation(); updateUsage(); updateContextBar(); }
    updateModelCtx(); // refresh capability/context tooltips + status
  }

  // ---- Messages from the extension ----
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'lang':
        applyLanguage(msg.lang, msg.bundle);
        break;
      case 'atFilesResult':
        onFileResults(msg.q, msg.files, msg.reqId);
        break;
      case 'spellWords':
        if (window.LangSpell) window.LangSpell.setWords(msg.words || []);
        break;
      case 'piperVoices':
        // Downloaded Piper voices: the chat selector only offers these (+ Custom).
        tts.downloadedVoices = new Set(msg.ids || []);
        if (doc && !configPanel.classList.contains('hidden')) renderConfig();
        break;
      case 'doc':
        doc = msg.doc;
        providerSelect.value = doc.provider;
        if (spellSelect) spellSelect.value = doc.spellLang || 'auto'; // per-chat spell-checker language
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
        // Ignore responses from a backend that is no longer active.
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
        // Synchronous final render: ensures the last tokens (that may not have made it
        // into the last frame) are reflected.
        pendingBody = false;
        pendingThink = false;
        rafQueued = false;
        if (streamingEl) {
          const body = streamingEl.querySelector('.body');
          body.innerHTML = renderMarkdownImpl(streamingText);
          body.classList.remove('cursor');
          bindThinking(streamingEl, thinkingText);
          processMermaid(body); // render diagrams now that the turn is complete
          scrollDown();
        }
        streamingEl = null;
        setStreaming(false);
        break;
      case 'history':
        // Authoritative history after send/delete/merge: re-render with indices and actions.
        if (doc) {
          doc.messages = msg.messages; // doc.usage is unused: updateUsage() recalculates from messages
          if ('summary' in msg) doc.summary = msg.summary || undefined; // keep the summary in sync
        }
        renderConversation();
        updateContextBar();
        updateUsage();
        break;
      case 'summarizing':
        setSummarizing(!!msg.active); // block sending for the duration
        if (msg.active) showSummarizing(msg.message); else hideSummarizing();
        break;
      case 'notice':
        notice(msg.message, false);
        break;
      case 'error':
        notice(msg.message, true);
        // Close the mid-stream turn: remove the cursor and release the reference,
        // so that a late delta does not write into the old bubble.
        pendingBody = false;
        pendingThink = false;
        rafQueued = false; // cancel any pending coalesced render
        if (streamingEl) {
          const b = streamingEl.querySelector('.body');
          if (streamingText) { b.innerHTML = renderMarkdownImpl(streamingText); processMermaid(b); }
          b.classList.remove('cursor');
          bindThinking(streamingEl, thinkingText); // preserve the partial reasoning badge
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
        if (msg.id === undefined || msg.id === tts.reqId) { // ignore errors from stale requests
          tts.stop();
          notice(msg.message, true);
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
