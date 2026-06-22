/** Defensive cap: if the backend sends a "line" without `\n` that grows indefinitely, avoids exhausting memory. */
const MAX_LINE_BUFFER = 4 * 1024 * 1024;

/**
 * Guarantees that a tool-call's arguments are VALID JSON. Models sometimes deliver them
 * truncated (e.g. `{"path": "ctx/x.md`), and forwarding that to the provider on the next turn
 * triggers a 400. Tries to repair (close open strings/objects); if not possible, returns '{}'.
 */
export function safeToolArgs(s: string | undefined): string {
  const raw = (s || '').trim();
  if (!raw) return '{}';
  try { JSON.parse(raw); return raw; } catch { /* repair attempt */ }
  let r = raw;
  if ((r.match(/(?<!\\)"/g) || []).length % 2) r += '"';   // close an open string
  const open = (r.match(/\{/g) || []).length;
  const close = (r.match(/\}/g) || []).length;
  if (open > close) r += '}'.repeat(open - close);         // close open objects
  try { JSON.parse(r); return r; } catch { return '{}'; }
}

/**
 * Reads a stream line by line (SSE/NDJSON) and calls `onLine` with each trimmed line.
 * Centralizes the buffer/decoder handling that was previously duplicated across each provider.
 * If `onLine` throws, the error propagates (providers use this for errors embedded in the stream).
 */
export async function readLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > MAX_LINE_BUFFER) buffer = buffer.slice(-MAX_LINE_BUFFER); // defensive cap
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  }
  // Flush the trailing line that arrived without a final newline. Ollama ends its NDJSON with the
  // {"done":true,…} object — which carries the token usage — and does not always append a closing
  // \n, so skipping this would silently drop that final chunk (and the usage with it).
  buffer += decoder.decode(); // flush any pending multibyte remainder
  const tail = buffer.trim();
  if (tail) onLine(tail);
}
