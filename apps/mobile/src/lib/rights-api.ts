import { api } from './api-client';
import type {
  MobileDeleteResponse,
  MobileExportResponse,
  MobileRevokeShareRequest,
  MobileRevokeShareResponse,
  MobileSharedLinksResponse,
} from './api-types';

/**
 * The native "Privacy & data" account-management calls. Each hits a mobile route
 * that delegates to the SAME web lib the browser uses — the app never re-implements
 * the teen redaction, the reversible deletion, or the audit write; it just posts
 * the intent (rules #1/#6). The shared api() client attaches the Bearer token,
 * extracts the route's `error` message on a non-2xx, and bounces to sign-in on 401.
 */

/** Fetch the full teen-redacted export document to share via the RN Share sheet. */
export async function exportData(): Promise<MobileExportResponse> {
  return api<MobileExportResponse>('/api/mobile/rights/export');
}

/** Schedule account/family deletion (reversible 7-day grace). Returns the effective
 * deletion instant so the UI can state the date the parent can still cancel before. */
export async function scheduleAccountDeletion(): Promise<MobileDeleteResponse> {
  return api<MobileDeleteResponse>('/api/mobile/rights/delete', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

/** The family's currently-live shared links (week plans + local picks). */
export async function listSharedLinks(): Promise<MobileSharedLinksResponse> {
  return api<MobileSharedLinksResponse>('/api/mobile/village/shares');
}

/** Turn off ONE shared link. The token is nulled + audited server-side (rules #1/#6). */
export async function revokeSharedLink(
  body: MobileRevokeShareRequest,
): Promise<MobileRevokeShareResponse> {
  return api<MobileRevokeShareResponse>('/api/mobile/village/shares/revoke', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
