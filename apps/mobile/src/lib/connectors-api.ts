import { api } from './api-client';
import type {
  ConnectorProvider,
  MobileConnectUrlResponse,
  MobileIntegrationDisconnectResponse,
} from './api-types';

/**
 * The native connector calls. All go through the shared api() client (attaches the
 * Bearer token, extracts the route's `error` on a non-2xx, bounces to sign-in on
 * 401). Connection PLUMBING only — no token material ever crosses these (rule #1).
 * The list read itself uses useApi(); these are the writes + the connect-URL fetch.
 */

/** The Google consent URL to open in a browser for a connector connect flow. The
 * callback lands the tokens server-side (the signed state carries the binding) and
 * redirects to /connected, so the app just awaits the browser close then refreshes. */
export async function fetchConnectUrl(provider: ConnectorProvider): Promise<string> {
  const { url } = await api<MobileConnectUrlResponse>(
    `/api/mobile/integrations/connect-url?provider=${provider}`,
  );
  return url;
}

/** Revoke a connector (purges tokens + audits server-side, rules #1/#6). */
export async function disconnectIntegration(provider: ConnectorProvider): Promise<void> {
  await api<MobileIntegrationDisconnectResponse>(
    `/api/mobile/integrations/${provider}/disconnect`,
    { method: 'POST' },
  );
}
