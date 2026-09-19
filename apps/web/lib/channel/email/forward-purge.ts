import { type Database, schema } from '@hale/db';
import { and, eq, lt, sql } from 'drizzle-orm';

/**
 * THE THREE-DAY PROMISE, kept (VIL-352 rung 3a).
 *
 * The ask tells a parent, in their own inbox: *"If you do nothing, I'll forget this
 * message in three days."* That sentence is the only thing standing between a third
 * party's raw document and an indefinite stay in our database, so it is a mechanism
 * rather than a copy line — and it ships with the door that makes the promise, not with
 * the rung after it (rule #1).
 *
 * TWO THINGS LAPSE, not one. The raw body goes, obviously. The *question* goes with it:
 * a `pending` sender whose held forwards have all expired is a household that was asked
 * something three days ago and never answered, and leaving that row behind would mean
 * the next forward from that school is held in silence against a question nobody
 * remembers. Dropping it back to undecided makes the next forward ask again — which is
 * the honest behaviour and, not incidentally, the only one that is visible.
 *
 * WHAT IS NEVER SWEPT: a sender the family decided about. `allowed` and `blocked` are
 * answers, not questions, and they do not expire.
 *
 * It rides the existing lifecycle sweep (`/api/cron/attachment-sweep`, minute 37) rather
 * than a cron slot of its own — the same route already purges the other bounded store a
 * parent's inaction leaves behind.
 */

/** The raw retention bound the ask copy states in words. */
export const PENDING_FORWARD_TTL_MS = 72 * 60 * 60 * 1000;

export interface ForwardSweepSummary {
  /** Raw forwarded documents deleted. */
  purged: number;
  /** Unanswered questions dropped back to undecided. */
  senders: number;
}

export async function sweepExpiredForwards(
  database: Database,
  now: Date = new Date(),
): Promise<ForwardSweepSummary> {
  const cutoff = new Date(now.getTime() - PENDING_FORWARD_TTL_MS);

  const expired = await database
    .select({ familyId: schema.emailForwardsPending.familyId })
    .from(schema.emailForwardsPending)
    .where(lt(schema.emailForwardsPending.createdAt, cutoff));

  const lapsed = await database
    .select({
      id: schema.familyForwardSenders.id,
      familyId: schema.familyForwardSenders.familyId,
    })
    .from(schema.familyForwardSenders)
    .where(
      and(
        eq(schema.familyForwardSenders.state, 'pending'),
        lt(schema.familyForwardSenders.createdAt, cutoff),
      ),
    );

  const families = new Set([
    ...expired.map((row) => row.familyId),
    ...lapsed.map((row) => row.familyId),
  ]);

  const summary: ForwardSweepSummary = { purged: 0, senders: 0 };
  for (const familyId of families) {
    await database.transaction(async (tx) => {
      const rawGone = await tx
        .delete(schema.emailForwardsPending)
        .where(
          and(
            eq(schema.emailForwardsPending.familyId, familyId),
            lt(schema.emailForwardsPending.createdAt, cutoff),
          ),
        )
        .returning({ id: schema.emailForwardsPending.id });

      // The emptiness is asserted INSIDE the delete, not read and then trusted: a forward
      // arriving against this sender between the two would otherwise lose its held row to
      // the cascade. Re-asserting `pending` for the same reason — a YES landing mid-sweep
      // is a decision, and a decision never lapses.
      let sendersGone = 0;
      for (const sender of lapsed.filter((row) => row.familyId === familyId)) {
        const dropped = await tx
          .delete(schema.familyForwardSenders)
          .where(
            and(
              eq(schema.familyForwardSenders.id, sender.id),
              eq(schema.familyForwardSenders.state, 'pending'),
              sql`not exists (select 1 from ${schema.emailForwardsPending} where ${schema.emailForwardsPending.senderId} = ${schema.familyForwardSenders.id})`,
            ),
          )
          .returning({ id: schema.familyForwardSenders.id });
        sendersGone += dropped.length;
      }

      if (rawGone.length === 0 && sendersGone === 0) return;
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'email_forward_raw_purged',
        // One row per HOUSEHOLD swept, so the target is the household: the counts in
        // `after` are an aggregate over many rows and there is no single
        // `email_forwards_pending` id this row could honestly point at.
        targetTable: 'families',
        targetId: familyId,
        after: { purged: rawGone.length, senders: sendersGone },
      });
      summary.purged += rawGone.length;
      summary.senders += sendersGone;
    });
  }

  return summary;
}
