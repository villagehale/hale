import { type Database, schema } from '@hale/db';
import type { Municipality } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { and, eq, gte, isNull, or } from 'drizzle-orm';
import { DEFAULT_TIMEZONE, dayKeyOf } from '~/lib/format/datetime';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import type { LatLng } from '~/lib/village/geocode';
import { MIN_SURFACE_CONFIDENCE } from './parse-hours';

/**
 * VIL-252 · M16 — turning family-agnostic civic facts into this family's feed.
 *
 * WHY A PROJECTION AND NOT A WRITE-THROUGH. civic_sessions holds one row per real
 * session; village_candidates is per family. Writing every Toronto library event
 * into every household would be ~6,000 rows per family and would make "is this
 * still true?" a question with N answers. Instead the sweep keeps the facts
 * correct once, and this selects the handful a given family should actually see.
 *
 * EVERY PROJECTED ROW IS DATED. A weekly drop-in is projected as its NEXT
 * occurrence, not as an evergreen "somewhere you could go", because the radar
 * places an undated candidate on either weekend day — which would cheerfully
 * offer a Wednesday-only EarlyON drop-in as a Saturday plan. Dating the row is
 * what makes that structurally impossible. It costs a nuance (the card does not
 * say "every Wednesday"), and that is the right trade: an omitted recurrence is
 * incomplete, a wrong day is false.
 *
 * The rows land under run_type 'civic' so they COEXIST with the LLM standing feed
 * — neither supersedes the other (see villageActiveFilter).
 */

/** Civic rows are their own run type so the weekly sweep and the LLM discovery
 * run can never clobber each other's candidates. */
export const CIVIC_RUN_TYPE = 'civic';

/** Which discovery provider produced the row, for village_candidates.source. */
export const CIVIC_SOURCE = 'civic_registry';

/** A feed is a shortlist, not a directory. Eight is enough to feel local without
 * burying the LLM feed's picks underneath a library's whole calendar. */
export const MAX_CIVIC_CANDIDATES_PER_FAMILY = 8;

/** How far ahead a projected session may sit. Beyond this it is not this week's
 * news, and the row would age out of the feed's freshness window anyway. */
const FORWARD_WINDOW_DAYS = 21;

/**
 * VIL-260 · WS5 — how far a civic pick may be from a family's coarse area.
 *
 * Municipality was the only locality gate, and "Toronto" is one bucket 45 km
 * across: a Scarborough family's Saturday storytime could be in Etobicoke. The
 * venue coordinates were already stored and simply never read.
 *
 * `PREFERRED` is a RANKING boundary, not a filter — inside it a session is
 * genuinely local ("we could walk / it's ten minutes"), so those fill the
 * shortlist first and a further one only appears when they run out. `MAX` is the
 * filter, and it is deliberately generous: past it, a drop-in programme costs
 * more in travel than it gives back, and offering it is worse than an empty feed.
 */
export const PREFERRED_RADIUS_KM = 8;
export const MAX_RADIUS_KM = 15;

/** Mean earth radius, the sphere the haversine below is measured on. */
const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance in kilometres. A flat-earth approximation is wrong by
 * ~28% on an east-west leg at Toronto's latitude, which is the difference between
 * "across the neighbourhood" and "across the city" — so the real formula, on a
 * layer whose entire job is to know which of those two a venue is.
 */
