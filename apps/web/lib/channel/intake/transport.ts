import type { MessageTransport } from '~/lib/channel/transport-address';
import type { IntakeKeyword } from './keywords';

/**
 * VIL-237 · M2 — the raw two-way SMS transport, deliberately smaller than the loop's
 * `Channel` seam (lib/channel/types.ts). That seam sends to a RESOLVED PARENT
 * (`send({ userId, rendered })`) and enforces loop policy on the way; intake has no
 * parent yet — the whole point is that the number arrives before the account — so it
 * addresses a bare E.164 and carries no policy at all. Two interfaces, not one
 * widened one: nothing in intake should be able to reach a loop template, and no loop
 * caller should be able to text an unresolved number.
 *
 * Provider-neutral (no Twilio here, and none coming through this file): M2 ships the
 * interface plus {@link FakeTransport}, and a real CPaaS adapter lands behind the SAME
 * `send` later — the state machine and its tests depend on the contract only.
 */

/** A normalized inbound message, already lifted out of whatever the provider posted. */
export interface InboundMessage {
  /** The sender's number as the provider gave it — normalized by the caller, never
   * stored raw (rule #1: it is hashed + encrypted the moment it is used). Always the
   * BARE address: the webhook strips any `whatsapp:` prefix before building this
   * (lib/channel/transport-address.ts), so one number is one person on either pipe. */
  from: string;
  body: string;
  /** The provider's own id for this inbound. The idempotency key: a carrier retry
   * carries the SAME id, which is how a duplicate is told from a real second text. */
  providerId: string;
  receivedAt: Date;
  /** The pipe the message arrived on. Absent means 'sms' — the historical transport
   * every pre-WhatsApp caller and fixture assumes; the webhook always sets it. */
  transport?: MessageTransport;
  /**
   * VIL-348 — the provider's OWN keyword handling already matched this message AND
   * already replied to the sender, so Hale's acknowledgment would be the second one.
   *
   * `null` is the ordinary case and it is a NAMED absence, not an unknown (rule #11):
   * it means the provider answered nothing and the whole reply is Hale's to send.
   * Provider-neutral like the rest of this interface — the field says what happened,
   * not which vendor's parameter carried it.
   *
   * ONLY THE ACKNOWLEDGMENT IS SUPPRESSED. Every consent write, every audit row and
   * every ledger row still happens: the provider's list is not Hale's ledger, and a
   * STOP that revokes nothing on our side because a carrier answered it first is the
   * CASL failure this field exists to avoid. What it buys is that a parent who asked
   * to be left alone gets one confirmation rather than two.
   */
  providerAnsweredKeyword?: IntakeKeyword | null;
}

/** What one `send` carries. `mediaUrls`, when present, must be non-empty absolute
 * PUBLIC urls — the provider fetches them itself, so nothing behind our auth can go. */
export interface OutboundMessage {
  to: string;
  body: string;
  /**
   * Attachments, as urls the PROVIDER fetches. Absent means a plain text message.
   *
   * THE CONTRACT FOR IMPLEMENTERS (rule #11): an implementation that cannot carry
   * media must THROW on a send that asks for it. Dropping the attachment and
   * delivering the body is the silent no-op the rule exists to forbid — the parent
   * would read a sentence about a card that never arrived, and nothing would be
   * logged. Present-but-empty is likewise a caller bug, not "no media": it means an
   * attachment was intended and is missing, so it is refused rather than downgraded.
   */
  mediaUrls?: string[];
}

export interface ChannelTransport {
  /** `transport` in the result names which pipe actually carried the send, for the
   * one implementation that chooses per message (the reply-routing transport,
   * lib/channel/reply-transport.ts) — the caller's ledger row must record the pipe
   * that was used, not the one it assumed. Absent means the implementation has only
   * one pipe (the plain SMS transport, every Fake). */
  send(
    input: OutboundMessage,
  ): Promise<{ providerMessageId: string; transport?: MessageTransport }>;
}

/**
 * The test double: records every outbound send in order, and mints inbound messages
 * so a test can drive a whole conversation without a provider. `inbound()` is a
 * convenience factory, not state — the state machine is the thing under test.
 */
export class FakeTransport implements ChannelTransport {
  /** Every send verbatim, INCLUDING its media — a fake that recorded only the body
   * could never fail on a dropped attachment. */
  readonly sent: OutboundMessage[] = [];
  private counter = 0;

  async send(input: OutboundMessage): Promise<{ providerMessageId: string }> {
    this.sent.push(input);
    this.counter += 1;
    return { providerMessageId: `fake-out-${this.counter}` };
  }

  /** The media urls sent so far, one entry per send that carried any. */
  media(): string[][] {
    return this.sent.flatMap((s) => (s.mediaUrls ? [s.mediaUrls] : []));
  }

  /** The bodies sent so far, in order — the assertion surface for copy tests. */
  bodies(): string[] {
    return this.sent.map((s) => s.body);
  }

  /** Build an inbound message as if the parent had texted it. */
  inbound(from: string, body: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
    this.counter += 1;
    return {
      from,
      body,
      providerId: `fake-in-${this.counter}`,
      receivedAt: new Date('2026-07-30T12:00:00.000Z'),
      ...overrides,
    };
  }
}
