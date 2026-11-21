import { type BillingNotice, type Database, schema } from '@hale/db';

/** Takes a family's notice writes one at a time (`pg_advisory_xact_lock`'s first key). */
export const BILLING_NOTICE_LOCK_NS = 735_001;

/** A connection or a transaction: both write these rows. */
export type NoticeDb = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;

/**
 * Every outcome is one immutable audit row, addressed to the recipient. `after` holds
 * only the lane, a closed reason and the attempt count, never an amount. The verbs are
 * internal to History and out of the family-wide export (trail/verbs.ts, rights/export.ts).
 */
export async function writeNoticeAudit(
  database: NoticeDb,
  row: Pick<BillingNotice, 'id' | 'familyId' | 'lane' | 'parentUserId'>,
  actionTaken: 'billing_notice_sent' | 'billing_notice_send_failed' | 'billing_notice_dropped',
  after: { reason?: string; attempts: number },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: row.familyId,
    actor: 'system',
    actionTaken,
    targetTable: 'billing_notices',
    targetId: row.id,
    audience: row.parentUserId,
    after: { lane: row.lane, ...after },
  });
}
