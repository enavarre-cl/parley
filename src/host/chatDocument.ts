import { Attachment, ChatMessage, ChatVariant, GenerationParams, ProviderId, TokenUsage, validateProvider } from './providers';

// ── Raw shapes as they appear in a loaded .chat file, before validation. Every field is `unknown`
// because nothing about a hand-editable JSON file is guaranteed until each branch below narrows it;
// the value of these interfaces over `any` is that a typo (reading a field that doesn't exist) is a
// compile error, and each access is forced through an explicit type check.
interface RawUsage { promptTokens?: unknown; completionTokens?: unknown; totalTokens?: unknown; cost?: unknown }
interface RawAttachment { kind?: unknown; name?: unknown; mime?: unknown; ref?: unknown; data?: unknown; bytes?: unknown }
interface RawToolCall { id?: unknown; name?: unknown; arguments?: unknown }
interface RawVariant { content?: unknown; thinking?: unknown; usage?: RawUsage; attachments?: unknown }
interface RawMessage {
  role?: unknown; content?: unknown; id?: unknown; ts?: unknown; usage?: RawUsage; thinking?: unknown;
  toolCalls?: unknown; toolCallId?: unknown; toolName?: unknown; attachments?: unknown; variants?: unknown; active?: unknown;
}
interface RawSummary { text?: unknown; upTo?: unknown }
interface RawDoc {
  params?: unknown; summary?: RawSummary; usage?: RawUsage; title?: unknown; provider?: unknown; model?: unknown;
  systemPrompt?: unknown; systemPromptFile?: unknown; systemPromptFiles?: unknown; spellLang?: unknown; messages?: unknown;
  [k: string]: unknown; // v1 loose params live at the top level; _extra round-trips unknown keys
}
/** A bag of inference settings read either from `raw.params` (v2) or the top level (v1). */
type RawParams = Record<string, unknown>;

/** Validates/normalizes raw attachments (message- or variant-level) from a loaded .chat. */
function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawAttachment[])
    .filter((a) => !!a && (a.kind === 'image' || a.kind === 'text' || a.kind === 'document')
      && (typeof a.data === 'string' || typeof a.ref === 'string'))
    .map((a) => {
      const o: Attachment = {
        kind: a.kind as Attachment['kind'],
        name: typeof a.name === 'string' ? a.name : 'attachment',
        mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
      };
      if (typeof a.ref === 'string') o.ref = a.ref;
      if (typeof a.data === 'string') o.data = a.data; // compat: legacy inline attachments
      if (typeof a.bytes === 'number' && a.bytes >= 0) o.bytes = a.bytes;
      return o;
    });
}

/** A parameter that can be toggled on/off, with its numeric value. */
export interface Toggle {
  enabled: boolean;
  value: number;
}

/** Inference settings stored in the `.chat` file. */
export interface ChatParams {
  temperature: number; // always active
  maxTokens: Toggle; // response length limit
  contextMessages: Toggle; // context window: number of last messages to send
  contextLength: Toggle; // num_ctx, model context size (Ollama)
  numThreads: Toggle; // CPU threads (Ollama)
  topK: Toggle;
  topP: Toggle;
  minP: Toggle;
  topA: Toggle; // OpenRouter sampler
  repeatPenalty: Toggle;
  presencePenalty: Toggle;
  frequencyPenalty: Toggle;
  seed: Toggle;
  stop: string[]; // stop strings
  thinking: boolean; // reasoning mode in Ollama (think: true)
  autoSummary: boolean; // when the context window fills up, summarises old messages
  tools: boolean; // enables tools (native filesystem + MCP servers)
}

/** Accumulated summary of old context (compaction). Covers messages[0..upTo). */
export interface ChatSummary {
  text: string;
  upTo: number;
}

/** Per-conversation view state persisted in the .chat. A boolean means the user explicitly set it
 *  (true = open, false = closed → streaming must not auto-reopen); absent means default (auto-open). */
export interface ChatUi {
  thinkOpen?: boolean;
  toolsOpen?: boolean;
  /** Ids of the expanded config-panel sections. Absent = the default (only the system prompt open);
   *  an explicit `[]` means the user collapsed everything. */
  configSections?: string[];
  /** Per-conversation chat zoom (history scale). Absent = 1×. */
  zoom?: number;
}

