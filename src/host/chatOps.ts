import * as vscode from 'vscode';
import * as path from 'path';
import { ChatDoc, serializeDoc } from './chatDocument';
import { ChatMessage, ChatVariant, TokenUsage, Attachment } from './providers/types';
import { sanitizeAttachments, applyVariantToMessage, addUsage } from './chatHelpers';
import { tr } from './i18n';
import { AttachmentStore } from './attachmentStore';

export interface ChatOpsCtx {
  webview: vscode.Webview;
  document: vscode.TextDocument;
  getDoc: () => ChatDoc | null;
  writeDoc: (doc: ChatDoc, opts?: { save?: boolean; prune?: boolean }) => Promise<void>;
  sendHistory: () => void;
  runInference: (doc: ChatDoc, context: ChatMessage[], allowTools?: boolean) => Promise<{ answer: string; thinking: string; failed: boolean; usage?: TokenUsage; images: { mime: string; data: string }[]; usedTools: boolean }>;
  attachStore: AttachmentStore;
  viewType: string;
}

/** Chat turn operations: send / generate / fork / continue / regenerate / variant ops. */
export function makeChatOps(deps: ChatOpsCtx) {
    const handleSend = async (text: string, attachments?: Attachment[]): Promise<void> => {
      text = (text ?? '').trim();
      const atts = sanitizeAttachments(attachments);
      if (!text && !atts.length) return;
      const doc = deps.getDoc();
      if (!doc) return;
      if (!doc.model) {
        deps.webview.postMessage({ type: 'error', message: tr('No model selected. Make sure the backend is active and press ⟳.') });
        return;
      }

      const userMsg: ChatMessage = { role: 'user', content: text };
      if (atts.length) userMsg.attachments = await deps.attachStore.store(atts); // blobs → .attach, message holds only refs
      doc.messages.push(userMsg);
      const onlyUser = doc.messages.filter((m) => m.role === 'user').length === 1;
      if (onlyUser && (!doc.title || doc.title === 'New chat')) {
        const base = text || atts[0]?.name || 'Attachment';
        doc.title = base.length > 40 ? base.slice(0, 40) + '…' : base;
      }
      await deps.writeDoc(doc);

      const { answer, thinking, failed, usage, images, usedTools } = await deps.runInference(doc, doc.messages, true);
      // Persist a final assistant even when the model returned no text, IF the turn used tools — so the
      // dangling assistant(toolCalls)+tool chain on disk is closed (else it's discarded next turn).
      if (!failed && (answer || thinking || images.length || usedTools)) {
        const fresh = deps.getDoc();
        if (fresh) {
          const m: ChatMessage = { role: 'assistant', content: answer };
          if (thinking) m.thinking = thinking;
          if (usage) m.usage = usage;
          if (images.length) m.attachments = await deps.attachStore.storeGenImages(images);
          fresh.messages.push(m);
          await deps.writeDoc(fresh);
        }
      }
      deps.sendHistory();
    };

    // Generates a response when the conversation ends with a user message
    // (e.g. after an error, a cancellation, or having deleted the response).
    const handleGenerate = async (): Promise<void> => {
      const doc = deps.getDoc();
      if (!doc) return;
      if (!doc.model) {
        deps.webview.postMessage({ type: 'error', message: tr('No model selected. Make sure the backend is active and press ⟳.') });
        return;
      }
      const last = doc.messages[doc.messages.length - 1];
      if (!last || last.role !== 'user') return;

      const { answer, thinking, failed, usage, images, usedTools } = await deps.runInference(doc, doc.messages, true);
      // Persist a final assistant even when the model returned no text, IF the turn used tools — so the
      // dangling assistant(toolCalls)+tool chain on disk is closed (else it's discarded next turn).
      if (!failed && (answer || thinking || images.length || usedTools)) {
        const fresh = deps.getDoc();
        if (fresh) {
          const m: ChatMessage = { role: 'assistant', content: answer };
          if (thinking) m.thinking = thinking;
          if (usage) m.usage = usage;
          if (images.length) m.attachments = await deps.attachStore.storeGenImages(images);
          fresh.messages.push(m);
          await deps.writeDoc(fresh);
        }
      }
      deps.sendHistory();
    };

    // Finds an available "(fork N)" .chat name next to the current file.
    const forkName = async (): Promise<vscode.Uri> => {
      const cur = deps.document.uri;
      const dir = vscode.Uri.joinPath(cur, '..');
      const file = cur.path.slice(cur.path.lastIndexOf('/') + 1);
      const stem = file.replace(/\.chat$/i, '');
      for (let n = 1; ; n++) {
        const name = `${stem} (fork${n > 1 ? ' ' + n : ''}).chat`;
        const target = vscode.Uri.joinPath(dir, name);
        try {
          await vscode.workspace.fs.stat(target); // exists → try next
        } catch {
          return target; // free
        }
      }
    };

    // Copies the attachments referenced by `msgs` to the fork's sidecar (same ids).
    const copyForkAttachments = async (target: vscode.Uri, msgs: ChatMessage[]): Promise<void> => {
      const refIds = new Set<string>();
      for (const m of msgs) {
        for (const a of (m.attachments ?? [])) if (a.ref) refIds.add(a.ref);
        for (const v of (m.variants ?? [])) for (const a of (v.attachments ?? [])) if (a.ref) refIds.add(a.ref);
      }
      if (!refIds.size) return;
      const src = deps.attachStore.load();
      const dst: Record<string, Attachment> = {};
      for (const id of refIds) if (src[id]) dst[id] = src[id];
      const forkStem = path.basename(target.fsPath).replace(/\.chat$/i, '');
      const forkAttach = vscode.Uri.joinPath(target, '..', forkStem + '.attach');
      await vscode.workspace.fs.writeFile(forkAttach, Buffer.from(JSON.stringify(dst) + '\n', 'utf8'));
    };

    // Fork: clones the conversation up to `index` (inclusive) into a new .chat and opens it.
    const handleFork = async (index: number, fromHere = false): Promise<void> => {
      const doc = deps.getDoc();
      if (!doc) return;
      if (!Number.isInteger(index) || index < 0 || index >= doc.messages.length) return;

      // Normal: clones up to here (inclusive). ⌥/Alt: clones FROM here to the end.
      const sliced = fromHere ? doc.messages.slice(index) : doc.messages.slice(0, index + 1);
      const forked: ChatDoc = {
        ...doc,
        title: doc.title + ' (' + tr('fork') + ')',
        messages: sliced,
        // The summary references old indices; it remains valid in an "up to here" fork
        // only if it covers within the slice. In "from here" it is discarded (origin changes).
        summary: !fromHere && doc.summary && doc.summary.upTo <= sliced.length ? doc.summary : undefined,
        usage: undefined, // usage is derived from the present messages
      };

      const target = await forkName();
      await vscode.workspace.fs.writeFile(target, Buffer.from(serializeDoc(forked), 'utf8'));
      await copyForkAttachments(target, sliced);

      await vscode.commands.executeCommand('vscode.openWith', target, deps.viewType);
    };

    // Continues the last assistant response: appends the new generation.
    const handleContinue = async (): Promise<void> => {
      const doc = deps.getDoc();
      if (!doc || !doc.model) return;
      const lastIdx = doc.messages.length - 1;
      if (lastIdx < 0 || doc.messages[lastIdx].role !== 'assistant') return;

      // Context = full history + an ephemeral continue instruction (not saved).
      const ctx: ChatMessage[] = [
        ...doc.messages,
        { role: 'user', content: 'Continue exactly from where you left off, expanding your previous response. Do not repeat what you already wrote, do not greet or summarize; keep writing.' },
      ];

      const { answer, thinking, failed, usage } = await deps.runInference(doc, ctx);
      if (failed || !answer) { deps.sendHistory(); return; }

      const fresh = deps.getDoc();
      const target = fresh?.messages[lastIdx];
      if (!fresh || !target || target.role !== 'assistant') { deps.sendHistory(); return; }

      const sep = /\s$/.test(target.content) ? '' : ' ';
      target.content = target.content + sep + answer;
      if (thinking) target.thinking = (target.thinking ? target.thinking + '\n\n' : '') + thinking;
      // Continue is another call: accumulate its token usage.
      if (usage) target.usage = addUsage(target.usage, usage);
      // If the response has variants, append to the active one (content and usage).
      if (Array.isArray(target.variants) && typeof target.active === 'number' && target.variants[target.active]) {
        const av = target.variants[target.active];
        av.content = target.content;
        if (thinking) av.thinking = target.thinking;
        if (usage) av.usage = addUsage(av.usage, usage);
      }
      await deps.writeDoc(fresh);
      deps.sendHistory();
    };

    // Reprocesses the last instruction: regenerates the last assistant response,
    // saving it as a new variant (without losing previous ones).
    const handleRegenerate = async (): Promise<void> => {
      const doc = deps.getDoc();
      if (!doc || !doc.model) return;
      let idx = -1;
      for (let i = doc.messages.length - 1; i >= 0; i--) {
        if (doc.messages[i].role === 'assistant') { idx = i; break; }
      }
      if (idx < 0) return;

      const { answer, thinking, failed, usage, images } = await deps.runInference(doc, doc.messages.slice(0, idx));
      if (failed || (!answer && !thinking && !images.length)) { deps.sendHistory(); return; }

      const fresh = deps.getDoc();
      const target = fresh?.messages[idx];
      if (!fresh || !target || target.role !== 'assistant') { deps.sendHistory(); return; }

      if (!Array.isArray(target.variants) || target.variants.length === 0) {
        // The original response becomes variant 0 (preserving its usage and any images).
        target.variants = [{ content: target.content, thinking: target.thinking, usage: target.usage, attachments: target.attachments }];
      }
      const variant: ChatVariant = { content: answer };
      if (thinking) variant.thinking = thinking;
      if (usage) variant.usage = usage;
      if (images.length) variant.attachments = await deps.attachStore.storeGenImages(images);
      target.variants.push(variant);
      target.active = target.variants.length - 1;
      applyVariantToMessage(target, variant);
      await deps.writeDoc(fresh);
      deps.sendHistory();
    };

    // Changes the active variant of an assistant message.
    const setVariant = async (index: number, variant: number): Promise<void> => {
      const doc = deps.getDoc();
      const t = doc?.messages[index];
      if (!doc || !t || !Array.isArray(t.variants)) return;
      if (variant < 0 || variant >= t.variants.length) return;
      t.active = variant;
      applyVariantToMessage(t, t.variants[variant]);
      await deps.writeDoc(doc);
      deps.sendHistory();
    };

    // Deletes a variant (only if more than one exists). When one remains, collapses to a simple response.
    const deleteVariant = async (index: number, variant: number): Promise<void> => {
      const doc = deps.getDoc();
      const t = doc?.messages[index];
      if (!doc || !t || !Array.isArray(t.variants) || t.variants.length <= 1) return;
      if (variant < 0 || variant >= t.variants.length) return;
      t.variants.splice(variant, 1);
      if (t.variants.length <= 1) {
        applyVariantToMessage(t, t.variants[0]); // collapse back to a plain response
        delete t.variants;
        delete t.active;
      } else {
        // Deleting a variant BEFORE the active one shifts the active index down by one — keep the
        // SAME variant shown instead of jumping to a different one (Math.min alone only capped the top).
        let a = t.active ?? 0;
        if (variant < a) a--;
        a = Math.max(0, Math.min(a, t.variants.length - 1));
        t.active = a;
        applyVariantToMessage(t, t.variants[a]);
      }
      await deps.writeDoc(doc);
      deps.sendHistory();
    };

  return { handleSend, handleGenerate, handleFork, handleContinue, handleRegenerate, setVariant, deleteVariant };
}
