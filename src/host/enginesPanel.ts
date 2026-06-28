/** Engines management panel (WebviewPanel): one card per engine (Ollama, Piper, Chatterbox) with
 *  what/where/which-version it downloads, a live progress bar during install/start, action buttons,
 *  and the RAM each running engine is using. Replaces the cramped tree inline-icons + toast. */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { tr } from './i18n';
import { errMsg, makeNonce } from './chatHelpers';

export type EngineKey = 'ollama' | 'piper' | 'chatterbox';
export type EngineStatus = 'notinstalled' | 'stopped' | 'running' | 'busy';
/** Progress reporter passed to long actions: a message and an optional 0..1 fraction. */
export type Report = (msg: string, pct?: number) => void;

export interface EnginePanelEngine {
  key: EngineKey;
  name: string;
  kind: string;          // short subtitle, e.g. "Neural TTS · voice cloning"
  sources: string[];     // what/where/version lines
  state: () => { status: EngineStatus; detail?: string };
  pid: () => number | undefined;
  install?: (report: Report) => Promise<void>;
  update?: (report: Report) => Promise<void>;
  start?: (report: Report) => Promise<void>;
  stop?: () => void;
  remove?: () => Promise<boolean>; // returns false if the user cancelled the confirm
}

let openPanel: vscode.WebviewPanel | undefined;

/** Reads RSS (resident memory, bytes) of a pid via `ps`, or 0. */
function rssBytes(pid: number): Promise<number> {
  return new Promise((resolve) => {
    cp.execFile('ps', ['-o', 'rss=', '-p', String(pid)], (err, stdout) => {
      const kb = parseInt((stdout || '').trim(), 10);
      resolve(err || Number.isNaN(kb) ? 0 : kb * 1024);
    });
  });
}

export function openEnginesPanel(
  context: vscode.ExtensionContext,
  engines: EnginePanelEngine[],
  onChange: vscode.Event<void>
): void {
  if (openPanel) { openPanel.reveal(); return; }

  const panel = vscode.window.createWebviewPanel(
    'jotflow.engines',
    tr('Engines'),
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  openPanel = panel;

  const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
  const nonce = makeNonce();
  const csp = [`default-src 'none'`, `style-src ${panel.webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${media('engines.css')}" rel="stylesheet" />
  <title>${esc(tr('Engines'))}</title>
</head>
<body>
  <h2>${esc(tr('Engines'))}</h2>
  <p class="sub">${esc(tr('Install, run and manage the local engines. Downloads are verified and run on 127.0.0.1.'))}</p>
  <div id="cards" class="eng-cards"></div>
  <script nonce="${nonce}">window.ENGINES_T = ${JSON.stringify({
    notinstalled: tr('Not installed'), stopped: tr('Stopped'), running: tr('Running'), busy: tr('Working…'),
    install: tr('Install'), update: tr('Update'), start: tr('Start'), stop: tr('Stop'), remove: tr('Delete'),
    ram: tr('RAM'), sources: tr('Downloads'),
  })};</script>
  <script nonce="${nonce}" src="${media('dist/engines.js')}"></script>
</body>
</html>`;

  const find = (key: string) => engines.find((e) => e.key === key);

  const snapshot = () => engines.map((e) => {
    const st = e.state();
    return {
      key: e.key, name: e.name, kind: e.kind, sources: e.sources,
      status: st.status, detail: st.detail || '',
      canInstall: !!e.install && st.status === 'notinstalled',
      canUpdate: !!e.update && (st.status === 'stopped' || st.status === 'running'),
      canStart: !!e.start && st.status === 'stopped',
      canStop: !!e.stop && st.status === 'running',
      canRemove: !!e.remove && st.status !== 'notinstalled',
    };
  });
  const sendState = () => panel.webview.postMessage({ type: 'state', engines: snapshot() });

  // RAM polling while the panel is open (every 3s for running engines).
  const pollRam = async () => {
    for (const e of engines) {
      const pid = e.pid();
      const bytes = pid ? await rssBytes(pid) : 0;
      panel.webview.postMessage({ type: 'stats', key: e.key, rssBytes: bytes });
    }
  };
  const ramTimer = setInterval(() => void pollRam(), 3000);

  const run = async (key: string, action: 'install' | 'update' | 'start') => {
    const e = find(key);
    if (!e) return;
    const report: Report = (msg, pct) => panel.webview.postMessage({ type: 'progress', key, msg, pct: typeof pct === 'number' ? pct : null, active: true });
    panel.webview.postMessage({ type: 'progress', key, msg: '', pct: null, active: true });
    sendState();
    try {
      if (action === 'install' && e.install) await e.install(report);
      else if (action === 'update' && e.update) await e.update(report);
      else if (action === 'start' && e.start) await e.start(report);
    } catch (err) {
      vscode.window.showErrorMessage(`${e.name}: ${errMsg(err)}`);
    }
    panel.webview.postMessage({ type: 'progress', key, msg: '', pct: null, active: false });
    sendState();
    void pollRam();
  };

  panel.webview.onDidReceiveMessage(async (m: { type?: string; key?: string; action?: string }) => {
    if (m?.type === 'ready') { sendState(); void pollRam(); return; }
    if (m?.type !== 'action' || typeof m.key !== 'string') return;
    const e = find(m.key);
    if (!e) return;
    if (m.action === 'install' || m.action === 'update' || m.action === 'start') { await run(m.key, m.action); return; }
    if (m.action === 'stop' && e.stop) { e.stop(); sendState(); void pollRam(); return; }
    if (m.action === 'remove' && e.remove) { await e.remove(); sendState(); void pollRam(); return; }
  });

  const sub = onChange(() => sendState());
  panel.onDidDispose(() => { clearInterval(ramTimer); sub.dispose(); openPanel = undefined; });
}
