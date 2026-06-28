import { ChatMessage, ChatResult, GenerationParams, LLMProvider, ModelInfo, StreamCallbacks } from './types';
import { formatHttpError } from './httpError';
import { postStream } from './request';
import { httpFetch } from '../http';
import { readLines, safeToolArgs } from './stream';
import { imageAttachments, documentAttachments } from './multimodal';

// ── Shapes of the Anthropic REST/SSE responses we read (only the fields we use). ────────────────
interface AnthropicModel { id?: string }
interface AnthropicModelsResponse { data?: AnthropicModel[] }
interface AnthropicEvent {
  type?: string;
  error?: { message?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
}

/**
 * Provider for the Anthropic Messages API (Claude).
 * SSE streaming; supports extended thinking (reasoning panel).
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': this.apiKey,
    };
  }

  private base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await httpFetch(`${this.base()}/models?limit=100`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(formatHttpError('Anthropic', res.status, res.statusText, detail));
    }
    const json = await res.json() as AnthropicModelsResponse;
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.filter((m) => typeof m?.id === 'string').map((m) => ({ id: m.id as string }));
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    p: GenerationParams,
    cb: StreamCallbacks
  ): Promise<ChatResult> {
    // Anthropic separates the system and only accepts user/assistant roles.
    const systemTexts: string[] = [];
    const msgs: Record<string, unknown>[] = [];
    // Consecutive tool results are grouped into a single 'user' message.
    let pendingToolResults: Record<string, unknown>[] = [];
    const flushTools = () => {
      if (pendingToolResults.length) {
        msgs.push({ role: 'user', content: pendingToolResults });
        pendingToolResults = [];
      }
    };
    for (const m of messages) {
      if (m.role === 'system') {
        if (m.content) systemTexts.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        pendingToolResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
        continue;
      }
      flushTools();
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: Record<string, unknown>[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          let input: unknown = {};
          try { input = JSON.parse(safeToolArgs(tc.arguments)); } catch { /* unrepairable tool args: send empty input object */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        msgs.push({ role: 'assistant', content });
        continue;
      }
      const imgs = imageAttachments(m);
      const docs = documentAttachments(m);
      if (imgs.length || docs.length) {
        const content: Record<string, unknown>[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const a of imgs) {
          content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
        }
        for (const a of docs) {
          content.push({ type: 'document', source: { type: 'base64', media_type: a.mime, data: a.data } });
        }
        msgs.push({ role: m.role, content });
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    flushTools();

    // max_tokens is MANDATORY in the API.
    const maxTokens = p.maxTokens && p.maxTokens > 0 ? p.maxTokens : 4096;

    const body: Record<string, unknown> = { model, messages: msgs, max_tokens: maxTokens, stream: true };
    if (systemTexts.length) body.system = systemTexts.join('\n\n');
    if (p.stop && p.stop.length) body.stop_sequences = p.stop;
    if (p.tools && p.tools.length) {
      body.tools = p.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      body.tool_choice = { type: 'auto' };
    }

    if (p.thinking) {
      // With thinking: budget < max_tokens, and temperature MUST be 1 (top_p/top_k not allowed).
      const budget = Math.max(1024, Math.min(maxTokens - 512, 4096));
      body.max_tokens = Math.max(maxTokens, budget + 512);
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.temperature = 1; // required by the API when thinking is enabled (was only in the comment)
    } else {
      if (p.temperature !== undefined) body.temperature = p.temperature;
      if (p.topP !== undefined) body.top_p = p.topP;
      if (p.topK !== undefined) body.top_k = p.topK;
    }

    const reader = await postStream(`${this.base()}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: cb.signal,
    }, 'Anthropic');
    let answer = '';
    let thinking = '';
    let inTok = 0;
    let outTok = 0;
    const blocks: Record<number, { id: string; name: string; json: string }> = {};

    await readLines(reader, (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      let evt: AnthropicEvent;
      try {
        evt = JSON.parse(payload);
      } catch {
        return; // partial or non-JSON SSE event: skip this chunk
      }
      if (evt?.type === 'error') {
        throw new Error(`Anthropic (stream): ${evt.error?.message ?? JSON.stringify(evt.error)}`);
      }
      if (evt?.type === 'message_start' && evt.message?.usage) {
        inTok = evt.message.usage.input_tokens || 0;
        outTok = evt.message.usage.output_tokens || 0;
      } else if (evt?.type === 'message_delta' && evt.usage) {
        outTok = evt.usage.output_tokens || outTok;
      }
      const idx = evt.index ?? 0;
      if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        blocks[idx] = { id: evt.content_block.id ?? '', name: evt.content_block.name ?? '', json: '' };
      } else if (evt?.type === 'content_block_delta') {
        const d = evt.delta ?? {};
        if (d.type === 'text_delta' && d.text) {
          answer += d.text;
          cb.onDelta(d.text);
        } else if (d.type === 'thinking_delta' && d.thinking) {
          thinking += d.thinking;
          cb.onReasoning?.(d.thinking);
        } else if (d.type === 'input_json_delta' && blocks[idx]) {
          blocks[idx].json += d.partial_json ?? '';
        }
      }
    }, cb.signal);

    const toolCalls = Object.values(blocks).map((b) => ({
      id: b.id,
      name: b.name,
      arguments: safeToolArgs(b.json),
    }));

    const usage = (inTok || outTok)
      ? { promptTokens: inTok, completionTokens: outTok, totalTokens: inTok + outTok }
      : undefined;

    return { answer, thinking, usage, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}
