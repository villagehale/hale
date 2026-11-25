import { type Database, schema } from '@hale/db';
import type { CalendarInviteSender } from '@hale/worker/executor';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { productionChannels } from '~/lib/channel/adapters/production';
import { createCalendarInviteSender } from '~/lib/loop/calendar-invite';
import { withInviteUnwrittenPage } from '~/lib/loop/calendar-invite-page';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import { productionCalendarCancelVoice } from '~/lib/loop/voice/calendar-cancel-voice';
import { productionCalendarInviteVoice } from '~/lib/loop/voice/calendar-invite-voice';
import { failurePageOpsPager } from '~/lib/monitoring/failure-page';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { linqChatAuditKey } from './family-audit';
import {
  type GroupFamilyDirectory,
  type GroupPlanAttendanceReader,
  type GroupPlanNoteWriter,
  createGroupPlanAttendanceReader,
  createGroupPlanNoteWriter,
} from './group-plan-invites';
import type { SendOneToOne } from './group-private-aside';

/**
 * VIL-459 — a time the group picks from Hale's proposal is recorded. It writes no
 * family's calendar copy and sends no invite: a yes in a group chat reaches a family's
 * calendar only through that parent's own 1:1 OK (VIL-773).
 */

export const COMMON_TIME_PROPOSED = 'linq_multi_family_common_time_proposed';
export const COMMON_TIME_PICKED = 'linq_multi_family_common_time_picked';

export interface CommonTimeProposal {
  id: string;
  occurredAt: Date;
  /** Offered starts still ahead. */
  slots: Date[];
  title: string | null;
}

export interface CommonTimePlanPorts {
  reader: GroupPlanAttendanceReader;
  invites: CalendarInviteSender;
  noteWriter: GroupPlanNoteWriter;
  sendOneToOne: SendOneToOne;
}

/**
 * The newest proposal the group actually saw in this chat, with the offered times still
 * ahead. Null when there is none, it never landed, or every time has passed.
 */
export async function latestCommonTimeProposal(
  database: Database,
  input: { chatId: string; familyIds: readonly string[]; now: Date },
): Promise<CommonTimeProposal | null> {
  if (input.familyIds.length === 0) return null;
  const a = schema.auditLog;
  const [row] = await database
    .select({ id: a.id, occurredAt: a.occurredAt, after: a.after })
    .from(a)
    .where(
      and(
        inArray(a.familyId, [...input.familyIds]),
        eq(a.actionTaken, COMMON_TIME_PROPOSED),
        sql`${a.after}->>'chatKey' = ${linqChatAuditKey(input.chatId).chatKey}`,
      ),
    )
    .orderBy(desc(a.occurredAt))
    .limit(1);
  if (!row) return null;
  const after = row.after as { slots?: unknown; notice?: unknown; title?: unknown };
  if (after.notice !== 'sent' && after.notice !== 'already_sent') return null;
  const slots = (Array.isArray(after.slots) ? after.slots : [])
    .filter((slot): slot is string => typeof slot === 'string')
    .map((slot) => new Date(slot))
    .filter((slot) => slot.getTime() > input.now.getTime());
  if (slots.length === 0) return null;
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    slots,
    title: typeof after.title === 'string' ? after.title : null,
  };
}

/**
 * VIL-643: true when this chat has already sent a proposal built from at least one
 * family's busy times, so a later proposal does not say so again.
 */
export async function chatAlreadyProposedFromBusy(
  database: Database,
  input: { chatId: string; familyIds: readonly string[] },
): Promise<boolean> {
  if (input.familyIds.length === 0) return false;
  const a = schema.auditLog;
  const rows = await database
    .select({ after: a.after })
    .from(a)
    .where(
      and(
        inArray(a.familyId, [...input.familyIds]),
        eq(a.actionTaken, COMMON_TIME_PROPOSED),
        sql`${a.after}->>'chatKey' = ${linqChatAuditKey(input.chatId).chatKey}`,
      ),
    );
  return rows.some((row) => {
    const after = row.after as { checked?: unknown; notice?: unknown };
    if (after.notice !== 'sent' && after.notice !== 'already_sent') return false;
    return typeof after.checked === 'number' && after.checked > 0;
  });
}

export type PickedTimeReport =
  /** The picker's family has no live, consented join here: nothing is written. */
  | { status: 'picker_not_joined' }
  /** The picker stopped Hale in this chat: nothing is written. */
  | { status: 'picker_stopped' }
  /**
   * The pick is recorded, and no family's calendar copy is written and no invite sent:
   * a yes in a group chat never reaches a family's calendar without that parent's own
   * 1:1 OK, and a pick is group words.
   */
  | { status: 'not_placed' };

/**
 * Record the picked time. Families come from the directory (live joins carrying their own
 * consent for this chat), and only a member of one of those families who has not stopped
 * Hale here can pick. Writes one audit row on the picker's family. It places nothing on
 * any family's calendar.
 */
export async function placePickedTime(
  database: Database,
  input: {
    chatId: string;
    proposal: CommonTimeProposal;
    picked: Date;
    title: string;
    /** The parent who picked: the pick's own audit row is on their family. */
    picker: { familyId: string; userId: string };
    directory: GroupFamilyDirectory;
    /** First name the group uses, by user id. */
    names: ReadonlyMap<string, string | null>;
    /** Users who stopped Hale in this chat: their lines are not read. */
    stopped: ReadonlySet<string>;
  },
  _ports: CommonTimePlanPorts,
): Promise<PickedTimeReport> {
  if (input.stopped.has(input.picker.userId)) {
    console.warn({ outcome: 'common_time_pick_stopped' }, 'linq multi-family: pick not placed');
    return { status: 'picker_stopped' };
  }
  const families = await input.directory.familiesInGroup(input.chatId);
  if (!families.some((family) => family.familyId === input.picker.familyId)) {
    console.warn({ outcome: 'common_time_pick_not_joined' }, 'linq multi-family: pick not placed');
    return { status: 'picker_not_joined' };
  }
  await database.insert(schema.auditLog).values({
    familyId: input.picker.familyId,
    actor: input.picker.userId,
    actionTaken: COMMON_TIME_PICKED,
    targetTable: 'audit_log',
    targetId: input.proposal.id,
    after: {
      ...linqChatAuditKey(input.chatId),
      slot: input.picked.toISOString(),
      status: 'not_placed',
      outcomes: {},
    },
  });
  console.info(
    { outcome: 'common_time_pick_not_placed' },
    'linq multi-family: a group pick writes no family calendar',
  );
  return { status: 'not_placed' };
}

/** Production: the same invite sender a 1:1 placement uses (VIL-249), model reads and notes. */
export function productionCommonTimePlanPorts(
  database: Database,
  sendOneToOne: SendOneToOne,
): CommonTimePlanPorts {
  const client = () => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'plan' });
  return {
    reader: createGroupPlanAttendanceReader(client),
    // VIL-719: an invite text the model cannot write tells #ops while the ask policy is on.
    invites: withInviteUnwrittenPage(
      createCalendarInviteSender(database, {
        channels: productionChannels(database),
        renderer: loopTemplateRenderer,
        inviteVoice: productionCalendarInviteVoice(),
        cancelVoice: productionCalendarCancelVoice(),
      }),
      failurePageOpsPager(() => database),
    ),
    noteWriter: createGroupPlanNoteWriter(client),
    sendOneToOne,
  };
}
