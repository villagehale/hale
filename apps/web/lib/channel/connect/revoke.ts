import type { Database } from '@hale/db';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import { revokeConnection } from '~/lib/integrations/store';

/**
 * Disconnecting a connector from the thread the parent is standing in — the act half of
 * the texted disconnect, mirroring offer.ts.
 *
 * It calls {@link revokeConnection} DIRECTLY and never `revokeFamilyConnector`
 * (integrations/load.ts), which resolves family and user from `auth()`: an inbound text
 * carries no session, so that path would answer `unauthenticated` and the parent would
 * see a nothing-happened for an instruction that was perfectly clear.
 *
 * SCOPE IS THE REVOKE KEY, which is why there is no `not_enrolled` here and no seat
 * re-proof either: the predicate is (family, user, provider) — the triple the connect
 * wrote under — so a caregiver, or a parent naming a connector that is the other
 * parent's, matches nothing and gets `not_connected`. There is no widening to guard.
 */
export type ConnectorRevokeOutcome =
  | { status: 'revoked' }
  /** Nothing of this parent's to disconnect — NOT a false success (rule #11). */
  | { status: 'not_connected' }
  /** The revoke or its audit row did not land, so nothing changed. Named rather than
   * thrown, for offer.ts's reason: a thrown handler defers the whole turn into hours of
   * queue backoff for an instruction the parent gave NOW, and the honest failure line
   * with a working retry is the better answer. The caller logs it. */
  | { status: 'revoke_failed' };

export async function revokeConnectorByText(
  database: Database,
  input: { familyId: string; parentUserId: string; provider: ConnectorProvider },
): Promise<ConnectorRevokeOutcome> {
  try {
    const revoked = await revokeConnection(
      database,
      input.familyId,
      input.parentUserId,
      input.provider,
      'sms',
    );
    return revoked > 0 ? { status: 'revoked' } : { status: 'not_connected' };
  } catch {
    return { status: 'revoke_failed' };
  }
}
