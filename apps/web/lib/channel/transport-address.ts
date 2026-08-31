/**
 * WhatsApp v1 — the transport-address boundary parser, the missing primitive the
 * silent-swallow bug traced to: Twilio posts a WhatsApp sender as
 * `From=whatsapp:+14165551234`, and `normalizePhoneE164` (correctly) rejects the
 * letters, so the message died as `invalid_number` with no ledger row and no log.
 *
 * The prefix is stripped HERE, once, at the webhook boundary — never inside
 * `normalizePhoneE164`, which is the canonicalizer the phone blind index keys on
 * and must stay E.164-pure. Downstream the entire SMS spine (normalize → blind
 * index → resolve → keywords → machine → C1) runs on the bare address unchanged,
 * which is what makes `whatsapp:+1416…` and `+1416…` the SAME person, family,
 * consent state, and coach thread by construction (the continuity law).
 */

/** The pipe a message rides. The ledger's channel_message_channel enum carries the
 * same two values (plus email/push/voice, which are not phone transports). */
export type MessageTransport = 'sms' | 'whatsapp';

/** Twilio's WhatsApp address form, on both `From` and `To`. */
export const WHATSAPP_ADDRESS_PREFIX = 'whatsapp:';

export interface TransportAddress {
  transport: MessageTransport;
  /** The bare address with the transport stripped — NOT yet validated; it goes to
   * `normalizePhoneE164` exactly as a plain SMS `From` would. */
  address: string;
}

/** Total on purpose: garbage in yields `{ transport: 'sms', address: garbage }`,
 * and the existing normalize step downstream stays the one rejector of invalid
 * numbers — one canonicalizer, one refusal path, whichever pipe was used. */
export function parseTransportAddress(raw: string): TransportAddress {
  if (raw.startsWith(WHATSAPP_ADDRESS_PREFIX)) {
    return { transport: 'whatsapp', address: raw.slice(WHATSAPP_ADDRESS_PREFIX.length) };
  }
  return { transport: 'sms', address: raw };
}
