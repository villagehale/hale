import type { Database } from '@hale/db';
import type { ParentIntentReading } from '~/lib/channel/intent/types';
import { sendClaimedGroupLine } from '~/lib/channel/linq/family-outbound';
import { declinePrivilegedGroupSeat } from '~/lib/channel/linq/group-members';
import type {
  DeterministicHandler,
  HandlerContext,
  HandlerVerdict,
} from '~/lib/channel/router/route';
import {
  type MemoryKindEnv,
  type MemoryParentIntent,
  familyMemoryKindsEnabled,
  parseMemoryParentIntent,
} from './kinds';
import { handleParentMemory } from './store';

function memoryDirected(
  reading: ParentIntentReading | null | undefined,
): MemoryParentIntent | null {
  if (reading?.intent !== 'memory' || !reading.value) return null;
  if (reading.value === 'recall')
    return { kind: 'recall', needle: null, factKey: null, value: null };
  if (reading.value === 'forget')
    return { kind: 'forget', needle: null, factKey: null, value: null };
  if (reading.value.startsWith('forget:')) {
    const needle = reading.value.slice('forget:'.length).trim();
    return { kind: 'forget', needle: needle || null, factKey: null, value: null };
  }
  if (reading.value.startsWith('correct:')) {
    const rest = reading.value.slice('correct:'.length);
    const split = rest.indexOf(':');
    if (split <= 0) return null;
    return {
      kind: 'correct',
      needle: null,
      factKey: rest.slice(0, split).trim(),
      value: rest.slice(split + 1).trim(),
    };
  }
  return null;
}

/**
 * Claims "what do you know" / "forget …" / "correct …" only while the kinds
 * flag is exactly on. Flag off returns before a read, so the coach still
 * owns the turn. The reply string is null unless the copy gate is also
 * exactly true — the placeholder must not reach the transport before Sloane
 * locks it. A group mirror goes through the ledgered group door, which
 * refuses any chat that is not this family's claimed group.
 */
export function familyMemoryKindsHandler(env?: MemoryKindEnv): DeterministicHandler {
  return {
    name: 'family_memory_kinds',
    async handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict> {
      const flags = env ?? process.env;
      if (!familyMemoryKindsEnabled(flags)) return { claimed: false };
      if (ctx.parentIntent && ctx.parentIntent.intent !== 'memory') return { claimed: false };
      const directed = ctx.parentIntent ? memoryDirected(ctx.parentIntent) : undefined;
      if (ctx.parentIntent?.intent === 'memory' && !directed) return { claimed: false };
      const parsed = directed ?? parseMemoryParentIntent(ctx.body);
      if (
        parsed &&
        (await declinePrivilegedGroupSeat(database, {
          familyId: ctx.familyId,
          userId: ctx.parentUserId,
          capability: 'family_memory',
        }))
      ) {
        return { claimed: true, outcome: 'group_member_not_authorized', reply: null };
      }
      const result = await handleParentMemory(database, {
        familyId: ctx.familyId,
        parentUserId: ctx.parentUserId,
        body: ctx.body,
        now: ctx.now,
        inboundChannelMessageId: ctx.inboundChannelMessageId,
        directed,
        env: flags,
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
      };
    },
  };
}
