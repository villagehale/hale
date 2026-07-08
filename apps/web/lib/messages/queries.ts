import { type Database, type DigestPerChildBreakdown, schema } from '@hale/db';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { effectiveTeenContent } from '~/lib/dashboard/mappers';
import { familyHasTeenager, readFamilyTimezone } from '~/lib/dashboard/trail-query';
import {
  type MessageActionState,
  type MessageView,
  toActionMessage,
  toDigestMessage,
} from './mappers';

/**
 * The mobile Messages inbox loader — "Hale's notes to you": the family's daily
 * digests + the action lifecycle a parent should see, newest first. Mirrors the
 * loadPendingApprovals shape: family-scoped, teen-redacted inside the loader (the
 * route never touches the DB), and degrades to an empty feed in the credential-less
 * preview / when no family resolves. A genuine query failure once a DB exists
 * surfaces as an error (rule #8) — deliberately not caught here.
 *
 * Two sources, merged and sorted by their stamp:
 *  - daily_digests: the composed brief prose (perChildBreakdown.briefText), already
 *    a parent-facing, pre-redacted slice (daily-digests.ts, rule #1) — surfaced
 *    wholesale.
 *  - actions: the lifecycle rows a parent sees — a draft awaiting their yes, an
 *    executed action, one that needs a human, or a revert. Joined to the source
 *    event for the teen flag + the event's child DOB, so effectiveTeenContent
 *    redacts a 13+ child's raw content (rule #1) exactly as the approvals loader.
 */

const FEED_LIMIT = 50;

/** The action states the feed surfaces, in the enum's shape. Excludes nothing the
 * parent should see: a drafted row (their yes), an executed row (autonomous), a
 * needs_human row, a revert. */
const FEED_STATES: readonly MessageActionState[] = [
  'drafted_for_approval',
  'autonomous',
  'needs_human',
  'reverted',
];

async function loadMessagesForFamily(
  database: Database,
  familyId: string,
): Promise<MessageView[]> {
  const [familyHasTeen, timeZone] = await Promise.all([
    familyHasTeenager(database, familyId),
    readFamilyTimezone(database, familyId),
  ]);

  const [digestRows, actionRows] = await Promise.all([
    database
      .select({
        id: schema.dailyDigests.id,
        breakdown: schema.dailyDigests.perChildBreakdown,
        generatedAt: schema.dailyDigests.generatedAt,
      })
      .from(schema.dailyDigests)
      .where(
        and(
          eq(schema.dailyDigests.familyId, familyId),
          isNotNull(schema.dailyDigests.perChildBreakdown),
        ),
      )
      .orderBy(desc(schema.dailyDigests.generatedAt))
      .limit(FEED_LIMIT),
    database
      .select({
        id: schema.actions.id,
        actionType: schema.actions.actionType,
        state: schema.actions.userVisibleState,
        draftedAt: schema.actions.draftedAt,
        executedAt: schema.actions.executedAt,
        revertedAt: schema.actions.revertedAt,
        revertedReason: schema.actions.revertedReason,
        teenContent: schema.events.teenContent,
        childDob: schema.children.dateOfBirth,
      })
      .from(schema.actions)
      .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
      .leftJoin(schema.children, eq(schema.events.childId, schema.children.id))
      .where(
        and(
          eq(schema.actions.familyId, familyId),
          inArray(schema.actions.userVisibleState, [...FEED_STATES]),
        ),
      )
      // The DB top-N window must match the feed's sort key (settled instant, not
      // drafted_at) — otherwise a long-ago-drafted action that settled recently
      // falls out of this window and vanishes from the top of the feed.
      .orderBy(sql`coalesce(${schema.actions.revertedAt}, ${schema.actions.executedAt}, ${schema.actions.draftedAt}) desc`)
      .limit(FEED_LIMIT),
  ]);

  // Tag each row with the raw instant it sorts by BEFORE formatting — the feed is
  // reverse-chron by the true point in time, never by the display string (which
  // wouldn't order across months).
  const digests = digestRows
    .filter((row): row is typeof row & { breakdown: DigestPerChildBreakdown } =>
      Boolean(row.breakdown?.briefText),
    )
    .map((row) => ({
      at: row.generatedAt,
      view: toDigestMessage(
        { id: row.id, briefText: row.breakdown.briefText as string, generatedAt: row.generatedAt },
        timeZone,
      ),
    }));

  const actions = actionRows.map((row) => {
    // A settled row is stamped by when it settled — reverted_at (declined/rolled
    // back) or executed_at (ran) — anything still pending by when it was drafted,
    // so the feed sorts by the moment the parent would notice it.
    const at = row.revertedAt ?? row.executedAt ?? row.draftedAt;
    return {
      at,
      view: toActionMessage(
        {
          id: row.id,
          actionType: row.actionType,
          state: row.state as MessageActionState,
          at,
          revertedReason: row.revertedReason,
          teenContent: effectiveTeenContent(row.teenContent, row.childDob ?? null, familyHasTeen),
        },
        timeZone,
      ),
    };
  });

  return [...digests, ...actions]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, FEED_LIMIT)
    .map((row) => row.view);
}

export function loadMessages(): Promise<MessageView[]> {
  if (!process.env.DATABASE_URL) return Promise.resolve([]);
  const database = defaultDb();
  return currentFamilyId(database).then((familyId) =>
    familyId ? loadMessagesForFamily(database, familyId) : [],
  );
}
