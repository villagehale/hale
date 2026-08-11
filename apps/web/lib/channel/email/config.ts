/**
 * The inbound-email leg's credentials and identities, read in ONE place and never
 * logged — the email twin of twilio/config.ts, including its all-or-nothing stance.
 *
 * Four values, and the leg genuinely needs all four:
 *   - RESEND_API_KEY — not for sending. The `email.received` webhook carries METADATA
 *     ONLY (no body, no headers); the message itself has to be fetched back with this
 *     key, so a deployment without it could authenticate a parent's email and then be
 *     unable to read a word of it.
 *   - RESEND_INBOUND_WEBHOOK_SECRET — the Svix signing secret for THIS webhook
 *     endpoint. Distinct from any outbound-event webhook secret; each endpoint gets its
 *     own in the Resend dashboard.
 *   - HALE_INBOUND_EMAIL_DOMAIN — the subdomain the machine receives on. Env-driven
 *     because the public address a parent writes to is forwarded in from elsewhere, so
 *     the code must never hard-code either address.
 *   - HALE_INBOUND_AUTHSERV_ID — the receiving MTA's `Authentication-Results`
 *     authserv-id. This is a SECURITY value, not a cosmetic one: it is what tells our
 *     own MTA's verdict apart from one an attacker typed into their message (trust.ts).
 *     It must be confirmed against a real delivered message before the leg is enabled.
 *
 * ALL-OR-NOTHING. A partially provisioned leg is the dangerous state — it accepts a
 * parent's message and then fails somewhere downstream having already written to the
 * ledger. Absent or partial config is one clean 503 and the whole leg is dark, by
 * construction rather than by a flag.
 */

export interface EmailInboundConfig {
  readonly apiKey: string;
  readonly webhookSecret: string;
  /** Lowercased — every comparison against it is case-insensitive. */
  readonly inboundDomain: string;
  /** Lowercased for the same reason. */
  readonly authservId: string;
}

const REQUIRED = [
  'RESEND_API_KEY',
  'RESEND_INBOUND_WEBHOOK_SECRET',
  'HALE_INBOUND_EMAIL_DOMAIN',
  'HALE_INBOUND_AUTHSERV_ID',
] as const;

/** A set env var's trimmed value, or undefined when it is absent or blank. */
function read(name: (typeof REQUIRED)[number]): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/** The config, or null when the leg is not provisioned. Values are returned, never
 * logged — every caller treats them as secrets. */
export function emailInboundConfig(): EmailInboundConfig | null {
  const apiKey = read('RESEND_API_KEY');
  const webhookSecret = read('RESEND_INBOUND_WEBHOOK_SECRET');
  const inboundDomain = read('HALE_INBOUND_EMAIL_DOMAIN');
  const authservId = read('HALE_INBOUND_AUTHSERV_ID');
  if (!apiKey || !webhookSecret || !inboundDomain || !authservId) {
    return null;
  }
  return {
    apiKey,
    webhookSecret,
    inboundDomain: inboundDomain.toLowerCase(),
    authservId: authservId.toLowerCase(),
  };
}

/** The config for a path that cannot proceed without it. Throws naming only the MISSING
 * variable names — never a value. */
export function requireEmailInboundConfig(): EmailInboundConfig {
  const config = emailInboundConfig();
  if (!config) {
    const missing = REQUIRED.filter((name) => !read(name));
    throw new Error(`inbound email not configured: missing ${missing.join(', ')}`);
  }
  return config;
}
