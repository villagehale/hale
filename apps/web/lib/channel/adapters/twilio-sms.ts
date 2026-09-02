import { captureAgentError } from '~/lib/analytics/server-capture';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { twilioConfig } from '~/lib/channel/twilio/config';
import { TwilioSendError, createTwilioTransport } from '~/lib/channel/twilio/transport';
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
 * A provider failure is CLASSIFIED here, not swallowed and not blindly rethrown. A
 * transient refusal becomes the transient error variant, which the dispatch turns back
 * into a throw so pg-boss redelivers with backoff (the per-channel dedupe key keeps the
 * retry from double-sending) — a Twilio outage must never become a silent week. A
 * PERMANENT refusal — 21610 above all, the parent has opted out at the carrier — becomes
 * the non-transient variant instead: retrying can only re-earn the same refusal, so the
 * dispatch writes the failed row with the Twilio code and the loop stops texting a
 * number that has told the carrier no.
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

      try {
        const { providerMessageId } = await transport.send({ to, body: rendered.text });
        return { status: 'sent', providerMessageId };
      } catch (error) {
        if (!(error instanceof TwilioSendError)) throw error;
        // Reported at the point the refusal is CLASSIFIED, which is the only place both
        // halves are known: Twilio's numeric code, and whether a retry could ever help.
        // The error's `message` is deliberately not passed — it echoes the recipient's
        // number and the body back, and the reporter has no field it would fit in.
        //
        // No family: this seam is addressed by `userId`, and a user id reported in a
        // field named for a family is a wrong grain that would silently mis-group every
        // co-parent. The dispatch already carries the per-family view of the same
        // failure on its ledger row (channel/dispatch.ts, loop_message_failed).
        await captureAgentError({
          lane: 'transport',
          code: error.code,
          retry: error.permanent ? 'permanent' : 'transient',
          familyId: null,
        });
        return {
          status: 'error',
          transient: !error.permanent,
          code: error.code,
          message: error.message,
        };
      }
    },
  };
}
