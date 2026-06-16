/** Descarga de archivos con progreso e integridad (puro Node, sin VS Code). */
import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';

/** SHA256 (hex) de un archivo. */
export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export interface DownloadOpts {
  redirects?: number;
  /** Progreso: bytes recibidos y total (0 si el servidor no manda content-length). */
  onProgress?: (received: number, total: number) => void;
  /** Permite cancelar la descarga. */
  signal?: AbortSignal;
}

/** Descarga `url` a `destPath` siguiendo redirecciones (GitHub/HF redirigen a su CDN). */
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
      headers: { 'User-Agent': 'lang-chat', Accept: '*/*' },
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
        const fail = (e: any) => { try { file.destroy(); } catch { /* nada */ } try { fs.unlinkSync(tmp); } catch { /* nada */ } reject(e); };
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
