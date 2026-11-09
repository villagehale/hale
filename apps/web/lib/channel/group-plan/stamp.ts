import { type Database, schema } from '@hale/db';
import { and, eq, or, sql } from 'drizzle-orm';
import {
  CHANNEL_AUDIT_ACTION,
  type ChannelDraftPort,
  calendarDraftApprovalSurfaces,
  stampChatKey,
} from '~/lib/channel/coach/draft';
import { channelGroupNoteKey } from '~/lib/coach/note-key';
import { linqChatBlindIndex } from '~/lib/crypto/blind-index';

/**
 * VIL-443 (T17) — which placements are a group's plan.
 *
 * A calendar_add drafted on a turn in the family's own group chat gets one audit row
 * naming that chat, so the executor's invite port can report the placement back to the
 * same group once a parent has said yes. Code writes it after the draft is minted: the
 * model's tools, the payload and the reviewer's input are all unchanged, so the model can
 * neither set nor forget it. A move or cancel is not marked. It is found through the
 * row's own placing action, so editing a group's plan from a 1:1 thread still tells the
 * group.
 *
 * ONLY THE FAMILY'S OWN GROUP. Every group message runs as a group turn, including one
 * in a chat shared with other families or one nobody claimed. A plan made there is not
 * the household group's to hear about, so it is not marked and keeps its 1:1 invites.
 */

export interface GroupPlanOrigin {
  familyId: string;
  /** The parent whose group message drafted it. */
  actor: string;
  actionId: string;
  /** The group turn's thread, which is keyed by the chat it runs in. */
  conversationId: string;
}

export type GroupPlanOriginOutcome = 'recorded' | 'outside_household_group';

export type RecordGroupPlanOrigin = (origin: GroupPlanOrigin) => Promise<GroupPlanOriginOutcome>;

export function groupPlanDraftPort(
  inner: ChannelDraftPort,
  turn: { audience: 'direct' | 'group'; conversationId: string },
  recordOrigin: RecordGroupPlanOrigin,
): ChannelDraftPort {
  if (turn.audience !== 'group') return inner;
  return {
    pendingIdentical: inner.pendingIdentical?.bind(inner),
    approvalWaitsIn: inner.approvalWaitsIn?.bind(inner),
    async draft(input) {
      const result = await inner.draft(input);
      if (input.actionType !== 'calendar_add') return result;
      try {
        const outcome = await recordOrigin({
          familyId: input.familyId,
          actor: input.actor,
          actionId: result.actionId,
          conversationId: turn.conversationId,
        });
        if (outcome === 'outside_household_group') {
          console.info(
            { familyId: input.familyId, actionId: result.actionId },
            'group plan: drafted outside the household group - 1:1 invites, not a group report',
          );
        }
      } catch (err) {
        console.error(
          {
            familyId: input.familyId,
            actionId: result.actionId,
            err: err instanceof Error ? err.name : 'unknown',
          },
          'group plan: origin unrecorded - this plan gets 1:1 invites, not a group report',
        );
      }
      return result;
    },
  };
}

export function productionRecordGroupPlanOrigin(database: Database): RecordGroupPlanOrigin {
  return async ({ familyId, actor, actionId, conversationId }) => {
    const [thread] = await database
      .select({
        noteKey: schema.conversations.noteKey,
        chatId: schema.families.linqGroupChatId,
      })
      .from(schema.conversations)
      .innerJoin(schema.families, eq(schema.families.id, schema.conversations.familyId))
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.familyId, familyId),
        ),
      );
    const chatId = thread?.chatId;
    if (!chatId || thread.noteKey !== channelGroupNoteKey(chatId)) {
      return 'outside_household_group';
    }
    await database.insert(schema.auditLog).values({
      familyId,
      actor,
      actionTaken: 'group_plan.drafted',
      targetTable: 'actions',
      targetId: actionId,
      // The row is immutable and exported, so the chat is named by its keyed index.
      after: { chatKey: linqChatBlindIndex(chatId) },
    });
    return 'recorded';
  };
}

/**
 * The chat key of the household group a group turn drafted this action in, or null when
 * none did. A stamp written before the key carries the raw chat id, which is keyed here.
 */
export async function groupPlanChatKey(
  database: Database,
  familyId: string,
  actionId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.targetTable, 'actions'),
        eq(schema.auditLog.targetId, actionId),
        eq(schema.auditLog.actionTaken, 'group_plan.drafted'),
      ),
    )
    .limit(1);
  return stampChatKey(row?.after);
}

/**
 * The drafts this household group chat answers (VIL-525): those asked in it while it was
 * the household group. A draft asked in a shared or unclaimed chat is never listed here;
 * it waits on the family's private threads.
 */
export async function groupPlanActionIds(
  database: Database,
  input: { familyId: string; chatId: string },
): Promise<ReadonlySet<string>> {
  // A chat that is no longer the household group answers none of them, even though
  // they were the household group's question when they were asked (VIL-595).
  const [family] = await database
    .select({ chatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId));
  if (family?.chatId !== input.chatId) return new Set();
  const chatKey = linqChatBlindIndex(input.chatId);
  const rows = await database
    .select({ targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, input.familyId),
        eq(schema.auditLog.targetTable, 'actions'),
        or(
          and(
            eq(schema.auditLog.actionTaken, CHANNEL_AUDIT_ACTION),
            sql`${schema.auditLog.after}->'origin'->>'chatKey' = ${chatKey}`,
          ),
          and(
            eq(schema.auditLog.actionTaken, 'group_plan.drafted'),
            or(
              sql`${schema.auditLog.after}->>'chatKey' = ${chatKey}`,
              sql`${schema.auditLog.after}->>'chatId' = ${input.chatId}`,
            ),
          ),
        ),
      ),
    );
  const ids = [...new Set(rows.flatMap((row) => (row.targetId ? [row.targetId] : [])))];
  // The query finds every draft asked in this chat; only those on its household-group
  // surface are its own. A shared chat's draft is on the private surface.
  const surfaces = await calendarDraftApprovalSurfaces(database, input.familyId, ids);
  return new Set(
    ids.filter((id) => {
      const surface = surfaces.get(id);
      return surface?.surface === 'household_group' && surface.chatKey === chatKey;
    }),
  );
}

/** Which of these actions a household group answers, in any such chat (VIL-525). */
export async function groupDraftedActionIds(
  database: Database,
  familyId: string,
  actionIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const surfaces = await calendarDraftApprovalSurfaces(database, familyId, actionIds);
  return new Set(actionIds.filter((id) => surfaces.get(id)?.surface === 'household_group'));
}
