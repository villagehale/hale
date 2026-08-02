import { z } from 'zod';
import type { WeeklySlot } from './hours-text';
import type { ParsedHours } from './parse-hours';
import type {
  CivicAdapter,
  CivicHarvest,
  CivicSessionRecord,
  CivicVenueRecord,
  FetchJson,
} from './types';

/**
 * VIL-252 · M16 · Tier ② — Toronto's EarlyON child and family centres.
 *
 * THE SOURCE. The City of Toronto publishes its EarlyON registry as open data
 * (CKAN resource 7326e338, "EarlyON Child and Family Centres Locations"): ~230
 * centres with address, coordinates, agency, website — and, crucially, the
 * centres' published hours as FREE TEXT (`dropinHours`, `registeredHours`).
 *
 * That free-text field is the whole reason Tier ② exists. It is an official,
 * stable, licensed feed — strictly better than fetching 230 centre webpages, and
 * it is the same data those pages are built from — but the hours themselves are
 * prose: "Monday: 10:00 a.m. - noon  ; 3:30 p.m. - 6:00 p.m.  | Tuesday: ...".
 * Reading a schedule out of that is the parsing problem, and `parseHours` (which
 * tries a strict deterministic read before any model) is where it is solved.
 *
 * INSTAGRAM AND FACEBOOK ARE NEVER READ. Many centres post their week to socials;
 * those posts are echoes of these same published hours. They are ephemeral,
 * auth-walled, and scraping them breaks both platforms' terms. If a centre's real
 * schedule is only ever on Instagram, Hale says nothing about that centre until
 * the centre chooses to share it with us.
 */

const CKAN_RESOURCE_ID = '7326e338-491e-4366-81a0-b12f5257c064';
const CKAN_SEARCH =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/datastore_search';
/** The human-facing dataset page — what a parent (or an auditor) should be shown
 * as the origin of a row, rather than a raw API URL. */
const DATASET_URL = 'https://open.toronto.ca/dataset/earlyon-child-and-family-centres/';

/** CKAN's per-request ceiling for this resource; the registry is ~230 rows. */
const PAGE_LIMIT = 500;

/**
 * EarlyON is defined in Ontario legislation as serving children from BIRTH TO
 * SIX, free of charge, with no registration for drop-in programming. That is a
 * statutory property of the program, not an inference about a given centre, so it
 * is applied uniformly rather than parsed per row.
 */
const EARLYON_AGE_MIN_MONTHS = 0;
const EARLYON_AGE_MAX_MONTHS = 5 * 12 + 11;

const recordSchema = z
  .object({
    loc_id: z.union([z.number(), z.string()]),
    program_name: z.string(),
    agency: z.string().nullish(),
    address: z.string().nullish(),
    full_address: z.string().nullish(),
    lat: z.number().nullish(),
    lng: z.number().nullish(),
    website: z.string().nullish(),
    dropinHours: z.string().nullish(),
    registeredHours: z.string().nullish(),
  })
  .passthrough();

const responseSchema = z
  .object({
    result: z.object({ records: z.array(recordSchema) }).passthrough(),
  })
  .passthrough();

/** "1102 Broadview Ave, East York, ON M4K 2S5" → city + postal code. Returns
 * nulls rather than guesses when the shape does not match. */
export function splitFullAddress(full: string | null | undefined): {
  city: string | null;
  postalCode: string | null;
} {
  if (!full) return { city: null, postalCode: null };
  const postal = /([A-Z]\d[A-Z]\s?\d[A-Z]\d)\s*$/i.exec(full.trim());
  const parts = full.split(',').map((p) => p.trim());
  // [street, city, "ON M4K 2S5"] — the city is the second-to-last part.
  const city = parts.length >= 3 ? (parts[parts.length - 2] ?? null) : null;
  return {
    city: city !== null && city.length > 0 ? city : null,
    postalCode: postal?.[1]?.toUpperCase() ?? null,
  };
}

/** A slot's id is derived from what it IS, so re-parsing the same published hours
 * lands on the same row instead of creating a second one every sweep. */
function slotExternalId(kind: 'dropin' | 'registered', slot: WeeklySlot): string {
  return `${kind}-${slot.dayOfWeek}-${slot.startMinute}-${slot.endMinute}`;
}

export interface EarlyOnDeps {
  /** Injected so the adapter is testable with no model, and so the strict-then-
   * LLM policy lives in one place (parse-hours.ts) rather than per adapter. */
  parseHours(text: string): Promise<ParsedHours>;
}

export function createEarlyOnTorontoAdapter(deps: EarlyOnDeps): CivicAdapter {
  return {
    system: 'earlyon_toronto',
    label: 'EarlyON Child and Family Centres (Toronto)',
    async harvest(fetchJson: FetchJson): Promise<CivicHarvest> {
      const raw = await fetchJson(`${CKAN_SEARCH}?id=${CKAN_RESOURCE_ID}&limit=${PAGE_LIMIT}`);
      const { result } = responseSchema.parse(raw);

      const venues: CivicVenueRecord[] = [];
      const sessions: CivicSessionRecord[] = [];

      for (const record of result.records) {
        const externalId = String(record.loc_id);
        const { city, postalCode } = splitFullAddress(record.full_address);

        venues.push({
          system: 'earlyon_toronto',
          externalId,
          kind: 'earlyon_centre',
          name: record.program_name.trim(),
          address: record.address?.trim() ?? null,
          city,
          postalCode,
          lat: record.lat ?? null,
          lng: record.lng ?? null,
          // The agency's own page, where a parent can confirm before setting out.
          url: record.website?.trim() ?? null,
          sourceUrl: DATASET_URL,
        });

        for (const [kind, text] of [
          ['dropin', record.dropinHours],
          ['registered', record.registeredHours],
        ] as const) {
          if (!text || text.trim().length === 0) continue;
          const parsed = await deps.parseHours(text);
          for (const slot of parsed.slots) {
            sessions.push({
              venueExternalId: externalId,
              externalId: slotExternalId(kind, slot),
              title:
                kind === 'dropin'
                  ? 'EarlyON drop-in'
                  : 'EarlyON registered program',
              summary: record.agency?.trim() ?? null,
              recurrence: 'weekly',
              startsAt: null,
              endsAt: null,
              dayOfWeek: slot.dayOfWeek,
              startMinute: slot.startMinute,
              endMinute: slot.endMinute,
              ageMinMonths: EARLYON_AGE_MIN_MONTHS,
              ageMaxMonths: EARLYON_AGE_MAX_MONTHS,
              isFree: true,
              // Drop-in is the defining feature of an EarlyON drop-in session; the
              // registered stream is exactly the part a parent must sign up for.
              registrationRequired: kind === 'registered',
              isCancelled: false,
              extraction: parsed.extraction,
              confidence: parsed.confidence,
              sourceUrl: DATASET_URL,
            });
          }
        }
      }

      return { venues, sessions, unknownAudienceIds: [] };
    },
  };
}
