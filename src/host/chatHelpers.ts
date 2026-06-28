/** Pure chat/message helpers (no VS Code dependency), extracted from extension.ts so the logic is
 *  small, reusable and unit-testable. Types come from providers/types (which imports nothing). */
import * as crypto from 'crypto';
import { ChatMessage, ChatVariant, TokenUsage } from './providers/types';

// Inputs are Partial because a provider may omit a field (each is defaulted to 0); the merged
// result is always a complete TokenUsage.
export function addUsage(a: Partial<TokenUsage> | undefined, b: Partial<TokenUsage> | undefined): TokenUsage | undefined {
  if (!a && !b) return undefined;
  const out: TokenUsage = {
    promptTokens: (a?.promptTokens || 0) + (b?.promptTokens || 0),
    completionTokens: (a?.completionTokens || 0) + (b?.completionTokens || 0),
    totalTokens: (a?.totalTokens || 0) + (b?.totalTokens || 0),
  };
  const cost = (a?.cost || 0) + (b?.cost || 0);
  if (cost) out.cost = cost;
  return out;
}

/** Rough token estimate (~4 characters per token). */
export function estTokens(s?: string): number {
  return s ? Math.ceil(s.length / 4) : 0;
}

/** Mirrors a variant's fields onto its parent message (content always; thinking/usage/attachments
 *  set when present, deleted when absent). The single source of truth for variant→message sync. */
export function applyVariantToMessage(m: ChatMessage, v: ChatVariant): void {
  m.content = v.content;
  if (v.thinking) m.thinking = v.thinking; else delete m.thinking;
  if (v.usage) m.usage = v.usage; else delete m.usage;
  if (v.attachments) m.attachments = v.attachments; else delete m.attachments;
}

/** Approximate token cost of a message, including attachments (ref-only ones use their stored size). */
export function msgTokens(m: ChatMessage): number {
  let t = estTokens(m.content) + 4;
  for (const a of m.attachments ?? []) {
    // Blobs live in the .attach sidecar, so history messages hold {ref} without `data`. Fall back to
    // the stored byte size so large attached files aren't budgeted as 0 (which overflowed the window).
    if (a.kind === 'image') t += 1200;
    else t += a.data ? estTokens(a.data) : Math.ceil((a.bytes ?? 0) / 4);
  }
  return t;
}

/** Is this an internal tool message (hidden in the UI)? An assistant with toolCalls or a 'tool' result. */
export function isHiddenToolMsg(m: ChatMessage): boolean {
  return m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
}

/** Validates and limits the attachments arriving from the webview. */
export function sanitizeAttachments(input: unknown): { kind: 'image' | 'text' | 'document'; name: string; mime: string; data: string }[] {
  if (!Array.isArray(input)) return [];
  const out: { kind: 'image' | 'text' | 'document'; name: string; mime: string; data: string }[] = [];
  for (const a of (input as { kind?: unknown; name?: unknown; mime?: unknown; data?: unknown }[]).slice(0, 10)) {
    if (!a || (a.kind !== 'image' && a.kind !== 'text' && a.kind !== 'document')) continue;
    if (typeof a.data !== 'string' || !a.data) continue;
    out.push({
      kind: a.kind,
      name: typeof a.name === 'string' ? a.name : 'attachment',
      mime: typeof a.mime === 'string' ? a.mime : (a.kind === 'image' ? 'image/png' : 'text/plain'),
      data: a.data,
    });
  }
  return out;
}

/** Maps a raw error to a friendlier backend-connection message when applicable. */
export function errMsg(err: unknown): string {
  const m = (typeof err === 'object' && err !== null && 'message' in err)
    ? String((err as Record<string, unknown>).message)
    : String(err);
  if (/fetch failed|ECONNREFUSED|Failed to fetch/i.test(m)) {
    return 'Could not connect to the backend. Is LM Studio / Ollama running? Check the URL in settings (🔧).';
  }
  return m;
}

/** Cryptographic nonce (not Math.random) for the webview CSP. */
export function makeNonce(): string {
  // hex: 128 bits of entropy, fixed length, all CSP-safe chars. (base64 + stripping non-alphanumerics
  // dropped a variable number of +/=/ chars, shortening the nonce and reducing entropy unpredictably.)
  return crypto.randomBytes(16).toString('hex');
}
