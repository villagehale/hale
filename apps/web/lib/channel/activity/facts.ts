import type Anthropic from '@anthropic-ai/sdk';
import { FAMILY_STAGES, type FamilyStage, STAGE_BOUNDARIES_MONTHS } from '@hale/types';
import { parseStatedAgeBand } from '../../social/age-band';

export const activityPicksJsonSchema: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          name_evidence: { type: 'string' },
          name: { type: 'string' },
          age_evidence: { type: 'string' },
          age_fit: { type: 'string' },
          when: { type: 'string' },
          when_evidence: { type: 'string' },
          schedule_kind: { type: 'string', enum: ['hours', 'recurring', 'term'] },
          historical_evidence: { type: 'string' },
          season: {
            type: 'string',
            description:
              "The season this fact belongs to, in the source's own words. Not a translation.",
          },
          occurrence_url: {
            type: 'string',
            description:
              'The page this dated fact was read from, when that page is not source_url.',
          },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                evidence: { type: 'string' },
                date: { type: 'string' },
                start_time: { type: 'string' },
                end_time: { type: 'string' },
                timezone: { type: 'string' },
                occurrence_url: { type: 'string' },
              },
              required: ['evidence', 'date'],
            },
          },
          price_evidence: { type: 'string' },
          price: { type: 'string' },
          source_name: { type: 'string' },
          source_url: {
            type: 'string',
            description: 'The exact source URL from this research, never guess one.',
          },
          event_date: {
            type: 'string',
            description: 'YYYY-MM-DD only when the source dates this session. Omit if unknown.',
          },
          indoor_outdoor: { type: 'string', enum: ['indoor', 'outdoor', 'both'] },
          access: {
            type: 'string',
            enum: ['drop_in', 'register_at_venue'],
            description: 'Only the published attendance requirement. Omit if unknown.',
          },
        },
        // `when` and `price` are OMITTED from required for the reason ActivityPick states:
        // a required field a page never published is a field the model can only satisfy by
        // inventing or by dropping the whole find, and it chose dropping.
        required: ['name_evidence', 'name', 'source_name', 'source_url'],
      },
    },
  },
  required: ['picks'],
};

export interface ActivitySession {
  date: string;
  evidence: string;
  start_time?: string | null;
  end_time?: string | null;
  timezone?: string | null;
  /** The page this occurrence was read from, when the model named one. */
  occurrence_url?: string | null;
}

export interface ActivityFactEvidence {
  program: string;
  age: string | null;
  sessions: readonly string[];
  schedule: string | null;
  price: string | null;
  history: string | null;
  windowConfirmed: boolean;
  /** The page the displayed date was read from, when that page is not the listing. */
  occurrenceUrl?: string | null;
  /** The season that owns this fact, when the page or the request names one. */
  season?: string | null;
}

export interface RawActivityFact {
  name?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  name_evidence?: string | null;
  age_fit?: string | null;
  age_evidence?: string | null;
  sessions?: ActivitySession[] | null;
  when?: string | null;
  when_evidence?: string | null;
  schedule_kind?: 'hours' | 'recurring' | 'term' | null;
  /** Season of this fact, in the source's own words. The model sets it; code does not translate it. */
  season?: string | null;
  /** Page this dated fact was read from, when that page is not source_url. */
  occurrence_url?: string | null;
  historical_evidence?: string | null;
  price?: string | null;
  price_evidence?: string | null;
  event_date?: string | null;
  indoor_outdoor?: 'indoor' | 'outdoor' | 'both' | null;
  access?: 'drop_in' | 'register_at_venue' | null;
}

export interface ActivityReference {
  name: string;
  sourceName: string;
  sourceUrl: string;
  ageFit: string | null;
  when: string | null;
  price: string | null;
  status: 'historical' | 'unconfirmed';
  evidence: ActivityFactEvidence;
  /** Season of the quote, when the page names one and it is not this request's season. */
  season?: string | null;
  access?: RawActivityFact['access'];
  indoorOutdoor?: RawActivityFact['indoor_outdoor'];
}

const normalize = (text: string) =>
  text
    .replace(/\\u([0-9a-f]{4})/gi, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
const quoted = (page: string, quote?: string | null): quote is string =>
  typeof quote === 'string' &&
  normalize(quote).length > 0 &&
  normalize(page).includes(normalize(quote));

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export function activityCalendarDate(now: Date, timeZone?: string | null): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
    } catch {
      // Invalid saved zones do not establish a local calendar date.
    }
  }
  return now.toISOString().slice(0, 10);
}

