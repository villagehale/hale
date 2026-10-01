/**
 * The only URLs the signup browser may open.
 *
 * https on a public host, or http on loopback for the local mock form.
 * Credentials, private addresses, and any other scheme are refused.
 *
 * The regex stays inside the function so `Function#toString` is a complete
 * copy the sandbox hands script can run without this module.
 */
export function registrationUrlAllowed(raw: string): { ok: true; href: string } | { ok: false } {
  const privateV4 = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (url.username || url.password) return { ok: false };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol === 'http:' && loopback) return { ok: true, href: url.href };
  if (url.protocol !== 'https:') return { ok: false };
  if (loopback || privateV4.test(host) || host.endsWith('.local')) return { ok: false };
  return { ok: true, href: url.href };
}
