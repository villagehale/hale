import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { registrationSeasonOf } from '@hale/types';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { HOME_METRO } from '~/lib/travel/away';
import { AREA_CODE_SPANS, AREA_CODE_ZONE } from './family-tz-nanp';
import { timezoneForIntakePostal } from './intake/postal-zone';
import { cityInCountry, matchPostalToken } from './off-domain/place';
import { areaCodeOf } from './proactive/quiet';

/**
 * VIL-709. A family whose zone was never resolved stays on the users.timezone
 * default, UTC. Quiet hours and the registration season then run on the wrong
 * clock. This module resolves a zone from the best signal we already stored —
 * the place, the phone's area code, the home metro, or a city or region on the
 * family row — and, when none of those is one zone, names the North American
 * zones the family might still be in. It does not read a message, and it does
 * not write a sentence to the parent.
 *
 * The column default is left alone. A resolved zone is stored on
 * `resolved_timezone` and used only while {@link familyTzResolveEnabled} is on,
 * so a dark flag keeps today's UTC clock.
 */

export const FAMILY_TZ_RESOLVE_ENABLED_ENV = 'FAMILY_TZ_RESOLVE_ENABLED';

export type TimezoneSource = 'place' | 'phone' | 'metro' | 'stated' | 'household';

export type ParentClock =
  | { kind: 'zone'; timeZone: string; source: TimezoneSource | 'stored' }
  | { kind: 'unresolved'; zones: readonly string[] };

/** Exact `true`. A trailing newline, `TRUE`, or `1` stays off. */
export function familyTzResolveEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('family-tz-resolve', undefined, env);
}

/**
 * Zones Hale already assigns to a Canadian or US place (postal-zone.ts).
 * The unresolved clock is the union of these, narrowed when a signal says
 * which of them are still possible. Hawaii through Newfoundland: a text may
 * leave only while it is daytime in every one of them.
 */
export const CANADA_ZONES = [
  'America/Blanc-Sablon',
  'America/Cambridge_Bay',
  'America/Edmonton',
  'America/Goose_Bay',
  'America/Halifax',
  'America/Iqaluit',
  'America/Moncton',
  'America/Rankin_Inlet',
  'America/Regina',
  'America/St_Johns',
  'America/Toronto',
  'America/Vancouver',
  'America/Whitehorse',
  'America/Winnipeg',
  'America/Yellowknife',
] as const;

export const UNITED_STATES_ZONES = [
  'America/Anchorage',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/New_York',
  'America/Phoenix',
  'Pacific/Honolulu',
] as const;

const NORTH_AMERICAN_ZONES: readonly string[] = [...CANADA_ZONES, ...UNITED_STATES_ZONES];

/** Provinces and states that sit in one zone. A region that spans zones is absent. */
const CANADA_REGION_ZONE: Readonly<Record<string, string>> = {
  alberta: 'America/Edmonton',
  ab: 'America/Edmonton',
  manitoba: 'America/Winnipeg',
  mb: 'America/Winnipeg',
  'new brunswick': 'America/Moncton',
  nb: 'America/Moncton',
  'nova scotia': 'America/Halifax',
  ns: 'America/Halifax',
  'northwest territories': 'America/Yellowknife',
  nt: 'America/Yellowknife',
  nwt: 'America/Yellowknife',
  'prince edward island': 'America/Halifax',
  pe: 'America/Halifax',
  pei: 'America/Halifax',
  saskatchewan: 'America/Regina',
  sk: 'America/Regina',
  yukon: 'America/Whitehorse',
  yt: 'America/Whitehorse',
};

