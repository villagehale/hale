import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';

/**
 * The zone a person joining an existing household starts in: the primary
 * parent's. `users.timezone` defaults to UTC (migration 0178), so every insert
 * into `users` passes a zone explicitly. A joiner has no postal code of their
 * own on file; they live where the household lives until they say otherwise.
 * Falls back to the product default when the household has no primary parent row.
 */
export async function householdTimezone(tx: Database, familyId: string): Promise<string> {
  const [primary] = await tx
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  if (!primary) return DEFAULT_TIMEZONE;
  const [row] = await tx
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, primary.userId))
    .limit(1);
  return row?.timezone ?? DEFAULT_TIMEZONE;
}
