import { z } from 'zod';
import { type StatedAgeBand, parseStatedAgeBand } from './age-band';
import type { LibrarySystem } from './library-systems';
import type {
  CivicAdapter,
  CivicHarvest,
  CivicSessionRecord,
  CivicVenueRecord,
  FetchJson,
} from './types';

/**
 * VIL-252 · M16 · Tier ① — library event calendars.
 *
 * The easy win, and deliberately the first thing built: the GTA library systems
 * publish a machine-readable events feed with real start and end instants, so a
 * storytime's time is READ, never inferred. No model is involved on this path and
 * every row lands at confidence 1. Tier ② (EarlyON free text) is where parsing —
 * and therefore doubt — begins.
 *
 * THE FEED. BiblioCommons serves every system Hale covers from one gateway:
 *   GET https://gateway.bibliocommons.com/v2/libraries/{id}/events?limit=200&page=N
 * The response is normalised — `events.items` is an id list and `entities.*` holds
 * the events, branch locations and audience vocabulary it refers to.
 *
 * TWO UPSTREAM CONSTRAINTS, VERIFIED AGAINST THE LIVE GATEWAY (2026-08-02), that
 * shape this code:
 *   1. Date filtering does not work. `startDate`/`endDate` (and every other
 *      spelling tried) are accepted and ignored, and no `sort` value is accepted
 *      at all (they 500). So there is no way to ask for "this week" and no way to
 *      stop early — the feed must be paged in full and filtered here. That is
 *      affordable because the feed IS the forward calendar: it carries only
 *      upcoming events (~3 months), so a full sweep is ~31 pages for Toronto and
 *      2 for Richmond Hill.
 *   2. `limit` is capped at 200; 500 errors.
 *
 * INSTAGRAM AND FACEBOOK ARE NEVER READ — not here and not anywhere in this
 * module. Branch socials are echoes of this same calendar, they are ephemeral and
 * auth-walled, and scraping them breaks both platforms' terms. This feed is the
 * primary source those posts are made from.
 */

const GATEWAY = 'https://gateway.bibliocommons.com/v2/libraries';

/** The gateway's ceiling; 500s above it. */
const PAGE_LIMIT = 200;

/** Safety stop so a runaway `pages` count can never page forever. At 200/page
 * this covers ~12,000 events — roughly double Toronto's whole forward calendar. */
const MAX_PAGES = 60;

/**
 * Only the fields Hale actually reads. `.passthrough()` everywhere and a
 * permissive shape on purpose: the gateway adds fields without notice, and an
 * over-strict schema would turn a harmless new key into a total coverage outage.
 * What must be present to produce a row IS strict — see `eventSchema`.
 */
const addressSchema = z
  .object({
    number: z.string().nullish(),
    street: z.string().nullish(),
    city: z.string().nullish(),
    zip: z.string().nullish(),
  })
  .passthrough();

const locationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    address: addressSchema.nullish(),
    mapLocation: z
      .object({
        centrePoint: z.object({ lat: z.number(), lng: z.number() }).nullish(),
      })
      .passthrough()
      .nullish(),
    webUrl: z.string().nullish(),
  })
  .passthrough();

