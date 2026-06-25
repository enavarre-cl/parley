import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ChatDoc } from './chatDocument';
import { ChatMessage, Attachment } from './providers/types';
import { ChatPatch } from './applyPatch';
import { tr } from './i18n';
import { errMsg } from './chatHelpers';
import { FindOpts } from './findReplace';
import { SPELL_LANGS, SpellLang, SpellWordsStore } from './spellWords';
import { routeSysPrompt } from './messageRouterSysPrompt';
import { routeEdit } from './messageRouterEdit';
import { removePiperVoice } from './piperVoices';
import { PiperManager } from './piper/manager';

/**
 * A message sent webview→host. The discriminator is `type`; the rest are per-message payload fields,
 * all optional and re-validated by each handler (the value crosses the postMessage JSON boundary).
 */
export interface WebviewMessage {
  type: string;
  word?: string;
  lang?: string;
  index?: number;
  text?: string;
  attachments?: Attachment[];
  rate?: number;
  voice?: string;
  id?: number;
  message?: string;
  data?: unknown;
  patch?: ChatPatch;
  content?: string;
  query?: string;
  replacement?: string;
  opts?: FindOpts;
  ordinal?: number;
  variant?: number;
  fromHere?: boolean;
  q?: string;
  reqId?: number;
  title?: string;
  html?: string;
  confirm?: boolean;
}

/** Everything the message router needs — one explicit context object (low coupling). */
export interface RouterCtx {
  webview: vscode.Webview;
  getDoc: () => ChatDoc | null;
  writeDoc: (doc: ChatDoc, opts?: { save?: boolean; prune?: boolean }) => Promise<void>;
  pushDoc: () => void;
  pushLang: () => void;
  sendHistory: () => void;
  loadModels: () => Promise<void>;
  handleSend: (text: string, attachments?: Attachment[]) => Promise<void>;
  handleGenerate: () => Promise<void>;
  handleFork: (index: number, fromHere?: boolean) => Promise<void>;
  handleContinue: () => Promise<void>;
  handleRegenerate: () => Promise<void>;
  setVariant: (index: number, variant: number) => Promise<void>;
  deleteVariant: (index: number, variant: number) => Promise<void>;
  ensureSummary: (doc: ChatDoc, history: ChatMessage[], upTo: number) => Promise<string>;
  synthPiper: (text: string, rate: number, voice: string, id: number) => Promise<void>;
  killPiper: () => void;
  resolveSystemPrompt: (doc: ChatDoc) => string;
  tlog: (s: string) => void;
  applyPatch: (doc: ChatDoc, patch: ChatPatch) => void;
  abortRef: { current: AbortController | undefined };
  busyRef: { value: boolean };
  ttsTokenRef: { value: number };
  spellWords: SpellWordsStore;
  downloadedVoiceIds: () => string[];
  piper: PiperManager;
  globalStorageUri: vscode.Uri;
  document: vscode.TextDocument;
  searchFiles: (q: string) => Promise<string[]>;
  sysPromptPathAllowed: (resolved: string) => boolean;
  confirmDelete: (msg: WebviewMessage, text: string) => Promise<boolean>;
  resolveAttachment: (a: Attachment) => Attachment;
}

