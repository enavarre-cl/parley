import { test } from 'node:test';
import assert from 'node:assert';
import { parseProgressPct } from '../progress';

test('parseProgressPct reads a literal percentage', () => {
  assert.equal(parseProgressPct('Downloading torch 45%'), 0.45);
  assert.equal(parseProgressPct('Sampling:  10%| | 104/1000'), 0.10);
  assert.equal(parseProgressPct('100%'), 1);
  assert.equal(parseProgressPct('0%'), 0);
});

test('parseProgressPct reads an a/b MB|GB ratio when there is no percent', () => {
  assert.equal(parseProgressPct('  360.0/720.0 MB'), 0.5);
  assert.ok(Math.abs(parseProgressPct('1.0/2.0 GB')! - 0.5) < 1e-9);
  assert.equal(parseProgressPct('500/1000 MiB'), 0.5);
});

test('parseProgressPct returns undefined when there is no progress signal', () => {
  assert.equal(parseProgressPct('loading model=english device=mps'), undefined);
  assert.equal(parseProgressPct('Setting up the engine…'), undefined);
  assert.equal(parseProgressPct(''), undefined);
});

test('parseProgressPct rejects out-of-range / nonsensical values', () => {
  assert.equal(parseProgressPct('999%'), undefined);   // not a 1–3 digit 0–100
  assert.equal(parseProgressPct('800/700 MB'), undefined); // a>b
});
