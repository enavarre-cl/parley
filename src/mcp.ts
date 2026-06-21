import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { ToolSchema } from './providers';

interface ServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

/** Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0). */
class McpClient {
  private proc?: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  tools: McpTool[] = [];

  constructor(public readonly config: ServerConfig) {}

  async start(): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows: `npx`/`node` and others are `.cmd`/`.bat`; without shell, spawn gives ENOENT.
      // The command comes from the workspace .mcp (already gated by Workspace Trust).
      shell: process.platform === 'win32',
    });
    this.proc.stdout!.on('data', (d) => this.onData(d));
    this.proc.stderr!.on('data', () => {});
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('The MCP server exited'));
      this.pending.clear();
    });
    this.proc.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'parley', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {});
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
        else p.resolve(msg.result);
      }
      // Server-initiated requests/notifications are ignored in this MVP.
    }
  }

  private send(obj: any): void {
    // The process may have died: avoids the TypeError on `stdin!` and degrades cleanly.
    try { this.proc?.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* process dead */ }
  }

  private request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  private notify(method: string, params: any): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async callTool(name: string, args: any): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args ?? {} });
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content
      .map((c: any) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
    return text || '(no output)';
  }

  dispose(): void {
    // Reject pending immediately (don't wait for the 30s timeout) and close the process.
    for (const p of this.pending.values()) { try { p.reject(new Error('MCP closed')); } catch { /* noop */ } }
    this.pending.clear();
    try { this.proc?.stdin?.end(); } catch { /* noop */ }
    try { this.proc?.kill(); } catch { /* noop */ }
    this.proc = undefined;
  }
}

/** Reads MCP server configurations from `.mcp.json` and `.mcp/*.json` in the workspace. */
function loadServerConfigs(): ServerConfig[] {
  const out: ServerConfig[] = [];
  const add = (cfg: any) => {
    if (cfg && typeof cfg.command === 'string') {
      out.push({
        name: typeof cfg.name === 'string' ? cfg.name : cfg.command,
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args : [],
        env: cfg.env && typeof cfg.env === 'object' ? cfg.env : undefined,
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
      });
    }
  };
  const parse = (raw: string) => {
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    // Standard format { mcpServers: { name: cfg } }
    if (json && json.mcpServers && typeof json.mcpServers === 'object') {
      for (const [name, cfg] of Object.entries<any>(json.mcpServers)) add({ name, ...cfg });
    } else if (Array.isArray(json)) {
      json.forEach(add);
    } else {
      add(json); // single server per file
    }
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    try {
      parse(fs.readFileSync(`${root}/.mcp.json`, 'utf8'));
    } catch {
      /* does not exist */
    }
    try {
      for (const entry of fs.readdirSync(`${root}/.mcp`)) {
        if (entry.endsWith('.json')) {
          try {
            parse(fs.readFileSync(`${root}/.mcp/${entry}`, 'utf8'));
          } catch {
            /* invalid file */
          }
        }
      }
    } catch {
      /* no .mcp folder */
    }
  }
  return out;
}

/** Manages MCP servers and aggregates their tools (prefixed by server: `server__tool`). */
export class McpManager {
  private clients: McpClient[] = [];
  private startPromise?: Promise<void>;
  errors: string[] = [];

  /** Starts the servers once (idempotent). */
  ensureStarted(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = (async () => {
        // Security: do not start MCP servers (spawning commands from the repo's .mcp) in
        // an untrusted workspace — that would be RCE when opening a malicious repo.
        if (!vscode.workspace.isTrusted) {
          this.errors.push('MCP disabled: the workspace is not trusted (Workspace Trust).');
          return;
        }
        for (const cfg of loadServerConfigs()) {
          const client = new McpClient(cfg);
          try {
            await client.start();
            this.clients.push(client);
          } catch (e: any) {
            this.errors.push(`${cfg.name}: ${e?.message ?? e}`);
          }
        }
      })();
    }
    return this.startPromise;
  }

  toolSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const c of this.clients) {
      for (const t of c.tools) {
        out.push({
          name: `${c.config.name}__${t.name}`,
          description: t.description,
          parameters: t.inputSchema ?? { type: 'object', properties: {} },
        });
      }
    }
    return out;
  }

  async call(fullName: string, args: any): Promise<string> {
    const sep = fullName.indexOf('__');
    const server = sep >= 0 ? fullName.slice(0, sep) : '';
    const tool = sep >= 0 ? fullName.slice(sep + 2) : fullName;
    const client = this.clients.find((c) => c.config.name === server);
    if (!client) throw new Error(`MCP server not found: ${server}`);
    return client.callTool(tool, args);
  }

  dispose(): void {
    this.clients.forEach((c) => c.dispose());
    this.clients = [];
    this.startPromise = undefined;
  }
}
