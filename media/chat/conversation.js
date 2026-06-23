/**
 * Conversation rendering: full re-render (renderConversation), incremental streaming render,
 * side panels (reasoning/tools), scroll anchoring, and PDF/HTML export.
 */
import { t } from '../core/i18n.js';
import { vscode } from '../core/vscode.js';
import { $, escapeHtml, iconButton } from '../core/dom.js';
import { ICONS } from '../core/icons.js';
import { render as renderMarkdown, renderRaw as renderMarkdownImpl } from '../render/markdown.js';
import { processMermaid } from '../render/mermaid.js';
import { getDoc } from '../ui/store.js';
import { tts } from '../features/tts.js';
import { refreshFind } from '../features/find.js';
import { lastNStart } from '../panels/models.js';
import { addMessage, bindThinking, disarmDelete } from './message.js';

const messagesEl = $('messages');
const configPanel = $('config');
const thinkPanel = $('thinking');
const thinkContent = $('thinkContent');
const toolsPanel = $('tools');
const toolsContent = $('toolsContent');
const sidepanels = $('sidepanels');

// ---- Streaming state (owned here; the protocol drives it via the stream* functions) ----
let streamingEl = null;
let streamingText = '';
let thinkingText = ''; // reasoning for the current turn
let toolsLive = []; // tool activity for the current turn
  let rafQueued = false;
  let pendingBody = false;
  let pendingThink = false;
  let streamCommitLen = 0;   // chars of streamingText already committed to the stable part
  let streamStableEl = null; // holds the finalized blocks (never re-touched)
  let streamTailEl = null;   // holds the current open block (re-rendered per frame)
  // Largest offset in `text` that ends on a block boundary (a blank line OUTSIDE a code fence), so
  // everything before it is a run of complete markdown blocks safe to render once and keep.
  function stableSplit(text) {
    const lines = text.split('\n');
    let offset = 0, inFence = false, lastSafe = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) inFence = !inFence;
      // Re-add the '\n' that split() removed — but NOT after the last element (there is no trailing
      // newline). Counting it overshot `lastSafe` past text.length when the text ended in '\n\n', so
      // streamCommitLen advanced too far and the next char fell into the gap (a clipped first letter,
      // e.g. "Jenny" → "enny", until the final whole-text render).
      offset += line.length + (i < lines.length - 1 ? 1 : 0);
      // A blank line is a settled block boundary ONLY when a line follows it: committing a blank
      // line that is currently the LAST line would freeze a not-yet-finished block (a table whose
      // separator/rows haven't arrived, a multi-line list/blockquote) as separate one-line <p>s for
      // the rest of the stream. Requiring a following line also keeps lastSafe ≤ text.length.
      if (!inFence && /^\s*$/.test(line) && i < lines.length - 1) lastSafe = offset;
    }
    return lastSafe;
  }
  function renderStreamBody(body, text) {
    if (!body) return;
    if (streamStableEl == null || streamStableEl.parentNode !== body) {
      body.innerHTML = '';
      streamStableEl = document.createElement('div'); streamStableEl.className = 'stream-part';
      streamTailEl = document.createElement('div'); streamTailEl.className = 'stream-part';
      body.appendChild(streamStableEl); body.appendChild(streamTailEl);
      streamCommitLen = 0;
    }
    const commit = stableSplit(text);
    if (commit > streamCommitLen) {
      // Parse ONLY the newly-completed blocks and append; the stable DOM is never re-touched.
      streamStableEl.insertAdjacentHTML('beforeend', renderMarkdownImpl(text.slice(streamCommitLen, commit)));
      streamCommitLen = commit;
    }
    streamTailEl.innerHTML = renderMarkdownImpl(text.slice(streamCommitLen)); // small open tail only
  }
  function resetStreamRender() { streamCommitLen = 0; streamStableEl = null; streamTailEl = null; }
  function flushStreamRender() {
    rafQueued = false;
    if (pendingBody && streamingEl) {
      pendingBody = false;
      renderStreamBody(streamingEl.querySelector('.body'), streamingText);
      scrollDown();
    }
    if (pendingThink) {
      pendingThink = false;
      showThinking(thinkingText);
    }
  }
  function queueStreamRender() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(flushStreamRender);
  }

