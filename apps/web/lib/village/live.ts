import { type Database, schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { deidentifyActivityQuery } from '~/lib/channel/activity/deidentify';
import type { ActivityReference } from '~/lib/channel/activity/facts';
import {
  type ActivityFinder,
  type ActivityPick,
  createActivityFinder,
} from '~/lib/channel/activity/lane';
import { readActivityLocation, readActivityTimeZone } from '~/lib/channel/activity/reader';
import { activityClient } from '~/lib/pipeline/client';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import { resolveActiveAreaCoarse } from './areas';

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
  references?: ActivityReference[];
  checkedSources?: string[];
}> {
  const now = options.now ?? new Date();
  const [city, children, area, parents, timeZone] = await Promise.all([
    readActivityLocation(database, familyId),
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
    readActivityTimeZone(database, familyId),
  ]);
  const eligible = children.filter((child) => deriveStage(child.dateOfBirth, now) !== 'teenager');
  if (eligible.length === 0) return { picks: [], reason: 'no_non_teen_children' };
  const towns = area ? resolveMunicipalities(area) : [];
  if (towns.length !== 1 && !city) return { picks: [], reason: 'no_area' };
  const youngest = [...eligible].sort(
    (a, b) => ageInMonths(a.dateOfBirth, now) - ageInMonths(b.dateOfBirth, now),
  )[0]!;
  const query = deidentifyActivityQuery({
    timeZone,
    subject: options.subject ?? 'local activities for kids',
    window: options.window ?? 'this year',
    municipality: towns.length === 1 ? towns[0]! : null,
    location: city,
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
        ...(found.references ? { references: found.references } : {}),
        ...(found.checkedSources ? { checkedSources: found.checkedSources } : {}),
      }
    : {
        picks: [],
        reason: found.reason,
        ...(found.searched
          ? {
              references: found.searched.references ?? [],
              checkedSources: found.searched.checkedSources ?? [],
            }
          : {}),
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
  return database.transaction(async (tx) => {
    const rows = await tx
      .insert(schema.familyActivityHistory)
      .values(
        picks.map((pick) => ({
          familyId,
          title: pick.name,
          kind: 'activity',
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
          source: 'web',
          sourceUrl: pick.sourceUrl ?? null,
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