const US_REGION_ZONE: Readonly<Record<string, string>> = {
  alabama: 'America/Chicago',
  al: 'America/Chicago',
  arkansas: 'America/Chicago',
  ar: 'America/Chicago',
  california: 'America/Los_Angeles',
  ca: 'America/Los_Angeles',
  colorado: 'America/Denver',
  co: 'America/Denver',
  connecticut: 'America/New_York',
  ct: 'America/New_York',
  delaware: 'America/New_York',
  de: 'America/New_York',
  'district of columbia': 'America/New_York',
  dc: 'America/New_York',
  'washington dc': 'America/New_York',
  georgia: 'America/New_York',
  ga: 'America/New_York',
  hawaii: 'Pacific/Honolulu',
  hi: 'Pacific/Honolulu',
  illinois: 'America/Chicago',
  il: 'America/Chicago',
  iowa: 'America/Chicago',
  ia: 'America/Chicago',
  louisiana: 'America/Chicago',
  la: 'America/Chicago',
  maine: 'America/New_York',
  me: 'America/New_York',
  maryland: 'America/New_York',
  md: 'America/New_York',
  massachusetts: 'America/New_York',
  ma: 'America/New_York',
  minnesota: 'America/Chicago',
  mn: 'America/Chicago',
  mississippi: 'America/Chicago',
  ms: 'America/Chicago',
  missouri: 'America/Chicago',
  mo: 'America/Chicago',
  montana: 'America/Denver',
  mt: 'America/Denver',
  'new hampshire': 'America/New_York',
  nh: 'America/New_York',
  'new jersey': 'America/New_York',
  nj: 'America/New_York',
  'new mexico': 'America/Denver',
  nm: 'America/Denver',
  'new york': 'America/New_York',
  ny: 'America/New_York',
  'north carolina': 'America/New_York',
  nc: 'America/New_York',
  ohio: 'America/New_York',
  oh: 'America/New_York',
  oklahoma: 'America/Chicago',
  ok: 'America/Chicago',
  pennsylvania: 'America/New_York',
  pa: 'America/New_York',
  'rhode island': 'America/New_York',
  ri: 'America/New_York',
  'south carolina': 'America/New_York',
  sc: 'America/New_York',
  utah: 'America/Denver',
  ut: 'America/Denver',
  vermont: 'America/New_York',
  vt: 'America/New_York',
  virginia: 'America/New_York',
  va: 'America/New_York',
  washington: 'America/Los_Angeles',
  wa: 'America/Los_Angeles',
  'west virginia': 'America/New_York',
  wv: 'America/New_York',
  wisconsin: 'America/Chicago',
  wi: 'America/Chicago',
  wyoming: 'America/Denver',
  wy: 'America/Denver',
};

/** Full names that are one zone even when the row never said which country. */
const UNAMBIGUOUS_REGION_ZONE: Readonly<Record<string, string>> = {
  alberta: 'America/Edmonton',
  california: 'America/Los_Angeles',
  colorado: 'America/Denver',
  connecticut: 'America/New_York',
  delaware: 'America/New_York',
  hawaii: 'Pacific/Honolulu',
  illinois: 'America/Chicago',
  iowa: 'America/Chicago',
  manitoba: 'America/Winnipeg',
  massachusetts: 'America/New_York',
  minnesota: 'America/Chicago',
  saskatchewan: 'America/Regina',
  yukon: 'America/Whitehorse',
};

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const HOME_METRO_NORM = new Set(HOME_METRO.map((name) => fold(name)));