// ---- Side panels ----
  function updateSide() {
    const open = !configPanel.classList.contains('hidden')
      || !thinkPanel.classList.contains('hidden')
      || !toolsPanel.classList.contains('hidden');
    sidepanels.classList.toggle('hidden', !open);
  }
  function openThink() { thinkPanel.classList.remove('hidden'); updateSide(); }
  function openTools() { toolsPanel.classList.remove('hidden'); updateSide(); }

  // Renders a list of tool activity in the panel.
  function showTools(activity) {
    toolsContent.innerHTML = '';
    if (!activity || !activity.length) {
      toolsContent.classList.add('empty');
      toolsContent.textContent = t('No tool activity.');
      return;
    }
    toolsContent.classList.remove('empty');
    for (const a of activity) {
      const item = document.createElement('div');
      item.className = 'tool-item';
      const head = document.createElement('div');
      head.className = 'tool-item-head';
      head.innerHTML = ICONS.tool + '<span>' + escapeHtml(a.name) + '</span>';
      item.appendChild(head);
      if (a.args && a.args !== '{}') {
        const args = document.createElement('div');
        args.className = 'tool-args';
        args.textContent = a.args;
        item.appendChild(args);
      }
      if (a.result !== undefined) {
        const pre = document.createElement('pre');
        pre.textContent = a.result;
        item.appendChild(pre);
      }
      toolsContent.appendChild(item);
    }
    toolsContent.scrollTop = toolsContent.scrollHeight;
  }
  function showThinking(text) {
    if (text) {
      thinkContent.innerHTML = renderMarkdownImpl(text); // called per-frame during reasoning: no cache
      thinkContent.classList.remove('empty');
    } else {
      thinkContent.textContent = t('This message has no reasoning.');
      thinkContent.classList.add('empty');
    }
    thinkContent.scrollTop = thinkContent.scrollHeight;
  }

  function banner(text, isError) {
    const el = document.createElement('div');
    el.className = 'banner' + (isError ? ' error' : '');
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollDown();
  }

  let suppressScroll = false; // prevents auto-scroll during a bulk re-render
  let stickToBottom = true;   // follow the bottom while text arrives; disabled when the user scrolls up
  function scrollDown() {
    if (suppressScroll || !stickToBottom) return; // if the user scrolled up, don't drag them to the bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  // The user is in control. A wheel/trackpad scroll-up detaches IMMEDIATELY and synchronously — this
  // beats the per-token auto-scroll, so an arriving character can't yank you back down. (The old code
  // only recomputed on the 'scroll' event with an 80px band, which lost this race → the "tug of war".)
  messagesEl.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) stickToBottom = false; // scrolling up to read → stop following the stream
  }, { passive: true });
  // Re-attach only once scrolled (back) to the very bottom. The tiny threshold means any scroll-up
  // stays detached instead of fighting inside a dead-zone band.
  messagesEl.addEventListener('scroll', () => {
    stickToBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 4;
  });

