import * as vscode from 'vscode';
import { LLMProvider } from './types';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';

export * from './types';

/** Única fuente de verdad de los backends soportados. */
export const PROVIDER_IDS = ['openai', 'ollama', 'gemini', 'anthropic', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Type guard para un id de backend válido. */
export function isProviderId(v: any): v is ProviderId {
  return PROVIDER_IDS.includes(v);
}

/** Normaliza un valor a un id de backend válido (por defecto 'openai'). */
export function validateProvider(v: any): ProviderId {
  return isProviderId(v) ? v : 'openai';
}

/**
 * Construye el provider para un backend concreto. La elección de backend vive
 * en cada archivo `.chat`; las URLs/credenciales de conexión son ajustes globales.
 */
// API keys cargadas desde SecretStorage (cifrado), pobladas por la extensión al activar.
// Tienen prioridad sobre el ajuste en settings (que queda como fallback / compat).
const keyOverrides: Partial<Record<ProviderId, string>> = {};
export function setApiKeyOverride(id: ProviderId, key: string | undefined): void {
  if (key) keyOverrides[id] = key; else delete keyOverrides[id];
}
/** Resuelve la API key de un backend: SecretStorage primero, ajuste de settings como fallback. */
export function resolveApiKey(id: ProviderId): string {
  const cfg = vscode.workspace.getConfiguration('langChat');
  return keyOverrides[id] || cfg.get<string>(`${id}.apiKey`, '') || '';
}

// baseUrl del servidor Ollama gestionado (lo fija el OllamaManager cuando está listo).
let managedOllamaBaseUrl: string | undefined;
export function setManagedOllamaBaseUrl(url: string | undefined): void { managedOllamaBaseUrl = url; }
/** baseUrl de Ollama: el gestionado si está activo y listo; si no, el de settings. */
function ollamaBaseUrl(cfg: vscode.WorkspaceConfiguration): string {
  if (managedOllamaBaseUrl && cfg.get<boolean>('ollama.managed', true)) return managedOllamaBaseUrl;
  return cfg.get<string>('ollama.baseUrl', 'http://localhost:11434');
}

export function buildProvider(providerId: ProviderId): LLMProvider {
  const cfg = vscode.workspace.getConfiguration('langChat');
  if (providerId === 'ollama') {
    return new OllamaProvider(ollamaBaseUrl(cfg));
  }
  if (providerId === 'gemini') {
    return new GeminiProvider(
      cfg.get<string>('gemini.baseUrl', 'https://generativelanguage.googleapis.com/v1beta'),
      resolveApiKey('gemini')
    );
  }
  if (providerId === 'anthropic') {
    return new AnthropicProvider(
      cfg.get<string>('anthropic.baseUrl', 'https://api.anthropic.com/v1'),
      resolveApiKey('anthropic')
    );
  }
  if (providerId === 'openrouter') {
    // OpenRouter es compatible con la API de OpenAI, y admite el parámetro `reasoning`.
    return new OpenAIProvider(
      cfg.get<string>('openrouter.baseUrl', 'https://openrouter.ai/api/v1'),
      resolveApiKey('openrouter'),
      true,
      cfg.get<string>('openrouter.sort', '')
    );
  }
  return new OpenAIProvider(
    cfg.get<string>('openai.baseUrl', 'http://localhost:1234/v1'),
    resolveApiKey('openai')
  );
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  endpoint: string;
  needsKey: boolean;
  hasKey: boolean;
}

/** Describe el backend activo: etiqueta legible, endpoint y estado de la API key. */
export function providerInfo(id: ProviderId): ProviderInfo {
  const cfg = vscode.workspace.getConfiguration('langChat');
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

/** Valores por defecto para nuevos archivos `.chat`. */
export function chatDefaults() {
  const cfg = vscode.workspace.getConfiguration('langChat');
  return {
    provider: cfg.get<ProviderId>('provider', 'openai'),
    temperature: cfg.get<number>('temperature', 0.7),
    maxTokens: cfg.get<number>('maxTokens', 2048),
  };
}
