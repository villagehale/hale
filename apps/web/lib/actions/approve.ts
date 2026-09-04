import { eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import {
  type ApprovedActionPayload,
  approvedActionPayloadSchema,
} from '@hale/tools-contracts';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';

/**
 * Minimal queue surface the approve flow needs — just `send`. Injected so the
 * precondition + payload-build logic is unit-testable without a real pg-boss.
 */
export interface ApproveQueue {
  send(
    name: string,
    data: ApprovedActionPayload,
    options?: { expireInSeconds: number; id: string },
  ): Promise<string | null>;
}

export type ApproveResult =
  | { status: 202; payload: ApprovedActionPayload }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 409; error: string };

/**
 * Validates that `actionId` exists, belongs to `familyId`, and is in
 * `drafted_for_approval`, then enqueues an actions.approved payload stamped with
 * the approving user id. The worker (other maker) does the actual
 * execution — this only records the human's consent and hands it off.
 *
 * Order matters: cross-family is a 403 (it exists but isn't yours), a missing
 * action is 404, and a wrong-state OR non-approved-verdict action is 409 (no
 * enqueue). No event is sent unless every precondition holds — an approval must
 * never fire a real action the caller isn't entitled to (hard rule #4), and a
 * draft the reviewer did not approve is never executable by a parent's click
 * (hard rule #3): the reviewer's verdict is a structural gate, not advisory.
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
      reviewerVerdict: schema.actions.reviewerVerdict,
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
  if (action.reviewerVerdict !== 'approved') {
    return { status: 409, error: 'action_not_reviewer_approved' };
  }

  const payload: ApprovedActionPayload = approvedActionPayloadSchema.parse({
    action_id: action.id,
    family_id: action.familyId,
    approved_by: args.approvedBy,
    approved_at: new Date().toISOString(),
  });

  // The job ID is the action id — one action is one execution is one job, the identity
  // the inbound leg already rides (channel/twilio/deps.ts sendOptions): pg-boss's
  // insert ends in ON CONFLICT DO NOTHING, so a double-tapped Approve, or the SMS
  // "YES" arc racing the web button, creates ONE job instead of two deliveries that
  // both pass the executor's gate (audit P1-4). expireInSeconds is set per-job so it
  // applies regardless of the queue default.
  const jobId = await queue.send('actions.approved', payload, {
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    id: action.id,
  });
  if (!jobId) {
    // Null means a job with this id already exists: the approval is already on its
    // way, exactly once. Named rather than silent (rule #11); still a 202, because
    // "your approval is being executed" is true either way.
    console.info(
      { actionId: action.id },
      'approve: actions.approved job already exists for this action — nothing new enqueued',
    );
  }
  return { status: 202, payload };
}
