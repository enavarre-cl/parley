import * as cp from 'child_process';

/**
 * Terminates a child process AND its descendants, cross-platform.
 *
 * - **Windows**: `taskkill /pid <pid> /T /F` kills the whole process tree. A plain `proc.kill()`
 *   only signals the direct child — and when the child was spawned with `shell: true` that child
 *   is `cmd.exe`, so the real server (e.g. `ollama serve`) would be left orphaned.
 * - **POSIX**: `SIGTERM` first for a graceful shutdown, then `SIGKILL` after `graceMs` if the
 *   process has not exited (some servers ignore SIGTERM and would otherwise hang around).
 */
export function killProcessTree(proc: cp.ChildProcess | null | undefined, graceMs = 3000): void {
  if (!proc || proc.pid === undefined) return;
  const pid = proc.pid;
  if (process.platform === 'win32') {
    try { cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { try { proc.kill(); } catch { /* already gone */ } }
    return;
  }
  let exited = false;
  proc.once('exit', () => { exited = true; });
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { if (!exited) { try { proc.kill('SIGKILL'); } catch { /* already gone */ } } }, graceMs).unref();
}
