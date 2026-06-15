import { ChatMessage, ChatResult, GenerationParams, LLMProvider, ModelInfo, StreamCallbacks } from './types';
import { createThinkSplitter } from './think';
import { formatHttpError } from './httpError';
import { httpFetch } from '../http';
import { readLines } from './stream';
import { imageAttachments, documentAttachments, dataUrl } from './multimodal';

/** content de un mensaje en formato OpenAI: string, o array de parts si hay imágenes/documentos. */
function openAIContent(m: ChatMessage): any {
  const imgs = imageAttachments(m);
  const docs = documentAttachments(m);
  if (!imgs.length && !docs.length) return m.content;
  const parts: any[] = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const a of imgs) parts.push({ type: 'image_url', image_url: { url: dataUrl(a) } });
  for (const a of docs) parts.push({ type: 'file', file: { filename: a.name, file_data: dataUrl(a) } });
  return parts;
}

/** Convierte un ChatMessage al formato de mensaje de la API de OpenAI. */
function openAIMessage(m: ChatMessage): any {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  const msg: any = { role: m.role, content: openAIContent(m) };
  if (m.toolCalls?.length) {
    msg.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
    if (!msg.content) msg.content = null;
  }
  return msg;
}

/**
 * Provider para endpoints compatibles con la API de OpenAI
 * (LM Studio, llama.cpp server, vLLM, LocalAI, etc.).
 */
export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    // OpenRouter usa nombres propios (repetition_penalty, top_a) y admite `reasoning`.
    private readonly openrouter: boolean = false,
    // Preferencia de enrutado de OpenRouter: '' | 'throughput' | 'latency' | 'price'.
    private readonly routeSort: string = ''
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpFetch(this.url('/models'), { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`No se pudieron listar los modelos (${res.status} ${res.statusText})`);
    }
    const json: any = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .filter((m: any) => typeof m?.id === 'string')
      .map((m: any) => {
        const arch = m.architecture ?? {};
        const inputs: string[] = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
        const modality: string = typeof arch.modality === 'string' ? arch.modality : '';
        const params: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
        const hasIn = (k: string) => inputs.includes(k) || modality.includes(k);
        return {
          id: m.id,
          // OpenRouter expone context_length; LM Studio a veces max_context_length.
          contextLength: typeof m.context_length === 'number' ? m.context_length
            : typeof m.max_context_length === 'number' ? m.max_context_length
            : undefined,
          vision: hasIn('image') || undefined,
          files: hasIn('file') || undefined,
          audio: hasIn('audio') || undefined,
          tools: params.includes('tools') || undefined,
          reasoning: params.includes('reasoning') || params.includes('include_reasoning') || undefined,
        };
      });
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    p: GenerationParams,
    cb: StreamCallbacks
  ): Promise<ChatResult> {
    const body: any = {
      model,
      messages: messages.map(openAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (p.tools && p.tools.length) {
      body.tools = p.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.maxTokens !== undefined && p.maxTokens > 0) body.max_tokens = p.maxTokens;
    if (p.topP !== undefined) body.top_p = p.topP;
    if (p.topK !== undefined) body.top_k = p.topK; // extensión de LM Studio / llama.cpp
    if (p.minP !== undefined) body.min_p = p.minP;
    if (p.repeatPenalty !== undefined) {
      // OpenRouter lo llama repetition_penalty; LM Studio / llama.cpp, repeat_penalty.
      if (this.openrouter) body.repetition_penalty = p.repeatPenalty;
      else body.repeat_penalty = p.repeatPenalty;
    }
    if (p.presencePenalty !== undefined) body.presence_penalty = p.presencePenalty;
    if (p.frequencyPenalty !== undefined) body.frequency_penalty = p.frequencyPenalty;
    if (p.seed !== undefined) body.seed = p.seed;
    if (p.topA !== undefined) body.top_a = p.topA; // sampler específico de OpenRouter
    if (p.stop && p.stop.length) body.stop = p.stop;
    // OpenRouter: pedir que el modelo de razonamiento devuelva sus tokens de thinking.
    if (p.thinking && this.openrouter) body.reasoning = { enabled: true };
    // OpenRouter: preferencia de enrutado entre proveedores (velocidad/precio).
    if (this.openrouter && this.routeSort) body.provider = { sort: this.routeSort };

    const res = await httpFetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: cb.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(formatHttpError('Backend', res.status, res.statusText, detail));
    }

    const reader = res.body.getReader();
    let answer = '';
    let thinking = '';
    const toolAcc: Record<number, { id: string; name: string; arguments: string }> = {};
    let usage: any;
    const splitter = createThinkSplitter(
      (a) => { answer += a; cb.onDelta(a); },
      (th) => { thinking += th; cb.onReasoning?.(th); }
    );

    await readLines(reader, (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        return; // Línea parcial o no-JSON: se ignora.
      }
      // Algunos servidores (OpenRouter, etc.) mandan el error DENTRO del stream.
      if (json?.error) {
        const err = json.error;
        let m = err?.message ?? JSON.stringify(err);
        // OpenRouter esconde la causa real (p. ej. "tools no soportadas") en metadata.
        const meta = err?.metadata;
        if (meta) {
          const raw = typeof meta.raw === 'string' ? meta.raw.trim() : meta.raw ? JSON.stringify(meta.raw) : '';
          if (raw) m += ` — ${raw}`;
          if (meta.provider_name) m += ` (proveedor: ${meta.provider_name})`;
        }
        if (err?.code) m += ` [${err.code}]`;
        throw new Error(`Backend (stream): ${m}`);
      }
      if (json?.usage) {
        usage = {
          promptTokens: json.usage.prompt_tokens || 0,
          completionTokens: json.usage.completion_tokens || 0,
          totalTokens: json.usage.total_tokens || 0,
        };
        if (typeof json.usage.cost === 'number') usage.cost = json.usage.cost;
      }
      const delta = json?.choices?.[0]?.delta ?? {};
      // Servidores con campo de razonamiento dedicado (o1-style).
      const reasoning: string = delta.reasoning_content ?? delta.reasoning ?? '';
      if (reasoning) {
        thinking += reasoning;
        cb.onReasoning?.(reasoning);
      }
      // Contenido normal: puede traer <think>…</think> embebido.
      if (delta.content) splitter.push(delta.content);
      // Acumula tool_calls que llegan fragmentados.
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : 0;
          const e = (toolAcc[i] ??= { id: '', name: '', arguments: '' });
          if (tc.id) e.id = tc.id;
          if (tc.function?.name) e.name += tc.function.name;
          if (tc.function?.arguments) e.arguments += tc.function.arguments;
        }
      }
    });
    splitter.flush();

    const toolCalls = Object.values(toolAcc)
      .filter((t) => t.name)
      .map((t) => ({ id: t.id || `call_${t.name}`, name: t.name, arguments: t.arguments || '{}' }));

    return { answer, thinking, usage, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}
