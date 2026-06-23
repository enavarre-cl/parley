import * as vscode from 'vscode';
import * as dns from 'dns';
import type { Dispatcher } from 'undici';
import { ipIsPrivate } from './net';

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

// `fetch` that respects the configured proxy. Defaults to the global `fetch` (no changes in the
// common case, without proxy). If a proxy is set, routes through undici with a ProxyAgent —
// Node's global fetch does NOT respect proxies or VS Code's `http.proxy`, hence this wrapper.
let _fetch: typeof globalThis.fetch = globalThis.fetch;

/** Resolves the proxy from `http.proxy` (VS Code) or standard environment variables. */
function resolveProxy(): string {
  const cfg = vscode.workspace.getConfiguration('http').get<string>('proxy') || '';
  return (
    cfg ||
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    ''
  );
}

/** Configures the proxy once on activation. Idempotent; re-callable if the config changes. */
export function initProxy(): void {
  const proxy = resolveProxy();
  if (!proxy) { _fetch = globalThis.fetch; return; } // no proxy → always use global fetch
  try {
    const { fetch: undiciFetch, ProxyAgent } = require('undici');
    const strictSSL = vscode.workspace.getConfiguration('http').get<boolean>('proxyStrictSSL', true);
    const agent = new ProxyAgent(strictSSL ? proxy : { uri: proxy, requestTls: { rejectUnauthorized: false } });
    _fetch = ((input: FetchInput, init?: FetchInit) =>
      undiciFetch(input, { ...(init || {}), dispatcher: agent })) as typeof globalThis.fetch;
  } catch {
    _fetch = globalThis.fetch; // undici unavailable or invalid proxy: fall back to global fetch
  }
}

/** `fetch` with proxy support. Use instead of the global `fetch`. */
export const httpFetch: typeof globalThis.fetch = (input: FetchInput, init?: FetchInit) => _fetch(input, init);

// ── SSRF-safe fetch (web_fetch) ───────────────────────────────────────────────────────────────
// An undici Agent whose DNS lookup validates the resolved IP AT CONNECT time and connects to that
// exact IP. This closes the DNS-rebinding (TOCTOU) window a separate pre-flight check leaves open:
// the address that is validated is the address that is connected to (no second, attacker-swappable
// resolution). Private/internal/metadata IPs are refused.
let _ssrfAgent: Dispatcher | null = null;
let _ssrfTried = false;
function ssrfSafeDispatcher(): Dispatcher | null {
  if (_ssrfTried) return _ssrfAgent;
  _ssrfTried = true;
  try {
    const { Agent } = require('undici');
    _ssrfAgent = new Agent({
      connect: {
        lookup(hostname: string, options: dns.LookupOptions, cb: (err: Error | null, address?: string, family?: number) => void) {
          dns.lookup(hostname, { ...(options || {}), all: true }, (err, addresses: dns.LookupAddress[]) => {
            if (err) return cb(err);
            const list = Array.isArray(addresses) ? addresses : [addresses];
            for (const a of list) {
              const ip = typeof a === 'string' ? a : a.address;
              if (ipIsPrivate(ip)) return cb(new Error('Internal/private host blocked (SSRF).'));
            }
            const first = list[0];
            cb(null, typeof first === 'string' ? first : first.address, typeof first === 'string' ? 4 : first.family);
          });
        },
      },
    });
  } catch {
    _ssrfAgent = null; // undici unavailable: fall back (the per-hop host check still applies)
  }
  return _ssrfAgent;
}

/**
 * Fetch for `web_fetch`: SSRF-hardened. With no proxy, routes through an undici dispatcher that
 * validates the resolved IP at connect time (anti DNS-rebinding). With a proxy, the proxy resolves
 * DNS (rebinding to the target IP doesn't apply), so the proxied fetch is used as-is.
 */
export function safeWebFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
  if (_fetch !== globalThis.fetch) return _fetch(input, init); // a proxy is configured
  const dispatcher = ssrfSafeDispatcher();
  if (!dispatcher) return _fetch(input, init);
  try {
    const { fetch: undiciFetch } = require('undici');
    return undiciFetch(input, { ...(init || {}), dispatcher });
  } catch {
    return _fetch(input, init);
  }
}
