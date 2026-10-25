import { type Database, type Municipality, schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import {
  type ActivityFinder,
  type ActivityPick,
  createActivityFinder,
} from '~/lib/channel/activity/lane';
import { safeHttpUrl } from '~/lib/format/http-url';
import { activityClient } from '~/lib/pipeline/client';
import { municipalitiesForFsa } from '~/lib/registration/fsa-municipalities';
import { resolveActiveAreaCoarse } from './areas';

/**
 * VIL-452 · the Finder's link field is `url`; receipts and dedupe read `sourceUrl`.
 * Normalize once at every offer boundary: an existing sourceUrl wins, and only a safe
 * absolute http(s) link is kept. Never invents a URL.
 */
export function withSourceUrl<T extends { url?: string; sourceUrl?: string }>(pick: T): T {
  const sourceUrl = safeHttpUrl(pick.sourceUrl) ?? safeHttpUrl(pick.url) ?? undefined;
  return { ...pick, sourceUrl };
}

/** Identity only, never facts to answer with. A new dated occurrence is a new offer. */
export function activityRecommendationKey(pick: {
  name: string;
  sourceUrl?: string | null;
  eventDate?: string | null;
  when?: string | null;
}): string | null {
  if (!pick.sourceUrl) return null;
  let source: URL;
  try {
    source = new URL(pick.sourceUrl);
  } catch {
    return null;
  }
  source.hash = '';
  for (const key of [...source.searchParams.keys()]) {
    if (/^utm_|^(gclid|fbclid)$/i.test(key)) source.searchParams.delete(key);
  }
  source.searchParams.sort();
  const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  // shortcut: undated recurrence uses the source's when label; structured session IDs can replace this when available.
  return JSON.stringify([
    source.toString(),
    normalized(pick.name),
    pick.eventDate ?? normalized(pick.when ?? ''),
  ]);
}

export async function unofferedActivityPicks(
  database: Database,
  familyId: string,
  picks: readonly ActivityPick[],
) {
  if (picks.length === 0) return [];
  const history = await database
    .select({
      name: schema.familyActivityHistory.title,
      sourceUrl: schema.familyActivityHistory.sourceUrl,
      eventDate: schema.familyActivityHistory.eventDate,
      when: schema.familyActivityHistory.whenLabel,
    })
    .from(schema.familyActivityHistory)
    .where(
      and(
        eq(schema.familyActivityHistory.familyId, familyId),
        isNotNull(schema.familyActivityHistory.offeredAt),
      ),
    );
  const seen = new Set(
    history.map(activityRecommendationKey).filter((key): key is string => key !== null),
  );
  return picks.filter((pick) => {
    const key = activityRecommendationKey(pick);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * VIL-451 · receipt identity for a parent-initiated re-read. A linked pick uses its
 * recommendation key; a linkless pick (no safe URL) falls back to venue + name +
 * date/when so a repeat read reuses its receipt instead of writing a new one.
 */
export function offerReceiptKey(pick: {
  name: string;
  sourceUrl?: string | null;
  sourceName?: string | null;
  eventDate?: string | null;
  when?: string | null;
}): string {
  const linked = activityRecommendationKey(pick);
  if (linked !== null) return linked;
  const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([
    'linkless',
    normalized(pick.sourceName ?? ''),
    normalized(pick.name),
    pick.eventDate ?? normalized(pick.when ?? ''),
  ]);
}

/**
 * VIL-451 · the newest existing offer receipt for each receipt key this family has
 * already been offered. Lets a parent-initiated read show a still current activity
 * again WITHOUT writing a duplicate offer row.
 */
export async function offeredReceiptIdsByKey(
  database: Database,
  familyId: string,
): Promise<Map<string, string>> {
  const history = await database
    .select({
      id: schema.familyActivityHistory.id,
      name: schema.familyActivityHistory.title,
      sourceUrl: schema.familyActivityHistory.sourceUrl,
      sourceName: schema.familyActivityHistory.venueName,
      eventDate: schema.familyActivityHistory.eventDate,
      when: schema.familyActivityHistory.whenLabel,
      offeredAt: schema.familyActivityHistory.offeredAt,
    })
    .from(schema.familyActivityHistory)
    .where(
      and(
        eq(schema.familyActivityHistory.familyId, familyId),
        isNotNull(schema.familyActivityHistory.offeredAt),
      ),
    );
  const byKey = new Map<string, { id: string; at: number }>();
  for (const row of history) {
    const key = offerReceiptKey(row);
    const at = row.offeredAt?.getTime() ?? 0;
    const prior = byKey.get(key);
    if (!prior || at > prior.at) byKey.set(key, { id: row.id, at });
  }
  return new Map([...byKey].map(([key, value]) => [key, value.id]));
}

/** Current picks come from this operation's web research, never from saved history. */
export async function findFamilyActivities(
  database: Database,
  familyId: string,
  options: {
    subject?: string;
    window?: string;
    now?: Date;
    finder?: ActivityFinder;
    excludePreviouslyOffered?: boolean;
  } = {},
): Promise<{
  picks: ActivityPick[];
  reason: string | null;
}> {
  const now = options.now ?? new Date();
  const [children, area, parents] = await Promise.all([
    database
      .select({ name: schema.children.name, dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId)),
    resolveActiveAreaCoarse(database, familyId),
    database
      .select({ name: schema.users.name })
      .from(schema.familyMembers)
      .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
      .where(eq(schema.familyMembers.familyId, familyId)),
  ]);
  const eligible = children.filter((child) => deriveStage(child.dateOfBirth, now) !== 'teenager');
  if (eligible.length === 0) return { picks: [], reason: 'no_non_teen_children' };
  const towns = area
    ? municipalitiesForFsa(area.replace(/\s+/g, '').toUpperCase().slice(0, 3))
    : [];
  if (towns.length !== 1) return { picks: [], reason: 'no_area' };
  const youngest = [...eligible].sort(
    (a, b) => ageInMonths(a.dateOfBirth, now) - ageInMonths(b.dateOfBirth, now),
  )[0]!;
  const query = deidentifyActivityQuery({
    subject: options.subject ?? 'local activities for kids',
    window: options.window ?? 'this year',
    municipality: towns.length === 1 ? (towns[0]! as Municipality) : null,
    stage: deriveStage(youngest.dateOfBirth, now),
    householdNames: [...children, ...parents].flatMap(({ name }) =>
      name ? [name, name.trim().split(/\s+/)[0]!] : [],
    ),
  });
  if (!query.ok) return { picks: [], reason: query.refusal };
  // A stored city is coarse context, not a postal code or precise home address.
  const found = await (options.finder ?? createActivityFinder(activityClient)).find({
    ...query.query,
    stages: [...new Set(eligible.map((child) => deriveStage(child.dateOfBirth, now)))],
  });
  if (found.found) {
    found.picks = found.picks.map((pick) => ({ ...pick, sourceUrl: pick.sourceUrl ?? pick.url }));
    const urls = found.picks.flatMap((pick) => (pick.sourceUrl ? [pick.sourceUrl] : []));
    const venues = urls.length
      ? await database
          .select({
            id: schema.familyActivityHistory.civicVenueId,
            url: schema.familyActivityHistory.sourceUrl,
          })
          .from(schema.familyActivityHistory)
          .where(
            and(
              eq(schema.familyActivityHistory.familyId, familyId),
              inArray(schema.familyActivityHistory.sourceUrl, urls),
              isNotNull(schema.familyActivityHistory.civicVenueId),
            ),
          )
      : [];
    // Identity only. A shared dataset URL is not one venue, and no cached date is read.
    for (const pick of found.picks) {
      const ids = new Set(
        venues
          .filter((venue) => venue.url === pick.sourceUrl)
          .flatMap((venue) => (venue.id ? [venue.id] : [])),
      );
      if (ids.size === 1) pick.civicVenueId ??= [...ids][0];
    }
  }
  return found.found
    ? {
        picks: options.excludePreviouslyOffered
          ? await unofferedActivityPicks(database, familyId, found.picks)
          : found.picks,
        reason: null,
      }
    : {
        picks: [],
        reason: found.reason,
      };
}

/** Persist only the picks returned to a family, for saves, shares and offer provenance. */
export async function recordActivityOffers(
  database: Database,
  familyId: string,
  picks: readonly ActivityPick[],
  now = new Date(),
) {
  if (picks.length === 0) return [];
  const normalized = picks.map(withSourceUrl);
  return database.transaction(async (tx) => {
    const rows = await tx
      .insert(schema.familyActivityHistory)
      .values(
        normalized.map((pick) => ({
          familyId,
          ...offerFacts(pick),
          kind: 'activity',
          source: 'web',
          confidence: 1,
          offeredAt: now,
          discoveredAt: now,
        })),
      )
      .returning();
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'activity.offered',
      targetTable: 'family_activity_history',
      after: { count: rows.length },
    });
    return rows;
  });
}

/** The live facts a receipt shows. Shared by a new receipt and a refreshed one. */
function offerFacts(pick: ActivityPick) {
  return {
    title: pick.name,
    summary: [pick.ageFit, pick.when, pick.price].filter(Boolean).join(' — '),
    venueName: pick.sourceName,
    ageRange: pick.ageFit,
    whenLabel: pick.when,
    eventDate: pick.eventDate ?? null,
    indoorOutdoor: pick.indoorOutdoor ?? null,
    access: pick.access ?? null,
    placeId: pick.placeId ?? null,
    civicVenueId: pick.civicVenueId ?? null,
    priceLevel: pick.price && /^(free|\$0\b|no cost)/i.test(pick.price) ? 'free' : null,
    sourceUrl: pick.sourceUrl ?? null,
  };
}

/**
 * VIL-451 · a repeat parent read reuses the receipt row (saved state and identity
 * survive) but rewrites its facts from THIS read's live result, so price, age and
 * summary never come from the old offer.
 */
export async function refreshActivityOffers(
  database: Database,
  familyId: string,
  refreshes: readonly { id: string; pick: ActivityPick }[],
  now = new Date(),
) {
  if (refreshes.length === 0) return;
  await database.transaction(async (tx) => {
    for (const { id, pick } of refreshes) {
      await tx
        .update(schema.familyActivityHistory)
        .set({ ...offerFacts(withSourceUrl(pick)), offeredAt: now })
        .where(
          and(
            eq(schema.familyActivityHistory.id, id),
            eq(schema.familyActivityHistory.familyId, familyId),
          ),
        );
    }
  });
}
