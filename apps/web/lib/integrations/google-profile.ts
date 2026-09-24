import { safeGivenName } from '~/lib/channel/identity/parent-call-name';

/**
 * Google's userinfo endpoint. Read ONLY the given name, and only with a token the
 * parent just granted `userinfo.profile` for. A failure is a named miss — the
 * connector still connects, and the parent is asked in the open form instead.
 */
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export async function readGoogleGivenName(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.info({ status: res.status }, 'google profile: userinfo declined');
      return null;
    }
    const body = (await res.json()) as { given_name?: unknown; sub?: unknown };
    const given = typeof body.given_name === 'string' ? safeGivenName(body.given_name) : null;
    if (!given) {
      console.info('google profile: no usable given name');
      return null;
    }
    return given;
  } catch (err) {
    console.info(
      { err: err instanceof Error ? err.name : 'unknown' },
      'google profile: userinfo failed',
    );
    return null;
  }
}

/**
 * Google's stable account id (`sub`). Used only to refuse attaching the other
 * parent's Google account. The value is not logged and is not stored raw.
 */
export async function readGoogleAccountSub(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      console.info({ status: res.status }, 'google account: userinfo declined');
      return null;
    }
    const body = (await res.json()) as { sub?: unknown };
    const sub = typeof body.sub === 'string' ? body.sub.trim() : '';
    if (!sub || sub.length > 255) {
      console.info('google account: no usable subject');
      return null;
    }
    return sub;
  } catch (err) {
    console.info(
      { err: err instanceof Error ? err.name : 'unknown' },
      'google account: userinfo failed',
    );
    return null;
  }
}
