/**
 * Transport-address boundary parser.
 *
 * Twilio posts a WhatsApp sender as `From=whatsapp:+14165551234`. The prefix is
 * recognized HERE so the inbound webhook can count `whatsapp_dropped` and return
 * empty TwiML. It is not folded into the SMS spine: the pipe is retired, and a
 * WhatsApp turn is not the same door as a text. `normalizePhoneE164` stays
 * E.164-pure.
 */

/** The pipe a message rides. The ledger's channel_message_channel enum carries the
 * same values (plus email/push/voice, which are not phone transports). `imessage` is
 * the Linq blue-bubble pipe (VIL-335): the address is still a bare E.164, resolved
 * by the same blind index, and the chat id travels beside the message rather than
 * inside the address. */
export type MessageTransport = 'sms' | 'whatsapp' | 'imessage';

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
