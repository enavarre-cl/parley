/**
 * Configuration panel (⚙): system prompt, sampling parameters (schema-driven), and the
 * read-aloud (TTS) section. Posts config patches to the host.
 */
import { t } from '../core/i18n.js';
import { vscode } from '../core/vscode.js';
import { $ } from '../core/dom.js';
import { getDoc } from '../ui/store.js';
import { tts } from '../features/tts.js';
import { updateContextBar } from './models.js';
import { renderConversation } from '../chat/conversation.js';
import { renderTtsConfig } from './configTts.js';

const configFields = $('configFields');

const SLIDER_STEP = 0.01; // decimal precision for fractional sliders/number inputs

// Configuration panel schema: collapsible sections (`id` persisted in doc.ui.configSections, `hint`
// is the collapsed-state subtitle). `only` restricts a parameter to certain backends; a section whose
// items are all filtered out for the active backend is hidden.
  const SCHEMA = [
    { id: 'response', title: 'Response', hint: 'temperature · length · stop', items: [
      { key: 'temperature', label: 'Temperature', kind: 'slider', min: 0, max: 2, step: SLIDER_STEP, toggle: false },
      { key: 'maxTokens', label: 'Limit response length', kind: 'int', min: 1, max: 131072, step: 1, toggle: true },
      { key: 'stop', label: 'Stop Strings', kind: 'tags' },
    ] },
    { id: 'context', title: 'Context', hint: 'history · summarize', items: [
      { key: 'contextMessages', label: 'History to send: last N messages', kind: 'int', min: 1, max: 500, step: 1, toggle: true },
      { key: 'autoSummary', label: 'Auto-summarize when context fills up', kind: 'bool' },
    ] },
    { id: 'capabilities', title: 'Capabilities', hint: 'reasoning · tools', items: [
      { key: 'thinking', label: 'Reasoning / thinking', kind: 'bool', only: ['gemini', 'anthropic', 'openrouter', 'ollama'] },
      { key: 'tools', label: 'Tools: workspace filesystem + MCP servers (.mcp)', kind: 'bool', only: ['openai', 'openrouter', 'gemini', 'anthropic', 'ollama'] },
    ] },
    { id: 'sampling', title: 'Sampling', hint: 'top-k/p · penalties · seed', items: [
      { key: 'topK', label: 'Top K Sampling', kind: 'int', min: 0, max: 500, step: 1, toggle: true },
      { key: 'topP', label: 'Top P Sampling', kind: 'slider', min: 0, max: 1, step: SLIDER_STEP, toggle: true },
      { key: 'minP', label: 'Min P Sampling', kind: 'slider', min: 0, max: 1, step: SLIDER_STEP, toggle: true, only: ['openai', 'ollama', 'openrouter'] },
      { key: 'topA', label: 'Top A Sampling', kind: 'slider', min: 0, max: 1, step: SLIDER_STEP, toggle: true, only: ['openrouter'] },
      { key: 'repeatPenalty', label: 'Repeat / Repetition Penalty', kind: 'number', min: 0, max: 2, step: SLIDER_STEP, toggle: true, only: ['openai', 'ollama', 'openrouter'] },
      { key: 'presencePenalty', label: 'Presence Penalty', kind: 'number', min: -2, max: 2, step: SLIDER_STEP, toggle: true, only: ['openai', 'ollama', 'openrouter', 'gemini'] },
      { key: 'frequencyPenalty', label: 'Frequency Penalty', kind: 'number', min: -2, max: 2, step: SLIDER_STEP, toggle: true, only: ['openai', 'ollama', 'openrouter', 'gemini'] },
      { key: 'seed', label: 'Seed', kind: 'int', min: 0, max: 2147483647, step: 1, toggle: true, only: ['openai', 'ollama', 'openrouter', 'gemini'] },
    ] },
    { id: 'engine', title: 'Engine · Ollama', hint: 'context window · threads', items: [
      { key: 'contextLength', label: 'Model window: num_ctx (tokens)', kind: 'int', min: 256, max: 131072, step: 256, toggle: true, only: ['ollama'] },
      { key: 'numThreads', label: 'CPU Threads', kind: 'slider', min: 1, max: 32, step: 1, toggle: true, only: ['ollama'] },
    ] },
  ];

  // Section ids expanded by default when a chat opens (everything else collapsed). The system prompt
  // is the headline editing surface, so it starts open; the parameter knobs stay tucked away.
  const DEFAULT_OPEN_SECTIONS = ['sysprompt'];

  // Effective open set: the persisted ids (even []), else the default. Read fresh each render.
  function openSections() {
    const ui = getDoc() && getDoc().ui;
    return ui && Array.isArray(ui.configSections) ? ui.configSections : DEFAULT_OPEN_SECTIONS;
  }

  // Persists the open/closed set into doc.ui.configSections via the same setConfig path as the
  // Reasoning/Tools panels (host merges into doc.ui; its own write is de-duped, so no re-render).
  function setSectionOpen(id, open) {
    const cur = openSections();
    const next = open ? [...new Set([...cur, id])] : cur.filter((s) => s !== id);
    const doc = getDoc();
    if (doc) doc.ui = Object.assign({}, doc.ui, { configSections: next });
    vscode.postMessage({ type: 'setConfig', patch: { ui: { configSections: next } } });
  }

  function patchConfig(patch) {
    const doc = getDoc();
    if (doc) {
      if (patch.params) {
        doc.params = doc.params || {};
        for (const k of Object.keys(patch.params)) doc.params[k] = patch.params[k];
      }
      for (const k of Object.keys(patch)) if (k !== 'params') doc[k] = patch[k];
    }
    vscode.postMessage({ type: 'setConfig', patch });
    updateContextBar();
    // If something that shifts the context dividers changed (last N / summary / budget),
    // re-render the conversation so the ✂️/🗜️ markers and dimming reflect the new state.
    if (patch.params && ('contextMessages' in patch.params || 'autoSummary' in patch.params)) {
      renderConversation();
    }
  }
  const patchParam = (key, value) => patchConfig({ params: { [key]: value } });

  // ---- Configuration panel rendering ----
  function renderConfig() {
    const doc = getDoc();
    if (!doc) return;
    // Backend and model are static in the HTML; here only system prompt + parameters, as a set of
    // collapsible sections (collapsed by default; state persisted per chat in doc.ui.configSections).
    configFields.innerHTML = '';

    // System prompt: an always-editable inline base + ordered .md layers, concatenated at send time.
    const sys = cfgSection('sysprompt', 'System prompt', '');
    sys.body.appendChild(sysPromptControl(doc));
    configFields.appendChild(sys.section);

    // Parameter sections, filtered by the active backend (a fully-filtered section is skipped).
    const provider = doc.provider;
    for (const group of SCHEMA) {
      const items = group.items.filter((it) => { const o = it as { only?: string[] }; return !o.only || o.only.includes(provider); });
      if (!items.length) continue;
      const sec = cfgSection(group.id, group.title, group.hint);
      for (const item of items) sec.body.appendChild(paramRow(item));
      configFields.appendChild(sec.section);
    }

    // Read aloud (system engine / Piper / Chatterbox) — its own collapsible section.
    const aloud = cfgSection('readaloud', 'Read aloud', 'voice · speed');
    renderTtsConfig(aloud.body);
    configFields.appendChild(aloud.section);
  }

  // Builds one collapsible section: a clickable header (chevron + title + collapsed-state hint) and a
  // body the caller fills. Toggling flips a CSS class in place (no re-render) and persists the set.
  function cfgSection(id, title, hint) {
    const section = document.createElement('div');
    section.className = 'cfg-section' + (openSections().includes(id) ? '' : ' collapsed');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'cfg-section__head';
    const chev = document.createElement('span');
    chev.className = 'cfg-section__chev'; // the disclosure triangle is drawn in CSS (border triangle)
    const titleEl = document.createElement('span');
    titleEl.className = 'cfg-section__title';
    titleEl.textContent = t(title);
    const hintEl = document.createElement('span');
    hintEl.className = 'cfg-section__hint';
    if (hint) hintEl.textContent = t(hint);
    head.appendChild(chev);
    head.appendChild(titleEl);
    head.appendChild(hintEl);
    head.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      setSectionOpen(id, !collapsed);
    });

    const body = document.createElement('div');
    body.className = 'cfg-section__body';

    section.appendChild(head);
    section.appendChild(body);
    return { section, body };
  }

  function fieldRow(label, control) {
    const row = document.createElement('div');
    row.className = 'cfg-row';
    const l = document.createElement('label');
    l.textContent = label;
    row.appendChild(l);
    row.appendChild(control);
    return row;
  }

  // System-prompt control: the inline base (always editable, segment 0) followed by the ordered list
  // of .md layers. Layer ops post a message and re-render off the host's pushDoc; only the base text
  // uses the optimistic patchConfig path.
  function sysPromptControl(doc) {
    const wrap = document.createElement('div');

    const sys = document.createElement('textarea');
    sys.className = 'sys-area';
    sys.spellcheck = true; sys.lang = window.LangI18n.get();
    sys.rows = 2; sys.value = doc.systemPrompt; sys.placeholder = t('System instructions…');
    const sysAutosize = () => { sys.style.height = 'auto'; sys.style.height = Math.min(sys.scrollHeight, 320) + 'px'; };
    sys.addEventListener('input', sysAutosize);
    sys.addEventListener('change', () => patchConfig({ systemPrompt: sys.value }));
    requestAnimationFrame(sysAutosize);
    wrap.appendChild(sys);

    // Layer source: a path/glob field + [Refresh] to resolve it, and a compact [+] to pick existing
    // .md files. Refresh re-syncs the list below — keeping the order you set, re-adding any you removed
    // at the end, and leaving it untouched when nothing was removed (see routeSysPrompt).
    const globRow = document.createElement('div');
    globRow.className = 'sysglob';
    const glob = document.createElement('input');
    glob.type = 'text';
    glob.className = 'sysglob-input';
    glob.value = doc.systemPromptGlob || '';
    glob.placeholder = t('e.g. systems/*.md or **/inst-*.md');
    glob.title = t('Relative path or glob, resolved against this .chat’s folder');
    glob.addEventListener('change', () => patchConfig({ systemPromptGlob: glob.value }));
    const refresh = document.createElement('button');
    refresh.textContent = t('Refresh');
    refresh.title = t('Resolve the pattern and update the layer list');
    refresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshSysPrompt', glob: glob.value }));
    glob.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); refresh.click(); } });
    const add = document.createElement('button');
    add.className = 'sysglob-add';
    add.textContent = '+';
    add.title = t('Append one or more existing .md files as layers');
    add.addEventListener('click', () => vscode.postMessage({ type: 'pickSysPrompt' }));
    globRow.appendChild(glob); globRow.appendChild(refresh); globRow.appendChild(add);
    wrap.appendChild(globRow);

    const layers = Array.isArray(doc.systemPromptFiles) ? doc.systemPromptFiles : [];
    if (layers.length) {
      const list = document.createElement('div');
      list.className = 'syslayers';
      layers.forEach((layer, i) => list.appendChild(sysLayerRow(layer, i, layers.length)));
      wrap.appendChild(list);
    }
    return wrap;
  }

  // One .md layer row: [☑ enabled] 📄 name … [↑] [↓] [Open] [✕]
  function sysLayerRow(layer, i, count) {
    const enabled = layer.enabled !== false;
    const row = document.createElement('div');
    row.className = 'syslayer' + (enabled ? '' : ' disabled');

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = enabled;
    cb.title = t('Include this layer in the prompt');
    cb.addEventListener('change', () => vscode.postMessage({ type: 'toggleSysPrompt', index: i, enabled: cb.checked }));

    // Name = a fixed 📄 + the path. The path truncates from the START (CSS `direction: rtl`), so the
    // END — the part that actually differs between layers, plus the extension — is always visible.
    const name = document.createElement('span');
    name.className = 'syslayer-name';
    name.title = layer.path;
    const ico = document.createElement('span');
    ico.className = 'syslayer-ico';
    ico.textContent = '📄';
    const pathEl = document.createElement('span');
    pathEl.className = 'syslayer-path';
    pathEl.textContent = layer.path;
    name.appendChild(ico); name.appendChild(pathEl);

    // Actions live in their own box, revealed on hover/focus so the name owns the full width at rest.
    const actions = document.createElement('span');
    actions.className = 'syslayer-actions';
    const up = sysLayerBtn('↑', t('Move up'), i > 0, () => vscode.postMessage({ type: 'moveSysPrompt', index: i, to: i - 1 }));
    const down = sysLayerBtn('↓', t('Move down'), i < count - 1, () => vscode.postMessage({ type: 'moveSysPrompt', index: i, to: i + 1 }));
    const open = sysLayerBtn(t('Open'), t('Open the .md file'), true, () => vscode.postMessage({ type: 'openSysPrompt', index: i }));
    const rm = sysLayerBtn('✕', t('Remove layer'), true, () => vscode.postMessage({ type: 'removeSysPrompt', index: i }));
    actions.appendChild(up); actions.appendChild(down); actions.appendChild(open); actions.appendChild(rm);

    row.appendChild(cb); row.appendChild(name); row.appendChild(actions);
    return row;
  }

  function sysLayerBtn(label, title, enabled, onClick) {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onClick);
    return b;
  }

  // Dispatches to a per-kind builder; every branch produces the same `cfg-row param` element.
  function paramRow(item) {
    const doc = getDoc();
    const p = doc.params || {};
    const row = document.createElement('div');
    row.className = 'cfg-row param';

    if (item.kind === 'tags') return paramRowTags(item, p, row);
    if (item.kind === 'bool') return paramRowBool(item, p, row);
    return paramRowNumeric(item, p, row);
  }

  function paramRowTags(item, p, row) {
    // Standardize on the .cfg-row label-over-control layout (same as Engine/Voice): a plain <label>
    // above the control with a 4px gap — not the .param-head value-row layout (label + number box).
    row.className = 'cfg-row';
    const lab = document.createElement('label');
    lab.textContent = t(item.label);
    row.appendChild(lab);
    row.appendChild(tagsBox(p));
    return row;
  }

  function paramRowBool(item, p, row) {
    const head = document.createElement('div');
    head.className = 'param-head';
    const left = document.createElement('div');
    left.className = 'param-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!p[item.key];
    row.classList.toggle('disabled', !cb.checked); // dim when off
    cb.addEventListener('change', () => {
      row.classList.toggle('disabled', !cb.checked);
      patchParam(item.key, cb.checked);
    });
    const lab = document.createElement('span');
    lab.textContent = t(item.label);
    left.appendChild(cb);
    left.appendChild(lab);
    head.appendChild(left);
    row.appendChild(head);
    return row;
  }

  // Numeric kinds: 'int' / 'number' (box only) and 'slider' (box + range).
  function paramRowNumeric(item, p, row) {
    const val = p[item.key];
    const enabled = item.toggle ? !!(val && val.enabled) : true;
    const numValue = item.toggle ? (val ? val.value : item.min) : (typeof val === 'number' ? val : item.min);

    // Header: [checkbox] label ............ [numeric box]
    const head = document.createElement('div');
    head.className = 'param-head';

    const left = document.createElement('div');
    left.className = 'param-label';
    let check = null;
    if (item.toggle) {
      check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = enabled;
      left.appendChild(check);
    }
    const lab = document.createElement('span');
    lab.textContent = t(item.label);
    left.appendChild(lab);
    head.appendChild(left);

    const numBox = document.createElement('input');
    numBox.type = 'number';
    numBox.className = 'param-num';
    numBox.min = item.min; numBox.max = item.max; numBox.step = item.step;
    numBox.value = String(numValue);
    head.appendChild(numBox);
    row.appendChild(head);

    let slider = null;
    if (item.kind === 'slider') {
      slider = document.createElement('input');
      slider.type = 'range';
      slider.min = item.min; slider.max = item.max; slider.step = item.step;
      slider.value = String(numValue);
      row.appendChild(slider);
    }

    const setDisabled = (off) => {
      numBox.disabled = off;
      if (slider) slider.disabled = off;
      row.classList.toggle('disabled', off);
    };
    setDisabled(item.toggle && !enabled);

    const commit = () => {
      const v = clamp(parseFloat(numBox.value), item);
      numBox.value = String(v);
      if (slider) slider.value = String(v);
      if (item.toggle) patchParam(item.key, { enabled: check.checked, value: v });
      else patchParam(item.key, v);
    };

    if (slider) {
      slider.addEventListener('input', () => { numBox.value = slider.value; });
      slider.addEventListener('change', commit);
    }
    numBox.addEventListener('input', () => { if (slider) slider.value = numBox.value; });
    numBox.addEventListener('change', commit);
    if (check) {
      check.addEventListener('change', () => {
        setDisabled(!check.checked);
        patchParam(item.key, { enabled: check.checked, value: clamp(parseFloat(numBox.value), item) });
      });
    }

    return row;
  }

  function clamp(v, item) {
    if (Number.isNaN(v)) v = item.min;
    if (item.step >= 1) v = Math.round(v);
    return Math.min(item.max, Math.max(item.min, v));
  }

  // The stop-strings editor: a .tags box of removable chips + a free-text input. The label and the
  // row layout come from paramRowTags (a standard .cfg-row), so only the box is built here.
  function tagsBox(p) {
    const box = document.createElement('div');
    box.className = 'tags';
    const stops = Array.isArray(p.stop) ? p.stop.slice() : [];

    function commit() { patchParam('stop', stops.slice()); render(); }
    function render() {
      box.innerHTML = '';
      stops.forEach((s, i) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = s;
        const x = document.createElement('button');
        x.textContent = '×'; x.title = t('Remove');
        x.addEventListener('click', () => { stops.splice(i, 1); commit(); });
        tag.appendChild(x);
        box.appendChild(tag);
      });
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = t('Type and press ⏎');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          stops.push(input.value.trim());
          commit();
        }
      });
      box.appendChild(input);
    }
    render();
    return box;
  }

export { renderConfig, patchConfig, fieldRow };
