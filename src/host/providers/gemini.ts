import { ChatMessage, ChatResult, GenImage, GenerationParams, LLMProvider, ModelInfo, StreamCallbacks, TokenUsage } from './types';
import { postStream } from './request';
import { httpFetch } from '../http';
import { readLines } from './stream';
import { imageAttachments, documentAttachments, isImageOutputModel } from './multimodal';

// ── Shapes of the Gemini REST/SSE responses we read (only the fields we use). ──────────────────
interface GeminiModel { name?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number }
interface GeminiModelsResponse { models?: GeminiModel[] }
interface GeminiInlineData { data?: string; mimeType?: string; mime_type?: string }
interface GeminiPart {
  text?: string; thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
  inlineData?: GeminiInlineData; inline_data?: GeminiInlineData;
}
interface GeminiStreamChunk {
  error?: { message?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  candidates?: { content?: { parts?: GeminiPart[] } }[];
}

/**
 * Provider for the Google Gemini API (Generative Language API).
 * Streaming via streamGenerateContent?alt=sse.
 */
export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['X-goog-api-key'] = this.apiKey;
    return h;
  }

  private base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpFetch(`${this.base()}/models`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      throw new Error(`Could not list Gemini models (${res.status} ${res.statusText})`);
    }
    const json = await res.json() as GeminiModelsResponse;
    const models = Array.isArray(json?.models) ? json.models : [];
    return models
      .filter((m) => Array.isArray(m.supportedGenerationMethods)
        && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({
        id: String(m.name).replace(/^models\//, ''),
        contextLength: typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined,
      }))
      .filter((m: ModelInfo) => !!m.id);
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    p: GenerationParams,
    cb: StreamCallbacks
  ): Promise<ChatResult> {
    // Gemini separates system into systemInstruction and uses user/model roles.
    const systemTexts: string[] = [];
    const contents: Record<string, unknown>[] = [];
    // Consecutive tool responses are grouped into a single 'user' content.
    let pendingFnResponses: Record<string, unknown>[] = [];
    const flushFns = () => {
      if (pendingFnResponses.length) {
        contents.push({ role: 'user', parts: pendingFnResponses });
        pendingFnResponses = [];
      }
    };
    for (const m of messages) {
      if (m.role === 'system') {
        if (m.content) systemTexts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        // Gemini 400s on a missing/empty function name (JSON.stringify drops `undefined`). Coerce to
        // a non-empty string so a malformed tool message degrades instead of failing the whole call.
        pendingFnResponses.push({
          functionResponse: { name: m.toolName || 'tool', response: { result: m.content } },
        });
        continue;
      }
      flushFns();
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts: Record<string, unknown>[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.toolCalls) {
          let args: unknown = {};
          try { args = JSON.parse(tc.arguments || '{}'); } catch { /* empty */ }
          parts.push({ functionCall: { name: tc.name, args } });
        }
        contents.push({ role: 'model', parts });
        continue;
      }
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const a of imageAttachments(m)) {
        parts.push({ inline_data: { mime_type: a.mime, data: a.data } });
      }
      for (const a of documentAttachments(m)) {
        parts.push({ inline_data: { mime_type: a.mime, data: a.data } });
      }
      if (!parts.length) parts.push({ text: '' });
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }
    flushFns();

    // Image-output models (nano-banana / *-flash-image): ask for the IMAGE modality and skip
    // tools/thinking, which they don't support.
    const imageOut = isImageOutputModel(model);

    const generationConfig: Record<string, unknown> = {};
    if (p.temperature !== undefined) generationConfig.temperature = p.temperature;
    if (p.maxTokens !== undefined && p.maxTokens > 0) generationConfig.maxOutputTokens = p.maxTokens;
    if (p.topP !== undefined) generationConfig.topP = p.topP;
    if (p.topK !== undefined) generationConfig.topK = p.topK;
    if (p.seed !== undefined) generationConfig.seed = p.seed;
    if (p.presencePenalty !== undefined) generationConfig.presencePenalty = p.presencePenalty;
    if (p.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = p.frequencyPenalty;
    if (p.stop && p.stop.length) generationConfig.stopSequences = p.stop;
    if (p.thinking && !imageOut) generationConfig.thinkingConfig = { includeThoughts: true };
    if (imageOut) generationConfig.responseModalities = ['TEXT', 'IMAGE'];

    const body: Record<string, unknown> = { contents, generationConfig };
    if (systemTexts.length) {
      body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };
    }
    if (!imageOut && p.tools && p.tools.length) {
      body.tools = [{
        functionDeclarations: p.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeSchema(t.parameters),
        })),
      }];
    }

    const url = `${this.base()}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const reader = await postStream(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: cb.signal,
    }, 'Gemini');
    let answer = '';
    let thinking = '';
    let usage: TokenUsage | undefined;
    const toolCalls: { id: string; name: string; arguments: string }[] = [];
    const images: GenImage[] = [];

    await readLines(reader, (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let json: GeminiStreamChunk;
      try {
        json = JSON.parse(payload);
      } catch {
        return; // Partial or non-JSON line: ignored.
      }
      // Error embedded in the stream (not silently swallowed: would truncate quietly otherwise).
      if (json?.error) {
        throw new Error(`Gemini (stream): ${json.error?.message ?? JSON.stringify(json.error)}`);
      }
      const um = json?.usageMetadata;
      if (um) {
        usage = {
          promptTokens: um.promptTokenCount || 0,
          completionTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
          totalTokens: um.totalTokenCount || 0,
        };
      }
      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const inline = part?.inlineData ?? part?.inline_data;
        if (inline?.data) {
          images.push({ mime: inline.mimeType ?? inline.mime_type ?? 'image/png', data: inline.data });
        } else if (part?.functionCall) {
          toolCalls.push({
            id: `call_${part.functionCall.name}_${toolCalls.length}`,
            name: part.functionCall.name ?? '',
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          });
        } else if (typeof part?.text === 'string') {
          if (part.thought === true) {
            thinking += part.text;
            cb.onReasoning?.(part.text);
          } else {
            answer += part.text;
            cb.onDelta(part.text);
          }
        }
      }
    }, cb.signal);

    return {
      answer, thinking, usage,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      images: images.length ? images : undefined,
    };
  }
}

/** Strips a JSON Schema for Gemini (does not accept $schema, additionalProperties, etc.). */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'additionalProperties' || k === 'title' || k === 'default') continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}
