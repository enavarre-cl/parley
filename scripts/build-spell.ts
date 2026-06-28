/**
 * Refreshes the webview spell-check DATA from the npm `dictionary-*` dev deps (run via tsx):
 *   - media/dict/<lang>.{aff,dic,LICENSE}  (hunspell dictionaries + their licenses)
 * These are licensed data assets that ship as-is, so they're committed; this only re-copies them
 * when a dictionary package updates. The nspell ENGINE bundle (media/dist/spell-engine.js) is a
 * generated artifact and is built by `scripts/build-webview.ts`, not here. Run `npm run build:spell`.
 * Idempotent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url); // for require.resolve() of the dictionary packages

const LANGS: [string, string][] = [
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

console.log(`spell dictionaries refreshed for: ${LANGS.map(([l]) => l).join(', ')}`);
