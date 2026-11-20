import type { Database } from '@hale/db';
import { sendClaimedGroupLine } from '~/lib/channel/linq/family-outbound';
import { declinePrivilegedGroupSeat } from '~/lib/channel/linq/group-members';
import { type MeaningScreen, sharedMeaningScreen } from '~/lib/channel/meaning-screen/read';
import type {
  DeterministicHandler,
  HandlerContext,
  HandlerVerdict,
} from '~/lib/channel/router/route';
import { type MemoryKindEnv, familyMemoryKindsEnabled } from './kinds';
import { readMemoryRequest } from './request';
import { handleParentMemory } from './store';

/**
 * Claims "what do you know about us" / "forget …" / "correct …" — in any wording and any
 * language, read by the model (`memory_request`), never matched — only while the kinds
 * flag is exactly on. Flag off returns before a read, so the coach still owns the turn.
 * An unread screen claims nothing either. The reply is null when the model does not
 * write one, and nothing else is sent. On a group turn the reply is for the asker alone
 * (`onlyToAsker`). A group mirror goes through the ledgered group door, which refuses
 * any chat that is not this family's claimed group.
 */
export function familyMemoryKindsHandler(
  env?: MemoryKindEnv,
  deps: { screen?: MeaningScreen } = {},
): DeterministicHandler {
  const screen = (): MeaningScreen => deps.screen ?? sharedMeaningScreen();
  return {
    name: 'family_memory_kinds',
    async detects(_database, ctx) {
      if (!familyMemoryKindsEnabled(env ?? process.env)) return false;
      const request = await readMemoryRequest(screen(), ctx.body);
      // A text the screen could not read may still be a "forget": beside a running turn
      // it goes back to its own turn rather than being answered in words alone.
      return request !== null;
    },
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const flags = env ?? process.env;
      if (!familyMemoryKindsEnabled(flags)) return { claimed: false };
      const request = await readMemoryRequest(screen(), ctx.body);
      if (request === null || request === 'unread') return { claimed: false };
      if (
        await declinePrivilegedGroupSeat(database, {
          familyId: ctx.familyId,
          userId: ctx.parentUserId,
          capability: 'family_memory',
        })
      ) {
        return { claimed: true, outcome: 'group_member_not_authorized', reply: null };
      }
      const result = await handleParentMemory(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        body: ctx.body,
        now: ctx.now,
        inboundChannelMessageId: ctx.inboundChannelMessageId,
        env: flags,
        screen: screen(),
        request,
        sendGroup: (chatId, body) => {
          const inbound = ctx.inboundChannelMessageId ?? ctx.now.toISOString();
          return sendClaimedGroupLine(database, {
            familyId: ctx.familyId,
            parentUserId: ctx.parentUserId,
            chatId,
            body,
            now: ctx.now,
            dedupeKey: `linq:memory_kinds:${inbound}`,
            templateKey: 'linq:memory_kinds',
            contentClass: 'family_settings',
          });
        },
      });
      if (!result.claimed) return { claimed: false };
      return {
        claimed: true,
        outcome: result.outcome,
        reply: result.reply,
        templateKey: result.reply ? 'memory_kinds' : undefined,
        ...(result.onlyToAsker ? { onlyToAsker: true as const } : {}),
      };
    },
  };
}
