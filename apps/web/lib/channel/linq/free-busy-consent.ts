import { type Database, schema } from '@hale/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';

/**
 * VIL-459 — a parent's own say-so for Hale to use their calendar's busy times in one
 * shared chat. One row per parent per chat; latest row wins, and a withdrawal stamped in
 * the same instant as a grant wins the tie, so the gate fails closed.
 */
export const FREE_BUSY_CONSENT = 'integration_specific' as const;

const FREE_BUSY_SCOPE_PREFIX = 'linq_free_busy:';

export function freeBusyScope(chatId: string): string {
  return `${FREE_BUSY_SCOPE_PREFIX}${chatId}`;
}

export type FreeBusyLedgerRow = {
  userId: string;
  consentScope: string | null;
  granted: boolean;
  revokedAt: Date | null;
  grantedAt: Date;
};

/** The latest row per parent per chat, and whether it still stands. */
export function latestFreeBusyRows(
  rows: readonly FreeBusyLedgerRow[],
): (FreeBusyLedgerRow & { standing: boolean })[] {
  const latest = new Map<string, FreeBusyLedgerRow>();
  for (const row of rows) {
    const key = `${row.userId}|${row.consentScope}`;
    const prior = latest.get(key);
    const later =
      !prior ||
      row.grantedAt.getTime() > prior.grantedAt.getTime() ||
      (row.grantedAt.getTime() === prior.grantedAt.getTime() && !row.granted);
    if (later) latest.set(key, row);
  }
  return [...latest.values()].map((row) => ({
    ...row,
    standing: row.granted && row.revokedAt == null,
  }));
}

/**
 * Append a `granted=false` row for each of these parents' standing free/busy say-so in
 * this family: in one chat, or in every chat when `chatId` is null. Returns how many
 * were withdrawn; an already-closed one is left at its original row.
 */
export async function withdrawFreeBusyConsent(
  database: Database,
  input: {
    familyId: string;
    userIds: readonly string[];
    chatId: string | null;
    now: Date;
    interpretation: string;
  },
): Promise<number> {
  if (input.userIds.length === 0) return 0;
  const rows = await database
    .select({
      userId: schema.consentRecords.userId,
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
      grantedAt: schema.consentRecords.grantedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, input.familyId),
        eq(schema.consentRecords.consentType, FREE_BUSY_CONSENT),
        inArray(schema.consentRecords.userId, [...input.userIds]),
        input.chatId === null
          ? like(schema.consentRecords.consentScope, `${FREE_BUSY_SCOPE_PREFIX}%`)
          : eq(schema.consentRecords.consentScope, freeBusyScope(input.chatId)),
      ),
    );
  const standing = latestFreeBusyRows(rows).filter((row) => row.standing);
  if (standing.length === 0) return 0;
  await database.insert(schema.consentRecords).values(
    standing.map((row) => ({
      userId: row.userId,
      familyId: input.familyId,
      consentType: FREE_BUSY_CONSENT,
      granted: false,
      consentScope: row.consentScope,
      policyVersion: POLICY_VERSION,
      grantedAt: input.now,
      evidence: { interpretation: input.interpretation },
    })),
  );
  return standing.length;
}
