/**
 * WHERE HALE'S ANSWER GOES — the router's one question about delivery, and the only
 * place the answer is allowed to be shaped like a phone number.
 *
 * C1 was written when there was one door: `phoneE164` on the context, a Twilio transport
 * on the deps, `channel: 'sms'` in the ledger row. Every one of those was true and none
 * of them said so — a parent who wrote by EMAIL would have been answered by text, or
 * dropped as `unreachable` for owning no phone. Naming the route is what makes the
 * router answer on the channel a message ARRIVED on, and makes any other behaviour
 * unspellable: there is no raw address anywhere downstream of this type, so no handler,
 * no plan, and no reply can pick a transport of its own.
 *
 * The route is resolved ONCE per turn, in the same read that resolves who is talking
 * (wiring.ts), and it is null for exactly one reason: there is no live address on that
 * channel — a revoked SMS channel, or a parent who has asked us to stop emailing. Null
 * is the router's `unreachable`, and it is why a stopped parent cannot be answered even
 * by a turn that is already in flight.
 */

export type ReplyRoute =
  | { channel: 'sms'; to: string }
  /**
   * `inReplyTo` is the inbound email's own Message-ID, carried so the answer lands
   * INSIDE the parent's thread. Nullable because a ledger row is not required to hold a
   * provider id — an answer with no reference is still an answer, it simply starts a new
   * thread rather than continuing one.
   */
  | { channel: 'email'; to: string; inReplyTo: string | null };

/**
 * What one delivered message leaves behind: the provider's id, and the channel it
 * actually went out on.
 *
 * The channel is reported by the SEND rather than assumed by the caller, and that is
 * what lets a self-sending handler write an honest ledger row without resolving a
 * destination of its own — the row says `email` because an email is what left, not
 * because someone remembered to branch.
 */
export interface ReplySent {
  providerMessageId: string;
  channel: ReplyRoute['channel'];
}

/**
 * One outbound message on a resolved route. Deliberately the SAME narrow shape the SMS
 * transport had — a body in, a receipt out — because everything channel-specific (a
 * subject, a footer, threading headers) belongs to the implementation rather than to the
 * caller. A sender that cannot deliver THROWS: the router claims the turn answered the
 * moment this returns, so a quiet failure would be a reply the parent never saw recorded
 * as one they did (rule #11).
 */
export interface ReplyTransport {
  send(input: { route: ReplyRoute; body: string }): Promise<ReplySent>;
}

/** Records every send with the route it went out on — the assertion surface for "was
 * this answered on the channel the parent used". */
export class FakeReplyTransport implements ReplyTransport {
  readonly sent: Array<{ route: ReplyRoute; body: string }> = [];
  private counter = 0;

  async send(input: { route: ReplyRoute; body: string }): Promise<ReplySent> {
    this.sent.push(input);
    this.counter += 1;
    return { providerMessageId: `fake-out-${this.counter}`, channel: input.route.channel };
  }

  bodies(): string[] {
    return this.sent.map((s) => s.body);
  }
}
