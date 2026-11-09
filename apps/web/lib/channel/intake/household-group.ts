import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { latestCoparentGroupWish } from './session';

/**
 * VIL-566 — the household group as the model reads it. The parent's yes on the
 * co-parent ask (the wish, on the intake session) and a group Hale is actually in
 * (the claim, `families.linq_group_chat_id`) are separate facts. A yes is not a
 * group: until the claim lands, the group is `pending` and setup is not finished.
 *
 * - `claimed`: the family's group exists.
 * - `pending`: they said yes and no group exists yet.
 * - `unclaimed`: the co-parent ask is open this turn and no group exists, so a yes
 *   in this message leaves it pending.
 *
 * Null when none of that is in play (no yes, and the ask is not open), so a turn
 * that has nothing to do with the group carries no fact.
 */
export type HouseholdGroupFact = 'claimed' | 'pending' | 'unclaimed';

export function householdGroupFact(args: {
  wanted: boolean | null;
  claimed: boolean;
  asking: boolean;
}): HouseholdGroupFact | null {
  if (args.wanted !== true && !args.asking) return null;
  if (args.claimed) return 'claimed';
  return args.wanted === true ? 'pending' : 'unclaimed';
}

/** The family's Linq group is claimed: Hale is in it. */
export async function householdGroupClaimed(
  database: Database,
  familyId: string,
): Promise<boolean> {
  const rows = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const chatId = rows[0]?.linqGroupChatId;
  return typeof chatId === 'string' && chatId.length > 0;
}

/** The fact for one turn. Reads the claim only when the group is in play. */
export async function householdGroupForTurn(
  database: Database,
  familyId: string,
  args: { wanted: boolean | null; asking: boolean },
): Promise<HouseholdGroupFact | null> {
  if (args.wanted !== true && !args.asking) return null;
  return householdGroupFact({
    ...args,
    claimed: await householdGroupClaimed(database, familyId),
  });
}

/** The fact for a turn outside the co-parent ask: the stored answer against the claim. */
export async function loadHouseholdGroupFact(
  database: Database,
  familyId: string,
): Promise<HouseholdGroupFact | null> {
  return householdGroupForTurn(database, familyId, {
    wanted: await latestCoparentGroupWish(database, familyId),
    asking: false,
  });
}
