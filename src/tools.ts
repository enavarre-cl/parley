import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';
import { McpManager } from './mcp';
import { ToolSchema } from './providers';
import { ipIsPrivate } from './net';
import { httpFetch } from './http';

/** Rechaza un host que resuelva a una IP interna/privada (anti-SSRF). Comprueba TODAS sus IPs. */
async function assertSafeHost(hostname: string): Promise<void> {
  let addrs: { address: string }[];
  try { addrs = await dns.promises.lookup(hostname, { all: true }); }
  catch { throw new Error('No se pudo resolver el host.'); }
  for (const a of addrs) if (ipIsPrivate(a.address)) throw new Error('Host interno/privado bloqueado (SSRF).');
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No hay ninguna carpeta de workspace abierta.');
  return root;
}

/** Comprueba que la ruta REAL (resuelta vía realpath) queda dentro del root real. Evita escapes por symlink. */
function assertRealWithin(abs: string, root: string): void {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = root; }
  // Resuelve el ancestro existente más profundo (la ruta puede no existir aún, p. ej. fs_write).
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  let realProbe: string;
  try { realProbe = fs.realpathSync(probe); } catch { realProbe = probe; }
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw new Error('Ruta fuera del workspace (symlink).');
  }
}

/**
 * Resuelve una ruta dentro de ALGUNA carpeta del workspace (multi-root): prueba cada carpeta y
 * usa aquella donde la ruta resuelta exista; si en ninguna existe, la primera carpeta válida
 * (p. ej. para fs_write). Nunca escapa de las carpetas (ni por `..` ni por symlink).
 */
function resolveInWorkspace(p: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) throw new Error('No hay ninguna carpeta de workspace abierta.');
  let chosen: { abs: string; root: string } | null = null;
  for (const f of folders) {
    const root = f.uri.fsPath;
    const abs = path.resolve(root, p || '.');
    if (abs !== root && !abs.startsWith(root + path.sep)) continue; // fuera de ESTA carpeta
    if (!chosen) chosen = { abs, root };          // primer candidato válido
    if (fs.existsSync(abs)) { chosen = { abs, root }; break; } // prioriza donde exista
  }
  if (!chosen) throw new Error(`Ruta fuera del workspace: ${p}`);
  assertRealWithin(chosen.abs, chosen.root); // nada de symlinks que escapen
  return chosen.abs;
}

/** Rutas a las que NO se permite escribir (ejecución / config sensible). */
function assertWritable(abs: string, root: string): void {
  const rel = path.relative(root, abs).split(path.sep);
  const top = rel[0];
  if (top === '.git' || top === '.vscode') {
    throw new Error(`Escritura no permitida en ${top}/ (ruta sensible).`);
  }
}

const EXCLUDE = '**/{node_modules,.git,out,dist,build,.vscode-test,.next,coverage}/**';

/** Convierte HTML a texto legible (quita scripts/estilos/tags y decodifica entidades básicas). */
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

/** Límite de lectura de fs_read (ajuste global, con fallback robusto si está roto). */
function maxReadBytes(): number {
  const v = vscode.workspace.getConfiguration('langChat').get<number>('tools.maxReadBytes', DEFAULT_MAX_READ);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_READ;
}

