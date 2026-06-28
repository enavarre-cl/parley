/** File download with progress and integrity checks (pure Node, no VS Code). */
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';
import * as dns from 'dns';
import { isIP } from 'net';
import { ipIsPrivate, safeLookupResult, ResolvedAddr } from './net';

/** SHA256 (hex) of a file. */
export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * DNS lookup that rejects internal/private IPs and connects to the validated address — used for
 * every request (initial AND each redirect). Without it, a malicious `Location:` (e.g. a mirror
 * redirecting to http://169.254.169.254/ or a host on the LAN) would be followed blindly (SSRF).
 * Validating at connect time (not just the hostname) also avoids a DNS-rebinding TOCTOU window.
 */
function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, address?: string | ResolvedAddr[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...(options || {}), all: true }, (err, addresses: dns.LookupAddress[]) => {
    if (err) return cb(err);
    const list: ResolvedAddr[] = Array.isArray(addresses) ? addresses : [addresses];
    const result = safeLookupResult(list, options?.all);
    if (!result) return cb(new Error('Internal/private host blocked (SSRF).') as NodeJS.ErrnoException);
    // Array when Node asked for `all` (autoSelectFamily); a single address otherwise.
    if (Array.isArray(result)) return cb(null, result);
    cb(null, result.address, result.family);
  });
}

export interface DownloadOpts {
  redirects?: number;
  /** Progress: bytes received and total (0 if the server sends no content-length). */
  onProgress?: (received: number, total: number) => void;
  /** Allows cancelling the download. */
  signal?: AbortSignal;
}

/** Downloads `url` to `destPath` following redirects (GitHub/HF redirect to their CDN). */
export function downloadFile(url: string, destPath: string, opts: DownloadOpts = {}): Promise<void> {
  const { redirects = 6, onProgress, signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    let u: URL;
    try { u = new URL(url); } catch { return reject(new Error('Invalid URL: ' + url)); }
    // A literal-IP host (e.g. a redirect to http://169.254.169.254/) bypasses the custom lookup
    // below — Node does no DNS for an IP literal — so block private IPs explicitly here too.
    // u.hostname keeps the brackets for IPv6 literals ([::1]); strip them before the check.
    const hostIp = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostIp) && ipIsPrivate(hostIp)) {
      return reject(new Error('Internal/private host blocked (SSRF).'));
    }
    const reqOpts: https.RequestOptions = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'jotflow', Accept: '*/*' },
      // reject internal/private IPs (anti-SSRF) on this request and every redirect. Cast: Node's
      // LookupFunction typing is stricter than the runtime contract safeLookup honours.
      lookup: safeLookup as https.RequestOptions['lookup'],
    };
    const req = https
      .get(reqOpts, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('too many redirects'));
          const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
          let next: string;
          try { next = new URL(loc, url).toString(); } catch { return reject(new Error('bad redirect: ' + loc)); }
          return resolve(downloadFile(next, destPath, { redirects: redirects - 1, onProgress, signal }));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + status));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        const tmp = destPath + '.part';
        const file = fs.createWriteStream(tmp);
        const fail = (e: Error) => { try { file.destroy(); } catch { /* noop */ } try { fs.unlinkSync(tmp); } catch { /* noop */ } reject(e); };
        res.on('error', fail);
        file.on('error', fail);
        if (onProgress) res.on('data', (chunk: Buffer) => { received += chunk.length; onProgress(received, total); });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          try { fs.renameSync(tmp, destPath); resolve(); } catch (e) { reject(e); }
        }));
      })
      .on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('download timeout')));
    if (signal) {
      const onAbort = (): void => { req.destroy(new Error('aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
      // Remove the listener when the request ends without aborting — otherwise, with a shared signal
      // (each redirect adds one), listeners accumulate on it for the life of the signal.
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}
