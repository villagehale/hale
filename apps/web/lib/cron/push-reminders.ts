import type { Database } from '@hale/db';
import type { ChildCompanionView } from '~/lib/companion/queries';
import { companionForFamily } from '~/lib/companion/queries';
import { notifyFamilyHealthReminder } from '~/lib/push/callers';
import type { PushMessage } from '~/lib/push/send';
import { MAX_FAMILIES_PER_RUN, selectFamiliesForRun } from './families';

/**
 * The daily health-reminder cron: for each family, find a child with a curated
 * health item coming up (immunization / well-child visit) that isn't marked done,
 * and push the family a gentle heads-up — at most one per family per day (the
 * push_sends debounce inside the notify caller).
 *
 * Reuses the SAME age-derived health schedule + done markers the companion page
 * reads (companionForFamily → companionForChild), so the reminder can never
 * disagree with what the app shows.
 *
 * Rule #1 (teen redaction): a child 13+ (stage 'teenager', the 156-month
 * deriveStage boundary) gets CATEGORY-ONLY copy with no name — the same
 * age-based gate the rest of the product uses, not a classifier flag. A non-teen
 * child's first name is allowed to the family's own devices.
 */

/** How soon a not-done health item must be due to trigger a reminder. `dueInWeeks`
 * is the companion view's coarse weeks-until-due signal, so "within ~7 days" is
 * due-now-or-within-about-a-week (0 or 1 whole weeks out). An item already past
 * due (negative) is not "coming up" and is skipped. */
const REMINDER_WINDOW_WEEKS = 1;

export type PushRemindersResult =
  | { status: 'notified' }
  /** No child had a not-done item inside the reminder window. */
  | { status: 'nothing_due' }
  /** A child had a due item, but the family already got a health push today. */
  | { status: 'debounced' };

export interface PushRemindersCronResult {
  processed: number;
  results: Array<
    | { familyId: string; result: PushRemindersResult }
    | { familyId: string; error: string }
  >;
}

/** The teen-safe reminder copy for one child (rule #1): a non-teen child's first
 * name is allowed; a teen (13+) gets category-only, never a name. */
function reminderMessage(childCompanion: ChildCompanionView): PushMessage {
  const title = 'Health reminder';
  if (childCompanion.stage === 'teenager') {
    return { title, body: 'A health item is coming up' };
  }
  return { title, body: `A health item is coming up for ${childCompanion.name}` };
}

/** The first child (soonest-due first, since children load DOB-ordered and each
 * child's nextHealth is soonest-first) with a not-done item inside the window. */
function childWithDueItem(children: ChildCompanionView[]): ChildCompanionView | null {
  for (const child of children) {
    const soonest = child.nextHealth.find(
      (item) => !item.done && item.dueInWeeks >= 0 && item.dueInWeeks <= REMINDER_WINDOW_WEEKS,
    );
    if (soonest) return child;
  }
  return null;
}

export async function runHealthReminderForFamily(
  familyId: string,
  database: Database,
  now: Date = new Date(),
): Promise<PushRemindersResult> {
  const children = await companionForFamily(familyId, database, now);
  const child = childWithDueItem(children);
  if (!child) {
    return { status: 'nothing_due' };
  }

  const result = await notifyFamilyHealthReminder(
    familyId,
    child.id,
    reminderMessage(child),
    database,
  );
  return result.status === 'debounced' ? { status: 'debounced' } : { status: 'notified' };
}

/**
 * The daily push-reminder cron: a heads-up for each family with an upcoming health
 * item, bounded by the per-run family cap. A per-family failure is recorded against
 * that family and the loop continues — one bad family can't starve the batch.
 */
export async function runPushRemindersCron(
  database: Database,
  now: Date = new Date(),
): Promise<PushRemindersCronResult> {
  const familyIds = await selectFamiliesForRun(database, MAX_FAMILIES_PER_RUN.pushReminders);

  const results: PushRemindersCronResult['results'] = [];
  for (const familyId of familyIds) {
    try {
      const result = await runHealthReminderForFamily(familyId, database, now);
      results.push({ familyId, result });
    } catch (err) {
      results.push({ familyId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { processed: familyIds.length, results };
}