/** A stored zone that is a real IANA name. UTC is the column default, not a place. */
export function realZone(zone: string | null | undefined): string | null {
  if (!zone || zone === 'UTC') return null;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

export interface FamilyZoneInput {
  storedTimezone: string | null;
  resolvedTimezone: string | null;
  /** Zone the intake place already computed, when its areas share one. */
  knownPlaceZone: string | null;
  country: 'CA' | 'US' | null;
  postalCode: string | null;
  areaCoarse: string | null;
  phone: string | null;
  city: string | null;
  province: string | null;
  /** The stated city's zone when every one of its areas agrees. */
  statedCityZone: string | null;
  /** Zones of a stated city that spans more than one. */
  statedCityZones: readonly string[] | null;
  householdZone: string | null;
}

export type FamilyZoneResult =
  | { status: 'resolved'; zone: string; source: TimezoneSource | 'stored' }
  | { status: 'unresolved'; zones: readonly string[] };

function placeFromCode(country: 'CA' | 'US' | null, raw: string | null): string | null {
  if (!raw) return null;
  const token = matchPostalToken(raw);
  if (!token) return null;
  if (country && country !== token.country) return null;
  const zone = timezoneForIntakePostal(token.country, token.areaKey);
  return zone === 'UTC' ? null : zone;
}

function phoneSignal(phone: string | null): {
  single: string | null;
  spans: readonly string[] | null;
} {
  const code = areaCodeOf(phone);
  if (!code) return { single: null, spans: null };
  const single = AREA_CODE_ZONE[code];
  if (single) return { single, spans: null };
  const spans = AREA_CODE_SPANS[code];
  return { single: null, spans: spans ?? null };
}

/**
 * The GTA, and only the GTA, is one zone. A US row is not the GTA even when
 * the city string is one of its district names ("York").
 */
export function homeMetroZone(
  country: 'CA' | 'US' | null,
  province: string | null,
  city: string | null,
): string | null {
  if (!city || country === 'US') return null;
  const name = fold(city);
  if (!HOME_METRO_NORM.has(name)) return null;
  const region = province ? fold(province) : null;
  if (region && region !== 'ontario' && region !== 'on') return null;
  if (name === 'york' && country !== 'CA') return null;
  return 'America/Toronto';
}

function regionZone(country: 'CA' | 'US' | null, province: string | null): string | null {
  if (!province) return null;
  const key = fold(province);
  if (country === 'CA') return CANADA_REGION_ZONE[key] ?? null;
  if (country === 'US') return US_REGION_ZONE[key] ?? null;
  return UNAMBIGUOUS_REGION_ZONE[key] ?? null;
}

function uniqueZones(zones: readonly string[]): string[] {
  return [...new Set(zones.filter((zone) => realZone(zone) !== null))].sort();
}

/**
 * Zones the family might still be in, once no signal was a single zone.
 * A narrower honest set wins. With nothing at all, every zone Hale serves
 * in Canada and the US.
 */
export function plausibleZones(input: {
  country: 'CA' | 'US' | null;
  statedCityZones: readonly string[] | null;
  phoneSpans: readonly string[] | null;
}): readonly string[] {
  const parts: string[][] = [];
  if (input.statedCityZones && input.statedCityZones.length > 1) {
    parts.push([...input.statedCityZones]);
  }
  if (input.phoneSpans && input.phoneSpans.length > 1) parts.push([...input.phoneSpans]);
  if (parts.length > 0) return uniqueZones(parts.flat());
  if (input.country === 'CA') return CANADA_ZONES;
  if (input.country === 'US') return UNITED_STATES_ZONES;
  return NORTH_AMERICAN_ZONES;
}

/**
 * Best signal first: a place, then the phone's area, then the home metro,
 * then a city or region the parent stated, then the other parent's zone.
 * UTC is never a result.
 */
export function resolveFamilyZone(input: FamilyZoneInput): FamilyZoneResult {
  const stored = realZone(input.storedTimezone);
  if (stored) return { status: 'resolved', zone: stored, source: 'stored' };
  const already = realZone(input.resolvedTimezone);
  if (already) return { status: 'resolved', zone: already, source: 'place' };

  const known = realZone(input.knownPlaceZone);
  if (known) return { status: 'resolved', zone: known, source: 'place' };
  const fromCode =
    placeFromCode(input.country, input.postalCode) ??
    placeFromCode(input.country, input.areaCoarse);
  if (fromCode) return { status: 'resolved', zone: fromCode, source: 'place' };

  const phone = phoneSignal(input.phone);
  if (phone.single) return { status: 'resolved', zone: phone.single, source: 'phone' };

  const metro = homeMetroZone(input.country, input.province, input.city);
  if (metro) return { status: 'resolved', zone: metro, source: 'metro' };

  const city = realZone(input.statedCityZone);
  if (city) return { status: 'resolved', zone: city, source: 'stated' };

  const region = regionZone(input.country, input.province);
  if (region) return { status: 'resolved', zone: region, source: 'stated' };

  const household = realZone(input.householdZone);
  if (household) return { status: 'resolved', zone: household, source: 'household' };

  return {
    status: 'unresolved',
    zones: plausibleZones({
      country: input.country,
      statedCityZones: input.statedCityZones,
      phoneSpans: phone.spans,
    }),
  };
}

export async function zonesForStatedCity(
  country: 'CA' | 'US',
  city: string,
  region: string | null,
): Promise<string[]> {
  const named = await cityInCountry(country, city, region);
  if (!named) return [];
  const zones = new Set<string>();
  for (const key of named.areaKeys) {
    const zone = timezoneForIntakePostal(country, key);
    if (zone !== 'UTC') zones.add(zone);
  }
  return [...zones];
}

function countryOf(row: {
  country: string | null;
  countryCode: string | null;
  postalCode: string | null;
  city: string | null;
}): 'CA' | 'US' | null {
  const text = row.country?.trim().toLowerCase() ?? '';
  if (text === 'canada' || text === 'ca') return 'CA';
  if (text === 'united states' || text === 'us' || text === 'usa') return 'US';
  // country_code defaults to CA on every row. Trust it only once a place was stored.
  if (!row.postalCode && !row.city) return null;
  if (row.countryCode === 'US') return 'US';
  if (row.countryCode === 'CA') return 'CA';
  return null;
}

async function persistResolvedZone(
  database: Database,
  input: {
    userId: string;
    familyId: string;
    zone: string | null;
    source: TimezoneSource | null;
    beforeZone: string | null;
    beforeSource: TimezoneSource | null;
  },
): Promise<void> {
  if (input.beforeZone === input.zone && input.beforeSource === input.source) return;
  await database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const updated = await tx
      .update(schema.users)
      .set({
        resolvedTimezone: input.zone,
        timezoneSource: input.source,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.users.id, input.userId),
          input.beforeZone === null
            ? isNull(schema.users.resolvedTimezone)
            : eq(schema.users.resolvedTimezone, input.beforeZone),
        ),
      )
      .returning({ id: schema.users.id });
    if (updated.length === 0) return;
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'timezone_resolved',
      targetTable: 'users',
      targetId: input.userId,
      before: {
        timezone: 'UTC',
        resolvedTimezone: input.beforeZone,
        timezoneSource: input.beforeSource,
      },
      after: { resolvedTimezone: input.zone, timezoneSource: input.source },
    });
  });
}

