import { type Database, schema } from '@hale/db';
import type { CalendarInviteSender } from '@hale/worker/executor';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { productionChannels } from '~/lib/channel/adapters/production';
import { createCalendarInviteSender } from '~/lib/loop/calendar-invite';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import { productionCalendarCancelVoice } from '~/lib/loop/voice/calendar-cancel-voice';
import { productionCalendarInviteVoice } from '~/lib/loop/voice/calendar-invite-voice';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { COMMON_TIME_MINUTES } from './common-time';
import { linqChatAuditKey } from './family-audit';
import {
  type GroupFamilyDirectory,
  type GroupPlan,
  type GroupPlanAttendanceReader,
  type GroupPlanFanOutReport,
  type GroupPlanMessage,
  type GroupPlanNoteWriter,
  createFamilyEventsCopyStore,
  createGroupPlanAttendanceReader,
  createGroupPlanNoteWriter,
  driveGroupPlan,
  existingCopyFamilies,
} from './group-plan-invites';
import type { SendOneToOne } from './group-private-aside';

/**
 * VIL-459 — a time the group picks from Hale's proposal becomes a plan on each family's
 * calendar, through the VIL-455 fan-out: one `family_events` copy and one invite per
 * family that said it is in, in its own words. The plan is the proposal (its audit row id
 * is the plan id), so a second pick never makes a second plan: the same pick changes
 * nothing, and a different offered time moves every copy.
 */

export const COMMON_TIME_PROPOSED = 'linq_multi_family_common_time_proposed';
export const COMMON_TIME_PICKED = 'linq_multi_family_common_time_picked';
export const COMMON_TIME_PLACED = 'linq_multi_family_common_time_placed';
export const COMMON_TIME_PLACE_FAILED = 'linq_multi_family_common_time_place_failed';
const NOTE_TEMPLATE = 'linq:multi_family_common_time_note';
/** What the attendance read sees: the newest lines since the proposal. */
const PLAN_MESSAGES_MAX = 30;

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

/** Linked parents' own lines in this chat after the proposal (never the ask), oldest first. */
async function planMessages(
  database: Database,
  input: {
    chatId: string;
    since: Date;
    familyIds: readonly string[];
    names: ReadonlyMap<string, string | null>;
    stopped: ReadonlySet<string>;
  },
): Promise<GroupPlanMessage[]> {
  const m = schema.channelMessages;
  const rows = await database
    .select({ familyId: m.familyId, userId: m.parentUserId, body: m.body })
    .from(m)
    .where(
      and(
        eq(m.providerChatId, input.chatId),
        eq(m.direction, 'in'),
        inArray(m.familyId, [...input.familyIds]),
        gt(m.sentAt, input.since),
        isNotNull(m.body),
      ),
    )
    .orderBy(desc(m.sentAt))
    .limit(PLAN_MESSAGES_MAX);
  return rows
    .reverse()
    .filter((row) => row.body && !(row.userId && input.stopped.has(row.userId)))
    .map((row) => ({
      familyId: row.familyId,
      senderName: (row.userId && input.names.get(row.userId)) || null,
      text: row.body as string,
    }));
}

/**
 * Place the picked time. Families come from the directory (live joins carrying their own
 * consent for this chat), so a family that left or withdrew gets nothing. Writes one
 * audit row on the picker's family and one on each family whose calendar copy changed
 * or failed to.
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
  ports: CommonTimePlanPorts,
): Promise<GroupPlanFanOutReport> {
  const plan: GroupPlan = {
    groupPlanId: input.proposal.id,
    chatId: input.chatId,
    title: input.title,
    startsAt: input.picked,
    endsAt: new Date(input.picked.getTime() + COMMON_TIME_MINUTES * 60_000),
    location: null,
    cancelled: false,
  };
  const families = await input.directory.familiesInGroup(input.chatId);
  const familyIds = families.map((family) => family.familyId);
  const messages =
    familyIds.length > 0
      ? await planMessages(database, {
          chatId: input.chatId,
          since: input.proposal.occurredAt,
          familyIds,
          names: input.names,
          stopped: input.stopped,
        })
      : [];
  const existing = await existingCopyFamilies(database, plan, familyIds);
  const report = await driveGroupPlan(
    {
      directory: { familiesInGroup: async () => families },
      reader: ports.reader,
      copies: createFamilyEventsCopyStore(database),
      invites: ports.invites,
      noteWriter: ports.noteWriter,
      privateNotes: {
        async send({ familyId, text }) {
          const sent = await ports.sendOneToOne({
            familyId,
            text,
            dedupeKey: `${NOTE_TEMPLATE}:${plan.groupPlanId}:${familyId}:${plan.startsAt.toISOString()}`,
          });
          return sent === 'failed' ? 'not_sent' : 'sent';
        },
      },
    },
    plan,
    messages,
    existing,
  );
  const chatKey = linqChatAuditKey(input.chatId);
  const slot = plan.startsAt.toISOString();
  const placed = report.status === 'done' ? report.families : [];
  const outcomes: Record<string, number> = {};
  for (const family of placed) outcomes[family.outcome] = (outcomes[family.outcome] ?? 0) + 1;
  await database.insert(schema.auditLog).values({
    familyId: input.picker.familyId,
    actor: input.picker.userId,
    actionTaken: COMMON_TIME_PICKED,
    targetTable: 'audit_log',
    targetId: input.proposal.id,
    after: { ...chatKey, slot, status: report.status, outcomes },
  });
  const touched = placed.filter(
    (family) => family.outcome !== 'not_in' && family.outcome !== 'unchanged',
  );
  if (touched.length > 0) {
    await database.insert(schema.auditLog).values(
      touched.map((family) => ({
        familyId: family.familyId,
        actor: 'system',
        actionTaken:
          family.outcome === 'invited' || family.outcome === 'cancelled'
            ? COMMON_TIME_PLACED
            : COMMON_TIME_PLACE_FAILED,
        targetTable: 'audit_log',
        targetId: input.proposal.id,
        after: {
          ...chatKey,
          slot,
          outcome: family.outcome,
          ...(family.note ? { note: family.note } : {}),
        },
      })),
    );
  }
  return report;
}

/** Production: the same invite sender a 1:1 placement uses (VIL-249), model reads and notes. */
export function productionCommonTimePlanPorts(
  database: Database,
  sendOneToOne: SendOneToOne,
): CommonTimePlanPorts {
  const client = () => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
  return {
    reader: createGroupPlanAttendanceReader(client),
    invites: createCalendarInviteSender(database, {
      channels: productionChannels(database),
      renderer: loopTemplateRenderer,
      inviteVoice: productionCalendarInviteVoice(),
      cancelVoice: productionCalendarCancelVoice(),
    }),
    noteWriter: createGroupPlanNoteWriter(client),
    sendOneToOne,
  };
}
