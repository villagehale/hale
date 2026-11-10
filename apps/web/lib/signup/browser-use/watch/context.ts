import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { signupProviderHost } from '../../consent';
import { browserUseWatchEnabled } from './flag';
import type { WatchItem } from './outcome';

/**
 * What Hale's watch last read on the providers THIS family deals with, handed to the
 * reply model as data, the way registration windows are. The model decides whether
 * and how to tell the parent; there is no sentence here.
 *
 * A family's providers are the hosts of its booking emails (activity_bookings) and of
 * the course pages it asked Hale to watch (watched_spots, unreleased). A watch reading
 * matches when the hosts are equal or one is a subdomain of the other
 * (`cityofx.perfectmind.com` vs a booking mail from `perfectmind.com`).
 *
 * No URL rides along: the model gets the provider name and the structured items only
 * (the page address stays in the database for the engine).
 *
 * Empty when the flag is off, when nothing matches, or when the newest reading is
 * older than WATCH_CONTEXT_MAX_AGE_MS, and then the caller omits the key entirely so
 * an ordinary turn's prompt bytes do not change.
 */
export const WATCH_CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const WATCH_CONTEXT_MAX_PAGES = 5;

export interface ProviderWatchContext {
  provider: string;
  kind: string;
  /** When Hale's watch read the page, ISO. */
  checkedAt: string;
  items: WatchItem[];
}

export function sameProviderHost(a: string, b: string): boolean {
  const x = signupProviderHost(a);
  const y = signupProviderHost(b);
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

function hostOf(url: string): string | null {
  try {
    return signupProviderHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export async function loadProviderWatchContext(
  database: Database,
  familyId: string,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderWatchContext[]> {
  if (!browserUseWatchEnabled(env)) return [];

  const [bookings, spots, subscribed] = await Promise.all([
    database
      .selectDistinct({ host: schema.activityBookings.providerHost })
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, familyId)),
    database
      .select({ url: schema.watchedSpots.sourceUrl })
      .from(schema.watchedSpots)
      .where(
        and(eq(schema.watchedSpots.familyId, familyId), isNull(schema.watchedSpots.releasedAt)),
      ),
    database
      .select({ host: schema.providerWatchTargets.providerHost })
      .from(schema.familyWatchSubscriptions)
      .innerJoin(
        schema.providerWatchTargets,
        eq(schema.providerWatchTargets.id, schema.familyWatchSubscriptions.targetId),
      )
      .where(
        and(
          eq(schema.familyWatchSubscriptions.familyId, familyId),
          isNull(schema.familyWatchSubscriptions.removedAt),
        ),
      ),
  ]);
  const familyHosts = [
    ...bookings.map((row) => signupProviderHost(row.host)),
    ...spots.map((row) => hostOf(row.url)).filter((host): host is string => host !== null),
    ...subscribed.map((row) => signupProviderHost(row.host)),
  ];
  if (familyHosts.length === 0) return [];

  const readings = await database
    .select({
      targetId: schema.providerWatchReadings.targetId,
      provider: schema.providerWatchReadings.providerHost,
      reading: schema.providerWatchReadings.reading,
      readAt: schema.providerWatchReadings.readAt,
      kind: schema.providerWatchTargets.kind,
    })
    .from(schema.providerWatchReadings)
    .innerJoin(
      schema.providerWatchTargets,
      eq(schema.providerWatchTargets.id, schema.providerWatchReadings.targetId),
    )
    .where(
      and(
        eq(schema.providerWatchReadings.outcome, 'read'),
        gte(
          schema.providerWatchReadings.readAt,
          new Date(now.getTime() - WATCH_CONTEXT_MAX_AGE_MS),
        ),
      ),
    )
    .orderBy(desc(schema.providerWatchReadings.readAt))
    .limit(200);

  const seen = new Set<string>();
  const out: ProviderWatchContext[] = [];
  for (const row of readings) {
    if (seen.has(row.targetId)) continue;
    seen.add(row.targetId);
    if (!familyHosts.some((host) => sameProviderHost(host, row.provider))) continue;
    const items = Array.isArray(row.reading?.items) ? (row.reading.items as WatchItem[]) : [];
    out.push({
      provider: row.provider,
      kind: row.kind,
      checkedAt: row.readAt.toISOString(),
      items,
    });
    if (out.length >= WATCH_CONTEXT_MAX_PAGES) break;
  }
  return out;
}
