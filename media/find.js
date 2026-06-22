/**
 * In-chat find & replace (VS Code-style) for the webview. Self-contained; receives the vscode
 * API via PFind.setApi(). Exposed as window.PFind. Loaded before main.js.
 */
(function () {
  const t = (s) => window.LangI18n.t(s);
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  let vscode = { postMessage() {} }; // set by PFind.setApi()
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

  window.PFind = { setApi(v) { vscode = v; }, open: openFind, close: closeFind, refresh: refreshFind, setReplaceVisible };
})();