export function haversineKm(from: LatLng, to: LatLng): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Which municipality a venue's city belongs to, so a family's FSA (already
 * resolved to municipalities by M1's hand-verified coverage) can be matched to
 * venues without a geocoding call.
 *
 * Toronto's pre-amalgamation names still appear verbatim in the City's own
 * EarlyON feed ("East York", "Scarborough", "York"), and Thornhill is the postal
 * city for Markham Public Library's Thornhill branch. A city not in this map
 * matches nothing — an unmatched venue is invisible, never guessed into the
 * nearest municipality.
 */
const CITY_TO_MUNICIPALITY: Readonly<Record<string, Municipality>> = {
  toronto: 'toronto',
  'east york': 'toronto',
  'north york': 'toronto',
  scarborough: 'toronto',
  etobicoke: 'toronto',
  york: 'toronto',
  markham: 'markham',
  thornhill: 'markham',
  unionville: 'markham',
  'richmond hill': 'richmond_hill',
  vaughan: 'vaughan',
  mississauga: 'mississauga',
};

export function municipalityForCity(city: string | null): Municipality | null {
  if (city === null) return null;
  return CITY_TO_MUNICIPALITY[city.trim().toLowerCase()] ?? null;
}

/** The session fields the selection actually turns on. */
export interface CivicSessionForFamily {
  id: string;
  title: string;
  summary: string | null;
  recurrence: string;
  startsAt: Date | null;
  dayOfWeek: number | null;
  startMinute: number | null;
  endMinute: number | null;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  registrationRequired: boolean;
  isCancelled: boolean;
  confidence: number;
  sourceUrl: string;
  venueName: string;
  venueAddress: string | null;
  venueCity: string | null;
  venueUrl: string | null;
  venueKind: string;
  lat: number | null;
  lng: number | null;
}

export interface ProjectedCivicCandidate {
  title: string;
  kind: string;
  summary: string;
  eventDate: string;
  sourceUrl: string;
  venueName: string;
  venueAddress: string | null;
  lat: number | null;
  lng: number | null;
  ageRange: string | null;
  confidence: number;
  /** Kilometres from the family's coarse-area centroid, or null when either the
   * area or the venue could not be placed. Carried so nothing downstream has to
   * re-derive what this layer already computed to rank the shortlist. */
  distanceKm: number | null;
}

/** `570` → `"9:30 a.m."`, in the municipal spelling these sources publish. */
export function formatMinuteOfDay(minute: number): string {
  const hours24 = Math.floor(minute / 60);
  const minutes = minute % 60;
  if (hours24 === 12 && minutes === 0) return 'noon';
  const meridiem = hours24 < 12 ? 'a.m.' : 'p.m.';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes).padStart(2, '0')} ${meridiem}`;
}

/** The local `YYYY-MM-DD` of the next `dayOfWeek` at or after `now`. A slot whose
 * day is today counts as today only if it has not already ended. */
export function nextOccurrenceDay(
  dayOfWeek: number,
  endMinute: number,
  now: Date,
  timeZone: string,
): string {
  const todayKey = dayKeyOf(now, timeZone);
  const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(now);
  const todayDow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts);
  const nowMinutes = (() => {
    const hm = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(now);
    const [h, m] = hm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  })();

  let delta = (dayOfWeek - todayDow + 7) % 7;
  if (delta === 0 && nowMinutes >= endMinute) delta = 7;

  const base = new Date(`${todayKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString().slice(0, 10);
}

/**
 * Pick the sessions this family should see. Pure — no clock beyond `now`, no
 * database — so the whole selection rule is unit-testable.
 *
 * A session is eligible only when it is uncancelled, confident enough to state
 * out loud, close enough to actually go to, and either open to all ages or
 * overlapping a child in this household.
 *
 * `center` is the family's COARSE-area centroid (rule #1 — an FSA's middle, never
 * a home). With one, anything past MAX_RADIUS_KM is dropped and anything inside
 * PREFERRED_RADIUS_KM fills the shortlist first; a venue with no coordinates is
 * dropped, because "nearby" is then a claim nothing supports. With `center` null
 * — the area could not be geocoded — the whole distance rule stands down and the
 * municipality gate is again the only locality guarantee: a Places outage costs a
 * family precision, never their feed.
 *
 * Soonest first within each proximity tier; ties broken by distance then title so
 * a run is stable.
 */
