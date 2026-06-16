import { ChatMessage, ChatResult, GenerationParams, LLMProvider, ModelInfo, StreamCallbacks } from './types';
import { createThinkSplitter } from './think';
import { formatHttpError } from './httpError';
import { httpFetch } from '../http';
import { readLines, safeToolArgs } from './stream';
import { imageAttachments } from './multimodal';

/**
 * Provider para el servidor Ollama (API nativa /api/chat, NDJSON streaming).
 */
export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';

  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpFetch(this.url('/api/tags'));
    if (!res.ok) {
      throw new Error(`No se pudieron listar los modelos de Ollama (${res.status} ${res.statusText})`);
    }
    const json: any = await res.json();
    const models = Array.isArray(json?.models) ? json.models : [];
    return models
      .filter((m: any) => typeof m?.name === 'string')
      .map((m: any) => ({ id: m.name }));
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    p: GenerationParams,
    cb: StreamCallbacks
  ): Promise<ChatResult> {
    const options: any = {};
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

    const reqBody: any = {
      model,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', content: m.content, tool_name: m.toolName };
        }
        const out: any = { role: m.role, content: m.content };
        const imgs = imageAttachments(m);
        if (imgs.length) out.images = imgs.map((a) => a.data);
        if (m.toolCalls?.length) {
          out.tool_calls = m.toolCalls.map((tc) => {
            let args: any = {};
            try { args = JSON.parse(safeToolArgs(tc.arguments)); } catch { /* vacío */ }
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

    const res = await httpFetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: cb.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(formatHttpError('Ollama', res.status, res.statusText, detail));
    }

    const reader = res.body.getReader();
    let answer = '';
    let thinking = '';
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    let usage: any;
    const splitter = createThinkSplitter(
      (a) => { answer += a; cb.onDelta(a); },
      (th) => { thinking += th; cb.onReasoning?.(th); }
    );

    await readLines(reader, (line) => {
      if (!line) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // Línea parcial: se ignora.
      }
      // Error embebido en el stream (Ollama lo manda como string).
      if (obj?.error) {
        throw new Error(`Ollama (stream): ${typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error)}`);
      }
      if (obj?.done && (obj.prompt_eval_count || obj.eval_count)) {
        const p0 = obj.prompt_eval_count || 0;
        const c0 = obj.eval_count || 0;
        usage = { promptTokens: p0, completionTokens: c0, totalTokens: p0 + c0 };
      }
      const message = obj?.message ?? {};
      // Campo de razonamiento nativo de Ollama (con think: true).
      if (message.thinking) {
        thinking += message.thinking;
        cb.onReasoning?.(message.thinking);
      }
      // Contenido: puede traer <think>…</think> embebido.
      if (message.content) splitter.push(message.content);
      // tool_calls (Ollama los entrega completos, arguments como objeto).
      if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
          const fn = tc.function ?? {};
          toolCalls.push({
            id: `call_${fn.name}_${toolCalls.length}`,
            name: fn.name,
            arguments: typeof fn.arguments === 'string' ? safeToolArgs(fn.arguments) : JSON.stringify(fn.arguments ?? {}),
          });
        }
      }
    });
    splitter.flush();

    return { answer, thinking, usage, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}
