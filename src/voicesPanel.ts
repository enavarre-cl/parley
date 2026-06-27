import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { PiperManager, PIPER_VOICE_CATALOG } from './piper/manager';
import { ChatterboxManager } from './chatterbox/manager';
import { listPiperVoices, removePiperVoice } from './piperVoices';
import { listChatterboxVoices, removeChatterboxVoice } from './chatterboxVoices';
import { voiceId, CHATTERBOX_LANGUAGES, CHATTERBOX_UI_LANGS } from './chatterbox/assets';
import { tr, resolvedLang } from './i18n';
import { errMsg } from './chatHelpers';

let openPanel: vscode.WebviewPanel | undefined;

/** Builds the Piper voice list (curated catalogue + which are already downloaded and their size). */
function piperState(voicesDir: string) {
  const downloaded = new Map(listPiperVoices(voicesDir).map((v) => [v.id, v.sizeBytes]));
  return PIPER_VOICE_CATALOG.map((v) => ({
    id: v.id, label: v.label, lang: v.lang,
    downloaded: downloaded.has(v.id), sizeBytes: downloaded.get(v.id) ?? 0,
  }));
}

function chatterboxState(chatterbox: ChatterboxManager) {
  return {
    installed: chatterbox.isInstalled(),
    running: chatterbox.isServerRunning(),
    voices: listChatterboxVoices(chatterbox.voicesDir()).map((v) => ({ id: v.id, label: v.label, sizeBytes: v.sizeBytes, source: v.source, language: v.language })),
  };
}

/** Picks a unique, safe id from a user-supplied voice name (appends -2, -3… on collision). */
function uniqueVoiceId(dir: string, name: string): string | null {
  const base = voiceId(name);
  if (!base) return null;
  let id = base;
  for (let n = 2; fs.existsSync(`${dir}/${id}.wav`); n++) id = `${base}-${n}`;
  return id;
}

