import { and, eq, isNull } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import { captureServerEvent } from '~/lib/analytics/server-capture';

/**
 * How long after execution a calendar placement can be undone. The window derives
 * from actions.executed_at. C3's UNDO surface imports this constant so the button's
 * visibility and the server's gate agree on the same 24h — a single source of truth
 * rather than two drifting copies.
 */
export const UNDO_WINDOW_HOURS = 24;

/** Only a calendar_add is cleanly reversible: the reversal soft-deletes the row it
 * created. A move/cancel undo would need the pre-mutation state, which is not
 * persisted, so they are not reversible via this primitive. */
const REVERSIBLE_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>(['calendar_add']);

export type ReverseResult =
  | { status: 200; familyEventId: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 409; error: string };

/**
 * The UNDO primitive for an executed calendar placement (C3 depends on this).
 *
 * Gates on the real executed state — the action must be a calendar_add, have run
 * (user_visible_state='autonomous' AND executed_at set), and still be inside the
 * 24h window measured from executed_at. Then, in ONE transaction (decline.ts tx
 * shape), it soft-deletes the placed family_events row (the reversalHandle stored
 * in executor_result) AND flips the origin action to 'reverted' /
 * reverted_reason='undone_by_human', writing an immutable audit row for BOTH the
 * soft-delete and the state transition (rule #6). The ICS feed reads family_events
 * live, so the soft-delete drops the event from the next subscription poll — there
 * is no cached calendar to regenerate.
 *
 * The state gate is also the double-undo guard: a second call sees the action in
 * 'reverted' (no longer 'autonomous') and returns 409, so the placement is never
 * soft-deleted twice.
 *
 * X1 (VIL-227): fires `loop_undo` (actionType only — no family/child detail) on a
 * successful reversal, AFTER the transaction commits. `capture` is injected
 * (defaulting to the real captureServerEvent) so tests assert on it without a
 * network call, matching this codebase's other injected-analytics call sites.
 */
export async function reverseExecutedCalendarAction(
  database: Database,
  args: {
    actionId: string;
    familyId: string;
    revertedBy: string;
    now?: Date;
    capture?: typeof captureServerEvent;
  },
): Promise<ReverseResult> {
  const now = args.now ?? new Date();
  const capture = args.capture ?? captureServerEvent;

  const rows = await database
    .select({
      id: schema.actions.id,
      familyId: schema.actions.familyId,
      actionType: schema.actions.actionType,
      userVisibleState: schema.actions.userVisibleState,
      executedAt: schema.actions.executedAt,
      executorResult: schema.actions.executorResult,
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
  if (!REVERSIBLE_ACTION_TYPES.has(action.actionType as ActionType)) {
    return { status: 409, error: 'action_not_reversible' };
  }
  if (action.userVisibleState !== 'autonomous' || !action.executedAt) {
    return { status: 409, error: 'action_not_executed' };
  }
  if (now.getTime() - action.executedAt.getTime() > UNDO_WINDOW_HOURS * 60 * 60 * 1000) {
    return { status: 409, error: 'undo_window_expired' };
  }

  const handle = (action.executorResult as { reversalHandle?: unknown } | null)?.reversalHandle;
  if (typeof handle !== 'string') {
    return { status: 409, error: 'no_reversal_handle' };
  }

  await database.transaction(async (tx) => {
    await tx
      .update(schema.familyEvents)
      .set({ deletedAt: now })
      .where(
        and(
          eq(schema.familyEvents.id, handle),
          eq(schema.familyEvents.familyId, args.familyId),
          isNull(schema.familyEvents.deletedAt),
        ),
      );

    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.revertedBy,
      actionTaken: 'action.calendar_placement_reverted',
      targetTable: 'family_events',
      targetId: handle,
      after: { actionId: action.id, reason: 'undone_by_human' },
    });

    await tx
      .update(schema.actions)
      .set({
        userVisibleState: 'reverted',
        revertedAt: now,
        revertedReason: 'undone_by_human',
      })
      .where(eq(schema.actions.id, action.id));

    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.revertedBy,
      actionTaken: 'action.reverted_by_human',
      targetTable: 'actions',
      targetId: action.id,
    });
  });

  // X1 (VIL-227): fired only after the reversal transaction commits — an aborted
  // undo (a throw inside the tx) never emits it. Best-effort: a telemetry hiccup
  // must not turn an already-committed undo into a thrown error for the caller.
  await capture('loop_undo', args.revertedBy, { actionType: action.actionType }).catch((err) => {
    console.error('loop_undo analytics failed (undo unaffected)', {
      message: err instanceof Error ? err.message : 'unknown error',
    });
  });

  return { status: 200, familyEventId: handle };
}
