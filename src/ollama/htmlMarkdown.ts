/**
 * Minimal HTML→Markdown converter for scraped model-card README content.
 *
 * Not a full DOM parser — it handles the elements an Ollama rendered README uses (headings, lists,
 * tables, code, links, emphasis) so the webview's Markdown renderer shows real structure (a
 * benchmarks table, bullet lists, headings) instead of one flattened paragraph. Pure and unit-tested.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ',
};

/** Decodes the handful of HTML entities that appear in scraped text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

/** Applies a removal regex repeatedly until the string stops changing — defeats split/nested tags
 *  (e.g. `<scr<script>ipt>`) that a single pass would leave behind (CodeQL js/incomplete-sanitization). */
function stripUntilStable(html: string, re: RegExp): string {
  let prev: string;
  do { prev = html; html = html.replace(re, ''); } while (html !== prev);
  return html;
}

/** Strips all tags from a fragment and collapses whitespace — for table cells and inline targets. */
function stripTags(html: string): string {
  return decodeEntities(stripUntilStable(html, /<[^>]*>/g)).replace(/\s+/g, ' ').trim();
}

/** Converts inline elements (links, emphasis, code, images) and drops any remaining tags. */
function inline(html: string): string {
  const converted = html
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `[${stripTags(t)}](${href})`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _g, t) => `**${stripTags(t)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _g, t) => `*${stripTags(t)}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${stripTags(t)}\``)
    .replace(/<img\b[^>]*>/gi, '');             // drop images (logos) — no broken markdown
  return stripUntilStable(converted, /<[^>]+>/g).replace(/[ \t]{2,}/g, ' '); // strip leftover tags
}

/** Converts a `<table>` body into a GitHub-flavoured Markdown table (the renderer supports them). */
function tableToMarkdown(body: string): string {
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((r) => [...r[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((c) => inline(c[1]).trim() || ' '))
    .filter((cells) => cells.length > 0);
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => [...r, ...Array(cols - r.length).fill(' ')];
  const lines = [pad(rows[0]), Array(cols).fill('---'), ...rows.slice(1).map(pad)]
    .map((r) => `| ${r.join(' | ')} |`);
  return `\n\n${lines.join('\n')}\n\n`;
}

/** Converts a scraped HTML fragment to Markdown (block + inline elements; tables preserved). */
export function htmlToMarkdown(fragment: string): string {
  let s = stripUntilStable(fragment, /<(script|style)\b[\s\S]*?<\/\1>/gi);
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, b) => tableToMarkdown(b));
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => `\n\n\`\`\`\n${stripTags(t)}\n\`\`\`\n\n`);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${inline(t).trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${inline(t).trim()}`);
  s = s.replace(/<\/(ul|ol)>/gi, '\n\n');
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => `\n\n> ${inline(t).trim()}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `\n\n${inline(t).trim()}\n\n`);
  s = inline(s); // remaining inline tags + strip leftover block tags
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
