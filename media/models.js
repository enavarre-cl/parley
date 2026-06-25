// Model explorer (webview). Searches the configured source (Ollama library or Hugging Face) and
// downloads via Ollama. The host maps both sources onto the same model/file shapes used here.
(function () {
  const vscode = acquireVsCodeApi();
  const t = (s) => (window.LangI18n ? window.LangI18n.t(s) : s);
  const $ = (id) => document.getElementById(id);
  const listEl = $('mb-list');
  const detailEl = $('mb-detail');
  const searchEl = $('mb-search');

  let results = [];
  let selected = null;        // id of the selected model
  let downloadsState = [];     // snapshot of ALL downloads (sent by the panel)
  let lastQuery = '';
  let currentLimit = 30;
  const PAGE = 30;
  const MAX_LIMIT = 240;
  let lastFetchCount = 0; // number of results returned by HF (to know if there are more)
  let filterProvider = '';      // provider: server-side filter (HF author=)
  let officialOrgs = [];        // curated list of official orgs (sent by the backend)
  let sortBy = 'relevance';     // Best Match by default (like LM Studio)

  // Provider and sort order are filtered on the server. Capabilities are NOT filtered (only shown
  // as estimated badges): relying on a heuristic to hide results leads to inconsistencies.
  function visibleResults() { return results; }

  function renderFilters() {
    const fb = $('mb-filters');
    if (!fb) return;
    // Union of official orgs (always) + authors present in the results.
    const set = new Set([...officialOrgs, ...results.map((m) => m.author).filter(Boolean)]);
    if (filterProvider) set.add(filterProvider);
    const authors = [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    fb.innerHTML =
      `<select id="mb-provider" class="mb-select-sm">
         <option value="">${esc(t('All providers'))}</option>
         ${authors.map((a) => `<option value="${esc(a)}"${a === filterProvider ? ' selected' : ''}>${esc(a)}</option>`).join('')}
       </select>
       <select id="mb-sort" class="mb-select-sm mb-sort">
         ${[['relevance', 'Best Match'], ['likes', 'Most Likes'], ['downloads', 'Most Downloads'], ['modified', 'Recently Updated']]
        .map(([v, l]) => `<option value="${v}"${v === sortBy ? ' selected' : ''}>${esc(t(l))}</option>`).join('')}
       </select>`;
    const ss = $('mb-sort');
    if (ss) ss.addEventListener('change', () => { sortBy = ss.value; currentLimit = PAGE; doSearch(); });
    const ps = $('mb-provider');
    if (ps) ps.addEventListener('change', () => {
      filterProvider = ps.value;     // provider filter = server-side (HF author=)
      currentLimit = PAGE;
      doSearch();
    });
  }


  // --- Search (debounce) ---
  function doSearch() { vscode.postMessage({ type: 'search', query: lastQuery, limit: currentLimit, author: filterProvider, sort: sortBy }); }
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      lastQuery = searchEl.value.trim();
      currentLimit = PAGE; // new search → back to first page
      doSearch();
    }, 350);
  });


  function openModel(id) {
    selected = id;
    renderList();
    const sel = listEl.querySelector('.mb-row.sel');
    if (sel) sel.scrollIntoView({ block: 'center' });
    detailEl.innerHTML = `<div class="mb-muted">${esc(t('Loading…'))}</div>`;
    // We send the model (header) so the panel saves the FULL card in the sidecar.
    vscode.postMessage({ type: 'detail', id, model: results.find((r) => r.id === id) });
  }

  function renderList() {
    const vis = visibleResults();
    if (!vis.length) { listEl.innerHTML = `<div class="mb-muted">${esc(t('No results'))}</div>`; return; }
    listEl.innerHTML = '';
    for (const m of vis) {
      const row = document.createElement('div');
      row.className = 'mb-row' + (m.id === selected ? ' sel' : '');
      const desc = m.description || pipelineLabel(m.pipeline);
      const off = m.official ? ` <span class="mb-verified" title="${esc(t('Official'))}">✓</span>` : '';
      const cloud = m.cloud ? ` <span class="mb-cloud" title="${esc(t('Runs on Ollama Cloud (no local download)'))}">☁ ${esc(t('Cloud'))}</span>` : '';
      const params = m.params ? `${esc(m.params)} · ` : '';
      const ago = fmtAgo(m.updated);
      row.innerHTML =
        `<div class="mb-row-title">${esc(m.id)}${off}${cloud}</div>` +
        (desc ? `<div class="mb-row-desc">${esc(desc)}</div>` : '') +
        `<div class="mb-row-meta">${params}⬇ ${fmtNum(m.downloads)} · ★ ${fmtNum(m.likes)}${ago ? ` · ${esc(ago)}` : ''}</div>` +
        capBadges(m.capabilities, true);
      row.addEventListener('click', () => openModel(m.id));
      listEl.appendChild(row);
    }
    // "Load more": only if HF filled the page (there may be more) and we haven't reached the limit.
    if (lastFetchCount >= currentLimit && currentLimit < MAX_LIMIT) {
      const more = document.createElement('button');
      more.id = 'mb-more';
      more.className = 'mb-more';
      more.textContent = t('Load more');
      more.addEventListener('click', () => {
        more.disabled = true;
        more.textContent = t('Loading…');
        currentLimit = Math.min(currentLimit + PAGE, MAX_LIMIT);
        doSearch();
      });
      listEl.appendChild(more);
    }
  }

  function renderDetail(id, files, readme, info, modelOverride) {
    const m = modelOverride || results.find((r) => r.id === id) || { id, capabilities: {}, pipeline: '', params: '', domain: '', official: false };
    info = info || {};
    const desc = m.description || pipelineLabel(m.pipeline);
    const params = info.params || m.params || '';
    const metaRow =
      `<div class="mb-meta-row">` +
      (params ? `<span class="mb-meta"><b>${esc(t('Params'))}</b> ${esc(params)}</span>` : '') +
      (info.context ? `<span class="mb-meta"><b>${esc(t('Context'))}</b> ${esc(info.context)}</span>` : '') +
      (info.arch ? `<span class="mb-meta"><b>${esc(t('Arch'))}</b> ${esc(info.arch)}</span>` : '') +
      (m.domain ? `<span class="mb-meta"><b>${esc(t('Domain'))}</b> ${esc(m.domain)}</span>` : '') +
      `<span class="mb-meta"><b>${esc(t('Format'))}</b> GGUF</span>` +
      `</div>`;
    let opts;
    if (m.cloud) {
      // Cloud models aren't downloaded; registering pulls a tiny manifest stub (`name:cloud`) so the
      // model shows up locally and can be picked in chat — inference still runs on Ollama Cloud.
      opts = `<div class="mb-opt-picker">
        <button class="mb-dl" id="mb-cloud-reg">${esc(t('Register for cloud use'))}</button>
      </div>
      <div class="mb-reco">${esc(t('Runs on Ollama Cloud. Registering adds it to your model list (no weights downloaded); needs an Ollama API key — see Set API Key.'))}</div>`;
    } else if (!files.length) {
      opts = `<div class="mb-muted">${esc(t('No downloadable files found'))}</div>`;
    } else {
      const def = pickDefaultQuant(files);
      const anyRisky = files.some((f) => f.pullable === false);
      opts = `<div class="mb-opt-picker">
        <select id="mb-quant-select" class="mb-select">
          ${files.map((f, i) =>
        `<option value="${i}"${i === def ? ' selected' : ''}>${f.pullable === false ? '⚠ ' : ''}${esc(f.quant)} · ${fmtBytes(f.size)}${f.shards && f.shards.length > 1 ? ` · ${f.shards.length} ${esc(t('parts'))}` : ''}${i === def ? '   ★' : ''}</option>`).join('')}
        </select>
        <button class="mb-dl" id="mb-dl">${esc(t('Download'))}</button>
        <span class="mb-opt-count">${files.length} ${esc(t('quantizations'))}</span>
      </div>
      <div class="mb-reco">★ ${esc(t('Recommended'))}: <b>${esc(files[def].quant)}</b> · ${fmtBytes(files[def].size)}</div>`
        + (anyRisky ? `<div class="mb-warn">⚠ ${esc(t('Non-standard file names: it will be downloaded and imported into Ollama (no resume).'))}</div>` : '');
    }
    const ago = fmtAgo(m.updated);
    const stats =
      `<div class="mb-stats">` +
      `<span>⬇ ${fmtNum(m.downloads || 0)}</span>` +
      `<span>★ ${fmtNum(m.likes || 0)}</span>` +
      (ago ? `<span class="mb-stat-upd">${esc(t('Last updated'))}: ${esc(ago)}</span>` : '') +
      `</div>`;
    const summary = readmeSummary(readme) || desc;
    detailEl.classList.remove('empty');
    detailEl.innerHTML =
      `<div class="mb-content">
         <div class="mb-head">
           <h2>${esc(id)}</h2>
           ${m.official ? `<span class="mb-verified" title="${esc(t('Official'))}">✓ ${esc(t('Official'))}</span>` : ''}
           ${m.cloud ? `<span class="mb-cloud" title="${esc(t('Runs on Ollama Cloud (no local download)'))}">☁ ${esc(t('Cloud'))}</span>` : ''}
         </div>
         ${stats}
         ${summary ? `<div class="mb-desc-box">${esc(summary)}</div>` : ''}
         ${metaRow}
         ${detailCaps(m.capabilities)}
         <div class="mb-section-title">${esc(t('Download options'))}</div>
         <div class="mb-opts">${opts}</div>
         <div id="mb-progress" class="hidden"></div>
         <div class="mb-section-title">README</div>
         <div class="mb-readme">${renderReadme(readme)}</div>
       </div>`;
    const dl = $('mb-dl');
    if (dl) dl.addEventListener('click', () => {
      const sel = $('mb-quant-select');
      const f = files[Number(sel && sel.value)] || files[0];
      vscode.postMessage({ type: 'pull', id, quant: f.quant, size: f.size, pullable: f.pullable !== false, path: f.path, shards: f.shards || [] });
    });
    const reg = $('mb-cloud-reg');
    if (reg) reg.addEventListener('click', () =>
      vscode.postMessage({ type: 'pull', id, quant: 'cloud', size: 0, pullable: true, path: '', shards: [] }));
    renderDetailProgress(id); // shows progress ONLY if this model has a download
  }

  /** Most recent download associated with a model, or null. */
  function modelDownload(id) {
    const items = downloadsState.filter((d) => d.modelId === id);
    if (!items.length) return null;
    return items.find((d) => d.state === 'downloading') || items[items.length - 1];
  }

  function progressText(d) {
    const pct = typeof d.pct === 'number' ? d.pct : null;
    return (d.status || t('Downloading…')) + (pct != null ? ' ' + pct + '%' : '')
      + (d.total ? ` ${fmtBytes(d.received)} / ${fmtBytes(d.total)}` : '');
  }

  /**
   * Renders the download progress for THIS model (does not bleed into others). Important: while
   * "downloading" it does NOT recreate the button on each tick (only updates text/bar), otherwise
   * a click on Cancel would be lost between re-renders.
   */
  function renderDetailProgress(id) {
    const p = $('mb-progress');
    if (!p) return;
    const d = modelDownload(id);
    if (!d) { p.classList.add('hidden'); p.innerHTML = ''; p.dataset.k = ''; return; }
    p.classList.remove('hidden');
    const key = d.id + ':' + d.state;
    if (p.dataset.k === key && d.state === 'downloading') {
      const txt = p.querySelector('.mb-ptext'); if (txt) txt.textContent = progressText(d);
      const bar = p.querySelector('.mb-bar > div');
      if (bar && typeof d.pct === 'number') bar.style.width = d.pct + '%';
      return; // same structure → don't recreate buttons
    }
    p.dataset.k = key;
    let head = '', btns = [];
    if (d.state === 'queued') {
      head = `<span class="mb-spin"></span> <span class="mb-ptext">${esc(t('Queued'))}</span>`;
      btns = [['cancel', t('Cancel'), d.id]];
    } else if (d.state === 'downloading') {
      const pct = typeof d.pct === 'number' ? d.pct : null;
      // Width is set via JS after insertion (see below), not an inline style attribute, so the CSP
      // does not need style-src 'unsafe-inline' on the app's own DOM (H9).
      const bar = pct != null ? '<div class="mb-bar"><div></div></div>' : '';
      head = `<span class="mb-spin"></span> <span class="mb-ptext">${esc(progressText(d))}</span>${bar}`;
      btns = [['cancel', t('Cancel'), d.id]];
    } else if (d.state === 'done') {
      head = `✅ <span class="mb-ptext">${esc(t('Downloaded'))}</span>`;
      btns = [['use', t('Use in chat'), d.ref]];
    } else if (d.state === 'cancelled') {
      head = `⏹ <span class="mb-ptext">${esc(t('Cancelled'))}</span>`;
      btns = [['retry', t('Retry'), d.id]];
    } else if (d.state === 'interrupted') {
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      head = `⏸ <span class="mb-ptext">${esc(t('Interrupted'))} ${pct}%</span>`;
      btns = [['retry', t('Resume'), d.id]];
    } else {
      head = `⚠️ <span class="mb-ptext">${esc(d.error || t('Error'))}</span>`;
      btns = [['retry', t('Retry'), d.id]];
    }
    p.innerHTML = head + btns.map(([act, label, val]) =>
      ` <button class="mb-pbtn" data-act="${act}" data-val="${esc(val)}">${esc(label)}</button>`).join('');
    if (d.state === 'downloading' && typeof d.pct === 'number') {
      const fill = p.querySelector('.mb-bar > div');
      if (fill) fill.style.width = d.pct + '%';
    }
    p.querySelectorAll('.mb-pbtn').forEach((b) => b.addEventListener('click', () => {
      const act = b.getAttribute('data-act'); const val = b.getAttribute('data-val');
      if (act === 'cancel') vscode.postMessage({ type: 'cancelDownload', id: val });
      else if (act === 'retry') vscode.postMessage({ type: 'retryDownload', id: val });
      else if (act === 'use') vscode.postMessage({ type: 'useModel', name: val });
    }));
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    switch (msg.type) {
      case 'searchResults': {
        lastFetchCount = (msg.models || []).length;
        if (typeof msg.limit === 'number') currentLimit = msg.limit;
        if (Array.isArray(msg.officialOrgs) && msg.officialOrgs.length) officialOrgs = msg.officialOrgs;
        // We respect the order returned by HF according to the chosen criterion (Best Match / Likes / etc.).
        results = (msg.models || []).slice();
        renderFilters();
        const keepScroll = listEl.scrollTop;
        renderList();
        listEl.scrollTop = keepScroll; // on "load more" we don't jump to the top
        break;
      }
      case 'detail':
        if (msg.id === selected) renderDetail(msg.id, msg.files || [], msg.readme || '', msg.info || {});
        break;
      case 'showCachedLoading':
        detailEl.innerHTML = `<div class="mb-muted">${esc(t('Loading…'))}</div>`;
        break;
      case 'showCachedModel': {
        // Click on a download → shows the card WITHOUT altering the current search.
        const card = msg.card || {};
        if (!card.model) break;
        selected = card.model.id;
        // Re-renders the list: clears the previous selection and highlights ONLY if the model is
        // in the current results (does not inject anything or alter the search).
        renderList();
        const sel = listEl.querySelector('.mb-row.sel');
        if (sel) sel.scrollIntoView({ block: 'center' });
        renderDetail(card.model.id, card.files || [], card.readme || '', card.info || {}, card.model);
        break;
      }
      case 'downloads':
        // Snapshot of ALL downloads: refresh the progress of the currently viewed model.
        downloadsState = msg.items || [];
        if (selected) renderDetailProgress(selected);
        break;
      case 'error':
        listEl.innerHTML = `<div class="mb-muted">⚠️ ${esc(msg.message || '')}</div>`;
        break;
    }
  });

  // Initial search (popular GGUF models).
  lastQuery = '';
  currentLimit = PAGE;
  doSearch();
})();
