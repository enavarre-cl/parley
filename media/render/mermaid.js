/**
 * Mermaid diagram rendering + GitHub-style pan/zoom viewer for the chat webview.
 * Self-contained (needs the vendored window.mermaid global, lazy-loaded). Entry: processMermaid.
 */
import { t } from '../core/i18n.js';

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
        const id = 'mmd-' + (_mermaidSeq++);
        const { svg } = await mermaid.render(id, code); // always render fresh
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
    // Scale proportionally to the bubble width: a leftover height attribute (or a missing viewBox)
    // makes CSS width:100% stretch the SVG horizontally → vertical squish. Anchor the aspect ratio
    // to the viewBox and drop the intrinsic width/height so height:auto follows it.
    const svgEl = canvas.querySelector('svg');
    if (svgEl) {
      if (!svgEl.getAttribute('viewBox')) {
        const w = parseFloat(svgEl.getAttribute('width') || '') || 0;
        const h = parseFloat(svgEl.getAttribute('height') || '') || 0;
        if (w && h) svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
      }
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svgEl.style.removeProperty('max-width'); // Mermaid pins a tiny intrinsic max-width inline
      svgEl.style.removeProperty('width');
      svgEl.style.removeProperty('height');
    }
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
      el.setAttribute('width', String(w)); el.setAttribute('height', String(h)); el.style.maxWidth = 'none';
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


export { processMermaid };
