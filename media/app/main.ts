/**
 * Webview entry point: initializes the feature modules, wires the toolbar and global keyboard
 * shortcuts, and routes host messages to the protocol dispatcher.
 */
import { vscode } from '../core/vscode.js';
import { $, escapeHtml } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { getDoc } from '../ui/store.js';
import { initComposer, setZoom } from '../chat/composer.js';
import { initAutocomplete } from '../features/autocomplete.js';
import { initSpell } from '../features/spell.js';
import { initTts } from '../features/tts.js';
import { renderConfig, patchConfig } from '../panels/config.js';
import { updateModelCtx, modelSelect } from '../panels/models.js';
import { updateSide, showCurrentTools, buildExportHtml } from '../chat/conversation.js';
import { openThink, openTools, dismissThink, dismissTools } from '../chat/panels.js';
import { openFind, closeFind, setReplaceVisible } from '../features/find.js';
import { handleMessage } from './protocol.js';

const providerSelect = $('providerSelect') as HTMLSelectElement;
const configPanel = $('config');
const thinkPanel = $('thinking');
const toolsPanel = $('tools');
const findBar = $('findBar');
const replaceInput = $('replaceInput') as HTMLInputElement;

// ---- Initialize feature modules (each wires its own DOM events) ----
initComposer();
initAutocomplete();
initSpell();
initTts(() => { if (getDoc() && !configPanel.classList.contains('hidden')) renderConfig(); });

// ---- Global keyboard: zoom reset, find/replace, undo blocking ----
window.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === '0')) { e.preventDefault(); setZoom(1); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); setReplaceVisible(false); openFind(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); setReplaceVisible(true); openFind(); replaceInput.focus(); }
  if (e.key === 'Escape' && findBar && !findBar.classList.contains('hidden')) { e.preventDefault(); closeFind(); }
  // Ctrl/Cmd+Z (and redo): the .chat is a text editor, so document undo would inadvertently
  // revert/delete messages. Block it ALWAYS; inside an editable field we keep its own
  // undo via execCommand (does not touch the document).
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as any;
    const editable = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
    if (editable) {
      const redo = (e.key === 'y' || e.key === 'Y') || e.shiftKey;
      try { document.execCommand(redo ? 'redo' : 'undo'); } catch (_) { /* no native undo */ }
    }
  }
});

// ---- Toolbar ----
providerSelect.addEventListener('change', () => {
  // Clear the model immediately to avoid showing models from the previous backend.
  modelSelect.innerHTML = '<option>' + escapeHtml(t('Loading…')) + '</option>';
  patchConfig({ provider: providerSelect.value });
  renderConfig(); // re-filter parameters for the new backend
});
modelSelect.addEventListener('change', () => { updateModelCtx(); patchConfig({ model: modelSelect.value }); });
$('refreshBtn').addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
$('settingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
$('configBtn').addEventListener('click', () => { configPanel.classList.toggle('hidden'); updateSide(); });
$('configClose').addEventListener('click', () => { configPanel.classList.add('hidden'); updateSide(); });
$('exportBtn').addEventListener('click', () => {
  const doc = getDoc();
  vscode.postMessage({ type: 'exportHtml', title: (doc && doc.title) || 'Chat', html: buildExportHtml() });
});
$('thinkBtn').addEventListener('click', () => { if (thinkPanel.classList.contains('hidden')) openThink(); else dismissThink(); });
$('thinkClose').addEventListener('click', () => dismissThink());
$('toolsBtn').addEventListener('click', () => { if (toolsPanel.classList.contains('hidden')) { showCurrentTools(); openTools(); } else dismissTools(); });
$('toolsClose').addEventListener('click', () => dismissTools());

// ---- Messages from the extension ----
window.addEventListener('message', (event) => handleMessage(event.data));

vscode.postMessage({ type: 'ready' });
