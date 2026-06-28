import { ChatMessage, ChatResult, GenImage, GenerationParams, LLMProvider, ModelInfo, StreamCallbacks, TokenUsage } from './types';
import { createThinkSplitter } from './think';
import { postStream } from './request';
import { httpFetch } from '../http';
import { readLines, safeToolArgs } from './stream';
import { isImageOutputModel, parseDataUrl } from './multimodal';
import { openAIMessage } from './openaiFormat';

// ── Shapes of the OpenAI-compatible REST/SSE responses we read (only the fields we use). ────────
interface OpenAIArchitecture { input_modalities?: string[]; modality?: string }
interface OpenAIModel {
  id?: string; architecture?: OpenAIArchitecture; supported_parameters?: string[];
  context_length?: number; max_context_length?: number;
}
interface OpenAIModelsResponse { data?: OpenAIModel[] }
interface OpenAIImagePart { image_url?: { url?: string }; url?: string }
interface OpenAIToolCallDelta { index?: number; id?: string; function?: { name?: string; arguments?: string } }
interface OpenAIDelta {
  content?: string; reasoning_content?: string; reasoning?: string;
  reasoning_details?: { text?: string; summary?: string }[];
  images?: OpenAIImagePart[]; tool_calls?: OpenAIToolCallDelta[];
}
interface OpenAIStreamChunk {
  error?: { message?: string; metadata?: { raw?: unknown; provider_name?: string }; code?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  choices?: { delta?: OpenAIDelta; message?: { images?: OpenAIImagePart[] } }[];
}

/**
 * Provider for OpenAI-API-compatible endpoints
 * (LM Studio, llama.cpp server, vLLM, LocalAI, etc.).
 */
export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    // OpenRouter uses its own names (repetition_penalty, top_a) and supports `reasoning`.
    private readonly openrouter: boolean = false,
    // OpenRouter routing preference: '' | 'throughput' | 'latency' | 'price'.
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
    const res = await httpFetch(this.url('/models'), { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`Could not list models (${res.status} ${res.statusText})`);
    }
    const json = await res.json() as OpenAIModelsResponse;
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .filter((m) => typeof m?.id === 'string')
      .map((m) => {
        const arch = m.architecture ?? {};
        const inputs: string[] = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
        const modality: string = typeof arch.modality === 'string' ? arch.modality : '';
        const params: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
        const hasIn = (k: string) => inputs.includes(k) || modality.includes(k);
        return {
          id: m.id as string, // guaranteed by the typeof m?.id === 'string' filter above
          // OpenRouter exposes context_length; LM Studio sometimes max_context_length.
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
    // Image-output models (nano-banana / *-flash-image via OpenRouter): request the image modality
    // and skip tools, which they don't support.
    const imageOut = isImageOutputModel(model);

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(openAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (imageOut) body.modalities = ['image', 'text'];
    if (!imageOut && p.tools && p.tools.length) {
      body.tools = p.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (p.maxTokens !== undefined && p.maxTokens > 0) body.max_tokens = p.maxTokens;
    if (p.topP !== undefined) body.top_p = p.topP;
    if (p.topK !== undefined) body.top_k = p.topK; // LM Studio / llama.cpp extension
    if (p.minP !== undefined) body.min_p = p.minP;
    if (p.repeatPenalty !== undefined) {
      // OpenRouter calls it repetition_penalty; LM Studio / llama.cpp calls it repeat_penalty.
      if (this.openrouter) body.repetition_penalty = p.repeatPenalty;
      else body.repeat_penalty = p.repeatPenalty;
    }
    if (p.presencePenalty !== undefined) body.presence_penalty = p.presencePenalty;
    if (p.frequencyPenalty !== undefined) body.frequency_penalty = p.frequencyPenalty;
    if (p.seed !== undefined) body.seed = p.seed;
    if (p.topA !== undefined) body.top_a = p.topA; // OpenRouter-specific sampler
    if (p.stop && p.stop.length) body.stop = p.stop;
    // OpenRouter: ask the reasoning model to return its thinking tokens.
    if (p.thinking && this.openrouter) body.reasoning = { enabled: true };
    // OpenRouter: routing preference across providers (speed/price).
    if (this.openrouter && this.routeSort) body.provider = { sort: this.routeSort };

    const reader = await postStream(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: cb.signal,
    }, 'Backend');
    let answer = '';
    let thinking = '';
    const toolAcc: Record<string, { id: string; name: string; arguments: string }> = {};
    let usage: TokenUsage | undefined;
    const images: GenImage[] = [];
    const imageSeen = new Set<string>(); // dedup (a frame may repeat in delta + final message)
    const collectImages = (arr: OpenAIImagePart[] | undefined): void => {
      if (!Array.isArray(arr)) return;
      for (const im of arr) {
        const parsed = parseDataUrl(im?.image_url?.url ?? im?.url ?? '');
        if (parsed && !imageSeen.has(parsed.data)) { imageSeen.add(parsed.data); images.push(parsed); }
      }
    };
    const splitter = createThinkSplitter(
      (a) => { answer += a; cb.onDelta(a); },
      (th) => { thinking += th; cb.onReasoning?.(th); }
    );

    await readLines(reader, (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let json: OpenAIStreamChunk;
      try {
        json = JSON.parse(payload);
      } catch {
        return; // Partial or non-JSON line: ignored.
      }
      // Some servers (OpenRouter, etc.) send the error INSIDE the stream.
      if (json?.error) {
        const err = json.error;
        let m = err?.message ?? JSON.stringify(err);
        // OpenRouter hides the real cause (e.g. "tools not supported") in metadata.
        const meta = err?.metadata;
        if (meta) {
          const raw = typeof meta.raw === 'string' ? meta.raw.trim() : meta.raw ? JSON.stringify(meta.raw) : '';
          if (raw) m += ` — ${raw}`;
          if (meta.provider_name) m += ` (provider: ${meta.provider_name})`;
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
      // Image-output models (OpenRouter): images arrive in delta.images (streaming) or the final message.
      collectImages(delta.images);
      collectImages(json?.choices?.[0]?.message?.images);
      // Servers with a dedicated reasoning field (o1-style). OpenRouter also (and for some models,
      // e.g. Gemini, ONLY) sends structured reasoning in reasoning_details: reasoning.text → text,
      // reasoning.summary → summary (reasoning.encrypted has no readable text → skipped).
      let reasoning: string = delta.reasoning_content ?? delta.reasoning ?? '';
      if (!reasoning && Array.isArray(delta.reasoning_details)) {
        reasoning = delta.reasoning_details.map((d) => d?.text ?? d?.summary ?? '').join('');
      }
      if (reasoning) {
        thinking += reasoning;
        cb.onReasoning?.(reasoning);
      }
      // Normal content: may carry embedded <think>…</think>.
      if (delta.content) splitter.push(delta.content);
      // Accumulate tool_calls that arrive fragmented.
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          // Key by index when the server fragments; else by id so multiple complete tool_calls in
          // one delta don't all collapse into slot 0 (P10).
          const key = typeof tc.index === 'number' ? `i${tc.index}` : (tc.id || '0');
          const e = (toolAcc[key] ??= { id: '', name: '', arguments: '' });
          if (tc.id) e.id = tc.id;
          if (tc.function?.name) e.name += tc.function.name;
          if (tc.function?.arguments) e.arguments += tc.function.arguments;
        }
      }
    }, cb.signal);
    splitter.flush();

    const toolCalls = Object.entries(toolAcc)
      .filter(([, t]) => t.name)
      // Synthetic id includes the accumulator key so two same-named tools without an id don't collide (P5).
      .map(([key, t]) => ({ id: t.id || `call_${t.name}_${key}`, name: t.name, arguments: safeToolArgs(t.arguments) }));

    return {
      answer, thinking, usage,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      images: images.length ? images : undefined,
    };
  }
}
