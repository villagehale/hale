import type { OAuthTokens } from './token-vault';

/**
 * Google OAuth for CONNECTORS — a server-side authorization-code flow that reuses
 * the existing web client (GOOGLE_OAUTH_CLIENT_ID/SECRET, the same one sign-in
 * uses) but adds two things sign-in doesn't need: OFFLINE access (a refresh token,
 * because connectors sync in the background when the user isn't present) and
 * INCREMENTAL authorization for the per-connector read-only scope.
 *
 * Read-only scopes only — connectors never mutate the user's Google data.
 */

export type ConnectorProvider = 'gcal' | 'gmail' | 'gdrive';

export const CONNECTOR_SCOPES: Record<ConnectorProvider, readonly string[]> = {
  gcal: ['https://www.googleapis.com/auth/calendar.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
  gdrive: ['https://www.googleapis.com/auth/drive.readonly'],
};

/** The connector provider enum values — the single list the sync poller iterates. */
export const CONNECTOR_PROVIDERS = Object.keys(CONNECTOR_SCOPES) as ConnectorProvider[];

/** Narrow an arbitrary path segment to a connector provider (rejects the other integration_provider values). */
export function isConnectorProvider(value: string): value is ConnectorProvider {
  return value === 'gcal' || value === 'gmail' || value === 'gdrive';
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function clientId(): string {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!id) throw new Error('GOOGLE_OAUTH_CLIENT_ID is not set — cannot start the connector OAuth flow');
  return id;
}

function clientSecret(): string {
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!secret) throw new Error('GOOGLE_OAUTH_CLIENT_SECRET is not set — cannot exchange the auth code');
  return secret;
}

/** The Google consent URL for connecting one connector. `state` is the CSRF/binding token. */
export function buildGoogleAuthUrl(opts: {
  provider: ConnectorProvider;
  state: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: CONNECTOR_SCOPES[opts.provider].join(' '),
    access_type: 'offline', // issue a refresh token for background sync
    prompt: 'consent', // force re-consent so the refresh token is (re)issued
    // Deliberately NOT include_granted_scopes: each connector's grant must be scoped
    // to ITSELF (rule #1). Unioning scopes across connectors means a gcal token would
    // still carry gmail.readonly, so disconnecting Gmail wouldn't kill Hale's ability
    // to read Gmail via the surviving gcal token. Self-scoped grants die with their
    // own disconnect.
    state: opts.state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/** Minimal fetch shape so the token exchange is injectable/mockable in tests. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** Exchange the authorization code for tokens. Throws (never returns partial) on a non-ok response. */
export async function exchangeCodeForTokens(
  opts: { code: string; redirectUri: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<OAuthTokens> {
  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: opts.code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`google token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as GoogleTokenResponse;
  return mapTokenResponse(data);
}

/**
 * Refresh an expired access token with the stored refresh token. Google's refresh
 * response does NOT echo the refresh_token, so the caller keeps the existing one
 * (mapTokenResponse only sets refreshToken when present). Throws on a non-ok
 * response (e.g. the user revoked access) rather than returning a partial token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<OAuthTokens> {
  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`google token refresh failed: ${res.status}`);
  }
  const data = (await res.json()) as GoogleTokenResponse;
  return mapTokenResponse(data);
}

function mapTokenResponse(data: GoogleTokenResponse): OAuthTokens {
  return {
    accessToken: data.access_token,
    ...(data.refresh_token && { refreshToken: data.refresh_token }),
    ...(data.expires_in && { expiresAt: Date.now() + data.expires_in * 1000 }),
    ...(data.scope && { scope: data.scope }),
    ...(data.token_type && { tokenType: data.token_type }),
  };
}
