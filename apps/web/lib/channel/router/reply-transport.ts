import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { sendLinqChatMessage, sendResolvingNewChat } from '~/lib/channel/outbound-transport';
import type { ReplySent, ReplyTransport } from './reply-route';

/**
 * The production way out — the ONE place a route becomes a provider call.
 *
 * There is exactly one `switch` on channel in the whole router, and this is it. That is
 * deliberate: every other module above works on a resolved route it cannot inspect, so
 * "answer on the channel they used" is a property of the type rather than a rule each
 * caller has to remember. Adding a third door is adding an arm here and a variant to
 * the route union (reply-route.ts), and the compiler finds every place that needs to know.
 */
export function createReplyTransport(deps: {
  /** The phone door. Production is `createOutboundTransport` (Linq unless the kill switch is on). */
  phone: ChannelTransport;
  /**
   * The iMessage door. Absent means the real Linq partner send (linq/transport.ts),
   * which throws a named `not_configured` when `LINQ_API_KEY` is unset — a missing
   * sender is a failed turn the drain can re-drive, never a text that vanished.
   * Tests inject a fake so they can prove the chat id is what gets addressed.
   */
  imessage?: (input: {
    chatId: string;
    body: string;
    replyToMessageId: string | null;
  }) => Promise<{ providerMessageId: string }>;
}): ReplyTransport {
  const sendImessage =
    deps.imessage ??
    ((input: { chatId: string; body: string; replyToMessageId: string | null }) =>
      sendLinqChatMessage({
        chatId: input.chatId,
        text: input.body,
        replyTo: input.replyToMessageId ? { messageId: input.replyToMessageId } : undefined,
      }));
  return {
    async send({ route, body }): Promise<ReplySent> {
      switch (route.channel) {
        case 'sms': {
          const sent = await sendResolvingNewChat(deps.phone, { to: route.to, body });
          const channel = sent.transport === 'imessage' ? 'imessage' : 'sms';
          return {
            providerMessageId: sent.providerMessageId,
            channel,
            ...(sent.chatId ? { chatId: sent.chatId } : {}),
          };
        }
        case 'imessage': {
          const sent = await sendImessage({
            chatId: route.chatId,
            body,
            replyToMessageId: route.replyToMessageId,
          });
          return { providerMessageId: sent.providerMessageId, channel: 'imessage' };
        }
      }
    },
  };
}
