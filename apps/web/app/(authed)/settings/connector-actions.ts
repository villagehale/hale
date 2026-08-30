'use server';

import { revalidatePath } from 'next/cache';
import { revokeFamilyConnector } from '~/lib/integrations/load';

export type DisconnectConnectorState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

/**
 * Disconnect one Google connector for the signed-in parent. Delegates to
 * revokeFamilyConnector: auth from the session, scoped to the caller's own
 * (family,user,provider), tokens purged + the rule-#6 audit row inside one
 * transaction. Every non-revoked result surfaces as an error — never the false
 * success the old fetch-the-route path returned when no row matched. The success
 * copy owns the local-only truth: Hale's tokens are deleted, but Google's own
 * record of the grant survives until the user removes it there.
 */
export async function disconnectConnectorAction(
  _previous: DisconnectConnectorState,
  formData: FormData,
): Promise<DisconnectConnectorState> {
  const provider = formData.get('provider');
  if (typeof provider !== 'string' || provider.length === 0) {
    return { status: 'error', message: 'Hale could not identify that connection.' };
  }

  const result = await revokeFamilyConnector(provider);
  switch (result.status) {
    case 'revoked':
      revalidatePath('/settings');
      return {
        status: 'success',
        message:
          'Disconnected — Hale deleted its keys. Google still lists the grant until you remove Hale at myaccount.google.com/permissions.',
      };
    case 'not_found':
      return {
        status: 'error',
        message: 'Nothing to disconnect — this connection isn’t yours, or it’s already gone.',
      };
    case 'unsupported_provider':
      return { status: 'error', message: 'Hale could not identify that connection.' };
    default:
      return { status: 'error', message: 'Sign in again before changing this connection.' };
  }
}
