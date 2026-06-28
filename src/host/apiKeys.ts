/** API-key storage: SecretStorage ⇄ provider overrides, plus the `jotflow.setApiKey` command. */
import * as vscode from 'vscode';
import { setApiKeyOverride, ProviderId } from './providers';
import { tr } from './i18n';

// Backends that use an API key. The secret is stored as `jotflow.<id>.apiKey`. Ollama only needs
// one for its cloud models (the local server proxies them once authenticated with OLLAMA_API_KEY).
const KEY_PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'openai', label: 'LM Studio / OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'ollama', label: 'Ollama (cloud)' },
];

/** Loads API keys from SecretStorage (encrypted) into the provider overrides. */
export async function loadApiKeys(context: vscode.ExtensionContext): Promise<void> {
  for (const { id } of KEY_PROVIDERS) {
    const k = await context.secrets.get(`jotflow.${id}.apiKey`);
    setApiKeyOverride(id, k || undefined);
  }
}

/** Wires API keys: initial load, live reload on secret changes, and the setApiKey command. */
export function registerApiKeys(context: vscode.ExtensionContext): void {
  void loadApiKeys(context); // populate overrides from SecretStorage on startup
  context.subscriptions.push(
    // If secrets change (another window, or the command), reload. Disposable so it is cleaned up on deactivate.
    context.secrets.onDidChange((e) => { if (e.key.startsWith('jotflow.') && e.key.endsWith('.apiKey')) void loadApiKeys(context); }),
    vscode.commands.registerCommand('jotflow.setApiKey', async () => {
      const pick = await vscode.window.showQuickPick(
        KEY_PROVIDERS.map((p) => ({ label: p.label, id: p.id })),
        { placeHolder: tr('Backend for the API key') }
      );
      if (!pick) return;
      const key = await vscode.window.showInputBox({
        password: true,
        prompt: `${tr('API key for')} ${pick.label} ${tr('(empty = delete)')}`,
        placeHolder: '••••••••',
      });
      if (key === undefined) return; // cancelled
      const secretKey = `jotflow.${pick.id}.apiKey`;
      if (key) await context.secrets.store(secretKey, key);
      else await context.secrets.delete(secretKey);
      setApiKeyOverride(pick.id, key || undefined);
      vscode.window.showInformationMessage(`${tr('API key for')} ${pick.label} ${key ? tr('saved') : tr('deleted')} ${tr('(encrypted in SecretStorage).')}`);
    })
  );
}