/** Opens (or reveals) the neural-voice download/management panel (Piper catalogue + Chatterbox). */
export function openVoicesPanel(
  context: vscode.ExtensionContext,
  piper: PiperManager,
  chatterbox: ChatterboxManager,
  voicesDir: string,
  onChanged: () => void
): void {
  if (openPanel) { openPanel.reveal(); return; }

  const panel = vscode.window.createWebviewPanel(
    'jotflow.voices',
    tr('Voices'),
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  openPanel = panel;

  const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
  const nonce = crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  const csp = [`default-src 'none'`, `style-src ${panel.webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  // Language options for new voices — only Jotflow's UI languages, sorted A→Z by name, with the
  // global UI language (jotflow.language) preselected.
  const uiLang = resolvedLang();
  const defLang = (CHATTERBOX_UI_LANGS as readonly string[]).includes(uiLang) ? uiLang : 'en';
  const langOptions = [...CHATTERBOX_UI_LANGS]
    .sort((a, b) => CHATTERBOX_LANGUAGES[a].localeCompare(CHATTERBOX_LANGUAGES[b]))
    .map((code) => `<option value="${code}"${code === defLang ? ' selected' : ''}>${esc(CHATTERBOX_LANGUAGES[code])} (${code})</option>`).join('');

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
  <div class="cb-actions">
    <select id="piperSelect" class="cb-select"></select>
    <button id="piperDownload" class="btn-primary">⬇ ${esc(tr('Download'))}</button>
  </div>
  <table><tbody id="piperRows"></tbody></table>

  <h2 class="cb-head">Chatterbox (TTS) · ${esc(tr('voice cloning'))}</h2>
  <p class="sub">${esc(tr('Create a voice by cloning a short sample. Paste a YouTube URL and pick a time range, or use a local audio file.'))}</p>
  <div id="cbEngine"></div>
  <div id="cbForm" class="hidden">
    <div class="cb-range">
      <div class="cb-field"><label for="cbName">${esc(tr('Voice name'))}</label><input id="cbName" type="text" placeholder="${esc(tr('e.g. Morgan'))}" /></div>
      <div class="cb-field"><label for="cbLang">${esc(tr('Language'))}</label><select id="cbLang">${langOptions}</select></div>
    </div>
    <div class="cb-field"><label for="cbUrl">${esc(tr('YouTube URL'))}</label><input id="cbUrl" type="text" placeholder="https://www.youtube.com/watch?v=…" /></div>
    <div class="cb-range">
      <div class="cb-field"><label for="cbStart">${esc(tr('Start'))} (mm:ss)</label><input id="cbStart" type="text" placeholder="00:30" /></div>
      <div class="cb-field"><label for="cbEnd">${esc(tr('End'))} (mm:ss)</label><input id="cbEnd" type="text" placeholder="00:45" /></div>
    </div>
    <div class="cb-actions">
      <button id="cbCreateUrl" class="btn-primary">${esc(tr('Create from YouTube'))}</button>
      <button id="cbCreateFile" class="btn-secondary">${esc(tr('Add from file…'))}</button>
    </div>
    <div id="cbError" class="cb-error"></div>
    <p class="cb-warn">${esc(tr('Only use audio you have the rights to. Clips are capped at 30s.'))}</p>
    <table><tbody id="cbRows"></tbody></table>
  </div>

  <script nonce="${nonce}">window.VOICES_T = ${JSON.stringify({
    download: tr('Download'),
    delete: tr('Delete voice'),
    downloaded: tr('Downloaded voice'),
    downloading: tr('Downloading…'),
    allDownloaded: tr('All voices downloaded'),
    noneDownloaded: tr('No voices downloaded yet.'),
    install: tr('Install Chatterbox engine + model'),
    installing: tr('Installing…'),
    create: tr('Create from YouTube'),
    creating: tr('Creating voice…'),
    running: tr('running'),
    stopped: tr('stopped'),
    noVoices: tr('No voices yet.'),
    badName: tr('Enter a voice name.'),
    badUrl: tr('Enter a valid YouTube URL.'),
    badRange: tr('Enter a valid time range (mm:ss), end after start, ≤ 30s.'),
  })};</script>
  <script nonce="${nonce}" src="${media('voices.js')}"></script>
</body>
</html>`;

  const send = () => panel.webview.postMessage({ type: 'state', piper: piperState(voicesDir), chatterbox: chatterboxState(chatterbox) });

  const fail = (e: unknown) => { vscode.window.showErrorMessage(tr('Could not create the voice: ') + errMsg(e)); };

  panel.webview.onDidReceiveMessage(async (m: { type?: string; id?: string; url?: string; start?: string; end?: string; name?: string; language?: string }) => {
    if (m?.type === 'ready') { send(); return; }

    // ── Piper ──
    if (m?.type === 'piperRemove' && typeof m.id === 'string') {
      removePiperVoice(voicesDir, m.id); send(); onChanged(); return;
    }
    if (m?.type === 'piperDownload' && typeof m.id === 'string') {
      const id = m.id;
      if (!PIPER_VOICE_CATALOG.some((v) => v.id === id)) return; // fail-closed: catalogue voices only
      panel.webview.postMessage({ type: 'busy', scope: 'piper', id });
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Downloading voice: ') + id + ' …' },
          () => piper.ensureVoice(id)
        );
      } catch (e) { vscode.window.showErrorMessage(tr('Could not download voice: ') + errMsg(e)); }
      send(); onChanged(); return;
    }

    // ── Chatterbox ──
    if (m?.type === 'chatterboxInstall') {
      panel.webview.postMessage({ type: 'busy', scope: 'chatterbox' });
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Installing engine…') + ' (Chatterbox)' },
          (p) => chatterbox.install((msg) => p.report({ message: msg }))
        );
      } catch (e) { vscode.window.showErrorMessage(`Chatterbox: ${errMsg(e)}`); }
      send(); onChanged(); return;
    }
    if (m?.type === 'chatterboxRemove' && typeof m.id === 'string') {
      removeChatterboxVoice(chatterbox.voicesDir(), m.id); send(); onChanged(); return;
    }
    if (m?.type === 'chatterboxCreateUrl' && typeof m.url === 'string' && typeof m.name === 'string') {
      const id = uniqueVoiceId(chatterbox.voicesDir(), m.name);
      if (!id) { vscode.window.showErrorMessage(tr('Enter a voice name.')); return; }
      panel.webview.postMessage({ type: 'busy', scope: 'chatterbox' });
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Creating voice…') },
          (p) => chatterbox.createVoice({ id, label: m.name!.trim(), language: m.language, url: m.url, start: m.start, end: m.end }, (msg) => p.report({ message: msg }))
        );
      } catch (e) { fail(e); }
      send(); onChanged(); return;
    }
    if (m?.type === 'chatterboxCreateFile' && typeof m.name === 'string') {
      const id = uniqueVoiceId(chatterbox.voicesDir(), m.name);
      if (!id) { vscode.window.showErrorMessage(tr('Enter a voice name.')); return; }
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false, openLabel: tr('Use as voice sample'),
        filters: { Audio: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'aac'] },
      });
      if (!picked || !picked[0]) return;
      panel.webview.postMessage({ type: 'busy', scope: 'chatterbox' });
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: tr('Creating voice…') },
          (p) => chatterbox.createVoice({ id, label: m.name!.trim(), language: m.language, filePath: picked[0].fsPath }, (msg) => p.report({ message: msg }))
        );
      } catch (e) { fail(e); }
      send(); onChanged(); return;
    }
  });

  // Keep the panel's engine state fresh while the daemon starts/stops.
  const onCb = chatterbox.onDidChange(() => send());
  panel.onDidDispose(() => { onCb.dispose(); openPanel = undefined; });
}
