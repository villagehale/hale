import type Anthropic from '@anthropic-ai/sdk';

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
}

export interface ActivityFactEvidence {
  program: string;
  age: string | null;
  sessions: readonly string[];
  schedule: string | null;
  price: string | null;
  history: string | null;
  windowConfirmed: boolean;
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
  access?: RawActivityFact['access'];
  indoorOutdoor?: RawActivityFact['indoor_outdoor'];
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
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

const validTime = (time?: string | null) =>
  time == null || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);

export function bindActivityFacts(
  raw: readonly RawActivityFact[],
  pages: readonly { url: string; text: string }[],
  window: string | null,
  now: Date,
  timeZone?: string | null,
  knownRange?: { start: string; end: string },
) {
  const picks: (RawActivityFact & {
    age_fit: string;
    when: string | null;
    price: string | null;
    evidence: ActivityFactEvidence;
  })[] = [];
  const references: ActivityReference[] = [];
  const range = activityDateRange(window, now, timeZone, knownRange);
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
    const age = item.age_fit?.trim() && quoted(page.text, item.age_evidence) ? item.age_fit : null;
    const price = item.price?.trim() && quoted(page.text, item.price_evidence) ? item.price : null;
    const observed = (item.sessions ?? []).filter(
      (session) =>
        quoted(page.text, session.evidence) &&
        validDate(session.date) &&
        validTime(session.start_time) &&
        validTime(session.end_time),
    );
    const sessions = observed.filter(
      (session) =>
        range && session.date >= today && session.date >= range.start && session.date <= range.end,
    );
    const historical =
      (observed.length > 0 && observed.every((session) => session.date < conclusivelyPast)) ||
      quoted(page.text, item.historical_evidence);
    // A rejected dated session must never escape through a free-form schedule fallback.
    const regular =
      !item.sessions?.length &&
      item.schedule_kind &&
      quoted(page.text, item.when_evidence) &&
      item.when?.trim() &&
      !historical
        ? item.when
        : null;
    const displayedSessions = range
      ? sessions
      : observed.filter((session) => session.date >= today);
    const when = displayedSessions.length
      ? displayedSessions
          .map(
            (session) =>
              `${session.date}${session.start_time ? ` ${session.start_time}${session.end_time ? `–${session.end_time}` : ''}` : ''}${session.timezone ? ` ${session.timezone}` : ''}`,
          )
          .join('; ')
      : regular;
    const evidence: ActivityFactEvidence = {
      program: item.name_evidence,
      age: age ? item.age_evidence! : null,
      sessions: observed.map((session) => session.evidence),
      schedule: regular ? item.when_evidence! : null,
      price: price ? item.price_evidence! : null,
      history: quoted(page.text, item.historical_evidence) ? item.historical_evidence : null,
      windowConfirmed: sessions.length > 0,
    };
    if (
      age &&
      when &&
      !historical &&
      (sessions.length > 0 || (regular && item.schedule_kind !== 'term'))
    ) {
      picks.push({ ...item, age_fit: age, when, price, event_date: sessions[0]?.date, evidence });
    } else {
      references.push({
        name: item.name,
        sourceName: item.source_name,
        sourceUrl: page.url,
        ageFit: age,
        when,
        price,
        status: historical ? 'historical' : 'unconfirmed',
        evidence,
        ...(item.access ? { access: item.access } : {}),
        ...(item.indoor_outdoor ? { indoorOutdoor: item.indoor_outdoor } : {}),
      });
    }
  }
  return { picks, references };
}
