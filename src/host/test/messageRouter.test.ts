import './vscodeStub'; // must come first: stubs `vscode` for the modules pulled in below
import { vscodeCalls, resetVscodeCalls } from './vscodeStub';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { routeMessage, RouterCtx, WebviewMessage } from '../messageRouter';
import { ChatDoc, defaultDoc } from '../chatDocument';
import { ChatMessage } from '../providers/types';

/**
 * Integration tests for the webview→host message router. `routeMessage` is dependency-injected via a
 * RouterCtx, so we feed it a mock ctx whose every method records its calls and assert that each
 * message `type` dispatches to the expected handler. This is the regression net for "wiring" bugs —
 * the 1.5.2 class, where a renamed `case` label silently stops a webview message from doing anything.
 */

const DEFAULTS = { provider: 'ollama' as const, temperature: 0.7, maxTokens: 2048 };
type Call = { name: string; args: unknown[] };

function docWith(messages: ChatMessage[]): ChatDoc {
  const d = defaultDoc(DEFAULTS);
  d.messages = messages;
  return d;
}

/** Builds a RouterCtx whose every dependency records its invocations into `calls`. */
function makeCtx(opts: { doc?: ChatDoc | null; busy?: boolean; confirm?: boolean; globMatches?: string[] } = {}) {
  const calls: Call[] = [];
  const doc = opts.doc === undefined ? defaultDoc(DEFAULTS) : opts.doc;
  const sync = (name: string) => (...args: unknown[]): void => { calls.push({ name, args }); };
  const asyncFn = (name: string) => async (...args: unknown[]): Promise<void> => { calls.push({ name, args }); };

  const ctx = {
    webview: { postMessage: sync('webview.postMessage') },
    getDoc: () => doc,
    writeDoc: asyncFn('writeDoc'),
    pushDoc: sync('pushDoc'),
    pushLang: sync('pushLang'),
    sendHistory: sync('sendHistory'),
    loadModels: asyncFn('loadModels'),
    handleSend: asyncFn('handleSend'),
    handleGenerate: asyncFn('handleGenerate'),
    handleFork: asyncFn('handleFork'),
    handleContinue: asyncFn('handleContinue'),
    handleRegenerate: asyncFn('handleRegenerate'),
    setVariant: asyncFn('setVariant'),
    deleteVariant: asyncFn('deleteVariant'),
    ensureSummary: async (...a: unknown[]): Promise<string> => { calls.push({ name: 'ensureSummary', args: a }); return ''; },
    synthPiper: asyncFn('synthPiper'),
    synthChatterbox: asyncFn('synthChatterbox'),
    killPiper: sync('killPiper'),
    resolveSystemPrompt: () => '',
    tlog: sync('tlog'),
    applyPatch: sync('applyPatch'),
    abortRef: { current: { abort: sync('abort') } },
    busyRef: { value: !!opts.busy },
    ttsTokenRef: { value: 0 },
    spellWords: { add: asyncFn('spellWords.add'), all: async () => [] },
    downloadedVoiceIds: () => [],
    downloadedChatterboxVoices: () => [],
    piper: { update: asyncFn('piper.update'), ensureVoice: asyncFn('piper.ensureVoice') },
    chatterbox: {},
    globalStorageUri: { path: '/gs' },
    document: { uri: { fsPath: '/x/test.chat', path: '/x/test.chat', toString: () => 'file:///x/test.chat' } },
    searchFiles: async () => [],
    resolveSysPromptGlob: async () => (opts.globMatches ?? []),
    sysPromptPathAllowed: () => true,
    confirmDelete: async (...a: unknown[]): Promise<boolean> => { calls.push({ name: 'confirmDelete', args: a }); return opts.confirm !== false; },
    resolveAttachment: (a: unknown) => a,
  };
  return { ctx: ctx as unknown as RouterCtx, calls };
}

const had = (calls: Call[], name: string): boolean => calls.some((c) => c.name === name);
const route = (msg: WebviewMessage, ctx: RouterCtx) => routeMessage(msg, ctx);

beforeEach(() => resetVscodeCalls());

// ── Lifecycle / config ──────────────────────────────────────────────────────────────────────────
test("'ready' pushes language + doc and loads models", async () => {
  const { ctx, calls } = makeCtx();
  await route({ type: 'ready' }, ctx);
  assert.ok(had(calls, 'pushLang'));
  assert.ok(had(calls, 'pushDoc'));
  assert.ok(had(calls, 'loadModels'));
});

