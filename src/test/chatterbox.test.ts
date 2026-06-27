import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseTimecode, validateRange, validateSourceUrl, voiceId, isSafeVoiceId, formatSections,
} from '../chatterbox/assets';

test('parseTimecode parses ss / mm:ss / hh:mm:ss', () => {
  assert.equal(parseTimecode('30'), 30);
  assert.equal(parseTimecode('1:30'), 90);
  assert.equal(parseTimecode('01:00:00'), 3600);
  assert.equal(parseTimecode('0:05'), 5);
});

test('parseTimecode rejects malformed input and out-of-range fields', () => {
  assert.equal(parseTimecode('abc'), null);
  assert.equal(parseTimecode('1:70'), null);   // seconds field > 59
  assert.equal(parseTimecode('1:70:00'), null); // minutes field > 59
  assert.equal(parseTimecode(''), null);
  assert.equal(parseTimecode('1:2:3:4'), null);
});

test('validateRange enforces start<end and a max duration', () => {
  assert.deepEqual(validateRange('00:10', '00:25'), { ok: true, start: 10, end: 25 });
  assert.equal(validateRange('00:30', '00:10').ok, false); // end before start
  assert.equal(validateRange('00:00', '01:00', 30).ok, false); // 60s > 30s max
  assert.equal(validateRange('x', '00:10').ok, false); // unparseable
});

test('validateSourceUrl allows only YouTube https by default (anti-SSRF)', () => {
  assert.equal(validateSourceUrl('https://www.youtube.com/watch?v=abc').ok, true);
  assert.equal(validateSourceUrl('https://youtu.be/abc').ok, true);
  assert.equal(validateSourceUrl('https://evil.example.com/x').ok, false);
  assert.equal(validateSourceUrl('http://169.254.169.254/').ok, false); // not YouTube, blocked
  assert.equal(validateSourceUrl('file:///etc/passwd').ok, false);
  assert.equal(validateSourceUrl('not a url').ok, false);
});

test('validateSourceUrl with allowAny still requires http(s)', () => {
  assert.equal(validateSourceUrl('https://example.com/a.mp4', true).ok, true);
  assert.equal(validateSourceUrl('file:///etc/passwd', true).ok, false);
  assert.equal(validateSourceUrl('javascript:alert(1)', true).ok, false);
});

test('voiceId sanitizes to a safe path component', () => {
  assert.equal(voiceId('Morgan Freeman'), 'morgan-freeman');
  assert.equal(voiceId('  ../../etc/passwd '), 'etc-passwd');
  assert.equal(voiceId('!!!'), null);
  assert.ok(isSafeVoiceId(voiceId('Morgan Freeman')!));
});

test('isSafeVoiceId rejects traversal and unsafe characters', () => {
  assert.equal(isSafeVoiceId('morgan-freeman'), true);
  assert.equal(isSafeVoiceId('../x'), false);
  assert.equal(isSafeVoiceId('a/b'), false);
  assert.equal(isSafeVoiceId('a.b'), false);
  assert.equal(isSafeVoiceId('-lead'), false);
  assert.equal(isSafeVoiceId(''), false);
});

test('formatSections emits the yt-dlp --download-sections token', () => {
  assert.equal(formatSections(30, 45), '*00:00:30-00:00:45');
  assert.equal(formatSections(3661, 3675), '*01:01:01-01:01:15');
});
