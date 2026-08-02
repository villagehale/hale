import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { twilioConfig } from '~/lib/channel/twilio/config';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import type { Channel } from '../types';

/**
 * The LOOP's SMS leg of the channel seam (VIL-213 · A2), lit up by VIL-260.
 *
 * A2 defined the seam and A3 (VIL-214) built the raw send, but behind M2's
 * `ChannelTransport` (lib/channel/twilio/transport.ts), which addresses a bare E.164 —
 * the shape intake needs, because intake has a number before it has an account. THIS
 * seam is the other shape: it is handed a `userId`. What was missing was the reader
 * that resolves one to a SENDABLE number; `resolveSendablePhone` (sms-consent-core) is
 * that reader, so the adapter composes the two rather than growing a third.
 *
 * Config is read all-or-nothing (see twilio/config.ts): a deploy holding some of the
 * credentials skips cleanly rather than half-sending, and the dispatch records the
 * skip as a not_configured leg.
 *
 * A provider failure THROWS out of the transport rather than being mapped to an
 * outcome. That is the drain's documented contract for a channel error: the job fails,
 * pg-boss redelivers with backoff, and the per-channel dedupe key keeps the retry from
 * double-sending. Swallowing it here would turn a Twilio outage into a silent week.
 *
 * Privacy (rule #1): the phone number and the rendered body are never logged.
 */

export interface TwilioSmsChannelDeps {
  /** Resolve an internal user id to a sendable E.164, or null when this parent has no
   * active verified SMS channel (prod: `resolveSendablePhone`). */
  resolveTarget(userId: string): Promise<string | null>;
  /** The shared outbound leg; defaults to the real Twilio transport. */
  transport?: ChannelTransport;
  /** Whether the Twilio leg is provisioned; defaults to the presence of the config. */
  configured?: boolean;
}

export function createTwilioSmsChannel(deps: TwilioSmsChannelDeps): Channel {
  const transport = deps.transport ?? createTwilioTransport();
  return {
    kind: 'sms',
    async send({ userId, rendered }) {
      if (rendered.kind !== 'sms') {
        throw new Error(`twilio sms adapter received ${rendered.kind} content`);
      }

      if (!(deps.configured ?? twilioConfig() !== null)) {
        return { status: 'skipped', reason: 'not_configured' };
      }

      const to = await deps.resolveTarget(userId);
      if (!to) {
        return { status: 'skipped', reason: 'no_address' };
      }

      const { providerMessageId } = await transport.send({ to, body: rendered.text });
      return { status: 'sent', providerMessageId };
    },
  };
}
