/**
 * The OTP transport seam. We OWN the code (generate + hash + verify locally);
 * this seam only TRANSMITS it. Production sends through Linq
 * (`createOutboundTransport`). An absent Linq door returns `not_configured`,
 * which the UI never mistakes for a code being on its way.
 */

import { linqPhoneOutboundConfigured } from '~/lib/channel/linq/config';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';

export type OtpSendResult = { status: 'sent' } | { status: 'not_configured' };

export interface OtpSender {
  sendCode(input: { phoneE164: string; code: string }): Promise<OtpSendResult>;
}

/** Minimal phone egress. The Linq outbound door implements this. */
export interface SmsTransport {
  sendSms(to: string, body: string): Promise<void>;
}

/** The verification text. Carries the code only — never the parent's name (rule #1). */
export function otpMessage(code: string): string {
  return `Your Hale verification code is ${code}. It expires in 10 minutes.`;
}

/**
 * A Fake for tests: records every code it was asked to send and reports `sent`
 * (or a stubbed result — pass `{ status: 'not_configured' }` to model the
 * CPaaS-absent state). Records nothing when it can't send.
 */
export class FakeOtpSender implements OtpSender {
  readonly sent: Array<{ phoneE164: string; code: string }> = [];
  constructor(private readonly result: OtpSendResult = { status: 'sent' }) {}

  async sendCode(input: { phoneE164: string; code: string }): Promise<OtpSendResult> {
    if (this.result.status === 'sent') {
      this.sent.push(input);
    }
    return this.result;
  }
}

/**
 * Whether a sign-in code can leave right now. False until Linq outbound is configured.
 */
export function isOtpSenderConfigured(): boolean {
  return linqPhoneOutboundConfigured();
}

function linqTransport(): SmsTransport | null {
  if (!linqPhoneOutboundConfigured()) return null;
  const outbound = createOutboundTransport();
  return {
    async sendSms(to, body) {
      await outbound.send({ to, body });
    },
  };
}

/**
 * The real OtpSender. `transport` defaults to Linq (null until Linq is configured
 * → `not_configured`); tests inject a transport to exercise the sent path.
 */
export function createOtpSender(transport: SmsTransport | null = linqTransport()): OtpSender {
  return {
    async sendCode({ phoneE164, code }) {
      if (!transport) return { status: 'not_configured' };
      await transport.sendSms(phoneE164, otpMessage(code));
      return { status: 'sent' };
    },
  };
}
