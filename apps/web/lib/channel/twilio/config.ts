/**
 * VIL-214 · A3 — the Twilio credentials, read in ONE place and never logged.
 *
 * Two different secrets, for two different jobs (a real source of confusion, so it is
 * spelled out here rather than rediscovered):
 *   - TWILIO_AUTH_TOKEN  — the account's PRIMARY token. The only key Twilio signs
 *     X-Twilio-Signature with, so it is what INBOUND verification needs. Never used
 *     for REST auth here.
 *   - TWILIO_API_KEY_SID / _SECRET — a revocable Standard API key, used as the HTTP
 *     Basic credentials for OUTBOUND sends. Revoking it kills sending without
 *     invalidating every webhook signature, which is the whole reason to prefer it.
 * TWILIO_ACCOUNT_SID is needed regardless: it is the REST path segment, and an API key
 * pair alone cannot address an account.
 *
 * ALL-OR-NOTHING on purpose. The inbound webhook does not just read texts, it ANSWERS
 * them, so a deployment holding the auth token but no sending credentials would accept
 * a parent's message and silently fail to reply. Absent config is a clean 503 (the
 * whole leg is dark); half-present config is the same 503 rather than a half-working
 * webhook.
 */

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly apiKeySid: string;
  readonly apiKeySecret: string;
  /** The Hale number parents text, E.164. Reuses A2's existing env name. */
  readonly fromNumber: string;
  /** When set, sends go out via the Messaging Service (queueing, smart encoding,
   * sender-pool scaling) instead of the bare number. Optional at this boundary:
   * absent means the pre-service behavior — a direct From send — which still
   * sends; it is a valid mode, not a silent no-op. */
  readonly messagingServiceSid: string | null;
}

/** The config, or null when the Twilio leg is not provisioned. Values are returned,
 * never logged — every caller treats them as secrets. */
export function twilioConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID ?? null;
  if (!accountSid || !authToken || !apiKeySid || !apiKeySecret || !fromNumber) {
    return null;
  }
  return { accountSid, authToken, apiKeySid, apiKeySecret, fromNumber, messagingServiceSid };
}

/**
 * The WhatsApp-enabled sender (WhatsApp v1), E.164 WITHOUT the `whatsapp:` prefix —
 * the transport applies it. Null while the leg is not provisioned (no Meta-verified
 * sender yet): every WhatsApp path must then degrade to a NAMED outcome — the reply
 * decider answers `not_configured` and rides SMS (reply-transport.ts) — never a
 * silent no-op (rule #11). Requires the base Twilio config too: a WhatsApp number
 * with no account credentials could accept nothing and send nothing.
 *
 * Whitespace-stripped before the check — `vercel env add` stores a trailing newline
 * (the flags-silently-OFF landmine), and that must read as "configured", not dark.
 */
export function twilioWhatsAppSender(): string | null {
  const sender = (process.env.TWILIO_WHATSAPP_FROM ?? '').trim();
  if (!sender || !twilioConfig()) return null;
  return sender;
}

/** The config for a path that cannot proceed without it (an outbound send). Throws
 * naming only the MISSING variable names — never a value. */
export function requireTwilioConfig(): TwilioConfig {
  const config = twilioConfig();
  if (!config) {
    const missing = [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_API_KEY_SID',
      'TWILIO_API_KEY_SECRET',
      'TWILIO_FROM_NUMBER',
    ].filter((name) => !process.env[name]);
    throw new Error(`twilio not configured: missing ${missing.join(', ')}`);
  }
  return config;
}
