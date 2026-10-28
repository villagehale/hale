import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { ChannelDraftPort } from '~/lib/channel/coach/draft';

/**
 * VIL-443 (T17) — which placements are a group's plan.
 *
 * A calendar_add drafted on a family-group turn gets one audit row naming that origin,
 * so the executor's invite port can report the placement back to the group once a parent
 * has said yes. Code writes it after the draft is minted: the model's tools, the payload
 * and the reviewer's input are all unchanged, so the model can neither set nor forget it.
 * A move or cancel is not marked. It is found through the row's own placing action, so
 * editing a group's plan from a 1:1 thread still tells the group.
 */

export interface GroupPlanOrigin {
  familyId: string;
  /** The parent whose group message drafted it. */
  actor: string;
  actionId: string;
}

export type RecordGroupPlanOrigin = (origin: GroupPlanOrigin) => Promise<void>;

export function groupPlanDraftPort(
  inner: ChannelDraftPort,
  audience: 'direct' | 'group',
  recordOrigin: RecordGroupPlanOrigin,
): ChannelDraftPort {
  if (audience !== 'group') return inner;
  return {
    async draft(input) {
      const result = await inner.draft(input);
      if (input.actionType !== 'calendar_add') return result;
      try {
        await recordOrigin({
          familyId: input.familyId,
          actor: input.actor,
          actionId: result.actionId,
        });
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
  return async ({ familyId, actor, actionId }) => {
    await database.insert(schema.auditLog).values({
      familyId,
      actor,
      actionTaken: 'group_plan.drafted',
      targetTable: 'actions',
      targetId: actionId,
    });
  };
}

/** True only when a group turn drafted this action. */
export async function isGroupPlanAction(
  database: Database,
  familyId: string,
  actionId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.auditLog.id })
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
  return row !== undefined;
}
