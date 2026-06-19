import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { PiperManager, PIPER_VOICE_CATALOG } from './piper/manager';
import { listPiperVoices, removePiperVoice } from './piperVoices';
import { tr } from './i18n';

let openPanel: vscode.WebviewPanel | undefined;

/** Builds the voice list (curated catalogue + which are already downloaded and their size). */
function voicesState(voicesDir: string) {
  const downloaded = new Map(listPiperVoices(voicesDir).map((v) => [v.id, v.sizeBytes]));
  return PIPER_VOICE_CATALOG.map((v) => ({
    id: v.id,
    label: v.label,
    lang: v.lang,
    downloaded: downloaded.has(v.id),
    sizeBytes: downloaded.get(v.id) ?? 0,
  }));
}

/** Opens (or reveals) the Piper (TTS) voice download/management panel. */
export function openVoicesPanel(
  context: vscode.ExtensionContext,
  piper: PiperManager,
  voicesDir: string,
  onChanged: () => void
): void {
  if (openPanel) { openPanel.reveal(); return; }

  const panel = vscode.window.createWebviewPanel(
    'langChat.voices',
    tr('Voices'),
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  openPanel = panel;

  const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
  const nonce = crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  const csp = [`default-src 'none'`, `style-src ${panel.webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${media('voices.css')}" rel="stylesheet" />
  <title>${esc(tr('Voices'))}</title>
</head>
<body>
  <h2>${esc(tr('Voices'))} · Piper (TTS)</h2>
  <p class="sub">${esc(tr('Download neural voices to read messages aloud. They are verified against a pinned checksum.'))}</p>
  <table><tbody id="rows"></tbody></table>
  <script nonce="${nonce}">window.VOICES_T = ${JSON.stringify({
    download: tr('Download'),
    delete: tr('Delete voice'),
    downloaded: tr('Downloaded voice'),
    downloading: tr('Downloading…'),
  })};</script>
  <script nonce="${nonce}" src="${media('voices.js')}"></script>
</body>
</html>`;

  const send = () => panel.webview.postMessage({ type: 'voices', voices: voicesState(voicesDir) });

  panel.webview.onDidReceiveMessage(async (m: any) => {
    if (m?.type === 'ready') { send(); return; }
    if (m?.type === 'remove' && typeof m.id === 'string') {
      removePiperVoice(voicesDir, m.id);
      send();
      onChanged();
      return;
    }
    if (m?.type === 'download' && typeof m.id === 'string') {
      const id = m.id;
      if (!PIPER_VOICE_CATALOG.some((v) => v.id === id)) return; // fail-closed: catalogue voices only
      panel.webview.postMessage({ type: 'busy', id });
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Downloading voice: ') + id + ' …' },
          () => piper.ensureVoice(id)
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(tr('Could not download voice: ') + (e?.message ?? e));
      }
      send();
      onChanged();
    }
  });

  panel.onDidDispose(() => { openPanel = undefined; });
}
