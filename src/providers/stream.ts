/** Tope defensivo: si el backend manda una "línea" sin `\n` que crece sin fin, evita agotar memoria. */
const MAX_LINE_BUFFER = 4 * 1024 * 1024;

/**
 * Garantiza que los argumentos de una tool-call sean JSON VÁLIDO. Los modelos a veces los entregan
 * truncados (p. ej. `{"path": "ctx/x.md`), y reenviar eso al provider en el siguiente turno provoca
 * un 400. Intenta reparar (cerrar cadenas/objetos abiertos); si no se puede, devuelve '{}'.
 */
export function safeToolArgs(s: string | undefined): string {
  const raw = (s || '').trim();
  if (!raw) return '{}';
  try { JSON.parse(raw); return raw; } catch { /* intento de reparación */ }
  let r = raw;
  if ((r.match(/(?<!\\)"/g) || []).length % 2) r += '"';   // cierra una cadena abierta
  const open = (r.match(/\{/g) || []).length;
  const close = (r.match(/\}/g) || []).length;
  if (open > close) r += '}'.repeat(open - close);         // cierra objetos abiertos
  try { JSON.parse(r); return r; } catch { return '{}'; }
}

/**
 * Lee un stream línea a línea (SSE/NDJSON) y llama `onLine` con cada línea ya recortada (trim).
 * Centraliza el manejo de buffer/decoder que antes estaba duplicado en cada provider.
 * Si `onLine` lanza, el error se propaga (los providers lo usan para errores embebidos en el stream).
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
    if (buffer.length > MAX_LINE_BUFFER) buffer = buffer.slice(-MAX_LINE_BUFFER); // cap defensivo
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  }
}