/**
 * The clock for this parent. Flag off: `users.timezone` as stored, including
 * the UTC default. Flag on: a resolved zone, or the zones a send must stay
 * out of the night in.
 */
export async function readParentClock(
  database: Database,
  parentUserId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ParentClock> {
  const [user] = await database
    .select({
      timezone: schema.users.timezone,
      resolvedTimezone: schema.users.resolvedTimezone,
      timezoneSource: schema.users.timezoneSource,
    })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId))
    .limit(1);
  if (!user) throw new Error(`readParentClock: no users row for ${parentUserId}`);
  if (!familyTzResolveEnabled(env)) {
    return { kind: 'zone', timeZone: user.timezone, source: 'stored' };
  }
  const stored = realZone(user.timezone);
  if (stored) return { kind: 'zone', timeZone: stored, source: 'stored' };

  const memberships = await database
    .select({
      familyId: schema.familyMembers.familyId,
      country: schema.families.country,
      countryCode: schema.families.countryCode,
      province: schema.families.province,
      provinceOrState: schema.families.provinceOrState,
      city: schema.families.city,
      postalCode: schema.families.postalCode,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.familyMembers)
    .innerJoin(schema.families, eq(schema.families.id, schema.familyMembers.familyId))
    .where(eq(schema.familyMembers.userId, parentUserId));

  const ranked = [...memberships].sort((a, b) => {
    const score = (row: (typeof memberships)[number]) =>
      (row.postalCode ? 4 : 0) + (row.city ? 2 : 0) + (row.areaCoarse ? 1 : 0);
    return score(b) - score(a);
  });
  const home = ranked[0] ?? null;
  const province = home?.province ?? home?.provinceOrState ?? null;
  const country = home
    ? countryOf({
        country: home.country,
        countryCode: home.countryCode,
        postalCode: home.postalCode,
        city: home.city,
      })
    : null;

  let statedCityZone: string | null = null;
  let statedCityZones: string[] | null = null;
  if (home?.city && (country === 'CA' || country === 'US')) {
    const zones = await zonesForStatedCity(country, home.city, province);
    if (zones.length === 1) statedCityZone = zones[0] ?? null;
    else if (zones.length > 1) statedCityZones = zones;
  }

  let householdZone: string | null = null;
  const familyIds = [...new Set(memberships.map((row) => row.familyId))];
  if (familyIds.length > 0) {
    const others = await database
      .select({
        timezone: schema.users.timezone,
        resolvedTimezone: schema.users.resolvedTimezone,
      })
      .from(schema.familyMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
      .where(
        and(
          inArray(schema.familyMembers.familyId, familyIds),
          inArray(schema.familyMembers.role, ['primary_parent', 'co_parent']),
          ne(schema.familyMembers.userId, parentUserId),
        ),
      );
    for (const other of others) {
      const zone = realZone(other.timezone) ?? realZone(other.resolvedTimezone);
      if (zone) {
        householdZone = zone;
        break;
      }
    }
  }

  const phone = await resolveSendablePhone(database, parentUserId);
  const result = resolveFamilyZone({
    storedTimezone: user.timezone,
    resolvedTimezone: null,
    knownPlaceZone: null,
    country,
    postalCode: home?.postalCode ?? null,
    areaCoarse: home?.areaCoarse ?? null,
    phone,
    city: home?.city ?? null,
    province,
    statedCityZone,
    statedCityZones,
    householdZone,
  });

  if (home && result.status === 'resolved' && result.source !== 'stored') {
    await persistResolvedZone(database, {
      userId: parentUserId,
      familyId: home.familyId,
      zone: result.zone,
      source: result.source,
      beforeZone: user.resolvedTimezone,
      beforeSource: user.timezoneSource,
    });
    return { kind: 'zone', timeZone: result.zone, source: result.source };
  }
  if (home && (user.resolvedTimezone !== null || user.timezoneSource !== null)) {
    await persistResolvedZone(database, {
      userId: parentUserId,
      familyId: home.familyId,
      zone: null,
      source: null,
      beforeZone: user.resolvedTimezone,
      beforeSource: user.timezoneSource,
    });
  }
  if (result.status === 'resolved') {
    return { kind: 'zone', timeZone: result.zone, source: result.source };
  }
  return { kind: 'unresolved', zones: result.zones };
}

export type ParentSeason =
  | { outcome: 'season'; timeZone: string; key: string; resetsOn: string }
  | { outcome: 'timezone_unset' };

/**
 * The registration season in the parent's zone. Flag off keeps the column,
 * UTC included. Flag on with no zone refuses the cap claim (`timezone_unset`)
 * instead of counting a season on UTC.
 */
export async function parentSeasonClock(
  database: Database,
  parentUserId: string,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): Promise<ParentSeason> {
  if (!familyTzResolveEnabled(env)) {
    const [row] = await database
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId))
      .limit(1);
    const timeZone = row?.timezone ?? 'UTC';
    const season = registrationSeasonOf(now, timeZone);
    return { outcome: 'season', timeZone, key: season.key, resetsOn: season.resetsOn };
  }
  const clock = await readParentClock(database, parentUserId, env);
  if (clock.kind === 'unresolved') return { outcome: 'timezone_unset' };
  const season = registrationSeasonOf(now, clock.timeZone);
  return {
    outcome: 'season',
    timeZone: clock.timeZone,
    key: season.key,
    resetsOn: season.resetsOn,
  };
}

