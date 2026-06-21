import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';
import { McpManager } from './mcp';
import { ToolSchema } from './providers';
import { ipIsPrivate } from './net';
import { httpFetch } from './http';

/** Rejects a host that resolves to an internal/private IP (anti-SSRF). Checks ALL its IPs. */
async function assertSafeHost(hostname: string): Promise<void> {
  let addrs: { address: string }[];
  try { addrs = await dns.promises.lookup(hostname, { all: true }); }
  catch { throw new Error('Could not resolve host.'); }
  for (const a of addrs) if (ipIsPrivate(a.address)) throw new Error('Internal/private host blocked (SSRF).');
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder is open.');
  return root;
}

/** Checks that the REAL path (resolved via realpath) stays inside the real root. Prevents symlink escapes. */
function assertRealWithin(abs: string, root: string): void {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = root; }
  // Resolves the deepest existing ancestor (the path may not exist yet, e.g. fs_write).
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  let realProbe: string;
  try { realProbe = fs.realpathSync(probe); } catch { realProbe = probe; }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw new Error('Path outside the workspace (symlink).');
  }
}

/**
 * Resolves a path within ANY workspace folder (multi-root): tries each folder and uses the one
 * where the resolved path exists; if none exists, uses the first valid folder (e.g. for fs_write).
 * Never escapes the folders (neither via `..` nor symlink).
 */
function resolveInWorkspace(p: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) throw new Error('No workspace folder is open.');
  let chosen: { abs: string; root: string } | null = null;
  for (const f of folders) {
    const root = f.uri.fsPath;
    const abs = path.resolve(root, p || '.');
    if (abs !== root && !abs.startsWith(root + path.sep)) continue; // outside THIS folder
    if (!chosen) chosen = { abs, root };          // first valid candidate
    if (fs.existsSync(abs)) { chosen = { abs, root }; break; } // prefer where it exists
  }
  if (!chosen) throw new Error(`Path outside the workspace: ${p}`);
  assertRealWithin(chosen.abs, chosen.root); // no symlinks escaping
  return chosen.abs;
}

/** Paths that are NOT allowed to be written to (execution / sensitive config). */
function assertWritable(abs: string, root: string): void {
  const rel = path.relative(root, abs).split(path.sep);
  const top = rel[0];
  if (top === '.git' || top === '.vscode') {
    throw new Error(`Writing not allowed in ${top}/ (sensitive path).`);
  }
}

const EXCLUDE = '**/{node_modules,.git,out,dist,build,.vscode-test,.next,coverage}/**';

/** Converts HTML to readable text (strips scripts/styles/tags and decodes basic entities). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr|article|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

const DEFAULT_MAX_READ = 100_000; // bytes

/** Read limit for fs_read (global setting, with a robust fallback if broken). */
function maxReadBytes(): number {
  const v = vscode.workspace.getConfiguration('parley').get<number>('tools.maxReadBytes', DEFAULT_MAX_READ);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_READ;
}

