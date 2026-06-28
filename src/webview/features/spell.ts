/**
 * Live spell-check overlay (misspelled words underlined) + right-click suggestions menu.
 * The nspell engine lives in the classic spell-engine.js (window.LangSpell).
 */
import { t } from '../core/i18n.js';
import { vscode } from '../core/vscode.js';
import { $, escapeHtml } from '../core/dom.js';
import { patchConfig } from '../panels/config.js';

const inputEl = $('input') as HTMLTextAreaElement;
const inputBackdrop = $('inputBackdrop');
const spellSelect = $('spellSelect') as HTMLSelectElement;

// ---- Spell checker (live underline via overlay; nspell engine in spell-engine.js) ----
  const WORD_RE = /[\p{L}\p{M}]+/gu; // words (letters + marks/diacritics); ignores numbers/symbols
  const SPELL_DEBOUNCE_MS = 250;
  let spellTimer = null;

  function spellEffective() {
    const pref = spellSelect ? spellSelect.value : 'auto';
    if (pref === 'off') return null;
    const dicts = window.SPELL_DICTS || {};
    if (pref !== 'auto' && dicts[pref]) return pref;
    const sys = (navigator.language || '').toLowerCase().slice(0, 2);
    return dicts[sys] ? sys : null;
  }

  function applySpellLang() {
    if (window.LangSpell) window.LangSpell.setLang(spellEffective());
    renderSpell();
  }

  // Rebuilds the background layer with misspelled words underlined.
  function renderSpell() {
    if (!inputBackdrop) return;
    const text = inputEl.value;
    if (!window.LangSpell || !window.LangSpell.ready()) { inputBackdrop.textContent = ''; return; }
    let html = '', last = 0, m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      const w = m[0];
      html += escapeHtml(text.slice(last, m.index));
      html += window.LangSpell.correct(w) ? escapeHtml(w) : '<span class="sp-err">' + escapeHtml(w) + '</span>';
      last = m.index + w.length;
    }
    html += escapeHtml(text.slice(last));
    inputBackdrop.innerHTML = html;
    inputBackdrop.scrollTop = inputEl.scrollTop;
  }

  function scheduleSpell() {
    if (spellTimer) clearTimeout(spellTimer);
    spellTimer = setTimeout(renderSpell, SPELL_DEBOUNCE_MS);
  }

  function wordAt(text, pos) {
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) {
      if (pos >= m.index && pos <= m.index + m[0].length) return { text: m[0], start: m.index, end: m.index + m[0].length };
      if (m.index > pos) break;
    }
    return null;
  }

  // Floating suggestions menu.
  let spellMenu = null;
  function closeSpellMenu() { if (spellMenu) { spellMenu.remove(); spellMenu = null; } }
  function showSpellMenu(x, y, word, suggestions) {
    closeSpellMenu();
    spellMenu = document.createElement('div');
    spellMenu.id = 'spellMenu';
    if (suggestions.length) {
      for (const s of suggestions) {
        const it = document.createElement('div');
        it.className = 'sp-item';
        it.textContent = s;
        it.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          const v = inputEl.value;
          inputEl.value = v.slice(0, word.start) + s + v.slice(word.end);
          const caret = word.start + s.length;
          inputEl.setSelectionRange(caret, caret);
          inputEl.dispatchEvent(new Event('input'));
          inputEl.focus();
          closeSpellMenu();
        });
        spellMenu.appendChild(it);
      }
    } else {
      const none = document.createElement('div');
      none.className = 'sp-none';
      none.textContent = t('No suggestions');
      spellMenu.appendChild(none);
    }
    const sep = document.createElement('div');
    sep.className = 'sp-sep';
    spellMenu.appendChild(sep);
    const add = document.createElement('div');
    add.className = 'sp-item';
    add.textContent = '➕ ' + t('Add to dictionary');
    add.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const lang = window.LangSpell ? window.LangSpell.lang() : null; // active spell-checker language
      if (window.LangSpell) window.LangSpell.add(word.text);   // immediate effect
      vscode.postMessage({ type: 'spellAddWord', word: word.text, lang }); // persisted per language
      renderSpell();
      closeSpellMenu();
      inputEl.focus();
    });
    spellMenu.appendChild(add);
    document.body.appendChild(spellMenu);
    // Fit within the screen.
    const r = spellMenu.getBoundingClientRect();
    spellMenu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    spellMenu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }

// Wires the spell selector, ready callback, and the right-click suggestions menu.
export function initSpell() {
  if (window.LangSpell) window.LangSpell.onReady(renderSpell);
  if (spellSelect) {
    spellSelect.addEventListener('change', () => {
      patchConfig({ spellLang: spellSelect.value });
      applySpellLang();
    });
  }
  inputEl.addEventListener('contextmenu', (e) => {
    if (!window.LangSpell || !window.LangSpell.ready()) return; // no spell checker: native menu
    const word = wordAt(inputEl.value, inputEl.selectionStart);
    if (!word || window.LangSpell.correct(word.text)) { closeSpellMenu(); return; }
    e.preventDefault();
    showSpellMenu(e.clientX, e.clientY, word, window.LangSpell.suggest(word.text));
  });
  document.addEventListener('mousedown', (e) => { if (spellMenu && !spellMenu.contains(e.target)) closeSpellMenu(); });
  window.addEventListener('blur', closeSpellMenu);
}

export { applySpellLang, renderSpell, scheduleSpell };
