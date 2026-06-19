// Webview i18n. "English as key" strategy: the source text (in code and HTML) is English and IS
// the key. The Spanish bundle is the single source of truth in l10n/es.json, injected into the
// webview HTML as `window.I18N_ES`. t() returns English as-is for 'en', or its Spanish translation
// for 'es' (with fallback to English when an entry is missing).
(function () {
  const ES = (typeof window !== 'undefined' && window.I18N_ES) || {};

  let _lang = 'en';
  window.LangI18n = {
    set(l) { _lang = l === 'es' ? 'es' : 'en'; },
    get() { return _lang; },
    t(s) { return _lang === 'es' ? (ES[s] || s) : s; },
    applyStatic(root) {
      root = root || document;
      const self = this;
      root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = self.t(el.getAttribute('data-i18n')); });
      root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = self.t(el.getAttribute('data-i18n-title')); });
      root.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = self.t(el.getAttribute('data-i18n-ph')); });
    },
  };
})();
