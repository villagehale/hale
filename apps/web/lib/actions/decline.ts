import { eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';

export type DeclineResult =
  | { status: 200 }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 409; error: string };

/**
 * A parent dismissing a drafted action — the "no" half of the consent queue
 * (rule #4: an L1/L2 family must be able to refuse a draft, not only approve it).
 *
 * Validates the same preconditions as approveDraftedAction — cross-family is a 403
 * (it exists but isn't yours), a missing action is 404, a wrong-state action is
 * 409 — then, atomically, moves the action out of 'drafted_for_approval' to
 * 'reverted' (the existing terminal-non-execute state — a dismissed draft never
 * runs) AND writes the immutable audit_log row the refusal requires (rule #6:
 * every action produces an audit row; PIPEDA right-to-access depends on it). No
 * queue send — a declined draft is never handed to the worker.
 */
export async function declineDraftedAction(
  database: Database,
  args: { actionId: string; familyId: string; declinedBy: string },
): Promise<DeclineResult> {
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

  await database.transaction(async (tx) => {
    await tx
      .update(schema.actions)
      .set({
        userVisibleState: 'reverted',
        revertedAt: new Date(),
        revertedReason: 'declined_by_human',
      })
      .where(eq(schema.actions.id, action.id));

    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.declinedBy,
      actionTaken: 'action.declined_by_human',
      targetTable: 'actions',
      targetId: action.id,
    });
  });

  return { status: 200 };
}
