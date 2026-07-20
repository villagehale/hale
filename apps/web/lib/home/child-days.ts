import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { loadFamilyTimezone } from '~/lib/dashboard/queries';
import { db as defaultDb } from '~/lib/db';
import {
  DIAPER_EPISODE,
  FEED_EPISODE,
  HEALTH_DONE_EPISODE,
  MEASUREMENT_EPISODE,
  MILESTONE_EPISODE,
  NAP_EPISODE,
} from '~/lib/companion/log-types';
import { _internal as recentInternal } from '~/lib/companion/recent-logs';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { dayKeyOf, formatTime } from '~/lib/format/datetime';

const { dropTeenEpisodes } = recentInternal;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many daily buckets the Sleep mini-chart shows (design handoff §4.2 Row 2). */
const WEEK_DAYS = 7;
/** How many items the highlights / meals lists surface before "view all". */
const HIGHLIGHTS_LIMIT = 5;
const MEALS_LIMIT = 5;

/** Human label for an episode kind, shown as the highlight row eyebrow. */
const KIND_LABEL: Record<string, string> = {
  [FEED_EPISODE]: 'Feed',
  [NAP_EPISODE]: 'Nap',
  [DIAPER_EPISODE]: 'Diaper',
  [MILESTONE_EPISODE]: 'Milestone',
  [MEASUREMENT_EPISODE]: 'Growth',
  [HEALTH_DONE_EPISODE]: 'Health',
};

/** One logged episode surfaced in the highlights / meals list — already redacted
 * (rule #1) and time-formatted in the family's zone server-side, so the client
 * renders it verbatim with no timezone guess. */
export interface HomeHighlight {
  id: string;
  /** The logged one-liner (child content → data-hale-pii at render). */
  summary: string;
  /** "Nap" / "Feed" / "Milestone" … the row eyebrow. */
  kindLabel: string;
  /** `HH:MM`, 24-hour, in the family's zone. */
  time: string;
}

/**
 * One child's Home Row 2 slice — all REAL logged aggregates, never the prototype's
 * fixed sample bars/times. Every field is derived from that child's own episodes
 * AFTER teen redaction, so a 13+ child's own content never leaks into a parent's
 * dashboard (rule #1). A child with nothing logged gets an all-empty entry so the
 * client always has data for the active selection (honest empty states in the UI).
 */
export interface HomeChildDays {
  childId: string;
  /** Today's episodes (all kinds), newest-first, capped. */
  highlights: HomeHighlight[];
  /** Today's feed episodes, newest-first, capped. */
  meals: HomeHighlight[];
  /** Full count of today's feeds (not capped) — the Meals headline. */
  mealsToday: number;
  /** Today's total logged sleep (nap minutes) — the Sleep headline. */
  todaySleepMin: number;
  /** Per-day total sleep minutes over the last 7 local days, oldest→newest (index 6
   * is today) — the Sleep mini bar chart. All zeros = nothing logged this week. */
  sleepWeek: number[];
  /** Average daily sleep over the days that HAVE logged sleep (a 0-sleep day is
   * "not logged", not "no sleep", so it doesn't drag the average), or null when the
   * week has none — the "this week" row is omitted then. */
  avgSleepMin: number | null;
  /** Milestone episodes logged in the 7-day window. */
  milestonesThisWeek: number;
}

