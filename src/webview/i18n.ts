// Webview i18n. "English as key" strategy: the source text (in code and HTML) is English and IS
// the key. Each non-English language has a package.nls.<lang>.json bundle (the same VS Code manifest
// bundle); the ACTIVE language's bundle is injected into the webview HTML as `window.I18N_BUNDLE`
// (with `window.I18N_LANG`). t() returns the translation, or English as-is when a key is missing.
// On a live language change the extension sends a fresh bundle (see setBundle / the 'lang' message).
(function () {
  let BUNDLE = (typeof window !== 'undefined' && window.I18N_BUNDLE) || {};
  let _lang = (typeof window !== 'undefined' && window.I18N_LANG) || 'en';

  window.LangI18n = {
    set(l) { _lang = l || 'en'; },
    setBundle(b) { BUNDLE = b || {}; },
    get() { return _lang; },
    t(s) { return BUNDLE[s] || s; },
    applyStatic(root) {
      root = root || document;
      const self = this;
      root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = self.t(el.getAttribute('data-i18n')); });
      root.querySelectorAll('[data-i18n-title]').forEach((el) => { const v = self.t(el.getAttribute('data-i18n-title')); el.title = v; el.dataset.tip = v; });
      root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = self.t(el.getAttribute('data-i18n-ph')); });
    },
  };
})();
