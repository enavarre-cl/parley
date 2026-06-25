import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { ToolSchema } from './providers';
import { killProcessTree } from './procKill';
import { errMsg } from './chatHelpers';

/** Cap on the stdio line buffer: a server emitting an unbounded line would otherwise OOM. */
const MAX_MCP_BUFFER = 8 * 1024 * 1024;

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
  inputSchema?: Record<string, unknown>;
}

/** A JSON-RPC 2.0 request/notification we write to the server's stdin. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params: Record<string, unknown>;
}

/** A JSON-RPC 2.0 response line as parsed off the server's stdout. */
interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/** Result of the MCP `tools/list` call. */
interface ToolsListResult { tools?: McpTool[] }
/** A single content block of a `tools/call` result. */
interface McpContentBlock { type?: string; text?: string }
/** Result of the MCP `tools/call` call. */
interface ToolCallResult { content?: McpContentBlock[]; isError?: boolean }

/** Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0). */
class McpClient {
  private proc?: ChildProcess;
  private buffer = '';
  private nextId = 1;
  private alive = false;          // false once the process has exited/errored → fail new calls fast
  private lastStderr = '';        // tail of the server's stderr, surfaced in error messages
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
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
    this.alive = true;
    this.proc.stdout!.on('data', (d) => this.onData(d));
    // Keep the tail of stderr instead of discarding it: it's the only diagnostic when a server fails.
    this.proc.stderr!.on('data', (d) => { this.lastStderr = (this.lastStderr + d.toString('utf8')).slice(-2000); });
    this.proc.on('exit', () => {
      this.alive = false;
      const detail = this.lastStderr.trim() ? `: ${this.lastStderr.trim().split('\n').slice(-3).join(' ')}` : '';
      for (const p of this.pending.values()) p.reject(new Error('The MCP server exited' + detail));
      this.pending.clear();
    });
    this.proc.on('error', (e) => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'jotflow', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
    const list = await this.request<ToolsListResult>('tools/list', {});
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString('utf8');
    if (this.buffer.length > MAX_MCP_BUFFER) this.buffer = this.buffer.slice(-MAX_MCP_BUFFER); // bound memory
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
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

  private send(obj: JsonRpcRequest): void {
    // The process may have died: avoids the TypeError on `stdin!` and degrades cleanly.
    try { this.proc?.stdin?.write(JSON.stringify(obj) + '\n'); } catch { /* process dead */ }
  }

  /**
   * Sends a JSON-RPC request and resolves with its `result`, typed as `T` by the caller (the result
   * shape is method-specific — `tools/list` → ToolsListResult, `tools/call` → ToolCallResult, …).
   * The pending-call map below is the heterogeneous plumbing that routes each reply back, so it holds
   * the value as `unknown` until this typed boundary casts it to `T`.
   */
  private request<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    // The server already died: fail immediately instead of waiting out the 30s timeout.
    if (!this.alive) return Promise.reject(new Error('The MCP server is not running.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: (v: unknown) => void, v: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        fn(v);
      };
      const settle = resolve as (v: unknown) => void;
      const onAbort = () => finish(reject, new Error('Stopped.'));
      const timer = setTimeout(() => finish(reject, new Error(`MCP timeout: ${method}`)), 30000);
      // The pending map routes the server's reply (onData) through finish so the timer/listener clear.
      this.pending.set(id, { resolve: (v) => finish(settle, v), reject: (e) => finish(reject, e) });
      this.send({ jsonrpc: '2.0', id, method, params });
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const res = await this.request<ToolCallResult>('tools/call', { name, arguments: args ?? {} }, signal);
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content
      .map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n') || '(no output)';
    // Honour the MCP `isError` flag so the model can tell a tool failure from normal output.
    return res?.isError ? `Error: ${text}` : text;
  }

  dispose(): void {
    // Reject pending immediately (don't wait for the 30s timeout) and close the process.
    this.alive = false;
    for (const p of this.pending.values()) { try { p.reject(new Error('MCP closed')); } catch { /* noop */ } }
    this.pending.clear();
    try { this.proc?.stdin?.end(); } catch { /* noop */ }
    // Tree-kill: with shell:true on Windows, proc.kill() would only kill the shell, orphaning the
    // real server (node/npx). Also escalates to SIGKILL on POSIX.
    killProcessTree(this.proc);
    this.proc = undefined;
  }
}

/** A server entry as it appears in a `.mcp.json` file, before validation (every field unverified). */
interface RawConfig {
  name?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
}

/** Reads MCP server configurations from `.mcp.json` and `.mcp/*.json` in the workspace. */
function loadServerConfigs(): ServerConfig[] {
  const out: ServerConfig[] = [];
  const add = (cfg: RawConfig | null) => {
    if (cfg && typeof cfg.command === 'string') {
      out.push({
        name: typeof cfg.name === 'string' ? cfg.name : cfg.command,
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [],
        env: cfg.env && typeof cfg.env === 'object' ? cfg.env as Record<string, string> : undefined,
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
      });
    }
  };
  const parse = (raw: string) => {
    // JSON.parse of an arbitrary external file: the one place `unknown` is the correct typed
    // boundary — the shape is genuinely not known until each branch below narrows it.
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    // Standard format { mcpServers: { name: cfg } }
    if (json && typeof json === 'object' && 'mcpServers' in json) {
      const servers = (json as { mcpServers?: Record<string, RawConfig> }).mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, cfg] of Object.entries(servers)) add({ ...cfg, name });
      }
    } else if (Array.isArray(json)) {
      json.forEach((c) => add(c as RawConfig));
    } else if (json && typeof json === 'object') {
      add(json as RawConfig); // single server per file
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
          } catch (e) {
            this.errors.push(`${cfg.name}: ${errMsg(e)}`);
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

  async call(fullName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const sep = fullName.indexOf('__');
    const server = sep >= 0 ? fullName.slice(0, sep) : '';
    const tool = sep >= 0 ? fullName.slice(sep + 2) : fullName;
    const client = this.clients.find((c) => c.config.name === server);
    if (!client) throw new Error(`MCP server not found: ${server}`);
    return client.callTool(tool, args, signal);
  }

  dispose(): void {
    this.clients.forEach((c) => c.dispose());
    this.clients = [];
    this.startPromise = undefined;
  }
}
