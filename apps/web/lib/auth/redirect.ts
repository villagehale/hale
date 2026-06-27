/**
 * Clamp a post-auth redirect target to an app-internal path. A bare
 * `startsWith('/')` is not enough: `//evil.com` and `/\evil.com` start with `/`
 * yet browsers resolve them as protocol-relative URLs to an external host. Reject
 * those so a crafted `callbackUrl` can never bounce a freshly-authed session
 * off-site (open-redirect / phishing).
 */
export function safeInternalRedirect(target: string | undefined, fallback = '/home'): string {
  if (!target || !target.startsWith('/')) return fallback;
  if (target.startsWith('//') || target.startsWith('/\\')) return fallback;
  return target;
}
