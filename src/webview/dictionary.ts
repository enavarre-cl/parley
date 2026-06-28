// Personal dictionary management panel (a table of words + add/remove).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const T = window.DICT_T || { remove: 'Remove' };

  const wordInput = $('word');
  const rows = $('rows');
  const countEl = $('count');
  const emptyEl = $('empty');

  function add() {
    const w = wordInput.value.trim();
    if (!w) return;
    vscode.postMessage({ type: 'add', word: w });
    wordInput.value = '';
    wordInput.focus();
  }

  $('addBtn').addEventListener('click', add);
  wordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });

  function render(words) {
    rows.innerHTML = '';
    emptyEl.classList.toggle('hidden', words.length > 0);
    countEl.textContent = words.length + (words.length === 1 ? ' word' : ' words');
    for (const w of words) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.className = 'w';
      td.textContent = w;
      const tdb = document.createElement('td');
      tdb.className = 'act';
      const del = document.createElement('button');
      del.className = 'del';
      del.title = T.remove;
      del.textContent = '🗑';
      del.addEventListener('click', () => vscode.postMessage({ type: 'remove', word: w }));
      tdb.appendChild(del);
      tr.appendChild(td);
      tr.appendChild(tdb);
      rows.appendChild(tr);
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'words') render(ev.data.words || []);
  });

  vscode.postMessage({ type: 'ready' });
})();
