import { eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import {
  type ApprovedActionPayload,
  approvedActionPayloadSchema,
} from '@hale/tools-contracts';

/**
 * Minimal queue surface the approve flow needs — just `send`. Injected so the
 * precondition + payload-build logic is unit-testable without a real pg-boss.
 */
export interface ApproveQueue {
  send(name: string, data: ApprovedActionPayload): Promise<string | null>;
}

export type ApproveResult =
  | { status: 202; payload: ApprovedActionPayload }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 409; error: string };

/**
 * Validates that `actionId` exists, belongs to `familyId`, and is in
 * `drafted_for_approval`, then enqueues an actions.approved payload stamped with
 * the approving Clerk user id. The worker (other maker) does the actual
 * execution — this only records the human's consent and hands it off.
 *
 * Order matters: cross-family is a 403 (it exists but isn't yours), a missing
 * action is 404, and a wrong-state action is 409 (no enqueue). No event is sent
 * unless every precondition holds — an approval must never fire a real action
 * the caller isn't entitled to (hard rule #4).
 */
export async function approveDraftedAction(
  database: Database,
  queue: ApproveQueue,
  args: { actionId: string; familyId: string; approvedBy: string },
): Promise<ApproveResult> {
  const rows = await database
    .select({
      id: schema.actions.id,
      familyId: schema.actions.familyId,
      userVisibleState: schema.actions.userVisibleState,
    })
    .from(schema.actions)
    .where(eq(schema.actions.id, args.actionId))
    .limit(1);

  const action = rows[0];
  if (!action) {
    return { status: 404, error: 'action_not_found' };
  }
  if (action.familyId !== args.familyId) {
    return { status: 403, error: 'action_belongs_to_another_family' };
  }
  if (action.userVisibleState !== 'drafted_for_approval') {
    return { status: 409, error: 'action_not_awaiting_approval' };
  }

  const payload: ApprovedActionPayload = approvedActionPayloadSchema.parse({
    action_id: action.id,
    family_id: action.familyId,
    approved_by: args.approvedBy,
    approved_at: new Date().toISOString(),
  });

  await queue.send('actions.approved', payload);
  return { status: 202, payload };
}
