import type { ConnectorProvider } from './google-oauth';
import type { ConnectionSummary } from './store';

export type ConnectionState = 'connected' | 'not_connected';

/** Connected while Hale still holds a credential for the provider: any row that is
 * not revoked (the same rule as the Connections page's live row). */
export function connectionState(
  rows: readonly Pick<ConnectionSummary, 'provider' | 'status'>[],
  provider: ConnectorProvider,
): ConnectionState {
  return rows.some((row) => row.provider === provider && row.status !== 'revoked')
    ? 'connected'
    : 'not_connected';
}
