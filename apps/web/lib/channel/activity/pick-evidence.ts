import { publishedValueIsQuoted } from '~/lib/registration/live-reading';
import { normaliseForMatch, preparePage, quoteIsBackedBy } from './quote-match';

/** Extraction metadata stays here; only backed values cross into a parent-facing pick. */
export interface ActivityEvidenceRow {
  name?: string | null;
  age_fit?: string | null;
  source_url?: string | null;
  location_quote?: string | null;
  relevance?: string | null;
  relevance_quote?: string | null;
  when?: string | null;
  when_quote?: string | null;
  when_source?: string | null;
  price?: string | null;
  price_quote?: string | null;
  price_source?: string | null;
  event_date?: string | null;
  registration?: string | null;
}

function contains(text: string, value: string): boolean {
  return normaliseForMatch(text).includes(normaliseForMatch(value));
}

function locationMatches(town: string, quote: string): boolean {
  const words = normaliseForMatch(quote).replace(/[^\p{L}\p{N}]+/gu, ' ');
  return town.split(',').every((part) => {
    const wanted = normaliseForMatch(part).trim();
    const aliases =
      wanted === 'ontario'
        ? ['ontario', 'on']
        : wanted === 'uk' || wanted === 'united kingdom'
          ? ['uk', 'united kingdom', 'england', 'scotland', 'wales', 'northern ireland']
          : wanted === 'usa' || wanted === 'united states'
            ? ['usa', 'united states', 'us']
            : [wanted];
    return aliases.some((alias) => ` ${words} `.includes(` ${alias} `));
  });
}

export function guardActivityPick<T extends ActivityEvidenceRow>(
  row: T,
  pages: readonly { url: string; text: string }[],
  query: { town: string | null; window: string | null; asOf: string },
): T | null {
  // shortcut: literal evidence cannot prove semantic relevance; real-source model evals remain the release gate.
  const page = pages.find(({ url }) => url === row.source_url);
  if (!page || !row.name || !row.age_fit) return null;
  if (!contains(page.text, row.name) || !contains(page.text, row.age_fit)) return null;
  const location = row.location_quote?.trim();
  if (
    !query.town ||
    !location ||
    !contains(page.text, location) ||
    !locationMatches(query.town, location)
  )
    return null;
  if (row.relevance !== 'current' && row.relevance !== 'unknown') return null;
  const evidence = preparePage(page.text);
  const backed = (
    value: string | null | undefined,
    quote: string | null | undefined,
    url?: string | null,
  ) => {
    const source = url ? pages.find((page) => page.url === url) : page;
    return value &&
      quote &&
      source &&
      contains(quote, value) &&
      quoteIsBackedBy(quote, preparePage(source.text))
      ? value
      : null;
  };
  const when = backed(row.when, row.when_quote, row.when_source);
  const price = backed(row.price, row.price_quote, row.price_source);
  const period = row.relevance_quote?.trim();
  if (row.relevance === 'current' && (!period || !quoteIsBackedBy(period, evidence))) return null;
  // An old dated schedule is not an ongoing schedule, even when labelled current.
  for (const span of [period, row.when_quote]) {
    const years = span?.match(/\b(?:19|20)\d{2}\b/g);
    if (years?.length && years.every((year) => Number(year) < Number(query.asOf.slice(0, 4))))
      return null;
  }
  let eventDate: string | null = null;
  if (row.event_date && when && row.relevance === 'current') {
    const date = new Date(`${row.event_date}T00:00:00Z`);
    if (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === row.event_date &&
      (row.when_quote ?? '').includes(row.event_date.slice(0, 4)) &&
      publishedValueIsQuoted({ date: row.event_date, time: null }, row.when_quote ?? '')
    ) {
      if (row.event_date < query.asOf) return null;
      eventDate = row.event_date;
    }
  }
  return {
    ...row,
    when: row.relevance === 'current' ? when : null,
    price,
    event_date: eventDate,
    registration:
      row.registration && contains(page.text, row.registration) ? row.registration : null,
  };
}