export function selectCivicSessions(
  sessions: readonly CivicSessionForFamily[],
  childAgesMonths: readonly number[],
  center: LatLng | null,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
  limit: number = MAX_CIVIC_CANDIDATES_PER_FAMILY,
): ProjectedCivicCandidate[] {
  const todayKey = dayKeyOf(now, timeZone);
  const horizon = new Date(now.getTime() + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const horizonKey = dayKeyOf(horizon, timeZone);

  const projected: ProjectedCivicCandidate[] = [];

  for (const session of sessions) {
    // A cancelled session is a fact worth keeping in the registry and never worth
    // putting on a parent's calendar.
    if (session.isCancelled) continue;
    // Better silent than wrong about a time (see MIN_SURFACE_CONFIDENCE).
    if (session.confidence < MIN_SURFACE_CONFIDENCE) continue;
    if (!fitsAnyChild(session, childAgesMonths)) continue;

    const distanceKm = distanceFor(session, center);
    if (center !== null && (distanceKm === null || distanceKm > MAX_RADIUS_KM)) continue;

    const when = occurrenceFor(session, now, timeZone);
    if (when === null) continue;
    if (when.day < todayKey || when.day > horizonKey) continue;

    projected.push({
      title: session.title,
      kind: session.venueKind === 'library_branch' ? 'library' : 'drop_in',
      summary: summaryFor(session, when.label),
      eventDate: when.day,
      sourceUrl: session.sourceUrl,
      venueName: session.venueName,
      venueAddress: session.venueAddress,
      lat: session.lat,
      lng: session.lng,
      ageRange: ageRangeLabel(session),
      confidence: session.confidence,
      distanceKm,
    });
  }

  projected.sort(
    (a, b) =>
      proximityTier(a) - proximityTier(b) ||
      a.eventDate.localeCompare(b.eventDate) ||
      (a.distanceKm ?? 0) - (b.distanceKm ?? 0) ||
      a.title.localeCompare(b.title),
  );
  return projected.slice(0, limit);
}

/** 0 for genuinely local, 1 for the rest — so a nearby session later in the week
 * beats a further one tomorrow, and the cap is what carries that preference to
 * every downstream reader of village_candidates. */
function proximityTier(candidate: ProjectedCivicCandidate): number {
  if (candidate.distanceKm === null) return 0;
  return candidate.distanceKm <= PREFERRED_RADIUS_KM ? 0 : 1;
}

function distanceFor(session: CivicSessionForFamily, center: LatLng | null): number | null {
  if (center === null || session.lat === null || session.lng === null) return null;
  return haversineKm(center, { lat: session.lat, lng: session.lng });
}

function fitsAnyChild(
  session: CivicSessionForFamily,
  childAgesMonths: readonly number[],
): boolean {
  // No stated band means the source said "everyone" — it covers any household.
  if (session.ageMinMonths === null && session.ageMaxMonths === null) return true;
  // A family with no children on file still sees all-ages programming above, but
  // nothing age-targeted: we have no fact that says it fits.
  const min = session.ageMinMonths ?? 0;
  const max = session.ageMaxMonths ?? Number.MAX_SAFE_INTEGER;
  return childAgesMonths.some((age) => age >= min && age <= max);
}

function occurrenceFor(
  session: CivicSessionForFamily,
  now: Date,
  timeZone: string,
): { day: string; label: string } | null {
  if (session.recurrence === 'occurrence') {
    if (session.startsAt === null) return null;
    return {
      day: dayKeyOf(session.startsAt, timeZone),
      label: new Intl.DateTimeFormat('en-CA', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }).format(session.startsAt),
    };
  }
  if (session.dayOfWeek === null || session.startMinute === null || session.endMinute === null) {
    return null;
  }
  return {
    day: nextOccurrenceDay(session.dayOfWeek, session.endMinute, now, timeZone),
    label: `${formatMinuteOfDay(session.startMinute)}–${formatMinuteOfDay(session.endMinute)}`,
  };
}

function summaryFor(session: CivicSessionForFamily, timeLabel: string): string {
  const access = session.registrationRequired ? 'Registration required' : 'Free drop-in';
  const where = session.venueCity === null ? session.venueName : `${session.venueName}, ${session.venueCity}`;
  return `${access} at ${where} — ${timeLabel}.`;
}

/** Below this a band is only legible in months: rendering "birth to 12 months"
 * as "0–1 years" describes a one-year-old's programme, not a lap-bounce. */
const MONTHS_LABEL_CEILING = 24;

/**
 * A human age hint, only when the source actually stated a band.
 *
 * ASCII punctuation on purpose: this string is persisted and read back out over
 * SMS, and an en dash is one more character that has to survive every transport
 * intact (WS1's outbound normalizer is the backstop, not the licence).
 */
function ageRangeLabel(session: CivicSessionForFamily): string | null {
  if (session.ageMinMonths === null || session.ageMaxMonths === null) return null;
  if (session.ageMaxMonths < MONTHS_LABEL_CEILING) {
    return `${session.ageMinMonths}-${session.ageMaxMonths} months`;
  }
  const toYears = (months: number) => Math.floor(months / 12);
  return `${toYears(session.ageMinMonths)}-${toYears(session.ageMaxMonths)} years`;
}

/**
 * Read this family's eligible civic sessions, select, and replace their civic
 * candidates. Supersede-then-insert scoped to run_type 'civic', so the LLM
 * standing feed is untouched — and one audit row for the whole projection
 * (rule #6).
 *
 * `center` is required rather than defaulted: a caller that forgets it would
 * silently lose the proximity rule and start offering cross-town storytimes
 * again, so "we could not place this family" has to be said out loud (null).
 */
