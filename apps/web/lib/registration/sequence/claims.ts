import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';

/**
 * VIL-242 · M7 — the CLAIM, read from the other side.
 *
 * A registration_sequences row means Hale has taken this family's registration morning
 * over for that window: it will send its own heads-up leg, its own battle plan and its
 * own 15-minute warning. M4's proactive nudge asks this before announcing a window, so
 * a prepared family never hears the same date twice from the same number.
 *
 * It lives in the M7 module rather than in the nudge sweep because the SEQUENCE owns
 * what "claimed" means. Every row counts, whatever state it is in — a shortlist still
 * waiting for approval has already sent (or will send) the heads-up that would
 * otherwise have been M4's, and a declined one is a family who said no to this window,
 * which is not an invitation to announce it again through a different door.
 */
export async function loadClaimedWindowIds(
  database: Database,
  familyId: string,
): Promise<Set<string>> {
  const rows = await database
    .select({ windowId: schema.registrationSequences.windowId })
    .from(schema.registrationSequences)
    .where(eq(schema.registrationSequences.familyId, familyId));
  return new Set(rows.map((row) => row.windowId));
}
