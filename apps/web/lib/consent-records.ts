import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';

/**
 * The read-only view of a parent's OWN consent ledger, for the Settings Trust card.
 *
 * Own rows only, by construction: keyed on the viewer's users.id and post-filtered
 * (the defense-in-depth shape every channel lookup keeps), so a co-parent's rows —
 * and above all their `evidence` (their verbatim words) — can never surface here
 * (rule #5). The evidence / ip / user_agent columns are deliberately never selected:
 * the list shows WHAT was consented to and WHEN, not the captured artifacts.
 */

export interface ViewerConsentRecord {
  id: string;
  consentType: string;
  consentScope: string | null;
  granted: boolean;
  policyVersion: string;
  grantedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export async function listConsentRecordsForViewer(
  database: Database,
  userId: string,
): Promise<ViewerConsentRecord[]> {
  const rows = await database
    .select({
      id: schema.consentRecords.id,
      userId: schema.consentRecords.userId,
      consentType: schema.consentRecords.consentType,
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
      policyVersion: schema.consentRecords.policyVersion,
      grantedAt: schema.consentRecords.grantedAt,
      revokedAt: schema.consentRecords.revokedAt,
      expiresAt: schema.consentRecords.expiresAt,
    })
    .from(schema.consentRecords)
    .where(eq(schema.consentRecords.userId, userId));

  // Rebuilt field by field rather than spread, so the output can NEVER carry a
  // column the interface doesn't name — even if the select were widened.
  return rows
    .filter((row) => row.userId === userId)
    .map((row) => ({
      id: row.id,
      consentType: row.consentType,
      consentScope: row.consentScope ?? null,
      granted: row.granted,
      policyVersion: row.policyVersion,
      grantedAt: row.grantedAt ?? null,
      revokedAt: row.revokedAt ?? null,
      expiresAt: row.expiresAt ?? null,
    }))
    .sort((a, b) => (b.grantedAt?.getTime() ?? 0) - (a.grantedAt?.getTime() ?? 0));
}
