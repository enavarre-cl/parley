import { test } from 'node:test';
import assert from 'node:assert';
import { imageAttachments, documentAttachments, dataUrl, parseDataUrl } from '../providers/multimodal';
import { Attachment, ChatMessage } from '../providers/types';

const msg = (attachments: Attachment[]): ChatMessage =>
  ({ role: 'user', content: '', attachments } as ChatMessage);

// Regression: deleting the `.attach` sidecar leaves `ref`-only attachments with no `data`. Those must
// be excluded so a provider never receives an empty image/document (which it rejects with 400/502).
test('imageAttachments keeps resolved images and drops data-less / empty ones', () => {
  const m = msg([
    { kind: 'image', name: 'ok.png', mime: 'image/png', data: 'AAAA' },
    { kind: 'image', name: 'gone.png', mime: 'image/png', ref: 'x' }, // sidecar deleted → no data
    { kind: 'image', name: 'empty.png', mime: 'image/png', data: '' }, // resolved to nothing
    { kind: 'text', name: 'note.txt', mime: 'text/plain', data: 'hi' }, // not an image
  ]);
  const imgs = imageAttachments(m);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].name, 'ok.png');
});

test('documentAttachments drops a document whose blob did not resolve', () => {
  const m = msg([
    { kind: 'document', name: 'a.pdf', mime: 'application/pdf', data: 'JVBER' },
    { kind: 'document', name: 'gone.pdf', mime: 'application/pdf', ref: 'y' },
  ]);
  const docs = documentAttachments(m);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, 'a.pdf');
});

test('imageAttachments on a message with no attachments is empty', () => {
  assert.deepEqual(imageAttachments({ role: 'user', content: '' } as ChatMessage), []);
});

test('dataUrl / parseDataUrl round-trip', () => {
  const a: Attachment = { kind: 'image', name: 'x.png', mime: 'image/png', data: 'QUJD' };
  assert.equal(dataUrl(a), 'data:image/png;base64,QUJD');
  assert.deepEqual(parseDataUrl(dataUrl(a)), { mime: 'image/png', data: 'QUJD' });
  assert.equal(parseDataUrl('not a data url'), null);
});
