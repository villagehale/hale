const PRIVATE_V4 = /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/;

/**
 * The only URLs the signup browser may open.
 *
 * https on a public host, or http on loopback for the local mock form.
 * Credentials, private addresses, and any other scheme are refused.
 */
export function registrationUrlAllowed(raw: string): { ok: true; href: string } | { ok: false } {
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
  if (loopback || PRIVATE_V4.test(host) || host.endsWith('.local')) return { ok: false };
  return { ok: true, href: url.href };
}
