import * as vscode from 'vscode';
import { LLMProvider } from './types';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';
import { validateBaseUrl } from './baseUrl';

export * from './types';
export { validateBaseUrl } from './baseUrl';

/** Single source of truth for supported backends. */
export const PROVIDER_IDS = ['openai', 'ollama', 'gemini', 'anthropic', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Type guard for a valid backend id. */
export function isProviderId(v: unknown): v is ProviderId {
  return PROVIDER_IDS.includes(v as ProviderId);
}

/** Normalizes a value to a valid backend id (defaults to 'openai'). */
export function validateProvider(v: unknown): ProviderId {
  return isProviderId(v) ? v : 'openai';
}

/**
 * Builds the provider for a specific backend. The backend choice lives in each
 * `.chat` file; connection URLs/credentials are global settings.
 */
// API keys loaded from SecretStorage (encrypted), populated by the extension on activation.
// They take priority over the settings value (which remains as fallback / compat).
const keyOverrides: Partial<Record<ProviderId, string>> = {};
export function setApiKeyOverride(id: ProviderId, key: string | undefined): void {
  if (key) keyOverrides[id] = key; else delete keyOverrides[id];
}
/** Resolves the API key for a backend: SecretStorage first, settings value as fallback. */
export function resolveApiKey(id: ProviderId): string {
  const cfg = vscode.workspace.getConfiguration('parley');
  return keyOverrides[id] || cfg.get<string>(`${id}.apiKey`, '') || '';
}

// baseUrl of the managed Ollama server (set by OllamaManager when ready).
let managedOllamaBaseUrl: string | undefined;
export function setManagedOllamaBaseUrl(url: string | undefined): void { managedOllamaBaseUrl = url; }
/** Ollama baseUrl: the managed one if active and ready; otherwise the one from settings. */
function ollamaBaseUrl(cfg: vscode.WorkspaceConfiguration): string {
  if (managedOllamaBaseUrl && cfg.get<boolean>('ollama.managed', true)) return managedOllamaBaseUrl;
  return cfg.get<string>('ollama.baseUrl', 'http://localhost:11434');
}

export function buildProvider(providerId: ProviderId): LLMProvider {
  const cfg = vscode.workspace.getConfiguration('parley');
  if (providerId === 'ollama') {
    // Managed Ollama is local and trusted; a user-set remote URL still gets sanity-checked. No key.
    return new OllamaProvider(validateBaseUrl(ollamaBaseUrl(cfg), { hasKey: false }));
  }
  if (providerId === 'gemini') {
    const key = resolveApiKey('gemini');
    return new GeminiProvider(
      validateBaseUrl(cfg.get<string>('gemini.baseUrl', 'https://generativelanguage.googleapis.com/v1beta'), { hasKey: !!key }),
      key
    );
  }
  if (providerId === 'anthropic') {
    const key = resolveApiKey('anthropic');
    return new AnthropicProvider(
      validateBaseUrl(cfg.get<string>('anthropic.baseUrl', 'https://api.anthropic.com/v1'), { hasKey: !!key }),
      key
    );
  }
  if (providerId === 'openrouter') {
    // OpenRouter is compatible with the OpenAI API and supports the `reasoning` parameter.
    const key = resolveApiKey('openrouter');
    return new OpenAIProvider(
      validateBaseUrl(cfg.get<string>('openrouter.baseUrl', 'https://openrouter.ai/api/v1'), { hasKey: !!key }),
      key,
      true,
      cfg.get<string>('openrouter.sort', '')
    );
  }
  const key = resolveApiKey('openai');
  return new OpenAIProvider(
    validateBaseUrl(cfg.get<string>('openai.baseUrl', 'http://localhost:1234/v1'), { hasKey: !!key }),
    key
  );
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  endpoint: string;
  needsKey: boolean;
  hasKey: boolean;
}

/** Describes the active backend: human-readable label, endpoint, and API key status. */
export function providerInfo(id: ProviderId): ProviderInfo {
  const cfg = vscode.workspace.getConfiguration('parley');
  if (id === 'ollama') {
    return {
      id,
      label: 'Ollama',
      endpoint: ollamaBaseUrl(cfg),
      needsKey: false,
      hasKey: true,
    };
  }
  if (id === 'gemini') {
    return {
      id,
      label: 'Google Gemini',
      endpoint: cfg.get<string>('gemini.baseUrl', 'https://generativelanguage.googleapis.com/v1beta'),
      needsKey: true,
      hasKey: !!resolveApiKey('gemini'),
    };
  }
  if (id === 'anthropic') {
    return {
      id,
      label: 'Anthropic Claude',
      endpoint: cfg.get<string>('anthropic.baseUrl', 'https://api.anthropic.com/v1'),
      needsKey: true,
      hasKey: !!resolveApiKey('anthropic'),
    };
  }
  if (id === 'openrouter') {
    return {
      id,
      label: 'OpenRouter',
      endpoint: cfg.get<string>('openrouter.baseUrl', 'https://openrouter.ai/api/v1'),
      needsKey: true,
      hasKey: !!resolveApiKey('openrouter'),
    };
  }
  return {
    id,
    label: 'LM Studio / OpenAI',
    endpoint: cfg.get<string>('openai.baseUrl', 'http://localhost:1234/v1'),
    needsKey: false,
    hasKey: true,
  };
}

/** Default values for new `.chat` files. */
export function chatDefaults() {
  const cfg = vscode.workspace.getConfiguration('parley');
  return {
    provider: cfg.get<ProviderId>('provider', 'openai'),
    temperature: cfg.get<number>('temperature', 0.7),
    maxTokens: cfg.get<number>('maxTokens', 2048),
  };
}