test("'setConfig' applies the patch and persists", async () => {
  const { ctx, calls } = makeCtx();
  await route({ type: 'setConfig', patch: { title: 'X' } }, ctx);
  assert.ok(had(calls, 'applyPatch'));
  assert.ok(had(calls, 'writeDoc'));
});

test("'setConfig' while busy lets ONLY a ui-only patch through (mid-stream panel toggle)", async () => {
  const uiOnly = makeCtx({ busy: true });
  await route({ type: 'setConfig', patch: { ui: { thinkOpen: true } } }, uiOnly.ctx);
  assert.ok(had(uiOnly.calls, 'applyPatch')); // ui-only passthrough

  const heavy = makeCtx({ busy: true });
  await route({ type: 'setConfig', patch: { systemPrompt: 'x' } }, heavy.ctx);
  assert.ok(!had(heavy.calls, 'applyPatch')); // a heavier patch is dropped while busy
});

test("'refreshModels' reloads models", async () => {
  const { ctx, calls } = makeCtx();
  await route({ type: 'refreshModels' }, ctx);
  assert.ok(had(calls, 'loadModels'));
});

test("'spellAddWord' adds to the active language list (and validates the lang)", async () => {
  const ok = makeCtx();
  await route({ type: 'spellAddWord', word: 'foo', lang: 'es' }, ok.ctx);
  assert.ok(had(ok.calls, 'spellWords.add'));

  const bad = makeCtx();
  await route({ type: 'spellAddWord', word: 'foo', lang: 'zz' }, bad.ctx);
  assert.ok(!had(bad.calls, 'spellWords.add'));
});

// ── Turn lifecycle ──────────────────────────────────────────────────────────────────────────────
test("'send' dispatches to handleSend and respects the busy lock", async () => {
  const free = makeCtx();
  await route({ type: 'send', text: 'hi' }, free.ctx);
  const sent = free.calls.find((c) => c.name === 'handleSend');
  assert.ok(sent, 'handleSend should be called');
  assert.equal(sent!.args[0], 'hi');

  const busy = makeCtx({ busy: true });
  await route({ type: 'send', text: 'hi' }, busy.ctx);
  assert.ok(!had(busy.calls, 'handleSend'), 'a send while busy is dropped');
});

test("'stop' aborts the in-flight request", async () => {
  const { ctx, calls } = makeCtx();
  await route({ type: 'stop' }, ctx);
  assert.ok(had(calls, 'abort'));
});

test("'regenerate' / 'continue' dispatch to their handlers", async () => {
  const r = makeCtx();
  await route({ type: 'regenerate' }, r.ctx);
  assert.ok(had(r.calls, 'handleRegenerate'));

  const c = makeCtx();
  await route({ type: 'continue' }, c.ctx);
  assert.ok(had(c.calls, 'handleContinue'));
});

test("'fork' requires an integer index", async () => {
  const ok = makeCtx();
  await route({ type: 'fork', index: 2, fromHere: true }, ok.ctx);
  const f = ok.calls.find((c) => c.name === 'handleFork');
  assert.ok(f); assert.equal(f!.args[0], 2); assert.equal(f!.args[1], true);

  const bad = makeCtx();
  await route({ type: 'fork', index: 1.5 }, bad.ctx);
  assert.ok(!had(bad.calls, 'handleFork'));
});

test("'regenerateFrom' only acts on a user message, trimming what follows", async () => {
  const onUser = makeCtx({ doc: docWith([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]) });
  await route({ type: 'regenerateFrom', index: 0 }, onUser.ctx);
  assert.ok(had(onUser.calls, 'writeDoc'));
  assert.ok(had(onUser.calls, 'sendHistory'));
  assert.ok(had(onUser.calls, 'handleGenerate'));

  const onAssistant = makeCtx({ doc: docWith([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]) });
  await route({ type: 'regenerateFrom', index: 1 }, onAssistant.ctx);
  assert.ok(!had(onAssistant.calls, 'handleGenerate'), 'index must point at a user message');
});

// ── Variants (the 1.5.2 wiring bug class) ───────────────────────────────────────────────────────
test("'setVariant' requires integer index + variant (guards the 1.5.2 label drift)", async () => {
  const ok = makeCtx();
  await route({ type: 'setVariant', index: 3, variant: 1 }, ok.ctx);
  const sv = ok.calls.find((c) => c.name === 'setVariant');
  assert.ok(sv, 'setVariant must be reachable'); assert.deepEqual(sv!.args, [3, 1]);

  const bad = makeCtx();
  await route({ type: 'setVariant', index: 3 }, bad.ctx); // missing variant
  assert.ok(!had(bad.calls, 'setVariant'));
});