/** One markdown layer of the system prompt: a file referenced relative to the .chat, optionally muted.
 *  `enabled === false` keeps the reference but excludes it from the assembled prompt; absent = on. */
export interface SysPromptFile {
  path: string;
  enabled?: boolean;
}

export interface ChatDoc {
  version: number;
  title: string;
  provider: ProviderId;
  model: string;
  systemPrompt: string; // the open base prompt — always the first segment of the assembled prompt
  /** Ordered markdown layers appended after the base at send time (concatenated, in order). The
   *  legacy single `systemPromptFile` string is migrated into this on load. */
  systemPromptFiles?: SysPromptFile[];
  /** Path/glob (relative to the .chat) the layer list is refreshed from. Refresh is additive: it
   *  keeps `systemPromptFiles` (order + enabled) and appends any matched file not already present, so
   *  a removed-but-still-matching file re-appears last and hand-picked layers survive. */
  systemPromptGlob?: string;
  spellLang?: 'auto' | 'off' | 'es' | 'en'; // spell-checker language (per-chat). Absent/'auto' = system default
  ui?: ChatUi; // per-conversation panel visibility (Reasoning/Tools); persisted in the .chat
  params: ChatParams;
  summary?: ChatSummary;
  usage?: TokenUsage; // accumulated token usage for the chat
  messages: ChatMessage[];
  /** Unknown top-level keys from the .chat preserved verbatim across a round-trip (forward-compat /
   *  hand-edited fields). Not part of the schema; re-emitted by serializeDoc. */
  _extra?: Record<string, unknown>;
}

export interface ChatDefaults {
  provider: ProviderId;
  temperature: number;
  maxTokens: number;
}

const t = (enabled: boolean, value: number): Toggle => ({ enabled, value });

export function defaultParams(defaults: ChatDefaults): ChatParams {
  return {
    temperature: defaults.temperature,
    maxTokens: t(false, defaults.maxTokens > 0 ? defaults.maxTokens : 2048),
    contextMessages: t(false, 20),
    contextLength: t(false, 4096),
    numThreads: t(false, 4),
    topK: t(false, 40),
    topP: t(true, 0.95),
    minP: t(true, 0.05),
    topA: t(false, 0),
    repeatPenalty: t(true, 1.1),
    presencePenalty: t(false, 0),
    frequencyPenalty: t(false, 0),
    seed: t(false, 0),
    stop: [],
    thinking: false,
    autoSummary: false,
    tools: false,
  };
}

export function defaultDoc(defaults: ChatDefaults): ChatDoc {
  return {
    version: 2,
    title: 'New chat',
    provider: defaults.provider,
    model: '',
    systemPrompt: 'You are a helpful assistant.',
    params: defaultParams(defaults),
    messages: [],
  };
}

// num()/toggle() read a single still-unverified JSON value, so `unknown` IS the precise type here
// (a "maybe-number" has no narrower shape); each one narrows before use.
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : fallback;
}

/** Validates the `systemPromptFiles` array from a loaded .chat. Tolerates bare strings (hand-edited
 *  shorthand) and `{ path, enabled }` objects; drops anything without a usable path. `enabled` is only
 *  carried when explicitly false (default-on stays absent, keeping the serialized JSON clean). */
function parseSysPromptFiles(raw: unknown): SysPromptFile[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .map((it): SysPromptFile | null => {
      if (typeof it === 'string') return it.trim() ? { path: it } : null;
      if (it && typeof it === 'object') {
        const o = it as { path?: unknown; enabled?: unknown };
        if (typeof o.path === 'string' && o.path.trim()) {
          const part: SysPromptFile = { path: o.path };
          if (o.enabled === false) part.enabled = false;
          return part;
        }
      }
      return null;
    })
    .filter((p): p is SysPromptFile => !!p);
}

/** Normalises a Toggle read from JSON, tolerating old/partial formats. */
function toggle(v: unknown, def: Toggle): Toggle {
  if (typeof v === 'number') return { enabled: true, value: v };
  if (v && typeof v === 'object') {
    const o = v as { enabled?: unknown; value?: unknown };
    return { enabled: !!o.enabled, value: num(o.value, def.value) };
  }
  return { ...def };
}

