// Thin wrapper over the classic LangI18n script (loaded before the module entry, so window.LangI18n
// is already set when any module evaluates). English strings are the keys.
export const t = (s: string): string => window.LangI18n.t(s);
