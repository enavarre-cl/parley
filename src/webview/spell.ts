// Webview spell-checker: loads a hunspell dictionary (es/en) and exposes
// correct()/suggest() via nspell (bundled in spell-engine.js → window.nspell).
// The .aff/.dic files are served from media/dict and loaded with fetch (CSP connect-src).
(function () {
  let speller = null;     // active nspell instance (or null = spell-checker disabled)
  let activeLang = null;  // 'es' | 'en' | null
  let loadToken = null;   // identifies the in-flight load (avoids races when switching language)
  const cache = {};       // lang -> nspell (avoid reloading the same dictionary)
  const listeners = [];
  let customWords = {}; // user-defined words PER LANGUAGE (lang -> words[])
  const applied = {};                   // lang -> words currently injected into cache[lang]

  function emitReady() { listeners.forEach((f) => { try { f(); } catch (_) { /* nothing */ } }); }

  // Syncs the nspell instance for `lang` with customWords[lang]: ADDS new words and REMOVES
  // deleted ones (nspell.add is not self-reversing; without this, a removed word would keep being accepted).
  function syncCustom(lang) {
    const sp = cache[lang];
    if (!sp) return;
    const want = customWords[lang] || [];
    const have = applied[lang] || [];
    for (const w of have) if (want.indexOf(w) === -1) { try { sp.remove(w); } catch (_) { /* nothing */ } }
    for (const w of want) if (have.indexOf(w) === -1) { try { sp.add(w); } catch (_) { /* nothing */ } }
    applied[lang] = want.slice();
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('dict ' + r.status);
    return r.text();
  }

  // Activates the spell-checker for `lang` if it has a bundled dictionary; any other value disables it.
  async function setLang(lang) {
    if (!lang || !(window.SPELL_DICTS || {})[lang]) { speller = null; activeLang = null; loadToken = null; emitReady(); return; }
    if (activeLang === lang && speller) return;
    if (cache[lang]) { speller = cache[lang]; activeLang = lang; syncCustom(lang); emitReady(); return; }
    const d = (window.SPELL_DICTS || {})[lang];
    if (!d || !window.nspell) { speller = null; activeLang = null; emitReady(); return; }
    const token = loadToken = {};
    try {
      const [aff, dic] = await Promise.all([fetchText(d.aff), fetchText(d.dic)]);
      if (loadToken !== token) return; // a more recent load won
      const sp = window.nspell(aff, dic);
      cache[lang] = sp;
      applied[lang] = [];
      syncCustom(lang);
      speller = sp; activeLang = lang;
      emitReady();
    } catch (_) {
      if (loadToken === token) { speller = null; activeLang = null; emitReady(); }
    }
  }

  // Replaces custom words (map {lang: words[]} from the backend) and applies them to each dictionary.
  function setWords(map) {
    const clean = (a) => (Array.isArray(a) ? a.filter((w) => typeof w === 'string' && w) : []);
    customWords = {};
    if (map) for (const k of Object.keys(map)) customWords[k] = clean(map[k]);
    for (const k in cache) syncCustom(k); // reconcile (add new, remove deleted)
    emitReady();
  }

  window.LangSpell = {
    setLang,
    setWords,
    add(w) {
      const l = activeLang;
      if (!w || !l) return;
      if (!customWords[l]) customWords[l] = [];
      if (customWords[l].indexOf(w) === -1) {
        customWords[l].push(w);
        syncCustom(l);
      }
    },
    ready() { return !!speller; },
    lang() { return activeLang; },
    // No active spell-checker → everything is considered correct (nothing is underlined).
    correct(w) { return speller ? speller.correct(w) : true; },
    suggest(w) { return speller ? speller.suggest(w).slice(0, 8) : []; },
    onReady(f) { if (typeof f === 'function') listeners.push(f); },
  };
})();
