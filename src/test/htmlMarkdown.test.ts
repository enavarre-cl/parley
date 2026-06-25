import { test } from 'node:test';
import assert from 'node:assert';
import { decodeEntities, htmlToMarkdown } from '../ollama/htmlMarkdown';

test('decodeEntities decodes the common HTML entities', () => {
  assert.strictEqual(decodeEntities('Alibaba&#39;s a &amp; b &lt;c&gt; &nbsp;x'), "Alibaba's a & b <c>  x");
});

test('htmlToMarkdown converts headings, emphasis, links, code and lists', () => {
  const md = htmlToMarkdown(
    '<h2>Key Features</h2>' +
    '<p>Built on <strong>K2.6</strong> — see <a href="https://hf.co/x">HF</a>.</p>' +
    '<ul><li>Long-horizon coding</li><li>Run <code>ollama run x</code></li></ul>',
  );
  assert.match(md, /## Key Features/);
  assert.match(md, /\*\*K2\.6\*\*/);
  assert.match(md, /\[HF\]\(https:\/\/hf\.co\/x\)/);
  assert.match(md, /- Long-horizon coding/);
  assert.match(md, /- Run `ollama run x`/);
  assert.doesNotMatch(md, /<[a-z]/i); // no raw tags
});

test('htmlToMarkdown renders a <table> as a GitHub-flavoured Markdown table', () => {
  const md = htmlToMarkdown(
    '<table><thead><tr><th>Benchmark</th><th>K2.6</th><th>K2.7</th></tr></thead>' +
    '<tbody><tr><td>Kimi Code</td><td>50.9</td><td>62.0</td></tr></tbody></table>',
  );
  assert.match(md, /\| Benchmark \| K2\.6 \| K2\.7 \|/);
  assert.match(md, /\| --- \| --- \| --- \|/);
  assert.match(md, /\| Kimi Code \| 50\.9 \| 62\.0 \|/);
});

test('htmlToMarkdown drops script/style and images', () => {
  const md = htmlToMarkdown('<style>.x{}</style><p>Hi</p><img src="logo.png" alt="logo"><script>bad()</script>');
  assert.strictEqual(md, 'Hi');
});

test('htmlToMarkdown removes split/nested tags a single pass would reassemble', () => {
  const md = htmlToMarkdown('<p>ok</p><scr<script>ipt>alert(1)</scr<script>ipt>');
  assert.match(md, /ok/);
  assert.doesNotMatch(md, /<script/i); // iterative strip leaves no reconstructable tag
});
