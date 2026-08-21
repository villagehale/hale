import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { requireTwilioConfig } from './config';

/**
 * VIL-214 · A3 — the real SMS leg behind M2's {@link ChannelTransport}: the ONE place
 * a message actually leaves Hale for a phone.
 *
 * Raw REST over `fetch`, no SDK. The Twilio node SDK would add a large dependency and
 * its own HTTP stack to send one form-encoded POST, and the repo has no Twilio
 * dependency to reuse (scout note on VIL-214). `fetch` is injected so the request this
 * builds is asserted directly in tests — no network, no credentials (rule: external
 * calls behind a small injectable interface).
 *
 * Privacy (rule #1): the number and the body are arguments, never log lines. Twilio
 * echoes both back inside its error `message` field, so failures surface the HTTP
 * status and Twilio's numeric error code ONLY — enough to diagnose (21610 = the
 * recipient opted out, 21408 = unpermitted region) without putting a parent's phone
 * number in a stack trace.
 */

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

/** Twilio's webhook budget is 15s and this send sits inside that request, so it is
 * bounded well under it: a hung provider must fail fast, not time the webhook out. */
const SEND_TIMEOUT_MS = 10_000;

export interface TwilioTransportDeps {
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
}

/**
 * The refusals no retry can fix: 21610 the recipient has opted out, 21408 the region is
 * not permitted, 21211 the number is not a valid E.164, 21614 the number cannot receive
 * SMS. Everything else — an outage, a throttle, a timeout — is transient by default, so
 * a code Twilio adds tomorrow keeps being retried rather than silently dropped.
 */
const PERMANENT_TWILIO_CODES = new Set(['21610', '21408', '21211', '21614']);

/**
 * A Twilio refusal, typed so a caller can act on it without parsing a string. Carries
 * the numeric code and the HTTP status ONLY: Twilio echoes the number and the body back
 * inside its own `message`, and this is the object that ends up in a stack trace (rule #1).
 */
export class TwilioSendError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  /** True when retrying would only earn the same refusal — the caller stops instead. */
  readonly permanent: boolean;

  constructor(code: string, httpStatus: number) {
    super(`twilio send failed: HTTP ${httpStatus}, twilio code ${code}`);
    this.name = 'TwilioSendError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.permanent = PERMANENT_TWILIO_CODES.has(code);
  }
}

function readErrorCode(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'code' in payload) {
    const code = (payload as { code: unknown }).code;
    if (typeof code === 'number' || typeof code === 'string') return String(code);
  }
  return 'unknown';
}

export function createTwilioTransport(deps: TwilioTransportDeps = {}): ChannelTransport {
  const doFetch = deps.fetch ?? globalThis.fetch;
  return {
    async send({ to, body }) {
      const config = requireTwilioConfig();
      const credentials = Buffer.from(`${config.apiKeySid}:${config.apiKeySecret}`).toString(
        'base64',
      );

      const response = await doFetch(
        `${TWILIO_API_BASE}/Accounts/${config.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${credentials}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: to,
            // Via the Messaging Service when configured (Twilio-side queueing and
            // encoding; the pool holds the same brand number, so the parent still
            // sees the contact they saved) — direct From otherwise.
            ...(config.messagingServiceSid
              ? { MessagingServiceSid: config.messagingServiceSid }
              : { From: config.fromNumber }),
            Body: body,
            // Live-gate finding (2026-08-11): Twilio only sends delivery receipts to a
            // StatusCallback named IN the send request — the number-level field does
            // not apply to API-created messages, so without this the ledger's rows
            // stop at 'sent' forever and a failed delivery is invisible.
            StatusCallback: `${appBaseUrl()}/api/channels/twilio/status`,
          }).toString(),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new TwilioSendError(readErrorCode(payload), response.status);
      }

      const payload = (await response.json()) as { sid?: unknown };
      const sid = payload.sid;
      if (typeof sid !== 'string' || sid.length === 0) {
        // The ledger's idempotency and every delivery callback key off this id, so a
        // fabricated one would quietly break both (rule #8: fail, don't paper over).
        throw new Error('twilio send succeeded but returned no message sid');
      }
      return { providerMessageId: sid };
    },
  };
}
