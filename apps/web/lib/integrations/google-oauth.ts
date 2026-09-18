import { appBaseUrl } from '~/lib/cron/email-compliance';
import type { OAuthTokens } from './token-vault';

/**
 * Google OAuth for CONNECTORS — a server-side authorization-code flow that adds two
 * things sign-in doesn't need: OFFLINE access (a refresh token, because connectors
 * sync in the background when the user isn't present) and INCREMENTAL authorization
 * for the per-connector read-only scope.
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

/** WHICH Google project this connector grant belongs to. */
export type OAuthClientSource = 'connector_project' | 'signin_project';

/**
 * The project the connector flow is running on, NAMED rather than inferred (rule #11).
 *
 * 'signin_project' means the connector pair is unset and the flow is riding the
 * SIGN-IN project's client — the pre-VIL-350 behaviour, which still works and must
 * keep working, but is the thing sensitive-scope verification must NOT be submitted
 * against: brand review, the verification state and the 100-new-user unverified cap
 * all attach to a Cloud PROJECT's consent screen, so a sibling client inside the
 * sign-in project would isolate nothing. GOOGLE_CONNECTOR_CLIENT_ID must be a client
 * in a SEPARATE project.
 *
 * BOTH halves or neither: an id from one project with a secret from another is a
 * token exchange that fails at Google with nothing in the data saying why, so a
 * half-set pair is the sign-in project, not a third state.
 */
export function connectorClientSource(): OAuthClientSource {
  return process.env.GOOGLE_CONNECTOR_CLIENT_ID && process.env.GOOGLE_CONNECTOR_CLIENT_SECRET
    ? 'connector_project'
    : 'signin_project';
}

function clientId(): string {
  const id =
    connectorClientSource() === 'connector_project'
      ? process.env.GOOGLE_CONNECTOR_CLIENT_ID
      : process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!id)
    throw new Error(
      'neither GOOGLE_CONNECTOR_CLIENT_ID nor GOOGLE_OAUTH_CLIENT_ID is set — cannot start the connector OAuth flow',
    );
  return id;
}

function clientSecret(): string {
  const secret =
    connectorClientSource() === 'connector_project'
      ? process.env.GOOGLE_CONNECTOR_CLIENT_SECRET
      : process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!secret)
    throw new Error(
      'neither GOOGLE_CONNECTOR_CLIENT_SECRET nor GOOGLE_OAUTH_CLIENT_SECRET is set — cannot exchange the auth code',
    );
  return secret;
}

/**
 * The ONE redirect_uri: registered with Google once, and identical in the consent
 * redirect and in the token exchange BY CONSTRUCTION, because both call this.
 *
 * appBaseUrl() and never the request's own origin. A redirect_uri computed from
 * whatever host the request arrived on is a different string on a preview deploy,
 * on the *.vercel.app alias and in prod — three strings where Google has one
 * registered, and the flow fails at Google with a message no log of ours carries.
 * The connect route refuses off-host rather than minting that URL (`wrong_host`).
 */
export function connectorRedirectUri(): string {
  return `${appBaseUrl()}/api/integrations/callback`;
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
