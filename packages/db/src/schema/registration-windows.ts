import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The GTA municipalities the registration radar covers (VIL-236 · M1). Kept as a
 * TS union over a plain `text` column rather than a pg enum: the covered set grows
 * municipality-by-municipality as each one is hand-verified, and a new town must
 * not need a migration (rule #9 — additive, and an enum ADD VALUE is a migration).
 */
export type Municipality =
  | 'toronto'
  | 'markham'
  | 'vaughan'
  | 'richmond_hill'
  | 'mississauga'
  | 'oakville'
  | 'burlington'
  | 'halton_hills'
  | 'brampton'
  | 'caledon'
  | 'ajax'
  | 'pickering'
  | 'whitby'
  | 'oshawa'
  | 'aurora';

/**
 * What kind of registration the window is for. `rec_program` is the seasonal
 * recreation guide (swim lessons usually ride inside it — `swim` is for the
 * municipalities that run a SEPARATE swim-lesson registration date), `camp` is
 * March Break / summer / PA-day camps, `after_school_care` is the school-year
 * before-and-after-school programs, which register on their own calendar.
 */
export type ProgramDomain = 'rec_program' | 'camp' | 'swim' | 'after_school_care';

/**
 * VIL-236 · M1 — the registration radar's data moat: when each GTA municipality
 * opens registration for its recreation programs, camps, swim lessons and after-
 * school care, so Hale can warn a family BEFORE the 6:30 a.m. scramble instead of
 * after the waitlist.
 *
 * Family-AGNOSTIC public reference data, like curated_resources: there is no
 * family_id and nothing here is PII (rule #1). Every row is hand-verified against
 * the municipality's own page — `source_url` + `verified_at` are NOT NULL precisely
 * so a row can never be a guess. A municipality that has not published its next
 * date yet gets NO row (an omission the coverage report names), never a placeholder.
 *
 * Time model: `open_at` is the general/non-resident open instant and is the one
 * required date — everything else is a refinement.
 *   preview_at        — when the guide/programs become browsable (Toronto, Markham)
 *   resident_open_at  — the earlier resident-priority open instant, NULL where the
 *                       municipality has no resident head start
 *   resident_priority_days   — the published size of that head start, for copy
 *   waitlist_response_hours  — how long a family has to accept a waitlist offer
 *                              before it moves on (Toronto 36h, Markham 48h)
 * All instants are timestamptz: registration opens at a WALL-CLOCK local time
 * (6:30 a.m. America/Toronto), so the seed encodes the local time with its explicit
 * UTC offset and the DST-correct instant is what lands here.
 *
 * (municipality, program_domain, cycle_label) is UNIQUE — the natural key, so the
 * seed sync is idempotent: a re-run updates a corrected date in place rather than
 * duplicating the cycle.
 */
export const registrationWindows = pgTable(
  'registration_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    municipality: text('municipality').$type<Municipality>().notNull(),
    programDomain: text('program_domain').$type<ProgramDomain>().notNull(),
    /** The municipality's own name for the cycle (e.g. "Fall 2026", "Summer 2027
     * Camps") — free text because every town labels its seasons differently. */
    cycleLabel: text('cycle_label').notNull(),
    /** When programs become browsable, where the municipality publishes it. */
    previewAt: timestamp('preview_at', { withTimezone: true }),
    /** The resident-priority open instant; NULL where residency buys nothing. */
    residentOpenAt: timestamp('resident_open_at', { withTimezone: true }),
    /** The general (non-resident) open instant — the one date every row must have. */
    openAt: timestamp('open_at', { withTimezone: true }).notNull(),
    /** The published resident head start in days, for the parent-facing copy. */
    residentPriorityDays: integer('resident_priority_days'),
    /** Hours to accept a waitlist offer before it passes to the next family. */
    waitlistResponseHours: integer('waitlist_response_hours'),
    /** The program's published age band in months; NULL means unbounded on that
     * side (a guide-wide registration date applies to every age). */
    ageMinMonths: integer('age_min_months'),
    ageMaxMonths: integer('age_max_months'),
    /** The municipal page the dates were read off — the honesty anchor. */
    sourceUrl: text('source_url').notNull(),
    /** When a human/agent last confirmed this row against source_url. Dates move;
     * a stale verified_at is the signal to re-check, not to keep trusting. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    /** Anything the page says that the columns can't hold (district splits, phone-
     * in windows, "in-person from 9 a.m."). Never a substitute for a real date. */
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The natural key — the seed's idempotency anchor.
    municipalityDomainCycleIdx: uniqueIndex(
      'registration_windows_municipality_domain_cycle_idx',
    ).on(table.municipality, table.programDomain, table.cycleLabel),
    // The radar's scan: the upcoming windows for a family's municipality, in date order.
    municipalityOpenIdx: index('registration_windows_municipality_open_idx').on(
      table.municipality,
      table.openAt,
    ),
  }),
);

export type RegistrationWindow = typeof registrationWindows.$inferSelect;
export type NewRegistrationWindow = typeof registrationWindows.$inferInsert;
