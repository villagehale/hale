import type { CivicSystem } from '@hale/db';
import { STAGE_BOUNDARIES_MONTHS, TEENAGER_START_MONTHS } from '@hale/types';

/**
 * VIL-252 · M16 — the GTA library systems whose event calendars Hale reads, and
 * the one thing that genuinely differs between them: what they call the people a
 * program is for.
 *
 * ADDING A SYSTEM IS ADDING A ROW HERE. All four GTA systems verified so far run
 * on the same BiblioCommons events gateway, so a new one needs an id, a public
 * events host, and its audience vocabulary — no new code path. Brampton (`bpl`)
 * is on the same gateway and is the obvious next row; it is left out only because
 * its audience vocabulary has not been read against a real payload yet, and a
 * guessed age band is exactly the thing this module refuses to do.
 *
 * WHY AUDIENCES ARE KEYED BY NAME. The gateway's audience ids are opaque per-
 * system mongo ids, unreadable in review; the names are the library's own words
 * and are what a human can verify against the branch's page. A name this table
 * does not know makes its events SKIPPED and reported (see CivicHarvest.
 * unknownAudienceIds) — never silently widened to "all ages", which would put a
 * 3-year-old's parent in an adult book club.
 */

const [NEWBORN_END] = STAGE_BOUNDARIES_MONTHS;
const TEEN_START = TEENAGER_START_MONTHS;

/** The last month of a child's Nth year — age "5" runs to 5y11m. */
const throughAge = (years: number): number => years * 12 + 11;

/** Hale covers birth to 18 (216 months); a teen audience tops out there. */
const PRODUCT_AGE_CEILING_MONTHS = 18 * 12 - 1;

/**
 * What an audience label means in months, or a marker for the two cases that are
 * not a band at all:
 *   'all-ages' — the source states no age, so neither do we (both bounds null).
 *   'adult'    — adult programming; the event is not civic FAMILY programming and
 *                is dropped. A parent asking Hale what's on this week must never
 *                be sent to a housing-help clinic because a library filed it
 *                under the same calendar.
 */
export type AudienceBand = readonly [number, number] | 'all-ages' | 'adult';

export interface LibrarySystem {
  readonly id: CivicSystem;
  readonly label: string;
  /** The public host serving both the gateway feed and the human event pages. */
  readonly gatewayId: string;
  readonly eventsHost: string;
  /** Audience label (lowercased) → what it means. */
  readonly audiences: Readonly<Record<string, AudienceBand>>;
}

const PRESCHOOL: readonly [number, number] = [0, throughAge(5)];
const SCHOOL_AGE: readonly [number, number] = [6 * 12, TEEN_START - 1];
const TEEN: readonly [number, number] = [TEEN_START, PRODUCT_AGE_CEILING_MONTHS];

/**
 * Verified against a live gateway payload on 2026-08-02. Every label below was
 * read from that system's own `entities.eventAudiences`, not assumed.
 */
export const LIBRARY_SYSTEMS = {
  tpl: {
    id: 'tpl',
    label: 'Toronto Public Library',
    gatewayId: 'tpl',
    eventsHost: 'https://tpl.bibliocommons.com',
    audiences: {
      'preschool children (0-5)': PRESCHOOL,
      'school age children (6-12)': SCHOOL_AGE,
      'teens (13-17)': TEEN,
      'adults (18+)': 'adult',
      'younger adults (18-24)': 'adult',
      'older adults': 'adult',
    },
  },
  markham: {
    id: 'markham',
    label: 'Markham Public Library',
    gatewayId: 'markham',
    eventsHost: 'https://markham.bibliocommons.com',
    audiences: {
      // Markham files under-6 separately from "children", so "children" is the
      // school-age band here — confirmed by its own listings ("Newcomer Youth
      // Love of Language Club", audience Children, describes ages 6 to 12).
      'infants (0 to 12 months)': [0, NEWBORN_END],
      'birth to five': PRESCHOOL,
      children: SCHOOL_AGE,
      youth: TEEN,
      'all ages': 'all-ages',
      adult: 'adult',
      'older adult': 'adult',
    },
  },
  rhpl: {
    id: 'rhpl',
    label: 'Richmond Hill Public Library',
    gatewayId: 'rhpl',
    eventsHost: 'https://rhpl.bibliocommons.com',
    audiences: {
      'babies, toddlers & preschool': PRESCHOOL,
      kids: SCHOOL_AGE,
      teens: TEEN,
      families: 'all-ages',
      adults: 'adult',
    },
  },
} as const satisfies Record<string, LibrarySystem>;

export type LibrarySystemId = keyof typeof LIBRARY_SYSTEMS;

export const LIBRARY_SYSTEM_LIST: readonly LibrarySystem[] = Object.values(LIBRARY_SYSTEMS);
