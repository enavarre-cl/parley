// Pure formatting/render helpers for the model explorer (no shared state). Classic script loaded
// BEFORE models.js; an IIFE keeps t/esc out of the shared global lexical scope and exposes the
// helpers on window so the models.js IIFE can call them directly (esc(), fmtBytes(), …).
(function () {
  const t = (s) => (window.LangI18n ? window.LangI18n.t(s) : s);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtBytes(n) {
    if (!n || n < 0) return '—';
    const gb = n / 1073741824;
    return gb >= 1 ? gb.toFixed(2) + ' GB' : (n / 1048576).toFixed(0) + ' MB';
  }
  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(n || 0);
  }
  // Localized relative time ("hace 10 días" / "10 days ago").
  function fmtAgo(dateStr) {
    if (!dateStr) return '';
    const then = new Date(dateStr).getTime();
    if (!then) return '';
    const sec = Math.round((Date.now() - then) / 1000);
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    const loc = (window.LangI18n && window.LangI18n.get && window.LangI18n.get()) || 'en';
    try {
      const rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
      for (const [unit, s] of units) {
        if (Math.abs(sec) >= s || unit === 'minute') return rtf.format(-Math.round(sec / s), unit);
      }
    } catch (e) { /* RTF not available */ }
    return '';
  }
  function pipelineLabel(p) {
    const map = {
      'text-generation': 'Text generation',
      'text2text-generation': 'Text generation',
      'image-text-to-text': 'Vision (image + text)',
      'any-to-any': 'Multimodal',
      'automatic-speech-recognition': 'Speech to text',
      'text-to-speech': 'Text to speech',
      'feature-extraction': 'Embeddings',
      'sentence-similarity': 'Embeddings',
    };
    return p ? t(map[p] || p) : '';
  }
  // Default quant: typical quality/size balance, with fallbacks.
  function pickDefaultQuant(files) {
    const order = ['Q4_K_M', 'Q4_0', 'Q5_K_M', 'Q4_K_S', 'Q8_0', 'Q6_K'];
    for (const q of order) { const i = files.findIndex((f) => f.quant === q); if (i >= 0) return i; }
    return Math.min(files.length - 1, Math.floor(files.length / 2));
  }
  function capBadges(caps, estimated) {
    const items = [];
    if (caps.vision) items.push(['👁', t('Vision')]);
    if (caps.tools) items.push(['🛠', t('Tool Use')]);
    if (caps.reasoning) items.push(['🧠', t('Reasoning')]);
    if (!items.length) return '';
    const tip = estimated ? ` title="${esc(t('Estimated from tags'))}"` : '';
    return `<span class="mb-caps"${tip}>` +
      items.map(([i, l]) => `<span class="mb-cap">${i} ${esc(l)}</span>`).join('') +
      (estimated ? ` <span class="mb-cap-est">~</span>` : '') + `</span>`;
  }

  // Capabilities row in the detail panel, with colors (Vision/Tools/Reasoning), like LM Studio.
  // `estimated` (HF heuristic) appends a `~`; Ollama reports declared capabilities, so it's omitted.
  function detailCaps(caps, estimated) {
    caps = caps || {};
    const items = [];
    if (caps.vision) items.push(['vision', '👁', t('Vision')]);
    if (caps.tools) items.push(['tools', '🛠', t('Tool Use')]);
    if (caps.reasoning) items.push(['reasoning', '🧠', t('Reasoning')]);
    if (!items.length) return '';
    return `<div class="mb-caps-row"><span class="mb-caps-label">${esc(t('Capabilities'))}:</span> ` +
      items.map(([k, i, l]) => `<span class="mb-cap-badge ${k}">${i} ${esc(l)}</span>`).join(' ') +
      (estimated ? ` <span class="mb-cap-est" title="${esc(t('Estimated from tags'))}">~</span>` : '') + `</div>`;
  }

  // Short README summary (first real paragraph, stripped of markdown/HTML), for the description box.
  function readmeSummary(md) {
    if (!md) return '';
    const text = md
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^\s*#.*$/gm, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 200 ? text.slice(0, 200).replace(/\s+\S*$/, '') + '…' : text;
  }

  // Allowlist sanitizer: parse into an inert <template> (its content never renders and scripts never
  // execute), then keep only known-safe tags/attributes. This is a DOM allowlist, not a regex denylist,
  // so a split/nested payload can't slip through; CSP remains the backstop.
  const SANITIZE_KEEP = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'STRONG',
    'EM', 'B', 'I', 'CODE', 'PRE', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'HR',
    'BLOCKQUOTE', 'SPAN', 'IMG']);
  const SANITIZE_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'SVG', 'HEAD']);
  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    for (const el of [...tpl.content.querySelectorAll('*')]) {
      if (SANITIZE_DROP.has(el.tagName)) { el.remove(); continue; }      // drop subtree
      if (!SANITIZE_KEEP.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; } // unwrap, keep text
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase(), v = attr.value;
        const ok = n === 'title' || n === 'alt'
          || (el.tagName === 'A' && n === 'href' && /^(https?:|mailto:)/i.test(v))
          || (el.tagName === 'IMG' && n === 'src' && /^(https?:|data:image\/)/i.test(v));
        if (!ok) el.removeAttribute(attr.name);
      }
    }
    return tpl.innerHTML;
  }

  // README render: basic markdown preserving embedded HTML (HF mixes both).
  // Inline Markdown (links, images, bold, inline code). Applied per line/cell.
  function inlineMd(s) {
    return s
      .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  // Cells of a Markdown table row (drops the leading/trailing pipe).
  function tableCells(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }
  const isTableSep = (l) => l.includes('|') && /-/.test(l) && /^[\s|:-]+$/.test(l);

  // Block-level Markdown: headings, lists, tables, code fences and paragraphs. (The chat's full
  // renderer is an ES module; this browser is a classic script, so it carries its own small one.)
  function renderReadme(md) {
    if (!md) return `<span class="mb-muted">${esc(t('No README'))}</span>`;
    const fences = [];
    md = md.replace(/```[\s\S]*?```/g, (m) => { fences.push(m); return `@@CODE${fences.length - 1}@@`; });
    const lines = md.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^@@CODE\d+@@$/.test(line.trim())) { out.push(line.trim()); i++; continue; }
      const h = /^(#{1,6})\s+(.+)$/.exec(line);
      if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = tableCells(line); i += 2;
        let html = '<table><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].includes('|')) {
          html += '<tr>' + tableCells(lines[i]).map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>'; i++;
        }
        out.push(html + '</tbody></table>'); continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`); i++;
        }
        out.push(`<ul>${items.join('')}</ul>`); continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])
        && !/^@@CODE\d+@@$/.test(lines[i].trim())
        && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i]); i++;
      }
      out.push(`<p>${inlineMd(para.join(' '))}</p>`);
    }
    let html = out.join('\n').replace(/@@CODE(\d+)@@/g, (m, n) => {
      const code = (fences[Number(n)] || '').replace(/^```\w*\n?/, '').replace(/```\s*$/, '');
      return `<pre><code>${esc(code)}</code></pre>`;
    });
    return sanitizeHtml(html);
  }
  Object.assign(window, {
    esc, fmtBytes, fmtNum, fmtAgo, pipelineLabel, pickDefaultQuant,
    capBadges, detailCaps, readmeSummary, sanitizeHtml, renderReadme,
  });
})();
