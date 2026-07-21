import { type Database, schema } from '@hale/db';
import { and, eq, gt, isNull, or } from 'drizzle-orm';

/**
 * F11 · The Sunday Loop (VIL-213 · A2). The parent's CASL express consent to
 * receive loop SERVICE messages over SMS must be LIVE before the seam sends any
 * SMS — granted, not revoked, unexpired. Per-parent (co-parents independent). No
 * generic consent-read helper existed, so this is the loop's own; A3 revokes on
 * STOP by setting revoked_at.
 */
export async function smsConsentLive(
  userId: string,
  database: Database,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.userId, userId),
        eq(schema.consentRecords.consentType, 'sms_service_messages'),
        eq(schema.consentRecords.granted, true),
        isNull(schema.consentRecords.revokedAt),
        or(isNull(schema.consentRecords.expiresAt), gt(schema.consentRecords.expiresAt, now)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