/** Unknown natural-language windows stay unknown instead of being silently broadened. */
export function activityDateRange(
  window: string | null,
  now: Date,
  timeZone?: string | null,
  knownRange?: { start: string; end: string },
): { start: string; end: string } | null {
  if (knownRange)
    return validDate(knownRange.start) &&
      validDate(knownRange.end) &&
      knownRange.start <= knownRange.end
      ? knownRange
      : null;
  const today = activityCalendarDate(now, timeZone);
  const calendarNow = new Date(`${today}T12:00:00Z`);
  if (!window) return { start: today, end: '9999-12-31' };
  const value = window.trim().toLowerCase();
  const dates = value.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (dates?.length && dates.every(validDate)) {
    return dates.length <= 2 && dates[0]! <= dates.at(-1)!
      ? { start: dates[0]!, end: dates.at(-1)! }
      : null;
  }
  const year = value.match(/\b(\d{4})\b/)?.[1];
  if (new Set(value.match(/\b\d{4}\b/g) ?? []).size > 1 || /\band\b/.test(value)) return null;
  const month = months.findIndex((name) => new RegExp(`\\b${name}\\b`).test(value));
  if (
    month >= 0 &&
    year &&
    months.filter((name) => new RegExp(`\\b${name}\\b`).test(value)).length === 1
  ) {
    const days =
      value
        .replace(year, '')
        .match(/\b\d{1,2}\b/g)
        ?.map(Number) ?? [];
    const start = `${year}-${String(month + 1).padStart(2, '0')}-${String(days[0] ?? 1).padStart(2, '0')}`;
    const end = `${year}-${String(month + 1).padStart(2, '0')}-${String(days.at(-1) ?? new Date(Date.UTC(Number(year), month + 1, 0)).getUTCDate()).padStart(2, '0')}`;
    return validDate(start) && validDate(end) && start <= end ? { start, end } : null;
  }
  if (/^\d{4}$/.test(value) || value === 'this year') {
    const y = year ?? String(calendarNow.getUTCFullYear());
    return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
  if (value === 'this month' || value === 'next month') {
    const date = new Date(
      Date.UTC(
        calendarNow.getUTCFullYear(),
        calendarNow.getUTCMonth() + (value === 'next month' ? 1 : 0),
        1,
      ),
    );
    return {
      start: date.toISOString().slice(0, 10),
      end: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
        .toISOString()
        .slice(0, 10),
    };
  }
  return null;
}

/**
 * Whether the model's season for this fact is the season the request asked for.
 *
 * Both strings are the model's, in whatever language the source and the question
 * used. A fact labelled `hiver` or `冬季` does not match a fall request. No season
 * word list is applied.
 */
export function seasonMatchesRequest(
  season: string | null | undefined,
  window: string | null | undefined,
): boolean {
  const fact = season?.trim().toLowerCase() ?? '';
  const asked = window?.trim().toLowerCase() ?? '';
  if (!fact || !asked) return true;
  return asked.includes(fact) || fact.includes(asked);
}

/**
 * The page a dated fact was read from.
 *
 * One page containing the quote owns it. Several pages do only when the model
 * named that page, or when exactly one of them contains the session's ISO date.
 * Month names are not read.
 */
export function pageOwningOccurrence(
  pages: readonly { url: string; text: string }[],
  quote: string,
  sessionDate: string,
  occurrenceUrl?: string | null,
): string | null {
  const holders = pages.filter((page) => quoted(page.text, quote));
  if (holders.length === 0) return null;
  if (occurrenceUrl) {
    const named = holders.find((page) => page.url === occurrenceUrl);
    if (named) return named.url;
  }
  if (holders.length === 1) return holders[0]?.url ?? null;
  const dated = sessionDate ? holders.filter((page) => page.text.includes(sessionDate)) : [];
  return dated.length === 1 ? (dated[0]?.url ?? null) : null;
}

/**
 * A minimum age a read page stated that starts above this stage.
 *
 * The stage ceiling is the existing boundary (toddler ends the month before 48).
 * The quote is the page's own sentence. Nothing here writes a parent-facing line.
 */
export function statedAgeExclusion(
  pages: readonly { url: string; text: string }[],
  stage: FamilyStage | null | undefined,
): { quote: string; sourceUrl: string } | null {
  if (!stage) return null;
  const index = FAMILY_STAGES.indexOf(stage);
  if (index < 0) return null;
  const ceiling = (STAGE_BOUNDARIES_MONTHS[index] ?? Number.POSITIVE_INFINITY) - 1;
  let best: { quote: string; sourceUrl: string; min: number } | null = null;
  for (const page of pages) {
    for (const sentence of page.text.split(/\n+|(?<=[.!?])\s+/)) {
      const quote = sentence.trim();
      if (!quote) continue;
      const band = parseStatedAgeBand(quote);
      if (!band || band.ageMinMonths <= ceiling) continue;
      if (!best || band.ageMinMonths < best.min) {
        best = { quote, sourceUrl: page.url, min: band.ageMinMonths };
      }
    }
  }
  return best ? { quote: best.quote, sourceUrl: best.sourceUrl } : null;
}

const validTime = (time?: string | null) =>
  time == null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);