test("'deleteVariant' confirms before deleting", async () => {
  const yes = makeCtx({ confirm: true });
  await route({ type: 'deleteVariant', index: 2, variant: 0 }, yes.ctx);
  assert.ok(had(yes.calls, 'confirmDelete'));
  assert.ok(had(yes.calls, 'deleteVariant'));

  const no = makeCtx({ confirm: false });
  await route({ type: 'deleteVariant', index: 2, variant: 0 }, no.ctx);
  assert.ok(!had(no.calls, 'deleteVariant'), 'a declined confirmation does not delete');
});

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────
test("'summarizeUpTo' runs only with auto-summary on and a valid index", async () => {
  const doc = docWith([{ role: 'user', content: 'a' }]);
  doc.params.autoSummary = true;
  const on = makeCtx({ doc });
  await route({ type: 'summarizeUpTo', index: 1 }, on.ctx);
  assert.ok(had(on.calls, 'ensureSummary'));

  const off = makeCtx({ doc: docWith([{ role: 'user', content: 'a' }]) }); // autoSummary defaults off
  await route({ type: 'summarizeUpTo', index: 1 }, off.ctx);
  assert.ok(!had(off.calls, 'ensureSummary'));
});

test("'setSummary' / 'clearSummary' persist and re-push", async () => {
  const setDoc = docWith([{ role: 'user', content: 'a' }]); setDoc.summary = { text: 's', upTo: 1 };
  const s = makeCtx({ doc: setDoc });
  await route({ type: 'setSummary', text: 'new' }, s.ctx);
  assert.ok(had(s.calls, 'writeDoc')); assert.ok(had(s.calls, 'pushDoc'));

  const clrDoc = docWith([{ role: 'user', content: 'a' }]); clrDoc.summary = { text: 's', upTo: 1 };
  const c = makeCtx({ doc: clrDoc });
  await route({ type: 'clearSummary' }, c.ctx);
  assert.ok(had(c.calls, 'writeDoc')); assert.ok(had(c.calls, 'pushDoc'));
});

// ── TTS ─────────────────────────────────────────────────────────────────────────────────────────
test("'tts' routes to the right engine; 'ttsStop' cancels", async () => {
  const cb = makeCtx();
  await route({ type: 'tts', engine: 'chatterbox', text: 'hi', voice: 'v', id: 1 }, cb.ctx);
  assert.ok(had(cb.calls, 'synthChatterbox'));

  const pp = makeCtx();
  await route({ type: 'tts', text: 'hi', voice: 'v', id: 1 }, pp.ctx);
  assert.ok(had(pp.calls, 'synthPiper'));

  const stop = makeCtx();
  await route({ type: 'ttsStop' }, stop.ctx);
  assert.ok(had(stop.calls, 'killPiper'));
  assert.equal(stop.ctx.ttsTokenRef.value, 1, 'the tts token is bumped to cancel the chunk loop');
});

// ── Direct vscode-side effects ──────────────────────────────────────────────────────────────────
test("'copy' writes to the clipboard; 'openSettings' opens settings", async () => {
  const copy = makeCtx();
  await route({ type: 'copy', text: 'hello' }, copy.ctx);
  assert.ok(vscodeCalls.includes('clipboard.writeText'));

  resetVscodeCalls();
  const settings = makeCtx();
  await route({ type: 'openSettings' }, settings.ctx);
  assert.ok(vscodeCalls.includes('commands.executeCommand'));
});

// ── Edit family (delegated to routeEdit) ────────────────────────────────────────────────────────
test('edit-family messages reach routeEdit and persist', async () => {
  const del = makeCtx({ doc: docWith([{ role: 'user', content: 'a' }]) });
  await route({ type: 'deleteMessage', index: 0 }, del.ctx);
  assert.ok(had(del.calls, 'writeDoc') && had(del.calls, 'sendHistory'), 'deleteMessage');

  const from = makeCtx({ doc: docWith([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]) });
  await route({ type: 'deleteFrom', index: 0 }, from.ctx);
  assert.ok(had(from.calls, 'writeDoc') && had(from.calls, 'sendHistory'), 'deleteFrom');

  const merge = makeCtx({ doc: docWith([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]) });
  await route({ type: 'mergeMessage', index: 1 }, merge.ctx);
  assert.ok(had(merge.calls, 'writeDoc') && had(merge.calls, 'sendHistory'), 'mergeMessage');

  const edit = makeCtx({ doc: docWith([{ role: 'user', content: 'a' }]) });
  await route({ type: 'editMessage', index: 0, content: 'b' }, edit.ctx);
  assert.ok(had(edit.calls, 'writeDoc') && had(edit.calls, 'sendHistory'), 'editMessage');

  const one = makeCtx({ doc: docWith([{ role: 'assistant', content: 'hello world' }]) });
  await route({ type: 'replaceOne', index: 0, query: 'world', replacement: 'there', ordinal: 1 }, one.ctx);
  assert.ok(had(one.calls, 'writeDoc') && had(one.calls, 'sendHistory'), 'replaceOne');

  const all = makeCtx({ doc: docWith([{ role: 'assistant', content: 'a a a' }]) });
  await route({ type: 'replaceAll', query: 'a', replacement: 'b' }, all.ctx);
  assert.ok(had(all.calls, 'writeDoc') && had(all.calls, 'sendHistory'), 'replaceAll');
});

