import { test } from 'node:test';
import assert from 'node:assert';
import { readLines } from '../providers/stream';

/** Creates a reader that emits `text` in chunks of `chunk` bytes (may split lines mid-way). */
function reader(text: string, chunk: number): ReadableStreamDefaultReader<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk)); c.close(); },
  });
  return stream.getReader();
}

test('readLines reassembles lines split across chunks', async () => {
  const lines: string[] = [];
  await readLines(reader('alpha\nbeta\ngamma\n', 3), (l) => lines.push(l));
  assert.deepEqual(lines, ['alpha', 'beta', 'gamma']);
});

test('readLines trims each line', async () => {
  const lines: string[] = [];
  await readLines(reader('  hola  \n\tmundo\t\n', 4), (l) => lines.push(l));
  assert.deepEqual(lines, ['hola', 'mundo']);
});

test('readLines preserves empty lines between newlines', async () => {
  const lines: string[] = [];
  await readLines(reader('a\n\nb\n', 2), (l) => lines.push(l));
  assert.deepEqual(lines, ['a', '', 'b']);
});

test('readLines emits the trailing line without a final newline', async () => {
  // Ollama ends its NDJSON with the {"done":true,…} object (token usage) and not always a
  // closing \n; the flush must emit it instead of dropping it silently.
  const lines: string[] = [];
  await readLines(reader('uno\ndos', 100), (l) => lines.push(l));
  assert.deepEqual(lines, ['uno', 'dos']);
});

test('readLines does not emit an empty trailing line on a final newline', async () => {
  const lines: string[] = [];
  await readLines(reader('uno\ndos\n', 100), (l) => lines.push(l));
  assert.deepEqual(lines, ['uno', 'dos']); // no spurious '' from the flush
});

test('readLines propagates if onLine throws (error embedded in stream)', async () => {
  await assert.rejects(
    readLines(reader('data: x\ndata: BOOM\n', 5), (l) => { if (l.includes('BOOM')) throw new Error('boom'); }),
    /boom/,
  );
});
