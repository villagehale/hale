import type { Database } from '@hale/db';
import { sql } from 'drizzle-orm';

const UNIQUE_VIOLATION = '23505';

/**
 * Assigns the next founding ordinal (first 100 families, permanent) to a
 * freshly provisioned family. Runs AFTER the provisioning transaction commits:
 * the badge is a decoration, so nothing about it may fail onboarding. Two
 * simultaneous signups can compute the same next number — the unique index
 * rejects one, and that family simply forfeits the badge (rule: fail the
 * garnish, never the meal). Any other error still propagates.
 */
export async function assignFoundingNumber(database: Database, familyId: string): Promise<void> {
  try {
    await database.execute(sql`
      UPDATE families
      SET founding_number = sub.next
      FROM (SELECT coalesce(max(founding_number), 0) + 1 AS next FROM families) sub
      WHERE families.id = ${familyId}
        AND families.founding_number IS NULL
        AND (SELECT count(*) FROM families WHERE founding_number IS NOT NULL) < 100
    `);
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return;
    }
    throw error;
  }
}
