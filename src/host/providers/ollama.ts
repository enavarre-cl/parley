import { ChatMessage, ChatResult, GenerationParams, LLMProvider, ModelInfo, StreamCallbacks, TokenUsage } from './types';
import { createThinkSplitter } from './think';
import { postStream } from './request';
import { httpFetch } from '../http';
import { readLines, safeToolArgs } from './stream';
import { imageAttachments } from './multimodal';
import { tr } from '../i18n';

/**
 * When the llama-server child of Ollama crashes (GGML assert, Windows stack-overrun 0xc0000409,
 * GPU/host OOM…), the raw message is a scary C++ stacktrace. Detect that signature and append an
 * actionable hint — the usual cause is the model not fitting in VRAM/RAM. Returns '' if it does not
 * look like a runtime crash, so normal API errors keep their original message untouched.
 */
function llamaCrashHint(detail: string): string {
  const d = (detail || '').toLowerCase();
  const looksLikeCrash =
    d.includes('llama-server') || d.includes('llamarunner') || d.includes('process has terminated') ||
    d.includes('ggml_assert') || d.includes('0xc0000409') ||
    d.includes('out of memory') || d.includes('failed to allocate') ||
    d.includes('cudamalloc') || d.includes('cuda error') || d.includes('vk_error_device_lost');
  return looksLikeCrash
    ? '\n\n' + tr('The model probably did not fit in your GPU/RAM. Try a smaller quantization or model, or force CPU by setting the environment variable OLLAMA_NUM_GPU=0.')
    : '';
}

// ── Shapes of the Ollama REST/NDJSON responses we read (only the fields we use). ────────────────
interface OllamaTagModel { name?: string }
interface OllamaTagsResponse { models?: OllamaTagModel[] }
interface OllamaStreamMessage {
  thinking?: string; content?: string;
  tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
}
interface OllamaStreamChunk {
  error?: unknown; done?: boolean; prompt_eval_count?: number; eval_count?: number;
  message?: OllamaStreamMessage;
}

/**
 * Provider for the Ollama server (native /api/chat API, NDJSON streaming).
 */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';

  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpFetch(this.url('/api/tags'), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`Could not list Ollama models (${res.status} ${res.statusText})`);
    }
    const json = await res.json() as OllamaTagsResponse;
    const models = Array.isArray(json?.models) ? json.models : [];
    return models
      .filter((m) => typeof m?.name === 'string')
      .map((m) => ({ id: m.name as string }));
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    p: GenerationParams,
    cb: StreamCallbacks
  ): Promise<ChatResult> {
    const options: Record<string, unknown> = {};
    if (p.temperature !== undefined) options.temperature = p.temperature;
    if (p.maxTokens !== undefined && p.maxTokens > 0) options.num_predict = p.maxTokens;
    if (p.topK !== undefined) options.top_k = p.topK;
    if (p.topP !== undefined) options.top_p = p.topP;
    if (p.minP !== undefined) options.min_p = p.minP;
    if (p.repeatPenalty !== undefined) options.repeat_penalty = p.repeatPenalty;
    if (p.presencePenalty !== undefined) options.presence_penalty = p.presencePenalty;
    if (p.frequencyPenalty !== undefined) options.frequency_penalty = p.frequencyPenalty;
    if (p.seed !== undefined) options.seed = p.seed;
    if (p.numThreads !== undefined) options.num_thread = p.numThreads;
    if (p.contextLength !== undefined) options.num_ctx = p.contextLength;
    if (p.stop && p.stop.length) options.stop = p.stop;

    const reqBody: Record<string, unknown> = {
      model,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', content: m.content, tool_name: m.toolName };
        }
        const out: Record<string, unknown> = { role: m.role, content: m.content };
        const imgs = imageAttachments(m);
        if (imgs.length) out.images = imgs.map((a) => a.data);
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((tc) => {
            let args: unknown = {};
            try { args = JSON.parse(safeToolArgs(tc.arguments)); } catch { /* empty */ }
            return { function: { name: tc.name, arguments: args } };
          });
        }
        return out;
      }),
      stream: true,
      options,
    };
    if (p.thinking) reqBody.think = true;
    if (p.tools && p.tools.length) {
      reqBody.tools = p.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const reader = await postStream(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: cb.signal,
    }, 'Ollama', llamaCrashHint);
    let answer = '';
    let thinking = '';
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    let usage: TokenUsage | undefined;
    const splitter = createThinkSplitter(
      (a) => { answer += a; cb.onDelta(a); },
      (th) => { thinking += th; cb.onReasoning?.(th); }
    );

    await readLines(reader, (line) => {
      if (!line) return;
      let obj: OllamaStreamChunk;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // Partial line: ignored.
      }
      // Error embedded in the stream (Ollama sends it as a string).
      if (obj?.error) {
        const err = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
        throw new Error(`Ollama (stream): ${err}` + llamaCrashHint(err));
      }
      if (obj?.done && (obj.prompt_eval_count || obj.eval_count)) {
        const p0 = obj.prompt_eval_count || 0;
        const c0 = obj.eval_count || 0;
        usage = { promptTokens: p0, completionTokens: c0, totalTokens: p0 + c0 };
      }
      const message = obj?.message ?? {};
      // Ollama's native reasoning field (with think: true).
      if (message.thinking) {
        thinking += message.thinking;
        cb.onReasoning?.(message.thinking);
      }
      // Content: may carry embedded <think>…</think>.
      if (message.content) splitter.push(message.content);
      // tool_calls (Ollama delivers them complete, arguments as an object).
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          const fn = tc.function ?? {};
          toolCalls.push({
            id: `call_${fn.name}_${toolCalls.length}`,
            name: fn.name ?? '',
            arguments: typeof fn.arguments === 'string' ? safeToolArgs(fn.arguments) : JSON.stringify(fn.arguments ?? {}),
          });
        }
      }
    }, cb.signal);
    splitter.flush();

    return { answer, thinking, usage, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}
