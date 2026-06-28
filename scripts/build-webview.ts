/**
 * Webview build (run via tsx). Emits everything the webview loads into `media/dist/`:
 *   1. `app.js` — the chat module graph (ESM, <script type="module">). esbuild resolves `.js` import
 *      specifiers to their `.ts` sources, so the graph migrates `.js`→`.ts` freely.
 *   2. one IIFE per classic global / standalone-panel webview: i18n, spell, models, modelsFormat,
 *      voices, compare, dictionary, engines.
 *   3. `spell-engine.js` — the third-party `nspell` library bundled to an IIFE (exposes window.nspell).
 * All generated → `media/dist/` is git-ignored, built on `npm run dev` and `vscode:prepublish`. The
 * only un-built `.js` is the vendored `mermaid.min.js`. Type-checking is a separate gate
 * (`tsc -p media/jsconfig.json`); the dictionary DATA is refreshed by `scripts/build-spell.ts`.
 */
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';

// During the migration a source may be .ts (done) or .js (not yet) — esbuild handles either.
const src = (p: string): string => (existsSync(p.replace(/\.js$/, '.ts')) ? p.replace(/\.js$/, '.ts') : p);

const CLASSIC = ['i18n', 'spell', 'models', 'modelsFormat', 'voices', 'compare', 'dictionary', 'engines'];

async function build(): Promise<void> {
  await esbuild.build({
    entryPoints: [src('media/app/main.js')],
    outfile: 'media/dist/app.js',
    bundle: true, format: 'esm', target: 'es2020', sourcemap: true, logLevel: 'warning',
  });
  await esbuild.build({
    entryPoints: Object.fromEntries(CLASSIC.map((n) => [n, src(`media/${n}.js`)])),
    outdir: 'media/dist',
    bundle: true, format: 'iife', target: 'es2020', sourcemap: true, logLevel: 'warning',
  });
  // The nspell spell engine, bundled for the browser sandbox (no temp file: esbuild stdin).
  await esbuild.build({
    stdin: { contents: "const nspell = require('nspell'); if (typeof window !== 'undefined') window.nspell = nspell;", resolveDir: '.', loader: 'js' },
    outfile: 'media/dist/spell-engine.js',
    bundle: true, format: 'iife', target: 'es2020', logLevel: 'warning',
  });
}

build().catch(() => process.exit(1));