const eventSchema = z
  .object({
    id: z.string(),
    // The authoritative UTC instants. Preferred over `definition.start`, which is
    // a zoneless wall-clock string: reading those would mean re-deriving Toronto's
    // DST offset ourselves, and being an hour wrong twice a year.
    indexStart: z.string(),
    indexEnd: z.string(),
    definition: z
      .object({
        title: z.string(),
        description: z.string().nullish(),
        branchLocationId: z.string().nullish(),
        audienceIds: z.array(z.string()).nullish(),
        isCancelled: z.boolean().nullish(),
        registrationInfo: z
          .object({
            enabledMethods: z.array(z.string()).nullish(),
            provider: z.string().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const payloadSchema = z
  .object({
    events: z
      .object({
        items: z.array(z.string()),
        pagination: z
          .object({ page: z.number(), pages: z.number(), count: z.number() })
          .passthrough()
          .nullish(),
      })
      .passthrough(),
    entities: z
      .object({
        events: z.record(eventSchema),
        eventAudiences: z.record(z.object({ name: z.string() }).passthrough()).nullish(),
        locations: z.record(locationSchema).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export type BiblioCommonsPayload = z.infer<typeof payloadSchema>;

/** "2140" + "Avenue Road" → "2140 Avenue Road". The feed pads some values
 * (Markham stores " Kennedy Road, Unit 1"), so both halves are trimmed. */
function formatAddress(address: z.infer<typeof addressSchema> | null | undefined): string | null {
  if (!address) return null;
  const line = [address.number, address.street]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ');
  return line.length > 0 ? line : null;
}

/**
 * Resolve an event's audiences to one age band. Returns `null` when the event
 * should NOT be surfaced — adult-only, no stated audience, or an audience this
 * system's registry does not know — and records the unknown labels so the gap is
 * reportable rather than invisible.
 */
function resolveAgeBand(
  system: LibrarySystem,
  audienceIds: readonly string[],
  audienceNames: Record<string, { name: string }>,
  unknown: Set<string>,
): { ageMinMonths: number | null; ageMaxMonths: number | null } | null {
  // No stated audience is not "everyone" — it is an unanswered question, and the
  // honest response to an unanswered question is to say nothing.
  if (audienceIds.length === 0) return null;

  let min: number | null = null;
  let max: number | null = null;
  let sawAllAges = false;
  let sawChildAudience = false;

  for (const id of audienceIds) {
    const label = audienceNames[id]?.name;
    if (label === undefined) {
      unknown.add(id);
      return null;
    }
    const band = system.audiences[label.trim().toLowerCase()];
    if (band === undefined) {
      unknown.add(label);
      return null;
    }
    // An adult audience alongside a child one (a family program open to grown-ups)
    // does not disqualify the event; an adult-ONLY event has no child audience and
    // falls out below.
    if (band === 'adult') continue;
    sawChildAudience = true;
    if (band === 'all-ages') {
      sawAllAges = true;
      continue;
    }
    min = min === null ? band[0] : Math.min(min, band[0]);
    max = max === null ? band[1] : Math.max(max, band[1]);
  }

  if (!sawChildAudience) return null;
  // "All ages" swallows any narrower band it is listed beside: the source is
  // saying everyone is welcome, so no upper or lower bound is claimed.
  if (sawAllAges) return { ageMinMonths: null, ageMaxMonths: null };
  return { ageMinMonths: min, ageMaxMonths: max };
}

/** The oldest a child can be and still be Hale's; the upper bound to intersect
 * against when an audience states none. */
const PRODUCT_AGE_CEILING_MONTHS = 18 * 12 - 1;

/**
 * VIL-260 · WS5 — narrow a calendar-wide audience band to the age THIS event
 * states about itself (see age-band.ts for why the audience alone is not enough:
 * a 0–5 umbrella was offering a 2-year-old an infant lap-bounce).
 *
 * Three cases, and the third is the interesting one:
 *   - the event states nothing → the umbrella is all we know, unchanged.
 *   - the audience states nothing ("all ages") → the event's own words are the
 *     only claim there is, so they become the band.
 *   - both → the intersection, EXCEPT when they do not overlap at all. A real
 *     conflict exists in the live data (RHPL files "Kindergarten Party (3–5 yrs)"
 *     under its school-age "Kids" audience), and there the event's own title is
 *     the specific truth while the audience is a filing decision. Trusting the
 *     narrower, self-described band is what keeps a three-year-old's party
 *     reachable by three-year-olds.
 */
function narrowToStated(
  audience: { ageMinMonths: number | null; ageMaxMonths: number | null },
  stated: StatedAgeBand | null,
): { ageMinMonths: number | null; ageMaxMonths: number | null } {
  if (stated === null) return audience;
  if (audience.ageMinMonths === null && audience.ageMaxMonths === null) return stated;

  const min = Math.max(audience.ageMinMonths ?? 0, stated.ageMinMonths);
  const max = Math.min(audience.ageMaxMonths ?? PRODUCT_AGE_CEILING_MONTHS, stated.ageMaxMonths);
  return min > max ? stated : { ageMinMonths: min, ageMaxMonths: max };
}

/**
 * Turn one gateway page into venues + sessions. Pure: no clock, no network, no
 * database, so the real captured payloads in ./fixtures test it exactly as it
 * runs in production.
 */
export function parseBiblioCommonsEvents(
  system: LibrarySystem,
  raw: unknown,
): CivicHarvest {
  const payload = payloadSchema.parse(raw);
  const audiences = payload.entities.eventAudiences ?? {};
  const locations = payload.entities.locations ?? {};
  const unknown = new Set<string>();

  const sessions: CivicSessionRecord[] = [];
  const usedBranchIds = new Set<string>();

  for (const id of payload.events.items) {
    const event = payload.entities.events[id];
    if (event === undefined) continue;
    const definition = event.definition;

    const branchId = definition.branchLocationId ?? null;
    // A session Hale cannot place is a session Hale cannot recommend: without a
    // branch there is no address, no distance, and nothing honest to say about
    // where to go. (Virtual-only programming is a separate feature, not this one.)
    if (branchId === null || locations[branchId] === undefined) continue;

    const audience = resolveAgeBand(system, definition.audienceIds ?? [], audiences, unknown);
    if (audience === null) continue;
    // The title is checked first because that is where two of the three systems
    // put the age; TPL states it only in the description, which is the read that
    // stops Baby Time ("birth to 18 months") looking like preschool programming.
    const band = narrowToStated(
      audience,
      parseStatedAgeBand(definition.title) ?? parseStatedAgeBand(definition.description),
    );

    const startsAt = new Date(event.indexStart);
    const endsAt = new Date(event.indexEnd);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) continue;
    // The DB CHECK enforces this too; dropping it here keeps a bad upstream row
    // from failing an entire sweep's insert.
    if (endsAt.getTime() <= startsAt.getTime()) continue;

    const registration = definition.registrationInfo;
    // A seat cap is NOT a registration signal: Markham stamps maxSeats=1 on
    // programs its own description calls "Drop-in program" (verified in the
    // captured fixture). Only an actual booking method or an external provider
    // means a parent has to do something before showing up.
    const registrationRequired =
      (registration?.enabledMethods?.length ?? 0) > 0 ||
      (registration?.provider ?? null) !== null;

    usedBranchIds.add(branchId);
    sessions.push({
      venueExternalId: branchId,
      externalId: event.id,
      title: definition.title.trim(),
      summary: null,
      recurrence: 'occurrence',
      startsAt,
      endsAt,
      dayOfWeek: null,
      startMinute: null,
      endMinute: null,
      ageMinMonths: band.ageMinMonths,
      ageMaxMonths: band.ageMaxMonths,
      // Library programming is free by policy and the feed publishes no price
      // field at all — so this is a declared property of the source, not a guess
      // about an individual row. A system that ever publishes a fee makes this
      // read from the source instead.
      isFree: true,
      registrationRequired,
      isCancelled: definition.isCancelled ?? false,
      extraction: 'structured',
      confidence: 1,
      sourceUrl: `${system.eventsHost}/events/${event.id}`,
    });
  }

  const venues: CivicVenueRecord[] = [];
  for (const branchId of usedBranchIds) {
    const location = locations[branchId];
    if (location === undefined) continue;
    venues.push({
      system: system.id,
      externalId: branchId,
      kind: 'library_branch',
      name: location.name.trim(),
      address: formatAddress(location.address),
      city: location.address?.city?.trim() ?? null,
      postalCode: location.address?.zip?.trim() ?? null,
      lat: location.mapLocation?.centrePoint?.lat ?? null,
      lng: location.mapLocation?.centrePoint?.lng ?? null,
      url: location.webUrl ?? null,
      sourceUrl: `${GATEWAY}/${system.gatewayId}/events`,
    });
  }

  return { venues, sessions, unknownAudienceIds: [...unknown] };
}

/** Merge page harvests into one, de-duplicating venues by their external id. */
function mergeHarvests(parts: readonly CivicHarvest[]): CivicHarvest {
  const venues = new Map<string, CivicVenueRecord>();
  const sessions: CivicSessionRecord[] = [];
  const unknown = new Set<string>();
  for (const part of parts) {
    for (const venue of part.venues) venues.set(venue.externalId, venue);
    sessions.push(...part.sessions);
    for (const id of part.unknownAudienceIds) unknown.add(id);
  }
  return { venues: [...venues.values()], sessions, unknownAudienceIds: [...unknown] };
}

/**
 * The adapter for one BiblioCommons library system. Pages the whole forward
 * calendar (see the module doc for why it cannot be filtered upstream) and parses
 * each page with the pure function above.
 */
export function createBiblioCommonsAdapter(system: LibrarySystem): CivicAdapter {
  return {
    system: system.id,
    label: system.label,
    async harvest(fetchJson: FetchJson): Promise<CivicHarvest> {
      const parts: CivicHarvest[] = [];
      let page = 1;
      let pages = 1;
      while (page <= Math.min(pages, MAX_PAGES)) {
        const raw = await fetchJson(
          `${GATEWAY}/${system.gatewayId}/events?limit=${PAGE_LIMIT}&page=${page}`,
        );
        parts.push(parseBiblioCommonsEvents(system, raw));
        const parsed = payloadSchema.parse(raw);
        pages = parsed.events.pagination?.pages ?? 1;
        if (parsed.events.items.length === 0) break;
        page += 1;
      }
      return mergeHarvests(parts);
    },
  };
}
