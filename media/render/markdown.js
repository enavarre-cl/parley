/**
 * Self-contained Markdown renderer for the chat webview — no dependency on app state.
 * Entry points: render (memoized) and renderRaw (uncached, used by streaming).
 */
import { escapeHtml } from '../core/dom.js';

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
  // Stash code-spans behind a NUL-delimited index placeholder. A space-delimited number ` 0 `
  // collided with ordinary prose ("entre 0 y 1"), turning digits into <code> and leaking
  // <code>undefined</code>. NUL never appears in chat text, so it can't collide.
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  t = deLatex(t); // Inline LaTeX → Unicode (code-spans are already protected above)
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    // Scheme allowlist: blocks javascript:/data:/vbscript:… (defense-in-depth on top of CSP).
    // Strip leading control chars/whitespace BEFORE testing the scheme: browsers ignore them
    // when resolving a URL, so `javascript:` would otherwise slip past and execute on click.
    const probe = url.replace(/[\u0000-\u0020]+/g, '');
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
    const href = scheme && !/^(https?|mailto)$/i.test(scheme[1]) ? '#' : url; // url is already escaped
    return '<a href="' + href + '">' + label + '</a>';
  });
  // Non-greedy so a bold span can contain a lone `*`/`_` (math, globs: `**2 * 3 = 6**`). The old
  // `[^*]+` stopped at the interior `*`, leaving a literal `**` that the single-`*` italic rule below
  // then mangled into a spurious `<em>`. Bounded to one paragraph (inlineMd runs per block).
  t = t.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
  return t;
}

function splitRow(line) {
  // Split on cell pipes, but NOT on an escaped `\|` (→ literal pipe) or a `|` inside a `code` span.
  // A raw `.split('|')` mis-counted cells and split code spans / leaked the backslash.
  const s = line.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '');
  const cells = [];
  let cur = '', inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; } // escaped pipe → literal
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Block-level Markdown renderer (headings, lists, blockquotes, tables, code…).
// renderMarkdown is memoized: it is a pure function, and renderConversation re-renders all
// messages (almost all identical) on every change. Streaming uses renderRaw (uncached).
const mdCache = new Map();
const MD_CACHE_MAX = 400;
export function render(src) {
  const key = String(src);
  const hit = mdCache.get(key);
  if (hit !== undefined) { mdCache.delete(key); mdCache.set(key, hit); return hit; } // refresh LRU
  const html = renderRaw(key);
  mdCache.set(key, html);
  if (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value); // evict oldest
  return html;
}
export function renderRaw(src) {
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
      out.push('<blockquote>' + renderRaw(buf.join('\n')) + '</blockquote>');
      continue;
    }
    // List (ordered or unordered), nested by indentation. The old code stripped the indentation and
    // emitted every <li> at one level, flattening any hierarchy; this keeps nesting with a small stack.
    const liRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
    if (liRe.test(line)) {
      const items = [];
      let mm;
      while (i < lines.length && (mm = liRe.exec(lines[i]))) {
        items.push({ indent: mm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(mm[2]), content: inlineMd(mm[3]) });
        i++;
      }
      let html = '';
      const stack = []; // [{ indent, tag }] — open lists from outermost to innermost
      for (const it of items) {
        while (stack.length && it.indent < stack[stack.length - 1].indent) html += '</li></' + stack.pop().tag + '>';
        if (!stack.length || it.indent > stack[stack.length - 1].indent) {
          const tag = it.ordered ? 'ol' : 'ul';
          html += '<' + tag + '><li>' + it.content;     // nested list inside the still-open parent <li>
          stack.push({ indent: it.indent, tag });
        } else {
          html += '</li><li>' + it.content;             // sibling at the same level
        }
      }
      while (stack.length) html += '</li></' + stack.pop().tag + '>';
      out.push(html);
      continue;
    }
    // Paragraph
    const para = [];
    while (i < lines.length && !isSpecial(lines[i])) { para.push(lines[i]); i++; }
    out.push('<p>' + inlineMd(para.join('\n')).replace(/\n/g, '<br/>') + '</p>');
  }
  return out.join('');
}
