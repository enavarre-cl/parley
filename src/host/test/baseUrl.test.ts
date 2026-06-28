import { test } from 'node:test';
import assert from 'node:assert';
import { validateBaseUrl } from '../providers/baseUrl';

test('validateBaseUrl accepts well-formed http(s) URLs', () => {
  assert.equal(validateBaseUrl('https://api.anthropic.com/v1', { hasKey: true }), 'https://api.anthropic.com/v1');
  assert.equal(validateBaseUrl('http://localhost:1234/v1', { hasKey: true }), 'http://localhost:1234/v1');
  assert.equal(validateBaseUrl('  http://127.0.0.1:11434  ', { hasKey: false }), 'http://127.0.0.1:11434');
  assert.equal(validateBaseUrl('http://[::1]:8080', { hasKey: true }), 'http://[::1]:8080');
});

test('validateBaseUrl rejects malformed URLs', () => {
  assert.throws(() => validateBaseUrl('', { hasKey: false }), /Invalid backend URL/);
  assert.throws(() => validateBaseUrl('not a url', { hasKey: false }), /Invalid backend URL/);
  // 'localhost:1234' parses with protocol 'localhost:' — caught by the scheme guard, still rejected.
  assert.throws(() => validateBaseUrl('localhost:1234', { hasKey: false }), /must use http or https/);
});

test('validateBaseUrl rejects non-http(s) schemes', () => {
  assert.throws(() => validateBaseUrl('file:///etc/passwd', { hasKey: false }), /must use http or https/);
  assert.throws(() => validateBaseUrl('javascript:alert(1)', { hasKey: false }), /must use http or https/);
  assert.throws(() => validateBaseUrl('data:text/plain,hi', { hasKey: false }), /must use http or https/);
  assert.throws(() => validateBaseUrl('ftp://example.com', { hasKey: false }), /must use http or https/);
});

test('validateBaseUrl refuses an API key over plaintext http to a remote host', () => {
  assert.throws(() => validateBaseUrl('http://api.openai.com/v1', { hasKey: true }), /plaintext http/);
  assert.throws(() => validateBaseUrl('http://192.168.1.50:8000', { hasKey: true }), /plaintext http/);
  // …but allows it when no key is attached (local OpenAI-compatible servers without auth)…
  assert.equal(validateBaseUrl('http://192.168.1.50:8000', { hasKey: false }), 'http://192.168.1.50:8000');
  // …and allows https to a remote host with a key.
  assert.equal(validateBaseUrl('https://api.openai.com/v1', { hasKey: true }), 'https://api.openai.com/v1');
});
