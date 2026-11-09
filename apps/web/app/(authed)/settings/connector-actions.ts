'use server';

import { revalidatePath } from 'next/cache';
import type { GoogleAccessOutcome } from '~/lib/integrations/google-disconnect';
import { revokeFamilyConnector } from '~/lib/integrations/load';

export type DisconnectConnectorState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

/**
 * The label on the page the parent is looking at once the disconnect has run, one per
 * thing Google may have confirmed (VIL-156). A UI label on the Settings surface, not a
 * message Hale sends: a Settings click is not a thread the parent opened, so nothing is
 * texted. Google revokes per project, so every label says both services are off, and
 * none claims more than Google answered.
 */
const DISCONNECTED_LABEL: Record<GoogleAccessOutcome, string> = {
  revoked:
    'Disconnected. Gmail and Google Calendar are both off, and Google has removed Hale’s access to your Google account.',
  pending_retry:
    'Disconnected. Gmail and Google Calendar are both off. Hale asked Google to remove its access; Google hasn’t confirmed yet, and Hale keeps asking.',
  not_confirmed:
    'Disconnected. Gmail and Google Calendar are both off and Hale deleted its keys, but Google didn’t confirm removing Hale’s access. Your Google account settings show whether Hale is still listed.',
};

/**
 * Disconnect Google for the signed-in parent. Delegates to revokeFamilyConnector, which
 * goes through disconnectGoogle: auth from the session, scoped to the caller's own
 * (family,user), every Google connector ended and revoked at Google. Every non-revoked
 * result surfaces as an error — never the false success the old fetch-the-route path
 * returned when no row matched.
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
      return { status: 'success', message: DISCONNECTED_LABEL[result.google] };
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