/** Tools nativas de filesystem del workspace (prefijo fs_). */
const BUILTIN: { schema: ToolSchema; run: (args: any) => Promise<string> }[] = [
  {
    schema: {
      name: 'fs_list',
      description: 'Lista archivos y carpetas de una ruta del workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta relativa (vacío = raíz)' } } },
    },
    run: async (a) => {
      const dir = resolveInWorkspace(a?.path ?? '.');
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)).join('\n') || '(vacío)';
    },
  },
  {
    schema: {
      name: 'fs_read',
      description: 'Lee el contenido de un archivo de texto del workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async (a) => {
      const file = resolveInWorkspace(a?.path ?? '');
      const limit = maxReadBytes();
      const size = fs.statSync(file).size;
      // Lee como mucho `limit` bytes: nunca carga un archivo gigante entero en memoria.
      const toRead = Math.min(size, limit);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, 0);
        const text = buf.toString('utf8');
        return size > limit ? text + `\n… (truncado, ${size} bytes)` : text;
      } finally {
        fs.closeSync(fd);
      }
    },
  },
  {
    schema: {
      name: 'fs_write',
      description: 'Escribe (crea o sobrescribe) un archivo de texto en el workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    run: async (a) => {
      if (!vscode.workspace.isTrusted) throw new Error('Escritura deshabilitada: el workspace no es de confianza.');
      const file = resolveInWorkspace(a?.path ?? '');
      assertWritable(file, workspaceRoot()); // no .git/ ni .vscode/
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(a?.content ?? ''), 'utf8');
      return `Escrito: ${a.path} (${Buffer.byteLength(String(a?.content ?? ''))} bytes)`;
    },
  },
  {
    schema: {
      name: 'get_datetime',
      description: 'Fecha y hora actuales del sistema (con zona horaria).',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return `ISO: ${now.toISOString()}\nLocal: ${now.toString()}\nZona horaria: ${tz}`;
    },
  },
  {
    schema: {
      name: 'fs_glob',
      description: 'Lista archivos del workspace que coinciden con un patrón glob (p. ej. **/*.ts).',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'Patrón glob' } },
        required: ['pattern'],
      },
    },
    run: async (a) => {
      const root = workspaceRoot();
      const uris = await vscode.workspace.findFiles(a?.pattern || '**/*', EXCLUDE, 500);
      const list = uris.map((u) => path.relative(root, u.fsPath)).sort();
      return list.length ? list.join('\n') : 'Sin archivos.';
    },
  },
  {
    schema: {
      name: 'fs_search',
      description: 'Busca texto (o regex) en los archivos del workspace. Devuelve coincidencias como ruta:línea.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Texto o expresión regular a buscar' },
          glob: { type: 'string', description: 'Patrón de archivos a incluir (por defecto **/*)' },
          regex: { type: 'boolean', description: 'Tratar query como regex' },
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
        try { re = new RegExp(a.query, 'i'); } catch (e: any) { return 'Regex inválida: ' + e.message; }
      }
      const needle = String(a?.query ?? '').toLowerCase();
      const matches: string[] = [];
      for (const uri of uris) {
        if (matches.length >= max) break;
        try { if (fs.statSync(uri.fsPath).size > 2_000_000) continue; } catch { continue; } // omite enormes sin leerlos
        let buf: Buffer;
        try { buf = fs.readFileSync(uri.fsPath); } catch { continue; }
        if (buf.includes(0)) continue; // omite binarios
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(needle);
          if (hit) {
            matches.push(`${path.relative(root, uri.fsPath)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (matches.length >= max) break;
          }
        }
      }
      return matches.length ? matches.join('\n') : 'Sin coincidencias.';
    },
  },
  {
    schema: {
      name: 'web_fetch',
      description: 'Descarga una URL (http/https) y devuelve su contenido como texto. Útil para leer webs, RSS o APIs.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          raw: { type: 'boolean', description: 'Devolver el cuerpo sin limpiar el HTML' },
        },
        required: ['url'],
      },
    },
    run: async (a) => {
      let url = String(a?.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('Solo se permiten URLs http/https.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        // Sigue redirects a mano validando el host de CADA salto (evita bypass público→interno).
        let res: Response | null = null;
        for (let hop = 0; hop < 6; hop++) {
          const u = new URL(url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Solo se permiten URLs http/https.');
          await assertSafeHost(u.hostname);
          res = await httpFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (LangChat)', Accept: '*/*' },
            signal: controller.signal,
            redirect: 'manual',
          });
          const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
          if (!loc) break;
          url = new URL(loc, url).toString(); // valida el siguiente salto en la próxima vuelta
        }
        if (!res) throw new Error('Sin respuesta.');
        if (!res.ok) return `Error HTTP ${res.status} ${res.statusText} al obtener ${url}`;
        const ctype = res.headers.get('content-type') || '';
        let text = await res.text();
        if (!a?.raw && /html/i.test(ctype)) text = htmlToText(text);
        const limit = maxReadBytes();
        if (text.length > limit) text = text.slice(0, limit) + `\n… (truncado, ${text.length} caracteres)`;
        return text || '(vacío)';
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    schema: {
      name: 'editor_context',
      description: 'Archivo activo en el editor y la selección actual del usuario.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const rel = (uri: vscode.Uri) =>
        uri.scheme === 'file' ? path.relative(root, uri.fsPath) : uri.toString();

      // Pestañas abiertas (incluye archivos aunque el foco esté en el chat).
      const tabs: string[] = [];
      for (const g of vscode.window.tabGroups.all) {
        for (const t of g.tabs) {
          const uri = (t.input as any)?.uri as vscode.Uri | undefined;
          if (uri) tabs.push(rel(uri) + (t.isActive ? ' (pestaña activa)' : ''));
        }
      }

      const ed = vscode.window.activeTextEditor;
      let out = '';
      if (ed) {
        const sel = ed.selection;
        const selText = ed.document.getText(sel);
        out += `Archivo de texto activo: ${rel(ed.document.uri)}\nLenguaje: ${ed.document.languageId}\nLíneas: ${ed.document.lineCount}`;
        out += selText
          ? `\nSelección (líneas ${sel.start.line + 1}-${sel.end.line + 1}):\n${selText.slice(0, 4000)}`
          : '\n(sin selección)';
      } else {
        out += 'No hay ningún editor de texto enfocado (puede que el foco esté en el chat u otra vista).';
      }
      if (tabs.length) out += `\n\nPestañas abiertas:\n${tabs.join('\n')}`;
      return out;
    },
  },
];

/** Agrega las tools nativas (filesystem) y las de los servidores MCP, y enruta su ejecución. */
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
    // Las tools MCP llevan separador `server__tool`. Sin él (p. ej. el modelo inventa `fs_//read`),
    // damos un error CLARO con las tools disponibles para que el modelo se autocorrija (no un
    // "servidor MCP vacío" inútil que además puede romper el siguiente turno).
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
