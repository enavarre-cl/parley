// Generic DOM/string helpers shared across the webview modules.

export const $ = (id: string): HTMLElement | null => document.getElementById(id);

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

/**
 * Points an <img> at a base64 attachment via a Blob object URL (`blob:`), not a `data:` string —
 * so untrusted bytes never flow into a URL string sink (avoids the CodeQL url-redirection/xss-dom
 * false positives on `img.src = 'data:'+…`). Validates the mime is an image and the payload is
 * base64; revokes the object URL once loaded so it doesn't leak across re-renders.
 */
export function setImageSrc(img: HTMLImageElement, mime: string, data: string): void {
  if (!/^image\/[\w.+-]+$/i.test(mime || '') || !/^[A-Za-z0-9+/=]+$/.test(data || '')) return;
  let bytes: Uint8Array;
  try {
    const bin = atob(data);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return; } // not valid base64
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const revoke = (): void => URL.revokeObjectURL(url);
  img.addEventListener('load', revoke, { once: true });
  img.addEventListener('error', revoke, { once: true });
  img.src = url;
}

// An icon button with a custom tooltip (data-tip → CSS) instead of the slow/unreliable native
// `title`; aria-label for a11y.
export function iconButton(svg: string, title: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
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
let tipTarget: Element | null = null;
function showTip(el: Element): void {
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
  const left = Math.max(4, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 4));
  tipEl.style.top = Math.round(top) + 'px';
  tipEl.style.left = Math.round(left) + 'px';
  tipEl.style.visibility = 'visible';
}
function hideTip(): void { tipEl.classList.add('hidden'); tipTarget = null; }
document.addEventListener('mouseover', (e) => {
  const tgt = e.target as any; const el = tgt.closest ? tgt.closest('[data-tip]') : null;
  if (el && el !== tipTarget) showTip(el);
});
document.addEventListener('mouseout', (e) => {
  if (!tipTarget) return;
  const tgt = e.target as any; const el = tgt.closest ? tgt.closest('[data-tip]') : null;
  if (el === tipTarget && !(e.relatedTarget && tipTarget.contains(e.relatedTarget as Node))) hideTip();
});
document.addEventListener('scroll', hideTip, true); // never let it stick while scrolling
window.addEventListener('blur', hideTip);
