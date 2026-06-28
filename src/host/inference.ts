import * as vscode from 'vscode';
import { ChatMessage, ChatResult, TokenUsage, Attachment, LLMProvider } from './providers/types';
import { ChatDoc, repairTrailingToolChain, resolveGenerationParams } from './chatDocument';
import { buildProvider, ProviderId } from './providers';
import { ToolHub } from './tools';
import { estTokens, msgTokens, addUsage, errMsg } from './chatHelpers';
import { tr } from './i18n';

/** Explicit dependencies for runInference — narrow, typed, no globals. */
export interface InferenceDeps {
  webview: vscode.Webview;
  toolHub: ToolHub;
  modelContexts: Record<string, number>;
  resolveSystemPrompt: (doc: ChatDoc) => string;
  ensureSummary: (doc: ChatDoc, history: ChatMessage[], upTo: number) => Promise<string>;
  resolveAttachment: (a: Attachment) => Attachment;
  getDoc: () => ChatDoc | null;
  writeDoc: (doc: ChatDoc, opts?: { save?: boolean; prune?: boolean }) => Promise<void>;
  sendHistory: () => void;
  abortRef: { current: AbortController | undefined };
  /** Provider factory — a seam for tests. Defaults to the real `buildProvider`. */
  buildProvider?: (provider: ProviderId) => LLMProvider;
}

