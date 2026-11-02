/**
 * How long a fact from each source is trusted. Relative imports only: the coach
 * eval loads context.ts through tsx, which cannot resolve the web `~` alias.
 *
 * A guess goes stale fastest. What a parent said, a receipt showed, or a row
 * from before sources were kept lasts a school year. Past the window the fact
 * is left out of a find and out of the coach prompt.
 */

export type FactSource = 'parent_message' | 'calendar' | 'receipt' | 'inferred' | 'legacy';

export const FACT_FRESH_DAYS: Readonly<Record<FactSource, number>> = {
  inferred: 90,
  calendar: 180,
  receipt: 365,
  parent_message: 365,
  legacy: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function asSource(source: string): FactSource {
  return source in FACT_FRESH_DAYS ? (source as FactSource) : 'legacy';
}

/** Still inside its source's window. Unknown sources are `legacy`. */
export function isFactFresh(source: string, sourcedAt: Date, now: Date): boolean {
  const ageDays = (now.getTime() - sourcedAt.getTime()) / DAY_MS;
  return ageDays <= FACT_FRESH_DAYS[asSource(source)];
}
