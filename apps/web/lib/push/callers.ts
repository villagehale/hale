import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import type { PushKind } from './prefs';
import { pushEnabledFor, recordFamilyPushSent, sentPushToFamilyToday } from './prefs';
import { type PushMessage, sendPushToUser } from './send';

/**
 * The notify-a-family callers: the seam between a cron loop (new-picks discovery,
 * health reminders) and the reusable sendPushToUser primitive. One family gets at
 * most one push per kind per day (the push_sends debounce), addressed only to the
 * parents who have that stream enabled, with one audit_log row per send.
 *
 * Defense in depth (rule #1): the pref is re-checked here per parent, so a parent
 * who turned a stream off receives nothing even if a future caller forgets to
 * filter. The audit row (rule #6) carries only the coarse kind + the target
 * user/child ids — never the message body, which is the only place a child's name
 * could appear.
 */

/** The parent roles that receive family push notifications. */
const PARENT_ROLES: Array<(typeof schema.familyMembers.role.enumValues)[number]> = [
  'primary_parent',
  'co_parent',
];

export type NotifyResult =
  | { status: 'sent'; notified: number }
  /** The family already got a push of this kind today; nothing addressed. */
  | { status: 'debounced' };

/** The family's parents (internal user ids) — the candidate recipients. */
async function familyParents(familyId: string, database: Database): Promise<string[]> {
  const rows = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        inArray(schema.familyMembers.role, PARENT_ROLES),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Send one push of `kind` to a family's parents, once per family per day. The
 * message is composed by the caller (which owns the teen-safe copy, rule #1);
 * this only addresses it. A parent with the stream off is skipped (pref re-check),
 * each real send writes a category-only audit row (rule #6), and the family
 * debounce ledger is written once when at least one parent was addressed.
 *
 * `childId` is threaded into the audit row for a health reminder (the target child
 * reference, rule #6) — never the child's name, which lives only in the message.
 */
async function notifyFamily(
  familyId: string,
  kind: PushKind,
  message: PushMessage,
  database: Database,
  childId?: string,
): Promise<NotifyResult> {
  if (await sentPushToFamilyToday(database, familyId, kind)) {
    return { status: 'debounced' };
  }

  const parents = await familyParents(familyId, database);

  let notified = 0;
  for (const userId of parents) {
    if (!(await pushEnabledFor(userId, kind, database))) {
      continue;
    }
    const sent = await sendPushToUser(userId, message, database);
    // Audit/count/ledger ONLY a real send (rule #6): a disabled flag or a
    // token-less parent must not fabricate a 'push_sent' row or debounce a
    // send that never happened (mirrors the digest's skip-before-record).
    if (sent.status !== 'sent') {
      continue;
    }
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'push_sent',
      targetTable: 'push_sends',
      targetId: userId,
      after: childId ? { kind, childId } : { kind },
    });
    notified += 1;
  }

  if (notified > 0) {
    await recordFamilyPushSent(database, familyId, kind);
  }

  return { status: 'sent', notified };
}

/** A family's coarse area (rule #1: the only location granularity that exists) —
 * or null when unset, in which case there is no place to name and no push. */
async function familyCoarseArea(familyId: string, database: Database): Promise<string | null> {
  const rows = await database
    .select({ areaCoarse: schema.families.areaCoarse })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return rows[0]?.areaCoarse ?? null;
}

/**
 * Notify a family that its village has `newCount` new picks. Rule #1: the copy is
 * a coarse count + the family's coarse area only — never a child name, never an
 * activity title with child attribution. A family with no coarse area has nowhere
 * to name, so nothing is sent.
 */
export async function notifyFamilyNewPicks(
  familyId: string,
  newCount: number,
  database: Database = defaultDb(),
): Promise<NotifyResult | { status: 'no_area' }> {
  const coarseArea = await familyCoarseArea(familyId, database);
  if (!coarseArea) {
    return { status: 'no_area' };
  }
  return notifyFamily(
    familyId,
    'new_picks',
    {
      title: 'Your village has new picks',
      body: `${newCount} new ${newCount === 1 ? 'thing' : 'things'} near ${coarseArea}`,
    },
    database,
  );
}

/**
 * Notify a family of an upcoming health item for one child. The caller composes
 * the teen-safe copy (rule #1: a child 13+ gets category-only, no name) and passes
 * the child id for the audit reference (rule #6).
 */
export function notifyFamilyHealthReminder(
  familyId: string,
  childId: string,
  message: PushMessage,
  database: Database = defaultDb(),
): Promise<NotifyResult> {
  return notifyFamily(familyId, 'health_reminder', message, database, childId);
}
