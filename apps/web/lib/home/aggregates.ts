import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { companionForFamily } from '~/lib/companion/queries';
import { _internal as recentInternal } from '~/lib/companion/recent-logs';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { listFamilySavedCandidateIds } from '~/lib/village/save';

const { dropTeenEpisodes } = recentInternal;

/** The window "this week" is measured against — a rolling 7 days, so the count is
 * timezone-agnostic (no calendar-week-start ambiguity across the family's zone and
 * the UTC server). */
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The three honest counts the Home stat row surfaces. Each is a COUNT only — no
 * summary, payload, or child breakdown travels — so rule #1 can't leak content:
 *   logsThisWeek   — quick-logs in the last 7 days, AFTER teen redaction (a 13+
 *                    child's own episode is dropped before counting, so the count
 *                    never betrays that something was logged about the teen).
 *   upcomingHealth — curated health items due within the horizon across the family.
 *                    The curated schedule tops out at 144 months (@hale/types), so a
 *                    teenager (156mo+) contributes none; this is a family total.
 *   savedPlaces    — village candidates the family has privately saved (authoritative
 *                    all-saves count, not just the current standing feed).
 */
export interface HomeStats {
  logsThisWeek: number;
  upcomingHealth: number;
  savedPlaces: number;
}

const EMPTY_STATS: HomeStats = { logsThisWeek: 0, upcomingHealth: 0, savedPlaces: 0 };

/** Health items counted as "coming up": scheduled and not yet marked done, within a
 * roughly-two-month lead so the count reflects what a parent should act on soon
 * rather than the whole future schedule. */
const UPCOMING_HEALTH_MAX_WEEKS = 8;

/**
 * Family-scoped aggregates for the Home stat row. `Database` + `familyId` +
 * `requestingUserId` are injected so the teen-redacted logs count is unit-testable
 * without the server-only auth chain; loadHomeStats is the request wrapper.
 *
 * The logs count reuses dropTeenEpisodes (the SAME redaction the recent-logs list
 * applies) so a teen's own episode is removed BEFORE the count — never a raw
 * COUNT(*) that would inflate the number and leak that something exists (rule #1).
 */
export async function readHomeStats(
  database: Database,
  familyId: string,
  requestingUserId: string | null,
  now: Date = new Date(),
): Promise<HomeStats> {
  const since = new Date(now.getTime() - WEEK_WINDOW_MS);

  // The four reads are independent (only logsThisWeek joins children+weekRows in
  // memory afterwards), so issue them together — ~2 latencies instead of ~5.
  const [children, weekRows, companion, savedIds] = await Promise.all([
    database
      .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId)),
    database
      .select({
        childId: schema.familyMemoryEpisodes.childId,
        authoredBy: schema.familyMemoryEpisodes.authoredBy,
      })
      .from(schema.familyMemoryEpisodes)
      .where(
        and(
          eq(schema.familyMemoryEpisodes.familyId, familyId),
          isNull(schema.familyMemoryEpisodes.deletedAt),
          gte(schema.familyMemoryEpisodes.occurredAt, since),
        ),
      )
      .orderBy(desc(schema.familyMemoryEpisodes.occurredAt)),
    companionForFamily(familyId, database, now),
    listFamilySavedCandidateIds(database, familyId),
  ]);

  const logsThisWeek = dropTeenEpisodes(weekRows, children, requestingUserId, now).length;

  const upcomingHealth = companion.reduce(
    (sum, child) =>
      sum +
      child.nextHealth.filter(
        (h) => !h.done && h.dueInWeeks >= 0 && h.dueInWeeks <= UPCOMING_HEALTH_MAX_WEEKS,
      ).length,
    0,
  );

  const savedPlaces = savedIds.size;

  return { logsThisWeek, upcomingHealth, savedPlaces };
}

/**
 * Request wrapper. Same degradation as the other Home loaders: no DATABASE_URL
 * (preview) or no resolved family (unauthed / onboarding incomplete) → all-zero
 * stats (the honest empty state). A genuine query failure once a DB exists must
 * surface (rule #8), so it is deliberately NOT caught.
 */
export async function loadHomeStats(): Promise<HomeStats> {
  if (!process.env.DATABASE_URL) return EMPTY_STATS;
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return EMPTY_STATS;
  const requestingUserId = await currentUserId(database);
  return readHomeStats(database, familyId, requestingUserId);
}
