import { type Database, schema } from '@hale/db';
import { type AnyColumn, and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';

/** The name a group answer carries once the person who gave it has left the household. */
export const DEPARTED_MEMBER_NAME = 'someone';

/**
 * A parent left the household: their name and words come off its group plans and polls.
 *
 * Their answers still count (a yes on Saturday's picnic stays a yes), so the rows stay and
 * only what names them changes: the display name on every RSVP, expected row, vote and
 * poll waiting list in this household's chats, the words of their RSVPs, and the name on
 * a private calendar ask Hale sent them for this household. A row is theirs by user id or
 * by member key, since a text vote from a number carries no user id; a calendar ask has
 * only the key. Returns how many rows changed; a second call changes none.
 */
export async function renameDepartedMember(
  tx: Database,
  input: { familyId: string; userId: string; memberKeys: readonly string[] },
): Promise<number> {
  const keys = [...input.memberKeys];
  const plans = tx
    .select({ id: schema.linqGroupPlans.id })
    .from(schema.linqGroupPlans)
    .where(eq(schema.linqGroupPlans.familyId, input.familyId));
  const polls = tx
    .select({ id: schema.linqGroupPolls.id })
    .from(schema.linqGroupPolls)
    .where(eq(schema.linqGroupPolls.familyId, input.familyId));
  const theirs = (table: { userId: AnyColumn; memberKey: AnyColumn }) =>
    keys.length === 0
      ? eq(table.userId, input.userId)
      : or(eq(table.userId, input.userId), inArray(table.memberKey, keys));

  const rsvps = await tx
    .update(schema.linqGroupPlanRsvps)
    .set({ displayName: DEPARTED_MEMBER_NAME, verbatim: null })
    .where(
      and(
        inArray(schema.linqGroupPlanRsvps.planId, plans),
        theirs(schema.linqGroupPlanRsvps),
        or(
          ne(schema.linqGroupPlanRsvps.displayName, DEPARTED_MEMBER_NAME),
          isNotNull(schema.linqGroupPlanRsvps.verbatim),
        ),
      ),
    )
    .returning({ id: schema.linqGroupPlanRsvps.id });
  const expected = await tx
    .update(schema.linqGroupPlanExpected)
    .set({ displayName: DEPARTED_MEMBER_NAME })
    .where(
      and(
        inArray(schema.linqGroupPlanExpected.planId, plans),
        theirs(schema.linqGroupPlanExpected),
        ne(schema.linqGroupPlanExpected.displayName, DEPARTED_MEMBER_NAME),
      ),
    )
    .returning({ id: schema.linqGroupPlanExpected.id });
  const votes = await tx
    .update(schema.linqGroupPollVotes)
    .set({ displayName: DEPARTED_MEMBER_NAME })
    .where(
      and(
        inArray(schema.linqGroupPollVotes.pollId, polls),
        theirs(schema.linqGroupPollVotes),
        ne(schema.linqGroupPollVotes.displayName, DEPARTED_MEMBER_NAME),
      ),
    )
    .returning({ id: schema.linqGroupPollVotes.id });
  const waitingLists = keys.length === 0 ? 0 : await renameInPollExpected(tx, input.familyId, keys);
  const calendarAsks =
    keys.length === 0
      ? []
      : await tx
          .update(schema.linqGroupPlanCalendarConsents)
          .set({ displayName: DEPARTED_MEMBER_NAME })
          .where(
            and(
              eq(schema.linqGroupPlanCalendarConsents.familyId, input.familyId),
              inArray(schema.linqGroupPlanCalendarConsents.memberKey, keys),
              ne(schema.linqGroupPlanCalendarConsents.displayName, DEPARTED_MEMBER_NAME),
            ),
          )
          .returning({ id: schema.linqGroupPlanCalendarConsents.id });
  return rsvps.length + expected.length + votes.length + waitingLists + calendarAsks.length;
}

/** A poll's waiting list is jsonb `[{ memberKey, displayName }]`, matched by key only. */
async function renameInPollExpected(
  tx: Database,
  familyId: string,
  keys: readonly string[],
): Promise<number> {
  const keyList = sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  );
  const polls = schema.linqGroupPolls;
  const updated = await tx
    .update(polls)
    .set({
      expected: sql`(
        select jsonb_agg(
          case when x.e->>'memberKey' in (${keyList})
            then jsonb_set(x.e, '{displayName}', to_jsonb(${DEPARTED_MEMBER_NAME}::text))
            else x.e end
          order by x.ord)
        from jsonb_array_elements(${polls.expected}) with ordinality as x(e, ord)
      )`,
    })
    .where(
      and(
        eq(polls.familyId, familyId),
        sql`exists (
          select 1 from jsonb_array_elements(${polls.expected}) as y(e)
          where y.e->>'memberKey' in (${keyList})
            and y.e->>'displayName' <> ${DEPARTED_MEMBER_NAME}
        )`,
      ),
    )
    .returning({ id: polls.id });
  return updated.length;
}
