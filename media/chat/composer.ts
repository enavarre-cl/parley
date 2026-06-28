/**
 * Composer: the input box, attachments (drag/drop, paste, file picker), send, streaming/
 * summarizing busy-state of the send button, and chat-local zoom.
 */
import { t } from '../core/i18n.js';
import { vscode } from '../core/vscode.js';
import { $, setImageSrc } from '../core/dom.js';
import { getDoc } from '../ui/store.js';
import { notice, clearNotices } from '../ui/notifications.js';
import { addMessage } from './message.js';
import { resetScroll, resetTools } from './conversation.js';
import { renderSpell, scheduleSpell } from '../features/spell.js';
import { handleFileKeydown, handleSuggestKeydown } from '../features/autocomplete.js';

const inputEl = $('input') as HTMLTextAreaElement;
const inputBackdrop = $('inputBackdrop');
const sendBtn = $('sendBtn');
const stopBtn = $('stopBtn');
const attachmentsEl = $('attachments');
const attachBtn = $('attachBtn');
const fileInput = $('fileInput') as HTMLInputElement;
const inputBox = $('inputBox');
const messagesEl = $('messages');

let pending = []; // pending attachments to send: {kind,name,mime,data}
let dragDepth = 0; // drag highlight nesting counter

// ---- Streaming / summarizing busy-state ----
let isStreaming = false;
export function setStreaming(on) {
  isStreaming = on;
  sendBtn.classList.toggle('hidden', on);
  stopBtn.classList.toggle('hidden', !on);
}
let isSummarizing = false;
export function setSummarizing(on) {
  isSummarizing = on;
  if (inputEl) inputEl.disabled = on;
  if (sendBtn) (sendBtn as HTMLButtonElement).disabled = on;
  if (inputBox) inputBox.classList.toggle('busy', on);
}

// ---- Attachments ----
  const IMG_RE = /^image\//;
  const TEXT_EXT = /\.(txt|md|json|csv|js|ts|tsx|jsx|py|java|c|cpp|h|go|rs|rb|php|html|css|scss|xml|yaml|yml|toml|ini|sh|sql|log|env)$/i;
  function isTextLike(file) {
    if (/^text\//.test(file.type)) return true;
    if (/(json|xml|javascript|yaml|csv|markdown|x-sh|x-python)/i.test(file.type)) return true;
    if (!file.type) return TEXT_EXT.test(file.name || ''); // unknown mime: fall back to extension
    return false;
  }
  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(',') + 1)); };
      reader.onerror = () => reject(reader.error || new Error('read error'));
      reader.readAsDataURL(file);
    });
  }
  async function fileToAttachment(file) {
    if (IMG_RE.test(file.type)) {
      return { kind: 'image', name: file.name || 'image.png', mime: file.type || 'image/png', data: await readBase64(file) };
    }
    if (isTextLike(file)) {
      const text = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result));
        rd.onerror = () => reject(rd.error || new Error('read error'));
        rd.readAsText(file);
      });
      return { kind: 'text', name: file.name || 'file.txt', mime: file.type || 'text/plain', data: text };
    }
    // PDF, docx, binaries… → base64 document
    return { kind: 'document', name: file.name || 'document', mime: file.type || 'application/octet-stream', data: await readBase64(file) };
  }

  async function addFiles(files) {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) { notice(t('Attachment too large (max 20 MB): ') + file.name, true); continue; }
      try {
        pending.push(await fileToAttachment(file));
      } catch (e) {
        notice(t('Could not read the file: ') + (file.name || ''), true);
      }
    }
    renderPending();
  }

  function renderPending() {
    attachmentsEl.innerHTML = '';
    attachmentsEl.classList.toggle('hidden', pending.length === 0);
    pending.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      if (a.kind === 'image') {
        const img = document.createElement('img');
        setImageSrc(img, a.mime, a.data);
        chip.appendChild(img);
      } else {
        chip.appendChild(document.createTextNode('📄 ' + a.name));
      }
      const x = document.createElement('button');
      x.textContent = '×'; x.title = t('Remove');
      x.addEventListener('click', () => { pending.splice(i, 1); renderPending(); });
      chip.appendChild(x);
      attachmentsEl.appendChild(chip);
    });
  }

