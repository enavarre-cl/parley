import { test } from 'node:test';
import assert from 'node:assert';
import { addUsage, estTokens, msgTokens, applyVariantToMessage, isHiddenToolMsg, sanitizeAttachments, errMsg, makeNonce } from '../chatHelpers';
import { ChatMessage, ChatVariant } from '../providers/types';

test('addUsage sums fields and keeps cost only when non-zero', () => {
  assert.deepEqual(addUsage(undefined, { promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
    { promptTokens: 1, completionTokens: 2, totalTokens: 3 });
  assert.equal(addUsage({ promptTokens: 5 }, undefined)!.promptTokens, 5);
  const s = addUsage({ promptTokens: 1, totalTokens: 1, cost: 0.5 }, { promptTokens: 2, totalTokens: 2, cost: 0.25 })!;
  assert.equal(s.promptTokens, 3); assert.equal(s.totalTokens, 3); assert.equal(s.cost, 0.75);
  assert.equal('cost' in addUsage({ totalTokens: 1 }, { totalTokens: 1 })!, false);
});

test('estTokens ~ length/4, 0 for empty', () => {
  assert.equal(estTokens(), 0);
  assert.equal(estTokens(''), 0);
  assert.equal(estTokens('abcd'), 1);
  assert.equal(estTokens('abcde'), 2);
});

test('msgTokens counts content + attachments (image flat, ref by bytes)', () => {
  const base = estTokens('hello') + 4;
  assert.equal(msgTokens({ role: 'user', content: 'hello' }), base);
  assert.equal(msgTokens({ role: 'user', content: 'hello', attachments: [{ kind: 'image', name: 'i', mime: 'image/png', data: 'x' }] }), base + 1200);
  // ref-only text attachment uses bytes/4 (not 0).
  assert.equal(msgTokens({ role: 'user', content: '', attachments: [{ kind: 'text', name: 't', mime: 'text/plain', ref: 'r', bytes: 40 }] }), 4 + 10);
});

test('applyVariantToMessage mirrors and deletes absent fields', () => {
  const m: ChatMessage = { role: 'assistant', content: 'old', thinking: 'th', usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } };
  const v: ChatVariant = { content: 'new' };
  applyVariantToMessage(m, v);
  assert.equal(m.content, 'new');
  assert.equal('thinking' in m, false);
  assert.equal('usage' in m, false);
});

test('isHiddenToolMsg: tool results and assistant tool_calls', () => {
  assert.equal(isHiddenToolMsg({ role: 'tool', content: 'x' }), true);
  assert.equal(isHiddenToolMsg({ role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'f', arguments: '{}' }] }), true);
  assert.equal(isHiddenToolMsg({ role: 'assistant', content: 'hi' }), false);
  assert.equal(isHiddenToolMsg({ role: 'user', content: 'hi' }), false);
});

test('sanitizeAttachments filters invalid and caps at 10', () => {
  assert.deepEqual(sanitizeAttachments(null), []);
  assert.deepEqual(sanitizeAttachments([{ kind: 'image' }]), []); // no data
  const ok = sanitizeAttachments([{ kind: 'text', data: 'x' }]);
  assert.equal(ok.length, 1); assert.equal(ok[0].name, 'attachment'); assert.equal(ok[0].mime, 'text/plain');
  assert.equal(sanitizeAttachments(Array.from({ length: 20 }, () => ({ kind: 'text', data: 'x' }))).length, 10);
});

test('errMsg friendlies connection errors, passes others through', () => {
  assert.match(errMsg(new Error('fetch failed')), /Could not connect/);
  assert.equal(errMsg(new Error('boom')), 'boom');
});

test('makeNonce is alphanumeric and non-empty', () => {
  const n = makeNonce();
  assert.ok(n.length > 0);
  assert.match(n, /^[A-Za-z0-9]+$/);
});
