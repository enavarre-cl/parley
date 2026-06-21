// Regenerates the webview spell-check assets from the npm `dictionary-*` dev deps:
//   - media/dict/<lang>.{aff,dic,LICENSE}  (hunspell dictionaries + their licenses)
//   - media/spell-engine.js                (the nspell engine bundled for the browser sandbox)
// Run with `npm run build:spell`. Idempotent.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const LANGS = [
  ['es', 'dictionary-es'],
  ['en', 'dictionary-en'],
  ['pt', 'dictionary-pt'],
  ['fr', 'dictionary-fr'],
  ['de', 'dictionary-de'],
  ['it', 'dictionary-it'],
];

fs.mkdirSync('media/dict', { recursive: true });
for (const [lang, pkg] of LANGS) {
  // Resolve the package's own dir via its main entry (the `index.aff` subpath is blocked by the
  // package's `exports` map); the .aff/.dic/license live alongside index.js.
  const dir = path.dirname(require.resolve(pkg));
  fs.copyFileSync(path.join(dir, 'index.aff'), `media/dict/${lang}.aff`);
  fs.copyFileSync(path.join(dir, 'index.dic'), `media/dict/${lang}.dic`);
  try {
    fs.copyFileSync(path.join(dir, 'license'), `media/dict/${lang}.LICENSE`);
  } catch {
    /* some dictionary packages name the license file differently — keep the existing one */
  }
}

// Bundle nspell for the webview (exposes window.nspell).
const entry = 'media/_spell-entry.js';
fs.writeFileSync(entry, "const nspell = require('nspell'); if (typeof window !== 'undefined') window.nspell = nspell;");
esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'iife', outfile: 'media/spell-engine.js' });
fs.unlinkSync(entry);

console.log(`spell assets rebuilt for: ${LANGS.map(([l]) => l).join(', ')}`);
