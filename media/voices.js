// Panel de descarga/gestión de voces Piper (TTS): tabla de voces curadas + descargar/borrar.
(function () {
  const vscode = acquireVsCodeApi();
  const T = window.VOICES_T || { download: 'Download', delete: 'Delete voice', downloaded: 'Downloaded', downloading: 'Downloading…' };
  const rows = document.getElementById('rows');
  const busy = new Set(); // ids en descarga (para deshabilitar el botón)

  function fmtBytes(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  function render(voices) {
    rows.innerHTML = '';
    for (const v of voices) {
      const tr = document.createElement('tr');

      const tdLabel = document.createElement('td');
      tdLabel.className = 'label';
      tdLabel.textContent = v.label;

      const tdStatus = document.createElement('td');
      tdStatus.className = 'status';
      if (busy.has(v.id)) tdStatus.textContent = T.downloading;
      else if (v.downloaded) tdStatus.textContent = '✓ ' + T.downloaded + (v.sizeBytes ? ' · ' + fmtBytes(v.sizeBytes) : '');

      const tdAct = document.createElement('td');
      tdAct.className = 'act';
      if (v.downloaded) {
        const del = document.createElement('button');
        del.className = 'del';
        del.title = T.delete;
        del.textContent = '🗑';
        del.addEventListener('click', () => vscode.postMessage({ type: 'remove', id: v.id }));
        tdAct.appendChild(del);
      } else {
        const dl = document.createElement('button');
        dl.className = 'dl';
        dl.disabled = busy.has(v.id);
        dl.textContent = busy.has(v.id) ? T.downloading : '⬇ ' + T.download;
        dl.addEventListener('click', () => {
          busy.add(v.id);
          dl.disabled = true;
          dl.textContent = T.downloading;
          tdStatus.textContent = T.downloading;
          vscode.postMessage({ type: 'download', id: v.id });
        });
        tdAct.appendChild(dl);
      }

      tr.appendChild(tdLabel);
      tr.appendChild(tdStatus);
      tr.appendChild(tdAct);
      rows.appendChild(tr);
    }
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;
    if (d.type === 'voices') { busy.clear(); render(d.voices || []); }
    else if (d.type === 'busy' && d.id) busy.add(d.id);
  });

  vscode.postMessage({ type: 'ready' });
})();
