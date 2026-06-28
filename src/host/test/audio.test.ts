import { test } from 'node:test';
import assert from 'node:assert';
import { splitForTTS, wavData, concatWavs } from '../audio';

/** Creates a minimal WAV with a 44-byte header + `pcm` bytes of data. */
function makeWav(pcmLen: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(22050, 24); h.writeUInt32LE(44100, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcmLen, 40);
  return Buffer.concat([h, Buffer.alloc(pcmLen, 7)]);
}

test('splitForTTS splits by sentences and loses no text', () => {
  const parts = splitForTTS('Hello world. How are you? Fine, thanks!');
  assert.ok(parts.length >= 1);
  assert.ok(parts.join(' ').includes('Hello world'));
  assert.ok(parts.join(' ').includes('thanks'));
});

test('splitForTTS splits sentences longer than maxLen', () => {
  const long = 'word '.repeat(100).trim(); // ~499 chars, one "sentence" with no punctuation
  const parts = splitForTTS(long, 100);
  assert.ok(parts.length > 1, 'should chunk');
  for (const p of parts) assert.ok(p.length <= 100, `chunk too long: ${p.length}`);
});

test('splitForTTS never returns empty', () => {
  assert.deepEqual(splitForTTS('   '), ['   ']);
});

test('concatWavs sums the PCM and fixes the size headers', () => {
  const a = makeWav(100), b = makeWav(250);
  const out = concatWavs([a, b]);
  const d = wavData(out);
  assert.equal(d.len, 350, 'concatenated PCM = sum');
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size = fileSize-8');
  assert.equal(out.readUInt32LE(40), 350, 'data sub-chunk size');
  assert.equal(out.toString('ascii', 0, 4), 'RIFF');
  assert.equal(out.toString('ascii', 8, 12), 'WAVE');
});

test('concatWavs with empty list returns empty buffer', () => {
  assert.equal(concatWavs([]).length, 0);
});