interface EpisodeRow {
  id: string;
  childId: string | null;
  authoredBy: string | null;
  episodeType: string;
  summary: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

/** A nap's logged minutes from its payload, or 0 when absent/malformed (a nap always
 * carries durationMin per buildEpisodeInsert; the guard only defends bad data). */
function napMinutes(payload: Record<string, unknown>): number {
  const value = payload.durationMin;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Pure: folds a family's last-7-days episodes into one Row-2 slice per child (in the
 * input child order). Redaction runs FIRST (dropTeenEpisodes, the same rule-#1 filter
 * the recent-logs list uses), so a teen's own content is gone before any bucketing.
 * Days are the family's LOCAL calendar days (dayKeyOf in `timeZone`), so a late-evening
 * log near the UTC boundary buckets under its local day, matching the trail.
 */
export function foldChildDays(
  rows: EpisodeRow[],
  children: ReadonlyArray<{ id: string; dateOfBirth: string }>,
  requestingUserId: string | null,
  timeZone: string,
  now: Date = new Date(),
): HomeChildDays[] {
  const visible = dropTeenEpisodes(rows, children, requestingUserId, now);

  // The 7 local day-keys, oldest→newest (index 6 = today).
  const dayKeys: string[] = [];
  for (let i = WEEK_DAYS - 1; i >= 0; i--) {
    dayKeys.push(dayKeyOf(new Date(now.getTime() - i * DAY_MS), timeZone));
  }
  const dayIndex = new Map(dayKeys.map((key, i) => [key, i]));
  const todayKey = dayKeys[WEEK_DAYS - 1];

  return children.map((child) => {
    // Newest-first so the highlights / meals caps keep the most recent items,
    // independent of the input order (the query sorts too, but the fold owns it).
    const own = visible
      .filter((e) => e.childId === child.id)
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    const sleepWeek = new Array<number>(WEEK_DAYS).fill(0);
    let milestonesThisWeek = 0;
    let todaySleepMin = 0;
    const todayEpisodes: EpisodeRow[] = [];

    for (const e of own) {
      const key = dayKeyOf(e.occurredAt, timeZone);
      const idx = dayIndex.get(key);
      if (idx === undefined) continue; // outside the 7-day window (rolling-fetch edge)
      const isToday = key === todayKey;
      if (isToday) todayEpisodes.push(e);
      if (e.episodeType === NAP_EPISODE) {
        const minutes = napMinutes(e.payload);
        sleepWeek[idx] = (sleepWeek[idx] ?? 0) + minutes;
        if (isToday) todaySleepMin += minutes;
      }
      if (e.episodeType === MILESTONE_EPISODE) milestonesThisWeek += 1;
    }

    const toHighlight = (e: EpisodeRow): HomeHighlight => ({
      id: e.id,
      summary: e.summary,
      kindLabel: KIND_LABEL[e.episodeType] ?? 'Update',
      time: formatTime(e.occurredAt, timeZone),
    });
    const todayFeeds = todayEpisodes.filter((e) => e.episodeType === FEED_EPISODE);

    const daysWithSleep = sleepWeek.filter((min) => min > 0);
    const avgSleepMin =
      daysWithSleep.length > 0
        ? Math.round(daysWithSleep.reduce((sum, min) => sum + min, 0) / daysWithSleep.length)
        : null;

    return {
      childId: child.id,
      highlights: todayEpisodes.slice(0, HIGHLIGHTS_LIMIT).map(toHighlight),
      meals: todayFeeds.slice(0, MEALS_LIMIT).map(toHighlight),
      mealsToday: todayFeeds.length,
      todaySleepMin,
      sleepWeek,
      avgSleepMin,
      milestonesThisWeek,
    };
  });
}

/**
 * Family-scoped Row-2 aggregates. `Database` + `familyId` + `requestingUserId` +
 * `timeZone` are injected so the fold (and its teen redaction) is unit-testable
 * without the server-only auth chain; loadHomeChildDays is the request wrapper. A
 * rolling-7-day fetch is a superset of the 7 local days the fold keys on, so a log
 * near the UTC/ local-midnight boundary is never missed.
 */
export async function readHomeChildDays(
  database: Database,
  familyId: string,
  requestingUserId: string | null,
  timeZone: string,
  now: Date = new Date(),
): Promise<HomeChildDays[]> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const since = new Date(now.getTime() - WEEK_DAYS * DAY_MS);
  const rows = await database
    .select({
      id: schema.familyMemoryEpisodes.id,
      childId: schema.familyMemoryEpisodes.childId,
      authoredBy: schema.familyMemoryEpisodes.authoredBy,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      summary: schema.familyMemoryEpisodes.summary,
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
      payload: schema.familyMemoryEpisodes.payload,
    })
    .from(schema.familyMemoryEpisodes)
    .where(
      and(
        eq(schema.familyMemoryEpisodes.familyId, familyId),
        isNull(schema.familyMemoryEpisodes.deletedAt),
        gte(schema.familyMemoryEpisodes.occurredAt, since),
      ),
    )
    .orderBy(desc(schema.familyMemoryEpisodes.occurredAt));

  return foldChildDays(rows, children, requestingUserId, timeZone, now);
}

/**
 * Request wrapper. Same degradation as the other Home loaders: no DATABASE_URL
 * (preview) or no resolved family (unauthed / onboarding incomplete) → empty list
 * (the honest empty state). A genuine query failure once a DB exists must surface
 * (rule #8), so it is deliberately NOT caught.
 */
export async function loadHomeChildDays(): Promise<HomeChildDays[]> {
  if (!process.env.DATABASE_URL) return [];
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return [];
  const [requestingUserId, timeZone] = await Promise.all([
    currentUserId(database),
    loadFamilyTimezone(),
  ]);
  return readHomeChildDays(database, familyId, requestingUserId, timeZone);
}
