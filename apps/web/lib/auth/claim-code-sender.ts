import { linqPhoneOutboundConfigured } from '~/lib/channel/linq/config';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { type OtpSender, createOtpSender } from '~/lib/channels/otp-sender';

/**
 * The sign-in code's way out of the building.
 *
 * The claim flow is wired to the shared outbound door (`createOutboundTransport`:
 * Linq on `LINQ_FROM_E164`), through the same OtpSender seam and the same message
 * copy.
 *
 * Rule #11: an absent transport is a NAMED outcome, not a silent nothing — no Linq
 * config yields a sender that reports `not_configured`, which the caller logs and
 * the UI never mistakes for a code being on its way.
 */
export function createClaimCodeSender(): OtpSender {
  if (!linqPhoneOutboundConfigured()) return createOtpSender(null);
  const transport = createOutboundTransport();
  return createOtpSender({
    async sendSms(to, body) {
      await transport.send({ to, body });
    },
  });
}
