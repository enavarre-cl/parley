/** Shared primitives for the local TTS HTTP daemons (Piper, Chatterbox): a free loopback port and
 *  a readiness poll. Pure helpers (only `net`/`http`), so each manager keeps its own process
 *  lifecycle (spawn, idle-timeout, kill) but does not duplicate this networking. */
import * as net from 'net';
import * as http from 'http';

/** Asks the OS for a free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Polls `GET path` on 127.0.0.1:port until it responds (or times out). */
export function waitForHttp(port: number, timeoutMs: number, path = '/'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = (): Promise<void> => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (res) => {
      res.resume();
      resolve();
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  const loop = async (): Promise<void> => {
    for (;;) {
      try { await tryOnce(); return; }
      catch {
        if (Date.now() > deadline) throw new Error('timeout waiting for the TTS daemon');
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };
  return loop();
}
