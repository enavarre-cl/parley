/**
 * Connection status, model selector (grouped, with context/capabilities), token usage chip,
 * and the context-budget bar. Owns the model→context/caps maps.
 */
import { t } from '../core/i18n.js';
import { ICONS } from '../core/icons.js';
import { $, escapeHtml } from '../core/dom.js';
import { getDoc } from '../ui/store.js';

const statusDot = $('statusDot');
const statusText = $('statusText');
const modelSelect = $('modelSelect') as HTMLSelectElement;
const modelCtxEl = $('modelCtx');
const modelCapsEl = $('modelCaps');
const usageChipEl = $('usageChip');
const ctxBar = $('ctxBar');
const ctxFill = $('ctxFill');
const ctxLabel = $('ctxLabel');

let modelContext = {}; // model id -> context tokens
let modelCaps = {}; // model id -> capabilities

const CTX_BUDGET_RATIO = 0.75; // auto context budget = this fraction of the model window

// ---- Connection status ----
  let statusInfo = null, statusState = 'checking', statusDetail = '';
  function renderStatus(info, state, detail) {
    statusInfo = info; statusState = state; statusDetail = detail || '';
    paintStatus();
  }
  // Composes the status: provider · active model (or the detail if no model).
  function paintStatus() {
    if (!statusInfo) return;
    statusDot.className = statusState;
    const model = modelSelect.value;
    let txt = statusInfo.label;
    if (model) txt += ' · ' + model;
    else if (statusDetail) txt += ' · ' + statusDetail;
    statusText.textContent = txt;
    statusText.title = statusInfo.label + ' — ' + statusInfo.endpoint + (statusDetail ? ' (' + statusDetail + ')' : '');
  }

  // ---- Models ----
  function fmtTokens(n) {
    if (!n) return '';
    if (n >= 1e6) return (n % 1e6 ? (n / 1e6).toFixed(1) : n / 1e6) + 'M';
    if (n >= 1e3) return Math.round(n / 1000) + 'K';
    return String(n);
  }
  function updateModelCtx() {
    const n = modelContext[modelSelect.value];
    modelCtxEl.textContent = n ? fmtTokens(n) : '';
    modelCtxEl.title = n ? n.toLocaleString() + ' ' + t('model context tokens') : '';
    updateModelCaps();
    paintStatus();
  }
  function updateModelCaps() {
    const c = modelCaps[modelSelect.value] || {};
    const caps = [];
    if (c.reasoning) caps.push(['spark', t('Reasoning / thinking')]);
    if (c.vision) caps.push(['eye', t('Vision (images)')]);
    if (c.audio) caps.push(['audio', t('Audio')]);
    if (c.files) caps.push(['file', t('Files / documents')]);
    if (c.tools) caps.push(['tool', t('Tools / function calling')]);
    // Tooltip on both the span (title) and inside the SVG (<title>), for maximum compatibility.
    modelCapsEl.innerHTML = caps.map((c) => {
      const label = escapeHtml(c[1]); // labels are translations, but escape before innerHTML anyway
      // Splice the <title> in right after the opening <svg …> tag. Explicit slice (not .replace('>'),
      // which CodeQL flags as incomplete sanitization — js/incomplete-sanitization); `label` is escaped.
      const raw = ICONS[c[0]];
      const gt = raw.indexOf('>') + 1;
      const svg = raw.slice(0, gt) + '<title>' + label + '</title>' + raw.slice(gt);
      return '<span class="cap" title="' + label + '">' + svg + '</span>';
    }).join('');
  }

  function renderModels(models, current, error) {
    const doc = getDoc();
    modelSelect.innerHTML = '';
    modelContext = {};
    modelCaps = {};
    if (error || models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = error ? t('No connection') : t('No models');
      modelSelect.appendChild(opt);
      updateModelCtx();
      return;
    }
    for (const info of models) {
      if (info.contextLength) modelContext[info.id] = info.contextLength;
      modelCaps[info.id] = {
        vision: info.vision, files: info.files, audio: info.audio,
        tools: info.tools, reasoning: info.reasoning,
      };
    }

    // Group by provider (the prefix before '/', e.g. openai/gpt-4o-mini).
    const groups = new Map();
    for (const info of models) {
      const m = info.id;
      const slash = m.indexOf('/');
      const vendor = slash > 0 ? m.slice(0, slash) : '';
      if (!groups.has(vendor)) groups.set(vendor, []);
      groups.get(vendor).push(m);
    }

    const named = [...groups.keys()].filter((v) => v).sort((a, b) => a.localeCompare(b));
    const order = groups.has('') ? [...named, ''] : named; // no provider prefix, goes last

    const addOption = (parent, m, label) => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = label;
      if (m === current) opt.selected = true;
      parent.appendChild(opt);
    };

    for (const vendor of order) {
      const list = groups.get(vendor).sort((a, b) => a.localeCompare(b));
      if (vendor) {
        const og = document.createElement('optgroup');
        og.label = vendor;
        // Inside the group, just the model name is enough (without the vendor prefix).
        for (const m of list) addOption(og, m, m.slice(vendor.length + 1));
        modelSelect.appendChild(og);
      } else {
        for (const m of list) addOption(modelSelect, m, m);
      }
    }
    updateModelCtx();
    if (doc) doc.model = current;
  }

