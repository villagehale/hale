import { getPublicOrigin } from 'mcp-handler';

/** Public deployment origin as reconstructed from the platform proxy headers. */
export function mcpRequestOrigin(req: Request): string {
  const configured = process.env.APP_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Invalid configuration fails through to the request-derived development
      // origin; production config validation reports the malformed APP_URL.
    }
  }
  return getPublicOrigin(req);
}

/**
 * Server Components do not receive a Request object. Reconstruct the same public
 * origin from Vercel's first forwarded hop, with APP_URL as the pinned production
 * source when configured. A missing/invalid host fails closed.
 */
export function mcpOriginFromHeaders(headers: Headers): string | null {
  const configured = process.env.APP_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }

  const forwardedHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || headers.get('host')?.split(',')[0]?.trim();
  if (!host) return null;
  const forwardedProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol =
    forwardedProto ||
    (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

/** Strict browser-origin check for the authenticated authorization form POST. */
export function hasExpectedOrigin(req: Request, expectedOrigin: string): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && origin === expectedOrigin;
}

export function oauthRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): URL {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url;
}
