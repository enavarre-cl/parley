import { httpFetch } from '../http';
import { formatHttpError } from './httpError';

/** Time to wait for response HEADERS before giving up. The streamed body afterwards is unbounded. */
const HEADERS_TIMEOUT_MS = 60_000;

/**
 * Fetch that fails if the server doesn't send response headers within `timeoutMs`. Honours the
 * caller's `init.signal` (Stop) too. The timer is cleared once headers arrive, so a long streamed
 * body is never cut by it — only a backend that accepts the connection and then goes silent.
 */
async function fetchWithHeadersTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const userSignal = init.signal ?? undefined;
  const onUserAbort = (): void => ctl.abort((userSignal as AbortSignal | undefined)?.reason);
  if (userSignal) {
    if (userSignal.aborted) ctl.abort((userSignal as AbortSignal).reason);
    else userSignal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new Error('No response from the server (timed out).')), timeoutMs);
  try {
    // ctl.signal stays linked to the user signal, so a later Stop still aborts the streamed body.
    return await httpFetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POSTs a streaming chat request and returns the response body reader, throwing a formatted error on
 * a non-OK or body-less response. Shared by every provider so the request/error shell lives in one
 * place. `name` labels the backend in errors; `hint` appends extra context (e.g. Ollama crash hints).
 */
export async function postStream(
  url: string,
  init: RequestInit,
  name: string,
  hint?: (detail: string) => string,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetchWithHeadersTimeout(url, init, HEADERS_TIMEOUT_MS);
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(formatHttpError(name, res.status, res.statusText, detail) + (hint ? hint(detail) : ''));
  }
  return res.body.getReader();
}
