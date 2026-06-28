/**
 * Standalone HTML/PDF export of the conversation. Opened in the system browser with an auto-print
 * trigger behind a strict per-document CSP. Pure given the document: reads getDoc(), holds none of
 * conversation.js's streaming/scroll state.
 */
import { t } from '../core/i18n.js';
import { escapeHtml } from '../core/dom.js';
import { render as renderMarkdown } from '../render/markdown.js';
import { getDoc } from '../ui/store.js';

const EXPORT_CSS = `
    *{box-sizing:border-box;}
    body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:760px;margin:0 auto;padding:36px 22px 48px;color:#1a1a1a;background:#fff;line-height:1.6;}
    h1.title{font-size:22px;font-weight:700;margin:0 0 2px;}
    .sub{color:#8a8a8a;font-size:12.5px;margin:0 0 26px;border-bottom:1px solid #ececec;padding-bottom:16px;}
    .m{margin:16px 0;display:flex;flex-direction:column;page-break-inside:avoid;}
    .m.user{align-items:flex-end;}
    .who{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#a0a0a0;margin:0 8px 4px;}
    .bubble{max-width:80%;padding:10px 15px;border-radius:16px;overflow-wrap:anywhere;}
    .m.assistant .bubble{background:#f3f4f6;border-bottom-left-radius:5px;}
    .m.user .bubble{background:#2563eb;color:#fff;border-bottom-right-radius:5px;}
    .bubble p{margin:.45em 0;} .bubble p:first-child{margin-top:0;} .bubble p:last-child{margin-bottom:0;}
    .bubble h1,.bubble h2,.bubble h3{margin:.5em 0 .3em;line-height:1.25;}
    .bubble ul,.bubble ol{margin:.3em 0;padding-left:1.4em;}
    .bubble pre{background:#0d1117;color:#e6edf3;padding:11px 13px;border-radius:9px;overflow:auto;font-size:12.5px;margin:.5em 0;}
    .m.user .bubble pre{background:#16336e;}
    .bubble code{background:rgba(130,130,130,.18);padding:1px 5px;border-radius:5px;font-size:.9em;}
    .m.user .bubble code{background:rgba(255,255,255,.22);}
    .bubble pre code{background:none;padding:0;}
    .bubble img{max-width:100%;border-radius:10px;margin-top:8px;}
    .bubble a{color:inherit;}
    .bubble table{border-collapse:collapse;margin:.5em 0;font-size:.95em;} .bubble th,.bubble td{border:1px solid #d6d6d6;padding:4px 9px;}
    .bubble blockquote{border-left:3px solid #ccc;margin:.5em 0;padding-left:10px;opacity:.85;}
  `;

export function buildExportHtml() {
  const doc = getDoc();
    const msgs = (doc && doc.messages) || [];
    const visible = msgs.filter((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return false; // exclude 'tool'
      if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) return false; // tool intermediate
      const hasImg = (m.attachments || []).some((a) => a.kind === 'image');
      return (m.content && m.content.trim()) || hasImg; // exclude empty
    });
    let body = '';
    for (const m of visible) {
      const who = m.role === 'user' ? t('You') : t('Assistant');
      let imgs = '';
      for (const a of (m.attachments || [])) {
        // Escape mime and data: a hand-crafted .attach sidecar could inject markup
        // into the exported HTML (opened in the external browser).
        if (a.kind === 'image') imgs += `<img src="data:${escapeHtml(a.mime)};base64,${escapeHtml(a.data)}"/>`;
      }
      const inner = (m.content ? renderMarkdown(m.content) : '') + imgs;
      body += `<div class="m ${m.role}"><div class="who">${who}</div><div class="bubble">${inner}</div></div>`;
    }
    const title = (doc && doc.title) || 'Chat';
    const sub = `${(doc && doc.provider) || ''}${doc && doc.model ? ' · ' + doc.model : ''} · ${visible.length} ${t('messages')}`;
    // The standalone export is opened in the system browser (outside the webview CSP). The body is
    // already HTML-escaped (renderMarkdown), so the model can't inject script — but a strict CSP with
    // a nonce for the print trigger is defense-in-depth: it blocks frames/objects/fetch/forms and any
    // unexpected inline script while still allowing the auto-print and inline styles.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const csp = "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'; script-src 'nonce-" +
      nonce + "'; base-uri 'none'; form-action 'none'";
    return '<!DOCTYPE html><html lang="' + window.LangI18n.get() + '"><head><meta charset="utf-8"/>' +
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '"/><title>' + escapeHtml(title) +
      '</title><style>' + EXPORT_CSS + '</style></head><body>' +
      '<h1 class="title">' + escapeHtml(title) + '</h1><div class="sub">' + escapeHtml(sub) + '</div>' + body +
      '<script nonce="' + nonce + '">window.onload=function(){setTimeout(function(){window.print()},300)}</scr' + 'ipt></body></html>';
  }
