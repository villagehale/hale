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
   * stored raw (rule #1: it is hashed + encrypted the moment it is used). */
  from: string;
  body: string;
  /** The provider's own id for this inbound. The idempotency key: a carrier retry
   * carries the SAME id, which is how a duplicate is told from a real second text. */
  providerId: string;
  receivedAt: Date;
}

export interface ChannelTransport {
  send(input: { to: string; body: string }): Promise<{ providerMessageId: string }>;
}

/**
 * The test double: records every outbound send in order, and mints inbound messages
 * so a test can drive a whole conversation without a provider. `inbound()` is a
 * convenience factory, not state — the state machine is the thing under test.
 */
export class FakeTransport implements ChannelTransport {
  readonly sent: Array<{ to: string; body: string }> = [];
  private counter = 0;

  async send(input: { to: string; body: string }): Promise<{ providerMessageId: string }> {
    this.sent.push(input);
    this.counter += 1;
    return { providerMessageId: `fake-out-${this.counter}` };
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