/**
 * Drops a trailing INCOMPLETE tool exchange from a message list ABOUT TO BE SENT to a backend. If
 * the editor closed mid agentic loop, the history can end with a `tool` result or an `assistant`
 * still requesting tools, with no final answer — replaying that triggers a 400 (assistant tool_call
 * without its tool reply). A completed turn always ends with an assistant message that has NO
 * toolCalls, so this only strips a genuinely unfinished trailing exchange.
 *
 * IMPORTANT: apply this to the wire copy at send time — NOT inside parseDoc — because mid-loop the
 * persisted doc legitimately ends with a just-completed tool exchange whose answer isn't written yet.
 */
export function repairTrailingToolChain(messages: ChatMessage[]): void {
  while (messages.length) {
    const last = messages[messages.length - 1];
    const incomplete = last.role === 'tool' || (last.role === 'assistant' && !!(last.toolCalls && last.toolCalls.length));
    if (!incomplete) break;
    messages.pop();
  }
}

/** Parses the text of a `.chat` file. Migrates v1 format to v2. Throws if the JSON is invalid. */
export function parseDoc(text: string, defaults: ChatDefaults): ChatDoc {
  if (!text || !text.trim()) return defaultDoc(defaults);

  const parsed: unknown = JSON.parse(text);
  // JSON.parse accepts non-objects ("null", 42, [..]) — `null` in particular crashed on raw.params
  // / raw.summary below. Treat any non-object shape as an empty doc instead of throwing a TypeError.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultDoc(defaults);
  const raw = parsed as RawDoc;
  const base = defaultDoc(defaults);
  const dp = base.params;
  // Supports both the new `params` object and the loose fields from the v1 format.
  const rp: RawParams = (raw.params && typeof raw.params === 'object' ? raw.params : raw) as RawParams;

  const params: ChatParams = {
    temperature: num(rp.temperature, dp.temperature),
    maxTokens: toggle(rp.maxTokens, dp.maxTokens),
    contextMessages: toggle(rp.contextMessages, dp.contextMessages),
    contextLength: toggle(rp.contextLength, dp.contextLength),
    numThreads: toggle(rp.numThreads, dp.numThreads),
    topK: toggle(rp.topK, dp.topK),
    topP: toggle(rp.topP, dp.topP),
    minP: toggle(rp.minP, dp.minP),
    topA: toggle(rp.topA, dp.topA),
    repeatPenalty: toggle(rp.repeatPenalty, dp.repeatPenalty),
    presencePenalty: toggle(rp.presencePenalty, dp.presencePenalty),
    frequencyPenalty: toggle(rp.frequencyPenalty, dp.frequencyPenalty),
    seed: toggle(rp.seed, dp.seed),
    stop: Array.isArray(rp.stop) ? (rp.stop as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    thinking: typeof rp.thinking === 'boolean' ? rp.thinking : false,
    autoSummary: typeof rp.autoSummary === 'boolean' ? rp.autoSummary : false,
    tools: typeof rp.tools === 'boolean' ? rp.tools : false,
  };

  const summary =
    raw.summary && typeof raw.summary.text === 'string' && typeof raw.summary.upTo === 'number'
      ? { text: raw.summary.text, upTo: raw.summary.upTo }
      : undefined;

  const usage: TokenUsage | undefined =
    raw.usage && typeof raw.usage === 'object'
      ? {
          promptTokens: Number(raw.usage.promptTokens) || 0,
          completionTokens: Number(raw.usage.completionTokens) || 0,
          totalTokens: Number(raw.usage.totalTokens) || 0,
        }
      : undefined;
  if (usage && typeof raw.usage?.cost === 'number') usage.cost = raw.usage.cost;

  let ui: ChatUi | undefined;
  if (raw.ui && typeof raw.ui === 'object') {
    const rui = raw.ui as { thinkOpen?: unknown; toolsOpen?: unknown; configSections?: unknown; zoom?: unknown };
    const u: ChatUi = {};
    if (typeof rui.thinkOpen === 'boolean') u.thinkOpen = rui.thinkOpen;
    if (typeof rui.toolsOpen === 'boolean') u.toolsOpen = rui.toolsOpen;
    // Keep even an empty array: [] = "user collapsed everything", distinct from absent (= default).
    if (Array.isArray(rui.configSections)) {
      u.configSections = (rui.configSections as unknown[]).filter((s): s is string => typeof s === 'string');
    }
    if (typeof rui.zoom === 'number' && Number.isFinite(rui.zoom)) u.zoom = rui.zoom;
    if (Object.keys(u).length) ui = u;
  }

  // System-prompt layers. Prefer the new `systemPromptFiles` array; otherwise migrate a legacy single
  // `systemPromptFile`. The legacy field REPLACED the inline prompt, so on migration we empty the base
  // (the file already holds that text) — preserving the exact prompt that was being sent, not doubling it.
  let systemPrompt = typeof raw.systemPrompt === 'string' ? raw.systemPrompt : base.systemPrompt;
  let systemPromptFiles = parseSysPromptFiles(raw.systemPromptFiles);
  if (!systemPromptFiles.length && typeof raw.systemPromptFile === 'string' && raw.systemPromptFile.trim()) {
    systemPromptFiles = [{ path: raw.systemPromptFile }];
    systemPrompt = '';
  }
  const systemPromptGlob =
    typeof raw.systemPromptGlob === 'string' && raw.systemPromptGlob.trim() ? raw.systemPromptGlob : undefined;

  const doc: ChatDoc = {
    version: 2,
    title: typeof raw.title === 'string' ? raw.title : base.title,
    provider: validateProvider(raw.provider),
    model: typeof raw.model === 'string' ? raw.model : '',
    systemPrompt,
    systemPromptFiles: systemPromptFiles.length ? systemPromptFiles : undefined,
    systemPromptGlob,
    spellLang: typeof raw.spellLang === 'string' && ['auto', 'off', 'es', 'en'].includes(raw.spellLang)
      ? raw.spellLang as ChatDoc['spellLang'] : undefined,
    ui,
    params,
    summary,
    usage,
    messages: Array.isArray(raw.messages)
      ? (raw.messages as RawMessage[])
          // We never persist 'system' messages (the system prompt lives separately). Filtering them
          // preserves the invariant that webview indices == doc.messages indices.
          .filter((m) => !!m && typeof m.content === 'string' && typeof m.role === 'string' && m.role !== 'system')
          .map((m) => {
            const msg: ChatMessage = { role: m.role as ChatMessage['role'], content: m.content as string };
            if (typeof m.id === 'string') msg.id = m.id;
            if (typeof m.ts === 'string') msg.ts = m.ts;
            if (m.usage && typeof m.usage === 'object') {
              msg.usage = {
                promptTokens: Number(m.usage.promptTokens) || 0,
                completionTokens: Number(m.usage.completionTokens) || 0,
                totalTokens: Number(m.usage.totalTokens) || 0,
              };
              if (typeof m.usage.cost === 'number') msg.usage.cost = m.usage.cost;
            }
            if (typeof m.thinking === 'string' && m.thinking) msg.thinking = m.thinking;
            if (Array.isArray(m.toolCalls)) {
              msg.toolCalls = (m.toolCalls as RawToolCall[])
                .filter((t) => !!t && typeof t.name === 'string')
                .map((t) => ({ id: String(t.id ?? ''), name: t.name as string, arguments: String(t.arguments ?? '{}') }));
            }
            if (typeof m.toolCallId === 'string') msg.toolCallId = m.toolCallId;
            if (typeof m.toolName === 'string') msg.toolName = m.toolName;
            const atts = parseAttachments(m.attachments);
            if (atts.length) msg.attachments = atts;
            if (Array.isArray(m.variants)) {
              const variants = (m.variants as RawVariant[])
                .filter((v) => !!v && typeof v.content === 'string')
                .map((v) => {
                  const o: ChatVariant = { content: v.content as string };
                  if (typeof v.thinking === 'string' && v.thinking) o.thinking = v.thinking;
                  if (v.usage && typeof v.usage === 'object') {
                    o.usage = {
                      promptTokens: Number(v.usage.promptTokens) || 0,
                      completionTokens: Number(v.usage.completionTokens) || 0,
                      totalTokens: Number(v.usage.totalTokens) || 0,
                    };
                    if (typeof v.usage.cost === 'number') o.usage.cost = v.usage.cost;
                  }
                  const vatts = parseAttachments(v.attachments);
                  if (vatts.length) o.attachments = vatts;
                  return o;
                });
              if (variants.length > 1) {
                msg.variants = variants;
                msg.active = typeof m.active === 'number' && m.active >= 0 && m.active < variants.length
                  ? m.active : variants.length - 1;
              }
            }
            return msg;
          })
      : [],
  };
  // Clamp summary.upTo to a valid message index. A corrupt/hand-edited value (-5, 99999, 2.7, NaN)
  // would otherwise propagate into the context-window math. Drop the summary if it covers nothing.
  if (doc.summary) {
    let upTo = Math.floor(doc.summary.upTo);
    if (!Number.isFinite(upTo) || upTo < 0) upTo = 0;
    if (upTo > doc.messages.length) upTo = doc.messages.length;
    doc.summary = upTo > 0 ? { text: doc.summary.text, upTo } : undefined;
  }
  // Preserve unknown top-level keys so a hand-edited or future-version field survives a round-trip
  // instead of being silently dropped on the next save. Only for v2-shaped docs (a v1 doc keeps its
  // loose params on `raw`, which are migrated into `params` — not "unknown").
  if (raw.params && typeof raw.params === 'object') {
    const extra: Record<string, unknown> = {};
    for (const k of Object.keys(raw)) if (!KNOWN_TOP_KEYS.has(k)) extra[k] = raw[k];
    if (Object.keys(extra).length) doc._extra = extra;
  }
  return doc;
}

/** Top-level keys owned by the schema; anything else in a .chat is preserved via doc._extra. */
const KNOWN_TOP_KEYS = new Set([
  // 'systemPromptFile' (legacy, singular) is listed so a migrated doc's old key is consumed, not
  // round-tripped into _extra alongside the new 'systemPromptFiles'.
  'version', 'title', 'provider', 'model', 'systemPrompt', 'systemPromptFile', 'systemPromptFiles',
  'systemPromptGlob', 'spellLang', 'ui', 'params', 'summary', 'usage', 'messages',
]);

export function serializeDoc(doc: ChatDoc): string {
  const ordered: ChatDoc = {
    version: 2,
    title: doc.title,
    provider: doc.provider,
    model: doc.model,
    systemPrompt: doc.systemPrompt,
    systemPromptFiles: doc.systemPromptFiles,
    systemPromptGlob: doc.systemPromptGlob,
    spellLang: doc.spellLang,
    ui: doc.ui,
    params: {
      temperature: doc.params.temperature,
      maxTokens: doc.params.maxTokens,
      contextMessages: doc.params.contextMessages,
      contextLength: doc.params.contextLength,
      numThreads: doc.params.numThreads,
      topK: doc.params.topK,
      topP: doc.params.topP,
      minP: doc.params.minP,
      topA: doc.params.topA,
      repeatPenalty: doc.params.repeatPenalty,
      presencePenalty: doc.params.presencePenalty,
      frequencyPenalty: doc.params.frequencyPenalty,
      seed: doc.params.seed,
      stop: doc.params.stop,
      thinking: doc.params.thinking,
      autoSummary: doc.params.autoSummary,
      tools: doc.params.tools,
    },
    summary: doc.summary,
    usage: doc.usage,
    messages: doc.messages,
  };
  // Re-emit any unknown top-level keys captured on parse (forward-compat / hand-edited fields),
  // without letting them override schema fields.
  const out: Record<string, unknown> = { ...ordered };
  for (const [k, v] of Object.entries(doc._extra ?? {})) if (!(k in out)) out[k] = v;
  return JSON.stringify(out, null, 2) + '\n';
}

/** Converts the document config into the parameters sent to the backend (active ones only). */
export function resolveGenerationParams(p: ChatParams): GenerationParams {
  const g: GenerationParams = { temperature: p.temperature };
  if (p.maxTokens.enabled) g.maxTokens = p.maxTokens.value;
  if (p.contextLength.enabled) g.contextLength = p.contextLength.value;
  if (p.numThreads.enabled) g.numThreads = p.numThreads.value;
  if (p.topK.enabled) g.topK = p.topK.value;
  if (p.topP.enabled) g.topP = p.topP.value;
  if (p.minP.enabled) g.minP = p.minP.value;
  if (p.topA.enabled) g.topA = p.topA.value;
  if (p.repeatPenalty.enabled) g.repeatPenalty = p.repeatPenalty.value;
  if (p.presencePenalty.enabled) g.presencePenalty = p.presencePenalty.value;
  if (p.frequencyPenalty.enabled) g.frequencyPenalty = p.frequencyPenalty.value;
  if (p.seed.enabled) g.seed = p.seed.value;
  if (p.stop.length) g.stop = p.stop;
  if (p.thinking) g.thinking = true;
  return g;
}