/** Native workspace filesystem tools (fs_ prefix). */
const BUILTIN: { schema: ToolSchema; run: (args: any) => Promise<string> }[] = [
  {
    schema: {
      name: 'fs_list',
      description: 'Lists files and folders at a workspace path.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative path (empty = root)' } } },
    },
    run: async (a) => {
      const dir = resolveInWorkspace(a?.path ?? '.');
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)).join('\n') || '(empty)';
    },
  },
  {
    schema: {
      name: 'fs_read',
      description: 'Reads the contents of a text file in the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async (a) => {
      const file = resolveInWorkspace(a?.path ?? '');
      const limit = maxReadBytes();
      const size = fs.statSync(file).size;
      // Read at most `limit` bytes: never loads a giant file entirely into memory.
      const toRead = Math.min(size, limit);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, 0);
        const text = buf.toString('utf8');
        return size > limit ? text + `\n… (truncated, ${size} bytes)` : text;
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  {
    schema: {
      name: 'fs_write',
      description: 'Writes (creates or overwrites) a text file in the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    run: async (a) => {
      if (!vscode.workspace.isTrusted) throw new Error('Writing disabled: the workspace is not trusted.');
      const file = resolveInWorkspace(a?.path ?? '');
      assertWritable(file, workspaceRoot()); // no .git/ or .vscode/
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(a?.content ?? ''), 'utf8');
      return `Written: ${a.path} (${Buffer.byteLength(String(a?.content ?? ''))} bytes)`;
    },
  },
  {
    schema: {
      name: 'get_datetime',
      description: 'Current system date and time (with timezone).',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return `ISO: ${now.toISOString()}\nLocal: ${now.toString()}\nTimezone: ${tz}`;
    },
  },
  {
    schema: {
      name: 'fs_glob',
      description: 'Lists workspace files matching a glob pattern (e.g. **/*.ts).',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'Glob pattern' } },
        required: ['pattern'],
      },
    },
    run: async (a) => {
      const root = workspaceRoot();
      const uris = await vscode.workspace.findFiles(a?.pattern || '**/*', EXCLUDE, 500);
      const list = uris.map((u) => path.relative(root, u.fsPath)).sort();
      return list.length ? list.join('\n') : 'No files.';
    },
  },
  {
    schema: {
      name: 'fs_search',
      description: 'Searches text (or regex) in workspace files. Returns matches as path:line.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regular expression to search' },
          glob: { type: 'string', description: 'File pattern to include (default **/*)' },
          regex: { type: 'boolean', description: 'Treat query as regex' },
          maxResults: { type: 'number' },
        },
        required: ['query'],
      },
    },
    run: async (a) => {
      const root = workspaceRoot();
      const max = Math.min(Math.max(1, a?.maxResults || 100), 500);
      const uris = await vscode.workspace.findFiles(a?.glob || '**/*', EXCLUDE, 3000);
      let re: RegExp | null = null;
      if (a?.regex) {
        try { re = new RegExp(a.query, 'i'); } catch (e: any) { return 'Invalid regex: ' + e.message; }
      }
      const needle = String(a?.query ?? '').toLowerCase();
      const matches: string[] = [];
      for (const uri of uris) {
        if (matches.length >= max) break;
        try { if (fs.statSync(uri.fsPath).size > 2_000_000) continue; } catch { continue; } // skip huge files without reading them
        let buf: Buffer;
        try { buf = fs.readFileSync(uri.fsPath); } catch { continue; }
        if (buf.includes(0)) continue; // skip binaries
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
          if (hit) {
            matches.push(`${path.relative(root, uri.fsPath)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (matches.length >= max) break;
          }
        }
      }
      return matches.length ? matches.join('\n') : 'No matches.';
    },
  },
  {
    schema: {
      name: 'web_fetch',
      description: 'Downloads a URL (http/https) and returns its content as text. Useful for reading websites, RSS, or APIs.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          raw: { type: 'boolean', description: 'Return the body without cleaning the HTML' },
        },
        required: ['url'],
      },
    },
    run: async (a) => {
      let url = String(a?.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http/https URLs are allowed.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        // Follows redirects manually, validating the host at EACH hop (prevents public→internal bypass).
        let res: Response | null = null;
        for (let hop = 0; hop < 6; hop++) {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http/https URLs are allowed.');
          await assertSafeHost(u.hostname);
          res = await httpFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Parley)', Accept: '*/*' },
            signal: controller.signal,
            redirect: 'manual',
          });
          const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
          if (!loc) break;
          url = new URL(loc, url).toString(); // validates the next hop on the next iteration
        }
        if (!res) throw new Error('No response.');
        if (!res.ok) return `HTTP error ${res.status} ${res.statusText} fetching ${url}`;
        const ctype = res.headers.get('content-type') || '';
        let text = await res.text();
        if (!a?.raw && /html/i.test(ctype)) text = htmlToText(text);
        const limit = maxReadBytes();
        if (text.length > limit) text = text.slice(0, limit) + `\n… (truncated, ${text.length} characters)`;
        return text || '(empty)';
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    schema: {
      name: 'editor_context',
      description: 'Active file in the editor and the current user selection.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const rel = (uri: vscode.Uri) =>
        uri.scheme === 'file' ? path.relative(root, uri.fsPath) : uri.toString();

      // Open tabs (includes files even if focus is in the chat).
      const tabs: string[] = [];
      for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
          const uri = (t.input as any)?.uri as vscode.Uri | undefined;
          if (uri) tabs.push(rel(uri) + (t.isActive ? ' (active tab)' : ''));
        }
      }

      const ed = vscode.window.activeTextEditor;
      let out = '';
      if (ed) {
        const sel = ed.selection;
        const selText = ed.document.getText(sel);
        out += `Active text file: ${rel(ed.document.uri)}\nLanguage: ${ed.document.languageId}\nLines: ${ed.document.lineCount}`;
        out += selText
          ? `\nSelection (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n${selText.slice(0, 4000)}`
          : '\n(no selection)';
      } else {
        out += 'No text editor is focused (focus may be in the chat or another view).';
      }
      if (tabs.length) out += `\n\nOpen tabs:\n${tabs.join('\n')}`;
      return out;
    },
  },
];

/** Aggregates native (filesystem) tools and MCP server tools, and routes their execution. */
export class ToolHub {
  readonly mcp = new McpManager();

  async ensureStarted(): Promise<void> {
    await this.mcp.ensureStarted();
  }

  schemas(): ToolSchema[] {
    return [...BUILTIN.map((b) => b.schema), ...this.mcp.toolSchemas()];
  }

  async call(name: string, args: any): Promise<string> {
    const builtin = BUILTIN.find((b) => b.schema.name === name);
    if (builtin) return builtin.run(args);
    // MCP tools use the `server__tool` separator. Without it (e.g. the model invents `fs_//read`),
    // we give a CLEAR error with the available tools so the model can self-correct (not a useless
    // "empty MCP server" that could also break the next turn).
    if (!name.includes('__')) {
      const avail = this.schemas().map((s) => s.name).join(', ');
      throw new Error(`Unknown tool "${name}". Available tools: ${avail}`);
    }
    return this.mcp.call(name, args);
  }

  mcpErrors(): string[] {
    return this.mcp.errors;
  }

  dispose(): void {
    this.mcp.dispose();
  }
}
