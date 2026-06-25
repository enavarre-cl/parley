import * as vscode from 'vscode';
import { makeNonce } from './chatHelpers';

/**
 * Serializes a value for embedding inside an inline <script>. JSON.stringify does NOT escape
 * `</script>`, `<!--` or the line separators U+2028/U+2029, so a value containing `</script>`
 * (e.g. a malicious downloaded-voice filename) would break out of the script element. Escaping
 * `<` and `>` to \uXXXX keeps it a valid JS string literal and closes that hole.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Line icons (monochrome, inherit currentColor) for the toolbar and headers.
const SVG = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const UI = {
  printer: SVG('<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  bulb: SVG('<line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>'),
  wrench: SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  sliders: SVG('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  key: SVG('<circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.4 11.6 21 2"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  refresh: SVG('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  clip: SVG('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  smile: SVG('<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>'),
  zoomIn: SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>'),
  zoomOut: SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>'),
};

/** Builds the chat webview HTML (CSP + DOM + script/style tags). Pure given its inputs. */
export function renderWebviewHtml(
  webview: vscode.Webview,
  opts: { extensionUri: vscode.Uri; lang: string; bundle: Record<string, string>; downloadedVoices: string[]; piperCustomSet: boolean }
): string {
  const { extensionUri, lang, bundle, downloadedVoices, piperCustomSet } = opts;
    const nonce = makeNonce();
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
    const csp = [
      `default-src 'none'`,
      // style-src 'unsafe-inline' is required ONLY by the vendored Mermaid renderer: its generated
      // SVG carries a <style> block (no nonce) AND per-node inline `style=` attributes, and inline
      // style ATTRIBUTES cannot be authorised by a nonce or hash — only by 'unsafe-inline'. The
      // extension's own DOM no longer relies on it (H9). The residual risk is bounded: script-src is
      // nonce + strict-dynamic locked (no script injection), default-src is 'none', and connect-src
      // is limited to the webview origin, so CSS-only injection has no exfiltration channel. Fully
      // removing it would require rendering Mermaid inside a sandboxed iframe (a rewrite of the
      // pan/zoom/sizing/copy-as-image viewer), tracked as a follow-up rather than done blindly here.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // 'strict-dynamic': the nonce'd module entry (app/main.js) statically imports the rest of the
      // webview modules; strict-dynamic propagates trust to those imports (they carry no nonce).
      `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: blob:`,
      `media-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource}`, // fetch of spell-checker dictionaries
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri('style.css')}" rel="stylesheet" />
  <link href="${uri('find.css')}" rel="stylesheet" />
  <link href="${uri('messages.css')}" rel="stylesheet" />
  <link href="${uri('composer.css')}" rel="stylesheet" />
  <link href="${uri('conversation.css')}" rel="stylesheet" />
  <title>Jotflow</title>
</head>
<body>
  <div id="app">
    <header id="topbar">
      <span id="statusDot" class="checking"></span>
      <span id="statusText">…</span>
      <span id="modelCaps"></span>
      <span id="usageChip" data-i18n-title="Tokens used in this chat" title="Tokens used in this chat"></span>
      <span id="spacer"></span>
      <span id="zoomGroup">
        <button id="zoomOutBtn" class="icon-btn" data-i18n-title="Zoom out (Alt/Option + wheel)" title="Zoom out (Alt/Option + wheel)">${UI.zoomOut}</button>
        <button id="zoomResetBtn" class="icon-btn" data-i18n-title="Reset zoom (Alt/Option + 0)" title="Reset zoom (Alt/Option + 0)">100%</button>
        <button id="zoomInBtn" class="icon-btn" data-i18n-title="Zoom in (Alt/Option + wheel)" title="Zoom in (Alt/Option + wheel)">${UI.zoomIn}</button>
      </span>
      <button id="exportBtn" class="icon-btn" data-i18n-title="Export to PDF (print)" title="Export to PDF (print)">${UI.printer}</button>
      <button id="thinkBtn" class="icon-btn" data-i18n-title="Reasoning panel" title="Reasoning panel">${UI.bulb}</button>
      <button id="toolsBtn" class="icon-btn" data-i18n-title="Tools panel" title="Tools panel">${UI.wrench}</button>
      <button id="configBtn" class="icon-btn" data-i18n-title="This chat's settings" title="This chat's settings">${UI.sliders}</button>
      <button id="settingsBtn" class="icon-btn" data-i18n-title="Connection settings (API keys / URLs)" title="Connection settings (API keys / URLs)">${UI.key}</button>
    </header>

    <div id="workspace">
      <div id="chat">
        <div id="findBar" class="hidden">
          <button id="findToggleReplace" class="find-toggle" aria-expanded="false" data-i18n-title="Toggle Replace" title="Toggle Replace">›</button>
          <div class="find-rows">
            <div class="find-row">
              <div class="find-field">
                <input id="findInput" type="text" spellcheck="false" data-i18n-ph="Find" placeholder="Find" />
                <div class="find-field-opts">
                  <button id="optMatchCase" class="find-opt" aria-pressed="false" data-i18n-title="Match Case" title="Match Case">Aa</button>
                  <button id="optWholeWord" class="find-opt" aria-pressed="false" data-i18n-title="Match Whole Word" title="Match Whole Word"><u>ab</u></button>
                  <button id="optRegex" class="find-opt" aria-pressed="false" data-i18n-title="Use Regular Expression" title="Use Regular Expression">.*</button>
                </div>
              </div>
              <span id="findCount"></span>
              <button id="findPrev" class="icon-btn" data-i18n-title="Previous match (Shift+Enter)" title="Previous match (Shift+Enter)">▲</button>
              <button id="findNext" class="icon-btn" data-i18n-title="Next match (Enter)" title="Next match (Enter)">▼</button>
              <button id="findClose" class="icon-btn" data-i18n-title="Close (Esc)" title="Close (Esc)">×</button>
            </div>
            <div id="findReplaceRow" class="find-row hidden">
              <div class="find-field">
                <input id="replaceInput" type="text" spellcheck="false" data-i18n-ph="Replace" placeholder="Replace" />
                <div class="find-field-opts">
                  <button id="optPreserveCase" class="find-opt" aria-pressed="false" data-i18n-title="Preserve Case" title="Preserve Case">AB</button>
                </div>
              </div>
              <button id="replaceOne" class="icon-btn" data-i18n-title="Replace (Enter)" title="Replace (Enter)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5v5a3 3 0 0 0 3 3h7"/><polyline points="12 9 16 13 12 17"/></svg></button>
              <button id="replaceAll" class="icon-btn" data-i18n-title="Replace All (⌘/Ctrl+Enter)" title="Replace All (⌘/Ctrl+Enter)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v4a3 3 0 0 0 3 3h8"/><polyline points="12 8 15 11 12 14"/><path d="M4 14v2a3 3 0 0 0 3 3h8"/><polyline points="12 16 15 19 12 22"/></svg></button>
            </div>
          </div>
        </div>
        <main id="messages"></main>
        <footer id="composer">
          <div id="notices"></div>
          <div id="ctxBar" class="hidden" data-i18n-title="Context window usage" title="Context window usage">
            <div id="ctxTrack"><div id="ctxFill"></div></div>
            <span id="ctxLabel"></span>
          </div>
          <div id="inputBox">
            <div id="emojiPicker" class="hidden"></div>
            <div id="attachments" class="hidden"></div>
            <div id="inputWrap">
              <div id="inputBackdrop" aria-hidden="true"></div>
              <textarea id="input" rows="1" spellcheck="false" data-i18n-ph="Type a message…  (Enter to send · Shift+Enter for newline)" placeholder="Type a message…  (Enter to send · Shift+Enter for newline)"></textarea>
            </div>
            <div id="inputToolbar">
              <button id="attachBtn" class="icon-btn" data-i18n-title="Attach image or file" title="Attach image or file">${UI.clip}</button>
              <button id="emojiBtn" class="icon-btn" title="Emojis">${UI.smile}</button>
              <span class="grow"></span>
              <button id="stopBtn" class="hidden" data-i18n-title="Stop" title="Stop">■</button>
              <button id="sendBtn" data-i18n-title="Send" title="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
            </div>
          </div>
          <input id="fileInput" type="file" multiple accept="image/*,application/pdf,.pdf,.docx,.doc,.txt,.md,.json,.csv,.js,.ts,.tsx,.py,.java,.c,.cpp,.go,.rs,.rb,.php,.html,.css,.xml,.yaml,.yml,.toml,.ini,.sh,.sql,.log" />
        </footer>
      </div>

      <div id="sidepanels" class="hidden">
        <section id="config" class="hidden">
          <div class="panel-head">
            <span>⚙ <span data-i18n="Settings">Settings</span></span>
            <button id="configClose" class="icon-btn" data-i18n-title="Hide" title="Hide">×</button>
          </div>
          <div id="configBody">
            <div class="cfg-row">
              <label>Backend</label>
              <select id="providerSelect" title="Backend">
                <option value="openai">LM Studio / OpenAI</option>
                <option value="ollama">Ollama</option>
                <option value="gemini">Google Gemini</option>
                <option value="anthropic">Anthropic Claude</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>
            <div class="cfg-row">
              <label data-i18n="Model">Model</label>
              <div id="modelRow">
                <select id="modelSelect" data-i18n-title="Model" title="Model"></select>
                <span id="modelCtx" data-i18n-title="Model context window" title="Model context window"></span>
                <button id="refreshBtn" class="icon-btn" data-i18n-title="Reload models" title="Reload models">${UI.refresh}</button>
              </div>
            </div>
            <div class="cfg-row">
              <label data-i18n="Spell-check">Spell-check</label>
              <select id="spellSelect" data-i18n-title="Spell-check language" title="Spell-check language">
                <option value="auto" data-i18n="Automatic (system)">Automatic (system)</option>
                <option value="off" data-i18n="Off">Off</option>
                <option value="en">English</option>
                <option value="es">Español</option>
                <option value="pt">Português</option>
                <option value="fr">Français</option>
                <option value="de">Deutsch</option>
                <option value="it">Italiano</option>
              </select>
            </div>
            <div id="configFields"></div>
          </div>
        </section>

        <aside id="thinking" class="hidden">
          <div class="panel-head">
            <span>${UI.bulb} <span data-i18n="Reasoning">Reasoning</span></span>
            <button id="thinkClose" class="icon-btn" data-i18n-title="Hide" title="Hide">×</button>
          </div>
          <div id="thinkContent" class="empty" data-i18n="The model's reasoning will appear here.">The model's reasoning will appear here.</div>
        </aside>

        <aside id="tools" class="hidden">
          <div class="panel-head">
            <span>${UI.wrench} <span data-i18n="Tools">Tools</span></span>
            <button id="toolsClose" class="icon-btn" data-i18n-title="Hide" title="Hide">×</button>
          </div>
          <div id="toolsContent" class="empty" data-i18n="Tool calls will appear here.">Tool calls will appear here.</div>
        </aside>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">window.SPELL_DICTS = {
    es: { aff: '${uri('dict/es.aff')}', dic: '${uri('dict/es.dic')}' },
    en: { aff: '${uri('dict/en.aff')}', dic: '${uri('dict/en.dic')}' },
    pt: { aff: '${uri('dict/pt.aff')}', dic: '${uri('dict/pt.dic')}' },
    fr: { aff: '${uri('dict/fr.aff')}', dic: '${uri('dict/fr.dic')}' },
    de: { aff: '${uri('dict/de.aff')}', dic: '${uri('dict/de.dic')}' },
    it: { aff: '${uri('dict/it.aff')}', dic: '${uri('dict/it.dic')}' }
  };
  window.DOWNLOADED_VOICES = ${jsonForScript(downloadedVoices)};
  window.PIPER_CUSTOM_SET = ${jsonForScript(piperCustomSet)};
  window.I18N_LANG = ${jsonForScript(lang)};
  window.I18N_BUNDLE = ${jsonForScript(bundle)};
  window.MERMAID_SRC = '${uri('mermaid.min.js')}'; // lazy-loaded on first Mermaid block
  window.JOTFLOW_NONCE = '${nonce}';                // so the lazy <script> passes the CSP</script>
  <!-- Classic scripts set window globals (LangZoom / LangI18n / LangSpell) consumed by the modules. -->
  <script nonce="${nonce}" src="${uri('zoom.js')}"></script>
  <script nonce="${nonce}" src="${uri('i18n.js')}"></script>
  <script nonce="${nonce}" src="${uri('spell-engine.js')}"></script>
  <script nonce="${nonce}" src="${uri('spell.js')}"></script>
  <!-- ES module entry: imports the full webview module graph (deferred → runs after the classics). -->
  <script type="module" nonce="${nonce}" src="${uri('app/main.js')}"></script>
</body>
</html>`;
}
