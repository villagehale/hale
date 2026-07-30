import { type Database, type NewRegistrationWindow, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { REGISTRATION_WINDOWS, type RegistrationWindowSeed } from './registration-windows-data.js';

/**
 * The registration radar's seed sync (VIL-236 · M1). Turns the hand-verified date
 * list into `registration_windows` rows, keyed on the natural
 * (municipality, program_domain, cycle_label) so a re-run corrects a moved date in
 * place instead of duplicating the cycle.
 *
 * The row build is a pure function so the whole thing is testable without a database:
 * `toRegistrationWindowRow` is where a malformed seed entry dies (loudly — rule #8),
 * and `syncRegistrationWindows` is the thin write on top of it.
 */

/** Parse a seed's ISO instant, refusing anything ambiguous or unparseable. */
function parseInstant(field: string, value: string): Date {
  // An offset (or Z) is REQUIRED: "2026-08-11T06:30:00" would be read in the server's
  // local zone, which silently shifts a 6:30 a.m. Toronto open on a Vercel box in UTC.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`registration window ${field} must carry an explicit UTC offset: ${value}`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`registration window ${field} is not a valid instant: ${value}`);
  }
  return parsed;
}

/**
 * Build the DB row for one verified seed entry, rejecting anything that would make the
 * radar lie: a source that isn't an https municipal page, a resident head start that
 * lands after the general open, or an age band whose bounds are inverted.
 */
export function toRegistrationWindowRow(seed: RegistrationWindowSeed): NewRegistrationWindow {
  if (!seed.sourceUrl.startsWith('https://')) {
    throw new Error(`registration window source must be https: ${seed.sourceUrl}`);
  }
  const openAt = parseInstant('openAt', seed.openAt);
  const residentOpenAt = seed.residentOpenAt
    ? parseInstant('residentOpenAt', seed.residentOpenAt)
    : null;
  const previewAt = seed.previewAt ? parseInstant('previewAt', seed.previewAt) : null;
  if (residentOpenAt && residentOpenAt > openAt) {
    throw new Error(
      `resident open must not be after the general open for ${seed.municipality}/${seed.cycleLabel}`,
    );
  }
  if (
    seed.ageMinMonths !== null &&
    seed.ageMaxMonths !== null &&
    seed.ageMinMonths > seed.ageMaxMonths
  ) {
    throw new Error(`age band is inverted for ${seed.municipality}/${seed.cycleLabel}`);
  }
  return {
    municipality: seed.municipality,
    programDomain: seed.programDomain,
    cycleLabel: seed.cycleLabel,
    previewAt,
    residentOpenAt,
    openAt,
    residentPriorityDays: seed.residentPriorityDays,
    waitlistResponseHours: seed.waitlistResponseHours,
    ageMinMonths: seed.ageMinMonths,
    ageMaxMonths: seed.ageMaxMonths,
    sourceUrl: seed.sourceUrl,
    verifiedAt: parseInstant('verifiedAt', seed.verifiedAt),
    notes: seed.notes,
  };
}

/**
 * Idempotently upsert the verified window list. A conflict on the natural key updates
 * every mutable field — dates move, and a stale date is worse than no date — and bumps
 * `updated_at` so a re-sync is visible. Returns the number of rows written.
 */
export async function syncRegistrationWindows(
  database: Database,
  entries: readonly RegistrationWindowSeed[] = REGISTRATION_WINDOWS,
): Promise<{ count: number }> {
  if (entries.length === 0) return { count: 0 };
  await database
    .insert(schema.registrationWindows)
    .values(entries.map(toRegistrationWindowRow))
    .onConflictDoUpdate({
      target: [
        schema.registrationWindows.municipality,
        schema.registrationWindows.programDomain,
        schema.registrationWindows.cycleLabel,
      ],
      set: {
        previewAt: sqlExcluded('preview_at'),
        residentOpenAt: sqlExcluded('resident_open_at'),
        openAt: sqlExcluded('open_at'),
        residentPriorityDays: sqlExcluded('resident_priority_days'),
        waitlistResponseHours: sqlExcluded('waitlist_response_hours'),
        ageMinMonths: sqlExcluded('age_min_months'),
        ageMaxMonths: sqlExcluded('age_max_months'),
        sourceUrl: sqlExcluded('source_url'),
        verifiedAt: sqlExcluded('verified_at'),
        notes: sqlExcluded('notes'),
        updatedAt: sql`now()`,
      },
    });
  return { count: entries.length };
}

/** Reference the row that would have been inserted, so a conflict updates the
 * existing row to the seed's current values (Drizzle's `sql` excluded reference). */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
