import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { SpellWordsStore, SpellLang, SPELL_LANG_NAMES } from './spellWords';
import { tr } from './i18n';

const openPanels: Partial<Record<SpellLang, vscode.WebviewPanel>> = {};

/** Opens (or reveals) the personal dictionary management panel for a language. */
export function openDictionaryPanel(context: vscode.ExtensionContext, store: SpellWordsStore, lang: SpellLang): void {
  const existing = openPanels[lang];
  if (existing) { existing.reveal(); return; }

  const langName = SPELL_LANG_NAMES[lang] || lang;
  const panel = vscode.window.createWebviewPanel(
    'parley.dictionary',
    `${tr('Dictionary')}: ${langName}`,
    vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  openPanels[lang] = panel;

  const media = (f: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
  const nonce = crypto.randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  const csp = [`default-src 'none'`, `style-src ${panel.webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link href="${media('dictionary.css')}" rel="stylesheet" />
  <title>${esc(tr('Dictionary'))}</title>
</head>
<body>
  <h2>${esc(tr('Personal dictionary'))} · ${esc(langName)}</h2>
  <p class="sub">${esc(tr('Words you add here stop being marked as misspelled. The base dictionary is not affected.'))}</p>
  <div id="addRow">
    <input id="word" type="text" spellcheck="false" placeholder="${esc(tr('Add a word…'))}" />
    <button id="addBtn">${esc(tr('Add'))}</button>
  </div>
  <div id="count" class="sub"></div>
  <table><tbody id="rows"></tbody></table>
  <div id="empty" class="empty hidden">${esc(tr('No words yet.'))}</div>
  <script nonce="${nonce}">window.DICT_T = ${JSON.stringify({ remove: tr('Remove') })};</script>
  <script nonce="${nonce}" src="${media('dictionary.js')}"></script>
</body>
</html>`;

  const send = async () => panel.webview.postMessage({ type: 'words', words: await store.list(lang) });
  const sub = store.onDidChange(() => { void send(); });
  panel.webview.onDidReceiveMessage(async (m: any) => {
    if (m?.type === 'ready') await send();
    else if (m?.type === 'add' && typeof m.word === 'string') await store.add(lang, m.word);
    else if (m?.type === 'remove' && typeof m.word === 'string') await store.remove(lang, m.word);
  });
  panel.onDidDispose(() => { sub.dispose(); delete openPanels[lang]; });
}
