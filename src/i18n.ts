/** Backend i18n (extension host). English is the key; the Spanish bundle is the single source of
 *  truth in package.nls.es.json — the VS Code-mandated manifest bundle, reused at runtime so there
 *  is ONE language file. The same bundle is injected into the webviews. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Effective language: respects langChat.language ('auto'|'en'|'es') or VS Code's locale. */
export function resolvedLang(): 'en' | 'es' {
  const pref = vscode.workspace.getConfiguration('langChat').get<string>('language', 'auto');
  if (pref === 'en' || pref === 'es') return pref;
  return vscode.env.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** Spanish bundle (English key → Spanish), loaded once. From out/i18n.js, ../package.nls.es.json
 *  resolves to <extension>/package.nls.es.json (shipped in the .vsix; also read natively by VS Code
 *  for the manifest). Manifest keys (dotted) coexist harmlessly with runtime keys (English text).
 *  Falls back to English on error. */
export const ES_BUNDLE: Record<string, string> = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.es.json'), 'utf8'));
  } catch {
    return {};
  }
})();

/** Translates a backend string to the effective language (English is the key). */
export function tr(s: string): string {
  return resolvedLang() === 'es' ? (ES_BUNDLE[s] ?? s) : s;
}
