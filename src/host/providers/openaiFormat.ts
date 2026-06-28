/** OpenAI-API message formatting: converts ChatMessage → the request `messages` shape. */
import { ChatMessage } from './types';
import { imageAttachments, documentAttachments, dataUrl } from './multimodal';
import { safeToolArgs } from './stream';

/** Message content in OpenAI format: string, or array of parts if there are images/documents. */
export function openAIContent(m: ChatMessage): string | Record<string, unknown>[] | undefined {
  const imgs = imageAttachments(m);
  const docs = documentAttachments(m);
  if (!imgs.length && !docs.length) return m.content;
  const parts: Record<string, unknown>[] = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const a of imgs) parts.push({ type: 'image_url', image_url: { url: dataUrl(a) } });
  for (const a of docs) parts.push({ type: 'file', file: { filename: a.name, file_data: dataUrl(a) } });
  return parts;
}

/** Converts a ChatMessage to the OpenAI API message format. */
export function openAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  const msg: Record<string, unknown> = { role: m.role, content: openAIContent(m) };
  if (m.toolCalls?.length) {
    msg.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      // Sanitize on SEND: repair a tool-call already saved with invalid JSON (otherwise the provider
      // returns 400 on every turn and the conversation stays permanently blocked).
      function: { name: tc.name, arguments: safeToolArgs(tc.arguments) },
    }));
    if (!msg.content) msg.content = null;
  }
  return msg;
}
