import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * How many Hale families currently sit in a Linq group. Household-only chats
 * (claimed on `families.linq_group_chat_id`, no multi-family join rows) count as 1.
 * Never a phone or a name.
 */
export async function groupFamilyCount(
  database: Database,
  chatId: string | null | undefined,
): Promise<number> {
  if (!chatId) return 1;
  const rows = await database
    .select({ familyId: schema.linqMultiFamilyJoins.familyId })
    .from(schema.linqMultiFamilyJoins)
    .where(
      and(eq(schema.linqMultiFamilyJoins.chatId, chatId), isNull(schema.linqMultiFamilyJoins.leftAt)),
    );
  const unique = new Set(rows.map((row) => row.familyId));
  return Math.max(1, unique.size);
}
