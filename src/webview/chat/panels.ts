/**
 * Reasoning + tools side panels: their visibility (open/updateSide) and content rendering
 * (showThinking / showTools). Owns only the panel DOM refs; no streaming/scroll state.
 */
import { $, escapeHtml } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { ICONS } from '../core/icons.js';
import { renderRaw as renderMarkdownImpl } from '../render/markdown.js';
import { getDoc } from '../ui/store.js';
import { vscode } from '../core/vscode.js';

const configPanel = $('config');
const thinkPanel = $('thinking');
const thinkContent = $('thinkContent');
const toolsPanel = $('tools');
const toolsContent = $('toolsContent');
const sidepanels = $('sidepanels');

export function updateSide() {
  const open = !configPanel.classList.contains('hidden')
    || !thinkPanel.classList.contains('hidden')
    || !toolsPanel.classList.contains('hidden');
  sidepanels.classList.toggle('hidden', !open);
}
// Panel visibility is a per-conversation preference persisted in the .chat (doc.ui.thinkOpen /
// toolsOpen). undefined = default (closed; auto-opens when reasoning/tools stream); true = the user
// opened it; false = the user closed it (streaming must not reopen it). Persisting goes through the
// same setConfig path as the config panel, so it survives reloads.
function persistUi(patch) {
  const doc = getDoc();
  if (doc) doc.ui = Object.assign({}, doc.ui, patch);
  vscode.postMessage({ type: 'setConfig', patch: { ui: patch } });
}

// Explicit user open: remember it so the panel stays open (and auto-open is re-enabled) across reloads.
export function openThink() { persistUi({ thinkOpen: true }); thinkPanel.classList.remove('hidden'); updateSide(); }
export function openTools() { persistUi({ toolsOpen: true }); toolsPanel.classList.remove('hidden'); updateSide(); }

// Auto open (from streaming reasoning / tool calls): only if the user hasn't explicitly closed it.
export function autoOpenThink() { if (getDoc() && getDoc().ui && getDoc().ui.thinkOpen === false) return; thinkPanel.classList.remove('hidden'); updateSide(); }
export function autoOpenTools() { if (getDoc() && getDoc().ui && getDoc().ui.toolsOpen === false) return; toolsPanel.classList.remove('hidden'); updateSide(); }

// User close: persist so streaming won't reopen it and it stays closed across reloads.
export function dismissThink() { persistUi({ thinkOpen: false }); thinkPanel.classList.add('hidden'); updateSide(); }
export function dismissTools() { persistUi({ toolsOpen: false }); toolsPanel.classList.add('hidden'); updateSide(); }

// Applies the persisted visibility when a conversation loads. Only a panel the user explicitly
// pinned open (=== true) shows on load; otherwise it starts closed and may auto-open while streaming.
export function applyPanelState(doc) {
  const ui = (doc && doc.ui) || {};
  thinkPanel.classList.toggle('hidden', ui.thinkOpen !== true);
  toolsPanel.classList.toggle('hidden', ui.toolsOpen !== true);
  updateSide();
}

const TOOL_PREVIEW_CHARS = 256; // a collapsed tool's args/result shows at most this many characters

// Appends `text` to `parent` as <tag class=className>. Long content starts COLLAPSED — truncated to
// TOOL_PREVIEW_CHARS with a toggle that expands to the full text and collapses again — so a verbose
// tool's args/output don't flood the panel. Short content is shown in full, with no toggle.
function appendCollapsible(parent, text, tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text.length <= TOOL_PREVIEW_CHARS) {
    el.textContent = text;
    parent.appendChild(el);
    return;
  }
  let expanded = false;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tool-more';
  const sync = () => {
    el.textContent = expanded ? text : text.slice(0, TOOL_PREVIEW_CHARS) + '…';
    toggle.textContent = expanded ? t('Show less') : t('Show more');
  };
  toggle.addEventListener('click', () => { expanded = !expanded; sync(); });
  sync();
  parent.appendChild(el);
  parent.appendChild(toggle);
}

// Renders a list of tool activity in the panel.
export function showTools(activity) {
  toolsContent.innerHTML = '';
  if (!activity || !activity.length) {
    toolsContent.classList.add('empty');
    toolsContent.textContent = t('No tool activity.');
    return;
  }
  toolsContent.classList.remove('empty');
  for (const a of activity) {
    const item = document.createElement('div');
    item.className = 'tool-item collapsed'; // collapsed by default: only the header (name) shows
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tool-item-head';
    head.innerHTML = '<span class="tool-chev"></span>' + ICONS.tool + '<span class="tool-name">' + escapeHtml(a.name) + '</span>';
    head.addEventListener('click', () => item.classList.toggle('collapsed'));
    item.appendChild(head);
    const body = document.createElement('div');
    body.className = 'tool-item-body'; // hidden while collapsed; holds args + result
    if (a.args && a.args !== '{}') appendCollapsible(body, a.args, 'div', 'tool-args');
    if (a.result !== undefined) appendCollapsible(body, String(a.result), 'pre', '');
    item.appendChild(body);
    toolsContent.appendChild(item);
  }
  toolsContent.scrollTop = toolsContent.scrollHeight;
}

export function showThinking(text) {
  if (text) {
    thinkContent.innerHTML = renderMarkdownImpl(text); // called per-frame during reasoning: no cache
    thinkContent.classList.remove('empty');
  } else {
    thinkContent.textContent = t('This message has no reasoning.');
    thinkContent.classList.add('empty');
  }
  thinkContent.scrollTop = thinkContent.scrollHeight;
}
