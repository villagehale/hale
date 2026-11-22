import { type BillingNotice, type BillingNoticeEventFacts, type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { addsNoticeSubject } from './merge';
import { resolveNoticePayer } from './payer';

/** Takes a family's notice writes one at a time (`pg_advisory_xact_lock`'s first key). */
export const BILLING_NOTICE_LOCK_NS = 735_001;

/** A connection or a transaction: both write these rows. */
export type NoticeDb = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;

type NoticeRef = Pick<BillingNotice, 'id' | 'familyId' | 'lane' | 'parentUserId'>;

function auditFields(row: NoticeRef, after: { reason?: string; attempts: number }) {
  return {
    familyId: row.familyId,
    actor: 'system',
    targetTable: 'billing_notices',
    targetId: row.id,
    audience: row.parentUserId,
    after: { lane: row.lane, ...after },
  };
}

/**
 * Every outcome is one immutable audit row, addressed to the recipient. `after` holds
 * only the lane, a closed reason and the attempt count, never an amount. The verbs are
 * internal to History and out of the family-wide export (trail/verbs.ts, rights/export.ts).
 */
export const writeNoticeAudit = {
  async sent(database: NoticeDb, row: NoticeRef, after: { attempts: number }): Promise<void> {
    await database
      .insert(schema.auditLog)
      .values({ ...auditFields(row, after), actionTaken: 'billing_notice_sent' });
  },
  async failed(
    database: NoticeDb,
    row: NoticeRef,
    after: { reason: string; attempts: number },
  ): Promise<void> {
    await database
      .insert(schema.auditLog)
      .values({ ...auditFields(row, after), actionTaken: 'billing_notice_send_failed' });
  },
  async dropped(
    database: NoticeDb,
    row: NoticeRef,
    after: { reason: string; attempts: number },
  ): Promise<void> {
    await database
      .insert(schema.auditLog)
      .values({ ...auditFields(row, after), actionTaken: 'billing_notice_dropped' });
  },
};

/** Amounts nobody will ever be told do not stay on the row. */
export function withoutAmounts(facts: BillingNoticeEventFacts): BillingNoticeEventFacts {
  if (!facts.refunds) return facts;
  return {
    ...facts,
    refunds: facts.refunds.map(({ refundedMinor: _r, chargeMinor: _c, ...rest }) => rest),
  } as BillingNoticeEventFacts;
}

/**
 * Whose money this dropped row is about. The access export shows a row to its payer alone,
 * so a drop that came before the drain read the payer reads it here, from the facts as
 * they stand under the family lock. `row` carries a payer this tick already resolved, which
 * holds only while no new subject has merged in since.
 */
async function payerOnDrop(
  tx: Pick<Database, 'select' | 'selectDistinct'>,
  row: BillingNotice,
  current: Pick<BillingNotice, 'facts' | 'parentUserId'>,
  reason: string,
): Promise<string | null> {
  if (reason === 'payer_unresolved') return null;
  if (current.parentUserId) return current.parentUserId;
  if (row.parentUserId && !addsNoticeSubject(row.facts, current.facts)) return row.parentUserId;
  const payer = await resolveNoticePayer(tx, {
    familyId: row.familyId,
    lane: row.lane,
    facts: current.facts,
  });
  return payer.status === 'resolved' ? payer.parentUserId : null;
}

/**
 * The one way a held row is dropped, by the drain or the webhook, inside a transaction
 * that holds the family lock: the row names its payer, or holds no amount.
 */
export async function writeNoticeDrop(
  tx: NoticeDb & Pick<Database, 'selectDistinct'>,
  row: BillingNotice,
  current: Pick<BillingNotice, 'facts' | 'parentUserId'>,
  drop: { reason: string; attempts: number; now: Date },
): Promise<void> {
  const parentUserId = await payerOnDrop(tx, row, current, drop.reason);
  await tx
    .update(schema.billingNotices)
    .set({
      status: 'dropped',
      dropReason: drop.reason,
      parentUserId,
      attempts: drop.attempts,
      updatedAt: drop.now,
      ...(parentUserId === null ? { facts: withoutAmounts(current.facts) } : {}),
    })
    .where(eq(schema.billingNotices.id, row.id));
  await writeNoticeAudit.dropped(
    tx,
    { ...row, parentUserId },
    { reason: drop.reason, attempts: drop.attempts },
  );
}
