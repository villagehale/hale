import { randomUUID } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { type AnyColumn, and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';

/** The name a group answer carries once the person who gave it has left the household. */
export const DEPARTED_MEMBER_NAME = 'someone';

/** Keys that name the person (`name:<folded name>`) or stand for their handle
 * (`handle:<keyed index>`). A phone blind index is neither: the number it hashes is kept
 * as consent evidence (depart.ts), so its key stays. */
const IDENTIFYING_KEY = /^(name|handle):/;

export interface DepartedMemberCleared {
  /** Rows whose display name or RSVP words were cleared. */
  namesCleared: number;
  /** Rows whose `name:` or `handle:` key, or a covers list or waiting list naming it, was
   * moved to a departed key. */
  keysCleared: number;
}

/**
 * A parent left the household: their name and words come off its group plans and polls.
 *
 * Their answers still count (a yes on Saturday's picnic stays a yes), so the rows stay and
 * only what names them changes: the display name on every RSVP, expected row, vote and
 * poll waiting list in this household's chats, the words of their RSVPs, and the name on
 * a private calendar ask Hale sent them for this household. A row is theirs by user id or
 * by member key, since a text vote from a number carries no user id; a calendar ask has
 * only the key. Returns how many rows changed; a second call changes none.
 * poll waiting list in this household's chats, and the words of their RSVPs. A row is
 * theirs by user id or by member key, since a text vote from a number carries no user id.
 *
 * A `name:` or `handle:` key is itself their name or a stand-in for their handle, so it
 * is moved to a fresh `departed:<uuid>`, the same one everywhere it appears in this
 * household (RSVP, expected row, vote, another answer's covers list, a poll's waiting
 * list), so a tally still pairs their answer with their place. A second call changes none.
 */
export async function renameDepartedMember(
  tx: Database,
  input: { familyId: string; userId: string; memberKeys: readonly string[] },
): Promise<DepartedMemberCleared> {
  const plans = householdPlans(tx, input.familyId);
  const polls = householdPolls(tx, input.familyId);
  // A key on a row stamped with their user id is theirs too: a tap on the poll card from an
  // Apple ID carries their id, and the waiting list and covers lists know them only by key.
  const keys = [
    ...new Set([
      ...input.memberKeys,
      ...(await keysOnRowsOf(tx, { plans, polls, userId: input.userId })),
    ]),
  ];
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
  const keysCleared = await rekeyIdentifyingKeys(
    tx,
    { familyId: input.familyId, plans, polls },
    keys,
  );
  return {
    namesCleared: rsvps.length + expected.length + votes.length + waitingLists,
    keysCleared,
  };
}

type Scope = {
  familyId: string;
  plans: ReturnType<typeof householdPlans>;
  polls: ReturnType<typeof householdPolls>;
};

async function keysOnRowsOf(
  tx: Database,
  scope: Omit<Scope, 'familyId'> & { userId: string },
): Promise<string[]> {
  const { plans, polls, userId } = scope;
  const rsvps = schema.linqGroupPlanRsvps;
  const expected = schema.linqGroupPlanExpected;
  const votes = schema.linqGroupPollVotes;
  const rows = [
    ...(await tx
      .select({ key: rsvps.memberKey })
      .from(rsvps)
      .where(and(inArray(rsvps.planId, plans), eq(rsvps.userId, userId)))),
    ...(await tx
      .select({ key: expected.memberKey })
      .from(expected)
      .where(and(inArray(expected.planId, plans), eq(expected.userId, userId)))),
    ...(await tx
      .select({ key: votes.memberKey })
      .from(votes)
      .where(and(inArray(votes.pollId, polls), eq(votes.userId, userId)))),
  ];
  return rows.map((row) => row.key);
}

function householdPlans(tx: Database, familyId: string) {
  return tx
    .select({ id: schema.linqGroupPlans.id })
    .from(schema.linqGroupPlans)
    .where(eq(schema.linqGroupPlans.familyId, familyId));
}

function householdPolls(tx: Database, familyId: string) {
  return tx
    .select({ id: schema.linqGroupPolls.id })
    .from(schema.linqGroupPolls)
    .where(eq(schema.linqGroupPolls.familyId, familyId));
}

async function rekeyIdentifyingKeys(
  tx: Database,
  scope: Scope,
  keys: readonly string[],
): Promise<number> {
  const { plans, polls } = scope;
  const rsvps = schema.linqGroupPlanRsvps;
  const expected = schema.linqGroupPlanExpected;
  const votes = schema.linqGroupPollVotes;
  const groupPolls = schema.linqGroupPolls;
  const identifying = keys.filter((key) => IDENTIFYING_KEY.test(key));

  let changed = 0;
  for (const from of identifying) {
    const to = `departed:${randomUUID()}`;
    const updated = [
      await tx
        .update(rsvps)
        .set({ memberKey: to })
        .where(and(inArray(rsvps.planId, plans), eq(rsvps.memberKey, from)))
        .returning({ id: rsvps.id }),
      await tx
        .update(expected)
        .set({ memberKey: to })
        .where(and(inArray(expected.planId, plans), eq(expected.memberKey, from)))
        .returning({ id: expected.id }),
      await tx
        .update(votes)
        .set({ memberKey: to })
        .where(and(inArray(votes.pollId, polls), eq(votes.memberKey, from)))
        .returning({ id: votes.id }),
      await tx
        .update(rsvps)
        .set({
          coversKeys: sql`(
            select coalesce(jsonb_agg(case when x.k = ${from} then ${to} else x.k end
              order by x.ord), '[]'::jsonb)::text
            from jsonb_array_elements_text(${rsvps.coversKeys}::jsonb) with ordinality as x(k, ord)
          )`,
        })
        .where(
          and(inArray(rsvps.planId, plans), sql`jsonb_exists(${rsvps.coversKeys}::jsonb, ${from})`),
        )
        .returning({ id: rsvps.id }),
      await tx
        .update(groupPolls)
        .set({
          expected: sql`(
            select jsonb_agg(
              case when x.e->>'memberKey' = ${from}
                then jsonb_set(x.e, '{memberKey}', to_jsonb(${to}::text))
                else x.e end
              order by x.ord)
            from jsonb_array_elements(${groupPolls.expected}) with ordinality as x(e, ord)
          )`,
        })
        .where(
          and(
            eq(groupPolls.familyId, scope.familyId),
            sql`exists (
              select 1 from jsonb_array_elements(${groupPolls.expected}) as y(e)
              where y.e->>'memberKey' = ${from}
            )`,
          ),
        )
        .returning({ id: groupPolls.id }),
    ];
    changed += updated.reduce((sum, rows) => sum + rows.length, 0);
  }
  return changed;
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
