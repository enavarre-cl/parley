/**
 * Validates a user-configured backend baseUrl before it is used to build request URLs. A malformed
 * URL, or one with a non-http(s) scheme (file:, data:, javascript:…), is rejected outright. Plain
 * http to a non-loopback host while an API key is attached is also rejected: the key would otherwise
 * travel in cleartext to an arbitrary host (P11). Returns the trimmed URL when valid.
 *
 * Kept free of the vscode/i18n imports so it is unit-testable in isolation; the messages mirror the
 * plain-English style of the other provider errors.
 */
export function validateBaseUrl(raw: string, opts: { hasKey: boolean }): string {
  const url = (raw || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid backend URL: ${url || '(empty)'}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Backend URL must use http or https, not ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (opts.hasKey && parsed.protocol === 'http:' && !loopback) {
    throw new Error(`Refusing to send the API key over plaintext http to ${parsed.host}. Use https.`);
  }
  return url;
}
