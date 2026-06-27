// Notices bar: dismissible info/error banners and the persistent "summarizing…" indicator.
import { t } from '../core/i18n.js';
import { $ } from '../core/dom.js';

const noticesEl = $('notices');

export function notice(text, isError) {
  const el = document.createElement('div');
  el.className = 'banner' + (isError ? ' error' : '');
  const span = document.createElement('span');
  span.className = 'banner-text';
  span.textContent = text;
  const x = document.createElement('button');
  x.className = 'banner-x';
  x.textContent = '×';
  x.title = t('Dismiss');
  x.addEventListener('click', () => el.remove());
  el.appendChild(span);
  el.appendChild(x);
  noticesEl.appendChild(el);
  if (!isError) setTimeout(() => el.remove(), 6000); // informational notices auto-dismiss
  return el;
}

// Persistent "summarizing…" indicator (with spinner); lasts the whole operation, no auto-dismiss.
let summarizingEl = null;
export function showSummarizing(text) {
  if (summarizingEl && summarizingEl.isConnected) return;
  const el = document.createElement('div');
  el.className = 'banner summarizing';
  const spin = document.createElement('span');
  spin.className = 'banner-spin';
  const span = document.createElement('span');
  span.className = 'banner-text';
  span.textContent = text || ('🗜️ ' + t('Context summarized up to here'));
  el.appendChild(spin);
  el.appendChild(span);
  noticesEl.appendChild(el);
  summarizingEl = el;
}
export function hideSummarizing() { if (summarizingEl) { summarizingEl.remove(); summarizingEl = null; } }

// Persistent read-aloud progress indicator with a fill bar (for slow neural TTS like Chatterbox).
let ttsEl = null;
export function showTtsProgress(pct, text) {
  if (!ttsEl || !ttsEl.isConnected) {
    ttsEl = document.createElement('div');
    ttsEl.className = 'banner tts-progress';
    const spin = document.createElement('span');
    spin.className = 'banner-spin';
    const span = document.createElement('span');
    span.className = 'banner-text';
    const bar = document.createElement('div');
    bar.className = 'tts-bar';
    const fill = document.createElement('div');
    fill.className = 'tts-bar-fill';
    bar.appendChild(fill);
    ttsEl.appendChild(spin);
    ttsEl.appendChild(span);
    ttsEl.appendChild(bar);
    ttsEl._span = span;
    ttsEl._fill = fill;
    noticesEl.appendChild(ttsEl);
  }
  ttsEl._span.textContent = text || ('🔊 ' + t('Generating audio…'));
  const p = typeof pct === 'number' ? Math.max(0, Math.min(1, pct)) : 0;
  ttsEl._fill.style.width = Math.round(p * 100) + '%';
}
export function hideTtsProgress() { if (ttsEl) { ttsEl.remove(); ttsEl = null; } }

// Clears the notices bar and the summarizing indicator. (Per-turn tool activity is reset
// separately by the conversation module.)
export function clearNotices() { noticesEl.innerHTML = ''; summarizingEl = null; }
