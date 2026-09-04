import { type Database, schema } from '@hale/db';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';

/**
 * The claim sweep — delivery truth for the EXECUTOR's sends, riding the same cron
 * tick as the Twilio delivery-truth sweep (delivery-sweep.ts) rather than minting a
 * third sweep system.
 *
 * An `outbound_sends` row is the executor's claim-before-send idempotency gate:
 * inserted BEFORE the provider send, confirmed (sent_at) only after the provider
 * acknowledges. The gap between the two is the crash window — and until this sweep,
 * its residue had ZERO readers: a worker that died between claim and send left a
 * sent_at-null row nobody selected, while the redelivery that followed read the
 * existing claim as "already sent" and marked the action done. An approved email
 * that never went out was structurally indistinguishable from one that did.
 *
 * THE INVARIANT (rule #11): a claim without a confirm past {@link
 * CLAIM_UNCONFIRMED_AGE_MS} becomes a NAMED outcome — an audit row (rule #6), a log
 * line, a summary count — exactly once. The once is `swept_at`, the sweep's own
 * claim on reporting: a guarded UPDATE ... WHERE swept_at IS NULL wins or loses in
 * the database, the same idiom the executor's claim itself uses (and the reason a
 * row the confirm reaches mid-sweep is counted, never re-reported).
 *
 * The sweep only REPORTS. It does not re-send (the send may have happened — a crash
 * between send and confirm looks identical, and a re-send would double-email the
 * parent) and it does not touch the action row. The named residue is what makes the
 * founder's follow-up possible; silence is what made it impossible.
 */

/** How long a claim may sit unconfirmed before the sweep names it. Claim → send →
 * confirm normally completes in seconds inside one drain job; the drain's wall
 * budget is 800s, so at fifteen minutes no in-flight send can still confirm. */
export const CLAIM_UNCONFIRMED_AGE_MS = 15 * 60 * 1000;

/** DB-only work (no provider calls), so the batch can be generous; a deeper backlog
 * drains across ticks. */
export const CLAIM_SWEEP_BATCH_LIMIT = 200;

export interface UnconfirmedClaimRow {
  id: string;
  actionId: string;
  familyId: string;
  claimedAt: Date;
}

/** Stale unconfirmed, unreported claims, oldest first. The join to actions is what
 * gives the audit row its family. */
export async function selectUnconfirmedClaims(
  database: Database,
  now: Date,
): Promise<UnconfirmedClaimRow[]> {
  const staleBefore = new Date(now.getTime() - CLAIM_UNCONFIRMED_AGE_MS);
  const s = schema.outboundSends;
  return database
    .select({
      id: s.id,
      actionId: s.actionId,
      familyId: schema.actions.familyId,
      claimedAt: s.claimedAt,
    })
    .from(s)
    .innerJoin(schema.actions, eq(s.actionId, schema.actions.id))
    .where(and(isNull(s.sentAt), isNull(s.sweptAt), lt(s.claimedAt, staleBefore)))
    .orderBy(asc(s.claimedAt))
    .limit(CLAIM_SWEEP_BATCH_LIMIT);
}

export interface ClaimSweepDeps {
  database: Database;
  log: Pick<Console, 'warn' | 'error'>;
  now?: () => Date;
}

/** Every claim's fate this tick, named (rule #11): the summary is the cron's JSON. */
export interface ClaimSweepSummary {
  scanned: number;
  /** Claims named this tick: swept_at stamped, audit row written. */
  swept: number;
  /** The guarded stamp matched nothing: a confirm (or another sweep) got there first. */
  alreadyResolved: number;
  /** A claim whose processing threw; logged, and it did not strand the batch. */
  rowErrors: number;
}

export async function sweepUnconfirmedClaims(deps: ClaimSweepDeps): Promise<ClaimSweepSummary> {
  const now = deps.now?.() ?? new Date();
  const rows = await selectUnconfirmedClaims(deps.database, now);
  const summary: ClaimSweepSummary = {
    scanned: rows.length,
    swept: 0,
    alreadyResolved: 0,
    rowErrors: 0,
  };

  for (const row of rows) {
    try {
      // The stamp is the claim on reporting, guarded on both nulls: a confirm landing
      // mid-sweep wins (the send happened after all), and a concurrent sweep loses.
      const stamped = await deps.database
        .update(schema.outboundSends)
        .set({ sweptAt: now })
        .where(
          and(
            eq(schema.outboundSends.id, row.id),
            isNull(schema.outboundSends.sweptAt),
            isNull(schema.outboundSends.sentAt),
          ),
        )
        .returning({ id: schema.outboundSends.id });
      if (stamped.length === 0) {
        summary.alreadyResolved += 1;
        continue;
      }
      summary.swept += 1;
      await deps.database.insert(schema.auditLog).values({
        familyId: row.familyId,
        actor: 'system',
        actionTaken: 'outbound_send_unconfirmed',
        targetTable: 'outbound_sends',
        targetId: row.id,
        after: { actionId: row.actionId, claimedAt: row.claimedAt.toISOString() },
      });
      deps.log.warn(
        {
          outboundSendId: row.id,
          actionId: row.actionId,
          ageMs: now.getTime() - row.claimedAt.getTime(),
        },
        'claim sweep: a send was claimed but never confirmed — the action may say done for an email that never left',
      );
    } catch (err) {
      summary.rowErrors += 1;
      deps.log.error(
        { outboundSendId: row.id, err: err instanceof Error ? err.message : String(err) },
        'claim sweep: one claim failed — the rest of the batch continues',
      );
    }
  }

  return summary;
}
