import type {
  CivicExtraction,
  CivicRecurrence,
  CivicSystem,
  CivicVenueKind,
} from '@hale/db';

/**
 * VIL-252 · M16 — what an ingestion adapter hands back, before anything touches
 * the database. Plain data, no ids, no clock: the sweep is what turns a harvest
 * into rows, so every adapter can be tested against a real captured payload with
 * no database at all.
 *
 * ADDING A LIBRARY SYSTEM SHOULD BE DATA, NOT ARCHITECTURE. A BiblioCommons
 * system is a row in LIBRARY_SYSTEMS (id, label, audience→age map) and nothing
 * else; the adapter is written once. A system on a different platform is a new
 * `CivicAdapter` implementation that returns this same shape.
 */

/** A venue as the upstream feed describes it. Public reference data only. */
export interface CivicVenueRecord {
  system: CivicSystem;
  externalId: string;
  kind: CivicVenueKind;
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  url: string | null;
  sourceUrl: string;
}

/**
 * A session as the upstream feed describes it. `venueExternalId` refers to a
 * venue in the SAME harvest — the sweep resolves it to a real venue id, so an
 * adapter never needs to know what is already stored.
 */
export interface CivicSessionRecord {
  venueExternalId: string;
  externalId: string;
  title: string;
  summary: string | null;
  recurrence: CivicRecurrence;
  startsAt: Date | null;
  endsAt: Date | null;
  dayOfWeek: number | null;
  startMinute: number | null;
  endMinute: number | null;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  isFree: boolean;
  registrationRequired: boolean;
  isCancelled: boolean;
  extraction: CivicExtraction;
  confidence: number;
  sourceUrl: string;
}

/**
 * One adapter run's output. `unknownAudienceIds` is the coverage signal that
 * keeps this honest: an audience the registry has no mapping for makes its
 * events VISIBLY missing (they are skipped and the id is reported) rather than
 * quietly reclassified as suitable for everyone. The sweep logs it so a
 * vocabulary change upstream shows up as a gap to fix, not as wrong ages.
 */
export interface CivicHarvest {
  venues: CivicVenueRecord[];
  sessions: CivicSessionRecord[];
  unknownAudienceIds: string[];
}

/** The network seam, injected so every adapter is testable against a fixture
 * and no test ever reaches the real internet. */
export type FetchJson = (url: string) => Promise<unknown>;

export interface CivicAdapter {
  readonly system: CivicSystem;
  readonly label: string;
  harvest(fetchJson: FetchJson): Promise<CivicHarvest>;
}

/** Real fetch, JSON only, with a bounded timeout. The one place civic ingestion
 * touches the network. */
export function createFetchJson(timeoutMs = 20_000): FetchJson {
  return async (url: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`civic fetch ${url} → HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
}
