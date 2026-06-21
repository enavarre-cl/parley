/** File download with progress and integrity checks (pure Node, no VS Code). */
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';

/** SHA256 (hex) of a file. */
export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'parley', Accept: '*/*' },
    };
    const req = https
      .get(reqOpts, (res: any) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('too many redirects'));
          const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
          let next: string;
          try { next = new URL(loc, url).toString(); } catch { return reject(new Error('bad redirect: ' + loc)); }
          return resolve(downloadFile(next, destPath, { redirects: redirects - 1, onProgress, signal }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        const tmp = destPath + '.part';
        const file = fs.createWriteStream(tmp);
        const fail = (e: any) => { try { file.destroy(); } catch { /* noop */ } try { fs.unlinkSync(tmp); } catch { /* noop */ } reject(e); };
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
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
  });
}
