/**
 * Converts an HTTP error response (whose body is typically JSON of the form
 * {error:{message}} or {error:"..."}) into a readable message, with hints based on the status code.
 */
export function formatHttpError(
  label: string,
  status: number,
  statusText: string,
  body: string
): string {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message ?? (typeof j?.error === 'string' ? j.error : '');
  } catch {
    msg = body;
  }
  msg = (msg || statusText || '').trim();
  if (msg.length > 500) msg = msg.slice(0, 500) + '…';

  let hint = '';
  if (status === 429) {
    hint = 'Quota or rate limit exceeded. Wait a few seconds or try another model ' +
      "(e.g. on Gemini's free tier the *-pro models aren't available; use gemini-2.5-flash).";
  } else if (status === 401 || status === 403) {
    hint = 'Authentication rejected. Check the API key in the settings (🔧).';
  } else if (status === 404) {
    hint = 'Not found. Check the selected model and the endpoint URL.';
  }

  let out = `${label} (${status}): ${msg}`;
  if (hint) out += `\n\n${hint}`;
  return out;
}
