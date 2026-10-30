import type { ActionType } from '@hale/types';

/**
 * The one definition of what can be undone and for how long.
 *
 * Extracted so the SURFACE that offers the control and the SERVER that performs the
 * reversal read the same rule. Two copies would drift, and the failure is the worst
 * shape a consent surface has: a button that is offered and then refused, or one that
 * is hidden on a row the server would happily reverse.
 *
 * Pure — no DB, no analytics — so the mappers can import it without dragging I/O into
 * a render path. reverse-calendar.ts keeps its own granular checks (it distinguishes
 * "not reversible" from "not executed" from "window expired" for the caller); it takes
 * the SET and the WINDOW from here rather than declaring its own.
 */

/**
 * How long after execution a calendar placement can be undone, measured from
 * actions.executed_at.
 */
export const UNDO_WINDOW_HOURS = 24;

/**
 * Only a calendar_add is cleanly reversible: the reversal soft-deletes the row it
 * created. A move/cancel undo would need the pre-mutation state, which is not
 * persisted, so they are not reversible via this primitive.
 */
export const UNDOABLE_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'calendar_add',
]);

/** Whether the undo window is still open for something executed at `executedAt`. */
export function withinUndoWindow(executedAt: Date, now: Date): boolean {
  return now.getTime() - executedAt.getTime() <= UNDO_WINDOW_HOURS * 60 * 60 * 1000;
}

/**
 * Whether an action can be undone RIGHT NOW — the predicate the surfaces show the
 * control on. Mirrors reverse-calendar's gate exactly: a reversible type, actually
 * executed (state 'autonomous' with an executed_at), and still inside the window.
 */
export function isUndoable(
  action: { actionType: string; userVisibleState: string; executedAt: Date | null },
  now: Date,
): boolean {
  if (!UNDOABLE_ACTION_TYPES.has(action.actionType as ActionType)) return false;
  if (action.userVisibleState !== 'autonomous' || action.executedAt === null) return false;
  return withinUndoWindow(action.executedAt, now);
}
