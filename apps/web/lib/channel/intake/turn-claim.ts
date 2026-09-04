import { type Database, schema } from '@hale/db';
import { eq, lt } from 'drizzle-orm';

/**
 * VIL-237 / audit P1-4 — claiming an intake turn, so one inbound text is one turn.
 *
 * The machine's step-4 duplicate check reads `session.lastProviderId` — a value saved
 * only AFTER the turn's model calls and sends — so a Twilio 15s-budget resend arriving
 * mid-turn passed it and ran the whole turn again: two welcome texts, doubled extractor
 * spend, and a last-write-wins session clobber (the exact resend race migration 0085's
 * comment records firing in production for the post-intake leg). Pre-provisioning
 * sessions write no channel_messages row, so the 0085 unique index cannot arbitrate the
 * early funnel; this claim is that arbiter's home.
 *
 * THE INSERT IS THE CLAIM (relay-claim.ts's rule). Not a select-then-insert, which is
 * two statements with a race between them, and not the in-row lastProviderId, which is
 * one session's opinion written after the fact. The unique index on provider_message_id
 * (migration 0106) decides atomically; losing it is a plain empty `returning`, and the
 * machine answers 'duplicate' — the same named outcome the old check produced, now
 * covering the mid-turn window, the pre-session greet, and out-of-order redeliveries of
 * anything in the retention window.
 *
 * THE DELIBERATE TRADE: a turn that crashes after claiming leaves its resend refused,
 * where the old racy check accidentally let the resend re-run the turn. That residue is
 * VISIBLE, not silent (rule #11) — `completed_at` stays NULL on the claim row — and the
 * window is the seconds of one webhook invocation, priced against a resend race that
 * fires today. Retention is housekeeping only (the relay idiom): the exactly-once
 * property is the unique index's, never the sweep's.
 */

/** Long enough that no Twilio redelivery — including its multi-hour fallback retries —
 * can outlive it, and short enough that the table stays a day of texts. */
const CLAIM_RETENTION_HOURS = 24;

/** True for the first delivery of this provider message id, false for every one
 * after it — including deliveries racing a turn that is still running. */
export async function claimIntakeTurn(
  database: Database,
  providerMessageId: string,
  at: Date,
): Promise<boolean> {
  await database
    .delete(schema.smsIntakeTurnClaims)
    .where(
      lt(
        schema.smsIntakeTurnClaims.claimedAt,
        new Date(at.getTime() - CLAIM_RETENTION_HOURS * 3_600_000),
      ),
    );

  const claimed = await database
    .insert(schema.smsIntakeTurnClaims)
    .values({ providerMessageId, claimedAt: at })
    .onConflictDoNothing({ target: schema.smsIntakeTurnClaims.providerMessageId })
    .returning({ id: schema.smsIntakeTurnClaims.id });

  return claimed.length > 0;
}

/** Stamps the claimed turn finished. A claim whose completed_at stays NULL past the
 * turn's own lifetime is the named crash residue (rule #11) — a text that was claimed
 * and never answered — and it is a row an operator can count, never a silence. */
export async function completeIntakeTurn(
  database: Database,
  providerMessageId: string,
  at: Date,
): Promise<void> {
  await database
    .update(schema.smsIntakeTurnClaims)
    .set({ completedAt: at })
    .where(eq(schema.smsIntakeTurnClaims.providerMessageId, providerMessageId));
}
