import type { Database } from '@hale/db';
import {
  type GoogleAccessOutcome,
  type GoogleDisconnectPorts,
  disconnectGoogle,
} from '~/lib/integrations/google-disconnect';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

/**
 * Disconnecting Google from the thread the parent is standing in — the act half of the
 * texted disconnect, mirroring offer.ts.
 *
 * It calls {@link disconnectGoogle} DIRECTLY and never `revokeFamilyConnector`
 * (integrations/load.ts), which resolves family and user from `auth()`: an inbound text
 * carries no session, so that path would answer `unauthenticated` and the parent would
 * see a nothing-happened for an instruction that was perfectly clear.
 *
 * SCOPE IS THE KEY, which is why there is no `not_enrolled` here and no seat re-proof
 * either: the predicate is (family, user) plus the named connector — the pair the connect
 * wrote under — so a caregiver, or a parent naming a connector that is the other
 * parent's, matches nothing and gets `not_connected`. There is no widening to guard.
 */
export type ConnectorRevokeOutcome =
  /** Every Google connector of theirs ended; `google` is what Google confirmed. */
  | { status: 'revoked'; providers: ConnectorProvider[]; google: GoogleAccessOutcome }
  /** Nothing of this parent's to disconnect — NOT a false success (rule #11). */
  | { status: 'not_connected' }
  /** The local disconnect did not land, so nothing changed. Named rather than thrown,
   * for offer.ts's reason: a thrown handler defers the whole turn into hours of queue
   * backoff for an instruction the parent gave NOW. The caller logs it. */
  | { status: 'revoke_failed' };

export async function revokeConnectorByText(
  database: Database,
  input: { familyId: string; parentUserId: string; provider: ConnectorProvider },
  ports: GoogleDisconnectPorts,
): Promise<ConnectorRevokeOutcome> {
  try {
    const result = await disconnectGoogle(
      database,
      { familyId: input.familyId, userId: input.parentUserId, via: 'sms', named: input.provider },
      ports,
    );
    return result.status === 'disconnected'
      ? { status: 'revoked', providers: result.providers, google: result.google }
      : { status: 'not_connected' };
  } catch {
    return { status: 'revoke_failed' };
  }
}