// ---- Send ----
function send() {
  const doc = getDoc();
  if (isStreaming || isSummarizing) return; // ignore sends while generating or summarizing
  const text = inputEl.value.trim();
  if (!text && pending.length === 0) return;
  clearNotices();
  resetTools(); // a new turn begins: drop the previous turn's live tool activity
  resetScroll(); // on send, stick to the bottom again
  const attachments = pending.slice();
  addMessage('user', text, { attachments });
  if (doc) doc.messages.push({ role: 'user', content: text, attachments });
  inputEl.value = '';
  inputEl.style.height = 'auto';
  renderSpell(); // clear the overlay underline
  pending = [];
  renderPending();
  setStreaming(true); // block resends until streamEnd/error
  vscode.postMessage({ type: 'send', text, attachments });
}

// ---- Chat-local zoom (independent of VS Code global zoom) ----
  // Persisted per conversation in doc.ui.zoom (travels with the .chat). vscode.getState() is kept as a
  // fast local cache so the level is restored instantly on reload, before the doc message arrives.
  let zoom = LangZoom.clampZoom((vscode.getState() && vscode.getState().zoom) || 1);
  let zoomPersistTimer = 0;
  function applyZoom() {
    // Zoom ONLY the history (which has its own scroll), not the whole body: zooming the body
    // scaled the 100vh layout and overflowed/clipped the composer (the input bar).
    document.body.style.zoom = '';                // clear any previous zoom on body (legacy state)
    if (messagesEl) messagesEl.style.zoom = String(zoom);
    const lbl = $('zoomResetBtn');
    if (lbl) lbl.textContent = Math.round(zoom * 100) + '%';
    const s = vscode.getState() || {};
    s.zoom = zoom;
    vscode.setState(s);
  }
  // Debounced write to the .chat (wheel zoom fires rapidly; coalesce into one persisted value).
  function persistZoom() {
    const doc = getDoc();
    if (doc) doc.ui = Object.assign({}, doc.ui, { zoom });
    clearTimeout(zoomPersistTimer);
    zoomPersistTimer = setTimeout(() => vscode.postMessage({ type: 'setConfig', patch: { ui: { zoom } } }), 400);
  }
  function setZoom(z) { zoom = LangZoom.clampZoom(z); applyZoom(); persistZoom(); }

  // Applies the zoom persisted in the loaded conversation (no re-persist). Called when a doc arrives.
  export function applyDocZoom(doc) {
    const z = doc && doc.ui && doc.ui.zoom;
    if (typeof z === 'number' && isFinite(z)) { zoom = LangZoom.clampZoom(z); applyZoom(); }
  }

// Wires all composer DOM events. Called once at startup.
export function initComposer() {
  // UI events
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  inputEl.addEventListener('keydown', (e) => {
    if (handleFileKeydown(e)) return;
    if (handleSuggestKeydown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.4) + 'px';
    scheduleSpell();
  });
  inputEl.addEventListener('scroll', () => { if (inputBackdrop) inputBackdrop.scrollTop = inputEl.scrollTop; });
  // File picker + drag/drop + paste
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; inputBox.classList.add('dragover'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; inputBox.classList.remove('dragover'); } });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    inputBox.classList.remove('dragover');
    const f = e.dataTransfer && e.dataTransfer.files;
    if (f && f.length) addFiles([...f]);
  });
  inputEl.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  // Zoom: Alt+wheel, Alt+0 handled in main; toolbar buttons here
  window.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    zoom = LangZoom.stepZoom(zoom, e.deltaY);
    applyZoom();
    persistZoom();
  }, { passive: false });
  $('zoomInBtn').addEventListener('click', () => setZoom(LangZoom.stepZoom(zoom, -1)));
  $('zoomOutBtn').addEventListener('click', () => setZoom(LangZoom.stepZoom(zoom, 1)));
  $('zoomResetBtn').addEventListener('click', () => setZoom(1));
  applyZoom();
}

export { setZoom };
