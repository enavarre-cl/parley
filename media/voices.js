// Neural-voice panel: Piper curated catalogue (download/delete) + Chatterbox (install engine,
// create a cloned voice from a local audio/video file with a start/end trim, delete). One IIFE panel.
(function () {
  const vscode = acquireVsCodeApi();
  const T = window.VOICES_T || {};
  const $ = (id) => document.getElementById(id);
  const piperRows = $('piperRows');
  const piperSelect = $('piperSelect');
  const piperDownload = $('piperDownload');
  const cbEngine = $('cbEngine');
  const cbForm = $('cbForm');
  const cbRows = $('cbRows');
  const piperBusy = new Set();   // piper ids downloading
  let cbBusy = false;            // chatterbox install/create in flight

  function fmtBytes(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  // ── Piper: a combo of downloadable voices + a Download button, and a list of downloaded ones ──
  function renderPiper(voices) {
    const notDl = voices.filter((v) => !v.downloaded);
    // Combo: voices not yet downloaded.
    if (piperSelect) {
      const prev = piperSelect.value;
      piperSelect.innerHTML = '';
      for (const v of notDl) {
        const o = document.createElement('option');
        o.value = v.id; o.textContent = v.label;
        piperSelect.appendChild(o);
      }
      if (!notDl.length) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = T.allDownloaded || '—';
        piperSelect.appendChild(o);
      } else if (notDl.some((v) => v.id === prev)) {
        piperSelect.value = prev;
      }
      piperSelect.disabled = !notDl.length;
    }
    if (piperDownload) {
      piperDownload.disabled = !notDl.length || piperBusy.size > 0;
      piperDownload.textContent = piperBusy.size ? T.downloading : '⬇ ' + T.download;
    }
    // List below: downloaded voices (+ any in-progress download).
    piperRows.innerHTML = '';
    const shown = voices.filter((v) => v.downloaded || piperBusy.has(v.id));
    if (!shown.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.className = 'status'; td.colSpan = 3; td.textContent = T.noneDownloaded;
      tr.appendChild(td); piperRows.appendChild(tr);
      return;
    }
    for (const v of shown) {
      const busy = piperBusy.has(v.id);
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.className = 'label';
      tdLabel.textContent = v.label + (v.lang ? '  ·  ' + v.lang : '');
      const tdStatus = document.createElement('td');
      tdStatus.className = 'status';
      tdStatus.textContent = busy ? T.downloading : (v.sizeBytes ? fmtBytes(v.sizeBytes) : '');
      const tdAct = document.createElement('td');
      tdAct.className = 'act';
      if (v.downloaded && !busy) {
        const del = document.createElement('button');
        del.className = 'del'; del.title = T.delete; del.textContent = '🗑';
        del.addEventListener('click', () => vscode.postMessage({ type: 'piperRemove', id: v.id }));
        tdAct.appendChild(del);
      }
      tr.appendChild(tdLabel); tr.appendChild(tdStatus); tr.appendChild(tdAct);
      piperRows.appendChild(tr);
    }
  }

  function wirePiper() {
    if (!piperDownload) return;
    piperDownload.addEventListener('click', () => {
      const id = piperSelect && piperSelect.value;
      if (!id) return;
      piperBusy.add(id);
      piperDownload.disabled = true; piperDownload.textContent = T.downloading;
      vscode.postMessage({ type: 'piperDownload', id });
    });
  }

  // ── Chatterbox ──
  function renderChatterbox(cb) {
    cbEngine.innerHTML = '';
    if (!cb.installed) {
      cbForm.classList.add('hidden');
      const btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.disabled = cbBusy;
      btn.textContent = cbBusy ? T.installing : '⬇ ' + T.install;
      btn.addEventListener('click', () => { cbBusy = true; btn.disabled = true; btn.textContent = T.installing; vscode.postMessage({ type: 'chatterboxInstall' }); });
      cbEngine.appendChild(btn);
      return;
    }
    cbForm.classList.remove('hidden');
    const status = document.createElement('div');
    status.className = 'cb-status';
    status.textContent = cb.running ? '● ' + (T.running || 'running') : '○ ' + (T.stopped || 'stopped');
    cbEngine.appendChild(status);
    renderCbVoices(cb.voices || []);
  }

  function renderCbVoices(voices) {
    cbRows.innerHTML = '';
    if (!voices.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.className = 'status'; td.colSpan = 2; td.textContent = T.noVoices;
      tr.appendChild(td); cbRows.appendChild(tr);
      return;
    }
    for (const v of voices) {
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.className = 'label';
      tdLabel.textContent = v.label + (v.language ? '  ·  ' + v.language : '') + (v.sizeBytes ? '  ·  ' + fmtBytes(v.sizeBytes) : '');
      const tdAct = document.createElement('td');
      tdAct.className = 'act';
      const del = document.createElement('button');
      del.className = 'del'; del.title = T.delete; del.textContent = '🗑';
      del.addEventListener('click', () => vscode.postMessage({ type: 'chatterboxRemove', id: v.id }));
      tdAct.appendChild(del);
      tr.appendChild(tdLabel); tr.appendChild(tdAct);
      cbRows.appendChild(tr);
    }
  }

  // mm:ss / ss / hh:mm:ss → seconds, or null.
  function parseTc(s) {
    const t = (s || '').trim();
    if (!/^\d{1,3}(:\d{1,2}){0,2}$/.test(t)) return null;
    const parts = t.split(':').map(Number);
    if (parts.length >= 2 && parts[parts.length - 1] > 59) return null;
    if (parts.length === 3 && parts[1] > 59) return null;
    return parts.reduce((a, p) => a * 60 + p, 0);
  }

  function wireForm() {
    const name = $('cbName'), start = $('cbStart'), end = $('cbEnd'), lang = $('cbLang');
    const createFile = $('cbCreateFile'), err = $('cbError');
    const showErr = (m) => { if (err) err.textContent = m || ''; };
    const language = () => (lang && lang.value) || 'en';
    // Don't disable the button here: the host opens the native file picker AFTER this, and only sends
    // a 'busy' message once a file is actually chosen — so a cancelled pick must leave the button live.
    createFile.addEventListener('click', () => {
      const nm = (name.value || '').trim();
      if (!nm) { showErr(T.badName); return; }
      const s = (start.value || '').trim(), e = (end.value || '').trim();
      // The range is optional, but if either field is filled both must form a valid window.
      if (s || e) {
        const a = parseTc(s), b = parseTc(e);
        if (a === null || b === null || b <= a) { showErr(T.badRange); return; }
      }
      showErr('');
      vscode.postMessage({ type: 'chatterboxCreateFile', name: nm, language: language(), start: s, end: e });
    });
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;
    if (d.type === 'state') {
      piperBusy.clear(); cbBusy = false;
      const createFile = $('cbCreateFile');
      if (createFile) createFile.disabled = false;
      renderPiper(d.piper || []);
      renderChatterbox(d.chatterbox || { installed: false, voices: [] });
    } else if (d.type === 'busy') {
      if (d.scope === 'piper' && d.id) piperBusy.add(d.id);
      else if (d.scope === 'chatterbox') { cbBusy = true; const cf = $('cbCreateFile'); if (cf) cf.disabled = true; }
    }
  });

  wireForm();
  wirePiper();
  vscode.postMessage({ type: 'ready' });
})();