// ── System-prompt layers (delegated to routeSysPrompt) ──────────────────────────────────────────
test('system-prompt layer ops (remove/move/toggle) persist and re-push', async () => {
  const layers = () => { const d = defaultDoc(DEFAULTS); d.systemPromptFiles = [{ path: 'a.md' }, { path: 'b.md' }]; return d; };

  const rm = makeCtx({ doc: layers() });
  await route({ type: 'removeSysPrompt', index: 0 }, rm.ctx);
  assert.ok(had(rm.calls, 'writeDoc') && had(rm.calls, 'pushDoc'), 'removeSysPrompt');

  const mv = makeCtx({ doc: layers() });
  await route({ type: 'moveSysPrompt', index: 0, to: 1 }, mv.ctx);
  assert.ok(had(mv.calls, 'writeDoc') && had(mv.calls, 'pushDoc'), 'moveSysPrompt');

  const tg = makeCtx({ doc: layers() });
  await route({ type: 'toggleSysPrompt', index: 0, enabled: false }, tg.ctx);
  assert.ok(had(tg.calls, 'writeDoc') && had(tg.calls, 'pushDoc'), 'toggleSysPrompt');
});

test('refreshSysPrompt re-syncs additively: keeps order + enabled, appends matched, never drops', async () => {
  // Removed 'b' (custom order a, c); glob still matches a, b, c → b is re-appended last.
  const reAdd = makeCtx({
    doc: Object.assign(defaultDoc(DEFAULTS), { systemPromptFiles: [{ path: 'a.md' }, { path: 'c.md' }] }),
    globMatches: ['a.md', 'b.md', 'c.md'],
  });
  await route({ type: 'refreshSysPrompt', glob: 'systems/*.md' }, reAdd.ctx);
  assert.deepEqual(reAdd.ctx.getDoc()!.systemPromptFiles, [{ path: 'a.md' }, { path: 'c.md' }, { path: 'b.md' }]);
  assert.equal(reAdd.ctx.getDoc()!.systemPromptGlob, 'systems/*.md');
  assert.ok(had(reAdd.calls, 'writeDoc') && had(reAdd.calls, 'pushDoc'));

  // Nothing removed (and the pattern still matches the same set) → list and order are untouched.
  const stable = makeCtx({
    doc: Object.assign(defaultDoc(DEFAULTS), { systemPromptFiles: [{ path: 'b.md', enabled: false }, { path: 'a.md' }] }),
    globMatches: ['a.md', 'b.md'],
  });
  await route({ type: 'refreshSysPrompt', glob: '*.md' }, stable.ctx);
  assert.deepEqual(stable.ctx.getDoc()!.systemPromptFiles, [{ path: 'b.md', enabled: false }, { path: 'a.md' }]);

  // A hand-picked layer the pattern does not match is preserved (refresh only appends, never drops).
  const keep = makeCtx({
    doc: Object.assign(defaultDoc(DEFAULTS), { systemPromptFiles: [{ path: 'a.md' }, { path: 'manual.md' }] }),
    globMatches: ['a.md', 'b.md'],
  });
  await route({ type: 'refreshSysPrompt', glob: 'a.md' }, keep.ctx);
  assert.deepEqual(keep.ctx.getDoc()!.systemPromptFiles, [{ path: 'a.md' }, { path: 'manual.md' }, { path: 'b.md' }]);
});

// ── Negative control ────────────────────────────────────────────────────────────────────────────
test('an unknown message type is a silent no-op (no throw, no dispatch)', async () => {
  const { ctx, calls } = makeCtx();
  await route({ type: 'totally-unknown-type' }, ctx);
  assert.equal(calls.length, 0);
});
