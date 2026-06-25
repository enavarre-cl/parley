/**
 * Builds a single chat message bubble: role header, per-message actions (copy/read/edit/
 * fork/regenerate/delete), body (markdown), attachments, reasoning + tool badges.
 */
import { t } from '../core/i18n.js';
import { vscode } from '../core/vscode.js';
import { ICONS } from '../core/icons.js';
import { $, iconButton, escapeHtml, setImageSrc } from '../core/dom.js';
import { render as renderMarkdown } from '../render/markdown.js';
import { processMermaid } from '../render/mermaid.js';
import { getDoc } from '../ui/store.js';
import { clearNotices } from '../ui/notifications.js';
import { tts } from '../features/tts.js';
import { handleFileKeydown, handleSuggestKeydown, setupEmojiAutocomplete } from '../features/autocomplete.js';
import { scrollDown, resetTools } from './conversation.js';
import { openThink, openTools, showThinking, showTools } from './panels.js';

const messagesEl = $('messages');

// Two-step message delete: the trash button currently "armed" (red), awaiting a confirming click.
let armedDelBtn = null;
export function disarmDelete() { if (armedDelBtn) { armedDelBtn.classList.remove('armed'); armedDelBtn = null; } }
// Any click outside the armed trash, or pressing Escape, cancels the pending delete.
document.addEventListener('click', (e) => { const tgt = /** @type {any} */ (e.target); if (armedDelBtn && !armedDelBtn.contains(tgt)) disarmDelete(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disarmDelete(); });

// Copies an image attachment to the system clipboard. base64 → Blob directly (no fetch: the CSP
// blocks data: URLs). Returns false if the browser/Electron clipboard cannot take an image.
  async function copyImageToClipboard(a) {
    if (!navigator.clipboard || !window.ClipboardItem || !a || !a.data) return false;
    const bin = atob(a.data);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: a.mime || 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  }

export function addMessage(role, content, opts) {
  const doc = getDoc();
    opts = opts || {};
    const el = /** @type {any} */ (document.createElement('div'));
    el.className = 'msg ' + role + (opts.preSummary ? ' pre-summary' : '') + (opts.dropped ? ' dropped' : '');
    if (Number.isInteger(opts.index)) el.dataset.msgIndex = opts.index; // lets find/replace map a hit → message

    const roleEl = document.createElement('div');
    roleEl.className = 'role';
    const name = document.createElement('span');
    name.textContent = role === 'user' ? t('You') : t('Assistant');
    roleEl.appendChild(name);
    if (opts.preSummary) {
      const mark = document.createElement('span');
      mark.className = 'pre-summary-mark';
      mark.textContent = '🗜️';
      mark.title = t('This message is compacted into the context summary.');
      roleEl.appendChild(mark);
    }
    if (opts.dropped) {
      const mark = document.createElement('span');
      mark.className = 'pre-summary-mark';
      mark.textContent = '✂️';
      mark.title = t('This message is outside the «last N» window — not sent.');
      roleEl.appendChild(mark);
    }

    if (role === 'assistant') {
      const badge = document.createElement('button');
      badge.className = 'think-badge';
      badge.textContent = t('reasoning');
      badge.addEventListener('click', () => {
        openThink();
        showThinking(el._thinking || '');
      });
      roleEl.appendChild(badge);

      const tbadge = document.createElement('button');
      tbadge.className = 'tool-badge';
      tbadge.textContent = t('tools');
      tbadge.addEventListener('click', () => { openTools(); showTools(el._toolActivity || []); });
      roleEl.appendChild(tbadge);
    }

    // Variant navigator (‹ i/n › 🗑) shown when there is more than one variant.
    if (opts.variantCount > 1) {
      const nav = document.createElement('span');
      nav.className = 'variant-nav';
      const active = opts.variantActive || 0;
      const mkBtn = (label, title, handler, disabled) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        if (disabled) b.disabled = true;
        else b.addEventListener('click', handler);
        return b;
      };
      nav.appendChild(mkBtn('‹', t('Previous variant'),
        () => vscode.postMessage({ type: 'setVariant', index: opts.index, variant: active - 1 }), active <= 0));
      const counter = document.createElement('span');
      counter.className = 'variant-count';
      counter.textContent = (active + 1) + '/' + opts.variantCount;
      nav.appendChild(counter);
      nav.appendChild(mkBtn('›', t('Next variant'),
        () => vscode.postMessage({ type: 'setVariant', index: opts.index, variant: active + 1 }), active >= opts.variantCount - 1));
      roleEl.appendChild(nav);
    }

    // Per-message actions (only for persisted messages with a known index).
    if (Number.isInteger(opts.index)) {
      const actions = document.createElement('span');
      actions.className = 'msg-actions';
      const imgAtt = (opts.attachments || []).find((a) => a.kind === 'image');
      const copyBtn = iconButton(ICONS.copy, imgAtt ? t('Copy image') : t('Copy'), async () => {
        // Image responses (nano-banana): copy the image to the clipboard; otherwise copy the text.
        let ok = false;
        if (imgAtt) ok = await copyImageToClipboard(imgAtt).catch(() => false);
        if (!ok) vscode.postMessage({ type: 'copy', text: content });
        copyBtn.innerHTML = ICONS.check;
        setTimeout(() => { copyBtn.innerHTML = ICONS.copy; }, 1200);
      });
      actions.appendChild(copyBtn);
      if (imgAtt) {
        // Save the generated image to disk (native save dialog handled by the extension host).
        actions.appendChild(iconButton(ICONS.download, t('Save image'),
          () => vscode.postMessage({ type: 'saveImage', index: opts.index })));
      }
      const readBtn = iconButton(ICONS.speaker, t('Read aloud'), () => tts.speak(content, readBtn, opts.id));
      actions.appendChild(readBtn);
      actions.appendChild(iconButton(ICONS.edit, t('Edit message'), () => startEditInline(el, opts.index)));
      if (opts.canRegenerate) {
        // Regenerate lives on the USER bubble ("regenerate the response to this message"): it re-rolls
        // the answer to a prompt, so it belongs with the prompt — not duplicated here. Continue stays.
        actions.appendChild(iconButton(ICONS.forward, t('Continue / keep developing this response'),
          () => { clearNotices(); resetTools(); vscode.postMessage({ type: 'continue' }); }));
      }
      if (opts.canGenerate) {
        // Regenerates the response to this prompt: truncates anything dangling after it (partial tool-calls, etc.) and re-infers.
        actions.appendChild(iconButton(ICONS.retry, t('Generate a response to this message'),
          () => { clearNotices(); resetTools(); vscode.postMessage({ type: 'regenerateFrom', index: opts.index }); }));
      }
      if (opts.canRegenFromPrompt) {
        // Re-rolls the response to this prompt (assistant variant) without deleting anything.
        actions.appendChild(iconButton(ICONS.retry, t('Regenerate the response to this message'),
          () => {
            clearNotices(); resetTools();
            const last = messagesEl.querySelector('.msg.assistant:last-child');
            if (last) last.remove();
            vscode.postMessage({ type: 'regenerate' });
          }));
      }
      if (opts.canMerge) {
        actions.appendChild(iconButton(ICONS.mergeUp, t('Merge with previous message'),
          () => vscode.postMessage({ type: 'mergeMessage', index: opts.index })));
      }
      // Summarize the context up to here (same limit as the "up to here" fork). Only with auto-summary.
      if (doc && doc.params && doc.params.autoSummary && !opts.preSummary && opts.index > 0) {
        actions.appendChild(iconButton(ICONS.summarize, t('Summarize the conversation up to here'),
          () => { clearNotices(); resetTools(); vscode.postMessage({ type: 'summarizeUpTo', index: opts.index }); }));
      }
      actions.appendChild(iconButton(ICONS.branch,
        t('Fork: clone the conversation up to here into a new .chat') + ` · ${t('⌥/Alt: fork from here to the end')}`,
        (e) => vscode.postMessage({ type: 'fork', index: opts.index, fromHere: !!(e && e.altKey) })));
      const hasVariants = opts.variantCount > 1;
      const delTitle = (hasVariants
        ? `${t('Delete this variant')} (${(opts.variantActive || 0) + 1}/${opts.variantCount})`
        : t('Delete message'))
        + `\n${t('Click again to confirm')}`
        + `\n${t('⌥/Alt: delete this and all below')}`
        + `\n${t('⇧/Shift: skip confirmation')}`;
      // Two-step delete: 1st click arms (turns red), 2nd click on the armed trash confirms. Any other
      // event (click elsewhere, re-render from inference/history) disarms it. Shift = delete now.
      const trashBtn = iconButton(ICONS.trash, delTitle, (e) => {
        e.stopPropagation(); // keep trash clicks from reaching the document-level disarm handler
        const performDelete = () => {
          disarmDelete();
          if (e.altKey && Number.isInteger(opts.index)) {
            vscode.postMessage({ type: 'deleteFrom', index: opts.index, confirm: false }); // this + all below
          } else if (hasVariants) {
            vscode.postMessage({ type: 'deleteVariant', index: opts.index, variant: opts.variantActive || 0, confirm: false });
          } else {
            vscode.postMessage({ type: 'deleteMessage', index: opts.index, confirm: false });
          }
        };
        if (e.shiftKey) { performDelete(); return; }              // Shift = delete immediately (as before)
        if (armedDelBtn === trashBtn) { performDelete(); return; } // 2nd click on the red trash = confirm
        disarmDelete();                                            // arm this one (only one at a time)
        armedDelBtn = trashBtn;
        trashBtn.classList.add('armed');
      });
      actions.appendChild(trashBtn);
      roleEl.appendChild(actions);
    }

    el.appendChild(roleEl);
    const body = document.createElement('div');
    body.className = 'body';
    const hasImage = Array.isArray(opts.attachments) && opts.attachments.some((a) => a.kind === 'image');
    if (role === 'assistant' && !opts.cursor && !(content && content.trim()) && !hasImage) {
      // Empty response (some models put everything into reasoning): clear note instead of a blank bubble.
      // Skipped when the response is an image (nano-banana): the image below IS the content.
      body.innerHTML = opts.thinking
        ? '<span class="empty-note">' + escapeHtml(t('The model put the whole response in its reasoning 🧠 — turn off «Reasoning / thinking» in ⚙ to see it here.')) + '</span>'
        : '<span class="empty-note">' + escapeHtml(t('(empty response)')) + '</span>';
    } else {
      body.innerHTML = renderMarkdown(content);
    }
    if (opts.cursor) body.classList.add('cursor');
    el.appendChild(body);
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      const att = document.createElement('div');
      att.className = 'msg-attachments';
      for (const a of opts.attachments) {
        if (a.kind === 'image') {
          const img = document.createElement('img');
          setImageSrc(img, a.mime, a.data);
          img.title = t('Click to enlarge');
          img.addEventListener('click', () => img.classList.toggle('zoomed'));
          att.appendChild(img);
        } else {
          const c = document.createElement('span');
          c.className = 'file-chip';
          c.textContent = '📄 ' + a.name;
          att.appendChild(c);
        }
      }
      el.appendChild(att);
    }
    if (role === 'assistant') {
      bindThinking(el, opts.thinking || '');
      el._toolActivity = opts.toolActivity || null;
      el.classList.toggle('has-tools', !!(opts.toolActivity && opts.toolActivity.length));
    }
    messagesEl.appendChild(el);
    processMermaid(body); // upgrade any ```mermaid blocks to SVG (no-op if there are none)
    scrollDown();
    return el;
  }

