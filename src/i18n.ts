/** Backend i18n (extension host). English is the key; the Spanish bundle is the single source of
 *  truth in l10n/es.json (the same file is injected into the webviews). */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Effective language: respects langChat.language ('auto'|'en'|'es') or VS Code's locale. */
export function resolvedLang(): 'en' | 'es' {
  const pref = vscode.workspace.getConfiguration('langChat').get<string>('language', 'auto');
  if (pref === 'en' || pref === 'es') return pref;
  return vscode.env.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** Spanish bundle (English key → Spanish), loaded once. From out/i18n.js, ../l10n/es.json
 *  resolves to <extension>/l10n/es.json (shipped in the .vsix). Falls back to English on error. */
export const ES_BUNDLE: Record<string, string> = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'es.json'), 'utf8'));
  } catch {
    return {};
  }
})();

/** Translates a backend string to the effective language (English is the key). */
export function tr(s: string): string {
  return resolvedLang() === 'es' ? (ES_BUNDLE[s] ?? s) : s;
}
