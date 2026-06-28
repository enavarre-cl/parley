import './vscodeStub'; // must come first: stubs `vscode` for the modules pulled in below
import { test } from 'node:test';
import assert from 'node:assert';
import { applyPatch } from '../applyPatch';
import { defaultDoc, parseDoc, serializeDoc, ChatDoc } from '../chatDocument';

const makeDoc = (): ChatDoc => defaultDoc({ provider: 'ollama', temperature: 0.7, maxTokens: 2048 });

test('applyPatch with null/undefined is a no-op', () => {
  const a = makeDoc();
  const before = JSON.stringify(a);
  applyPatch(a, null);
  applyPatch(a, undefined);
  applyPatch(a, 'not an object' as unknown as null);
  assert.equal(JSON.stringify(a), before);
});

test('applyPatch sets valid top-level string fields', () => {
  const doc = makeDoc();
  applyPatch(doc, { title: 'Hello', model: 'gpt-x', systemPrompt: 'be brief' });
  assert.equal(doc.title, 'Hello');
  assert.equal(doc.model, 'gpt-x');
  assert.equal(doc.systemPrompt, 'be brief');
});

test('applyPatch ignores invalid top-level field types', () => {
  const doc = makeDoc();
  const origTitle = doc.title;
  const origModel = doc.model;
  applyPatch(doc, { title: 123 as unknown as string, model: null as unknown as string });
  assert.equal(doc.title, origTitle);
  assert.equal(doc.model, origModel);
});

test('applyPatch accepts a valid provider and rejects an unknown one', () => {
  const doc = makeDoc();
  applyPatch(doc, { provider: 'anthropic' });
  assert.equal(doc.provider, 'anthropic');
  applyPatch(doc, { provider: 'definitely-not-a-provider' });
  assert.equal(doc.provider, 'anthropic'); // unchanged
});

test('applyPatch validates spellLang against the allowed set', () => {
  const doc = makeDoc();
  applyPatch(doc, { spellLang: 'es' });
  assert.equal(doc.spellLang, 'es');
  applyPatch(doc, { spellLang: 'auto' });
  assert.equal(doc.spellLang, 'auto');
  applyPatch(doc, { spellLang: 'xx' }); // not allowed
  assert.equal(doc.spellLang, 'auto'); // unchanged
});

test('applyPatch updates scalar params and ignores invalid ones', () => {
  const doc = makeDoc();
  applyPatch(doc, { params: { temperature: 0.9, thinking: true, tools: true, stop: ['END', 5, 'STOP'] } });
  assert.equal(doc.params.temperature, 0.9);
  assert.equal(doc.params.thinking, true);
  assert.equal(doc.params.tools, true);
  assert.deepEqual(doc.params.stop, ['END', 'STOP']); // non-strings filtered out

  applyPatch(doc, { params: { temperature: NaN } });
  assert.equal(doc.params.temperature, 0.9); // NaN rejected, unchanged
});

test('applyPatch updates toggle params (enabled + value)', () => {
  const doc = makeDoc();
  applyPatch(doc, { params: { maxTokens: { enabled: true, value: 512 } } });
  assert.equal(doc.params.maxTokens.enabled, true);
  assert.equal(doc.params.maxTokens.value, 512);

  // Partial / invalid toggle updates leave the other field intact.
  applyPatch(doc, { params: { maxTokens: { value: NaN } } });
  assert.equal(doc.params.maxTokens.enabled, true);
  assert.equal(doc.params.maxTokens.value, 512); // NaN rejected
  applyPatch(doc, { params: { maxTokens: { enabled: false } } });
  assert.equal(doc.params.maxTokens.enabled, false);
  assert.equal(doc.params.maxTokens.value, 512);
});

test('applyPatch updates ui panel visibility and validates booleans', () => {
  const doc = makeDoc();
  applyPatch(doc, { ui: { thinkOpen: false, toolsOpen: true } });
  assert.deepEqual(doc.ui, { thinkOpen: false, toolsOpen: true });

  // A partial patch leaves the other panel's state intact.
  applyPatch(doc, { ui: { thinkOpen: true } });
  assert.deepEqual(doc.ui, { thinkOpen: true, toolsOpen: true });

  // Non-boolean values are rejected (the JSON boundary is untrusted).
  applyPatch(doc, { ui: { thinkOpen: 'oops' as unknown as boolean } });
  assert.equal(doc.ui?.thinkOpen, true); // unchanged
});

test('applyPatch updates ui.configSections and ui.zoom (validated, merged)', () => {
  const doc = makeDoc();
  applyPatch(doc, { ui: { configSections: ['sysprompt', 'sampling'], zoom: 1.4 } });
  assert.deepEqual(doc.ui?.configSections, ['sysprompt', 'sampling']);
  assert.equal(doc.ui?.zoom, 1.4);

  // An empty array is a valid "everything collapsed" state (kept, not dropped).
  applyPatch(doc, { ui: { configSections: [] } });
  assert.deepEqual(doc.ui?.configSections, []);
  assert.equal(doc.ui?.zoom, 1.4); // untouched by the partial patch

  // Junk is rejected at the boundary: non-array sections and non-finite zoom.
  applyPatch(doc, { ui: { configSections: 'nope' as unknown as string[], zoom: NaN } });
  assert.deepEqual(doc.ui?.configSections, []); // unchanged
  assert.equal(doc.ui?.zoom, 1.4);              // unchanged
});

