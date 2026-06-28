import * as vscode from 'vscode';
import { buildProvider, ChatMessage } from './providers';
import { tr } from './i18n';
import { ChatDoc } from './chatDocument';

export interface SummaryDeps {
  webview: vscode.Webview;
  writeDoc: (doc: ChatDoc, opts?: { save?: boolean; prune?: boolean }) => Promise<void>;
  abortRef: { current: AbortController | undefined };
}

/** Incremental conversation summarization (rolling summary to preserve context). */
export function makeSummary(deps: SummaryDeps) {
  const { webview, writeDoc, abortRef } = deps;
    // Calls the model to summarise a block of messages (no streaming to the UI).
    const summarizeMessages = async (
      doc: ChatDoc,
      prevText: string,
      msgs: ChatMessage[]
    ): Promise<string> => {
      const convo = msgs
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      const instruction =
        (prevText
          ? `Previous summary of the conversation:\n${prevText}\n\nIntegrate the following new messages into a single updated summary.`
          : 'Summarize the following conversation.') +
        '\nKeep facts, decisions, data, names and pending tasks. Be concise. Reply with only the summary, in the same language as the conversation.\n\n--- Conversation ---\n' +
        convo;
      const wire: ChatMessage[] = [
        { role: 'system', content: 'You are an assistant that summarizes conversations to preserve context.' },
        { role: 'user', content: instruction },
      ];
      abortRef.current = new AbortController();
      let text = '';
      let reasoning = '';
      try {
        // No explicit timeout here on purpose: cancellation/timeout is handled by the provider
        // through the AbortSignal passed below (abortRef.current.signal).
        await buildProvider(doc.provider).chat(
          doc.model,
          wire,
          { temperature: 0.3, maxTokens: 1024 },
          {
            signal: abortRef.current!.signal,
            onDelta: (d) => { text += d; },
            onReasoning: (d) => { reasoning += d; },
          }
        );
      } finally {
        abortRef.current = undefined;
      }
      // Some reasoning models return text only in the thinking channel.
      return (text.trim() || reasoning.trim());
    };
    const ensureSummary = async (
      doc: ChatDoc,
      history: ChatMessage[],
      targetUpTo: number
    ): Promise<string> => {
      const prev = doc.summary;
      if (prev && prev.upTo >= targetUpTo) return prev.text;
      const startFrom = prev ? prev.upTo : 0;
      const block = history.slice(startFrom, targetUpTo);
      if (!block.length) return prev?.text ?? '';
      // PERSISTENT indicator (with spinner) throughout the model call; removed on completion
      // or failure. (Previously it was a notice that auto-closed after 6 s, leaving a feedback gap.)
      webview.postMessage({ type: 'summarizing', active: true, message: tr('🗜️ Summarizing previous context…') });
      try {
        const text = await summarizeMessages(doc, prev?.text ?? '', block);
        if (text) {
          doc.summary = { text, upTo: targetUpTo };
          await writeDoc(doc);
        }
        return doc.summary?.text ?? '';
      } finally {
        webview.postMessage({ type: 'summarizing', active: false });
      }
    };
  return { ensureSummary };
}
