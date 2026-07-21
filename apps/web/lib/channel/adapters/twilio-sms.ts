import type { Channel } from '../types';

/**
 * The SMS leg of the channel seam (VIL-213 · A2) — scaffold. Twilio is not
 * provisioned yet (founder-side: account, A2P number, campaign registration), so
 * this always reports a not_configured skip today and the dispatch treats SMS as an
 * absent leg. A3 finishes provisioning and the raw send; when the three env creds are
 * present, this throws so a half-configured deploy fails loudly instead of silently
 * dropping a message. Lighting it up is then a localized change inside `send`.
 *
 * Privacy (rule #1): the phone number and the rendered body are never logged.
 */

/** Provisioning config for the Twilio send — empty until A3 wires it. */
export type TwilioSmsChannelDeps = Record<string, never>;

export function createTwilioSmsChannel(_deps?: TwilioSmsChannelDeps): Channel {
  return {
    kind: 'sms',
    async send({ rendered }) {
      if (rendered.kind !== 'sms') {
        throw new Error(`twilio sms adapter received ${rendered.kind} content`);
      }

      const configured =
        Boolean(process.env.TWILIO_ACCOUNT_SID) &&
        Boolean(process.env.TWILIO_AUTH_TOKEN) &&
        Boolean(process.env.TWILIO_FROM_NUMBER);
      if (!configured) {
        return { status: 'skipped', reason: 'not_configured' };
      }

      // A3 finishes provisioning + the raw Twilio send. Reaching here means the creds
      // are set but the send path isn't built — surface it rather than drop silently.
      throw new Error('twilio send not implemented');
    },
  };
}