export interface NewFamilyPlace {
  timezone: string | null;
  countryCode: 'CA' | 'US' | null;
  postalCode: string | null;
  areaCoarse: string | null;
  city: string | null;
  province: string | null;
}

/**
 * The zone to store at signup, or null when the flag is off or nothing
 * resolves. The caller writes it; this does not.
 */
export async function zoneForNewFamily(input: {
  place: NewFamilyPlace | null;
  phone: string | null;
  env?: Record<string, string | undefined>;
}): Promise<{ zone: string; source: TimezoneSource } | null> {
  if (!familyTzResolveEnabled(input.env)) return null;
  const place = input.place;
  const country = place?.countryCode ?? null;
  let statedCityZone: string | null = null;
  let statedCityZones: string[] | null = null;
  if (place?.city && (country === 'CA' || country === 'US')) {
    const zones = await zonesForStatedCity(country, place.city, place.province);
    if (zones.length === 1) statedCityZone = zones[0] ?? null;
    else if (zones.length > 1) statedCityZones = zones;
  }
  const result = resolveFamilyZone({
    storedTimezone: null,
    resolvedTimezone: null,
    knownPlaceZone: place?.timezone ?? null,
    country,
    postalCode: place?.postalCode ?? null,
    areaCoarse: place?.areaCoarse ?? null,
    phone: input.phone,
    city: place?.city ?? null,
    province: place?.province ?? null,
    statedCityZone,
    statedCityZones,
    householdZone: null,
  });
  if (result.status !== 'resolved' || result.source === 'stored') return null;
  return { zone: result.zone, source: result.source };
}