let summaryOpen = false; // is the summary bubble expanded?
export function renderConversation() {
  const doc = getDoc();
    disarmDelete(); // the trash buttons are about to be recreated → cancel any pending two-step delete
    // If a message that no longer exists (was deleted) is being read, stop the audio.
    if (tts.busy() && tts.msgId && doc && !(doc.messages || []).some((m) => m.id === tts.msgId)) {
      tts.stop();
    }
    // Preserve the user's scroll position (unless they were at the bottom). Anchor to the message
    // nearest the top of the viewport + its on-screen offset, so a height change in the rebuild
    // (e.g. an edit textarea collapsing back to rendered text) doesn't make the scroll jump.
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
    const prevTop = messagesEl.scrollTop;
    let scrollAnchor = null;
    if (!atBottom) {
      const viewTop = messagesEl.getBoundingClientRect().top;
      for (const el of messagesEl.querySelectorAll('.msg[data-msg-index]')) {
        const a = /** @type {HTMLElement} */ (el);
        const r = a.getBoundingClientRect();
        if (r.bottom > viewTop + 1) { scrollAnchor = { index: a.dataset.msgIndex, offset: r.top - viewTop }; break; }
      }
    }
    messagesEl.innerHTML = '';
    if (!doc) return;
    suppressScroll = true;
    const visible = doc.messages.filter((m) => m.role !== 'system');
    if (visible.length === 0) {
      banner(t('Empty chat. Type below to start.') + '  ·  ' + t('Model:') + ' ' + (doc.model || '—'));
    }
    // Hidden messages (intermediate assistant with tool_calls, and 'tool' messages) do not count
    // as "last": the last displayable one is the one that receives the regenerate/generate buttons.
    const displayable = (mm) => !((mm.role === 'assistant' && Array.isArray(mm.toolCalls) && mm.toolCalls.length) || mm.role === 'tool');
    let lastDisplayable = -1;
    for (let k = visible.length - 1; k >= 0; k--) { if (displayable(visible[k])) { lastDisplayable = k; break; } }
    // Index of the user prompt whose answer is the last displayable assistant — even when tool
    // calls put intermediate (non-displayable) assistant/tool messages between them. Used for the
    // "regenerate response" button, which must appear on that prompt regardless of adjacency.
    let lastPromptIdx = -1;
    if (lastDisplayable >= 0 && visible[lastDisplayable].role === 'assistant') {
      for (let k = lastDisplayable - 1; k >= 0; k--) { if (visible[k].role === 'user') { lastPromptIdx = k; break; } }
    }
    let lastThinking = '';
    let pendingTools = []; // tool activity accumulated up to the final message of the turn
    // Summary: messages [0..upTo) are compacted (not resent). We mark the boundary with a
    // divider (bubble = summary text) and dim the preceding messages.
    const upTo = doc.summary ? doc.summary.upTo : 0;
    const summaryText = doc.summary ? doc.summary.text : '';
    let summaryShown = false;
    // "Last N messages": if active, WINS over the summary (the old summary is not sent).
    const cmP = (doc.params && doc.params.contextMessages) || {};
    const lastN = (cmP.enabled && cmP.value > 0) ? cmP.value : 0; // 0 = inactive
    const cut = lastN ? lastNStart(visible, lastN) : 0;   // effective start (nearest cut wins)
    let lastNShown = false;
    // Inline editor for the summary (same pattern as startEditInline but saves to doc.summary).
    const startEditSummary = (el) => {
      if (el.querySelector('.edit-wrap')) return;
      el.classList.add('editing');
      const body = el.querySelector('.body');
      body.style.display = 'none';
      const wrap = document.createElement('div');
      wrap.className = 'edit-wrap';
      const ta = document.createElement('textarea');
      ta.className = 'edit-area';
      ta.spellcheck = true; ta.lang = window.LangI18n.get();
      ta.value = summaryText;
      const bar = document.createElement('div');
      bar.className = 'edit-bar';
      const cancel = document.createElement('button');
      cancel.textContent = t('Cancel'); cancel.className = 'btn-secondary';
      const save = document.createElement('button');
      save.textContent = t('Save'); save.className = 'btn-primary';
      bar.appendChild(cancel); bar.appendChild(save);
      wrap.appendChild(ta); wrap.appendChild(bar);
      body.after(wrap);
      const commit = () => vscode.postMessage({ type: 'setSummary', text: ta.value });
      const close = () => { body.style.display = ''; wrap.remove(); el.classList.remove('editing'); };
      save.addEventListener('click', commit);
      cancel.addEventListener('click', close);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });
      const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.5) + 'px'; };
      ta.addEventListener('input', autosize);
      ta.focus({ preventScroll: true }); autosize();
    };
    // Centered bubble with the rendered summary (markdown) + actions.
    const summaryBubble = () => {
      const el = document.createElement('div');
      el.className = 'msg summary-msg';
      const roleEl = document.createElement('div');
      roleEl.className = 'role';
      const nm = document.createElement('span');
      nm.textContent = '🗜️ ' + t('Context summary');
      roleEl.appendChild(nm);
      const actions = document.createElement('span');
      actions.className = 'msg-actions';
      const copyBtn = iconButton(ICONS.copy, t('Copy'), () => {
        vscode.postMessage({ type: 'copy', text: summaryText });
        copyBtn.innerHTML = ICONS.check; setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 1200);
      });
      actions.appendChild(copyBtn);
      const readBtn = iconButton(ICONS.speaker, t('Read aloud'), () => tts.speak(summaryText, readBtn)); // no msgId: not a history message
      actions.appendChild(readBtn);
      actions.appendChild(iconButton(ICONS.edit, t('Edit summary'), () => startEditSummary(el)));
      actions.appendChild(iconButton(ICONS.branch,
        t('Fork: clone the conversation up to here into a new .chat') + ` · ${t('⌥/Alt: fork from here to the end')}`,
        (e) => vscode.postMessage({ type: 'fork', index: upTo, fromHere: !!(e && e.altKey) })));
      actions.appendChild(iconButton(ICONS.trash, t('Delete summary (uncompact the history)'),
        () => vscode.postMessage({ type: 'clearSummary' })));
      roleEl.appendChild(actions);
      el.appendChild(roleEl);
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = renderMarkdown(summaryText);
      el.appendChild(body);
      return el;
    };
    const summaryDivider = () => {
      const d = document.createElement('div');
      d.className = 'summary-divider' + (summaryOpen ? ' open' : '');
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'summary-divider-label';
      s.textContent = '🗜️ ' + t('Context summarized up to here') + (summaryOpen ? ' ▾' : ' ▸');
      s.title = t('Click to view the summary');
      s.addEventListener('click', () => { summaryOpen = !summaryOpen; renderConversation(); });
      d.appendChild(s);
      messagesEl.appendChild(d);
      if (summaryOpen) messagesEl.appendChild(summaryBubble());
    };
    // "Last N" divider: from here onward is the only content sent.
    const lastNDivider = () => {
      const d = document.createElement('div');
      d.className = 'lastn-divider';
      const s = document.createElement('span');
      s.className = 'lastn-divider-label';
      s.textContent = '✂️ ' + t('From here: only the last {n} messages are sent').replace('{n}', String(lastN));
      d.appendChild(s);
      messagesEl.appendChild(d);
    };
    // With "last N" active, the saved summary is NOT sent (it is stale): shown dimmed as an indicator.
    if (lastN && summaryText) {
      const d = document.createElement('div');
      d.className = 'summary-divider excluded';
      const s = document.createElement('span');
      s.className = 'summary-divider-label';
      s.textContent = '🗜️ ' + t('Saved summary — not sent while «last N» is active');
      s.title = summaryText;
      d.appendChild(s);
      messagesEl.appendChild(d);
    }
    for (let i = 0; i < visible.length; i++) {
      const m = visible[i];
      // Internal tool messages: NOT shown as a bubble; they go to the panel.
      if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        for (const tc of m.toolCalls) pendingTools.push({ name: tc.name, args: tc.arguments });
        continue;
      }
      if (m.role === 'tool') {
        const slot = pendingTools.find((t) => t.name === m.toolName && t.result === undefined);
        if (slot) slot.result = m.content;
        else pendingTools.push({ name: m.toolName, result: m.content });
        continue;
      }
      // Normal message (user or final assistant response).
      const canMerge = i > 0 && visible[i - 1].role === m.role;
      const isLast = i === lastDisplayable; // last DISPLAYABLE (ignores dangling tool-calls/tool)
      const canRegenerate = m.role === 'assistant' && isLast;
      // Last displayable user message → regenerate response (truncates anything dangling after it).
      const canGenerate = m.role === 'user' && isLast;
      // User message whose response (the following assistant) is the last displayable:
      // allows re-rolling from the prompt without having to delete the assistant message.
      const canRegenFromPrompt = m.role === 'user' && i === lastPromptIdx;
      const activity = (m.role === 'assistant' && pendingTools.length) ? pendingTools.slice() : null;
      // Divider before the first message at/after the boundary (last-N wins over the summary).
      if (lastN) {
        if (!lastNShown && i >= cut) { if (cut > 0) lastNDivider(); lastNShown = true; }
      } else if (upTo > 0 && !summaryShown && i >= upTo) {
        summaryDivider(); summaryShown = true;
      }
      addMessage(m.role, m.content, {
        thinking: m.thinking,
        attachments: m.attachments,
        toolActivity: activity,
        index: i,
        id: m.id,
        canMerge,
        canRegenerate,
        canGenerate,
        canRegenFromPrompt,
        preSummary: !lastN && upTo > 0 && i < upTo, // compacted into the summary
        dropped: lastN > 0 && i < cut,              // outside the "last N" window
        variantCount: Array.isArray(m.variants) ? m.variants.length : 1,
        variantActive: m.active || 0,
      });
      if (m.role === 'assistant') lastThinking = m.thinking || '';
      pendingTools = [];
    }
    // The entire history was summarized (no recent messages): divider at the end.
    if (!lastN && upTo > 0 && !summaryShown) summaryDivider();
    // Restore scroll: to the bottom if already there; otherwise to where it was.
    suppressScroll = false;
    if (atBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (scrollAnchor) {
      // Re-pin the anchor message to the same on-screen offset it had before the rebuild.
      const a = messagesEl.querySelector('.msg[data-msg-index="' + scrollAnchor.index + '"]');
      if (a) {
        const viewTop = messagesEl.getBoundingClientRect().top;
        messagesEl.scrollTop += (a.getBoundingClientRect().top - viewTop) - scrollAnchor.offset;
      } else {
        messagesEl.scrollTop = prevTop;
      }
    } else {
      messagesEl.scrollTop = prevTop;
    }
    // If the search bar is open, re-highlight over the freshly rebuilt DOM.
    refreshFind();
    // Show the reasoning of the last message in the panel.
    showThinking(lastThinking);
  }

