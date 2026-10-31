import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import type { ChannelDraftPort } from '~/lib/channel/coach/draft';
import { channelGroupNoteKey } from '~/lib/coach/note-key';

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
  turn: {
    audience: 'direct' | 'group';
    conversationId: string;
    groupChatId?: string | null;
  },
  recordOrigin: RecordGroupPlanOrigin,
): ChannelDraftPort {
  if (turn.audience !== 'group') return inner;
  const pendingIdentical = inner.pendingIdentical;
  return {
    pendingIdentical: pendingIdentical
      ? (input) =>
          pendingIdentical({
            ...input,
            audience: 'group',
            ...(turn.groupChatId ? { groupChatId: turn.groupChatId } : {}),
          })
      : undefined,
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
      after: { chatId },
    });
    return 'recorded';
  };
}

/** The family group chat a group turn drafted this action in, or null when none did. */
export async function groupPlanChatId(
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
  const chatId = (row?.after as { chatId?: unknown } | null | undefined)?.chatId;
  return typeof chatId === 'string' ? chatId : null;
}

/** Every action a turn in this family group chat drafted (`group_plan.drafted`). */
export async function groupPlanActionIds(
  database: Database,
  input: { familyId: string; chatId: string },
): Promise<ReadonlySet<string>> {
  const rows = await database
    .select({ targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, input.familyId),
        eq(schema.auditLog.targetTable, 'actions'),
        eq(schema.auditLog.actionTaken, 'group_plan.drafted'),
        sql`${schema.auditLog.after}->>'chatId' = ${input.chatId}`,
      ),
    );
  return new Set(rows.flatMap((row) => (row.targetId ? [row.targetId] : [])));
}
