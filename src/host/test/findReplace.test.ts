import { test } from 'node:test';
import assert from 'node:assert';
import { buildFindRegex, applyCase, expandRefs, replaceInString } from '../findReplace';

test('buildFindRegex: literal escaping, case, whole-word, invalid regex', () => {
  // Plain query is escaped (dots are literal), case-insensitive by default.
  const r1 = buildFindRegex('a.b', {})!;
  assert.equal('axb'.match(r1), null);
  assert.ok('a.b'.match(r1));
  assert.ok('A.B'.match(buildFindRegex('a.b', {})!)); // case-insensitive
  assert.equal('A.B'.match(buildFindRegex('a.b', { matchCase: true })!), null);
  // Whole word.
  assert.equal(buildFindRegex('cat', { wholeWord: true })!.test('concatenate'), false);
  assert.equal(buildFindRegex('cat', { wholeWord: true })!.test('a cat sat'), true);
  // Invalid regex returns null; empty returns null.
  assert.equal(buildFindRegex('(', { regex: true }), null);
  assert.equal(buildFindRegex('', {}), null);
});

test('applyCase mirrors UPPER and Capitalized, leaves the rest', () => {
  assert.equal(applyCase('FOO', 'bar'), 'BAR');
  assert.equal(applyCase('Foo', 'bar'), 'Bar');
  assert.equal(applyCase('foo', 'bar'), 'bar');
  assert.equal(applyCase('fOo', 'bar'), 'bar'); // mixed → unchanged
});

test('expandRefs expands $&, $1 and $$', () => {
  const m = /(\d+)-(\d+)/.exec('12-34') as RegExpExecArray;
  assert.equal(expandRefs('$1/$2 ($&) $$', m), '12/34 (12-34) $');
});

test('replaceInString: replace-all vs nth, count', () => {
  assert.deepEqual(replaceInString('a a a', 'a', 'b', 0, {}), { content: 'b b b', count: 3 });
  assert.deepEqual(replaceInString('a a a', 'a', 'b', 2, {}), { content: 'a b a', count: 1 });
  assert.deepEqual(replaceInString('hello', 'x', 'y', 0, {}), { content: 'hello', count: 0 });
});

test('replaceInString: spaces are searchable (no trim) and self-containing replacement is safe', () => {
  assert.deepEqual(replaceInString('a a a', ' ', '_', 0, {}), { content: 'a_a_a', count: 2 });
  // "approx" → "approximately" left-to-right, each original match replaced once (no runaway).
  assert.deepEqual(
    replaceInString('approx and approx', 'approx', 'approximately', 0, {}),
    { content: 'approximately and approximately', count: 2 },
  );
});

test('replaceInString: regex groups + preserveCase', () => {
  assert.deepEqual(
    replaceInString('2026-06-22', '(\\d{4})-(\\d{2})', '$2/$1', 0, { regex: true }),
    { content: '06/2026-22', count: 1 },
  );
  assert.deepEqual(
    replaceInString('FOO foo Foo', 'foo', 'bar', 0, { preserveCase: true }),
    { content: 'BAR bar Bar', count: 3 },
  );
});

test('replaceInString: skips matches inside Markdown link URLs (B4)', () => {
  // "example" appears in the label, the URL and prose. The webview only highlights the visible ones
  // (label + prose), so nth must count those — not the URL occurrence.
  const src = 'See [example](http://example.com) for the example.';
  assert.deepEqual(
    replaceInString(src, 'example', 'sample', 2, {}),
    { content: 'See [example](http://example.com) for the sample.', count: 1 },
  );
  // replace-all also leaves the URL untouched (count = visible matches only).
  assert.deepEqual(
    replaceInString(src, 'example', 'X', 0, {}),
    { content: 'See [X](http://example.com) for the X.', count: 2 },
  );
});