// ---- Export to PDF (self-contained HTML + auto-print) ----
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

// ---- Streaming lifecycle (called by the protocol dispatcher) ----
export function streamStart() {
  toolsLive = []; streamingText = ''; thinkingText = '';
  resetStreamRender(); // start the incremental render fresh for this turn
  streamingEl = addMessage('assistant', '', { cursor: true });
}
export function streamReasoning(delta) { thinkingText += delta; openThink(); pendingThink = true; queueStreamRender(); }
export function streamDelta(delta) { streamingText += delta; pendingBody = true; queueStreamRender(); }
export function streamEnd() {
  pendingBody = false; pendingThink = false; rafQueued = false;
  if (streamingEl) {
    const body = streamingEl.querySelector('.body');
    body.innerHTML = renderMarkdownImpl(streamingText);
    body.classList.remove('cursor');
    bindThinking(streamingEl, thinkingText);
    processMermaid(body); // render diagrams now that the turn is complete
    scrollDown();
  }
  streamingEl = null;
}
// Closes a mid-stream turn on error: keep the partial text, drop the cursor, release the ref.
export function streamError() {
  pendingBody = false; pendingThink = false; rafQueued = false;
  if (streamingEl) {
    const b = streamingEl.querySelector('.body');
    if (streamingText) { b.innerHTML = renderMarkdownImpl(streamingText); processMermaid(b); }
    b.classList.remove('cursor');
    bindThinking(streamingEl, thinkingText);
    streamingEl = null;
  }
}
export function toolCall(name, args) { toolsLive.push({ name, args }); openTools(); showTools(toolsLive); }
export function toolResult(name, content) {
  for (let k = toolsLive.length - 1; k >= 0; k--) {
    if (toolsLive[k].name === name && toolsLive[k].result === undefined) { toolsLive[k].result = content; break; }
  }
  showTools(toolsLive);
}
export function showCurrentTools() { showTools(toolsLive); }
// Clears the current turn's live tool activity (and the panel) when a new action starts.
export function resetTools() { toolsLive = []; showTools(toolsLive); }

export function resetScroll() { stickToBottom = true; }
export { showThinking, showTools, openThink, openTools, updateSide, scrollDown };
