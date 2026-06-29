/** Applies to a ChatDoc only the valid keys arriving from the webview (incl. nested config). */
import { ChatDoc, ChatParams } from './chatDocument';
import { isProviderId } from './providers';
import { SPELL_LANGS } from './spellWords';

const TOGGLE_KEYS: (keyof ChatParams)[] = [
  'maxTokens', 'contextMessages', 'contextLength', 'numThreads', 'topK', 'topP', 'minP', 'topA',
  'repeatPenalty', 'presencePenalty', 'frequencyPenalty', 'seed',
];

/** A partial config update from the config panel/webview. Every field is optional and re-validated
 * here before touching the doc — the webview is trusted code, but the value still crosses a JSON
 * boundary, so each access is guarded. */
export interface ChatPatch {
  title?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  systemPromptGlob?: string;
  spellLang?: string;
  ui?: { thinkOpen?: boolean; toolsOpen?: boolean; configSections?: string[]; zoom?: number };
  params?: Record<string, unknown>;
}

export function applyPatch(doc: ChatDoc, patch: ChatPatch | null | undefined): void {
  if (!patch || typeof patch !== 'object') return;
  if (typeof patch.title === 'string') doc.title = patch.title;
  if (isProviderId(patch.provider)) {
    doc.provider = patch.provider;
  }
  if (typeof patch.model === 'string') doc.model = patch.model;
  if (typeof patch.systemPrompt === 'string') doc.systemPrompt = patch.systemPrompt;
  if (typeof patch.systemPromptGlob === 'string') {
    doc.systemPromptGlob = patch.systemPromptGlob.trim() ? patch.systemPromptGlob : undefined;
  }
  if (typeof patch.spellLang === 'string' && ['auto', 'off', ...SPELL_LANGS].includes(patch.spellLang)) {
    doc.spellLang = patch.spellLang as ChatDoc['spellLang'];
  }

  if (patch.ui && typeof patch.ui === 'object') {
    doc.ui = doc.ui || {};
    if (typeof patch.ui.thinkOpen === 'boolean') doc.ui.thinkOpen = patch.ui.thinkOpen;
    if (typeof patch.ui.toolsOpen === 'boolean') doc.ui.toolsOpen = patch.ui.toolsOpen;
    if (Array.isArray(patch.ui.configSections)) {
      doc.ui.configSections = patch.ui.configSections.filter((s): s is string => typeof s === 'string');
    }
    if (typeof patch.ui.zoom === 'number' && Number.isFinite(patch.ui.zoom)) doc.ui.zoom = patch.ui.zoom;
  }

  const p = patch.params;
  if (p && typeof p === 'object') {
    if (typeof p.temperature === 'number' && !Number.isNaN(p.temperature)) {
      doc.params.temperature = p.temperature;
    }
    if (Array.isArray(p.stop)) {
      doc.params.stop = (p.stop as unknown[]).filter((s): s is string => typeof s === 'string');
    }
    if (typeof p.thinking === 'boolean') {
      doc.params.thinking = p.thinking;
    }
    if (typeof p.autoSummary === 'boolean') {
      doc.params.autoSummary = p.autoSummary;
    }
    if (typeof p.tools === 'boolean') {
      doc.params.tools = p.tools;
    }
    for (const key of TOGGLE_KEYS) {
      const incoming = p[key];
      if (!incoming || typeof incoming !== 'object') continue;
      const inc = incoming as { enabled?: unknown; value?: unknown };
      const current = doc.params[key] as { enabled: boolean; value: number };
      if (typeof inc.enabled === 'boolean') current.enabled = inc.enabled;
      if (typeof inc.value === 'number' && !Number.isNaN(inc.value)) {
        current.value = inc.value;
      }
    }
  }
}