/** Runs one chat turn: context trimming, the wire build, and the agentic tool loop. */
export async function runInference(
  doc: ChatDoc, context: ChatMessage[], allowTools: boolean, deps: InferenceDeps
): Promise<{ answer: string; thinking: string; failed: boolean; usage?: TokenUsage; images: { mime: string; data: string }[]; usedTools: boolean }> {
  const { webview, toolHub, modelContexts, resolveSystemPrompt, ensureSummary, resolveAttachment, getDoc, writeDoc, sendHistory, abortRef } = deps;
      const buildLLM = deps.buildProvider ?? buildProvider; // seam: tests inject a fake provider
      // Copy + drop any trailing unfinished tool exchange (crash/reload recovery) so we never replay
      // an assistant tool_call without its tool reply → provider 400. On a normal send this is a no-op.
      let history = context.slice();
      repairTrailingToolChain(history);
      let summaryText = '';
      // Resolve ONCE: used both to budget the trimming below and as the system message sent. Must be
      // the effective prompt (file content included) or the budget under-counts and can overflow the window.
      const sysPrompt = resolveSystemPrompt(doc);

      const cmCfg = doc.params.contextMessages;
      const lastNActive = cmCfg.enabled && cmCfg.value > 0;
      if (lastNActive) {
        // PRIORITY: "last N messages" wins over the summary (which becomes stale as the chat advances).
        // The token budget (auto = 75% of the model window) also caps: the tighter cut wins
        // (to avoid blowing the window).
        const modelCtx = modelContexts[doc.model];
        const budget = modelCtx ? Math.floor(modelCtx * 0.75) : 16000;
        let acc = estTokens(sysPrompt);
        let start = history.length;
        for (let i = history.length - 1; i >= 0; i--) {
          if (history.length - i > cmCfg.value) break;            // cap: N messages
          const tk = msgTokens(history[i]);
          if (acc + tk > budget && start < history.length) break; // cap: token budget
          acc += tk;
          start = i;
        }
        history = history.slice(start);
      } else if (doc.params.autoSummary) {
        // TOKEN-based compaction against the real model window (auto = 75% of the window).
        const modelCtx = modelContexts[doc.model];
        const budget = modelCtx ? Math.floor(modelCtx * 0.75) : 16000;

        // Start from the existing summary: never resend what has already been summarised.
        let upTo = doc.summary ? doc.summary.upTo : 0;
        summaryText = doc.summary?.text ?? '';

        const fixed = estTokens(sysPrompt) + estTokens(summaryText);
        let total = fixed;
        for (let i = upTo; i < history.length; i++) total += msgTokens(history[i]);

        if (total > budget) {
          // Keeps recent messages that fit within ~half the budget.
          const keepBudget = Math.max(1, Math.floor(budget / 2));
          let acc = 0;
          let keepFrom = history.length;
          for (let i = history.length - 1; i >= upTo; i--) {
            const t = msgTokens(history[i]);
            if (acc + t > keepBudget && keepFrom < history.length) break;
            acc += t;
            keepFrom = i;
          }
          const targetUpTo = Math.max(upTo, keepFrom);
          if (targetUpTo > upTo) {
            try {
              summaryText = await ensureSummary(doc, history, targetUpTo);
              upTo = targetUpTo;
            } catch (err) {
              webview.postMessage({ type: 'notice', message: tr('⚠️ Could not summarize context: ') + errMsg(err) });
              summaryText = doc.summary?.text ?? '';
            }
          }
        }
        history = history.slice(upTo);
      }

      // After trimming, don't start with assistant/tool (would break function calling and Anthropic/Gemini).
      while (history.length && (history[0].role === 'assistant' || history[0].role === 'tool')) {
        history = history.slice(1);
      }

      const wire: ChatMessage[] = [];
      if (sysPrompt.trim()) wire.push({ role: 'system', content: sysPrompt });
      if (summaryText) {
        wire.push({ role: 'system', content: `Summary of the previous conversation (compacted context):\n${summaryText}` });
      }
      // Role/content/images are sent and, if present, tool fields. Thinking is OMITTED.
      wire.push(...history.map((m) => {
        let content = m.content;
        const resolved = (m.attachments ?? []).map(resolveAttachment);
        const hasData = (a: Attachment): boolean => typeof a.data === 'string' && a.data.length > 0;
        // A `ref`-only attachment whose blob can't be resolved (e.g. the `.attach` sidecar was
        // deleted) arrives with no `data`. Sending it empty makes the provider reject the whole
        // request (400/502), and the broken message replays every turn — so drop it and leave the
        // model a note instead of an empty image.
        for (const a of resolved.filter((x) => !hasData(x))) content += `\n\n[Attachment unavailable: ${a.name}]`;
        const media = resolved.filter((a) => (a.kind === 'image' || a.kind === 'document') && hasData(a));
        for (const f of resolved.filter((a) => a.kind === 'text' && hasData(a))) {
          content += `\n\n[Attached file: ${f.name}]\n${f.data}`;
        }
        const wm: ChatMessage = { role: m.role, content };
        if (media.length) wm.attachments = media;
        if (m.toolCalls) wm.toolCalls = m.toolCalls;
        if (m.toolCallId) wm.toolCallId = m.toolCallId;
        if (m.toolName) wm.toolName = m.toolName;
        return wm;
      }));

      const params = resolveGenerationParams(doc.params);
      if (allowTools && doc.params.tools) {
        try {
          await toolHub.ensureStarted();
          const schemas = toolHub.schemas();
          if (schemas.length) params.tools = schemas;
          if (toolHub.mcpErrors().length) {
            webview.postMessage({ type: 'notice', message: tr('⚠️ Some MCP servers failed to start: ') + toolHub.mcpErrors().join('; ') });
          }
        } catch { /* toolHub start failed: continue without tools (graceful degradation) */ }
      }

      let answer = '';
      let thinking = '';
      let failed = false;
      let aborted = false;
      let usage: TokenUsage | undefined = undefined;
      let images: { mime: string; data: string }[] = [];
      let usedTools = false; // true once a tool call was persisted → the caller must close the chain

      // Agentic loop: if the model requests tools, they are executed and fed back.
      // A single AbortController for the ENTIRE turn: so Stop also cuts between
      // iterations and before executing the next tool (not only during chat()).
      const ac = new AbortController();
      abortRef.current = ac;
      // Max agentic tool-loop iterations (configurable). 0 = unlimited: the loop still ends when the
      // model stops requesting tools or the user presses Stop (the AbortController breaks it).
      const cfgIters = vscode.workspace.getConfiguration('jotflow').get<number>('tools.maxIterations', 8);
      const MAX_ITERS = Number.isFinite(cfgIters) && cfgIters >= 0 ? Math.floor(cfgIters) : 8;
      const HARD_ITER_CAP = 100; // backstop even when the user sets 0 (unlimited): a model stuck in a
      for (let iter = 0; (MAX_ITERS === 0 || iter < MAX_ITERS) && iter < HARD_ITER_CAP; iter++) { // tool loop won't run away on cost
        if (ac.signal.aborted) { aborted = true; break; }
        const id = `m_${Date.now().toString(36)}_${iter}`;
        webview.postMessage({ type: 'streamStart', id });
        let res: ChatResult = { answer: '', thinking: '' };
        try {
          res = await buildLLM(doc.provider).chat(doc.model, wire, params, {
            signal: ac.signal,
            onDelta: (delta) => { webview.postMessage({ type: 'streamDelta', id, delta }); },
            onReasoning: (delta) => { webview.postMessage({ type: 'streamReasoning', id, delta }); },
          });
        } catch (err) {
          if (ac.signal.aborted) aborted = true;
          else { webview.postMessage({ type: 'error', message: errMsg(err) }); failed = true; }
        }
        webview.postMessage({ type: 'streamEnd', id });
        if (res.usage) usage = addUsage(usage, res.usage);
        if (res.images?.length) images = images.concat(res.images);
        // Only adopt the text of a chat() that actually completed. On failure/abort `res` is the
        // empty default, so overwriting here would wipe a non-empty answer from a prior iteration.
        if (!failed && !aborted) { answer = res.answer; thinking = res.thinking; }

        if (failed || aborted || !res.toolCalls || !res.toolCalls.length) break;

        // The model requested tools: persist the call, execute, and feed back.
        usedTools = true;
        const callMsg: ChatMessage = { role: 'assistant', content: res.answer, toolCalls: res.toolCalls };
        if (res.thinking) callMsg.thinking = res.thinking;
        wire.push(callMsg);
        const fresh = getDoc();
        fresh?.messages.push(callMsg);

        // Run the requested tools CONCURRENTLY: the model asked for them in a single turn without
        // seeing intermediate results, so they're independent and can't rely on intra-turn ordering.
        // Results are collected in request order to keep tool_result ↔ tool_call pairing intact.
        const toolResults = await Promise.all(res.toolCalls.map(async (tc): Promise<{ tc: typeof tc; out: string }> => {
          let args: Record<string, unknown> = {};
          let parseError = false;
          try { args = JSON.parse(tc.arguments || '{}'); } catch { parseError = true; }
          webview.postMessage({ type: 'toolCall', name: tc.name, args: tc.arguments || '' });
          let out: string;
          if (parseError) {
            // Tell the model its arguments were invalid JSON so it can retry, instead of silently
            // running the tool with {} (which masks the real problem).
            out = `Error: tool arguments were not valid JSON: ${(tc.arguments || '').slice(0, 200)}`;
          } else {
            try {
              out = await toolHub.call(tc.name, args, ac.signal); // Stop cancels in-flight tools too
            } catch (e) {
              out = 'Error: ' + (errMsg(e));
            }
          }
          webview.postMessage({ type: 'toolResult', name: tc.name, content: out });
          return { tc, out };
        }));
        for (const { tc, out } of toolResults) {
          const toolMsg: ChatMessage = { role: 'tool', content: out, toolCallId: tc.id, toolName: tc.name };
          wire.push(toolMsg);
          fresh?.messages.push(toolMsg);
        }
        if (ac.signal.aborted) aborted = true; // a Stop during the concurrent batch cancels the turn
        // If the turn was aborted mid tool-loop, drop the dangling assistant(toolCalls) + any partial
        // tool replies before persisting: the model never produced its answer, so writing that chain
        // would leave a broken turn on disk (an assistant with toolCalls missing their tool results).
        if (aborted && fresh) repairTrailingToolChain(fresh.messages);
        // Intermediate write in the tool-loop: no save() or prune (done once at the end of the turn).
        if (fresh) await writeDoc(fresh, { save: false, prune: false });
        sendHistory();
        if (aborted) break;
        // next iteration: the model sees the results
      }
      if (abortRef.current === ac) abortRef.current = undefined; // release the turn's controller

      if (!failed && !answer && !thinking && !images.length && !aborted) {
        webview.postMessage({
          type: 'error',
          message: tr('The model returned no content. Try another model; on OpenRouter, check the key\'s credits/limits.'),
        });
      }
      return { answer, thinking, failed, usage, images, usedTools };
}