export async function projectCivicCandidates(
  database: Database,
  familyId: string,
  areaCoarse: string | null,
  center: LatLng | null,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIMEZONE,
): Promise<number> {
  // No area means nothing to place a family near — and a neighbouring city's
  // storytime is worse than silence (M1's rule).
  if (areaCoarse === null) return 0;
  const municipalities = new Set(resolveMunicipalities(areaCoarse));
  if (municipalities.size === 0) return 0;

  const children = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const childAges = children
    .map((child) => (child.dateOfBirth === null ? null : ageInMonths(child.dateOfBirth, now)))
    .filter((age): age is number => age !== null);

  const rows = await database
    .select({
      id: schema.civicSessions.id,
      title: schema.civicSessions.title,
      summary: schema.civicSessions.summary,
      recurrence: schema.civicSessions.recurrence,
      startsAt: schema.civicSessions.startsAt,
      dayOfWeek: schema.civicSessions.dayOfWeek,
      startMinute: schema.civicSessions.startMinute,
      endMinute: schema.civicSessions.endMinute,
      ageMinMonths: schema.civicSessions.ageMinMonths,
      ageMaxMonths: schema.civicSessions.ageMaxMonths,
      registrationRequired: schema.civicSessions.registrationRequired,
      isCancelled: schema.civicSessions.isCancelled,
      confidence: schema.civicSessions.confidence,
      sourceUrl: schema.civicSessions.sourceUrl,
      venueName: schema.civicVenues.name,
      venueAddress: schema.civicVenues.address,
      venueCity: schema.civicVenues.city,
      venueUrl: schema.civicVenues.url,
      venueKind: schema.civicVenues.kind,
      lat: schema.civicVenues.lat,
      lng: schema.civicVenues.lng,
    })
    .from(schema.civicSessions)
    .innerJoin(schema.civicVenues, eq(schema.civicSessions.venueId, schema.civicVenues.id))
    .where(
      and(
        isNull(schema.civicSessions.supersededAt),
        eq(schema.civicSessions.isCancelled, false),
        gte(schema.civicSessions.confidence, MIN_SURFACE_CONFIDENCE),
        // A dated session in the past is dead weight; weekly rows have no instant.
        or(
          isNull(schema.civicSessions.startsAt),
          gte(schema.civicSessions.startsAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)),
        ),
      ),
    );

  const local = rows.filter((row) => {
    const municipality = municipalityForCity(row.venueCity);
    return municipality !== null && municipalities.has(municipality);
  });

  const picks = selectCivicSessions(local, childAges, center, now, timeZone);

  await database.transaction(async (tx) => {
    await tx
      .update(schema.villageCandidates)
      .set({ supersededAt: now })
      .where(
        and(
          eq(schema.villageCandidates.familyId, familyId),
          isNull(schema.villageCandidates.supersededAt),
          eq(schema.villageCandidates.runType, CIVIC_RUN_TYPE),
        ),
      );

    if (picks.length > 0) {
      await tx.insert(schema.villageCandidates).values(
        picks.map((pick) => ({
          familyId,
          childId: null,
          title: pick.title,
          kind: pick.kind,
          cadence: null,
          summary: pick.summary,
          sourceUrl: pick.sourceUrl,
          source: CIVIC_SOURCE,
          confidence: pick.confidence,
          coverageNote: null,
          eventDate: pick.eventDate,
          seasons: null,
          lat: pick.lat,
          lng: pick.lng,
          venueName: pick.venueName,
          venueAddress: pick.venueAddress,
          // Free by policy at every source in this layer — and the radar's
          // free-first ordering reads exactly this field.
          priceLevel: 'free',
          ageRange: pick.ageRange,
          indoorOutdoor: 'indoor',
          runType: CIVIC_RUN_TYPE,
          searchSeason: null,
          discoveredAt: now,
        })),
      );
    }

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'civic.candidates.projected',
      targetTable: 'village_candidates',
      // `placed` records whether the proximity rule actually ran: a geocoding
      // outage degrades to municipality-only silently by design, and this is the
      // only place that degradation is visible afterwards.
      after: { areaCoarse, count: picks.length, source: CIVIC_SOURCE, placed: center !== null },
    });
  });

  return picks.length;
}
