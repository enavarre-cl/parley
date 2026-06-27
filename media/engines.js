// Engines panel: one card per engine with status, download sources, RAM, a live progress bar and
// action buttons. Driven by the host via postMessage. Small standalone IIFE panel.
(function () {
  const vscode = acquireVsCodeApi();
  const T = window.ENGINES_T || {};
  const cards = document.getElementById('cards');
  let engines = [];
  const progress = {}; // key -> { msg, pct, active }
  const ram = {};      // key -> bytes

  function fmtBytes(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
  }

  function badge(status) {
    const b = document.createElement('span');
    b.className = 'eng-badge eng-' + status;
    b.textContent = status === 'running' ? T.running : status === 'stopped' ? T.stopped : status === 'busy' ? T.busy : T.notinstalled;
    return b;
  }

  function button(label, action, key, primary) {
    const btn = document.createElement('button');
    btn.className = primary ? 'btn-primary' : 'btn-secondary';
    btn.textContent = label;
    btn.addEventListener('click', () => vscode.postMessage({ type: 'action', key, action }));
    return btn;
  }

  function render() {
    cards.innerHTML = '';
    for (const e of engines) {
      const p = progress[e.key] || {};
      const card = document.createElement('div');
      card.className = 'eng-card';

      const head = document.createElement('div');
      head.className = 'eng-head';
      const title = document.createElement('div');
      title.className = 'eng-title';
      const nm = document.createElement('span');
      nm.className = 'eng-name';
      nm.textContent = e.name;
      const kind = document.createElement('span');
      kind.className = 'eng-kind';
      kind.textContent = e.kind;
      title.appendChild(nm); title.appendChild(kind);
      head.appendChild(title);
      head.appendChild(badge(p.active ? 'busy' : e.status));
      card.appendChild(head);

      // Downloads (what / where / version).
      const src = document.createElement('div');
      src.className = 'eng-sources';
      const sl = document.createElement('div');
      sl.className = 'eng-sources-label';
      sl.textContent = T.sources;
      src.appendChild(sl);
      for (const s of e.sources || []) {
        const li = document.createElement('div');
        li.className = 'eng-source';
        li.textContent = s;
        src.appendChild(li);
      }
      card.appendChild(src);

      // RAM (when running).
      if (e.status === 'running' && ram[e.key]) {
        const r = document.createElement('div');
        r.className = 'eng-ram';
        r.textContent = T.ram + ': ' + fmtBytes(ram[e.key]);
        card.appendChild(r);
      }

      // Progress (when a task is active).
      if (p.active) {
        const bar = document.createElement('div');
        bar.className = 'eng-bar' + (p.pct == null ? ' indeterminate' : '');
        const fill = document.createElement('div');
        fill.className = 'eng-bar-fill';
        if (p.pct != null) fill.style.width = Math.round(p.pct * 100) + '%';
        bar.appendChild(fill);
        card.appendChild(bar);
        if (p.msg) {
          const msg = document.createElement('div');
          msg.className = 'eng-progress-msg';
          msg.textContent = p.pct != null ? Math.round(p.pct * 100) + '% · ' + p.msg : p.msg;
          card.appendChild(msg);
        }
      } else if (e.detail) {
        const d = document.createElement('div');
        d.className = 'eng-progress-msg';
        d.textContent = e.detail;
        card.appendChild(d);
      }

      // Actions. Install/Start/Update are hidden while a task runs; Stop and Delete stay available
      // so the panel can always recover (and aren't blocked by a stuck progress state).
      const acts = document.createElement('div');
      acts.className = 'eng-actions';
      if (!p.active) {
        if (e.canInstall) acts.appendChild(button('⬇ ' + T.install, 'install', e.key, true));
        if (e.canStart) acts.appendChild(button('▶ ' + T.start, 'start', e.key, true));
        if (e.canUpdate) acts.appendChild(button('↻ ' + T.update, 'update', e.key, false));
      }
      if (e.canStop) acts.appendChild(button('■ ' + T.stop, 'stop', e.key, false));
      if (e.canRemove) acts.appendChild(button('🗑 ' + T.remove, 'remove', e.key, false));
      card.appendChild(acts);

      cards.appendChild(card);
    }
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;
    if (d.type === 'state') { engines = d.engines || []; render(); }
    else if (d.type === 'progress') { progress[d.key] = { msg: d.msg, pct: d.pct, active: d.active }; render(); }
    else if (d.type === 'stats') { ram[d.key] = d.rssBytes || 0; render(); }
  });

  vscode.postMessage({ type: 'ready' });
})();