export function bindThinking(el, text) {
    el._thinking = text || '';
    el.classList.toggle('has-think', !!text);
  }

// Inline editing of a message's content.
export function startEditInline(el, index) {
  const doc = getDoc();
    if (el.querySelector('.edit-wrap')) return; // already editing
    const m = doc && doc.messages[index];
    if (!m) return;
    el.classList.add('editing');
    const body = el.querySelector('.body');
    body.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'edit-wrap';
    const ta = document.createElement('textarea');
    ta.className = 'edit-area';
    ta.spellcheck = true;
    ta.lang = window.LangI18n.get();
    ta.value = m.content;
    const bar = document.createElement('div');
    bar.className = 'edit-bar';
    const cancel = document.createElement('button');
    cancel.textContent = t('Cancel');
    cancel.className = 'btn-secondary';
    const save = document.createElement('button');
    save.textContent = t('Save');
    save.className = 'btn-primary';
    bar.appendChild(cancel); // left
    bar.appendChild(save);   // right
    wrap.appendChild(ta);
    wrap.appendChild(bar);
    body.after(wrap);

    const commit = () => vscode.postMessage({ type: 'editMessage', index, content: ta.value });
    const close = () => { body.style.display = ''; wrap.remove(); el.classList.remove('editing'); };
    save.addEventListener('click', commit);
    cancel.addEventListener('click', close);
    ta.addEventListener('keydown', (e) => {
      if (handleFileKeydown(e)) return;
      if (handleSuggestKeydown(e)) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    setupEmojiAutocomplete(ta); // :name autocomplete also works when editing

    // Aligns the bottom edge of the editing bubble to the end of the visible area.
    const alignBottom = () => {
      const cr = messagesEl.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      messagesEl.scrollTop += (er.bottom - cr.bottom) + 8;
    };
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.5) + 'px'; };
    ta.addEventListener('input', autosize);
    ta.focus({ preventScroll: true });
    autosize();
    requestAnimationFrame(alignBottom);
  }

export { copyImageToClipboard };
