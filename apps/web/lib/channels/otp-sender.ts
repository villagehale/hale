/**
 * The OTP transport seam. Deliberately provider-NEUTRAL (OtpSender, not
 * "TwilioVerify"): the CPaaS account is founder-side and unprovisioned, and the
 * provider may land as Telnyx or Twilio (decided at A3). Until then every send
 * returns `not_configured`, which the UI surfaces as an honest "text verification
 * arrives when SMS launches" state — never a dead form pretending to send.
 *
 * We OWN the code (generate + hash + verify locally, one vendor path); this seam
 * only TRANSMITS the code as an SMS. A3 wires the real provider send by supplying a
 * concrete {@link SmsTransport}; the enrolment logic and its tests depend on the
 * OtpSender interface, never on a provider.
 */

export type OtpSendResult = { status: 'sent' } | { status: 'not_configured' };

export interface OtpSender {
  sendCode(input: { phoneE164: string; code: string }): Promise<OtpSendResult>;
}

/** Minimal SMS egress. A3's provider adapter (Twilio/Telnyx) implements this. */
export interface SmsTransport {
  sendSms(to: string, body: string): Promise<void>;
}

/** Inside a sign-in request, so bounded like the main transport's 10s: a hung CPaaS
 * must fail fast, never pin a parent on "sending your code" until the platform kills
 * the function (lib/channel/twilio/transport.ts's exact budget). */
const OTP_SEND_TIMEOUT_MS = 10_000;

/**
 * A CPaaS refusal, typed so a caller can act on it without parsing a string — the
 * TwilioSendError convention on the one SMS leg that predates it. Provider-neutral,
 * so the split is on the HTTP status alone: a 4xx (bar 408/429) is the provider
 * saying the request itself is wrong, and the identical request re-sent earns the
 * identical answer; everything else — throttle, timeout, outage — is transient.
 * Carries the status ONLY: a CPaaS error body echoes the number back, and this is
 * the object that ends up in a stack trace (rule #1).
 */
export class OtpSendError extends Error {
  readonly httpStatus: number;
  /** True when retrying would only earn the same refusal — the caller stops instead. */
  readonly permanent: boolean;

  constructor(httpStatus: number) {
    super(`SMS OTP send failed (${httpStatus})`);
    this.name = 'OtpSendError';
    this.httpStatus = httpStatus;
    this.permanent =
      httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429;
  }
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
 * Read a Twilio-shaped SMS transport from env, or null when the CPaaS account isn't
 * provisioned (the current state everywhere). Provider-neutral env names so A3 can
 * point them at Telnyx or Twilio without renaming.
 */
function transportFromEnv(): SmsTransport | null {
  const accountSid = process.env.SMS_OTP_ACCOUNT_SID;
  const authToken = process.env.SMS_OTP_AUTH_TOKEN;
  const from = process.env.SMS_OTP_FROM;
  const apiBase = process.env.SMS_OTP_API_BASE; // e.g. https://api.twilio.com/2010-04-01
  if (!accountSid || !authToken || !from || !apiBase) return null;

  return {
    async sendSms(to, body) {
      const res = await fetch(`${apiBase}/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
        signal: AbortSignal.timeout(OTP_SEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new OtpSendError(res.status);
      }
    },
  };
}

/**
 * Whether an SMS transport is provisioned right now — lets the Settings read show
 * the honest "text verification arrives when SMS launches" state without attempting
 * a send. False until the CPaaS env is set (A3 provisioning).
 */
export function isOtpSenderConfigured(): boolean {
  return transportFromEnv() !== null;
}

/**
 * The real OtpSender. `transport` defaults to the env-derived one (null until CPaaS
 * lands → `not_configured`); tests inject a Fake transport to exercise the sent path.
 */
export function createOtpSender(transport: SmsTransport | null = transportFromEnv()): OtpSender {
  return {
    async sendCode({ phoneE164, code }) {
      if (!transport) return { status: 'not_configured' };
      await transport.sendSms(phoneE164, otpMessage(code));
      return { status: 'sent' };
    },
  };
}