export function bindActivityFacts(
  raw: readonly RawActivityFact[],
  pages: readonly { url: string; text: string }[],
  window: string | null,
  now: Date,
  timeZone?: string | null,
  knownRange?: { start: string; end: string },
  requestedStages?: readonly FamilyStage[],
) {
  const picks: (RawActivityFact & {
    age_fit: string;
    when: string | null;
    price: string | null;
    evidence: ActivityFactEvidence;
  })[] = [];
  const references: ActivityReference[] = [];
  const range = activityDateRange(window, now, timeZone, knownRange);
  const stageBands = requestedStages?.map((stage) => {
    const index = FAMILY_STAGES.indexOf(stage);
    return {
      min: STAGE_BOUNDARIES_MONTHS[index - 1] ?? 0,
      max: (STAGE_BOUNDARIES_MONTHS[index] ?? Number.POSITIVE_INFINITY) - 1,
    };
  });
  const today = activityCalendarDate(now, timeZone);
  // Without a source zone, the previous UTC date can still be today locally.
  const conclusivelyPast = timeZone
    ? today
    : new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  for (const item of raw) {
    const page = pages.find((page) => page.url === item.source_url);
    if (
      !page ||
      !item.name?.trim() ||
      !item.source_name?.trim() ||
      !quoted(page.text, item.name_evidence)
    )
      continue;
    const age =
      item.age_fit?.trim() && quoted(page.text, item.age_evidence) ? item.age_evidence : null;
    const ageBand = age ? parseStatedAgeBand(normalize(age)) : null;
    // Stage overlap establishes only a possible fit, never an exact child's eligibility.
    const stageCompatible =
      !stageBands?.length ||
      (ageBand &&
        stageBands.some(
          (stage) => ageBand.ageMinMonths <= stage.max && ageBand.ageMaxMonths >= stage.min,
        ));
    // Display the source's price wording, never a separately generated amount/conversion.
    const price =
      item.price?.trim() && quoted(page.text, item.price_evidence) ? item.price_evidence : null;
    const observed = (item.sessions ?? []).filter((session) => {
      const statedYears: readonly string[] =
        normalize(session.evidence).match(/\b(?:19|20)\d{2}\b/g) ?? [];
      return (
        quoted(page.text, session.evidence) &&
        validDate(session.date) &&
        (statedYears.length === 0 || statedYears.includes(session.date.slice(0, 4))) &&
        validTime(session.start_time) &&
        validTime(session.end_time)
      );
    });
    const sessions = observed.filter(
      (session) =>
        range && session.date >= today && session.date >= range.start && session.date <= range.end,
    );
    const historical =
      (observed.length > 0 && observed.every((session) => session.date < conclusivelyPast)) ||
      quoted(page.text, item.historical_evidence);
    // The model's season, not a word list. `hiver` or `冬季` is not this fall request.
    const foreignSeason = !seasonMatchesRequest(item.season, window);
    // A rejected dated session must never escape through a free-form schedule fallback.
    const regular =
      !foreignSeason &&
      !item.sessions?.length &&
      item.schedule_kind &&
      quoted(page.text, item.when_evidence) &&
      item.when?.trim() &&
      !historical
        ? item.when_evidence
        : null;
    const displayedSessions = range
      ? sessions
      : observed.filter((session) => session.date >= today);
    const occurrenceUrls = [
      ...new Set(
        displayedSessions.flatMap((session) => {
          const owner = pageOwningOccurrence(
            pages,
            session.evidence,
            session.date,
            session.occurrence_url ?? item.occurrence_url,
          );
          return owner ? [owner] : [];
        }),
      ),
    ];
    const occurrenceUrl = occurrenceUrls.length === 1 ? (occurrenceUrls[0] ?? null) : null;
    const ownedUrl = occurrenceUrl ?? page.url;
    const when = displayedSessions.length
      ? displayedSessions
          .map(
            (session) =>
              `${session.date}${session.start_time ? ` ${session.start_time}${session.end_time ? `–${session.end_time}` : ''}` : ''}${session.timezone ? ` ${session.timezone}` : ''}`,
          )
          .join('; ')
      : regular;
    const season = item.season?.trim() || null;
    const evidence: ActivityFactEvidence = {
      program: item.name_evidence,
      age: age ? item.age_evidence! : null,
      sessions: observed.map((session) => session.evidence),
      schedule: regular ? item.when_evidence! : null,
      price: price ? item.price_evidence! : null,
      history: quoted(page.text, item.historical_evidence) ? item.historical_evidence : null,
      windowConfirmed: sessions.length > 0,
      occurrenceUrl,
      season,
    };
    if (
      !foreignSeason &&
      age &&
      stageCompatible &&
      when &&
      !historical &&
      (!range || range.end >= today) &&
      (sessions.length > 0 || (regular && item.schedule_kind !== 'term'))
    ) {
      picks.push({
        ...item,
        source_url: ownedUrl,
        age_fit: age,
        when,
        price,
        event_date: sessions[0]?.date,
        evidence,
      });
    } else {
      references.push({
        name: item.name,
        sourceName: item.source_name,
        sourceUrl: ownedUrl,
        ageFit: age,
        when: foreignSeason ? (item.when_evidence ?? when) : when,
        price,
        status: historical ? 'historical' : 'unconfirmed',
        season,
        evidence,
        ...(item.access ? { access: item.access } : {}),
        ...(item.indoor_outdoor ? { indoorOutdoor: item.indoor_outdoor } : {}),
      });
    }
  }
  return { picks, references };
}