test('parseDoc/serializeDoc round-trips ui and omits it when absent', () => {
  const defaults = { provider: 'ollama' as const, temperature: 0.7, maxTokens: 2048 };

  // Round-trip: a persisted ui survives parse → serialize → parse.
  const withUi = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: '',
    ui: { thinkOpen: false, toolsOpen: true }, params: { temperature: 0.7 }, messages: [],
  }), defaults);
  assert.deepEqual(withUi.ui, { thinkOpen: false, toolsOpen: true });
  const reparsed = parseDoc(serializeDoc(withUi), defaults);
  assert.deepEqual(reparsed.ui, { thinkOpen: false, toolsOpen: true });

  // A doc without ui must not emit a "ui" key (chats predating the feature stay clean).
  const noUi = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: '', params: { temperature: 0.7 }, messages: [],
  }), defaults);
  assert.equal(noUi.ui, undefined);
  assert.ok(!/"ui":/.test(serializeDoc(noUi)));

  // A corrupt ui (invalid value) keeps only the valid field.
  const partial = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: '',
    ui: { thinkOpen: 'x', toolsOpen: true }, params: { temperature: 0.7 }, messages: [],
  }), defaults);
  assert.deepEqual(partial.ui, { toolsOpen: true });

  // configSections (incl. empty) + zoom survive the round-trip; non-string section ids are filtered.
  const withState = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: '',
    ui: { configSections: ['sysprompt', 2, 'sampling'], zoom: 1.25 }, params: { temperature: 0.7 }, messages: [],
  }), defaults);
  assert.deepEqual(withState.ui, { configSections: ['sysprompt', 'sampling'], zoom: 1.25 });
  assert.deepEqual(parseDoc(serializeDoc(withState), defaults).ui, { configSections: ['sysprompt', 'sampling'], zoom: 1.25 });

  // An explicit empty configSections ("all collapsed") is preserved, distinct from absent.
  const collapsed = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: '',
    ui: { configSections: [] }, params: { temperature: 0.7 }, messages: [],
  }), defaults);
  assert.deepEqual(collapsed.ui, { configSections: [] });
});

const DEFAULTS = { provider: 'ollama' as const, temperature: 0.7, maxTokens: 2048 };

test('parseDoc migrates a legacy systemPromptFile into one layer and empties the base', () => {
  // The legacy single file REPLACED the inline prompt, so migration must empty the base (the file
  // already holds that text) — preserving the exact prompt sent, not doubling it.
  const doc = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: 'old inline',
    systemPromptFile: 'sys.md', params: { temperature: 0.7 }, messages: [],
  }), DEFAULTS);
  assert.equal(doc.systemPrompt, '');
  assert.deepEqual(doc.systemPromptFiles, [{ path: 'sys.md' }]);
  // The legacy key must not survive into _extra and get re-emitted alongside the new array.
  const out = serializeDoc(doc);
  assert.ok(!/"systemPromptFile":/.test(out));
  assert.ok(/"systemPromptFiles":/.test(out));
});

test('parseDoc validates systemPromptFiles (objects + string shorthand, drops junk, keeps enabled:false)', () => {
  const doc = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: 'base',
    systemPromptFiles: [
      { path: 'a.md' },
      'b.md',                       // shorthand → { path }
      { path: 'c.md', enabled: false },
      { path: '  ' },               // blank path → dropped
      { enabled: true },            // no path → dropped
      42,                           // junk → dropped
    ],
    params: { temperature: 0.7 }, messages: [],
  }), DEFAULTS);
  assert.deepEqual(doc.systemPromptFiles, [
    { path: 'a.md' },
    { path: 'b.md' },
    { path: 'c.md', enabled: false },
  ]);
  // A present array wins over a legacy field; base is left untouched (not emptied).
  assert.equal(doc.systemPrompt, 'base');
});

test('serializeDoc round-trips systemPromptFiles and omits the key when there are no layers', () => {
  const withLayers = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: 'base',
    systemPromptFiles: [{ path: 'a.md' }, { path: 'b.md', enabled: false }],
    params: { temperature: 0.7 }, messages: [],
  }), DEFAULTS);
  const reparsed = parseDoc(serializeDoc(withLayers), DEFAULTS);
  assert.deepEqual(reparsed.systemPromptFiles, [{ path: 'a.md' }, { path: 'b.md', enabled: false }]);

  const noLayers = parseDoc(JSON.stringify({
    version: 2, provider: 'ollama', model: 'm', systemPrompt: 'base',
    params: { temperature: 0.7 }, messages: [],
  }), DEFAULTS);
  assert.equal(noLayers.systemPromptFiles, undefined);
  assert.ok(!/"systemPromptFiles":/.test(serializeDoc(noLayers)));
});
