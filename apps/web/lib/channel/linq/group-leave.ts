import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import * as door from '~/lib/channel/outbound-transport';
import { cancelGroupReminders } from '~/lib/loop/reminders/group/store';
import { linqGroupLeaveEnabled } from './config';
import { listLinqParticipantHandles } from './transport';

/**
 * VIL-477 · Hale leaves a group chat, and only on the family's explicit ask.
 *
 * Code owns the guard; Hale's AI owns the decision and every word. The caller (the
 * group turn) passes `explicitAsk: true` only when the model read a member asking
 * Hale to leave. Any confirmation is written by the model before this runs — this
 * module sends nothing to a parent and has no fixed copy.
 *
 * Linq leaves only iMessage groups with 4+ active participants including Hale, so a
 * group must show 3+ other handles. Leaving is one-way: Hale returns only if a member
 * re-adds it. Dark unless `LINQ_GROUP_LEAVE_ENABLED` is exactly `true`. Every Linq
 * call goes through outbound-transport (the capture door).
 */
export type GroupLeaveOutcome =
  | { status: 'left' }
  | { status: 'skipped'; reason: 'flag_off' | 'no_explicit_ask' | 'not_group' | 'too_small' }
  | { status: 'failed'; reason: string };

export interface GroupLeavePorts {
  listParticipants: typeof listLinqParticipantHandles;
  leave: typeof door.leaveLinqChat;
}

const defaultPorts: GroupLeavePorts = {
  listParticipants: listLinqParticipantHandles,
  leave: door.leaveLinqChat,
};

/** Linq: 4+ active participants including Hale → 3+ other handles. */
export const MIN_OTHER_HANDLES_TO_LEAVE = 3;

export type GroupLeaveEligibility =
  | { status: 'eligible' }
  | Exclude<GroupLeaveOutcome, { status: 'left' }>;

/**
 * The same guard `leaveGroupOnFamilyAsk` runs, without leaving. The model's verb asks
 * this BEFORE it writes its reply, so a leave the guard would decline is known while
 * the model can still say so honestly (it stays in the chat).
 */
export async function groupLeaveEligibility(
  input: { chatId: string; explicitAsk: boolean },
  ports: Pick<GroupLeavePorts, 'listParticipants'> = defaultPorts,
): Promise<GroupLeaveEligibility> {
  if (!linqGroupLeaveEnabled()) return { status: 'skipped', reason: 'flag_off' };
  if (input.explicitAsk !== true) return { status: 'skipped', reason: 'no_explicit_ask' };
  const chat = await ports.listParticipants({ chatId: input.chatId });
  if (chat.status !== 'ok') {
    return { status: 'failed', reason: chat.status === 'refused' ? chat.code : chat.status };
  }
  if (chat.isGroup !== true) return { status: 'skipped', reason: 'not_group' };
  if (new Set(chat.handles).size < MIN_OTHER_HANDLES_TO_LEAVE) {
    return { status: 'skipped', reason: 'too_small' };
  }
  return { status: 'eligible' };
}

export async function leaveGroupOnFamilyAsk(
  input: { chatId: string; explicitAsk: boolean },
  ports: GroupLeavePorts = defaultPorts,
): Promise<GroupLeaveOutcome> {
  const guard = await groupLeaveEligibility(input, ports);
  if (guard.status !== 'eligible') return guard;
  const result = await ports.leave({ chatId: input.chatId });
  if (result.status === 'accepted') return { status: 'left' };
  return { status: 'failed', reason: result.status === 'refused' ? result.code : result.status };
}

/**
 * After Linq ACCEPTS a family-asked leave: release the household's claim on this chat
 * (so later group sends never target a chat Hale already left), cancel group-bound work,
 * and write the immutable audit row. Independent of `LINQ_GROUP_ONBOARDING_V2_ENABLED`
 * (Design blocker). Scoped to this family + this chat; idempotent — the removal webhook
 * that may follow finds nothing claimed and writes no second leave row.
 */
export async function releaseGroupOnLeave(
  database: Database,
  input: { familyId: string; chatId: string; askedBy: string | null; now: Date },
): Promise<{ released: boolean }> {
  const released = await database
    .update(schema.families)
    .set({ linqGroupChatId: null, updatedAt: input.now })
    .where(
      and(
        eq(schema.families.id, input.familyId),
        eq(schema.families.linqGroupChatId, input.chatId),
      ),
    )
    .returning({ id: schema.families.id });
  await cancelGroupReminders(database, {
    chatId: input.chatId,
    reason: 'group_ejected',
    now: input.now,
  });
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.askedBy ?? 'system',
    actionTaken: 'linq_group_left_on_ask',
    targetTable: 'families',
    targetId: input.familyId,
    after: { claimReleased: released.length > 0 },
  });
  return { released: released.length > 0 };
}
