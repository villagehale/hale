import { type Database, schema } from '@hale/db';
import { and, countDistinct, eq, isNotNull, isNull } from 'drizzle-orm';

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

/**
 * VIL-722 · whether a Linq group is one household's or several, for retention per chat
 * kind. The same test the multi-family turn applies before it takes a message
 * (`takeMultiFamilyTurn`, lib/channel/linq/multi-family.ts): two or more households
 * present in the chat, or two or more live joins. Anything less is the household path.
 * Counts only: never a phone, a name or a family id.
 */
export async function groupChatKind(
  database: Database,
  chatId: string | null | undefined,
): Promise<'family_group' | 'multi_family_group'> {
  if (!chatId) return 'family_group';
  const people = schema.linqSharedGroupPeople;
  const [present] = await database
    .select({ households: countDistinct(people.familyId) })
    .from(people)
    .where(and(eq(people.chatId, chatId), isNotNull(people.familyId)));
  if ((present?.households ?? 0) >= 2) return 'multi_family_group';
  const joins = schema.linqMultiFamilyJoins;
  const [joined] = await database
    .select({ households: countDistinct(joins.familyId) })
    .from(joins)
    .where(and(eq(joins.chatId, chatId), isNull(joins.leftAt), isNotNull(joins.joinedAt)));
  return (joined?.households ?? 0) >= 2 ? 'multi_family_group' : 'family_group';
}