/** Routes one webview→host message. */
export async function routeMessage(msg: WebviewMessage, ctx: RouterCtx): Promise<void> {
      switch (msg?.type) {
        case 'ready':
          ctx.pushLang();
          ctx.pushDoc();
          ctx.webview.postMessage({ type: 'spellWords', words: await ctx.spellWords.all() });
          ctx.webview.postMessage({ type: 'piperVoices', ids: ctx.downloadedVoiceIds() });
          await ctx.loadModels();
          break;
        case 'spellAddWord':
          // Adds to the active spell-checker language list. The store fires onDidChange →
          // all webviews + the sidebar view are updated.
          if (typeof msg.word === 'string' && typeof msg.lang === 'string' && (SPELL_LANGS as string[]).includes(msg.lang)) {
            await ctx.spellWords.add(msg.lang as SpellLang, msg.word);
          }
          break;
        case 'summarizeUpTo': {
          // Summarises context up to message `index` (exclusive), same as the "up to here" fork.
          if (ctx.busyRef.value) break;
          const doc = ctx.getDoc();
          if (!doc) break;
          if (!doc.params.autoSummary) {
            ctx.webview.postMessage({ type: 'notice', message: tr('Enable "Auto-summarize when context fills up" to use the summary.') });
            break;
          }
          const idx = msg.index ?? -1;
          const currentUpTo = doc.summary ? doc.summary.upTo : 0;
          if (!Number.isInteger(idx) || idx <= currentUpTo || idx > doc.messages.length) {
            ctx.webview.postMessage({ type: 'notice', message: tr('Nothing new to summarize.') });
            break;
          }
          ctx.busyRef.value = true;
          try {
            await ctx.ensureSummary(doc, doc.messages, idx);
            ctx.pushDoc();
          } catch (err) {
            ctx.webview.postMessage({ type: 'notice', message: tr('⚠️ Could not summarize context: ') + errMsg(err) });
          } finally { ctx.busyRef.value = false; }
          break;
        }
        case 'setSummary': {
          // Manual editing of the summary text (does not change its `upTo`).
          if (ctx.busyRef.value) break;
          const doc = ctx.getDoc();
          if (!doc || !doc.summary || typeof msg.text !== 'string') break;
          doc.summary = { text: msg.text, upTo: doc.summary.upTo };
          await ctx.writeDoc(doc);
          ctx.pushDoc();
          break;
        }
        case 'clearSummary': {
          // Clears the summary: the full history is sent again (recalculated if needed).
          if (ctx.busyRef.value) break;
          const doc = ctx.getDoc();
          if (!doc || !doc.summary) break;
          doc.summary = undefined;
          await ctx.writeDoc(doc);
          ctx.pushDoc();
          break;
        }
        case 'send':
          if (ctx.busyRef.value) break;
          ctx.busyRef.value = true;
          try { await ctx.handleSend(msg.text ?? '', msg.attachments); } finally { ctx.busyRef.value = false; }
          break;
        case 'stop':
          ctx.abortRef.current?.abort();
          break;
        case 'tts':
          await ctx.synthPiper(String(msg.text ?? ''), Number(msg.rate) || 1, String(msg.voice ?? ''), Number(msg.id) || 0);
          break;
        case 'ttsStop':
          ctx.tlog('ttsStop (cancel)');
          ctx.ttsTokenRef.value++; // cancels the current chunk loop
          ctx.killPiper(); // and kills the in-flight piper (avoid wasting CPU)
          break;
        case 'ttsLog':
          ctx.tlog('[webview] ' + msg.message + ' ' + (msg.data != null ? JSON.stringify(msg.data) : ''));
          break;
        case 'ttsUpdate':
          try {
            const voice = String(msg.voice ?? '');
            const notice = (m: string) => ctx.webview.postMessage({ type: 'notice', message: m });
            // Fully anchored + restricted charset: blocks path traversal (no '.', '/' or '\'),
            // since `voice` feeds path.join in removePiperVoice/ensureVoice. e.g. `en_US-../../etc`
            // is rejected. Real ids look like `en_US-amy-medium` / `en_US-ryan-x_low`.
            const isVoice = /^[a-z]{2}_[A-Z]{2}-[a-zA-Z0-9_-]+$/.test(voice);
            if (isVoice) removePiperVoice(vscode.Uri.joinPath(ctx.globalStorageUri, 'piper-voices').fsPath, voice);
            await ctx.piper.update(notice);          // updates the engine (pip upgrade)
            if (isVoice) await ctx.piper.ensureVoice(voice, notice); // re-downloads the voice
          } catch (e) {
            ctx.webview.postMessage({ type: 'ttsError', message: tr('Could not set up Piper: ') + (errMsg(e)) });
          }
          break;
        case 'setConfig': {
          if (ctx.busyRef.value) break; // do not mutate the doc while an inference is writing
          // Acquire the lock for the whole handler: it awaits writeDoc, loadModels and (on the
          // tools-on edge) a Trust dialog that can sit open for seconds — without holding busyRef a
          // concurrent `send` could start an inference that writes the doc underneath us.
          ctx.busyRef.value = true;
          try {
            const doc = ctx.getDoc();
            if (doc) {
              const before = doc.provider;
              const toolsBefore = doc.params.tools;
              ctx.applyPatch(doc, msg.patch ?? {});
              await ctx.writeDoc(doc);
              if (doc.provider !== before) await ctx.loadModels();
              // Tools just turned ON in an untrusted workspace: nudge the user to grant Workspace Trust
              // now (up front) so filesystem tools / MCP servers won't fail mid-turn. Only on the
              // off→on edge, so it never nags on unrelated config changes.
              if (doc.params.tools && !toolsBefore && !vscode.workspace.isTrusted) {
                const manage = tr('Manage Trust');
                const pick = await vscode.window.showWarningMessage(
                  tr('Jotflow tools (workspace files + MCP servers) need a trusted workspace to run.'),
                  manage,
                );
                if (pick === manage) await vscode.commands.executeCommand('workbench.trust.manage');
              }
            }
          } finally { ctx.busyRef.value = false; }
          break;
        }
        case 'deleteMessage':
        case 'deleteFrom':
        case 'mergeMessage':
        case 'editMessage':
        case 'replaceOne':
        case 'replaceAll':
          await routeEdit(msg, ctx); // handlers split into messageRouterEdit.ts
          break;
        case 'regenerate':
          if (ctx.busyRef.value) break;
          ctx.busyRef.value = true;
          try { await ctx.handleRegenerate(); } finally { ctx.busyRef.value = false; }
          break;
        case 'continue':
          if (ctx.busyRef.value) break;
          ctx.busyRef.value = true;
          try { await ctx.handleContinue(); } finally { ctx.busyRef.value = false; }
          break;
        case 'fork':
          if (ctx.busyRef.value) break;
          if (Number.isInteger(msg.index)) {
            ctx.busyRef.value = true;
            try { await ctx.handleFork(msg.index!, msg.fromHere === true); } finally { ctx.busyRef.value = false; }
          }
          break;
        case 'regenerateFrom': {
          // Regenerates the response to a user message: discards everything after it
          // (old response, partial tool-calls…) and runs inference again.
          if (ctx.busyRef.value) break;
          const doc = ctx.getDoc();
          if (!doc) break;
          const i = msg.index ?? -1;
          if (!Number.isInteger(i) || i < 0 || i >= doc.messages.length || doc.messages[i].role !== 'user') break;
          ctx.busyRef.value = true; // blocks re-entrancy BEFORE mutating/writing
          try {
            if (i + 1 < doc.messages.length) {
              doc.messages.splice(i + 1); // leaves the prompt as the last message
              doc.summary = undefined;
              await ctx.writeDoc(doc);
              ctx.sendHistory();
            }
            await ctx.handleGenerate();
          } finally { ctx.busyRef.value = false; }
          break;
        }
        case 'setVariant':
          if (!ctx.busyRef.value && Number.isInteger(msg.index) && Number.isInteger(msg.variant)) {
            await ctx.setVariant(msg.index!, msg.variant!);
          }
          break;
        case 'deleteVariant':
          if (!ctx.busyRef.value && Number.isInteger(msg.index) && Number.isInteger(msg.variant)) {
            if (!(await ctx.confirmDelete(msg, tr('Delete this variant?')))) break;
            await ctx.deleteVariant(msg.index!, msg.variant!);
          }
          break;
        case 'refreshModels':
          await ctx.loadModels();
          break;
        case 'copy':
          if (typeof msg.text === 'string') await vscode.env.clipboard.writeText(msg.text);
          break;
        case 'atFiles': {
          // @-mention autocomplete: return workspace files matching the partial query.
          const files = await ctx.searchFiles(typeof msg.q === 'string' ? msg.q : '');
          ctx.webview.postMessage({ type: 'atFilesResult', q: msg.q, reqId: msg.reqId, files });
          break;
        }
        case 'saveImage': {
          // Saves a generated image of message `index` (the active variant) to disk via a native dialog.
          const doc = ctx.getDoc();
          const m = msg.index != null ? doc?.messages[msg.index] : undefined;
          if (!m) break;
          const img = (m.attachments ?? []).map(ctx.resolveAttachment).find((a) => a.kind === 'image' && a.data);
          if (!img) break;
          const ext = /jpe?g/i.test(img.mime) ? 'jpg' : /webp/i.test(img.mime) ? 'webp' : /gif/i.test(img.mime) ? 'gif' : 'png';
          // Default to the workspace folder (fall back to the .chat's folder, then home).
          const saveDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            || path.dirname(ctx.document.uri.fsPath)
            || os.homedir();
          const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(saveDir, img.name || `image.${ext}`)),
            filters: { [tr('Image')]: [ext] },
          });
          if (!target) break;
          await vscode.workspace.fs.writeFile(target, Buffer.from(img.data ?? '', 'base64'));
          break;
        }
        case 'exportHtml': {
          // Writes a self-contained HTML file and opens it in the browser (which can print it → Save as PDF).
          const safe = String(msg.title || 'chat').replace(/[^\w\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 40);
          const file = vscode.Uri.file(path.join(os.tmpdir(), `jotflow-${safe}-${Date.now()}.html`));
          await vscode.workspace.fs.writeFile(file, Buffer.from(String(msg.html || ''), 'utf8'));
          await vscode.env.openExternal(file);
          // Deletes the temp file after giving the browser time to load it (otherwise they pile up in /tmp).
          setTimeout(() => { try { fs.unlinkSync(file.fsPath); } catch { /* nothing */ } }, 60000);
          break;
        }
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'jotflow');
          break;
        case 'createSysPrompt':
        case 'pickSysPrompt':
        case 'openSysPrompt':
        case 'clearSysPrompt':
          await routeSysPrompt(msg, ctx); // handlers split into messageRouterSysPrompt.ts
          break;
      }
}
