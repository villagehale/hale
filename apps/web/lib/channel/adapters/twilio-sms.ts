import type { Channel } from '../types';

/**
 * The LOOP's SMS leg of the channel seam (VIL-213 · A2) — still a scaffold, and
 * deliberately so after VIL-214 · A3.
 *
 * A3 provisioned Twilio and built the raw send, but behind M2's `ChannelTransport`
 * (lib/channel/twilio/transport.ts), which addresses a bare E.164 — the shape intake
 * needs, because intake has a number before it has an account. THIS seam is the other
 * shape: it is handed a `userId` and no phone at all, so lighting it up needs a reader
 * that resolves a user to a SENDABLE number. `loadSmsChannelState` deliberately returns
 * only a masked one, so that reader does not exist yet; writing it is the loop-SMS
 * follow-up, not something to improvise inside an adapter with no db handle.
 *
 * This previously THREW once the three env credentials were present, on the assumption
 * that creds appearing meant this send path had been built. A3 broke that assumption:
 * the same credentials now power the inbound webhook, so their presence says nothing
 * about this leg. The skip is the honest report — the dispatch records it as a
 * not_configured outcome and the message goes out over email instead.
 *
 * Privacy (rule #1): the phone number and the rendered body are never logged.
 */

/** Provisioning config for the loop's Twilio send — empty until the leg is wired. */
export type TwilioSmsChannelDeps = Record<string, never>;

export function createTwilioSmsChannel(_deps?: TwilioSmsChannelDeps): Channel {
  return {
    kind: 'sms',
    async send({ rendered }) {
      if (rendered.kind !== 'sms') {
        throw new Error(`twilio sms adapter received ${rendered.kind} content`);
      }
      return { status: 'skipped', reason: 'not_configured' };
    },
  };
}
