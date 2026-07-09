import type { ConnectorState, IntegrationStatus } from '../../app/api/mobile/types';
import { CONNECTOR_PROVIDERS } from './google-oauth';
import type { ConnectionSummary } from './store';

/**
 * Shape the connection summaries into the native connectors view: one entry per known
 * connector (gcal/gmail/gdrive), with the raw integration_status normalized to an
 * honest UI status. Only the provider + status + a connect timestamp cross the wire —
 * never tokens or scopes (rule #1). A provider with no row (or a non-connector row
 * like stripe) reads as 'not_connected'. Should two rows share a provider (both
 * parents linked it — the mobile route scopes to one parent, but defend regardless),
 * the strongest status wins so the UI never reports a live sync as 'Not connected'.
 */
export function toConnectorStates(connections: ConnectionSummary[]): ConnectorState[] {
  const byProvider = new Map<string, ConnectionSummary>();
  for (const row of connections) {
    const existing = byProvider.get(row.provider);
    if (!existing || statusRank(row.status) > statusRank(existing.status)) {
      byProvider.set(row.provider, row);
    }
  }
  return CONNECTOR_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    const status = normalizeStatus(row?.status);
    // A connect timestamp is only meaningful for a live/errored connection — a
    // never-linked (or revoked) provider carries none.
    return status === 'not_connected' || !row?.connectedAt
      ? { provider, status }
      : { provider, status, connectedAt: row.connectedAt.toISOString() };
  });
}

/** Which of two rows for the same provider wins: an active connection outranks an
 * errored/expired one, which outranks anything revoked/unknown — so a live sync is
 * never masked by a stale revoked row. */
function statusRank(raw: string): number {
  switch (raw) {
    case 'active':
      return 2;
    case 'error':
    case 'expired':
      return 1;
    default:
      return 0;
  }
}

/** Fail closed: only 'active' is 'connected'; 'error'/'expired' need reconnecting;
 * everything else (revoked, connecting, unknown) is 'not_connected'. */
function normalizeStatus(raw: string | undefined): IntegrationStatus {
  switch (raw) {
    case 'active':
      return 'connected';
    case 'error':
    case 'expired':
      return 'error';
    default:
      return 'not_connected';
  }
}
