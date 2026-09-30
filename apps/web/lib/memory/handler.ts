import type { Database } from '@hale/db';
import { linqApiKey } from '~/lib/channel/linq/config';
import { sendLinqChatMessage } from '~/lib/channel/linq/transport';
import type {
  DeterministicHandler,
  HandlerContext,
  HandlerVerdict,
} from '~/lib/channel/router/route';
import { type MemoryKindEnv, familyMemoryKindsEnabled } from './kinds';
import { handleParentMemory } from './store';

/**
 * Group chat only. The chat id is the family's claimed Linq group, chosen
 * by the caller. A missing API key is named `not_configured` and sends nothing.
 * This never looks up a 1:1 chat.
 */
async function sendGroupOnly(chatId: string, body: string): Promise<'sent' | 'not_configured'> {
  if (!linqApiKey()) return 'not_configured';
  await sendLinqChatMessage({ chatId, text: body });
  return 'sent';
}

/**
 * Claims "what do you know" / "forget …" / "correct …" only while the kinds
 * flag is exactly on. Flag off returns before a read, so the coach still
 * owns the turn. The reply string is null unless the copy gate is also
 * exactly true — the placeholder must not reach the transport before Sloane
 * locks it.
 */
export function familyMemoryKindsHandler(env?: MemoryKindEnv): DeterministicHandler {
  return {
    name: 'family_memory_kinds',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const flags = env ?? process.env;
      if (!familyMemoryKindsEnabled(flags)) return { claimed: false };
      const result = await handleParentMemory(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        body: ctx.body,
        now: ctx.now,
        inboundChannelMessageId: ctx.inboundChannelMessageId,
        env: flags,
        sendGroup: sendGroupOnly,
      });
      if (!result.claimed) return { claimed: false };
      return {
        claimed: true,
        outcome: result.outcome,
        reply: result.reply,
        templateKey: result.reply ? 'memory_kinds' : undefined,
      };
    },
  };
}
