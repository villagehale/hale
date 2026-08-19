import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Voice v1 — the ticket that gets a call onto the relay socket.
 *
 * Every other door into Hale's Twilio leg is authenticated by Twilio's own signature.
 * The relay socket cannot be: Twilio does NOT sign the WebSocket upgrade it opens for
 * `<ConversationRelay>`, so a `wss://` URL that is merely public is a URL anyone can
 * connect to and then claim, in the first message they send, to be any caller they like.
 *
 * So the URL carries its own authority. The voice webhook — which IS signature-verified,
 * and which has already resolved WHO is calling before it decides to open a relay at all
 * — mints a short-lived ticket and puts it in the query string. The socket trusts the
 * ticket and nothing else on the wire.
 *
 * THE TICKET CARRIES THE IDENTITY, and that is the whole security property. A ticket
 * bound only to the call id would still leave the socket asking the wire "whose call is
 * this?" — and the wire is the attacker. Instead the family and the parent are inside
 * the signed payload, resolved back when the webhook was still holding a verified
 * request. A forged connect therefore cannot reach a family row: not because the lookup
 * is guarded, but because there is no lookup to aim at.
 *
 * What it deliberately does NOT carry is the phone number. This string rides in a URL
 * that Twilio stores and logs, so it holds two opaque uuids and nothing a support agent
 * at a third party could read as a person (rule #1).
 *
 * KEY SEPARATION follows lib/crypto/blind-index.ts and the referral code exactly: an
 * HKDF subkey of APP_ENCRYPTION_KEY under this module's own label, so a leaked ticket is
 * not an oracle for the phone index or the encryption key, and no new secret has to be
 * provisioned.
 */

const KEY_BYTES = 32;
/** This module's HKDF context label. Bumping it invalidates tickets in flight, which is
 * at most one call's worth — but it is pinned for the same reason the others are. */
const RELAY_TOKEN_INFO = 'hale-voice-relay-v1';

/**
 * How long a ticket is good for. A caller picks up (or does not) within a couple of
 * rings, so anything past two minutes is a window that exists only for an attacker to
 * find. Short enough to matter, long enough to survive a slow carrier.
 */
export const RELAY_TOKEN_TTL_SECONDS = 120;

/** Who the verified webhook decided this call belongs to. */
export interface RelayTicket {
  callSid: string;
  familyId: string;
  parentUserId: string;
}

export type RelayTokenCheck =
  | { ok: true; ticket: RelayTicket }
  | {
      ok: false;
      reason:
        /** Not shaped like a ticket at all — never reaches the key. */
        | 'malformed'
        /** Shaped right, signed wrong: tampered, or minted under another key. */
        | 'bad_signature'
        /** Authentic, but its window has passed. */
        | 'expired'
        /** Authentic, but for a different call than the one on this socket. */
        | 'call_mismatch';
    };

function loadKeyMaterial(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set — cannot mint a voice relay ticket');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}) — generate one with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

function relayKey(): Buffer {
  return Buffer.from(
    hkdfSync('sha256', loadKeyMaterial(), Buffer.alloc(0), RELAY_TOKEN_INFO, KEY_BYTES),
  );
}

/** `callSid.familyId.parentUserId.exp` — the four facts the signature covers. Dots are
 * safe separators: a CallSid is `CA` plus hex, a uuid is hex and dashes, and the expiry
 * is digits. */
function payload(ticket: RelayTicket, expSeconds: number): string {
  return `${ticket.callSid}.${ticket.familyId}.${ticket.parentUserId}.${expSeconds}`;
}

function sign(body: string): string {
  return createHmac('sha256', relayKey()).update(body).digest('hex');
}

/** The ticket for one call, good for {@link RELAY_TOKEN_TTL_SECONDS}. URL-safe as
 * minted — every field is hex, dashes, or digits — so it needs no encoding. */
export function mintRelayToken(ticket: RelayTicket, now: Date): string {
  const exp = Math.floor(now.getTime() / 1000) + RELAY_TOKEN_TTL_SECONDS;
  const body = payload(ticket, exp);
  return `${body}.${sign(body)}`;
}

/**
 * Read a ticket off the wire, or say why it is not one.
 *
 * The order is deliberate: shape, then signature, then the two facts the signature makes
 * trustworthy. Checking the expiry before the signature would be checking a number the
 * caller chose.
 */
export function verifyRelayToken(
  token: string | null | undefined,
  callSid: string,
  now: Date,
): RelayTokenCheck {
  if (!token) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 5) return { ok: false, reason: 'malformed' };
  const [sid, familyId, parentUserId, rawExp, mac] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d+$/.test(rawExp) || !/^[0-9a-f]{64}$/.test(mac)) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = sign(`${sid}.${familyId}.${parentUserId}.${rawExp}`);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'))) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (Number(rawExp) * 1000 < now.getTime()) return { ok: false, reason: 'expired' };
  if (sid !== callSid) return { ok: false, reason: 'call_mismatch' };

  return { ok: true, ticket: { callSid: sid, familyId, parentUserId } };
}
