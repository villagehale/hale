import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { type EmailReplyDeps, sendEmailReply } from '~/lib/channel/email/reply-send';
import type { ReplySent, ReplyTransport } from './reply-route';

/**
 * The production way out — the ONE place a route becomes a provider call.
 *
 * There is exactly one `switch` on channel in the whole router, and this is it. That is
 * deliberate: every other module above works on a resolved route it cannot inspect, so
 * "answer on the channel they used" is a property of the type rather than a rule each
 * caller has to remember. Adding a third door is adding an arm here and a variant to
 * the route union (reply-route.ts), and the compiler finds every place that needs to know.
 *
 * THE EMAIL LEG MAY BE ABSENT, and its absence is a first-class outcome (rule #11)
 * rather than a nullable dependency that silently does nothing. An unprovisioned inbound
 * leg means no email can have arrived, so no route can name it — but if one somehow
 * does, this THROWS by name. A throw is the honest answer: it fails the turn, which the
 * router treats as a broken turn and the drain re-drives, instead of claiming a parent
 * was answered by a send that never happened.
 */
export function createReplyTransport(deps: {
  /**
   * The phone door — BOTH pipes. In production this is the reply-routing transport
   * (lib/channel/reply-transport.ts), which decides SMS-vs-WhatsApp per send from the
   * parent's newest inbound row and Meta's 24h window, and names the pipe it used in
   * the result. The sms and whatsapp arms below both hand to it: the route says which
   * door the parent used, the phone transport owns which pipe may answer through it.
   */
  phone: ChannelTransport;
  /** Null when the inbound-email leg is not provisioned — see the module note. */
  email: EmailReplyDeps | null;
}): ReplyTransport {
  return {
    async send({ route, body }): Promise<ReplySent> {
      switch (route.channel) {
        case 'sms':
        case 'whatsapp': {
          const sent = await deps.phone.send({ to: route.to, body });
          // Absent means a single-pipe SMS transport (intake/transport.ts) — the same
          // convention sendReply kept before the route existed.
          return { providerMessageId: sent.providerMessageId, channel: sent.transport ?? 'sms' };
        }
        case 'email': {
          if (!deps.email) {
            throw new Error(
              'channel router: an email reply was routed but the inbound-email leg is not provisioned',
            );
          }
          const { providerMessageId } = await sendEmailReply(deps.email, {
            to: route.to,
            body,
            inReplyTo: route.inReplyTo,
          });
          return { providerMessageId, channel: 'email' };
        }
      }
    },
  };
}
