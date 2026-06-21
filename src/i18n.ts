/** Backend i18n (extension host). English is the key; each non-English language has a
 *  package.nls.<lang>.json bundle (English key → translation), which is also VS Code's manifest
 *  bundle. The active bundle is injected into the webviews. Falls back to English on any miss. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type Lang = 'en' | 'es' | 'pt' | 'fr' | 'de' | 'it';
/** Supported UI languages. English is the source (no bundle); the rest have package.nls.<lang>.json. */
export const SUPPORTED_LANGS: Lang[] = ['en', 'es', 'pt', 'fr', 'de', 'it'];

/** Effective language: respects parley.language ('auto'|code) or VS Code's locale when 'auto'. */
export function resolvedLang(): Lang {
  const pref = vscode.workspace.getConfiguration('parley').get<string>('language', 'auto');
  if (pref && pref !== 'auto' && (SUPPORTED_LANGS as string[]).includes(pref)) return pref as Lang;
  const loc = vscode.env.language.toLowerCase();
  return SUPPORTED_LANGS.find((l) => l !== 'en' && loc.startsWith(l)) ?? 'en';
}

/** Loads (once, lazily) the bundle for a language. English has none (it IS the key). */
const _bundles: Partial<Record<Lang, Record<string, string>>> = {};
function loadBundle(lang: Lang): Record<string, string> {
  if (lang === 'en') return {};
  if (!_bundles[lang]) {
    try {
      // From out/i18n.js, ../package.nls.<lang>.json resolves to the shipped manifest bundle.
      _bundles[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `package.nls.${lang}.json`), 'utf8'));
    } catch {
      _bundles[lang] = {};
    }
  }
  return _bundles[lang]!;
}

/** The translation bundle for the active language (injected into webviews). */
export function activeBundle(): Record<string, string> {
  return loadBundle(resolvedLang());
}

/** Translates a backend string to the effective language (English is the key). */
export function tr(s: string): string {
  return activeBundle()[s] ?? s;
}
