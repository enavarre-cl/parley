// Generic DOM/string helpers shared across the webview modules.

export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// An icon button with a custom tooltip (data-tip → CSS) instead of the slow/unreliable native
// `title`; aria-label for a11y.
export function iconButton(svg, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-act';
  b.dataset.tip = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// ---- Floating tooltip for any [data-tip] element (native `title` doesn't render reliably in
// webviews). Self-initializes once on import. ----
const tipEl = document.createElement('div');
tipEl.id = 'tip';
tipEl.className = 'hidden';
document.body.appendChild(tipEl);
let tipTarget = null;
function showTip(el) {
  const text = el.getAttribute('data-tip');
  if (!text) { hideTip(); return; }
  tipTarget = el;
  tipEl.textContent = text;
  tipEl.style.visibility = 'hidden';
  tipEl.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  let top = r.bottom + 6;
  if (top + th > window.innerHeight - 4) top = r.top - th - 6; // flip above if no room below
  let left = Math.max(4, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 4));
  tipEl.style.top = Math.round(top) + 'px';
  tipEl.style.left = Math.round(left) + 'px';
  tipEl.style.visibility = 'visible';
}
function hideTip() { tipEl.classList.add('hidden'); tipTarget = null; }
document.addEventListener('mouseover', (e) => {
  const tgt = /** @type {any} */ (e.target); const el = tgt.closest ? tgt.closest('[data-tip]') : null;
  if (el && el !== tipTarget) showTip(el);
});
document.addEventListener('mouseout', (e) => {
  if (!tipTarget) return;
  const tgt = /** @type {any} */ (e.target); const el = tgt.closest ? tgt.closest('[data-tip]') : null;
  if (el === tipTarget && !(e.relatedTarget && tipTarget.contains(e.relatedTarget))) hideTip();
});
document.addEventListener('scroll', hideTip, true); // never let it stick while scrolling
window.addEventListener('blur', hideTip);