// ---- Context usage bar (by tokens) ----
  function estTokens(s) { return s ? Math.ceil(s.length / 4) : 0; }
  function msgTokens(m) {
    let t = estTokens(m.content) + 4;
    for (const a of (m.attachments || [])) t += a.kind === 'image' ? 1200 : estTokens(a.data);
    return t;
  }
  // Effective token budget: auto = 75% of the model window.
  function ctxBudget() {
    const modelCtx = modelContext[modelSelect.value];
    return modelCtx ? Math.floor(modelCtx * CTX_BUDGET_RATIO) : 16000;
  }
  // Tokens of the EFFECTIVE system prompt. The backend sends sysPromptTokens (file content included);
  // fall back to estimating the inline prompt if it's an older payload without that field.
  function sysPromptTokens() {
    const doc = getDoc();
    if (!doc) return 0;
    return typeof doc.sysPromptTokens === 'number' ? doc.sysPromptTokens : estTokens(doc.systemPrompt || '');
  }
  // Effective start index for "last N": the NEAREST cut wins (N messages vs token budget).
  // Exact replica of the backend's trimming so the divider matches what is actually sent.
  function lastNStart(msgs, n) {
    const budget = ctxBudget();
    let acc = sysPromptTokens();
    let start = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs.length - i > n) break;                       // cap: N messages
      const tk = msgTokens(msgs[i]);
      if (acc + tk > budget && start < msgs.length) break;  // cap: token budget
      acc += tk;
      start = i;
    }
    return start;
  }
  function updateUsage() {
    const doc = getDoc();
    // Calculated by summing the usage of the current messages (not a fixed accumulator).
    let pt = 0, ct = 0, tt = 0, cost = 0, has = false;
    const add = (u) => { if (u) { has = true; pt += u.promptTokens || 0; ct += u.completionTokens || 0; tt += u.totalTokens || 0; if (u.cost) cost += u.cost; } };
    for (const m of (doc && doc.messages) || []) {
      // If there are variants (retries), sum ALL of them (each was a paid call).
      if (Array.isArray(m.variants) && m.variants.length) {
        for (const v of m.variants) add(v.usage);
      } else {
        add(m.usage);
      }
    }
    if (!has || !tt) { usageChipEl.textContent = ''; return; }
    usageChipEl.textContent = fmtTokens(tt) + ' tok' + (cost ? ' · $' + cost.toFixed(cost < 0.01 ? 4 : 2) : '');
    usageChipEl.title = `${t('Tokens (current messages)')} — ${t('input')}: ${pt.toLocaleString()} · ${t('output')}: ${ct.toLocaleString()} · ${t('total')}: ${tt.toLocaleString()}`
      + (cost ? `\n${t('Cost')}: $${cost.toFixed(6)}` : '');
  }

  function updateContextBar() {
    const doc = getDoc();
    // Applies with auto-summary OR "last N" (both trim what is sent).
    if (!doc || !doc.params) { ctxBar.classList.add('hidden'); return; }
    const cm = doc.params.contextMessages;
    const lastN = (cm && cm.enabled && cm.value > 0) ? cm.value : 0; // wins over the summary
    if (!lastN && !doc.params.autoSummary) { ctxBar.classList.add('hidden'); return; }
    const budget = ctxBudget();
    const msgs = doc.messages || [];
    let total = sysPromptTokens();
    if (lastN) {
      // Only the effective "last N" window (bounded by the budget; no summary).
      for (let i = lastNStart(msgs, lastN); i < msgs.length; i++) total += msgTokens(msgs[i]);
    } else {
      const upTo = doc.summary ? doc.summary.upTo : 0;
      total += estTokens(doc.summary ? doc.summary.text : '');
      for (let i = upTo; i < msgs.length; i++) total += msgTokens(msgs[i]);
    }
    const pct = Math.min(100, Math.round((total / budget) * 100));
    ctxBar.classList.remove('hidden');
    ctxFill.style.width = pct + '%';
    ctxFill.className = pct >= 90 ? 'high' : pct >= 60 ? 'mid' : '';
    ctxLabel.textContent = `${t('Context')} ${fmtTokens(total)}/${fmtTokens(budget)} (${pct}%)`;
  }

export { renderStatus, paintStatus, renderModels, updateModelCtx, updateModelCaps, fmtTokens,
  estTokens, msgTokens, ctxBudget, sysPromptTokens, lastNStart, updateUsage, updateContextBar,
  modelSelect };
