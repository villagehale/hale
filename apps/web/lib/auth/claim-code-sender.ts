import { twilioConfig } from '~/lib/channel/twilio/config';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { type OtpSender, createOtpSender } from '~/lib/channels/otp-sender';

/**
 * The sign-in code's way out of the building.
 *
 * `createOtpSender()`'s own default reads an `SMS_OTP_*` env family that predates the
 * A3 Twilio leg and exists nowhere else in this repo — not in `.env.example`, not in
 * any deployment. Defaulting to it would ship a sign-in flow that is `not_configured`
 * in every environment, which is the honest-but-useless outcome. So the claim flow is
 * wired to the transport that actually carries Hale's SMS today, through the same
 * OtpSender seam and the same message copy.
 *
 * Rule #11: an absent transport is a NAMED outcome, not a silent nothing — no Twilio
 * config yields a sender that reports `not_configured`, which the caller logs and the
 * UI never mistakes for a code being on its way.
 */
export function createClaimCodeSender(): OtpSender {
  if (!twilioConfig()) {
    return createOtpSender(null);
  }
  const transport = createTwilioTransport();
  return createOtpSender({
    async sendSms(to, body) {
      await transport.send({ to, body });
    },
  });
}
