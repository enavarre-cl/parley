import * as vscode from 'vscode';
import { buildProvider, providerInfo } from './providers';
import { tr } from './i18n';
import { errMsg } from './chatHelpers';
import { ChatDoc } from './chatDocument';

export interface LoadModelsDeps {
  webview: vscode.Webview;
  getDoc: () => ChatDoc | null;
  writeDoc: (doc: ChatDoc, opts?: { save?: boolean; prune?: boolean }) => Promise<void>;
  sendStatus: (state: 'checking' | 'ok' | 'error', detail?: string) => void;
  modelContextsRef: { value: Record<string, number> };
}

/** Fetches the provider model list, updates the model-context map, and posts status/models. */
export function makeLoadModels(deps: LoadModelsDeps): () => Promise<void> {
  const { webview, getDoc, writeDoc, sendStatus, modelContextsRef } = deps;
    const loadModels = async (): Promise<void> => {
      const doc = getDoc();
      if (!doc) return;
      const info = providerInfo(doc.provider);
      sendStatus('checking');

      if (info.needsKey && !info.hasKey) {
        webview.postMessage({
          type: 'models',
          provider: doc.provider,
          models: [],
          current: '',
          error: `${tr('Missing the API key for')} ${info.label}. ${tr('Set it in the settings (🔧).')}`,
        });
        sendStatus('error', tr('missing API key'));
        return;
      }

      try {
        let models = await buildProvider(doc.provider).listModels();
        // Global OpenRouter vendor filter (prefix before '/').
        if (doc.provider === 'openrouter') {
          const cfg = vscode.workspace.getConfiguration('jotflow');
          const vendors = cfg.get<string[]>('openrouter.vendors', []);
          if (vendors.length) {
            models = models.filter((m) => vendors.includes(m.id.split('/')[0]));
          }
          // Custom model ids the API doesn't list (new/preview). Always included, before the vendor list.
          const custom = cfg.get<string[]>('openrouter.customModels', []).map((s) => (s || '').trim()).filter(Boolean);
          const present = new Set(models.map((m) => m.id));
          for (const id of [...custom].reverse()) {
            if (!present.has(id)) { models.unshift({ id }); present.add(id); }
          }
        }
        modelContextsRef.value = {};
        for (const m of models) if (m.contextLength) modelContextsRef.value[m.id] = m.contextLength;
        const ids = models.map((m) => m.id);
        let current = doc.model;
        if ((!current || !ids.includes(current)) && ids.length > 0) {
          current = ids[0];
          doc.model = current;
          await writeDoc(doc);
        }
        webview.postMessage({ type: 'models', provider: doc.provider, models, current });
        sendStatus('ok', `${models.length} ${tr(models.length === 1 ? 'model' : 'models')}`);
      } catch (err) {
        webview.postMessage({ type: 'models', provider: doc.provider, models: [], current: '', error: errMsg(err) });
        sendStatus('error', tr('no connection'));
      }
    };
  return loadModels;
}
