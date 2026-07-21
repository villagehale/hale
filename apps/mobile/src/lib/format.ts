import type { FamilyStage, MilestoneStatus } from './api-types';

/** "3 mo" under two years, "2 yr" beyond — the compact companion age label. */
export function agePhrase(ageMonths: number): string {
  if (ageMonths < 24) return `${ageMonths} mo`;
  return `${Math.floor(ageMonths / 12)} yr`;
}

/** Whole-weeks-until a health item → a calm human phrase (mirrors the web page). */
export function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'due now';
  if (dueInWeeks === 1) return 'in 1 week';
  if (dueInWeeks < 8) return `in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

/** Village price band → a compact chip label (mirrors web priceBandLabel).
 * Unknown / absent → null so the caller HIDES the chip (never a fabricated band). */
const PRICE_BAND_LABELS: Record<string, string> = {
  free: 'Free',
  low: '$',
  moderate: '$$',
  high: '$$$',
};
export function priceBandLabel(band: string | null): string | null {
  if (band === null) return null;
  return PRICE_BAND_LABELS[band] ?? null;
}

/** Village indoor/outdoor → chip label (mirrors web). Unknown / absent → null. */
const INDOOR_OUTDOOR_LABELS: Record<string, string> = {
  indoor: 'Indoor',
  outdoor: 'Outdoor',
  both: 'Indoor & outdoor',
};
export function indoorOutdoorLabel(value: string | null): string | null {
  if (value === null) return null;
  return INDOOR_OUTDOOR_LABELS[value] ?? null;
}

/** Milestone timing → the parent-facing label (mirrors the web page). */
export const MILESTONE_TIMING_LABEL: Record<MilestoneStatus['timing'], string> = {
  upcoming: 'coming up',
  in_window: 'around now',
  watch: 'worth asking',
};

/** Family stage → a capitalized, parent-facing label so headers read "Newborn"
 * rather than the raw lowercase enum "newborn"/"teenager". */
export const STAGE_LABEL: Record<FamilyStage, string> = {
  newborn: 'Newborn',
  toddler: 'Toddler',
  child: 'Child',
  teenager: 'Teen',
};

// Hoisted so the formatter is built once, not per call: whenPhrase runs per episode
// row and foundStamp's dayKey runs per Village RecCard, and each toLocaleString /
// DateTimeFormat construction re-parses locale data. The undefined-locale one reads the
// device locale at module load, which is stable for the app process (a locale change
// restarts the app → reloads this module).
const WHEN_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const DAY_KEY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A logged episode's ISO time → a short "Jul 2, 2:15pm" style phrase. */
export function whenPhrase(occurredAt: string): string {
  return WHEN_FORMAT.format(new Date(occurredAt));
}

/** Day-grained "found …" freshness phrase for a discovery run (mirrors the web
 * `foundStamp`): "found today" / "found yesterday" / "found N days ago". On-device
 * the parent's local day IS the family's day, so the day count reads the device's
 * local days; a future stamp (clock skew) reads "found today". A missing or
 * unparseable stamp returns '' rather than throwing: Intl.format on an Invalid Date
 * throws a RangeError that would crash the render, so we fail closed to no stamp. */
export function foundStamp(discoveredAt: string, now: Date = new Date()): string {
  const discovered = new Date(discoveredAt);
  if (Number.isNaN(discovered.getTime())) return '';
  const dayKey = (d: Date) => DAY_KEY_FORMAT.format(d);
  const days = Math.floor(
    (Date.parse(`${dayKey(now)}T00:00:00Z`) - Date.parse(`${dayKey(discovered)}T00:00:00Z`)) /
      86_400_000,
  );
  if (days <= 0) return 'found today';
  if (days === 1) return 'found yesterday';
  return `found ${days} days ago`;
}
