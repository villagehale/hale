import { timezoneOffsetMs } from '~/lib/memory/period';

/**
 * The runtime's ICU time-zone data is a dependency no version range can state: Node
 * v24.12.0 is newer than v22.23.4 and still ships tz 2025b. So the check is behavioural —
 * a few dated facts from the IANA tz database, read through the same primitive the
 * family-local time math uses. A stale runtime is a named `tzdata_stale` outcome, logged
 * at boot; it never crashes the app.
 *
 * Node ICU is the only time-zone engine for family-local time. Keep family-zoned
 * `AT TIME ZONE` out of SQL until Postgres tzdata is current (prod 17.6 was stale on 2026-11-03).
 */

export const TZDATA_PROBE_INSTANT = new Date('2026-12-15T12:00:00Z');

export interface TzdataSentinel {
  zone: string;
  offsetMinutes: number;
  since: string;
}

// Each zone's final Zone line in the tz 2026f `northamerica` file, in force from
// 2026-11-01. With their links (Yellowknife, Rainy_River, Canada/*) these are every
// US or Canada zone whose offset changed between 2025b and 2026e.
export const TZDATA_SENTINELS: readonly TzdataSentinel[] = [
  { zone: 'America/Vancouver', offsetMinutes: -420, since: '2026b' },
  { zone: 'America/Edmonton', offsetMinutes: -360, since: '2026c' },
  { zone: 'America/Inuvik', offsetMinutes: -360, since: '2026d' },
  { zone: 'America/Winnipeg', offsetMinutes: -300, since: '2026e' },
];

export type OffsetReader = (instant: Date, timeZone: string) => number;

export interface TzdataMismatch {
  zone: string;
  expectedMinutes: number;
  actual: number | 'unreadable';
}

export type TzdataCheck =
  | { outcome: 'tzdata_current'; tz: string; icu: string }
  | { outcome: 'tzdata_stale'; tz: string; icu: string; mismatches: TzdataMismatch[] };

const MINUTE_MS = 60_000;

function readMinutes(readOffset: OffsetReader, zone: string): number | 'unreadable' {
  try {
    const minutes = readOffset(TZDATA_PROBE_INSTANT, zone) / MINUTE_MS;
    return Number.isFinite(minutes) ? minutes : 'unreadable';
  } catch (err) {
    if (err instanceof RangeError) return 'unreadable';
    throw err;
  }
}

export function checkTzdata(
  readOffset: OffsetReader = timezoneOffsetMs,
  versions: { tz?: string; icu?: string } = { tz: process.versions.tz, icu: process.versions.icu },
): TzdataCheck {
  const tz = versions.tz ?? 'not_reported';
  const icu = versions.icu ?? 'not_reported';
  const mismatches: TzdataMismatch[] = [];
  for (const sentinel of TZDATA_SENTINELS) {
    const actual = readMinutes(readOffset, sentinel.zone);
    if (actual !== sentinel.offsetMinutes) {
      mismatches.push({ zone: sentinel.zone, expectedMinutes: sentinel.offsetMinutes, actual });
    }
  }
  if (mismatches.length === 0) return { outcome: 'tzdata_current', tz, icu };
  return { outcome: 'tzdata_stale', tz, icu, mismatches };
}

export function reportTzdataAtBoot(check: TzdataCheck = checkTzdata()): TzdataCheck {
  const { outcome, tz, icu } = check;
  console.info({ tz, icu, node: process.version, outcome }, 'tzdata: runtime time-zone data');
  if (check.outcome === 'tzdata_stale') {
    console.error(
      { code: 'tzdata_stale', tz, icu, mismatches: check.mismatches },
      'tzdata_stale: ICU time-zone data is older than the 2026 Canadian changes',
    );
  }
  return check;
}
